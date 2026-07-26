import SwiftUI

struct TaskDetailView: View {
    @EnvironmentObject private var model: AppModel
    let taskID: String
    @State private var showingLog = false

    var body: some View {
        Group {
            if let task {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(task.id).font(.caption.monospaced().weight(.semibold)).foregroundStyle(.secondary)
                                Spacer()
                                StatusPill(value: task.status)
                            }
                            Text(task.title).font(.title2.bold())
                            HStack(spacing: 14) {
                                if task.priority != "none" {
                                    Label(WorkFormatting.title(for: task.priority), systemImage: "flag.fill")
                                        .foregroundStyle(Color.workPriority(task.priority))
                                }
                                if let due = WorkFormatting.shortDate(task.dueAt) {
                                    Label(due, systemImage: "calendar")
                                }
                                Label(WorkFormatting.title(for: task.type), systemImage: "shippingbox")
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 6)
                    }

                    Section("Move") {
                        Menu {
                            ForEach(model.snapshot?.workspace.statuses ?? [], id: \.self) { status in
                                Button {
                                    Task { await model.moveTask(task, to: status) }
                                } label: {
                                    Label(WorkFormatting.title(for: status),
                                          systemImage: status == task.status ? "checkmark" : "arrow.right")
                                }
                                .disabled(status == task.status)
                            }
                        } label: {
                            Label("Change status", systemImage: "arrow.left.arrow.right")
                        }
                        .disabled(model.isMutating || model.isShowingCachedData)
                    }

                    detailSection("Goal", text: task.sections.goal)
                    checklistSection("Requirements", items: task.requirements, section: "requirements", task: task)
                    checklistSection("Acceptance Criteria", items: task.acceptanceCriteria, section: "acceptance", task: task)
                    detailSection("Plan", text: task.sections.plan)
                    detailSection("Notes", text: task.sections.notes)

                    if let blockedReason = task.blockedReason, !blockedReason.isEmpty {
                        Section("Blocked") {
                            Label(blockedReason, systemImage: "exclamationmark.octagon.fill")
                                .foregroundStyle(.red)
                        }
                    }

                    if !task.dependsOn.isEmpty || !task.blockedBy.isEmpty {
                        Section("Relationships") {
                            if !task.dependsOn.isEmpty {
                                LabeledContent("Depends on", value: task.dependsOn.joined(separator: ", "))
                            }
                            if !task.blockedBy.isEmpty {
                                LabeledContent("Blocked by", value: task.blockedBy.joined(separator: ", "))
                            }
                        }
                    }

                    if !task.log.isEmpty {
                        Section("Progress") {
                            ForEach(Array(task.log.enumerated()), id: \.offset) { _, entry in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.message)
                                    if let date = WorkFormatting.date(from: entry.at) {
                                        Text(date.formatted(.relative(presentation: .named)))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }

                    detailSection("Completion Summary", text: task.sections.completionSummary)
                }
                .navigationTitle("Task")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingLog = true } label: { Image(systemName: "text.badge.plus") }
                            .disabled(model.isShowingCachedData)
                            .accessibilityLabel("Add progress update")
                    }
                }
                .sheet(isPresented: $showingLog) {
                    AddProgressSheet(task: task).environmentObject(model)
                }
            } else {
                ContentUnavailableView("Task unavailable", systemImage: "questionmark.folder",
                                       description: Text("It may have moved or been removed."))
            }
        }
    }

    private var task: WorkTask? { model.snapshot?.tasks.first { $0.id == taskID } }

    @ViewBuilder
    private func detailSection(_ title: String, text: String) -> some View {
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Section(title) { Text(text).textSelection(.enabled) }
        }
    }

    @ViewBuilder
    private func checklistSection(_ title: String, items: [ChecklistItem], section: String,
                                  task: WorkTask) -> some View {
        if !items.isEmpty {
            Section(title) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    Button {
                        Task { await model.toggleChecklist(task, section: section, index: index, checked: !item.checked) }
                    } label: {
                        HStack(alignment: .top) {
                            Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(item.checked ? .green : .secondary)
                            Text(item.text)
                                .foregroundStyle(item.checked ? .secondary : .primary)
                                .strikethrough(item.checked)
                        }
                    }
                    .disabled(model.isMutating || model.isShowingCachedData)
                }
            }
        }
    }
}

private struct AddProgressSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let task: WorkTask
    @State private var message = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Update") { TextEditor(text: $message).frame(minHeight: 140) }
            }
            .navigationTitle("Progress")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        Task {
                            if await model.appendLog(task, message: message.trimmingCharacters(in: .whitespacesAndNewlines)) {
                                dismiss()
                            }
                        }
                    }
                    .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}
