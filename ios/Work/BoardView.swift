import SwiftUI

struct BoardView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedStatus: String?
    @State private var showingNewTask = false

    var body: some View {
        NavigationStack {
            List {
                // Every other tab carries this; the board is where a stale or
                // offline service is least obvious, since old tasks still render.
                Section { ConnectionBanner().listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)
                Section {
                    if filteredTasks.isEmpty {
                        ContentUnavailableView("No matching work", systemImage: "rectangle.stack.badge.minus",
                                               description: Text("Choose another status or create a task."))
                            .listRowBackground(Color.clear)
                    } else {
                        ForEach(filteredTasks) { task in
                            NavigationLink { TaskDetailView(taskID: task.id) } label: { TaskCard(task: task) }
                                .padding(.leading, isNested(task) ? 22 : 0)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    if let next = adjacentStatus(for: task, offset: 1) {
                                        Button { Task { await model.moveTask(task, to: next) } } label: {
                                            Label(WorkFormatting.title(for: next), systemImage: "arrow.right")
                                        }
                                        .tint(.blue)
                                    }
                                }
                                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                    if let previous = adjacentStatus(for: task, offset: -1) {
                                        Button { Task { await model.moveTask(task, to: previous) } } label: {
                                            Label(WorkFormatting.title(for: previous), systemImage: "arrow.left")
                                        }
                                        .tint(.orange)
                                    }
                                }
                        }
                    }
                    if !model.isShowingCachedData {
                        QuickAddRow(status: quickAddStatus)
                    }
                } header: {
                    // A "list" project asked for a plain list; drop the status board.
                    if !isPlainList {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                filterButton("All", status: nil, count: model.scopedTasks.count)
                                ForEach(statuses, id: \.self) { status in
                                    filterButton(WorkFormatting.title(for: status), status: status,
                                                 count: model.scopedTasks.filter { $0.status == status }.count)
                                }
                            }
                            .padding(.vertical, 6)
                        }
                        .textCase(nil)
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
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
        }
    }

    private var statuses: [String] { model.snapshot?.workspace.statuses ?? [] }

    private var isPlainList: Bool { model.selectedProject?.showsPlainList == true }

    /// A quick-add row files into the column being viewed, or backlog when the
    /// whole board is shown — matching the web, where each column has its own.
    private var quickAddStatus: String { isPlainList ? "backlog" : (selectedStatus ?? "backlog") }

    private var filteredTasks: [WorkTask] {
        let visible = model.scopedTasks
            .filter { isPlainList || selectedStatus == nil || $0.status == selectedStatus }
            .sorted { left, right in
                if left.isFinished != right.isFinished { return !left.isFinished }
                // Created order, so a list typed top to bottom reads back that
                // way and a new row lands beside the field that made it.
                return left.createdAt < right.createdAt
            }
        // Subtasks sit under their parent; one whose parent is filtered out
        // stays at top level rather than disappearing.
        let ids = Set(visible.map(\.id))
        var ordered: [WorkTask] = []
        for task in visible where task.parentId == nil || !ids.contains(task.parentId ?? "") {
            ordered.append(task)
            ordered.append(contentsOf: visible.filter { $0.parentId == task.id })
        }
        return ordered
    }

    /// True when this row should render indented under the row above it.
    private func isNested(_ task: WorkTask) -> Bool {
        guard let parentId = task.parentId else { return false }
        return filteredTasks.contains { $0.id == parentId }
    }

    private func adjacentStatus(for task: WorkTask, offset: Int) -> String? {
        guard !model.isShowingCachedData,
              let index = statuses.firstIndex(of: task.status),
              statuses.indices.contains(index + offset) else { return nil }
        return statuses[index + offset]
    }

    @ViewBuilder
    private func filterButton(_ label: String, status: String?, count: Int) -> some View {
        Button {
            withAnimation(.snappy) { selectedStatus = status }
        } label: {
            HStack(spacing: 5) {
                Text(label)
                Text(count.formatted()).foregroundStyle(status == selectedStatus ? .white.opacity(0.8) : .secondary)
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .foregroundStyle(status == selectedStatus ? .white : .primary)
            .background(status == selectedStatus ? Color.purple : Color.secondary.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
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
