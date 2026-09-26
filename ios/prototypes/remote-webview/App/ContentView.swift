import SwiftUI
import WebKit

struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = ""
    @State private var enteredURL = ""
    @State private var showingSetup = false
    @State private var connection: ConnectionState = .checking
    @State private var webError: String?
    @State private var reloadID = 0
    @State private var tabNavigationID = 0
    @State private var selectedTab: AppTab = .gallery
    @State private var showsTabs = false

    private var activeURL: URL? { ServerAddress.parse(serverURL) }

    var body: some View {
        Group {
            if let activeURL, !showingSetup {
                switch connection {
                case .checking:
                    ProgressView("Checking server…")
                case .failed(let message):
                    unavailable(message, address: activeURL)
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
                    serverURL = address.absoluteString
                    connection = .checking
                    webError = nil
                    showingSetup = false
                    Task { await checkServer(address) }
                }
                .disabled(ServerAddress.parse(enteredURL) == nil)
            }
        }
        .onAppear {
            if enteredURL.isEmpty { enteredURL = serverURL }
        }
    }

    private func browser(_ address: URL) -> some View {
        WebView(
            serverURL: address,
            errorMessage: $webError,
            selectedTab: $selectedTab,
            showsTabs: $showsTabs,
            reloadID: reloadID,
            tabNavigationID: tabNavigationID
        )
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if showsTabs {
                    tabBar
                } else {
                    Button("Change server", systemImage: "server.rack") { showSetup() }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(.regularMaterial)
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
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases) { tab in
                Group {
                    if tab == .settings {
                        Menu {
                            Button("GoonCave settings", systemImage: "gearshape") {
                                open(tab)
                            }
                            Button("Change server", systemImage: "server.rack") {
                                showSetup()
                            }
                        } label: {
                            tabLabel(tab)
                        }
                    } else {
                        Button { open(tab) } label: { tabLabel(tab) }
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, 8)
        .background(.regularMaterial)
    }

    private func tabLabel(_ tab: AppTab) -> some View {
        VStack(spacing: 4) {
            Image(systemName: tab.symbol).font(.system(size: 21))
            Text(tab.title).font(.caption2)
        }
        .foregroundStyle(selectedTab == tab ? .blue : .secondary)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(selectedTab == tab ? [.isSelected] : [])
    }

    private func open(_ tab: AppTab) {
        selectedTab = tab
        tabNavigationID += 1
    }

    private func unavailable(_ message: String, address: URL) -> some View {
        ContentUnavailableView {
            Label("Cannot connect", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await checkServer(address) } }
            Button("Change server") { showSetup() }
        }
    }

    private func showSetup() {
        enteredURL = serverURL
        showingSetup = true
        webError = nil
        showsTabs = false
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
            connection = .ready
        } catch {
            guard !Task.isCancelled, serverURL == address.absoluteString else { return }
            connection = .failed("Check the iPhone connection, server address, and HTTPS certificate. \(error.localizedDescription)")
        }
    }
}

private enum ConnectionState {
    case checking
    case ready
    case failed(String)
}

private enum ServerAddress {
    static func parse(_ text: String) -> URL? {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            return nil
        }
        return components.url
    }
}
