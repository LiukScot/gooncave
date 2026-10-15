//! A small WebDAV client: whole-file reads and writes guarded by ETags, folder creation, listing
//! and deletion, enough for a sync folder.

use crate::{Error, Result};
use reqwest::{header, Method, StatusCode, Url};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(120);
/// A file larger than this is refused instead of filling memory.
const MAX_DOWNLOAD_BYTES: u64 = 512 << 20;

/// When a write may replace what is in the folder.
pub(crate) enum Condition<'a> {
    /// Only while no file exists at the path.
    Absent,
    /// Only while the file still has this ETag.
    Matches(&'a str),
    /// Always.
    Any,
}

pub(crate) struct Folder {
    base: Url,
    username: String,
    password: String,
    client: reqwest::Client,
}

/// Turns a failed request into a message that names the cause, so the user knows what to fix.
fn unreachable_folder(error: reqwest::Error, url: &Url) -> Error {
    eprintln!("WebDAV request failed: {error:?}");
    let host = url.host_str().unwrap_or("the server");
    let mut causes = String::new();
    let mut source: Option<&dyn std::error::Error> = Some(&error);
    while let Some(cause) = source {
        causes.push_str(&cause.to_string().to_lowercase());
        causes.push('\n');
        source = cause.source();
    }
    let message = if causes.contains("dns error") || causes.contains("failed to lookup address") {
        format!("GoonCave cannot find the server {host}. Check the address. If it is a Tailscale or home network name, check that this device is connected to that network.")
    } else if causes.contains("certificate") {
        format!("The certificate of {host} is not valid for this address, so the connection is not secure. Use the address the server's certificate was issued for.")
    } else if error.is_timeout() {
        format!("{host} did not answer in time. Check that the server is on and reachable from this device.")
    } else if causes.contains("connection refused") {
        format!("{host} refused the connection. Check that the server is on and that the address and port are right.")
    } else if error.is_redirect() {
        format!("{host} redirected the request too many times. Check the folder address.")
    } else {
        "GoonCave cannot reach the WebDAV folder. Check the address and the network, then try again.".to_owned()
    };
    Error::Remote(message)
}

fn refused(status: StatusCode, url: &Url) -> Error {
    eprintln!("WebDAV answered {status} for {url}");
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Error::Remote(
            "The WebDAV folder refused the user name or password. Check them and connect again."
                .into(),
        ),
        StatusCode::NOT_FOUND | StatusCode::CONFLICT => Error::Remote(
            "The WebDAV folder was not found. Check its address and connect again.".into(),
        ),
        StatusCode::INSUFFICIENT_STORAGE => {
            Error::Remote("The WebDAV folder is full. Free some space, then sync again.".into())
        }
        _ => Error::Remote("The WebDAV folder answered with an error. Try again later.".into()),
    }
}

impl Folder {
    /// `address` is the folder's `http` or `https` URL; GoonCave keeps its files below it.
    pub(crate) fn new(address: &str, username: &str, password: &str) -> Result<Self> {
        let invalid =
            || Error::Invalid("Enter the folder's full address, starting with https://.".into());
        let mut base = Url::parse(address.trim()).map_err(|_| invalid())?;
        match (base.scheme(), base.host_str()) {
            ("https", Some(_)) => {}
            ("http", Some(host)) if on_this_network(host) => {}
            ("http", Some(_)) => {
                return Err(Error::Invalid(
                    "Use an address starting with https://. Plain http:// would send your password unencrypted over the internet; it works only for folders on this computer or your home network."
                        .into(),
                ))
            }
            _ => return Err(invalid()),
        }
        if !base.username().is_empty() || base.password().is_some() {
            return Err(Error::Invalid(
                "Put the user name and password in their own fields, not in the folder address."
                    .into(),
            ));
        }
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .map_err(|error| Error::Storage(error.to_string()))?;
        Ok(Self {
            base,
            username: username.to_owned(),
            password: password.to_owned(),
            client,
        })
    }

    fn url(&self, path: &str) -> Result<Url> {
        self.base
            .join(path)
            .map_err(|error| Error::Storage(format!("invalid WebDAV path {path}: {error}")))
    }

    fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        let request = self.client.request(method, url);
        if self.username.is_empty() && self.password.is_empty() {
            request
        } else {
            request.basic_auth(&self.username, Some(&self.password))
        }
    }

    /// The file's bytes and ETag, or `None` when the folder has no such file.
    pub(crate) async fn get(&self, path: &str) -> Result<Option<(Vec<u8>, Option<String>)>> {
        let url = self.url(path)?;
        let mut response = self
            .request(Method::GET, url.clone())
            .send()
            .await
            .map_err(|error| unreachable_folder(error, &url))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(refused(response.status(), &url));
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let too_large = || {
            Error::Remote(format!(
                "A file in the WebDAV folder is larger than {} MB, too large for GoonCave to read.",
                MAX_DOWNLOAD_BYTES >> 20
            ))
        };
        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
        {
            return Err(too_large());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| unreachable_folder(error, &url))?
        {
            body.extend_from_slice(&chunk);
            if body.len() as u64 > MAX_DOWNLOAD_BYTES {
                return Err(too_large());
            }
        }
        Ok(Some((body, etag)))
    }

    /// Writes the file. Returns `false` when `condition` no longer holds.
    pub(crate) async fn put(
        &self,
        path: &str,
        body: Vec<u8>,
        condition: Condition<'_>,
    ) -> Result<bool> {
        let url = self.url(path)?;
        let request = match condition {
            Condition::Absent => self
                .request(Method::PUT, url.clone())
                .header(header::IF_NONE_MATCH, "*"),
            Condition::Matches(etag) => self
                .request(Method::PUT, url.clone())
                .header(header::IF_MATCH, etag),
            Condition::Any => self.request(Method::PUT, url.clone()),
        };
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|error| unreachable_folder(error, &url))?;
        match response.status() {
            status if status.is_success() => Ok(true),
            StatusCode::PRECONDITION_FAILED => Ok(false),
            status => Err(refused(status, &url)),
        }
    }

    /// Creates the folder at `path` (ending in `/`) unless it exists.
    pub(crate) async fn create_folder(&self, path: &str) -> Result<()> {
        let url = self.url(path)?;
        let response = self
            .request(
                Method::from_bytes(b"MKCOL").expect("valid method"),
                url.clone(),
            )
            .send()
            .await
            .map_err(|error| unreachable_folder(error, &url))?;
        match response.status() {
            status if status.is_success() => Ok(()),
            // An existing folder answers 405; some servers say so with 409 or 301.
            StatusCode::METHOD_NOT_ALLOWED
            | StatusCode::MOVED_PERMANENTLY
            | StatusCode::CONFLICT
                if self.exists(path).await? =>
            {
                Ok(())
            }
            status => Err(refused(status, &url)),
        }
    }

    async fn propfind(&self, path: &str) -> Result<Option<String>> {
        let url = self.url(path)?;
        let response = self
            .request(Method::from_bytes(b"PROPFIND").expect("valid method"), url.clone())
            .header("Depth", "1")
            .header(header::CONTENT_TYPE, "application/xml")
            .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
            .send()
            .await
            .map_err(|error| unreachable_folder(error, &url))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(refused(response.status(), &url));
        }
        Ok(Some(
            response
                .text()
                .await
                .map_err(|error| unreachable_folder(error, &url))?,
        ))
    }

    async fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.propfind(path).await?.is_some())
    }

    /// Names of the entries directly inside the folder at `path` (ending in `/`).
    pub(crate) async fn list(&self, path: &str) -> Result<Vec<String>> {
        let Some(xml) = self.propfind(path).await? else {
            return Ok(Vec::new());
        };
        let folder = self.url(path)?;
        let mut names = Vec::new();
        for href in hrefs(&xml)? {
            let Ok(entry) = folder.join(&href) else {
                continue;
            };
            let Some(name) = entry
                .path()
                .strip_prefix(folder.path())
                .map(|rest| rest.trim_end_matches('/'))
                .filter(|rest| !rest.is_empty() && !rest.contains('/'))
            else {
                continue;
            };
            names.push(name.to_owned());
        }
        Ok(names)
    }

    pub(crate) async fn delete(&self, path: &str) -> Result<()> {
        let url = self.url(path)?;
        let response = self
            .request(Method::DELETE, url.clone())
            .send()
            .await
            .map_err(|error| unreachable_folder(error, &url))?;
        match response.status() {
            status if status.is_success() || status == StatusCode::NOT_FOUND => Ok(()),
            status => Err(refused(status, &url)),
        }
    }
}

/// Loopback and private-range hosts, where plain `http` does not cross the internet.
fn on_this_network(host: &str) -> bool {
    use std::net::IpAddr;
    match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// The `href` values of a PROPFIND answer, whatever prefix the server gives the `DAV:` namespace.
fn hrefs(xml: &str) -> Result<Vec<String>> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let (mut inside, mut found) = (false, Vec::new());
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) if tag.local_name().as_ref() == "href" => inside = true,
            Ok(Event::End(tag)) if tag.local_name().as_ref() == "href" => inside = false,
            Ok(Event::Text(text)) if inside => found.push(text.xml10_content().trim().to_owned()),
            Ok(Event::Eof) => return Ok(found),
            Err(error) => {
                eprintln!("Invalid WebDAV listing: {error}");
                return Err(Error::Remote(
                    "The WebDAV folder sent a listing GoonCave cannot read.".into(),
                ));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listings_with_any_namespace_prefix_give_their_hrefs() {
        let xml = r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
            <D:response><D:href>/dav/GoonCave/backups/</D:href></D:response>
            <D:response><D:href>/dav/GoonCave/backups/2026-10-01.json.gz</D:href></D:response>
            </D:multistatus>"#;
        assert_eq!(
            hrefs(xml).unwrap(),
            [
                "/dav/GoonCave/backups/",
                "/dav/GoonCave/backups/2026-10-01.json.gz"
            ]
        );
    }

    async fn failure(address: &str) -> String {
        Folder::new(address, "", "")
            .unwrap()
            .get("x")
            .await
            .err()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn unreachable_folders_name_the_cause() {
        let unknown = failure("https://nowhere.invalid/dav").await;
        assert!(
            unknown.contains("cannot find the server nowhere.invalid"),
            "{unknown}"
        );
        let refused = failure("http://127.0.0.1:1/dav").await;
        assert!(
            refused.contains("127.0.0.1 refused the connection"),
            "{refused}"
        );
    }

    #[test]
    fn addresses_must_be_web_urls() {
        assert!(Folder::new("ftp://example.org/x", "", "").is_err());
        assert!(Folder::new("not a url", "", "").is_err());
        assert!(Folder::new("http://example.org/dav", "", "").is_err());
        assert!(Folder::new("http://8.8.8.8/dav", "", "").is_err());
        assert!(Folder::new("https://me:secret@example.org/dav", "", "").is_err());
        for local in [
            "http://localhost:8080/dav",
            "http://127.0.0.1/dav",
            "http://192.168.1.6/dav",
            "http://[::1]/dav",
        ] {
            assert!(Folder::new(local, "", "").is_ok(), "{local}");
        }
        let folder = Folder::new("https://example.org/dav", "", "").unwrap();
        assert_eq!(
            folder.url("GoonCave/library.json.gz").unwrap().as_str(),
            "https://example.org/dav/GoonCave/library.json.gz"
        );
    }
}
