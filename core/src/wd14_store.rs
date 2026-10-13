use crate::{
    db::OWNER_ID,
    library::NOW,
    source_store::{self, File},
    tags,
    wd14_model::{Tag, OUTPUTS, REVISION},
    Error, Result,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub(crate) fn enabled(c: &Connection) -> Result<bool> {
    let value = c
        .query_row("SELECT value FROM meta WHERE key='wd14.enabled'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    match value.as_deref() {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        _ => Err(Error::Storage(
            "Invalid automatic tagging setting. Turn tagging off and on again.".into(),
        )),
    }
}

pub(crate) fn set_enabled(c: &Connection, enabled: bool) -> Result<()> {
    c.execute("INSERT INTO meta (key,value) VALUES ('wd14.enabled',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[if enabled {"true"} else {"false"}])?;
    Ok(())
}

pub(crate) fn pending(c: &Connection, excluded: &[String]) -> Result<Option<File>> {
    let id = c.query_row("SELECT f.id FROM files f JOIN library_folders folders ON folders.id=f.folder_id
        WHERE folders.user_id=?1 AND NOT EXISTS(SELECT 1 FROM wd14_applied a WHERE a.file_id=f.id AND a.sha256=f.sha256 AND a.model=?2)
        AND f.id NOT IN (SELECT value FROM json_each(?3)) ORDER BY f.created_at,f.id LIMIT 1",
        params![OWNER_ID,REVISION,serde_json::json!(excluded).to_string()],|r|r.get::<_,String>(0)).optional()?;
    id.map(|id| source_store::file(c, &id))
        .transpose()
        .map(Option::flatten)
}

pub(crate) fn counts(c: &Connection) -> Result<(i64, i64)> {
    Ok(c.query_row("SELECT count(*),coalesce(sum(EXISTS(SELECT 1 FROM wd14_applied a WHERE a.file_id=f.id AND a.sha256=f.sha256 AND a.model=?2)),0)
        FROM files f JOIN library_folders folders ON folders.id=f.folder_id WHERE folders.user_id=?1",params![OWNER_ID,REVISION],|r|Ok((r.get(0)?,r.get(1)?)))?)
}

pub(crate) fn cached(c: &Connection, sha: &str) -> Result<Option<Vec<Tag>>> {
    let raw = c
        .query_row(
            "SELECT results FROM wd14_results WHERE sha256=?1 AND model=?2",
            params![sha, REVISION],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    raw.map(|raw| parse(&raw)).transpose()
}

pub(crate) fn parse(raw: &str) -> Result<Vec<Tag>> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| Error::Storage("Invalid saved WD14 results.".into()))?;
    let rows = value
        .as_array()
        .filter(|a| a.len() <= OUTPUTS)
        .ok_or_else(|| Error::Storage("Invalid saved WD14 results.".into()))?;
    let mut found = std::collections::HashSet::new();
    rows.iter()
        .map(|row| {
            let invalid =
                || Error::Storage("Invalid saved WD14 tag. Existing file tags were kept.".into());
            let name = row["tag"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 500 && !s.chars().any(char::is_control))
                .ok_or_else(invalid)?;
            let category = match row["category"].as_str() {
                Some("general") => "general",
                Some("artist") => "artist",
                Some("character") => "character",
                Some("copyright") => "copyright",
                Some("meta") => "meta",
                _ => return Err(invalid()),
            };
            let score = row["score"]
                .as_f64()
                .filter(|s| s.is_finite() && (0.0..=1.0).contains(s))
                .ok_or_else(invalid)? as f32;
            if !found.insert(name.to_owned()) {
                return Err(invalid());
            }
            Ok(Tag {
                name: name.into(),
                category,
                score,
            })
        })
        .collect()
}

pub(crate) fn apply(c: &mut Connection, snapshot: &File, results: &[Tag]) -> Result<bool> {
    if !source_store::current(c, snapshot)? {
        return Ok(false);
    }
    let raw = serde_json::json!(results.iter().map(Tag::json).collect::<Vec<_>>()).to_string();
    let results = parse(&raw)?;
    let tx = c.transaction()?;
    tx.execute(&format!("INSERT INTO wd14_results (sha256,model,results,updated_at) VALUES (?1,?2,?3,{NOW}) ON CONFLICT(sha256,model) DO UPDATE SET results=excluded.results,updated_at=excluded.updated_at WHERE wd14_results.results<>excluded.results"),params![snapshot.sha256,REVISION,raw])?;
    tx.execute(
        "DELETE FROM file_tags WHERE file_id=?1 AND source='WD14'",
        [&snapshot.id],
    )?;
    for tag in results {
        let name = tags::normalize(&tag.name);
        if name.is_empty() || tags::unusable(&name) {
            continue;
        }
        let canonical = tags::canonical(&tx, &name)?;
        tx.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,score,created_at,updated_at) VALUES (?1,?2,?3,?4,'WD14',?5,{NOW},{NOW}) ON CONFLICT(file_id,tag,source) DO UPDATE SET category=excluded.category,score=excluded.score,canonical_tag=excluded.canonical_tag,updated_at=excluded.updated_at"),params![snapshot.id,name,canonical,tag.category,tag.score])?;
    }
    tx.execute("INSERT INTO wd14_applied (file_id,sha256,model) VALUES (?1,?2,?3) ON CONFLICT(file_id) DO UPDATE SET sha256=excluded.sha256,model=excluded.model",params![snapshot.id,snapshot.sha256,REVISION])?;
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[tokio::test]
    async fn cached_results_cover_copies_empty_results_and_changed_files() {
        let temporary = tempfile::tempdir().unwrap();
        let db = Database::open(
            &temporary.path().join("data"),
            &temporary.path().join("library"),
        )
        .unwrap();
        db.call(|c| {
            assert!(!enabled(c)?);
            set_enabled(c,true)?;
            assert!(enabled(c)?);
            c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,'/fixture','LOCAL','IDLE',{NOW},{NOW})"),[OWNER_ID])?;
            c.execute("INSERT INTO active_library_folders (id) VALUES ('folder')",[])?;
            for id in ["one","two"] {
                c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES (?1,'folder','LOCAL',?2,1,{NOW},'shared-sha','IMAGE',{NOW},{NOW})"),params![id,format!("/fixture/{id}.png")])?;
            }
            let one = source_store::file(c,"one")?.unwrap();
            assert!(apply(c,&one,&[])?);
            assert_eq!(counts(c)?,(2,1));
            assert!(cached(c,"shared-sha")?.unwrap().is_empty());
            let two = pending(c,&[])?.unwrap();
            assert_eq!(two.id,"two");
            c.execute("UPDATE wd14_results SET updated_at='2026-01-01T00:00:00.000Z'",[])?;
            assert!(apply(c,&two,&cached(c,"shared-sha")?.unwrap())?);
            assert_eq!(c.query_row("SELECT updated_at FROM wd14_results",[],|r|r.get::<_,String>(0))?,"2026-01-01T00:00:00.000Z");
            assert!(pending(c,&[])?.is_none());
            c.execute("UPDATE files SET sha256='new-sha' WHERE id='one'",[])?;
            assert!(!apply(c,&one,&[])?);
            assert_eq!(pending(c,&[])?.unwrap().id,"one");
            assert_eq!(counts(c)?,(2,1));
            Ok(())
        }).await.unwrap();
    }

    #[test]
    fn rejects_invalid_cached_scores_categories_and_duplicates() {
        for raw in [
            r#"[{"tag":"test","category":"general","score":2}]"#,
            r#"[{"tag":"test","category":"bad","score":0.8}]"#,
            r#"[{"tag":"test","category":"general","score":0.8},{"tag":"test","category":"general","score":0.7}]"#,
        ] {
            assert!(parse(raw).is_err());
        }
    }
}
