import SwiftUI

struct BoardView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedStatus: String?
    @State private var showingNewTask = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if filteredTasks.isEmpty {
                        ContentUnavailableView("No matching work", systemImage: "rectangle.stack.badge.minus",
                                               description: Text("Choose another status or create a task."))
                            .listRowBackground(Color.clear)
                    } else {
                        ForEach(filteredTasks) { task in
                            NavigationLink { TaskDetailView(taskID: task.id) } label: { TaskCard(task: task) }
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
                } header: {
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
            .listStyle(.plain)
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

    private var filteredTasks: [WorkTask] {
        model.scopedTasks.filter { selectedStatus == nil || $0.status == selectedStatus }
            .sorted { left, right in
                if left.isFinished != right.isFinished { return !left.isFinished }
                if priorityRank(left.priority) != priorityRank(right.priority) {
                    return priorityRank(left.priority) < priorityRank(right.priority)
                }
                return left.updatedAt > right.updatedAt
            }
    }

    private func priorityRank(_ priority: String) -> Int {
        ["critical", "high", "medium", "low", "none"].firstIndex(of: priority) ?? 5
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
    @State private var type = "task"
    @State private var priority = "none"
    @State private var hasDueDate = false
    @State private var dueAt = Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("What needs to get done?", text: $title, axis: .vertical)
                    Picker("Type", selection: $type) {
                        ForEach(["task", "bug", "feature", "research", "admin", "epic", "idea"], id: \.self) {
                            Text(WorkFormatting.title(for: $0)).tag($0)
                        }
                    }
                    Picker("Priority", selection: $priority) {
                        ForEach(["none", "low", "medium", "high", "critical"], id: \.self) {
                            Text(WorkFormatting.title(for: $0)).tag($0)
                        }
                    }
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
                                type: type,
                                priority: priority,
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
