use crate::{
    booru_engines as engines,
    booru_http::{remote, Transport},
    boorus::Site,
    Error, Result,
};
use reqwest::{Method, Url};
use scraper::{Html, Selector};
use serde_json::Value;
use std::collections::BTreeMap;

fn selector(raw: &str) -> Selector {
    Selector::parse(raw).expect("static selector")
}
fn artist(raw: &str) -> Result<&str> {
    let name = raw.trim().trim_start_matches('_');
    if name.is_empty()
        || name.len() > 50
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"~._-".contains(&b))
    {
        return Err(Error::Invalid("Enter a FurAffinity artist username of at most 50 letters, numbers, dots, underscores, dashes or ~.".into()));
    }
    Ok(name)
}
pub(crate) fn require(site: &Site) -> Result<()> {
    if site.engine != "furaffinity" || !site.enabled {
        return Err(Error::Invalid(
            "Enable a FurAffinity account to follow artists.".into(),
        ));
    }
    let username = site
        .username
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("Save your FurAffinity username in Accounts.".into()))?;
    artist(username)?;
    if site.cookie.as_ref().is_none_or(|s| s.is_empty()) {
        return Err(Error::Invalid(
            "Save a fresh FurAffinity session cookie in Accounts to read your watchlist.".into(),
        ));
    }
    Ok(())
}
fn watchlist(html: &str, username: &str) -> Result<Vec<String>> {
    let doc = Html::parse_document(html);
    let title = doc
        .select(&selector("title"))
        .next()
        .map(|e| e.text().collect::<String>())
        .unwrap_or_default();
    if !title
        .trim()
        .starts_with("Buddy list -- Fur Affinity [dot] net")
    {
        return Err(remote("FurAffinity did not return your watchlist. Open the site to complete browser verification, then save a fresh session in Accounts."));
    }
    let mut artists = BTreeMap::new();
    for link in doc.select(&selector("a[href^='/user/']")) {
        let raw = link
            .value()
            .attr("href")
            .unwrap()
            .trim_start_matches("/user/")
            .trim_end_matches('/');
        let name =
            artist(raw).map_err(|_| remote("FurAffinity returned an invalid artist username."))?;
        if !name.eq_ignore_ascii_case(username) {
            artists
                .entry(name.to_lowercase())
                .or_insert(name.to_owned());
        }
        if artists.len() > 10000 {
            return Err(remote(
                "FurAffinity's watchlist exceeds the supported size.",
            ));
        }
    }
    Ok(artists.into_values().collect())
}
pub(crate) async fn artists(t: &Transport, site: &Site) -> Result<Vec<String>> {
    require(site)?;
    let username = site.username.as_deref().unwrap();
    let target = engines::endpoint(site, &format!("/watchlist/by/{}/", artist(username)?))?;
    let html = t.text(target, engines::web_headers(site)?).await?;
    watchlist(&html, username)
}
fn action(site: &Site, name: &str, html: &str) -> Result<(bool, Url)> {
    let doc = Html::parse_document(html);
    if doc.select(&selector("#pageid-userpage")).next().is_none() {
        return Err(remote(
            "FurAffinity did not return the artist page. Save a fresh session in Accounts.",
        ));
    }
    let origin = engines::endpoint(site, "/")?;
    for link in doc.select(&selector("a[href]")) {
        let Some(raw) = link.value().attr("href") else {
            continue;
        };
        let Ok(url) = origin.join(raw) else {
            continue;
        };
        let segments: Vec<_> = url.path().trim_matches('/').split('/').collect();
        if segments.len() != 2 || !["watch", "unwatch"].contains(&segments[0]) {
            continue;
        }
        if url.origin() != origin.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !segments[1].eq_ignore_ascii_case(name)
            || !url.query_pairs().any(|(k, v)| {
                k == "key" && !v.is_empty() && v.bytes().all(|b| b.is_ascii_alphanumeric())
            })
        {
            return Err(remote("FurAffinity returned an unsafe follow action. Open the artist on the original site."));
        }
        return Ok((segments[0] == "unwatch", url));
    }
    Err(remote(
        "FurAffinity did not expose a follow action. Save a fresh session cookie in Accounts.",
    ))
}
pub(crate) async fn set_artist(t: &Transport, site: &Site, raw: &str, desired: bool) -> Result<()> {
    require(site)?;
    let name = artist(raw)?;
    let view = engines::endpoint(site, &format!("/user/{name}/"))?;
    let html = t.text(view.clone(), engines::web_headers(site)?).await?;
    let (current, target) = action(site, name, &html)?;
    if current == desired {
        return Ok(());
    }
    let response = t
        .write(target, engines::web_headers(site)?, Method::GET, None)
        .await?;
    if response.status().as_u16() >= 400 {
        return Err(remote(
            "FurAffinity refused the follow change. Refresh your session in Accounts.",
        ));
    }
    drop(response);
    let html = t.text(view, engines::web_headers(site)?).await?;
    if action(site, name, &html)?.0 != desired {
        return Err(remote("FurAffinity did not confirm the follow change. Check the artist on the original site before retrying."));
    }
    Ok(())
}
pub(crate) fn valid_cursor(raw: &str) -> bool {
    raw.strip_prefix("/msg/submissions/new~")
        .and_then(|s| s.strip_suffix("@48/"))
        .is_some_and(|s| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()))
}
fn listing(html: &str) -> Result<(Vec<Value>, Option<String>)> {
    let mut posts = crate::explore::fa_list(
        html,
        "#messagecenter-submissions, #messagecenter-new-submissions",
    )?;
    // FurAffinity thumbnails carry the upload epoch; retain it so discoveries sort across sites.
    for post in &mut posts {
        if let Some(epoch) = post["previewUrl"]
            .as_str()
            .and_then(|raw| Url::parse(raw).ok())
            .and_then(|url| {
                let name = url.path_segments()?.next_back()?.split('.').next()?;
                let epoch = name.rsplit('-').next()?;
                (epoch.len() == 10)
                    .then(|| epoch.parse::<u64>().ok())
                    .flatten()
            })
            .filter(|n| *n > 0 && *n <= 253402300799)
        {
            post["createdAt"] = serde_json::json!(crate::library::iso_millis(
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(epoch)
            ));
        }
    }
    let doc = Html::parse_document(html);
    let next = doc
        .select(&selector("a.more[href], a.more-half[href]"))
        .filter(|a| !a.value().classes().any(|c| c == "prev"))
        .filter_map(|a| a.value().attr("href"))
        .find(|raw| valid_cursor(raw))
        .map(str::to_owned);
    Ok((posts, next))
}
pub(crate) async fn page(
    t: &Transport,
    site: &Site,
    cursor: Option<&str>,
) -> Result<(Vec<Value>, Option<String>)> {
    require(site)?;
    if cursor.is_some_and(|s| !valid_cursor(s)) {
        return Err(Error::Storage(
            "Invalid saved FurAffinity feed cursor.".into(),
        ));
    }
    let html = t
        .text(
            engines::endpoint(site, cursor.unwrap_or("/msg/submissions/"))?,
            engines::web_headers(site)?,
        )
        .await?;
    let result = listing(&html)?;
    if cursor.is_some() && result.1.as_deref() == cursor {
        return Err(remote(
            "FurAffinity repeated a feed page. Try refreshing later.",
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watchlists_and_feed_pages_reject_login_pages_and_unsafe_cursors() {
        assert!(watchlist("<form>Login</form>", "fixture").is_err());
        let html = "<title>Buddy list -- Fur Affinity [dot] net</title><a href='/user/fixture/'>Me</a><a href='/user/artist-a/'>A</a><a href='/user/ARTIST-A/'>A</a>";
        assert_eq!(watchlist(html, "fixture").unwrap(), vec!["artist-a"]);
        assert!(listing("<div id='pageid-browse'></div>").is_err());
        let html = "<div id='messagecenter-new-submissions'><figure id='sid-7'><img src='https://t.furaffinity.net/7-1735689600.jpg' data-tags='wolf'><a href='/user/artist-a/'>Artist</a></figure><a class='more' href='/msg/submissions/new~7@48/'>Next</a></div>";
        let (posts, next) = listing(html).unwrap();
        assert_eq!(posts[0]["createdAt"], "2025-01-01T00:00:00.000Z");
        assert_eq!(next.as_deref(), Some("/msg/submissions/new~7@48/"));
        for raw in [
            "https://evil.example/msg/submissions/new~7@48/",
            "/msg/submissions/new~7@48/?key=secret",
            "/msg/submissions/new~../@48/",
        ] {
            assert!(!valid_cursor(raw));
        }
    }
    #[tokio::test]
    async fn subscription_artist_changes_are_authenticated_idempotent_and_confirmed() {
        use axum::{extract::Request, response::IntoResponse, routing::any, Router};
        use std::sync::{Arc, Mutex};
        let state = Arc::new(Mutex::new((false, 0)));
        let captured = state.clone();
        let app=Router::new().fallback(any(move |request:Request| {
            let captured=captured.clone();async move {
                assert_eq!(request.headers()["cookie"],"a=fake;b=fake");
                let path=request.uri().path();let mut state=captured.lock().unwrap();
                if path=="/user/fixture-artist/" {
                    return axum::response::Html(format!("<div id='pageid-userpage'><a href='/{}watch/fixture-artist/?key=fake'>Watch</a></div>",if state.0 {"un"}else{""})).into_response();
                }
                if path=="/watch/fixture-artist/" || path=="/unwatch/fixture-artist/" {
                    state.0=path.starts_with("/watch/");state.1+=1;
                    return (axum::http::StatusCode::FOUND,[("location","https://evil.example/should-not-be-followed")]).into_response();
                }
                if path=="/msg/submissions/" {
                    return axum::response::Html("<div id='messagecenter-submissions'><figure id='sid-7'><img src='https://t.furaffinity.net/7-1735689600.jpg'></figure><a class='more' href='/msg/submissions/new~7@48/'>Next</a></div>").into_response();
                }
                if path=="/msg/submissions/new~7@48/" {return axum::response::Html("<div id='messagecenter-submissions'></div>").into_response();}
                axum::response::Html(format!("<title>Buddy list -- Fur Affinity [dot] net</title>{}",if state.0 {"<a href='/user/fixture-artist/'>Artist</a>"}else{""})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let site = Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "furaffinity".into(),
            base,
            username: Some("fixture-owner".into()),
            key: None,
            cookie: Some("a=fake;b=fake".into()),
            enabled: true,
            public: Value::Null,
        };
        let t = Transport {
            allow_loopback: true,
        };
        assert!(artists(&t, &site).await.unwrap().is_empty());
        set_artist(&t, &site, "fixture-artist", true).await.unwrap();
        set_artist(&t, &site, "fixture-artist", true).await.unwrap();
        assert_eq!(artists(&t, &site).await.unwrap(), vec!["fixture-artist"]);
        assert_eq!(state.lock().unwrap().1, 1);
        let (posts, next) = page(&t, &site, None).await.unwrap();
        assert_eq!(posts[0]["remoteId"], "7");
        assert!(page(&t, &site, next.as_deref()).await.unwrap().0.is_empty());
        set_artist(&t, &site, "fixture-artist", false)
            .await
            .unwrap();
        set_artist(&t, &site, "fixture-artist", false)
            .await
            .unwrap();
        assert!(artists(&t, &site).await.unwrap().is_empty());
        assert_eq!(state.lock().unwrap().1, 2);
        assert!(set_artist(&t, &site, "../unsafe", true).await.is_err());
        let unsafe_html="<div id='pageid-userpage'><a href='https://evil.example/watch/fixture-artist/?key=fake'>Watch</a></div>";
        assert!(action(&site, "fixture-artist", unsafe_html).is_err());
        task.abort();
    }
}
