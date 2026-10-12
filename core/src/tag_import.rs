use crate::{db::Database, library::NOW, tags, Error, Result};
use axum::{extract::State, routing::get, Json, Router};
use flate2::read::GzDecoder;
use reqwest::{Client, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    io::Read,
    path::Path,
    time::Duration,
};
use tokio::io::AsyncWriteExt;

const EXPORT: &str = "https://static1.e621.net/data/db_export";
const DANBOORU: &str = "https://danbooru.donmai.us";
const WEEK: i64 = 7 * 24 * 60 * 60;
const PAGE_SIZE: usize = 1000;
const NAME_BUDGET: usize = 4000;
const MAX_EXPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const RETRIES: &[u64] = &[2, 10, 30];
const VERSION: &str = "2";
const MAX_RELATION_ROWS: usize = 1_000_000;
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const RETRY_INTERVAL_SECONDS: i64 = 60 * 60;

type Graph = BTreeMap<String, BTreeSet<String>>;

fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Storage(format!("tag database import: {error}"))
}

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/tags/database", get(status).post(request_refresh))
}

fn meta(c: &Connection, key: &str) -> Result<Option<String>> {
    Ok(
        c.query_row("SELECT value FROM tag_db_meta WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()?,
    )
}
fn set_meta(c: &Connection, key: &str, value: &str) -> Result<()> {
    c.execute("INSERT INTO tag_db_meta (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
    Ok(())
}

async fn status(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| {
        Ok(Json(
            json!({"state":meta(c,"state")?.unwrap_or_else(||"waiting".into()),
        "importedAt":meta(c,"imported_at")?,"error":meta(c,"error")?}),
        ))
    })
    .await
}

async fn request_refresh(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| {
        let tx = c.transaction()?;
        let state = meta(&tx, "state")?;
        if state.as_deref() != Some("running") {
            set_meta(&tx, "state", "queued")?;
        }
        tx.commit()?;
        Ok(Json(json!({"status":"queued"})))
    })
    .await
}

fn needs_refresh(c: &Connection) -> Result<bool> {
    let requested = meta(c, "state")?.as_deref() == Some("queued");
    let has_tags:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM file_tags ft JOIN files f ON f.id=ft.file_id JOIN library_folders fo ON fo.id=f.folder_id)",[],|r|r.get(0))?;
    let stale:bool=c.query_row("SELECT COALESCE((SELECT value<>?1 FROM tag_db_meta WHERE key='import_version'),1)
                OR COALESCE((SELECT unixepoch(value)<=unixepoch()-?2 OR unixepoch(value) IS NULL FROM tag_db_meta WHERE key='imported_at'),1)",params![VERSION,WEEK],|r|r.get(0))?;
    let retry:bool=c.query_row("SELECT COALESCE((SELECT unixepoch(value)<=unixepoch()-?1 FROM tag_db_meta WHERE key='attempted_at'),1)",[RETRY_INTERVAL_SECONDS],|r|r.get(0))?;
    Ok(requested || (has_tags && stale && retry))
}

pub(crate) async fn watch(db: Database) {
    // The first tick is delayed so opening the library never waits for remote vocabulary.
    let mut timer =
        tokio::time::interval_at(tokio::time::Instant::now() + POLL_INTERVAL, POLL_INTERVAL);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // A process interruption leaves no half-import, but must permit the next attempt.
    if let Err(e) = db
        .call(|c| {
            if meta(c, "state")?.as_deref() == Some("running") {
                set_meta(c, "state", "queued")?;
            }
            Ok(())
        })
        .await
    {
        eprintln!("Cannot resume tag database import: {e}");
    }
    loop {
        timer.tick().await;
        let due = db.call(|c| needs_refresh(c)).await;
        match due {
            Ok(true) => {
                if let Err(e) = refresh(&db).await {
                    eprintln!("Tag database refresh failed; previous vocabulary retained: {e}");
                    if let Err(e)=db.call(|c| {let tx=c.transaction()?;set_meta(&tx,"state","failed")?;
                    set_meta(&tx,"error","The tag vocabulary could not be downloaded. Check your connection and try again. Your saved tags and previous vocabulary are still available.")?;tx.commit()?;Ok(())}).await {
                    eprintln!("Cannot save tag database failure: {e}");
                }
                }
            }
            Ok(false) => {}
            Err(e) => eprintln!("Cannot check tag database refresh: {e}"),
        }
    }
}

async fn response(client: &Client, url: Url) -> Result<reqwest::Response> {
    for attempt in 0..=RETRIES.len() {
        let response = client.get(url.clone()).send().await;
        match response {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r)
                if r.status().as_u16() == 429
                    || [500, 502, 503, 504, 520, 521, 522, 523, 524]
                        .contains(&r.status().as_u16()) =>
            {
                if attempt == RETRIES.len() {
                    return Err(invalid(format!("{} returned {}", url.path(), r.status())));
                }
            }
            Ok(r) => return Err(invalid(format!("{} returned {}", url.path(), r.status()))),
            Err(e) => {
                if attempt == RETRIES.len() {
                    return Err(invalid(e.without_url()));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(RETRIES[attempt])).await;
    }
    unreachable!()
}

async fn json_page(client: &Client, url: Url) -> Result<Vec<Value>> {
    let mut response = response(client, url).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| invalid(e.without_url()))?
    {
        if bytes.len() + chunk.len() > MAX_JSON_BYTES {
            return Err(invalid("API page exceeds the size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(invalid)?;
    value
        .as_array()
        .cloned()
        .ok_or_else(|| invalid("API page is not an array"))
}

async fn download(client: &Client, name: &str, directory: &Path) -> Result<std::path::PathBuf> {
    let url = Url::parse(&format!("{EXPORT}/{name}.csv.gz")).map_err(invalid)?;
    let mut response = response(client, url).await?;
    let path = directory.join(format!("{name}.csv.gz"));
    let mut file = tokio::fs::File::create(&path).await?;
    let mut size = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| invalid(e.without_url()))?
    {
        size += chunk.len() as u64;
        if size > MAX_EXPORT_BYTES {
            return Err(invalid("export exceeds the download size limit"));
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(path)
}

fn pair(row: &Value) -> Result<(String, String)> {
    let a = row
        .get("antecedent_name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("missing antecedent_name"))?;
    let b = row
        .get("consequent_name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("missing consequent_name"))?;
    Ok((a.into(), b.into()))
}

fn usable_pair(a: &str, b: &str, alias: bool) -> Option<(String, String)> {
    if tags::normalize(a) != a || (alias && tags::unusable(b)) {
        return None;
    }
    let b = tags::normalize(b);
    (!a.is_empty() && !b.is_empty() && a != b).then(|| (a.into(), b))
}

async fn relations(client: &Client, base: &str, name: &str) -> Result<Vec<(String, String)>> {
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let mut url = Url::parse(&format!("{base}/{name}.json")).map_err(invalid)?;
        url.query_pairs_mut()
            .append_pair("limit", &PAGE_SIZE.to_string())
            .append_pair("search[status]", "active")
            .append_pair("only", "id,antecedent_name,consequent_name");
        if let Some(id) = cursor {
            url.query_pairs_mut().append_pair("page", &format!("b{id}"));
        }
        let page = json_page(client, url).await?;
        if page.len() > PAGE_SIZE {
            return Err(invalid("oversized relation page"));
        }
        let mut next = None;
        for row in &page {
            let id = row
                .get("id")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0)
                .ok_or_else(|| invalid("invalid relation id"))?;
            if next.is_some_and(|previous| id >= previous)
                || cursor.is_some_and(|cursor| id >= cursor)
            {
                return Err(invalid("relation cursor did not advance"));
            }
            next = Some(id);
            rows.push(pair(row)?);
        }
        if rows.len() > MAX_RELATION_ROWS {
            return Err(invalid("relation table exceeds the supported size"));
        }
        if page.len() < PAGE_SIZE {
            return Ok(rows);
        }
        cursor = next;
    }
}

fn category(code: &str, e621: bool) -> Option<&'static str> {
    match code {
        "0" => Some("general"),
        "1" => Some("artist"),
        "3" => Some("copyright"),
        "4" => Some("character"),
        "5" => Some(if e621 { "species" } else { "meta" }),
        "7" if e621 => Some("meta"),
        "8" if e621 => Some("lore"),
        _ => None,
    }
}

fn csv_rows(
    reader: impl Read,
    required: &[&str],
    mut apply: impl FnMut(&csv::StringRecord, &[usize]) -> Result<()>,
) -> Result<()> {
    let mut reader = csv::Reader::from_reader(reader);
    let header = reader.headers().map_err(invalid)?.clone();
    let indexes = required
        .iter()
        .map(|name| {
            header
                .iter()
                .position(|h| h == *name)
                .ok_or_else(|| invalid(format!("missing CSV column {name}")))
        })
        .collect::<Result<Vec<_>>>()?;
    for row in reader.records() {
        let row = row.map_err(invalid)?;
        apply(&row, &indexes)?;
    }
    if reader.position().byte() > MAX_EXPORT_BYTES * 4 {
        return Err(invalid("decompressed export exceeds the size limit"));
    }
    Ok(())
}

fn read_export(path: &Path) -> Result<impl Read> {
    // Bound the decompressed stream as well as the compressed download.
    Ok(GzDecoder::new(std::fs::File::open(path)?).take(MAX_EXPORT_BYTES * 4 + 1))
}

fn closure(direct: &Graph) -> Graph {
    let mut result = Graph::new();
    for tag in direct.keys() {
        let mut seen = BTreeSet::new();
        let mut pending = vec![tag.clone()];
        while let Some(current) = pending.pop() {
            for parent in direct.get(&current).into_iter().flatten() {
                if parent != tag && seen.insert(parent.clone()) {
                    pending.push(parent.clone());
                }
            }
        }
        result.insert(tag.clone(), seen);
    }
    result
}

fn stage(
    directory: &Path,
    dan_aliases: Vec<(String, String)>,
    dan_implications: Vec<(String, String)>,
) -> Result<()> {
    let mut c = Connection::open(directory.join("vocabulary.sqlite"))?;
    c.execute_batch("CREATE TABLE tag_aliases (antecedent TEXT PRIMARY KEY,consequent TEXT NOT NULL,source TEXT NOT NULL);
        CREATE TABLE tag_implications (tag TEXT NOT NULL,implied TEXT NOT NULL,PRIMARY KEY(tag,implied));
        CREATE TABLE tag_categories (tag TEXT PRIMARY KEY,category TEXT NOT NULL);")?;
    let tx = c.transaction()?;
    let mut claimed = HashSet::new();
    csv_rows(
        read_export(&directory.join("tag_aliases.csv.gz"))?,
        &["status", "antecedent_name", "consequent_name"],
        |r, i| {
            if &r[i[0]] == "active" {
                if let Some((a, b)) = usable_pair(&r[i[1]], &r[i[2]], true) {
                    claimed.insert(a.clone());
                    claimed.insert(b.clone());
                    tx.execute(
                        "INSERT OR IGNORE INTO tag_aliases VALUES (?1,?2,'e621')",
                        params![a, b],
                    )?;
                }
            }
            Ok(())
        },
    )?;
    for (a, b) in dan_aliases {
        if let Some((a, b)) = usable_pair(&a, &b, true) {
            if !claimed.contains(&a) {
                tx.execute(
                    "INSERT OR IGNORE INTO tag_aliases VALUES (?1,?2,'danbooru')",
                    params![a, b],
                )?;
            }
        }
    }
    let mut direct = Graph::new();
    csv_rows(
        read_export(&directory.join("tag_implications.csv.gz"))?,
        &["status", "antecedent_name", "consequent_name"],
        |r, i| {
            if &r[i[0]] == "active" {
                if let Some((a, b)) = usable_pair(&r[i[1]], &r[i[2]], false) {
                    direct.entry(a).or_default().insert(b);
                }
            }
            Ok(())
        },
    )?;
    for (a, b) in dan_implications {
        if let Some((a, b)) = usable_pair(&a, &b, false) {
            direct.entry(a).or_default().insert(b);
        }
    }
    {
        let mut insert = tx.prepare("INSERT INTO tag_implications VALUES (?1,?2)")?;
        for (tag, parents) in closure(&direct) {
            for parent in parents {
                insert.execute(params![tag, parent])?;
            }
        }
    }
    {
        let mut insert = tx.prepare("INSERT OR IGNORE INTO tag_categories VALUES (?1,?2)")?;
        csv_rows(
            read_export(&directory.join("tags.csv.gz"))?,
            &["name", "category", "post_count"],
            |r, i| {
                let name = &r[i[0]];
                let count = r[i[2]].parse::<i64>().map_err(invalid)?;
                if count > 0 && tags::normalize(name) == name {
                    if let Some(category) = category(&r[i[1]], true) {
                        insert.execute(params![name, category])?;
                    }
                }
                Ok(())
            },
        )?;
    }
    for table in ["tag_aliases", "tag_implications", "tag_categories"] {
        let count: i64 =
            tx.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
        if count == 0 {
            return Err(invalid(format!("empty {table} export")));
        }
    }
    tx.commit()?;
    Ok(())
}

async fn categories(client: &Client, names: Vec<String>) -> Result<Vec<(String, String)>> {
    let mut found = Vec::new();
    let mut start = 0;
    while start < names.len() {
        let mut end = start;
        let mut cost = 0;
        while end < names.len() && end - start < PAGE_SIZE {
            let encoded =
                Url::parse_with_params(DANBOORU, [("n", &names[end])]).map_err(invalid)?;
            let bytes = encoded.query().unwrap_or("").len() + 3;
            if cost + bytes > NAME_BUDGET {
                if end == start {
                    return Err(invalid("tag name exceeds URL budget"));
                }
                break;
            }
            cost += bytes;
            end += 1;
        }
        let mut url = Url::parse(&format!("{DANBOORU}/tags.json")).map_err(invalid)?;
        url.query_pairs_mut()
            .append_pair("limit", &(end - start).to_string())
            .append_pair("only", "name,category,post_count")
            .append_pair("search[name_comma]", &names[start..end].join(","));
        for row in json_page(client, url).await? {
            let name = row
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("invalid category name"))?;
            let code = row
                .get("category")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("invalid category code"))?;
            let count = row
                .get("post_count")
                .and_then(Value::as_i64)
                .ok_or_else(|| invalid("invalid category post count"))?;
            if count > 0 && tags::normalize(name) == name {
                if let Some(cat) = category(&code.to_string(), false) {
                    if cat != "general" {
                        found.push((name.into(), cat.into()));
                    }
                }
            }
        }
        start = end;
    }
    Ok(found)
}

fn apply(c: &mut Connection, path: &Path) -> Result<()> {
    c.execute(
        "ATTACH DATABASE ?1 AS vocabulary",
        [path.to_string_lossy().as_ref()],
    )?;
    let result: Result<()> = (|| {
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM tag_aliases WHERE source IN ('e621','danbooru')",
            [],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO tag_aliases SELECT * FROM vocabulary.tag_aliases",
            [],
        )?;
        tx.execute("DELETE FROM tag_implications", [])?;
        tx.execute(
            "INSERT INTO tag_implications SELECT * FROM vocabulary.tag_implications",
            [],
        )?;
        tx.execute("DELETE FROM tag_categories", [])?;
        tx.execute(
            "INSERT INTO tag_categories SELECT * FROM vocabulary.tag_categories",
            [],
        )?;
        let names = {
            let mut s = tx.prepare("SELECT DISTINCT tag FROM file_tags")?;
            let rows = s
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for tag in names {
            let canonical = tags::canonical(&tx, &tag)?;
            tx.execute(
                "UPDATE file_tags SET canonical_tag=?1 WHERE tag=?2 AND canonical_tag<>?1",
                params![canonical, tag],
            )?;
        }
        tx.execute("UPDATE file_tags SET category=(SELECT category FROM tag_categories WHERE tag=file_tags.tag)
            WHERE source<>'MANUAL' AND category='general' AND EXISTS(SELECT 1 FROM tag_categories WHERE tag=file_tags.tag AND category<>'general')",[])?;
        tx.execute(&format!("INSERT INTO tag_db_meta (key,value) VALUES ('imported_at',{NOW}) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),[])?;
        set_meta(&tx, "import_version", VERSION)?;
        set_meta(&tx, "state", "ready")?;
        set_meta(&tx, "imported_from", &format!("{EXPORT} {DANBOORU}"))?;
        tx.execute("DELETE FROM tag_db_meta WHERE key='error'", [])?;
        tx.commit()?;
        Ok(())
    })();
    let detached = c.execute_batch("DETACH DATABASE vocabulary");
    result?;
    detached?;
    Ok(())
}

async fn refresh(db: &Database) -> Result<()> {
    db.call(|c| {let tx=c.transaction()?;set_meta(&tx,"state","running")?;
        tx.execute(&format!("INSERT INTO tag_db_meta (key,value) VALUES ('attempted_at',{NOW}) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),[])?;tx.commit()?;Ok(())}).await?;
    let client = Client::builder()
        .user_agent("GoonCave/0.0 (https://github.com/LiukScot/gooncave)")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(invalid)?;
    let directory = std::sync::Arc::new(tempfile::tempdir()?);
    for name in ["tag_aliases", "tag_implications", "tags"] {
        download(&client, name, directory.path()).await?;
    }
    let aliases = relations(&client, DANBOORU, "tag_aliases").await?;
    let implications = relations(&client, DANBOORU, "tag_implications").await?;
    let stage_directory = directory.clone();
    tokio::task::spawn_blocking(move || stage(stage_directory.path(), aliases, implications))
        .await
        .map_err(invalid)??;
    let names=db.call(|c| {let mut s=c.prepare("SELECT DISTINCT ft.tag FROM file_tags ft JOIN files f ON f.id=ft.file_id JOIN library_folders fo ON fo.id=f.folder_id WHERE ft.source<>'MANUAL' AND ft.category='general' ORDER BY ft.tag")?;
        let names=s.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(names)}).await?;
    let staging = directory.path().join("vocabulary.sqlite");
    let path = staging.clone();
    let missing_directory = directory.clone();
    let missing = tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
        let _directory = missing_directory;
        let c = Connection::open(path)?;
        let mut missing = Vec::new();
        for name in names {
            let exists: bool = c.query_row(
                "SELECT EXISTS(SELECT 1 FROM tag_categories WHERE tag=?1)",
                [&name],
                |r| r.get(0),
            )?;
            if !exists {
                missing.push(name);
            }
        }
        Ok(missing)
    })
    .await
    .map_err(invalid)??;
    let categories = categories(&client, missing).await?;
    let path = staging.clone();
    let category_directory = directory.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _directory = category_directory;
        let mut c = Connection::open(path)?;
        let tx = c.transaction()?;
        for (tag, category) in categories {
            tx.execute(
                "INSERT OR IGNORE INTO tag_categories VALUES (?1,?2)",
                params![tag, category],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(invalid)??;
    // Keep the temporary directory alive until the blocking transaction has finished, even on cancellation.
    db.call(move |c| {
        let _directory = directory;
        apply(c, &staging)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn export(dir: &Path, name: &str, text: &str) {
        let file = std::fs::File::create(dir.join(format!("{name}.csv.gz"))).unwrap();
        let mut gzip = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        gzip.write_all(text.as_bytes()).unwrap();
        gzip.finish().unwrap();
    }
    #[test]
    fn imports_quoted_csv_conflicting_aliases_categories_and_cyclic_implications() {
        let dir = tempfile::tempdir().unwrap();
        export(dir.path(),"tag_aliases","status,antecedent_name,consequent_name,reason\nactive,puppy,dog,\"two,\nlines\"\nactive,2d,invalid_tag,x\nactive,female/?,ambiguous,x\npending,old,new,x\n");
        export(dir.path(),"tag_implications","status,antecedent_name,consequent_name\nactive,dog,animal\nactive,animal,living\nactive,living,animal\n");
        export(
            dir.path(),
            "tags",
            "name,category,post_count\ndog,5,2\nplain,0,3\ndead,1,0\ninvalid,6,3\n",
        );
        stage(
            dir.path(),
            vec![
                ("dog".into(), "puppy".into()),
                ("hound".into(), "dog".into()),
            ],
            vec![("puppy".into(), "dog".into())],
        )
        .unwrap();
        let c = Connection::open(dir.path().join("vocabulary.sqlite")).unwrap();
        assert_eq!(tags::canonical(&c, "hound").unwrap(), "dog");
        assert_eq!(tags::canonical(&c, "2d").unwrap(), "2d");
        let count: i64 = c
            .query_row(
                "SELECT count(*) FROM tag_implications WHERE tag='dog'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        let category: String = c
            .query_row(
                "SELECT category FROM tag_categories WHERE tag='dog'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(category, "species");
        let count: i64 = c
            .query_row("SELECT count(*) FROM tag_categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
    #[test]
    fn malformed_csv_is_rejected_before_replacing_the_vocabulary() {
        assert!(csv_rows(
            "name,category\ndog,1\n".as_bytes(),
            &["name", "category", "post_count"],
            |_, _| Ok(())
        )
        .is_err());
        assert!(pair(&json!({"id":1,"antecedent_name":"a"})).is_err());
    }
    #[tokio::test]
    async fn vocabulary_replacement_is_atomic_and_preserves_custom_aliases_and_manual_categories() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap();
        let stage_dir = tempfile::tempdir().unwrap();
        export(
            stage_dir.path(),
            "tag_aliases",
            "status,antecedent_name,consequent_name\nactive,puppy,dog\n",
        );
        export(
            stage_dir.path(),
            "tag_implications",
            "status,antecedent_name,consequent_name\nactive,dog,animal\n",
        );
        export(
            stage_dir.path(),
            "tags",
            "name,category,post_count\npuppy,5,1\n",
        );
        stage(stage_dir.path(), vec![], vec![]).unwrap();
        let path = stage_dir.path().join("vocabulary.sqlite");
        let staged = path.clone();
        db.call(move |c| {
            c.execute_batch("INSERT INTO folders (id,user_id,path,type,created_at,updated_at,status) VALUES ('f','device-owner','/example','LOCAL','now','now','IDLE');
                INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES ('f','f','LOCAL','a',1,'now','a','IMAGE','now','now');
                INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,created_at,updated_at) VALUES ('f','puppy','puppy','artist','MANUAL','now','now'),('f','puppy','puppy','general','E621','now','now');
                INSERT INTO tag_aliases VALUES ('puppy','custom_dog','custom'),('old','old_tag','e621');
                CREATE TRIGGER fail_import BEFORE INSERT ON tag_db_meta WHEN NEW.key='imported_at' BEGIN SELECT RAISE(ABORT,'disk failure'); END;")?;
            assert!(apply(c,&staged).is_err());
            assert_eq!(tags::canonical(c,"old")?,"old_tag");
            assert_eq!(meta(c,"imported_at")?,None);
            c.execute_batch("DROP TRIGGER fail_import")?;
            apply(c,&staged)?;
            assert_eq!(tags::canonical(c,"puppy")?,"custom_dog");
            assert_eq!(tags::canonical(c,"old")?,"old");
            assert_eq!(meta(c,"state")?.as_deref(),Some("ready"));
            c.execute("INSERT INTO active_library_folders (id) VALUES ('f')",[])?;
            assert!(!needs_refresh(c)?);
            c.execute("UPDATE tag_db_meta SET value='2000-01-01T00:00:00Z' WHERE key='imported_at'",[])?;
            assert!(needs_refresh(c)?);
            c.execute(&format!("INSERT INTO tag_db_meta VALUES ('attempted_at',{NOW})"),[])?;
            assert!(!needs_refresh(c)?);
            set_meta(c,"state","queued")?;
            assert!(needs_refresh(c)?);
            for (source,expected) in [("MANUAL","artist"),("E621","species")] {
                let (canonical,category):(String,String)=c.query_row("SELECT canonical_tag,category FROM file_tags WHERE source=?1",[source],|r|Ok((r.get(0)?,r.get(1)?)))?;
                assert_eq!(canonical,"custom_dog");assert_eq!(category,expected);
            }
            Ok(())
        }).await.unwrap();
    }
}
