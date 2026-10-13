use crate::{
    booru_engines, booru_http,
    db::{Database, OWNER_ID},
    library::NOW,
    Error, Result,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, OptionalExtension, Row};
use serde_json::{json, Value};

pub(crate) const ENGINES: &[&str] = &[
    "danbooru",
    "e621",
    "moebooru",
    "gelbooru",
    "sankaku",
    "philomena",
    "shimmie",
    "szurubooru",
    "furaffinity",
];
const MAX_SITES: usize = 32;
const DETECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
#[derive(Clone, Debug)]
pub(crate) struct Site {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub base: String,
    pub username: Option<String>,
    pub key: Option<String>,
    pub cookie: Option<String>,
    pub enabled: bool,
    pub public: Value,
}
fn schema(engine: &str) -> &'static str {
    match engine {
        "danbooru" | "e621" => "username+apikey",
        "gelbooru" => "userid+apikey",
        "sankaku" => "token",
        "philomena" => "apikey-only",
        "szurubooru" => "username+apikey",
        "furaffinity" => "username+session-cookie",
        _ => "none",
    }
}
fn row(r: &Row) -> rusqlite::Result<Site> {
    let key: Option<String> = r.get("api_key")?;
    let cookie: Option<String> = r.get("session_cookie")?;
    let engine: String = r.get("engine")?;
    let public = json!({"id":r.get::<_,String>("id")?,"name":r.get::<_,String>("name")?,"engine":engine,"baseUrl":r.get::<_,String>("base_url")?,
 "username":r.get::<_,Option<String>>("username")?,"hasApiKey":key.as_ref().is_some_and(|s|!s.is_empty()),"hasSessionCookie":cookie.as_ref().is_some_and(|s|!s.is_empty()),
 "isPreset":r.get::<_,bool>("is_preset")?,"presetKey":r.get::<_,Option<String>>("preset_key")?,"enabled":r.get::<_,bool>("enabled")?,
 "siteAutoSyncMidnight":r.get::<_,bool>("site_auto_sync_midnight")?,"siteReverseSyncEnabled":r.get::<_,bool>("site_reverse_sync_enabled")?,"siteAutoFavEnabled":r.get::<_,bool>("site_auto_fav_enabled")?,
 "sortOrder":r.get::<_,i64>("sort_order")?,"createdAt":r.get::<_,String>("created_at")?,"updatedAt":r.get::<_,String>("updated_at")?,
 "engineCredentialSchema":schema(&engine),"engineSupportsSessionCookie":matches!(engine.as_str(),"gelbooru"|"furaffinity")});
    Ok(Site {
        id: r.get("id")?,
        name: r.get("name")?,
        engine,
        base: r.get("base_url")?,
        username: r.get("username")?,
        key,
        cookie,
        enabled: r.get("enabled")?,
        public,
    })
}
pub(crate) async fn sites(db: &Database) -> Result<Vec<Site>> {
    db.call(|c| {
        let mut s = c.prepare(
            "SELECT * FROM user_booru_sites WHERE user_id=?1 ORDER BY sort_order,id LIMIT ?2",
        )?;
        let rows = s
            .query_map(params![OWNER_ID, (MAX_SITES + 1) as i64], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() > MAX_SITES {
            return Err(Error::Invalid(format!(
                "Use at most {MAX_SITES} booru sites."
            )));
        }
        for site in &rows {
            if !ENGINES.contains(&site.engine.as_str()) {
                return Err(Error::Storage("Unknown saved booru engine.".into()));
            }
            booru_http::url(&site.base)?;
        }
        Ok(rows)
    })
    .await
}
pub(crate) async fn site(db: &Database, id: String) -> Result<Option<Site>> {
    db.call(move |c| {
        Ok(c.query_row(
            "SELECT * FROM user_booru_sites WHERE user_id=?1 AND id=?2",
            params![OWNER_ID, id],
            row,
        )
        .optional()?)
    })
    .await
}
pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/booru-sites", get(list).post(create))
        .route("/booru-sites/engines", get(catalog))
        .route("/booru-sites/detect", post(detect))
        .route("/booru-sites/reorder", post(reorder))
        .route(
            "/booru-sites/{id}",
            axum::routing::put(update).delete(remove),
        )
        .route("/booru-sites/{id}/test", post(test))
}
async fn list(State(db): State<Database>) -> Result<Json<Value>> {
    Ok(Json(
        json!({"sites":sites(&db).await?.into_iter().map(|s|s.public).collect::<Vec<_>>()}),
    ))
}
fn presets() -> Value {
    json!([
     {"key":"E621","name":"e621","engine":"e621","baseUrl":"https://e621.net"},
     {"key":"E926","name":"e926","engine":"e621","baseUrl":"https://e926.net"},
     {"key":"DANBOORU","name":"Danbooru","engine":"danbooru","baseUrl":"https://danbooru.donmai.us"},
     {"key":"GELBOORU","name":"Gelbooru","engine":"gelbooru","baseUrl":"https://gelbooru.com"},
     {"key":"RULE34","name":"Rule34","engine":"gelbooru","baseUrl":"https://api.rule34.xxx"},
     {"key":"YANDERE","name":"yande.re","engine":"moebooru","baseUrl":"https://yande.re"},
     {"key":"KONACHAN","name":"Konachan","engine":"moebooru","baseUrl":"https://konachan.com"},
     {"key":"SANKAKU","name":"Sankaku Channel","engine":"sankaku","baseUrl":"https://chan.sankakucomplex.com"},
     {"key":"IDOL_COMPLEX","name":"Idol Complex","engine":"sankaku","baseUrl":"https://idol.sankakucomplex.com"},
     {"key":"DERPIBOORU","name":"Derpibooru","engine":"philomena","baseUrl":"https://derpibooru.org"},
     {"key":"FURAFFINITY","name":"FurAffinity","engine":"furaffinity","baseUrl":"https://www.furaffinity.net"}
    ])
}
async fn catalog() -> Json<Value> {
    Json(
        json!({"engines":ENGINES.iter().map(|e|json!({"type":e,"credentialSchema":schema(e),
 "defaultCapabilities":{"favorites":crate::booru_favorites::supported(e),"tags":true,"sourceMatch":false,"search":true,"vote":false},
 "supportedExploreSorts":if matches!(*e,"furaffinity"|"shimmie"){vec!["new"]}else{vec!["new","hot","popular"]},
 "supportsExploreTagSearch":*e!="furaffinity","supportsSessionCookie":matches!(*e,"gelbooru"|"furaffinity"),
 "supportsRelations":matches!(*e,"e621"|"danbooru"|"gelbooru"|"moebooru"|"sankaku"),"supportsPools":matches!(*e,"e621"|"danbooru")
 })).collect::<Vec<_>>(),"presets":presets()}),
    )
}
fn payload(
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Value> {
    let Json(v) = p.map_err(|_| {
        Error::Invalid("Send valid JSON with Content-Type application/json.".into())
    })?;
    if !v.is_object() {
        return Err(Error::Invalid("Send a site configuration object.".into()));
    }
    Ok(v)
}
fn text(v: &Value, name: &str, max: usize, required: bool) -> Result<Option<String>> {
    match v.get(name) {
        None | Some(Value::Null) if !required => Ok(None),
        Some(Value::String(s))
            if s.trim().chars().count() <= max && (!required || !s.trim().is_empty()) =>
        {
            Ok((!s.trim().is_empty()).then(|| s.trim().to_owned()))
        }
        _ => Err(Error::Invalid(format!(
            "Enter a valid {name} (at most {max} characters)."
        ))),
    }
}
fn validate(v: &Value, creating: bool) -> Result<()> {
    text(v, "name", 100, creating)?;
    if creating || v.get("engine").is_some() {
        let e = text(v, "engine", 30, true)?.unwrap();
        if !ENGINES.contains(&e.as_str()) {
            return Err(Error::Invalid("Choose a supported booru engine.".into()));
        }
    }
    if creating || v.get("baseUrl").is_some() {
        let base = text(v, "baseUrl", 2000, true)?.unwrap();
        let url = booru_http::url(&base)?;
        if url.query().is_some() {
            return Err(Error::Invalid(
                "Enter the site's base address without query parameters.".into(),
            ));
        }
    }
    for (key, max) in [("username", 100), ("apiKey", 4096), ("sessionCookie", 8192)] {
        let value = text(v, key, max, false)?;
        if value
            .as_ref()
            .is_some_and(|s| s.chars().any(char::is_control))
        {
            return Err(Error::Invalid(format!(
                "{key} cannot contain line breaks or control characters."
            )));
        }
    }
    for key in [
        "enabled",
        "siteAutoSyncMidnight",
        "siteReverseSyncEnabled",
        "siteAutoFavEnabled",
    ] {
        if v.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(Error::Invalid(format!("{key} must be true or false.")));
        }
    }
    Ok(())
}
async fn create(
    State(db): State<Database>,
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response> {
    let v = payload(p)?;
    validate(&v, true)?;
    let id = uuid::Uuid::new_v4().to_string();
    let return_id = id.clone();
    let duplicate=db.call(move|c|{
 let tx=c.transaction()?;let base=text(&v,"baseUrl",2000,true)?.unwrap().trim_end_matches('/').to_owned();
 let count:i64=tx.query_row("SELECT count(*) FROM user_booru_sites WHERE user_id=?1",[OWNER_ID],|r|r.get(0))?;
 if count>=MAX_SITES as i64{return Err(Error::Invalid(format!("Use at most {MAX_SITES} booru sites.")));}
 let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM user_booru_sites WHERE user_id=?1 AND base_url=?2)",params![OWNER_ID,base],|r|r.get(0))?;
 if exists{return Ok(true);}
 let order:i64=tx.query_row("SELECT COALESCE(MAX(sort_order)+1,0) FROM user_booru_sites WHERE user_id=?1",[OWNER_ID],|r|r.get(0))?;
 tx.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,username,api_key,session_cookie,is_preset,preset_key,enabled,sort_order,site_auto_sync_midnight,site_reverse_sync_enabled,site_auto_fav_enabled,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,NULL,?9,?10,?11,?12,?13,{NOW},{NOW})"),params![id,OWNER_ID,text(&v,"name",100,true)?,text(&v,"engine",30,true)?,base,text(&v,"username",100,false)?,text(&v,"apiKey",4096,false)?,text(&v,"sessionCookie",8192,false)?,v["enabled"].as_bool().unwrap_or(true),order,v["siteAutoSyncMidnight"].as_bool().unwrap_or(false),v["siteReverseSyncEnabled"].as_bool().unwrap_or(false),v["siteAutoFavEnabled"].as_bool().unwrap_or(false)])?;
 tx.commit()?;Ok(false)}).await?;
    if duplicate {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({"error":"A site with this address already exists."})),
        )
            .into_response());
    }
    Ok(Json(json!({"site":site(&db,return_id).await?.unwrap().public})).into_response())
}
async fn update(
    State(db): State<Database>,
    Path(id): Path<String>,
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response> {
    let v = payload(p)?;
    validate(&v, false)?;
    let Some(existing) = site(&db, id.clone()).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    let return_id = id.clone();
    let duplicate=db.call(move|c|{
 let tx=c.transaction()?;
 if !existing.public["isPreset"].as_bool().unwrap_or(false){
 if let Some(base)=text(&v,"baseUrl",2000,false)?{
 let base=base.trim_end_matches('/');let conflict:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM user_booru_sites WHERE user_id=?1 AND id<>?2 AND base_url=?3)",params![OWNER_ID,id,base],|r|r.get(0))?;
 if conflict{return Ok(true);}tx.execute("UPDATE user_booru_sites SET base_url=?1 WHERE id=?2 AND user_id=?3",params![base,id,OWNER_ID])?;
 }
 if let Some(engine)=text(&v,"engine",30,false)?{tx.execute("UPDATE user_booru_sites SET engine=?1 WHERE id=?2 AND user_id=?3",params![engine,id,OWNER_ID])?;}}
 for (key,column,max) in [("name","name",100),("username","username",100),("apiKey","api_key",4096),("sessionCookie","session_cookie",8192)]{
 if v.get(key).is_some(){let value=text(&v,key,max,key=="name")?;tx.execute(&format!("UPDATE user_booru_sites SET {column}=?1 WHERE id=?2 AND user_id=?3"),params![value,id,OWNER_ID])?;}}
 for (key,column) in [("enabled","enabled"),("siteAutoSyncMidnight","site_auto_sync_midnight"),("siteReverseSyncEnabled","site_reverse_sync_enabled"),("siteAutoFavEnabled","site_auto_fav_enabled")]{
 if let Some(value)=v[key].as_bool(){tx.execute(&format!("UPDATE user_booru_sites SET {column}=?1 WHERE id=?2 AND user_id=?3"),params![value,id,OWNER_ID])?;}}
 if ["engine","baseUrl","username","apiKey","sessionCookie"].iter().any(|key| v.get(*key).is_some()) {
 crate::subscription_store::reset(&tx,Some(&id),false)?;
 }
 tx.execute(&format!("UPDATE user_booru_sites SET updated_at={NOW} WHERE id=?1 AND user_id=?2"),params![id,OWNER_ID])?;
 tx.commit()?;Ok(false)}).await?;
    if duplicate {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({"error":"A site with this address already exists."})),
        )
            .into_response());
    }
    Ok(Json(json!({"site":site(&db,return_id).await?.unwrap().public})).into_response())
}
async fn remove(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let removed = db
        .call(move |c| {
            Ok(c.execute(
                "DELETE FROM user_booru_sites WHERE id=?1 AND user_id=?2",
                params![id, OWNER_ID],
            )?)
        })
        .await?;
    if removed == 0 {
        return Ok(crate::files::not_found("Site"));
    }
    Ok(Json(json!({"ok":true})).into_response())
}
async fn reorder(
    State(db): State<Database>,
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let v = payload(p)?;
    let ids = v["orderedIds"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= MAX_SITES)
        .ok_or_else(|| Error::Invalid("Supply the site's orderedIds list.".into()))?
        .clone();
    db.call(move |c| {
        let tx = c.transaction()?;
        let mut seen = std::collections::HashSet::new();
        for (i, id) in ids.iter().enumerate() {
            let id = id
                .as_str()
                .filter(|s| seen.insert(*s))
                .ok_or_else(|| Error::Invalid("Site IDs must be unique strings.".into()))?;
            if tx.execute(
                "UPDATE user_booru_sites SET sort_order=?1 WHERE id=?2 AND user_id=?3",
                params![i as i64, id, OWNER_ID],
            )? != 1
            {
                return Err(Error::Invalid(
                    "The ordered list contains an unknown site.".into(),
                ));
            }
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    list(State(db)).await
}
async fn test(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let Some(site) = site(&db, id).await? else {
        return Ok(crate::files::not_found("Site"));
    };
    let transport = booru_http::Transport::default();
    let result = booru_engines::search(&transport, &site, &booru_engines::Search::default()).await;
    let mut response = match &result {
        Ok(_) => json!({"ok":true}),
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    };
    if site.cookie.is_some() && matches!(site.engine.as_str(), "gelbooru" | "furaffinity") {
        response["cookie"] = match result {
            Ok(posts) => match booru_engines::check_cookie(&transport, &site, &posts).await {
                Ok(()) => json!({"ok":true}),
                Err(e) => json!({"ok":false,"error":e.to_string()}),
            },
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
    }
    Ok(Json(response).into_response())
}
async fn detect(
    p: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response> {
    let v = payload(p)?;
    let base = text(&v, "baseUrl", 2000, true)?.unwrap();
    booru_http::url(&base)?;
    if let Some(preset) = presets()
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["baseUrl"].as_str() == Some(base.trim_end_matches('/')))
    {
        let engine = preset["engine"].as_str().unwrap();
        return Ok(Json(json!({"engine":engine,"confidence":"hostname","credentialSchema":schema(engine),"defaultCapabilities":{"favorites":crate::booru_favorites::supported(engine),"tags":true,"sourceMatch":false,"search":true,"vote":false},"supportsSessionCookie":matches!(engine,"gelbooru"|"furaffinity"),"sample":null,"attempts":[]})).into_response());
    }
    // Detection probes public reads only; credentials are added after the engine is known.
    let transport = booru_http::Transport::default();
    let mut attempts = Vec::new();
    let deadline = tokio::time::Instant::now() + DETECTION_TIMEOUT;
    for engine in ENGINES {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let site = Site {
            id: String::new(),
            name: "Site".into(),
            engine: (*engine).into(),
            base: base.clone(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        match tokio::time::timeout(remaining.min(PROBE_TIMEOUT), booru_engines::probe(&transport, &site)).await {
            Ok(Ok(true)) => return Ok(Json(json!({"engine":engine,"confidence":"probe","credentialSchema":schema(engine),"defaultCapabilities":{"favorites":crate::booru_favorites::supported(engine),"tags":true,"sourceMatch":false,"search":true,"vote":false},"supportsSessionCookie":matches!(*engine,"gelbooru"|"furaffinity"),"sample":null,"attempts":attempts})).into_response()),
            Ok(Ok(false)) => attempts.push(json!({"engine":engine,"status":"no-match"})),
            Ok(Err(_)) | Err(_) => attempts.push(json!({"engine":engine,"status":"network-error"})),
        }
    }
    Ok((StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"error":"unknown","message":"The site's engine could not be identified. Choose its engine manually.","attempts":attempts,"tried":ENGINES}))).into_response())
}
