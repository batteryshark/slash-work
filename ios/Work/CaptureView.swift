import SwiftUI

/// The workbench capture dock as a sheet: one field, no ceremony. Plain text
/// files a capture into the current scope; a `task:` first line files tasks.
struct CaptureBar: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var notice: String?
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Capture").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .font(.subheadline)
            }

            TextField("Write anything you want remembered", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .font(.subheadline)
                .padding(10)
                .background(WorkTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(WorkTheme.line, lineWidth: 1))
                .focused($focused)
                .submitLabel(.send)
                .onSubmit { submit() }

            Group {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(WorkTheme.danger)
                } else if let notice {
                    Text(notice).foregroundStyle(WorkTheme.success)
                } else {
                    Text("Saves to \(destinationName). Start with \"task:\" to file a task instead.")
                        .foregroundStyle(WorkTheme.muted)
                }
            }
            .font(.caption)

            Button {
                submit()
            } label: {
                Text(model.isMutating ? "Saving…" : "Save")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      || model.isMutating || model.isShowingCachedData)

            Spacer(minLength: 0)
        }
        .padding(16)
        .background(WorkTheme.canvas)
        .presentationDetents([.height(240), .medium])
        .presentationDragIndicator(.visible)
        .onAppear { focused = true }
    }

    private var destinationName: String {
        model.selectedProject?.name ?? "the workspace inbox"
    }

    private func submit() {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        errorMessage = nil
        notice = nil

        if let titles = TaskLines.taskCommandTitles(content) {
            text = ""
            Task {
                let result = await model.quickAddTasks(titles.joined(separator: "\n"),
                                                       status: "backlog", parentId: nil)
                if let error = result.error {
                    errorMessage = "Added \(result.created.count) of \(titles.count). Not saved — \(error)"
                    if text.isEmpty {
                        text = result.remaining.map { "task: \($0)" }.joined(separator: "\n")
                    }
                } else {
                    notice = result.created.count == 1
                        ? "Added 1 task to \(destinationName)."
                        : "Added \(result.created.count) tasks to \(destinationName)."
                }
                focused = true
            }
            return
        }

        text = ""
        Task {
            if await model.createCapture(text: content, toProject: model.selectedProjectPath != nil) {
                notice = "Saved to \(destinationName)."
            } else {
                errorMessage = model.lastError.map { "Not saved — \($0)" } ?? "Not saved."
                if text.isEmpty { text = content }
            }
            focused = true
        }
    }
}
