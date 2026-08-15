import SwiftUI

/// The workbench Work list: tasks grouped by status in the web's order, each
/// group foldable, done folded by default, terminal statuses behind a toggle.
struct WorkListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var folded: Set<String> = ["done"]
    @State private var showTerminal = false
    @State private var showingNewTask = false
    @State private var selectedTask: TaskRef?

    var body: some View {
        NavigationStack {
            List {
                Section { ConnectionBanner().listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)

                if visibleTasks.isEmpty {
                    Section {
                        Text("No work items in this scope yet. Type one below or promote an Inbox thought.")
                            .font(.footnote)
                            .foregroundStyle(WorkTheme.muted)
                    }
                    .listRowBackground(WorkTheme.surface)
                }

                ForEach(groupOrder, id: \.self) { status in
                    let group = topLevel.filter { $0.status == status }
                    if !group.isEmpty {
                        statusSection(status, group: group)
                    }
                }

                Section {
                    if !model.isShowingCachedData {
                        QuickAddRow(status: "backlog")
                    }
                    Button(showTerminal ? "Hide cancelled & archived" : "Show cancelled & archived") {
                        withAnimation(.snappy) { showTerminal.toggle() }
                    }
                    .font(.caption)
                    .foregroundStyle(WorkTheme.muted)
                }
                .listRowBackground(WorkTheme.surface)
            }
            .listStyle(.insetGrouped)
            .environment(\.defaultMinListRowHeight, 34)
            .scrollContentBackground(.hidden)
            .background(WorkTheme.canvas)
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .workCapture()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingNewTask = true } label: { Image(systemName: "plus") }
                        .disabled(model.isShowingCachedData)
                        .accessibilityLabel("New task")
                }
            }
            .refreshable { await model.refresh() }
            .sheet(isPresented: $showingNewTask) {
                NewTaskSheet().environmentObject(model)
            }
            .sheet(item: $selectedTask) { ref in
                TaskPanelSheet(taskID: ref.id).environmentObject(model)
            }
        }
    }

    private func statusSection(_ status: String, group: [WorkTask]) -> some View {
        Section {
            if !folded.contains(status) {
                ForEach(group) { task in
                    taskRow(task, nested: false)
                    ForEach(children(of: task.id)) { child in
                        taskRow(child, nested: true)
                    }
                }
            }
        } header: {
            Button {
                withAnimation(.snappy) {
                    if folded.contains(status) { folded.remove(status) } else { folded.insert(status) }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .rotationEffect(.degrees(folded.contains(status) ? 0 : 90))
                    Circle()
                        .fill(Color.workStatus(status))
                        .frame(width: 7, height: 7)
                    Text(WorkFormatting.title(for: status))
                    Text(folded.contains(status) ? "\(group.count) — show" : "\(group.count)")
                        .foregroundStyle(WorkTheme.muted)
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(WorkTheme.ink)
            }
            .textCase(nil)
            .accessibilityLabel("\(WorkFormatting.title(for: status)), \(group.count) tasks, \(folded.contains(status) ? "folded" : "expanded")")
        }
        .listRowBackground(WorkTheme.surface)
    }

    private func taskRow(_ task: WorkTask, nested: Bool) -> some View {
        Button { selectedTask = TaskRef(id: task.id) } label: {
            TaskRowView(task: task, showsProject: model.selectedProjectPath == nil) { id in
                selectedTask = TaskRef(id: id)
            }
        }
        .buttonStyle(.plain)
        .padding(.leading, nested ? 22 : 0)
    }

    // MARK: Grouping, matching the web list view.

    private var groupOrder: [String] {
        WorkFormatting.statusGroups(for: model.snapshot?.workspace.statuses ?? [],
                                    showTerminal: showTerminal)
    }

    private var visibleTasks: [WorkTask] {
        model.scopedTasks.filter { showTerminal || !["cancelled", "archived"].contains($0.status) }
    }

    private var topLevel: [WorkTask] {
        let ids = Set(visibleTasks.map(\.id))
        return visibleTasks
            .filter { $0.parentId == nil || !ids.contains($0.parentId ?? "") }
            .sorted { left, right in
                let leftDue = left.dueAt ?? "9999"
                let rightDue = right.dueAt ?? "9999"
                if leftDue != rightDue { return leftDue < rightDue }
                return left.createdAt < right.createdAt
            }
    }

    private func children(of id: String) -> [WorkTask] {
        visibleTasks.filter { $0.parentId == id }.sorted { $0.createdAt < $1.createdAt }
    }
}

struct NewTaskSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var delegated = false
    @State private var hasDueDate = false
    @State private var dueAt = Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("What needs to get done?", text: $title, axis: .vertical)
                }

                Section("Description") {
                    TextField("Background and context — what is this, and what is the situation?",
                              text: $description, axis: .vertical)
                        .lineLimit(3...)
                }

                Section {
                    Toggle("Hand to an agent", isOn: $delegated)
                } footer: {
                    Text("An agent runner picks up delegated items on its next pass.")
                }

                Section("Schedule") {
                    Toggle("Due date", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Due", selection: $dueAt, displayedComponents: [.date, .hourAndMinute])
                    }
                }

                if let project = model.selectedProject {
                    Section("Project") { Label(project.name, systemImage: "folder") }
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.isMutating ? "Creating…" : "Create") {
                        Task {
                            let succeeded = await model.createTask(
                                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                description: description.trimmingCharacters(in: .whitespacesAndNewlines),
                                delegated: delegated,
                                dueAt: hasDueDate ? dueAt : nil
                            )
                            if succeeded { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}

/// Rapid entry, matching the web's quick-add: submit creates and keeps focus so
/// the next line can be typed straight away, a pasted list becomes one task per
/// line, and indent files the next task under the one just made.
struct QuickAddRow: View {
    @EnvironmentObject private var model: AppModel
    let status: String

    @State private var value = ""
    @State private var indent = false
    @State private var anchor: WorkTask?
    @State private var message: String?
    @FocusState private var focused: Bool

    private var parentId: String? {
        // One level only: indenting under a subtask makes a sibling, never a
        // grandchild, because parentId is a single link.
        guard indent, let anchor else { return nil }
        return anchor.parentId ?? anchor.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if indent {
                    Image(systemName: "arrow.turn.down.right")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                TextField("Add a task", text: $value, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .submitLabel(.next)
                    .onSubmit { submit() }
                    .disabled(model.isShowingCachedData)
            }
            .padding(.leading, indent ? 20 : 0)

            if let parentId, indent {
                Text("Subtask of \(parentId)")
                    .font(.caption2).foregroundStyle(.secondary)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(.orange)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                if focused {
                    Button { indent = false } label: { Image(systemName: "arrow.left.to.line") }
                        .accessibilityLabel("Outdent: file the next task on its own")
                        .disabled(!indent)
                    Button { indent = true } label: { Image(systemName: "arrow.right.to.line") }
                        .accessibilityLabel("Indent: file the next task under the one above")
                        .disabled(anchor == nil)
                    Spacer()
                    // Without this the field is a trap: the only way out was to
                    // create a task, or to tap another row and get navigated
                    // into it. Dismissing keeps whatever was typed.
                    Button { focused = false } label: { Image(systemName: "keyboard.chevron.compact.down") }
                        .accessibilityLabel("Dismiss the keyboard")
                    Button("Add") { submit() }.disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func submit() {
        let text = value
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        value = ""
        message = nil
        Task {
            let result = await model.quickAddTasks(text, status: status, parentId: parentId)
            if let last = result.created.last { anchor = last }
            if let error = result.error {
                message = "Added \(result.created.count) of \(result.created.count + result.remaining.count). Not saved — \(error)"
                // Give back only what never landed, and never clobber new typing.
                if value.isEmpty { value = result.remaining.joined(separator: "\n") }
            } else if result.created.count > 1 {
                message = "Added \(result.created.count) tasks."
            }
            focused = true
        }
    }
}
