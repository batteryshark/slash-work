import SwiftUI

struct IdeasView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewIdea = false

    var body: some View {
        NavigationStack {
            List {
                if model.scopedIdeas.isEmpty {
                    ContentUnavailableView("No ideas yet", systemImage: "lightbulb",
                                           description: Text("Capture something worth considering now or later."))
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(sortedIdeas) { idea in
                        NavigationLink { IdeaDetailView(ideaID: idea.id) } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    StatusPill(value: idea.status)
                                    Spacer()
                                    if idea.agentIntent == "evaluation_requested" {
                                        Label("Evaluation requested", systemImage: "sparkles")
                                            .font(.caption2).foregroundStyle(.purple)
                                    }
                                }
                                Text(idea.title).font(.headline)
                                if !idea.sections.opportunity.isEmpty {
                                    Text(idea.sections.opportunity).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                }
                                if let revisit = WorkFormatting.shortDate(idea.revisitAt) {
                                    Label("Revisit \(revisit)", systemImage: "calendar")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 7)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingNewIdea = true } label: { Image(systemName: "plus") }
                        .disabled(model.isShowingCachedData)
                        .accessibilityLabel("New idea")
                }
            }
            .refreshable { await model.refresh() }
            .sheet(isPresented: $showingNewIdea) { NewIdeaSheet().environmentObject(model) }
        }
    }

    private var sortedIdeas: [WorkIdea] {
        model.scopedIdeas.sorted { $0.updatedAt > $1.updatedAt }
    }
}

private struct NewIdeaSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var opportunity = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Idea") {
                    TextField("What should we consider?", text: $title, axis: .vertical)
                    TextEditor(text: $opportunity).frame(minHeight: 130)
                }
                if let project = model.selectedProject {
                    Section("Project") { Label(project.name, systemImage: "folder") }
                }
            }
            .navigationTitle("New Idea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            if await model.createIdea(
                                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                opportunity: opportunity.trimmingCharacters(in: .whitespacesAndNewlines)
                            ) { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}

private struct IdeaDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let ideaID: String
    @State private var pendingStatus: String?
    @State private var showingReason = false
    @State private var showingDelete = false

    var body: some View {
        Group {
            if let idea {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            StatusPill(value: idea.status)
                            Text(idea.title).font(.title2.bold())
                            if !idea.tags.isEmpty {
                                Text(idea.tags.map { "#\($0)" }.joined(separator: "  "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 6)
                    }

                    Section("State") {
                        Menu("Change state") {
                            ForEach(["open", "exploring", "deferred", "proposed", "adopted", "declined"], id: \.self) { status in
                                Button {
                                    change(idea: idea, to: status)
                                } label: {
                                    Label(WorkFormatting.title(for: status),
                                          systemImage: status == idea.status ? "checkmark" : "arrow.right")
                                }
                                .disabled(status == idea.status)
                            }
                        }
                        .disabled(model.isMutating || model.isShowingCachedData)

                        Button {
                            Task { await model.requestIdeaEvaluation(idea) }
                        } label: {
                            Label(idea.agentIntent == "evaluation_requested" ? "Evaluation requested" : "Ask agent to evaluate",
                                  systemImage: "sparkles")
                        }
                        .disabled(model.isMutating || model.isShowingCachedData
                                  || idea.agentIntent == "evaluation_requested"
                                  || ["deferred", "adopted", "declined"].contains(idea.status))
                    }

                    ForEach(sections(for: idea), id: \.title) { section in
                        if !section.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Section(section.title) { Text(section.text).textSelection(.enabled) }
                        }
                    }

                    Section {
                        Button("Delete Idea", role: .destructive) { showingDelete = true }
                            .disabled(model.isShowingCachedData)
                    }
                }
                .navigationTitle("Idea")
                .navigationBarTitleDisplayMode(.inline)
                .sheet(isPresented: $showingReason) {
                    IdeaReasonSheet(status: pendingStatus ?? "deferred") { reason in
                        Task {
                            if await model.updateIdea(idea, status: pendingStatus ?? "deferred", reason: reason) {
                                showingReason = false
                            }
                        }
                    }
                }
                .confirmationDialog("Delete this idea?", isPresented: $showingDelete, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) {
                        Task { if await model.deleteIdea(idea) { dismiss() } }
                    }
                } message: {
                    Text("This removes the Markdown record. This cannot be undone in the app.")
                }
            } else {
                ContentUnavailableView("Idea unavailable", systemImage: "lightbulb.slash")
            }
        }
    }

    private var idea: WorkIdea? { model.snapshot?.ideas.first { $0.id == ideaID } }

    private func change(idea: WorkIdea, to status: String) {
        pendingStatus = status
        if ["deferred", "declined"].contains(status) {
            showingReason = true
        } else {
            Task { await model.updateIdea(idea, status: status, reason: nil) }
        }
    }

    private func sections(for idea: WorkIdea) -> [(title: String, text: String)] {
        [
            ("Opportunity", idea.sections.opportunity),
            ("Why It Might Matter", idea.sections.whyItMightMatter),
            ("Hypothesis", idea.sections.hypothesis),
            ("Unknowns", idea.sections.unknowns),
            ("Potential Shape", idea.sections.potentialShape),
            ("Evidence", idea.sections.evidence),
            ("Risks and Constraints", idea.sections.risksAndConstraints),
            ("Next Evaluation", idea.sections.nextEvaluation),
            ("Outcome", idea.sections.outcome),
        ]
    }
}

private struct IdeaReasonSheet: View {
    @Environment(\.dismiss) private var dismiss
    let status: String
    let onSave: (String) -> Void
    @State private var reason = ""

    var body: some View {
        NavigationStack {
            Form {
                Section(status == "deferred" ? "Why not now?" : "Why are we closing this?") {
                    TextEditor(text: $reason).frame(minHeight: 150)
                }
            }
            .navigationTitle(WorkFormatting.title(for: status))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(reason.trimmingCharacters(in: .whitespacesAndNewlines)) }
                        .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
