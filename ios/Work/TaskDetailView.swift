import SwiftUI

/// The web's right-hand task panel as a large sheet over the list.
struct TaskPanelSheet: View {
    let taskID: String

    var body: some View {
        NavigationStack {
            TaskDetailView(taskID: taskID)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

/// Read-first task detail: prose renders as prose until tapped, every section
/// the web edits is editable here, checklists gain rows inline.
struct TaskDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let taskID: String

    @State private var editingTitle = false
    @State private var titleDraft = ""
    @State private var tagDraft = ""
    @State private var newRequirement = ""
    @State private var newAcceptance = ""
    @State private var logDraft = ""
    @State private var addedSections: Set<String> = []
    @State private var selectedQuestion: WorkDecision?
    @FocusState private var titleFocused: Bool

    var body: some View {
        Group {
            if let task {
                List {
                    headerSection(task)
                    delegationSection(task)
                    openQuestions(for: task)
                    proseSections(task)
                    checklistSection("Requirements", items: task.requirements,
                                     section: "requirements", draft: $newRequirement, task: task)
                    checklistSection("Acceptance Criteria", items: task.acceptanceCriteria,
                                     section: "acceptance", draft: $newAcceptance, task: task)
                    blockedSection(task)
                    relationshipsSection(task)
                    logSection(task)
                }
                .listStyle(.insetGrouped)
                .environment(\.defaultMinListRowHeight, 34)
                .scrollContentBackground(.hidden)
                .background(WorkTheme.canvas)
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle(task.id)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
                .sheet(item: $selectedQuestion) { question in
                    DecisionSheet(decision: question).environmentObject(model)
                }
            } else {
                ContentUnavailableView("Task unavailable", systemImage: "questionmark.folder",
                                       description: Text("It may have moved or been removed."))
            }
        }
    }

    private var task: WorkTask? { model.snapshot?.tasks.first { $0.id == taskID } }
    private var locked: Bool { model.isMutating || model.isShowingCachedData }

    // MARK: Header — title tap-to-edit, status, chips, tags.

    private func headerSection(_ task: WorkTask) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(task.id + (task.delegated ? " · handed to an agent" : ""))
                        .font(.caption.monospaced())
                        .foregroundStyle(WorkTheme.muted)
                    Spacer()
                    statusMenu(task)
                }

                if editingTitle {
                    TextField("Title", text: $titleDraft, axis: .vertical)
                        .font(.headline)
                        .focused($titleFocused)
                        .onSubmit { saveTitle(task) }
                        .submitLabel(.done)
                    HStack {
                        Button("Cancel") { editingTitle = false }
                            .font(.caption)
                        Spacer()
                        Button("Save") { saveTitle(task) }
                            .font(.caption.weight(.semibold))
                            .disabled(titleDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || locked)
                    }
                } else {
                    Text(task.title)
                        .font(.headline)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            guard !model.isShowingCachedData else { return }
                            titleDraft = task.title
                            editingTitle = true
                            titleFocused = true
                        }
                        .accessibilityHint("Tap to edit the title")
                }

                // Meta chips: project, due, checklist progress, tags.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        if let path = task.projectPath {
                            Text(path.split(separator: "/").last.map(String.init) ?? path)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(WorkTheme.muted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(WorkTheme.surfaceMuted, in: Capsule())
                        }
                        DueChip(dueAt: task.dueAt)
                        if task.checklistTotal > 0 {
                            Text("\(task.checklistCompleted)/\(task.checklistTotal) checks")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(WorkTheme.muted)
                        }
                        ForEach(task.tags, id: \.self) { tag in
                            TagChip(tag: tag)
                                .contextMenu {
                                    Button("Remove tag", role: .destructive) {
                                        Task { _ = await model.setTaskTags(task, task.tags.filter { $0 != tag }) }
                                    }
                                }
                        }
                        TextField("+ tag", text: $tagDraft)
                            .font(.caption2)
                            .frame(width: 64)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit {
                                let value = tagDraft.trimmingCharacters(in: .whitespaces).lowercased()
                                tagDraft = ""
                                guard !value.isEmpty else { return }
                                Task { _ = await model.setTaskTags(task, task.tags + [value]) }
                            }
                            .disabled(locked)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(WorkTheme.surface)
    }

    private func statusMenu(_ task: WorkTask) -> some View {
        Menu {
            ForEach(statusChoices, id: \.self) { status in
                Button {
                    Task { await model.moveTask(task, to: status) }
                } label: {
                    Label(WorkFormatting.title(for: status),
                          systemImage: status == task.status ? "checkmark" : "circle")
                }
                // Review unlocks when the checklist is complete, like the web.
                .disabled(status == task.status
                          || (status == "review" && task.checklistCompleted < task.checklistTotal))
            }
        } label: {
            StatusPill(value: task.status)
        }
        .disabled(locked)
        .accessibilityLabel("Status: \(WorkFormatting.title(for: task.status)). Opens the status picker.")
    }

    private var statusChoices: [String] {
        var statuses = model.snapshot?.workspace.statuses ?? []
        for terminal in ["cancelled", "archived"] where !statuses.contains(terminal) {
            statuses.append(terminal)
        }
        return statuses
    }

    private func saveTitle(_ task: WorkTask) {
        let value = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != task.title else {
            editingTitle = false
            return
        }
        Task {
            if await model.editTask(task, title: value) { editingTitle = false }
        }
    }

    private func delegationSection(_ task: WorkTask) -> some View {
        Section {
            Toggle("Hand to an agent", isOn: Binding(
                get: { task.delegated },
                set: { on in Task { await model.setDelegated(task, on) } }
            ))
            .disabled(locked)
        } footer: {
            Text("An agent runner picks up delegated items on its next pass.")
        }
        .listRowBackground(WorkTheme.surface)
    }

    // MARK: Prose sections — text is text until tapped.

    private static let sectionOrder: [(key: String, title: String, placeholder: String)] = [
        ("description", "Description", "Background and context — what is this, and what is the situation?"),
        ("goal", "Goal", "The discrete outcome — what does done accomplish?"),
        ("plan", "Plan", "How to get there — known steps or research shape"),
        ("notes", "Notes", "Working notes that belong on the card"),
        ("outcome", "Outcome", "What shipped, changed, or was learned?"),
    ]

    private func sectionText(_ task: WorkTask, _ key: String) -> String {
        switch key {
        case "description": task.sections.description
        case "goal": task.sections.goal
        case "plan": task.sections.plan
        case "notes": task.sections.notes
        default: task.sections.completionSummary
        }
    }

    @ViewBuilder
    private func proseSections(_ task: WorkTask) -> some View {
        ForEach(Self.sectionOrder, id: \.key) { entry in
            let text = sectionText(task, entry.key)
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || addedSections.contains(entry.key) {
                EditableSection(
                    title: entry.title,
                    text: text,
                    placeholder: entry.placeholder,
                    autoEdit: addedSections.contains(entry.key),
                    onAbandon: { addedSections.remove(entry.key) },
                    save: { value in await saveSection(task, key: entry.key, value: value) }
                )
            }
        }

        let missing = Self.sectionOrder.filter { entry in
            sectionText(task, entry.key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !addedSections.contains(entry.key)
        }
        if !missing.isEmpty, !model.isShowingCachedData {
            Section("Add section") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(missing, id: \.key) { entry in
                            Button("+ \(entry.title.lowercased())") {
                                addedSections.insert(entry.key)
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            .listRowBackground(WorkTheme.surface)
        }
    }

    private func saveSection(_ task: WorkTask, key: String, value: String) async -> Bool {
        let saved: Bool
        switch key {
        case "description": saved = await model.editTask(task, description: value)
        case "goal": saved = await model.editTask(task, goal: value)
        case "plan": saved = await model.editTask(task, plan: value)
        case "notes": saved = await model.editTask(task, notes: value)
        default: saved = await model.editTask(task, completionSummary: value)
        }
        if saved { addedSections.remove(key) }
        return saved
    }

    // MARK: Checklists — toggle, add, remove; declined rows are read-only.

    @ViewBuilder
    private func checklistSection(_ title: String, items: [ChecklistItem], section: String,
                                  draft: Binding<String>, task: WorkTask) -> some View {
        if !items.isEmpty || !model.isShowingCachedData {
            Section(title) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    checklistRow(item, index: index, section: section, items: items, task: task)
                }
                TextField(section == "requirements" ? "Add requirement" : "Add criterion",
                          text: draft)
                    .font(.footnote)
                    .onSubmit {
                        let value = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
                        draft.wrappedValue = ""
                        guard !value.isEmpty else { return }
                        Task {
                            _ = await model.setChecklist(task, section: section,
                                                         items: items + [ChecklistItem(checked: false, text: value)])
                        }
                    }
                    .disabled(locked)
            }
            .listRowBackground(WorkTheme.surface)
        }
    }

    @ViewBuilder
    private func checklistRow(_ item: ChecklistItem, index: Int, section: String,
                              items: [ChecklistItem], task: WorkTask) -> some View {
        Group {
            if item.declined {
                // An agent verified this as not-done; the row states why and
                // stays read-only.
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .top) {
                        Image(systemName: "slash.circle")
                            .foregroundStyle(WorkTheme.warning)
                        Text(item.text)
                            .font(.footnote)
                            .foregroundStyle(WorkTheme.muted)
                    }
                    Text("Declined by an agent: \(item.reason.isEmpty ? "no reason recorded" : item.reason)")
                        .font(.caption2)
                        .foregroundStyle(WorkTheme.warning)
                        .padding(.leading, 26)
                }
            } else {
                Button {
                    Task {
                        await model.toggleChecklist(task, section: section, index: index,
                                                    checked: !item.checked)
                    }
                } label: {
                    HStack(alignment: .top) {
                        Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.checked ? WorkTheme.success : WorkTheme.muted)
                        Text(item.text)
                            .font(.footnote)
                            .foregroundStyle(item.checked ? WorkTheme.muted : WorkTheme.ink)
                            .strikethrough(item.checked)
                    }
                }
                .disabled(locked)
            }
        }
        .swipeActions {
            Button(role: .destructive) {
                var next = items
                next.remove(at: index)
                Task { _ = await model.setChecklist(task, section: section, items: next) }
            } label: {
                Label("Remove", systemImage: "trash")
            }
            .disabled(locked)
        }
    }

    // MARK: The rest — blocked, relationships, log.

    @ViewBuilder
    private func blockedSection(_ task: WorkTask) -> some View {
        if let blockedReason = task.blockedReason, !blockedReason.isEmpty {
            Section("Blocked") {
                Label(blockedReason, systemImage: "exclamationmark.octagon.fill")
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.danger)
            }
            .listRowBackground(WorkTheme.surface)
        }
    }

    @ViewBuilder
    private func relationshipsSection(_ task: WorkTask) -> some View {
        if !task.dependsOn.isEmpty || !task.blockedBy.isEmpty {
            Section("Relationships") {
                if !task.dependsOn.isEmpty {
                    LabeledContent("Depends on", value: task.dependsOn.joined(separator: ", "))
                        .font(.footnote)
                }
                if !task.blockedBy.isEmpty {
                    LabeledContent("Blocked by", value: task.blockedBy.joined(separator: ", "))
                        .font(.footnote)
                }
            }
            .listRowBackground(WorkTheme.surface)
        }
    }

    private func logSection(_ task: WorkTask) -> some View {
        Section("Log") {
            if !model.isShowingCachedData {
                TextField("Add progress", text: $logDraft, axis: .vertical)
                    .font(.footnote)
                    .onSubmit {
                        let value = logDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                        logDraft = ""
                        guard !value.isEmpty else { return }
                        Task { _ = await model.appendLog(task, message: value) }
                    }
                    .disabled(locked)
            }
            if task.log.isEmpty {
                Text("No entries yet.")
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.muted)
            }
            // Newest first: the last thing that happened is what you came to
            // read. The record itself stays append-only and chronological.
            ForEach(Array(task.log.enumerated()).reversed(), id: \.offset) { _, entry in
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.message)
                        .font(.footnote)
                    if let date = WorkFormatting.date(from: entry.at) {
                        Text(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
                            .font(.caption2)
                            .foregroundStyle(WorkTheme.muted)
                    }
                }
            }
        }
        .listRowBackground(WorkTheme.surface)
    }

    /// Unresolved decisions that point at this task. Answering one records the
    /// choice on the task's log; the status stays the person's to change.
    @ViewBuilder
    private func openQuestions(for task: WorkTask) -> some View {
        let questions = model.openQuestions(for: task.id)
        if !questions.isEmpty {
            Section {
                ForEach(questions) { question in
                    Button { selectedQuestion = question } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "hand.raised.fill").foregroundStyle(WorkTheme.accent)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(question.title)
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                                if let recommended = question.recommendedOption {
                                    Text("Recommended: \(recommended)")
                                        .font(.caption2).foregroundStyle(WorkTheme.accent)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                    }
                    .disabled(model.isShowingCachedData)
                }
            } header: {
                Text("Open questions")
            } footer: {
                Text("Answering records the choice on this task's log. The status stays yours to change.")
            }
            .listRowBackground(WorkTheme.surface)
        }
    }
}

/// Read-first section editing: prose renders as prose; tapping it (or the
/// pencil) swaps in an editor with an explicit Save. Editing is off while an
/// offline snapshot is on screen, because that snapshot is read-only.
private struct EditableSection: View {
    @EnvironmentObject private var model: AppModel
    let title: String
    let text: String
    let placeholder: String
    var autoEdit = false
    var onAbandon: () -> Void = {}
    let save: (String) async -> Bool

    @State private var isEditing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        Section {
            if isEditing {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .font(.footnote)
                    .lineLimit(3...12)
                    .focused($focused)
                    .accessibilityHint("Markdown and multiple lines are supported")
                HStack {
                    Button("Cancel") { cancel() }
                        .font(.caption)
                        .buttonStyle(.bordered)
                    Spacer()
                    Button(model.isMutating ? "Saving…" : "Save") {
                        focused = false
                        let pending = draft
                        Task {
                            if await save(pending) {
                                isEditing = false
                                draft = ""
                            }
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isMutating || draft == text)
                }
            } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(placeholder) { begin() }
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.muted)
            } else {
                MarkdownText(source: text)
                    .font(.footnote)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        guard !model.isShowingCachedData else { return }
                        begin()
                    }
                    .accessibilityHint("Tap to edit")
            }
        } header: {
            HStack {
                Text(title)
                Spacer()
                if !isEditing, !model.isShowingCachedData {
                    Button {
                        begin()
                    } label: {
                        Image(systemName: "pencil")
                            .font(.caption)
                    }
                    .disabled(model.isMutating)
                    .accessibilityLabel("Edit \(title)")
                }
            }
        }
        .listRowBackground(WorkTheme.surface)
        .onAppear {
            if autoEdit, !isEditing { begin() }
        }
    }

    private func begin() {
        draft = text
        isEditing = true
        focused = true
    }

    private func cancel() {
        focused = false
        isEditing = false
        draft = ""
        // A freshly added section with nothing typed was never real.
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { onAbandon() }
    }
}
