use crate::{
    booru_favorites as remote,
    booru_http::Transport,
    boorus::{self, Site},
    db::{Database, OWNER_ID},
    library::NOW,
    source_matches::Match,
    source_store::{self, File},
    Error, Result,
};
use rusqlite::params;

/// Favorites `file`'s best trusted source match on its site when that site has
/// "Auto-favorite source matches" on. Returns the favorited `(provider, post id)`,
/// or `None` when nothing qualifies. The favorite row points at the library file,
/// so the next sync recognises the post instead of downloading it again.
pub(crate) async fn from_source(
    db: &Database,
    t: &Transport,
    file: &File,
) -> Result<Option<(String, String)>> {
    favorite_best(db, t, file, &boorus::sites(db).await?).await
}

async fn favorite_best(
    db: &Database,
    t: &Transport,
    file: &File,
    sites: &[Site],
) -> Result<Option<(String, String)>> {
    let id = file.id.clone();
    let runs = db.call(move |c| source_store::runs(c, &id)).await?;
    let mut best: Option<(f64, &Site, String, String)> = None;
    for run in runs.iter().filter(|r| r["status"] == "COMPLETED") {
        let provider = run["provider"]
            .as_str()
            .ok_or_else(|| Error::Storage("Invalid saved source provider.".into()))?;
        let results = run["results"].as_array().filter(|r| !r.is_empty()).cloned();
        let candidates = results.unwrap_or_else(|| vec![run.clone()]);
        for candidate in candidates {
            let (Some(url), Some(score)) =
                (candidate["sourceUrl"].as_str(), candidate["score"].as_f64())
            else {
                continue;
            };
            let trusted = Match {
                url: url.into(),
                score,
                name: None,
                thumbnail: None,
                distance: candidate["distance"].as_f64(),
            }
            .trusted(provider);
            if !trusted || best.as_ref().is_some_and(|(top, ..)| score <= *top) {
                continue;
            }
            if let Some((site, post)) = sites
                .iter()
                .find_map(|s| source_store::candidate(s, url).map(|post| (s, post)))
            {
                best = Some((score, site, post, url.to_owned()));
            }
        }
    }
    let Some((_, site, post, url)) = best else {
        return Ok(None);
    };
    let provider = remote::provider(site);
    let (key, remote_id) = (provider.clone(), post.clone());
    // A post already recorded as a favorite keeps its record, so a downloaded copy is not orphaned.
    let marked = db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM favorite_items WHERE user_id=?1 AND provider=?2 AND remote_id=?3)",
                params![OWNER_ID, key, remote_id],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .await?;
    if marked || site.public["siteAutoFavEnabled"] != true || remote::require(site, true).is_err() {
        return Ok(None);
    }
    let _guard = db.favorites.writes.lock().await;
    remote::set(t, site, &post, true).await?;
    crate::subscription_store::favorite_override(db, &site.id, &post, true).await?;
    let (path, key, remote_id) = (file.path.clone(), provider.clone(), post.clone());
    db.call(move |c| {
        c.execute(&format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,source_url,file_url,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,NULL,{NOW},{NOW}) ON CONFLICT(user_id,provider,remote_id) DO UPDATE SET file_path=excluded.file_path,source_url=excluded.source_url,file_url=NULL,updated_at=excluded.updated_at"),params![OWNER_ID,key,remote_id,path,url])?;
        Ok(())
    })
    .await?;
    db.favorites.mark_removed(provider.clone(), &post, false)?;
    Ok(Some((provider, post)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    #[tokio::test]
    async fn favorites_the_best_trusted_match_once_and_only_when_the_site_opts_in() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let posted = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let (seen, count) = (posted.clone(), calls.clone());
        let app = Router::new().route(
            "/favorites.json",
            post(move |body: String| async move {
                count.fetch_add(1, Ordering::SeqCst);
                seen.lock().unwrap().push(body);
                Json(json!({}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let seeded = base.clone();
        db.call(move |c| {
            c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,username,api_key,is_preset,enabled,sort_order,site_auto_fav_enabled,created_at,updated_at) VALUES ('fixture',?1,'Fixture','e621',?2,'fake-user','fake-key',0,1,0,0,{NOW},{NOW})"),params![OWNER_ID,seeded])?;
            c.execute(&format!("INSERT INTO folders (id,user_id,path,type,status,created_at,updated_at) VALUES ('folder',?1,'/fixture','LOCAL','IDLE',{NOW},{NOW})"),[OWNER_ID])?;
            c.execute("INSERT INTO active_library_folders (id) VALUES ('folder')", [])?;
            c.execute(&format!("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES ('file','folder','LOCAL','/fixture/file.png',1,{NOW},'file','IMAGE',{NOW},{NOW})"),[])?;
            // Post 9 scores highest but under Fluffle's threshold; post 7 is the best trusted match.
            for (id, provider, results) in [
                ("fluffle", "FLUFFLE", json!([{"sourceUrl":format!("{seeded}/posts/9"),"score":94.0}])),
                // Exact by Fluffle's own label, but far from the image: must not win with its 100.
                ("fluffle-far", "FLUFFLE", json!([{"sourceUrl":format!("{seeded}/posts/11"),"score":100.0,"distance":0.97}])),
                ("saucenao", "SAUCENAO", json!([{"sourceUrl":format!("{seeded}/posts/5"),"score":90.5},{"sourceUrl":format!("{seeded}/posts/7"),"score":91.0}])),
            ] {
                c.execute(&format!("INSERT INTO provider_runs (id,file_id,provider,status,cached_hit,results,created_at) VALUES (?1,'file',?2,'COMPLETED',0,?3,{NOW})"),params![id,provider,results.to_string()])?;
            }
            Ok(())
        })
        .await
        .unwrap();
        let file = db
            .call(|c| source_store::file(c, "file"))
            .await
            .unwrap()
            .unwrap();
        let t = Transport {
            allow_loopback: true,
        };
        // boorus::sites refuses loopback addresses, so read the fixture site directly.
        let sites = || async { vec![boorus::site(&db, "fixture".into()).await.unwrap().unwrap()] };
        assert_eq!(
            favorite_best(&db, &t, &file, &sites().await).await.unwrap(),
            None
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        db.call(|c| {
            c.execute("UPDATE user_booru_sites SET site_auto_fav_enabled=1", [])?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            favorite_best(&db, &t, &file, &sites().await).await.unwrap(),
            Some(("fixture".into(), "7".into()))
        );
        assert_eq!(
            favorite_best(&db, &t, &file, &sites().await).await.unwrap(),
            None
        );
        server.abort();
        assert_eq!(*posted.lock().unwrap(), ["post_id=7"]);
        let saved = db
            .call(|c| {
                Ok(c.query_row("SELECT file_path,source_url FROM favorite_items WHERE provider='fixture' AND remote_id='7'", [], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?)
            })
            .await
            .unwrap();
        assert_eq!(
            saved,
            ("/fixture/file.png".into(), format!("{base}/posts/7"))
        );
    }
}
