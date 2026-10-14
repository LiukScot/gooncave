//! Finds visual copies: files of one media type and size whose downscaled grayscale pixels
//! differ by at most `pixelThreshold`. The gallery stacks each group into one tile, and the
//! duplicate policy (`duplicate_policy`) resolves the groups.

use crate::{
    db::Database,
    library::iso_millis,
    media::{self, MediaKind},
    Error, Result,
};
use axum::{
    body::Bytes,
    extract::State,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;

const MAX_SIZE_NEIGHBOR_OFFSETS: usize = 12;
const SMALL_GROUP_FULL_COMPARE_LIMIT: usize = 120;
const SIGNATURE_CONCURRENCY: usize = 4;

#[derive(Clone, Debug)]
pub(crate) struct Options {
    pub media_type: Option<&'static str>,
    pub pixel_threshold: f64,
    pub sample_size: u32,
    pub video_frames: u32,
    pub max_comparisons: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            media_type: None,
            pixel_threshold: 0.005,
            sample_size: 96,
            video_frames: 3,
            max_comparisons: 2000,
        }
    }
}

impl Options {
    fn parse(body: &Value) -> Result<Self> {
        let invalid = || Error::Invalid("Invalid duplicate scan options.".into());
        let body = body.as_object().ok_or_else(invalid)?;
        let mut options = Self::default();
        if let Some(value) = body.get("mediaType") {
            options.media_type = match value.as_str() {
                Some("ALL") => None,
                Some("IMAGE") => Some("IMAGE"),
                Some("VIDEO") => Some("VIDEO"),
                _ => return Err(invalid()),
            };
        }
        if let Some(value) = body.get("pixelThreshold") {
            options.pixel_threshold = value
                .as_f64()
                .filter(|v| (0.0..=1.0).contains(v))
                .ok_or_else(invalid)?;
        }
        let integer = |key: &str, range: std::ops::RangeInclusive<u64>| -> Result<Option<u64>> {
            body.get(key)
                .map(|value| {
                    value
                        .as_u64()
                        .filter(|v| range.contains(v))
                        .ok_or_else(invalid)
                })
                .transpose()
        };
        if let Some(value) = integer("sampleSize", 8..=256)? {
            options.sample_size = value as u32;
        }
        if let Some(value) = integer("videoFrames", 1..=8)? {
            options.video_frames = value as u32;
        }
        if let Some(value) = integer("maxComparisons", 1..=100_000)? {
            options.max_comparisons = value;
        }
        Ok(options)
    }
}

/// One file of a candidate group, read with its folder so the original can be resolved.
#[derive(Clone)]
struct Candidate {
    id: String,
    folder: String,
    sha256: String,
    kind: MediaKind,
    size: i64,
    path: String,
    duration_ms: Option<i64>,
    summary: Value,
}

enum Signature {
    Image(Vec<u8>),
    Video(Vec<Vec<u8>>),
}

impl Signature {
    fn kind(&self) -> &'static str {
        match self {
            Self::Image(_) => "IMAGE",
            Self::Video(_) => "VIDEO",
        }
    }

    /// The reference layout: image pixels as they are; for a video a little-endian `u32` frame
    /// count, then each frame as a `u32` length and its pixels.
    fn encode(&self) -> Vec<u8> {
        match self {
            Self::Image(pixels) => pixels.clone(),
            Self::Video(frames) => {
                let mut data = (frames.len() as u32).to_le_bytes().to_vec();
                for frame in frames {
                    data.extend((frame.len() as u32).to_le_bytes());
                    data.extend(frame);
                }
                data
            }
        }
    }

    fn decode(kind: &str, data: &[u8]) -> Option<Self> {
        match kind {
            "IMAGE" => Some(Self::Image(data.to_vec())),
            "VIDEO" => {
                let read = |offset: usize| -> Option<usize> {
                    Some(
                        u32::from_le_bytes(data.get(offset..offset + 4)?.try_into().ok()?) as usize,
                    )
                };
                let count = read(0)?;
                let mut offset = 4;
                let mut frames = Vec::new();
                for _ in 0..count {
                    let length = read(offset)?;
                    offset += 4;
                    frames.push(data.get(offset..offset + length)?.to_vec());
                    offset += length;
                }
                Some(Self::Video(frames))
            }
            _ => None,
        }
    }
}

/// Mean absolute pixel difference from 0 (equal) to 1; buffers of different length never match.
fn difference(a: &[u8], b: &[u8]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 1.0;
    }
    let sum: u64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    sum as f64 / (a.len() as f64 * 255.0)
}

fn compare(a: &Signature, b: &Signature) -> f64 {
    match (a, b) {
        (Signature::Image(a), Signature::Image(b)) => difference(a, b),
        (Signature::Video(a), Signature::Video(b)) => {
            let frames = a.len().min(b.len());
            if frames == 0 {
                return 1.0;
            }
            a.iter().zip(b).map(|(x, y)| difference(x, y)).sum::<f64>() / frames as f64
        }
        _ => 1.0,
    }
}

/// Pairs to compare within one group: neighbours by file size first, then every pair of a small
/// group, stopping at `max_pairs`.
fn comparison_pairs(sizes: &[(i64, &str)], max_pairs: u64) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    if sizes.len() < 2 || max_pairs == 0 {
        return pairs;
    }
    let mut order: Vec<usize> = (0..sizes.len()).collect();
    order.sort_by(|a, b| sizes[*a].cmp(&sizes[*b]));
    let mut seen = HashSet::new();
    let mut push = |a: usize, b: usize, pairs: &mut Vec<(usize, usize)>| {
        let pair = (a.min(b), a.max(b));
        if a != b && seen.insert(pair) {
            pairs.push(pair);
        }
        pairs.len() as u64 >= max_pairs
    };
    for offset in 1..=MAX_SIZE_NEIGHBOR_OFFSETS {
        for i in 0..order.len().saturating_sub(offset) {
            if push(order[i], order[i + offset], &mut pairs) {
                return pairs;
            }
        }
    }
    if sizes.len() > SMALL_GROUP_FULL_COMPARE_LIMIT {
        return pairs;
    }
    for i in 0..sizes.len() {
        for j in i + 1..sizes.len() {
            if push(i, j, &mut pairs) {
                return pairs;
            }
        }
    }
    pairs
}

fn find_root(parent: &mut [usize], x: usize) -> usize {
    let mut root = x;
    while parent[root] != root {
        root = parent[root];
    }
    let mut node = x;
    while parent[node] != root {
        node = std::mem::replace(&mut parent[node], root);
    }
    root
}

async fn build_signature(db: &Database, file: &Candidate, options: &Options) -> Option<Signature> {
    let path = db
        .library()
        .resolve_file(Path::new(&file.folder), Path::new(&file.path))
        .ok()?;
    let size = options.sample_size;
    match file.kind {
        MediaKind::Image => media::signature_frame(&path, MediaKind::Image, size, None)
            .await
            .ok()
            .map(Signature::Image),
        MediaKind::Video => {
            let seconds = file.duration_ms.unwrap_or(0) as f64 / 1000.0;
            let count = options.video_frames.max(1);
            let stamps: Vec<f64> = if seconds > 0.0 {
                (1..=count)
                    .map(|i| seconds * f64::from(i) / f64::from(count + 1))
                    .collect()
            } else {
                vec![1.0]
            };
            let mut frames = Vec::new();
            for stamp in stamps {
                // A stamp past the last frame yields nothing; the others still make a signature.
                if let Ok(frame) =
                    media::signature_frame(&path, MediaKind::Video, size, Some(stamp)).await
                {
                    frames.push(frame);
                }
            }
            (!frames.is_empty()).then_some(Signature::Video(frames))
        }
    }
}

fn progress(
    phase: &str,
    processed: usize,
    total: i64,
    comparisons: u64,
    groups: usize,
    skipped: usize,
    message: String,
) -> Value {
    json!({"phase":phase,"processed":processed,"total":total,"comparisons":comparisons,"groups":groups,"skippedNoSignature":skipped,"message":message})
}

/// Scans the active library. `report` receives progress; `cancel` stops between files.
pub(crate) async fn find(
    db: &Database,
    options: &Options,
    report: impl Fn(Value),
    cancel: &AtomicBool,
) -> Result<Value> {
    let media_type = options.media_type;
    let (total_files, eligible_files, size_groups) = db
        .call(move |c| {
            let media = if media_type.is_some() { " AND f.media_type = ?1" } else { "" };
            let eligible = format!("f.folder_id IN (SELECT id FROM library_folders){media}
                AND f.width IS NOT NULL AND f.width != 0 AND f.height IS NOT NULL AND f.height != 0 AND f.size_bytes > 0");
            let total: i64 = c.query_row("SELECT COUNT(*) FROM files f WHERE f.folder_id IN (SELECT id FROM library_folders)", [], |r| r.get(0))?;
            let params = rusqlite::params_from_iter(media_type);
            let count: i64 = c.query_row(&format!("SELECT COUNT(*) FROM files f WHERE {eligible}"), params, |r| r.get(0))?;
            let mut statement = c.prepare(&format!(
                "SELECT f.media_type, f.width, f.height FROM files f WHERE {eligible}
                 GROUP BY f.media_type, f.width, f.height HAVING COUNT(*) >= 2 ORDER BY f.media_type, f.width, f.height"))?;
            let groups = statement
                .query_map(rusqlite::params_from_iter(media_type), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((total, count, groups))
        })
        .await?;

    let mut groups: Vec<Value> = Vec::new();
    let (mut comparisons, mut compared_files, mut skipped) = (0u64, 0usize, 0usize);
    report(progress(
        "preparing",
        0,
        eligible_files,
        0,
        0,
        0,
        format!(
            "Found {eligible_files} eligible files in {} size groups",
            size_groups.len()
        ),
    ));

    for (index, (kind, width, height)) in size_groups.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) || comparisons >= options.max_comparisons {
            break;
        }
        let key = format!("{kind}:{width}x{height}");
        let (kind, width, height, sample) = (kind.clone(), *width, *height, options.sample_size);
        let (files, cached) = db
            .call(move |c| {
                let mut statement = c.prepare(
                    "SELECT f.*, folders.path AS folder_path,
                       (SELECT json_group_array(provider) FROM favorite_items fav WHERE fav.user_id = folders.user_id AND fav.file_path = f.path) AS favorite_providers
                     FROM files f JOIN library_folders folders ON folders.id = f.folder_id
                     WHERE f.media_type = ?1 AND f.width = ?2 AND f.height = ?3 AND f.size_bytes > 0
                     ORDER BY f.size_bytes, f.path")?;
                let mut files = statement
                    .query_map(params![kind, width, height], |row| {
                        let thumb: Option<String> = row.get("thumb_path")?;
                        let summary = json!({
                            "id": row.get::<_, String>("id")?, "folderId": row.get::<_, String>("folder_id")?,
                            "path": row.get::<_, String>("path")?, "mtime": row.get::<_, String>("mtime")?,
                            "mediaType": row.get::<_, String>("media_type")?, "sizeBytes": row.get::<_, i64>("size_bytes")?,
                            "width": row.get::<_, Option<i64>>("width")?, "height": row.get::<_, Option<i64>>("height")?,
                            "durationMs": row.get::<_, Option<i64>>("duration_ms")?,
                            "thumbUrl": thumb.as_deref().and_then(|t| Path::new(t).file_name()).map(|n| format!("/thumbnails/{}", n.to_string_lossy())),
                            "favoriteProviders": serde_json::from_str::<Value>(&row.get::<_, String>("favorite_providers")?)
                                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
                        });
                        Ok(Candidate {
                            id: row.get("id")?,
                            folder: row.get("folder_path")?,
                            sha256: row.get("sha256")?,
                            kind: if row.get::<_, String>("media_type")? == "VIDEO" { MediaKind::Video } else { MediaKind::Image },
                            size: row.get("size_bytes")?,
                            path: row.get("path")?,
                            duration_ms: row.get("duration_ms")?,
                            summary,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut cached = HashMap::new();
                let mut lookup = c.prepare("SELECT kind, data, source_hash FROM file_signatures WHERE file_id = ?1 AND sample_size = ?2")?;
                for file in &files {
                    if let Some((kind, data, hash)) = lookup
                        .query_row(params![file.id, sample], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, String>(2)?)))
                        .optional()?
                    {
                        if hash == file.sha256 {
                            if let Some(signature) = Signature::decode(&kind, &data) {
                                cached.insert(file.id.clone(), signature);
                            }
                        }
                    }
                }
                let mut summaries: Vec<Value> = files.iter().map(|f| f.summary.clone()).collect();
                crate::source_store::attach_runs(c, &mut summaries)?;
                for (file, summary) in files.iter_mut().zip(summaries) {
                    file.summary = summary;
                }
                Ok((files, cached))
            })
            .await?;
        let mut signatures = cached;
        let missing: Vec<Candidate> = files
            .iter()
            .filter(|f| !signatures.contains_key(&f.id))
            .cloned()
            .collect();
        report(progress(
            "signature",
            compared_files,
            eligible_files,
            comparisons,
            groups.len(),
            skipped,
            format!(
                "Group {}/{}: {} cached, computing {} signatures",
                index + 1,
                size_groups.len(),
                signatures.len(),
                missing.len()
            ),
        ));
        let mut built = futures_util::stream::iter(missing)
            .map(|file| async move {
                let signature = if cancel.load(Ordering::Relaxed) {
                    None
                } else {
                    build_signature(db, &file, options).await
                };
                (file, signature)
            })
            .buffer_unordered(SIGNATURE_CONCURRENCY);
        let mut fresh = Vec::new();
        while let Some((file, signature)) = built.next().await {
            let Some(signature) = signature else {
                if !cancel.load(Ordering::Relaxed) {
                    skipped += 1;
                }
                continue;
            };
            fresh.push((
                file.id.clone(),
                file.sha256.clone(),
                signature.kind(),
                signature.encode(),
            ));
            signatures.insert(file.id, signature);
        }
        drop(built);
        if !fresh.is_empty() {
            db.call(move |c| {
                let transaction = c.transaction()?;
                {
                    let mut insert = transaction.prepare(
                        "INSERT INTO file_signatures (file_id, kind, sample_size, data, source_hash) VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(file_id) DO UPDATE SET kind = excluded.kind, sample_size = excluded.sample_size, data = excluded.data,
                           source_hash = excluded.source_hash, created_at = datetime('now')",
                    )?;
                    for (id, hash, kind, data) in &fresh {
                        insert.execute(params![id, kind, sample, data, hash])?;
                    }
                }
                transaction.commit()?;
                Ok(())
            })
            .await?;
        }
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let candidates: Vec<&Candidate> = files
            .iter()
            .filter(|f| signatures.contains_key(&f.id))
            .collect();
        if candidates.len() < 2 {
            continue;
        }
        let remaining = options.max_comparisons - comparisons;
        let budget = (remaining / (size_groups.len() - index) as u64).max(1);
        let sizes: Vec<(i64, &str)> = candidates
            .iter()
            .map(|f| (f.size, f.path.as_str()))
            .collect();
        let pairs = comparison_pairs(&sizes, budget);
        if pairs.is_empty() {
            continue;
        }
        compared_files += candidates.len();
        report(progress(
            "comparing",
            compared_files,
            eligible_files,
            comparisons,
            groups.len(),
            skipped,
            format!(
                "Group {}/{}: comparing {} files",
                index + 1,
                size_groups.len(),
                candidates.len()
            ),
        ));
        let mut parent: Vec<usize> = (0..candidates.len()).collect();
        for (i, j) in pairs {
            if comparisons >= options.max_comparisons {
                break;
            }
            comparisons += 1;
            if compare(
                &signatures[&candidates[i].id],
                &signatures[&candidates[j].id],
            ) <= options.pixel_threshold
            {
                let (a, b) = (find_root(&mut parent, i), find_root(&mut parent, j));
                parent[b] = a;
            }
        }
        let mut buckets: Vec<(usize, Vec<Value>)> = Vec::new();
        for (i, file) in candidates.iter().enumerate() {
            let root = find_root(&mut parent, i);
            match buckets.iter_mut().find(|(r, _)| *r == root) {
                Some((_, bucket)) => bucket.push(file.summary.clone()),
                None => buckets.push((root, vec![file.summary.clone()])),
            }
        }
        for (_, bucket) in buckets.into_iter().filter(|(_, b)| b.len() >= 2) {
            groups.push(json!({"key": key, "files": bucket}));
        }
    }

    Ok(json!({
        "groups": groups,
        "stats": {"totalFiles": total_files, "eligibleFiles": eligible_files, "comparedFiles": compared_files,
            "comparisons": comparisons, "skippedNoSignature": skipped, "pixelThreshold": options.pixel_threshold}
    }))
}

pub(crate) struct Job {
    state: std::sync::Mutex<Value>,
    cancel: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    start: Mutex<()>,
}

impl Default for Job {
    fn default() -> Self {
        Self {
            state: std::sync::Mutex::new(
                json!({"status":"idle","startedAt":null,"updatedAt":now(),
                "progress":null,"result":null,"error":null}),
            ),
            cancel: std::sync::Mutex::new(None),
            start: Mutex::new(()),
        }
    }
}

fn now() -> String {
    iso_millis(std::time::SystemTime::now())
}

impl Job {
    fn snapshot(&self) -> Value {
        self.state
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    fn update(&self, patch: Value) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        for (key, value) in patch.as_object().into_iter().flatten() {
            state[key] = value.clone();
        }
        state["updatedAt"] = json!(now());
    }
}

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/duplicates/scan/start", post(start))
        .route("/duplicates/scan/status", get(status))
        .route("/duplicates/scan/cancel", post(cancel))
}

async fn start(State(db): State<Database>, body: Bytes) -> Result<Json<Value>> {
    let body = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| Error::Invalid("Invalid duplicate scan options.".into()))?
    };
    let options = Options::parse(&body)?;
    let _guard = db.duplicates.start.lock().await;
    if db.duplicates.snapshot()["status"] == "running" {
        return Ok(Json(
            json!({"status":"busy","state":db.duplicates.snapshot()}),
        ));
    }
    let flag = Arc::new(AtomicBool::new(false));
    *db.duplicates
        .cancel
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(flag.clone());
    db.duplicates.update(
        json!({"status":"running","startedAt":now(),"result":null,"error":null,
        "progress":progress("preparing",0,0,0,0,0,"Preparing duplicate scan".into())}),
    );
    let worker = db.clone();
    tokio::spawn(async move {
        let job = worker.duplicates.clone();
        let result = find(
            &worker,
            &options,
            |p| job.update(json!({"progress": p})),
            &flag,
        )
        .await;
        // Cleared while the status still says running, so no newer scan has stored its flag yet.
        *job.cancel.lock().unwrap_or_else(|p| p.into_inner()) = None;
        match result {
            _ if flag.load(Ordering::Relaxed) => {
                job.update(json!({"status":"error","error":"Scan cancelled","result":null}))
            }
            Ok(result) => job.update(json!({"status":"done","result":result,"error":null})),
            Err(error) => {
                eprintln!("Duplicate scan failed: {error}");
                job.update(json!({"status":"error","error":error.to_string(),"result":null}));
            }
        }
    });
    Ok(Json(
        json!({"status":"started","state":db.duplicates.snapshot()}),
    ))
}

async fn status(State(db): State<Database>) -> Json<Value> {
    Json(db.duplicates.snapshot())
}

async fn cancel(State(db): State<Database>) -> Json<Value> {
    match db
        .duplicates
        .cancel
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
    {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Json(json!({"status":"cancelled"}))
        }
        None => Json(json!({"status":"idle"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_signatures_survive_the_cache_round_trip() {
        let signature = Signature::Video(vec![vec![1, 2, 3], vec![9]]);
        let decoded = Signature::decode("VIDEO", &signature.encode()).unwrap();
        assert_eq!(compare(&signature, &decoded), 0.0);
        let Signature::Video(frames) = decoded else {
            panic!("decoded as an image")
        };
        assert_eq!(frames, vec![vec![1, 2, 3], vec![9]]);
        assert!(Signature::decode("VIDEO", &[2, 0, 0, 0, 5, 0, 0, 0, 1]).is_none());
    }

    #[test]
    fn signatures_of_different_kinds_or_lengths_never_match() {
        assert_eq!(
            compare(
                &Signature::Image(vec![0; 4]),
                &Signature::Video(vec![vec![0; 4]])
            ),
            1.0
        );
        assert_eq!(difference(&[0, 0], &[0, 0, 0]), 1.0);
        assert_eq!(difference(&[0, 255], &[255, 255]), 0.5);
    }

    #[test]
    fn comparison_pairs_cover_small_groups_and_respect_the_budget() {
        let sizes: Vec<(i64, &str)> = (0..20).map(|i| (i, "f")).collect();
        let all = comparison_pairs(&sizes, u64::MAX);
        assert_eq!(all.len(), 20 * 19 / 2);
        assert_eq!(all.iter().collect::<HashSet<_>>().len(), all.len());
        assert_eq!(comparison_pairs(&sizes, 5).len(), 5);
        assert!(comparison_pairs(&sizes[..1], 10).is_empty());
    }

    #[test]
    fn scan_options_are_validated() {
        assert!(Options::parse(&json!({"pixelThreshold": 2})).is_err());
        assert!(Options::parse(&json!({"mediaType": "AUDIO"})).is_err());
        assert!(Options::parse(&json!({"maxComparisons": 0})).is_err());
        let options = Options::parse(&json!({"mediaType": "VIDEO", "sampleSize": 32})).unwrap();
        assert_eq!(
            (options.media_type, options.sample_size),
            (Some("VIDEO"), 32)
        );
    }
}
