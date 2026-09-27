import SwiftUI
import WebKit

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = ""
    @State private var enteredURL = ""
    @State private var showingSetup = false
    @State private var connection: ConnectionState = .checking
    @State private var webError: String?
    @State private var reloadID = 0
    @State private var selectedTab: AppTab = .gallery
    @State private var showsTabs = false
    @State private var detailTabs: Set<AppTab> = []
    @State private var atSettingsHome = false
    @State private var network = NetworkMonitor()
    @State private var session = SessionWatcher()

    private var activeURL: URL? { ServerAddress.parse(serverURL) }
    private let pageBackground = Color(red: 0.0688, green: 0.07888, blue: 0.0912)
    // Ultra-thin material lifts the resting status area above the page color; this tint balances the measured difference while preserving blur.
    private let statusTint = Color(red: 7.0 / 255.0, green: 7.0 / 255.0, blue: 12.0 / 255.0)

    var body: some View {
        Group {
            if let activeURL, !showingSetup {
                switch connection {
                case .checking:
                    ProgressView("Checking server…")
                case .offline:
                    unavailable("You're offline", symbol: "wifi.slash", message: "Connect this iPhone to the internet or your VPN, then try again.", address: activeURL)
                case .incompatible(let serverVersion):
                    unavailable("Update required", symbol: "arrow.triangle.2.circlepath", message: incompatibleMessage(serverVersion), address: activeURL)
                case .failed(let message):
                    unavailable("Cannot connect", symbol: "wifi.exclamationmark", message: message, address: activeURL)
                case .ready:
                    browser(activeURL)
                }
            } else {
                NavigationStack {
                    setupView.navigationTitle("Server")
                }
            }
        }
        .task {
            if let activeURL { await checkServer(activeURL) }
        }
        .onChange(of: network.isOnline) { _, online in
            if online, case .offline = connection, let activeURL {
                Task { await checkServer(activeURL) }
            }
        }
    }

    private var setupView: some View {
        Form {
            Section("Your server") {
                TextField("https://gooncave.example", text: $enteredURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .accessibilityLabel("Server address")
                Text("Enter the HTTPS address that opens GoonCave in a browser. The server must be reachable from this iPhone.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                Button("Connect") {
                    guard let address = ServerAddress.parse(enteredURL) else { return }
                    let changesServer = address.absoluteString != serverURL
                    serverURL = address.absoluteString
                    connection = .checking
                    webError = nil
                    showingSetup = false
                    Task {
                        if changesServer { await clearServerData() }
                        await checkServer(address)
                    }
                }
                .disabled(ServerAddress.parse(enteredURL) == nil)
            }
        }
        .onAppear {
            if enteredURL.isEmpty { enteredURL = serverURL }
        }
    }

    private func browser(_ address: URL) -> some View {
        TabView(selection: $selectedTab) {
            ForEach(AppTab.allCases) { tab in
                Group {
                    if tab == .games {
                        ContentUnavailableView("Games", systemImage: "gamecontroller", description: Text("Games are coming soon."))
                    } else {
                        site(tab, at: address)
                        .overlay(alignment: .bottom) {
                            if !showsTabs {
                                Button("Change server", systemImage: "server.rack") { showSetup() }
                                    .padding(.horizontal, 20)
                                    .padding(.vertical, 12)
                                    .background(.regularMaterial, in: Capsule())
                                    .padding(.bottom, 8)
                            } else if tab == .settings && atSettingsHome {
                                Button("Change server", systemImage: "server.rack") { showSetup() }
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 10)
                                    .background(.regularMaterial, in: Capsule())
                                    .padding(.bottom, 12)
                            }
                        }
                    }
                }
                .toolbar(showsTabs && !detailTabs.contains(tab) ? .visible : .hidden, for: .tabBar)
                .tabItem { Label(tab.title, systemImage: tab.symbol) }
                .tag(tab)
            }
        }
            .background(pageBackground, ignoresSafeAreaEdges: .top)
            .overlay {
                GeometryReader { geometry in
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .overlay(statusTint.opacity(0.7))
                        .frame(height: geometry.safeAreaInsets.top)
                        .offset(y: -geometry.safeAreaInsets.top)
                        .allowsHitTesting(false)
                }
            }
            .overlay {
                if let webError {
                    ContentUnavailableView {
                        Label("Page unavailable", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(webError)
                    } actions: {
                        Button("Try again") { reloadID += 1 }
                        Button("Change server") { showSetup() }
                    }
                    .padding()
                    .background(.regularMaterial)
                }
            }
            // Cover the site instead of unloading it, so reconnecting keeps the page and scroll position.
            .overlay {
                if !network.isOnline {
                    ContentUnavailableView {
                        Label("You're offline", systemImage: "wifi.slash")
                    } description: {
                        Text("GoonCave keeps your place and continues when this iPhone reconnects.")
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.regularMaterial)
                }
            }
    }

    @ViewBuilder private func site(_ tab: AppTab, at address: URL) -> some View {
        let page = WebView(
            serverURL: address,
            initialTab: tab,
            errorMessage: $webError,
            showsTabs: $showsTabs,
            detailTabs: $detailTabs,
            atSettingsHome: $atSettingsHome,
            reloadID: reloadID,
            sessionGeneration: session.generation,
            isVisible: selectedTab == tab
        )
        page.backgroundExtensionEffect().ignoresSafeArea(edges: .bottom)
    }

    private func unavailable(_ title: String, symbol: String, message: String, address: URL) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await checkServer(address) } }
            Button("Change server") { showSetup() }
        }
    }

    private func incompatibleMessage(_ serverVersion: Int?) -> String {
        if let serverVersion, serverVersion > supportedAPIVersions.upperBound {
            return "This server needs a newer version of this app. Install the latest GoonCave IPA."
        }
        return "This server runs an older GoonCave. Update the server, then try again."
    }

    private func showSetup() {
        enteredURL = serverURL
        showingSetup = true
        webError = nil
        showsTabs = false
        detailTabs.removeAll()
        atSettingsHome = false
    }

    // The previous server's session cookie, cached pages, and media must not
    // reach the next server or account. Runs before any web view is created.
    @MainActor
    private func clearServerData() async {
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        URLCache.shared.removeAllCachedResponses()
    }

    @MainActor
    private func checkServer(_ address: URL) async {
        connection = .checking
        var request = URLRequest(url: address.appending(path: "health"))
        request.timeoutInterval = 10
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard !Task.isCancelled, serverURL == address.absoluteString else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  response.url?.host == address.host,
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  body["status"] as? String == "ok" else {
                connection = .failed("This address did not return the GoonCave health response. Check that it points to the server root.")
                return
            }
            guard let version = body["apiVersion"] as? Int, supportedAPIVersions.contains(version) else {
                connection = .incompatible(serverVersion: body["apiVersion"] as? Int)
                return
            }
            connection = .ready
        } catch {
            let message = await recoveryMessage(for: error, server: address)
            guard !Task.isCancelled, serverURL == address.absoluteString else { return }
            connection = message.map(ConnectionState.failed) ?? .offline
        }
    }
}

// Must include the apiVersion that the server's /health route reports.
private let supportedAPIVersions = 1...1

private enum ConnectionState {
    case checking
    case ready
    case offline
    case incompatible(serverVersion: Int?)
    case failed(String)
}
