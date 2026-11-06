//! Removing a booru account also removes the library posts linked to it.
//!
//! A post is linked to an account through `favorite_items`: its row names the site and the
//! library file. A file also linked to another site that still exists stays. A `REMOTE` file is
//! online-only: this device knows it from sync and would fetch it from the site. A `LOCAL` file
//! is downloaded on this device.
//!
//! Deleting a file here never writes to the trash. The trash is shared, and another device would
//! delete its downloaded copy too. The rows leave this device alone, and the file's sync record
//! is marked removed (`applied = 3`) so a later pass does not bring the row back.

use crate::{
    db::{Database, OWNER_ID},
    library, subscription_store, Error, Result,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

struct Post {
    id: String,
    sha: String,
    path: String,
    folder: String,
    downloaded: bool,
}

/// What removing a site takes with it, as counts shown before the person confirms.
#[derive(Debug, PartialEq)]
pub(crate) struct Counts {
    pub online_only: usize,
    pub downloaded: usize,
}

/// What the caller still has to delete outside the database.
#[derive(Default)]
pub(crate) struct Removed {
    /// Downloaded originals the person chose to delete: the file path and its folder.
    pub originals: Vec<(String, String)>,
    pub thumbnails: Vec<String>,
}

/// The keys the site's favorites are saved under: its own id and its preset key.
fn providers(c: &Connection, id: &str) -> Result<Option<(String, String)>> {
    Ok(c.query_row(
        "SELECT id, coalesce(preset_key, id) FROM user_booru_sites WHERE id = ?1 AND user_id = ?2",
        params![id, OWNER_ID],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?)
}

fn linked(c: &Connection, id: &str, preset: &str) -> Result<Vec<Post>> {
    let mut s = c.prepare(
        "SELECT f.id, f.sha256, f.path, folders.path, f.location_type = 'LOCAL'
         FROM favorite_items fi
         JOIN files f ON f.path = fi.file_path
         JOIN folders ON folders.id = f.folder_id
         WHERE fi.user_id = ?1 AND fi.provider IN (?2, ?3)
           AND NOT EXISTS (SELECT 1 FROM favorite_items o
             JOIN user_booru_sites s ON s.user_id = ?1 AND (s.id = o.provider OR s.preset_key = o.provider)
             WHERE o.user_id = ?1 AND o.file_path = fi.file_path AND s.id <> ?2)
         GROUP BY f.id",
    )?;
    let rows = s
        .query_map(params![OWNER_ID, id, preset], |r| {
            Ok(Post {
                id: r.get(0)?,
                sha: r.get(1)?,
                path: r.get(2)?,
                folder: r.get(3)?,
                downloaded: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// `None` when the site does not exist.
pub(crate) fn counts(c: &Connection, id: &str) -> Result<Option<Counts>> {
    let Some((id, preset)) = providers(c, id)? else {
        return Ok(None);
    };
    let posts = linked(c, &id, &preset)?;
    let downloaded = posts.iter().filter(|p| p.downloaded).count();
    Ok(Some(Counts {
        online_only: posts.len() - downloaded,
        downloaded,
    }))
}

/// Deletes the site, its online-only posts, and its downloaded posts when `delete_downloaded`;
/// the other downloaded files stay as plain library files. Returns `None` when the site does not
/// exist. Run it in one transaction.
pub(crate) fn remove_site(
    c: &Connection,
    id: &str,
    delete_downloaded: bool,
) -> Result<Option<Removed>> {
    let Some((id, preset)) = providers(c, id)? else {
        return Ok(None);
    };
    let mut removed = Removed::default();
    let mut ids = Vec::new();
    let mut shas = Vec::new();
    for post in linked(c, &id, &preset)? {
        if post.downloaded && !delete_downloaded {
            continue;
        }
        if post.downloaded {
            removed.originals.push((post.path, post.folder));
        }
        ids.push(post.id);
        shas.push(post.sha);
    }
    removed.thumbnails = library::forget_files(c, &ids)?;
    for sha in shas {
        let gone: bool = c.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM files WHERE sha256 = ?1)",
            [&sha],
            |r| r.get(0),
        )?;
        if gone {
            c.execute("DELETE FROM kept_files WHERE sha256 = ?1", [&sha])?;
            // Removed with its site (`applied = 3`): a waiting record would add the row again, and
            // a set-aside one (2) comes back once the sync folder stores the original.
            c.execute(
                "UPDATE sync_records SET applied = 3 WHERE kind = 'file' AND record_key = json_array(?1)",
                [&sha],
            )?;
        }
    }
    // Tags and relations saved under a custom site's random id would name a site that no longer
    // exists, and every start would search them for a site to adopt them.
    for table in ["file_tags", "file_post_relations"] {
        c.execute(&format!("DELETE FROM {table} WHERE source = ?1"), [&id])?;
    }
    c.execute(
        "DELETE FROM favorite_items WHERE user_id = ?1 AND provider IN (?2, ?3)",
        params![OWNER_ID, id, preset],
    )?;
    c.execute(
        "DELETE FROM pending_favorites WHERE user_id = ?1 AND site_id = ?2",
        params![OWNER_ID, id],
    )?;
    c.execute(
        "DELETE FROM declined_favorites WHERE site_id = ?1 AND user_id = ?2",
        params![id, OWNER_ID],
    )?;
    subscription_store::reset(c, Some(&id), false)?;
    c.execute(
        "DELETE FROM user_booru_sites WHERE id = ?1 AND user_id = ?2",
        params![id, OWNER_ID],
    )?;
    Ok(Some(removed))
}

/// Deletes from disk what [`remove_site`] released, and the thumbnails nobody uses.
pub(crate) async fn clean_up(db: &Database, removed: Removed) -> Result<()> {
    // The site is already gone, so nothing can retry: delete what can be deleted, then report.
    let mut failed = 0;
    for (path, folder) in removed.originals {
        let path: PathBuf = match db
            .library()
            .resolve_file(std::path::Path::new(&folder), std::path::Path::new(&path))
        {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[developer] Cannot find a file of a removed site on disk: {error}");
                failed += 1;
                continue;
            }
        };
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!(
                    "[developer] Cannot delete {} with its removed site: {error}",
                    path.display()
                );
                failed += 1;
            }
        }
    }
    library::remove_thumbnails(&db.library().thumbnails, removed.thumbnails).await;
    if failed > 0 {
        return Err(Error::Storage(format!(
            "The account is removed, but GoonCave could not delete {failed} downloaded file(s) from disk. Check that the library folder is writable, then delete them from the gallery."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::NOW;

    /// Site `mine` has: `online` (REMOTE), `held` (downloaded, file on disk), `shared`
    /// (downloaded, also linked to site `other`); `other` also has `elsewhere`.
    fn seed(c: &Connection, root: &str) -> Result<()> {
        c.execute_batch(&format!(
            "INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status) VALUES ('f', '{OWNER_ID}', '{root}', 'LOCAL', {NOW}, {NOW}, 'IDLE');
             INSERT INTO user_booru_sites (id, user_id, name, engine, base_url, is_preset, enabled, sort_order, created_at, updated_at) VALUES
               ('mine', '{OWNER_ID}', 'Mine', 'danbooru', 'https://x.example', 0, 1, 0, {NOW}, {NOW}),
               ('other', '{OWNER_ID}', 'Other', 'danbooru', 'https://y.example', 0, 1, 1, {NOW}, {NOW});
             INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, created_at, updated_at) VALUES
               ('online', 'f', 'REMOTE', '{root}/online', 1, {NOW}, 'sha-online', 'IMAGE', {NOW}, {NOW}),
               ('held', 'f', 'LOCAL', '{root}/held.png', 1, {NOW}, 'sha-held', 'IMAGE', {NOW}, {NOW}),
               ('shared', 'f', 'LOCAL', '{root}/shared.png', 1, {NOW}, 'sha-shared', 'IMAGE', {NOW}, {NOW}),
               ('elsewhere', 'f', 'REMOTE', '{root}/elsewhere', 1, {NOW}, 'sha-elsewhere', 'IMAGE', {NOW}, {NOW});
             INSERT INTO favorite_items (user_id, provider, remote_id, file_path, created_at, updated_at) VALUES
               ('{OWNER_ID}', 'mine', '1', '{root}/online', {NOW}, {NOW}),
               ('{OWNER_ID}', 'mine', '2', '{root}/held.png', {NOW}, {NOW}),
               ('{OWNER_ID}', 'mine', '3', '{root}/shared.png', {NOW}, {NOW}),
               ('{OWNER_ID}', 'other', '3', '{root}/shared.png', {NOW}, {NOW}),
               ('{OWNER_ID}', 'other', '4', '{root}/elsewhere', {NOW}, {NOW});
             INSERT INTO file_tags (file_id, tag, category, source, created_at, updated_at) VALUES
               ('held', 'a', 'general', 'mine', {NOW}, {NOW}), ('held', 'b', 'general', 'other', {NOW}, {NOW});
             INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES
               ('file', '[\"sha-online\"]', '{{}}', {NOW}, 1);"
        ))?;
        Ok(())
    }

    fn files(c: &Connection) -> String {
        c.query_row(
            "SELECT group_concat(id) FROM (SELECT id FROM files ORDER BY id)",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn open() -> (tempfile::TempDir, Database, String) {
        let dir = tempfile::tempdir().unwrap();
        let library = dir.path().join("library");
        let db = Database::open(&dir.path().join("data"), &library).unwrap();
        let root = db.library().root.to_string_lossy().into_owned();
        std::fs::write(std::path::Path::new(&root).join("held.png"), b"x").unwrap();
        (dir, db, root)
    }

    #[tokio::test]
    async fn counts_split_online_only_from_downloaded_and_skip_files_of_other_sites() {
        let (_dir, db, root) = open();
        let found = db
            .call(move |c| {
                seed(c, &root)?;
                counts(c, "mine")
            })
            .await
            .unwrap();
        assert_eq!(
            found,
            Some(Counts {
                online_only: 1,
                downloaded: 1
            })
        );
        assert_eq!(db.call(|c| counts(c, "nope")).await.unwrap(), None);
    }

    #[tokio::test]
    async fn removing_a_site_keeps_downloaded_files_unless_asked() {
        let (_dir, db, root) = open();
        let seeded = root.clone();
        let after = db
            .call(move |c| {
                seed(c, &seeded)?;
                let removed = remove_site(c, "mine", false)?.unwrap();
                assert!(removed.originals.is_empty());
                Ok((
                    files(c),
                    c.query_row(
                        "SELECT group_concat(provider || remote_id) FROM favorite_items",
                        [],
                        |r| r.get::<_, String>(0),
                    )?,
                    c.query_row("SELECT group_concat(source) FROM file_tags", [], |r| {
                        r.get::<_, String>(0)
                    })?,
                    c.query_row(
                        "SELECT applied FROM sync_records WHERE kind = 'file'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )?,
                    c.query_row(
                        "SELECT count(*) FROM user_booru_sites WHERE id = 'mine'",
                        [],
                        |r| r.get::<_, i64>(0),
                    )?,
                ))
            })
            .await
            .unwrap();
        assert_eq!(after.0, "elsewhere,held,shared");
        assert_eq!(after.1, "other3,other4");
        assert_eq!(after.2, "other");
        assert_eq!(after.3, 3);
        assert_eq!(after.4, 0);
        assert!(std::path::Path::new(&root).join("held.png").exists());
    }

    #[tokio::test]
    async fn removing_a_site_deletes_downloaded_files_on_request_but_not_shared_ones() {
        let (_dir, db, root) = open();
        let seeded = root.clone();
        let (left, removed) = db
            .call(move |c| {
                seed(c, &seeded)?;
                let removed = remove_site(c, "mine", true)?.unwrap();
                Ok((files(c), removed))
            })
            .await
            .unwrap();
        assert_eq!(left, "elsewhere,shared");
        clean_up(&db, removed).await.unwrap();
        assert!(!std::path::Path::new(&root).join("held.png").exists());
    }
}
