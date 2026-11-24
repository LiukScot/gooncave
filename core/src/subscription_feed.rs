//! The Subscriptions feed, saved on this device (ADR 0005). A sync reads each search from its
//! newest post down to the newest one it saved before; the feed lists the saved posts by date and
//! reads older pages only when the reader reaches the oldest saved date of a search that may have
//! more.
use crate::{
    booru_http::Transport,
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    explore, subscription_store as store,
    subscriptions::{self as subs, Position},
    Error, Result,
};
use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

const SYNC_EVERY: Duration = Duration::from_secs(15 * 60);
/// A search synced this recently is not read again, so opening the feed right after a sync asks
/// no site.
const SYNCED_RECENTLY: i64 = 60;
const RETENTION_DAYS: i64 = 365;
/// Pages a sync reads per search before it stops looking for the newest post saved before; the
/// posts in between are then read as older posts.
const MAX_NEW_PAGES: usize = 25;
/// Newest post IDs kept per search to recognise where the last sync stopped.
const HEAD_IDS: usize = 40;
/// How long one feed page may spend reading older posts from the sites.
const READ_BUDGET: Duration = Duration::from_secs(8);

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/explore/subscriptions", get(feed))
        .route("/explore/subscriptions/new", get(new_posts))
        .route("/explore/subscriptions/progress", get(progress))
}

#[derive(Clone, Debug)]
struct Row {
    /// Index into the sites being read.
    site: usize,
    query: Vec<String>,
    head: Vec<String>,
    tail: Position,
    tail_at: Option<i64>,
    synced_at: i64,
}
impl Row {
    fn unread(&self) -> bool {
        self.tail_at.is_none() && !self.tail.done
    }
    /// Whether opening the feed has to read this search before it answers: never read, or on a
    /// site read through the browser, which the periodic sync leaves out, and not read for a
    /// sync period. Read after the answer, its posts would land among posts already shown.
    fn behind(&self, site: &Site, now: i64) -> bool {
        self.unread()
            || (crate::browser::site(&site.base).is_some()
                && self.synced_at < now - SYNC_EVERY.as_secs() as i64)
    }
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
fn damaged() -> Error {
    Error::Storage(
        "The saved feed is damaged. Remove and add a subscription to read it again.".into(),
    )
}
fn query_key(query: &[String]) -> String {
    json!(query).to_string()
}

/// Brings the saved searches of `sites` in line with the subscriptions and returns them. A site
/// whose subscriptions changed starts again from its newest posts.
async fn prepare(db: &Database, t: &Transport, sites: &[Site]) -> Result<Vec<Row>> {
    let (tags, artists, pools) = db
        .call(|c| Ok((store::searches(c)?, store::artists(c)?, store::pools(c)?)))
        .await?;
    let mut plans = Vec::new();
    for site in sites {
        let searches = subs::site_searches(&tags, &artists, &pools, site);
        let absent = subs::absent_searches(db, t, site, &searches).await;
        let queries = subs::site_queries(&searches, &absent, site);
        // The inbox does not depend on the searches.
        let searches = if site.engine == "furaffinity" {
            vec![]
        } else {
            searches
        };
        let of = json!({"engine": site.engine, "base": site.base, "searches": searches});
        plans.push((site.id.clone(), of, queries));
    }
    db.call(move |c| {
        let tx = c.transaction()?;
        let mut rows = Vec::new();
        for (index, (site, of, queries)) in plans.into_iter().enumerate() {
            let saved: Option<String> = tx
                .query_row(
                    "SELECT searches FROM subscription_sites WHERE site_id=?1",
                    [&site],
                    |r| r.get(0),
                )
                .optional()?;
            let saved = saved.and_then(|s| serde_json::from_str::<Value>(&s).ok());
            if saved.as_ref() != Some(&of) {
                if !keeps_posts(saved.as_ref(), &of) {
                    tx.execute("DELETE FROM subscription_posts WHERE site_id=?1", [&site])?;
                    tx.execute(
                        "DELETE FROM subscription_searches WHERE site_id=?1",
                        [&site],
                    )?;
                }
                let of = of.to_string();
                tx.execute(
                    "INSERT INTO subscription_sites(site_id,searches) VALUES (?1,?2)
                     ON CONFLICT(site_id) DO UPDATE SET searches=excluded.searches",
                    params![site, of],
                )?;
            }
            // Searches regrouped (a Danbooru tag got its first post) keep the posts read so far.
            let keys = queries.iter().map(|q| query_key(q)).collect::<HashSet<_>>();
            let mut stale = Vec::new();
            {
                let mut s =
                    tx.prepare("SELECT query FROM subscription_searches WHERE site_id=?1")?;
                for key in s.query_map([&site], |r| r.get::<_, String>(0))? {
                    let key = key?;
                    if !keys.contains(&key) {
                        stale.push(key);
                    }
                }
            }
            for key in stale {
                tx.execute(
                    "DELETE FROM subscription_searches WHERE site_id=?1 AND query=?2",
                    params![site, key],
                )?;
            }
            for query in queries {
                let key = query_key(&query);
                tx.execute(
                    "INSERT OR IGNORE INTO subscription_searches(site_id,query) VALUES (?1,?2)",
                    params![site, key],
                )?;
                let (head, tail, tail_at, synced_at): (String, String, Option<i64>, i64) = tx
                    .query_row(
                        "SELECT head,tail,tail_at,synced_at FROM subscription_searches
                         WHERE site_id=?1 AND query=?2",
                        params![site, key],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?;
                rows.push(Row {
                    site: index,
                    query,
                    head: serde_json::from_str(&head).map_err(|_| damaged())?,
                    tail: serde_json::from_str(&tail).map_err(|_| damaged())?,
                    tail_at,
                    synced_at,
                });
            }
        }
        tx.commit()?;
        Ok(rows)
    })
    .await
}

/// Whether a site's saved posts still belong to the feed after its searches changed from `saved`
/// to `now`: they do when the site is the same and every search followed before still is. Posts
/// do not record the search that found them, so a removed search clears the site's posts.
fn keeps_posts(saved: Option<&Value>, now: &Value) -> bool {
    let Some(saved) = saved else {
        return false;
    };
    let searches = |v: &Value| v["searches"].as_array().cloned().unwrap_or_default();
    let followed = searches(now);
    saved["engine"] == now["engine"]
        && saved["base"] == now["base"]
        && searches(saved).iter().all(|s| followed.contains(s))
}

/// Each post's sort date: its own, never later than the post above it (see
/// [`subs::run_dates`]); a page without dates takes the time it was read.
fn dated(posts: Vec<Value>, above: Option<i64>) -> Vec<(i64, Value)> {
    let at = now();
    let dates = subs::run_dates(&posts, above);
    posts
        .into_iter()
        .zip(dates)
        .map(|(mut post, date)| {
            let date = if date == i64::MAX { at } else { date };
            // Shown with the date it sorts by, so it never reads newer than a post above it.
            if subs::posted(&post).is_none_or(|d| d > date) {
                if let Some(text) = time::OffsetDateTime::from_unix_timestamp(date)
                    .ok()
                    .and_then(|d| {
                        d.format(&time::format_description::well_known::Rfc3339)
                            .ok()
                    })
                {
                    post["createdAt"] = json!(text);
                }
            }
            (date, post)
        })
        .collect()
}
/// A post read again (by a second search, or a later sync) keeps its place and the date shown
/// with it; the rest of it is updated.
fn save_posts(c: &Connection, site: &str, posts: &[(i64, Value)]) -> Result<()> {
    let mut s = c.prepare(
        "INSERT INTO subscription_posts(site_id,remote_id,sort_at,post) VALUES (?1,?2,?3,?4)
         ON CONFLICT(site_id,remote_id) DO UPDATE
         SET post=json_set(excluded.post,'$.createdAt',json_extract(post,'$.createdAt'))",
    )?;
    for (date, post) in posts {
        let id = post["remoteId"]
            .as_str()
            .ok_or_else(|| crate::booru_http::remote("The site sent a post without an ID."))?;
        s.execute(params![site, id, date, post.to_string()])?;
    }
    Ok(())
}

/// Reads the posts of `row` newer than the newest saved, or its first page when it has none.
/// Returns the posts saved.
async fn sync_row(db: &Database, t: &Transport, site: &Site, row: &Row) -> Result<Vec<Value>> {
    let first = row.unread();
    let known = row.head.iter().map(String::as_str).collect::<HashSet<_>>();
    let newest_known = row
        .head
        .iter()
        .filter_map(|id| id.parse::<u64>().ok())
        .max();
    let mut at = Position::default();
    let mut found = Vec::new();
    let mut reached = first;
    for _ in 0..if first { 1 } else { MAX_NEW_PAGES } {
        let read = subs::read(t, site, &row.query, &at).await?;
        let mut stop = false;
        for post in &read.posts {
            let id = post["remoteId"].as_str().unwrap_or_default();
            if known.contains(id)
                || subs::post_id(post)
                    .zip(newest_known)
                    .is_some_and(|(n, m)| n <= m)
            {
                stop = true;
                break;
            }
            found.push(post.clone());
        }
        at = read.after(&at);
        if stop || at.done {
            reached = true;
            break;
        }
    }
    let posts = dated(found, None);
    let mut head = posts
        .iter()
        .filter_map(|(_, p)| p["remoteId"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    head.extend(row.head.iter().cloned());
    head.truncate(HEAD_IDS);
    let oldest = posts.last().map(|(date, _)| *date);
    let (site_id, key, saved) = (site.id.clone(), query_key(&row.query), posts.clone());
    let kept = db
        .call(move |c| {
            let tx = c.transaction()?;
            if !followed(&tx, &site_id, &key)? {
                return Ok(false);
            }
            save_posts(&tx, &site_id, &saved)?;
            tx.execute(
            "UPDATE subscription_searches SET head=?3, synced_at=?4 WHERE site_id=?1 AND query=?2",
            params![site_id, key, json!(head).to_string(), now()],
        )?;
            if !reached || first {
                // A first read, or more new posts than one sync reads: older posts carry on from here.
                tx.execute(
                    "UPDATE subscription_searches SET tail=?3, tail_at=?4, done=?5
                 WHERE site_id=?1 AND query=?2",
                    params![
                        site_id,
                        key,
                        serde_json::to_string(&at).map_err(|e| Error::Storage(e.to_string()))?,
                        oldest.unwrap_or_else(now),
                        at.done
                    ],
                )?;
            }
            tx.commit()?;
            Ok(true)
        })
        .await?;
    Ok(saved_posts(kept, posts))
}

/// Whether `key` is still one of the site's searches. `prepare` drops a search whose
/// subscription was removed, with its posts, while a sync may still be reading it.
fn followed(c: &Connection, site: &str, key: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM subscription_searches WHERE site_id=?1 AND query=?2)",
        params![site, key],
        |r| r.get(0),
    )?)
}
fn saved_posts(kept: bool, posts: Vec<(i64, Value)>) -> Vec<Value> {
    if kept {
        posts.into_iter().map(|(_, p)| p).collect()
    } else {
        Vec::new()
    }
}

/// Reads the next older page of `row`. Returns the posts saved.
async fn read_older(db: &Database, t: &Transport, site: &Site, row: &Row) -> Result<Vec<Value>> {
    let read = subs::read(t, site, &row.query, &row.tail).await?;
    let next = read.after(&row.tail);
    let posts = dated(read.posts, row.tail_at);
    let oldest = posts.last().map(|(date, _)| *date).or(row.tail_at);
    let (site_id, key, saved) = (site.id.clone(), query_key(&row.query), posts.clone());
    let (from, to) = (
        serde_json::to_string(&row.tail).map_err(|e| Error::Storage(e.to_string()))?,
        serde_json::to_string(&next).map_err(|e| Error::Storage(e.to_string()))?,
    );
    let kept = db
        .call(move |c| {
            let tx = c.transaction()?;
            if !followed(&tx, &site_id, &key)? {
                return Ok(false);
            }
            // A sync that moved the tail meanwhile wins; these posts are saved either way.
            save_posts(&tx, &site_id, &saved)?;
            tx.execute(
                "UPDATE subscription_searches SET tail=?4, tail_at=?5, done=?6
             WHERE site_id=?1 AND query=?2 AND tail=?3",
                params![site_id, key, from, to, oldest, next.done],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await?;
    Ok(saved_posts(kept, posts))
}

type Work = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Value>>> + Send>>;
type Job = fn(Database, Transport, Site, Row) -> Work;
fn sync_job(db: Database, t: Transport, site: Site, row: Row) -> Work {
    Box::pin(async move { sync_row(&db, &t, &site, &row).await })
}
fn older_job(db: Database, t: Transport, site: Site, row: Row) -> Work {
    Box::pin(async move { read_older(&db, &t, &site, &row).await })
}

/// Runs `job` on each row, a few at a time per site. Returns the posts saved, by site index, and
/// the first error of each site that failed. With `count`, each finished row counts in
/// `subscription_progress`.
async fn run(
    db: &Database,
    t: &Transport,
    sites: &[Site],
    rows: Vec<Row>,
    job: Job,
    count: bool,
) -> (Vec<(usize, Value)>, HashMap<usize, String>) {
    let mut queued = rows.into_iter().collect::<std::collections::VecDeque<_>>();
    let mut running = vec![0; sites.len()];
    let mut pending = tokio::task::JoinSet::new();
    let (mut saved, mut failed) = (Vec::new(), HashMap::new());
    loop {
        while pending.len() < subs::PARALLEL_SEARCHES {
            let Some(at) = queued
                .iter()
                .position(|r| running[r.site] < subs::parallel_searches(&sites[r.site]))
            else {
                break;
            };
            let row = queued.remove(at).unwrap();
            running[row.site] += 1;
            let index = row.site;
            let work = job(db.clone(), t.clone(), sites[index].clone(), row);
            pending.spawn(async move { (index, work.await) });
        }
        let Some(done) = pending.join_next().await else {
            break;
        };
        match done {
            Ok((index, result)) => {
                running[index] -= 1;
                if count {
                    if let Some((read, _)) = db
                        .subscription_progress
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .as_mut()
                    {
                        *read += 1;
                    }
                }
                match result {
                    Ok(posts) => saved.extend(posts.into_iter().map(|p| (index, p))),
                    Err(e) => {
                        failed.entry(index).or_insert_with(|| e.to_string());
                        // The other searches of a failing site would fail the same way.
                        queued.retain(|r| r.site != index);
                    }
                }
            }
            // A task that panicked keeps its slot: its site has failed anyway.
            Err(e) => eprintln!("[developer] A subscription search task failed: {e}"),
        }
    }
    (saved, failed)
}

/// Reads the new posts of every enabled site. `background` leaves out sites whose pages only
/// GoonCave's browser can load: each sync would start a browser process, and opening the feed
/// syncs them. A sync already running covers this one.
pub(crate) async fn sync(db: &Database, t: &Transport, background: bool) {
    let Ok(_guard) = db.subscription_feed.try_lock() else {
        return;
    };
    let sites = match boorus::sites(db).await {
        Ok(sites) => sites
            .into_iter()
            .filter(|s| s.enabled && !(background && crate::browser::site(&s.base).is_some()))
            .collect::<Vec<_>>(),
        Err(e) => {
            eprintln!("[developer] The subscriptions sync could not read the sites: {e}");
            return;
        }
    };
    if sites.iter().any(|s| s.engine == "furaffinity") {
        // The inbox follows the watchlist; a running watchlist sync (Settings) covers it.
        if let Ok(_watchlist) = db.subscriptions.try_lock() {
            match subs::sync_artists(db, t, &sites).await {
                Ok(errors) => {
                    for error in errors {
                        eprintln!("[developer] FurAffinity watchlist sync failed: {error}");
                    }
                }
                Err(e) => eprintln!("[developer] FurAffinity watchlist sync failed: {e}"),
            }
        }
    }
    for (site, error) in sync_sites(db, t, &sites, false).await {
        eprintln!(
            "[developer] The subscriptions of {} did not sync: {error}",
            sites[site].name
        );
    }
}
/// Syncs `sites`, or with `opening` only the searches the feed has to read before it answers
/// (see [`Row::behind`]). The caller holds `subscription_feed`. Returns the first error of each
/// site that failed, by index.
async fn sync_sites(
    db: &Database,
    t: &Transport,
    sites: &[Site],
    opening: bool,
) -> HashMap<usize, String> {
    let rows = match prepare(db, t, sites).await {
        Ok(rows) => rows,
        Err(e) => return (0..sites.len()).map(|i| (i, e.to_string())).collect(),
    };
    let cutoff = now() - RETENTION_DAYS * 86_400;
    if let Err(e) = db
        .call(move |c| {
            let tx = c.transaction()?;
            tx.execute(
                "DELETE FROM subscription_posts WHERE sort_at < ?1",
                [cutoff],
            )?;
            // The feed ends where the kept posts end: reading on would show posts the next sync
            // deletes, and leave a gap where it already did.
            tx.execute(
                "UPDATE subscription_searches SET done=1 WHERE tail_at < ?1",
                [cutoff],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    {
        eprintln!("[developer] Old subscription posts were not deleted: {e}");
    }
    let recent = now() - SYNCED_RECENTLY;
    let rows = rows
        .into_iter()
        .filter(|r| {
            if opening {
                r.behind(&sites[r.site], now())
            } else {
                r.unread() || r.synced_at < recent
            }
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return HashMap::new();
    }
    let progress = || {
        db.subscription_progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    };
    *progress() = Some((0, rows.len()));
    let (saved, failed) = run(db, t, sites, rows, sync_job, true).await;
    *progress() = None;
    hits(db, sites, &saved).await;
    failed
}
/// Only the Settings filter depends on it: a failure must not stop the feed.
async fn hits(db: &Database, sites: &[Site], saved: &[(usize, Value)]) {
    let lists = db
        .call(|c| Ok((store::searches(c)?, store::artists(c)?)))
        .await;
    let result = match lists {
        Ok((tags, artists)) => subs::record_site_hits(db, sites, &tags, &artists, saved).await,
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        eprintln!("[developer] The subscription site hits were not saved: {e}");
    }
}
/// Syncs the feed every 15 minutes, starting when the app starts.
/// The first sync waits a full period: at launch it would read every search at once while the
/// gallery loads, and opening the feed syncs anyway.
fn sync_schedule() -> tokio::time::Interval {
    let mut interval =
        tokio::time::interval_at(tokio::time::Instant::now() + SYNC_EVERY, SYNC_EVERY);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval
}
pub(crate) async fn watch(db: Database) {
    let mut interval = sync_schedule();
    loop {
        interval.tick().await;
        sync(&db, &Transport::default(), true).await;
    }
}

/// The place after the last post shown: the feed is ordered by date, newest first, then by site
/// and post ID.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    at: i64,
    site: String,
    id: String,
}
impl Key {
    fn top() -> Self {
        Self {
            at: i64::MAX,
            site: String::new(),
            id: String::new(),
        }
    }
    fn decode(raw: &str) -> Result<Self> {
        let invalid = || Error::Invalid("This feed position is not valid. Reload the feed.".into());
        if raw.len() > 1000 {
            return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }
    fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).unwrap())
    }
}
fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}
type SavedPage = (Vec<(Key, Value)>, Option<i64>);
/// Posts after `key` down to the oldest saved date of a search that may have older posts
/// (`floor`), at most `limit + 1`, and that floor.
fn saved_page(
    c: &Connection,
    sites: &[String],
    key: &Key,
    limit: usize,
    unread: bool,
) -> Result<SavedPage> {
    let ids = placeholders(sites.len());
    let floor: Option<i64> = c.query_row(
        &format!(
            "SELECT max(tail_at) FROM subscription_searches
             WHERE site_id IN ({ids}) AND done=0 AND tail_at IS NOT NULL"
        ),
        params_from_iter(sites),
        |r| r.get(0),
    )?;
    let unread = if unread {
        "AND NOT EXISTS(SELECT 1 FROM read_marks m WHERE m.scope='post' AND m.user_id=?
            AND m.item_key=p.site_id||':'||p.remote_id)"
    } else {
        ""
    };
    let mut args: Vec<rusqlite::types::Value> = sites.iter().cloned().map(Into::into).collect();
    args.extend([
        key.at.into(),
        key.at.into(),
        key.site.clone().into(),
        key.at.into(),
        key.site.clone().into(),
        key.id.clone().into(),
        floor.unwrap_or(i64::MIN).into(),
    ]);
    if !unread.is_empty() {
        args.push(OWNER_ID.to_owned().into());
    }
    args.push((limit as i64 + 1).into());
    let mut s = c.prepare(&format!(
        "SELECT site_id,remote_id,sort_at,post FROM subscription_posts p
         WHERE site_id IN ({ids})
           AND (sort_at<? OR (sort_at=? AND site_id>?) OR (sort_at=? AND site_id=? AND remote_id>?))
           AND sort_at>=? {unread}
         ORDER BY sort_at DESC, site_id, remote_id LIMIT ?"
    ))?;
    let rows = s
        .query_map(params_from_iter(args), |r| {
            Ok((
                Key {
                    site: r.get(0)?,
                    id: r.get(1)?,
                    at: r.get(2)?,
                },
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let posts = rows
        .into_iter()
        .map(|(key, post)| Ok((key, serde_json::from_str(&post).map_err(|_| damaged())?)))
        .collect::<Result<Vec<_>>>()?;
    Ok((posts, floor))
}
/// The searches that may have older posts, highest oldest date first.
fn open_searches(c: &Connection, sites: &[Site]) -> Result<Vec<Row>> {
    let ids = sites.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    let mut s = c.prepare(&format!(
        "SELECT site_id,query,head,tail,tail_at,synced_at FROM subscription_searches
         WHERE site_id IN ({}) AND done=0 AND tail_at IS NOT NULL ORDER BY tail_at DESC",
        placeholders(ids.len())
    ))?;
    let rows = s
        .query_map(params_from_iter(&ids), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(site, query, head, tail, tail_at, synced_at)| {
            Ok(Row {
                site: ids.iter().position(|id| *id == site).unwrap(),
                query: serde_json::from_str(&query).map_err(|_| damaged())?,
                head: serde_json::from_str(&head).map_err(|_| damaged())?,
                tail: serde_json::from_str(&tail).map_err(|_| damaged())?,
                tail_at: Some(tail_at),
                synced_at,
            })
        })
        .collect()
}

#[derive(Default)]
struct FeedQuery {
    limit: usize,
    cursor: Option<Key>,
    sites: Option<HashSet<String>>,
    unread: bool,
}
fn feed_query(q: &HashMap<String, String>) -> Result<FeedQuery> {
    let limit = q
        .get("limit")
        .map(|s| {
            s.parse::<usize>()
                .ok()
                .filter(|n| (1..=100).contains(n))
                .ok_or_else(|| Error::Invalid("limit must be from 1 through 100.".into()))
        })
        .transpose()?
        .unwrap_or(subs::PAGE_SIZE);
    let sites = match q.get("sites") {
        Some(raw) if raw.len() <= 2000 => Some(
            raw.split(|c: char| c == ',' || c.is_whitespace())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        ),
        Some(_) => return Err(Error::Invalid("The site selection is too long.".into())),
        None => None,
    };
    Ok(FeedQuery {
        limit,
        cursor: q
            .get("cursor")
            .filter(|s| !s.is_empty())
            .map(|s| Key::decode(s))
            .transpose()?,
        sites,
        unread: q.get("unread").is_some_and(|v| v == "1" || v == "true"),
    })
}
async fn chosen_sites(db: &Database, wanted: &Option<HashSet<String>>) -> Result<Vec<Site>> {
    Ok(boorus::sites(db)
        .await?
        .into_iter()
        .filter(|s| s.enabled && wanted.as_ref().is_none_or(|ids| ids.contains(&s.id)))
        .collect())
}
async fn feed(
    State(db): State<Database>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let q = feed_query(&q)?;
    let sites = chosen_sites(&db, &q.sites).await?;
    let t = Transport::default();
    let page = page(&db, &t, sites, q).await?;
    Ok(Json(page))
}
/// One feed page from the saved posts. The first page reads the searches never read before and
/// starts a sync in the background; the posts it finds wait above (see [`new_posts`]).
async fn page(db: &Database, t: &Transport, sites: Vec<Site>, q: FeedQuery) -> Result<Value> {
    let mut failed = HashMap::new();
    if q.cursor.is_none() {
        let pending = prepare(db, t, &sites).await?;
        if pending.iter().any(|r| r.behind(&sites[r.site], now())) {
            let _guard = db.subscription_feed.lock().await;
            failed = sync_sites(db, t, &sites, true).await;
        }
        let (db, t) = (db.clone(), t.clone());
        tokio::spawn(async move { sync(&db, &t, false).await });
    }
    let key = q.cursor.clone().unwrap_or_else(Key::top);
    let deadline = Instant::now() + READ_BUDGET;
    let (posts, floor) = loop {
        let ok = sites
            .iter()
            .enumerate()
            .filter(|(i, _)| !failed.contains_key(i))
            .map(|(_, s)| s.clone())
            .collect::<Vec<_>>();
        if ok.is_empty() {
            break (vec![], None);
        }
        let (ids, key, limit, unread) = (
            ok.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            key.clone(),
            q.limit,
            q.unread,
        );
        let (posts, floor) = db
            .call(move |c| saved_page(c, &ids, &key, limit, unread))
            .await?;
        if posts.len() >= q.limit || floor.is_none() || Instant::now() >= deadline {
            break (posts, floor);
        }
        // Not a page yet: read the searches whose oldest saved post is the newest.
        let held = sites.clone();
        let open = db.call(move |c| open_searches(c, &held)).await?;
        let mut per_site = HashMap::<usize, usize>::new();
        let batch = open
            .into_iter()
            .filter(|r| !failed.contains_key(&r.site))
            .filter(|r| {
                let n = per_site.entry(r.site).or_default();
                *n += 1;
                *n <= subs::parallel_searches(&sites[r.site])
            })
            .take(subs::PARALLEL_SEARCHES)
            .collect::<Vec<_>>();
        let (saved, errors) = run(db, t, &sites, batch, older_job, false).await;
        hits(db, &sites, &saved).await;
        failed.extend(errors);
    };
    let has_more = posts.len() > q.limit || floor.is_some();
    let posts = posts.into_iter().take(q.limit).collect::<Vec<_>>();
    let next = posts.last().map(|(k, _)| k.clone()).unwrap_or(key);
    let newest = match posts.first() {
        Some((k, _)) => Some(k.at),
        // An empty feed still counts what a sync saves after it.
        None if q.cursor.is_none() && !sites.is_empty() => {
            let ids = sites.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
            Some(
                db.call(move |c| {
                    Ok(c.query_row(
                        &format!(
                            "SELECT coalesce(max(sort_at), 0) FROM subscription_posts
                             WHERE site_id IN ({})",
                            placeholders(ids.len())
                        ),
                        params_from_iter(&ids),
                        |r| r.get::<_, i64>(0),
                    )?)
                })
                .await?,
            )
        }
        None => None,
    };
    let media = explore::media_key(db).await?;
    let mut grouped = HashMap::<String, Vec<Value>>::new();
    for (k, post) in &posts {
        grouped
            .entry(k.site.clone())
            .or_default()
            .push(post.clone());
    }
    let mut decorated = HashMap::new();
    for site in &sites {
        if let Some(list) = grouped.remove(&site.id) {
            for post in explore::decorate(db, site, list, &media).await? {
                let id = post["remoteId"].as_str().unwrap_or_default().to_owned();
                decorated.insert((site.id.clone(), id), post);
            }
        }
    }
    let shown = posts
        .into_iter()
        .filter_map(|(k, _)| decorated.remove(&(k.site, k.id)))
        .collect::<Vec<_>>();
    let errors = failed
        .into_iter()
        .map(|(i, e)| crate::booru_http::site_error(&sites[i].id, &sites[i].name, &e))
        .collect::<Vec<_>>();
    Ok(json!({
        "posts": shown,
        "hasMore": has_more,
        "nextCursor": has_more.then(|| next.encode()),
        "newestAt": newest,
        "siteErrors": errors,
    }))
}
/// The searches the running sync has read and has to read: `read` and `total`, both null when
/// no sync runs. A failed site's searches never count as read.
async fn progress(State(db): State<Database>) -> Json<Value> {
    let progress = *db
        .subscription_progress
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    Json(match progress {
        Some((read, total)) => json!({"read": read, "total": total}),
        None => json!({"read": null, "total": null}),
    })
}
/// How many saved posts are newer than `after` (a feed's `newestAt`): what a sync found while
/// the feed was open.
async fn new_posts(
    State(db): State<Database>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let after = q
        .get("after")
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| Error::Invalid("Supply after as seconds since 1970.".into()))?;
    let options = feed_query(&q)?;
    let ids = chosen_sites(&db, &options.sites)
        .await?
        .into_iter()
        .map(|s| s.id)
        .collect::<Vec<_>>();
    let count = db
        .call(move |c| {
            if ids.is_empty() {
                return Ok(0);
            }
            let unread = if options.unread {
                "AND NOT EXISTS(SELECT 1 FROM read_marks m WHERE m.scope='post' AND m.user_id=?
                    AND m.item_key=p.site_id||':'||p.remote_id)"
            } else {
                ""
            };
            let mut args: Vec<rusqlite::types::Value> =
                ids.iter().cloned().map(Into::into).collect();
            args.push(after.into());
            if options.unread {
                args.push(OWNER_ID.to_owned().into());
            }
            Ok(c.query_row(
                &format!(
                    "SELECT count(*) FROM subscription_posts p
                     WHERE site_id IN ({}) AND sort_at>? {unread}",
                    placeholders(ids.len())
                ),
                params_from_iter(args),
                |r| r.get::<_, i64>(0),
            )?)
        })
        .await?;
    Ok(Json(json!({ "count": count })))
}

/// Keeps a saved post's favorite as the person set it, until the next sync reads it again.
pub(crate) async fn set_favorited(
    db: &Database,
    site: &str,
    id: &str,
    favorited: bool,
) -> Result<()> {
    let (site, id) = (site.to_owned(), id.to_owned());
    db.call(move |c| {
        c.execute(
            "UPDATE subscription_posts SET post=json_set(post,'$.favorited',json(?3))
             WHERE site_id=?1 AND remote_id=?2",
            params![site, id, if favorited { "true" } else { "false" }],
        )?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::write_setting;
    use axum::{extract::Request, response::IntoResponse, routing::any};
    use std::sync::{Arc, Mutex};

    type Posts = Arc<Mutex<Vec<(u64, &'static str, i64)>>>;

    fn t() -> Transport {
        Transport {
            allow_loopback: true,
        }
    }
    /// An e621 that holds `posts` as (id, tag, unix seconds) and answers `~a ~b` (any of),
    /// `a b` (all of), `page=N` and `page=b<id>` as e621 does, newest ID first.
    async fn booru(posts: Posts) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
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
                let mut rows = posts.lock().unwrap().iter()
                    .filter(|(_, tag, _)| all.iter().all(|t| *t == tag) && (any.is_empty() || any.contains(tag)))
                    .cloned()
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
    /// A site `fixture` of `engine` at `base`, saved with that address so a background sync
    /// sees the same searches.
    async fn setup(db: &Database, engine: &str, base: &str) -> Site {
        let (engine, base) = (engine.to_owned(), base.to_owned());
        db.call(move |c| {
            c.execute("INSERT INTO user_booru_sites(id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at)
                VALUES ('fixture',?1,'Fixture',?2,?3,0,1,0,'2026-10-12','2026-10-12')",params![OWNER_ID, engine, base])?;Ok(())
        }).await.unwrap();
        let mut site = boorus::site(db, "fixture".into()).await.unwrap().unwrap();
        site.base = base_of(db).await;
        site
    }
    async fn base_of(db: &Database) -> String {
        db.call(|c| {
            Ok(c.query_row(
                "SELECT base_url FROM user_booru_sites WHERE id='fixture'",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
    }
    async fn subscribe(db: &Database, tags: Value) {
        db.call(move |c| write_setting(c, "subscriptions.tags", &tags))
            .await
            .unwrap();
    }
    fn options(cursor: Option<Key>, limit: usize, unread: bool) -> FeedQuery {
        FeedQuery {
            limit,
            cursor,
            sites: None,
            unread,
        }
    }
    /// Reads the whole feed of `sites` `limit` posts at a time, as Show more does: the ids shown
    /// and the site errors.
    async fn read_feed(
        db: &Database,
        sites: &[Site],
        limit: usize,
        unread: bool,
    ) -> (Vec<String>, Vec<Value>) {
        let (mut ids, mut errors, mut cursor) = (vec![], vec![], None);
        for _ in 0..200 {
            let page = page(db, &t(), sites.to_vec(), options(cursor, limit, unread))
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
            cursor = Some(Key::decode(next).unwrap());
        }
        panic!("the feed never ended");
    }
    fn ids(range: impl DoubleEndedIterator<Item = u64>) -> Vec<String> {
        range.rev().map(|id| id.to_string()).collect()
    }
    fn open() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn every_post_of_a_search_comes_once_in_order_even_past_its_first_page() {
        let posts = (1..=100)
            .map(|id| {
                (
                    id,
                    if id % 2 == 0 { "fox" } else { "wolf" },
                    1_800_000_000 + id as i64 * 60,
                )
            })
            .collect();
        let (base, requests, task) = booru(Arc::new(Mutex::new(posts))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox", "wolf"])).await;
        let (shown, errors) = read_feed(&db, &[site], 30, false).await;
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
        let (base, _, task) = booru(Arc::new(Mutex::new(posts.clone()))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox score:>10", "wolf"])).await;
        let (shown, _) = read_feed(&db, &[site], 25, false).await;
        posts.sort_by_key(|p| std::cmp::Reverse(p.2));
        assert_eq!(
            shown,
            posts.iter().map(|p| p.0.to_string()).collect::<Vec<_>>()
        );
        task.abort();
    }
    #[tokio::test]
    async fn a_sync_saves_every_new_post_and_they_wait_above_an_open_feed() {
        // #710: a refresh that read only the newest page left the rest to land inside older days.
        let at = 1_800_000_000;
        let posts: Posts = Arc::new(Mutex::new(
            (1..=50).map(|id| (id, "fox", at + id as i64)).collect(),
        ));
        let (base, requests, task) = booru(posts.clone()).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        let first = page(&db, &t(), vec![site.clone()], options(None, 10, false))
            .await
            .unwrap();
        let newest = first["newestAt"].as_i64().unwrap();
        let cursor = Key::decode(first["nextCursor"].as_str().unwrap()).unwrap();
        // 100 posts arrive, more than two pages.
        posts
            .lock()
            .unwrap()
            .extend((51..=150).map(|id| (id, "fox", at + id as i64)));
        let _guard = db.subscription_feed.lock().await;
        db.call(|c| {
            c.execute("UPDATE subscription_searches SET synced_at=0", [])?;
            Ok(())
        })
        .await
        .unwrap();
        let failed = sync_sites(&db, &t(), std::slice::from_ref(&site), false).await;
        assert!(failed.is_empty(), "{failed:?}");
        drop(_guard);
        // Show more carries on below the posts shown, and the new ones are counted above.
        let more = page(
            &db,
            &t(),
            vec![site.clone()],
            options(Some(cursor), 10, false),
        )
        .await
        .unwrap();
        assert_eq!(more["posts"][0]["remoteId"], "40");
        let count: i64 = db
            .call(move |c| {
                Ok(c.query_row(
                    "SELECT count(*) FROM subscription_posts WHERE sort_at>?1",
                    [newest],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(count, 100);
        let reopened = page(&db, &t(), vec![site], options(None, 150, false))
            .await
            .unwrap();
        let shown = reopened["posts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["remoteId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(shown[..110], ids(41..=150)[..]);
        // The sync stopped at the newest post saved before instead of reading the whole search.
        let syncs = requests.lock().unwrap().len();
        assert!(syncs < 10, "{syncs} requests");
        task.abort();
    }
    #[tokio::test]
    async fn unread_only_skips_read_posts_without_asking_the_site_again() {
        let posts = (1..=60)
            .map(|id| (id, "fox", 1_800_000_000 + id as i64))
            .collect();
        let (base, requests, task) = booru(Arc::new(Mutex::new(posts))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        read_feed(&db, std::slice::from_ref(&site), 40, false).await;
        let asked = requests.lock().unwrap().len();
        db.call(|c| {
            for id in 11..=60 {
                c.execute("INSERT INTO read_marks(scope,item_key,user_id,read_at) VALUES ('post',?1,?2,'2026-11-19')",
                    params![format!("fixture:{id}"), OWNER_ID])?;
            }
            Ok(())
        }).await.unwrap();
        let (shown, _) = read_feed(&db, std::slice::from_ref(&site), 40, true).await;
        assert_eq!(shown, ids(1..=10));
        assert_eq!(requests.lock().unwrap().len(), asked);
        // Everything read: the empty feed still counts posts saved above the newest one.
        db.call(|c| {
            for id in 1..=10 {
                c.execute("INSERT INTO read_marks(scope,item_key,user_id,read_at) VALUES ('post',?1,?2,'2026-11-19')",
                    params![format!("fixture:{id}"), OWNER_ID])?;
            }
            Ok(())
        }).await.unwrap();
        let empty = page(&db, &t(), vec![site], options(None, 40, true))
            .await
            .unwrap();
        assert_eq!(empty["posts"], json!([]));
        assert_eq!(empty["newestAt"], 1_800_000_060);
        task.abort();
    }
    #[tokio::test]
    async fn changed_subscriptions_read_the_site_again() {
        let posts = vec![(1, "fox", 1_800_000_000), (2, "wolf", 1_800_000_100)];
        let (base, _, task) = booru(Arc::new(Mutex::new(posts))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox", "wolf"])).await;
        assert_eq!(
            read_feed(&db, std::slice::from_ref(&site), 40, false)
                .await
                .0,
            ["2", "1"]
        );
        subscribe(&db, json!(["fox"])).await;
        assert_eq!(read_feed(&db, &[site], 40, false).await.0, ["1"]);
        task.abort();
    }
    #[tokio::test]
    async fn a_sync_still_reading_a_removed_search_does_not_bring_its_posts_back() {
        let posts = vec![(1, "fox", 1_800_000_000), (2, "wolf", 1_800_000_100)];
        let (base, _, task) = booru(Arc::new(Mutex::new(posts))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox", "wolf"])).await;
        let sites = vec![site.clone()];
        let reading = prepare(&db, &t(), &sites).await.unwrap().remove(0);
        // The feed opens after `wolf` is removed, while the sync still reads `~fox ~wolf`.
        subscribe(&db, json!(["fox"])).await;
        prepare(&db, &t(), &sites).await.unwrap();
        assert!(sync_row(&db, &t(), &site, &reading)
            .await
            .unwrap()
            .is_empty());
        let mut older = reading.clone();
        older.tail_at = Some(1_800_000_200);
        assert!(read_older(&db, &t(), &site, &older)
            .await
            .unwrap()
            .is_empty());
        let saved: i64 = db
            .call(|c| Ok(c.query_row("SELECT count(*) FROM subscription_posts", [], |r| r.get(0))?))
            .await
            .unwrap();
        assert_eq!(saved, 0);
        task.abort();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_first_opening_reports_how_many_searches_it_has_read() {
        let posts = Arc::new(Mutex::new(vec![(1, "fox", 1_800_000_000)]));
        let (base, _, task) = booru(posts.clone()).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        // Holding the site's posts keeps its answer waiting while the feed opens.
        let (locked, release) = (std::sync::mpsc::channel(), std::sync::mpsc::channel::<()>());
        let held = posts.clone();
        let holder = std::thread::spawn(move || {
            let _posts = held.lock().unwrap();
            locked.0.send(()).unwrap();
            release.1.recv().unwrap();
        });
        locked.1.recv().unwrap();
        let opening = {
            let db = db.clone();
            tokio::spawn(async move { page(&db, &t(), vec![site], options(None, 40, false)).await })
        };
        let mut seen = json!(null);
        for _ in 0..200 {
            seen = progress(State(db.clone())).await.0;
            if !seen["total"].is_null() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(seen, json!({"read": 0, "total": 1}));
        release.0.send(()).unwrap();
        holder.join().unwrap();
        let first = opening.await.unwrap().unwrap();
        assert_eq!(first["posts"].as_array().unwrap().len(), 1);
        assert_eq!(
            progress(State(db.clone())).await.0,
            json!({"read": null, "total": null})
        );
        task.abort();
    }
    #[tokio::test(start_paused = true)]
    async fn launching_the_app_reads_no_search_before_the_first_period() {
        let mut schedule = sync_schedule();
        let early = SYNC_EVERY - Duration::from_secs(1);
        assert!(tokio::time::timeout(early, schedule.tick()).await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_secs(2), schedule.tick())
                .await
                .is_ok()
        );
    }
    #[tokio::test]
    async fn opening_the_feed_reads_browser_sites_the_periodic_sync_left_out() {
        let (_dir, db) = open();
        let mut site = setup(&db, "e621", "https://e621.net").await;
        let read = |synced_at| Row {
            site: 0,
            query: vec!["fox".into()],
            head: vec!["1".into()],
            tail: {
                let mut tail = Position::default();
                tail.done = true;
                tail
            },
            tail_at: Some(1),
            synced_at,
        };
        let now = 1_800_000_000;
        let stale = now - SYNC_EVERY.as_secs() as i64 - 1;
        assert!(!read(stale).behind(&site, now));
        site.base = "https://www.furaffinity.net".into();
        assert!(read(stale).behind(&site, now));
        assert!(!read(now - 60).behind(&site, now));
    }
    #[tokio::test]
    async fn a_new_subscription_keeps_the_posts_saved_before() {
        let posts = Arc::new(Mutex::new(vec![(1, "fox", 1_800_000_000)]));
        let (base, _, task) = booru(posts.clone()).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        assert_eq!(
            read_feed(&db, std::slice::from_ref(&site), 40, false)
                .await
                .0,
            ["1"]
        );
        // The site no longer lists post 1, so only the saved copy can show it.
        *posts.lock().unwrap() = vec![(2, "wolf", 1_800_000_100)];
        subscribe(&db, json!(["fox", "wolf"])).await;
        assert_eq!(read_feed(&db, &[site], 40, false).await.0, ["2", "1"]);
        task.abort();
    }
    #[test]
    fn saved_posts_go_when_a_search_or_the_site_changes() {
        let of = |base: &str, searches: &[&str]| json!({"engine": "e621", "base": base, "searches": searches});
        let saved = of("https://e621.net", &["fox", "wolf"]);
        let keeps = |now: Value| keeps_posts(Some(&saved), &now);
        assert!(keeps(of("https://e621.net", &["wolf", "fox", "cat"])));
        assert!(!keeps(of("https://e621.net", &["fox"])));
        assert!(!keeps(of("https://e926.net", &["fox", "wolf"])));
        assert!(!keeps_posts(None, &saved));
    }
    #[tokio::test]
    async fn a_failing_site_is_reported_and_the_others_still_load() {
        let posts = (1..=3)
            .map(|id| (id, "fox", 1_800_000_000 + id as i64))
            .collect();
        let (base, _, task) = booru(Arc::new(Mutex::new(posts))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        db.call(|c| {
            c.execute("INSERT INTO user_booru_sites(id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at)
                VALUES ('broken',?1,'Broken','e621','http://127.0.0.1:1',0,1,1,'2026-10-12','2026-10-12')",[OWNER_ID])?;Ok(())
        }).await.unwrap();
        subscribe(&db, json!(["fox"])).await;
        let broken = Site {
            id: "broken".into(),
            name: "Broken".into(),
            base: "http://127.0.0.1:1".into(),
            ..site.clone()
        };
        let (shown, errors) = read_feed(&db, &[site, broken], 40, false).await;
        assert_eq!(shown, ["3", "2", "1"]);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["siteId"], "broken");
        task.abort();
    }
    #[tokio::test]
    async fn a_post_dated_by_a_later_edit_never_reads_newer_than_the_post_above_it() {
        // Post 2 was uploaded before post 3, but the site dates it by an edit an hour later.
        let at = 1_800_000_000;
        let posts = vec![(3, "fox", at), (2, "fox", at + 3600), (1, "fox", at - 3600)];
        let (base, _, task) = booru(Arc::new(Mutex::new(posts))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        let first = page(&db, &t(), vec![site], options(None, 40, false))
            .await
            .unwrap();
        let shown = first["posts"]
            .as_array()
            .unwrap()
            .iter()
            .map(subs::posted)
            .collect::<Vec<_>>();
        assert_eq!(shown, [Some(at), Some(at), Some(at - 3600)]);
        task.abort();
    }
    #[tokio::test]
    async fn a_post_read_again_keeps_the_date_it_sorts_by() {
        let (_dir, db) = open();
        setup(&db, "e621", "https://fixture.example").await;
        let shown = db
            .call(|c| {
                let post =
                    |at: &str, score: i64| json!({"remoteId":"7","createdAt":at,"score":score});
                save_posts(c, "fixture", &[(100, post("1970-01-01T00:01:40Z", 1))])?;
                // A second search dates the same post by a later edit.
                save_posts(c, "fixture", &[(200, post("1970-01-01T00:03:20Z", 2))])?;
                Ok(c.query_row(
                    "SELECT sort_at, json_extract(post,'$.createdAt'), json_extract(post,'$.score')
                     FROM subscription_posts",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                        ))
                    },
                )?)
            })
            .await
            .unwrap();
        assert_eq!(shown, (100, "1970-01-01T00:01:40Z".to_owned(), 2));
    }
    #[tokio::test]
    async fn the_saved_posts_record_where_each_search_has_results() {
        let (base, _, task) = booru(Arc::new(Mutex::new(vec![(1, "wolf", 1_800_000_000)]))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["wolf score:>5", "fox"])).await;
        read_feed(&db, &[site], 40, false).await;
        let hits = db.call(|c| store::site_hits(c)).await.unwrap();
        assert_eq!(hits["wolf score:>5"], ["fixture"]);
        assert!(!hits.contains_key("fox"));
        task.abort();
    }
    #[tokio::test]
    async fn posts_past_a_year_are_deleted_and_the_feed_ends_there() {
        let (base, _, task) = booru(Arc::new(Mutex::new(
            (1..=50)
                .map(|id| (id, "fox", now() - 400 * 86_400 + id as i64))
                .collect(),
        )))
        .await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        let first = page(&db, &t(), vec![site.clone()], options(None, 40, false))
            .await
            .unwrap();
        assert_eq!(first["posts"].as_array().unwrap().len(), 40);
        let _guard = db.subscription_feed.lock().await;
        sync_sites(&db, &t(), std::slice::from_ref(&site), false).await;
        drop(_guard);
        let (shown, _) = read_feed(&db, &[site], 40, false).await;
        assert!(shown.is_empty(), "{shown:?}");
        task.abort();
    }
    #[tokio::test]
    async fn a_favorite_set_from_the_feed_stays_on_the_saved_post() {
        let (base, _, task) = booru(Arc::new(Mutex::new(vec![(1, "fox", 1_800_000_000)]))).await;
        let (_dir, db) = open();
        let site = setup(&db, "e621", &base).await;
        subscribe(&db, json!(["fox"])).await;
        read_feed(&db, std::slice::from_ref(&site), 40, false).await;
        set_favorited(&db, "fixture", "1", true).await.unwrap();
        let page = page(&db, &t(), vec![site], options(None, 40, false))
            .await
            .unwrap();
        assert_eq!(page["posts"][0]["favorited"], true);
        task.abort();
    }
    #[tokio::test]
    async fn danbooru_skips_the_tags_it_has_no_posts_for() {
        let requests = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = requests.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let requests = captured.clone();
            async move {
                let (path, query) = (request.uri().path().to_owned(), request.uri().query().unwrap_or("").to_owned());
                let url = reqwest::Url::parse(&format!("https://fixture.example/?{query}")).unwrap();
                let params = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
                match path.as_str() {
                    "/tags.json" => {
                        requests.lock().unwrap().push("tags".into());
                        Json(json!([{"name":"fox","post_count":5},{"name":"wolf","post_count":3},{"name":"ghost_tag","post_count":0}]))
                    }
                    "/tag_aliases.json" => Json(json!([{"antecedent_name":"old_name"}])),
                    _ => {
                        requests.lock().unwrap().push(format!("{} page={}", params["tags"], params["page"]));
                        let first = !params["page"].starts_with('b') && params["tags"] == "~fox ~wolf";
                        Json(json!((first.then_some(61..=100).into_iter().flatten()).rev().map(|id| json!({
                            "id":id,"file_url":"https://cdn.example.com/file.png","tag_string_general":"fox",
                            "created_at":format!("2026-11-{:02}T00:00:00Z", id % 28 + 1)}))
                            .collect::<Vec<_>>()))
                    }
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_dir, db) = open();
        let site = setup(&db, "danbooru", &base).await;
        subscribe(&db, json!(["fox", "ghost_tag", "wolf", "owl", "old_name"])).await;
        read_feed(&db, &[site], 30, false).await;
        server.abort();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|r| *r == "tags").count(), 1);
        let searched = requests
            .iter()
            .filter(|r| *r != "tags")
            .flat_map(|r| {
                r.split(" page=")
                    .next()
                    .unwrap()
                    .split(' ')
                    .map(|t| t.trim_start_matches('~'))
            })
            .collect::<HashSet<_>>();
        assert_eq!(searched, HashSet::from(["fox", "wolf", "old_name"]));
    }
    #[tokio::test]
    async fn the_furaffinity_inbox_carries_on_from_the_last_post_read() {
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
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_dir, db) = open();
        setup(&db, "furaffinity", &base).await;
        db.call(|c| {c.execute("UPDATE user_booru_sites SET username='fixture-owner',session_cookie='a=fake;b=fake' WHERE id='fixture'",[])?;Ok(())}).await.unwrap();
        let site = Site {
            base,
            ..boorus::site(&db, "fixture".into()).await.unwrap().unwrap()
        };
        let (shown, errors) = read_feed(&db, &[site], 1, false).await;
        assert_eq!(shown, ["9", "8", "7"]);
        assert!(errors.is_empty(), "{errors:?}");
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
        task.abort();
    }
}
