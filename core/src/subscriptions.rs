use crate::{
    booru_engines::{self, Search},
    booru_http::{Transport, USER_NOT_FOUND},
    boorus::{self, Site},
    db::{write_setting, Database},
    explore, subscription_remote as remote, subscription_store as store, Error, Result,
};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) const PAGE_SIZE: usize = 40;
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
pub(crate) async fn sync_artists(
    db: &Database,
    t: &Transport,
    sites: &[Site],
) -> Result<Vec<Value>> {
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
/// Where one search of one site has got to. `below` is the ID of the oldest post read; `page`
/// is the next page on sites that page by number or by link (FurAffinity). Posts on that page
/// with an ID of `below` or higher were read already; on sites whose IDs are not numbers,
/// `skip` counts the posts of that page already read instead.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Position {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    below: Option<u64>,
    #[serde(default, skip_serializing_if = "is_zero")]
    skip: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) done: bool,
}
fn is_zero(n: &usize) -> bool {
    *n == 0
}
/// The searches the feed of `site` reads: one per batch of [`site_searches`], or one for the
/// FurAffinity inbox, which holds the watched artists' posts.
pub(crate) fn site_queries(searches: &[String], absent: &[usize], site: &Site) -> Vec<Vec<String>> {
    if site.engine == "furaffinity" {
        return vec![vec![]];
    }
    let searches = searches
        .iter()
        .enumerate()
        .filter(|(i, _)| !absent.contains(i))
        .map(|(_, s)| s.clone())
        .collect::<Vec<_>>();
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
/// The searches of a Danbooru site, by index in `searches`, whose tag has no posts there and is
/// no alias. Free accounts search two tags at a time, so each pair costs a request on every feed
/// page; most followed artists of other sites have no tag there. A tag that gets its first post
/// joins the feed within a day. When the lookup fails, every search is read.
pub(crate) async fn absent_searches(
    db: &Database,
    t: &Transport,
    site: &Site,
    searches: &[String],
) -> Vec<usize> {
    let plain = |s: &str| {
        !s.chars().any(|c| c.is_whitespace() || c == ':' || c == '*') && !s.starts_with(['-', '~'])
    };
    if site.engine != "danbooru" {
        return vec![];
    }
    let mut names = searches
        .iter()
        .filter(|s| plain(s))
        .map(|s| s.to_lowercase())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return vec![];
    }
    let key = format!("tags-with-posts:{}:{}", site.id, names.join(" "));
    let (held, held_site) = (t.clone(), site.clone());
    let known = crate::cache::remember(
        db,
        &key,
        crate::cache::Keep::Revalidate(crate::cache::DAY),
        move || async move {
            Ok(json!(
                booru_engines::danbooru_tags_with_posts(&held, &held_site, &names).await?
            ))
        },
    )
    .await
    .and_then(|v| {
        serde_json::from_value::<HashSet<String>>(v)
            .map_err(|_| Error::Storage("A cached tag list is damaged.".into()))
    });
    let known = match known {
        Ok(known) => known,
        Err(e) => {
            eprintln!(
                "[developer] {}: subscribed tags not checked, every search is read: {e}",
                site.name
            );
            return vec![];
        }
    };
    searches
        .iter()
        .enumerate()
        .filter(|(_, s)| plain(s) && !known.contains(&s.to_lowercase()))
        .map(|(i, _)| i)
        .collect()
}
/// The saved searches, then each followed artist, then `pool:ID` for each pool followed on the
/// site. `batch` sends a `pool:` search alone, since it contains `:`.
pub(crate) fn site_searches(
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
/// Searches read at once across all sites.
pub(crate) const PARALLEL_SEARCHES: usize = 8;
/// Searches read at once on one site: e621 allows about two requests a second; Danbooru about
/// ten, and a sync asks it the most, since it searches two tags at a time.
pub(crate) fn parallel_searches(site: &Site) -> usize {
    if site.engine == "danbooru" {
        4
    } else {
        2
    }
}
/// Pages one read may pass when every post on them was read already.
const MAX_SKIPPED_PAGES: usize = 3;

/// One search's next posts, newest first, without those already read.
pub(crate) struct Read {
    pub(crate) posts: Vec<Value>,
    /// Whether the site may have older posts than these.
    more: bool,
    /// The page these posts came from, and the one after it, on sites that page by number or link.
    page: Option<String>,
    next: Option<String>,
    /// Posts of `page` left out by [`Position::skip`].
    skipped: usize,
}
impl Read {
    /// Where the search carries on after these posts, which are all taken.
    pub(crate) fn after(&self, at: &Position) -> Position {
        let last = self.posts.last();
        let mut next = Position {
            page: self.page.clone(),
            below: last.and_then(post_id).or(at.below),
            // Without a numeric ID only the count of posts read marks the place.
            skip: if last.is_some_and(|p| post_id(p).is_none()) || self.posts.is_empty() {
                self.skipped + self.posts.len()
            } else {
                0
            },
            done: !self.more,
        };
        if let Some(page) = &self.next {
            next.page = Some(page.clone());
            next.skip = 0;
        }
        next
    }
}
pub(crate) fn post_id(post: &Value) -> Option<u64> {
    post["remoteId"].as_str()?.parse().ok()
}
/// The page of `query` after `at`, newest first.
pub(crate) async fn read(
    t: &Transport,
    site: &Site,
    query: &[String],
    at: &Position,
) -> Result<Read> {
    let by_id = booru_engines::pages_by_id(site);
    let mut page = at.page.clone();
    for pass in 0..=MAX_SKIPPED_PAGES {
        let (raw, more, next) = if site.engine == "furaffinity" {
            let (posts, next) = remote::page(t, site, page.as_deref()).await?;
            (posts, next.is_some(), next)
        } else {
            let number = match &page {
                None => 1,
                Some(p) => p
                    .parse::<usize>()
                    .map_err(|_| Error::Storage("A saved feed position is damaged.".into()))?,
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
        // A page that moved since it was read repeats posts already read.
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
    // Pages that moved since the search was read: carry on after them, so the next read starts
    // further down instead of reading the same pages again.
    Ok(Read {
        posts: vec![],
        more: true,
        page: page.clone(),
        next: page,
        skipped: 0,
    })
}
/// Seconds since 1970 of `createdAt`, or None when the post has no readable date.
pub(crate) fn posted(post: &Value) -> Option<i64> {
    post["createdAt"]
        .as_str()
        .and_then(|s| {
            time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|d| d.unix_timestamp())
}
/// One search's dates, never rising, so each search stays a run in the feed: a post dated
/// after the one above it, or after `above` (the last post read from the search), takes that
/// date, and a post without a date takes the date above it, or below it at the top of the page.
/// A page without any date sorts first. Some sites date a post by its last edit (Rule34's
/// `change`, FurAffinity's thumbnail), which a later post ID shows to be too late.
pub(crate) fn run_dates(posts: &[Value], above: Option<i64>) -> Vec<i64> {
    let first = posts
        .iter()
        .find_map(posted)
        .map_or(above.unwrap_or(i64::MAX), |d| above.map_or(d, |a| d.min(a)));
    let mut last = first;
    posts
        .iter()
        .map(|p| {
            last = posted(p).map_or(last, |d| d.min(last));
            last
        })
        .collect()
}
/// Adds to `subscriptions.siteHits` the booru sites where the saved posts match a search, for
/// the filter in Settings.
pub(crate) async fn record_site_hits(
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
    fn dated(id: &str, at: &str) -> Value {
        json!({"remoteId":id,"createdAt":at})
    }
    #[tokio::test]
    async fn pages_that_moved_since_the_last_read_are_passed_not_read_forever() {
        // A number-paged site where new posts pushed every page down: each holds posts read already.
        let app = Router::new().fallback(any(|| async {
            Json(json!((1000..1040)
                .rev()
                .map(|id| json!({"id":id,"file_url":"https://cdn.example.com/f.jpg","tags":"fox"}))
                .collect::<Vec<_>>()))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let site = Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "moebooru".into(),
            base,
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let at = Position {
            page: Some("2".into()),
            below: Some(10),
            ..Position::default()
        };
        let read = read(
            &Transport {
                allow_loopback: true,
            },
            &site,
            &["fox".into()],
            &at,
        )
        .await
        .unwrap();
        task.abort();
        assert!(read.posts.is_empty());
        assert_eq!(
            read.after(&at),
            Position {
                page: Some("6".into()),
                below: Some(10),
                ..Position::default()
            }
        );
    }
    #[test]
    fn a_page_of_ids_that_are_not_numbers_carries_on_by_counting_the_posts_read() {
        let read = Read {
            posts: ["c", "b"]
                .iter()
                .map(|id| dated(id, "2026-10-12T00:00:00Z"))
                .collect(),
            more: true,
            page: None,
            next: None,
            skipped: 1,
        };
        assert_eq!(
            read.after(&Position::default()),
            Position {
                skip: 3,
                ..Position::default()
            }
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
        assert_eq!(run_dates(&posts, None), [day, day, day, day]);
        assert_eq!(run_dates(&[json!({"remoteId":"1"})], None), [i64::MAX]);
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
