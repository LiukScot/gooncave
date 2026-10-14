use crate::{
    booru_http::Transport,
    boorus,
    db::{read_setting, Database, OWNER_ID},
    media::{self, MediaKind},
    source_matches::Match,
    source_remote,
    source_store::{self, File},
    Error, Result,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{watch, Mutex, Semaphore};

const MAX_QUEUED_SEARCHES: usize = 4;

fn automatic_targets(c: &rusqlite::Connection) -> Result<Value> {
    let targets = read_setting(c, "source_targets", &json!([]))?;
    let selected = targets
        .as_array()
        .filter(|items| items.len() <= 64 && items.iter().all(|item| item.as_str().is_some()))
        .ok_or_else(|| {
            Error::Storage("Invalid saved source targets. Update File sources settings.".into())
        })?;
    let mut query = c.prepare("SELECT DISTINCT lower(coalesce(preset_key,id)) FROM user_booru_sites
        WHERE user_id=?1 AND enabled=1 AND EXISTS(SELECT 1 FROM json_each(?2)
        WHERE lower(value)=lower(user_booru_sites.id) OR lower(value)=lower(user_booru_sites.preset_key))
        ORDER BY 1 LIMIT 32")?;
    let sources = query
        .query_map(
            rusqlite::params![OWNER_ID, json!(selected).to_string()],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(sources))
}

fn select_sources(mut candidates: Vec<(String, String, f64)>) -> Vec<(String, String)> {
    candidates.sort_by(|a, b| b.2.total_cmp(&a.2));
    let mut sources = Vec::new();
    for (source, url, _) in candidates {
        if !sources.iter().any(|(key, _)| key == &source) {
            sources.push((source, url));
        }
    }
    sources
}

pub(crate) struct Job {
    pub writes: Mutex<()>,
    queue: Semaphore,
    pub cancel: watch::Sender<u64>,
}

impl Default for Job {
    fn default() -> Self {
        Self {
            writes: Mutex::new(()),
            queue: Semaphore::new(MAX_QUEUED_SEARCHES),
            cancel: watch::channel(0).0,
        }
    }
}

pub(crate) async fn key(db: &Database) -> Result<Option<String>> {
    db.call(|c| {
        Ok(c.query_row(
            "SELECT api_key FROM provider_credentials WHERE user_id=?1 AND provider='SAUCENAO'",
            [OWNER_ID],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
    })
    .await
}

pub(crate) async fn refresh(
    db: &Database,
    file: &File,
    matches: &[(String, String)],
) -> Result<usize> {
    let sites = boorus::sites(db).await?;
    let mut updated = 0;
    let mut failure = None;
    for (source, url) in matches {
        let Some(site) = sites
            .iter()
            .find(|s| s.id == *source || s.public["presetKey"].as_str() == Some(source))
        else {
            continue;
        };
        let Some(id) = source_store::candidate(site, url) else {
            continue;
        };
        match crate::explore::tagged_post(&Transport::default(), site, &id).await {
            Ok(Some(post)) => {
                let snapshot = file.clone();
                let site = site.clone();
                let url = url.clone();
                updated += usize::from(
                    db.call(move |c| source_store::apply_tags(c, &snapshot, &site, &url, &post))
                        .await?,
                );
            }
            Ok(None) => {
                failure = Some(Error::Remote(
                    "A source post is no longer available. Existing tags were kept.".into(),
                ));
            }
            Err(error) => {
                failure = Some(error);
            }
        }
    }
    if let Some(error) = failure {
        return Err(Error::Remote(format!(
            "Some source tags could not update. Completed updates were kept. {error}"
        )));
    }
    Ok(updated)
}

pub(crate) async fn run(db: &Database, id: &str, provider: &str) -> Result<Option<Value>> {
    run_with(db, id, provider, &Transport::default(), None).await
}

async fn run_with(
    db: &Database,
    id: &str,
    provider: &str,
    transport: &Transport,
    endpoint: Option<&str>,
) -> Result<Option<Value>> {
    if !["SAUCENAO", "FLUFFLE"].contains(&provider) {
        return Err(Error::Invalid("Choose SauceNAO or Fluffle.".into()));
    }
    let _queued = db.sources.queue.try_acquire().map_err(|_| {
        Error::Remote(
            "Another image search is running. Wait for it to finish, then try again.".into(),
        )
    })?;
    let mut cancellation = db.sources.cancel.subscribe();
    let generation = *cancellation.borrow();
    let guard = tokio::select! {
        guard=db.sources.writes.lock()=>guard,
        _=cancellation.wait_for(|current|*current!=generation)=>return Err(Error::Remote("Image search was cancelled. You can retry it.".into())),
    };
    let lookup = id.to_owned();
    let Some(file) = db.call(move |c| source_store::file(c, &lookup)).await? else {
        return Ok(None);
    };
    let credential = key(db).await?;
    if provider == "SAUCENAO" && credential.as_deref().is_none_or(str::is_empty) {
        return Err(Error::Unavailable(
            "Add your SauceNAO API key in Settings → File sources before searching.",
        ));
    }
    let snapshot = file.clone();
    let name = provider.to_owned();
    let run = db
        .call(move |c| source_store::begin(c, &snapshot.id, &name))
        .await?;
    let work = async {
        let path = db.library().resolve_file(
            std::path::Path::new(&file.folder),
            std::path::Path::new(&file.path),
        )?;
        let kind = match file.kind.as_str() {
            "IMAGE" => MediaKind::Image,
            "VIDEO" => MediaKind::Video,
            _ => return Err(Error::Invalid("This media type cannot be searched.".into())),
        };
        let before = tokio::fs::metadata(&path).await?;
        if i64::try_from(before.len()).ok() != Some(file.size)
            || crate::library::iso_millis(before.modified()?) != file.mtime
        {
            return Err(Error::Remote(
                "This file changed. Wait for the library scan, then retry image search.".into(),
            ));
        }
        let image = media::source_image(&path, kind, file.duration_ms).await?;
        let after = tokio::fs::metadata(&path).await?;
        if after.len() != before.len() || after.modified()? != before.modified()? {
            return Err(Error::Remote(
                "This file changed while preparing image search. Refresh the library and retry."
                    .into(),
            ));
        }
        match endpoint {
            Some(endpoint) => {
                source_remote::upload(
                    transport,
                    transport.media_url(endpoint)?,
                    provider,
                    credential.as_deref(),
                    image,
                )
                .await
            }
            None => source_remote::search(transport, provider, credential.as_deref(), image).await,
        }
    };
    let answer = tokio::select! {
        answer=work=>answer,
        _=cancellation.wait_for(|current|*current!=generation)=>Err(Error::Remote("Image search was cancelled. You can retry it.".into())),
    };
    let (matches, error) = match answer {
        Ok(matches) => (matches, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let error = if provider == "SAUCENAO" && key(db).await? != credential {
        Some("The image search account changed. Retry with the current account.".into())
    } else {
        error
    };
    let snapshot = file.clone();
    let saved = run.clone();
    let results = matches.clone();
    let message = error.clone();
    let persisted = db
        .call(move |c| {
            source_store::finish(c, &snapshot, &saved, &results, message.as_deref(), false)
        })
        .await?;
    if !persisted {
        return Err(Error::Remote(
            "This file changed during image search. Refresh the library and try again.".into(),
        ));
    }
    if let Some(message) = error {
        return Err(Error::Remote(message));
    }
    crate::duplicate_policy::notify(db, "provider-post-changed").await;
    let refreshed = refresh_saved(db, id).await;
    // Auto-favorite waits on favorites sync downloads, so it must not hold up other searches.
    drop(guard);
    // The match is saved even when its tags failed to load; a failed auto-favorite never fails the search.
    if let Err(error) = crate::auto_favorite::from_source(db, transport, &file).await {
        eprintln!("Auto-favorite for file {id} failed: {error}");
    }
    refreshed.map_err(|error| {
        Error::Remote(format!(
            "A source was found, but its tags could not update. Retry tag refresh. {error}"
        ))
    })?;
    let id = id.to_owned();
    db.call(move |c| {
        Ok(source_store::runs(c, &id)?
            .into_iter()
            .find(|r| r["id"] == run))
    })
    .await
}

pub(crate) async fn refresh_file(db: &Database, id: &str) -> Result<Option<usize>> {
    let _guard = db.sources.writes.try_lock().map_err(|_| {
        Error::Remote(
            "Another source update is running. Wait for it to finish, then try again.".into(),
        )
    })?;
    refresh_saved(db, id).await
}

pub(crate) async fn refresh_saved(db: &Database, id: &str) -> Result<Option<usize>> {
    let mut cancellation = db.sources.cancel.subscribe();
    let generation = *cancellation.borrow();
    let id = id.to_owned();
    let (file, known, rows) = db
        .call(move |c| {
            Ok((
                source_store::file(c, &id)?,
                source_store::known_sources(c, &id)?,
                source_store::runs(c, &id)?,
            ))
        })
        .await?;
    let Some(file) = file else { return Ok(None) };
    let mut candidates = known
        .into_iter()
        .map(|(site, url)| (site, url, 0.0))
        .collect::<Vec<_>>();
    let sites = boorus::sites(db).await?;
    for row in rows.iter().filter(|r| r["status"] == "COMPLETED") {
        let provider = row["provider"]
            .as_str()
            .ok_or_else(|| Error::Storage("Invalid saved source provider.".into()))?;
        for value in row["results"]
            .as_array()
            .ok_or_else(|| Error::Storage("Invalid saved source results.".into()))?
        {
            let Some(url) = value["sourceUrl"].as_str() else {
                continue;
            };
            let score = value["score"].as_f64().unwrap_or(0.0);
            let matched = Match {
                url: url.into(),
                score,
                name: None,
                thumbnail: None,
                distance: None,
            };
            if !matched.trusted(provider) {
                continue;
            }
            if let Some(site) = sites
                .iter()
                .find(|s| source_store::candidate(s, url).is_some())
            {
                let source = site.public["presetKey"]
                    .as_str()
                    .unwrap_or(&site.id)
                    .to_owned();
                candidates.push((source, url.into(), score));
            }
        }
    }
    let sources = select_sources(candidates);
    tokio::select! {
        result=refresh(db,&file,&sources)=>Ok(Some(result?)),
        _=cancellation.wait_for(|current|*current!=generation)=>Err(Error::Remote("Tag refresh was cancelled. Completed updates were kept.".into())),
    }
}

pub(crate) async fn watch(db: Database) {
    let recovery=db.call(|c| {
        c.execute("UPDATE provider_runs SET status='FAILED',error='Image search was interrupted. Retry the search.',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('RUNNING','PENDING')",[])?;
        Ok(())
    }).await;
    if let Err(error) = recovery {
        eprintln!("Cannot recover image searches: {error}");
    }
    let mut timer = tokio::time::interval(Duration::from_secs(10));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        let targets = db.call(|c| automatic_targets(c)).await;
        let targets = match targets {
            Ok(targets) => targets,
            Err(error) => {
                eprintln!("Cannot read source targets: {error}");
                continue;
            }
        };
        let Some(selected) = targets.as_array() else {
            eprintln!("Invalid saved source targets. Update File sources settings.");
            continue;
        };
        if selected.is_empty() {
            continue;
        }
        let next=db.call(move|c| {
            Ok(c.query_row("SELECT f.id FROM files f JOIN library_folders folders ON folders.id=f.folder_id
                WHERE folders.user_id=?1 AND NOT EXISTS(SELECT 1 FROM file_tags ft WHERE ft.file_id=f.id AND lower(ft.source) IN (SELECT lower(value) FROM json_each(?2)) AND ft.source_url IS NOT NULL)
                AND NOT EXISTS(SELECT 1 FROM provider_runs r WHERE r.file_id=f.id AND r.created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'))
                AND NOT EXISTS(SELECT 1 FROM provider_runs r WHERE r.file_id=f.id AND r.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'))
                ORDER BY f.created_at,f.id LIMIT 1",rusqlite::params![OWNER_ID,targets.to_string()],|r|r.get::<_,String>(0)).optional()?)
        }).await;
        match next {
            Ok(Some(id)) => {
                if let Err(error) = run(&db, &id, "FLUFFLE").await {
                    eprintln!("Automatic image search: {error}");
                }
                let sauce_ready = match key(&db).await {
                    Ok(key) => key.is_some_and(|k| !k.is_empty()),
                    Err(error) => {
                        eprintln!("Cannot read SauceNAO settings: {error}");
                        false
                    }
                };
                if sauce_ready {
                    let check = id.clone();
                    let matched = match db.call(move |c| source_store::matched(c, &check)).await {
                        Ok(matched) => matched,
                        Err(error) => {
                            eprintln!("Cannot inspect known sources: {error}");
                            true
                        }
                    };
                    if !matched {
                        if let Err(error) = run(&db, &id, "SAUCENAO").await {
                            eprintln!("Automatic SauceNAO search: {error}");
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("Cannot read image search queue: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Json, Router};
    use std::{
        process::Command,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
    };

    #[tokio::test]
    async fn automatic_search_requires_an_enabled_selected_booru() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        db.call(|c| {
            c.execute("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,preset_key,enabled,sort_order,created_at,updated_at)
                VALUES ('active',?1,'Example','e621','https://example.test',1,'E621',1,0,'now','now'),
                ('disabled',?1,'Disabled','danbooru','https://disabled.test',1,'DANBOORU',0,1,'now','now')", [OWNER_ID])?;
            crate::db::write_setting(c,"source_targets", &json!(["WD14","MANUAL","unknown","DANBOORU"]))?;
            assert_eq!(automatic_targets(c)?, json!([]));
            crate::db::write_setting(c,"source_targets", &json!(["E621","active","DANBOORU"]))?;
            assert_eq!(automatic_targets(c)?, json!(["e621"]));
            c.execute("UPDATE user_booru_sites SET enabled=0 WHERE id='active'", [])?;
            assert_eq!(automatic_targets(c)?, json!([]));
            assert_eq!(read_setting(c,"source_targets", &json!([]))?, json!(["E621","active","DANBOORU"]));
            Ok(())
        }).await.unwrap();
    }

    #[test]
    fn selects_the_most_confident_source_per_site() {
        assert_eq!(
            select_sources(vec![
                ("e621".into(), "https://e621.net/posts/1".into(), 0.0),
                ("e621".into(), "https://e621.net/posts/2".into(), 91.0),
                ("e621".into(), "https://e621.net/posts/3".into(), 98.0),
                (
                    "danbooru".into(),
                    "https://danbooru.donmai.us/posts/4".into(),
                    100.0
                ),
            ]),
            vec![
                (
                    "danbooru".into(),
                    "https://danbooru.donmai.us/posts/4".into()
                ),
                ("e621".into(), "https://e621.net/posts/3".into()),
            ]
        );
    }

    #[tokio::test]
    async fn video_search_uses_an_interior_frame_instead_of_the_title_screen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("clip.mp4");
        let status = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=64x32:d=0.05",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x32:d=1.95",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0",
                "-c:v",
                "mpeg4",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        let bytes = media::source_image(&path, MediaKind::Video, Some(2000))
            .await
            .unwrap();
        let preview = directory.path().join("preview.png");
        std::fs::write(&preview, bytes).unwrap();
        let decoded = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(preview)
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        assert!(decoded.status.success());
        let pixel = &decoded.stdout[..3];
        assert!(
            pixel[2] > 200 && pixel[0] < 20 && pixel[1] < 20,
            "{pixel:?}"
        );
    }

    #[tokio::test]
    async fn cancels_queued_searches_and_allows_a_fresh_request() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        let guard = db.sources.writes.lock().await;
        let mut queued = Vec::new();
        for _ in 0..MAX_QUEUED_SEARCHES {
            let db = db.clone();
            queued.push(tokio::spawn(
                async move { run(&db, "missing", "FLUFFLE").await },
            ));
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while db.sources.queue.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(run(&db, "missing", "FLUFFLE")
            .await
            .unwrap_err()
            .to_string()
            .contains("Another image search"));
        db.sources
            .cancel
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        for job in queued {
            let error = tokio::time::timeout(Duration::from_secs(1), job)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(error.to_string().contains("cancelled"));
        }
        drop(guard);
        assert_eq!(db.sources.queue.available_permits(), MAX_QUEUED_SEARCHES);
        assert!(run(&db, "missing", "FLUFFLE").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn searches_a_scanned_file_and_keeps_good_matches_when_provider_fails() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        assert!(boorus::sites(&db).await.unwrap().is_empty());
        let status = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x32",
                "-frames:v",
                "1",
            ])
            .arg(db.library().root.join("sample.png"))
            .status()
            .unwrap();
        assert!(status.success());
        crate::library::scan(&db).await.unwrap();
        let id = db
            .call(|c| {
                Ok(c.query_row("SELECT id FROM files LIMIT 1", [], |r| {
                    r.get::<_, String>(0)
                })?)
            })
            .await
            .unwrap();
        let fail = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let (failed, count) = (fail.clone(), calls.clone());
        let app=Router::new().route("/search",post(move|| {
            let (fail,calls)=(failed.clone(),count.clone());
            async move {
                calls.fetch_add(1,Ordering::SeqCst);
                if fail.load(Ordering::SeqCst) {return StatusCode::TOO_MANY_REQUESTS.into_response();}
                Json(json!({"results":[{"url":"https://e621.net/posts/7","platform":"e621","match":"exact","distance":0.05}]})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/search", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let transport = Transport {
            allow_loopback: true,
        };
        let result = run_with(&db, &id, "FLUFFLE", &transport, Some(&endpoint))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["status"], "COMPLETED");
        assert_eq!(result["sourceUrl"], "https://e621.net/posts/7");
        assert_eq!(result["score"].as_f64(), Some(100.0));
        fail.store(true, Ordering::SeqCst);
        let error = run_with(&db, &id, "FLUFFLE", &transport, Some(&endpoint))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("request limit"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "uploads must not retry automatically"
        );
        let lookup = id.clone();
        let rows = db
            .call(move |c| source_store::runs(c, &lookup))
            .await
            .unwrap();
        assert_eq!(
            rows.iter().filter(|r| r["status"] == "COMPLETED").count(),
            1
        );
        assert_eq!(rows.iter().filter(|r| r["status"] == "FAILED").count(), 1);
        assert!(!rows.iter().any(|r| r["status"] == "RUNNING"));
        let lookup = id.clone();
        let listed = db
            .call(move |c| {
                let mut files = vec![json!({"id":lookup})];
                source_store::attach_runs(c, &mut files)?;
                Ok(files)
            })
            .await
            .unwrap();
        assert_eq!(listed[0]["providers"]["FLUFFLE"]["status"], "COMPLETED");
        assert_eq!(
            listed[0]["providers"]["FLUFFLE"]["sourceUrl"],
            "https://e621.net/posts/7"
        );
        server.abort();
        let _ = server.await;
        drop(db);
        let db = Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        assert_eq!(
            db.call(move |c| Ok(source_store::runs(c, &id)?.len()))
                .await
                .unwrap(),
            2
        );
    }
}
