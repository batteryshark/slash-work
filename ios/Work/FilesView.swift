import SwiftUI

/// The workbench Files tab: a read-only tree fetched one directory at a time,
/// with a plain-text preview. Scoped to a project, like the web.
struct FilesView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if model.selectedProjectPath == nil {
                    ContentUnavailableView(
                        "Files are scoped to a project",
                        systemImage: "folder",
                        description: Text("Choose a project from the scope button to browse its files.")
                    )
                    .background(WorkTheme.canvas)
                } else {
                    FileDirectoryList(path: ".")
                        // Changing scope swaps the tree out from under the
                        // browser; rebuilding it is the honest reset.
                        .id(model.selectedProjectPath)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .workNavigation()
            .workCapture()
        }
    }
}

struct FileDirectoryList: View {
    @EnvironmentObject private var model: AppModel
    let path: String
    @State private var directory: FileDirectory?
    @State private var isLoading = false

    var body: some View {
        List {
            if let directory {
                if directory.entries.isEmpty {
                    Text("This directory is empty.")
                        .font(.footnote)
                        .foregroundStyle(WorkTheme.muted)
                        .listRowBackground(WorkTheme.surface)
                }
                ForEach(directory.entries) { entry in
                    row(entry)
                        .listRowBackground(WorkTheme.surface)
                }
            } else if isLoading {
                HStack {
                    ProgressView()
                    Text("Loading…").font(.footnote).foregroundStyle(WorkTheme.muted)
                }
                .listRowBackground(WorkTheme.surface)
            } else {
                Text("This directory could not be read.")
                    .font(.footnote)
                    .foregroundStyle(WorkTheme.muted)
                    .listRowBackground(WorkTheme.surface)
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 34)
        .scrollContentBackground(.hidden)
        .background(WorkTheme.canvas)
        .navigationTitle(path == "." ? "Files" : (path.split(separator: "/").last.map(String.init) ?? path))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard directory == nil else { return }
            isLoading = true
            directory = await model.listFiles(path: path)
            isLoading = false
        }
        .refreshable {
            directory = await model.listFiles(path: path)
        }
    }

    @ViewBuilder
    private func row(_ entry: FileEntry) -> some View {
        if entry.isDirectory {
            NavigationLink {
                FileDirectoryList(path: entry.path)
            } label: {
                entryLabel(entry, icon: "folder")
            }
        } else if entry.previewable {
            NavigationLink {
                FilePreviewView(path: entry.path, name: entry.name)
            } label: {
                entryLabel(entry, icon: "doc.text")
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                entryLabel(entry, icon: entry.kind == "symlink" ? "arrow.triangle.turn.up.right.diamond" : "doc")
                if let reason = entry.blockedReason {
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(WorkTheme.muted)
                }
            }
            .foregroundStyle(WorkTheme.muted)
        }
    }

    private func entryLabel(_ entry: FileEntry, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.footnote)
                .foregroundStyle(entry.isDirectory ? WorkTheme.accent : WorkTheme.muted)
                .frame(width: 18)
            Text(entry.name)
                .font(.footnote)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let status = entry.gitStatus {
                Text(status)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(status == "deleted" ? WorkTheme.danger : WorkTheme.warning)
            }
        }
    }
}

struct FilePreviewView: View {
    @EnvironmentObject private var model: AppModel
    let path: String
    let name: String
    @State private var preview: FilePreview?
    @State private var isLoading = false

    var body: some View {
        Group {
            if let preview {
                ScrollView([.vertical, .horizontal]) {
                    // Line numbers in the gutter, matching the web preview.
                    let lines = preview.content.components(separatedBy: "\n")
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            HStack(alignment: .top, spacing: 10) {
                                Text("\(index + 1)")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(WorkTheme.muted)
                                    .frame(width: 36, alignment: .trailing)
                                Text(line.isEmpty ? " " : line)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(WorkTheme.ink)
                            }
                        }
                        if preview.truncated {
                            Text("Preview truncated. The full file is larger than the preview limit.")
                                .font(.caption2)
                                .foregroundStyle(WorkTheme.warning)
                                .padding(.top, 8)
                        }
                    }
                    .padding(12)
                    .textSelection(.enabled)
                }
                .background(WorkTheme.canvas)
            } else if isLoading {
                ProgressView()
            } else {
                ContentUnavailableView("Preview unavailable", systemImage: "doc.text",
                                       description: Text("This file could not be read as text."))
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard preview == nil else { return }
            isLoading = true
            preview = await model.previewFile(path: path)
            isLoading = false
        }
    }
}
