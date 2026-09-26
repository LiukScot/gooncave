import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let serverURL: URL
    @Binding var errorMessage: String?
    @Binding var selectedTab: AppTab
    @Binding var showsTabs: Bool
    let reloadID: Int
    let tabNavigationID: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let hideWebTabBar = """
        const style = document.createElement('style');
        style.textContent = '.app-tab-bar{display:none!important}@media(max-width:767.98px){.page-shell{padding-bottom:1rem!important}}';
        document.documentElement.appendChild(style);
        """
        configuration.userContentController.addUserScript(
            WKUserScript(source: hideWebTabBar, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.observeURL(of: webView)
        webView.load(URLRequest(url: serverURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastReloadID != reloadID {
            context.coordinator.lastReloadID = reloadID
            webView.load(URLRequest(url: serverURL))
        }
        if context.coordinator.lastTabNavigationID != tabNavigationID {
            context.coordinator.lastTabNavigationID = tabNavigationID
            webView.load(URLRequest(url: serverURL.appending(path: selectedTab.path)))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: WebView
        var lastReloadID: Int
        var lastTabNavigationID: Int
        private var urlObservation: NSKeyValueObservation?

        init(_ parent: WebView) {
            self.parent = parent
            lastReloadID = parent.reloadID
            lastTabNavigationID = parent.tabNavigationID
        }

        func observeURL(of webView: WKWebView) {
            urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
                guard let self, let url = webView.url,
                      url.scheme == self.parent.serverURL.scheme,
                      url.host == self.parent.serverURL.host,
                      url.port == self.parent.serverURL.port else { return }
                DispatchQueue.main.async {
                    self.parent.showsTabs = url.path.hasPrefix("/app")
                    if let tab = AppTab(url: url) { self.parent.selectedTab = tab }
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.errorMessage = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled {
                parent.errorMessage = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled {
                parent.errorMessage = error.localizedDescription
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
