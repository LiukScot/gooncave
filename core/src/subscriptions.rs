use crate::{
    booru_engines::{self, Search},
    booru_http::{Transport, USER_NOT_FOUND},
    boorus::{self, Site},
    db::{write_setting, Database},
    explore, subscription_remote as remote, subscription_store as store, Error, Result,
};
use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const PAGE_SIZE: usize = 40;
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
    // A running sync (the feed's first page, or a follow) covers the watchlists; the page must
    // not wait for it.
    let guard = db.subscriptions.try_lock().ok();
    overview(&db, guard.is_some()).await
}
/// Whether a feed post carrying `post_tags` (normalized) matches the saved search `entry`.
/// Meta terms (`score:>5`) and exclusions (`-x`) are ignored; an entry with no positive term
/// matches nothing (shortcut: the real query semantics live on each site).
fn matches_search(entry: &str, post_tags: &HashSet<String>) -> bool {
    let (mut all, mut any, mut optional, mut positive) = (true, false, false, false);
    for term in entry.split_whitespace() {
        if term.starts_with('-') || term.contains(':') {
            continue;
        }
        positive = true;
        match term.strip_prefix('~') {
            Some(tag) => {
                optional = true;
                any |= post_tags.contains(&crate::tags::normalize(tag));
            }
            None => all &= post_tags.contains(&crate::tags::normalize(term)),
        }
    }
    positive && all && (any || !optional)
}
/// The ids of the enabled sites where each saved search and artist has had results in the feed
/// (see [`record_site_hits`]), read without any request. FurAffinity sites count an artist from
/// the watchlist snapshot.
fn site_hits(
    c: &rusqlite::Connection,
    sites: &[Site],
    entries: &[&String],
) -> Result<HashMap<String, Vec<String>>> {
    let seen = store::site_hits(c)?;
    let mut hits: HashMap<String, Vec<String>> = HashMap::new();
    for site in sites.iter().filter(|s| s.enabled) {
        let fa = (site.engine == "furaffinity")
            .then(|| store::seen_artists(c, &site.id))
            .transpose()?
            .map(Option::unwrap_or_default);
        for entry in entries {
            let found = match &fa {
                Some(watched) => watched.contains(*entry),
                None => seen.get(*entry).is_some_and(|ids| ids.contains(&site.id)),
            };
            if found {
                hits.entry((*entry).clone())
                    .or_default()
                    .push(site.id.clone());
            }
        }
    }
    Ok(hits)
}
/// The saved searches that name one artist: a single plain tag that the tag vocabulary and the
/// library call an artist, or do not know at all. Booru artists are most single-tag searches, and
/// a tag the vocabulary files as a species, character or anything else (`cat`) stays a search.
/// They stay searches in storage: only FurAffinity users go in the artist list, which is synced
/// with each FurAffinity watchlist.
fn artist_searches(c: &rusqlite::Connection, tags: &[String]) -> Result<Vec<String>> {
    let mut s = c.prepare(
        "SELECT EXISTS(SELECT 1 FROM tag_categories WHERE tag=?1 AND category='artist')
            OR EXISTS(SELECT 1 FROM file_tags WHERE canonical_tag=?1 AND category='artist')
            OR NOT (EXISTS(SELECT 1 FROM tag_categories WHERE tag=?1)
                OR EXISTS(SELECT 1 FROM file_tags WHERE canonical_tag=?1))",
    )?;
    let mut artists = Vec::new();
    for tag in tags {
        if tag.contains([' ', ':', '*']) || tag.starts_with(['-', '~']) {
            continue;
        }
        if s.query_row([tag], |r| r.get(0))? {
            artists.push(tag.clone());
        }
    }
    Ok(artists)
}
/// The saved searches and artists, with `siteHits`: the enabled sites where each has results, and
/// `artistSearches` (see [`artist_searches`]).
/// With `sync`, each FurAffinity account's watchlist is first merged into the artists; the
/// caller holds the `subscriptions` lock.
async fn overview(db: &Database, sync: bool) -> Result<Json<Value>> {
    let sites = boorus::sites(db).await?;
    let errors = if sync {
        sync_artists(db, &Transport::default(), &sites).await?
    } else {
        vec![]
    };
    let (tags, artists, hits, artist_searches) = db
        .call(move |c| {
            let (tags, artists) = (store::searches(c)?, store::artists(c)?);
            let entries: Vec<&String> = tags.iter().chain(&artists).collect();
            let hits = site_hits(c, &sites, &entries)?;
            let artist_searches = artist_searches(c, &tags)?;
            Ok((tags, artists, hits, artist_searches))
        })
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
        json!({"tags":tags,"artists":artists,"artistSearches":artist_searches,"siteHits":hits,"artistErrors":errors,"targets":targets}),
    ))
}
/// Follow changes refused in a row before one account's sync stops for this round.
const MAX_FOLLOW_FAILURES: usize = 3;
/// Settings unfollows one artist and syncs at once, so more than this many removals in one sync
/// means the local list was lost or emptied (a restored backup, a sync gone wrong), not chosen.
const MAX_UNWATCH_AT_ONCE: usize = 3;
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
        let mut plan = store::reconcile(&watched, seen.as_deref(), &local);
        if plan.unwatch.len() > MAX_UNWATCH_AT_ONCE {
            eprintln!(
                "[developer] The artist list lost {} FurAffinity artists at once; they are imported again instead of unwatched",
                plan.unwatch.len()
            );
            errors.push(failed(&Error::Invalid(format!(
                "{} artists left the list at once, so they were added back instead of unwatched on FurAffinity. Unfollow them one at a time.",
                plan.unwatch.len()
            ))));
            // Only the lost artists come back: the rest of the plan stays, so an artist unwatched
            // on FurAffinity since the last sync is not watched again.
            plan.local.append(&mut plan.unwatch);
        }
        if plan.local.len() > store::MAX_ARTISTS {
            // Saving it would leave a list GoonCave refuses to read back.
            errors.push(failed(&Error::Invalid(format!(
                "Importing this watchlist would pass {} followed artists. Unfollow some, then reload.",
                store::MAX_ARTISTS
            ))));
            continue;
        }
        let mut now = watched;
        let mut missing = Vec::new();
        let mut failures_in_a_row = 0;
        for (artist, watch) in plan
            .watch
            .iter()
            .map(|a| (a, true))
            .chain(plan.unwatch.iter().map(|a| (a, false)))
        {
            if let Err(e) = remote::set_artist(t, site, artist, watch).await {
                // Not on FurAffinity: the name stays a search on the boorus and is no failure.
                if matches!(e, Error::Refused { code, .. } if code == USER_NOT_FOUND) {
                    if watch {
                        missing.push(artist.clone());
                    }
                    continue;
                }
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
            if watch {
                now.push(artist.clone());
            } else {
                now.retain(|a| a != artist);
            }
        }
        let id = site.id.clone();
        db.call(move |c| {
            let tx = c.transaction()?;
            // Device sync may have replaced the list during the requests above. Saving would
            // drop that change, and saving the watchlist alone would read its new artists as
            // removed here next time; both wait for the next sync, which starts from the new list.
            if store::artists(&tx)? == local {
                plan.local.retain(|a| !missing.contains(a));
                if plan.local != local {
                    store::save_artists(&tx, &plan.local)?;
                    if !missing.is_empty() {
                        eprintln!(
                            "[developer] {} followed artists are not on FurAffinity and are now searches",
                            missing.len()
                        );
                        let searches = store::searches(&tx)?;
                        let searches = searches.iter().chain(&missing).collect::<Vec<_>>();
                        write_setting(
                            &tx,
                            "subscriptions.tags",
                            &json!(store::normalize_searches(&json!(searches))?),
                        )?;
                    }
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
/// spaces and operators such as `~`, `-` and `score:>5` are kept). A single name that is an artist
/// is followed as an artist instead (see `follows_as_artist`); `artist: true` says the caller
/// already knows it is one.
async fn add_tag(State(db): State<Database>, p: Payload) -> Result<Json<Value>> {
    let body = body(p)?;
    let entry = if body.get("search").is_some() {
        text(&body, "search", 100)?
    } else {
        crate::tags::normalize(&text(&body, "tag", 100)?)
    };
    let tags = store::normalize_searches(&json!([entry]))?;
    if follows_as_artist(&db, &tags[0], body["artist"] == true).await? {
        return set_artist(&db, json!({"artist":tags[0]}), true).await;
    }
    update_tags(&db, tags, true).await
}
/// Whether `entry` is one plain name (no spaces, `~`, `-` or `:` operators) that FurAffinity can
/// follow and that `hinted` or the tag vocabulary or the library's own tags call an artist.
async fn follows_as_artist(db: &Database, entry: &str, hinted: bool) -> Result<bool> {
    if entry.contains([' ', ':']) || entry.starts_with(['-', '~']) || remote::artist(entry).is_err()
    {
        return Ok(false);
    }
    if hinted {
        return Ok(true);
    }
    let tag = entry.to_owned();
    db.call(move |c| {
        Ok(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM tag_categories WHERE tag=?1 AND category='artist')
                OR EXISTS(SELECT 1 FROM file_tags WHERE canonical_tag=?1 AND category='artist')",
            [&tag],
            |r| r.get(0),
        )?)
    })
    .await
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
        }
        let artists = store::artists(&tx)?;
        tx.commit()?;
        Ok(Json(json!({"tags":tags,"artists":artists})))
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
    // Serialize with the watchlist sync: a completed unfollow cannot be overwritten by an old one.
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
            pools.push(followed);
            store::save_pools(&tx, &pools)?;
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
        }
        tx.commit()?;
        Ok(Json(json!({"pools":pools})))
    })
    .await
}
/// Where one search of one site has got to. `below` is the ID of the oldest post shown; `page`
/// is the next page on sites that page by number or by link (FurAffinity). Posts on that page
/// with an ID of `below` or higher were shown already; on sites whose IDs are not numbers,
/// `skip` counts the posts of that page already shown instead.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    below: Option<u64>,
    #[serde(default, skip_serializing_if = "is_zero")]
    skip: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    done: bool,
}
fn is_zero(n: &usize) -> bool {
    *n == 0
}
/// Each site's searches, as `of` (a fingerprint of the searches) and one position per search.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SitePositions {
    of: String,
    at: Vec<Position>,
}
type FeedCursor = std::collections::BTreeMap<String, SitePositions>;
const MAX_CURSOR: usize = 100_000;

fn invalid_cursor() -> Error {
    Error::Invalid("The subscriptions changed since this feed was opened. Reload the feed.".into())
}
fn decode_cursor(raw: &str) -> Result<FeedCursor> {
    if raw.len() > MAX_CURSOR {
        return Err(invalid_cursor());
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid_cursor())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())
}
/// Identifies one site's address, engine and searches, so a cursor made for others is refused.
/// Stable across app versions, since the frontend keeps cursors while the app is open.
fn fingerprint(site: &Site, searches: &[Vec<String>]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(json!([site.engine, site.base, searches]).to_string());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}
/// The searches the feed of `site` reads: one per batch of [`site_searches`], or one for the
/// FurAffinity inbox, which holds the watched artists' posts.
fn site_queries(
    tags: &[String],
    artists: &[String],
    pools: &[store::PoolSubscription],
    site: &Site,
) -> Vec<Vec<String>> {
    if site.engine == "furaffinity" {
        return vec![vec![]];
    }
    let searches = site_searches(tags, artists, pools, site);
    let mut queries = Vec::new();
    let mut start = 0;
    while !searches.is_empty() {
        let (query, next, wrapped) = batch(&searches, start, batch_size(site));
        queries.push(query);
        if wrapped {
            break;
        }
        start = next;
    }
    queries
}

/// One feed page read live from the sites: no post is saved.
///
/// Every search of every site reads its next page, newest first. A search that may have more
/// posts sets a limit: posts older than its last one may still come from it, so they wait for
/// the next feed page. Posts from the limit up are merged by date and shown. A post the sites
/// add later is newer than everything shown, so it can only appear at the top after a reload.
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
        .map(|s| decode_cursor(s))
        .transpose()?;
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
    feed_page(&db, &Transport::default(), sites, cursor, limit)
        .await
        .map(Json)
}
async fn feed_page(
    db: &Database,
    t: &Transport,
    sites: Vec<Site>,
    cursor: Option<FeedCursor>,
    limit: usize,
) -> Result<Value> {
    if cursor.is_none() && sites.iter().any(|s| s.engine == "furaffinity") {
        // The inbox follows the watchlist; a running sync (Settings) already covers it.
        if let Ok(_guard) = db.subscriptions.try_lock() {
            for error in sync_artists(db, t, &sites).await? {
                eprintln!("[developer] FurAffinity watchlist sync failed: {error}");
            }
        }
    }
    let (tags, artists, pools) = db
        .call(|c| Ok((store::searches(c)?, store::artists(c)?, store::pools(c)?)))
        .await?;
    let mut streams = Vec::new();
    let mut next_cursor = FeedCursor::new();
    for (index, site) in sites.iter().enumerate() {
        let queries = site_queries(&tags, &artists, &pools, site);
        if queries.is_empty() {
            continue;
        }
        let of = fingerprint(site, &queries);
        let at = match &cursor {
            None => vec![Position::default(); queries.len()],
            Some(cursor) => match cursor.get(&site.id) {
                Some(saved) if saved.of == of && saved.at.len() == queries.len() => {
                    saved.at.clone()
                }
                _ => return Err(invalid_cursor()),
            },
        };
        for (slot, (query, at)) in queries.into_iter().zip(&at).enumerate() {
            if !at.done {
                streams.push(Stream {
                    site: index,
                    slot,
                    query,
                    at: at.clone(),
                });
            }
        }
        next_cursor.insert(site.id.clone(), SitePositions { of, at });
    }
    let reads = read_all(t, &sites, &streams).await;
    let page = merge(&streams, reads, limit);
    let mut errors = Vec::new();
    for (index, error) in page.failed {
        let site = &sites[index];
        errors.push(crate::booru_http::site_error(&site.id, &site.name, &error));
        // A site that failed leaves the feed until it is reloaded: posts it would send later
        // would land among older ones.
        for at in &mut next_cursor.get_mut(&site.id).unwrap().at {
            at.done = true;
        }
    }
    for (stream, position) in streams.iter().zip(page.positions) {
        let saved = &mut next_cursor.get_mut(&sites[stream.site].id).unwrap().at[stream.slot];
        if !saved.done {
            *saved = position;
        }
    }
    let has_more = next_cursor.values().any(|s| s.at.iter().any(|at| !at.done));
    // Only the Settings filter depends on it: a failure must not hide the feed.
    if let Err(e) = record_site_hits(db, &sites, &tags, &artists, &page.posts).await {
        eprintln!("[developer] The subscription site hits were not saved: {e}");
    }
    let key = explore::media_key(db).await?;
    let mut grouped = HashMap::<usize, Vec<Value>>::new();
    let mut order = Vec::new();
    for (index, post) in page.posts {
        order.push((index, post["remoteId"].as_str().unwrap().to_owned()));
        grouped.entry(index).or_default().push(post);
    }
    let mut decorated = HashMap::new();
    for (index, posts) in grouped {
        for post in explore::decorate(db, &sites[index], posts, &key).await? {
            decorated.insert((index, post["remoteId"].as_str().unwrap().to_owned()), post);
        }
    }
    let posts = order
        .into_iter()
        .filter_map(|key| decorated.remove(&key))
        .collect::<Vec<_>>();
    Ok(json!({
        "posts": posts,
        "hasMore": has_more,
        "nextCursor": has_more.then(|| URL_SAFE_NO_PAD.encode(serde_json::to_vec(&next_cursor).unwrap())),
        "siteErrors": errors,
    }))
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
/// How many subscribed tags one query can ask for: engines without a verified OR get one.
fn batch_size(site: &Site) -> usize {
    match site.engine.as_str() {
        "e621" => 40,
        "danbooru" => 2,
        "gelbooru" if booru_engines::website(site) == "https://rule34.xxx" => 20,
        _ => 1,
    }
}
fn any_of(site: &Site, tags: Vec<String>) -> Vec<String> {
    if tags.len() < 2 {
        return tags;
    }
    match site.engine.as_str() {
        "e621" | "danbooru" => tags.into_iter().map(|s| format!("~{s}")).collect(),
        // Rule34 answers `{a ~ b}` and `~a ~b` with no posts and no error.
        "gelbooru" => vec![format!("( {} )", tags.join(" ~ "))],
        _ => tags,
    }
}
/// Searches read at once across all sites: each feed page asks every search for its next page.
const PARALLEL_SEARCHES: usize = 6;
/// Searches read at once on one site: e621 allows about two requests a second.
const PARALLEL_SEARCHES_PER_SITE: usize = 2;
/// Pages one search may pass in one feed page when every post on them was shown already.
const MAX_SKIPPED_PAGES: usize = 3;

struct Stream {
    /// Index into the feed's sites.
    site: usize,
    /// Index of this search among its site's searches.
    slot: usize,
    query: Vec<String>,
    at: Position,
}
/// One search's next posts, newest first, without those already shown.
struct Read {
    posts: Vec<Value>,
    /// Whether the site may have older posts than these.
    more: bool,
    /// The page these posts came from, and the one after it, on sites that page by number or link.
    page: Option<String>,
    next: Option<String>,
    /// Posts of `page` left out by [`Position::skip`].
    skipped: usize,
}
fn post_id(post: &Value) -> Option<u64> {
    post["remoteId"].as_str()?.parse().ok()
}
async fn read(t: &Transport, site: &Site, query: &[String], at: &Position) -> Result<Read> {
    let by_id = booru_engines::pages_by_id(site);
    let mut page = at.page.clone();
    for pass in 0..=MAX_SKIPPED_PAGES {
        let (raw, more, next) = if site.engine == "furaffinity" {
            let (posts, next) = remote::page(t, site, page.as_deref()).await?;
            (posts, next.is_some(), next)
        } else {
            let number = match &page {
                None => 1,
                Some(p) => p.parse::<usize>().map_err(|_| invalid_cursor())?,
            };
            if number > MAX_PAGE {
                return Err(crate::booru_http::remote(
                    "The feed reached the site's pagination limit. Narrow your subscribed searches.",
                ));
            }
            let posts = booru_engines::search(
                t,
                site,
                &Search {
                    tags: any_of(site, query.to_vec()),
                    page: number,
                    limit: PAGE_SIZE,
                    before: at.below.filter(|_| by_id),
                    ..Search::default()
                },
            )
            .await?;
            let more = posts.len() >= PAGE_SIZE;
            (
                posts,
                more,
                (more && !by_id).then(|| (number + 1).to_string()),
            )
        };
        let skipped = if pass == 0 { at.skip.min(raw.len()) } else { 0 };
        // A page that moved since it was read repeats posts already shown.
        let posts = raw
            .into_iter()
            .skip(skipped)
            .filter(|p| {
                at.below
                    .is_none_or(|below| post_id(p).is_none_or(|id| id < below))
            })
            .collect::<Vec<_>>();
        if posts.is_empty() && next.is_some() {
            page = next;
            continue;
        }
        return Ok(Read {
            posts,
            more,
            page,
            next,
            skipped,
        });
    }
    // shortcut: a search whose pages all repeat shown posts waits for the next feed page and
    // sets no limit on this one, so its older posts may land just above the limit of the others.
    Ok(Read {
        posts: vec![],
        more: true,
        page,
        next: None,
        skipped: 0,
    })
}
async fn read_all(t: &Transport, sites: &[Site], streams: &[Stream]) -> Vec<Result<Read>> {
    let mut results = (0..streams.len()).map(|_| None).collect::<Vec<_>>();
    let mut queued = (0..streams.len()).collect::<std::collections::VecDeque<_>>();
    let mut running = vec![0; sites.len()];
    let mut pending = tokio::task::JoinSet::new();
    loop {
        while pending.len() < PARALLEL_SEARCHES {
            let Some(at) = queued
                .iter()
                .position(|i| running[streams[*i].site] < PARALLEL_SEARCHES_PER_SITE)
            else {
                break;
            };
            let index = queued.remove(at).unwrap();
            let stream = &streams[index];
            running[stream.site] += 1;
            let (t, site, query, at) = (
                t.clone(),
                sites[stream.site].clone(),
                stream.query.clone(),
                stream.at.clone(),
            );
            pending.spawn(async move { (index, read(&t, &site, &query, &at).await) });
        }
        let Some(done) = pending.join_next().await else {
            break;
        };
        match done {
            Ok((index, result)) => {
                running[streams[index].site] -= 1;
                results[index] = Some(result);
            }
            // A task that panicked keeps its slot: its site has failed anyway.
            Err(e) => eprintln!("[developer] A subscription search task failed: {e}"),
        }
    }
    results
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err(Error::Storage("The search did not finish.".into()))))
        .collect()
}
struct FeedPage {
    /// (site index, post), newest first.
    posts: Vec<(usize, Value)>,
    /// Each stream's position after this page, in the order of the streams.
    positions: Vec<Position>,
    /// The first error of each site that failed.
    failed: Vec<(usize, String)>,
}
/// Seconds since 1970 of `createdAt`, or None when the post has no readable date.
fn posted(post: &Value) -> Option<i64> {
    post["createdAt"]
        .as_str()
        .and_then(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|d| d.unix_timestamp())
}
/// One search's dates, never rising, so each search stays a run in the merge: a post dated
/// after the one above it takes that date, and a post without a date takes the date above it,
/// or below it at the top of the page. A page without any date sorts first.
fn run_dates(posts: &[Value]) -> Vec<i64> {
    let first = posts.iter().find_map(posted).unwrap_or(i64::MAX);
    let mut last = first;
    posts
        .iter()
        .map(|p| {
            last = posted(p).map_or(last, |d| d.min(last));
            last
        })
        .collect()
}
/// Merges the reads by date down to the limit the searches with more posts set; see [`feed`].
fn merge(streams: &[Stream], reads: Vec<Result<Read>>, limit: usize) -> FeedPage {
    let mut failed: Vec<(usize, String)> = Vec::new();
    for (stream, read) in streams.iter().zip(&reads) {
        if let Err(e) = read {
            if !failed.iter().any(|(site, _)| *site == stream.site) {
                failed.push((stream.site, e.to_string()));
            }
        }
    }
    let ok = |stream: &Stream| !failed.iter().any(|(site, _)| *site == stream.site);
    let dates = reads
        .iter()
        .map(|read| read.as_ref().map_or(vec![], |read| run_dates(&read.posts)))
        .collect::<Vec<_>>();
    let floor = streams
        .iter()
        .zip(&reads)
        .zip(&dates)
        .filter(|((stream, read), dates)| {
            ok(stream) && read.as_ref().is_ok_and(|r| r.more) && !dates.is_empty()
        })
        .map(|(_, dates)| *dates.last().unwrap())
        .max();
    let mut candidates = Vec::new();
    for (index, (stream, dates)) in streams.iter().zip(&dates).enumerate() {
        if !ok(stream) {
            continue;
        }
        for (position, date) in dates.iter().enumerate() {
            if floor.is_some_and(|floor| *date < floor) {
                break;
            }
            candidates.push((*date, index, position));
        }
    }
    // Stable: equal dates keep the order of the sites, then of each search.
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));
    let mut taken = vec![0; streams.len()];
    let mut shown = HashSet::new();
    let mut posts = Vec::new();
    for (_, index, position) in candidates {
        if posts.len() == limit {
            break;
        }
        let read = reads[index].as_ref().unwrap();
        let post = &read.posts[position];
        taken[index] = position + 1;
        let site = streams[index].site;
        // A post that matches two searches of a site comes once.
        if shown.insert((
            site,
            post["remoteId"].as_str().unwrap_or_default().to_owned(),
        )) {
            posts.push((site, post.clone()));
        }
    }
    let positions = streams
        .iter()
        .zip(&reads)
        .zip(taken)
        .map(|((stream, read), taken)| {
            let Ok(read) = read else {
                return Position {
                    done: true,
                    ..stream.at.clone()
                };
            };
            let last = read.posts[..taken].last();
            let mut at = Position {
                page: read.page.clone(),
                below: last.and_then(post_id).or(stream.at.below),
                // Without a numeric ID only the count of shown posts marks the place.
                skip: if last.is_some_and(|p| post_id(p).is_none()) || taken == 0 {
                    read.skipped + taken
                } else {
                    0
                },
                done: false,
            };
            if taken == read.posts.len() {
                match &read.next {
                    _ if !read.more => at.done = true,
                    Some(next) => {
                        at.page = Some(next.clone());
                        at.skip = 0;
                    }
                    None => {}
                }
            }
            at
        })
        .collect();
    FeedPage {
        posts,
        positions,
        failed,
    }
}
/// Adds to `subscriptions.siteHits` the booru sites where the shown posts match a search, for
/// the filter in Settings.
async fn record_site_hits(
    db: &Database,
    sites: &[Site],
    tags: &[String],
    artists: &[String],
    posts: &[(usize, Value)],
) -> Result<()> {
    let entries = tags.iter().chain(artists).cloned().collect::<Vec<_>>();
    let mut found = HashSet::new();
    for (index, post) in posts {
        let site = &sites[*index];
        if site.engine == "furaffinity" {
            continue;
        }
        let post_tags: HashSet<String> = post["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["tag"].as_str().map(crate::tags::normalize))
            .collect();
        for entry in entries.iter().filter(|e| matches_search(e, &post_tags)) {
            found.insert((entry.clone(), site.id.clone()));
        }
    }
    if found.is_empty() {
        return Ok(());
    }
    db.call(move |c| {
        let mut hits = store::site_hits(c)?;
        let before = hits.clone();
        for (entry, site) in found {
            let sites = hits.entry(entry).or_default();
            if !sites.contains(&site) {
                sites.push(site);
            }
        }
        if hits != before {
            store::save_site_hits(c, &hits)?;
        }
        Ok(())
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_single_tag_counts_as_an_artist_unless_the_vocabulary_files_it_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        db.call(|c| {
            c.execute_batch(
                "INSERT INTO tag_categories(tag,category) VALUES ('cat','species'),('rukis','artist'),('comic','meta');",
            )?;
            let tags = ["rukis", "desertkaiju", "grefina_(noirchaton4)", "cat", "comic", "fox score:>10", "-gore", "~a", "dra*"]
                .map(String::from);
            assert_eq!(
                artist_searches(c, &tags)?,
                ["rukis", "desertkaiju", "grefina_(noirchaton4)"]
            );
            Ok(())
        })
        .await
        .unwrap();
    }
    use axum::{extract::Request, response::IntoResponse, routing::any};
    use std::sync::{Arc, Mutex};

    use crate::db::OWNER_ID;

    /// An e621 that holds `posts` as (id, tag, unix seconds) and answers `~a ~b` (any of),
    /// `a b` (all of), `page=N` and `page=b<id>` as e621 does, newest ID first.
    async fn booru(
        posts: Vec<(u64, &'static str, i64)>,
    ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let (requests, posts) = (captured.clone(), posts.clone());
            async move {
                let query = request.uri().query().unwrap_or("").to_owned();
                let url = reqwest::Url::parse(&format!("https://fixture.example/?{query}")).unwrap();
                let params = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
                requests.lock().unwrap().push(format!("{} page={}", params["tags"], params["page"]));
                let terms = params["tags"].split(' ').collect::<Vec<_>>();
                let any = terms.iter().filter_map(|t| t.strip_prefix('~')).collect::<Vec<_>>();
                let all = terms.iter().filter(|t| !t.starts_with('~') && !t.contains(':')).collect::<Vec<_>>();
                let limit: usize = params["limit"].parse().unwrap();
                let mut rows = posts
                    .iter()
                    .filter(|(_, tag, _)| all.iter().all(|t| *t == tag) && (any.is_empty() || any.contains(tag)))
                    .collect::<Vec<_>>();
                rows.sort_by_key(|p| std::cmp::Reverse(p.0));
                let rows = match params["page"].strip_prefix('b') {
                    Some(below) => {
                        let below: u64 = below.parse().unwrap();
                        rows.into_iter().filter(|p| p.0 < below).take(limit).collect::<Vec<_>>()
                    }
                    None => {
                        let page: usize = params["page"].parse().unwrap();
                        rows.into_iter().skip((page - 1) * limit).take(limit).collect()
                    }
                };
                let rows = rows.iter().map(|(id, tag, at)| {
                    let at = time::OffsetDateTime::from_unix_timestamp(*at).unwrap()
                        .format(&time::format_description::well_known::Rfc3339).unwrap();
                    json!({"id":id,"file":{"url":"https://cdn.example.com/post.jpg","ext":"jpg"},
                        "preview":{"url":"https://cdn.example.com/preview.jpg"},"tags":{"general":[tag]},
                        "created_at":at,"relationships":{},"pools":[]})
                }).collect::<Vec<_>>();
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
    /// Reads the whole feed of `sites` `limit` posts at a time, as Show more does: the ids
    /// shown and the site errors.
    async fn read_feed(db: &Database, sites: &[Site], limit: usize) -> (Vec<String>, Vec<Value>) {
        let t = Transport {
            allow_loopback: true,
        };
        let (mut ids, mut errors, mut cursor) = (vec![], vec![], None);
        for _ in 0..100 {
            let page = feed_page(db, &t, sites.to_vec(), cursor, limit)
                .await
                .unwrap();
            ids.extend(
                page["posts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p["remoteId"].as_str().unwrap().to_owned()),
            );
            errors.extend(page["siteErrors"].as_array().unwrap().iter().cloned());
            let Some(next) = page["nextCursor"].as_str() else {
                return (ids, errors);
            };
            assert_eq!(page["hasMore"], true);
            cursor = Some(decode_cursor(next).unwrap());
        }
        panic!("the feed never ended");
    }
    fn ids(range: impl DoubleEndedIterator<Item = u64>) -> Vec<String> {
        range.rev().map(|id| id.to_string()).collect()
    }
    #[tokio::test]
    async fn every_post_of_a_search_comes_once_in_order_even_past_its_first_page() {
        // 100 new posts on one search: the old refresh read only the newest 40 of them.
        let (base, requests, task) = booru(
            (1..=100)
                .map(|id| {
                    (
                        id,
                        if id % 2 == 0 { "fox" } else { "wolf" },
                        1_800_000_000 + id as i64 * 60,
                    )
                })
                .collect(),
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        db.call(|c| write_setting(c, "subscriptions.tags", &json!(["fox", "wolf"])))
            .await
            .unwrap();
        let (shown, errors) = read_feed(&db, &[site], 30).await;
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(shown, ids(1..=100));
        // One search, `~fox ~wolf`, paged by ID: posts added on top cannot shift the next page.
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.starts_with("~fox ~wolf page=")));
        task.abort();
    }
    #[tokio::test]
    async fn searches_merge_by_date_and_an_older_post_never_follows_a_newer_one_later() {
        // `fox score:>10` is searched alone: two searches, one busy and recent, one sparse.
        let mut posts = (101..=160)
            .map(|id| (id, "fox", 1_800_000_000 + id as i64 * 60))
            .collect::<Vec<_>>();
        posts.extend((1..=30).map(|id| (id, "wolf", 1_800_000_000 + id as i64 * 400)));
        let (base, _, task) = booru(posts.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        db.call(|c| write_setting(c, "subscriptions.tags", &json!(["fox score:>10", "wolf"])))
            .await
            .unwrap();
        let (shown, _) = read_feed(&db, &[site], 25).await;
        posts.sort_by_key(|p| std::cmp::Reverse(p.2));
        assert_eq!(
            shown,
            posts.iter().map(|p| p.0.to_string()).collect::<Vec<_>>()
        );
        task.abort();
    }
    #[tokio::test]
    async fn a_failing_site_is_reported_and_the_others_still_load() {
        let (base, _, task) = booru(
            (1..=3)
                .map(|id| (id, "fox", 1_800_000_000 + id as i64))
                .collect(),
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        db.call(|c| write_setting(c, "subscriptions.tags", &json!(["fox"])))
            .await
            .unwrap();
        let broken = Site {
            id: "broken".into(),
            name: "Broken".into(),
            base: "http://127.0.0.1:1".into(),
            ..site.clone()
        };
        let (shown, errors) = read_feed(&db, &[site, broken], 40).await;
        assert_eq!(shown, ["3", "2", "1"]);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["siteId"], "broken");
        task.abort();
    }
    #[tokio::test]
    async fn a_cursor_for_other_searches_is_refused() {
        let (base, _, task) = booru(
            (1..=50)
                .map(|id| (id, "fox", 1_800_000_000 + id as i64))
                .collect(),
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        db.call(|c| write_setting(c, "subscriptions.tags", &json!(["fox"])))
            .await
            .unwrap();
        let t = Transport {
            allow_loopback: true,
        };
        let first = feed_page(&db, &t, vec![site.clone()], None, 10)
            .await
            .unwrap();
        let cursor = decode_cursor(first["nextCursor"].as_str().unwrap()).unwrap();
        db.call(|c| write_setting(c, "subscriptions.tags", &json!(["fox", "wolf"])))
            .await
            .unwrap();
        assert!(matches!(
            feed_page(&db, &t, vec![site], Some(cursor), 10).await,
            Err(Error::Invalid(_))
        ));
        task.abort();
    }
    #[tokio::test]
    async fn the_shown_posts_record_where_each_search_has_results() {
        let (base, _, task) = booru(vec![(1, "wolf", 1_800_000_000)]).await;
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let site = setup(&db, base).await;
        db.call(|c| write_setting(c, "subscriptions.tags", &json!(["wolf score:>5", "fox"])))
            .await
            .unwrap();
        read_feed(&db, &[site], 40).await;
        let sites = boorus::sites(&db).await.unwrap();
        let (wolf, fox) = ("wolf score:>5".to_owned(), "fox".to_owned());
        let hits = db
            .call(move |c| site_hits(c, &sites, &[&wolf, &fox]))
            .await
            .unwrap();
        assert_eq!(hits["wolf score:>5"], ["fixture"]);
        assert!(!hits.contains_key("fox"));
        task.abort();
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
    #[test]
    fn subscription_batches_use_each_engines_or_and_one_tag_where_none_is_verified() {
        let site = |engine: &str, base: &str| Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: engine.into(),
            base: base.into(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let tags = || vec!["fox".to_string(), "grefina_(noirchaton4)".to_string()];
        let rule34 = site("gelbooru", "https://api.rule34.xxx");
        assert_eq!(batch_size(&rule34), 20);
        assert_eq!(any_of(&rule34, tags()), ["( fox ~ grefina_(noirchaton4) )"]);
        assert_eq!(any_of(&rule34, vec!["fox".into()]), ["fox"]);
        let e621 = site("e621", "https://e621.net");
        assert_eq!(any_of(&e621, tags()), ["~fox", "~grefina_(noirchaton4)"]);
        assert_eq!(batch_size(&site("gelbooru", "https://gelbooru.com")), 1);
        assert_eq!(batch_size(&site("moebooru", "https://yande.re")), 1);
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
    /// A three-page FurAffinity inbox: 9 and 8 on the newest page's chain, 7 on the last page.
    async fn fa_inbox(
        db: &Database,
    ) -> (Site, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let app = Router::new().fallback(any(move |uri: axum::http::Uri| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(uri.path().to_owned());
                let (id, next) = match uri.path() {
                    "/msg/submissions/" => ("9", Some("/msg/submissions/new~8@48/")),
                    "/msg/submissions/new~8@48/" => ("8", Some("/msg/submissions/new~7@48/")),
                    _ => ("7", None),
                };
                let more = next.map(|n| format!("<a class='more' href='{n}'>Next</a>")).unwrap_or_default();
                axum::response::Html(format!("<div id='messagecenter-submissions'><figure id='sid-{id}'><img src='https://t.furaffinity.net/{id}-179176320{id}.jpg'></figure>{more}</div>"))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        setup(db, base.clone()).await;
        db.call(|c| {c.execute("UPDATE user_booru_sites SET engine='furaffinity',username='fixture-owner',session_cookie='a=fake;b=fake' WHERE id='fixture'",[])?;Ok(())}).await.unwrap();
        let mut site = boorus::site(db, "fixture".into()).await.unwrap().unwrap();
        site.base = base;
        (site, requests, task)
    }
    #[tokio::test]
    async fn the_furaffinity_inbox_carries_on_from_the_last_post_shown() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (site, requests, task) = fa_inbox(&db).await;
        let (shown, errors) = read_feed(&db, &[site], 1).await;
        assert_eq!(shown, ["9", "8", "7"]);
        // The watchlist sync, then each page once: a page read whole is not read again.
        let pages = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.starts_with("/msg/"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            pages,
            [
                "/msg/submissions/",
                "/msg/submissions/new~8@48/",
                "/msg/submissions/new~7@48/"
            ]
        );
        assert!(errors.is_empty(), "{errors:?}");
        task.abort();
    }
    fn stream(site: usize) -> Stream {
        Stream {
            site,
            slot: 0,
            query: vec![],
            at: Position::default(),
        }
    }
    fn dated(id: &str, at: &str) -> Value {
        json!({"remoteId":id,"createdAt":at})
    }
    #[test]
    fn a_page_of_ids_that_are_not_numbers_carries_on_by_counting_the_posts_shown() {
        let read = Read {
            posts: ["c", "b", "a"]
                .iter()
                .map(|id| dated(id, "2026-10-12T00:00:00Z"))
                .collect(),
            more: true,
            page: None,
            next: Some("2".into()),
            skipped: 0,
        };
        let page = merge(&[stream(0)], vec![Ok(read)], 2);
        assert_eq!(page.posts.len(), 2);
        assert_eq!(
            page.positions,
            [Position {
                skip: 2,
                ..Position::default()
            }]
        );
    }
    #[test]
    fn a_post_without_a_date_stays_beside_its_neighbours() {
        let posts = [
            json!({"remoteId":"3"}),
            dated("2", "2026-10-12T00:00:00Z"),
            json!({"remoteId":"1"}),
            dated("0", "2026-10-13T00:00:00Z"),
        ];
        let day = 1_791_763_200;
        assert_eq!(run_dates(&posts), [day, day, day, day]);
        assert_eq!(run_dates(&[json!({"remoteId":"1"})]), [i64::MAX]);
    }
    #[test]
    fn a_cursor_belongs_to_one_address_and_engine() {
        let site = |base: &str| Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "e621".into(),
            base: base.into(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let searches = [vec!["fox".to_owned()]];
        assert_eq!(
            fingerprint(&site("https://e621.net"), &searches),
            fingerprint(&site("https://e621.net"), &searches)
        );
        assert_ne!(
            fingerprint(&site("https://e621.net"), &searches),
            fingerprint(&site("https://e926.net"), &searches)
        );
    }
    #[tokio::test]
    async fn site_hits_count_a_furaffinity_artist_from_the_watchlist() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (_, _, task) = fa_inbox(&db).await;
        db.call(|c| store::save_seen_artists(c, "fixture", &["rukis".to_owned()]))
            .await
            .unwrap();
        let sites = boorus::sites(&db).await.unwrap();
        let (rukis, other) = ("rukis".to_owned(), "other".to_owned());
        let hits = db
            .call(move |c| site_hits(c, &sites, &[&rukis, &other]))
            .await
            .unwrap();
        assert_eq!(hits["rukis"], ["fixture"]);
        assert!(!hits.contains_key("other"));
        task.abort();
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
                    ["user", name] if name.starts_with("gone") => (
                        axum::http::StatusCode::BAD_REQUEST,
                        "<title>System Error</title>This user cannot be found.",
                    )
                        .into_response(),
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
    async fn an_artist_not_on_furaffinity_becomes_a_search_without_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let (site, fa, task) = fake_fa(&[], &["real"], None).await;
        let t = Transport {
            allow_loopback: true,
        };
        save_local(&db, &["gone-artist", "real"]).await;
        let errors = sync_artists(&db, &t, &[site]).await.unwrap();
        assert!(errors.is_empty());
        assert_eq!(watching(&fa), ["real"]);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, ["real"]);
        assert_eq!(seen.unwrap(), ["real"]);
        assert_eq!(
            db.call(|c| store::searches(c)).await.unwrap(),
            ["gone-artist"]
        );
        task.abort();
    }
    async fn added(db: &Database, body: Value) -> (Vec<String>, Vec<String>) {
        let Json(v) = add_tag(State(db.clone()), Ok(Json(body))).await.unwrap();
        let list = |k: &str| serde_json::from_value(v[k].clone()).unwrap();
        (list("tags"), list("artists"))
    }
    #[tokio::test]
    async fn adding_a_single_name_follows_it_only_when_it_is_an_artist() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        db.call(|c| {
            c.execute("INSERT INTO tag_categories (tag,category) VALUES ('nawka','artist'),('wolf','species')", [])?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            added(&db, json!({"tag":"Nawka"})).await,
            (vec![], vec!["nawka".to_owned()])
        );
        assert_eq!(
            added(&db, json!({"tag":"wolf"})).await,
            (vec!["wolf".to_owned()], vec!["nawka".to_owned()])
        );
        let (tags, artists) = added(&db, json!({"tag":"unknown_name","artist":true})).await;
        assert_eq!(tags, ["wolf"]);
        assert_eq!(artists, ["nawka", "unknown_name"]);
        let (tags, artists) = added(&db, json!({"search":"nawka2 ~wolf"})).await;
        assert_eq!(tags, ["wolf", "nawka2 ~wolf"]);
        assert_eq!(artists.len(), 2);
        let (tags, _) = added(&db, json!({"search":"-nawka"})).await;
        assert_eq!(tags.last().unwrap(), "-nawka");
    }
    #[test]
    fn a_search_matches_posts_by_its_positive_tags_only() {
        let post: HashSet<String> = ["a", "b"].map(String::from).into();
        assert!(matches_search("a", &post));
        assert!(matches_search("a b", &post));
        assert!(!matches_search("a c", &post));
        assert!(matches_search("~a ~c", &post));
        assert!(!matches_search("~c ~d", &post));
        assert!(matches_search("a -x score:>5", &post));
        assert!(!matches_search("-x score:>5", &post));
    }
    #[tokio::test]
    async fn a_list_emptied_at_once_is_imported_again_instead_of_unwatched() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let watched = ["a", "b", "c", "d"];
        let (site, fa, task) = fake_fa(&watched, &watched, None).await;
        let t = Transport {
            allow_loopback: true,
        };
        db.call(move |c| store::save_seen_artists(c, "fixture", &watched.map(str::to_owned)))
            .await
            .unwrap();
        let errors = sync_artists(&db, &t, &[site]).await.unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(watching(&fa), watched);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, watched);
        assert_eq!(seen.unwrap(), watched);
        task.abort();
    }
    #[tokio::test]
    async fn a_list_emptied_at_once_keeps_an_artist_unwatched_on_furaffinity_unwatched() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        let watched = ["a", "b", "c", "d"];
        let (site, fa, task) = fake_fa(&watched, &["a", "b", "c", "d", "x"], None).await;
        let t = Transport {
            allow_loopback: true,
        };
        db.call(|c| {
            store::save_seen_artists(c, "fixture", &["a", "b", "c", "d", "x"].map(str::to_owned))
        })
        .await
        .unwrap();
        save_local(&db, &["x"]).await;
        let errors = sync_artists(&db, &t, &[site]).await.unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(watching(&fa), watched);
        let (local, seen) = local_and_seen(&db).await;
        assert_eq!(local, watched);
        assert_eq!(seen.unwrap(), watched);
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
