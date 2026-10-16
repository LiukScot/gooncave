use crate::{
    db::{read_setting, write_setting, OWNER_ID},
    library, Error, Result,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub(crate) const MAX_SEARCHES: usize = 500;
const GENERATION: &str = "subscriptions.feedGeneration";
const BOOKMARK: &str = "subscriptions.bookmark";

pub(crate) fn searches(c: &Connection) -> Result<Vec<String>> {
    let value = read_setting(c, "subscriptions.tags", &json!([]))?;
    normalize_searches(&value)
        .map_err(|e| Error::Storage(format!("Invalid saved subscriptions: {e}")))
}
pub(crate) fn normalize_searches(value: &Value) -> Result<Vec<String>> {
    let rows = value
        .as_array()
        .filter(|a| a.len() <= MAX_SEARCHES)
        .ok_or_else(|| Error::Invalid(format!("Save at most {MAX_SEARCHES} searches.")))?;
    let mut tags = Vec::new();
    for row in rows {
        let raw = row
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.chars().count() <= 100)
            .ok_or_else(|| Error::Invalid("Each search needs 1 through 100 characters.".into()))?;
        let search = raw
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if !tags.contains(&search) {
            tags.push(search);
        }
    }
    Ok(tags)
}
const POOLS: &str = "subscriptions.pools";
pub(crate) const MAX_POOLS: usize = 500;

/// A followed pool, with what Settings shows of it. `site_id` is this device's site ID; sync
/// shares each pool under the site's preset key or address instead.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PoolSubscription {
    pub site_id: String,
    pub site_name: String,
    pub pool_id: String,
    pub name: String,
    pub post_count: usize,
    /// Preview of the first page, read when the pool was followed.
    pub cover_url: Option<String>,
}

pub(crate) fn pools(c: &Connection) -> Result<Vec<PoolSubscription>> {
    serde_json::from_value(read_setting(c, POOLS, &json!([]))?)
        .map_err(|e| Error::Storage(format!("Invalid saved pool subscriptions: {e}")))
}
pub(crate) fn save_pools(c: &Connection, pools: &[PoolSubscription]) -> Result<()> {
    write_setting(c, POOLS, &json!(pools))
}
pub(crate) fn generation(c: &Connection) -> Result<u64> {
    read_setting(c, GENERATION, &json!(0))?
        .as_u64()
        .ok_or_else(|| Error::Storage("Invalid saved subscription generation.".into()))
}
pub(crate) fn reset(c: &Connection, site: Option<&str>, search_only: bool) -> Result<()> {
    let next = generation(c)?
        .checked_add(1)
        .ok_or_else(|| Error::Storage("Subscription generation overflow.".into()))?;
    write_setting(c, GENERATION, &json!(next))?;
    for table in ["subscription_feed_items", "subscription_feed_sync_state"] {
        c.execute(&format!("DELETE FROM {table} WHERE user_id=?1 AND (?2 IS NULL OR site_id=?2)
            AND (?3=0 OR site_id IN (SELECT id FROM user_booru_sites WHERE user_id=?1 AND engine<>'furaffinity'))"),
            params![OWNER_ID, site, search_only])?;
    }
    let missing_bookmark=match bookmark(c)? {
        Some(cursor)=>!c.query_row("SELECT EXISTS(SELECT 1 FROM subscription_feed_items WHERE user_id=?1 AND site_id=?2 AND remote_id=?3)",
            params![OWNER_ID,cursor.site,cursor.remote],|r| r.get::<_,bool>(0))?,
        None=>false,
    };
    if missing_bookmark {
        write_setting(c, BOOKMARK, &Value::Null)?;
    }
    Ok(())
}
pub(crate) async fn favorite_override(
    db: &crate::db::Database,
    site: &str,
    id: &str,
    favorite: bool,
) -> Result<()> {
    let site = site.to_owned();
    let id = id.to_owned();
    db.call(move |c| {
        c.execute("UPDATE subscription_feed_items SET favorited_override=?1 WHERE user_id=?2 AND site_id=?3 AND remote_id=?4",
            params![favorite,OWNER_ID,site,id])?;Ok(())
    }).await
}

#[derive(Clone, Debug)]
pub(crate) struct SyncState {
    pub head: usize,
    pub tag: usize,
    pub page: usize,
    pub page_had_posts: bool,
    pub exhausted: bool,
    pub cursor: Option<String>,
    pub head_cursor: Option<String>,
    pub feed_exhausted: bool,
}
impl Default for SyncState {
    fn default() -> Self {
        Self {
            head: 0,
            tag: 0,
            page: 2,
            page_had_posts: false,
            exhausted: false,
            cursor: None,
            head_cursor: None,
            feed_exhausted: false,
        }
    }
}
pub(crate) fn state(c: &Connection, site: &str) -> Result<SyncState> {
    let state = c.query_row("SELECT head_tag_index,next_tag_index,search_page,search_page_had_posts,
        search_exhausted,feed_cursor,feed_head_cursor,feed_exhausted FROM subscription_feed_sync_state
        WHERE user_id=?1 AND site_id=?2", params![OWNER_ID,site], |r| Ok(SyncState {
            head: r.get::<_,u32>(0)? as usize, tag: r.get::<_,u32>(1)? as usize, page: r.get::<_,u32>(2)? as usize, page_had_posts: r.get(3)?,
            exhausted: r.get(4)?, cursor: r.get(5)?, head_cursor: r.get(6)?, feed_exhausted: r.get(7)?,
        })).optional()?.unwrap_or_default();
    if state.head >= MAX_SEARCHES || state.tag >= MAX_SEARCHES || !(2..=1001).contains(&state.page)
    {
        return Err(Error::Storage(
            "Invalid saved subscription progress.".into(),
        ));
    }
    Ok(state)
}
pub(crate) fn save_state(
    c: &Connection,
    site: &str,
    state: &SyncState,
    error: Option<&str>,
) -> Result<()> {
    c.execute("INSERT INTO subscription_feed_sync_state
        (user_id,site_id,head_tag_index,next_tag_index,search_page,search_page_had_posts,search_exhausted,
         feed_cursor,feed_head_cursor,feed_exhausted,updated_at,last_error)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
        ON CONFLICT(user_id,site_id) DO UPDATE SET head_tag_index=excluded.head_tag_index,
        next_tag_index=excluded.next_tag_index,search_page=excluded.search_page,
        search_page_had_posts=excluded.search_page_had_posts,search_exhausted=excluded.search_exhausted,
        feed_cursor=excluded.feed_cursor,feed_head_cursor=excluded.feed_head_cursor,
        feed_exhausted=excluded.feed_exhausted,updated_at=excluded.updated_at,last_error=excluded.last_error",
        params![OWNER_ID,site,state.head as i64,state.tag as i64,state.page as i64,state.page_had_posts,state.exhausted,
            state.cursor,state.head_cursor,state.feed_exhausted,library::iso_millis(std::time::SystemTime::now()),error])?;
    Ok(())
}
pub(crate) fn has_posts(c: &Connection, site: &str, ids: Option<&[Value]>) -> Result<bool> {
    if let Some(posts) = ids {
        if posts.is_empty() {
            return Ok(false);
        }
        let placeholders = vec!["?"; posts.len()].join(",");
        let mut args = vec![OWNER_ID.to_owned(), site.to_owned()];
        args.extend(
            posts
                .iter()
                .map(|p| p["remoteId"].as_str().unwrap().to_owned()),
        );
        Ok(c.query_row(&format!("SELECT EXISTS(SELECT 1 FROM subscription_feed_items WHERE user_id=? AND site_id=? AND remote_id IN ({placeholders}))"),
            rusqlite::params_from_iter(args),|r|r.get(0))?)
    } else {
        Ok(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM subscription_feed_items WHERE user_id=?1 AND site_id=?2)",
            params![OWNER_ID, site],
            |r| r.get(0),
        )?)
    }
}
pub(crate) fn timestamp(raw: &str) -> Result<String> {
    let parsed = OffsetDateTime::parse(raw, &Rfc3339)
        .map_err(|_| Error::Invalid("Use a valid subscription timestamp.".into()))?;
    if parsed.unix_timestamp() < 0 {
        return Err(Error::Invalid("Subscription date is before 1970.".into()));
    }
    Ok(library::iso_millis(
        std::time::UNIX_EPOCH
            + std::time::Duration::from_millis((parsed.unix_timestamp_nanos() / 1_000_000) as u64),
    ))
}
fn validate_post(post: &Value) -> Result<()> {
    let invalid =
        || Error::Storage("Invalid saved subscription post. Refresh subscriptions.".into());
    let id = post["remoteId"].as_str().ok_or_else(invalid)?;
    crate::booru_engines::id(&json!(id)).map_err(|_| invalid())?;
    let tags = post["tags"]
        .as_array()
        .filter(|a| a.len() <= 10000)
        .ok_or_else(invalid)?;
    for tag in tags {
        if !tag["tag"].is_string() || !tag["category"].is_string() {
            return Err(invalid());
        }
    }
    for field in ["previewUrl", "sampleUrl", "fileUrl"] {
        if let Some(url) = post[field].as_str() {
            crate::booru_http::url(url).map_err(|_| invalid())?;
        } else if !post[field].is_null() {
            return Err(invalid());
        }
    }
    if let Some(date) = post["createdAt"].as_str() {
        timestamp(date).map_err(|_| invalid())?;
    }
    Ok(())
}
pub(crate) fn insert(c: &Connection, site: &str, posts: &[Value]) -> Result<()> {
    let now = library::iso_millis(std::time::SystemTime::now());
    let mut statement = c.prepare(
        "INSERT INTO subscription_feed_items
        (user_id,site_id,remote_id,post_json,sort_at,discovered_at) VALUES (?1,?2,?3,?4,?5,?6)
        ON CONFLICT(user_id,site_id,remote_id) DO UPDATE SET post_json=excluded.post_json",
    )?;
    for post in posts {
        validate_post(post)?;
        let sort = post["createdAt"]
            .as_str()
            .map(timestamp)
            .transpose()?
            .unwrap_or_else(|| now.clone());
        statement.execute(params![
            OWNER_ID,
            site,
            post["remoteId"].as_str(),
            post.to_string(),
            sort,
            now
        ])?;
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub(crate) struct Cursor {
    pub sort: String,
    pub discovered: String,
    pub site: String,
    pub remote: String,
}
impl Cursor {
    pub fn decode(raw: &str) -> Result<Self> {
        let invalid = || Error::Invalid("Invalid subscription cursor. Reopen the feed.".into());
        if raw.len() > 1000 {
            return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| invalid())?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let text = |key: &str, max: usize| {
            value[key]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= max)
                .map(str::to_owned)
                .ok_or_else(invalid)
        };
        let cursor = Self {
            sort: timestamp(&text("sortAt", 40)?).map_err(|_| invalid())?,
            discovered: timestamp(&text("discoveredAt", 40)?).map_err(|_| invalid())?,
            site: text("siteId", 100)?,
            remote: text("remoteId", 50)?,
        };
        crate::booru_engines::id(&json!(cursor.remote)).map_err(|_| invalid())?;
        Ok(cursor)
    }
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(
            json!({"sortAt":self.sort,"discoveredAt":self.discovered,
            "siteId":self.site,"remoteId":self.remote})
            .to_string(),
        )
    }
}
pub(crate) fn bookmark(c: &Connection) -> Result<Option<Cursor>> {
    match read_setting(c, BOOKMARK, &Value::Null)? {
        Value::Null => Ok(None),
        Value::String(raw) => Cursor::decode(&raw)
            .map(Some)
            .map_err(|e| Error::Storage(e.to_string())),
        _ => Err(Error::Storage(
            "Invalid saved subscription bookmark.".into(),
        )),
    }
}
pub(crate) fn save_bookmark(c: &Connection, site: &str, id: &str) -> Result<bool> {
    let cursor = c.query_row("SELECT sort_at,discovered_at FROM subscription_feed_items WHERE user_id=?1 AND site_id=?2 AND remote_id=?3",
        params![OWNER_ID,site,id], |r| Ok(Cursor {sort:r.get(0)?,discovered:r.get(1)?,site:site.into(),remote:id.into()})).optional()?;
    if let Some(cursor) = cursor {
        write_setting(c, BOOKMARK, &json!(cursor.encode()))?;
        return Ok(true);
    }
    Ok(false)
}
pub(crate) struct Page {
    pub items: Vec<(String, Value)>,
    pub next: Option<String>,
    pub has_more: bool,
    pub ready: bool,
}
pub(crate) fn list(
    c: &Connection,
    sites: &[String],
    cursor: Option<Cursor>,
    inclusive: bool,
    limit: usize,
) -> Result<Page> {
    if sites.is_empty() {
        return Ok(Page {
            items: vec![],
            next: None,
            has_more: false,
            ready: true,
        });
    }
    let placeholders = vec!["?"; sites.len()].join(",");
    let mut args: Vec<rusqlite::types::Value> = vec![OWNER_ID.to_owned().into()];
    args.extend(sites.iter().cloned().map(Into::into));
    let clause = if let Some(cursor) = &cursor {
        args.extend(
            [
                cursor.sort.clone(),
                cursor.sort.clone(),
                cursor.discovered.clone(),
                cursor.sort.clone(),
                cursor.discovered.clone(),
                cursor.site.clone(),
                cursor.sort.clone(),
                cursor.discovered.clone(),
                cursor.site.clone(),
                cursor.remote.clone(),
            ]
            .map(Into::into),
        );
        format!(
            "AND (sort_at < ? OR (sort_at=? AND discovered_at < ?) OR
            (sort_at=? AND discovered_at=? AND site_id > ?) OR
            (sort_at=? AND discovered_at=? AND site_id=? AND remote_id {} ?))",
            if inclusive { ">=" } else { ">" }
        )
    } else {
        String::new()
    };
    args.push((limit as i64 + 1).into());
    let mut statement = c.prepare(&format!(
        "SELECT site_id,remote_id,post_json,sort_at,discovered_at,favorited_override
        FROM subscription_feed_items WHERE user_id=? AND site_id IN ({placeholders}) {clause}
        ORDER BY sort_at DESC,discovered_at DESC,site_id,remote_id LIMIT ?"
    ))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<bool>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit;
    let mut items = Vec::new();
    let mut next = None;
    for (site, remote, raw, sort, discovered, favorite) in rows.into_iter().take(limit) {
        let mut post: Value = serde_json::from_str(&raw)
            .map_err(|_| Error::Storage("Unreadable saved subscription post.".into()))?;
        validate_post(&post)?;
        if let Some(favorite) = favorite {
            post["favorited"] = json!(favorite);
        }
        next = Some(
            Cursor {
                sort,
                discovered,
                site: site.clone(),
                remote,
            }
            .encode(),
        );
        items.push((site, post));
    }
    let mut ready = true;
    for site in sites {
        // A failing site cannot backfill; its error is reported by refresh and must not hide the other sites' posts.
        let sync: Option<(bool, bool, Option<String>)> = c
            .query_row(
                "SELECT search_exhausted,feed_exhausted,last_error
            FROM subscription_feed_sync_state WHERE user_id=?1 AND site_id=?2",
                params![OWNER_ID, site],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match sync {
            Some((_, _, Some(_))) => {}
            Some((search_end, feed_end, None)) => {
                if let Some(cursor) = &cursor {
                    let oldest: Option<String> = c.query_row("SELECT min(sort_at) FROM subscription_feed_items WHERE user_id=?1 AND site_id=?2",
                        params![OWNER_ID,site], |r| r.get(0))?;
                    if !search_end && !feed_end && oldest.is_none_or(|date| date > cursor.sort) {
                        ready = false;
                    }
                }
            }
            None => ready = false,
        }
    }
    Ok(Page {
        items,
        next,
        has_more,
        ready,
    })
}
