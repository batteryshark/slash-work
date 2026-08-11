import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { IssuesView() } label: {
                        Label {
                            LabeledContent(
                                "Issues",
                                value: model.scopedIssues.count.formatted()
                            )
                        } icon: {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .foregroundStyle(.purple)
                        }
                    }
                    NavigationLink { NotesView() } label: {
                        Label { LabeledContent("Notes", value: model.scopedNotes.count.formatted()) }
                        icon: { Image(systemName: "note.text").foregroundStyle(.blue) }
                    }
                    NavigationLink { CaptureInboxView() } label: {
                        Label { LabeledContent("Capture Inbox", value: model.scopedCaptures.count.formatted()) }
                        icon: { Image(systemName: "tray.full").foregroundStyle(.orange) }
                    }
                    NavigationLink { ProjectsView() } label: {
                        Label { LabeledContent("Projects", value: (model.snapshot?.projects.count ?? 0).formatted()) }
                        icon: { Image(systemName: "folder.fill").foregroundStyle(.indigo) }
                    }
                }

                Section("Connection") {
                    NavigationLink { ConnectionsView() } label: {
                        Label("Work Instances", systemImage: "server.rack")
                    }
                    if let workspace = model.selectedWorkspace {
                        LabeledContent("Workspace", value: workspace.name)
                    }
                    if let version = model.serviceVersion {
                        LabeledContent("Work version", value: version)
                    }
                }

                Section {
                    Button {
                        Task {
                            await model.refreshDirectory()
                            await model.refresh()
                        }
                    } label: {
                        Label("Refresh workspaces", systemImage: "arrow.triangle.2.circlepath")
                    }
                    Button(role: .destructive) { model.disconnect() } label: {
                        Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
        }
    }
}

private struct IssuesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewIssue = false

    var body: some View {
        List {
            if model.isShowingCachedData {
                Section { ConnectionBanner().listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)
            }

            if sortedIssues.isEmpty {
                ContentUnavailableView(
                    "No issues",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("File anything that needs an agent to investigate or answer.")
                )
                .listRowBackground(Color.clear)
            } else {
                ForEach(sortedIssues) { issue in
                    NavigationLink { IssueDetailView(issueID: issue.id) } label: {
                        IssueRow(issue: issue)
                    }
                    .accessibilityLabel(
                        "\(issue.title), \(issue.state.title), \(issue.messages.count) replies"
                    )
                }
            }
        }
        .navigationTitle("Issues")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingNewIssue = true } label: {
                    Label("File issue", systemImage: "square.and.pencil")
                }
                .disabled(model.isShowingCachedData || model.isMutating)
                .accessibilityHint("Opens a free-form issue composer")
            }
        }
        .sheet(isPresented: $showingNewIssue) {
            NewIssueSheet().environmentObject(model)
        }
    }

    private var sortedIssues: [WorkIssue] {
        model.scopedIssues.sorted {
            let left = sortRank($0.state)
            let right = sortRank($1.state)
            return left == right ? $0.updatedAt > $1.updatedAt : left < right
        }
    }

    private func sortRank(_ state: WorkIssueState) -> Int {
        switch state {
        case .needsHuman: 0
        case .inProgress: 1
        case .queued: 2
        case .resolved: 3
        case .closed: 4
        }
    }
}

private struct IssueRow: View {
    let issue: WorkIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(issue.title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Spacer(minLength: 8)
                IssueStatePill(state: issue.state)
            }

            Text(issue.body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            HStack(spacing: 12) {
                Label(
                    issue.messages.count.formatted(),
                    systemImage: "bubble.left"
                )
                if let updated = WorkFormatting.relative(issue.updatedAt) {
                    Label(updated, systemImage: "clock")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

private struct NewIssueSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @State private var bodyText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Filing to") {
                    if let project = model.selectedProject {
                        LabeledContent("Project", value: project.name)
                        Text(project.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } else {
                        LabeledContent(
                            "Workspace",
                            value: model.selectedWorkspace?.name ?? model.snapshot?.workspace.name ?? "Workspace"
                        )
                        Text(model.selectedWorkspace?.root ?? model.snapshot?.workspace.root ?? "")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Section {
                    ZStack(alignment: .topLeading) {
                        if bodyText.isEmpty {
                            Text("What should the agent pick up?")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 8)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $bodyText)
                            .frame(minHeight: 240)
                            .focused($isFocused)
                            .accessibilityLabel("Issue description")
                            .accessibilityHint("Markdown and multiple lines are supported")
                    }
                } footer: {
                    Text("Only this text is required. A title is created automatically.")
                }
            }
            .navigationTitle("File Issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") {
                        Task {
                            if await model.createIssue(body: bodyText) { dismiss() }
                        }
                    }
                    .disabled(trimmedBody.isEmpty || model.isMutating || model.isShowingCachedData)
                }
            }
            .onAppear { isFocused = true }
        }
    }

    private var trimmedBody: String {
        bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct IssueDetailView: View {
    @EnvironmentObject private var model: AppModel
    @State private var replyText = ""
    @State private var confirmingClose = false
    @FocusState private var replyFocused: Bool
    let issueID: String

    var body: some View {
        Group {
            if let issue {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if model.isShowingCachedData {
                            ConnectionBanner()
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                IssueStatePill(state: issue.state)
                                Spacer()
                                if issue.state.isTerminal {
                                    Button {
                                        Task { _ = await model.reopen(issue) }
                                    } label: {
                                        Label("Reopen", systemImage: "arrow.uturn.backward")
                                    }
                                    .buttonStyle(.bordered)
                                    .disabled(model.isShowingCachedData || model.isMutating)
                                }
                            }
                            Text(issue.id)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            MarkdownText(source: issue.body)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(messageMetadata(
                                author: WorkIssueAuthor(kind: "human", name: nil),
                                createdAt: issue.createdAt
                            ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding()
                        .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))

                        ForEach(issue.messages) { message in
                            IssueMessageView(message: message)
                        }

                        if let summary = issue.resolutionSummary, !summary.isEmpty {
                            VStack(alignment: .leading, spacing: 7) {
                                Label("Resolution", systemImage: "checkmark.circle.fill")
                                    .font(.headline)
                                    .foregroundStyle(.green)
                                MarkdownText(source: summary)
                            }
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.green.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
                        }

                        if !issue.stateHistory.isEmpty {
                            DisclosureGroup("State history") {
                                VStack(alignment: .leading, spacing: 12) {
                                    ForEach(Array(issue.stateHistory.enumerated()), id: \.offset) { _, change in
                                        IssueHistoryRow(change: change)
                                    }
                                }
                                .padding(.top, 10)
                            }
                            .accessibilityHint("Shows who changed this issue and when")
                        }
                    }
                    .padding()
                }
                .safeAreaInset(edge: .bottom) {
                    IssueReplyComposer(
                        text: $replyText,
                        isFocused: $replyFocused,
                        issue: issue
                    )
                    .environmentObject(model)
                }
                .navigationTitle(issue.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { issueActions(issue) }
                .confirmationDialog(
                    "Close this issue?",
                    isPresented: $confirmingClose,
                    titleVisibility: .visible
                ) {
                    Button("Close Issue", role: .destructive) {
                        Task { _ = await model.close(issue) }
                    }
                } message: {
                    Text("You can reopen it later. Agents cannot close issues.")
                }
            } else {
                ContentUnavailableView(
                    "Issue unavailable",
                    systemImage: "exclamationmark.bubble",
                    description: Text("It may have moved outside the current project scope.")
                )
            }
        }
    }

    private var issue: WorkIssue? {
        model.snapshot?.issues.first { $0.id == issueID }
    }

    @ToolbarContentBuilder
    private func issueActions(_ issue: WorkIssue) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if issue.state.isTerminal {
                    Button {
                        Task { _ = await model.reopen(issue) }
                    } label: {
                        Label("Reopen", systemImage: "arrow.uturn.backward.circle")
                    }
                    .disabled(model.isShowingCachedData || model.isMutating)
                }

                if issue.state != .closed {
                    Button(role: .destructive) { confirmingClose = true } label: {
                        Label("Close Issue", systemImage: "xmark.circle")
                    }
                    .disabled(model.isShowingCachedData || model.isMutating)
                }
            } label: {
                Label("Issue actions", systemImage: "ellipsis.circle")
            }
        }
    }

    private func messageMetadata(author: WorkIssueAuthor, createdAt: String) -> String {
        let time = WorkFormatting.date(from: createdAt)?
            .formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return [author.displayName, time].compactMap { $0 }.joined(separator: " · ")
    }
}

private struct IssueMessageView: View {
    let message: WorkIssueMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                message.author.displayName,
                systemImage: message.author.kind == "agent" ? "cpu" : "person.fill"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(message.author.kind == "agent" ? .purple : .blue)

            MarkdownText(source: message.body)

            if let date = WorkFormatting.date(from: message.createdAt) {
                Text(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            message.author.kind == "agent" ? Color.purple.opacity(0.1) : Color.blue.opacity(0.1),
            in: RoundedRectangle(cornerRadius: 14)
        )
        .accessibilityElement(children: .combine)
    }
}

private struct IssueReplyComposer: View {
    @EnvironmentObject private var model: AppModel
    @Binding var text: String
    let isFocused: FocusState<Bool>.Binding
    let issue: WorkIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if model.isShowingCachedData {
                Label("Offline snapshots are read-only. Reconnect to reply.", systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if replyReturnsToQueue {
                Label(replyStateMessage, systemImage: "arrow.uturn.backward")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Write a reply…", text: $text, axis: .vertical)
                    .lineLimit(1...8)
                    .textFieldStyle(.roundedBorder)
                    .focused(isFocused)
                    .disabled(model.isShowingCachedData)
                    .accessibilityHint("Markdown and multiple lines are supported")

                Button {
                    Task {
                        if await model.reply(to: issue, body: text) { text = "" }
                    }
                } label: {
                    Label(
                        issue.state.isTerminal ? "Reply and reopen"
                            : issue.state == .needsHuman ? "Reply and return to queue" : "Reply",
                        systemImage: "arrow.up.circle.fill"
                    )
                    .labelStyle(.iconOnly)
                    .font(.title2)
                }
                .disabled(
                    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.isMutating
                        || model.isShowingCachedData
                )
            }
        }
        .padding()
        .background(.bar)
    }

    private var replyReturnsToQueue: Bool {
        issue.state == .needsHuman || issue.state.isTerminal
    }

    private var replyStateMessage: String {
        if issue.state.isTerminal {
            return "Replying will reopen this issue and return it to Queued."
        }
        return "Replying will answer the request and return this issue to Queued."
    }
}

private struct IssueHistoryRow: View {
    let change: WorkIssueStateChange

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(historyTitle)
                    .font(.subheadline.weight(.medium))
                Spacer()
                if let date = WorkFormatting.date(from: change.at) {
                    Text(date.formatted(.dateTime.month(.abbreviated).day()))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text("By \(change.actor.displayName)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let reason = change.reason, !reason.isEmpty {
                MarkdownText(source: reason)
                    .font(.caption)
            }
            if let summary = change.resolutionSummary, !summary.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Resolution")
                        .font(.caption.weight(.semibold))
                    MarkdownText(source: summary)
                        .font(.caption)
                }
                .padding(.top, 3)
            }
        }
    }

    private var historyTitle: String {
        if let from = change.from {
            return "\(from.title) → \(change.to.title)"
        }
        return change.to.title
    }
}

private struct IssueStatePill: View {
    let state: WorkIssueState

    var body: some View {
        Text(state.title)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Color.workStatus(state.rawValue))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.workStatus(state.rawValue).opacity(0.12), in: Capsule())
            .accessibilityLabel("State: \(state.title)")
    }
}

private struct MarkdownText: View {
    let source: String

    var body: some View {
        if let attributed = try? AttributedString(markdown: source) {
            Text(attributed)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        } else {
            Text(source)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }
}

private struct NotesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewNote = false

    var body: some View {
        List {
            if model.scopedNotes.isEmpty {
                ContentUnavailableView("No notes", systemImage: "note.text",
                                       description: Text("Add durable project context without turning it into a task."))
                    .listRowBackground(Color.clear)
            } else {
                ForEach(model.scopedNotes.sorted { $0.updatedAt > $1.updatedAt }) { note in
                    NavigationLink {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                Text(note.title).font(.largeTitle.bold())
                                if note.createdBy.kind == "agent" {
                                    Label("Created by \(note.createdBy.name ?? "agent")", systemImage: "cpu")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Text(note.text).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                            }
                            .padding()
                        }
                        .navigationTitle("Note")
                        .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(note.title).font(.headline)
                            Text(note.text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .padding(.vertical, 5)
                    }
                }
            }
        }
        .navigationTitle("Notes")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingNewNote = true } label: { Image(systemName: "plus") }
                    .disabled(model.isShowingCachedData)
            }
        }
        .sheet(isPresented: $showingNewNote) { NewNoteSheet().environmentObject(model) }
    }
}

private struct NewNoteSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Note") {
                    TextField("Title", text: $title)
                    TextEditor(text: $text).frame(minHeight: 180)
                }
            }
            .navigationTitle("New Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.createNote(
                                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                text: text.trimmingCharacters(in: .whitespacesAndNewlines)
                            ) { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}

private struct CaptureInboxView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            if model.scopedCaptures.isEmpty {
                ContentUnavailableView("Inbox clear", systemImage: "tray",
                                       description: Text("New captures will appear here."))
                    .listRowBackground(Color.clear)
            } else {
                ForEach(model.scopedCaptures.sorted { $0.createdAt > $1.createdAt }) { capture in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(WorkFormatting.title(for: capture.kind), systemImage: icon(for: capture.kind))
                            .font(.caption.weight(.semibold)).foregroundStyle(.purple)
                        Text(capture.text)
                        if let date = WorkFormatting.date(from: capture.createdAt) {
                            Text(date.formatted(.relative(presentation: .named)))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await model.deleteCapture(capture) }
                        } label: { Label("Delete", systemImage: "trash") }
                        .disabled(model.isShowingCachedData)
                    }
                }
            }
        }
        .navigationTitle("Capture Inbox")
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "idea": "lightbulb"
        case "question": "questionmark.circle"
        default: "bolt"
        }
    }
}

private struct ProjectsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewProject = false
    @State private var projectToDelete: WorkProject?

    var body: some View {
        List {
            if projects.isEmpty {
                ContentUnavailableView("No projects", systemImage: "folder",
                                       description: Text("Create a project to organize tasks, notes, and decisions."))
                    .listRowBackground(Color.clear)
            } else {
                ForEach(projects) { project in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(project.name).font(.headline)
                        Text(project.path).font(.caption.monospaced()).foregroundStyle(.secondary)
                        if !project.description.isEmpty {
                            Text(project.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .padding(.vertical, 5)
                    .swipeActions {
                        Button(role: .destructive) { projectToDelete = project } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .disabled(model.isShowingCachedData || model.isMutating)
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

    private var projects: [WorkProject] {
        (model.snapshot?.projects ?? []).sorted { $0.path < $1.path }
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

private struct ConnectionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var profileToForget: ServerProfile?

    var body: some View {
        List {
            ForEach(model.profiles) { profile in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Label(profile.name, systemImage: profile.id == model.activeProfileID ? "checkmark.circle.fill" : "server.rack")
                        Spacer()
                        if profile.id == model.activeProfileID { Text("Connected").font(.caption).foregroundStyle(.green) }
                    }
                    Text(profile.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard profile.id != model.activeProfileID else { return }
                    Task { await model.connect(to: profile) }
                }
                .swipeActions {
                    Button(role: .destructive) { profileToForget = profile } label: {
                        Label("Forget", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle("Work Instances")
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
