import SwiftUI

/// The web's left rail as a sheet: workspace picker, project tree with open
/// counts and tag filter, then management and service controls.
struct ScopeSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var tagFilter: String?

    var body: some View {
        NavigationStack {
            List {
                if let directory = model.directory, directory.workspaces.count > 1 {
                    Section("Workspace") {
                        ForEach(directory.workspaces) { workspace in
                            Button {
                                Task { await model.selectWorkspace(workspace) }
                                dismiss()
                            } label: {
                                HStack {
                                    Image(systemName: workspace.id == model.selectedWorkspaceID
                                          ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(workspace.id == model.selectedWorkspaceID
                                                         ? WorkTheme.accent : WorkTheme.muted)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(workspace.name).foregroundStyle(WorkTheme.ink)
                                        Text(workspace.root)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(WorkTheme.muted)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                }

                Section("Projects") {
                    if !vocabulary.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(vocabulary, id: \.self) { tag in
                                    Button {
                                        tagFilter = tagFilter == tag ? nil : tag
                                    } label: {
                                        TagChip(tag: tag, selected: tagFilter == tag)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Filter by tag \(tag)")
                                    .accessibilityAddTraits(tagFilter == tag ? [.isSelected] : [])
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }

                    scopeRow(name: "All projects", path: nil,
                             count: model.openTaskCount(under: nil),
                             selected: model.selectedProjectPath == nil)

                    ForEach(projectGroups(filteredProjects)) { group in
                        DisclosureGroup(isExpanded: groupBinding(group.key)) {
                            ForEach(group.projects) { project in
                                scopeRow(name: project.name, path: project.path,
                                         count: model.openTaskCount(under: project.path),
                                         selected: model.selectedProjectPath == project.path,
                                         tags: project.tagList)
                            }
                        } label: {
                            HStack {
                                Text(group.title).font(.subheadline.weight(.semibold))
                                Spacer()
                                Text("\(group.projects.count)")
                                    .font(.caption)
                                    .foregroundStyle(WorkTheme.muted)
                            }
                        }
                    }
                }

                Section("Manage") {
                    NavigationLink { ProjectsView() } label: {
                        Label("Projects", systemImage: "folder")
                    }
                    NavigationLink { ConnectionsView() } label: {
                        Label("Work instances", systemImage: "server.rack")
                    }
                }

                Section("Service") {
                    if let version = model.serviceVersion {
                        LabeledContent(model.activeProfile.map { "\($0.name) version" } ?? "Work version",
                                       value: version)
                    }
                    Button {
                        Task { await model.restartService() }
                    } label: {
                        Label(model.isRestartingService ? "Restarting…" : "Restart the service",
                              systemImage: "arrow.triangle.2.circlepath.circle")
                    }
                    .disabled(model.isRestartingService || model.isShowingCachedData)
                    Button {
                        Task {
                            await model.refreshDirectory()
                            await model.refresh()
                        }
                    } label: {
                        Label("Refresh workspaces", systemImage: "arrow.triangle.2.circlepath")
                    }
                    Button(role: .destructive) {
                        model.disconnect()
                        dismiss()
                    } label: {
                        Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .navigationTitle("Scope")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .onAppear {
                // The group containing the selection starts open.
                if let selected = model.selectedProjectPath, selected.contains("/") {
                    expandedGroups.insert(String(selected.split(separator: "/")[0]))
                }
            }
        }
    }

    @State private var expandedGroups: Set<String> = []

    private func groupBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { expandedGroups.contains(key) || tagFilter != nil },
            set: { open in
                if open { expandedGroups.insert(key) } else { expandedGroups.remove(key) }
            }
        )
    }

    private func scopeRow(name: String, path: String?, count: Int, selected: Bool,
                          tags: [String] = []) -> some View {
        Button {
            model.selectProject(path: path)
            dismiss()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: selected ? "checkmark" : (path == nil ? "square.grid.2x2" : "folder"))
                    .font(.caption)
                    .foregroundStyle(selected ? WorkTheme.accent : WorkTheme.muted)
                    .frame(width: 18)
                Text(name)
                    .font(.subheadline)
                    .foregroundStyle(WorkTheme.ink)
                    .lineLimit(1)
                ForEach(tags.prefix(2), id: \.self) { TagChip(tag: $0) }
                Spacer()
                if count > 0 {
                    Text("\(count)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(WorkTheme.muted)
                }
            }
        }
    }

    private var filteredProjects: [WorkProject] {
        let all = model.snapshot?.projects ?? []
        guard let tagFilter else { return all }
        return all.filter { $0.tagList.contains { $0.caseInsensitiveCompare(tagFilter) == .orderedSame } }
    }

    private var vocabulary: [String] {
        WorkTag.vocabulary(model.snapshot?.projects ?? [])
    }
}

struct ProjectsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewProject = false
    @State private var projectToDelete: WorkProject?
    @State private var projectToTag: WorkProject?

    var body: some View {
        List {
            if projects.isEmpty {
                ContentUnavailableView("No projects", systemImage: "folder",
                                       description: Text("Create a project to organize tasks, notes, and decisions."))
                    .listRowBackground(Color.clear)
            } else {
                ForEach(projectGroups(projects)) { group in
                    Section(group.title) {
                        ForEach(group.projects) { project in row(project) }
                    }
                }
            }
        }
        .navigationTitle("Projects")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingNewProject = true } label: { Image(systemName: "plus") }
                    .disabled(model.isShowingCachedData || model.isMutating)
                    .accessibilityLabel("New project")
            }
        }
        .sheet(isPresented: $showingNewProject) { NewProjectSheet().environmentObject(model) }
        .sheet(item: $projectToTag) { project in ProjectTagsSheet(project: project).environmentObject(model) }
        .confirmationDialog("Delete this project?", isPresented: Binding(
            get: { projectToDelete != nil }, set: { if !$0 { projectToDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete \(projectToDelete?.name ?? "Project")", role: .destructive) {
                guard let project = projectToDelete else { return }
                Task { await model.deleteProject(project) }
            }
        } message: {
            Text("This removes the project's Work records (tasks, notes, decisions). The folder is kept if it still contains your files. This cannot be undone.")
        }
    }

    private func row(_ project: WorkProject) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.name).font(.subheadline.weight(.semibold))
            Text(project.path).font(.caption2.monospaced()).foregroundStyle(WorkTheme.muted)
            if !project.tagList.isEmpty {
                HStack(spacing: 5) {
                    ForEach(project.tagList, id: \.self) { TagChip(tag: $0) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .swipeActions {
            Button(role: .destructive) { projectToDelete = project } label: {
                Label("Delete", systemImage: "trash")
            }
            .disabled(model.isShowingCachedData || model.isMutating)
            Button { projectToTag = project } label: {
                Label("Tags", systemImage: "tag")
            }
            .tint(.indigo)
            .disabled(model.isShowingCachedData || model.isMutating)
        }
    }

    private var projects: [WorkProject] {
        (model.snapshot?.projects ?? []).sorted { $0.path < $1.path }
    }
}

/// Tag editing follows the section editor's rules: explicit action, disabled
/// while mutating or on cached data. Each add or remove is its own save, so
/// there is no half-typed list to lose.
struct ProjectTagsSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let project: WorkProject
    @State private var draft = ""

    private var tags: [String] {
        (model.snapshot?.projects.first { $0.path == project.path } ?? project).tagList
    }

    private var suggestions: [String] {
        let taken = Set(tags.map { $0.lowercased() })
        let query = draft.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return WorkTag.vocabulary(model.snapshot?.projects ?? [])
            .filter { !taken.contains($0.lowercased()) && (query.isEmpty || $0.lowercased().contains(query)) }
            .prefix(8)
            .map(\.self)
    }

    private var isNew: Bool {
        let query = draft.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !query.isEmpty
            && !WorkTag.vocabulary(model.snapshot?.projects ?? []).contains { $0.lowercased() == query }
    }

    private var locked: Bool { model.isMutating || model.isShowingCachedData }

    var body: some View {
        NavigationStack {
            Form {
                Section("Tags") {
                    if tags.isEmpty {
                        Text("No tags. Optional — a project works exactly the same without them.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(tags, id: \.self) { tag in
                        HStack {
                            TagChip(tag: tag)
                            Spacer()
                            Button {
                                save(tags.filter { $0 != tag })
                            } label: {
                                Image(systemName: "minus.circle.fill").foregroundStyle(.red)
                            }
                            .buttonStyle(.plain)
                            .disabled(locked)
                            .accessibilityLabel("Remove tag \(tag)")
                        }
                    }
                }
                Section("Add") {
                    TextField("Tag", text: $draft)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onSubmit { add(draft) }
                    if isNew {
                        Button("Create “\(draft.trimmingCharacters(in: .whitespacesAndNewlines))”") { add(draft) }
                            .disabled(locked)
                    }
                    ForEach(suggestions, id: \.self) { tag in
                        Button { add(tag) } label: { TagChip(tag: tag) }
                            .buttonStyle(.plain)
                            .disabled(locked)
                    }
                }
            }
            .navigationTitle(project.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }

    private func add(_ tag: String) {
        let next = WorkTag.normalize(tags + [tag])
        draft = ""
        guard next.count != tags.count else { return }
        save(next)
    }

    private func save(_ next: [String]) {
        Task { _ = await model.setProjectTags(project, next) }
    }
}

private struct NewProjectSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var parentPath: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("Name", text: $name)
                }
                Section("Create under") {
                    Picker("Parent", selection: $parentPath) {
                        Text("Workspace root").tag(String?.none)
                        ForEach(model.snapshot?.projects ?? []) { project in
                            Text(project.name).tag(String?.some(project.path))
                        }
                    }
                }
            }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            if await model.createProject(
                                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                parentPath: parentPath
                            ) { dismiss() }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}

struct ConnectionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var profileToForget: ServerProfile?
    @State private var addingInstance = false

    var body: some View {
        List {
            if model.profiles.isEmpty {
                ContentUnavailableView("No Work instances", systemImage: "server.rack",
                                       description: Text("Add the URL that `work --tailscale` prints."))
            }
            ForEach(model.profiles) { profile in
                let active = profile.id == model.activeProfileID
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Label(profile.name, systemImage: active ? "checkmark.circle.fill" : "server.rack")
                        Spacer()
                        // The version is only known for the instance actually
                        // connected, so it is labelled per row rather than once
                        // as though it described all of them.
                        if active {
                            Text(model.serviceVersion.map { "Connected · \($0)" } ?? "Connected")
                                .font(.caption).foregroundStyle(WorkTheme.success)
                        }
                    }
                    Text(profile.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard !active else { return }
                    Task { await model.connect(to: profile) }
                }
                .swipeActions {
                    Button(role: .destructive) { profileToForget = profile } label: {
                        Label("Forget", systemImage: "trash")
                    }
                }
            }
            .onDelete { offsets in
                if let index = offsets.first, model.profiles.indices.contains(index) {
                    profileToForget = model.profiles[index]
                }
            }
        }
        .navigationTitle("Work Instances")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { addingInstance = true } label: { Label("Add", systemImage: "plus") }
                    .accessibilityLabel("Add a Work instance")
            }
            // Swipe-to-forget alone hid the capability; Edit makes it visible.
            ToolbarItem(placement: .topBarLeading) { EditButton() }
        }
        .sheet(isPresented: $addingInstance) { AddInstanceSheet() }
        .confirmationDialog("Forget this Work instance?", isPresented: Binding(
            get: { profileToForget != nil }, set: { if !$0 { profileToForget = nil } }
        ), titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                guard let profile = profileToForget else { return }
                Task { await model.forget(profile) }
            }
        } message: {
            Text("Its cached snapshots will also be removed from this device.")
        }
    }
}

/// Adding an instance was possible only on the first-run connection screen, so
/// a second Work server could not be added once one was connected.
private struct AddInstanceSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://100.x.y.z:43170", text: $url)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { add() }
                } header: {
                    Text("Work URL")
                } footer: {
                    Text("Start Work with `work --tailscale`, then enter the API URL it prints. Adding an instance connects to it.")
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("Add Instance")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { add() }
                        .disabled(url.trimmingCharacters(in: .whitespaces).isEmpty
                                  || model.connectionState == .connecting)
                }
            }
            .onAppear { focused = true }
        }
    }

    private func add() {
        let candidate = url.trimmingCharacters(in: .whitespaces)
        guard !candidate.isEmpty else { return }
        do {
            _ = try WorkAPIClient.validatedURL(from: candidate)
        } catch {
            self.error = error.localizedDescription
            return
        }
        model.serverURL = candidate
        Task {
            await model.connect()
            if case .failed(let message) = model.connectionState {
                self.error = message
            } else {
                dismiss()
            }
        }
    }
}
