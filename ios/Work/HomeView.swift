import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedDecision: WorkDecision?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ConnectionBanner()

                    HStack(spacing: 12) {
                        MetricCard(value: model.unfinishedTaskCount, label: "Open work", icon: "rectangle.stack")
                        MetricCard(value: model.openDecisions.count, label: "Needs you", icon: "hand.raised.fill")
                        MetricCard(value: model.scopedCaptures.count, label: "Inbox", icon: "tray.fill")
                    }

                    if !model.openDecisions.isEmpty {
                        sectionHeader("Needs You", subtitle: "Decisions waiting for a human")
                        VStack(spacing: 10) {
                            ForEach(model.openDecisions) { decision in
                                Button { selectedDecision = decision } label: {
                                    DecisionCard(decision: decision)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if !upcoming.isEmpty {
                        sectionHeader("Upcoming", subtitle: "Scheduled work and revisit dates")
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 12) {
                                ForEach(upcoming) { item in UpcomingCard(item: item) }
                            }
                        }
                        .contentMargins(.horizontal, 1)
                    }

                    sectionHeader("Work in motion", subtitle: "Recently updated unfinished tasks")
                    if activeTasks.isEmpty {
                        ContentUnavailableView("Nothing in flight", systemImage: "checkmark.circle",
                                               description: Text("Create a task or choose another project."))
                            .frame(minHeight: 180)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(activeTasks) { task in
                                NavigationLink { TaskDetailView(taskID: task.id) } label: { TaskCard(task: task) }
                                if task.id != activeTasks.last?.id { Divider() }
                            }
                        }
                        .padding(.horizontal, 14)
                        .background(.background, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .refreshable { await model.refresh() }
            .sheet(item: $selectedDecision) { decision in
                DecisionSheet(decision: decision)
                    .environmentObject(model)
            }
        }
    }

    private var activeTasks: [WorkTask] {
        Array(model.scopedTasks.filter { !$0.isFinished }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(8))
    }

    private var upcoming: [UpcomingItem] {
        guard model.snapshot != nil else { return [] }
        let tasks = model.scopedTasks.compactMap { task -> UpcomingItem? in
            guard !task.isFinished, let date = WorkFormatting.date(from: task.dueAt) else { return nil }
            return UpcomingItem(id: "task-\(task.id)", title: task.title, kind: "Task", date: date,
                                systemImage: "checklist", color: .blue)
        }
        let ideas = model.scopedIdeas.compactMap { idea -> UpcomingItem? in
            guard let date = WorkFormatting.date(from: idea.revisitAt) else { return nil }
            return UpcomingItem(id: "idea-\(idea.id)", title: idea.title, kind: "Idea", date: date,
                                systemImage: "lightbulb", color: .orange)
        }
        let decisions = model.scopedDecisions
            .compactMap { decision -> UpcomingItem? in
                guard decision.status == "deferred",
                      let date = WorkFormatting.date(from: decision.resolution?.choice?.until) else { return nil }
                return UpcomingItem(id: "decision-\(decision.id)", title: decision.title, kind: "Decision", date: date,
                                    systemImage: "hand.raised", color: .purple)
            }
        return Array((tasks + ideas + decisions).sorted { $0.date < $1.date }.prefix(20))
    }

    @ViewBuilder
    private func sectionHeader(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.title2.bold())
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
        }
    }
}

private struct MetricCard: View {
    let value: Int
    let label: String
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon).foregroundStyle(.purple)
            Text(value.formatted()).font(.title2.bold())
            Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct DecisionCard: View {
    let decision: WorkDecision

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(.purple)
                .frame(width: 28, height: 28)
                .background(.purple.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 6) {
                Text(decision.title).font(.headline).foregroundStyle(.primary)
                if !decision.detail.isEmpty {
                    Text(decision.detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                if let recommended = decision.recommendedOption {
                    Label("Recommended: \(recommended)", systemImage: "sparkles")
                        .font(.caption).foregroundStyle(.purple)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(.background, in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct UpcomingItem: Identifiable {
    let id: String
    let title: String
    let kind: String
    let date: Date
    let systemImage: String
    let color: Color
}

private struct UpcomingCard: View {
    let item: UpcomingItem

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(item.kind, systemImage: item.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(item.color)
            Text(item.title).font(.headline).lineLimit(3)
            Spacer(minLength: 0)
            Text(item.date.formatted(.dateTime.month(.abbreviated).day()))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(item.date < .now ? .red : .secondary)
        }
        .padding(14)
        .frame(width: 190, height: 140, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 16))
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
                    Text(decision.title).font(.title2.bold())
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
                                            .font(.caption).foregroundStyle(.purple)
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
