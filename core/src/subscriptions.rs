use crate::{
    booru_engines::{self, Search},
    booru_http::Transport,
    boorus::{self, Site},
    db::{write_setting, Database, OWNER_ID},
    explore, subscription_remote as remote,
    subscription_store::{self as store, Cursor, SyncState},
    Error, Result,
};
use axum::{
    extract::{Query, State},
    routing::{get, post, put},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

const REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);
const RETENTION_DAYS: i64 = 365;
const PAGE_SIZE: usize = 40;
const MAX_QUERIES: usize = 4;
const MAX_PAGE: usize = 1000;
type Payload = std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>;

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/settings/subscriptions", get(settings))
        .route(
            "/settings/subscriptions/tags",
            get(tags).put(save_tags).post(add_tag),
        )
        .route(
            "/settings/subscriptions/artists",
            post(follow).delete(unfollow),
        )
        .route(
            "/settings/subscriptions/pools",
            get(pools).post(follow_pool).delete(unfollow_pool),
        )
        .route("/explore/subscriptions", get(feed))
        .route("/explore/subscriptions/refresh", post(refresh_route))
        .route("/explore/subscriptions/bookmark", put(bookmark))
}
fn body(p: Payload) -> Result<Value> {
    let Json(v) = p.map_err(|_| Error::Invalid("Send a valid JSON object.".into()))?;
    if !v.is_object() {
        return Err(Error::Invalid("Send a JSON object.".into()));
    }
    Ok(v)
}
fn text(v: &Value, key: &str, max: usize) -> Result<String> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= max)
        .map(|s| s.trim().to_owned())
        .ok_or_else(|| Error::Invalid(format!("Supply {key} with 1 through {max} characters.")))
}
/// The saved searches and artists as stored, without the FurAffinity sync `settings` runs.
async fn tags(State(db): State<Database>) -> Result<Json<Value>> {
    let (tags, artists) = db
        .call(|c| Ok((store::searches(c)?, store::artists(c)?)))
        .await?;
    Ok(Json(json!({"tags":tags,"artists":artists})))
}
async fn settings(State(db): State<Database>) -> Result<Json<Value>> {
    // A running refresh syncs the watchlists itself; the page must not wait for it.
    let guard = db.subscriptions.try_lock().ok();
    overview(&db, guard.is_some()).await
}
/// The saved searches and artists. With `sync`, each enabled FurAffinity account's watchlist is
/// first merged into the artists; the caller holds the `subscriptions` lock.
async fn overview(db: &Database, sync: bool) -> Result<Json<Value>> {
    let errors = if sync {
        let sites = boorus::sites(db).await?;
        sync_artists(db, &Transport::default(), &sites).await?
    } else {
        vec![]
    };
    let (tags, artists) = db
        .call(|c| Ok((store::searches(c)?, store::artists(c)?)))
        .await?;
    let targets: Vec<Value> = tags
        .iter()
        .map(|tag| json!({"kind":"tag","value":tag}))
        .chain(
            artists
                .iter()
                .map(|artist| json!({"kind":"artist","value":artist})),
        )
        .collect();
    Ok(Json(
        json!({"tags":tags,"artists":artists,"artistErrors":errors,"targets":targets}),
    ))
}
/// Follow changes refused in a row before one account's sync stops for this round.
const MAX_FOLLOW_FAILURES: usize = 3;
/// Two-way sync of the artists with each enabled FurAffinity watchlist (see `store::reconcile`).
/// A failed account is returned as an error and retried on the next sync; its changes are kept.
/// The caller holds the `subscriptions` lock.
async fn sync_artists(db: &Database, t: &Transport, sites: &[Site]) -> Result<Vec<Value>> {
    let mut errors = Vec::new();
    for site in sites
        .iter()
        .filter(|s| s.enabled && s.engine == "furaffinity")
    {
        let failed =
            |e: &Error| json!({"siteId":site.id,"siteName":site.name,"error":e.to_string()});
        let watched = match remote::artists(t, site).await {
            Ok(names) => names.iter().map(|n| n.to_lowercase()).collect::<Vec<_>>(),
            Err(e) => {
                errors.push(failed(&e));
                continue;
            }
        };
        let id = site.id.clone();
        let (seen, local) = db
            .call(move |c| Ok((store::seen_artists(c, &id)?, store::artists(c)?)))
            .await?;
        let plan = store::reconcile(&watched, seen.as_deref(), &local);
        if plan.local.len() > store::MAX_ARTISTS {
            // Saving it would leave a list GoonCave refuses to read back.
            errors.push(failed(&Error::Invalid(format!(
                "Importing this watchlist would pass {} followed artists. Unfollow some, then reload.",
                store::MAX_ARTISTS
            ))));
            continue;
        }
        let mut now = watched;
        let mut changed = false;
        let mut failures_in_a_row = 0;
        for (artist, watch) in plan
            .watch
            .iter()
            .map(|a| (a, true))
            .chain(plan.unwatch.iter().map(|a| (a, false)))
        {
            if let Err(e) = remote::set_artist(t, site, artist, watch).await {
                // One artist FurAffinity does not know must not hold back the others; a run of
                // refusals is an expired session, where every further request would fail too.
                errors.push(failed(&Error::Invalid(format!("{artist}: {e}"))));
                failures_in_a_row += 1;
                if failures_in_a_row == MAX_FOLLOW_FAILURES {
                    break;
                }
                continue;
            }
            failures_in_a_row = 0;
            changed = true;
            if watch {
                now.push(artist.clone());
            } else {
                now.retain(|a| a != artist);
            }
        }
        let id = site.id.clone();
        db.call(move |c| {
            let tx = c.transaction()?;
            if changed {
                store::reset(&tx, Some(&id), false)?;
            }
            // Device sync may have replaced the list during the requests above. Saving would
            // drop that change, and saving the watchlist alone would read its new artists as
            // removed here next time; both wait for the next sync, which starts from the new list.
            if store::artists(&tx)? == local {
                if plan.local != local {
                    store::save_artists(&tx, &plan.local)?;
                    store::reset(&tx, None, true)?;
                }
                store::save_seen_artists(&tx, &id, &now)?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    }
    Ok(errors)
}
async fn save_tags(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let tags = store::normalize_searches(&body(p)?["tags"])?;
    update_tags(&db, tags, false).await
}
/// Adds one tag (`tag`, written the way a booru names it) or one whole search (`search`, whose
/// spaces and operators such as `~`, `-` and `score:>5` are kept).
async fn add_tag(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let body = body(p)?;
    let entry = if body.get("search").is_some() {
        text(&body, "search", 100)?
    } else {
        crate::tags::normalize(&text(&body, "tag", 100)?)
    };
    let tags = store::normalize_searches(&json!([entry]))?;
    update_tags(&db, tags, true).await
}
async fn update_tags(db: &Database, mut tags: Vec<String>, append: bool) -> Result<Json<Value>> {
    db.call(move |c| {
        let tx = c.transaction()?;
        let previous = store::searches(&tx)?;
        if append {
            tags = store::normalize_searches(&json!(previous
                .iter()
                .chain(tags.iter())
                .cloned()
                .collect::<Vec<_>>()))?;
        }
        if previous != tags {
            write_setting(&tx, "subscriptions.tags", &json!(tags))?;
            store::reset(&tx, None, true)?;
        }
        tx.commit()?;
        Ok(Json(json!({"tags":tags})))
    })
    .await
}
async fn follow(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    set_artist(&db, body(p)?, true).await
}
async fn unfollow(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    set_artist(&db, body(p)?, false).await
}
/// Adds or removes one artist in GoonCave's list; the sync then passes it on to FurAffinity.
async fn set_artist(db: &Database, v: Value, desired: bool) -> Result<Json<Value>> {
    let artist = remote::artist(&text(&v, "artist", 50)?)?.to_lowercase();
    // Serialize with refresh: a completed unfollow cannot be overwritten by an old page.
    let _guard = db.subscriptions.lock().await;
    db.call(move |c| {
        let tx = c.transaction()?;
        let mut artists = store::artists(&tx)?;
        let before = artists.len();
        if desired {
            if !artists.contains(&artist) {
                if before >= store::MAX_ARTISTS {
                    return Err(Error::Invalid(format!(
                        "Follow at most {} artists.",
                        store::MAX_ARTISTS
                    )));
                }
                artists.push(artist);
            }
        } else {
            artists.retain(|a| *a != artist);
        }
        if artists.len() != before {
            store::save_artists(&tx, &artists)?;
            store::reset(&tx, None, true)?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    overview(db, true).await
}
/// Followed pools of sites that still exist; a deleted site takes its pools out of view.
async fn pools(State(db): State<Database>) -> Result<Json<Value>> {
    let sites = boorus::sites(&db)
        .await?
        .into_iter()
        .map(|s| s.id)
        .collect::<HashSet<_>>();
    let pools = db.call(|c| store::pools(c)).await?;
    let pools = pools
        .into_iter()
        .filter(|p| sites.contains(&p.site_id))
        .collect::<Vec<_>>();
    Ok(Json(json!({"pools":pools})))
}
fn pool_target(v: &Value) -> Result<(String, String)> {
    let site = text(v, "siteId", 100)?;
    let pool = booru_engines::id(&v["poolId"])
        .map_err(|_| Error::Invalid("Supply a valid poolId.".into()))?;
    Ok((site, pool))
}
async fn follow_pool(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let (site_id, pool_id) = pool_target(&body(p)?)?;
    let site = boorus::site(&db, site_id.clone())
        .await?
        .ok_or_else(|| Error::Invalid("This site no longer exists. Reload Accounts.".into()))?;
    if !matches!(site.engine.as_str(), "e621" | "danbooru") {
        return Err(Error::Invalid("This site has no pools.".into()));
    }
    // Name and cover come from the booru, never from the caller.
    let (pool_id, name, post_count, cover_url) =
        explore::pool_summary(&Transport::default(), &site, &pool_id).await?;
    let followed = store::PoolSubscription {
        site_id,
        site_name: site.name,
        pool_id,
        name,
        post_count,
        cover_url,
    };
    db.call(move |c| {
        let tx = c.transaction()?;
        let mut pools = store::pools(&tx)?;
        if !pools
            .iter()
            .any(|p| p.site_id == followed.site_id && p.pool_id == followed.pool_id)
        {
            if pools.len() >= store::MAX_POOLS {
                return Err(Error::Invalid(format!(
                    "Follow at most {} pools.",
                    store::MAX_POOLS
                )));
            }
            let site = followed.site_id.clone();
            pools.push(followed);
            store::save_pools(&tx, &pools)?;
            store::reset(&tx, Some(&site), false)?;
        }
        tx.commit()?;
        Ok(Json(json!({"pools":pools})))
    })
    .await
}
async fn unfollow_pool(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let (site_id, pool_id) = pool_target(&body(p)?)?;
    db.call(move |c| {
        let tx = c.transaction()?;
        let mut pools = store::pools(&tx)?;
        let before = pools.len();
        pools.retain(|p| !(p.site_id == site_id && p.pool_id == pool_id));
        if pools.len() != before {
            store::save_pools(&tx, &pools)?;
            store::reset(&tx, Some(&site_id), false)?;
        }
        tx.commit()?;
        Ok(Json(json!({"pools":pools})))
    })
    .await
}
async fn bookmark(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let v = body(p)?;
    let site = text(&v, "siteId", 100)?;
    let id = text(&v, "remoteId", 50)?;
    booru_engines::id(&json!(id)).map_err(|_| Error::Invalid("Supply a valid post ID.".into()))?;
    let saved = db
        .call(move |c| store::save_bookmark(c, &site, &id))
        .await?;
    if !saved {
        return Err(Error::Invalid(
            "The post is no longer in the feed. Refresh subscriptions.".into(),
        ));
    }
    Ok(Json(json!({"ok":true})))
}
async fn feed(
    State(db): State<Database>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let limit = q
        .get("limit")
        .map(|s| {
            s.parse::<usize>()
                .ok()
                .filter(|n| (1..=100).contains(n))
                .ok_or_else(|| Error::Invalid("limit must be from 1 through 100.".into()))
        })
        .transpose()?
        .unwrap_or(PAGE_SIZE);
    let cursor = q
        .get("cursor")
        .filter(|s| !s.is_empty())
        .map(|s| Cursor::decode(s))
        .transpose()?;
    let resume = match q.get("resume").map(String::as_str) {
        None | Some("0") => false,
        Some("1") => true,
        _ => return Err(Error::Invalid("resume must be 0 or 1.".into())),
    };
    let wanted = match q.get("sites") {
        Some(raw) if raw.len() <= 2000 => Some(
            raw.split(|c: char| c == ',' || c.is_whitespace())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect::<HashSet<_>>(),
        ),
        Some(_) => return Err(Error::Invalid("The site selection is too long.".into())),
        None => None,
    };
    let sites = boorus::sites(&db)
        .await?
        .into_iter()
        .filter(|s| s.enabled && wanted.as_ref().is_none_or(|ids| ids.contains(&s.id)))
        .collect::<Vec<_>>();
    let ids = sites.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    let page = db
        .call(move |c| {
            let (cursor, inclusive) = if resume && cursor.is_none() {
                let bookmark = store::bookmark(c)?.filter(|b| ids.contains(&b.site));
                (bookmark, true)
            } else {
                (cursor, false)
            };
            store::list(c, &ids, cursor, inclusive, limit)
        })
        .await?;
    let key = explore::media_key(&db).await?;
    let mut grouped = HashMap::<String, Vec<Value>>::new();
    let mut order = Vec::new();
    for (site, post) in page.items {
        order.push((site.clone(), post["remoteId"].as_str().unwrap().to_owned()));
        grouped.entry(site).or_default().push(post);
    }
    let mut decorated = HashMap::new();
    for site in sites {
        if let Some(posts) = grouped.remove(&site.id) {
            for post in explore::decorate(&db, &site, posts, &key).await? {
                decorated.insert(
                    (
                        site.id.clone(),
                        post["remoteId"].as_str().unwrap().to_owned(),
                    ),
                    post,
                );
            }
        }
    }
    let posts = order
        .into_iter()
        .filter_map(|key| decorated.remove(&key))
        .collect::<Vec<_>>();
    Ok(Json(
        json!({"posts":posts,"hasMore":page.has_more,"nextCursor":page.next,"ready":page.ready}),
    ))
}
async fn refresh_route(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let v = body(p)?;
    let rounds = match v.get("rounds") {
        None => 1,
        Some(n) => n
            .as_u64()
            .filter(|n| (1..=4).contains(n))
            .ok_or_else(|| Error::Invalid("rounds must be from 1 through 4.".into()))?,
    };
    Ok(Json(
        refresh(&db, &Transport::default(), rounds, false).await?,
    ))
}
pub(crate) async fn watch(db: Database) {
    let mut interval = tokio::time::interval(REFRESH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match refresh(&db, &Transport::default(), 1, true).await {
            Ok(result) => {
                if result["errors"].as_array().is_some_and(|a| !a.is_empty()) {
                    eprintln!("Subscription refresh failed: {result}");
                }
            }
            Err(e) => eprintln!("Subscription refresh could not run: {e}"),
        }
    }
}
async fn saved_errors(db: &Database) -> Result<Value> {
    db.call(|c| {
        let mut s=c.prepare("SELECT site.id,site.name,state.last_error FROM subscription_feed_sync_state state
            JOIN user_booru_sites site ON site.id=state.site_id WHERE state.user_id=?1 AND site.enabled=1 AND state.last_error IS NOT NULL")?;
        let errors=s.query_map([OWNER_ID],|r| Ok(crate::booru_http::site_error(&r.get::<_,String>(0)?,&r.get::<_,String>(1)?,&r.get::<_,String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"errors":errors}))
    }).await
}
/// `background` leaves out sites whose pages only GoonCave's browser can load: each refresh
/// would start a browser process, and the feed refreshes them when it opens.
async fn refresh(db: &Database, t: &Transport, rounds: u64, background: bool) -> Result<Value> {
    let _guard = match db.subscriptions.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            let _wait = db.subscriptions.lock().await;
            return saved_errors(db).await;
        }
    };
    let sites = boorus::sites(db)
        .await?
        .into_iter()
        .filter(|s| s.enabled && !(background && crate::browser::site(&s.base).is_some()))
        .collect::<Vec<_>>();
    for error in sync_artists(db, t, &sites).await? {
        eprintln!("[developer] FurAffinity watchlist sync failed: {error}");
    }
    let (tags, artists, pools, generation) = db
        .call(|c| {
            let cutoff = (time::OffsetDateTime::now_utc() - time::Duration::days(RETENTION_DAYS))
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|e| Error::Storage(e.to_string()))?;
            c.execute(
                "DELETE FROM subscription_feed_items WHERE user_id=?1 AND sort_at<?2",
                params![OWNER_ID, store::timestamp(&cutoff)?],
            )?;
            Ok((
                store::searches(c)?,
                store::artists(c)?,
                store::pools(c)?,
                store::generation(c)?,
            ))
        })
        .await?;
    for _ in 0..rounds {
        let mut queued = sites.iter();
        let mut pending = tokio::task::JoinSet::new();
        loop {
            while pending.len() < 4 {
                let Some(site) = queued.next().cloned() else {
                    break;
                };
                let db = db.clone();
                let t = t.clone();
                let tags = site_searches(&tags, &artists, &pools, &site);
                pending.spawn(async move {
                    let result = refresh_site(&db, &t, &site, &tags, generation).await;
                    (site, result)
                });
            }
            let Some(result) = pending.join_next().await else {
                break;
            };
            let (site, result) =
                result.map_err(|e| Error::Storage(format!("Subscription task failed: {e}")))?;
            if let Err(e) = result {
                let error = match e {
                    Error::Invalid(_) | Error::Remote(_) | Error::Refused { .. } => e.to_string(),
                    _ => {
                        eprintln!("Subscription storage failed: {e}");
                        "The feed could not be saved. Check disk space and folder permissions, then retry.".into()
                    }
                };
                db.call(move |c| {
                    if store::generation(c)? == generation && site_current(c, &site)? {
                        store::save_state(c, &site.id, &store::state(c, &site.id)?, Some(&error))?;
                    }
                    Ok(())
                })
                .await?;
            }
        }
    }
    saved_errors(db).await
}
fn site_current(c: &rusqlite::Connection, site: &Site) -> Result<bool> {
    let updated: Option<String> = c
        .query_row(
            "SELECT updated_at FROM user_booru_sites WHERE user_id=?1 AND id=?2 AND enabled=1",
            params![OWNER_ID, site.id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(updated.as_deref() == site.public["updatedAt"].as_str())
}
async fn commit(
    db: &Database,
    site: &Site,
    posts: Vec<Value>,
    state: Option<SyncState>,
    generation: u64,
) -> Result<bool> {
    let site = site.clone();
    db.call(move |c| {
        let tx = c.transaction()?;
        if store::generation(&tx)? != generation || !site_current(&tx, &site)? {
            return Ok(false);
        }
        store::insert(&tx, &site.id, &posts)?;
        if let Some(state) = state {
            store::save_state(&tx, &site.id, &state, None)?;
        }
        tx.commit()?;
        Ok(true)
    })
    .await
}
/// The saved searches, then each followed artist, then `pool:ID` for each pool followed on the
/// site. `batch` sends a `pool:` search alone, since it contains `:`.
fn site_searches(
    tags: &[String],
    artists: &[String],
    pools: &[store::PoolSubscription],
    site: &Site,
) -> Vec<String> {
    tags.iter()
        // A leading `-` or `~` would turn the name into an exclusion or an OR on the boorus.
        .chain(artists.iter().filter(|a| !a.starts_with(['-', '~'])))
        .cloned()
        .chain(
            pools
                .iter()
                .filter(|p| p.site_id == site.id)
                .map(|p| format!("pool:{}", p.pool_id)),
        )
        .collect()
}
fn batch(tags: &[String], start: usize, size: usize) -> (Vec<String>, usize, bool) {
    if tags.is_empty() {
        return (vec![], 0, false);
    }
    let start = start % tags.len();
    let expression = |s: &str| {
        s.chars().any(char::is_whitespace) || s.contains(':') || s.starts_with(['-', '~'])
    };
    let limit = if expression(&tags[start]) {
        1
    } else {
        size.min(tags.len())
    };
    let mut result = Vec::new();
    while result.len() < limit {
        let tag = &tags[(start + result.len()) % tags.len()];
        if !result.is_empty() && expression(tag) {
            break;
        }
        result.push(tag.clone());
    }
    let count = result.len();
    (
        result,
        (start + count) % tags.len(),
        start + count >= tags.len(),
    )
}
async fn search_page(
    t: &Transport,
    site: &Site,
    mut tags: Vec<String>,
    page: usize,
) -> Result<Vec<Value>> {
    if matches!(site.engine.as_str(), "e621" | "danbooru") && tags.len() > 1 {
        tags = tags.into_iter().map(|s| format!("~{s}")).collect();
    }
    booru_engines::search(
        t,
        site,
        &Search {
            tags,
            page,
            limit: PAGE_SIZE,
            ..Search::default()
        },
    )
    .await
}
async fn refresh_site(
    db: &Database,
    t: &Transport,
    site: &Site,
    tags: &[String],
    generation: u64,
) -> Result<()> {
    let id = site.id.clone();
    let mut state = db.call(move |c| store::state(c, &id)).await?;
    if site.engine == "furaffinity" {
        return refresh_fa(db, t, site, state, generation).await;
    }
    if tags.is_empty() {
        state.exhausted = true;
        commit(db, site, vec![], Some(state), generation).await?;
        return Ok(());
    }
    let size = match site.engine.as_str() {
        "e621" => 40,
        "danbooru" => 2,
        _ => 1,
    };
    let (head, next, _) = batch(tags, state.head, size);
    let posts = search_page(t, site, head, 1).await?;
    state.head = next;
    if !commit(db, site, posts, None, generation).await? {
        return Ok(());
    }
    for _ in 1..MAX_QUERIES {
        if state.exhausted {
            break;
        }
        if state.page > MAX_PAGE {
            return Err(crate::booru_http::remote(
                "The feed reached the site's pagination limit. Narrow your subscribed searches.",
            ));
        }
        let (tags, next, wrapped) = batch(tags, state.tag, size);
        let posts = search_page(t, site, tags, state.page).await?;
        state.page_had_posts |= !posts.is_empty();
        state.tag = next;
        if wrapped {
            state.exhausted = !state.page_had_posts;
            if !state.exhausted {
                state.page += 1;
            }
            state.page_had_posts = false;
        }
        if !commit(db, site, posts, Some(state.clone()), generation).await? {
            return Ok(());
        }
        if wrapped {
            break;
        }
    }
    commit(db, site, vec![], Some(state), generation).await?;
    Ok(())
}
async fn known(db: &Database, site: &Site, posts: Option<Vec<Value>>) -> Result<bool> {
    let id = site.id.clone();
    db.call(move |c| store::has_posts(c, &id, posts.as_deref()))
        .await
}
async fn refresh_fa(
    db: &Database,
    t: &Transport,
    site: &Site,
    mut state: SyncState,
    generation: u64,
) -> Result<()> {
    let had_posts = known(db, site, None).await?;
    let (posts, next) = remote::page(t, site, None).await?;
    let reached = known(db, site, Some(posts.clone())).await?;
    if !commit(db, site, posts, None, generation).await? {
        return Ok(());
    }
    if state.head_cursor.is_none() && had_posts && !reached {
        state.head_cursor = next.clone();
    }
    let mut visited = HashSet::new();
    for _ in 0..2 {
        let Some(cursor) = state.head_cursor.clone() else {
            break;
        };
        if !visited.insert(cursor.clone()) {
            return Err(crate::booru_http::remote(
                "FurAffinity repeated its feed cursor. Try again later.",
            ));
        }
        let (posts, next) = remote::page(t, site, Some(&cursor)).await?;
        let reached = known(db, site, Some(posts.clone())).await?;
        state.head_cursor = if reached { None } else { next };
        if !commit(db, site, posts, Some(state.clone()), generation).await? {
            return Ok(());
        }
    }
    if let Some(cursor) = state.cursor.clone().filter(|_| !state.feed_exhausted) {
        if state.page > MAX_PAGE {
            return Err(crate::booru_http::remote("The FurAffinity feed reached its pagination limit. Open older submissions on the original site."));
        }
        let (posts, next) = remote::page(t, site, Some(&cursor)).await?;
        state.cursor = next;
        state.feed_exhausted = state.cursor.is_none();
        state.page += 1;
        commit(db, site, posts, Some(state), generation).await?;
    } else {
        if !state.feed_exhausted {
            state.cursor = next;
            state.feed_exhausted = state.cursor.is_none();
        }
        commit(db, site, vec![], Some(state), generation).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Request, response::IntoResponse, routing::any};
    use std::sync::{Arc, Mutex};

    async fn fixture() -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let app=Router::new().fallback(any(move |request:Request| {
            let requests=captured.clone();
            async move {
                let query=request.uri().query().unwrap_or("").to_owned();
                requests.lock().unwrap().push(query.clone());
                let url=reqwest::Url::parse(&format!("https://fixture.example/?{query}")).unwrap();
                let params=url.query_pairs().collect::<HashMap<_,_>>();
                let page=params.get("page").map(|s| s.as_ref()).unwrap_or("1");
                let rows=if page=="1" || page=="2" {vec![json!({"id":page.parse::<u64>().unwrap(),
                    "file":{"url":"https://cdn.example.com/post.jpg","ext":"jpg"},
                    "preview":{"url":"https://cdn.example.com/preview.jpg"},"tags":{"artist":["fixture_artist"]},
                    "created_at":"2026-10-12T00:00:00Z","relationships":{},"pools":[]})]} else {vec![]};
                Json(json!({"posts":rows})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (base, requests, task)
    }
    async fn setup(db: &Database, base: String) -> Site {
        db.call(|c| {
            c.execute("INSERT INTO user_booru_sites(id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at)
                VALUES ('fixture',?1,'Fixture','e621','https://fixture.example',0,1,0,'2026-10-12','2026-10-12')",[OWNER_ID])?;Ok(())
        }).await.unwrap();
        let mut site = boorus::site(db, "fixture".into()).await.unwrap().unwrap();
        site.base = base;
        site
    }
    #[tokio::test]
    async fn subscription_refresh_keeps_compound_searches_and_backfills_without_moving_posts() {
        let (base, requests, task) = fixture().await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        let t = Transport {
            allow_loopback: true,
        };
        let tags = vec![
            "fixture_artist score:>10".into(),
            "fox".into(),
            "wolf".into(),
        ];
        refresh_site(&db, &t, &site, &tags, 0).await.unwrap();
        let state = db.call(|c| store::state(c, "fixture")).await.unwrap();
        assert_eq!(state.page, 3);
        assert_eq!(state.head, 1);
        let queries = requests.lock().unwrap().clone();
        let decoded = queries
            .iter()
            .map(|q| {
                reqwest::Url::parse(&format!("https://fixture.example/?{q}"))
                    .unwrap()
                    .query_pairs()
                    .find(|(k, _)| k == "tags")
                    .unwrap()
                    .1
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            decoded,
            vec![
                "fixture_artist score:>10",
                "fixture_artist score:>10",
                "~fox ~wolf"
            ]
        );
        let first = db
            .call(|c| store::list(c, &["fixture".into()], None, false, 10))
            .await
            .unwrap();
        assert_eq!(first.items.len(), 2);
        let cursor = first.next.clone();
        refresh_site(&db, &t, &site, &tags, 0).await.unwrap();
        let state = db.call(|c| store::state(c, "fixture")).await.unwrap();
        assert!(state.exhausted);
        let second = db
            .call(|c| store::list(c, &["fixture".into()], None, false, 10))
            .await
            .unwrap();
        assert_eq!(cursor, second.next);
        assert_eq!(first.items, second.items);
        task.abort();
    }
    #[tokio::test]
    async fn subscription_reset_and_site_changes_refuse_late_pages_and_favorite_overrides_survive_refresh(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, "https://fixture.example".into()).await;
        let post = json!({"remoteId":"7","previewUrl":"https://cdn.example.com/post.jpg","sampleUrl":null,"fileUrl":null,
            "createdAt":"2026-10-12T00:00:00Z","tags":[],"favorited":true});
        assert!(commit(
            &db,
            &site,
            vec![post.clone()],
            Some(SyncState::default()),
            0
        )
        .await
        .unwrap());
        store::favorite_override(&db, "fixture", "7", false)
            .await
            .unwrap();
        assert!(commit(&db, &site, vec![post.clone()], None, 0)
            .await
            .unwrap());
        let page = db
            .call(|c| store::list(c, &["fixture".into()], None, false, 10))
            .await
            .unwrap();
        assert_eq!(page.items[0].1["favorited"], false);
        db.call(|c| {
            let tx = c.transaction()?;
            store::reset(&tx, None, true)?;
            tx.commit()?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(!commit(
            &db,
            &site,
            vec![post.clone()],
            Some(SyncState::default()),
            0
        )
        .await
        .unwrap());
        assert!(!known(&db, &site, None).await.unwrap());
        db.call(|c| {
            c.execute(
                "UPDATE user_booru_sites SET updated_at='2026-10-13' WHERE id='fixture'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            !commit(&db, &site, vec![post], Some(SyncState::default()), 1)
                .await
                .unwrap()
        );
    }
    #[test]
    fn subscription_batches_rotate_simple_tags_and_isolate_expressions() {
        let tags = vec!["fox".into(), "wolf".into(), "bird score:>10".into()];
        assert_eq!(
            batch(&tags, 0, 40),
            (vec!["fox".into(), "wolf".into()], 2, false)
        );
        assert_eq!(
            batch(&tags, 2, 40),
            (vec!["bird score:>10".into()], 0, true)
        );
        assert_eq!(batch(&tags, 1, 1), (vec!["wolf".into()], 2, false));
        let operators = vec![
            "score:>10".into(),
            "-photo".into(),
            "~wolf".into(),
            "fox".into(),
        ];
        assert_eq!(
            batch(&operators, 0, 40),
            (vec!["score:>10".into()], 1, false)
        );
        assert_eq!(batch(&operators, 1, 40), (vec!["-photo".into()], 2, false));
        assert_eq!(batch(&operators, 2, 40), (vec!["~wolf".into()], 3, false));
    }
    #[tokio::test]
    async fn subscription_fa_backfill_recovers_after_an_interrupted_first_page_or_initial_error() {
        let app=Router::new().fallback(any(|| async {
            axum::response::Html("<div id='messagecenter-submissions'><figure id='sid-7'><img src='https://t.furaffinity.net/7-1791763200.jpg'></figure><a class='more' href='/msg/submissions/new~7@48/'>Next</a></div>")
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        setup(&db, base.clone()).await;
        db.call(|c| {c.execute("UPDATE user_booru_sites SET engine='furaffinity',username='fixture-owner',session_cookie='a=fake;b=fake' WHERE id='fixture'",[])?;Ok(())}).await.unwrap();
        let mut site = boorus::site(&db, "fixture".into()).await.unwrap().unwrap();
        site.base = base;
        let t = Transport {
            allow_loopback: true,
        };
        let (posts, _) = remote::page(&t, &site, None).await.unwrap();
        assert!(commit(&db, &site, posts, None, 0).await.unwrap());
        refresh_site(&db, &t, &site, &[], 0).await.unwrap();
        assert_eq!(
            db.call(|c| store::state(c, "fixture"))
                .await
                .unwrap()
                .cursor
                .as_deref(),
            Some("/msg/submissions/new~7@48/")
        );
        db.call(|c| {
            let tx = c.transaction()?;
            store::reset(&tx, None, false)?;
            store::save_state(
                &tx,
                "fixture",
                &SyncState::default(),
                Some("Temporary network failure"),
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
        .unwrap();
        refresh_site(&db, &t, &site, &[], 1).await.unwrap();
        assert_eq!(
            db.call(|c| store::state(c, "fixture"))
                .await
                .unwrap()
                .cursor
                .as_deref(),
            Some("/msg/submissions/new~7@48/")
        );
        task.abort();
    }
    #[tokio::test]
    async fn a_site_that_keeps_failing_does_not_hide_the_feed_of_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        setup(&db, "https://fixture.example".into()).await;
        let page = db
            .call(|c| {
                let state = store::state(c, "fixture")?;
                store::save_state(
                    c,
                    "fixture",
                    &state,
                    Some("The site returned an unexpected response."),
                )?;
                let first = store::list(c, &["fixture".into()], None, false, 10)?;
                let cursor = store::Cursor {
                    sort: "2026-10-01T00:00:00.000Z".into(),
                    discovered: "2026-10-01T00:00:00.000Z".into(),
                    site: "other".into(),
                    remote: "1".into(),
                };
                let older = store::list(c, &["fixture".into()], Some(cursor), true, 10)?;
                Ok((first.ready, older.ready))
            })
            .await
            .unwrap();
        assert_eq!(page, (true, true));
    }
    #[test]
    fn a_followed_pool_is_searched_alone_and_only_on_its_own_site() {
        let site = |id: &str| Site {
            id: id.into(),
            name: id.into(),
            engine: "e621".into(),
            base: String::new(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let pools = vec![store::PoolSubscription {
            site_id: "with-pool".into(),
            site_name: "e621".into(),
            pool_id: "7".into(),
            name: "Fox Comic".into(),
            post_count: 2,
            cover_url: None,
        }];
        let tags = vec!["fox".to_owned(), "cat".to_owned()];
        let artists = vec!["rukis".to_owned(), "-dash".to_owned(), "~tilde".to_owned()];
        let own = site_searches(&tags, &artists, &pools, &site("with-pool"));
        assert_eq!(own, ["fox", "cat", "rukis", "pool:7"]);
        assert_eq!(
            site_searches(&tags, &artists, &pools, &site("other")),
            ["fox", "cat", "rukis"]
        );
        assert_eq!(batch(&own, 0, 40).0, ["fox", "cat", "rukis"]);
        assert_eq!(batch(&own, 3, 40).0, ["pool:7"]);
    }
    #[tokio::test]
    async fn a_pool_summary_reads_name_page_count_and_first_page_cover() {
        let app = Router::new().fallback(any(|request: Request| async move {
            if request.uri().path() == "/pools/7.json" {
                return Json(json!({"id":7,"name":"Fox_Comic_","post_ids":[11,12]})).into_response();
            }
            Json(json!({"posts":[{"id":11,"file":{"url":"https://cdn.example.com/11.jpg","ext":"jpg"},
                "preview":{"url":"https://cdn.example.com/11-preview.jpg"},"tags":{},
                "created_at":"2026-10-12T00:00:00Z","relationships":{},"pools":[7]}]}))
            .into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        let t = Transport {
            allow_loopback: true,
        };
        let summary = explore::pool_summary(&t, &site, "7").await.unwrap();
        assert_eq!(
            summary,
            (
                "7".into(),
                "Fox Comic".into(),
                2,
                Some("https://cdn.example.com/11-preview.jpg".into())
            )
        );
        task.abort();
    }

    type Watched = Arc<Mutex<std::collections::BTreeSet<String>>>;
    /// A FurAffinity account that watches `watched`. Only `known` artists have a page. With
    /// `replace_on_watch`, every watch request first replaces the stored artist list.
    async fn fake_fa(
        watched: &[&str],
        known: &[&str],
        replace_on_watch: Option<Database>,
    ) -> (Site, Watched, tokio::task::JoinHandle<()>) {
        let state: Watched = Arc::new(Mutex::new(watched.iter().map(|s| s.to_string()).collect()));
        let shared = state.clone();
        let known: Vec<String> = known.iter().map(|s| s.to_string()).collect();
        let app = Router::new().fallback(any(move |request: Request| {
            let (state, known, db) = (shared.clone(), known.clone(), replace_on_watch.clone());
            async move {
                let path = request.uri().path().to_owned();
                match path.trim_matches('/').split('/').collect::<Vec<_>>()[..] {
                    ["watchlist", "by", _] => {
                        let links: String = state.lock().unwrap().iter().map(|n| format!("<a href='/user/{n}/'>{n}</a>")).collect();
                        axum::response::Html(format!("<title>Buddy list -- Fur Affinity [dot] net</title>{links}")).into_response()
                    }
                    ["user", name] if known.iter().any(|k| k == name) => {
                        let prefix = if state.lock().unwrap().contains(name) { "un" } else { "" };
                        axum::response::Html(format!("<div id='pageid-userpage'><a href='/{prefix}watch/{name}/?key=abc'>Watch</a></div>")).into_response()
                    }
                    ["user", _] => axum::response::Html("<div id='pageid-browse'></div>").into_response(),
                    ["watch", name] => {
                        state.lock().unwrap().insert(name.to_owned());
                        if let Some(db) = db {
                            db.call(|c| store::save_artists(c, &["replaced".to_owned()])).await.unwrap();
                        }
                        axum::response::Html("ok").into_response()
                    }
                    ["unwatch", name] => {
                        state.lock().unwrap().remove(name);
                        axum::response::Html("ok").into_response()
                    }
                    _ => axum::http::StatusCode::NOT_FOUND.into_response(),
                }
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
        (site, state, task)
    }
    fn watching(fa: &Watched) -> Vec<String> {
        fa.lock().unwrap().iter().cloned().collect()
    }
    async fn save_local(db: &Database, artists: &[&str]) {
        let artists: Vec<String> = artists.iter().map(|s| s.to_string()).collect();
        db.call(move |c| store::save_artists(c, &artists))
            .await
            .unwrap();
    }
    async fn local_and_seen(db: &Database) -> (Vec<String>, Option<Vec<String>>) {
        db.call(|c| Ok((store::artists(c)?, store::seen_artists(c, "fixture")?)))
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn the_first_artist_sync_imports_the_watchlist_and_watches_local_only_artists() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (site, fa, task) = fake_fa(
            &["artist-a", "artist-b"],
            &["artist-a", "artist-b", "local-only"],
            None,
        )
        .await;
        let t = Transport {
            allow_loopback: true,
        };
        save_local(&db, &["local-only"]).await;
        let errors = sync_artists(&db, &t, &[site]).await.unwrap();
        assert!(errors.is_empty());
        assert_eq!(watching(&fa), ["artist-a", "artist-b", "local-only"]);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, ["local-only", "artist-a", "artist-b"]);
        assert_eq!(seen.unwrap(), ["artist-a", "artist-b", "local-only"]);
        task.abort();
    }
    #[tokio::test]
    async fn after_a_sync_removals_on_either_side_reach_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (site, fa, task) = fake_fa(
            &["artist-a", "artist-b", "artist-c"],
            &["artist-a", "artist-b", "artist-c"],
            None,
        )
        .await;
        let t = Transport {
            allow_loopback: true,
        };
        let sites = [site];
        assert!(sync_artists(&db, &t, &sites).await.unwrap().is_empty());
        save_local(&db, &["artist-a", "artist-c"]).await;
        fa.lock().unwrap().remove("artist-c");
        let errors = sync_artists(&db, &t, &sites).await.unwrap();
        assert!(errors.is_empty());
        assert_eq!(watching(&fa), ["artist-a"]);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, ["artist-a"]);
        assert_eq!(seen.unwrap(), ["artist-a"]);
        task.abort();
    }
    #[tokio::test]
    async fn an_artist_furaffinity_does_not_know_is_reported_and_does_not_stop_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (site, fa, task) = fake_fa(&["existing"], &["existing", "real"], None).await;
        let t = Transport {
            allow_loopback: true,
        };
        save_local(&db, &["ghost", "real"]).await;
        let errors = sync_artists(&db, &t, &[site]).await.unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["siteId"], "fixture");
        assert!(errors[0]["error"].as_str().unwrap().starts_with("ghost: "));
        assert_eq!(watching(&fa), ["existing", "real"]);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, ["ghost", "real", "existing"]);
        assert_eq!(seen.unwrap(), ["existing", "real"]);
        task.abort();
    }
    #[tokio::test]
    async fn a_list_replaced_during_the_sync_is_kept_and_the_watchlist_snapshot_is_not_saved() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (site, fa, task) = fake_fa(&[], &["local"], Some(db.clone())).await;
        let t = Transport {
            allow_loopback: true,
        };
        save_local(&db, &["local"]).await;
        db.call(|c| store::save_seen_artists(c, "fixture", &["kept".to_owned()]))
            .await
            .unwrap();
        let errors = sync_artists(&db, &t, &[site]).await.unwrap();
        assert!(errors.is_empty());
        assert_eq!(watching(&fa), ["local"]);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, ["replaced"]);
        assert_eq!(seen.unwrap(), ["kept"]);
        task.abort();
    }
}
