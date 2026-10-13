use crate::{
    booru_engines, boorus::Site, db::OWNER_ID, files::file_exists, library::NOW,
    source_matches::Match, tags, Error, Result,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

#[derive(Clone)]
pub(crate) struct File {
    pub id: String,
    pub path: String,
    pub folder: String,
    pub sha256: String,
    pub kind: String,
    pub size: i64,
    pub mtime: String,
    pub duration_ms: Option<i64>,
}

pub(crate) fn file(connection: &Connection, id: &str) -> Result<Option<File>> {
    Ok(connection.query_row("SELECT f.id,f.path,folders.path,f.sha256,f.media_type,f.size_bytes,f.mtime,f.duration_ms FROM files f
        JOIN library_folders folders ON folders.id=f.folder_id WHERE f.id=?1 AND folders.user_id=?2",
        params![id,OWNER_ID], |r| Ok(File{id:r.get(0)?,path:r.get(1)?,folder:r.get(2)?,sha256:r.get(3)?,kind:r.get(4)?,size:r.get(5)?,mtime:r.get(6)?,duration_ms:r.get(7)?})).optional()?)
}

pub(crate) fn current(connection: &Connection, snapshot: &File) -> Result<bool> {
    Ok(file(connection, &snapshot.id)?.is_some_and(|f| {
        f.sha256 == snapshot.sha256
            && f.path == snapshot.path
            && f.folder == snapshot.folder
            && f.size == snapshot.size
            && f.mtime == snapshot.mtime
    }))
}

pub(crate) fn runs(connection: &Connection, id: &str) -> Result<Vec<Value>> {
    let mut statement=connection.prepare("SELECT id,provider,status,cached_hit,score,source_url,thumb_url,results,created_at,completed_at,error
        FROM provider_runs WHERE file_id=?1 ORDER BY created_at DESC,id DESC LIMIT 64")?;
    let rows=statement.query_map([id],|r| {
        let raw: Option<String>=r.get(7)?;
        let results=raw.map(|s|serde_json::from_str::<Value>(&s)).transpose()
            .map_err(|e|rusqlite::Error::FromSqlConversionFailure(7,rusqlite::types::Type::Text,Box::new(e)))?.unwrap_or(json!([]));
        Ok(json!({"id":r.get::<_,String>(0)?,"fileId":id,"provider":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,
            "cachedHit":r.get::<_,bool>(3)?,"score":r.get::<_,Option<f64>>(4)?,"sourceUrl":r.get::<_,Option<String>>(5)?,
            "thumbUrl":r.get::<_,Option<String>>(6)?,"results":results,"createdAt":r.get::<_,String>(8)?,
            "completedAt":r.get::<_,Option<String>>(9)?,"error":r.get::<_,Option<String>>(10)?}))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn begin(connection: &Connection, file_id: &str, provider: &str) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    connection.execute(&format!("INSERT INTO provider_runs (id,file_id,provider,status,cached_hit,created_at) VALUES (?1,?2,?3,'RUNNING',0,{NOW})"),params![id,file_id,provider])?;
    Ok(id)
}

pub(crate) fn attach_runs(connection: &Connection, files: &mut [Value]) -> Result<()> {
    const FILES_PER_QUERY: usize = 500;
    let ids = files
        .iter()
        .map(|file| {
            file["id"]
                .as_str()
                .ok_or_else(|| Error::Storage("A library file has no identity.".into()))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut found = std::collections::HashMap::<String, serde_json::Map<String, Value>>::new();
    for batch in ids.chunks(FILES_PER_QUERY) {
        let slots = vec!["?"; batch.len()].join(",");
        let mut statement=connection.prepare(&format!("SELECT file_id,provider,json_object('id',id,'fileId',file_id,'provider',provider,'status',status,
            'cachedHit',json(CASE WHEN cached_hit=0 THEN 'false' ELSE 'true' END),'score',score,'sourceUrl',source_url,'thumbUrl',thumb_url,
            'results',json(coalesce(results,'[]')),'createdAt',created_at,'completedAt',completed_at,'error',error)
            FROM (SELECT *,row_number() OVER (PARTITION BY file_id,provider ORDER BY (status='COMPLETED') DESC,created_at DESC,id DESC) AS latest
                FROM provider_runs WHERE file_id IN ({slots})) WHERE latest=1"))?;
        let rows = statement.query_map(rusqlite::params_from_iter(batch.iter()), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (file, provider, raw) = row?;
            let run = serde_json::from_str(&raw)
                .map_err(|_| Error::Storage("Invalid saved image search result.".into()))?;
            found.entry(file).or_default().insert(provider, run);
        }
    }
    for file in files {
        let id = file["id"]
            .as_str()
            .ok_or_else(|| Error::Storage("A library file has no identity.".into()))?;
        file["providers"] = json!(found.remove(id).unwrap_or_default());
    }
    Ok(())
}

pub(crate) fn finish(
    connection: &Connection,
    snapshot: &File,
    run: &str,
    matches: &[Match],
    error: Option<&str>,
    cached: bool,
) -> Result<bool> {
    if !current(connection, snapshot)? {
        connection.execute(&format!("UPDATE provider_runs SET status='FAILED',error='This file changed during image search. Retry the search.',completed_at={NOW} WHERE id=?1 AND file_id=?2"),params![run,snapshot.id])?;
        return Ok(false);
    }
    let first = matches.first();
    connection.execute(&format!("UPDATE provider_runs SET status=?1,cached_hit=?2,score=?3,source_url=?4,thumb_url=?5,results=?6,error=?7,completed_at={NOW} WHERE id=?8 AND file_id=?9"),
        params![if error.is_some(){"FAILED"}else{"COMPLETED"},cached,first.map(|m|m.score),first.map(|m|m.url.as_str()),
            first.and_then(|m|m.thumbnail.as_deref()),json!(matches.iter().map(Match::json).collect::<Vec<_>>()).to_string(),error,run,snapshot.id])?;
    connection.execute("DELETE FROM provider_runs WHERE file_id=?1
        AND id NOT IN (SELECT id FROM provider_runs WHERE file_id=?1 ORDER BY created_at DESC,id DESC LIMIT 62)
        AND id NOT IN (SELECT id FROM (SELECT id,row_number() OVER (PARTITION BY provider ORDER BY created_at DESC,id DESC) AS latest
            FROM provider_runs WHERE file_id=?1 AND status='COMPLETED') WHERE latest=1)",[&snapshot.id])?;
    Ok(true)
}

pub(crate) fn candidate(site: &Site, raw: &str) -> Option<String> {
    if !site.enabled {
        return None;
    }
    let source = reqwest::Url::parse(raw).ok()?;
    let home = reqwest::Url::parse(&booru_engines::website(site)).ok()?;
    let host = |u: &reqwest::Url| {
        u.host_str()
            .map(|s| s.trim_start_matches("www.").to_ascii_lowercase())
    };
    if host(&source) != host(&home)
        || source.port_or_known_default() != home.port_or_known_default()
        || !source.username().is_empty()
        || source.password().is_some()
        || !matches!(source.scheme(), "http" | "https")
    {
        return None;
    }
    let prefix = match site.engine.as_str() {
        "e621" | "danbooru" => "/posts/",
        "moebooru" | "sankaku" => "/post/show/",
        "philomena" => "/images/",
        "shimmie" => "/post/view/",
        "szurubooru" => "/post/",
        "furaffinity" => "/view/",
        "gelbooru" => {
            if source.path() != "/index.php" {
                return None;
            }
            let pairs = source
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            if pairs.get("page").map(|s| s.as_ref()) != Some("post")
                || pairs.get("s").map(|s| s.as_ref()) != Some("view")
            {
                return None;
            }
            return pairs
                .get("id")
                .and_then(|v| booru_engines::id(&json!(v.as_ref())).ok());
        }
        _ => return None,
    };
    let id = source.path().strip_prefix(prefix)?.trim_end_matches('/');
    if id.contains('/') {
        return None;
    }
    booru_engines::id(&json!(id)).ok()
}

pub(crate) fn apply_tags(
    connection: &mut Connection,
    snapshot: &File,
    site: &Site,
    source_url: &str,
    post: &Value,
) -> Result<bool> {
    if !current(connection, snapshot)? {
        return Ok(false);
    }
    let same_site:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM user_booru_sites WHERE user_id=?1 AND id=?2 AND enabled=1 AND engine=?3 AND base_url=?4 AND username IS ?5 AND api_key IS ?6 AND session_cookie IS ?7 AND preset_key IS ?8)",params![OWNER_ID,site.id,site.engine,site.base,site.username,site.key,site.cookie,site.public["presetKey"].as_str()],|r|r.get(0))?;
    if !same_site {
        return Ok(false);
    }
    let entries = post["tags"]
        .as_array()
        .filter(|v| v.len() <= 10_000)
        .ok_or_else(|| {
            Error::Remote("The source returned invalid tags. Existing tags were kept.".into())
        })?;
    let provider = site.public["presetKey"].as_str().unwrap_or(&site.id);
    let mut validated = Vec::new();
    for entry in entries {
        let name = entry["tag"]
            .as_str()
            .filter(|s| s.len() <= 500)
            .ok_or_else(|| Error::Remote("The source returned an invalid tag.".into()))?;
        let category = entry["category"].as_str().unwrap_or("general");
        if ![
            "general",
            "artist",
            "copyright",
            "character",
            "species",
            "meta",
            "metadata",
            "rating",
            "lore",
            "invalid",
        ]
        .contains(&category)
        {
            return Err(Error::Remote(
                "The source returned an invalid tag category.".into(),
            ));
        }
        let name = tags::normalize(name);
        if !name.is_empty() && !tags::unusable(&name) {
            validated.push((
                name,
                if category == "metadata" {
                    "meta"
                } else {
                    category
                },
            ));
        }
    }
    if validated.is_empty() {
        return Ok(false);
    }
    let categorized = validated.iter().any(|(_, c)| *c != "general");
    let has_categories:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM file_tags WHERE file_id=?1 AND source=?2 AND category<>'general')",params![snapshot.id,provider],|r|r.get(0))?;
    if !categorized && has_categories {
        return Ok(false);
    }
    let tx = connection.transaction()?;
    tx.execute(
        "DELETE FROM file_tags WHERE file_id=?1 AND source=?2",
        params![snapshot.id, provider],
    )?;
    for (name, category) in validated {
        let canonical = tags::canonical(&tx, &name)?;
        tx.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,source_url,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,{NOW},{NOW})"),params![snapshot.id,name,canonical,category,provider,source_url])?;
    }
    tx.commit()?;
    Ok(true)
}

pub(crate) fn matched(connection: &Connection, id: &str) -> Result<bool> {
    let targets = crate::db::read_setting(connection, "source_targets", &json!([]))?;
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM file_tags WHERE file_id=?1 AND source NOT IN ('MANUAL','WD14') AND source_url IS NOT NULL AND (json_array_length(?2)=0 OR lower(source) IN (SELECT lower(value) FROM json_each(?2))))",params![id,targets.to_string()],|r|r.get(0))?)
}

pub(crate) fn known_sources(connection: &Connection, id: &str) -> Result<Vec<(String, String)>> {
    let mut statement=connection.prepare("SELECT DISTINCT source,source_url FROM file_tags WHERE file_id=?1 AND source NOT IN ('MANUAL','WD14') AND source_url IS NOT NULL LIMIT 32")?;
    let rows = statement
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) fn remove_match(connection: &mut Connection, id: &str, url: &str) -> Result<bool> {
    if !file_exists(connection, id)? {
        return Ok(false);
    }
    let tx = connection.transaction()?;
    tx.execute(
        "DELETE FROM file_tags WHERE file_id=?1 AND source_url=?2 AND source<>'MANUAL'",
        params![id, url],
    )?;
    let rows = runs(&tx, id)?;
    for row in rows {
        let mut results = row["results"]
            .as_array()
            .ok_or_else(|| Error::Storage("Invalid saved source matches.".into()))?
            .clone();
        results.retain(|r| r["sourceUrl"] != url);
        let first = results.first();
        tx.execute(
            "UPDATE provider_runs SET results=?1,score=?2,source_url=?3,thumb_url=?4 WHERE id=?5",
            params![
                json!(results).to_string(),
                first.and_then(|v| v["score"].as_f64()),
                first.and_then(|v| v["sourceUrl"].as_str()),
                first.and_then(|v| v["thumbUrl"].as_str()),
                row["id"].as_str()
            ],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> Site {
        Site {
            id: "test".into(),
            name: "Test".into(),
            engine: "e621".into(),
            base: "https://e621.net".into(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: json!({"presetKey":"E621"}),
        }
    }

    #[test]
    fn source_candidates_require_matching_host_and_post_path() {
        assert_eq!(
            candidate(&site(), "https://e621.net/posts/12"),
            Some("12".into())
        );
        for address in [
            "https://e621.net.evil.example/posts/12",
            "https://e621.net/users/12",
            "https://e621.net/posts/12/extra",
            "https://e621.net:444/posts/12",
        ] {
            assert!(candidate(&site(), address).is_none(), "{address}");
        }
    }

    #[tokio::test]
    async fn refresh_preserves_manual_tags_suppressions_and_richer_categories() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        db.call(|c| {
            c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,'/fixture','LOCAL','IDLE',{NOW},{NOW})"),[OWNER_ID])?;
            c.execute("INSERT INTO active_library_folders (id) VALUES ('folder')",[])?;
            c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES ('file','folder','LOCAL','/fixture/image.png',1,{NOW},'digest','IMAGE',{NOW},{NOW})"),[])?;
            c.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,created_at,updated_at) VALUES ('file','manual_tag','manual_tag','general','MANUAL',{NOW},{NOW})"),[])?;
            c.execute(&format!("INSERT INTO file_tag_suppressions (file_id,tag,created_at) VALUES ('file','blue_eyes',{NOW})"),[])?;
            c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,preset_key,enabled,sort_order,created_at,updated_at) VALUES ('test',?1,'Test','e621','https://e621.net',1,'E621',1,0,{NOW},{NOW})"),[OWNER_ID])?;
            let snapshot=file(c,"file")?.unwrap();
            let post=json!({"tags":[{"tag":"test_artist","category":"artist"},{"tag":"blue_eyes","category":"general"}]});
            assert!(apply_tags(c,&snapshot,&site(),"https://e621.net/posts/12",&post)?);
            assert!(!apply_tags(c,&snapshot,&site(),"https://e621.net/posts/12",&json!({"tags":[{"tag":"blue_eyes","category":"general"}]}))?);
            assert!(matched(c,"file")?);
            let good = begin(c,"file","FLUFFLE")?;
            assert!(finish(c,&snapshot,&good,&[],None,false)?);
            for _ in 0..70 {
                let failed = begin(c,"file","FLUFFLE")?;
                assert!(finish(c,&snapshot,&failed,&[],Some("Provider unavailable"),false)?);
            }
            let history = runs(c,"file")?;
            assert!(history.len() <= 64);
            assert!(history.iter().any(|row| row["id"] == good && row["status"] == "COMPLETED"));
            assert_eq!(c.query_row("SELECT count(*) FROM file_tags WHERE source='MANUAL'",[],|r|r.get::<_,i64>(0))?,1);
            assert_eq!(c.query_row("SELECT category FROM file_tags WHERE tag='test_artist'",[],|r|r.get::<_,String>(0))?,"artist");
            assert_eq!(c.query_row("SELECT count(*) FROM file_tag_suppressions WHERE tag='blue_eyes'",[],|r|r.get::<_,i64>(0))?,1);
            c.execute("UPDATE user_booru_sites SET api_key='changed' WHERE id='test'",[])?;
            assert!(!apply_tags(c,&snapshot,&site(),"https://e621.net/posts/12",&post)?);
            c.execute("UPDATE user_booru_sites SET api_key=NULL WHERE id='test'",[])?;
            c.execute("UPDATE files SET sha256='changed' WHERE id='file'",[])?;
            assert!(!apply_tags(c,&snapshot,&site(),"https://e621.net/posts/12",&post)?);
            Ok(())
        }).await.unwrap();
    }
}
