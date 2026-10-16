use crate::{
    booru_engines::{self, Search},
    booru_http::{self, Transport},
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    Error, Result,
};
use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use reqwest::Url;
use ring::hmac;
use rusqlite::OptionalExtension;
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::{sync::Semaphore, task::JoinSet};
const MAX_POOLS: usize = 20;
const MAX_POOL_POSTS: usize = 100_000;
const POOL_PAGE_SIZE: usize = 60;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES: usize = 500 * 1024 * 1024;
static MEDIA_SLOTS: Semaphore = Semaphore::const_new(4);

type QueryMap = HashMap<String, String>;
pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/explore/posts", get(search))
        .route("/explore/vote", post(crate::booru_votes::route))
        .route("/explore/post", get(single))
        .route("/explore/post-tags", get(post_tags))
        .route("/explore/post-text", get(post_text))
        .route("/explore/post-relations", get(relations))
        .route("/explore/post-pools", get(post_pools))
        .route("/explore/pool", get(pool_page))
        .route("/explore/media", get(media))
        .route("/explore/media/{filename}", get(media))
        .route(
            "/explore/gallery-matches",
            post(crate::gallery_matches::route),
        )
}
fn query_text<'a>(q: &'a QueryMap, key: &str, max: usize) -> Result<Option<&'a str>> {
    let value = q.get(key).map(String::as_str);
    if value.is_some_and(|s| s.chars().count() > max) {
        return Err(Error::Invalid(format!("{key} is too long.")));
    }
    Ok(value)
}
fn number(q: &QueryMap, key: &str, default: usize, max: usize) -> Result<usize> {
    q.get(key)
        .map(|s| {
            s.parse::<usize>()
                .ok()
                .filter(|n| *n > 0 && *n <= max)
                .ok_or_else(|| Error::Invalid(format!("{key} must be from 1 through {max}.")))
        })
        .transpose()
        .map(|n| n.unwrap_or(default))
}
fn options(q: &QueryMap) -> Result<Search> {
    let mut s = Search::default();
    s.tags = query_text(q, "tags", 500)?
        .unwrap_or("")
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    s.sort = q.get("sort").cloned().unwrap_or(s.sort);
    if !["new", "hot", "popular"].contains(&s.sort.as_str()) {
        return Err(Error::Invalid("Choose New, Hot or Popular.".into()));
    }
    s.window = q.get("window").cloned().unwrap_or(s.window);
    if !["day", "week", "month", "year", "all"].contains(&s.window.as_str()) {
        return Err(Error::Invalid("Choose a supported calendar period.".into()));
    }
    if let Some(d) = q.get("date") {
        s.date = booru_engines::date(d)?;
    }
    s.page = number(q, "page", 1, 1000)?;
    s.limit = number(q, "limit", 40, 100)?;
    Ok(s)
}
async fn require_site(db: &Database, q: &QueryMap) -> Result<Option<Site>> {
    let id = query_text(q, "siteId", 100)?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("Choose a site.".into()))?;
    boorus::site(db, id.into()).await
}
fn remote_id(q: &QueryMap, name: &str) -> Result<String> {
    booru_engines::id(&json!(
        query_text(q, name, 50)?.ok_or_else(|| Error::Invalid(format!("Supply {name}.")))?
    ))
    .map_err(|_| Error::Invalid(format!("Supply a valid {name}.")))
}
pub(crate) async fn media_key(db: &Database) -> Result<Vec<u8>> {
    db.call(|c| {
        let tx = c.transaction()?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT value FROM meta WHERE key='core.booru_media_key'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let key =
            saved.unwrap_or_else(|| format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()));
        tx.execute(
            "INSERT OR IGNORE INTO meta (key,value) VALUES ('core.booru_media_key',?1)",
            [&key],
        )?;
        tx.commit()?;
        Ok(key.into_bytes())
    })
    .await
}
fn signature(key: &[u8], site_id: &str, url: &str) -> Vec<u8> {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    hmac::sign(&key, format!("{site_id}\0{url}").as_bytes())
        .as_ref()
        .to_vec()
}
pub(crate) fn signed(key: &[u8], site_id: &str, value: &Value) -> Value {
    let Some(raw) = value.as_str() else {
        return Value::Null;
    };
    let sig: String = signature(key, site_id, raw)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let extension = Url::parse(raw)
        .ok()
        .and_then(|u| u.path().rsplit('.').next().map(str::to_lowercase))
        .filter(|s| {
            [
                "jpg", "jpeg", "png", "gif", "webp", "avif", "mp4", "webm", "m4v", "mov",
            ]
            .contains(&s.as_str())
        })
        .unwrap_or_else(|| "bin".into());
    let mut path = Url::parse(&format!("http://localhost/explore/media/file.{extension}")).unwrap();
    path.query_pairs_mut()
        .append_pair("siteId", site_id)
        .append_pair("u", raw)
        .append_pair("s", &sig);
    json!(format!("{}?{}", path.path(), path.query().unwrap()))
}
/// The 32 signature bytes of a 64-digit hex `s` parameter.
fn signature_bytes(sig: &str) -> Option<Vec<u8>> {
    if sig.len() != 64 || !sig.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&sig[i..i + 2], 16).ok())
        .collect()
}
fn verified(key: &[u8], site_id: &str, url: &str, sig: &[u8]) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    hmac::verify(&key, format!("{site_id}\0{url}").as_bytes(), sig).is_ok()
}
/// The site and remote address of a `/explore/media` link this core signed with `key`;
/// `None` for any other link.
pub(crate) fn verified_media(key: &[u8], link: &str) -> Option<(String, String)> {
    let url = Url::parse("http://localhost/").ok()?.join(link).ok()?;
    if url.path() != "/explore/media" && !url.path().starts_with("/explore/media/") {
        return None;
    }
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let (site, raw) = (q.get("siteId")?, q.get("u")?);
    verified(key, site, raw, &signature_bytes(q.get("s")?)?).then(|| (site.clone(), raw.clone()))
}
/// Whether the browser loads this site's media through the core. FurAffinity's Cloudflare
/// refuses a burst of thumbnails; other CDNs serve the browser directly, in parallel and cached.
fn proxied(site: &Site) -> bool {
    site.engine == "furaffinity"
}
pub(crate) async fn decorate(
    db: &Database,
    site: &Site,
    mut posts: Vec<Value>,
    key: &[u8],
) -> Result<Vec<Value>> {
    let keys: Vec<String> = posts
        .iter()
        .map(|p| format!("{}:{}", site.id, p["remoteId"].as_str().unwrap()))
        .collect();
    let read=db.call(move|c|{if keys.is_empty(){return Ok(HashSet::new());}let placeholders=vec!["?";keys.len()].join(",");
 let mut values=vec![OWNER_ID.to_owned()];values.extend(keys);
 let mut s=c.prepare(&format!("SELECT item_key FROM read_marks WHERE user_id=? AND scope='post' AND item_key IN ({placeholders})"))?;
 let rows=s.query_map(rusqlite::params_from_iter(values),|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;Ok(rows)}).await?;
    let provider = crate::booru_favorites::provider(site);
    let ids: Vec<String> = posts
        .iter()
        .map(|p| p["remoteId"].as_str().unwrap().to_owned())
        .collect();
    let saved = db.call(move |c| {
        if ids.is_empty() { return Ok(HashMap::new()); }
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut values = vec![OWNER_ID.to_owned(), provider]; values.extend(ids);
        let mut s = c.prepare(&format!("SELECT fav.remote_id, f.id FROM favorite_items fav JOIN files f ON f.path=fav.file_path JOIN library_folders folders ON folders.id=f.folder_id WHERE fav.user_id=? AND fav.provider=? AND fav.remote_id IN ({placeholders})"))?;
        let rows = s.query_map(rusqlite::params_from_iter(values), |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<HashMap<_,_>>>()?; Ok(rows)
    }).await?;
    for p in &mut posts {
        p["siteId"] = json!(site.id);
        p["siteName"] = json!(site.name);
        p["engine"] = json!(site.engine);
        p["sourceUrl"] = json!(booru_engines::post_url(
            site,
            p["remoteId"].as_str().unwrap()
        )?);
        p["read"] =
            json!(read.contains(&format!("{}:{}", site.id, p["remoteId"].as_str().unwrap())));
        let held = saved.get(p["remoteId"].as_str().unwrap());
        p["libraryFileId"] = json!(held);
        if p["favorited"].is_null() {
            p["favorited"] = json!(held.is_some());
        }
        p["colorSourceUrl"] = signed(key, &site.id, &p["previewUrl"]);
        p["matchPreviewUrl"] = signed(
            key,
            &site.id,
            if p["fileExt"] == "gif" {
                &p["fileUrl"]
            } else if !p["sampleUrl"].is_null() {
                &p["sampleUrl"]
            } else {
                &p["fileUrl"]
            },
        );
        if proxied(site) {
            for field in ["previewUrl", "sampleUrl", "fileUrl"] {
                p[field] = signed(key, &site.id, &p[field]);
            }
        }
    }
    Ok(posts)
}
async fn search(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Json<Value>> {
    let s = options(&q)?;
    let wanted = query_text(&q, "sites", 2000)?.map(|v| {
        v.split(|c: char| c == ',' || c.is_whitespace())
            .collect::<HashSet<_>>()
    });
    let sites: Vec<_> = boorus::sites(&db)
        .await?
        .into_iter()
        .filter(|site| {
            site.enabled
                && wanted.as_ref().is_none_or(|w| w.contains(site.id.as_str()))
                && (!matches!(site.engine.as_str(), "furaffinity" | "shimmie") || s.sort == "new")
                && (site.engine != "furaffinity" || s.tags.is_empty())
        })
        .collect();
    let ids: Vec<_> = sites.iter().map(|s| s.id.clone()).collect();
    let mut jobs = JoinSet::new();
    let slots = Arc::new(Semaphore::new(4));
    for site in sites {
        let s = s.clone();
        let slots = slots.clone();
        jobs.spawn(async move {
            let _slot = slots.acquire().await.expect("owned semaphore");
            let result = booru_engines::search(&Transport::default(), &site, &s).await;
            (site, result)
        });
    }
    let key = media_key(&db).await?;
    let mut by_site = HashMap::new();
    let mut errors = Vec::new();
    while let Some(job) = jobs.join_next().await {
        let (site, result) =
            job.map_err(|_| booru_http::remote("The search was interrupted. Try again."))?;
        match result {
            Ok(found) => {
                by_site.insert(site.id.clone(), decorate(&db, &site, found, &key).await?);
            }
            Err(e) => {
                errors.push(json!({"siteId":site.id,"siteName":site.name,"error":e.to_string()}))
            }
        }
    }
    let mut posts = Vec::new();
    if s.sort == "new" {
        for index in 0..s.limit {
            for id in &ids {
                if let Some(post) = by_site.get(id).and_then(|p| p.get(index)) {
                    posts.push(post.clone());
                }
            }
        }
    } else {
        for id in &ids {
            if let Some(found) = by_site.remove(id) {
                posts.extend(found);
            }
        }
        posts.sort_by(|a, b| {
            b["score"]
                .as_f64()
                .unwrap_or(0.)
                .total_cmp(&a["score"].as_f64().unwrap_or(0.))
        });
    }
    Ok(Json(json!({"posts":posts,"siteErrors":errors,"sites":ids})))
}
async fn single(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Response> {
    let id = remote_id(&q, "remoteId")?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    let Some(post) = booru_engines::single(&Transport::default(), &site, &id).await? else {
        return Ok(crate::files::not_found("Post"));
    };
    let key = media_key(&db).await?;
    let post = decorate(&db, &site, vec![post], &key).await?.remove(0);
    Ok(Json(json!({"post":post})).into_response())
}
async fn post_tags(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Response> {
    let id = remote_id(&q, "remoteId")?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    let Some(post) = tagged_post(&Transport::default(), &site, &id).await? else {
        return Ok(crate::files::not_found("Post"));
    };
    let file = if proxied(&site) {
        signed(&media_key(&db).await?, &site.id, &post["fileUrl"])
    } else {
        post["fileUrl"].clone()
    };
    Ok(Json(json!({"tags":post["tags"],"fileUrl":file})).into_response())
}

pub(crate) async fn tagged_post(
    transport: &Transport,
    site: &Site,
    id: &str,
) -> Result<Option<Value>> {
    let Some(mut post) = booru_engines::single(transport, site, id).await? else {
        return Ok(None);
    };
    if site.engine == "gelbooru" {
        let mut address = site.clone();
        address.base = booru_engines::website(&site);
        let mut url = booru_engines::endpoint(&address, "/index.php")?;
        url.query_pairs_mut()
            .append_pair("page", "post")
            .append_pair("s", "view")
            .append_pair("id", &id);
        let html = transport
            .text(url, booru_engines::web_headers(&site)?)
            .await?;
        post["tags"] = gel_tags(&html)?;
    }
    Ok(Some(post))
}
async fn post_text(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Response> {
    let id = remote_id(&q, "remoteId")?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    if site.engine == "furaffinity" {
        let p = booru_engines::single(&Transport::default(), &site, &id).await?;
        return Ok(Json(json!({"title":p.as_ref().map(|p|p["title"].clone()),"description":p.as_ref().map(|p|p["description"].clone())})).into_response());
    }
    if site.engine == "e621" {
        let p = Transport::default()
            .json(
                booru_engines::endpoint(&site, &format!("/posts/{id}.json"))?,
                booru_engines::headers(&site, false)?,
            )
            .await?;
        return Ok(
            Json(json!({"title":null,"description":p["post"]["description"]})).into_response(),
        );
    }
    if site.engine == "philomena" {
        let p = Transport::default()
            .json(
                booru_engines::endpoint(&site, &format!("/api/v1/json/images/{id}"))?,
                booru_engines::headers(&site, false)?,
            )
            .await?;
        return Ok(
            Json(json!({"title":null,"description":p["image"]["description"]})).into_response(),
        );
    }
    Ok(Json(json!({"title":null,"description":null})).into_response())
}
async fn relations(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Response> {
    let id = remote_id(&q, "remoteId")?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    if !matches!(
        site.engine.as_str(),
        "e621" | "danbooru" | "gelbooru" | "moebooru" | "sankaku"
    ) {
        return Ok(Json(json!({"posts":[]})).into_response());
    }
    let children = match q.get("hasChildren").map(String::as_str) {
        None | Some("false") => false,
        Some("true") => true,
        _ => return Err(Error::Invalid("hasChildren must be true or false.".into())),
    };
    let parent = q
        .get("parentId")
        .map(|_| remote_id(&q, "parentId"))
        .transpose()?;
    if parent.is_none()
        && !children
        && matches!(site.engine.as_str(), "e621" | "danbooru" | "moebooru")
    {
        return Ok(Json(json!({"posts":[]})).into_response());
    }
    let root = parent.unwrap_or_else(|| id.clone());
    let s = Search {
        tags: vec![format!("parent:{root}")],
        limit: 40,
        ..Default::default()
    };
    let t = Transport::default();
    let mut posts = booru_engines::search(&t, &site, &s).await?;
    if !posts.iter().any(|p| p["remoteId"] == root) {
        if let Some(p) = booru_engines::single(&t, &site, &root).await? {
            posts.insert(0, p);
        }
    }
    posts.sort_by_key(|p| p["remoteId"] != root);
    if posts.len() < 2 {
        posts.clear();
    }
    let key = media_key(&db).await?;
    let mut posts = decorate(&db, &site, posts, &key).await?;
    for p in &mut posts {
        p["isParent"] = json!(p["remoteId"] == root);
        p["isCurrent"] = json!(p["remoteId"] == id);
    }
    Ok(Json(json!({"posts":posts})).into_response())
}
#[derive(Clone)]
struct Pool {
    id: String,
    name: String,
    ids: Vec<String>,
}
fn pool(v: &Value) -> Result<Pool> {
    let id = booru_engines::id(&v["id"])?;
    let name = v["name"]
        .as_str()
        .filter(|s| s.len() <= 2000)
        .ok_or_else(|| booru_http::remote("The site returned an invalid pool name."))?;
    let ids = v["post_ids"]
        .as_array()
        .filter(|a| a.len() <= MAX_POOL_POSTS)
        .ok_or_else(|| {
            booru_http::remote("The site's pool exceeds the supported size or has no page order.")
        })?;
    Ok(Pool {
        id,
        name: name.into(),
        ids: ids.iter().map(booru_engines::id).collect::<Result<_>>()?,
    })
}
async fn read_pool(t: &Transport, site: &Site, id: &str) -> Result<Pool> {
    pool(
        &t.json(
            booru_engines::endpoint(site, &format!("/pools/{id}.json"))?,
            booru_engines::headers(site, false)?,
        )
        .await?,
    )
}
async fn post_pools(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Response> {
    let id = remote_id(&q, "remoteId")?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    if !matches!(site.engine.as_str(), "e621" | "danbooru") {
        return Ok(Json(json!({"pools":[]})).into_response());
    }
    let t = Transport::default();
    let pools = if site.engine == "danbooru" {
        let mut url = booru_engines::endpoint(&site, "/pools.json")?;
        url.query_pairs_mut()
            .append_pair("search[post_ids_include_any]", &id)
            .append_pair("limit", &MAX_POOLS.to_string());
        let v = t.json(url, booru_engines::headers(&site, false)?).await?;
        let pools = v
            .as_array()
            .filter(|a| a.len() <= MAX_POOLS)
            .ok_or_else(|| booru_http::remote("The site returned an invalid pool list."))?;
        pools.iter().map(pool).collect::<Result<Vec<_>>>()?
    } else {
        let ids = if let Some(raw) = query_text(&q, "poolIds", 500)? {
            raw.split(',')
                .filter(|s| !s.is_empty())
                .map(|s| booru_engines::id(&json!(s)))
                .collect::<Result<Vec<_>>>()?
        } else {
            let post = booru_engines::single(&t, &site, &id).await?;
            post.map(|p| {
                p["poolIds"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(booru_engines::id)
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default()
        };
        if ids.len() > MAX_POOLS {
            return Err(Error::Invalid("Too many pools for one post.".into()));
        }
        let mut pools = Vec::new();
        for id in ids {
            pools.push(read_pool(&t, &site, &id).await?);
        }
        pools
    };
    let navigators:Vec<_>=pools.into_iter().filter_map(|p|p.ids.iter().position(|p|p==&id).map(|index|json!({"poolId":p.id,"siteId":site.id,"siteName":site.name,"name":p.name,"position":index+1,"postCount":p.ids.len(),"prevId":index.checked_sub(1).and_then(|i|p.ids.get(i)),"nextId":p.ids.get(index+1)}))).collect();
    Ok(Json(json!({"pools":navigators})).into_response())
}
async fn pool_page(State(db): State<Database>, Query(q): Query<QueryMap>) -> Result<Response> {
    let id = remote_id(&q, "poolId")?;
    let page = number(&q, "page", 1, 1000)?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    if !matches!(site.engine.as_str(), "e621" | "danbooru") {
        return Ok(crate::files::not_found("Pool"));
    }
    let t = Transport::default();
    let pool = read_pool(&t, &site, &id).await?;
    let ids: Vec<_> = pool
        .ids
        .iter()
        .skip((page - 1) * POOL_PAGE_SIZE)
        .take(POOL_PAGE_SIZE)
        .cloned()
        .collect();
    let posts = booru_engines::by_ids(&t, &site, &ids).await?;
    let key = media_key(&db).await?;
    let mut posts = decorate(&db, &site, posts, &key).await?;
    for p in &mut posts {
        p["position"] = json!(pool.ids.iter().position(|id| p["remoteId"] == *id).unwrap() + 1);
    }
    Ok(Json(json!({"poolId":pool.id,"siteId":site.id,"siteName":site.name,"name":pool.name,"postCount":pool.ids.len(),"page":page,"pageSize":POOL_PAGE_SIZE,"posts":posts,"postIds":pool.ids})).into_response())
}
async fn media(
    State(db): State<Database>,
    Query(q): Query<QueryMap>,
    request: axum::extract::Request,
) -> Result<Response> {
    let raw = query_text(&q, "u", 8000)?
        .ok_or_else(|| Error::Invalid("The media address is missing.".into()))?;
    let sig = query_text(&q, "s", 64)?
        .and_then(signature_bytes)
        .ok_or_else(|| Error::Invalid("The media link is incomplete. Search again.".into()))?;
    let Some(site) = require_site(&db, &q).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    if !verified(&media_key(&db).await?, &site.id, raw, &sig) {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({"error":"This media link is invalid. Search again to load the post."})),
        )
            .into_response());
    }
    let url = booru_http::url(raw)?;
    let mut headers = booru_engines::headers(&site, true)?;
    if let Some(range) = request.headers().get(header::RANGE) {
        headers.insert(header::RANGE, range.clone());
    }
    let slot = MEDIA_SLOTS
        .acquire()
        .await
        .map_err(|_| booru_http::remote("The media request was cancelled."))?;
    let response = Transport::default().get(url, headers).await?;
    let status = response.status();
    let h = response.headers().clone();
    let mime = h
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(';').next())
        .unwrap_or("");
    let allowed = matches!(
        mime,
        "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "video/mp4"
            | "video/webm"
            | "video/quicktime"
    );
    if !allowed {
        return Err(booru_http::remote("The provider did not return a supported image or video. Open its original post to check availability."));
    }
    let max = if mime.starts_with("video/") {
        MAX_VIDEO_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(booru_http::remote(
            "This media file exceeds the supported size. Open the original post.",
        ));
    }
    let stream = futures_util::stream::try_unfold(
        (response, 0usize, slot),
        move |(mut response, size, slot)| async move {
            let chunk = response
                .chunk()
                .await
                .map_err(|_| std::io::Error::other("Media download interrupted"))?;
            match chunk {
                Some(chunk) if size + chunk.len() <= max => {
                    let next = size + chunk.len();
                    Ok(Some((chunk, (response, next, slot))))
                }
                Some(_) => Err(std::io::Error::other("Media size limit exceeded")),
                None => Ok(None),
            }
        },
    );
    let mut result = (status, Body::from_stream(stream)).into_response();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = h.get(&name) {
            result.headers_mut().insert(name, value.clone());
        }
    }
    result.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    if status == StatusCode::OK {
        // A signed link always names the same file, so the webview keeps it and a
        // grid seen before loads without asking the booru again.
        result.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=2592000, immutable"),
        );
    }
    Ok(result)
}
fn selector(raw: &str) -> Selector {
    Selector::parse(raw).expect("static selector")
}
fn challenge(html: &str) -> Result<()> {
    if [
        "cf-chl-",
        "Just a moment",
        "Checking your browser",
        "cf-turnstile",
    ]
    .iter()
    .any(|s| html.contains(s))
    {
        return Err(booru_http::captcha());
    }
    Ok(())
}
fn fa_tags(raw: Option<&str>) -> Vec<Value> {
    let mut tags: HashMap<String, String> = HashMap::new();
    for token in raw.unwrap_or("").split_whitespace() {
        let (raw, c) = if let Some(s) = token.strip_prefix("u_") {
            (s.trim_start_matches('_'), "artist")
        } else if let Some(s) = token.strip_prefix("s_") {
            (s, "species")
        } else if let Some(s) = token
            .strip_prefix("c_")
            .or_else(|| token.strip_prefix("t_"))
        {
            (s, "meta")
        } else {
            (token, "general")
        };
        if ["all", "unspecified_any"].contains(&raw) {
            continue;
        }
        let name = crate::tags::normalize(raw);
        if name.is_empty() {
            continue;
        }
        let priority = |c: &str| match c {
            "artist" => 3,
            "species" => 2,
            "meta" => 1,
            _ => 0,
        };
        if tags
            .get(&name)
            .is_none_or(|old| priority(c) > priority(old))
        {
            tags.insert(name, c.to_owned());
        }
    }
    let mut tags: Vec<_> = tags
        .into_iter()
        .map(|(tag, category)| json!({"tag":tag,"category":category}))
        .collect();
    tags.sort_by(|a, b| a["tag"].as_str().cmp(&b["tag"].as_str()));
    tags
}
fn fa_url(raw: Option<&str>) -> Result<Value> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(Value::Null);
    };
    let raw = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.into()
    };
    let mut url = booru_http::url(&raw)
        .map_err(|_| booru_http::remote("FurAffinity returned an invalid media address."))?;
    if !url
        .host_str()
        .is_some_and(|h| h == "furaffinity.net" || h.ends_with(".furaffinity.net"))
    {
        return Err(booru_http::remote(
            "FurAffinity returned media from an unexpected address.",
        ));
    }
    url.set_scheme("https").unwrap();
    Ok(json!(url.as_str()))
}
pub(crate) fn fa_listing(_site: &Site, html: &str) -> Result<Vec<Value>> {
    fa_list(html, "#pageid-browse")
}
pub(crate) fn fa_list(html: &str, container: &str) -> Result<Vec<Value>> {
    challenge(html)?;
    let doc = Html::parse_document(html);
    if doc.select(&selector(container)).next().is_none() {
        return Err(booru_http::remote(
            "FurAffinity did not return the requested list. Save a fresh session in Accounts and retry.",
        ));
    }
    let mut posts = Vec::new();
    for figure in doc.select(&selector("figure[id^='sid-']")) {
        let id = booru_engines::id(&json!(figure
            .value()
            .attr("id")
            .unwrap()
            .trim_start_matches("sid-")))?;
        let image = figure.select(&selector("img")).next().ok_or_else(|| {
            booru_http::remote("FurAffinity returned a post without a thumbnail.")
        })?;
        let url = fa_url(image.value().attr("src"))?;
        let artist = figure
            .select(&selector("a[href^='/user/']"))
            .next()
            .and_then(|a| a.value().attr("href"))
            .map(|s| {
                s.trim_start_matches("/user/")
                    .trim_end_matches('/')
                    .to_owned()
            });
        let dimension = |key| {
            image
                .value()
                .attr(key)
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| *n > 0)
        };
        let rating = figure.value().classes().find_map(|c| {
            c.strip_prefix("r-")
                .filter(|s| ["general", "mature", "adult"].contains(s))
        });
        posts.push(json!({"remoteId":id,"previewUrl":url,"sampleUrl":url,"fileUrl":null,"width":dimension("data-width"),"height":dimension("data-height"),"score":null,"rating":rating,"md5":null,"createdAt":null,"tags":fa_tags(image.value().attr("data-tags")),"favCount":null,"uploader":artist,"fileExt":null,"fileSize":null,"favorited":null,"voted":null,"parentId":null,"hasChildren":false,"poolIds":[]}));
        if posts.len() > 100 {
            return Err(booru_http::remote("FurAffinity returned too many posts."));
        }
    }
    Ok(posts)
}
pub(crate) fn fa_submission(_site: &Site, id: &str, html: &str) -> Result<Value> {
    challenge(html)?;
    let doc = Html::parse_document(html);
    let media=doc.select(&selector("#submissionImg, #flash_embed")).next().ok_or_else(||booru_http::remote("FurAffinity did not return a viewable submission. Open the original post to check availability."))?;
    let file = fa_url(
        media
            .value()
            .attr("data-fullview-src")
            .or_else(|| media.value().attr("data"))
            .or_else(|| media.value().attr("src")),
    )?;
    let text = |s: &str| {
        doc.select(&selector(s))
            .next()
            .map(|e| e.text().collect::<Vec<_>>().join(" ").trim().to_owned())
    };
    Ok(
        json!({"remoteId":id,"previewUrl":file,"sampleUrl":file,"fileUrl":file,"width":null,"height":null,"score":null,"rating":null,"md5":null,"createdAt":null,"tags":fa_tags(media.value().attr("data-tags")),"favCount":null,"uploader":null,"fileExt":null,"fileSize":null,"favorited":null,"voted":null,"parentId":null,"hasChildren":false,"poolIds":[],"title":text(".submission-title h2"),"description":text(".submission-description-text")}),
    )
}
fn gel_tags(html: &str) -> Result<Value> {
    let doc = Html::parse_document(html);
    let mut tags = Vec::new();
    for item in doc.select(&selector("li[class*='tag-type-']")) {
        let category = item
            .value()
            .classes()
            .find_map(|c| c.strip_prefix("tag-type-"))
            .unwrap_or("general");
        let category = if category == "metadata" {
            "meta"
        } else {
            category
        };
        for a in item.select(&selector("a[href*='search=']")) {
            if let Some(href) = a.value().attr("href") {
                if let Ok(url) = Url::parse("https://example.com").unwrap().join(href) {
                    if let Some((_, name)) = url.query_pairs().find(|(k, _)| k == "search") {
                        tags.push(json!({"tag":crate::tags::normalize(&name),"category":category}));
                        break;
                    }
                }
            }
        }
    }
    if tags.is_empty() {
        return Err(booru_http::remote("The site did not expose tag categories. The listing's tags are still available; try again later."));
    }
    Ok(json!(tags))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_media_links_preserve_video_extension_and_bind_site_and_address() {
        let key = b"fake-test-key";
        let value = signed(
            key,
            "site-a",
            &json!("https://cdn.example.com/movie.webm?version=2"),
        );
        let path = value.as_str().unwrap();
        assert!(path.starts_with("/explore/media/file.webm?"));
        let url = Url::parse(&format!("http://localhost{path}")).unwrap();
        let q: HashMap<_, _> = url.query_pairs().collect();
        let signature = signature(key, "site-a", &q["u"]);
        assert_eq!(
            q["s"],
            signature
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let key = hmac::Key::new(hmac::HMAC_SHA256, key);
        assert!(hmac::verify(&key, format!("site-b\0{}", q["u"]).as_bytes(), &signature).is_err());
        assert!(hmac::verify(&key, b"site-a\0https://example.com/other", &signature).is_err());
    }
    #[test]
    fn furaffinity_and_gelbooru_html_keep_categories_and_reject_challenges() {
        let site = Site {
            id: "test".into(),
            name: "Test".into(),
            engine: "furaffinity".into(),
            base: "https://www.furaffinity.net".into(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let html="<img id='submissionImg' data-fullview-src='//d.furaffinity.net/file.gif?x=1&amp;y=2' data-tags='u_test_artist test_artist s_canine s_all c_digital'><div class='submission-title'><h2>Neutral &amp; Title</h2></div><section class='submission-description-text'><p>Hello <strong>world</strong></p></section>";
        let p = fa_submission(&site, "7", html).unwrap();
        assert_eq!(p["title"], "Neutral & Title");
        assert_eq!(p["fileUrl"], "https://d.furaffinity.net/file.gif?x=1&y=2");
        let tags = p["tags"].as_array().unwrap();
        assert_eq!(tags.iter().filter(|t| t["tag"] == "test_artist").count(), 1);
        assert_eq!(
            tags.iter().find(|t| t["tag"] == "test_artist").unwrap()["category"],
            "artist"
        );
        assert!(fa_listing(
            &site,
            "<main id='pageid-browse'>Just a moment cf-chl-</main>"
        )
        .is_err());
        assert!(fa_submission(
            &site,
            "7",
            "<img id='submissionImg' src='https://evil.example/file.png'>"
        )
        .is_err());
        let tags=gel_tags("<li class='tag-type-artist'><a href='/index.php?page=wiki&amp;s=view&amp;search=test_artist'>Wiki</a></li><li class='tag-type-metadata'><a href='/index.php?search=digital'>Wiki</a></li>").unwrap();
        assert_eq!(
            tags,
            json!([{"tag":"test_artist","category":"artist"},{"tag":"digital","category":"meta"}])
        );
    }
    #[tokio::test]
    async fn read_marks_are_batched_and_proxy_key_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let library = dir.path().join("library");
        let db = Database::open(&data, &library).unwrap();
        db.call(|c|{c.execute("INSERT INTO read_marks (scope,item_key,user_id,read_at) VALUES ('post','site-a:7','device-owner','now')",[])?;Ok(())}).await.unwrap();
        let key = media_key(&db).await.unwrap();
        let site = Site {
            id: "site-a".into(),
            name: "Test".into(),
            engine: "e621".into(),
            base: "https://e621.net".into(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let p = json!({"remoteId":"7","previewUrl":"https://cdn.example.com/a.jpg","sampleUrl":null,"fileUrl":"https://cdn.example.com/a.webm","fileExt":"webm","favorited":null});
        let decorated = decorate(&db, &site, vec![p], &key).await.unwrap();
        assert_eq!(decorated[0]["read"], true);
        assert_eq!(decorated[0]["fileUrl"], "https://cdn.example.com/a.webm");
        assert_eq!(decorated[0]["previewUrl"], "https://cdn.example.com/a.jpg");
        for field in ["colorSourceUrl", "matchPreviewUrl"] {
            assert!(decorated[0][field]
                .as_str()
                .unwrap()
                .starts_with("/explore/media/"));
        }
        let furaffinity = Site {
            engine: "furaffinity".into(),
            ..site
        };
        let p = json!({"remoteId":"8","previewUrl":"https://cdn.example.com/b.jpg","sampleUrl":null,"fileUrl":"https://cdn.example.com/b.png","fileExt":"png","favorited":null});
        let decorated = decorate(&db, &furaffinity, vec![p], &key).await.unwrap();
        assert!(decorated[0]["previewUrl"]
            .as_str()
            .unwrap()
            .starts_with("/explore/media/"));
        drop(db);
        let db = Database::open(&data, &library).unwrap();
        assert_eq!(media_key(&db).await.unwrap(), key);
    }
    #[test]
    fn pool_order_accepts_sparse_ids_and_rejects_invented_positions() {
        let p = pool(&json!({"id":3,"name":"neutral_set","post_ids":[7,3,12]})).unwrap();
        assert_eq!(p.ids, vec!["7", "3", "12"]);
        assert!(pool(&json!({"id":3,"name":"set","post_ids":["../secret"]})).is_err());
    }
}
