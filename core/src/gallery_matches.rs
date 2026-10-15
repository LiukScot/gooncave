//! Which Explore posts are already favorites in the library, so "Keep every favorite" can mark
//! them without downloading the post again.

use crate::{
    booru_engines,
    booru_http::{self, Transport},
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    duplicate_policy, duplicates, explore,
    media::{self, MediaKind},
    Error, Result,
};
use axum::{body::Bytes, extract::State, http::header, Json};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::io::AsyncWriteExt;

const MAX_POSTS: usize = 100;
const MATCH_CONCURRENCY: usize = 4;
const FINGERPRINT_PAGE_SIZE: usize = 500;
const MAX_HASH_DISTANCE: u32 = 2;
const MAX_RATIO_DIFFERENCE: f64 = 0.03;
const MAX_PIXEL_DIFFERENCE: f64 = 0.01;
const SIGNATURE_SIZE: u32 = 96;
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const SKIPPED_EXTENSIONS: [&str; 5] = ["gif", "mp4", "webm", "m4v", "mov"];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Post {
    key: String,
    match_preview_url: String,
    width: Option<i64>,
    height: Option<i64>,
    file_ext: Option<String>,
}

#[derive(serde::Deserialize)]
struct Request {
    posts: Vec<Post>,
}

impl Post {
    fn valid(&self) -> bool {
        (1..=200).contains(&self.key.chars().count())
            && (1..=5000).contains(&self.match_preview_url.chars().count())
            && self.width.is_none_or(|w| w > 0)
            && self.height.is_none_or(|h| h > 0)
            && self
                .file_ext
                .as_ref()
                .is_none_or(|e| e.chars().count() <= 20)
    }
}

pub(crate) async fn route(State(db): State<Database>, body: Bytes) -> Result<Json<Value>> {
    let request = serde_json::from_slice::<Request>(&body)
        .ok()
        .filter(|r| r.posts.len() <= MAX_POSTS && r.posts.iter().all(Post::valid))
        .ok_or_else(|| Error::Invalid("Invalid gallery match request".into()))?;
    let keys = matching_keys(&db, &Transport::default(), request.posts).await?;
    Ok(Json(json!({ "keys": keys })))
}

struct Fingerprint {
    id: String,
    folder: String,
    path: String,
    thumb: Option<String>,
    phash: String,
    width: i64,
    height: i64,
}

struct Remote {
    key: String,
    width: i64,
    height: i64,
    hash: String,
    /// `None` when the picture cannot be sampled; such a post never matches.
    signature: Option<Vec<u8>>,
}

fn hash_distance(left: &str, right: &str) -> u32 {
    let parse = |s: &str| {
        (s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| u64::from_str_radix(s, 16).ok())
            .flatten()
    };
    match (parse(left), parse(right)) {
        (Some(a), Some(b)) => (a ^ b).count_ones(),
        _ => u32::MAX,
    }
}

fn plausible(remote: &Remote, local: &Fingerprint) -> bool {
    let ratio =
        (remote.width as f64 / remote.height as f64) / (local.width as f64 / local.height as f64);
    (ratio - 1.0).abs() <= MAX_RATIO_DIFFERENCE
        && hash_distance(&remote.hash, &local.phash) <= MAX_HASH_DISTANCE
}

async fn fingerprints(db: &Database, after: Option<String>) -> Result<Vec<Fingerprint>> {
    db.call(move |c| {
        let mut statement = c.prepare(
            "SELECT DISTINCT f.id, folders.path, f.path, f.thumb_path, f.phash, f.width, f.height
             FROM files f
             JOIN library_folders folders ON folders.id = f.folder_id
             JOIN favorite_items fav ON fav.user_id = folders.user_id AND fav.file_path = f.path
             WHERE folders.user_id = ?1 AND f.media_type = 'IMAGE' AND f.phash IS NOT NULL
               AND f.width IS NOT NULL AND f.height IS NOT NULL AND (?2 IS NULL OR f.id > ?2)
             ORDER BY f.id LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                rusqlite::params![OWNER_ID, after, FINGERPRINT_PAGE_SIZE as i64],
                |r| {
                    Ok(Fingerprint {
                        id: r.get(0)?,
                        folder: r.get(1)?,
                        path: r.get(2)?,
                        thumb: r.get(3)?,
                        phash: r.get(4)?,
                        width: r.get(5)?,
                        height: r.get(6)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await
}

async fn download(t: &Transport, site: &Site, raw: &str) -> Result<tempfile::NamedTempFile> {
    let url = t.media_url(raw)?;
    let mut response = t.get(url, booru_engines::headers(site, true)?).await?;
    let image = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|m| m.starts_with("image/"));
    if !image {
        return Err(booru_http::remote("the site did not answer with an image"));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_IMAGE_BYTES)
    {
        return Err(booru_http::remote("the image exceeds the size limit"));
    }
    let tmp = tempfile::NamedTempFile::new()?;
    let mut file = tokio::fs::File::from_std(tmp.reopen()?);
    let mut size = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| booru_http::remote("the image download was interrupted"))?
    {
        size += chunk.len() as u64;
        if size > MAX_IMAGE_BYTES {
            return Err(booru_http::remote("the image exceeds the size limit"));
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(tmp)
}

async fn prepare(t: &Transport, site: Option<&Site>, post: Post, raw: String) -> Option<Remote> {
    let (Some(width), Some(height)) = (post.width, post.height) else {
        return None;
    };
    let ext = post.file_ext.as_deref().unwrap_or("").to_lowercase();
    if SKIPPED_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let result = async {
        let site = site.ok_or_else(|| Error::Invalid("the site no longer exists".into()))?;
        let file = download(t, site, &raw).await?;
        let hash = media::average_hash(file.path()).await?;
        // Sampled now so the download is deleted before the next one starts.
        Ok::<_, Error>((hash, signature(file.path()).await))
    }
    .await;
    match result {
        Ok((hash, signature)) => Some(Remote {
            key: post.key,
            width,
            height,
            hash,
            signature,
        }),
        Err(error) => {
            eprintln!("[explore-gallery-match] {} skipped: {error}", post.key);
            None
        }
    }
}

async fn signature(path: &Path) -> Option<Vec<u8>> {
    media::signature_frame(path, MediaKind::Image, SIGNATURE_SIZE, None)
        .await
        .map_err(|error| {
            eprintln!(
                "[explore-gallery-match] cannot sample {}: {error}",
                path.display()
            )
        })
        .ok()
}

/// The library file's signature, falling back to its thumbnail when the original cannot be read.
async fn local_signature(
    db: &Database,
    cache: &mut HashMap<PathBuf, Option<Vec<u8>>>,
    local: &Fingerprint,
) -> Option<Vec<u8>> {
    let original = db
        .library()
        .resolve_file(Path::new(&local.folder), Path::new(&local.path))
        .ok();
    for path in [original, local.thumb.as_ref().map(PathBuf::from)]
        .into_iter()
        .flatten()
    {
        if !cache.contains_key(&path) {
            let computed = signature(&path).await;
            cache.insert(path.clone(), computed);
        }
        if let Some(found) = &cache[&path] {
            return Some(found.clone());
        }
    }
    None
}

/// Keys of the posts whose picture is a favorite already in the library. Empty unless the
/// duplicate policy keeps every favorite. Posts with an unsigned or tampered preview link, without
/// a size, animated, or whose download fails are left out.
async fn matching_keys(db: &Database, t: &Transport, posts: Vec<Post>) -> Result<Vec<String>> {
    if posts.is_empty() || !duplicate_policy::keeps_every_favorite(db).await? {
        return Ok(Vec::new());
    }
    let mut page = fingerprints(db, None).await?;
    if page.is_empty() {
        return Ok(Vec::new());
    }
    let key = explore::media_key(db).await?;
    let verified: Vec<(Post, String, String)> = posts
        .into_iter()
        .filter_map(|post| {
            let (site, raw) = explore::verified_media(&key, &post.match_preview_url)?;
            Some((post, site, raw))
        })
        .collect();
    let mut sites: HashMap<String, Option<Site>> = HashMap::new();
    for (_, id, _) in &verified {
        if !sites.contains_key(id) {
            sites.insert(id.clone(), boorus::site(db, id.clone()).await?);
        }
    }
    let mut unmatched: Vec<Remote> = stream::iter(verified)
        .map(|(post, site, raw)| prepare(t, sites[&site].as_ref(), post, raw))
        .buffered(MATCH_CONCURRENCY)
        .filter_map(|remote| async { remote })
        .collect()
        .await;

    let mut matches = Vec::new();
    let mut local_signatures = HashMap::new();
    while !unmatched.is_empty() {
        for index in (0..unmatched.len()).rev() {
            let candidates: Vec<&Fingerprint> = page
                .iter()
                .filter(|local| plausible(&unmatched[index], local))
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let Some(remote_signature) = &unmatched[index].signature else {
                unmatched.remove(index);
                continue;
            };
            let mut matched = false;
            for local in candidates {
                let local_signature = local_signature(db, &mut local_signatures, local).await;
                if local_signature.is_some_and(|l| {
                    duplicates::difference(remote_signature, &l) <= MAX_PIXEL_DIFFERENCE
                }) {
                    matched = true;
                    break;
                }
            }
            if matched {
                matches.push(unmatched.remove(index).key);
            }
        }
        if page.len() < FINGERPRINT_PAGE_SIZE {
            break;
        }
        let after = page.last().map(|f| f.id.clone());
        page = fingerprints(db, after).await?;
        if page.is_empty() {
            break;
        }
    }
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::write_setting,
        library::{self, NOW},
    };
    use axum::{response::IntoResponse, routing::get, Router};
    use std::process::Command;

    fn picture(path: &Path, source: &str) {
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", source])
            .args(["-frames:v", "1", "-y"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn post(key: &str, link: &str) -> Post {
        Post {
            key: key.into(),
            match_preview_url: link.into(),
            width: Some(160),
            height: Some(120),
            file_ext: Some("png".into()),
        }
    }

    #[tokio::test]
    async fn marks_posts_whose_picture_is_a_favorite_and_ignores_unsigned_links() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let root = db.library().root.clone();
        picture(&root.join("favorite.png"), "testsrc=s=160x120");
        picture(&root.join("not-favorite.png"), "smptebars=s=160x120");
        library::scan(&db).await.unwrap();

        // The site serves the favorite, the library file that is not a favorite, and a picture
        // missing from the library, all at the same size.
        let remote = dir.path().join("remote");
        std::fs::create_dir(&remote).unwrap();
        picture(&remote.join("same.png"), "testsrc=s=160x120");
        picture(&remote.join("smpte.png"), "smptebars=s=160x120");
        picture(&remote.join("other.png"), "mandelbrot=s=160x120");
        let served = remote.clone();
        let app = Router::new().route(
            "/{name}",
            get(
                move |axum::extract::Path(name): axum::extract::Path<String>| {
                    let bytes = std::fs::read(served.join(name)).unwrap();
                    async move { ([(header::CONTENT_TYPE, "image/png")], bytes).into_response() }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (favorite, seeded) = (root.join("favorite.png"), base.clone());
        db.call(move |c| {
            c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at) VALUES ('fixture',?1,'Fixture','e621',?2,0,1,0,{NOW},{NOW})"), rusqlite::params![OWNER_ID, seeded])?;
            c.execute(&format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,created_at,updated_at) VALUES (?1,'fixture','1',?2,{NOW},{NOW})"), rusqlite::params![OWNER_ID, favorite.to_string_lossy()])?;
            Ok(())
        })
        .await
        .unwrap();
        let key = explore::media_key(&db).await.unwrap();
        let link = |name: &str| {
            explore::signed(&key, "fixture", &json!(format!("{base}/{name}")))
                .as_str()
                .unwrap()
                .to_owned()
        };
        let same = link("same.png");
        let unsigned = same.replace(&same[same.len() - 64..], &"0".repeat(64));
        // A real signature with another address: the signature covers the address.
        let forged = link("other.png").replace("other.png", "same.png");
        let posts = || {
            vec![
                post("fixture:1", &same),
                post("fixture:2", &link("smpte.png")),
                post("fixture:3", &link("other.png")),
                post("fixture:4", &unsigned),
                post("fixture:5", &forged),
                post("fixture:6", &format!("{base}/same.png")),
            ]
        };
        let t = Transport {
            allow_loopback: true,
        };

        assert!(
            matching_keys(&db, &t, posts()).await.unwrap().is_empty(),
            "the policy is off"
        );
        db.call(|c| {
            write_setting(
                c,
                "duplicates.policy",
                &json!({"enabled": true, "style": "favorite_all", "preferredProviders": []}),
            )
        })
        .await
        .unwrap();
        assert_eq!(
            matching_keys(&db, &t, posts()).await.unwrap(),
            ["fixture:1"]
        );
        server.abort();

        let too_many = json!({"posts": (0..=MAX_POSTS).map(|i| json!({"key": format!("k{i}"), "matchPreviewUrl": same, "width": 1, "height": 1, "fileExt": null})).collect::<Vec<_>>()});
        let refused = route(State(db.clone()), Bytes::from(too_many.to_string())).await;
        assert!(matches!(refused, Err(Error::Invalid(_))));
    }

    #[test]
    fn hash_distance_counts_differing_bits_and_rejects_malformed_hashes() {
        assert_eq!(hash_distance("00000000000000ff", "000000000000000f"), 4);
        assert_eq!(hash_distance("0000", "0000"), u32::MAX);
        assert_eq!(
            hash_distance("+00000000000000f", "000000000000000f"),
            u32::MAX
        );
    }
}
