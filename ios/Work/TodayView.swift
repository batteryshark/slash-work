import SwiftUI

/// One value the sheet presenter can hang on to; String alone is not Identifiable.
struct TaskRef: Identifiable, Hashable {
    let id: String
}

/// The workbench Today tab: Needs you, Decided, On deck, Inbox — in that
/// order, with the same composition rules as the web.
struct TodayView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedDecision: WorkDecision?
    @State private var selectedTask: TaskRef?
    @State private var decidedOpen = false

    var body: some View {
        NavigationStack {
            List {
                Section { ConnectionBanner().listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)

                needsYouSection
                decidedSection
                onDeckSection
                inboxSection
            }
            .listStyle(.insetGrouped)
            .environment(\.defaultMinListRowHeight, 34)
            .scrollContentBackground(.hidden)
            .background(WorkTheme.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .workCapture()
            .refreshable { await model.refresh() }
            .sheet(item: $selectedDecision) { decision in
                DecisionSheet(decision: decision).environmentObject(model)
            }
            .sheet(item: $selectedTask) { ref in
                TaskPanelSheet(taskID: ref.id).environmentObject(model)
            }
        }
    }

    // MARK: Needs you — open decisions, issues waiting on a human, blocked work.

    private var needsYouSection: some View {
        Section {
            if needsCount == 0 {
                Text("Nothing needs you.")
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.muted)
            }
            ForEach(activeDecisions) { decision in
                Button { selectedDecision = decision } label: {
                    needsRow(kind: "decision", title: decision.title,
                             detail: projectName(decision.projectPath))
                }
            }
            ForEach(humanIssues) { issue in
                NavigationLink {
                    IssueDetailView(issueID: issue.id)
                } label: {
                    needsRow(kind: "issue", title: issue.title,
                             detail: projectName(issue.projectPath))
                }
            }
            ForEach(model.blockedTasks) { task in
                Button { selectedTask = TaskRef(id: task.id) } label: {
                    needsRow(kind: "blocked", title: task.title,
                             detail: projectName(task.projectPath))
                }
            }
        } header: {
            sectionHeader("Needs you", count: needsCount)
        }
        .listRowBackground(WorkTheme.surface)
    }

    private func needsRow(kind: String, title: String, detail: String) -> some View {
        HStack(spacing: 8) {
            Text(kind)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(kind == "blocked" ? WorkTheme.danger : WorkTheme.accent)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background((kind == "blocked" ? WorkTheme.danger : WorkTheme.accent).opacity(0.12),
                            in: Capsule())
            Text(title)
                .font(.footnote)
                .foregroundStyle(WorkTheme.ink)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(WorkTheme.muted)
                .lineLimit(1)
        }
    }

    // MARK: Decided — the archive, collapsed, each row reopenable.

    @ViewBuilder
    private var decidedSection: some View {
        if !decidedDecisions.isEmpty {
            Section {
                if decidedOpen {
                    ForEach(decidedDecisions.prefix(12)) { decision in
                        HStack(spacing: 8) {
                            Text(decision.status)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.workStatus(decision.status))
                            Text(decision.title)
                                .font(.footnote)
                                .foregroundStyle(WorkTheme.ink)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            if let option = decision.resolution?.choice?.option {
                                Text(option)
                                    .font(.caption2)
                                    .foregroundStyle(WorkTheme.muted)
                                    .lineLimit(1)
                            }
                            Button("Reopen") {
                                Task { _ = await model.reopenDecision(decision) }
                            }
                            .font(.caption2.weight(.semibold))
                            .buttonStyle(.borderless)
                            .disabled(model.isMutating || model.isShowingCachedData)
                        }
                    }
                }
            } header: {
                Button {
                    withAnimation(.snappy) { decidedOpen.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(decidedOpen ? 90 : 0))
                        Text("Decided")
                        Text("\(decidedDecisions.count)")
                            .foregroundStyle(WorkTheme.muted)
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(WorkTheme.ink)
                }
                .textCase(nil)
            }
            .listRowBackground(WorkTheme.surface)
        }
    }

    // MARK: On deck — due or overdue first, then work in flight.

    private var onDeckSection: some View {
        Section {
            if dueTasks.isEmpty, activeTasks.isEmpty {
                Text("Nothing due, nothing in flight.")
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.muted)
            }
            ForEach(dueTasks + activeTasks) { task in
                Button { selectedTask = TaskRef(id: task.id) } label: {
                    TaskRowView(task: task, showsProject: model.selectedProjectPath == nil) { id in
                        selectedTask = TaskRef(id: id)
                    }
                }
                .buttonStyle(.plain)
            }
        } header: {
            sectionHeader("On deck", count: dueTasks.count + activeTasks.count)
        }
        .listRowBackground(WorkTheme.surface)
    }

    // MARK: Inbox — captures with triage on each row.

    private var inboxSection: some View {
        Section {
            if captures.isEmpty {
                Text("Nothing in the inbox.")
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.muted)
            }
            ForEach(captures.prefix(10)) { capture in
                VStack(alignment: .leading, spacing: 3) {
                    Text(capture.text)
                        .font(.footnote)
                        .foregroundStyle(WorkTheme.ink)
                        .lineLimit(2)
                    HStack(spacing: 8) {
                        if let path = capture.projectPath {
                            Text(projectName(path))
                                .font(.caption2)
                                .foregroundStyle(WorkTheme.muted)
                        }
                        if let date = WorkFormatting.relative(capture.createdAt) {
                            Text(date)
                                .font(.caption2)
                                .foregroundStyle(WorkTheme.muted)
                        }
                    }
                }
                .swipeActions(edge: .leading, allowsFullSwipe: false) {
                    Button {
                        Task { _ = await model.promoteCaptureToTask(capture) }
                    } label: { Label("Task", systemImage: "checklist") }
                    .tint(WorkTheme.accent)
                    .disabled(triageLocked)
                    Button {
                        Task { _ = await model.promoteCaptureToNote(capture) }
                    } label: { Label("Note", systemImage: "note.text") }
                    .tint(.indigo)
                    .disabled(triageLocked)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { _ = await model.deleteCapture(capture) }
                    } label: { Label("Drop", systemImage: "trash") }
                    .disabled(triageLocked)
                }
                .contextMenu {
                    Button("File as a task") { Task { _ = await model.promoteCaptureToTask(capture) } }
                    Button("Keep as a note") { Task { _ = await model.promoteCaptureToNote(capture) } }
                    Button("Drop it", role: .destructive) { Task { _ = await model.deleteCapture(capture) } }
                }
            }
            if captures.count > 10 {
                Text("\(captures.count - 10) more in this inbox.")
                    .font(.caption2)
                    .foregroundStyle(WorkTheme.muted)
            }
        } header: {
            sectionHeader("Inbox", count: captures.count)
        }
        .listRowBackground(WorkTheme.surface)
    }

    private var triageLocked: Bool { model.isMutating || model.isShowingCachedData }

    // MARK: Composition, matching the web.

    private var activeDecisions: [WorkDecision] {
        model.openDecisions.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var decidedDecisions: [WorkDecision] {
        model.scopedDecisions.filter { !$0.isOpen }.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var humanIssues: [WorkIssue] { model.needsHumanIssues }

    private var needsCount: Int {
        activeDecisions.count + humanIssues.count + model.blockedTasks.count
    }

    private var dueTasks: [WorkTask] {
        model.scopedTasks.filter { task in
            guard !task.isFinished, task.status != "archived" else { return false }
            let tone = WorkFormatting.dueTone(task.dueAt)
            return tone == .overdue || tone == .today
        }
    }

    private var activeTasks: [WorkTask] {
        let due = Set(dueTasks.map(\.id))
        return model.scopedTasks.filter {
            ["in_progress", "review"].contains($0.status) && !due.contains($0.id)
        }
    }

    private var captures: [WorkCapture] {
        model.scopedCaptures.sorted { $0.createdAt > $1.createdAt }
    }

    private func projectName(_ path: String?) -> String {
        guard let path else { return "root" }
        return model.snapshot?.projects.first { $0.path == path }?.name
            ?? (path.split(separator: "/").last.map(String.init) ?? path)
    }

    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 5) {
            Text(title)
            Text("\(count)").foregroundStyle(WorkTheme.muted)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(WorkTheme.ink)
        .textCase(nil)
    }
}

struct DecisionSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let decision: WorkDecision
    @State private var selectedOption: String
    @State private var response = ""
    @State private var deferUntil = Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now

    init(decision: WorkDecision) {
        self.decision = decision
        _selectedOption = State(initialValue: decision.recommendedOption ?? decision.options.first ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(decision.title).font(.title3.bold())
                    if !decision.detail.isEmpty { Text(decision.detail).foregroundStyle(.secondary) }
                }

                if !decision.options.isEmpty {
                    Section("Choose one") {
                        ForEach(choices, id: \.self) { option in
                            Button { selectedOption = option } label: {
                                HStack {
                                    Image(systemName: selectedOption == option ? "checkmark.circle.fill" : "circle")
                                    Text(option).foregroundStyle(.primary)
                                    Spacer()
                                    if option == decision.recommendedOption {
                                        Label("Recommended", systemImage: "sparkles")
                                            .font(.caption).foregroundStyle(WorkTheme.accent)
                                    }
                                }
                            }
                        }
                    }
                }

                Section(decision.options.isEmpty ? "Your response" : "Reason or context") {
                    TextEditor(text: $response).frame(minHeight: 100)
                    if selectedOption == "Other" {
                        Text("A written response is required when choosing Other.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }

                Section("Not now") {
                    DatePicker("Revisit", selection: $deferUntil, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    Button("Defer until this date") { resolve(action: "defer", until: deferUntil) }
                        .disabled(model.isMutating || model.isShowingCachedData)
                }

                Section {
                    Button("Reject", role: .destructive) { resolve(action: "reject") }
                }
            }
            .navigationTitle("Decision")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.isMutating ? "Saving…" : "Approve") { resolve(action: "approve") }
                        .disabled(!canApprove || model.isMutating || model.isShowingCachedData)
                }
            }
        }
    }

    private var choices: [String] {
        decision.options.contains("Other") ? decision.options : decision.options + ["Other"]
    }

    private var canApprove: Bool {
        let note = response.trimmingCharacters(in: .whitespacesAndNewlines)
        if decision.options.isEmpty { return !note.isEmpty }
        if selectedOption == "Other" { return !note.isEmpty }
        return !selectedOption.isEmpty
    }

    private func resolve(action: String, until: Date? = nil) {
        let note = response.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let succeeded = await model.resolveDecision(
                decision,
                action: action,
                option: action == "approve" && !decision.options.isEmpty ? selectedOption : nil,
                note: note.isEmpty ? nil : note,
                until: until
            )
            if succeeded { dismiss() }
        }
    }
}
