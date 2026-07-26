import SwiftUI

struct CaptureView: View {
    @EnvironmentObject private var model: AppModel
    @State private var text = ""
    @State private var kind = "update"
    @State private var saved = false
    @State private var savedTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ConnectionBanner()

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Capture anything").font(.largeTitle.bold())
                        Text("Get it out of your head. You can organize it later.")
                            .foregroundStyle(.secondary)
                    }

                    Picker("Kind", selection: $kind) {
                        Label("Update", systemImage: "bolt").tag("update")
                        Label("Idea", systemImage: "lightbulb").tag("idea")
                        Label("Question", systemImage: "questionmark").tag("question")
                    }
                    .pickerStyle(.segmented)

                    TextEditor(text: $text)
                        .focused($focused)
                        .frame(minHeight: 180)
                        .padding(10)
                        .scrollContentBackground(.hidden)
                        .background(.background, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(alignment: .topLeading) {
                            if text.isEmpty {
                                Text("A thought, observation, question, or thing you do not want to lose…")
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 15)
                                    .padding(.vertical, 18)
                                    .allowsHitTesting(false)
                            }
                        }

                    if let project = model.selectedProject {
                        Label("Saving to \(project.name)", systemImage: "folder.fill")
                            .font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        Label("Saving to the workspace inbox", systemImage: "tray.fill")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }

                    Button {
                        save()
                    } label: {
                        HStack {
                            if model.isMutating { ProgressView().tint(.white) }
                            if saved { Label("Saved", systemImage: "checkmark") }
                            else { Text(model.isMutating ? "Saving…" : "Save Capture") }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || model.isMutating || model.isShowingCachedData)

                    if !recentCaptures.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Recently captured").font(.title3.bold())
                            ForEach(recentCaptures) { capture in
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: icon(for: capture.kind)).foregroundStyle(.purple)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(capture.text).lineLimit(2)
                                        if let date = WorkFormatting.date(from: capture.createdAt) {
                                            Text(date.formatted(.relative(presentation: .named)))
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.background, in: RoundedRectangle(cornerRadius: 12))
                            }
                        }
                        .padding(.top, 6)
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .onDisappear { savedTask?.cancel() }
        }
    }

    private var recentCaptures: [WorkCapture] {
        Array(model.scopedCaptures.sorted { $0.createdAt > $1.createdAt }.prefix(5))
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "idea": "lightbulb.fill"
        case "question": "questionmark.circle.fill"
        default: "bolt.fill"
        }
    }

    private func save() {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        focused = false
        Task {
            if await model.createCapture(text: content, kind: kind) {
                text = ""
                saved = true
                savedTask?.cancel()
                savedTask = Task {
                    try? await Task.sleep(for: .seconds(2))
                    guard !Task.isCancelled else { return }
                    await MainActor.run { saved = false }
                }
            }
        }
    }
}
