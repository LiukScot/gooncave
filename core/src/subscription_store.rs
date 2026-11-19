use crate::{
    db::{read_setting, write_setting},
    Error, Result,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;

pub(crate) const MAX_SEARCHES: usize = 500;

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
const ARTISTS: &str = "subscriptions.artists";
/// As many as FurAffinity's watchlist reader accepts.
pub(crate) const MAX_ARTISTS: usize = 10000;

pub(crate) fn artists(c: &Connection) -> Result<Vec<String>> {
    normalize_artists(&read_setting(c, ARTISTS, &json!([]))?)
        .map_err(|e| Error::Storage(format!("Invalid saved subscribed artists: {e}")))
}
/// Usernames lowercased and deduplicated, in the order given.
pub(crate) fn normalize_artists(value: &Value) -> Result<Vec<String>> {
    let rows = value
        .as_array()
        .filter(|a| a.len() <= MAX_ARTISTS)
        .ok_or_else(|| Error::Invalid(format!("Save at most {MAX_ARTISTS} artists.")))?;
    let mut names = Vec::new();
    for row in rows {
        let name = row
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 50)
            .ok_or_else(|| Error::Invalid("Each artist needs 1 through 50 characters.".into()))?
            .trim()
            .to_lowercase();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    Ok(names)
}
pub(crate) fn save_artists(c: &Connection, artists: &[String]) -> Result<()> {
    write_setting(c, ARTISTS, &json!(artists))
}
/// What one FurAffinity account's watchlist held at the last sync, kept on this device only.
/// `None` before the first sync.
pub(crate) fn seen_artists(c: &Connection, site: &str) -> Result<Option<Vec<String>>> {
    match read_setting(c, &format!("{ARTISTS}.seen.{site}"), &Value::Null)? {
        Value::Null => Ok(None),
        value => normalize_artists(&value)
            .map(Some)
            .map_err(|e| Error::Storage(format!("Invalid saved FurAffinity watchlist: {e}"))),
    }
}
pub(crate) fn save_seen_artists(c: &Connection, site: &str, artists: &[String]) -> Result<()> {
    write_setting(c, &format!("{ARTISTS}.seen.{site}"), &json!(artists))
}

#[derive(Debug, PartialEq)]
pub(crate) struct ArtistPlan {
    /// The local list after this account's changes were taken in.
    pub local: Vec<String>,
    /// Added in GoonCave: to watch on FurAffinity.
    pub watch: Vec<String>,
    /// Removed in GoonCave: to unwatch on FurAffinity.
    pub unwatch: Vec<String>,
}
/// Merges one account's watchlist `watched` into the local list `local`, comparing with `seen`,
/// the watchlist at the last sync. Without `seen` the watchlist is only imported. All names are
/// lowercase.
pub(crate) fn reconcile(
    watched: &[String],
    seen: Option<&[String]>,
    local: &[String],
) -> ArtistPlan {
    let seen = seen.unwrap_or(&[]);
    let removed_on_fa = |a: &&String| seen.contains(a) && !watched.contains(a);
    let mut plan = ArtistPlan {
        local: local
            .iter()
            .filter(|a| !removed_on_fa(a))
            .cloned()
            .collect(),
        watch: local
            .iter()
            .filter(|a| !watched.contains(a) && !seen.contains(a))
            .cloned()
            .collect(),
        unwatch: watched
            .iter()
            .filter(|a| seen.contains(a) && !local.contains(a))
            .cloned()
            .collect(),
    };
    for a in watched {
        if !seen.contains(a) && !plan.local.contains(a) {
            plan.local.push(a.clone());
        }
    }
    plan
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
const SITE_HITS: &str = "subscriptions.siteHits";
/// Each search or artist with the ids of the booru sites where the feed showed a post matching
/// it. Kept on this device only, since site ids differ between devices.
pub(crate) fn site_hits(c: &Connection) -> Result<HashMap<String, Vec<String>>> {
    serde_json::from_value(read_setting(c, SITE_HITS, &json!({}))?)
        .map_err(|e| Error::Storage(format!("Invalid saved subscription site hits: {e}")))
}
pub(crate) fn save_site_hits(c: &Connection, hits: &HashMap<String, Vec<String>>) -> Result<()> {
    write_setting(c, SITE_HITS, &json!(hits))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }
    fn plan(watched: &[&str], seen: Option<&[&str]>, local: &[&str]) -> ArtistPlan {
        let seen = seen.map(names);
        reconcile(&names(watched), seen.as_deref(), &names(local))
    }

    #[test]
    fn the_first_sync_imports_the_watchlist_and_unwatches_nothing() {
        let p = plan(&["a", "b"], None, &["b", "c"]);
        assert_eq!(p.local, names(&["b", "c", "a"]));
        assert_eq!(p.watch, names(&["c"]));
        assert!(p.unwatch.is_empty());
    }
    #[test]
    fn an_artist_watched_on_furaffinity_since_the_last_sync_joins_the_list() {
        let p = plan(&["a", "b"], Some(&["a"]), &["a"]);
        assert_eq!(p.local, names(&["a", "b"]));
        assert!(p.watch.is_empty() && p.unwatch.is_empty());
    }
    #[test]
    fn an_artist_unwatched_on_furaffinity_leaves_the_list() {
        let p = plan(&["a"], Some(&["a", "b"]), &["a", "b"]);
        assert_eq!(p.local, names(&["a"]));
        assert!(p.watch.is_empty() && p.unwatch.is_empty());
    }
    #[test]
    fn an_artist_added_in_gooncave_is_watched_on_furaffinity() {
        let p = plan(&["a"], Some(&["a"]), &["a", "c"]);
        assert_eq!(p.local, names(&["a", "c"]));
        assert_eq!(p.watch, names(&["c"]));
        assert!(p.unwatch.is_empty());
    }
    #[test]
    fn an_artist_removed_in_gooncave_is_unwatched_on_furaffinity() {
        let p = plan(&["a", "b"], Some(&["a", "b"]), &["a"]);
        assert_eq!(p.local, names(&["a"]));
        assert!(p.watch.is_empty());
        assert_eq!(p.unwatch, names(&["b"]));
    }
    #[test]
    fn subscribed_artists_are_lowercased_and_deduplicated() {
        assert_eq!(
            normalize_artists(&json!(["Rukis", "rukis", " Dark "])).unwrap(),
            names(&["rukis", "dark"])
        );
    }
}
