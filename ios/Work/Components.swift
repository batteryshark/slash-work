import SwiftUI

/// The workbench palette, verbatim from app/globals.css. Light and dark are
/// the web's tokens, so the phone and the desktop read as one product.
enum WorkTheme {
    static let canvas = dynamic(light: 0xF4F4F8, dark: 0x0F0F14)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x16161D)
    static let surfaceMuted = dynamic(light: 0xEBEBF2, dark: 0x1E1E28)
    static let ink = dynamic(light: 0x1C1C24, dark: 0xE9E9F0)
    static let muted = dynamic(light: 0x63636F, dark: 0x8D8D9E)
    static let line = dynamic(light: 0xDDDDE6, dark: 0x262631)
    static let accent = dynamic(light: 0x7261EE, dark: 0x8B7CF7)
    static let accentSoft = dynamic(light: 0xE9E6FF, dark: 0x262242)
    static let danger = dynamic(light: 0xC04545, dark: 0xF16969)
    static let warning = dynamic(light: 0x8F5F14, dark: 0xF0A231)
    static let success = dynamic(light: 0x1E7A4C, dark: 0x4ADE80)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 0xFF) / 255,
                           green: CGFloat((value >> 8) & 0xFF) / 255,
                           blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        })
    }
}

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

/// The rail translated to a phone: a scope button in the navigation bar that
/// opens the scope sheet, plus the refresh control.
private struct WorkNavigationModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @State private var showingScope = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Button { showingScope = true } label: {
                        HStack(spacing: 6) {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(model.selectedProject?.name ?? "All projects")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(WorkTheme.ink)
                                    .lineLimit(1)
                                Text(model.selectedWorkspace?.name ?? model.snapshot?.workspace.name ?? "Workspace")
                                    .font(.caption2)
                                    .foregroundStyle(WorkTheme.muted)
                                    .lineLimit(1)
                            }
                            Image(systemName: "chevron.down.circle.fill")
                                .font(.caption)
                                .foregroundStyle(WorkTheme.muted)
                        }
                    }
                    .accessibilityLabel("Change workspace or project")
                }
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
            .sheet(isPresented: $showingScope) {
                ScopeSheet().environmentObject(model)
            }
    }
}

/// The capture pill translated to a phone: a floating button that opens the
/// one-line capture bar. Hidden on offline snapshots, which are read-only.
private struct CaptureButtonModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @State private var showingCapture = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottomTrailing) {
                if !model.isShowingCachedData {
                    Button { showingCapture = true } label: {
                        Image(systemName: "plus")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(width: 48, height: 48)
                            .background(WorkTheme.accent, in: Circle())
                            .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
                    }
                    .padding(.trailing, 18)
                    .padding(.bottom, 18)
                    .accessibilityLabel("Capture")
                }
            }
            .sheet(isPresented: $showingCapture) {
                CaptureBar().environmentObject(model)
            }
    }
}

extension View {
    func workNavigation() -> some View { modifier(WorkNavigationModifier()) }
    func workCapture() -> some View { modifier(CaptureButtonModifier()) }
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
                .foregroundStyle(WorkTheme.warning)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(WorkTheme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
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
                .foregroundStyle(WorkTheme.warning)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(WorkTheme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            default:
                if let warning = model.cacheWarning {
                    Label(warning, systemImage: "externaldrive.badge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(WorkTheme.warning)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(WorkTheme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
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

/// Same shape as StatusPill: the name always shows, the colour is only
/// reinforcement, so the chip stays readable without hue discrimination.
struct TagChip: View {
    let tag: String
    var selected = false
    var color: Color { WorkTag.color(tag) }

    var body: some View {
        Text(tag)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(selected ? 0.28 : 0.12), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(selected ? 0.9 : 0.25), lineWidth: selected ? 1.5 : 1))
    }
}

/// The web's due chip: overdue red, today amber, later plain.
struct DueChip: View {
    let dueAt: String?

    var body: some View {
        if let label = WorkFormatting.dueLabel(dueAt) {
            let tone = WorkFormatting.dueTone(dueAt)
            let color: Color = switch tone {
            case .overdue: WorkTheme.danger
            case .today: WorkTheme.warning
            default: WorkTheme.muted
            }
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(color.opacity(0.12), in: Capsule())
        }
    }
}

/// The web's 34px list row: status dot, id, title, chips. Compact on purpose.
struct TaskRowView: View {
    @EnvironmentObject private var model: AppModel
    let task: WorkTask
    var showsProject = false
    /// Called when the checkbox gate needs the panel open (incomplete checklist).
    var onOpen: (String) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 8) {
            Button {
                Task { await completeFromRow() }
            } label: {
                Image(systemName: task.status == "done" ? "checkmark.square.fill" : "square")
                    .font(.subheadline)
                    .foregroundStyle(task.status == "done" ? WorkTheme.accent : WorkTheme.muted)
            }
            .buttonStyle(.plain)
            .disabled(model.isMutating || model.isShowingCachedData)
            .accessibilityLabel(task.status == "done" ? "Mark \(task.id) not done" : "Mark \(task.id) done")

            Circle()
                .fill(Color.workStatus(task.status))
                .frame(width: 7, height: 7)

            Text(task.id)
                .font(.caption2.monospaced())
                .foregroundStyle(WorkTheme.muted)

            Text(task.title)
                .font(.footnote)
                .foregroundStyle(task.isFinished ? WorkTheme.muted : WorkTheme.ink)
                .strikethrough(task.status == "done")
                .lineLimit(1)

            Spacer(minLength: 4)

            if task.delegated {
                Text("agent")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(WorkTheme.accent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(WorkTheme.accentSoft, in: Capsule())
            }
            if task.blockedReason != nil || task.status == "blocked" {
                Text("blocked")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(WorkTheme.danger)
            }
            if !task.isFinished { DueChip(dueAt: task.dueAt) }
            if task.checklistTotal > 0 {
                Text("\(task.checklistCompleted)/\(task.checklistTotal)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(WorkTheme.muted)
            }
            if showsProject, let path = task.projectPath {
                Text(path.split(separator: "/").last.map(String.init) ?? path)
                    .font(.caption2)
                    .foregroundStyle(WorkTheme.muted)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }

    /// The web's checkbox rule: an incomplete checklist opens the card at its
    /// unfinished boxes instead of silently refusing; unchecking returns the
    /// task to backlog.
    private func completeFromRow() async {
        if task.status == "done" {
            _ = await model.moveTask(task, to: "backlog")
            return
        }
        if task.checklistTotal > 0, task.checklistCompleted < task.checklistTotal {
            onOpen(task.id)
            return
        }
        _ = await model.moveTask(task, to: "done")
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
            .background(WorkTheme.danger.opacity(0.92), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
