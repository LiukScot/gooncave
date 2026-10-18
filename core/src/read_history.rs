//! Explore history: the posts behind the read marks, newest first.

use crate::{
    boorus,
    db::{Database, OWNER_ID},
    explore, Error, Result,
};
use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const PAGE_SIZE: usize = 40;
const MAX_PAGE_SIZE: usize = 100;
const MAX_SNAPSHOT_BYTES: usize = 4096;
const MAX_URL_LENGTH: usize = 2048;
const MAX_TEXT_LENGTH: usize = 256;
const MAX_POOLS: usize = 64;

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/read-marks/history", get(history))
}

/// The fields of a post that hold on any device, from an untrusted copy of one Explore showed.
/// Media this core proxies are kept as the site's own address, which `explore::decorate` signs
/// again when the post is shown. `None` when the copy is not a post of `site_id`/`remote_id`.
pub(crate) fn snapshot(key: &[u8], site_id: &str, remote_id: &str, post: &Value) -> Option<String> {
    let post = post.as_object()?;
    if post.get("remoteId")?.as_str()? != remote_id {
        return None;
    }
    let mut kept = Map::new();
    kept.insert("remoteId".into(), json!(remote_id));
    for field in ["previewUrl", "sampleUrl", "fileUrl"] {
        let url = match post.get(field) {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(url)) if url.len() <= MAX_URL_LENGTH => {
                if url.starts_with("https://") || url.starts_with("http://") {
                    json!(url)
                } else {
                    let (site, raw) = explore::verified_media(key, url)?;
                    if site != site_id {
                        return None;
                    }
                    json!(raw)
                }
            }
            _ => return None,
        };
        kept.insert(field.into(), url);
    }
    for field in ["width", "height", "score", "favCount", "fileSize"] {
        let number = match post.get(field) {
            None | Some(Value::Null) => Value::Null,
            Some(Value::Number(number)) => Value::Number(number.clone()),
            _ => return None,
        };
        kept.insert(field.into(), number);
    }
    for field in [
        "rating",
        "md5",
        "createdAt",
        "uploader",
        "fileExt",
        "parentId",
    ] {
        let text = match post.get(field) {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(text)) if text.len() <= MAX_TEXT_LENGTH => json!(text),
            _ => return None,
        };
        kept.insert(field.into(), text);
    }
    let has_children = match post.get("hasChildren") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        _ => return None,
    };
    kept.insert("hasChildren".into(), json!(has_children));
    let pools = match post.get("poolIds") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Array(ids))
            if ids.len() <= MAX_POOLS
                && ids
                    .iter()
                    .all(|id| id.as_str().is_some_and(|id| id.len() <= MAX_TEXT_LENGTH)) =>
        {
            Value::Array(ids.clone())
        }
        _ => return None,
    };
    kept.insert("poolIds".into(), pools);
    let text = Value::Object(kept).to_string();
    (text.len() <= MAX_SNAPSHOT_BYTES).then_some(text)
}

fn page_size(query: &HashMap<String, String>) -> Result<usize> {
    match query.get("limit") {
        None => Ok(PAGE_SIZE),
        Some(raw) => raw
            .parse()
            .ok()
            .filter(|limit| (1..=MAX_PAGE_SIZE).contains(limit))
            .ok_or_else(|| Error::Invalid(format!("limit must be 1 through {MAX_PAGE_SIZE}."))),
    }
}

/// `readAt|itemKey` of the last post of the previous page.
fn cursor(query: &HashMap<String, String>) -> Result<Option<(String, String)>> {
    query
        .get("cursor")
        .map(|raw| {
            raw.split_once('|')
                .filter(|(read_at, key)| !read_at.is_empty() && key.contains(':'))
                .map(|(read_at, key)| (read_at.to_owned(), key.to_owned()))
                .ok_or_else(|| Error::Invalid("Supply the cursor of the previous page.".into()))
        })
        .transpose()
}

async fn history(
    State(db): State<Database>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let limit = page_size(&query)?;
    let after = cursor(&query)?;
    let wanted: Option<HashSet<String>> = query.get("sites").map(|ids| {
        ids.split(',')
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect()
    });
    // A mark of a deleted site has nothing to show.
    let sites: HashMap<String, boorus::Site> = boorus::sites(&db)
        .await?
        .into_iter()
        .filter(|site| wanted.as_ref().is_none_or(|ids| ids.contains(&site.id)))
        .map(|site| (site.id.clone(), site))
        .collect();
    if sites.is_empty() {
        return Ok(Json(json!({"posts": [], "nextCursor": null})));
    }
    let site_ids: Vec<String> = sites.keys().cloned().collect();
    let rows: Vec<(String, String, String)> = db
        .call(move |c| {
            let placeholders = (5..5 + site_ids.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            let mut values: Vec<rusqlite::types::Value> = vec![
                OWNER_ID.to_owned().into(),
                after.as_ref().map(|(read_at, _)| read_at.clone()).into(),
                after.as_ref().map(|(_, key)| key.clone()).into(),
                ((limit + 1) as i64).into(),
            ];
            values.extend(site_ids.into_iter().map(Into::into));
            let mut statement = c.prepare(&format!(
                "SELECT item_key, read_at, post FROM read_marks
                 WHERE scope = 'post' AND user_id = ?1 AND post IS NOT NULL
                   AND (?2 IS NULL OR (read_at, item_key) < (?2, ?3))
                   AND substr(item_key, 1, instr(item_key, ':') - 1) IN ({placeholders})
                 ORDER BY read_at DESC, item_key DESC LIMIT ?4"
            ))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(values), |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await?;
    let more = rows.len() > limit;
    let rows = &rows[..rows.len().min(limit)];
    let next_cursor = more
        .then(|| {
            rows.last()
                .map(|(key, read_at, _)| format!("{read_at}|{key}"))
        })
        .flatten();

    let mut by_site: HashMap<&str, Vec<Value>> = HashMap::new();
    for (key, read_at, post) in rows {
        let Some((site, _)) = key.split_once(':') else {
            continue;
        };
        let mut post: Value = serde_json::from_str(post)
            .map_err(|e| Error::Storage(format!("Invalid saved history post {key}: {e}")))?;
        post["readAt"] = json!(read_at);
        post["tags"] = json!([]);
        post["favorited"] = Value::Null;
        post["voted"] = Value::Null;
        by_site.entry(site).or_default().push(post);
    }
    let key = explore::media_key(&db).await?;
    let mut shown: HashMap<String, Value> = HashMap::new();
    for (site, posts) in by_site {
        let Some(site_row) = sites.get(site) else {
            continue;
        };
        for post in explore::decorate(&db, site_row, posts, &key).await? {
            shown.insert(
                format!("{site}:{}", post["remoteId"].as_str().unwrap_or_default()),
                post,
            );
        }
    }
    let posts: Vec<Value> = rows
        .iter()
        .filter_map(|(key, _, _)| shown.remove(key))
        .collect();
    Ok(Json(json!({"posts": posts, "nextCursor": next_cursor})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_keeps_only_the_post_and_refuses_another_post() {
        let post = json!({
            "remoteId": "7", "previewUrl": "https://cdn.example/7.jpg", "sampleUrl": null,
            "fileUrl": "https://cdn.example/7.png", "width": 10, "height": 20, "score": 3,
            "rating": "s", "md5": "abc", "createdAt": null, "favCount": 1, "uploader": "me",
            "fileExt": "png", "fileSize": 5, "parentId": null, "hasChildren": false, "poolIds": [],
            "siteId": "site", "read": true, "libraryFileId": "file", "tags": [{"tag": "fox"}]
        });
        let kept: Value =
            serde_json::from_str(&snapshot(b"key", "site", "7", &post).unwrap()).unwrap();
        assert_eq!(kept["previewUrl"], "https://cdn.example/7.jpg");
        assert!(
            kept.get("siteId").is_none()
                && kept.get("tags").is_none()
                && kept.get("read").is_none()
        );
        assert_eq!(snapshot(b"key", "site", "8", &post), None);
        assert_eq!(
            snapshot(
                b"key",
                "site",
                "7",
                &json!({"remoteId": "7", "previewUrl": "javascript:x"})
            ),
            None
        );
    }

    #[test]
    fn a_proxied_link_is_kept_as_the_site_address_only_for_its_own_site() {
        let link = explore::signed(b"key", "fa", &json!("https://t.furaffinity.net/1.jpg"));
        let post = json!({"remoteId": "1", "previewUrl": link});
        let kept: Value =
            serde_json::from_str(&snapshot(b"key", "fa", "1", &post).unwrap()).unwrap();
        assert_eq!(kept["previewUrl"], "https://t.furaffinity.net/1.jpg");
        assert_eq!(snapshot(b"key", "other", "1", &post), None);
        assert_eq!(snapshot(b"other key", "fa", "1", &post), None);
    }
}
