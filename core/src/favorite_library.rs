use crate::{
    booru_engines as engines, booru_favorites as remote,
    booru_http::Transport,
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    library::{self, NOW},
    media, Error, Result,
};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncWriteExt;
const MAX_DOWNLOAD: u64 = 500 * 1024 * 1024;
/// Moves favorites saved under a site's own id to the preset key the site now has, since lookups
/// use that key. A favorite saved under both keys keeps the preset one, pointing at whichever copy is in the
/// library; the other download stays there for the duplicate finder.
pub(crate) const ADOPT_PRESET_KEYS: &str = "
    UPDATE favorite_items SET file_path = (SELECT b.file_path FROM favorite_items b
        JOIN user_booru_sites s ON s.id = b.provider AND s.user_id = b.user_id
        WHERE s.preset_key = favorite_items.provider AND b.user_id = favorite_items.user_id
          AND b.remote_id = favorite_items.remote_id AND b.file_path IN (SELECT path FROM files))
    WHERE file_path NOT IN (SELECT path FROM files) AND EXISTS (SELECT 1 FROM favorite_items b
        JOIN user_booru_sites s ON s.id = b.provider AND s.user_id = b.user_id
        WHERE s.preset_key = favorite_items.provider AND b.user_id = favorite_items.user_id
          AND b.remote_id = favorite_items.remote_id AND b.file_path IN (SELECT path FROM files));
    DELETE FROM favorite_items WHERE EXISTS (SELECT 1 FROM user_booru_sites s
        WHERE s.id = favorite_items.provider AND s.user_id = favorite_items.user_id AND s.preset_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM favorite_items k WHERE k.user_id = favorite_items.user_id
            AND k.provider = s.preset_key AND k.remote_id = favorite_items.remote_id));
    UPDATE favorite_items SET provider = (SELECT s.preset_key FROM user_booru_sites s
        WHERE s.id = favorite_items.provider AND s.user_id = favorite_items.user_id)
    WHERE EXISTS (SELECT 1 FROM user_booru_sites s
        WHERE s.id = favorite_items.provider AND s.user_id = favorite_items.user_id AND s.preset_key IS NOT NULL);";

async fn saved(db: &Database, site: &Site, id: &str) -> Result<Option<(String, String)>> {
    let provider = remote::provider(site);
    let id = id.to_owned();
    db.call(move|c|Ok(c.query_row("SELECT files.id,files.path FROM favorite_items fav JOIN files ON files.path=fav.file_path JOIN library_folders folders ON folders.id=files.folder_id WHERE fav.user_id=?1 AND fav.provider=?2 AND fav.remote_id=?3",params![OWNER_ID,provider,id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?)).await
}
pub(crate) async fn import(
    db: &Database,
    t: &Transport,
    site: &Site,
    id: &str,
    post: Option<Value>,
) -> Result<(String, bool)> {
    if let Some((file_id, path)) = saved(db, site, id).await? {
        let path = db
            .library()
            .resolve_file(&db.library().root, Path::new(&path))?;
        if tokio::fs::try_exists(path).await? {
            return Ok((file_id, false));
        }
    }
    let post = match post.filter(|p| p["fileUrl"].is_string()) {
        Some(p) => p,
        None => engines::single(t, site, id)
            .await?
            .ok_or_else(|| Error::Remote("The favorite post is unavailable on the site.".into()))?,
    };
    let raw = post["fileUrl"].as_str().ok_or_else(|| {
        Error::Remote(
            "This favorite has no downloadable file. Open its original post to check availability."
                .into(),
        )
    })?;
    let url = t.media_url(raw)?;
    let extension = Path::new(url.path())
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            Error::Remote("The site returned a file without a supported extension.".into())
        })?;
    let kind = media::detect_kind(Path::new(&format!("file.{extension}")))
        .ok_or_else(|| Error::Remote("This favorite's media type is not supported.".into()))?;
    let provider = remote::provider(site);
    let name = format!("favorite-{}-{id}.{extension}", site_hash(site));
    let root = db.library().resolve_folder(&db.library().root)?;
    let target = db.library().resolve_file(&root, &root.join(name))?;
    if !tokio::fs::try_exists(&target).await? {
        let tmp = tempfile::Builder::new()
            .prefix(".favorite-")
            .tempfile_in(&root)?;
        let mut file = tokio::fs::File::from_std(tmp.reopen()?);
        let mut response = t.get(url, engines::headers(site, true)?).await?;
        if response.content_length().is_some_and(|n| n > MAX_DOWNLOAD) {
            return Err(Error::Remote(
                "The favorite exceeds the 500 MiB download limit.".into(),
            ));
        }
        let mut size = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            Error::Remote("The favorite download was interrupted. Retry sync.".into())
        })? {
            size += chunk.len() as u64;
            if size > MAX_DOWNLOAD {
                return Err(Error::Remote(
                    "The favorite exceeds the 500 MiB download limit.".into(),
                ));
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        if !media::content_matches(tmp.path(), kind).await {
            return Err(Error::Remote("The downloaded favorite does not contain the expected media. Retry after checking the original post.".into()));
        }
        tmp.persist_noclobber(&target)
            .map_err(|e| Error::Io(e.error))?;
    }
    if !media::content_matches(&target, kind).await {
        return Err(Error::Storage(
            "The saved favorite is not valid media. Check the file in your library.".into(),
        ));
    }
    let root_text = root.to_string_lossy().to_string();
    let folder = db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT id FROM library_folders WHERE path=?1 AND user_id=?2",
                params![root_text, OWNER_ID],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
        })
        .await?;
    let folder = match folder {
        Some(id) => id,
        None => {
            library::scan(db).await?;
            let root_text = root.to_string_lossy().to_string();
            db.call(move |c| {
                Ok(c.query_row(
                    "SELECT id FROM library_folders WHERE path=?1 AND user_id=?2",
                    params![root_text, OWNER_ID],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .await?
        }
    };
    let metadata = tokio::fs::metadata(&target).await?;
    let scanned = library::process(
        db,
        &target,
        metadata.len() as i64,
        library::iso_millis(metadata.modified()?),
        None,
    )
    .await?;
    let id = id.to_owned();
    let raw = raw.to_owned();
    let source = engines::post_url(site, &id)?;
    let path = target.to_string_lossy().to_string();
    let file_id=db.call(move|c| {
        let tx=c.transaction()?;let file_id=library::upsert(&tx,&folder,&scanned)?;
        tx.execute(&format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,source_url,file_url,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,{NOW},{NOW}) ON CONFLICT(user_id,provider,remote_id) DO UPDATE SET file_path=excluded.file_path,source_url=excluded.source_url,file_url=excluded.file_url,updated_at=excluded.updated_at"),params![OWNER_ID,provider,id,path,source,raw])?;
        if let Some(tags)=post["tags"].as_array(){for tag in tags {
            let name=tag["tag"].as_str().ok_or_else(||Error::Remote("The site returned an invalid tag.".into()))?;let name=crate::tags::normalize(name);if name.is_empty(){continue;}
            let canonical=crate::tags::canonical(&tx,&name)?;let category=tag["category"].as_str().unwrap_or("general");
            tx.execute(&format!("INSERT INTO file_tags (file_id,tag,canonical_tag,category,source,source_url,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,{NOW},{NOW}) ON CONFLICT(file_id,tag,source) DO UPDATE SET canonical_tag=excluded.canonical_tag,category=excluded.category,updated_at=excluded.updated_at"),params![file_id,name,canonical,category,provider,source])?;
        }}
        tx.commit()?;Ok(file_id)
    }).await?;
    Ok((file_id, true))
}
pub(crate) async fn remove_local(db: &Database, site: &Site, id: &str) -> Result<bool> {
    let provider = remote::provider(site);
    let remote_id = id.to_owned();
    let mut removed = false;
    if let Some((file_id, path)) = saved(db, site, id).await? {
        let check_path = path.clone();
        let check_provider = provider.clone();
        let check_id = remote_id.clone();
        let shared=db.call(move|c|Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM favorite_items WHERE user_id=?1 AND file_path=?2 AND (provider<>?3 OR remote_id<>?4))",params![OWNER_ID,check_path,check_provider,check_id],|r|r.get::<_,bool>(0))?)).await?;
        // Preserve copies moved out of the managed download location and files shared by favorites.
        let managed_name = format!("favorite-{}-{id}.", site_hash(site));
        if !shared
            && Path::new(&path).parent() == Some(db.library().root.as_path())
            && Path::new(&path)
                .file_name()
                .is_some_and(|s| s.to_string_lossy().starts_with(&managed_name))
        {
            let target = db
                .library()
                .resolve_file(&db.library().root, Path::new(&path))?;
            match tokio::fs::remove_file(target).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            let orphans = db
                .call(move |c| crate::originals::forget_deleted(c, &[file_id]))
                .await?;
            library::remove_thumbnails(&db.library().thumbnails, orphans).await;
            removed = true;
        }
    }
    db.call(move |c| {
        c.execute(
            "DELETE FROM favorite_items WHERE user_id=?1 AND provider=?2 AND remote_id=?3",
            params![OWNER_ID, provider, remote_id],
        )?;
        Ok(())
    })
    .await?;
    Ok(removed)
}

fn site_hash(site: &Site) -> String {
    Sha256::digest(site.id.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) async fn reverse_before_delete(db: &Database, path: &Path) -> Result<()> {
    let path = path.to_string_lossy().to_string();
    let items=db.call(move|c|{let mut s=c.prepare("SELECT provider,remote_id FROM favorite_items WHERE user_id=?1 AND file_path=?2 LIMIT 33")?;let rows=s.query_map(params![OWNER_ID,path],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;Ok(rows)}).await?;
    if items.len() > 32 {
        return Err(Error::Storage(
            "Too many favorite sources on this file. Check Accounts before deleting it.".into(),
        ));
    }
    if items.is_empty() {
        return Ok(());
    }
    let sites = boorus::sites(db).await?;
    for (provider, id) in items {
        if let Some(site) = sites
            .iter()
            .find(|s| remote::provider(s) == provider && s.public["siteReverseSyncEnabled"] == true)
        {
            remote::set(&Transport::default(), site, &id, false).await?;
        }
        db.favorites.mark_removed(provider, &id, true)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use serde_json::json;
    fn site(base: String) -> Site {
        Site {
            id: "fixture".into(),
            name: "Fixture".into(),
            engine: "e621".into(),
            base,
            username: Some("fake-user".into()),
            key: Some("fake-key".into()),
            cookie: None,
            enabled: true,
            public: Value::Null,
        }
    }
    async fn fixture(bytes: Vec<u8>) -> (Site, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/file.png",
            get(move || {
                let bytes = bytes.clone();
                async move { bytes }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let s = site(format!("http://{}", listener.local_addr().unwrap()));
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (s, task)
    }
    fn png(dir: &Path) -> Vec<u8> {
        let file = dir.join("fixture.png");
        assert!(std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:size=64x64",
                "-frames:v",
                "1"
            ])
            .arg(&file)
            .status()
            .unwrap()
            .success());
        std::fs::read(file).unwrap()
    }
    fn post(site: &Site) -> Value {
        json!({"remoteId":"7","fileUrl":format!("{}/file.png",site.base),"tags":[{"tag":"test_artist","category":"artist"}]})
    }
    #[tokio::test]
    async fn favorite_import_is_idempotent_persists_tags_and_removes_only_its_managed_copy() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = png(dir.path());
        let (site, task) = fixture(bytes).await;
        let data = dir.path().join("data");
        let root = dir.path().join("library");
        let db = Database::open(&data, &root).unwrap();
        let t = Transport {
            allow_loopback: true,
        };
        let (id, added) = import(&db, &t, &site, "7", Some(post(&site)))
            .await
            .unwrap();
        assert!(added);
        let (again, added) = import(&db, &t, &site, "7", Some(post(&site)))
            .await
            .unwrap();
        assert_eq!(id, again);
        assert!(!added);
        let path = saved(&db, &site, "7").await.unwrap().unwrap().1;
        assert!(Path::new(&path).is_file());
        db.call(move|c| {assert_eq!(c.query_row("SELECT count(*) FROM file_tags WHERE file_id=?1 AND canonical_tag='test_artist' AND category='artist'",[id],|r|r.get::<_,i64>(0))?,1);Ok(())}).await.unwrap();
        drop(db);
        let db = Database::open(&data, &root).unwrap();
        assert!(saved(&db, &site, "7").await.unwrap().is_some());
        std::fs::write(root.join("unrelated.txt"), b"keep").unwrap();
        let lookup = path.clone();
        let sha = db
            .call(move |c| {
                Ok(
                    c.query_row("SELECT sha256 FROM files WHERE path = ?1", [lookup], |r| {
                        r.get::<_, String>(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert!(remove_local(&db, &site, "7").await.unwrap());
        assert!(!Path::new(&path).exists());
        assert!(root.join("unrelated.txt").exists());
        assert!(saved(&db, &site, "7").await.unwrap().is_none());
        // Gone for good: nothing to restore, and its synced record cannot bring it back as a
        // file with no original.
        let ghost = db
            .call(move |c| {
                Ok((
                    crate::originals::purged(c, &sha)?,
                    crate::originals::add_remote(
                        c,
                        &sha,
                        &json!({"mediaType": "IMAGE", "sizeBytes": 1}),
                    )?,
                ))
            })
            .await
            .unwrap();
        assert_eq!(ghost, (true, false));
        task.abort();
    }
    #[tokio::test]
    async fn failed_media_download_never_leaves_a_file_or_favorite_record() {
        let dir = tempfile::tempdir().unwrap();
        let (site, task) = fixture(b"<html>Login required</html>".to_vec()).await;
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        assert!(import(
            &db,
            &Transport {
                allow_loopback: true
            },
            &site,
            "7",
            Some(post(&site))
        )
        .await
        .is_err());
        assert_eq!(std::fs::read_dir(&db.library().root).unwrap().count(), 0);
        assert!(saved(&db, &site, "7").await.unwrap().is_none());
        task.abort();
    }
    #[tokio::test]
    async fn moved_and_shared_files_survive_unfavorite() {
        let dir = tempfile::tempdir().unwrap();
        let (site, task) = fixture(png(dir.path())).await;
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let (id, _) = import(
            &db,
            &Transport {
                allow_loopback: true,
            },
            &site,
            "7",
            Some(post(&site)),
        )
        .await
        .unwrap();
        let path = saved(&db, &site, "7").await.unwrap().unwrap().1;
        let shared = path.clone();
        db.call(move|c|{c.execute(&format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,created_at,updated_at) VALUES (?1,'other','8',?2,{NOW},{NOW})"),params![OWNER_ID,shared])?;Ok(())}).await.unwrap();
        assert!(!remove_local(&db, &site, "7").await.unwrap());
        assert!(Path::new(&path).exists());
        let moved = db.library().root.join("keep.png");
        std::fs::rename(&path, &moved).unwrap();
        let moved_text = moved.to_string_lossy().to_string();
        db.call(move |c| {
            c.execute(
                "UPDATE files SET path=?1 WHERE id=?2",
                params![moved_text, id],
            )?;
            c.execute(
                "UPDATE favorite_items SET file_path=?1 WHERE provider='other'",
                params![moved_text],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let mut other = site.clone();
        other.id = "other".into();
        assert!(!remove_local(&db, &other, "8").await.unwrap());
        assert!(moved.exists());
        task.abort();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn replaced_download_symlink_cannot_delete_an_outside_file() {
        let dir = tempfile::tempdir().unwrap();
        let (site, task) = fixture(png(dir.path())).await;
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        import(
            &db,
            &Transport {
                allow_loopback: true,
            },
            &site,
            "7",
            Some(post(&site)),
        )
        .await
        .unwrap();
        let path = saved(&db, &site, "7").await.unwrap().unwrap().1;
        let outside = dir.path().join("keep.txt");
        std::fs::write(&outside, b"keep").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(remove_local(&db, &site, "7").await.is_err());
        assert_eq!(std::fs::read(outside).unwrap(), b"keep");
        task.abort();
    }
}
