use crate::{Error, Result};
use reqwest::{
    header::{HeaderMap, LOCATION},
    Client, Url,
};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::Semaphore;

pub(crate) const MAX_API_BYTES: usize = 8 * 1024 * 1024;
const NETWORK_CONCURRENCY: usize = 4;
const TIMEOUT: Duration = Duration::from_secs(25);
const RETRY_DELAYS: &[u64] = &[2, 5];
static SLOTS: OnceLock<Semaphore> = OnceLock::new();
static FA_REQUEST: OnceLock<tokio::sync::Mutex<tokio::time::Instant>> = OnceLock::new();

async fn pace(target: &Url) {
    if target
        .host_str()
        .is_some_and(|host| host == "furaffinity.net" || host.ends_with(".furaffinity.net"))
    {
        let mut next = FA_REQUEST
            .get_or_init(|| tokio::sync::Mutex::new(tokio::time::Instant::now()))
            .lock()
            .await;
        tokio::time::sleep_until(*next).await;
        *next = tokio::time::Instant::now() + Duration::from_secs(1);
    }
}

pub(crate) fn remote(message: impl Into<String>) -> Error {
    Error::Remote(message.into())
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
        let client = self.client(&target).await?;
        pace(&target).await;
        let has_content_type = headers.contains_key(reqwest::header::CONTENT_TYPE);
        let mut request = client.request(method, target).headers(headers);
        if let Some(body) = body {
            if !has_content_type {
                request = request.header(
                    reqwest::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded",
                );
            }
            request = request.body(body);
        }
        // A lost response may follow a successful write; never repeat a mutation automatically.
        request.send().await.map_err(|_| remote("The site's answer was interrupted. Check the post on the original site before retrying."))
    }
    pub(crate) async fn client(&self, url: &Url) -> Result<Client> {
        let host = url
            .host_str()
            .ok_or_else(|| remote("The site address has no host."))?;
        let addrs: Vec<SocketAddr> = tokio::time::timeout(
            TIMEOUT,
            tokio::net::lookup_host((
                host.trim_matches(['[', ']']),
                url.port_or_known_default().unwrap_or(443),
            )),
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
        Client::builder()
            .user_agent("GoonCave (https://github.com/LiukScot/gooncave)")
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(host, &addrs)
            .build()
            .map_err(|_| remote("The secure connection could not be initialized."))
    }
    pub async fn get(&self, mut target: Url, headers: HeaderMap) -> Result<reqwest::Response> {
        let original = target.clone();
        for redirect in 0..=4 {
            let client = self.client(&target).await?;
            for attempt in 0..=RETRY_DELAYS.len() {
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
                if response.status().as_u16() == 429 && attempt < RETRY_DELAYS.len() {
                    let wait = response
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok())
                        .and_then(|h| h.parse::<u64>().ok())
                        .unwrap_or(RETRY_DELAYS[attempt])
                        .min(10);
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
                if !response.status().is_success() {
                    return Err(remote(match response.status().as_u16(){
      401|403=>"The site refused access. Check your API key or session in Accounts; it may also require a browser verification.",
      404=>"The post or API address was not found. Check the site address in Accounts.",
      422=>"The site refused this search. Reduce the number of tags or change the search terms.",
      429=>"The site is limiting requests. Wait a moment and try again.",
      _=>"The site could not complete the request. Try again later.",
     }));
                }
                return Ok(response);
            }
        }
        Err(remote("The site could not complete the request."))
    }
    pub async fn bytes(&self, target: Url, headers: HeaderMap, max: usize) -> Result<Vec<u8>> {
        let _slot = SLOTS
            .get_or_init(|| Semaphore::new(NETWORK_CONCURRENCY))
            .acquire()
            .await
            .map_err(|_| remote("The request was cancelled."))?;
        let mut response = self.get(target, headers).await?;
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
}
