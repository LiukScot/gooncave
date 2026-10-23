use crate::{Error, Result};
use reqwest::{
    header::{HeaderMap, LOCATION},
    Client, Url,
};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, SemaphorePermit};

pub(crate) const MAX_API_BYTES: usize = 8 * 1024 * 1024;
const NETWORK_CONCURRENCY: usize = 4;
const TIMEOUT: Duration = Duration::from_secs(25);
/// Seconds between attempts after a CAPTCHA or a 429; its length is the retry
/// count. Cloudflare challenges only some requests, so a later one often passes.
#[cfg(not(test))]
const RETRY_DELAYS: &[u64] = &[2, 5, 12];
#[cfg(test)]
const RETRY_DELAYS: &[u64] = &[0, 0, 0];
static SLOTS: OnceLock<Semaphore> = OnceLock::new();
/// A client per host keeps its connections open; a new one costs a TLS handshake per request.
/// Each pins the addresses checked when it was built, so it expires to follow DNS changes.
static CLIENTS: OnceLock<std::sync::Mutex<HashMap<String, (Instant, Client)>>> = OnceLock::new();
const CLIENT_LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_CLIENTS: usize = 64;
static PAGE_REQUEST: OnceLock<tokio::sync::Mutex<tokio::time::Instant>> = OnceLock::new();

async fn pace(target: &Url) {
    // Only pages behind a browser check are paced; their thumbnail and file hosts are a CDN.
    if crate::browser::serves(target) {
        let mut next = PAGE_REQUEST
            .get_or_init(|| tokio::sync::Mutex::new(tokio::time::Instant::now()))
            .lock()
            .await;
        tokio::time::sleep_until(*next).await;
        *next = tokio::time::Instant::now() + Duration::from_secs(1);
    }
}

pub(crate) const CLOUDFLARE_CHALLENGE: &str = "The site answered with a Cloudflare browser check, which only a web browser can pass, so GoonCave could not check your credentials. Try again later; while the check stays on, use the site in your browser.";

pub(crate) fn remote(message: impl Into<String>) -> Error {
    Error::Remote(message.into())
}
pub(crate) fn captcha() -> Error {
    Error::Refused {
        code: "BOORU_CAPTCHA",
        message: CLOUDFLARE_CHALLENGE.into(),
    }
}
/// A Cloudflare challenge or a 429: both lift by themselves, so the client
/// may send the request again later.
fn paused(response: &reqwest::Response) -> Option<Error> {
    if response
        .headers()
        .get("cf-mitigated")
        .is_some_and(|v| v == "challenge")
    {
        return Some(captcha());
    }
    (response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS).then(|| Error::Refused {
        code: "BOORU_RATE_LIMITED",
        message: "The site is limiting requests. Wait a moment and try again.".into(),
    })
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 192 && b == 0))
}
fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(ip) = ip.to_ipv4_mapped() {
        return public_v4(ip);
    }
    let s = ip.segments();
    // Only global unicast; exclude documentation and transition mechanisms embedding IPv4 targets.
    (s[0] & 0xe000) == 0x2000
        && s[0] != 0x2002
        && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
}
pub(crate) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}
pub(crate) fn url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)
        .map_err(|_| Error::Invalid("Enter a complete HTTP or HTTPS site address.".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid(
            "Use an HTTP or HTTPS address without a password or fragment.".into(),
        ));
    }
    let host = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok_and(|ip| !public_ip(ip))
    {
        return Err(Error::Invalid(
            "Choose a public booru address. Local and private addresses cannot be used.".into(),
        ));
    }
    Ok(url)
}

fn checked(response: reqwest::Response) -> Result<reqwest::Response> {
    if !response.status().is_success() {
        return Err(remote(match response.status().as_u16(){
      401|403=>"The site refused access. Check your API key or session in Accounts; it may also require a browser verification.",
      404=>"The post or API address was not found. Check the site address in Accounts.",
      422=>"The site refused this search. Reduce the number of tags or change the search terms.",
      429=>"The site is limiting requests. Wait a moment and try again.",
      _=>"The site could not complete the request. Try again later.",
     }));
    }
    Ok(response)
}

/// Fetches `target` through the registered browser engine when it serves that host.
async fn browse(target: &Url, headers: &HeaderMap) -> Result<Option<reqwest::Response>> {
    let Some(browser) = crate::browser::get().filter(|_| crate::browser::serves(target)) else {
        return Ok(None);
    };
    let cookie = headers
        .get(reqwest::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    pace(target).await;
    let page = browser
        .fetch(target.to_string(), cookie)
        .await
        .map_err(remote)?;
    let response = axum::http::Response::builder()
        .status(page.status)
        .body(page.body)
        .map_err(|_| remote("The site returned an invalid status."))?;
    Ok(Some(response.into()))
}

#[derive(Clone, Default)]
pub(crate) struct Transport {
    #[cfg(test)]
    pub allow_loopback: bool,
}
impl Transport {
    pub fn media_url(&self, raw: &str) -> Result<Url> {
        #[cfg(test)]
        if self.allow_loopback {
            if let Ok(url) = Url::parse(raw) {
                if url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.username().is_empty()
                    && url.password().is_none()
                {
                    return Ok(url);
                }
            }
        }
        url(raw)
    }
    pub async fn write(
        &self,
        target: Url,
        headers: HeaderMap,
        method: reqwest::Method,
        body: Option<String>,
    ) -> Result<reqwest::Response> {
        if method == reqwest::Method::GET && body.is_none() {
            if let Some(response) = browse(&target, &headers).await? {
                return Ok(response);
            }
        }
        let client = self.client(&target).await?;
        let has_content_type = headers.contains_key(reqwest::header::CONTENT_TYPE);
        for attempt in 0.. {
            pace(&target).await;
            let mut request = client
                .request(method.clone(), target.clone())
                .headers(headers.clone());
            if let Some(body) = &body {
                if !has_content_type {
                    request = request.header(
                        reqwest::header::CONTENT_TYPE,
                        "application/x-www-form-urlencoded",
                    );
                }
                request = request.body(body.clone());
            }
            // A lost response may follow a successful write; never repeat a mutation automatically.
            let response = request.send().await.map_err(|_| remote("The site's answer was interrupted. Check the post on the original site before retrying."))?;
            // A CAPTCHA or a 429 means the site did not run the write, so sending it again is safe.
            match paused(&response) {
                Some(_) if attempt < RETRY_DELAYS.len() => {
                    tokio::time::sleep(Duration::from_secs(RETRY_DELAYS[attempt])).await;
                }
                Some(error) => return Err(error),
                None => return Ok(response),
            }
        }
        unreachable!("the loop returns once the retries are spent")
    }
    pub(crate) async fn client(&self, url: &Url) -> Result<Client> {
        let host = url
            .host_str()
            .ok_or_else(|| remote("The site address has no host."))?;
        let port = url.port_or_known_default().unwrap_or(443);
        #[cfg(test)]
        let key = format!("{host}:{port}:{}", self.allow_loopback);
        #[cfg(not(test))]
        let key = format!("{host}:{port}");
        let clients = CLIENTS.get_or_init(Default::default);
        if let Some((built, client)) = clients.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
            if built.elapsed() < CLIENT_LIFETIME {
                return Ok(client.clone());
            }
        }
        let addrs: Vec<SocketAddr> = tokio::time::timeout(
            TIMEOUT,
            tokio::net::lookup_host((host.trim_matches(['[', ']']), port)),
        )
        .await
        .map_err(|_| {
            remote("The site's address lookup timed out. Check your connection and try again.")
        })?
        .map_err(|_| remote("The site could not be reached. Check your connection and try again."))?
        .collect();
        let allowed = |ip: IpAddr| {
            #[cfg(test)]
            if self.allow_loopback && ip.is_loopback() {
                return true;
            }
            public_ip(ip)
        };
        if addrs.is_empty() || addrs.iter().any(|a| !allowed(a.ip())) {
            return Err(remote(
                "The site points to a local or private address. Choose a public booru.",
            ));
        }
        let client = Client::builder()
            .user_agent("GoonCave (https://github.com/LiukScot/gooncave)")
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(host, &addrs)
            .build()
            .map_err(|_| remote("The secure connection could not be initialized."))?;
        let mut clients = clients.lock().unwrap_or_else(|p| p.into_inner());
        clients.retain(|_, (built, _)| built.elapsed() < CLIENT_LIFETIME);
        if clients.len() >= MAX_CLIENTS {
            clients.clear();
        }
        clients.insert(key, (Instant::now(), client.clone()));
        Ok(client)
    }
    pub async fn get(&self, target: Url, headers: HeaderMap) -> Result<reqwest::Response> {
        Ok(self.fetch(target, headers, false).await?.0)
    }
    /// [`Self::get`]; with `limited`, each attempt also takes one of the shared network slots,
    /// returned with the response so it stays taken while the body downloads. A wait between
    /// attempts gives the slot back, or a site asking for a pause would stall every other one.
    async fn fetch(
        &self,
        mut target: Url,
        headers: HeaderMap,
        limited: bool,
    ) -> Result<(reqwest::Response, Option<SemaphorePermit<'static>>)> {
        if let Some(response) = browse(&target, &headers).await? {
            return Ok((checked(response)?, None));
        }
        let original = target.clone();
        for redirect in 0..=4 {
            let client = self.client(&target).await?;
            for attempt in 0..=RETRY_DELAYS.len() {
                let slot = if limited {
                    Some(
                        SLOTS
                            .get_or_init(|| Semaphore::new(NETWORK_CONCURRENCY))
                            .acquire()
                            .await
                            .map_err(|_| remote("The request was cancelled."))?,
                    )
                } else {
                    None
                };
                pace(&target).await;
                let response = client
                    .get(target.clone())
                    .headers(headers.clone())
                    .send()
                    .await
                    .map_err(|_| {
                        remote(
                            "The site could not be reached. Check your connection and try again.",
                        )
                    })?;
                // Cloudflare in front of FurAffinity's image hosts refuses a burst of
                // thumbnails with 403 for a short while.
                let refused_burst = response.status().as_u16() == 403
                    && target
                        .host_str()
                        .is_some_and(|host| host.ends_with(".furaffinity.net"))
                    && !crate::browser::serves(&target);
                if attempt < RETRY_DELAYS.len() && (paused(&response).is_some() || refused_burst) {
                    let wait = response
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok())
                        .and_then(|h| h.parse::<u64>().ok())
                        .map_or(RETRY_DELAYS[attempt], |seconds| seconds.min(10));
                    drop(slot);
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    continue;
                }
                if response.status().is_redirection() {
                    if redirect == 4 {
                        return Err(remote(
                            "The site redirected too many times. Check its address.",
                        ));
                    }
                    let location = response
                        .headers()
                        .get(LOCATION)
                        .and_then(|h| h.to_str().ok())
                        .ok_or_else(|| remote("The site returned an incomplete redirect."))?;
                    let next = target
                        .join(location)
                        .map_err(|_| remote("The site returned an invalid redirect."))?;
                    if next.origin() != original.origin()
                        || !next.username().is_empty()
                        || next.password().is_some()
                    {
                        return Err(remote("The site redirected to another address. Update its address in Accounts and try again."));
                    }
                    target = next;
                    break;
                }
                if let Some(error) = paused(&response) {
                    return Err(error);
                }
                return Ok((checked(response)?, slot));
            }
        }
        Err(remote("The site could not complete the request."))
    }
    pub async fn bytes(&self, target: Url, headers: HeaderMap, max: usize) -> Result<Vec<u8>> {
        let (mut response, _slot) = self.fetch(target, headers, true).await?;
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err(remote("The site's response exceeds the supported size."));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| remote("The download was interrupted. Try again."))?
        {
            if bytes.len() + chunk.len() > max {
                return Err(remote("The site's response exceeds the supported size."));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn json(&self, target: Url, headers: HeaderMap) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.bytes(target, headers, MAX_API_BYTES).await?).map_err(|_| {
            remote("The site returned an unexpected response. Check its engine in Accounts.")
        })
    }
    pub async fn text(&self, target: Url, headers: HeaderMap) -> Result<String> {
        String::from_utf8(self.bytes(target, headers, MAX_API_BYTES).await?)
            .map_err(|_| remote("The site returned an unreadable page."))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn spaces_furaffinity_pages_but_not_its_media_hosts() {
        let media = Url::parse("https://t.furaffinity.net/1@400-1.jpg").unwrap();
        let started = tokio::time::Instant::now();
        for _ in 0..3 {
            pace(&media).await;
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        let page = Url::parse("https://www.furaffinity.net/view/1/").unwrap();
        let started = tokio::time::Instant::now();
        pace(&page).await;
        pace(&page).await;
        assert!(started.elapsed() >= Duration::from_millis(900));
    }
    #[test]
    fn blocks_private_reserved_and_embedded_targets() {
        for addr in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "2002:7f00:1::",
            "2001:db8::1",
            "64:ff9b::7f00:1",
        ] {
            assert!(!public_ip(addr.parse().unwrap()), "{addr}");
        }
        for addr in ["1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(addr.parse().unwrap()));
        }
    }
    #[tokio::test]
    async fn requests_to_one_site_share_a_connection() {
        use axum::{extract::ConnectInfo, routing::get, Router};
        let peers = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = peers.clone();
        let app = Router::new().route(
            "/",
            get(
                move |ConnectInfo(peer): ConnectInfo<SocketAddr>| async move {
                    seen.lock().unwrap().push(peer);
                    "ok"
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap()
        });
        let t = Transport {
            allow_loopback: true,
        };
        for _ in 0..2 {
            t.text(url.clone(), HeaderMap::new()).await.unwrap();
        }
        let peers = peers.lock().unwrap();
        assert_eq!(peers.len(), 2);
        assert_eq!(peers[0], peers[1]);
        task.abort();
    }
    #[tokio::test]
    async fn names_a_cloudflare_challenge_instead_of_blaming_credentials() {
        use axum::{http::StatusCode, response::IntoResponse, routing::get, Router};
        let flaky = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/challenge",
                get(|| async {
                    (
                        StatusCode::FORBIDDEN,
                        [("cf-mitigated", "challenge")],
                        "<title>Just a moment...</title>",
                    )
                }),
            )
            .route("/denied", get(|| async { StatusCode::FORBIDDEN }))
            .route("/busy", get(|| async { StatusCode::TOO_MANY_REQUESTS }))
            .route(
                "/flaky",
                get(move || {
                    let hits = flaky.clone();
                    async move {
                        // Only the first request of each pair is challenged.
                        if hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst) % 2 == 0 {
                            (StatusCode::FORBIDDEN, [("cf-mitigated", "challenge")]).into_response()
                        } else {
                            StatusCode::OK.into_response()
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let t = Transport {
            allow_loopback: true,
        };
        let message = |r: Result<reqwest::Response>| match r {
            Err(Error::Remote(m)) => m,
            _ => panic!("expected a remote error"),
        };
        let at = |path: &str| Url::parse(&format!("{base}{path}")).unwrap();
        let code = |r: Result<reqwest::Response>| match r {
            Err(Error::Refused { code, message }) => (code, message),
            _ => panic!("expected a refusal the client can retry"),
        };
        // A favorite is a write: it must carry the code too, or the client
        // shows the error at once instead of retrying.
        for (path, expected) in [
            ("/challenge", "BOORU_CAPTCHA"),
            ("/busy", "BOORU_RATE_LIMITED"),
        ] {
            assert_eq!(code(t.get(at(path), HeaderMap::new()).await).0, expected);
            assert_eq!(
                code(
                    t.write(at(path), HeaderMap::new(), reqwest::Method::GET, None)
                        .await
                )
                .0,
                expected
            );
        }
        // Cloudflare challenges only some requests: a later attempt goes through.
        assert!(t.get(at("/flaky"), HeaderMap::new()).await.is_ok());
        assert!(t
            .write(at("/flaky"), HeaderMap::new(), reqwest::Method::GET, None)
            .await
            .is_ok());
        let (_, challenged) = code(t.get(at("/challenge"), HeaderMap::new()).await);
        assert!(challenged.contains("Cloudflare"), "{challenged}");
        assert!(!challenged.contains("API key"), "{challenged}");
        let denied = message(
            t.get(
                Url::parse(&format!("{base}/denied")).unwrap(),
                HeaderMap::new(),
            )
            .await,
        );
        assert!(denied.contains("API key"), "{denied}");
        task.abort();
    }
}
