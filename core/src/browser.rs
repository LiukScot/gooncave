//! FurAffinity sits behind a Cloudflare browser check that rejects any client but a
//! real browser engine. A desktop shell registers its engine here; the core then sends
//! FurAffinity page requests through it instead of `reqwest`.
use std::{future::Future, pin::Pin, sync::OnceLock};

/// A page the browser engine fetched.
pub struct Page {
    pub status: u16,
    pub body: String,
}

pub type Pending<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

pub trait Browser: Send + Sync {
    /// GETs `url` with the engine's cookies, after storing `cookie` (`a=…; b=…`) in them
    /// when given. Shows the check to the person when Cloudflare asks for one.
    fn fetch(&self, url: String, cookie: Option<String>) -> Pending<Page>;
    /// Lets the person sign in to FurAffinity at `base` in a window. Returns the
    /// session cookie and the signed-in username, or `None` when the window was closed.
    fn sign_in(&self, base: String) -> Pending<Option<(String, Option<String>)>>;
}

static BROWSER: OnceLock<Box<dyn Browser>> = OnceLock::new();

/// Registers the engine once at startup; later calls are ignored.
pub fn register(browser: Box<dyn Browser>) {
    let _ = BROWSER.set(browser);
}

pub(crate) fn get() -> Option<&'static dyn Browser> {
    BROWSER.get().map(|browser| browser.as_ref())
}

/// The FurAffinity page hosts the engine serves; media hosts stay on `reqwest`.
pub(crate) fn serves(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("www.furaffinity.net" | "furaffinity.net")
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_furaffinity_pages_go_through_the_browser() {
        let serves = |raw: &str| super::serves(&reqwest::Url::parse(raw).unwrap());
        assert!(serves("https://www.furaffinity.net/view/1/"));
        assert!(serves("https://furaffinity.net/"));
        assert!(!serves("https://d.furaffinity.net/art/x.png"));
        assert!(!serves("http://www.furaffinity.net/"));
        assert!(!serves("https://www.furaffinity.net.evil.test/"));
    }
}
