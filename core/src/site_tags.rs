//! Re-reads the posts a booru site tagged, so tags stored before the engine
//! could see categories get them. Reads before it writes and removes nothing
//! up front: a site that starts challenging its callers costs a run and leaves
//! the library alone.

use crate::{
    booru_favorites as remote,
    booru_http::Transport,
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    files::not_found,
    library, source_store, Error, Result,
};
use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

/// Between posts. A booru starts challenging a faster caller than this.
const REQUEST_INTERVAL: Duration = Duration::from_millis(1_500);
const BATCH: i64 = 100;

pub(crate) struct Job {
    state: Mutex<Value>,
    running: Arc<tokio::sync::Mutex<()>>,
    cancelled: AtomicBool,
}

impl Default for Job {
    fn default() -> Self {
        Self {
            state: Mutex::new(
                json!({"status":"idle","siteId":null,"processed":0,"total":0,"updated":0,"unchanged":0,"failed":0,"startedAt":null,"updatedAt":now(),"error":null}),
            ),
            running: Arc::default(),
            cancelled: AtomicBool::new(false),
        }
    }
}

fn now() -> String {
    library::iso_millis(std::time::SystemTime::now())
}

impl Job {
    fn state(&self) -> Result<Value> {
        Ok(self
            .state
            .lock()
            .map_err(|_| Error::Storage("Tag refresh state lock poisoned.".into()))?
            .clone())
    }
    fn update(&self, operation: impl FnOnce(&mut Value)) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("Tag refresh state lock poisoned.".into()))?;
        operation(&mut state);
        state["updatedAt"] = json!(now());
        Ok(())
    }
    fn count(&self, field: &str) -> Result<()> {
        self.update(|s| {
            s["processed"] = json!(s["processed"].as_u64().unwrap_or(0) + 1);
            s[field] = json!(s[field].as_u64().unwrap_or(0) + 1);
        })
    }
}

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/booru-sites/{id}/tags/refresh", post(start))
        .route("/booru-sites/tags/refresh", get(progress))
        .route("/booru-sites/tags/refresh/cancel", post(cancel))
}

async fn progress(State(db): State<Database>) -> Result<Json<Value>> {
    Ok(Json(db.site_tags.state()?))
}

async fn cancel(State(db): State<Database>) -> Json<Value> {
    let running = db.site_tags.running.try_lock().is_err();
    if running {
        db.site_tags.cancelled.store(true, Ordering::SeqCst);
    }
    Json(json!({"cancelled":running}))
}

/// Files tagged from a source with a post address and no categorised tag.
const STALE: &str = "FROM file_tags t
    JOIN files f ON f.id=t.file_id JOIN library_folders fo ON fo.id=f.folder_id
    WHERE t.source=?1 AND fo.user_id=?2 AND t.source_url IS NOT NULL";
const UNCATEGORISED: &str = "GROUP BY t.file_id HAVING SUM(t.category<>'general')=0";

/// Up to `limit` targets after `after`, in file order.
fn targets(
    c: &rusqlite::Connection,
    source: &str,
    after: &str,
    limit: i64,
) -> Result<Vec<(String, String)>> {
    let mut statement = c.prepare(&format!(
        "SELECT t.file_id,MAX(t.source_url) {STALE} AND t.file_id>?3 {UNCATEGORISED} ORDER BY t.file_id LIMIT ?4"
    ))?;
    let rows = statement
        .query_map(params![source, OWNER_ID, after, limit], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

async fn start(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let Ok(guard) = db.site_tags.running.clone().try_lock_owned() else {
        return Ok(Json(json!({"status":"busy","progress":db.site_tags.state()?})).into_response());
    };
    let Some(site) = boorus::site(&db, id.clone()).await? else {
        return Ok(not_found("Site"));
    };
    // A disabled site receives no requests.
    if !site.enabled {
        return Err(Error::Invalid(
            "Turn this site on in Accounts to re-read its tags.".into(),
        ));
    }
    let key = remote::provider(&site);
    let total = db
        .call(move |c| {
            Ok(c.query_row(
                &format!("SELECT count(*) FROM (SELECT 1 {STALE} {UNCATEGORISED})"),
                params![key, OWNER_ID],
                |r| r.get::<_, i64>(0),
            )?)
        })
        .await?;
    db.site_tags.cancelled.store(false, Ordering::SeqCst);
    db.site_tags.update(|s| {
        *s = json!({"status":"running","siteId":id,"processed":0,"total":total,"updated":0,"unchanged":0,"failed":0,"startedAt":now(),"updatedAt":now(),"error":null});
    })?;
    let worker = db.clone();
    tokio::spawn(async move {
        let _guard = guard;
        let result = run(&worker, &Transport::default(), &site, REQUEST_INTERVAL).await;
        let reported = worker.site_tags.update(|s| match result {
            Ok(()) => s["status"] = json!("done"),
            Err(error) => {
                s["status"] = json!("error");
                s["error"] = json!(error.to_string());
            }
        });
        if let Err(error) = reported {
            eprintln!("Cannot report tag refresh: {error}");
        }
    });
    Ok(Json(json!({"status":"started","progress":db.site_tags.state()?})).into_response())
}

async fn run(db: &Database, t: &Transport, site: &Site, interval: Duration) -> Result<()> {
    let key = remote::provider(site);
    let mut after = String::new();
    let mut first = true;
    loop {
        let (source, cursor) = (key.clone(), after.clone());
        let batch = db
            .call(move |c| targets(c, &source, &cursor, BATCH))
            .await?;
        let Some((last, _)) = batch.last() else {
            return Ok(());
        };
        after = last.clone();
        for (file, url) in batch {
            if !first {
                tokio::time::sleep(interval).await;
            }
            first = false;
            if db.site_tags.cancelled.load(Ordering::SeqCst) {
                return Ok(());
            }
            match refresh(db, t, site, file.clone(), &url).await {
                Ok(true) => db.site_tags.count("updated")?,
                Ok(false) => db.site_tags.count("unchanged")?,
                // One unreachable post is no reason to abandon the rest.
                Err(error) => {
                    eprintln!("Tag refresh failed for file {file}: {error}");
                    db.site_tags.count("failed")?;
                }
            }
        }
    }
}

async fn refresh(
    db: &Database,
    t: &Transport,
    site: &Site,
    file: String,
    url: &str,
) -> Result<bool> {
    let Some(post) = source_store::candidate(site, url) else {
        return Ok(false);
    };
    let Some(snapshot) = db.call(move |c| source_store::file(c, &file)).await? else {
        return Ok(false);
    };
    let Some(tagged) = crate::explore::tagged_post(t, site, &post).await? else {
        return Ok(false);
    };
    let _guard = db.sources.writes.lock().await;
    let (site, url) = (site.clone(), url.to_owned());
    // apply_tags keeps categorised tags when the answer has none.
    db.call(move |c| source_store::apply_tags(c, &snapshot, &site, &url, &tagged))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::NOW;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    async fn request(db: &Database, method: &str, path: &str) -> (u16, Value) {
        let response = routes()
            .with_state(db.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn seed(c: &rusqlite::Connection, base: &str, root: &std::path::Path) -> rusqlite::Result<()> {
        c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,username,api_key,is_preset,enabled,sort_order,created_at,updated_at) VALUES ('fixture',?1,'Fixture','e621',?2,'fake-user','fake-key',0,1,0,{NOW},{NOW})"),params![OWNER_ID,base])?;
        c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,?2,'LOCAL','IDLE',{NOW},{NOW})"),params![OWNER_ID,root.to_string_lossy()])?;
        c.execute(
            "INSERT INTO active_library_folders (id) VALUES ('folder')",
            [],
        )?;
        for (id, category) in [("stale", "general"), ("categorised", "artist")] {
            let path = root.join(format!("{id}.png"));
            c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES (?1,'folder','LOCAL',?2,1,{NOW},?1,'IMAGE',{NOW},{NOW})"),params![id,path.to_string_lossy()])?;
            c.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,source_url,created_at,updated_at) VALUES (?1,'old_tag','old_tag',?2,'fixture',?3,{NOW},{NOW})"),params![id,category,format!("{base}/posts/7")])?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn rereads_only_uncategorised_posts_and_keeps_tags_it_cannot_improve() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let app = Router::new().route(
            "/posts.json",
            get(|| async {
                Json(json!({"posts":[{"id":7,"file":{"url":null},"tags":{"artist":["new_artist"],"general":["new_tag"]},"pools":[],"relationships":{}}]}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = db.library().root.clone();
        db.call(move |c| Ok(seed(c, &base, &root)?)).await.unwrap();
        let site = boorus::site(&db, "fixture".into()).await.unwrap().unwrap();
        db.site_tags.update(|s| s["processed"] = json!(0)).unwrap();
        run(
            &db,
            &Transport {
                allow_loopback: true,
            },
            &site,
            Duration::ZERO,
        )
        .await
        .unwrap();
        server.abort();
        let state = db.site_tags.state().unwrap();
        assert_eq!(
            (state["processed"].as_u64(), state["updated"].as_u64()),
            (Some(1), Some(1)),
            "{state}"
        );
        let tags = db
            .call(|c| {
                let mut s =
                    c.prepare("SELECT file_id,tag,category FROM file_tags ORDER BY file_id,tag")?;
                let rows = s
                    .query_map([], |r| {
                        Ok(format!(
                            "{}:{}:{}",
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .unwrap();
        assert_eq!(
            tags,
            [
                "categorised:old_tag:artist",
                "stale:new_artist:artist",
                "stale:new_tag:general"
            ]
        );
    }

    #[tokio::test]
    async fn reports_missing_sites_busy_runs_and_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        assert_eq!(
            request(&db, "POST", "/booru-sites/missing/tags/refresh")
                .await
                .0,
            404
        );
        assert_eq!(
            request(&db, "POST", "/booru-sites/tags/refresh/cancel")
                .await
                .1["cancelled"],
            false
        );
        let held = db.site_tags.running.clone().try_lock_owned().unwrap();
        assert_eq!(
            request(&db, "POST", "/booru-sites/missing/tags/refresh")
                .await
                .1["status"],
            "busy"
        );
        assert_eq!(
            request(&db, "POST", "/booru-sites/tags/refresh/cancel")
                .await
                .1["cancelled"],
            true
        );
        drop(held);
        let root = db.library().root.clone();
        db.call(move |c| Ok(seed(c, "http://127.0.0.1:1", &root)?))
            .await
            .unwrap();
        db.call(|c| Ok(c.execute("UPDATE user_booru_sites SET enabled=0", [])?))
            .await
            .unwrap();
        let (status, refused) = request(&db, "POST", "/booru-sites/fixture/tags/refresh").await;
        assert_eq!(status, 400, "{refused}");
        assert_eq!(db.site_tags.state().unwrap()["status"], "idle");
        db.call(|c| Ok(c.execute("UPDATE user_booru_sites SET enabled=1", [])?))
            .await
            .unwrap();
        let (status, started) = request(&db, "POST", "/booru-sites/fixture/tags/refresh").await;
        assert_eq!((status, started["status"].as_str()), (200, Some("started")));
        assert_eq!(started["progress"]["total"], 1);
        assert_eq!(started["progress"]["siteId"], "fixture");
        assert!(!started.to_string().contains("fake-key"));
    }
}
