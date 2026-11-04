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
pub(crate) const MAX_RATIO_DIFFERENCE: f64 = 0.03;
const MAX_PIXEL_DIFFERENCE: f64 = 0.01;
/// A remote preview is a different encoding and scale, so this is looser than for two local
/// copies, yet far below what an edit of the picture changes. Measured on e621 previews against
/// a library file: the same post stays near 9/255 here, a retouched post near 73/255.
const MAX_SAMPLE_DIFFERENCE: f64 = 24.0 / 255.0;
const SIGNATURE_SIZE: u32 = 96;
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const SKIPPED_EXTENSIONS: [&str; 5] = ["gif", "mp4", "webm", "m4v", "mov"];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Post {
    pub(crate) key: String,
    pub(crate) match_preview_url: String,
    pub(crate) width: Option<i64>,
    pub(crate) height: Option<i64>,
    pub(crate) file_ext: Option<String>,
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

pub(crate) struct Fingerprint {
    pub(crate) id: String,
    pub(crate) folder: String,
    pub(crate) path: String,
    pub(crate) thumb: Option<String>,
    pub(crate) phash: String,
    pub(crate) width: i64,
    pub(crate) height: i64,
}

pub(crate) struct Remote {
    key: String,
    width: i64,
    height: i64,
    hash: String,
    /// `None` when the picture cannot be sampled; such a post never matches.
    pub(crate) signature: Option<Vec<u8>>,
}

/// Whether a remote preview's samples and a library file's samples show one picture.
pub(crate) fn same_picture(remote: &[u8], local: &[u8]) -> bool {
    duplicates::difference(remote, local) <= MAX_PIXEL_DIFFERENCE
        && duplicates::largest_block_difference(remote, local) <= MAX_SAMPLE_DIFFERENCE
}

/// [`same_picture`] for a sample as large as the picture, where no single sample is blurred: the
/// largest single difference then separates an edit from a re-encoding.
pub(crate) fn same_sharp_picture(remote: &[u8], local: &[u8]) -> bool {
    duplicates::difference(remote, local) <= MAX_PIXEL_DIFFERENCE
        && duplicates::largest_difference(remote, local) <= MAX_SAMPLE_DIFFERENCE
}

/// A 64-bit average hash from its 16 hex digits; `None` when malformed.
pub(crate) fn parse_hash(s: &str) -> Option<u64> {
    (s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| u64::from_str_radix(s, 16).ok())
        .flatten()
}

fn hash_distance(left: &str, right: &str) -> u32 {
    match (parse_hash(left), parse_hash(right)) {
        (Some(a), Some(b)) => (a ^ b).count_ones(),
        _ => u32::MAX,
    }
}

pub(crate) fn plausible(remote: &Remote, local: &Fingerprint) -> bool {
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

pub(crate) async fn download(
    t: &Transport,
    site: &Site,
    raw: &str,
) -> Result<tempfile::NamedTempFile> {
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

pub(crate) async fn prepare(
    t: &Transport,
    site: Option<&Site>,
    post: Post,
    raw: String,
) -> Option<Remote> {
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
pub(crate) async fn local_signature(
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

/// Whether a site post, as `explore::tagged_post` returns it, shows the library file at `path`.
/// The shapes must agree, and a picture must also look the same as the post's preview. A video or
/// an animation is compared by shape only, since a preview is one frame of many; a picture whose
/// size is unknown, by its look only. Errs when neither check can be made, the preview cannot be
/// downloaded or a picture cannot be sampled, so the check can run again later.
pub(crate) async fn post_shows_file(
    t: &Transport,
    site: &Site,
    post: &Value,
    path: &Path,
    kind: &str,
    size: Option<(i64, i64)>,
) -> Result<bool> {
    let sizes = post["width"]
        .as_i64()
        .zip(post["height"].as_i64())
        .zip(size)
        .filter(|((rw, rh), (lw, lh))| [rw, rh, lw, lh].iter().all(|n| **n > 0));
    if let Some(((rw, rh), (lw, lh))) = sizes {
        let ratio = (rw as f64 / rh as f64) / (lw as f64 / lh as f64);
        if (ratio - 1.0).abs() > MAX_RATIO_DIFFERENCE {
            return Ok(false);
        }
    }
    let ext = post["fileExt"].as_str().unwrap_or("").to_lowercase();
    if kind != "IMAGE" || SKIPPED_EXTENSIONS.contains(&ext.as_str()) || see_through(path).await {
        return match sizes {
            Some(_) => Ok(true),
            None => Err(booru_http::remote(
                "a size is unknown, and this file can be compared only by its shape",
            )),
        };
    }
    let raw = post["previewUrl"]
        .as_str()
        .or(post["sampleUrl"].as_str())
        .ok_or_else(|| booru_http::remote("the post has no preview to compare"))?;
    let preview = download(t, site, raw).await?;
    // Without the post's size, the preview's own shape stands in for it. A preview cropped to
    // another shape cannot tell anything, and a look check against it would drop a true match.
    if sizes.is_none() {
        match same_shape(preview.path(), path, size).await {
            Some(true) => {}
            Some(false) => return Err(booru_http::remote(
                "a size is unknown and the preview has another shape, so it could not be compared",
            )),
            None => return Err(booru_http::remote("a picture could not be read to compare")),
        }
    }
    let (Some(remote), Some(local)) = (signature(preview.path()).await, signature(path).await)
    else {
        return Err(booru_http::remote("a picture could not be compared"));
    };
    Ok(same_picture(&remote, &local))
}

/// Whether two pictures' pixel sizes have the same shape; `right_size`, when known, spares reading
/// `right`. None when a picture cannot be read.
async fn same_shape(left: &Path, right: &Path, right_size: Option<(i64, i64)>) -> Option<bool> {
    let (left, right) = (left.to_owned(), right.to_owned());
    let known =
        right_size.and_then(|(w, h)| Some((u32::try_from(w).ok()?, u32::try_from(h).ok()?)));
    // By content, not extension: a downloaded preview is saved without one.
    let read = |path: &Path| -> image::ImageResult<(u32, u32)> {
        image::ImageReader::open(path)?
            .with_guessed_format()?
            .into_dimensions()
    };
    let sizes = tokio::task::spawn_blocking(move || {
        let right = match known {
            Some(size) => size,
            None => read(&right)?,
        };
        Ok::<_, image::ImageError>((read(&left)?, right))
    })
    .await;
    match sizes {
        Ok(Ok(((lw, lh), (rw, rh)))) if lh > 0 && rh > 0 => {
            let ratio = (lw as f64 / lh as f64) / (rw as f64 / rh as f64);
            Some((ratio - 1.0).abs() <= MAX_RATIO_DIFFERENCE)
        }
        Ok(Ok(_)) => Some(false),
        Ok(Err(error)) => {
            eprintln!("[developer] Cannot read a picture's size to compare it with a site preview: {error}");
            None
        }
        Err(error) => {
            eprintln!("[developer] Reading a picture's size stopped: {error}");
            None
        }
    }
}

/// Whether a picture can have see-through parts. A sample keeps only the colour under them, which
/// a site's flattened preview does not show, so such a picture is compared by shape only.
async fn see_through(path: &Path) -> bool {
    let path = path.to_owned();
    let read = tokio::task::spawn_blocking(move || {
        use image::ImageDecoder;
        let reader = image::ImageReader::open(&path)?.with_guessed_format()?;
        let decoder = reader.into_decoder().map_err(std::io::Error::other)?;
        if !decoder.color_type().has_alpha() {
            return Ok(false);
        }
        // A GIF decoder always reports a see-through channel: only a pixel tells.
        let picture = image::DynamicImage::from_decoder(decoder).map_err(std::io::Error::other)?;
        Ok::<_, std::io::Error>(picture.to_rgba8().pixels().any(|pixel| pixel[3] < u8::MAX))
    })
    .await
    .map_err(std::io::Error::other)
    .flatten();
    read.unwrap_or_else(|error| {
        eprintln!("[developer] Cannot read whether a library picture is see-through: {error}");
        false
    })
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
                if local_signature.is_some_and(|l| same_picture(remote_signature, &l)) {
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

    #[tokio::test]
    async fn a_post_shows_the_file_only_with_the_same_shape_and_picture() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let local = dir.path().join("local.png");
        picture(&local, "testsrc=s=160x120");
        let remote = dir.path().join("remote");
        std::fs::create_dir(&remote).unwrap();
        picture(&remote.join("same.png"), "testsrc=s=160x120");
        picture(&remote.join("smpte.png"), "smptebars=s=160x120");
        picture(&remote.join("square.png"), "testsrc=s=120x120");
        let served = remote.clone();
        let app = Router::new().route(
            "/{name}",
            get(
                move |axum::extract::Path(name): axum::extract::Path<String>| {
                    let found = std::fs::read(served.join(name));
                    async move {
                        match found {
                            Ok(bytes) => {
                                ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
                            }
                            Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let seeded = base.clone();
        db.call(move |c| {
            c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at) VALUES ('fixture',?1,'Fixture','e621',?2,0,1,0,{NOW},{NOW})"), rusqlite::params![OWNER_ID, seeded])?;
            Ok(())
        })
        .await
        .unwrap();
        let site = boorus::site(&db, "fixture".into()).await.unwrap().unwrap();
        let t = Transport {
            allow_loopback: true,
        };
        // The site's own file is larger than the library copy, at the same shape.
        let post = |width: i64, preview: &str| json!({"width": width, "height": 240, "fileExt": "png", "previewUrl": format!("{base}/{preview}")});
        let shows = |post: Value, kind: &'static str| {
            let (t, site, local) = (&t, &site, &local);
            async move { post_shows_file(t, site, &post, local, kind, Some((160, 120))).await }
        };
        assert!(shows(post(320, "same.png"), "IMAGE").await.unwrap());
        assert!(!shows(post(320, "smpte.png"), "IMAGE").await.unwrap());
        assert!(
            !shows(post(240, "same.png"), "IMAGE").await.unwrap(),
            "another shape"
        );
        assert!(
            shows(post(320, "missing.png"), "VIDEO").await.unwrap(),
            "a video compares shapes only"
        );
        let mut no_size = post(320, "same.png");
        no_size["width"] = Value::Null;
        assert!(
            shows(no_size.clone(), "IMAGE").await.unwrap(),
            "a picture of unknown size is compared by its look"
        );
        assert!(shows(no_size, "VIDEO").await.is_err());
        let mut cropped = post(320, "square.png");
        cropped["width"] = Value::Null;
        assert!(
            shows(cropped, "IMAGE").await.is_err(),
            "a preview of another shape cannot tell, so the match is kept"
        );
        assert!(
            shows(post(320, "missing.png"), "IMAGE").await.is_err(),
            "an unreachable preview can be checked again"
        );
        // A GIF saved under a .jpg name, as a site may serve it, is still a picture to compare.
        let gif = dir.path().join("saved-as.gif");
        picture(&gif, "testsrc=s=160x120");
        let named_jpg = dir.path().join("library-copy.jpg");
        std::fs::rename(&gif, &named_jpg).unwrap();
        let mut gif_post = post(320, "same.png");
        gif_post["width"] = Value::Null;
        assert!(
            post_shows_file(&t, &site, &gif_post, &named_jpg, "IMAGE", Some((160, 120)))
                .await
                .unwrap(),
            "a GIF picture of the same look"
        );
        // A see-through picture is compared by shape only, so even another picture passes.
        picture(
            &local,
            "color=c=red@0.0:s=160x120,format=rgba,drawbox=x=40:y=30:w=80:h=60:color=blue:t=fill",
        );
        assert!(
            shows(post(320, "smpte.png"), "IMAGE").await.unwrap(),
            "compared by shape only"
        );
        server.abort();
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
