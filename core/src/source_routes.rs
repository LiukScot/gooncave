use crate::{
    db::{read_setting, write_setting, Database, OWNER_ID},
    files::{file_exists, not_found},
    library::NOW,
    source_jobs, source_store, Error, Result,
};
use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/credentials", get(credentials).put(save_credential))
        .route("/sources", get(sources))
        .route("/sources/settings", axum::routing::put(save_settings))
        .route("/sources/cancel", post(cancel))
        .route("/files/{id}/providers", get(providers))
        .route("/files/{id}/providers/{provider}", post(search))
        .route("/files/{id}/tags/refresh", post(refresh))
        .route("/files/{id}/matches/remove", post(remove_match))
}

fn credential(c: &rusqlite::Connection) -> Result<Value> {
    let saved:Option<(Option<String>,Option<String>,String)>=c.query_row("SELECT username,api_key,updated_at FROM provider_credentials WHERE user_id=?1 AND provider='SAUCENAO'",[OWNER_ID],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    Ok(match saved {
        Some((username, key, time)) => {
            json!({"provider":"SAUCENAO","username":username,"hasApiKey":key.is_some_and(|s|!s.is_empty()),"source":"db","updatedAt":time})
        }
        None => {
            json!({"provider":"SAUCENAO","username":null,"hasApiKey":false,"source":"none","updatedAt":null})
        }
    })
}

async fn credentials(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| Ok(Json(json!({"credentials":[credential(c)?]}))))
        .await
}

async fn save_credential(
    State(db): State<Database>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let object = body
        .as_object()
        .ok_or_else(|| Error::Invalid("Send SauceNAO credentials as an object.".into()))?;
    if body["provider"] != "SAUCENAO"
        || object
            .keys()
            .any(|k| !["provider", "username", "apiKey"].contains(&k.as_str()))
    {
        return Err(Error::Invalid(
            "Use Accounts to change booru accounts. This form accepts SauceNAO only.".into(),
        ));
    }
    for name in ["username", "apiKey"] {
        if body.get(name).is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| s.len() > 4096 || s.chars().any(char::is_control))
        }) {
            return Err(Error::Invalid(
                "Enter valid SauceNAO account details.".into(),
            ));
        }
    }
    db.call(move|c| {
        let tx=c.transaction()?;
        let previous:Option<(Option<String>,Option<String>)>=tx.query_row("SELECT username,api_key FROM provider_credentials WHERE user_id=?1 AND provider='SAUCENAO'",[OWNER_ID],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let (username,key)=previous.unwrap_or_default();
        let username=body["username"].as_str().map(str::to_owned).or(username);
        let key=body["apiKey"].as_str().map(str::to_owned).or(key);
        tx.execute(&format!("INSERT INTO provider_credentials (user_id,provider,username,api_key,updated_at) VALUES (?1,'SAUCENAO',?2,?3,{NOW}) ON CONFLICT(user_id,provider) DO UPDATE SET username=excluded.username,api_key=excluded.api_key,updated_at=excluded.updated_at"),params![OWNER_ID,username,key])?;
        tx.commit()?;
        Ok(Json(json!({"credential":credential(c)?})))
    }).await
}

fn settings(c: &rusqlite::Connection) -> Result<Value> {
    Ok(
        json!({"display":read_setting(c,"source_display",&json!([]))?,"targets":read_setting(c,"source_targets",&json!([]))?,"displayInitialized":read_setting(c,"source_display_initialized",&json!(false))?}),
    )
}

fn overview(c: &rusqlite::Connection) -> Result<Value> {
    let config = settings(c)?;
    let mut s=c.prepare("SELECT lower(coalesce(site.preset_key,site.id)),site.name,coalesce(found.hits,0)
        FROM user_booru_sites site LEFT JOIN (
            SELECT ft.source,count(DISTINCT ft.file_id) AS hits FROM file_tags ft JOIN files f ON f.id=ft.file_id JOIN library_folders folders ON folders.id=f.folder_id
            WHERE folders.user_id=?1 AND ft.source_url IS NOT NULL GROUP BY ft.source
        ) found ON found.source=coalesce(site.preset_key,site.id)
        WHERE site.user_id=?1 AND site.enabled=1 ORDER BY coalesce(found.hits,0) DESC,site.sort_order,site.id LIMIT 64")?;
    let mut sources = s
        .query_map([OWNER_ID], |r| {
            let key = r.get::<_, String>(0)?;
            Ok(json!({"key":key,"label":r.get::<_,String>(1)?,"count":r.get::<_,i64>(2)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let wd14_count: i64 = c.query_row("SELECT count(DISTINCT ft.file_id) FROM file_tags ft JOIN files f ON f.id=ft.file_id JOIN library_folders folders ON folders.id=f.folder_id WHERE folders.user_id=?1 AND ft.source='WD14'",[OWNER_ID],|r|r.get(0))?;
    if wd14_count > 0 || crate::wd14_store::enabled(c)? {
        sources.push(json!({"key":"wd14","label":"WD14","count":wd14_count}));
    }
    let (total,matched,videos,failed,failed_videos):(i64,i64,i64,i64,i64)=c.query_row("SELECT count(*),
        coalesce(sum(EXISTS(SELECT 1 FROM file_tags ft WHERE ft.file_id=f.id AND lower(ft.source) IN (SELECT lower(value) FROM json_each(?2)) AND ft.source_url IS NOT NULL)),0),
        coalesce(sum(f.media_type='VIDEO'),0),
        coalesce(sum(NOT EXISTS(SELECT 1 FROM file_tags ft WHERE ft.file_id=f.id AND lower(ft.source) IN (SELECT lower(value) FROM json_each(?2)) AND ft.source_url IS NOT NULL)
            AND EXISTS(SELECT 1 FROM provider_runs r WHERE r.file_id=f.id AND r.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'))),0),
        coalesce(sum(f.media_type='VIDEO' AND NOT EXISTS(SELECT 1 FROM file_tags ft WHERE ft.file_id=f.id AND lower(ft.source) IN (SELECT lower(value) FROM json_each(?2)) AND ft.source_url IS NOT NULL)
            AND EXISTS(SELECT 1 FROM provider_runs r WHERE r.file_id=f.id AND r.created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'))),0)
        FROM files f JOIN library_folders folders ON folders.id=f.folder_id WHERE folders.user_id=?1 AND f.location_type='LOCAL'",params![OWNER_ID,config["targets"].to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    Ok(
        json!({"sources":sources,"settings":config,"progress":{"total":total,"matched":matched,"pending":total-matched-failed,"failed":failed,"videos":videos,"failedImages":failed-failed_videos,"failedVideos":failed_videos}}),
    )
}

async fn sources(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| Ok(Json(overview(c)?))).await
}

async fn save_settings(State(db): State<Database>, Json(body): Json<Value>) -> Result<Json<Value>> {
    let object = body
        .as_object()
        .ok_or_else(|| Error::Invalid("Send source settings as an object.".into()))?;
    for (name, value) in object {
        let valid = match name.as_str() {
            "display" | "targets" => value.as_array().is_some_and(|v| {
                v.len() <= 64
                    && v.iter().all(|v| {
                        v.as_str().is_some_and(|s| {
                            !s.is_empty()
                                && s.len() <= 200
                                && !s.chars().any(char::is_control)
                                && (name != "targets"
                                    || !(s.trim().eq_ignore_ascii_case("wd14")
                                        || s.trim().eq_ignore_ascii_case("manual")))
                        })
                    })
            }),
            "displayInitialized" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err(Error::Invalid("Choose valid file source settings.".into()));
        }
    }
    db.call(move |c| {
        let tx = c.transaction()?;
        for (name, key) in [
            ("display", "source_display"),
            ("targets", "source_targets"),
            ("displayInitialized", "source_display_initialized"),
        ] {
            if let Some(value) = body.get(name) {
                write_setting(&tx, key, value)?;
            }
        }
        tx.commit()?;
        let view = overview(c)?;
        Ok(Json(
            json!({"settings":view["settings"],"progress":view["progress"]}),
        ))
    })
    .await
}

async fn providers(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    db.call(move |c| {
        if !file_exists(c, &id)? {
            return Ok(not_found("File"));
        }
        Ok(Json(json!({"providers":source_store::runs(c,&id)?})).into_response())
    })
    .await
}

async fn search(
    State(db): State<Database>,
    Path((id, provider)): Path<(String, String)>,
) -> Result<Response> {
    Ok(
        match source_jobs::run(&db, &id, &provider.to_ascii_uppercase()).await? {
            Some(run) => Json(json!({"providerRun":run})).into_response(),
            None => not_found("File"),
        },
    )
}

async fn refresh(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    Ok(match source_jobs::refresh_file(&db, &id).await? {
        Some(updated) => Json(json!({"job":{"id":uuid::Uuid::new_v4().to_string(),"fileId":id,"status":"done","error":null},"updated":updated})).into_response(),
        None => not_found("File"),
    })
}

async fn remove_match(
    State(db): State<Database>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Response> {
    let url = body["sourceUrl"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or_else(|| Error::Invalid("Choose a source match to remove.".into()))?
        .to_owned();
    let _guard = db.sources.writes.lock().await;
    let lookup = id.clone();
    let removed = db
        .call(move |c| source_store::remove_match(c, &lookup, &url))
        .await?;
    if !removed {
        return Ok(not_found("File"));
    }
    source_jobs::refresh_saved(&db, &id).await?;
    db.call(move|c| {
        let tags = crate::tags::view(c,&id)?;
        Ok(Json(json!({"status":"ok","providers":source_store::runs(c,&id)?,"tags":tags["tags"],"implied":tags["implied"]})).into_response())
    }).await
}

async fn cancel(State(db): State<Database>) -> Json<Value> {
    let running = db.sources.writes.try_lock().is_err();
    if running {
        db.sources
            .cancel
            .send_modify(|generation| *generation = generation.wrapping_add(1));
    }
    Json(json!({"cancelled":running}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{Frontend, Server};
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn request(server: &Server, method: &str, path: &str, body: Value) -> (u16, Value) {
        let response = server
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", server.origin.trim_start_matches("http://"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn credentials_are_private_and_source_settings_persist() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        let data = directory.path().join("data");
        let db = Database::open(&data, &root).unwrap();
        let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
            .await
            .unwrap();
        let (status, value) = request(
            &server,
            "PUT",
            "/credentials",
            json!({"provider":"SAUCENAO","apiKey":"fake-test-key"}),
        )
        .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["credential"]["hasApiKey"], true);
        assert!(!value.to_string().contains("fake-test-key"));
        let (status, value) = request(
            &server,
            "PUT",
            "/sources/settings",
            json!({"targets":["e621"],"display":["e621"],"displayInitialized":true}),
        )
        .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["settings"]["targets"], json!(["e621"]));
        assert_eq!(
            request(&server, "PUT", "/sources/settings", json!({"targets":[1]}))
                .await
                .0,
            400
        );
        assert_eq!(
            request(
                &server,
                "PUT",
                "/sources/settings",
                json!({"targets":["WD14"]})
            )
            .await
            .0,
            400
        );
        assert_eq!(
            request(
                &server,
                "PUT",
                "/credentials",
                json!({"provider":"SAUCENAO","apiKey":"bad\nkey"})
            )
            .await
            .0,
            400
        );
        drop(server);
        let db = Database::open(&data, &root).unwrap();
        let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
            .await
            .unwrap();
        let (_, value) = request(&server, "GET", "/credentials", Value::Null).await;
        assert_eq!(value["credentials"][0]["hasApiKey"], true);
        assert!(!value.to_string().contains("fake-test-key"));
        let (_, value) = request(&server, "GET", "/sources", Value::Null).await;
        assert_eq!(value["settings"]["targets"], json!(["e621"]));
        assert_eq!(value["progress"]["total"], 0);
    }

    #[tokio::test]
    async fn all_five_source_tagged_files_are_searchable_and_only_selected_targets_count() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        db.call(|c| {
            c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,'/fixture','LOCAL','IDLE',{NOW},{NOW})"),[OWNER_ID])?;
            c.execute("INSERT INTO active_library_folders (id) VALUES ('folder')",[])?;
            c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,preset_key,enabled,sort_order,created_at,updated_at) VALUES ('site',?1,'e621','e621','https://e621.net',1,'E621',1,0,{NOW},{NOW})"),[OWNER_ID])?;
            for index in 0..5 {
                let id=format!("file-{index}");
                c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES (?1,'folder','LOCAL',?2,1,{NOW},?1,'IMAGE',{NOW},{NOW})"),params![id,format!("/fixture/{index}.png")])?;
                c.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,source_url,created_at,updated_at) VALUES (?1,'test_artist','test_artist','artist','E621',?2,{NOW},{NOW})"),params![id,format!("https://e621.net/posts/{index}")])?;
            }
            Ok(())
        }).await.unwrap();
        let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
            .await
            .unwrap();
        let (status, files) = request(&server, "GET", "/files?tags=test_artist", Value::Null).await;
        assert_eq!(status, 200, "{files}");
        assert_eq!(files["total"], 5);
        assert_eq!(files["files"].as_array().unwrap().len(), 5);
        let (_, sources) = request(&server, "GET", "/sources", Value::Null).await;
        assert_eq!(sources["sources"][0]["count"], 5);
        assert_eq!(sources["progress"]["matched"], 0);
        let (_, sources) = request(
            &server,
            "PUT",
            "/sources/settings",
            json!({"targets":["e621"]}),
        )
        .await;
        assert_eq!(sources["progress"]["matched"], 5);
        let (_, sources) = request(
            &server,
            "PUT",
            "/sources/settings",
            json!({"targets":["danbooru"]}),
        )
        .await;
        assert_eq!(sources["progress"]["matched"], 0);
        let (status, body) = request(
            &server,
            "POST",
            "/files/file-0/providers/saucenao",
            Value::Null,
        )
        .await;
        assert_eq!(status, 501, "{body}");
        assert!(body["error"].as_str().unwrap().contains("API key"));
    }
}
