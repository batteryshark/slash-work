import SwiftUI

@main
struct WorkApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task {
                    guard model.activeProfile != nil else { return }
                    await model.connect()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                if model.snapshot == nil, model.activeProfile != nil { await model.connect() }
                else { await model.refresh() }
            }
        }
    }
}

private struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            if model.snapshot != nil {
                DashboardTabs()
            } else {
                ConnectionView()
            }
            ErrorToast()
                .padding(.top, 6)
                .animation(.snappy, value: model.lastError)
        }
    }
}

private struct DashboardTabs: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }
                .badge(model.openDecisions.count)

            BoardView()
                .tabItem { Label("Board", systemImage: "rectangle.3.group") }

            CaptureView()
                .tabItem { Label("Capture", systemImage: "plus.circle.fill") }

            IdeasView()
                .tabItem { Label("Ideas", systemImage: "lightbulb.fill") }

            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
    }
}

private struct ConnectionView: View {
    @EnvironmentObject private var model: AppModel
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 26) {
                    WorkMark()
                        .frame(width: 88, height: 88)
                        .shadow(color: .purple.opacity(0.22), radius: 18, y: 8)

                    VStack(spacing: 7) {
                        Text("/work")
                            .font(.largeTitle.bold())
                        Text("Your projects, decisions, and work in motion—native on your tailnet.")
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    if !model.profiles.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Saved instances").font(.headline)
                            ForEach(model.profiles) { profile in
                                Button {
                                    Task { await model.connect(to: profile) }
                                } label: {
                                    HStack {
                                        Image(systemName: "server.rack")
                                        VStack(alignment: .leading) {
                                            Text(profile.name).foregroundStyle(.primary)
                                            Text(profile.url).font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                    }
                                    .padding(12)
                                    .background(.background, in: RoundedRectangle(cornerRadius: 12))
                                }
                                .buttonStyle(.plain)
                                .disabled(model.connectionState == .connecting)
                            }
                        }
                        .frame(maxWidth: 480)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Work URL").font(.headline)
                        TextField("http://100.x.y.z:43170", text: $model.serverURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .submitLabel(.go)
                            .focused($focused)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 54)
                            .background(.background, in: RoundedRectangle(cornerRadius: 12))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(focused ? Color.accentColor : Color.secondary.opacity(0.25),
                                            lineWidth: focused ? 2 : 1)
                            }
                            .onSubmit { connect() }
                        Text("Start Work with `work --tailscale`, then enter the API URL it prints. Access is controlled by your tailnet ACLs.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: 480)

                    if case let .failed(message) = model.connectionState {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: 480, alignment: .leading)
                    }

                    Button { connect() } label: {
                        HStack {
                            if model.connectionState == .connecting { ProgressView().tint(.white) }
                            Text(model.connectionState == .connecting ? "Connecting…" : "Connect")
                        }
                        .frame(maxWidth: 480)
                        .padding(.vertical, 7)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.connectionState == .connecting
                              || model.serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.vertical, 48)
            }
            .background(Color(.systemGroupedBackground))
        }
    }

    private func connect() {
        focused = false
        Task { await model.connect() }
    }
}
