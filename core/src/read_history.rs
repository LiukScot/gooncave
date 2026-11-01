//! History: the posts behind the read marks and the files opened in the Gallery, newest first.

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
/// `siteId` of a History entry that is a Gallery file; the file's id is its `remoteId`.
const LIBRARY_SITE: &str = "library";

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

/// `readAt|entryKey` of the last entry of the previous page.
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
    let site_ids: Vec<String> = sites.keys().cloned().collect();
    let rows: Vec<(String, String, Option<String>)> = db
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
                // A limit per arm lets the post marks come ordered from their index and stop early;
                // one ORDER BY over both would sort every mark for each page.
                "SELECT entry, read_at, post FROM (
                    SELECT * FROM (
                        SELECT item_key AS entry, read_at, post FROM read_marks
                        WHERE scope = 'post' AND user_id = ?1 AND post IS NOT NULL
                          AND (?2 IS NULL OR (read_at, item_key) < (?2, ?3))
                          AND substr(item_key, 1, instr(item_key, ':') - 1) IN ({placeholders})
                        ORDER BY read_at DESC, item_key DESC LIMIT ?4)
                    UNION ALL
                    SELECT * FROM (
                        SELECT '{LIBRARY_SITE}:' || m.item_key AS entry, m.read_at, NULL AS post FROM read_marks m
                        JOIN files f ON f.id = m.item_key JOIN library_folders lf ON lf.id = f.folder_id
                        WHERE m.scope = 'opened' AND m.user_id = ?1
                          AND f.sha256 NOT IN (SELECT sha256 FROM trash)
                          AND (?2 IS NULL OR (m.read_at, '{LIBRARY_SITE}:' || m.item_key) < (?2, ?3))
                        ORDER BY m.read_at DESC, entry DESC LIMIT ?4)
                 ) ORDER BY read_at DESC, entry DESC LIMIT ?4"
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
    let mut opened: HashMap<String, String> = HashMap::new();
    for (key, read_at, post) in rows {
        let Some((site, id)) = key.split_once(':') else {
            continue;
        };
        let Some(post) = post else {
            opened.insert(id.to_owned(), read_at.clone());
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
    shown.extend(opened_entries(&db, opened).await?);
    with_library_copies(&db, &mut shown).await?;
    let posts: Vec<Value> = rows
        .iter()
        .filter_map(|(key, _, _)| shown.remove(key))
        .collect();
    Ok(Json(json!({"posts": posts, "nextCursor": next_cursor})))
}

/// Gallery files as History entries, in the shape of a post so one grid shows both.
/// `opened` maps a file's id to when it was opened; a file deleted since is left out.
async fn opened_entries(
    db: &Database,
    opened: HashMap<String, String>,
) -> Result<HashMap<String, Value>> {
    db.call(move |c| {
        let placeholders = vec!["?"; opened.len()].join(",");
        let mut statement = c.prepare(&format!(
            "SELECT id, width, height, size_bytes, thumb_path FROM files WHERE id IN ({placeholders})"
        ))?;
        let entries = statement
            .query_map(rusqlite::params_from_iter(opened.keys()), |row| {
                let id: String = row.get(0)?;
                Ok((format!("{LIBRARY_SITE}:{id}"), json!({
                    "remoteId": id, "siteId": LIBRARY_SITE, "siteName": "Gallery", "engine": LIBRARY_SITE,
                    "sourceUrl": "", "previewUrl": crate::files::thumb_url(row.get::<_, Option<String>>(4)?.as_deref()),
                    "sampleUrl": null, "fileUrl": null, "width": row.get::<_, Option<i64>>(1)?,
                    "height": row.get::<_, Option<i64>>(2)?, "fileSize": row.get::<_, i64>(3)?,
                    "score": null, "rating": null, "md5": null, "createdAt": null, "favCount": null,
                    "uploader": null, "fileExt": null, "parentId": null, "hasChildren": false, "poolIds": [],
                    "tags": [], "favorited": false, "voted": null, "read": true, "readAt": opened[&id],
                    "libraryFileId": id,
                })))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(entries)
    })
    .await
}

/// Says which entries have their original on this device, the only ones that open offline.
async fn with_library_copies(db: &Database, shown: &mut HashMap<String, Value>) -> Result<()> {
    let ids: Vec<String> = shown
        .values()
        .filter_map(|entry| entry["libraryFileId"].as_str().map(str::to_owned))
        .collect();
    let copies: HashMap<String, (String, Option<String>)> = db
        .call(move |c| {
            let placeholders = vec!["?"; ids.len()].join(",");
            let mut statement = c.prepare(&format!(
                "SELECT id, location_type, thumb_path FROM files WHERE id IN ({placeholders})"
            ))?;
            let copies = statement
                .query_map(rusqlite::params_from_iter(&ids), |row| {
                    Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
                })?
                .collect::<rusqlite::Result<HashMap<_, _>>>()?;
            Ok(copies)
        })
        .await?;
    for entry in shown.values_mut() {
        let Some((location, thumb)) = entry["libraryFileId"].as_str().and_then(|id| copies.get(id))
        else {
            continue;
        };
        entry["libraryLocation"] = json!(location);
        entry["libraryThumbUrl"] = json!(crate::files::thumb_url(thumb.as_deref()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn history_mixes_posts_with_opened_files_but_not_files_only_marked_read() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        db.call(|c| {
            let at = "2026-01-01T00:00:0";
            c.execute_batch(&format!("
                INSERT INTO folders (id, user_id, path, type, status, created_at, updated_at)
                  VALUES ('d', '{OWNER_ID}', '/library', 'LOCAL', 'ACTIVE', '{at}0Z', '{at}0Z');
                INSERT INTO active_library_folders (id) VALUES ('d');
                INSERT INTO files (id, folder_id, path, size_bytes, mtime, sha256, media_type, location_type, created_at, updated_at) VALUES
                  ('here', 'd', '/library/a.png', 1, '{at}0Z', 'a', 'IMAGE', 'LOCAL', '{at}0Z', '{at}0Z'),
                  ('away', 'd', '/library/b.png', 1, '{at}0Z', 'b', 'IMAGE', 'REMOTE', '{at}0Z', '{at}0Z'),
                  ('scrolled', 'd', '/library/c.png', 1, '{at}0Z', 'c', 'IMAGE', 'LOCAL', '{at}0Z', '{at}0Z'),
                  ('binned', 'd', '/library/d.png', 1, '{at}0Z', 'd', 'IMAGE', 'LOCAL', '{at}0Z', '{at}0Z');
                INSERT INTO trash (sha256, trashed_at) VALUES ('d', '{at}0Z');
                INSERT INTO read_marks (scope, item_key, user_id, read_at) VALUES
                  ('opened', 'here', '{OWNER_ID}', '{at}3Z'),
                  ('opened', 'away', '{OWNER_ID}', '{at}2Z'),
                  ('file', 'scrolled', '{OWNER_ID}', '{at}4Z'),
                  ('opened', 'binned', '{OWNER_ID}', '{at}5Z');
            "))?;
            Ok(())
        })
        .await
        .unwrap();

        let page = |query: HashMap<String, String>| history(State(db.clone()), Query(query));
        let Json(first) = page(HashMap::from([("limit".to_owned(), "1".to_owned())]))
            .await
            .unwrap();
        assert_eq!(first["posts"][0]["remoteId"], "here");
        assert_eq!(first["posts"][0]["siteId"], LIBRARY_SITE);
        assert_eq!(first["posts"][0]["libraryLocation"], "LOCAL");

        let cursor = first["nextCursor"].as_str().unwrap().to_owned();
        let Json(second) = page(HashMap::from([("cursor".to_owned(), cursor)])).await.unwrap();
        assert_eq!(second["posts"].as_array().unwrap().len(), 1);
        assert_eq!(second["posts"][0]["remoteId"], "away");
        assert_eq!(second["posts"][0]["libraryLocation"], "REMOTE");
    }

    #[tokio::test]
    async fn a_file_deleted_while_history_loads_does_not_fail_the_page() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let gone = HashMap::from([("gone".to_owned(), "2026-01-01T00:00:00Z".to_owned())]);
        assert!(opened_entries(&db, gone).await.unwrap().is_empty());
        let mut shown = HashMap::from([(
            "site:1".to_owned(),
            json!({"remoteId": "1", "libraryFileId": "gone"}),
        )]);
        with_library_copies(&db, &mut shown).await.unwrap();
        assert!(shown["site:1"].get("libraryLocation").is_none());
    }

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
