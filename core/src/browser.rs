//! FurAffinity sits behind a Cloudflare browser check that rejects any client but a
//! real browser engine. A shell registers its engine here; the core then sends
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

pub const CHECK_MESSAGE: &str = "FurAffinity is checking that a person is using GoonCave. Complete the check below; this window closes by itself.";
pub const SIGN_IN_MESSAGE: &str = "Sign in with your FurAffinity account. GoonCave keeps the session on this device only. This window closes by itself once you are signed in.";
pub const CHECK_CLOSED: &str = "FurAffinity's browser check was closed before it finished. Try again and complete the check in the window that opens.";
pub const UNREACHABLE: &str =
    "FurAffinity could not be reached. Check your connection and try again.";
pub const STOPPED: &str = "GoonCave's browser stopped. Open GoonCave again.";

// Bodies of async JavaScript functions an engine runs inside a FurAffinity page. FETCH
// gets `url` as an argument; the request carries the engine's cookies and passes
// Cloudflare like any page load.
pub const FETCH: &str = "const response = await fetch(url, {credentials: 'include'});
return {status: response.status, challenged: response.headers.get('cf-mitigated') === 'challenge', body: await response.text()};";
pub const CHALLENGED: &str = "return document.title.startsWith('Just a moment') || document.querySelector('#challenge-form, #challenge-error-text, #cf-challenge-running') !== null;";
pub const USERNAME: &str = "const avatar = document.querySelector('img.loggedin_user_avatar');
const link = document.querySelector('#my-username') || avatar?.closest('a[href^=\\'/user/\\']');
const name = link?.getAttribute('href')?.match(/^\\/user\\/([^/]+)/)?.[1] || avatar?.alt || link?.textContent || '';
return name.trim().replace(/^~/, '');";

/// `scheme://host` of an https `url`, the page an engine must show to fetch it.
pub fn origin(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    Some(&url[..8 + rest.find('/').unwrap_or(rest.len())])
}

/// The cookie domain, like `.furaffinity.net`, that covers every host of the site at `base`.
pub fn cookie_domain(base: &str) -> String {
    let host = base
        .strip_prefix("https://")
        .map(|host| host.trim_start_matches("www.").trim_end_matches('/'))
        .unwrap_or_default();
    format!(".{host}")
}

/// The `name=value` pairs of a Cookie header.
pub fn cookie_pairs(header: &str) -> impl Iterator<Item = (&str, &str)> {
    header.split(';').filter_map(|pair| {
        let (name, value) = pair.trim().split_once('=')?;
        (!name.is_empty() && !value.is_empty()).then_some((name, value))
    })
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

    #[test]
    fn origin_keeps_scheme_and_host_only() {
        assert_eq!(
            super::origin("https://www.furaffinity.net/view/1/"),
            Some("https://www.furaffinity.net")
        );
        assert_eq!(
            super::origin("https://www.furaffinity.net"),
            Some("https://www.furaffinity.net")
        );
        assert_eq!(super::origin("http://www.furaffinity.net/"), None);
    }

    #[test]
    fn cookie_domain_covers_the_site_without_www() {
        assert_eq!(
            super::cookie_domain("https://www.furaffinity.net/"),
            ".furaffinity.net"
        );
        assert_eq!(
            super::cookie_domain("https://furaffinity.net"),
            ".furaffinity.net"
        );
    }

    #[test]
    fn cookie_pairs_skip_empty_entries() {
        let pairs: Vec<_> = super::cookie_pairs("a=one; b=two;; =x; c=").collect();
        assert_eq!(pairs, [("a", "one"), ("b", "two")]);
    }
}
