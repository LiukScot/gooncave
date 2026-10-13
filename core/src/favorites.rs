use crate::{
    booru_engines as engines, booru_favorites as remote,
    booru_http::Transport,
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    library, Error, Result,
};
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
use tokio::sync::{watch, Notify};

use crate::favorite_library::{import, remove_local};
pub(crate) struct Job {
    state: Mutex<Value>,
    pending: Mutex<Option<(Vec<Site>, bool)>>,
    ready: Notify,
    cancel: watch::Sender<bool>,
    pub(crate) changes: Mutex<HashMap<(String, String), bool>>,
    pub(crate) writes: tokio::sync::Mutex<()>,
}
impl Default for Job {
    fn default() -> Self {
        Self {
            state: Mutex::new(
                json!({"status":"idle","message":"Idle","startedAt":null,"updatedAt":now(),"progress":null,"results":[]}),
            ),
            pending: Mutex::new(None),
            ready: Notify::new(),
            cancel: watch::channel(false).0,
            changes: Mutex::new(HashMap::new()),
            writes: tokio::sync::Mutex::new(()),
        }
    }
}
fn now() -> String {
    library::iso_millis(std::time::SystemTime::now())
}
impl Job {
    pub(crate) fn mark_removed(&self, provider: String, id: &str, removed: bool) -> Result<()> {
        let running = self.state()?["status"] == "running";
        let mut changes = self
            .changes
            .lock()
            .map_err(|_| Error::Storage("Favorites change lock poisoned.".into()))?;
        if running {
            changes.insert((provider, id.to_owned()), removed);
        } else {
            changes.remove(&(provider, id.to_owned()));
        }
        Ok(())
    }
    fn state(&self) -> Result<Value> {
        Ok(self
            .state
            .lock()
            .map_err(|_| Error::Storage("Favorites state lock poisoned.".into()))?
            .clone())
    }
    fn update(&self, operation: impl FnOnce(&mut Value)) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Storage("Favorites state lock poisoned.".into()))?;
        operation(&mut state);
        state["updatedAt"] = json!(now());
        Ok(())
    }
}
pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/favorites/sync/status", get(status))
        .route("/favorites/sync", post(start))
        .route("/favorites/sync/cancel", post(cancel))
        .route("/explore/favorite", post(favorite))
        .route("/explore/unfavorite", post(unfavorite))
}
async fn status(State(db): State<Database>) -> Result<Json<Value>> {
    Ok(Json(db.favorites.state()?))
}
fn body(
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Value> {
    let Json(v) = p.map_err(|_| Error::Invalid("Send a valid JSON object.".into()))?;
    if !v.is_object() {
        return Err(Error::Invalid("Send a JSON object.".into()));
    }
    Ok(v)
}
async fn start(
    State(db): State<Database>,
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let v = body(p)?;
    if v.get("deleteMissing").is_some_and(|v| !v.is_boolean()) {
        return Err(Error::Invalid(
            "deleteMissing must be true or false.".into(),
        ));
    }
    let wanted = match v.get("providers") {
        None => None,
        Some(Value::Array(values)) if !values.is_empty() && values.len() <= 32 => Some(
            values
                .iter()
                .map(|v| {
                    v.as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 100)
                        .map(str::to_owned)
                        .ok_or_else(|| Error::Invalid("Choose valid provider IDs.".into()))
                })
                .collect::<Result<HashSet<_>>>()?,
        ),
        _ => return Err(Error::Invalid("Choose between 1 and 32 providers.".into())),
    };
    let all = boorus::sites(&db).await?;
    if let Some(ref wanted) = wanted {
        if wanted.iter().any(|id| {
            !all.iter()
                .any(|s| &s.id == id || &remote::provider(s) == id)
        }) {
            return Err(Error::Invalid(
                "A selected site no longer exists. Reload Accounts.".into(),
            ));
        }
    }
    let sites = all
        .into_iter()
        .filter(|s| {
            s.enabled
                && remote::supported(&s.engine)
                && (wanted.is_some() || remote::require(s, false).is_ok())
                && wanted
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&s.id) || ids.contains(&remote::provider(s)))
        })
        .collect::<Vec<_>>();
    if sites.is_empty() {
        return Err(Error::Invalid(
            "Add and enable an account that supports favorites, then save its credentials in Accounts.".into(),
        ));
    }
    for site in &sites {
        remote::require(site, false)?;
    }
    let mut pending = db
        .favorites
        .pending
        .lock()
        .map_err(|_| Error::Storage("Favorites queue lock poisoned.".into()))?;
    if db.favorites.state()?["status"] == "running" {
        return Ok(Json(json!({"status":"busy","state":db.favorites.state()?})));
    }
    db.favorites.cancel.send_replace(false);
    db.favorites
        .changes
        .lock()
        .map_err(|_| Error::Storage("Favorites change lock poisoned.".into()))?
        .clear();
    db.favorites.update(|s|*s=json!({"status":"running","message":"Fetching favorites","startedAt":now(),"updatedAt":now(),"progress":{"providers":[]},"results":[]}))?;
    *pending = Some((sites, v["deleteMissing"].as_bool().unwrap_or(false)));
    db.favorites.ready.notify_one();
    Ok(Json(
        json!({"status":"started","state":db.favorites.state()?}),
    ))
}
async fn cancel(State(db): State<Database>) -> Result<Json<Value>> {
    let running = db.favorites.state()?["status"] == "running";
    if running {
        db.favorites.cancel.send_replace(true);
    }
    Ok(Json(
        json!({"status":if running {"cancelling"}else{"idle"},"state":db.favorites.state()?}),
    ))
}
pub(crate) async fn watch(db: Database) {
    loop {
        db.favorites.ready.notified().await;
        let pending = match db.favorites.pending.lock() {
            Ok(mut p) => p.take(),
            Err(_) => {
                eprintln!("Favorites queue lock poisoned");
                return;
            }
        };
        let Some((sites, delete_missing)) = pending else {
            continue;
        };
        let mut cancelled = db.favorites.cancel.subscribe();
        let transport = Transport::default();
        let result = if *cancelled.borrow() {
            Err(Error::Invalid(
                "Favorites sync cancelled. Imported files were kept.".into(),
            ))
        } else {
            tokio::select! {result=sync(&db,&transport,sites,delete_missing)=>result,_=cancelled.changed()=>Err(Error::Invalid("Favorites sync cancelled. Imported files were kept.".into()))}
        };
        if let Err(error) = db.favorites.update(|s| {
            s["status"] = json!(if result.is_ok() { "done" } else { "error" });
            s["message"] =
                json!(result.map_or_else(|e| e.to_string(), |_| "Favorites sync complete".into()));
        }) {
            eprintln!("Cannot report favorites sync: {error}");
        }
    }
}
fn progress(site: &Site) -> Value {
    json!({"provider":remote::provider(site),"siteName":site.name,"stage":"fetching","fetched":0,"total":0,"processed":0,"added":0,"removed":0,"skipped":0,"errors":[]})
}
async fn sync(db: &Database, t: &Transport, sites: Vec<Site>, delete_missing: bool) -> Result<()> {
    let mut failed = false;
    for site in sites {
        let mut p = progress(&site);
        let result = sync_site(db, t, &site, delete_missing, &mut p).await;
        if let Err(error) = result {
            failed = true;
            p["stage"] = json!("error");
            p["errors"]
                .as_array_mut()
                .unwrap()
                .push(json!(error.to_string()));
        } else {
            p["stage"] = json!("done");
        }
        db.favorites.update(|s| {
            s["results"].as_array_mut().unwrap().push(p.clone());
            s["progress"]["providers"] = json!([p]);
        })?;
    }
    if failed {
        Err(Error::Invalid(
            "Some favorites could not be imported. Check the account errors and retry.".into(),
        ))
    } else {
        Ok(())
    }
}
async fn sync_site(
    db: &Database,
    t: &Transport,
    site: &Site,
    delete_missing: bool,
    p: &mut Value,
) -> Result<()> {
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut seen = HashSet::new();
    for n in 1..=remote::PAGE_LIMIT {
        let (posts, next) = remote::page(t, site, n, cursor).await?;
        let done = if site.engine == "furaffinity" {
            next.is_none()
        } else {
            posts.len() < remote::PAGE_SIZE
        };
        if let Some(ref url) = next {
            if !cursors.insert(url.to_string()) {
                return Err(Error::Remote(
                    "The favorites page repeated. Sync stopped safely.".into(),
                ));
            }
        }
        let mut fresh = 0;
        for post in posts {
            let id = engines::id(&post["remoteId"])?;
            if !seen.insert(id.clone()) {
                continue;
            }
            fresh += 1;
            p["fetched"] = json!(seen.len());
            p["total"] = json!(seen.len());
            p["stage"] = json!("downloading");
            {
                let _guard = db.favorites.writes.lock().await;
                let removed = db
                    .favorites
                    .changes
                    .lock()
                    .map_err(|_| Error::Storage("Favorites change lock poisoned.".into()))?
                    .get(&(remote::provider(site), id.clone()))
                    == Some(&true);
                let imported = if removed {
                    Ok((String::new(), false))
                } else {
                    import(db, t, site, &id, Some(post)).await
                };
                match imported {
                    Ok((_, added)) => {
                        let field = if added { "added" } else { "skipped" };
                        p[field] = json!(p[field].as_u64().unwrap() + 1);
                    }
                    Err(error) => {
                        let errors = p["errors"].as_array_mut().unwrap();
                        if errors.len() < 100 {
                            errors.push(json!(error.to_string()));
                        }
                    }
                }
            }
            p["processed"] = json!(seen.len());
            db.favorites.update(|s| {
                s["message"] = json!(format!("{}: importing favorites", site.name));
                s["progress"]["providers"] = json!([p]);
            })?;
        }
        if done {
            if delete_missing && p["errors"].as_array().unwrap().is_empty() {
                p["stage"] = json!("deleting");
                let mut after = String::new();
                loop {
                    let provider = remote::provider(site);
                    let cursor = after.clone();
                    let items=db.call(move|c|{let mut s=c.prepare("SELECT remote_id FROM favorite_items WHERE user_id=?1 AND provider=?2 AND remote_id>?3 ORDER BY remote_id LIMIT 100")?;let rows=s.query_map(params![OWNER_ID,provider,cursor],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)}).await?;
                    if items.is_empty() {
                        break;
                    }
                    after = items.last().unwrap().clone();
                    for id in items {
                        if !seen.contains(&id) {
                            let _guard = db.favorites.writes.lock().await;
                            let added = db
                                .favorites
                                .changes
                                .lock()
                                .map_err(|_| {
                                    Error::Storage("Favorites change lock poisoned.".into())
                                })?
                                .get(&(remote::provider(site), id.clone()))
                                == Some(&false);
                            if added {
                                continue;
                            }
                            remove_local(db, site, &id).await?;
                            p["removed"] = json!(p["removed"].as_u64().unwrap() + 1);
                        }
                    }
                }
            }
            return if p["errors"].as_array().unwrap().is_empty() {
                Ok(())
            } else {
                Err(Error::Remote(
                    "Some files could not be saved. Retry sync to import them.".into(),
                ))
            };
        }
        if fresh == 0 {
            return Err(Error::Remote(
                "The favorites page repeated. Sync stopped safely.".into(),
            ));
        }
        cursor = next;
    }
    Err(Error::Remote(
        "Favorites exceeded the safe pagination limit. Sync stopped safely.".into(),
    ))
}
async fn action_site(db: &Database, v: &Value) -> Result<(Site, String)> {
    let site_id = v["siteId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or_else(|| Error::Invalid("Choose a site.".into()))?;
    let id = engines::id(&v["remoteId"])
        .map_err(|_| Error::Invalid("Choose a valid post ID.".into()))?;
    let site = boorus::site(db, site_id.into())
        .await?
        .ok_or_else(|| Error::Invalid("Site not found. Reload Accounts.".into()))?;
    remote::require(&site, true)?;
    Ok((site, id))
}
async fn favorite(
    State(db): State<Database>,
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let v = body(p)?;
    let (site, id) = action_site(&db, &v).await?;
    if v.get("autoVote").is_some_and(|v| !v.is_boolean()) {
        return Err(Error::Invalid("autoVote must be true or false.".into()));
    }
    if let Some(raw) = v.get("fileUrl") {
        let raw = raw
            .as_str()
            .filter(|s| s.len() <= 5000)
            .ok_or_else(|| Error::Invalid("Invalid file address.".into()))?;
        if !raw.starts_with("/explore/media/") {
            crate::booru_http::url(raw)?;
        }
    }
    let _guard = db.favorites.writes.lock().await;
    let t = Transport::default();
    remote::set(&t, &site, &id, true).await?;
    crate::subscription_store::favorite_override(&db, &site.id, &id, true).await?;
    db.favorites
        .mark_removed(remote::provider(&site), &id, false)?;
    // Resolve media from the authenticated post, never from an arbitrary client-supplied URL.
    let (file_id,_)=import(&db,&t,&site,&id,None).await.map_err(|_|Error::Remote("The remote favorite was saved, but its local copy could not be imported. Retry Sync favorites in Accounts.".into()))?;
    Ok(Json(
        json!({"ok":true,"fileId":file_id,"voteError":if v["autoVote"]==true {json!("Voting is not available in this build. The favorite was saved.")}else{Value::Null}}),
    ))
}
async fn unfavorite(
    State(db): State<Database>,
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let v = body(p)?;
    let (site, id) = action_site(&db, &v).await?;
    let _guard = db.favorites.writes.lock().await;
    remote::set(&Transport::default(), &site, &id, false).await?;
    crate::subscription_store::favorite_override(&db, &site.id, &id, false).await?;
    db.favorites
        .mark_removed(remote::provider(&site), &id, true)?;
    let removed = remove_local(&db, &site, &id).await?;
    Ok(Json(json!({"ok":true,"removedLocalFile":removed})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::NOW;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    async fn request(db: &Database, method: &str, path: &str, v: Value) -> (u16, Value) {
        let response = routes()
            .with_state(db.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(v.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[tokio::test]
    async fn sync_does_not_restore_a_favorite_removed_after_its_page_was_fetched() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let app=axum::Router::new().route("/posts.json",axum::routing::get(||async{Json(json!({"posts":[{"id":7,"file":{"url":null},"tags":{},"pools":[],"relationships":{}}]}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site = Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "e621".into(),
            base: format!("http://{}", listener.local_addr().unwrap()),
            username: Some("fake-user".into()),
            key: Some("fake-key".into()),
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        db.favorites
            .changes
            .lock()
            .unwrap()
            .insert(("fixture".into(), "7".into()), true);
        let mut progress = progress(&site);
        let result = sync_site(
            &db,
            &Transport {
                allow_loopback: true,
            },
            &site,
            false,
            &mut progress,
        )
        .await;
        server.abort();
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(progress["skipped"], 1);
        assert_eq!(progress["added"], 0);
    }
    #[tokio::test]
    async fn sync_keeps_favorites_added_after_its_remote_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let app = axum::Router::new().route(
            "/posts.json",
            axum::routing::get(|| async { Json(json!({"posts":[]})) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site = Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "e621".into(),
            base: format!("http://{}", listener.local_addr().unwrap()),
            username: Some("fake-user".into()),
            key: Some("fake-key".into()),
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        db.call(|c|{c.execute(&format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,created_at,updated_at) VALUES (?1,'fixture','8','new-copy.png',{NOW},{NOW})"),[OWNER_ID])?;Ok(())}).await.unwrap();
        db.favorites
            .changes
            .lock()
            .unwrap()
            .insert(("fixture".into(), "8".into()), false);
        sync_site(
            &db,
            &Transport {
                allow_loopback: true,
            },
            &site,
            true,
            &mut progress(&site),
        )
        .await
        .unwrap();
        db.call(|c|{assert_eq!(c.query_row("SELECT count(*) FROM favorite_items WHERE provider='fixture' AND remote_id='8'",[],|r|r.get::<_,i64>(0))?,1);Ok(())}).await.unwrap();
        server.abort();
    }
    #[tokio::test]
    async fn sync_validates_accounts_reports_busy_and_cancels_queued_work_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        assert_eq!(
            request(&db, "POST", "/favorites/sync", json!({})).await.0,
            400
        );
        db.call(|c|{c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,username,api_key,is_preset,enabled,sort_order,created_at,updated_at) VALUES ('example',?1,'Example','e621','https://example.org','fake-user','fake-key',0,1,0,{NOW},{NOW})"),[OWNER_ID])?;Ok(())}).await.unwrap();
        db.call(|c|{c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at) VALUES ('browse-only',?1,'Browse only','danbooru','https://browse.example.org',0,1,1,{NOW},{NOW})"),[OWNER_ID])?;Ok(())}).await.unwrap();
        for v in [
            json!({"providers":[]}),
            json!({"providers":["missing"]}),
            json!({"deleteMissing":"true"}),
        ] {
            assert_eq!(request(&db, "POST", "/favorites/sync", v).await.0, 400);
        }
        let (status, result) = request(&db, "POST", "/favorites/sync", json!({})).await;
        assert_eq!(status, 200);
        assert_eq!(result["status"], "started");
        assert!(!result.to_string().contains("fake-key"));
        assert_eq!(
            request(&db, "POST", "/favorites/sync", json!({})).await.1["status"],
            "busy"
        );
        assert_eq!(
            request(&db, "POST", "/favorites/sync/cancel", json!({}))
                .await
                .1["status"],
            "cancelling"
        );
        let worker = tokio::spawn(watch(db.clone()));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while db.favorites.state().unwrap()["status"] == "running" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let state = db.favorites.state().unwrap();
        assert_eq!(state["status"], "error");
        assert!(state["message"].as_str().unwrap().contains("cancelled"));
        worker.abort();
        let _ = worker.await;

        db.call(|c| {
            c.execute(
                "UPDATE user_booru_sites SET base_url='http://127.0.0.1:1' WHERE id='example'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let (status,error)=request(&db,"POST","/explore/favorite",json!({"siteId":"example","remoteId":"7","fileUrl":"/explore/media/file.png?siteId=example&u=fake&s=fake"})).await;
        assert_eq!(status, 502, "{error}");
        assert!(!error.to_string().contains("Invalid file address"));
        let (status, _) = request(
            &db,
            "POST",
            "/explore/favorite",
            json!({"siteId":"example","remoteId":"../7"}),
        )
        .await;
        assert_eq!(status, 400);
    }
}
