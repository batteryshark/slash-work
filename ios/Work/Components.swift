import SwiftUI

struct WorkMark: View {
    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.23, style: .continuous)
                    .fill(
                        LinearGradient(colors: [Color(red: 0.61, green: 0.53, blue: 1),
                                                Color(red: 0.38, green: 0.28, blue: 0.91)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                Path { path in
                    path.move(to: CGPoint(x: size * 0.55, y: size * 0.20))
                    path.addLine(to: CGPoint(x: size * 0.72, y: size * 0.20))
                    path.addLine(to: CGPoint(x: size * 0.45, y: size * 0.80))
                    path.addLine(to: CGPoint(x: size * 0.28, y: size * 0.80))
                    path.closeSubpath()
                }
                .fill(.white)
            }
            .frame(width: size, height: size)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct WorkScopeMenu: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Menu {
            if let directory = model.directory {
                Section("Workspace") {
                    ForEach(directory.workspaces) { workspace in
                        Button {
                            Task { await model.selectWorkspace(workspace) }
                        } label: {
                            Label(workspace.name,
                                  systemImage: workspace.id == model.selectedWorkspaceID
                                    ? "checkmark" : "folder")
                        }
                    }
                }
            }

            if let projects = model.snapshot?.projects, !projects.isEmpty {
                Section("Project") {
                    Button {
                        model.selectProject(path: nil)
                    } label: {
                        Label("All projects", systemImage: model.selectedProjectPath == nil ? "checkmark" : "square.grid.2x2")
                    }
                }
                if !model.recentProjects.isEmpty {
                    Section("Recent") {
                        ForEach(model.recentProjects) { project in projectButton(project) }
                    }
                }
                // Submenus are the menu's collapsed-by-default disclosure group.
                ForEach(projectGroups(projects)) { group in
                    Menu {
                        ForEach(group.projects) { project in projectButton(project) }
                    } label: {
                        Label("\(group.title) (\(group.projects.count))", systemImage: "folder")
                    }
                }
            }
        } label: {
            HStack(spacing: 7) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.selectedProject?.name ?? "All projects")
                        .font(.headline)
                        .lineLimit(1)
                    Text(model.selectedWorkspace?.name ?? model.snapshot?.workspace.name ?? "Workspace")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.down.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Change workspace or project")
    }

    private func projectButton(_ project: WorkProject) -> some View {
        Button {
            model.selectProject(path: project.path)
        } label: {
            Label(project.name,
                  systemImage: project.path == model.selectedProjectPath ? "checkmark" : "folder")
        }
    }
}

private struct WorkNavigationModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .principal) { WorkScopeMenu() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        if model.isRefreshing { ProgressView() }
                        else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(model.isRefreshing)
                    .accessibilityLabel("Refresh")
                }
            }
    }
}

extension View {
    func workNavigation() -> some View { modifier(WorkNavigationModifier()) }
}

struct ConnectionBanner: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(spacing: 10) {
            if model.isStaleBuild {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Work was updated on disk. This service still runs the older build.",
                          systemImage: "clock.badge.exclamationmark")
                        .font(.caption)
                    Button(model.isRestartingService ? "Restarting…" : "Restart the service") {
                        Task { await model.restartService() }
                    }
                    .font(.caption.bold())
                    .buttonStyle(.bordered)
                    .disabled(model.isRestartingService)
                }
                .foregroundStyle(.orange)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            }
            switch model.connectionState {
            case let .offline(message):
                VStack(alignment: .leading, spacing: 4) {
                    Label("Offline snapshot", systemImage: "wifi.slash")
                        .font(.subheadline.bold())
                    Text(message)
                        .font(.caption)
                        .lineLimit(2)
                    if let savedAt = model.cacheSavedAt {
                        Text("Saved \(savedAt.formatted(.relative(presentation: .named)))")
                            .font(.caption2)
                    }
                }
                .foregroundStyle(.orange)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            default:
                if let warning = model.cacheWarning {
                    Label(warning, systemImage: "externaldrive.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }
}

struct StatusPill: View {
    let value: String
    var color: Color { .workStatus(value) }

    var body: some View {
        Text(WorkFormatting.title(for: value))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
    }
}

struct TaskCard: View {
    let task: WorkTask

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.id)
                    .font(.caption.monospaced().weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                StatusPill(value: task.status)
            }

            Text(task.title)
                .font(.headline)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)

            if let summary = task.descriptionSummary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .multilineTextAlignment(.leading)
            }

            HStack(spacing: 12) {
                if task.delegated {
                    Label("Agent", systemImage: "sparkles")
                        .foregroundStyle(.purple)
                }
                if let due = WorkFormatting.shortDate(task.dueAt) {
                    Label(due, systemImage: "calendar")
                        .foregroundStyle(dueColor)
                }
                if task.checklistTotal > 0 {
                    Label("\(task.checklistCompleted)/\(task.checklistTotal)", systemImage: "checklist")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private var dueColor: Color {
        guard let date = WorkFormatting.date(from: task.dueAt), !task.isFinished else { return .secondary }
        return date < .now ? .red : .secondary
    }
}

struct ErrorToast: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let error = model.lastError {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(error).font(.footnote)
                Spacer(minLength: 0)
                Button { model.lastError = nil } label: { Image(systemName: "xmark") }
            }
            .foregroundStyle(.white)
            .padding(12)
            .background(.red.opacity(0.92), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
