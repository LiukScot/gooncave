//! Repairs favorite links that tie a post to a library file showing another picture.
//!
//! An older duplicate finder merged edits of one picture into one file and pointed every post's
//! favorite at the survivor. The check below downloads each linked post's preview and drops the
//! link when the preview is not the file's picture.

use crate::{
    booru_engines,
    booru_favorites::provider as provider_key,
    booru_http::Transport,
    boorus::Site,
    db::{Database, OWNER_ID},
    gallery_matches::{self, Fingerprint, Post},
    Error, Result,
};
use futures_util::{stream, StreamExt};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;

const MAX_LINKS: usize = 5000;
const CONCURRENCY: usize = 4;

struct Link {
    provider: String,
    remote_id: String,
    file_path: String,
    file: Fingerprint,
    /// The post as its site describes it now; `None` when the site cannot be read.
    post: Option<Value>,
}

enum Verdict {
    Same,
    Different,
    /// The site or the picture could not be read; the link stays.
    Unknown,
}

pub(crate) async fn route(
    axum::extract::State(db): axum::extract::State<Database>,
) -> Result<axum::Json<Value>> {
    let sites = crate::boorus::sites(&db).await?;
    recheck(&db, &sites, &Transport::default())
        .await
        .map(axum::Json)
}

/// Only files linked from more than one post can hold a wrong link, and only posts of the file's
/// exact size are judged. When no linked post shows the
/// file's picture, none is removed: the survivor of the merge cannot be told from the rest.
pub(crate) async fn recheck(db: &Database, sites: &[Site], t: &Transport) -> Result<Value> {
    let mut links = load_links(db).await?;
    let posts: Vec<Option<Value>> = stream::iter(0..links.len())
        .map(|index| fetch_post(t, sites, &links[index]))
        .buffered(CONCURRENCY)
        .collect()
        .await;
    for (link, post) in links.iter_mut().zip(posts) {
        link.post = post;
    }
    judge(db, sites, t, links).await
}

async fn load_links(db: &Database) -> Result<Vec<Link>> {
    let links = db
        .call(|c| {
            let mut statement = c.prepare(
                "SELECT fav.provider, fav.remote_id, fav.file_path, f.id, folders.path, f.thumb_path, f.phash, f.width, f.height
                 FROM favorite_items fav
                 JOIN files f ON f.path = fav.file_path
                 JOIN library_folders folders ON folders.id = f.folder_id AND folders.user_id = fav.user_id
                 WHERE fav.user_id = ?1 AND f.media_type = 'IMAGE' AND f.phash IS NOT NULL
                   AND f.width IS NOT NULL AND f.height IS NOT NULL
                   AND (SELECT count(*) FROM favorite_items o WHERE o.user_id = fav.user_id AND o.file_path = fav.file_path) > 1
                 ORDER BY fav.file_path, fav.created_at, fav.remote_id LIMIT ?2",
            )?;
            let rows = statement
                .query_map(params![OWNER_ID, (MAX_LINKS + 1) as i64], |r| {
                    Ok(Link {
                        provider: r.get(0)?,
                        remote_id: r.get(1)?,
                        file_path: r.get(2)?,
                        file: Fingerprint {
                            id: r.get(3)?,
                            folder: r.get(4)?,
                            path: r.get(2)?,
                            thumb: r.get(5)?,
                            phash: r.get(6)?,
                            width: r.get(7)?,
                            height: r.get(8)?,
                        },
                        post: None,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await?;
    if links.len() > MAX_LINKS {
        return Err(Error::Invalid(format!(
            "More than {MAX_LINKS} favorite links share a file, which is too many to check at once."
        )));
    }
    Ok(links)
}

async fn judge(db: &Database, sites: &[Site], t: &Transport, links: Vec<Link>) -> Result<Value> {
    let (mut checked, mut unchecked, mut unresolved) = (0, 0, 0);
    let mut removed = Vec::new();
    let mut groups: Vec<Vec<Link>> = Vec::new();
    for link in links {
        match groups.last_mut() {
            Some(group) if group[0].file_path == link.file_path => group.push(link),
            _ => groups.push(vec![link]),
        }
    }
    for group in groups {
        let mut cache = HashMap::new();
        let local = gallery_matches::local_signature(db, &mut cache, &group[0].file).await;
        let verdicts: Vec<Verdict> = match &local {
            Some(local) => {
                stream::iter(0..group.len())
                    .map(|index| verdict(t, sites, &group[index], local))
                    .buffered(CONCURRENCY)
                    .collect()
                    .await
            }
            None => group.iter().map(|_| Verdict::Unknown).collect(),
        };
        let any_same = verdicts.iter().any(|v| matches!(v, Verdict::Same));
        let any_different = verdicts.iter().any(|v| matches!(v, Verdict::Different));
        unchecked += verdicts
            .iter()
            .filter(|v| matches!(v, Verdict::Unknown))
            .count();
        checked += verdicts.len();
        if any_different && !any_same {
            unresolved += 1;
            continue;
        }
        for (link, verdict) in group.iter().zip(&verdicts) {
            if matches!(verdict, Verdict::Different) {
                let (provider, remote_id, file_path) = (
                    link.provider.clone(),
                    link.remote_id.clone(),
                    link.file_path.clone(),
                );
                db.call(move |c| {
                    c.execute(
                        "DELETE FROM favorite_items WHERE user_id = ?1 AND provider = ?2 AND remote_id = ?3 AND file_path = ?4",
                        params![OWNER_ID, provider, remote_id, file_path],
                    )?;
                    Ok(())
                })
                .await?;
                removed.push(json!({"provider": link.provider, "remoteId": link.remote_id}));
            }
        }
    }
    Ok(
        json!({"checked": checked, "removed": removed, "unchecked": unchecked, "unresolvedFiles": unresolved}),
    )
}

async fn fetch_post(t: &Transport, sites: &[Site], link: &Link) -> Option<Value> {
    let site = sites.iter().find(|s| provider_key(s) == link.provider)?;
    match booru_engines::single(t, site, &link.remote_id).await {
        Ok(post) => post,
        Err(error) => {
            eprintln!("[favorite-links] {} unreadable: {error}", link.remote_id);
            None
        }
    }
}

async fn verdict(t: &Transport, sites: &[Site], link: &Link, local: &[u8]) -> Verdict {
    let (Some(site), Some(post)) = (
        sites.iter().find(|s| provider_key(s) == link.provider),
        &link.post,
    ) else {
        return Verdict::Unknown;
    };
    let Some(preview) = post["previewUrl"].as_str() else {
        return Verdict::Unknown;
    };
    // The merge this repairs only joined pictures of identical size, so a post of another size is
    // a legitimate link (a repost, a resize) that this check cannot judge.
    let size = (post["width"].as_i64(), post["height"].as_i64());
    if size != (Some(link.file.width), Some(link.file.height)) {
        return Verdict::Unknown;
    }
    let candidate = Post {
        key: link.remote_id.clone(),
        match_preview_url: String::new(),
        width: post["width"].as_i64(),
        height: post["height"].as_i64(),
        file_ext: post["fileExt"].as_str().map(str::to_owned),
    };
    let Some(remote) = gallery_matches::prepare(t, Some(site), candidate, preview.to_owned()).await
    else {
        return Verdict::Unknown;
    };
    let Some(signature) = &remote.signature else {
        return Verdict::Unknown;
    };
    if gallery_matches::plausible(&remote, &link.file)
        && gallery_matches::same_picture(signature, local)
    {
        Verdict::Same
    } else {
        Verdict::Different
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{self, NOW};
    use axum::{extract::Request, http::header, response::IntoResponse, routing::any, Router};
    use std::{path::Path, process::Command};

    fn picture(path: &Path, source: &str) {
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", source])
            .args(["-frames:v", "1", "-y"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[tokio::test]
    async fn a_link_to_an_edit_of_the_files_picture_is_dropped_and_the_real_one_stays() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let root = db.library().root.clone();
        let original = "testsrc=s=160x120";
        let edit = "testsrc=s=160x120,drawbox=x=40:y=30:w=60:h=50:color=white:t=fill";
        picture(&root.join("a.png"), original);
        picture(&root.join("b.png"), "smptebars=s=160x120");
        library::scan(&db).await.unwrap();

        let remote = dir.path().join("remote");
        std::fs::create_dir(&remote).unwrap();
        picture(&remote.join("original.png"), original);
        picture(&remote.join("edit.png"), edit);
        picture(&remote.join("bars.png"), "mandelbrot=s=160x120");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let served = remote.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let folder = served.clone();
            async move {
                let bytes =
                    std::fs::read(folder.join(request.uri().path().trim_start_matches('/')))
                        .unwrap();
                ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
            }
        }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (a, b) = (root.join("a.png"), root.join("b.png"));
        db.call(move |c| {
            for (id, path) in [("1", &a), ("2", &a), ("3", &b), ("4", &b), ("5", &a)] {
                c.execute(
                    &format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,created_at,updated_at) VALUES (?1,'fixture',?2,?3,{NOW},{NOW})"),
                    params![OWNER_ID, id, path.to_string_lossy()],
                )?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let sites = vec![Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "e621".into(),
            base,
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        }];
        let mut links = load_links(&db).await.unwrap();
        for link in &mut links {
            let image = ["original", "edit", "bars", "bars", "edit"]
                [link.remote_id.parse::<usize>().unwrap() - 1];
            let (width, height) = if link.remote_id == "5" {
                (80, 60)
            } else {
                (160, 120)
            };
            link.post = Some(
                json!({"previewUrl": format!("{}/{image}.png", sites[0].base), "width": width, "height": height, "fileExt": "png"}),
            );
        }
        let transport = Transport {
            allow_loopback: true,
        };
        let report = judge(&db, &sites, &transport, links).await.unwrap();
        let left: Vec<String> = db
            .call(|c| {
                let mut s = c.prepare("SELECT remote_id FROM favorite_items ORDER BY remote_id")?;
                let ids = s
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                Ok(ids)
            })
            .await
            .unwrap();
        server.abort();
        assert_eq!(
            report["removed"],
            json!([{"provider": "fixture", "remoteId": "2"}])
        );
        assert_eq!(
            left,
            ["1", "3", "4", "5"],
            "a file no linked post matches keeps every link, and a post of another size is not judged"
        );
        assert_eq!(report["unresolvedFiles"], 1);
    }
}
