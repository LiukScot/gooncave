use crate::{
    booru_engines::{self as engines, Search},
    booru_http::{remote, Transport},
    boorus::Site,
    Error, Result,
};
use reqwest::{Method, Url};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::collections::HashSet;

pub(crate) const PAGE_LIMIT: usize = 1000;
pub(crate) const PAGE_SIZE: usize = 50;
/// Waits before sending an add-favorite again after a server error, and
/// before re-reading the list while the site has not shown the new favorite yet.
#[cfg(not(test))]
const FAVORITE_RETRY_MS: [u64; 2] = [500, 1_500];
#[cfg(test)]
const FAVORITE_RETRY_MS: [u64; 2] = [0, 0];
pub(crate) fn supported(engine: &str) -> bool {
    matches!(
        engine,
        "e621" | "danbooru" | "gelbooru" | "furaffinity" | "szurubooru"
    )
}
pub(crate) fn require(site: &Site, writing: bool) -> Result<()> {
    if !site.enabled || !supported(&site.engine) {
        return Err(Error::Invalid(
            "Enable a site that supports favorites in Accounts.".into(),
        ));
    }
    if site.username.as_ref().is_none_or(|s| s.is_empty())
        || (site.engine != "furaffinity" && site.key.as_ref().is_none_or(|s| s.is_empty()))
        || (matches!(site.engine.as_str(), "furaffinity" | "gelbooru")
            && (writing || site.engine == "furaffinity")
            && site.cookie.as_ref().is_none_or(|s| s.is_empty()))
    {
        return Err(Error::Invalid("Favorites need your account credentials. Save the API key or session cookie in Accounts.".into()));
    }
    Ok(())
}
pub(crate) fn provider(site: &Site) -> String {
    site.public["presetKey"]
        .as_str()
        .unwrap_or(&site.id)
        .to_owned()
}
fn web(site: &Site, path: &str) -> Result<Url> {
    Url::parse(&engines::website(site))
        .and_then(|u| u.join(path))
        .map_err(|_| remote("Check the site's address in Accounts."))
}
fn selector(s: &str) -> Selector {
    Selector::parse(s).unwrap()
}
pub(crate) fn html_page(
    site: &Site,
    target: &Url,
    html: &str,
) -> Result<(Vec<String>, Option<Url>)> {
    let doc = Html::parse_document(html);
    let fa = site.engine == "furaffinity";
    if html.to_ascii_lowercase().contains("cf-chl-")
        || html.to_ascii_lowercase().contains("just a moment")
        || (fa
            && (doc.select(&selector("#pageid-favorites")).next().is_none()
                || doc.select(&selector("#gallery-favorites")).next().is_none()))
        || (!fa && !html.to_ascii_lowercase().contains("favorites"))
    {
        return Err(remote("The site did not return its favorites list. Open the site to complete browser verification, then save a fresh session in Accounts."));
    }
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut next = None;
    if fa {
        for figure in doc.select(&selector("#gallery-favorites figure[id^='sid-']")) {
            let id = engines::id(&json!(figure
                .value()
                .attr("id")
                .unwrap()
                .trim_start_matches("sid-")))?;
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
    }
    if fa {
        for form in doc.select(&selector("form[action]")) {
            let action = form.value().attr("action").unwrap();
            if !action.ends_with("/next") {
                continue;
            }
            let url = target
                .join(action)
                .map_err(|_| remote("The site returned an invalid favorites cursor."))?;
            if url.origin() != target.origin()
                || !url.username().is_empty()
                || url.password().is_some()
                || !url.path().starts_with("/favorites/")
            {
                return Err(remote(
                    "The site returned an unsafe favorites cursor. Sync stopped safely.",
                ));
            }
            next = Some(url);
        }
    }
    for a in doc.select(&selector("a[href]")) {
        let Some(href) = a.value().attr("href") else {
            continue;
        };
        let Ok(url) = target.join(href) else {
            continue;
        };
        if url.origin() != target.origin() || !url.username().is_empty() || url.password().is_some()
        {
            continue;
        }
        let q: std::collections::HashMap<_, _> = url.query_pairs().collect();
        let post = if fa {
            url.path()
                .strip_prefix("/view/")
                .map(|s| s.trim_end_matches('/').to_owned())
        } else if q.get("page").is_some_and(|s| s == "post")
            && q.get("s").is_some_and(|s| s == "view")
        {
            q.get("id").map(|s| s.to_string())
        } else {
            None
        };
        if let Some(id) = post {
            let id = engines::id(&json!(id))?;
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
        if fa
            && url.path().starts_with("/favorites/")
            && (a.text().collect::<String>().to_lowercase().contains("next")
                || a.value().attr("rel") == Some("next"))
        {
            next = Some(url);
        }
    }
    if ids.len() > PAGE_SIZE * 2 {
        return Err(remote("The favorites page exceeded the supported size."));
    }
    if !fa && ids.is_empty() {
        let text = doc
            .root_element()
            .text()
            .collect::<String>()
            .to_ascii_lowercase();
        if ![
            "no favorites",
            "no favourites",
            "no posts found",
            "no posts were found",
            "don't have any favorites",
            "no images",
        ]
        .iter()
        .any(|phrase| text.contains(phrase))
        {
            return Err(remote("The site did not confirm an empty favorites list. Check the original site's favorites page, then retry sync."));
        }
    }
    Ok((ids, next))
}
pub(crate) async fn page(
    t: &Transport,
    site: &Site,
    page: usize,
    cursor: Option<Url>,
) -> Result<(Vec<Value>, Option<Url>)> {
    require(site, false)?;
    if matches!(site.engine.as_str(), "e621" | "danbooru" | "szurubooru") {
        return Ok((
            engines::search(
                t,
                site,
                &Search {
                    tags: vec![format!("fav:{}", site.username.as_ref().unwrap())],
                    page,
                    limit: PAGE_SIZE,
                    ..Default::default()
                },
            )
            .await?,
            None,
        ));
    }
    let target = if site.engine == "furaffinity" {
        match cursor {
            Some(url) => url,
            None => {
                let mut u = web(site, "/favorites/")?;
                u.path_segments_mut()
                    .map_err(|_| remote("Invalid site address."))?
                    .pop_if_empty()
                    .push(site.username.as_ref().unwrap())
                    .push("");
                u
            }
        }
    } else {
        let mut u = web(site, "/index.php")?;
        u.query_pairs_mut()
            .append_pair("page", "favorites")
            .append_pair("s", "view")
            .append_pair("id", site.username.as_ref().unwrap())
            .append_pair("pid", &((page - 1) * PAGE_SIZE).to_string());
        u
    };
    let html = t.text(target.clone(), engines::web_headers(site)?).await?;
    let (ids, next) = html_page(site, &target, &html)?;
    Ok((
        ids.into_iter()
            .map(|id| json!({"remoteId":id,"fileUrl":null}))
            .collect(),
        next,
    ))
}
async fn contains(t: &Transport, site: &Site, id: &str) -> Result<bool> {
    let mut cursor = None;
    let mut cursors = HashSet::new();
    for n in 1..=PAGE_LIMIT {
        let (posts, next) = page(t, site, n, cursor).await?;
        if posts.iter().any(|p| p["remoteId"] == id) {
            return Ok(true);
        }
        let done = if site.engine == "furaffinity" {
            next.is_none()
        } else {
            posts.len() < PAGE_SIZE
        };
        if done {
            return Ok(false);
        }
        if let Some(ref url) = next {
            if !cursors.insert(url.to_string()) {
                return Err(remote(
                    "The site's favorites pagination repeated. Sync stopped safely.",
                ));
            }
        }
        cursor = next;
    }
    Err(remote(
        "Favorites exceeded the safe pagination limit. Sync stopped safely.",
    ))
}
fn fa_action(site: &Site, id: &str, html: &str) -> Result<(bool, Url)> {
    let base = web(site, &format!("/view/{id}/"))?;
    let doc = Html::parse_document(html);
    for a in doc.select(&selector("a[href]")) {
        let Ok(url) = base.join(a.value().attr("href").unwrap()) else {
            continue;
        };
        if url.origin() != base.origin() || !url.username().is_empty() || url.password().is_some() {
            continue;
        }
        for (path, current) in [
            (format!("/fav/{id}/"), false),
            (format!("/unfav/{id}/"), true),
        ] {
            if url.path() == path
                && url
                    .query_pairs()
                    .any(|(key, value)| key == "key" && !value.is_empty())
            {
                return Ok((current, url));
            }
        }
    }
    Err(remote(
        "The site did not expose a favorite action. Save a fresh session cookie in Accounts.",
    ))
}
pub(crate) async fn set(t: &Transport, site: &Site, id: &str, desired: bool) -> Result<()> {
    require(site, true)?;
    let id = engines::id(&json!(id))?;
    if site.engine == "szurubooru" {
        let response = t
            .write(
                engines::endpoint(site, &format!("/api/post/{id}/favorite"))?,
                engines::headers(site, false)?,
                if desired {
                    Method::POST
                } else {
                    Method::DELETE
                },
                None,
            )
            .await?;
        if response.status().is_success() || (!desired && response.status() == 404) {
            return Ok(());
        }
        return Err(remote("The site refused the favorite change. Check your credentials and permissions in Accounts."));
    }
    if matches!(site.engine.as_str(), "e621" | "danbooru") {
        let response = t
            .write(
                engines::endpoint(
                    site,
                    &if desired {
                        "/favorites.json".into()
                    } else {
                        format!("/favorites/{id}.json")
                    },
                )?,
                engines::headers(site, false)?,
                if desired {
                    Method::POST
                } else {
                    Method::DELETE
                },
                desired.then(|| urlencoded("post_id", &id)),
            )
            .await?;
        if response.status().is_success() || (!desired && response.status() == 404) {
            return Ok(());
        }
        if desired && response.status() == 422 && contains(t, site, &id).await? {
            return Ok(());
        }
        return Err(remote(
            "The site refused the favorite change. Check your credentials in Accounts and retry.",
        ));
    }
    if site.engine == "furaffinity" {
        let view = web(site, &format!("/view/{id}/"))?;
        let html = t.text(view.clone(), engines::web_headers(site)?).await?;
        let (current, action) = fa_action(site, &id, &html)?;
        if current == desired {
            return Ok(());
        }
        let response = t
            .write(action, engines::web_headers(site)?, Method::GET, None)
            .await?;
        if response.status().as_u16() >= 400 {
            return Err(remote(
                "The site refused the favorite change. Refresh the session in Accounts.",
            ));
        }
        let html = t.text(view, engines::web_headers(site)?).await?;
        if fa_action(site, &id, &html)?.0 == desired {
            return Ok(());
        }
    } else {
        let mut url = if desired {
            web(site, "/public/addfav.php")?
        } else {
            web(site, "/index.php")?
        };
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("id", &id);
            if !desired {
                q.append_pair("page", "favorites")
                    .append_pair("s", "delete");
            }
        }
        let mut headers = engines::web_headers(site)?;
        if desired {
            headers.insert(
                reqwest::header::HeaderName::from_static("x-requested-with"),
                reqwest::header::HeaderValue::from_static("XMLHttpRequest"),
            );
        }
        let mut response = t
            .write(url.clone(), headers.clone(), Method::GET, None)
            .await?;
        // Adding a favorite twice is a no-op on the site, so a server error is safe to retry.
        for delay in FAVORITE_RETRY_MS {
            if !desired || !matches!(response.status().as_u16(), 500 | 502 | 503 | 504) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            response = t
                .write(url.clone(), headers.clone(), Method::GET, None)
                .await?;
        }
        let response = if desired && response.status() == 404 {
            let mut url = web(site, "/index.php")?;
            url.query_pairs_mut()
                .append_pair("page", "favorites")
                .append_pair("s", "add")
                .append_pair("id", &id);
            t.write(url, headers, Method::GET, None).await?
        } else {
            response
        };
        if response.status().as_u16() >= 400 && !(response.status() == 404 && !desired) {
            return Err(remote(
                "The site refused the favorite change. Refresh the session in Accounts.",
            ));
        }
        if desired {
            // The newest favorite comes first, so a post just added shows on
            // page 1 once the site has caught up; polling that page keeps the
            // check to a few requests on an account with thousands of favorites.
            for delay in [0].into_iter().chain(FAVORITE_RETRY_MS) {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                if page(t, site, 1, None)
                    .await?
                    .0
                    .iter()
                    .any(|p| p["remoteId"] == id)
                {
                    return Ok(());
                }
            }
        }
        if contains(t, site, &id).await? == desired {
            return Ok(());
        }
    }
    Err(remote("The favorite change was not confirmed by the site. Save a fresh session cookie in Accounts and retry."))
}
fn urlencoded(key: &str, value: &str) -> String {
    let mut u = Url::parse("https://example.org/").unwrap();
    u.query_pairs_mut().append_pair(key, value);
    u.query().unwrap().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Request, State},
        response::IntoResponse,
        routing::any,
        Router,
    };
    use std::sync::{Arc, Mutex};
    fn site(engine: &str, base: String) -> Site {
        Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: engine.into(),
            base,
            username: Some("fake-user".into()),
            key: Some("fake-key".into()),
            cookie: Some("a=fake;b=fake".into()),
            enabled: true,
            public: Value::Null,
        }
    }
    struct Fixture {
        base: String,
        state: Arc<Mutex<(bool, Vec<(String, String, String)>)>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn fixture(engine: &str) -> Fixture {
        let state = Arc::new(Mutex::new((false, Vec::new())));
        let e = engine.to_owned();
        let e2 = e.clone();
        let app=Router::new().fallback(any(move |State(state):State<Arc<Mutex<(bool,Vec<(String,String,String)>)>>>,request:Request|{
            let e=e2.clone();async move {
                let method=request.method().to_string();let path=request.uri().to_string();let auth=request.headers().get(if matches!(e.as_str(),"e621"|"danbooru"){"authorization"}else{"cookie"}).and_then(|s|s.to_str().ok()).unwrap_or("").to_owned();
                let bytes=axum::body::to_bytes(request.into_body(),1024).await.unwrap();
                let mut s=state.lock().unwrap();s.1.push((method.clone(),path.clone(),auth));
                if path.starts_with("/favorites.json") && method=="POST" {assert_eq!(bytes.as_ref(),b"post_id=7");s.0=true;return axum::http::StatusCode::CREATED.into_response();}
                if path.starts_with("/favorites/7.json") && method=="DELETE" {s.0=false;return axum::http::StatusCode::NO_CONTENT.into_response();}
                if path.starts_with("/posts.json") {let rows=if s.0{vec![json!({"id":7,"file":{"url":null},"tags":{},"pools":[],"relationships":{},"tag_string":""})]}else{vec![]};return axum::Json(if e=="e621"{json!({"posts":rows})}else{json!(rows)}).into_response();}
                if path.starts_with("/view/"){return axum::response::Html(format!("<a href='/{}fav/7/?key=fake'>Favorite</a>",if s.0{"un"}else{""})).into_response();}
                if path.starts_with("/fav/") || path.starts_with("/unfav/"){s.0=path.starts_with("/fav/");return (axum::http::StatusCode::FOUND,[("location","http://127.0.0.1:1/do-not-follow")]).into_response();}
                if path.starts_with("/public/addfav.php") {s.0=true;return axum::http::StatusCode::OK.into_response();}
                if path.contains("s=delete"){s.0=false;return (axum::http::StatusCode::FOUND,[("location","/index.php?page=favorites&s=view")]).into_response();}
                axum::response::Html(format!("<h1>Favorites</h1>{}",if s.0{"<a href='/index.php?page=post&amp;s=view&amp;id=7'>Post</a>"}else{"No favorites"})).into_response()
            }
        })).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fixture { base, state, task }
    }
    #[tokio::test]
    async fn favorites_write_with_credentials_and_confirm_cookie_actions_for_all_supported_engines()
    {
        let t = Transport {
            allow_loopback: true,
        };
        for engine in ["e621", "danbooru", "gelbooru", "furaffinity"] {
            let f = fixture(engine).await;
            let s = site(engine, f.base.clone());
            set(&t, &s, "7", true).await.unwrap();
            assert!(f.state.lock().unwrap().0, "{engine}");
            set(&t, &s, "7", true).await.unwrap();
            set(&t, &s, "7", false).await.unwrap();
            assert!(!f.state.lock().unwrap().0, "{engine}");
            let state = f.state.lock().unwrap();
            assert!(
                state.1.iter().all(|(_, _, auth)| !auth.is_empty()),
                "{engine}"
            );
            if engine == "furaffinity" {
                assert_eq!(
                    state
                        .1
                        .iter()
                        .filter(|(_, path, _)| path.starts_with("/fav/"))
                        .count(),
                    1
                );
            }
        }
    }
    #[test]
    fn html_pagination_requires_real_favorites_and_keeps_cursors_on_the_site() {
        let s = site("furaffinity", "https://www.furaffinity.net".into());
        let u = Url::parse("https://www.furaffinity.net/favorites/fake/").unwrap();
        let html="<div id='pageid-favorites'><div id='gallery-favorites'><a href='/view/7/'>post</a><a href='/view/7/'>duplicate</a></div><form action='/favorites/fake/2/next'></form><a href='https://evil.example/'>Next</a></div>";
        let (ids, next) = html_page(&s, &u, html).unwrap();
        assert_eq!(ids, vec!["7"]);
        assert_eq!(next.unwrap().path(), "/favorites/fake/2/next");
        assert!(html_page(&s, &u, "<form>Login</form>").is_err());
        assert!(fa_action(
            &s,
            "7",
            "<a href='https://evil.example/fav/7/?key=fake'>Add</a>"
        )
        .is_err());
    }
    #[test]
    fn unexpected_empty_gelbooru_pages_are_errors_not_removed_favorites() {
        let s = site("gelbooru", "https://example.org".into());
        let u = Url::parse("https://example.org/index.php?page=favorites").unwrap();
        assert!(html_page(&s, &u, "<h1>Favorites</h1><p>Log in to continue</p>").is_err());
        assert!(html_page(&s, &u, "<h1>Favorites</h1><p>No favorites</p>")
            .unwrap()
            .0
            .is_empty());
    }

    #[tokio::test]
    async fn rejected_write_redirects_are_not_followed_and_secrets_stay_out_of_errors() {
        let app = Router::new().fallback(any(|| async {
            (
                axum::http::StatusCode::FOUND,
                [("location", "http://127.0.0.1:1/leak")],
            )
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let s = site("e621", format!("http://{}", listener.local_addr().unwrap()));
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let error = set(
            &Transport {
                allow_loopback: true,
            },
            &s,
            "7",
            true,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(!error.contains("fake-key"));
        assert!(!error.contains("127.0.0.1"));
        task.abort();
    }
    #[tokio::test]
    async fn a_cookie_favorite_survives_a_server_error_and_a_list_that_updates_late() {
        // (add-favorite calls, list reads since the add went through)
        let state = Arc::new(Mutex::new((0, None::<usize>)));
        let app = Router::new()
            .fallback(any(
                |State(state): State<Arc<Mutex<(usize, Option<usize>)>>>, request: Request| async move {
                    let path = request.uri().to_string();
                    let mut s = state.lock().unwrap();
                    if path.starts_with("/public/addfav.php") {
                        s.0 += 1;
                        if s.0 == 1 {
                            return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
                        }
                        s.1 = Some(0);
                        return axum::http::StatusCode::OK.into_response();
                    }
                    // The list shows the new favorite only from its second read.
                    let shown = s.1.is_some_and(|reads| reads >= 1);
                    if let Some(reads) = s.1.as_mut() {
                        *reads += 1;
                    }
                    axum::response::Html(if shown {
                        "<h1>Favorites</h1><a href='/index.php?page=post&amp;s=view&amp;id=7'>Post</a>"
                    } else {
                        "<h1>Favorites</h1>No favorites"
                    })
                    .into_response()
                },
            ))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let t = Transport {
            allow_loopback: true,
        };
        set(&t, &site("gelbooru", base), "7", true).await.unwrap();
        assert_eq!(state.lock().unwrap().0, 2);
        task.abort();
    }
}
