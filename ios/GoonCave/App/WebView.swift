import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let serverURL: URL
    let initialTab: AppTab
    @Binding var errorMessage: String?
    @Binding var showsTabs: Bool
    @Binding var detailTabs: Set<AppTab>
    let reloadID: Int

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
        webView.load(URLRequest(url: initialTab == .gallery ? serverURL : serverURL.appending(path: initialTab.path)))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastReloadID != reloadID {
            context.coordinator.lastReloadID = reloadID
            webView.load(URLRequest(url: initialTab == .gallery ? serverURL : serverURL.appending(path: initialTab.path)))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "routeChange")
        coordinator.stopObserving()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: WebView
        var lastReloadID: Int
        private var urlObservation: NSKeyValueObservation?

        init(_ parent: WebView) {
            self.parent = parent
            lastReloadID = parent.reloadID
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
            guard url.scheme == parent.serverURL.scheme,
                  url.host == parent.serverURL.host,
                  url.port == parent.serverURL.port else { return }
            parent.showsTabs = url.path.hasPrefix("/app")
            let detailParameter: String?
            switch url.path {
            case "/app/gallery": detailParameter = "fileId"
            case "/app/explore": detailParameter = "post"
            default: detailParameter = nil
            }
            let hasDetail = detailParameter.map { name in
                URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.contains { $0.name == name && !($0.value ?? "").isEmpty } ?? false
            } ?? false
            if hasDetail {
                parent.detailTabs.insert(parent.initialTab)
            } else {
                parent.detailTabs.remove(parent.initialTab)
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
