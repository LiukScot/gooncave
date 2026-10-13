use crate::{
    db::{Database, OWNER_ID},
    files::{file_exists, not_found},
    library::NOW,
    Error, Result,
};
use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) fn normalize(value: &str) -> String {
    value
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "_:()-".contains(*c))
        .collect::<String>()
        .to_ascii_lowercase()
}

pub(crate) fn unusable(value: &str) -> bool {
    value == "invalid_tag" || value.ends_with("_(disambiguation)")
}

pub(crate) fn canonical(connection: &Connection, tag: &str) -> Result<String> {
    let mut current = tag.to_owned();
    let mut seen = HashSet::from([current.clone()]);
    loop {
        let next: Option<String> = connection
            .query_row(
                "SELECT consequent FROM tag_aliases WHERE antecedent=?1",
                [&current],
                |r| r.get(0),
            )
            .optional()?;
        let Some(next) = next else { return Ok(current) };
        if unusable(&next) || !seen.insert(next.clone()) {
            return Ok(current);
        }
        current = next;
    }
}

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/tags/suggest", get(suggest))
        .route("/files/{id}/tags", get(read).delete(clear))
        .route("/files/{id}/tags/manual", post(manual))
        .route("/files/{id}/tags/suppress", post(suppress))
}

fn view(connection: &Connection, id: &str) -> Result<Value> {
    let mut statement = connection.prepare("SELECT ft.* FROM file_tags ft WHERE file_id=?1 AND NOT EXISTS
        (SELECT 1 FROM file_tag_suppressions s WHERE s.file_id=ft.file_id AND s.tag=ft.tag) ORDER BY tag ASC")?;
    let tags = statement.query_map([id], |r| Ok(json!({
        "fileId":id, "tag":r.get::<_,String>("tag")?,
        "canonicalTag":r.get::<_,String>("canonical_tag")?, "category":r.get::<_,String>("category")?,
        "source":r.get::<_,String>("source")?, "score":r.get::<_,Option<f64>>("score")?,
        "sourceUrl":r.get::<_,Option<String>>("source_url")?, "createdAt":r.get::<_,String>("created_at")?, "updatedAt":r.get::<_,String>("updated_at")?
    })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut statement = connection.prepare("SELECT DISTINCT implied FROM tag_implications WHERE tag IN
        (SELECT canonical_tag FROM file_tags ft WHERE file_id=?1 AND NOT EXISTS
        (SELECT 1 FROM file_tag_suppressions s WHERE s.file_id=ft.file_id AND s.tag=ft.tag))
        AND implied NOT IN (SELECT canonical_tag FROM file_tags ft WHERE file_id=?1 AND NOT EXISTS
        (SELECT 1 FROM file_tag_suppressions s WHERE s.file_id=ft.file_id AND s.tag=ft.tag)) ORDER BY implied")?;
    let implied = statement
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut s=connection.prepare("SELECT fav.provider,fav.source_url FROM favorite_items fav JOIN files f ON f.path=fav.file_path WHERE f.id=?1 AND fav.user_id=?2 ORDER BY fav.provider LIMIT 32")?;
    let favorites = s
        .query_map(params![id, OWNER_ID], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let sources = favorites
        .iter()
        .map(|(provider, _)| provider)
        .collect::<Vec<_>>();
    let links = favorites
        .iter()
        .filter_map(|(provider, url)| {
            url.as_ref()
                .map(|url| json!({"siteName":provider,"sourceUrl":url}))
        })
        .collect::<Vec<_>>();
    Ok(json!({"tags":tags,"implied":implied,"favoriteSources":sources,"favoriteSourceLinks":links}))
}

async fn read(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    db.call(move |c| {
        if !file_exists(c, &id)? {
            return Ok(not_found("File"));
        }
        Ok(Json(view(c, &id)?).into_response())
    })
    .await
}

async fn clear(State(db): State<Database>, Path(id): Path<String>) -> Result<Response> {
    db.call(move |c| {
        if !file_exists(c, &id)? {
            return Ok(not_found("File"));
        }
        let removed = c.execute("DELETE FROM file_tags WHERE file_id=?1", [id])?;
        Ok(Json(json!({"status":"ok","removed":removed})).into_response())
    })
    .await
}

type Payload = std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>;
fn body(payload: Payload) -> Result<Value> {
    payload
        .map(|Json(v)| v)
        .map_err(|_| Error::Invalid("Send a valid JSON tag body.".into()))
}

async fn manual(
    State(db): State<Database>,
    Path(id): Path<String>,
    payload: Payload,
) -> Result<Response> {
    let body = body(payload)?;
    let raw = body
        .get("tag")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && t.len() <= 1024)
        .ok_or_else(|| Error::Invalid("Enter a tag of 1 through 1024 characters.".into()))?;
    let tag = normalize(raw);
    if tag.is_empty() {
        return Err(Error::Invalid(
            "The tag contains no letters or numbers. Enter a tag name.".into(),
        ));
    }
    let category = match body.get("category") {
        None => "general".to_owned(),
        Some(v) => v
            .as_str()
            .ok_or_else(|| Error::Invalid("Choose a tag category.".into()))?
            .trim()
            .to_ascii_lowercase(),
    };
    if ![
        "general",
        "artist",
        "character",
        "copyright",
        "species",
        "meta",
        "lore",
        "invalid",
    ]
    .contains(&category.as_str())
    {
        return Err(Error::Invalid(
            "Choose one of the available tag categories.".into(),
        ));
    }
    db.call(move |c| {
        if !file_exists(c,&id)? {return Ok(not_found("File"));}
        let tx = c.transaction()?;
        let canonical = canonical(&tx,&tag)?;
        tx.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,created_at,updated_at)
            VALUES (?1,?2,?3,?4,'MANUAL',{NOW},{NOW}) ON CONFLICT(file_id,tag,source)
            DO UPDATE SET canonical_tag=excluded.canonical_tag,category=excluded.category,updated_at=excluded.updated_at"), params![id,tag,canonical,category])?;
        // A deliberate re-add must become visible even if the same provider spelling was removed.
        tx.execute("DELETE FROM file_tag_suppressions WHERE file_id=?1 AND tag=?2",params![id,tag])?;
        tx.commit()?;
        Ok(Json(json!({"status":"ok"})).into_response())
    }).await
}

async fn suppress(
    State(db): State<Database>,
    Path(id): Path<String>,
    payload: Payload,
) -> Result<Response> {
    let body = body(payload)?;
    let wanted = body
        .get("tags")
        .and_then(Value::as_array)
        .filter(|t| (1..=64).contains(&t.len()))
        .and_then(|tags| {
            tags.iter()
                .map(|t| {
                    t.as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 1024)
                        .map(normalize)
                })
                .collect::<Option<Vec<_>>>()
        })
        .filter(|tags| tags.iter().all(|t| !t.is_empty()))
        .ok_or_else(|| Error::Invalid("Send 1 through 64 tag names to remove.".into()))?;
    db.call(move |c| {
        if !file_exists(c,&id)? {return Ok(not_found("File"));}
        let tx = c.transaction()?;
        for tag in wanted {
            let canonical = canonical(&tx,&tag)?;
            tx.execute(&format!("INSERT INTO file_tag_suppressions (file_id,tag,created_at)
                SELECT file_id,tag,{NOW} FROM file_tags WHERE file_id=?1 AND canonical_tag=?2 AND source<>'MANUAL'
                ON CONFLICT(file_id,tag) DO NOTHING"),params![id,canonical])?;
            tx.execute("DELETE FROM file_tags WHERE file_id=?1 AND canonical_tag=?2 AND source='MANUAL'",params![id,canonical])?;
        }
        tx.commit()?;
        Ok(Json(view(c,&id)?).into_response())
    }).await
}

async fn suggest(
    State(db): State<Database>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let limit: i64 = query
        .get("limit")
        .map(|v| v.parse())
        .transpose()
        .map_err(|_| Error::Invalid("Suggestion limit must be a whole number.".into()))?
        .unwrap_or(10);
    if !(1..=50).contains(&limit) {
        return Err(Error::Invalid(
            "Suggestion limit must be 1 through 50.".into(),
        ));
    }
    let vocabulary = match query.get("scope").map(String::as_str) {
        None | Some("library") => false,
        Some("vocabulary") => true,
        _ => {
            return Err(Error::Invalid(
                "Suggestion scope must be library or vocabulary.".into(),
            ))
        }
    };
    let raw = query.get("q").map(String::as_str).unwrap_or("");
    if raw.len() > 1024 {
        return Err(Error::Invalid("The suggestion text is too long.".into()));
    }
    let prefix = normalize(raw);
    if prefix.is_empty() {
        return Ok(Json(json!({"suggestions":[]})));
    }
    let escaped = prefix
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    db.call(move |c| {
        let mut statement = c.prepare("SELECT canonical_tag AS tag,COUNT(DISTINCT file_id) AS files FROM file_tags ft
            JOIN files f ON f.id=ft.file_id JOIN library_folders fo ON fo.id=f.folder_id
            WHERE fo.user_id=? AND canonical_tag LIKE ? ESCAPE '\\' AND NOT EXISTS
            (SELECT 1 FROM file_tag_suppressions s WHERE s.file_id=ft.file_id AND s.tag=ft.tag)
            GROUP BY canonical_tag ORDER BY (canonical_tag LIKE ? ESCAPE '\\') DESC, files DESC,tag ASC LIMIT ?")?;
        let pattern = format!("%{escaped}%"); let starts = format!("{escaped}%");
        let mut suggestions = statement.query_map(params![OWNER_ID,pattern,starts,limit],|r| Ok(json!({"tag":r.get::<_,String>(0)?,"files":r.get::<_,i64>(1)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        if vocabulary && suggestions.len() < limit as usize {
            let mut statement = c.prepare("SELECT tag FROM (SELECT consequent AS tag FROM tag_aliases WHERE consequent LIKE ? ESCAPE '\\'
                UNION SELECT antecedent FROM tag_aliases WHERE antecedent LIKE ? ESCAPE '\\'
                UNION SELECT tag FROM tag_implications WHERE tag LIKE ? ESCAPE '\\'
                UNION SELECT implied FROM tag_implications WHERE implied LIKE ? ESCAPE '\\')
                ORDER BY (tag LIKE ? ESCAPE '\\') DESC,LENGTH(tag),tag LIMIT ?")?;
            let values: Vec<rusqlite::types::Value> = vec![pattern.clone().into(),pattern.clone().into(),pattern.clone().into(),pattern.into(),starts.into(),(limit*2).into()];
            let rows = statement.query_map(params_from_iter(values),|r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for tag in rows {if suggestions.len()>=limit as usize {break;} if !suggestions.iter().any(|s| s["tag"]==tag) {suggestions.push(json!({"tag":tag,"files":0}));}}
        }
        Ok(Json(json!({"suggestions":suggestions})))
    }).await
}
