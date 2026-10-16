use crate::{
    db::Database,
    source_store::File,
    wd14_model::{self, Model, ARTIFACTS, REVISION},
    wd14_store, Error, Result,
};
use axum::{extract::State, routing::get, Json, Router};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{watch, Mutex, Notify},
};

pub(crate) struct Job {
    control: Mutex<()>,
    cancel: watch::Sender<u64>,
    wake: Notify,
    pub(crate) progress: Mutex<Value>,
}

impl Default for Job {
    fn default() -> Self {
        Self {
            control: Mutex::new(()),
            cancel: watch::channel(0).0,
            wake: Notify::new(),
            progress: Mutex::new(
                json!({"state":"idle","downloadedBytes":0,"failed":0,"error":null}),
            ),
        }
    }
}

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/tagging", get(status).put(toggle))
}

async fn status(State(db): State<Database>) -> Result<Json<Value>> {
    let (enabled, total, completed) = db
        .call(|c| {
            let (total, completed) = wd14_store::counts(c)?;
            Ok((wd14_store::enabled(c)?, total, completed))
        })
        .await?;
    let progress = db.wd14.progress.lock().await.clone();
    Ok(Json(
        json!({"available":wd14_model::available(),"enabled":enabled,"modelBytes":ARTIFACTS.iter().map(|a|a.1).sum::<u64>(),"model":wd14_model::REPOSITORY,
        "total":total,"completed":completed,"state":progress["state"],"downloadedBytes":progress["downloadedBytes"],"failed":progress["failed"],"error":progress["error"]}),
    ))
}

async fn toggle(State(db): State<Database>, Json(body): Json<Value>) -> Result<Json<Value>> {
    let enabled = body
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.get("enabled"))
        .and_then(Value::as_bool)
        .ok_or_else(|| Error::Invalid("Choose whether to enable automatic tagging.".into()))?;
    if enabled && !wd14_model::available() {
        return Err(Error::Unavailable("Automatic tagging currently requires an AVX2-capable Linux computer. You can still add tags by hand."));
    }
    {
        let _guard = db.wd14.control.lock().await;
        db.call(move |c| wd14_store::set_enabled(c, enabled))
            .await?;
        db.wd14.cancel.send_modify(|n| *n = n.wrapping_add(1));
        *db.wd14.progress.lock().await = json!({"state":if enabled {"starting"} else {"idle"},"downloadedBytes":0,"failed":0,"error":null});
    }
    db.wd14.wake.notify_one();
    status(State(db)).await
}

fn permitted_download(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            host == "huggingface.co"
                || host == "hf.co"
                || host.ends_with(".huggingface.co")
                || host.ends_with(".hf.co")
        })
}

async fn download(db: &Database, directory: &Path) -> Result<()> {
    tokio::fs::create_dir_all(directory).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30 * 60))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !permitted_download(attempt.url()) {
                attempt.error("WD14 download redirected outside its model host")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| Error::Remote(format!("Cannot start the WD14 download: {e}")))?;
    let mut downloaded = 0u64;
    for (name, size, expected) in ARTIFACTS {
        let destination = directory.join(name);
        let check = destination.clone();
        let valid = tokio::task::spawn_blocking(move || wd14_model::verify(&check, size, expected))
            .await
            .map_err(|e| Error::Storage(e.to_string()))?
            .is_ok();
        if valid {
            downloaded += size;
            continue;
        }
        let temporary = tempfile::NamedTempFile::new_in(directory)?;
        let mut file = tokio::fs::File::from_std(temporary.reopen()?);
        let url = format!(
            "https://huggingface.co/{}/resolve/{REVISION}/{name}",
            wd14_model::REPOSITORY
        );
        let response = client.get(url).send().await.and_then(reqwest::Response::error_for_status)
            .map_err(|e|Error::Remote(format!("WD14 could not download. Check your connection and enable tagging to retry. {e}")))?;
        if response.content_length().is_some_and(|n| n != size) {
            return Err(Error::Remote(
                "WD14 returned an unexpected download size. Retry later.".into(),
            ));
        }
        let mut stream = response.bytes_stream();
        let mut received = 0u64;
        let mut hash = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                Error::Remote(format!(
                    "WD14 download stopped. Enable tagging to retry. {e}"
                ))
            })?;
            received += chunk.len() as u64;
            if received > size {
                return Err(Error::Remote(
                    "WD14 download exceeded its expected size.".into(),
                ));
            }
            hash.update(&chunk);
            file.write_all(&chunk).await?;
            *db.wd14.progress.lock().await = json!({"state":"downloading","downloadedBytes":downloaded+received,"failed":0,"error":null});
        }
        let actual = hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if received != size || actual != expected {
            return Err(Error::Remote(
                "WD14 download failed verification. Enable tagging to retry.".into(),
            ));
        }
        file.sync_all().await?;
        drop(file);
        temporary.persist(&destination).map_err(|e| {
            Error::Storage(format!(
                "Cannot save WD14. Check free space and folder permissions. {e}"
            ))
        })?;
        downloaded += size;
    }
    Ok(())
}

async fn tag(
    db: &Database,
    model: Arc<std::sync::Mutex<Model>>,
    file: &File,
) -> Result<Vec<wd14_model::Tag>> {
    let path = db
        .library()
        .resolve_file(Path::new(&file.folder), Path::new(&file.path))?;
    let metadata = tokio::fs::metadata(&path).await?;
    if i64::try_from(metadata.len()).ok() != Some(file.size)
        || crate::library::iso_millis(metadata.modified()?) != file.mtime
    {
        return Err(Error::Remote(
            "A file changed before tagging. It will be tagged after the library scan.".into(),
        ));
    }
    let kind = match file.kind.as_str() {
        "VIDEO" => crate::media::MediaKind::Video,
        "IMAGE" => crate::media::MediaKind::Image,
        _ => {
            return Err(Error::Invalid(
                "This media type cannot be tagged. Add tags by hand in Gallery.".into(),
            ))
        }
    };
    let bytes = crate::media::tagging_image(&path, kind).await?;
    let after = tokio::fs::metadata(&path).await?;
    if after.len() != metadata.len() || after.modified()? != metadata.modified()? {
        return Err(Error::Remote(
            "A file changed while preparing its tags. Refresh the library to retry.".into(),
        ));
    }
    let tags = tokio::task::spawn_blocking(move || {
        model
            .lock()
            .map_err(|_| {
                Error::Storage("WD14 model lock failed. Restart the app to retry.".into())
            })?
            .tag(&bytes)
    })
    .await
    .map_err(|e| Error::Storage(format!("WD14 inference stopped: {e}")))??;
    let after = tokio::fs::metadata(&path).await?;
    if after.len() != metadata.len() || after.modified()? != metadata.modified()? {
        return Err(Error::Remote(
            "A file changed during tagging. Refresh the library to retry.".into(),
        ));
    }
    Ok(tags)
}

async fn process(db: &Database, generation: u64) -> Result<()> {
    let directory: PathBuf = db.library().models.join("wd14").join(REVISION);
    let mut cancellation = db.wd14.cancel.subscribe();
    tokio::select! {
        biased;
        _=cancellation.wait_for(|n|*n!=generation)=>return Ok(()),
        result=download(db,&directory)=>result?,
    }
    if *cancellation.borrow() != generation {
        return Ok(());
    }
    *db.wd14.progress.lock().await = json!({"state":"loading","downloadedBytes":ARTIFACTS.iter().map(|a|a.1).sum::<u64>(),"failed":0,"error":null});
    let model = tokio::task::spawn_blocking(move || Model::load(&directory))
        .await
        .map_err(|e| Error::Storage(e.to_string()))??;
    let model = Arc::new(std::sync::Mutex::new(model));
    let mut failed = Vec::new();
    let mut last_error = None;
    loop {
        if *db.wd14.cancel.borrow() != generation {
            return Ok(());
        }
        let exclusions = failed.clone();
        let next = db
            .call(move |c| wd14_store::pending(c, &exclusions))
            .await?;
        *db.wd14.progress.lock().await = json!({"state":if next.is_some(){"tagging"}else if failed.is_empty(){"ready"}else{"failed"},"downloadedBytes":ARTIFACTS.iter().map(|a|a.1).sum::<u64>(),"failed":failed.len(),"error":last_error});
        let Some(file) = next else {
            tokio::select! {
                _=cancellation.wait_for(|n|*n!=generation)=>return Ok(()),
                _=tokio::time::sleep(Duration::from_secs(10))=>{},
            }
            continue;
        };
        let sha = file.sha256.clone();
        let cached = db.call(move |c| wd14_store::cached(c, &sha)).await?;
        let result = match cached {
            Some(tags) => Ok(tags),
            None => tag(db, model.clone(), &file).await,
        };
        match result {
            Ok(tags) => {
                if !finish(db, generation, &file, tags).await? {
                    if *db.wd14.cancel.borrow() != generation {
                        return Ok(());
                    }
                    failed.push(file.id);
                    last_error = Some("A file changed during tagging. Turn tagging off and on after the next library scan to retry.".to_owned());
                }
            }
            Err(error) => {
                let name = Path::new(&file.path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("this file");
                last_error = Some(format!("Could not tag {name}. {error} Check the file in Gallery, then turn tagging off and on to retry."));
                failed.push(file.id);
            }
        }
        if failed.len() >= 100 {
            return Err(Error::Remote("Tagging stopped after 100 unreadable files. Check the files and turn tagging on to retry.".into()));
        }
    }
}

async fn finish(
    db: &Database,
    generation: u64,
    snapshot: &File,
    tags: Vec<wd14_model::Tag>,
) -> Result<bool> {
    let _guard = db.wd14.control.lock().await;
    if *db.wd14.cancel.borrow() != generation {
        return Ok(false);
    }
    let snapshot = snapshot.clone();
    db.call(move |c| {
        if !wd14_store::enabled(c)? {
            return Ok(false);
        }
        wd14_store::apply(c, &snapshot, &tags)
    })
    .await
}

pub(crate) async fn watch(db: Database) {
    loop {
        let generation = *db.wd14.cancel.borrow();
        let enabled = match db.call(|c| wd14_store::enabled(c)).await {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Cannot read WD14 settings: {error}");
                false
            }
        };
        if enabled && wd14_model::available() {
            // Wait for in-flight CPU work before restarting; stopping never starts a second model.
            if let Err(error) = process(&db, generation).await {
                eprintln!("Automatic tagging: {error}");
                let _guard = db.wd14.control.lock().await;
                if *db.wd14.cancel.borrow() == generation {
                    if let Err(error) = db.call(|c| wd14_store::set_enabled(c, false)).await {
                        eprintln!("Cannot stop failed WD14 job: {error}");
                    }
                    let mut progress = db.wd14.progress.lock().await;
                    progress["state"] = json!("failed");
                    progress["error"] = json!(match error {
                        Error::Io(_) | Error::Sqlite(_) => "Automatic tagging could not read or save its files. Check free space and folder permissions, then enable tagging to retry.".to_owned(),
                        _ => error.to_string(),
                    });
                }
            }
        }
        db.wd14.wake.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_model_hosts_can_receive_download_redirects() {
        for url in [
            "https://huggingface.co/model",
            "https://cas-bridge.xethub.hf.co/blob",
        ] {
            assert!(permitted_download(&url.parse().unwrap()));
        }
        for url in [
            "http://huggingface.co/model",
            "https://huggingface.co.evil.example/model",
            "https://127.0.0.1/model",
            "https://user@huggingface.co/model",
            "https://hf.co:444/model",
        ] {
            assert!(!permitted_download(&url.parse().unwrap()));
        }
    }

    #[tokio::test]
    async fn cancelled_or_disabled_jobs_cannot_overwrite_tags() {
        use crate::{db::OWNER_ID, library::NOW};
        let temporary = tempfile::tempdir().unwrap();
        let db = Database::open(
            &temporary.path().join("data"),
            &temporary.path().join("library"),
        )
        .unwrap();
        let snapshot = db.call(|c| {
            c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,'/fixture','LOCAL','IDLE',{NOW},{NOW})"),[OWNER_ID])?;
            c.execute("INSERT INTO active_library_folders (id) VALUES ('folder')",[])?;
            c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES ('file','folder','LOCAL','/fixture/image.png',1,{NOW},'digest','IMAGE',{NOW},{NOW})"),[])?;
            c.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,created_at,updated_at) VALUES ('file','manual_tag','manual_tag','general','MANUAL',{NOW},{NOW})"),[])?;
            c.execute(&format!("INSERT INTO file_tag_suppressions (file_id,tag,created_at) VALUES ('file','blue_eyes',{NOW})"),[])?;
            wd14_store::set_enabled(c,true)?;
            Ok(crate::source_store::file(c,"file")?.unwrap())
        }).await.unwrap();
        let tags = vec![wd14_model::Tag {
            name: "blue_eyes".into(),
            category: "general",
            score: 0.8,
        }];
        let old = *db.wd14.cancel.borrow();
        db.wd14.cancel.send_modify(|n| *n += 1);
        assert!(!finish(&db, old, &snapshot, tags.clone()).await.unwrap());
        let current = *db.wd14.cancel.borrow();
        assert!(finish(&db, current, &snapshot, tags.clone()).await.unwrap());
        db.call(|c| wd14_store::set_enabled(c, false))
            .await
            .unwrap();
        assert!(!finish(&db, current, &snapshot, Vec::new()).await.unwrap());
        db.call(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM file_tags WHERE source='MANUAL'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM file_tags WHERE source='WD14'",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                1
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM file_tag_suppressions", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                c.query_row("SELECT count(*) FROM wd14_results", [], |r| r
                    .get::<_, i64>(0))?,
                1
            );
            Ok(())
        })
        .await
        .unwrap();
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
    #[tokio::test]
    #[ignore = "Downloads 389 MB of pinned model weights; CI runs this integration test separately"]
    async fn matches_python_reference_images() {
        let temporary = tempfile::tempdir().unwrap();
        let db = Database::open(
            &temporary.path().join("data"),
            &temporary.path().join("library"),
        )
        .unwrap();
        let directory = temporary.path().join("model");
        download(&db, &directory).await.unwrap();
        let mut model = Model::load(&directory).unwrap();
        let reference: Value =
            serde_json::from_str(include_str!("../tests/fixtures/wd14/python-tags.json")).unwrap();
        for (name, bytes) in [
            (
                "solid",
                include_bytes!("../tests/fixtures/wd14/solid.png").as_slice(),
            ),
            (
                "gradient",
                include_bytes!("../tests/fixtures/wd14/gradient.png").as_slice(),
            ),
            (
                "pattern",
                include_bytes!("../tests/fixtures/wd14/pattern.png").as_slice(),
            ),
        ] {
            let tags = model.tag(bytes).unwrap();
            let expected = wd14_store::parse(&reference[name].to_string()).unwrap();
            assert_eq!(tags.len(), expected.len(), "{name}: different tag count");
            for tag in tags {
                let expected = expected
                    .iter()
                    .find(|t| t.name == tag.name)
                    .unwrap_or_else(|| panic!("{name}: unexpected tag {}", tag.name));
                assert_eq!(
                    tag.category, expected.category,
                    "{name}: {} category",
                    tag.name
                );
                assert!(
                    (tag.score - expected.score).abs() <= 0.001,
                    "{name}: {} score {} vs {}",
                    tag.name,
                    tag.score,
                    expected.score
                );
            }
        }
    }
}
