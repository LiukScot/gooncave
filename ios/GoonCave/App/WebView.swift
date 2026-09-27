import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let serverURL: URL
    let initialTab: AppTab
    @Binding var errorMessage: String?
    @Binding var showsTabs: Bool
    @Binding var detailTabs: Set<AppTab>
    @Binding var atSettingsHome: Bool
    let reloadID: Int
    let sessionGeneration: Int
    let isVisible: Bool

    private var startURL: URL { initialTab == .gallery ? serverURL : serverURL.appending(path: initialTab.path) }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let hideWebTabBar = """
        const style = document.createElement('style');
        style.textContent = '.app-tab-bar{display:none!important}@media(max-width:767.98px){.page-shell{padding-bottom:env(safe-area-inset-bottom)!important}}';
        document.documentElement.appendChild(style);
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: hideWebTabBar, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let reportRoute = """
        (() => {
          let lastHref = '';
          const notify = () => {
            if (location.href === lastHref) return;
            lastHref = location.href;
            window.webkit.messageHandlers.routeChange.postMessage(lastHref);
          };
          for (const method of ['pushState', 'replaceState']) {
            const original = history[method];
            history[method] = function (...args) {
              const result = original.apply(this, args);
              queueMicrotask(notify);
              return result;
            };
          }
          addEventListener('popstate', notify);
          addEventListener('pageshow', notify);
        })();
        """
        configuration.userContentController.add(context.coordinator, name: "routeChange")
        configuration.userContentController.addUserScript(
            WKUserScript(source: reportRoute, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.observeURL(of: webView)
        webView.load(URLRequest(url: startURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastReloadID != reloadID {
            context.coordinator.lastReloadID = reloadID
            webView.load(URLRequest(url: startURL))
        }
        // The visible tab caused the sign-in or sign-out and navigates itself;
        // hidden tabs would keep showing the previous account.
        if context.coordinator.lastSessionGeneration != sessionGeneration {
            context.coordinator.lastSessionGeneration = sessionGeneration
            if !isVisible { webView.load(URLRequest(url: startURL)) }
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "routeChange")
        coordinator.stopObserving()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: WebView
        var lastReloadID: Int
        var lastSessionGeneration: Int
        private var navigationCount = 0
        private var urlObservation: NSKeyValueObservation?

        init(_ parent: WebView) {
            self.parent = parent
            lastReloadID = parent.reloadID
            lastSessionGeneration = parent.sessionGeneration
        }

        func observeURL(of webView: WKWebView) {
            urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
                guard let self, let url = webView.url else { return }
                DispatchQueue.main.async { self.updateRoute(url) }
            }
        }

        func stopObserving() {
            urlObservation?.invalidate()
            urlObservation = nil
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "routeChange", message.frameInfo.isMainFrame,
                  let address = message.body as? String, let url = URL(string: address) else { return }
            updateRoute(url)
        }

        private func updateRoute(_ url: URL) {
            guard let route = SiteRoute(url: url, server: parent.serverURL) else { return }
            parent.showsTabs = route.showsTabs
            if parent.initialTab == .settings {
                parent.atSettingsHome = route.isSettingsHome
            }
            if route.showsDetail {
                parent.detailTabs.insert(parent.initialTab)
            } else {
                parent.detailTabs.remove(parent.initialTab)
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            navigationCount += 1
        }

        // iOS may end a background page's process to free memory, which leaves
        // a blank page after unlocking the phone.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if webView.url == nil {
                webView.load(URLRequest(url: parent.startURL))
            } else {
                webView.reload()
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.errorMessage = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showError(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showError(error)
        }

        // A nil message means the iPhone is offline, which ContentView already covers.
        private func showError(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            let failedNavigation = navigationCount
            let server = parent.serverURL
            Task { @MainActor in
                let message = await recoveryMessage(for: error, server: server)
                guard failedNavigation == navigationCount, let message else { return }
                parent.errorMessage = message
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else {
                decisionHandler(.cancel)
                return
            }
            if action.targetFrame?.isMainFrame == false || url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if url.scheme == parent.serverURL.scheme &&
                url.host == parent.serverURL.host &&
                url.port == parent.serverURL.port &&
                action.targetFrame != nil {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            if url.scheme == "https" || url.scheme == "http" {
                UIApplication.shared.open(url)
            }
        }
    }
}
