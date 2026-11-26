//! Which Explore posts show a picture another loaded post already shows, so the grid stacks them.

use crate::{
    booru_http::Transport,
    boorus::{self, Site},
    cache,
    db::Database,
    explore,
    gallery_matches::{
        self, Post, MAX_HASH_DISTANCE, MAX_RATIO_DIFFERENCE, SIGNATURE_SIZE, SKIPPED_EXTENSIONS,
    },
    Error, Result,
};
use axum::{body::Bytes, extract::State, Json};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};

const MAX_POSTS: usize = 100;
const MAX_EARLIER_POSTS: usize = 5000;
const CONCURRENCY: usize = 8;
/// The page is held back while its pictures are compared, so that no tile moves afterwards.
const BUDGET: Duration = Duration::from_millis(2500);
const HASH_LENGTH: usize = 16;

#[derive(serde::Deserialize)]
struct Request {
    posts: Vec<Post>,
    #[serde(default)]
    earlier: Vec<Post>,
}

pub(crate) async fn route(State(db): State<Database>, body: Bytes) -> Result<Json<Value>> {
    let request = serde_json::from_slice::<Request>(&body)
        .ok()
        .filter(|r| {
            r.posts.len() <= MAX_POSTS
                && r.earlier.len() <= MAX_EARLIER_POSTS
                && r.posts.iter().chain(&r.earlier).all(Post::valid)
        })
        .ok_or_else(|| Error::Invalid("Invalid copies request".into()))?;
    let copies = copies(
        &db,
        &Transport::default(),
        request.posts,
        request.earlier,
        BUDGET,
    )
    .await?;
    Ok(Json(json!({ "copies": copies })))
}

struct Candidate {
    key: String,
    site: String,
    raw: String,
    uploader: Option<String>,
    width: i64,
    height: i64,
    file_ext: Option<String>,
}

/// Whether two posts can be copies at all: the same shape, and not two posts of one uploader on one
/// site, who posts variants of a picture on purpose.
fn comparable(a: &Candidate, b: &Candidate) -> bool {
    let one_uploader = match (&a.uploader, &b.uploader) {
        (Some(a), Some(b)) => a.to_lowercase() == b.to_lowercase(),
        _ => true,
    };
    if a.key == b.key || (a.site == b.site && one_uploader) {
        return false;
    }
    let ratio = (a.width as f64 / a.height as f64) / (b.width as f64 / b.height as f64);
    (ratio - 1.0).abs() <= MAX_RATIO_DIFFERENCE
}

/// A picture's average hash and samples, kept so a post loaded earlier is not downloaded again
/// for every later page.
async fn look(
    db: &Database,
    t: &Transport,
    site: Option<&Site>,
    candidate: &Candidate,
) -> Option<(String, Vec<u8>)> {
    let key = format!("look:{}:{}", candidate.site, candidate.raw);
    let samples = (SIGNATURE_SIZE * SIGNATURE_SIZE) as usize;
    match cache::get(db, &key).await {
        Ok(Some(entry)) if entry.bytes.len() == HASH_LENGTH + samples => {
            let (hash, signature) = entry.bytes.split_at(HASH_LENGTH);
            if let Ok(hash) = std::str::from_utf8(hash) {
                return Some((hash.to_owned(), signature.to_vec()));
            }
        }
        Ok(_) => {}
        Err(error) => eprintln!("[developer] Cannot read a kept picture comparison: {error}"),
    }
    let post = Post {
        key: candidate.key.clone(),
        match_preview_url: String::new(),
        width: Some(candidate.width),
        height: Some(candidate.height),
        file_ext: candidate.file_ext.clone(),
        uploader: None,
    };
    let remote = gallery_matches::prepare(t, site, post, candidate.raw.clone()).await?;
    let signature = remote.signature?;
    if remote.hash.len() == HASH_LENGTH && signature.len() == samples {
        let bytes = [remote.hash.as_bytes(), &signature].concat();
        if let Err(error) = cache::put(db, &key, "look", "application/octet-stream", &bytes).await {
            eprintln!("[developer] Cannot keep a picture comparison: {error}");
        }
    }
    Some((remote.hash, signature))
}

/// Pairs `[post, other]` of keys: `post` is one of `posts` and shows the picture of `other`, which
/// is in `earlier` or before it in `posts`. A post with an unsigned preview link, without a size,
/// animated, or whose picture is not read within `budget` is in no pair.
async fn copies(
    db: &Database,
    t: &Transport,
    posts: Vec<Post>,
    earlier: Vec<Post>,
    budget: Duration,
) -> Result<Vec<[String; 2]>> {
    let key = explore::media_key(db).await?;
    let candidate = |post: Post| {
        let (site, raw) = explore::verified_media(&key, &post.match_preview_url)?;
        let ext = post.file_ext.as_deref().unwrap_or("").to_lowercase();
        if SKIPPED_EXTENSIONS.contains(&ext.as_str()) {
            return None;
        }
        Some(Candidate {
            key: post.key,
            site,
            raw,
            uploader: post.uploader,
            width: post.width?,
            height: post.height?,
            file_ext: post.file_ext,
        })
    };
    let posts: Vec<Candidate> = posts.into_iter().filter_map(candidate).collect();
    let earlier: Vec<Candidate> = earlier.into_iter().filter_map(candidate).collect();
    let new = posts.iter().filter(|one| {
        posts
            .iter()
            .chain(&earlier)
            .any(|other| comparable(one, other))
    });
    let shown = earlier
        .iter()
        .filter(|one| posts.iter().any(|post| comparable(one, post)));
    let wanted: Vec<&Candidate> = new.chain(shown).collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let mut sites: HashMap<String, Option<Site>> = HashMap::new();
    for one in &wanted {
        if !sites.contains_key(&one.site) {
            sites.insert(one.site.clone(), boorus::site(db, one.site.clone()).await?);
        }
    }
    let total = wanted.len();
    let reads: Vec<_> = wanted
        .into_iter()
        .map(|one| {
            let site = sites[&one.site].as_ref();
            async move { Some((one.key.as_str(), look(db, t, site, one).await?)) }
        })
        .collect();
    let looks: HashMap<&str, (String, Vec<u8>)> = stream::iter(reads)
        .buffer_unordered(CONCURRENCY)
        .take_until(tokio::time::sleep(budget))
        .filter_map(|found| async { found })
        .collect()
        .await;
    if looks.len() < total {
        eprintln!(
            "[developer] Explore compared {} of {total} pictures to find copies. The others failed to load or ran out of time, so their copies are not stacked.",
            looks.len()
        );
    }
    let mut pairs = Vec::new();
    for (index, post) in posts.iter().enumerate() {
        let Some((hash, signature)) = looks.get(post.key.as_str()) else {
            continue;
        };
        for other in earlier.iter().chain(&posts[..index]) {
            let same = comparable(post, other)
                && looks.get(other.key.as_str()).is_some_and(|(h, s)| {
                    gallery_matches::hash_distance(hash, h) <= MAX_HASH_DISTANCE
                        && gallery_matches::same_picture(signature, s)
                });
            if same {
                pairs.push([post.key.clone(), other.key.clone()]);
            }
        }
    }
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::OWNER_ID, library::NOW};
    use axum::{http::header, response::IntoResponse, routing::get, Router};
    use std::{path::Path, process::Command};

    fn picture(path: &Path, source: &str, extra: &[&str]) {
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", source])
            .args(extra)
            .args(["-frames:v", "1", "-y"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn two_posts_of_one_uploader_on_one_site_are_not_compared() {
        let post = |key: &str, site: &str, uploader: Option<&str>, width: i64| Candidate {
            key: key.into(),
            site: site.into(),
            raw: String::new(),
            uploader: uploader.map(str::to_owned),
            width,
            height: 400,
            file_ext: None,
        };
        let original = post("a:1", "a", Some("Artist"), 600);
        assert!(!comparable(
            &original,
            &post("a:2", "a", Some("artist"), 600)
        ));
        assert!(!comparable(&original, &post("a:2", "a", None, 600)));
        assert!(comparable(&original, &post("a:2", "a", Some("other"), 600)));
        assert!(comparable(
            &original,
            &post("b:1", "b", Some("artist"), 300 * 2)
        ));
        assert!(
            !comparable(&original, &post("b:1", "b", None, 400)),
            "another shape is another picture"
        );
    }

    #[tokio::test]
    async fn a_smaller_recompressed_copy_on_another_site_is_found_on_the_page_and_across_pages() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let remote = dir.path().join("remote");
        std::fs::create_dir(&remote).unwrap();
        picture(&remote.join("original.png"), "testsrc=s=640x480", &[]);
        picture(
            &remote.join("copy.jpg"),
            "testsrc=s=640x480",
            &["-vf", "scale=320:240", "-q:v", "6"],
        );
        picture(&remote.join("other.png"), "mandelbrot=s=640x480", &[]);
        let served = remote.clone();
        let app = Router::new().route(
            "/{name}",
            get(
                move |axum::extract::Path(name): axum::extract::Path<String>| {
                    let mime = if name.ends_with(".jpg") {
                        "image/jpeg"
                    } else {
                        "image/png"
                    };
                    let found = std::fs::read(served.join(name));
                    async move {
                        match found {
                            Ok(bytes) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
                            Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // Two sites cannot share an address.
        let seeded = [
            ("first", base.clone()),
            ("second", base.replace("127.0.0.1", "localhost")),
        ];
        db.call(move |c| {
            for (order, (id, address)) in seeded.iter().enumerate() {
                c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at) VALUES (?1,?2,?1,'e621',?3,0,1,?4,{NOW},{NOW})"), rusqlite::params![id, OWNER_ID, address, order as i64])?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let key = explore::media_key(&db).await.unwrap();
        let post = |site: &str, id: &str, name: &str, size: (i64, i64)| Post {
            key: format!("{site}:{id}"),
            match_preview_url: explore::signed(&key, site, &json!(format!("{base}/{name}")))
                .as_str()
                .unwrap()
                .to_owned(),
            width: Some(size.0),
            height: Some(size.1),
            file_ext: name.rsplit('.').next().map(str::to_owned),
            uploader: None,
        };
        let t = Transport {
            allow_loopback: true,
        };
        let budget = Duration::from_secs(30);

        let page = vec![
            post("first", "1", "original.png", (640, 480)),
            post("second", "2", "copy.jpg", (320, 240)),
            post("second", "3", "other.png", (640, 480)),
            post("first", "4", "copy.jpg", (320, 240)),
        ];
        assert_eq!(
            copies(&db, &t, page, Vec::new(), budget).await.unwrap(),
            [["second:2", "first:1"], ["first:4", "second:2"]],
            "a copy on the same site with no uploader named is left alone"
        );

        let later = vec![post("second", "2", "copy.jpg", (320, 240))];
        let shown = vec![
            post("first", "1", "original.png", (640, 480)),
            post("second", "3", "other.png", (640, 480)),
        ];
        // The site is gone: the picture loaded with the earlier page is not downloaded again.
        std::fs::remove_file(remote.join("original.png")).unwrap();
        assert_eq!(
            copies(&db, &t, later, shown, budget).await.unwrap(),
            [["second:2", "first:1"]]
        );

        let unread = vec![
            post("first", "5", "missing.png", (640, 480)),
            post("second", "2", "copy.jpg", (320, 240)),
        ];
        assert!(
            copies(&db, &t, unread, Vec::new(), budget)
                .await
                .unwrap()
                .is_empty(),
            "a picture that cannot be read is in no pair"
        );
        server.abort();
    }
}
