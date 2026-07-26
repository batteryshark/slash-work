import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case offline(String)
        case failed(String)
    }

    private enum DefaultsKey {
        static let profiles = "work.profiles"
        static let activeProfile = "work.activeProfile"
        static func workspace(_ serverID: String) -> String { "work.workspace.\(serverID)" }
        static func project(_ serverID: String, _ workspaceID: String) -> String {
            "work.project.\(serverID).\(workspaceID)"
        }
        static func directory(_ serverID: String) -> String { "work.directory.\(serverID)" }
    }

    @Published var serverURL = ""
    @Published private(set) var profiles: [ServerProfile]
    @Published private(set) var activeProfileID: String?
    @Published private(set) var connectionState: ConnectionState = .disconnected
    @Published private(set) var directory: WorkspaceDirectory?
    @Published private(set) var selectedWorkspaceID: String?
    @Published private(set) var selectedProjectPath: String?
    @Published private(set) var snapshot: WorkspacePayload?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isMutating = false
    @Published private(set) var isShowingCachedData = false
    @Published private(set) var cacheSavedAt: Date?
    @Published private(set) var serviceVersion: String?
    @Published var lastError: String?
    @Published private(set) var cacheWarning: String?

    private var client: WorkAPIClient?
    private var etag: String?
    private let defaults: UserDefaults
    private let snapshotStore: SnapshotStore
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard, snapshotStore: SnapshotStore = SnapshotStore()) {
        self.defaults = defaults
        self.snapshotStore = snapshotStore
        if let data = defaults.data(forKey: DefaultsKey.profiles),
           let decoded = try? decoder.decode([ServerProfile].self, from: data) {
            profiles = decoded
        } else {
            profiles = []
        }
        activeProfileID = defaults.string(forKey: DefaultsKey.activeProfile)
        if let activeProfile = profiles.first(where: { $0.id == activeProfileID }) {
            serverURL = activeProfile.url
        }
    }

    var activeProfile: ServerProfile? {
        profiles.first { $0.id == activeProfileID }
    }

    var selectedWorkspace: WorkspaceSummary? {
        directory?.workspaces.first { $0.id == selectedWorkspaceID }
    }

    var selectedProject: WorkProject? {
        guard let selectedProjectPath else { return nil }
        return snapshot?.projects.first { $0.path == selectedProjectPath }
    }

    var scopedTasks: [WorkTask] { snapshot?.tasks.filter { includes($0.projectPath) } ?? [] }
    var scopedCaptures: [WorkCapture] { snapshot?.captures.filter { includes($0.projectPath) } ?? [] }
    var scopedIdeas: [WorkIdea] { snapshot?.ideas.filter { includes($0.projectPath) } ?? [] }
    var scopedNotes: [WorkNote] { snapshot?.notes.filter { includes($0.projectPath) } ?? [] }
    var scopedDecisions: [WorkDecision] { snapshot?.decisions.filter { includes($0.projectPath) } ?? [] }
    var openDecisions: [WorkDecision] {
        scopedDecisions.filter(\.isOpen)
    }

    var unfinishedTaskCount: Int { scopedTasks.filter { !$0.isFinished }.count }

    func connect() async {
        guard connectionState != .connecting else { return }
        connectionState = .connecting
        lastError = nil
        cacheWarning = nil

        let candidateProfile: ServerProfile
        do {
            let url = try WorkAPIClient.validatedURL(from: serverURL)
            if let existing = profiles.first(where: { $0.url == url.absoluteString }) {
                candidateProfile = existing
            } else {
                candidateProfile = ServerProfile(name: url.host ?? "Work", url: url.absoluteString)
            }
            let client = try WorkAPIClient(baseURL: url)
            let health = try await client.health()
            let directory = try await client.workspaces()
            guard let workspace = preferredWorkspace(in: directory, serverID: candidateProfile.id) else {
                throw WorkAPIError.server(status: 503, code: "no_available_workspace",
                                          message: "This Work instance has no available workspaces.")
            }

            self.client = client
            self.serviceVersion = health.service?.version
            self.directory = directory
            self.activeProfileID = candidateProfile.id
            self.serverURL = candidateProfile.url
            upsert(candidateProfile)
            persistDirectory(directory, serverID: candidateProfile.id)
            defaults.set(candidateProfile.id, forKey: DefaultsKey.activeProfile)
            selectedWorkspaceID = workspace.id
            persistSelectedWorkspace()
            await loadSelectedWorkspace(preferCache: true)
        } catch {
            let message = error.localizedDescription
            if await restoreCachedConnection() {
                connectionState = .offline(message)
                lastError = message
            } else {
                client = nil
                directory = nil
                snapshot = nil
                connectionState = .failed(message)
                lastError = message
            }
        }
    }

    func connect(to profile: ServerProfile) async {
        activeProfileID = profile.id
        serverURL = profile.url
        defaults.set(profile.id, forKey: DefaultsKey.activeProfile)
        await connect()
    }

    func disconnect() {
        client = nil
        directory = nil
        selectedWorkspaceID = nil
        selectedProjectPath = nil
        snapshot = nil
        etag = nil
        isShowingCachedData = false
        cacheSavedAt = nil
        serviceVersion = nil
        connectionState = .disconnected
        lastError = nil
        activeProfileID = nil
        defaults.removeObject(forKey: DefaultsKey.activeProfile)
    }

    func forget(_ profile: ServerProfile) async {
        profiles.removeAll { $0.id == profile.id }
        persistProfiles()
        defaults.removeObject(forKey: DefaultsKey.workspace(profile.id))
        defaults.removeObject(forKey: DefaultsKey.directory(profile.id))
        try? await snapshotStore.remove(serverID: profile.id)
        if activeProfileID == profile.id {
            activeProfileID = nil
            defaults.removeObject(forKey: DefaultsKey.activeProfile)
            serverURL = ""
            disconnect()
        }
    }

    func refresh() async {
        guard !isRefreshing, let client, let workspaceID = selectedWorkspaceID else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            switch try await client.workspace(id: workspaceID, etag: etag) {
            case let .unchanged(newETag):
                etag = newETag
                isShowingCachedData = false
            case let .snapshot(newSnapshot, newETag):
                guard selectedWorkspaceID == workspaceID else { return }
                snapshot = newSnapshot
                etag = newETag
                isShowingCachedData = false
                cacheSavedAt = .now
                await saveCache(newSnapshot, etag: newETag, workspaceID: workspaceID)
                restoreProjectSelection()
            }
            connectionState = .connected
            lastError = nil
        } catch is CancellationError {
            return
        } catch {
            lastError = error.localizedDescription
            if snapshot != nil {
                connectionState = .offline(error.localizedDescription)
                isShowingCachedData = true
            } else {
                connectionState = .failed(error.localizedDescription)
            }
        }
    }

    func refreshDirectory() async {
        guard let client, let profile = activeProfile else { return }
        do {
            let updated = try await client.workspaces(forceRefresh: true)
            directory = updated
            persistDirectory(updated, serverID: profile.id)
            if !updated.workspaces.contains(where: { $0.id == selectedWorkspaceID && $0.isAvailable }),
               let replacement = preferredWorkspace(in: updated, serverID: profile.id) {
                await selectWorkspace(replacement)
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func selectWorkspace(_ workspace: WorkspaceSummary) async {
        guard workspace.isAvailable, workspace.id != selectedWorkspaceID else { return }
        selectedWorkspaceID = workspace.id
        selectedProjectPath = nil
        snapshot = nil
        etag = nil
        isShowingCachedData = false
        cacheSavedAt = nil
        persistSelectedWorkspace()
        await loadSelectedWorkspace(preferCache: true)
    }

    func selectProject(path: String?) {
        selectedProjectPath = path
        guard let profile = activeProfile, let workspaceID = selectedWorkspaceID else { return }
        let key = DefaultsKey.project(profile.id, workspaceID)
        if let path { defaults.set(path, forKey: key) }
        else { defaults.removeObject(forKey: key) }
    }

    func createCapture(text: String, kind: String) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.createCapture(text: text, kind: kind,
                                               projectPath: self.selectedProjectPath, workspaceID: workspaceID)
        }
    }

    func createTask(title: String, type: String, priority: String, dueAt: Date?) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.createTask(title: title, type: type, priority: priority,
                                            projectPath: self.selectedProjectPath, dueAt: dueAt,
                                            workspaceID: workspaceID)
        }
    }

    func moveTask(_ task: WorkTask, to status: String) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.moveTask(id: task.id, status: status, note: nil, workspaceID: workspaceID)
        }
    }

    func toggleChecklist(_ task: WorkTask, section: String, index: Int, checked: Bool) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.toggleChecklist(taskID: task.id, section: section, index: index,
                                                 checked: checked, workspaceID: workspaceID)
        }
    }

    func appendLog(_ task: WorkTask, message: String) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.appendTaskLog(taskID: task.id, message: message, workspaceID: workspaceID)
        }
    }

    func resolveDecision(_ decision: WorkDecision, action: String, option: String?,
                         note: String?, until: Date? = nil) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.resolveDecision(id: decision.id, action: action, option: option,
                                                 note: note, until: until, workspaceID: workspaceID)
        }
    }

    func createIdea(title: String, opportunity: String) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.createIdea(title: title, opportunity: opportunity,
                                            projectPath: self.selectedProjectPath, workspaceID: workspaceID)
        }
    }

    func updateIdea(_ idea: WorkIdea, status: String, reason: String?) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.updateIdeaStatus(id: idea.id, status: status, reason: reason,
                                                 workspaceID: workspaceID)
        }
    }

    func requestIdeaEvaluation(_ idea: WorkIdea) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.requestIdeaEvaluation(id: idea.id, workspaceID: workspaceID)
        }
    }

    func deleteIdea(_ idea: WorkIdea) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            try await client.deleteIdea(id: idea.id, workspaceID: workspaceID)
        }
    }

    func deleteCapture(_ capture: WorkCapture) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            try await client.deleteCapture(id: capture.id, workspaceID: workspaceID)
        }
    }

    func createNote(title: String, text: String) async -> Bool {
        await mutate {
            guard let client = self.client, let workspaceID = self.selectedWorkspaceID else { return }
            _ = try await client.createNote(title: title, text: text,
                                            projectPath: self.selectedProjectPath, workspaceID: workspaceID)
        }
    }

    private func mutate(_ operation: @escaping @MainActor () async throws -> Void) async -> Bool {
        guard !isMutating, !isShowingCachedData, client != nil, selectedWorkspaceID != nil else { return false }
        isMutating = true
        lastError = nil
        do {
            try await operation()
            etag = nil
            isMutating = false
            await refresh()
            return true
        } catch {
            isMutating = false
            lastError = error.localizedDescription
            return false
        }
    }

    private func loadSelectedWorkspace(preferCache: Bool) async {
        guard let profile = activeProfile, let workspaceID = selectedWorkspaceID else { return }
        if preferCache, let cached = try? await snapshotStore.load(serverID: profile.id, workspaceID: workspaceID) {
            snapshot = cached.snapshot
            etag = cached.etag
            cacheSavedAt = cached.savedAt
            isShowingCachedData = true
            restoreProjectSelection()
        }
        await refresh()
    }

    private func restoreCachedConnection() async -> Bool {
        guard let profile = profiles.first(where: { $0.url == serverURL }),
              let workspaceID = defaults.string(forKey: DefaultsKey.workspace(profile.id)),
              let cached = try? await snapshotStore.load(serverID: profile.id, workspaceID: workspaceID) else {
            return false
        }
        activeProfileID = profile.id
        directory = persistedDirectory(serverID: profile.id) ?? WorkspaceDirectory(
            defaultWorkspaceId: workspaceID,
            activeWorkspaceId: workspaceID,
            workspaces: [WorkspaceSummary(id: workspaceID, name: cached.snapshot.workspace.name,
                                          root: cached.snapshot.workspace.root,
                                          location: cached.snapshot.workspace.location,
                                          available: false, peer: cached.snapshot.workspace.peer)]
        )
        selectedWorkspaceID = workspaceID
        snapshot = cached.snapshot
        etag = cached.etag
        cacheSavedAt = cached.savedAt
        isShowingCachedData = true
        restoreProjectSelection()
        return true
    }

    private func preferredWorkspace(in directory: WorkspaceDirectory, serverID: String) -> WorkspaceSummary? {
        let remembered = defaults.string(forKey: DefaultsKey.workspace(serverID))
        return directory.workspaces.first { $0.id == remembered && $0.isAvailable }
            ?? directory.workspaces.first { $0.id == directory.defaultWorkspaceId && $0.isAvailable }
            ?? directory.workspaces.first(where: \.isAvailable)
    }

    private func includes(_ projectPath: String?) -> Bool {
        guard let scope = selectedProjectPath, scope != "." else { return true }
        guard let projectPath else { return false }
        return projectPath == scope || projectPath.hasPrefix("\(scope)/")
    }

    private func restoreProjectSelection() {
        guard let profile = activeProfile, let workspaceID = selectedWorkspaceID else { return }
        let remembered = defaults.string(forKey: DefaultsKey.project(profile.id, workspaceID))
        if let remembered, snapshot?.projects.contains(where: { $0.path == remembered }) == true {
            selectedProjectPath = remembered
        } else {
            selectedProjectPath = nil
        }
    }

    private func saveCache(_ snapshot: WorkspacePayload, etag: String?, workspaceID: String) async {
        guard let profile = activeProfile else { return }
        do {
            try await snapshotStore.save(CachedWorkspace(snapshot: snapshot, etag: etag, savedAt: .now),
                                         serverID: profile.id, workspaceID: workspaceID)
            cacheWarning = nil
        } catch {
            cacheWarning = "Connected, but the offline snapshot could not be saved: \(error.localizedDescription)"
        }
    }

    private func upsert(_ profile: ServerProfile) {
        if let index = profiles.firstIndex(where: { $0.id == profile.id }) {
            profiles[index] = profile
        } else {
            profiles.append(profile)
        }
        persistProfiles()
    }

    private func persistProfiles() {
        if let data = try? encoder.encode(profiles) { defaults.set(data, forKey: DefaultsKey.profiles) }
    }

    private func persistSelectedWorkspace() {
        guard let profile = activeProfile, let selectedWorkspaceID else { return }
        defaults.set(selectedWorkspaceID, forKey: DefaultsKey.workspace(profile.id))
    }

    private func persistDirectory(_ directory: WorkspaceDirectory, serverID: String) {
        if let data = try? encoder.encode(directory) { defaults.set(data, forKey: DefaultsKey.directory(serverID)) }
    }

    private func persistedDirectory(serverID: String) -> WorkspaceDirectory? {
        guard let data = defaults.data(forKey: DefaultsKey.directory(serverID)) else { return nil }
        return try? decoder.decode(WorkspaceDirectory.self, from: data)
    }
}
