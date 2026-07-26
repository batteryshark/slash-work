import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { NotesView() } label: {
                        Label { LabeledContent("Notes", value: model.scopedNotes.count.formatted()) }
                        icon: { Image(systemName: "note.text").foregroundStyle(.blue) }
                    }
                    NavigationLink { CaptureInboxView() } label: {
                        Label { LabeledContent("Capture Inbox", value: model.scopedCaptures.count.formatted()) }
                        icon: { Image(systemName: "tray.full").foregroundStyle(.orange) }
                    }
                }

                Section("Connection") {
                    NavigationLink { ConnectionsView() } label: {
                        Label("Work Instances", systemImage: "server.rack")
                    }
                    if let workspace = model.selectedWorkspace {
                        LabeledContent("Workspace", value: workspace.name)
                        LabeledContent("Location", value: workspace.isRemote ? "Remote via \(workspace.peer?.name ?? "peer")" : "Local")
                    }
                    if let version = model.serviceVersion {
                        LabeledContent("Work version", value: version)
                    }
                    LabeledContent("Client API", value: "v\(WorkAPIClient.supportedAPIVersion)")
                }

                Section {
                    Button {
                        Task {
                            await model.refreshDirectory()
                            await model.refresh()
                        }
                    } label: {
                        Label("Refresh workspaces", systemImage: "arrow.triangle.2.circlepath")
                    }
                    Button(role: .destructive) { model.disconnect() } label: {
                        Label("Disconnect", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
        }
    }
}

private struct NotesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingNewNote = false

    var body: some View {
        List {
            if model.scopedNotes.isEmpty {
                ContentUnavailableView("No notes", systemImage: "note.text",
                                       description: Text("Add durable project context without turning it into a task."))
                    .listRowBackground(Color.clear)
            } else {
                ForEach(model.scopedNotes.sorted { $0.updatedAt > $1.updatedAt }) { note in
                    NavigationLink {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                Text(note.title).font(.largeTitle.bold())
                                if note.createdBy.kind == "agent" {
                                    Label("Created by \(note.createdBy.name ?? "agent")", systemImage: "cpu")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Text(note.text).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                            }
                            .padding()
                        }
                        .navigationTitle("Note")
                        .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(note.title).font(.headline)
                            Text(note.text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .padding(.vertical, 5)
                    }
                }
            }
        }
        .navigationTitle("Notes")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingNewNote = true } label: { Image(systemName: "plus") }
                    .disabled(model.isShowingCachedData)
            }
        }
        .sheet(isPresented: $showingNewNote) { NewNoteSheet().environmentObject(model) }
    }
}

private struct NewNoteSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Note") {
                    TextField("Title", text: $title)
                    TextEditor(text: $text).frame(minHeight: 180)
                }
            }
            .navigationTitle("New Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            if await model.createNote(
                                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                text: text.trimmingCharacters(in: .whitespacesAndNewlines)
                            ) { dismiss() }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isMutating)
                }
            }
        }
    }
}

private struct CaptureInboxView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            if model.scopedCaptures.isEmpty {
                ContentUnavailableView("Inbox clear", systemImage: "tray",
                                       description: Text("New captures will appear here."))
                    .listRowBackground(Color.clear)
            } else {
                ForEach(model.scopedCaptures.sorted { $0.createdAt > $1.createdAt }) { capture in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(WorkFormatting.title(for: capture.kind), systemImage: icon(for: capture.kind))
                            .font(.caption.weight(.semibold)).foregroundStyle(.purple)
                        Text(capture.text)
                        if let date = WorkFormatting.date(from: capture.createdAt) {
                            Text(date.formatted(.relative(presentation: .named)))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await model.deleteCapture(capture) }
                        } label: { Label("Delete", systemImage: "trash") }
                        .disabled(model.isShowingCachedData)
                    }
                }
            }
        }
        .navigationTitle("Capture Inbox")
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "idea": "lightbulb"
        case "question": "questionmark.circle"
        default: "bolt"
        }
    }
}

private struct ConnectionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var profileToForget: ServerProfile?

    var body: some View {
        List {
            ForEach(model.profiles) { profile in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Label(profile.name, systemImage: profile.id == model.activeProfileID ? "checkmark.circle.fill" : "server.rack")
                        Spacer()
                        if profile.id == model.activeProfileID { Text("Connected").font(.caption).foregroundStyle(.green) }
                    }
                    Text(profile.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard profile.id != model.activeProfileID else { return }
                    Task { await model.connect(to: profile) }
                }
                .swipeActions {
                    Button(role: .destructive) { profileToForget = profile } label: {
                        Label("Forget", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle("Work Instances")
        .confirmationDialog("Forget this Work instance?", isPresented: Binding(
            get: { profileToForget != nil }, set: { if !$0 { profileToForget = nil } }
        ), titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                guard let profile = profileToForget else { return }
                Task { await model.forget(profile) }
            }
        } message: {
            Text("Its cached snapshots will also be removed from this device.")
        }
    }
}
