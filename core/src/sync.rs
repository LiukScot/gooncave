//! Sync through a WebDAV folder. The folder holds one snapshot of every shared record with the
//! time of its last change; each device merges it into its own database, newest change winning.
//!
//! Change times and deletion markers live in `sync_records`, not in the shared tables: a cycle
//! exports the shared records, compares them with the last known state and stamps what changed.
//! Every writer in the core therefore syncs without knowing about it. Records that belong to a
//! file use its SHA-256 as key, and sites use their preset key or address, so keys match across
//! devices.

use crate::{
    db::{read_setting, write_setting, Database, OWNER_ID},
    library::{iso_millis, NOW},
    webdav::{Condition, Fetched, Folder, Put},
    Error, Result,
};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, value::RawValue, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SNAPSHOT: &str = "GoonCave/library.json.gz";
const FOLDER: &str = "GoonCave/";
const BACKUPS: &str = "GoonCave/backups/";
const KEEP_BACKUPS: usize = 14;
const FORMAT: u64 = 1;
/// A snapshot larger than this once unpacked is refused rather than filling memory.
const MAX_SNAPSHOT_BYTES: u64 = 1 << 30;
/// How long the database stays quiet after a change before the upload.
const QUIET: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_secs(1);
const RETRY: Duration = Duration::from_secs(60);
const ATTEMPTS: usize = 3;
/// How long closing the app waits for the last upload.
pub(crate) const CLOSE_TIMEOUT: Duration = Duration::from_secs(15);

const CONNECTION_KEY: &str = "sync.webdav";
const BACKUP_KEY: &str = "sync.lastBackup";
/// Settings shared between devices. Grid columns, the duplicate policy, WD14 and sync itself
/// stay on each device.
const SHARED_SETTINGS: &[&str] = &[
    "blacklist.settings",
    "shortcuts.bindings",
    "subscriptions.tags",
    "source_targets",
    "source_display",
    "source_display_initialized",
    "trash.enabled",
];
/// Tables whose writes can change a shared record.
const TABLES: &[&str] = &[
    "files",
    "file_tags",
    "file_tag_suppressions",
    "file_votes",
    "provider_runs",
    "file_post_relations",
    "read_marks",
    "favorite_items",
    "user_settings",
    "user_booru_sites",
    "tag_aliases",
    "wd14_results",
    "trash",
];
/// The kinds each table feeds. `files` and `user_booru_sites` name the file or site in most
/// keys, so a write there exports every kind.
fn kinds_of(table: &str) -> &'static [&'static str] {
    match table {
        "file_tags" => &["tag"],
        "file_tag_suppressions" => &["suppression"],
        "file_votes" => &["vote"],
        "provider_runs" => &["source"],
        "file_post_relations" => &["relation"],
        "read_marks" => &["read_file", "read_post"],
        "favorite_items" => &["favorite"],
        "user_settings" => &["setting"],
        "tag_aliases" => &["alias"],
        "wd14_results" => &["wd14"],
        "trash" => &["trash"],
        _ => KINDS,
    }
}
/// Kinds in the order they are applied: sites first, so records naming a site can find it.
const KINDS: &[&str] = &[
    "site",
    "setting",
    "alias",
    "wd14",
    "trash",
    "file",
    "tag",
    "suppression",
    "vote",
    "source",
    "relation",
    "read_file",
    "read_post",
    "favorite",
];

pub(crate) fn now() -> String {
    iso_millis(SystemTime::now())
}

fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub(crate) struct Job {
    changed: AtomicBool,
    last_change: AtomicU64,
    /// Set while a cycle applies remote records, so its own writes do not count as changes.
    applying: AtomicBool,
    /// Local changes were stamped but not uploaded yet.
    pending_upload: AtomicBool,
    /// Tables written since the last stamp; it starts full so the first stamp compares all.
    dirty: Mutex<HashSet<&'static str>>,
    /// A folder (address and user) and the ETag of its snapshot when that held exactly this
    /// device's records, so an unchanged snapshot is not downloaded and merged again.
    in_step: Mutex<Option<(String, String)>>,
    pub(crate) wake: tokio::sync::Notify,
    running: tokio::sync::Mutex<()>,
    status: Mutex<Value>,
}

impl Default for Job {
    fn default() -> Self {
        Self {
            changed: AtomicBool::new(false),
            last_change: AtomicU64::new(0),
            applying: AtomicBool::new(false),
            pending_upload: AtomicBool::new(false),
            dirty: Mutex::new(TABLES.iter().copied().collect()),
            in_step: Mutex::new(None),
            wake: tokio::sync::Notify::new(),
            running: tokio::sync::Mutex::new(()),
            status: Mutex::new(json!({"state": "off", "lastSyncAt": null, "error": null})),
        }
    }
}

impl Job {
    /// Called by the database's update hook for every written row.
    pub(crate) fn written(&self, table: &str) {
        // Rows of a newly active folder enter the export without a write to `files`.
        let table = if table == "active_library_folders" {
            "files"
        } else {
            table
        };
        let Some(&table) = TABLES.iter().find(|t| **t == table) else {
            return;
        };
        // Applied records are compared again too, as a full export would.
        self.dirty
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(table);
        if !self.applying.load(Ordering::Relaxed) {
            self.last_change.store(millis(), Ordering::Relaxed);
            self.changed.store(true, Ordering::Relaxed);
        }
    }

    /// The kinds to compare, emptying the set. Call it on the main connection: while that is
    /// held no write is half done, so the stamp that follows reads every write counted here.
    fn take_dirty(&self) -> HashSet<&'static str> {
        std::mem::take(&mut *self.dirty.lock().unwrap_or_else(|p| p.into_inner()))
            .into_iter()
            .flat_map(|table| kinds_of(table).iter().copied())
            .collect()
    }

    fn known_etag(&self, place: &str) -> Option<String> {
        self.in_step
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|(at, _)| at == place)
            .map(|(_, etag)| etag.clone())
    }

    fn set_in_step(&self, place: &str, etag: Option<String>) {
        *self.in_step.lock().unwrap_or_else(|p| p.into_inner()) =
            etag.map(|etag| (place.to_owned(), etag));
    }

    fn mark_all_dirty(&self) {
        self.dirty
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend(TABLES.iter().copied());
    }

    fn due(&self) -> bool {
        self.changed.load(Ordering::Relaxed)
            && millis().saturating_sub(self.last_change.load(Ordering::Relaxed))
                >= QUIET.as_millis() as u64
    }

    fn set_status(&self, patch: Value) {
        let mut status = self.status.lock().unwrap_or_else(|p| p.into_inner());
        for (key, value) in patch.as_object().into_iter().flatten() {
            status[key] = value.clone();
        }
    }

    fn snapshot(&self) -> Value {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

// ---- Keys --------------------------------------------------------------------------------

pub(crate) fn key(parts: &[&str]) -> String {
    serde_json::to_string(parts).expect("strings serialize")
}

fn parts(key: &str) -> Result<Vec<String>> {
    serde_json::from_str(key).map_err(|e| Error::Storage(format!("invalid sync key {key}: {e}")))
}

struct SiteRow {
    id: String,
    preset: Option<String>,
    base: String,
}

/// Translates between this device's site ids and keys every device shares.
struct Sites(Vec<SiteRow>);

impl Sites {
    fn load(c: &Connection) -> Result<Self> {
        let mut statement =
            c.prepare("SELECT id, preset_key, base_url FROM user_booru_sites WHERE user_id = ?1")?;
        let rows = statement
            .query_map([OWNER_ID], |r| {
                Ok(SiteRow {
                    id: r.get(0)?,
                    preset: r.get(1)?,
                    base: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Self(rows))
    }

    fn shared(site: &SiteRow) -> String {
        site.preset
            .clone()
            .unwrap_or_else(|| format!("url:{}", site.base))
    }

    /// A tag source, relation source or favorite provider may name a site by its random id;
    /// everything else (preset keys, `MANUAL`, `WD14`) is already shared.
    fn share_token(&self, token: &str) -> String {
        match self.0.iter().find(|s| s.id == token) {
            Some(site) => Self::shared(site),
            None => token.to_owned(),
        }
    }

    fn local_token(&self, token: &str) -> Option<String> {
        match token.strip_prefix("url:") {
            Some(base) => self.0.iter().find(|s| s.base == base).map(|s| s.id.clone()),
            None => Some(token.to_owned()),
        }
    }

    fn share_id(&self, id: &str) -> Option<String> {
        self.0.iter().find(|s| s.id == id).map(Self::shared)
    }

    fn local_id(&self, shared: &str) -> Option<String> {
        self.0
            .iter()
            .find(|s| Self::shared(s) == shared)
            .map(|s| s.id.clone())
    }
}

/// What this device has: its files by hash and its sites.
pub(crate) struct Device {
    files: HashMap<String, Vec<(String, String)>>,
    sites: Sites,
}

impl Device {
    pub(crate) fn load(c: &Connection) -> Result<Self> {
        let mut files: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut statement = c.prepare(
            "SELECT f.sha256, f.id, f.path FROM files f JOIN library_folders lf ON lf.id = f.folder_id
             ORDER BY f.created_at, f.id",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            files
                .entry(row.get(0)?)
                .or_default()
                .push((row.get(1)?, row.get(2)?));
        }
        Ok(Self {
            files,
            sites: Sites::load(c)?,
        })
    }

    /// Whether a record missing from this device's export was deleted here, rather than
    /// belonging to a file or site this device does not have.
    fn holds(&self, kind: &str, key: &[String]) -> bool {
        let has_file = |i: usize| key.get(i).is_some_and(|sha| self.files.contains_key(sha));
        let has_token = |i: usize| {
            key.get(i)
                .is_some_and(|t| self.sites.local_token(t).is_some())
        };
        match kind {
            "file" | "suppression" | "vote" | "source" | "read_file" => has_file(0),
            "tag" => has_file(0) && has_token(2),
            "relation" => has_file(0) && has_token(1),
            "read_post" => key
                .first()
                .is_some_and(|s| self.sites.local_id(s).is_some()),
            "favorite" => has_token(0),
            _ => true,
        }
    }
}

// ---- Export ------------------------------------------------------------------------------

/// Each record's data as JSON text. Text is far smaller than a parsed [`Value`], and the
/// default `serde_json` map sorts keys, so equal data always has equal text.
pub(crate) type Records = HashMap<(String, String), String>;

fn add(records: &mut Records, kind: &str, key: String, data: Value) {
    records
        .entry((kind.to_owned(), key))
        .or_insert_with(|| data.to_string());
}

fn json_text(raw: &str, what: &str) -> Result<Value> {
    serde_json::from_str(raw).map_err(|e| Error::Storage(format!("invalid {what}: {e}")))
}

/// Every shared record this device holds. Copies of one file share a record; the oldest copy
/// (or the latest vote, read mark or source) speaks for them.
pub(crate) fn export(c: &Connection, device: &Device) -> Result<Records> {
    export_kinds(c, device, &KINDS.iter().copied().collect())
}

/// [`export`] limited to `kinds`.
fn export_kinds(c: &Connection, device: &Device, kinds: &HashSet<&str>) -> Result<Records> {
    let mut records = Records::new();
    let sites = &device.sites;
    let joined = "JOIN files f ON f.id = t.file_id JOIN library_folders lf ON lf.id = f.folder_id";

    if kinds.contains("file") {
        let mut s = c.prepare(
            "SELECT f.sha256, f.media_type, f.size_bytes, f.width, f.height, CAST(round(f.duration_ms) AS INTEGER), f.phash
             FROM files f JOIN library_folders lf ON lf.id = f.folder_id ORDER BY f.created_at, f.id",
        )?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let sha: String = r.get(0)?;
            add(
                &mut records,
                "file",
                key(&[&sha]),
                json!({"mediaType": r.get::<_, String>(1)?, "sizeBytes": r.get::<_, i64>(2)?,
                "width": r.get::<_, Option<i64>>(3)?, "height": r.get::<_, Option<i64>>(4)?,
                "durationMs": r.get::<_, Option<i64>>(5)?, "phash": r.get::<_, Option<String>>(6)?}),
            );
        }
    }

    if kinds.contains("tag") {
        let mut s = c.prepare(&format!(
            "SELECT f.sha256, t.tag, t.source, t.category, t.score, t.source_url, t.canonical_tag
             FROM file_tags t {joined} ORDER BY f.created_at, f.id"
        ))?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let (sha, tag, source): (String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?);
            add(
                &mut records,
                "tag",
                key(&[&sha, &tag, &sites.share_token(&source)]),
                json!({"category": r.get::<_, String>(3)?,
                "score": r.get::<_, Option<f64>>(4)?, "sourceUrl": r.get::<_, Option<String>>(5)?, "canonical": r.get::<_, String>(6)?}),
            );
        }
    }

    if kinds.contains("suppression") {
        let mut s = c.prepare(&format!(
            "SELECT f.sha256, t.tag, t.created_at FROM file_tag_suppressions t {joined} ORDER BY f.created_at, f.id"
        ))?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let (sha, tag): (String, String) = (r.get(0)?, r.get(1)?);
            add(
                &mut records,
                "suppression",
                key(&[&sha, &tag]),
                json!({"createdAt": r.get::<_, String>(2)?}),
            );
        }
    }

    if kinds.contains("vote") {
        let mut s = c.prepare(&format!(
            "SELECT f.sha256, t.score, t.last_vote_at FROM file_votes t {joined} ORDER BY t.last_vote_at DESC"
        ))?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let sha: String = r.get(0)?;
            add(
                &mut records,
                "vote",
                key(&[&sha]),
                json!({"score": r.get::<_, i64>(1)?, "lastVoteAt": r.get::<_, String>(2)?}),
            );
        }
    }

    if kinds.contains("source") {
        let mut s = c.prepare(&format!(
            "SELECT f.sha256, t.provider, t.cached_hit, t.score, t.source_url, t.thumb_url, t.results, t.created_at, t.completed_at
             FROM provider_runs t {joined} WHERE t.status = 'COMPLETED' ORDER BY t.completed_at DESC, t.created_at DESC"
        ))?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let (sha, provider): (String, String) = (r.get(0)?, r.get(1)?);
            add(
                &mut records,
                "source",
                key(&[&sha, &provider]),
                json!({"cachedHit": r.get::<_, bool>(2)?,
                "score": r.get::<_, Option<f64>>(3)?, "sourceUrl": r.get::<_, Option<String>>(4)?,
                "thumbUrl": r.get::<_, Option<String>>(5)?, "results": r.get::<_, Option<String>>(6)?,
                "createdAt": r.get::<_, String>(7)?, "completedAt": r.get::<_, Option<String>>(8)?}),
            );
        }
    }

    if kinds.contains("relation") {
        let mut s = c.prepare(&format!(
            "SELECT f.sha256, t.source, t.remote_id, t.parent_id, t.has_children, t.pool_ids
             FROM file_post_relations t {joined} ORDER BY f.created_at, f.id"
        ))?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let (sha, source): (String, String) = (r.get(0)?, r.get(1)?);
            add(
                &mut records,
                "relation",
                key(&[&sha, &sites.share_token(&source)]),
                json!({"remoteId": r.get::<_, String>(2)?,
                "parentId": r.get::<_, Option<String>>(3)?, "hasChildren": r.get::<_, bool>(4)?, "poolIds": r.get::<_, Option<String>>(5)?}),
            );
        }
    }

    if kinds.contains("read_file") {
        let mut s = c.prepare(
            "SELECT f.sha256, m.read_at FROM read_marks m JOIN files f ON f.id = m.item_key
             JOIN library_folders lf ON lf.id = f.folder_id
             WHERE m.scope = 'file' AND m.user_id = ?1 ORDER BY m.read_at DESC",
        )?;
        let mut rows = s.query([OWNER_ID])?;
        while let Some(r) = rows.next()? {
            let sha: String = r.get(0)?;
            add(
                &mut records,
                "read_file",
                key(&[&sha]),
                json!({"readAt": r.get::<_, String>(1)?}),
            );
        }
    }

    if kinds.contains("read_post") {
        let mut s = c.prepare(
            "SELECT item_key, read_at FROM read_marks WHERE scope = 'post' AND user_id = ?1",
        )?;
        let mut rows = s.query([OWNER_ID])?;
        while let Some(r) = rows.next()? {
            let item: String = r.get(0)?;
            // A mark of a site deleted here is left behind; nothing on another device can match it.
            let Some((site, remote)) = item
                .split_once(':')
                .and_then(|(site, remote)| Some((sites.share_id(site)?, remote.to_owned())))
            else {
                continue;
            };
            add(
                &mut records,
                "read_post",
                key(&[&site, &remote]),
                json!({"readAt": r.get::<_, String>(1)?}),
            );
        }
    }

    if kinds.contains("favorite") {
        let mut s = c.prepare(
            "SELECT fav.provider, fav.remote_id, fav.source_url, fav.file_url, fav.created_at,
               (SELECT f.sha256 FROM files f WHERE f.path = fav.file_path ORDER BY f.created_at LIMIT 1)
             FROM favorite_items fav WHERE fav.user_id = ?1",
        )?;
        let mut rows = s.query([OWNER_ID])?;
        while let Some(r) = rows.next()? {
            let (provider, remote): (String, String) = (r.get(0)?, r.get(1)?);
            add(
                &mut records,
                "favorite",
                key(&[&sites.share_token(&provider), &remote]),
                json!({"sourceUrl": r.get::<_, Option<String>>(2)?,
                "fileUrl": r.get::<_, Option<String>>(3)?, "createdAt": r.get::<_, String>(4)?, "sha256": r.get::<_, Option<String>>(5)?}),
            );
        }
    }

    if kinds.contains("setting") {
        let mut s = c.prepare("SELECT key, value FROM user_settings WHERE user_id = ?1")?;
        let mut rows = s.query([OWNER_ID])?;
        while let Some(r) = rows.next()? {
            let name: String = r.get(0)?;
            if SHARED_SETTINGS.contains(&name.as_str()) {
                let value = json_text(&r.get::<_, String>(1)?, &format!("setting {name}"))?;
                add(
                    &mut records,
                    "setting",
                    key(&[&name]),
                    json!({"value": value}),
                );
            }
        }
    }

    if kinds.contains("site") {
        let mut s = c.prepare(
            "SELECT name, engine, base_url, is_preset, preset_key, enabled, sort_order FROM user_booru_sites WHERE user_id = ?1",
        )?;
        let mut rows = s.query([OWNER_ID])?;
        while let Some(r) = rows.next()? {
            let site = SiteRow {
                id: String::new(),
                preset: r.get(4)?,
                base: r.get(2)?,
            };
            add(
                &mut records,
                "site",
                key(&[&Sites::shared(&site)]),
                json!({"name": r.get::<_, String>(0)?, "engine": r.get::<_, String>(1)?,
                "baseUrl": site.base, "isPreset": r.get::<_, bool>(3)?, "presetKey": site.preset,
                "enabled": r.get::<_, bool>(5)?, "sortOrder": r.get::<_, i64>(6)?}),
            );
        }
    }

    if kinds.contains("alias") {
        let mut s =
            c.prepare("SELECT antecedent, consequent FROM tag_aliases WHERE source = 'custom'")?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let antecedent: String = r.get(0)?;
            add(
                &mut records,
                "alias",
                key(&[&antecedent]),
                json!({"consequent": r.get::<_, String>(1)?}),
            );
        }
    }

    if kinds.contains("wd14") {
        let mut s = c.prepare("SELECT sha256, model, results FROM wd14_results")?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let (sha, model): (String, String) = (r.get(0)?, r.get(1)?);
            add(
                &mut records,
                "wd14",
                key(&[&sha, &model]),
                json!({"results": r.get::<_, String>(2)?}),
            );
        }
    }

    if kinds.contains("trash") {
        let mut s = c.prepare("SELECT sha256, trashed_at FROM trash")?;
        let mut rows = s.query([])?;
        while let Some(r) = rows.next()? {
            let sha: String = r.get(0)?;
            add(
                &mut records,
                "trash",
                key(&[&sha]),
                json!({"trashedAt": r.get::<_, String>(1)?}),
            );
        }
    }
    Ok(records)
}

// ---- Stored state ------------------------------------------------------------------------

struct Stored {
    data: Option<String>,
    at: String,
    /// 1 applied, 0 waiting, 2 set aside: see the `0022` migration.
    applied: i64,
}

fn stored(tx: &Connection) -> Result<HashMap<(String, String), Stored>> {
    stored_kinds(tx, &KINDS.iter().copied().collect())
}

fn stored_kinds(
    tx: &Connection,
    kinds: &HashSet<&str>,
) -> Result<HashMap<(String, String), Stored>> {
    let mut statement = tx.prepare(&format!(
        "SELECT kind, record_key, data, changed_at, applied FROM sync_records WHERE kind IN ({})",
        vec!["?"; kinds.len()].join(",")
    ))?;
    let mut rows = statement.query(rusqlite::params_from_iter(kinds))?;
    let mut found = HashMap::new();
    while let Some(r) = rows.next()? {
        found.insert(
            (r.get(0)?, r.get(1)?),
            Stored {
                data: r.get(2)?,
                at: r.get(3)?,
                applied: r.get(4)?,
            },
        );
    }
    Ok(found)
}

fn save(
    tx: &Transaction,
    (kind, key): &(String, String),
    data: Option<&str>,
    at: &str,
    applied: bool,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(kind, record_key) DO UPDATE SET data = excluded.data, changed_at = excluded.changed_at, applied = excluded.applied",
    )?
    .execute(params![kind, key, data, at, applied])?;
    Ok(())
}

/// What a stamp writes: records to save (`None` marks a deletion) and `applied` flags to set.
#[derive(Default)]
struct Changes {
    saves: Vec<((String, String), Option<String>)>,
    flags: Vec<((String, String), bool)>,
}

/// Compares the records of `kinds` with the stored ones. Only reads, so it runs on sync's own
/// connection; call it inside one transaction, or a file removed midway looks deleted.
fn compare(c: &Connection, kinds: &HashSet<&str>) -> Result<Changes> {
    let mut changes = Changes::default();
    if kinds.is_empty() {
        return Ok(changes);
    }
    let device = Device::load(c)?;
    let local = export_kinds(c, &device, kinds)?;
    let known = stored_kinds(c, kinds)?;
    for (id, data) in &local {
        match known.get(id) {
            Some(Stored {
                data: Some(old),
                applied,
                ..
            }) if old == data => {
                if *applied != 1 {
                    changes.flags.push((id.clone(), true));
                }
            }
            _ => changes.saves.push((id.clone(), Some(data.clone()))),
        }
    }
    for (id, record) in &known {
        if local.contains_key(id) || record.data.is_none() || record.applied != 1 {
            continue;
        }
        if device.holds(&id.0, &parts(&id.1)?) {
            changes.saves.push((id.clone(), None));
        } else {
            // The file or site went away; the record stays for the devices that still have it.
            changes.flags.push((id.clone(), false));
        }
    }
    Ok(changes)
}

/// Stamps `changes` with `at`. Returns whether any record changed.
fn write(c: &mut Connection, at: &str, changes: Changes) -> Result<bool> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (id, data) in &changes.saves {
        save(&tx, id, data.as_deref(), at, true)?;
    }
    for (id, applied) in &changes.flags {
        tx.execute(
            "UPDATE sync_records SET applied = ?3 WHERE kind = ?1 AND record_key = ?2",
            params![id.0, id.1, applied],
        )?;
    }
    tx.commit()?;
    Ok(!changes.saves.is_empty())
}

struct Remote {
    kind: String,
    key: String,
    data: Option<String>,
    at: String,
}

/// Why a snapshot cannot be read.
enum Unreadable {
    Damaged,
    Newer,
}

#[derive(serde::Deserialize)]
struct Snapshot {
    format: u64,
    records: Vec<SnapshotRecord>,
}

// The data stays text until each record is read, so the whole snapshot never exists as a tree.
#[derive(serde::Deserialize)]
struct SnapshotRecord {
    kind: String,
    key: Vec<String>,
    #[serde(default)]
    data: Option<Box<RawValue>>,
    at: String,
}

#[derive(serde::Deserialize)]
struct Header {
    format: Value,
}

fn parse(bytes: &[u8]) -> std::result::Result<Vec<Remote>, Unreadable> {
    let invalid_snapshot = || Unreadable::Damaged;
    let unpack = || BufReader::new(GzDecoder::new(bytes).take(MAX_SNAPSHOT_BYTES + 1));
    let snapshot: Snapshot = match serde_json::from_reader(unpack()) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            // A newer format may store records differently; only its version can tell.
            let format = serde_json::from_reader::<_, Header>(unpack())
                .ok()
                .and_then(|header| header.format.as_u64());
            if format.is_some_and(|format| format > FORMAT) {
                return Err(Unreadable::Newer);
            }
            eprintln!("Cannot read the sync file: {error}");
            return Err(invalid_snapshot());
        }
    };
    match snapshot.format {
        FORMAT => {}
        newer if newer > FORMAT => return Err(Unreadable::Newer),
        _ => return Err(invalid_snapshot()),
    }
    snapshot
        .records
        .into_iter()
        .map(|record| {
            let at = time::OffsetDateTime::parse(
                &record.at,
                &time::format_description::well_known::Rfc3339,
            )
            .map_err(|_| invalid_snapshot())?;
            // One format keeps the text comparison in `merge` in time order, and a time in the
            // future cannot outrank every later change.
            let at = iso_millis(SystemTime::from(at).min(SystemTime::now()));
            // The text stays as written: parsing it again could round a float and make equal
            // data look different. Valid JSON that starts with `{` is an object.
            let data = match record.data {
                None => None,
                Some(raw) if raw.get().starts_with('{') => {
                    Some(Box::<str>::from(raw).into_string())
                }
                Some(_) => return Err(invalid_snapshot()),
            };
            let parts: Vec<&str> = record.key.iter().map(String::as_str).collect();
            Ok(Remote {
                kind: record.kind,
                key: key(&parts),
                data,
                at,
            })
        })
        .collect()
}

/// Keeps every remote record newer than the stored one, waiting to be applied. Returns whether
/// the folder lacks something this device has.
/// Merges `remote` into the stored records. Returns whether the folder lacks some of this
/// device's records.
fn merge(c: &mut Connection, remote: Vec<Remote>) -> Result<bool> {
    let (newer, behind) = newer_than_stored(c, remote)?;
    save_newer(c, newer)?;
    Ok(behind)
}

/// The remote records newer than the stored ones, and whether the folder lacks some of this
/// device's records. Only reads, so it runs on sync's own connection.
fn newer_than_stored(c: &Connection, mut remote: Vec<Remote>) -> Result<(Vec<Remote>, bool)> {
    // Counting matches below needs each record once; key order also keeps lookups local.
    remote.sort_by(|a, b| (&a.kind, &a.key).cmp(&(&b.kind, &b.key)));
    remote.dedup_by(|a, b| a.kind == b.kind && a.key == b.key);
    let local_count: i64 = c.query_row("SELECT COUNT(*) FROM sync_records", [], |r| r.get(0))?;
    let mut matched = 0;
    let mut behind = false;
    let mut newer_records = Vec::new();
    {
        // One lookup per record instead of every stored record in memory at once.
        let mut find = c.prepare(
            "SELECT data, changed_at FROM sync_records WHERE kind = ?1 AND record_key = ?2",
        )?;
        for record in remote {
            let local: Option<(Option<String>, String)> = find
                .query_row(params![record.kind, record.key], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            let newer = match &local {
                None => true,
                Some((data, at)) => {
                    (
                        record.at.as_str(),
                        record.data.as_deref().unwrap_or_default(),
                    ) > (at.as_str(), data.as_deref().unwrap_or_default())
                }
            };
            matched += i64::from(local.is_some());
            if newer {
                newer_records.push(record);
            } else if local.is_some_and(|(data, at)| at != record.at || data != record.data) {
                behind = true;
            }
        }
    }
    // Fewer matches than stored records means the folder lacks some.
    behind |= matched < local_count;
    Ok((newer_records, behind))
}

fn save_newer(c: &mut Connection, newer: Vec<Remote>) -> Result<()> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for record in newer {
        save(
            &tx,
            &(record.kind, record.key),
            record.data.as_deref(),
            &record.at,
            false,
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn snapshot(c: &Connection) -> Result<Vec<u8>> {
    let mut statement = c.prepare(
        "SELECT kind, record_key, data, changed_at FROM sync_records ORDER BY kind, record_key",
    )?;
    let mut rows = statement.query([])?;
    let mut pack = Pack::new()?;
    while let Some(r) = rows.next()? {
        pack.push(
            &r.get::<_, String>(0)?,
            &r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?.as_deref(),
            &r.get::<_, String>(3)?,
        )?;
    }
    pack.finish()
}

/// Writes a snapshot record by record, so a large library is never held as one JSON tree.
struct Pack {
    // Each record is many tiny writes; the encoder is slow at those.
    out: std::io::BufWriter<GzEncoder<Vec<u8>>>,
    first: bool,
}

#[derive(serde::Serialize)]
struct PackedRecord<'a> {
    at: &'a str,
    data: Option<&'a RawValue>,
    key: &'a RawValue,
    kind: &'a str,
}

impl Pack {
    fn new() -> Result<Self> {
        let mut out = std::io::BufWriter::with_capacity(
            1 << 16,
            GzEncoder::new(Vec::new(), Compression::default()),
        );
        write!(out, r#"{{"format":{FORMAT},"records":["#)?;
        Ok(Self { out, first: true })
    }

    /// `key` and `data` are stored JSON text; text that is not JSON fails instead of producing
    /// a damaged snapshot.
    fn push(&mut self, kind: &str, key: &str, data: Option<&str>, at: &str) -> Result<()> {
        let json = |raw, what| {
            serde_json::from_str::<&RawValue>(raw)
                .map_err(|e| Error::Storage(format!("invalid {what}: {e}")))
        };
        let record = PackedRecord {
            at,
            data: data.map(|raw| json(raw, "sync record")).transpose()?,
            key: json(key, "sync key")?,
            kind,
        };
        if !std::mem::take(&mut self.first) {
            self.out.write_all(b",")?;
        }
        serde_json::to_writer(&mut self.out, &record).map_err(|e| Error::Storage(e.to_string()))
    }

    fn finish(mut self) -> Result<Vec<u8>> {
        self.out.write_all(b"]}")?;
        let encoder = self
            .out
            .into_inner()
            .map_err(|e| Error::Storage(e.error().to_string()))?;
        Ok(encoder.finish()?)
    }
}

// ---- Apply -------------------------------------------------------------------------------

fn field<'a>(data: &'a Value, name: &str) -> Result<&'a Value> {
    data.get(name)
        .ok_or_else(|| Error::Remote(format!("A sync record lacks {name}.")))
}

fn text<'a>(data: &'a Value, name: &str) -> Result<&'a str> {
    field(data, name)?
        .as_str()
        .ok_or_else(|| Error::Remote(format!("A sync record has an invalid {name}.")))
}

fn maybe_text<'a>(data: &'a Value, name: &str) -> Result<Option<&'a str>> {
    match field(data, name)? {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s)),
        _ => Err(Error::Remote(format!(
            "A sync record has an invalid {name}."
        ))),
    }
}

fn number(data: &Value, name: &str) -> Result<i64> {
    field(data, name)?
        .as_i64()
        .ok_or_else(|| Error::Remote(format!("A sync record has an invalid {name}.")))
}

fn maybe_real(data: &Value, name: &str) -> Result<Option<f64>> {
    match field(data, name)? {
        Value::Null => Ok(None),
        value => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| Error::Remote(format!("A sync record has an invalid {name}."))),
    }
}

fn flag(data: &Value, name: &str) -> Result<bool> {
    field(data, name)?
        .as_bool()
        .ok_or_else(|| Error::Remote(format!("A sync record has an invalid {name}.")))
}

/// Writes one remote record into the shared tables. Returns `false` when this device lacks the
/// file or site it belongs to; it is tried again on later cycles.
fn apply(
    tx: &Connection,
    device: &Device,
    kind: &str,
    key: &[String],
    data: Option<&Value>,
) -> Result<bool> {
    let part = |i: usize| {
        key.get(i)
            .map(String::as_str)
            .ok_or_else(|| Error::Remote(format!("A {kind} sync record has an invalid key.")))
    };
    let copies = |sha: &str| device.files.get(sha).map(Vec::as_slice).unwrap_or(&[]);
    match kind {
        "site" => {
            // A site added by hand here takes the preset key another device knows it by.
            let local = device.sites.local_id(part(0)?).or_else(|| {
                let base = data?.get("baseUrl")?.as_str()?;
                data?.get("presetKey")?.as_str()?;
                device
                    .sites
                    .0
                    .iter()
                    .find(|s| s.base == base && s.preset.is_none())
                    .map(|s| s.id.clone())
            });
            if let Some(d) = data {
                crate::boorus::validate(d, true)?;
                if maybe_text(d, "presetKey")?.is_some_and(|key| key.len() > 100) {
                    return Err(Error::Remote(
                        "A site sync record has an invalid presetKey.".into(),
                    ));
                }
            }
            match (data, local) {
                (None, Some(id)) => {
                    tx.execute("DELETE FROM user_booru_sites WHERE id = ?1", [id])?;
                }
                (None, None) => {}
                // The folder may be written by anyone holding its password: credentials saved
                // here never follow a site to another address or engine.
                (Some(d), Some(id)) => {
                    tx.execute(&format!("UPDATE user_booru_sites SET name = ?1, enabled = ?2, sort_order = ?3,
                        username = CASE WHEN base_url = ?4 AND engine = ?5 THEN username END,
                        api_key = CASE WHEN base_url = ?4 AND engine = ?5 THEN api_key END,
                        session_cookie = CASE WHEN base_url = ?4 AND engine = ?5 THEN session_cookie END,
                        is_preset = CASE WHEN preset_key IS NULL AND ?7 IS NOT NULL THEN ?8 ELSE is_preset END,
                        preset_key = coalesce(preset_key, ?7),
                        base_url = ?4, engine = ?5, updated_at = {NOW} WHERE id = ?6"),
                        params![text(d, "name")?, flag(d, "enabled")?, number(d, "sortOrder")?, text(d, "baseUrl")?, text(d, "engine")?, id,
                            maybe_text(d, "presetKey")?, flag(d, "isPreset")?])?;
                    tx.execute_batch(crate::favorite_library::ADOPT_PRESET_KEYS)?;
                }
                (Some(d), None) => {
                    let count: i64 = tx.query_row(
                        "SELECT count(*) FROM user_booru_sites WHERE user_id = ?1",
                        [OWNER_ID],
                        |r| r.get(0),
                    )?;
                    if count >= crate::boorus::MAX_SITES as i64 {
                        return Err(Error::Remote(format!(
                            "This device already has {} booru sites.",
                            crate::boorus::MAX_SITES
                        )));
                    }
                    tx.execute(&format!("INSERT INTO user_booru_sites (id, user_id, name, engine, base_url, is_preset, preset_key, enabled, sort_order, created_at, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, {NOW}, {NOW})"),
                        params![uuid::Uuid::new_v4().to_string(), OWNER_ID, text(d, "name")?, text(d, "engine")?, text(d, "baseUrl")?,
                            flag(d, "isPreset")?, maybe_text(d, "presetKey")?, flag(d, "enabled")?, number(d, "sortOrder")?])?;
                }
            }
            Ok(true)
        }
        "setting" => {
            let name = part(0)?;
            if !SHARED_SETTINGS.contains(&name) {
                return Ok(false);
            }
            match data {
                Some(d) => write_setting(tx, name, field(d, "value")?)?,
                None => {
                    tx.execute(
                        "DELETE FROM user_settings WHERE user_id = ?1 AND key = ?2",
                        params![OWNER_ID, name],
                    )?;
                }
            }
            Ok(true)
        }
        "alias" => {
            match data {
                Some(d) => {
                    tx.execute("INSERT INTO tag_aliases (antecedent, consequent, source) VALUES (?1, ?2, 'custom')
                        ON CONFLICT(antecedent) DO UPDATE SET consequent = excluded.consequent, source = 'custom'",
                        params![part(0)?, text(d, "consequent")?])?;
                }
                None => {
                    tx.execute(
                        "DELETE FROM tag_aliases WHERE antecedent = ?1 AND source = 'custom'",
                        [part(0)?],
                    )?;
                }
            }
            Ok(true)
        }
        "wd14" => {
            // A result is a cache that local copies may still point at; only new results arrive.
            if let Some(d) = data {
                tx.execute(&format!("INSERT INTO wd14_results (sha256, model, results, updated_at) VALUES (?1, ?2, ?3, {NOW})
                    ON CONFLICT(sha256, model) DO UPDATE SET results = excluded.results, updated_at = excluded.updated_at
                    WHERE wd14_results.results <> excluded.results"),
                    params![part(0)?, part(1)?, text(d, "results")?])?;
            }
            Ok(true)
        }
        "trash" => {
            match data {
                Some(d) => {
                    let at = text(d, "trashedAt")?;
                    // A malformed time would compare as already expired and purge the file.
                    let valid: bool = tx
                        .query_row(
                            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1) = ?1",
                            [&at],
                            |r| r.get::<_, Option<bool>>(0),
                        )?
                        .unwrap_or(false);
                    if !valid {
                        return Err(Error::Remote(format!(
                            "The trash sync record has an invalid time: {at}"
                        )));
                    }
                    tx.execute(
                        "INSERT INTO trash (sha256, trashed_at) VALUES (?1, ?2)
                        ON CONFLICT(sha256) DO UPDATE SET trashed_at = excluded.trashed_at",
                        params![part(0)?, at],
                    )?;
                }
                None => {
                    tx.execute("DELETE FROM trash WHERE sha256 = ?1", [part(0)?])?;
                }
            }
            Ok(true)
        }
        // A file this device lacks is shown from its metadata until its original is fetched.
        "file" => match data {
            Some(d) if !device.files.contains_key(part(0)?) => {
                crate::originals::add_remote(tx, part(0)?, d)
            }
            _ => Ok(device.files.contains_key(part(0)?)),
        },
        "tag" => {
            let Some(source) = device.sites.local_token(part(2)?) else {
                return Ok(false);
            };
            let files = copies(part(0)?);
            for (id, _) in files {
                match data {
                    Some(d) => {
                        tx.execute(&format!("INSERT INTO file_tags (file_id, tag, canonical_tag, category, source, score, source_url, created_at, updated_at)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, {NOW}, {NOW}) ON CONFLICT(file_id, tag, source) DO UPDATE SET canonical_tag = excluded.canonical_tag,
                            category = excluded.category, score = excluded.score, source_url = excluded.source_url, updated_at = excluded.updated_at"),
                            params![id, part(1)?, text(d, "canonical")?, text(d, "category")?, source, maybe_real(d, "score")?, maybe_text(d, "sourceUrl")?])?;
                    }
                    None => {
                        tx.execute(
                            "DELETE FROM file_tags WHERE file_id = ?1 AND tag = ?2 AND source = ?3",
                            params![id, part(1)?, source],
                        )?;
                    }
                }
            }
            Ok(!files.is_empty() || data.is_none())
        }
        "suppression" => {
            let files = copies(part(0)?);
            for (id, _) in files {
                match data {
                    Some(d) => {
                        tx.execute("INSERT INTO file_tag_suppressions (file_id, tag, created_at) VALUES (?1, ?2, ?3)
                            ON CONFLICT(file_id, tag) DO UPDATE SET created_at = excluded.created_at",
                            params![id, part(1)?, text(d, "createdAt")?])?;
                    }
                    None => {
                        tx.execute(
                            "DELETE FROM file_tag_suppressions WHERE file_id = ?1 AND tag = ?2",
                            params![id, part(1)?],
                        )?;
                    }
                }
            }
            Ok(!files.is_empty() || data.is_none())
        }
        "vote" => {
            let files = copies(part(0)?);
            for (id, _) in files {
                match data {
                    Some(d) => {
                        tx.execute("INSERT INTO file_votes (file_id, score, last_vote_at) VALUES (?1, ?2, ?3)
                            ON CONFLICT(file_id) DO UPDATE SET score = excluded.score, last_vote_at = excluded.last_vote_at",
                            params![id, number(d, "score")?, text(d, "lastVoteAt")?])?;
                    }
                    None => {
                        tx.execute("DELETE FROM file_votes WHERE file_id = ?1", [id])?;
                    }
                }
            }
            Ok(!files.is_empty() || data.is_none())
        }
        "source" => {
            let provider = part(1)?;
            let files = copies(part(0)?);
            for (id, _) in files {
                let Some(d) = data else {
                    tx.execute("DELETE FROM provider_runs WHERE file_id = ?1 AND provider = ?2 AND status = 'COMPLETED'", params![id, provider])?;
                    continue;
                };
                let completed = maybe_text(d, "completedAt")?;
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM provider_runs WHERE file_id = ?1 AND provider = ?2 AND status = 'COMPLETED'
                       AND completed_at IS ?3 AND created_at = ?4)",
                    params![id, provider, completed, text(d, "createdAt")?], |r| r.get(0))?;
                if !exists {
                    tx.execute("INSERT INTO provider_runs (id, file_id, provider, status, cached_hit, score, source_url, thumb_url, results, created_at, completed_at)
                        VALUES (?1, ?2, ?3, 'COMPLETED', ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![uuid::Uuid::new_v4().to_string(), id, provider, flag(d, "cachedHit")?, maybe_real(d, "score")?,
                            maybe_text(d, "sourceUrl")?, maybe_text(d, "thumbUrl")?, maybe_text(d, "results")?, text(d, "createdAt")?, completed])?;
                }
            }
            Ok(!files.is_empty() || data.is_none())
        }
        "relation" => {
            let Some(source) = device.sites.local_token(part(1)?) else {
                return Ok(false);
            };
            let files = copies(part(0)?);
            for (id, _) in files {
                match data {
                    Some(d) => {
                        tx.execute(&format!("INSERT INTO file_post_relations (file_id, source, remote_id, parent_id, has_children, pool_ids, updated_at)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, {NOW}) ON CONFLICT(file_id, source) DO UPDATE SET remote_id = excluded.remote_id,
                            parent_id = excluded.parent_id, has_children = excluded.has_children, pool_ids = excluded.pool_ids, updated_at = excluded.updated_at"),
                            params![id, source, text(d, "remoteId")?, maybe_text(d, "parentId")?, flag(d, "hasChildren")?, maybe_text(d, "poolIds")?])?;
                    }
                    None => {
                        tx.execute(
                            "DELETE FROM file_post_relations WHERE file_id = ?1 AND source = ?2",
                            params![id, source],
                        )?;
                    }
                }
            }
            Ok(!files.is_empty() || data.is_none())
        }
        "read_file" | "read_post" => {
            let (scope, items): (&str, Vec<String>) = if kind == "read_file" {
                (
                    "file",
                    copies(part(0)?).iter().map(|(id, _)| id.clone()).collect(),
                )
            } else {
                let Some(site) = device.sites.local_id(part(0)?) else {
                    return Ok(false);
                };
                ("post", vec![format!("{site}:{}", part(1)?)])
            };
            for item in &items {
                match data {
                    Some(d) => {
                        tx.execute("INSERT INTO read_marks (scope, item_key, user_id, read_at) VALUES (?1, ?2, ?3, ?4)
                            ON CONFLICT(scope, item_key, user_id) DO UPDATE SET read_at = excluded.read_at",
                            params![scope, item, OWNER_ID, text(d, "readAt")?])?;
                    }
                    None => {
                        tx.execute("DELETE FROM read_marks WHERE scope = ?1 AND item_key = ?2 AND user_id = ?3", params![scope, item, OWNER_ID])?;
                    }
                }
            }
            Ok(!items.is_empty() || data.is_none())
        }
        "favorite" => {
            let Some(provider) = device.sites.local_token(part(0)?) else {
                return Ok(false);
            };
            let Some(d) = data else {
                tx.execute("DELETE FROM favorite_items WHERE user_id = ?1 AND provider = ?2 AND remote_id = ?3",
                    params![OWNER_ID, provider, part(1)?])?;
                return Ok(true);
            };
            // A favorite points at a local file; until this device has it, the favorites sync
            // downloads it or the record waits.
            let Some((_, path)) = maybe_text(d, "sha256")?.and_then(|sha| copies(sha).first())
            else {
                return Ok(false);
            };
            tx.execute(&format!("INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, file_url, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, {NOW}) ON CONFLICT(user_id, provider, remote_id) DO UPDATE SET file_path = excluded.file_path,
                source_url = excluded.source_url, file_url = excluded.file_url, created_at = excluded.created_at, updated_at = excluded.updated_at"),
                params![OWNER_ID, provider, part(1)?, path, maybe_text(d, "sourceUrl")?, maybe_text(d, "fileUrl")?, text(d, "createdAt")?])?;
            Ok(true)
        }
        // A kind from a newer GoonCave waits until this device is updated.
        _ => Ok(false),
    }
}

/// Applies every waiting record this device can apply now.
fn apply_pending(c: &mut Connection, job: &Job) -> Result<usize> {
    let waiting: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_records WHERE applied = 0)",
        [],
        |r| r.get(0),
    )?;
    if !waiting {
        return Ok(0);
    }
    job.applying.store(true, Ordering::Relaxed);
    let result = (|| {
        let mut device = Device::load(c)?;
        let mut tx = c.transaction()?;
        let mut waiting = Vec::new();
        {
            let mut statement =
                tx.prepare("SELECT kind, record_key, data FROM sync_records WHERE applied = 0")?;
            let mut rows = statement.query([])?;
            while let Some(r) = rows.next()? {
                let (kind, key, data): (String, String, Option<String>) =
                    (r.get(0)?, r.get(1)?, r.get(2)?);
                if let Some(rank) = KINDS.iter().position(|k| *k == kind) {
                    waiting.push((rank, kind, key, data));
                }
            }
        }
        waiting.sort_by_key(|(rank, ..)| *rank);
        let mut applied = 0;
        let mut sites_changed = false;
        let mut files_changed = false;
        for (_, kind, key, data) in waiting {
            if sites_changed && kind != "site" {
                device.sites = Sites::load(&tx)?;
                sites_changed = false;
            }
            if files_changed && kind != "file" {
                device = Device::load(&tx)?;
                files_changed = false;
            }
            let data = data.map(|raw| json_text(&raw, "sync record")).transpose()?;
            // A dropped savepoint rolls back, so a record that fails leaves nothing half written.
            let point = tx.savepoint()?;
            match apply(&point, &device, &kind, &parts(&key)?, data.as_ref()) {
                Ok(true) => {
                    point.execute(
                        "UPDATE sync_records SET applied = 1 WHERE kind = ?1 AND record_key = ?2",
                        params![kind, key],
                    )?;
                    point.commit()?;
                    applied += 1;
                    sites_changed |= kind == "site";
                    files_changed |= kind == "file";
                }
                Ok(false) => {}
                // A damaged record waits instead of stopping every other record.
                Err(error) => eprintln!("Cannot apply the {kind} sync record {key}: {error}"),
            }
        }
        tx.commit()?;
        Ok(applied)
    })();
    job.applying.store(false, Ordering::Relaxed);
    result
}

// ---- Manual backups ----------------------------------------------------------------------

/// The records of a backup file. Deletion markers are dropped: an import adds and updates, and
/// never deletes.
pub(crate) fn read_backup(bytes: &[u8]) -> Result<Records> {
    let records = parse(bytes).map_err(|reason| match reason {
        Unreadable::Damaged => Error::Invalid("This file is not a GoonCave backup, or it is damaged.".into()),
        Unreadable::Newer => Error::Invalid("This backup comes from a newer GoonCave. Update GoonCave on this device, then import it again.".into()),
    })?;
    Ok(records
        .into_iter()
        .filter_map(|r| Some(((r.kind, r.key), r.data?)))
        .collect())
}

/// Takes records brought in by hand as changes made now, so they win over what this device and
/// the folder hold. Records of files this device lacks wait for them.
pub(crate) fn take(c: &mut Connection, job: &Job, records: Records) -> Result<Value> {
    // The folder lacks these records now, so its snapshot must be read and merged again.
    job.set_in_step("", None);
    let at = now();
    let remote = records
        .into_iter()
        .map(|((kind, key), data)| Remote {
            kind,
            key,
            data: Some(data),
            at: at.clone(),
        })
        .collect();
    merge(c, remote)?;
    let applied = apply_pending(c, job)?;
    let waiting: i64 = c.query_row(
        "SELECT COUNT(*) FROM sync_records WHERE applied = 0",
        [],
        |r| r.get(0),
    )?;
    Ok(json!({"applied": applied, "waiting": waiting}))
}

/// Every shared record of this device as a backup file, with the time of its last known change.
pub(crate) fn backup_file(c: &Connection) -> Result<Vec<u8>> {
    let device = Device::load(c)?;
    let local = export(c, &device)?;
    let known = stored(c)?;
    let at = now();
    let mut records: Vec<(&(String, String), &String, &str)> = local
        .iter()
        .map(|(id, data)| {
            let when = match known.get(id) {
                Some(Stored {
                    data: Some(old),
                    at: stamped,
                    ..
                }) if old == data => stamped.as_str(),
                _ => at.as_str(),
            };
            (id, data, when)
        })
        .collect();
    // Records waiting for a file this device lacks still belong to the library.
    records.extend(
        known
            .iter()
            .filter(|(id, record)| record.applied != 1 && !local.contains_key(*id))
            .filter_map(|(id, record)| Some((id, record.data.as_ref()?, record.at.as_str()))),
    );
    records.sort_by(|a, b| a.0.cmp(b.0));
    let mut pack = Pack::new()?;
    for ((kind, key), data, at) in records {
        pack.push(kind, key, Some(data), at)?;
    }
    pack.finish()
}

// ---- Cycle -------------------------------------------------------------------------------

struct Saved {
    url: String,
    username: String,
    password: String,
}

fn connection(c: &Connection) -> Result<Option<Saved>> {
    let saved = read_setting(c, CONNECTION_KEY, &Value::Null)?;
    if saved.is_null() {
        return Ok(None);
    }
    let invalid = || Error::Storage("invalid sync connection setting".into());
    Ok(Some(Saved {
        url: saved["url"].as_str().ok_or_else(invalid)?.to_owned(),
        username: saved["username"].as_str().ok_or_else(invalid)?.to_owned(),
        password: saved["password"].as_str().ok_or_else(invalid)?.to_owned(),
    }))
}

/// The connected sync folder, if any.
pub(crate) async fn connected_folder(db: &Database) -> Result<Option<Folder>> {
    match db.call(|c| connection(c)).await? {
        Some(saved) => Ok(Some(Folder::new(
            &saved.url,
            &saved.username,
            &saved.password,
        )?)),
        None => Ok(None),
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Trigger {
    /// Start, a new connection or "Sync now": always read the folder.
    Full,
    /// A local change: read and write the folder only when something needs uploading.
    Change,
}

/// Stamps the kinds whose tables were written since the last stamp.
async fn stamp_dirty(db: &Database, at: String) -> Result<bool> {
    let job = db.sync.clone();
    let kinds = db.call(move |_| Ok(job.take_dirty())).await?;
    let result = async {
        let changes = db.sync_read(move |c| compare(c, &kinds)).await?;
        db.call(move |c| write(c, &at, changes)).await
    }
    .await;
    if result.is_err() {
        db.sync.mark_all_dirty();
    }
    result
}

async fn cycle(db: &Database, folder: &Folder, place: &str, trigger: Trigger) -> Result<()> {
    let job = &db.sync;
    job.changed.store(false, Ordering::Relaxed);
    let fresh: bool = db
        .call(|c| {
            Ok(c.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM sync_records WHERE applied = 1)",
                [],
                |r| r.get(0),
            )?)
        })
        .await?;
    if fresh {
        // Nothing stored to compare with: every kind has to be stamped, and the folder read.
        job.mark_all_dirty();
        job.set_in_step(place, None);
    }
    // A device joining a folder takes the folder's version of shared records first; stamping
    // first would make every local record newer than the folder's.
    if !fresh {
        let at = now();
        if stamp_dirty(db, at).await? {
            job.pending_upload.store(true, Ordering::Relaxed);
        }
    }
    let worker = db.clone();
    db.call(move |c| apply_pending(c, &worker.sync)).await?;
    if trigger == Trigger::Change && !job.pending_upload.load(Ordering::Relaxed) {
        return Ok(());
    }
    let mut first = fresh;
    for _ in 0..ATTEMPTS {
        let known = job.known_etag(place);
        let (mut behind, absent, etag) = match folder.get(SNAPSHOT, known.as_deref()).await? {
            // The folder still holds exactly the records this device had then; only the
            // changes stamped since are new.
            Fetched::Unchanged => (job.pending_upload.load(Ordering::Relaxed), false, known),
            fetched => {
                let absent = matches!(fetched, Fetched::Missing);
                let (records, etag) = match fetched {
                    Fetched::Found(bytes, etag) => (tokio::task::spawn_blocking(move || parse(&bytes))
                        .await
                        .map_err(|error| Error::Storage(error.to_string()))?
                        .map_err(|reason| match reason {
                        Unreadable::Damaged => Error::Remote("The sync file in the WebDAV folder is damaged. Restore a copy from its backups folder, or remove it to start over from this device.".into()),
                        Unreadable::Newer => Error::Remote("Another device synced with a newer GoonCave. Update GoonCave on this device to keep syncing.".into()),
                    })?, etag),
                    _ => (Vec::new(), None),
                };
                let (newer, behind) = db.sync_read(move |c| newer_than_stored(c, records)).await?;
                db.call(move |c| save_newer(c, newer)).await?;
                (behind, absent, etag)
            }
        };
        let worker = db.clone();
        db.call(move |c| apply_pending(c, &worker.sync)).await?;
        if first {
            first = false;
            let at = now();
            behind |= stamp_dirty(db, at).await?;
        }
        behind |= absent;
        if !behind {
            job.pending_upload.store(false, Ordering::Relaxed);
            job.set_in_step(place, etag);
            return backup(db, folder, None).await;
        }
        let body = db.sync_read(|c| snapshot(c)).await?;
        let condition = match &etag {
            _ if absent => Condition::Absent,
            Some(etag) => Condition::Matches(etag),
            // A server without ETags cannot detect a concurrent write; the next merge repairs it.
            None => Condition::Any,
        };
        match folder.put(SNAPSHOT, body.clone(), condition).await? {
            Put::Written(etag) => {
                job.pending_upload.store(false, Ordering::Relaxed);
                job.set_in_step(place, etag);
                return backup(db, folder, Some(body)).await;
            }
            Put::Stale => job.set_in_step(place, None),
        }
    }
    Err(Error::Remote(
        "Another device kept changing the sync folder. GoonCave will try again shortly.".into(),
    ))
}

/// Writes today's backup once a day and keeps the latest [`KEEP_BACKUPS`].
async fn backup(db: &Database, folder: &Folder, body: Option<Vec<u8>>) -> Result<()> {
    let today = now()[..10].to_owned();
    let last = db
        .call(|c| read_setting(c, BACKUP_KEY, &Value::Null))
        .await?;
    if last.as_str() == Some(today.as_str()) {
        return Ok(());
    }
    let body = match body {
        Some(body) => body,
        None => db.sync_read(|c| snapshot(c)).await?,
    };
    folder.create_folder(BACKUPS).await?;
    folder
        .put(&format!("{BACKUPS}{today}.json.gz"), body, Condition::Any)
        .await?;
    prune(folder).await?;
    db.call(move |c| write_setting(c, BACKUP_KEY, &json!(today)))
        .await
}

async fn prune(folder: &Folder) -> Result<()> {
    let mut names: Vec<String> = folder
        .list(BACKUPS)
        .await?
        .into_iter()
        .filter(|name| name.ends_with(".json.gz"))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(KEEP_BACKUPS);
    for name in &names[..excess] {
        folder.delete(&format!("{BACKUPS}{name}")).await?;
    }
    Ok(())
}

/// Runs one cycle if a folder is connected and records the outcome in the status.
async fn run(db: &Database, trigger: Trigger) -> Result<()> {
    let _running = db.sync.running.lock().await;
    let Some(saved) = db.call(|c| connection(c)).await? else {
        // Imported records still wait for their files without a folder.
        db.sync.changed.store(false, Ordering::Relaxed);
        let worker = db.clone();
        db.call(move |c| apply_pending(c, &worker.sync)).await?;
        db.sync.set_status(json!({"state": "off", "error": null}));
        return Ok(());
    };
    db.sync
        .set_status(json!({"state": "syncing", "error": null}));
    let result = async {
        let folder = Folder::new(&saved.url, &saved.username, &saved.password)?;
        cycle(
            db,
            &folder,
            &format!("{}\n{}", saved.url, saved.username),
            trigger,
        )
        .await
    }
    .await;
    match &result {
        Ok(()) => {
            db.sync
                .set_status(json!({"state": "idle", "lastSyncAt": now(), "error": null}));
            db.originals.wake.notify_one();
        }
        Err(error) => {
            eprintln!("Sync failed: {error}");
            db.sync
                .set_status(json!({"state": "error", "error": error.to_string()}));
        }
    }
    result
}

/// Reads the folder on start, then uploads a few seconds after each change. Runs until dropped.
pub(crate) async fn watch(db: Database) {
    let mut trigger = Some(Trigger::Full);
    let mut retry_at: Option<Instant> = None;
    loop {
        if trigger.is_none() && db.sync.due() {
            trigger = Some(Trigger::Change);
        }
        if trigger.is_none() && retry_at.is_some_and(|at| Instant::now() >= at) {
            trigger = Some(Trigger::Full);
        }
        if let Some(current) = trigger.take() {
            retry_at = run(&db, current)
                .await
                .err()
                .map(|_| Instant::now() + RETRY);
            release_freed_memory();
        }
        tokio::select! {
            _ = db.sync.wake.notified() => trigger = Some(Trigger::Full),
            _ = tokio::time::sleep(POLL) => {}
        }
    }
}

/// A cycle holds every record in memory at once. glibc keeps what it frees in each
/// thread's arena, so without this a large library stays at gigabytes of resident memory.
fn release_freed_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only returns free heap pages to the system.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// The upload when the app closes.
pub(crate) async fn flush(db: &Database) {
    if let Err(error) = run(db, Trigger::Change).await {
        eprintln!("Cannot upload the last changes before closing: {error}");
    }
}

// ---- Routes ------------------------------------------------------------------------------

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route(
            "/sync/settings",
            get(get_settings).put(put_settings).delete(disconnect),
        )
        .route("/sync/status", get(status))
        .route("/sync/now", post(sync_now))
}

fn public(saved: Option<&Saved>) -> Value {
    match saved {
        Some(saved) => {
            json!({"url": saved.url, "username": saved.username, "hasPassword": !saved.password.is_empty()})
        }
        None => json!({"url": null, "username": null, "hasPassword": false}),
    }
}

async fn get_settings(State(db): State<Database>) -> Result<Json<Value>> {
    let saved = db.call(|c| connection(c)).await?;
    Ok(Json(public(saved.as_ref())))
}

/// Connects a folder. The password may be left out to keep the saved one. The folder is checked
/// before anything is saved.
async fn put_settings(State(db): State<Database>, body: axum::body::Bytes) -> Result<Json<Value>> {
    let invalid =
        || Error::Invalid("Send the folder address, a user name and optionally a password.".into());
    let body: Value = serde_json::from_slice(&body).map_err(|_| invalid())?;
    let url = body["url"]
        .as_str()
        .filter(|u| !u.trim().is_empty() && u.len() <= 2048)
        .ok_or_else(invalid)?
        .trim()
        .to_owned();
    let username = body["username"]
        .as_str()
        .filter(|u| u.len() <= 512)
        .ok_or_else(invalid)?
        .to_owned();
    let previous = db.call(|c| connection(c)).await?;
    let password = match body.get("password") {
        None | Some(Value::Null) => previous
            .as_ref()
            .map(|p| p.password.clone())
            .unwrap_or_default(),
        Some(Value::String(p)) if p.len() <= 512 => p.clone(),
        _ => return Err(invalid()),
    };
    let folder = Folder::new(&url, &username, &password)?;
    folder.create_folder(FOLDER).await?;
    let saved = Saved {
        url,
        username,
        password,
    };
    let moved = previous.as_ref().is_none_or(|p| p.url != saved.url);
    let value = json!({"url": saved.url, "username": saved.username, "password": saved.password});
    let running = db.sync.running.lock().await;
    db.call(move |c| {
        let tx = c.transaction()?;
        write_setting(&tx, CONNECTION_KEY, &value)?;
        // Another folder starts from what it holds, not from what the old one held. Records
        // still waiting for their files (an import, for one) are kept.
        if moved {
            tx.execute("DELETE FROM sync_records WHERE applied = 1", [])?;
            tx.execute(
                "DELETE FROM user_settings WHERE user_id = ?1 AND key = ?2",
                params![OWNER_ID, BACKUP_KEY],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    drop(running);
    db.sync.wake.notify_one();
    Ok(Json(public(Some(&saved))))
}

async fn disconnect(State(db): State<Database>) -> Result<Json<Value>> {
    let _running = db.sync.running.lock().await;
    db.call(|c| {
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM user_settings WHERE user_id = ?1 AND key IN (?2, ?3)",
            params![OWNER_ID, CONNECTION_KEY, BACKUP_KEY],
        )?;
        tx.execute("DELETE FROM sync_records WHERE applied = 1", [])?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    db.sync
        .set_status(json!({"state": "off", "lastSyncAt": null, "error": null}));
    Ok(Json(public(None)))
}

async fn status(State(db): State<Database>) -> Json<Value> {
    Json(db.sync.snapshot())
}

async fn sync_now(State(db): State<Database>) -> Result<Json<Value>> {
    let configured = db.call(|c| connection(c)).await?.is_some();
    if !configured {
        return Err(Error::Invalid(
            "Connect a WebDAV folder first, then sync.".into(),
        ));
    }
    db.sync.wake.notify_one();
    Ok(Json(json!({"status": "queued"})))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{HeaderMap, Method, StatusCode, Uri},
        response::{IntoResponse, Response},
    };
    use std::{path::Path, process::Command, sync::Arc};

    /// Path → (body, version used as the ETag).
    type Files = HashMap<String, (Vec<u8>, u64)>;

    /// An in-memory WebDAV folder with ETags; a path ending in `/` marks a folder.
    #[derive(Clone, Default)]
    pub(crate) struct Dav(pub(crate) Arc<Mutex<Files>>);

    impl Dav {
        pub(crate) fn files(&self) -> HashMap<String, (Vec<u8>, u64)> {
            self.0.lock().unwrap().clone()
        }
    }

    async fn dav(
        State(dav): State<Dav>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let path = uri.path().to_owned();
        let mut files = dav.0.lock().unwrap();
        let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
        match method.as_str() {
            "GET" => match files.get(&path) {
                Some((_, version))
                    if header("if-none-match") == Some(&format!("\"{version}\"")) =>
                {
                    StatusCode::NOT_MODIFIED.into_response()
                }
                Some((body, version)) => {
                    ([("etag", format!("\"{version}\""))], body.clone()).into_response()
                }
                None => StatusCode::NOT_FOUND.into_response(),
            },
            "PUT" => {
                let current = files.get(&path).map(|(_, v)| format!("\"{v}\""));
                if (header("if-none-match") == Some("*") && current.is_some())
                    || header("if-match").is_some_and(|tag| current.as_deref() != Some(tag))
                {
                    return StatusCode::PRECONDITION_FAILED.into_response();
                }
                let version = files.values().map(|(_, v)| *v).max().unwrap_or(0) + 1;
                files.insert(path, (body.to_vec(), version));
                (StatusCode::CREATED, [("etag", format!("\"{version}\""))]).into_response()
            }
            "MKCOL" if files.contains_key(&path) => StatusCode::METHOD_NOT_ALLOWED.into_response(),
            "MKCOL" => {
                files.insert(path, (Vec::new(), 0));
                StatusCode::CREATED.into_response()
            }
            "PROPFIND" if !files.contains_key(&path) => StatusCode::NOT_FOUND.into_response(),
            "PROPFIND" => {
                let entries: String = files
                    .keys()
                    .filter(|p| {
                        p.strip_prefix(&path).is_some_and(|rest| {
                            !rest.is_empty() && !rest.trim_end_matches('/').contains('/')
                        })
                    })
                    .chain(std::iter::once(&path))
                    .map(|p| format!("<d:response><d:href>{p}</d:href></d:response>"))
                    .collect();
                (
                    StatusCode::MULTI_STATUS,
                    format!(r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">{entries}</d:multistatus>"#),
                )
                    .into_response()
            }
            "DELETE" => {
                files.remove(&path);
                StatusCode::NO_CONTENT.into_response()
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    pub(crate) async fn serve() -> (String, Dav) {
        let store = Dav::default();
        store
            .0
            .lock()
            .unwrap()
            .insert("/dav/".into(), (Vec::new(), 0));
        let app = Router::new().fallback(dav).with_state(store.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/dav"), store)
    }

    pub(crate) fn picture(path: &Path, source: &str) {
        let status = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                source,
                "-frames:v",
                "1",
                "-y",
            ])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    pub(crate) struct Device {
        _dir: tempfile::TempDir,
        pub(crate) db: Database,
    }

    impl Device {
        pub(crate) async fn open(url: &str, pictures: &[(&str, &Path)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
            let root = db.library().root.clone();
            for (name, source) in pictures {
                std::fs::copy(source, root.join(name)).unwrap();
            }
            crate::library::scan(&db).await.unwrap();
            let value = json!({"url": url, "username": "owner", "password": "dav-password-1"});
            db.call(move |c| write_setting(c, CONNECTION_KEY, &value))
                .await
                .unwrap();
            Self { _dir: dir, db }
        }

        pub(crate) async fn sql(&self, statement: &str) {
            let statement = statement.to_owned();
            self.db
                .call(move |c| Ok(c.execute_batch(&statement)?))
                .await
                .unwrap();
        }

        pub(crate) async fn value(&self, query: &str) -> Option<String> {
            let query = query.to_owned();
            self.db
                .call(move |c| {
                    Ok(c.query_row(&query, [], |r| r.get::<_, Option<String>>(0))
                        .optional()?
                        .flatten())
                })
                .await
                .unwrap()
        }

        pub(crate) async fn sync(&self, trigger: Trigger) {
            run(&self.db, trigger).await.unwrap();
        }
    }

    use rusqlite::OptionalExtension;

    pub(crate) struct Fixtures {
        _dir: tempfile::TempDir,
        pub(crate) first: std::path::PathBuf,
        pub(crate) second: std::path::PathBuf,
    }

    pub(crate) fn fixtures() -> Fixtures {
        let dir = tempfile::tempdir().unwrap();
        let (first, second) = (dir.path().join("first.png"), dir.path().join("second.png"));
        picture(&first, "testsrc=s=64x48");
        picture(&second, "color=c=blue:s=64x48");
        Fixtures {
            _dir: dir,
            first,
            second,
        }
    }

    fn vote(score: i64) -> String {
        format!("INSERT INTO file_votes (file_id, score, last_vote_at) SELECT id, {score}, {NOW} FROM files WHERE true
                 ON CONFLICT(file_id) DO UPDATE SET score = excluded.score, last_vote_at = excluded.last_vote_at")
    }

    #[tokio::test]
    async fn a_vote_reaches_the_second_device_and_the_latest_change_wins() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("a.png", &files.first)]).await;
        a.sql(&vote(1)).await;
        a.sync(Trigger::Full).await;

        let b = Device::open(&url, &[("renamed.png", &files.first)]).await;
        b.sync(Trigger::Full).await;
        assert_eq!(
            b.value("SELECT CAST(score AS TEXT) FROM file_votes")
                .await
                .as_deref(),
            Some("1")
        );

        b.sql(&vote(-1)).await;
        b.sync(Trigger::Change).await;
        a.sync(Trigger::Full).await;
        assert_eq!(
            a.value("SELECT CAST(score AS TEXT) FROM file_votes")
                .await
                .as_deref(),
            Some("-1")
        );

        // A deletion travels as a marker, so the next merge does not bring the vote back.
        a.sql("DELETE FROM file_votes").await;
        a.sync(Trigger::Change).await;
        b.sync(Trigger::Full).await;
        b.sync(Trigger::Full).await;
        a.sync(Trigger::Full).await;
        assert_eq!(b.value("SELECT score FROM file_votes").await, None);
        assert_eq!(a.value("SELECT score FROM file_votes").await, None);
    }

    #[test]
    fn a_write_marks_only_the_kinds_its_table_feeds() {
        let job = Job::default();
        assert_eq!(job.take_dirty().len(), KINDS.len());
        assert!(job.take_dirty().is_empty());
        job.written("read_marks");
        job.written("sync_records");
        assert_eq!(job.take_dirty(), HashSet::from(["read_file", "read_post"]));
        job.written("active_library_folders");
        assert_eq!(job.take_dirty().len(), KINDS.len());
    }

    #[tokio::test]
    async fn a_stamp_of_one_table_neither_deletes_nor_revives_the_records_of_the_others() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("a.png", &files.first)]).await;
        a.sql(&format!("{};
            INSERT INTO file_tags (file_id, tag, canonical_tag, category, source, created_at, updated_at)
              SELECT id, 'blue_sky', 'blue_sky', 'general', 'local', {NOW}, {NOW} FROM files;", vote(1))).await;
        a.sync(Trigger::Full).await;
        let b = Device::open(&url, &[("b.png", &files.first)]).await;
        b.sync(Trigger::Full).await;
        assert_eq!(
            b.value("SELECT tag FROM file_tags WHERE tag = 'blue_sky'")
                .await
                .as_deref(),
            Some("blue_sky")
        );

        a.sql("DELETE FROM file_tags WHERE tag = 'blue_sky'").await;
        a.sync(Trigger::Change).await;
        a.sql(&format!(
            "INSERT INTO read_marks (scope, item_key, user_id, read_at)
              SELECT 'file', id, '{OWNER_ID}', {NOW} FROM files"
        ))
        .await;
        a.sync(Trigger::Change).await;
        b.sync(Trigger::Full).await;
        b.sync(Trigger::Full).await;
        a.sync(Trigger::Full).await;

        for device in [&a, &b] {
            assert_eq!(
                device
                    .value("SELECT tag FROM file_tags WHERE tag = 'blue_sky'")
                    .await,
                None
            );
            assert_eq!(
                device
                    .value("SELECT CAST(score AS TEXT) FROM file_votes")
                    .await
                    .as_deref(),
                Some("1")
            );
        }
        assert!(b
            .value("SELECT read_at FROM read_marks WHERE scope = 'file'")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn an_unchanged_folder_is_not_read_again_and_another_devices_write_is() {
        let (url, dav) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("a.png", &files.first)]).await;
        a.sql(&vote(1)).await;
        a.sync(Trigger::Full).await;
        let b = Device::open(&url, &[("b.png", &files.first)]).await;
        b.sync(Trigger::Full).await;
        b.sql(&vote(-1)).await;
        b.sync(Trigger::Change).await;

        // A's ETag is from its own upload; B's write changed it, so A must read B's vote.
        a.sql(&format!(
            "INSERT INTO read_marks (scope, item_key, user_id, read_at)
              SELECT 'file', id, '{OWNER_ID}', {NOW} FROM files"
        ))
        .await;
        a.sync(Trigger::Change).await;
        assert_eq!(
            a.value("SELECT CAST(score AS TEXT) FROM file_votes")
                .await
                .as_deref(),
            Some("-1")
        );

        // Nothing new in the folder: A uploads its change on top of the snapshot it knows.
        a.sql(&vote(1)).await;
        a.sync(Trigger::Change).await;
        let version = dav.files()["/dav/GoonCave/library.json.gz"].1;
        b.sync(Trigger::Full).await;
        assert_eq!(
            b.value("SELECT CAST(score AS TEXT) FROM file_votes")
                .await
                .as_deref(),
            Some("1")
        );
        assert!(b
            .value("SELECT read_at FROM read_marks WHERE scope = 'file'")
            .await
            .is_some());
        assert_eq!(dav.files()["/dav/GoonCave/library.json.gz"].1, version);
    }

    #[tokio::test]
    async fn credentials_stay_on_the_device_and_custom_sites_keep_their_records() {
        let (url, dav) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("a.png", &files.first)]).await;
        a.sql(&format!("
            INSERT INTO user_booru_sites (id, user_id, name, engine, base_url, username, api_key, session_cookie, is_preset, enabled, sort_order, created_at, updated_at)
              VALUES ('site-on-a', '{OWNER_ID}', 'Mine', 'e621', 'https://booru.example.org', 'secret-user-7', 'secret-key-7', 'secret-cookie-7', 0, 1, 3, {NOW}, {NOW});
            INSERT INTO provider_credentials (user_id, provider, username, api_key, updated_at) VALUES ('{OWNER_ID}', 'SAUCENAO', 'sauce-user-7', 'sauce-key-7', {NOW});
            INSERT INTO file_tags (file_id, tag, canonical_tag, category, source, created_at, updated_at) SELECT id, 'blue_sky', 'blue_sky', 'general', 'site-on-a', {NOW}, {NOW} FROM files;
            INSERT INTO read_marks (scope, item_key, user_id, read_at) VALUES ('post', 'site-on-a:42', '{OWNER_ID}', {NOW});
            INSERT INTO user_settings (user_id, key, value) VALUES ('{OWNER_ID}', 'blacklist.settings', '{{\"tags\":[\"gore\"]}}'), ('{OWNER_ID}', 'extra.maxGridColumns', '9');")).await;
        a.sync(Trigger::Full).await;

        let snapshot = dav.files()["/dav/GoonCave/library.json.gz"].0.clone();
        let mut text = String::new();
        GzDecoder::new(snapshot.as_slice())
            .read_to_string(&mut text)
            .unwrap();
        for secret in [
            "secret-user-7",
            "secret-key-7",
            "secret-cookie-7",
            "sauce-user-7",
            "sauce-key-7",
            "dav-password-1",
            "maxGridColumns",
        ] {
            assert!(!text.contains(secret), "{secret} reached the folder");
        }

        let b = Device::open(&url, &[("b.png", &files.first)]).await;
        b.sync(Trigger::Full).await;
        let site = b
            .value("SELECT id FROM user_booru_sites WHERE base_url = 'https://booru.example.org'")
            .await
            .unwrap();
        assert_ne!(site, "site-on-a");
        assert_eq!(
            b.value(
                "SELECT api_key FROM user_booru_sites WHERE base_url = 'https://booru.example.org'"
            )
            .await,
            None
        );
        assert_eq!(
            b.value("SELECT source FROM file_tags WHERE tag = 'blue_sky'")
                .await,
            Some(site.clone())
        );
        assert_eq!(
            b.value("SELECT item_key FROM read_marks WHERE scope = 'post'")
                .await,
            Some(format!("{site}:42"))
        );
        assert_eq!(
            b.value("SELECT value FROM user_settings WHERE key = 'blacklist.settings'")
                .await
                .as_deref(),
            Some(r#"{"tags":["gore"]}"#)
        );
        assert_eq!(
            b.value("SELECT value FROM user_settings WHERE key = 'extra.maxGridColumns'")
                .await,
            None
        );
    }

    #[tokio::test]
    async fn a_file_missing_on_the_device_shows_with_its_records_until_it_arrives() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(
            &url,
            &[("one.png", &files.first), ("two.png", &files.second)],
        )
        .await;
        a.sql(&format!("INSERT INTO file_votes (file_id, score, last_vote_at) SELECT id, 1, {NOW} FROM files WHERE path LIKE '%two.png'")).await;
        a.sync(Trigger::Full).await;

        let b = Device::open(&url, &[("one.png", &files.first)]).await;
        b.sync(Trigger::Full).await;
        assert_eq!(
            b.value("SELECT CAST(v.score AS TEXT) FROM file_votes v JOIN files f ON f.id = v.file_id WHERE f.location_type = 'REMOTE'").await.as_deref(),
            Some("1"),
            "the file missing on this device shows with its vote"
        );
        b.sql(&format!("UPDATE file_votes SET score = -1, last_vote_at = {NOW} WHERE file_id IN (SELECT id FROM files WHERE path LIKE '%one.png')")).await;
        b.sync(Trigger::Change).await;
        a.sync(Trigger::Full).await;
        assert_eq!(
            a.value("SELECT CAST(v.score AS TEXT) FROM file_votes v JOIN files f ON f.id = v.file_id WHERE f.path LIKE '%two.png'").await.as_deref(),
            Some("1"),
            "another file's upload must not change this vote"
        );

        std::fs::copy(&files.second, b.db.library().root.join("arrived.png")).unwrap();
        crate::library::scan(&b.db).await.unwrap();
        b.sync(Trigger::Change).await;
        assert_eq!(
            b.value("SELECT CAST(v.score AS TEXT) FROM file_votes v JOIN files f ON f.id = v.file_id WHERE f.path LIKE '%arrived.png'").await.as_deref(),
            Some("1")
        );
        assert_eq!(
            b.value("SELECT CAST(count(*) AS TEXT) FROM files")
                .await
                .as_deref(),
            Some("2"),
            "the arrived file takes over the row it was shown from"
        );
    }

    #[tokio::test]
    async fn a_synced_site_cannot_move_saved_credentials_to_another_address() {
        let (url, _) = serve().await;
        let a = Device::open(&url, &[]).await;
        a.sql(&format!("INSERT INTO user_booru_sites (id, user_id, name, engine, base_url, api_key, is_preset, preset_key, enabled, sort_order, created_at, updated_at)
            VALUES ('local', '{OWNER_ID}', 'e621', 'e621', 'https://e621.net', 'kept-key', 1, 'e621', 1, 0, {NOW}, {NOW});
            INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES ('site', '[\"e621\"]',
              '{{\"name\":\"Renamed\",\"engine\":\"danbooru\",\"baseUrl\":\"https://attacker.example\",\"isPreset\":true,\"presetKey\":\"e621\",\"enabled\":false,\"sortOrder\":4}}',
              '2999-01-01T00:00:00.000Z', 0);")).await;
        let worker = a.db.clone();
        a.db.call(move |c| apply_pending(c, &worker.sync))
            .await
            .unwrap();
        assert_eq!(
            a.value("SELECT name || ' ' || engine || ' ' || base_url || ' ' || ifnull(api_key, 'no key') FROM user_booru_sites").await.as_deref(),
            Some("Renamed danbooru https://attacker.example no key")
        );
    }

    #[tokio::test]
    async fn a_damaged_record_waits_without_blocking_the_others() {
        let (url, _) = serve().await;
        let a = Device::open(&url, &[]).await;
        a.sql("INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES
            ('site', '[\"e621\"]', '{}', '2999-01-01T00:00:00.000Z', 0),
            ('setting', '[\"shortcuts.bindings\"]', '{\"value\":{\"next\":\"j\"}}', '2999-01-01T00:00:00.000Z', 0);").await;
        let worker = a.db.clone();
        a.db.call(move |c| apply_pending(c, &worker.sync))
            .await
            .unwrap();
        assert_eq!(
            a.value("SELECT value FROM user_settings WHERE key = 'shortcuts.bindings'")
                .await
                .as_deref(),
            Some(r#"{"next":"j"}"#)
        );
        assert_eq!(
            a.value("SELECT group_concat(kind) FROM sync_records WHERE applied = 0")
                .await
                .as_deref(),
            Some("site")
        );
    }

    #[tokio::test]
    async fn a_backup_file_restores_votes_once_the_file_arrives_without_a_folder() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("a.png", &files.first)]).await;
        a.sql(&vote(1)).await;
        let file = a.db.call(|c| backup_file(c)).await.unwrap();

        let b = Device::open(&url, &[]).await;
        b.sql("DELETE FROM user_settings WHERE key = 'sync.webdav'")
            .await;
        let records = read_backup(&file).unwrap();
        let worker = b.db.clone();
        let result =
            b.db.call(move |c| take(c, &worker.sync, records))
                .await
                .unwrap();
        assert_eq!(result["waiting"], 0, "{result}");
        assert_eq!(
            b.value("SELECT location_type FROM files").await.as_deref(),
            Some("REMOTE"),
            "the file shows before its original arrives"
        );

        std::fs::copy(&files.first, b.db.library().root.join("b.png")).unwrap();
        crate::library::scan(&b.db).await.unwrap();
        b.sync(Trigger::Change).await;
        assert_eq!(
            b.value("SELECT CAST(score AS TEXT) FROM file_votes")
                .await
                .as_deref(),
            Some("1")
        );
    }

    #[test]
    fn remote_times_share_one_format_and_never_lie_in_the_future() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(
                br#"{"format": 1, "records": [
                {"kind": "alias", "key": ["a"], "data": {"consequent": "b"}, "at": "2026-01-01T12:00:00+02:00"},
                {"kind": "alias", "key": ["c"], "data": {"consequent": "d"}, "at": "2999-01-01T00:00:00Z"}]}"#,
            )
            .unwrap();
        let records = parse(&encoder.finish().unwrap()).ok().unwrap();
        assert_eq!(records[0].at, "2026-01-01T10:00:00.000Z");
        assert!(records[1].at <= now(), "{}", records[1].at);
    }

    #[tokio::test]
    async fn a_synced_site_with_an_unknown_engine_waits() {
        let (url, _) = serve().await;
        let a = Device::open(&url, &[]).await;
        a.sql("INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES ('site', '[\"url:https://x.example\"]',
            '{\"name\":\"X\",\"engine\":\"unknown\",\"baseUrl\":\"https://x.example\",\"isPreset\":false,\"presetKey\":null,\"enabled\":true,\"sortOrder\":0}',
            '2026-01-01T00:00:00.000Z', 0);").await;
        let worker = a.db.clone();
        a.db.call(move |c| apply_pending(c, &worker.sync))
            .await
            .unwrap();
        assert_eq!(
            a.value("SELECT CAST(count(*) AS TEXT) FROM user_booru_sites WHERE base_url = 'https://x.example'").await.as_deref(),
            Some("0")
        );
    }

    #[tokio::test]
    async fn a_site_added_by_hand_takes_the_preset_key_and_its_read_marks() {
        let (url, _) = serve().await;
        let a = Device::open(&url, &[]).await;
        a.sql(&format!("INSERT INTO user_booru_sites (id, user_id, name, engine, base_url, api_key, is_preset, preset_key, enabled, sort_order, created_at, updated_at)
            VALUES ('mine', '{OWNER_ID}', 'e621', 'e621', 'https://e621.net', 'kept-key', 0, NULL, 1, 0, {NOW}, {NOW});
            INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES
            ('site', '[\"E621\"]', '{{\"name\":\"e621\",\"engine\":\"e621\",\"baseUrl\":\"https://e621.net\",\"isPreset\":true,\"presetKey\":\"E621\",\"enabled\":true,\"sortOrder\":0}}', '2026-01-01T00:00:00.000Z', 0),
            ('read_post', '[\"E621\",\"123\"]', '{{\"readAt\":\"2026-01-01T00:00:00.000Z\"}}', '2026-01-01T00:00:00.000Z', 0);
            INSERT INTO favorite_items (user_id, provider, remote_id, file_path, created_at, updated_at) VALUES
            ('{OWNER_ID}', 'E621', '1', '/old/one.png', {NOW}, {NOW}),
            ('{OWNER_ID}', 'mine', '1', '/again/one.png', {NOW}, {NOW}),
            ('{OWNER_ID}', 'mine', '2', '/two.png', {NOW}, {NOW});")).await;
        let worker = a.db.clone();
        a.db.call(move |c| apply_pending(c, &worker.sync))
            .await
            .unwrap();
        assert_eq!(
            a.value("SELECT group_concat(id || ' ' || preset_key || ' ' || api_key) FROM user_booru_sites").await.as_deref(),
            Some("mine E621 kept-key")
        );
        assert_eq!(
            a.value("SELECT item_key FROM read_marks WHERE scope = 'post'")
                .await
                .as_deref(),
            Some("mine:123")
        );
        assert_eq!(
            a.value("SELECT group_concat(provider || ' ' || remote_id || ' ' || file_path, ', ') FROM (SELECT * FROM favorite_items ORDER BY remote_id)").await.as_deref(),
            Some("E621 1 /old/one.png, E621 2 /two.png"),
            "favorites saved under the site's own id move to the preset key, which a later sync looks them up by"
        );
    }

    #[tokio::test]
    async fn a_daily_backup_is_written_and_only_the_latest_fourteen_are_kept() {
        let (url, dav) = serve().await;
        {
            let mut files = dav.0.lock().unwrap();
            files.insert("/dav/GoonCave/".into(), (Vec::new(), 0));
            files.insert("/dav/GoonCave/backups/".into(), (Vec::new(), 0));
            for day in 1..=15 {
                files.insert(
                    format!("/dav/GoonCave/backups/2026-01-{day:02}.json.gz"),
                    (vec![1], 1),
                );
            }
        }
        let a = Device::open(&url, &[]).await;
        a.sync(Trigger::Full).await;
        let mut backups: Vec<String> = dav
            .files()
            .into_keys()
            .filter_map(|p| {
                p.strip_prefix("/dav/GoonCave/backups/")
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
            })
            .collect();
        backups.sort();
        assert_eq!(backups.len(), KEEP_BACKUPS);
        assert_eq!(backups[0], "2026-01-03.json.gz");
        assert_eq!(
            backups.last().unwrap(),
            &format!("{}.json.gz", &now()[..10])
        );
    }

    #[tokio::test]
    async fn a_damaged_or_newer_snapshot_is_refused_with_a_clear_error() {
        let damaged = read_backup(b"not gzip").err().unwrap().to_string();
        assert!(damaged.contains("damaged"), "{damaged}");
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(br#"{"format": 2, "records": []}"#)
            .unwrap();
        let error = read_backup(&encoder.finish().unwrap())
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("newer GoonCave"), "{error}");
        // A newer format may change the shape of its records; its version still decides.
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(br#"{"format": 2, "records": [{"kind": 7, "id": "x"}]}"#)
            .unwrap();
        let error = read_backup(&encoder.finish().unwrap())
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("newer GoonCave"), "{error}");
    }

    #[test]
    fn snapshot_data_keeps_its_text() {
        let data = r#"{"score":0.30000000000000004,"z":1}"#;
        let mut pack = Pack::new().unwrap();
        pack.push("tag", r#"["a"]"#, Some(data), "2026-01-01T00:00:00.000Z")
            .unwrap();
        let records = parse(&pack.finish().unwrap()).ok().unwrap();
        assert_eq!(records[0].data.as_deref(), Some(data));
        let mut pack = Pack::new().unwrap();
        pack.push("tag", r#"["a"]"#, Some("[1]"), "2026-01-01T00:00:00.000Z")
            .unwrap();
        assert!(matches!(
            parse(&pack.finish().unwrap()),
            Err(Unreadable::Damaged)
        ));
    }
}
