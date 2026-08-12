import Foundation
import SwiftUI

// Server keys come and go. Decoding a missing (or wrongly typed) key to a
// default keeps an older app talking to a newer Work instead of failing whole.
extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    func value<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

struct WorkServiceHealth: Decodable, Sendable {
    let ok: Bool
    let service: ServiceSummary?

    struct ServiceSummary: Decodable, Sendable {
        let instanceId: String?
        let version: String?
        let staleBuild: Bool?
    }
}

struct WorkspaceDirectory: Codable, Sendable {
    let defaultWorkspaceId: String
    let activeWorkspaceId: String
    let workspaces: [WorkspaceSummary]
}

struct WorkspaceSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let root: String
}

struct WorkspacePayload: Codable, Sendable {
    let version: Int
    let workspace: WorkspaceInfo
    let projects: [WorkProject]
    let captures: [WorkCapture]
    let decisions: [WorkDecision]
    let issues: [WorkIssue]
    let notes: [WorkNote]
    let tasks: [WorkTask]
    /// True when the running service is older than the code on disk.
    let staleBuild: Bool?

    private enum CodingKeys: String, CodingKey {
        case version, workspace, projects, captures, decisions, issues, notes, tasks, staleBuild
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        staleBuild = try container.decodeIfPresent(Bool.self, forKey: .staleBuild)
        workspace = try container.decode(WorkspaceInfo.self, forKey: .workspace)
        projects = try container.decode([WorkProject].self, forKey: .projects)
        captures = try container.decode([WorkCapture].self, forKey: .captures)
        decisions = try container.decode([WorkDecision].self, forKey: .decisions)
        // Old on-device snapshots predate Issues. Keeping them readable preserves
        // the app's offline recovery behavior during an upgrade.
        issues = try container.decodeIfPresent([WorkIssue].self, forKey: .issues) ?? []
        notes = try container.decode([WorkNote].self, forKey: .notes)
        tasks = try container.decode([WorkTask].self, forKey: .tasks)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(workspace, forKey: .workspace)
        try container.encode(projects, forKey: .projects)
        try container.encode(captures, forKey: .captures)
        try container.encode(decisions, forKey: .decisions)
        try container.encode(issues, forKey: .issues)
        try container.encode(notes, forKey: .notes)
        try container.encode(tasks, forKey: .tasks)
        try container.encodeIfPresent(staleBuild, forKey: .staleBuild)
    }
}

struct WorkspaceInfo: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let root: String
    let dataDir: String
    let startScopePath: String?
    let statuses: [String]
}

struct WorkProject: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let projectId: String?
    let name: String
    let description: String
    let path: String
    let depth: Int
    let markers: [String]
    let aliasPaths: [String]?
    /// "board" or "list". Absent on older servers, which only had boards.
    let view: String?

    var showsPlainList: Bool { view == "list" }
}

struct WorkCapture: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let text: String
    let kind: String
    let scopePath: String
    let projectPath: String?
    let createdAt: String
    let updatedAt: String
}

struct WorkDecision: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let projectPath: String?
    let options: [String]
    let recommendedOption: String?
    let status: String
    let resolution: DecisionResolution?
    /// Ids of the Work items this question is about, such as "W-0001".
    let refs: [String]?
    let createdAt: String
    let updatedAt: String

    /// Matches the web's `decisionIsActive`: a deferral whose date has passed is
    /// active again. A deferral with no date, or a date still ahead, stays quiet.
    var isOpen: Bool {
        if status == "open" { return true }
        guard status == "deferred", let until = WorkFormatting.date(from: resolution?.choice?.until) else {
            return false
        }
        return until <= .now
    }
    func references(_ itemID: String) -> Bool { refs?.contains(itemID) == true }
}

struct DecisionResolution: Codable, Hashable, Sendable {
    let action: String
    let choice: DecisionChoice?
    let note: String?
    let at: String
}

struct DecisionChoice: Codable, Hashable, Sendable {
    let option: String?
    let until: String?
    let projectPath: String?
}

enum WorkIssueState: String, Codable, Sendable {
    case queued
    case inProgress = "in_progress"
    case needsHuman = "needs_human"
    case resolved
    case closed

    var title: String {
        switch self {
        case .queued: "Queued"
        case .inProgress: "Agent working"
        case .needsHuman: "Needs you"
        case .resolved: "Resolved"
        case .closed: "Closed"
        }
    }

    var isTerminal: Bool { self == .resolved || self == .closed }
}

struct WorkIssue: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let body: String
    let state: WorkIssueState
    let scopePath: String
    let projectPath: String?
    let claimedBy: WorkIssueAuthor?
    let resolutionSummary: String?
    let messages: [WorkIssueMessage]
    let stateHistory: [WorkIssueStateChange]
    let createdAt: String
    let updatedAt: String
}

struct WorkIssueAuthor: Codable, Hashable, Sendable {
    let kind: String
    let name: String?

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return kind == "agent" ? "Agent" : "You"
    }
}

struct WorkIssueMessage: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let body: String
    let author: WorkIssueAuthor
    let createdAt: String
}

struct WorkIssueStateChange: Codable, Hashable, Sendable {
    let from: WorkIssueState?
    let to: WorkIssueState
    let actor: WorkIssueAuthor
    let reason: String?
    let at: String
    let resolutionSummary: String?
}

struct WorkNote: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let text: String
    let scopePath: String
    let projectPath: String?
    let createdBy: NoteAuthor
    let createdAt: String
    let updatedAt: String
}

struct NoteAuthor: Codable, Hashable, Sendable {
    let kind: String
    let name: String?
}

struct ChecklistItem: Codable, Hashable, Sendable {
    let checked: Bool
    let text: String
}

struct WorkTask: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let status: String
    let projectPath: String?
    /// A human ticks this to hand the item to automation. Agents cannot set it.
    let delegated: Bool
    let tags: [String]
    let dependsOn: [String]
    let blockedBy: [String]
    let blockedReason: String?
    let parentId: String?
    let dueAt: String?
    let source: String?
    let createdAt: String
    let updatedAt: String
    let startedAt: String?
    let completedAt: String?
    let cancelledAt: String?
    let sections: TaskSections
    let requirements: [ChecklistItem]
    let acceptanceCriteria: [ChecklistItem]
    let log: [TaskLogEntry]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.value(.title, id)
        status = c.value(.status, "backlog")
        projectPath = c.value(.projectPath)
        delegated = c.value(.delegated, false)
        tags = c.value(.tags, [])
        dependsOn = c.value(.dependsOn, [])
        blockedBy = c.value(.blockedBy, [])
        blockedReason = c.value(.blockedReason)
        parentId = c.value(.parentId)
        dueAt = c.value(.dueAt)
        source = c.value(.source)
        createdAt = c.value(.createdAt, "")
        updatedAt = c.value(.updatedAt, "")
        startedAt = c.value(.startedAt)
        completedAt = c.value(.completedAt)
        cancelledAt = c.value(.cancelledAt)
        sections = c.value(.sections, TaskSections())
        requirements = c.value(.requirements, [])
        acceptanceCriteria = c.value(.acceptanceCriteria, [])
        log = c.value(.log, [])
    }

    var isFinished: Bool { status == "done" || status == "cancelled" }
    var checklistCompleted: Int {
        requirements.filter(\.checked).count + acceptanceCriteria.filter(\.checked).count
    }
    var checklistTotal: Int { requirements.count + acceptanceCriteria.count }
    /// First non-empty line of the description, for one-line previews.
    var descriptionSummary: String? {
        sections.description
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
    }
}

struct TaskSections: Codable, Hashable, Sendable {
    let description: String
    let goal: String
    let requirements: String
    let acceptanceCriteria: String
    let plan: String
    let notes: String
    let progressLog: String
    let completionSummary: String

    init() {
        self.init(description: "", goal: "", requirements: "", acceptanceCriteria: "",
                  plan: "", notes: "", progressLog: "", completionSummary: "")
    }

    init(description: String, goal: String, requirements: String, acceptanceCriteria: String,
         plan: String, notes: String, progressLog: String, completionSummary: String) {
        self.description = description
        self.goal = goal
        self.requirements = requirements
        self.acceptanceCriteria = acceptanceCriteria
        self.plan = plan
        self.notes = notes
        self.progressLog = progressLog
        self.completionSummary = completionSummary
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        description = c.value(.description, "")
        goal = c.value(.goal, "")
        requirements = c.value(.requirements, "")
        acceptanceCriteria = c.value(.acceptanceCriteria, "")
        plan = c.value(.plan, "")
        notes = c.value(.notes, "")
        progressLog = c.value(.progressLog, "")
        completionSummary = c.value(.completionSummary, "")
    }
}

struct TaskLogEntry: Codable, Hashable, Sendable {
    let at: String
    let message: String
}

struct ServerProfile: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var url: String

    init(id: String = UUID().uuidString, name: String, url: String) {
        self.id = id
        self.name = name
        self.url = url
    }
}

struct CachedWorkspace: Codable, Sendable {
    let snapshot: WorkspacePayload
    let etag: String?
    let savedAt: Date
}

struct ProjectGroup: Identifiable, Hashable, Sendable {
    let key: String
    let title: String
    let projects: [WorkProject]

    var id: String { key }
}

/// The folder path is the taxonomy: a project's first path segment is its group.
/// Projects that sit directly in the root come first, then folders A→Z, and the
/// projects inside each group stay sorted by path.
func projectGroups(_ projects: [WorkProject]) -> [ProjectGroup] {
    var buckets: [String: [WorkProject]] = [:]
    for project in projects where project.path != "." {
        let key = project.path.contains("/") ? String(project.path.split(separator: "/")[0]) : ""
        buckets[key, default: []].append(project)
    }
    return buckets.keys.sorted { left, right in
        if left.isEmpty != right.isEmpty { return left.isEmpty }
        return left < right
    }.map { key in
        ProjectGroup(key: key,
                     title: key.isEmpty ? "Straight in this root" : WorkFormatting.title(for: key),
                     projects: (buckets[key] ?? []).sorted { $0.path < $1.path })
    }
}

enum WorkFormatting {
    private static let fractionalParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let standardParser = ISO8601DateFormatter()

    static func date(from value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return fractionalParser.date(from: value) ?? standardParser.date(from: value)
    }

    static func shortDate(_ value: String?) -> String? {
        guard let date = date(from: value) else { return nil }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    static func relative(_ value: String?) -> String? {
        guard let date = date(from: value) else { return nil }
        return date.formatted(.relative(presentation: .named))
    }

    static func title(for value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

extension Color {
    static func workStatus(_ status: String) -> Color {
        switch status {
        case "done", "adopted", "approved": .green
        case "in_progress", "exploring": .blue
        case "review", "proposed": .purple
        case "blocked", "rejected", "declined": .red
        case "deferred", "needs_human": .orange
        case "cancelled", "closed": .secondary
        case "resolved": .green
        default: .indigo
        }
    }
}
