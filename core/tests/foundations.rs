use std::sync::Arc;

use gooncave_core::{
    db::{Database, MIGRATIONS, OWNER_ID},
    http::{Frontend, Server},
};
use reqwest::Client;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::{sync::oneshot, task::JoinHandle};

struct Running {
    origin: String,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}

async fn start(database: Database) -> Running {
    let server = Server::bind(
        database,
        0,
        Frontend::Embedded(Arc::new(|_| {
            Some((b"frontend".to_vec(), "text/html".into()))
        })),
    )
    .await
    .unwrap();
    let origin = server.origin.clone();
    let (shutdown, receiver) = oneshot::channel();
    Running {
        origin,
        shutdown,
        task: tokio::spawn(server.serve(receiver)),
    }
}

impl Running {
    async fn stop(self) {
        self.shutdown.send(()).unwrap();
        self.task.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn settings_survive_a_full_core_restart_and_migrations_do_not_repeat() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path(), &directory.path().join("library")).unwrap();
    let first = start(database).await;
    let conflict = Server::bind(
        Database::open(directory.path(), &directory.path().join("library")).unwrap(),
        0,
        Frontend::Embedded(Arc::new(|_| None)),
    )
    .await;
    match conflict {
        Err(gooncave_core::Error::Storage(message)) => {
            assert!(message.contains("saved local port is in use"))
        }
        _ => panic!("a second instance must not silently choose another origin"),
    }
    let client = Client::new();
    let initial: Value = client
        .get(format!("{}/settings/extra", first.origin))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(initial["voteSystemEnabled"], false);
    let saved: Value = client
        .put(format!("{}/settings/extra", first.origin))
        .json(&json!({"voteSystemEnabled": true, "maxGridColumns": 4}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["voteSystemEnabled"], true);
    assert_eq!(saved["autoVoteOnFavorite"], true);
    let first_origin = first.origin.clone();
    first.stop().await;

    let database = Database::open(directory.path(), &directory.path().join("library")).unwrap();
    let count = database
        .call(|connection| {
            Ok(
                connection.query_row("SELECT count(*) FROM __drizzle_migrations", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(count, MIGRATIONS.len() as i64);
    let second = start(database).await;
    assert_eq!(second.origin, first_origin);
    let loaded: Value = client
        .get(format!("{}/settings/extra", second.origin))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(loaded, saved);
    let profile: Value = client
        .get(format!("{}/device", second.origin))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(profile["user"]["id"], OWNER_ID);
    assert_eq!(profile["user"]["capabilities"]["library"], true);
    assert_eq!(
        profile["user"]["libraryRoot"],
        directory
            .path()
            .join("library")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    let files: Value = client
        .get(format!("{}/files", second.origin))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(files, json!({"files": [], "total": 0}));
    assert_eq!(
        client
            .post(format!("{}/auth/login", second.origin))
            .send()
            .await
            .unwrap()
            .status(),
        501
    );
    second.stop().await;
}

#[tokio::test]
async fn invalid_settings_are_rejected_without_partial_writes() {
    let directory = TempDir::new().unwrap();
    let server =
        start(Database::open(directory.path(), &directory.path().join("library")).unwrap()).await;
    let client = Client::new();
    for patch in [
        json!({"maxGridColumns": 13}),
        json!({"maxGridColumns": 1.5}),
        json!({"developerMode": "true"}),
        json!({"voteSystemEnabled": true, "unknown": true}),
        json!(null),
    ] {
        assert_eq!(
            client
                .put(format!("{}/settings/extra", server.origin))
                .json(&patch)
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    let loaded: Value = client
        .get(format!("{}/settings/extra", server.origin))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(loaded["voteSystemEnabled"], false);
    assert_eq!(
        client
            .put(format!("{}/settings/extra", server.origin))
            .header("content-type", "application/json")
            .body("{broken")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    server.stop().await;
}

#[tokio::test]
async fn incomplete_saved_settings_return_errors_without_disabling_the_database() {
    let directory = TempDir::new().unwrap();
    let database = Database::open(directory.path(), &directory.path().join("library")).unwrap();
    database.call(|connection| {
        connection.execute(
            "INSERT INTO user_settings (user_id, key, value) VALUES (?1, 'blacklist.settings', '{}')",
            [OWNER_ID],
        )?;
        Ok(())
    }).await.unwrap();
    let server = start(database).await;
    let client = Client::new();
    assert_eq!(
        client
            .get(format!("{}/settings/blacklist", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        500
    );
    assert_eq!(
        client
            .put(format!("{}/settings/blacklist", server.origin))
            .json(&json!({"applyToGallery": true}))
            .send()
            .await
            .unwrap()
            .status(),
        500
    );
    assert_eq!(
        client
            .get(format!("{}/device", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server.stop().await;
}

#[tokio::test]
async fn shortcut_and_blacklist_contracts_match_the_reference() {
    let directory = TempDir::new().unwrap();
    let server =
        start(Database::open(directory.path(), &directory.path().join("library")).unwrap()).await;
    let client = Client::new();
    let bindings = json!({"bindings": {"next": "ArrowRight", "previous": "ArrowLeft"}});
    let saved: Value = client
        .put(format!("{}/settings/shortcuts", server.origin))
        .json(&bindings)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved, bindings);
    let saved: Value = client
        .put(format!("{}/settings/blacklist", server.origin))
        .json(&json!({"tags": [" Sample  Tag ", "sample_tag", "Mixed!\tCase"], "applyToGallery": true}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        saved,
        json!({"tags": ["sample_tag", "mixed_case"], "applyToGallery": true, "applyToExplore": true})
    );
    assert_eq!(
        client
            .put(format!("{}/settings/blacklist", server.origin))
            .json(&json!({"tags": [7]}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    server.stop().await;
}

#[tokio::test]
async fn another_website_cannot_read_or_change_the_local_library() {
    let directory = TempDir::new().unwrap();
    let server =
        start(Database::open(directory.path(), &directory.path().join("library")).unwrap()).await;
    let client = Client::new();
    for header in [
        ("origin", "https://example.test"),
        ("origin", "null"),
        ("host", "example.test"),
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-site", "same-site"),
    ] {
        assert_eq!(
            client
                .get(format!("{}/device", server.origin))
                .header(header.0, header.1)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .put(format!("{}/settings/extra", server.origin))
                .header(header.0, header.1)
                .json(&json!({"developerMode": true}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    assert_eq!(
        client
            .put(format!("{}/settings/extra", server.origin))
            .header("origin", &server.origin)
            .json(&json!({"developerMode": true}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server.stop().await;
}

#[tokio::test]
async fn media_streams_ranges_and_refuses_paths_outside_the_selected_folder() {
    let directory = TempDir::new().unwrap();
    let media = directory.path().join("media");
    std::fs::create_dir(&media).unwrap();
    std::fs::write(media.join("sample.mp4"), b"0123456789").unwrap();
    std::fs::write(directory.path().join("outside.mp4"), b"private").unwrap();
    let database = Database::open(directory.path(), &media).unwrap();
    let root = media.to_string_lossy().into_owned();
    let sample = media.join("sample.mp4").to_string_lossy().into_owned();
    database.call(move |connection| {
        connection.execute("INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status) VALUES ('folder', ?1, ?2, 'LOCAL', '2026-01-01', '2026-01-01', 'IDLE')", rusqlite::params![OWNER_ID, root])?;
        for (id, path) in [("sample", sample.as_str()), ("outside", "../outside.mp4")] {
            connection.execute("INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, created_at, updated_at) VALUES (?1, 'folder', 'LOCAL', ?2, 10, '2026-01-01', ?1, 'VIDEO', '2026-01-01', '2026-01-01')", rusqlite::params![id, path])?;
        }
        connection.execute("INSERT INTO active_library_folders (id) VALUES ('folder')", [])?;
        Ok(())
    }).await.unwrap();
    // Deliberately invalid recorded paths exercise HTTP validation without the scanner deleting them.
    let bound = Server::bind(database, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (shutdown, receiver) = oneshot::channel();
    let server = Running {
        origin: bound.origin.clone(),
        shutdown,
        task: tokio::spawn(async move {
            axum::serve(bound.listener, bound.router)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
        }),
    };
    let client = Client::new();
    let response = client
        .get(format!("{}/files/sample/content", server.origin))
        .header("range", "bytes=2-5")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"2345");
    let resumed = client
        .get(format!("{}/files/sample/content", server.origin))
        .header("range", "bytes=2-5")
        .header("if-range", "\"stale\"")
        .send()
        .await
        .unwrap();
    assert_eq!(resumed.status(), 200);
    assert_eq!(resumed.bytes().await.unwrap().as_ref(), b"0123456789");
    let original = client
        .get(format!("{}/files/sample/content", server.origin))
        .send()
        .await
        .unwrap();
    let etag = original.headers()["etag"].to_str().unwrap().to_owned();
    let modified = original.headers()["last-modified"]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        client
            .get(format!("{}/files/sample/content", server.origin))
            .header("if-none-match", &etag)
            .send()
            .await
            .unwrap()
            .status(),
        304
    );
    for validator in [&etag, &modified] {
        assert_eq!(
            client
                .get(format!("{}/files/sample/content", server.origin))
                .header("range", "bytes=2-5")
                .header("if-range", validator)
                .send()
                .await
                .unwrap()
                .status(),
            206
        );
    }
    std::fs::write(media.join("sample.mp4"), b"0123456789!").unwrap();
    let changed = client
        .get(format!("{}/files/sample/content", server.origin))
        .header("range", "bytes=2-5")
        .header("if-range", &etag)
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), 200);
    assert_ne!(changed.headers()["etag"], etag);
    assert_eq!(changed.bytes().await.unwrap().as_ref(), b"0123456789!");
    assert_eq!(
        client
            .get(format!("{}/files/sample/content", server.origin))
            .header("range", "bytes=99-100")
            .send()
            .await
            .unwrap()
            .status(),
        416
    );
    for (range, expected) in [("bytes=-5", &b"6789!"[..]), ("bytes=8-99", &b"89!"[..])] {
        let partial = client
            .get(format!("{}/files/sample/content", server.origin))
            .header("range", range)
            .send()
            .await
            .unwrap();
        assert_eq!(partial.status(), 206, "{range}");
        assert_eq!(partial.bytes().await.unwrap().as_ref(), expected, "{range}");
    }
    assert_eq!(
        client
            .get(format!("{}/files/sample/content", server.origin))
            .header("range", "bytes=-")
            .send()
            .await
            .unwrap()
            .status(),
        416
    );
    let download = client
        .get(format!("{}/files/sample/content?download=1", server.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(download.status(), 200);
    assert_eq!(
        download.headers()["content-disposition"],
        "attachment; filename=\"sample.mp4\"; filename*=UTF-8''sample.mp4"
    );
    let inline = client
        .get(format!("{}/files/sample/content", server.origin))
        .send()
        .await
        .unwrap();
    assert!(inline.headers().get("content-disposition").is_none());
    assert_eq!(
        client
            .get(format!("{}/files/outside/content", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .get(format!("{}/files/missing/content", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client
            .get(format!("{}/files", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server.stop().await;
}
