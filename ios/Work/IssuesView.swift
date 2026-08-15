import SwiftUI

/// The workbench Issues tab: GitHub-style — open and closed, open first,
/// sorted by update, thread with replies underneath.
struct IssuesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewIssue = false

    var body: some View {
        NavigationStack {
            Group {
                // Issues are project records; the web disables this tab at
                // root scope, and the phone matches.
                if model.selectedProjectPath == nil {
                    ContentUnavailableView(
                        "Issues are scoped to a project",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Choose a project from the scope button to view and file issues.")
                    )
                    .background(WorkTheme.canvas)
                } else {
                    issueList
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .workCapture()
        }
    }

    private var issueList: some View {
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
                    .listRowBackground(WorkTheme.surface)
                    .accessibilityLabel(
                        "\(issue.title), \(issue.id), \(issue.state.title), \(issue.messages.count) replies"
                    )
                }
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 34)
        .scrollContentBackground(.hidden)
        .background(WorkTheme.canvas)
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
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

    /// Open before closed; inside each half, the most recently touched first.
    private var sortedIssues: [WorkIssue] {
        model.scopedIssues.sorted {
            let leftClosed = $0.state == .closed
            let rightClosed = $1.state == .closed
            if leftClosed != rightClosed { return !leftClosed }
            return $0.updatedAt > $1.updatedAt
        }
    }
}

private struct IssueRow: View {
    let issue: WorkIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                IssueStatePill(state: issue.state)
                Text(issue.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(WorkTheme.ink)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if issue.delegated {
                    Text("agent")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(WorkTheme.accent)
                }
            }

            HStack(spacing: 10) {
                Text(issue.id)
                    .font(.caption2.monospaced())
                Label(issue.messages.count.formatted(), systemImage: "bubble.left")
                    .font(.caption2)
                if let updated = WorkFormatting.relative(issue.updatedAt) {
                    Text(updated)
                        .font(.caption2)
                }
            }
            .foregroundStyle(WorkTheme.muted)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }
}

private struct NewIssueSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @FocusState private var nameFocused: Bool
    @State private var title = ""
    @State private var bodyText = ""
    @State private var images: [PendingImage] = []

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

                // An issue names itself. Scraping the first body line produced
                // titles like: In issues, """Hand to an agent
                Section {
                    TextField("What is this about?", text: $title)
                        .textInputAutocapitalization(.sentences)
                        .focused($nameFocused)
                } header: {
                    Text("Name")
                }

                Section {
                    ZStack(alignment: .topLeading) {
                        if bodyText.isEmpty {
                            Text("What should the agent investigate?")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 8)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $bodyText)
                            .frame(minHeight: 200)
                            .focused($isFocused)
                            .accessibilityLabel("Issue description")
                            .accessibilityHint("Markdown and multiple lines are supported")
                    }
                } header: {
                    Text("Description")
                }

                Section("Images") {
                    AttachmentTray(images: $images)
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
                            if await model.createIssue(title: title, body: bodyText,
                                                       attachments: images) { dismiss() }
                        }
                    }
                    .disabled(trimmedTitle.isEmpty || (trimmedBody.isEmpty && images.isEmpty)
                              || model.isMutating || model.isShowingCachedData)
                }
            }
            .onAppear { nameFocused = true }
        }
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
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
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if model.isShowingCachedData {
                            ConnectionBanner()
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                IssueStatePill(state: issue.state)
                                Spacer()
                                if issue.state == .closed {
                                    Button {
                                        Task { _ = await model.reopen(issue) }
                                    } label: {
                                        Label("Reopen", systemImage: "arrow.uturn.backward")
                                            .font(.caption)
                                    }
                                    .buttonStyle(.bordered)
                                    .disabled(model.isShowingCachedData || model.isMutating)
                                }
                            }
                            Text(issue.id)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            Text(issue.longId)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                                .textSelection(.enabled)
                                .accessibilityLabel("Long issue ID, \(issue.longId)")
                            MarkdownBody(source: issue.body)
                                .font(.footnote)
                            Text(messageMetadata(
                                author: WorkIssueAuthor(kind: "human", name: nil),
                                createdAt: issue.createdAt
                            ))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(12)
                        .background(WorkTheme.surface, in: RoundedRectangle(cornerRadius: 10))

                        VStack(alignment: .leading, spacing: 6) {
                            Toggle("Hand to an agent", isOn: Binding(
                                get: { issue.delegated },
                                set: { on in Task { _ = await model.setDelegated(issue, on) } }
                            ))
                            .font(.subheadline)
                            .disabled(model.isShowingCachedData || model.isMutating)
                            Text("An agent runner picks up delegated items on its next pass.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(12)
                        .background(WorkTheme.surface, in: RoundedRectangle(cornerRadius: 10))

                        ForEach(issue.messages) { message in
                            IssueMessageView(message: message)
                        }

                        if let summary = issue.resolutionSummary, !summary.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Label("Resolution", systemImage: "checkmark.circle.fill")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(WorkTheme.success)
                                MarkdownBody(source: summary)
                                    .font(.footnote)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(WorkTheme.success.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
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
                            .font(.subheadline)
                            .accessibilityHint("Shows who changed this issue and when")
                        }
                    }
                    .padding(12)
                }
                .background(WorkTheme.canvas)
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
                if issue.state == .closed {
                    Button {
                        Task { _ = await model.reopen(issue) }
                    } label: {
                        Label("Reopen", systemImage: "arrow.uturn.backward.circle")
                    }
                    .disabled(model.isShowingCachedData || model.isMutating)
                } else {
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
        VStack(alignment: .leading, spacing: 6) {
            Label(
                message.author.displayName,
                systemImage: message.author.kind == "agent" ? "cpu" : "person.fill"
            )
            .font(.caption.weight(.semibold))
            .foregroundStyle(message.author.kind == "agent" ? WorkTheme.accent : Color.blue)

            MarkdownBody(source: message.body)
                .font(.footnote)

            if let date = WorkFormatting.date(from: message.createdAt) {
                Text(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            message.author.kind == "agent" ? WorkTheme.accentSoft.opacity(0.6) : WorkTheme.surface,
            in: RoundedRectangle(cornerRadius: 10)
        )
        .accessibilityElement(children: .combine)
    }
}

private struct IssueReplyComposer: View {
    @EnvironmentObject private var model: AppModel
    @Binding var text: String
    let isFocused: FocusState<Bool>.Binding
    let issue: WorkIssue
    @State private var images: [PendingImage] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if model.isShowingCachedData {
                Label("Offline snapshots are read-only. Reconnect to reply.", systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(WorkTheme.warning)
            } else if replyReturnsToQueue {
                Label(replyStateMessage, systemImage: "arrow.uturn.backward")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !model.isShowingCachedData {
                AttachmentTray(images: $images)
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
                        if await model.reply(to: issue, body: text, attachments: images) {
                            text = ""
                            images = []
                        }
                    }
                } label: {
                    Label(
                        issue.state == .closed ? "Reply and reopen"
                            : issue.state == .needsHuman ? "Reply and return to queue" : "Reply",
                        systemImage: "arrow.up.circle.fill"
                    )
                    .labelStyle(.iconOnly)
                    .font(.title2)
                }
                .disabled(
                    (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty)
                        || model.isMutating
                        || model.isShowingCachedData
                )
            }
        }
        .padding()
        .background(.bar)
    }

    private var replyReturnsToQueue: Bool {
        issue.state == .needsHuman || issue.state == .closed
    }

    private var replyStateMessage: String {
        if issue.state == .closed {
            return "Replying will reopen this issue and return it to Open."
        }
        return "Replying will answer the request and return this issue to Open."
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
            .foregroundStyle(pillColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(pillColor.opacity(0.12), in: Capsule())
            .accessibilityLabel("State: \(state.title)")
    }

    private var pillColor: Color {
        switch state {
        case .queued: WorkTheme.success
        case .inProgress: .blue
        case .needsHuman: WorkTheme.warning
        case .closed: WorkTheme.muted
        }
    }
}

/// Markdown rendered as attributed text. Image refs are dropped by
/// AttributedString; the attachment-aware renderer replaces this in M4.
struct MarkdownText: View {
    let source: String

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: source,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
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

/// The Notes tab: newest first, reading pane on push, delete behind a
/// confirmation.
struct NotesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewNote = false
    @State private var noteToDelete: WorkNote?

    var body: some View {
        NavigationStack {
            List {
                if model.scopedNotes.isEmpty {
                    ContentUnavailableView("No notes", systemImage: "note.text",
                                           description: Text("Add durable project context without turning it into a task."))
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(model.scopedNotes.sorted { $0.updatedAt > $1.updatedAt }) { note in
                        NavigationLink {
                            NoteReadingView(noteID: note.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(note.title).font(.footnote.weight(.semibold))
                                Text(note.text)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .padding(.vertical, 3)
                        }
                        .listRowBackground(WorkTheme.surface)
                        .swipeActions {
                            Button(role: .destructive) { noteToDelete = note } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            .disabled(model.isShowingCachedData || model.isMutating)
                        }
                    }
                }
            }
            .confirmationDialog("Delete this note?", isPresented: Binding(
                get: { noteToDelete != nil }, set: { if !$0 { noteToDelete = nil } }
            ), titleVisibility: .visible) {
                Button("Delete Note", role: .destructive) {
                    guard let note = noteToDelete else { return }
                    Task { _ = await model.deleteNote(note) }
                }
            } message: {
                Text("This removes the note and its attachments. This cannot be undone.")
            }
            .listStyle(.insetGrouped)
            .environment(\.defaultMinListRowHeight, 34)
            .scrollContentBackground(.hidden)
            .background(WorkTheme.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .workCapture()
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingNewNote = true } label: { Image(systemName: "plus") }
                        .disabled(model.isShowingCachedData)
                        .accessibilityLabel("New note")
                }
            }
            .sheet(isPresented: $showingNewNote) { NewNoteSheet().environmentObject(model) }
        }
    }
}

struct NoteReadingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let noteID: String
    @State private var editing = false
    @State private var confirmingDelete = false

    var body: some View {
        Group {
            if let note {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(note.title).font(.title3.bold())
                        if note.createdBy.kind == "agent" {
                            Label("Created by \(note.createdBy.name ?? "agent")", systemImage: "cpu")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        MarkdownBody(source: note.text)
                            .font(.footnote)
                    }
                    .padding()
                }
                .background(WorkTheme.canvas)
                .navigationTitle("Note")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button { editing = true } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .disabled(model.isShowingCachedData || model.isMutating)
                            Button(role: .destructive) { confirmingDelete = true } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            .disabled(model.isShowingCachedData || model.isMutating)
                        } label: {
                            Label("Note actions", systemImage: "ellipsis.circle")
                        }
                    }
                }
                .sheet(isPresented: $editing) {
                    EditNoteSheet(note: note).environmentObject(model)
                }
                .confirmationDialog("Delete this note?", isPresented: $confirmingDelete,
                                    titleVisibility: .visible) {
                    Button("Delete Note", role: .destructive) {
                        Task {
                            if await model.deleteNote(note) { dismiss() }
                        }
                    }
                } message: {
                    Text("This removes the note and its attachments. This cannot be undone.")
                }
            } else {
                ContentUnavailableView("Note unavailable", systemImage: "note.text",
                                       description: Text("It may have moved outside the current project scope."))
            }
        }
    }

    private var note: WorkNote? {
        model.snapshot?.notes.first { $0.id == noteID }
    }
}

private struct EditNoteSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let note: WorkNote
    @State private var title: String
    @State private var text: String

    init(note: WorkNote) {
        self.note = note
        _title = State(initialValue: note.title)
        _text = State(initialValue: note.text)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Note") {
                    TextField("Title", text: $title)
                    TextEditor(text: $text).frame(minHeight: 220)
                }
            }
            .navigationTitle("Edit Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.isMutating ? "Saving…" : "Save") {
                        Task {
                            if await model.updateNote(note,
                                                      title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                                      text: text) {
                                dismiss()
                            }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || model.isMutating
                              || (title == note.title && text == note.text))
                }
            }
        }
    }
}

struct NewNoteSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""
    @State private var images: [PendingImage] = []

    var body: some View {
        NavigationStack {
            Form {
                Section("Note") {
                    TextField("Title", text: $title)
                    TextEditor(text: $text).frame(minHeight: 180)
                }
                Section("Images") {
                    AttachmentTray(images: $images)
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
                                text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                                attachments: images
                            ) { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}
