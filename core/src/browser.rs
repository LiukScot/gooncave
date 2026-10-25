//! FurAffinity's and Rule34's pages sit behind a Cloudflare browser check that rejects
//! any client but a real browser engine. A shell registers its engine here; the core
//! then sends those page requests through it instead of `reqwest`.
use std::{future::Future, pin::Pin, sync::OnceLock};

/// A page the browser engine fetched.
pub struct Page {
    pub status: u16,
    pub body: String,
}

/// A file the browser engine fetched.
pub struct FilePage {
    pub status: u16,
    pub body: Vec<u8>,
}

pub type Pending<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

pub trait Browser: Send + Sync {
    /// GETs `url` with the engine's cookies, after storing `cookie` (`a=…; b=…`) in them
    /// when given. Shows the check to the person when Cloudflare asks for one.
    fn fetch(&self, url: String, cookie: Option<String>) -> Pending<Page>;
    /// GETs the picture or video at `url` on one of a site's media hosts, which refuse any
    /// client but a browser. `None` when this engine cannot, and the caller asks the host itself.
    fn fetch_file(&self, _url: String) -> Pending<Option<FilePage>> {
        Box::pin(async { Ok(None) })
    }
    /// Lets the person sign in to the [`Site`] at `base` in a window. Returns the
    /// session cookie and the signed-in account, or `None` when the window was closed.
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

/// A site whose pages only a browser engine can load.
pub struct Site {
    pub name: &'static str,
    hosts: &'static [&'static str],
    /// Path and query of the sign-in page.
    pub login: &'static str,
    /// The cookies that together make up a signed-in session.
    pub session: [&'static str; 2],
    /// Suffixes of the hosts that serve its pictures and videos behind the same check.
    media: &'static [&'static str],
    /// The session cookie holding the account id, where the site has one; elsewhere
    /// [`USERNAME`] reads the account from the page.
    pub account: Option<&'static str>,
}

const SITES: &[Site] = &[
    Site {
        name: "FurAffinity",
        hosts: &["www.furaffinity.net", "furaffinity.net"],
        login: "/login",
        session: ["a", "b"],
        media: &[".furaffinity.net"],
        account: None,
    },
    Site {
        name: "Rule34",
        hosts: &["rule34.xxx", "www.rule34.xxx"],
        login: "/index.php?page=account&s=login&code=00",
        session: ["user_id", "pass_hash"],
        media: &[],
        account: Some("user_id"),
    },
];

/// The site whose pages at the https `url` go through the engine.
pub fn site(url: &str) -> Option<&'static Site> {
    let rest = url.strip_prefix("https://")?;
    let host = &rest[..rest.find(['/', '?', ':']).unwrap_or(rest.len())];
    SITES.iter().find(|site| site.hosts.contains(&host))
}

impl Site {
    pub fn check_title(&self) -> String {
        format!("{} check", self.name)
    }
    pub fn check_message(&self) -> String {
        format!("{} is checking that a person is using GoonCave. Complete the check below; this window closes by itself.", self.name)
    }
    pub fn check_closed(&self) -> String {
        format!("{}'s browser check was closed before it finished. Try again and complete the check in the window that opens.", self.name)
    }
    pub fn sign_in_title(&self) -> String {
        format!("Sign in to {}", self.name)
    }
    pub fn sign_in_message(&self) -> String {
        format!("Sign in with your {} account. GoonCave keeps the session on this device only. This window closes by itself once you are signed in.", self.name)
    }
}

pub const UNREACHABLE: &str = "The site could not be reached. Check your connection and try again.";
pub const STOPPED: &str = "GoonCave's browser stopped. Open GoonCave again.";

// Bodies of async JavaScript functions an engine runs inside a page of a [`Site`]. FETCH
// gets `url` as an argument; the request carries the engine's cookies and passes
// Cloudflare like any page load.
pub const FETCH: &str = "const response = await fetch(url, {credentials: 'include'});
return {status: response.status, challenged: response.headers.get('cf-mitigated') === 'challenge', body: await response.text()};";
/// Like FETCH for a file: the body comes back as base64, since a script returns only text.
pub const FETCH_FILE: &str = "const response = await fetch(url, {credentials: 'include'});
const blob = await response.blob();
const body = await new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
return {status: response.status, challenged: response.headers.get('cf-mitigated') === 'challenge', body};";
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

/// The site whose media host serves the https `url`: files that Cloudflare shows the same
/// check as the pages. Its origin is where the check is passed.
pub(crate) fn media_site(url: &reqwest::Url) -> Option<&'static Site> {
    if url.scheme() != "https" || serves(url) {
        return None;
    }
    let host = url.host_str()?;
    SITES
        .iter()
        .find(|site| site.media.iter().any(|suffix| host.ends_with(suffix)))
}

/// The site that serves the media file at `url`, and the origin of the host to fetch it from:
/// the check clears a request only from a page of the host it protects.
pub fn media_origin(url: &str) -> Option<(&'static Site, String)> {
    let url = reqwest::Url::parse(url).ok()?;
    let site = media_site(&url)?;
    Some((site, format!("https://{}", url.host_str()?)))
}

/// The page hosts the engine serves; API and media hosts stay on `reqwest`.
pub(crate) fn serves(url: &reqwest::Url) -> bool {
    site(url.as_str()).is_some()
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_checked_site_media_hosts_are_fetched_as_files() {
        let media = |raw: &str| super::media_site(&reqwest::Url::parse(raw).unwrap()).is_some();
        assert!(media("https://d.furaffinity.net/art/x/1.png"));
        assert!(media("https://t.furaffinity.net/1@400-1.jpg"));
        assert!(!media("https://www.furaffinity.net/view/1/"));
        assert!(!media("http://d.furaffinity.net/art/x/1.png"));
        assert!(!media("https://d.furaffinity.net.evil.test/1.png"));
        assert!(!media("https://static1.e621.net/data/a.png"));
    }

    #[test]
    fn only_checked_site_pages_go_through_the_browser() {
        let serves = |raw: &str| super::serves(&reqwest::Url::parse(raw).unwrap());
        assert!(serves("https://www.furaffinity.net/view/1/"));
        assert!(serves("https://furaffinity.net/"));
        assert!(!serves("https://d.furaffinity.net/art/x.png"));
        assert!(!serves("http://www.furaffinity.net/"));
        assert!(!serves("https://www.furaffinity.net.evil.test/"));
        assert!(serves(
            "https://rule34.xxx/index.php?page=favorites&s=view&id=1"
        ));
        assert!(!serves("https://api.rule34.xxx/index.php?page=dapi"));
        assert!(!serves("https://wimg.rule34.xxx/images/1.jpg"));
        assert!(!serves("https://rule34.xxx@evil.test/"));
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
