//! Finds visual copies: files of one media type and shape whose downscaled grayscale pixels
//! differ by at most `pixelThreshold`, or, at different sizes, as little as a site's preview
//! differs from its file. The gallery stacks each group into one tile, and the
//! duplicate policy (`duplicate_policy`) resolves the groups.

use crate::{
    db::Database,
    gallery_matches,
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
use rusqlite::{params, Connection, OptionalExtension};
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
/// Average hashes of one picture at two sizes stay within a few bits; checked against the
/// signatures afterwards, so this only picks which pairs to compare first.
const MAX_NEAR_HASH_DISTANCE: u32 = 6;
const SMALL_GROUP_FULL_COMPARE_LIMIT: usize = 120;
const SIGNATURE_CONCURRENCY: usize = 4;
/// Two encodings of one picture stay within a few levels of gray per sample; an edit moves the
/// samples it touches by far more. 10 levels of 255.
const MAX_SAMPLE_DIFFERENCE: f64 = 10.0 / 255.0;

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
            pixel_threshold: 0.0005,
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
    width: i64,
    height: i64,
    phash: Option<String>,
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
pub(crate) fn difference(a: &[u8], b: &[u8]) -> f64 {
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

/// Largest absolute difference of any single sample, from 0 (equal) to 1. The mean hides a local
/// edit: a retouch that fills a few samples of a 96x96 grid moves the mean by far less than the
/// noise between two encodings of one picture, and moves its own samples by a lot.
pub(crate) fn largest_difference(a: &[u8], b: &[u8]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 1.0;
    }
    let peak = a
        .iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0);
    f64::from(peak) / 255.0
}

/// Side of the block that [`largest_block_difference`] averages.
const BLOCK: usize = 4;

/// [`largest_difference`] after averaging the signed differences over BLOCK x BLOCK blocks of the
/// square grid. A small preview is blurred and resampled, so single samples of the same picture
/// stray by tens of levels along edges; a retouch fills a whole block and still stands out.
pub(crate) fn largest_block_difference(a: &[u8], b: &[u8]) -> f64 {
    let side = (a.len() as f64).sqrt() as usize;
    if a.len() != b.len() || side * side != a.len() || side < BLOCK {
        return largest_difference(a, b);
    }
    let diff = |x: usize, y: usize| i32::from(a[y * side + x]) - i32::from(b[y * side + x]);
    let mut peak = 0;
    for top in 0..=side - BLOCK {
        for left in 0..=side - BLOCK {
            let sum: i32 = (top..top + BLOCK)
                .flat_map(|y| (left..left + BLOCK).map(move |x| (x, y)))
                .map(|(x, y)| diff(x, y))
                .sum();
            peak = peak.max(sum.unsigned_abs() as usize / (BLOCK * BLOCK));
        }
    }
    peak as f64 / 255.0
}

fn largest(a: &Signature, b: &Signature) -> f64 {
    match (a, b) {
        (Signature::Image(a), Signature::Image(b)) => largest_difference(a, b),
        (Signature::Video(a), Signature::Video(b)) if !a.is_empty() && !b.is_empty() => a
            .iter()
            .zip(b)
            .map(|(x, y)| largest_difference(x, y))
            .fold(0.0, f64::max),
        _ => 1.0,
    }
}

/// Whether two signatures are one picture: close on average and with no sample far off.
fn same_picture(a: &Signature, b: &Signature, threshold: f64) -> bool {
    compare(a, b) <= threshold && largest(a, b) <= MAX_SAMPLE_DIFFERENCE
}

/// [`same_picture`] for two sizes of one picture, where scaling blurs every sample a little.
fn same_rescaled_picture(a: &Signature, b: &Signature) -> bool {
    match (a, b) {
        (Signature::Image(a), Signature::Image(b)) => gallery_matches::same_picture(a, b),
        (Signature::Video(a), Signature::Video(b)) => {
            !a.is_empty()
                && a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|(x, y)| gallery_matches::same_picture(x, y))
        }
        _ => false,
    }
}

/// Sizes of one media type, each with its file count, joined while each shape is within
/// [`gallery_matches::MAX_RATIO_DIFFERENCE`] of the previous one, so copies at other resolutions
/// meet. Only groups with two files or more.
fn shape_groups(mut sizes: Vec<(String, i64, i64, i64)>) -> Vec<(String, Vec<(i64, i64)>)> {
    let ratio = |w: i64, h: i64| w as f64 / h as f64;
    sizes.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(ratio(a.1, a.2).total_cmp(&ratio(b.1, b.2)))
    });
    // Kind, the shapes joined so far, and how many files they hold.
    type Group = (String, Vec<(i64, i64)>, i64);
    let mut groups: Vec<Group> = Vec::new();
    for (kind, width, height, count) in sizes {
        match groups.last_mut() {
            Some((last, members, total))
                if *last == kind
                    && members.last().is_some_and(|(w, h)| {
                        (ratio(width, height) / ratio(*w, *h) - 1.0).abs()
                            <= gallery_matches::MAX_RATIO_DIFFERENCE
                    }) =>
            {
                members.push((width, height));
                *total += count;
            }
            _ => groups.push((kind, vec![(width, height)], count)),
        }
    }
    groups
        .into_iter()
        .filter(|(.., total)| *total >= 2)
        .map(|(kind, members, _)| (kind, members))
        .collect()
}

/// Pairs whose average hashes are close: copies at other sizes, which file size does not bring
/// together.
fn near_hash_pairs(hashes: &[Option<u64>]) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for i in 0..hashes.len() {
        for j in i + 1..hashes.len() {
            if let (Some(a), Some(b)) = (hashes[i], hashes[j]) {
                if (a ^ b).count_ones() <= MAX_NEAR_HASH_DISTANCE {
                    pairs.push((i, j));
                }
            }
        }
    }
    pairs
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

/// Changes when a library file is added, removed, gets its size or changes in place, so a
/// finished scan can tell that it no longer covers the library. Taken before a scan reads the
/// files.
fn library_stamp(c: &Connection) -> rusqlite::Result<String> {
    c.query_row(
        "SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(MAX(f.updated_at), '') FROM files f
         WHERE f.folder_id IN (SELECT id FROM library_folders) AND f.location_type = 'LOCAL'
           AND f.width > 0 AND f.height > 0",
        [],
        |r| r.get(0),
    )
}

/// Scans the active library. `report` receives progress; `cancel` stops between files.
pub(crate) async fn find(
    db: &Database,
    options: &Options,
    report: impl Fn(Value),
    cancel: &AtomicBool,
) -> Result<Value> {
    let media_type = options.media_type;
    let (stamp, total_files, eligible_files, size_groups) = db
        .call(move |c| {
            let stamp = library_stamp(c)?;
            let media = if media_type.is_some() { " AND f.media_type = ?1" } else { "" };
            let eligible = format!("f.folder_id IN (SELECT id FROM library_folders) AND f.location_type = 'LOCAL'{media}
                AND f.width IS NOT NULL AND f.width != 0 AND f.height IS NOT NULL AND f.height != 0 AND f.size_bytes > 0");
            let total: i64 = c.query_row("SELECT COUNT(*) FROM files f WHERE f.folder_id IN (SELECT id FROM library_folders)", [], |r| r.get(0))?;
            let params = rusqlite::params_from_iter(media_type);
            let count: i64 = c.query_row(&format!("SELECT COUNT(*) FROM files f WHERE {eligible}"), params, |r| r.get(0))?;
            let mut statement = c.prepare(&format!(
                "SELECT f.media_type, f.width, f.height, COUNT(*) FROM files f WHERE {eligible}
                 GROUP BY f.media_type, f.width, f.height"))?;
            let sizes = statement
                .query_map(rusqlite::params_from_iter(media_type), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((stamp, total, count, shape_groups(sizes)))
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

    for (index, (kind, members)) in size_groups.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) || comparisons >= options.max_comparisons {
            break;
        }
        let key = format!("{kind}:{}x{}", members[0].0, members[0].1);
        let shapes = json!(members
            .iter()
            .map(|(w, h)| format!("{w}x{h}"))
            .collect::<Vec<_>>())
        .to_string();
        let (kind, sample) = (kind.clone(), options.sample_size);
        let (files, cached) = db
            .call(move |c| {
                let mut statement = c.prepare(
                    "SELECT f.*, folders.path AS folder_path,
                       (SELECT json_group_array(provider) FROM favorite_items fav WHERE fav.user_id = folders.user_id AND fav.file_path = f.path) AS favorite_providers
                     FROM files f JOIN library_folders folders ON folders.id = f.folder_id
                     WHERE f.media_type = ?1 AND f.width || 'x' || f.height IN (SELECT value FROM json_each(?2))
                       AND f.size_bytes > 0 AND f.location_type = 'LOCAL'
                     ORDER BY f.size_bytes, f.path")?;
                let mut files = statement
                    .query_map(params![kind, shapes], |row| {
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
                            width: row.get("width")?,
                            height: row.get("height")?,
                            phash: row.get("phash")?,
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
        let hashes: Vec<Option<u64>> = candidates
            .iter()
            .map(|f| f.phash.as_deref().and_then(gallery_matches::parse_hash))
            .collect();
        let mut pairs = near_hash_pairs(&hashes);
        pairs.truncate(budget as usize);
        let compared: HashSet<(usize, usize)> = pairs.iter().copied().collect();
        pairs.extend(
            comparison_pairs(&sizes, budget - pairs.len() as u64)
                .into_iter()
                .filter(|pair| !compared.contains(pair)),
        );
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
            let (a, b) = (candidates[i], candidates[j]);
            let (left, right) = (&signatures[&a.id], &signatures[&b.id]);
            // A shape group chains sizes, so its ends can be further apart than one step.
            let ratio = (a.width as f64 / a.height as f64) / (b.width as f64 / b.height as f64);
            let same = if (a.width, a.height) == (b.width, b.height) {
                same_picture(left, right, options.pixel_threshold)
            } else {
                (ratio - 1.0).abs() <= gallery_matches::MAX_RATIO_DIFFERENCE
                    && same_rescaled_picture(left, right)
            };
            if same {
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
        // One shape group holds many sets of copies, and the duplicate policy acts on each key as
        // one set, so a set's key names its first file too.
        for (_, bucket) in buckets.into_iter().filter(|(_, b)| b.len() >= 2) {
            let first = bucket[0]["id"].as_str().unwrap_or_default();
            groups.push(json!({"key": format!("{key}:{first}"), "files": bucket}));
        }
    }

    Ok(json!({
        "groups": groups,
        "libraryStamp": stamp,
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
    pub(crate) fn snapshot(&self) -> Value {
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
        // The last result stays until this one replaces it, so the gallery keeps its stacks meanwhile.
        json!({"status":"running","startedAt":now(),"error":null,
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
                job.update(json!({"status":"error","error":"Scan cancelled"}))
            }
            Ok(result) => job.update(json!({"status":"done","result":result,"error":null})),
            Err(error) => {
                eprintln!("Duplicate scan failed: {error}");
                job.update(json!({"status":"error","error":error.to_string()}));
            }
        }
    });
    Ok(Json(
        json!({"status":"started","state":db.duplicates.snapshot()}),
    ))
}

/// A finished scan says `stale` once the library changed after it started, so the gallery can
/// start a new one instead of leaving later copies unstacked. Only then: a running scan is
/// polled often, and the gallery waits for it anyway.
async fn status(State(db): State<Database>) -> Result<Json<Value>> {
    let mut state = db.duplicates.snapshot();
    if state["status"] == "done" {
        let stamp = db.call(|c| Ok(library_stamp(c)?)).await?;
        state["stale"] = json!(state["result"]["libraryStamp"] != stamp.as_str());
    }
    Ok(Json(state))
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
    use crate::{db::OWNER_ID, library::NOW};

    #[tokio::test]
    async fn copies_at_another_resolution_are_one_group_and_another_picture_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let root = db.library().root.clone();
        let ffmpeg = |args: &[&str], name: &str| {
            let status = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-y"])
                .args(args)
                .args(["-frames:v", "1"])
                .arg(root.join(name))
                .status()
                .unwrap();
            assert!(status.success());
        };
        ffmpeg(&["-f", "lavfi", "-i", "testsrc=s=640x480"], "large.jpg");
        // The small copy is the large one scaled down, as a site's lower resolution is.
        let large = root.join("large.jpg").to_string_lossy().into_owned();
        ffmpeg(&["-i", &large, "-vf", "scale=160:120"], "small.png");
        ffmpeg(&["-f", "lavfi", "-i", "smptebars=s=640x480"], "other.png");
        crate::library::scan(&db).await.unwrap();
        let result = find(&db, &Options::default(), |_| {}, &AtomicBool::new(false))
            .await
            .unwrap();
        let groups = result["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1, "{groups:?}");
        let mut names: Vec<&str> = groups[0]["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap().rsplit('/').next().unwrap())
            .collect();
        names.sort_unstable();
        assert_eq!(names, ["large.jpg", "small.png"]);
    }

    #[tokio::test]
    async fn two_sets_of_copies_with_one_shape_are_two_groups() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let root = db.library().root.clone();
        let ffmpeg = |args: &[&str], name: &str| {
            let status = std::process::Command::new("ffmpeg")
                .args(["-v", "error", "-y"])
                .args(args)
                .args(["-frames:v", "1"])
                .arg(root.join(name))
                .status()
                .unwrap();
            assert!(status.success());
        };
        for (source, name) in [("testsrc", "test"), ("smptebars", "bars")] {
            ffmpeg(
                &["-f", "lavfi", "-i", &format!("{source}=s=640x480")],
                &format!("{name}-large.jpg"),
            );
            let large = root
                .join(format!("{name}-large.jpg"))
                .to_string_lossy()
                .into_owned();
            ffmpeg(
                &["-i", &large, "-vf", "scale=160:120"],
                &format!("{name}-small.png"),
            );
        }
        crate::library::scan(&db).await.unwrap();
        let result = find(&db, &Options::default(), |_| {}, &AtomicBool::new(false))
            .await
            .unwrap();
        let groups = result["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2, "{groups:?}");
        // The duplicate policy treats one key as one group: a failure in one set would stop
        // the clean-up of the other, and its kept file would stand for both.
        assert_ne!(groups[0]["key"], groups[1]["key"]);
    }

    #[test]
    fn shapes_within_three_percent_join_and_others_stay_apart() {
        let groups = shape_groups(vec![
            ("IMAGE".into(), 1280, 940, 1),
            ("IMAGE".into(), 3103, 2279, 1),
            ("IMAGE".into(), 1000, 1000, 1),
            ("VIDEO".into(), 1280, 940, 1),
        ]);
        assert_eq!(
            groups,
            [("IMAGE".to_string(), vec![(3103, 2279), (1280, 940)])]
        );
    }

    #[tokio::test]
    async fn a_finished_scan_turns_stale_when_a_copy_arrives_later() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let add = |id: &'static str| {
            db.call(move |c| {
                c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,width,height,created_at,updated_at) VALUES (?1,'folder','LOCAL',?2,1,{NOW},?1,'IMAGE',10,10,{NOW},{NOW})"), params![id, format!("/fixture/{id}.png")])?;
                Ok(())
            })
        };
        db.call(|c| {
            c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,'/fixture','LOCAL','IDLE',{NOW},{NOW})"), [OWNER_ID])?;
            c.execute("INSERT INTO active_library_folders (id) VALUES ('folder')", [])?;
            Ok(())
        })
        .await
        .unwrap();
        add("first").await.unwrap();
        let result = find(&db, &Options::default(), |_| {}, &AtomicBool::new(false))
            .await
            .unwrap();
        db.duplicates
            .update(json!({"status": "done", "result": result}));
        assert_eq!(status(State(db.clone())).await.unwrap().0["stale"], false);

        add("copy").await.unwrap();
        let state = status(State(db.clone())).await.unwrap().0;
        assert_eq!(state["stale"], true);
        assert!(
            state["result"]["groups"].is_array(),
            "the old result stays usable meanwhile"
        );
    }

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
    fn default_threshold_keeps_a_small_edit_apart() {
        let threshold = Options::default().pixel_threshold;
        let original = vec![100u8; 1000];
        let mut edited = original.clone();
        // a retouch: mean difference 0.002, well above an identical picture's 0
        edited[..10].fill(150);
        assert!(difference(&original, &edited) > threshold);
        assert!(difference(&original, &original) <= threshold);
    }

    #[test]
    fn a_local_edit_is_kept_apart_though_its_mean_difference_is_tiny() {
        let threshold = Options::default().pixel_threshold;
        let original = Signature::Image(vec![100u8; 9216]);
        let mut edited = vec![100u8; 9216];
        // one sample of a 96x96 grid: mean difference 0.00002, far below the threshold
        edited[500] = 160;
        let edited = Signature::Image(edited);
        assert!(compare(&original, &edited) <= threshold);
        assert!(!same_picture(&original, &edited, threshold));
    }

    #[test]
    fn block_difference_ignores_scattered_preview_noise_but_not_a_retouched_patch() {
        let original = vec![100u8; 9216];
        // every seventh sample is far off, as along the edges of a blurred preview
        let scattered: Vec<u8> = (0..9216)
            .map(|i| if i % 7 == 0 { 142 } else { 100 })
            .collect();
        assert!(largest_difference(&original, &scattered) > 24.0 / 255.0);
        assert!(largest_block_difference(&original, &scattered) < 24.0 / 255.0);
        let mut retouched = original.clone();
        for y in 40..46 {
            retouched[y * 96 + 40..y * 96 + 46].fill(200);
        }
        assert!(largest_block_difference(&original, &retouched) > 24.0 / 255.0);
    }

    #[test]
    fn encoding_noise_is_still_one_picture() {
        let threshold = Options::default().pixel_threshold;
        let original = Signature::Image(vec![100u8; 9216]);
        // one sample in ten is a level off: a re-encode, not an edit
        let noisy = Signature::Image(
            (0..9216)
                .map(|i| if i % 10 == 0 { 101 } else { 100 })
                .collect(),
        );
        assert!(same_picture(&original, &noisy, threshold));
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
