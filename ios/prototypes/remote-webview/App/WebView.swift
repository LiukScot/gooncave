import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let serverURL: URL
    @Binding var errorMessage: String?
    let reloadID: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: serverURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastReloadID != reloadID {
            context.coordinator.lastReloadID = reloadID
            webView.load(URLRequest(url: serverURL))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: WebView
        var lastReloadID: Int

        init(_ parent: WebView) {
            self.parent = parent
            lastReloadID = parent.reloadID
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
