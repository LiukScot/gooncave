use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime},
};

use gooncave_core::{
    db::Database,
    http::{Frontend, Server},
    library,
};
use reqwest::{multipart, Client, StatusCode};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::{sync::oneshot, task::JoinHandle};

struct Running {
    origin: String,
    client: Client,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<std::io::Result<()>>,
}

impl Running {
    async fn start(database: Database) -> Self {
        let server = Server::bind(database, 0, Frontend::Embedded(Arc::new(|_| None)))
            .await
            .unwrap();
        let origin = server.origin.clone();
        let (shutdown, receiver) = oneshot::channel();
        Self {
            origin,
            client: Client::new(),
            shutdown,
            task: tokio::spawn(server.serve(receiver)),
        }
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let response = self
            .client
            .get(format!("{}{path}", self.origin))
            .send()
            .await
            .unwrap();
        (
            response.status(),
            response.json().await.unwrap_or(Value::Null),
        )
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .json(&body)
            .send()
            .await
            .unwrap();
        (
            response.status(),
            response.json().await.unwrap_or(Value::Null),
        )
    }

    async fn files(&self, query: &str) -> Vec<Value> {
        let (status, body) = self.get(&format!("/files{query}")).await;
        assert_eq!(status, 200, "{body}");
        body["files"].as_array().unwrap().clone()
    }

    /// The startup scan runs in the background; waits until every folder is idle again.
    async fn idle_folders(&self) -> Vec<Value> {
        for _ in 0..200 {
            let folders = self.get("/folders").await.1["folders"]
                .as_array()
                .unwrap()
                .clone();
            // The scan keeps running for a moment after its last folder turns idle.
            if folders
                .iter()
                .all(|folder| folder["status"] == "IDLE" && folder["lastScanAt"].is_string())
                && self.get("/library/progress").await.1["scanning"] == false
            {
                return folders;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the background scan did not finish");
    }

    async fn stop(self) {
        self.shutdown.send(()).unwrap();
        self.task.await.unwrap().unwrap();
    }
}

fn ffmpeg(arguments: &[&str], output: &Path) {
    let status = Command::new("ffmpeg")
        .args(["-v", "error", "-y"])
        .args(arguments)
        .arg(output)
        .status()
        .expect("FFmpeg must be installed to run the library tests");
    assert!(status.success(), "ffmpeg failed for {}", output.display());
}

fn picture(path: &Path, source: &str) {
    ffmpeg(&["-f", "lavfi", "-i", source, "-frames:v", "1"], path);
}

#[tokio::test]
async fn baseline_jpeg_gets_a_nonempty_thumbnail() {
    let directory = TempDir::new().unwrap();
    let source = directory.path().join("baseline.jpg");
    std::fs::write(&source, include_bytes!("fixtures/baseline.jpg")).unwrap();
    let probe = gooncave_core::media::probe(&source, gooncave_core::media::MediaKind::Image)
        .await
        .unwrap();
    let thumbnail = gooncave_core::media::thumbnail(
        &source,
        gooncave_core::media::MediaKind::Image,
        probe,
        directory.path(),
        "baseline",
    )
    .await
    .unwrap();
    let bytes = std::fs::read(thumbnail).unwrap();
    assert!(bytes.starts_with(&[0xff, 0xd8]), "thumbnail must be a JPEG");
    assert!(bytes.ends_with(&[0xff, 0xd9]), "thumbnail must be complete");
}

fn set_mtime(path: &Path, seconds: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
        .unwrap();
}

/// A JPEG whose EXIF says "rotate 90° clockwise", so its displayed shape differs from its pixels.
fn rotated_jpeg(path: &Path) {
    let plain = path.with_extension("plain.jpg");
    picture(&plain, "color=c=red:size=200x100");
    let bytes = std::fs::read(&plain).unwrap();
    std::fs::remove_file(&plain).unwrap();
    let mut payload = b"Exif\0\0II*\0\x08\0\0\0\x01\0".to_vec();
    payload.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    let mut out = bytes[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&u16::try_from(payload.len() + 2).unwrap().to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&bytes[2..]);
    std::fs::write(path, out).unwrap();
}

struct Library {
    _directory: TempDir,
    data: PathBuf,
    root: PathBuf,
}

/// Four media files with distinct shapes and modification times, plus files a scan must ignore.
fn library() -> Library {
    let directory = TempDir::new().unwrap();
    let data = directory.path().join("data");
    let root = directory.path().join("library");
    std::fs::create_dir_all(root.join("Comics")).unwrap();
    rotated_jpeg(&root.join("photo.jpg"));
    set_mtime(&root.join("photo.jpg"), 3_000);
    picture(&root.join("Comics/strip.png"), "color=c=blue:size=100x1200");
    set_mtime(&root.join("Comics/strip.png"), 1_000);
    ffmpeg(
        &["-f", "lavfi", "-i", "testsrc=size=120x80:rate=5", "-t", "1"],
        &root.join("loop.gif"),
    );
    set_mtime(&root.join("loop.gif"), 4_000);
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10",
            "-t",
            "2",
            "-c:v",
            "mpeg4",
        ],
        &root.join("clip.mp4"),
    );
    set_mtime(&root.join("clip.mp4"), 2_000);
    std::fs::write(root.join("notes.txt"), "not media").unwrap();
    std::fs::write(directory.path().join("outside.png"), "private").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(directory.path().join("outside.png"), root.join("link.png"))
        .unwrap();
    Library {
        _directory: directory,
        data,
        root,
    }
}

fn name(file: &Value) -> String {
    Path::new(file["path"].as_str().unwrap())
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn scanned_files_appear_in_the_gallery_with_thumbnails() {
    let library = library();
    let database = Database::open(&library.data, &library.root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database).await;

    let folders = server.idle_folders().await;
    assert_eq!(folders.len(), 2);
    assert_eq!(
        server.get("/library/progress").await,
        (
            StatusCode::OK,
            json!({"scanning": false, "files": 4, "found": 4, "waiting": 0})
        )
    );

    let files = server.files("?sort=mtime_asc").await;
    let names: Vec<_> = files.iter().map(name).collect();
    assert_eq!(names, ["strip.png", "clip.mp4", "photo.jpg", "loop.gif"]);
    let by_name = |wanted: &str| {
        files
            .iter()
            .find(|file| name(file) == wanted)
            .unwrap()
            .clone()
    };

    let photo = by_name("photo.jpg");
    assert_eq!(
        (photo["width"].as_i64(), photo["height"].as_i64()),
        (Some(100), Some(200))
    );
    assert_eq!(photo["phash"].as_str().unwrap().len(), 16);
    assert_eq!(photo["mediaType"], "IMAGE");
    assert_eq!(photo["voteScore"], 0);
    assert_eq!(photo["nextVoteAt"], Value::Null);
    let clip = by_name("clip.mp4");
    assert_eq!(clip["mediaType"], "VIDEO");
    assert_eq!(clip["durationMs"], 2000);
    assert_eq!(clip["phash"], Value::Null);
    assert!(by_name("strip.png")["thumbUrl"]
        .as_str()
        .unwrap()
        .ends_with("-crop.jpg"));
    assert!(by_name("loop.gif")["thumbUrl"]
        .as_str()
        .unwrap()
        .ends_with("-animated.webp"));

    for file in &files {
        let thumb = file["thumbUrl"].as_str().unwrap();
        let response = server
            .client
            .get(format!("{}{thumb}", server.origin))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "{thumb}");
        let expected = if thumb.ends_with(".webp") {
            "image/webp"
        } else {
            "image/jpeg"
        };
        assert_eq!(response.headers()["content-type"], expected);
        assert_eq!(
            response.headers()["cache-control"],
            "private, max-age=31536000, immutable"
        );
    }
    let (status, _) = server
        .get("/thumbnails/..%2F..%2Fdata%2Flibrary.sqlite")
        .await;
    assert_eq!(status, 404);

    let comics = folders
        .iter()
        .find(|folder| folder["path"].as_str().unwrap().ends_with("Comics"))
        .unwrap();
    let only_comics = server
        .files(&format!("?folderId={}", comics["id"].as_str().unwrap()))
        .await;
    assert_eq!(
        only_comics.iter().map(name).collect::<Vec<_>>(),
        ["strip.png"]
    );
    let videos = server.files("?mediaType=VIDEO").await;
    assert_eq!(videos.iter().map(name).collect::<Vec<_>>(), ["clip.mp4"]);
    let (_, page) = server.get("/files?sort=mtime_desc&limit=2&offset=1").await;
    assert_eq!(page["total"], 4);
    assert_eq!(
        page["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(name)
            .collect::<Vec<_>>(),
        ["photo.jpg", "clip.mp4"]
    );

    let shuffled = server.files("?sort=random&seed=abc").await;
    assert_eq!(server.files("?sort=random&seed=abc").await, shuffled);
    let mut paged = server.files("?sort=random&seed=abc&limit=2").await;
    paged.extend(server.files("?sort=random&seed=abc&limit=2&offset=2").await);
    assert_eq!(paged, shuffled);

    let (status, empty_search) = server.get("/files?tags=female").await;
    assert_eq!(status, 200);
    assert_eq!(empty_search, json!({"files": [], "total": 0}));
    assert_eq!(server.get("/files?sort=bogus").await.0, 400);
    assert_eq!(server.get("/files?limit=0").await.0, 400);

    let id = photo["id"].as_str().unwrap();
    let (status, tags) = server.get(&format!("/files/{id}/tags")).await;
    assert_eq!(status, 200);
    assert_eq!(
        tags,
        json!({"tags": [], "implied": [], "favoriteSources": [], "favoriteSourceLinks": []})
    );
    for (panel, key) in [
        ("relations", "posts"),
        ("pools", "pools"),
        ("source-text", "sources"),
        ("providers", "providers"),
    ] {
        let (status, body) = server.get(&format!("/files/{id}/{panel}")).await;
        assert_eq!(
            (status, body),
            (StatusCode::OK, json!({key: []})),
            "{panel}"
        );
    }
    assert_eq!(server.get("/files/missing/tags").await.0, 404);
    let (status, body) = server
        .send(
            reqwest::Method::POST,
            &format!("/files/{id}/tags/refresh"),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["job"]["fileId"], id);
    assert_eq!(body["job"]["status"], "done");
    assert_eq!(body["updated"], 0);
    server.stop().await;
}

#[tokio::test]
async fn votes_respect_the_floor_and_the_daily_cooldown() {
    let library = library();
    let database = Database::open(&library.data, &library.root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database).await;
    let files = server.files("?sort=mtime_asc").await;
    let (first, second) = (
        files[0]["id"].as_str().unwrap(),
        files[1]["id"].as_str().unwrap(),
    );

    let (status, body) = server
        .send(
            reqwest::Method::POST,
            &format!("/files/{second}/vote"),
            json!({"value": -1}),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(
        body["error"],
        "This file is already at zero and cannot go lower."
    );
    let (status, body) = server
        .send(
            reqwest::Method::POST,
            &format!("/files/{second}/vote"),
            json!({"value": 1}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["voteScore"], 1);
    let next = body["nextVoteAt"].as_str().unwrap().to_owned();
    let (status, body) = server
        .send(
            reqwest::Method::POST,
            &format!("/files/{second}/vote"),
            json!({"value": 1}),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(
        body["error"],
        "This file was already voted in the last 24 hours."
    );
    assert_eq!(
        (body["voteScore"].as_i64(), body["nextVoteAt"].as_str()),
        (Some(1), Some(next.as_str()))
    );
    let (status, _) = server
        .send(
            reqwest::Method::POST,
            &format!("/files/{first}/vote"),
            json!({"value": 2}),
        )
        .await;
    assert_eq!(status, 400);
    assert_eq!(
        server
            .send(
                reqwest::Method::POST,
                "/files/missing/vote",
                json!({"value": 1})
            )
            .await
            .0,
        404
    );

    tokio::time::sleep(Duration::from_millis(5)).await;
    let (status, _) = server
        .send(
            reqwest::Method::POST,
            &format!("/files/{first}/vote"),
            json!({"value": 1}),
        )
        .await;
    assert_eq!(status, 200);

    // Equal scores: the file that reached the score first ranks first.
    let rated = server.files("?sort=rated").await;
    assert_eq!(
        (&rated[0]["id"], &rated[1]["id"]),
        (&json!(second), &json!(first))
    );
    assert_eq!(rated[0]["voteScore"], 1);
    assert_eq!(rated[0]["nextVoteAt"], next);
    server.stop().await;
}

#[tokio::test]
async fn deleting_and_rescanning_keep_rows_in_step_with_the_disk() {
    let library = library();
    let database = Database::open(&library.data, &library.root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database.clone()).await;
    let files = server.files("?sort=mtime_asc").await;
    let photo = files.iter().find(|file| name(file) == "photo.jpg").unwrap();
    let id = photo["id"].as_str().unwrap();
    let thumb = PathBuf::from(photo["thumbPath"].as_str().unwrap());
    assert!(thumb.is_file());
    let strip = files.iter().find(|file| name(file) == "strip.png").unwrap();
    let (status, _) = server
        .send(
            reqwest::Method::POST,
            "/read-marks",
            json!({"scope": "file", "keys": [id, strip["id"]]}),
        )
        .await;
    assert_eq!(status, 200);

    let (status, body) = server
        .send(
            reqwest::Method::DELETE,
            &format!("/files/{id}"),
            Value::Null,
        )
        .await;
    assert_eq!(
        (status, body),
        (StatusCode::OK, json!({"status": "deleted"}))
    );
    assert!(!library.root.join("photo.jpg").exists());
    assert!(!thumb.exists());
    assert_eq!(server.files("").await.len(), 3);
    assert_eq!(
        server
            .send(
                reqwest::Method::DELETE,
                &format!("/files/{id}"),
                Value::Null
            )
            .await
            .0,
        404
    );
    let marks = database
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM read_marks WHERE scope = 'file'",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(marks, 1);

    // Unchanged files keep their row; files and subfolders removed on disk lose theirs.
    let clip = server.files("?mediaType=VIDEO").await[0].clone();
    std::fs::remove_dir_all(library.root.join("Comics")).unwrap();
    picture(&library.root.join("new.png"), "color=c=green:size=64x64");
    library::scan(&database).await.unwrap();
    let names: Vec<_> = server
        .files("?sort=mtime_asc")
        .await
        .iter()
        .map(name)
        .collect();
    assert_eq!(names, ["clip.mp4", "loop.gif", "new.png"]);
    let marks = database
        .call(|connection| {
            Ok(
                connection.query_row("SELECT count(*) FROM read_marks", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(
        marks, 0,
        "removing a subfolder drops the read marks of its files"
    );
    let rescanned = server.files("?mediaType=VIDEO").await[0].clone();
    assert_eq!(
        (&rescanned["id"], &rescanned["updatedAt"]),
        (&clip["id"], &clip["updatedAt"])
    );
    assert_eq!(
        server.get("/folders").await.1["folders"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (status, body) = server
        .send(
            reqwest::Method::DELETE,
            &format!("/folders/{}", clip["folderId"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(status, 400, "{body}");
    server.stop().await;
}

#[tokio::test]
async fn uploads_import_media_and_refuse_disguised_or_duplicate_files() {
    let library = library();
    let database = Database::open(&library.data, &library.root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database).await;
    let folders = server.get("/folders").await.1;
    let root = folders["folders"]
        .as_array()
        .unwrap()
        .iter()
        .find(|folder| !folder["path"].as_str().unwrap().ends_with("Comics"))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = library.data.join("upload.png");
    std::fs::create_dir_all(&library.data).unwrap();
    picture(&source, "color=c=yellow:size=50x40");
    let part =
        |name: &str, bytes: Vec<u8>| multipart::Part::bytes(bytes).file_name(name.to_owned());
    let form = multipart::Form::new()
        .part(
            "file",
            part("../fresh.png", std::fs::read(&source).unwrap()),
        )
        .part(
            "file",
            part("fake.jpg", b"<script>alert(1)</script>".to_vec()),
        )
        .part("file", part("photo.jpg", std::fs::read(&source).unwrap()))
        .part("file", part("raw.dng", b"raw".to_vec()));
    let response = server
        .client
        .post(format!("{}/folders/{root}/uploads", server.origin))
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["uploaded"].as_array().unwrap().len(), 1);
    assert_eq!(body["uploaded"][0]["name"], "fresh.png");
    let mut reasons: Vec<_> = body["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["reason"].as_str().unwrap())
        .collect();
    // Content checks finish after the cheap name checks, so only the set is stable.
    reasons.sort_unstable();
    assert_eq!(
        reasons,
        [
            "A file with this name already exists in the folder",
            "File content does not match its extension",
            "RAW photos are not supported. Export the photo as JPEG and upload it again."
        ]
    );
    assert!(library.root.join("fresh.png").is_file());
    assert!(!library.root.join("fake.jpg").exists());
    let fresh = server
        .files("")
        .await
        .into_iter()
        .find(|file| name(file) == "fresh.png")
        .unwrap();
    assert_eq!(
        (fresh["width"].as_i64(), fresh["height"].as_i64()),
        (Some(50), Some(40))
    );
    assert!(fresh["thumbUrl"].is_string());
    server.stop().await;
}

#[tokio::test]
async fn read_marks_are_validated_and_cleared_per_scope() {
    let directory = TempDir::new().unwrap();
    let server = Running::start(
        Database::open(
            &directory.path().join("data"),
            &directory.path().join("library"),
        )
        .unwrap(),
    )
    .await;
    let (status, body) = server
        .send(
            reqwest::Method::POST,
            "/read-marks",
            json!({"scope": "post", "keys": ["a:1", "a:1", "a:2"]}),
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({"marked": 2})));
    assert_eq!(
        server
            .send(
                reqwest::Method::POST,
                "/read-marks",
                json!({"scope": "post", "keys": []})
            )
            .await
            .0,
        400
    );
    assert_eq!(
        server
            .send(
                reqwest::Method::POST,
                "/read-marks",
                json!({"scope": "other", "keys": ["x"]})
            )
            .await
            .0,
        400
    );
    let long = "x".repeat(257);
    assert_eq!(
        server
            .send(
                reqwest::Method::POST,
                "/read-marks",
                json!({"scope": "post", "keys": [long]})
            )
            .await
            .0,
        400
    );
    let (status, body) = server
        .send(
            reqwest::Method::DELETE,
            "/read-marks?scope=file",
            Value::Null,
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({"cleared": 0})));
    let (status, body) = server
        .send(
            reqwest::Method::DELETE,
            "/read-marks?scope=post",
            Value::Null,
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({"cleared": 2})));
    server.stop().await;
}

#[tokio::test]
async fn reopening_with_another_library_folder_updates_the_profile() {
    let directory = TempDir::new().unwrap();
    let data = directory.path().join("data");
    let first = directory.path().join("first");
    let database = Database::open(&data, &first).unwrap();
    picture(&first.join("original.png"), "color=c=red:size=64x64");
    library::scan(&database).await.unwrap();
    let server = Running::start(database).await;
    server.idle_folders().await;
    let original = server.files("").await[0].clone();
    let id = original["id"].as_str().unwrap();
    assert_eq!(
        server
            .send(
                reqwest::Method::POST,
                &format!("/files/{id}/vote"),
                json!({"value": 1})
            )
            .await
            .0,
        200
    );
    server.stop().await;
    let second = directory.path().join("second");
    let server = Running::start(Database::open(&data, &second).unwrap()).await;
    let (_, profile) = server.get("/device").await;
    assert_eq!(
        profile["user"]["libraryRoot"],
        second.canonicalize().unwrap().to_string_lossy().as_ref()
    );
    assert!(server.files("").await.is_empty());
    assert_eq!(
        server
            .client
            .get(format!(
                "{}{}",
                server.origin,
                original["thumbUrl"].as_str().unwrap()
            ))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        server
            .client
            .get(format!("{}/files/{id}/content", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let response = server
        .client
        .post(format!(
            "{}/folders/{}/uploads",
            server.origin,
            original["folderId"].as_str().unwrap()
        ))
        .multipart(multipart::Form::new().part(
            "file",
            multipart::Part::bytes(b"x".to_vec()).file_name("new.png"),
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    server.stop().await;
    let server = Running::start(Database::open(&data, &first).unwrap()).await;
    server.idle_folders().await;
    let restored = server.files("").await;
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0]["id"], original["id"]);
    assert_eq!(restored[0]["voteScore"], 1);
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn library_boundaries_reject_replaced_directories_and_inactive_roots() {
    let directory = TempDir::new().unwrap();
    let data = directory.path().join("data");
    let root = directory.path().join("first");
    let nested = root.join("Comics");
    std::fs::create_dir_all(&nested).unwrap();
    picture(&nested.join("keep.png"), "color=c=blue:size=64x64");
    let database = Database::open(&data, &root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database).await;
    server.idle_folders().await;
    let file = server.files("").await[0].clone();
    let id = file["id"].as_str().unwrap();
    let folder = file["folderId"].as_str().unwrap();
    let outside = directory.path().join("outside");
    std::fs::rename(&nested, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &nested).unwrap();
    let response = server
        .client
        .get(format!("{}/files/{id}/content", server.origin))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert_eq!(
        server
            .send(
                reqwest::Method::DELETE,
                &format!("/files/{id}"),
                Value::Null
            )
            .await
            .0,
        400
    );
    assert!(outside.join("keep.png").exists());
    let response = server
        .client
        .post(format!("{}/folders/{folder}/uploads", server.origin))
        .multipart(
            multipart::Form::new().part(
                "file",
                multipart::Part::bytes(std::fs::read(outside.join("keep.png")).unwrap())
                    .file_name("new.png"),
            ),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    assert!(!outside.join("new.png").exists());
    server.stop().await;
    let second = directory.path().join("second");
    let server = Running::start(Database::open(&data, &second).unwrap()).await;
    server.idle_folders().await;
    assert!(server.files("").await.is_empty());
    assert_eq!(
        server
            .client
            .get(format!("{}/files/{id}/content", server.origin))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        server
            .send(
                reqwest::Method::DELETE,
                &format!("/files/{id}"),
                Value::Null
            )
            .await
            .0,
        404
    );
    assert_eq!(
        server
            .send(
                reqwest::Method::POST,
                &format!("/files/{id}/vote"),
                json!({"value": 1})
            )
            .await
            .0,
        404
    );
    server.stop().await;
}

#[tokio::test]
async fn identical_uploads_all_get_a_thumbnail() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("library");
    let database = Database::open(&directory.path().join("data"), &root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database).await;
    let folder = server.idle_folders().await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let source = directory.path().join("source.png");
    picture(&source, "color=c=green:size=64x64");
    let mut form = multipart::Form::new();
    for index in 0..8 {
        form = form.part(
            "file",
            multipart::Part::bytes(std::fs::read(&source).unwrap())
                .file_name(format!("copy-{index}.png")),
        );
    }
    let response = server
        .client
        .post(format!("{}/folders/{folder}/uploads", server.origin))
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let files = server.files("").await;
    assert_eq!(files.len(), 8);
    for file in files {
        assert!(file["thumbPath"].is_string(), "{file}");
        assert!(Path::new(file["thumbPath"].as_str().unwrap()).is_file());
    }
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn scanner_refuses_a_library_root_replaced_by_a_symlink() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("library");
    let database = Database::open(&directory.path().join("data"), &root).unwrap();
    library::scan(&database).await.unwrap();
    let outside = directory.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    picture(&outside.join("private.png"), "color=c=blue:size=64x64");
    std::fs::rename(&root, directory.path().join("original")).unwrap();
    std::os::unix::fs::symlink(&outside, &root).unwrap();
    assert!(library::scan(&database).await.is_err());
    let count = database
        .call(|connection| {
            Ok(connection
                .query_row("SELECT count(*) FROM files", [], |row| row.get::<_, i64>(0))?)
        })
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(outside.join("private.png").is_file());
}

#[tokio::test]
async fn an_unreadable_file_is_retried_once_per_run_not_on_every_scan() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("library");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("broken.mp4"), b"not a video").unwrap();
    let database = Database::open(&directory.path().join("data"), &root).unwrap();
    let updated =
        |database: Database| async move {
            database
                .call(|connection| {
                    Ok(connection.query_row(
                        "SELECT updated_at, thumb_path FROM files",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                    )?)
                })
                .await
                .unwrap()
        };
    library::scan(&database).await.unwrap();
    let first = updated(database.clone()).await;
    assert_eq!(first.1, None);
    tokio::time::sleep(Duration::from_millis(5)).await;
    library::scan(&database).await.unwrap();
    assert_eq!(updated(database.clone()).await, first);
}

#[tokio::test]
async fn scans_share_identical_thumbnails_bound_animations_and_register_new_subfolders() {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("library");
    std::fs::create_dir_all(&root).unwrap();
    picture(&root.join("copy.png"), "color=c=purple:size=60x60");
    std::fs::copy(root.join("copy.png"), root.join("twin.png")).unwrap();
    picture(&root.join("tall.png"), "color=c=gray:size=400x700");
    // 130 frames, each far in colour from the one before, so no encoder merges them.
    ffmpeg(
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=black:size=8x8:rate=10,geq=r='mod(N*97,256)':g='mod(N*53,256)':b=0",
            "-t",
            "13",
        ],
        &root.join("long.gif"),
    );
    let database = Database::open(&directory.path().join("data"), &root).unwrap();
    library::scan(&database).await.unwrap();
    let server = Running::start(database.clone()).await;
    let files = server.files("").await;
    let thumb = |wanted: &str| {
        PathBuf::from(
            files.iter().find(|file| name(file) == wanted).unwrap()["thumbPath"]
                .as_str()
                .unwrap(),
        )
    };

    let tall = thumb("tall.png");
    assert!(
        !tall.to_string_lossy().ends_with("-crop.jpg"),
        "{}",
        tall.display()
    );
    let animation = std::fs::read(thumb("long.gif")).unwrap();
    let frames = animation
        .windows(4)
        .filter(|chunk| chunk == b"ANMF")
        .count();
    assert_eq!(frames, 120);

    let shared = thumb("twin.png");
    assert_eq!(thumb("copy.png"), shared);
    let copy = files.iter().find(|file| name(file) == "copy.png").unwrap();
    let (status, _) = server
        .send(
            reqwest::Method::DELETE,
            &format!("/files/{}", copy["id"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200);
    assert!(shared.is_file(), "the twin still uses the thumbnail");

    let old_tall = thumb("tall.png");
    picture(&root.join("tall.png"), "color=c=orange:size=400x700");
    set_mtime(&root.join("tall.png"), 9_000);
    library::scan(&database).await.unwrap();
    let rebuilt = server.files("").await;
    let tall = rebuilt
        .iter()
        .find(|file| name(file) == "tall.png")
        .unwrap();
    let new_tall = PathBuf::from(tall["thumbPath"].as_str().unwrap());
    assert_ne!(new_tall, old_tall);
    assert!(new_tall.is_file());
    assert!(
        !old_tall.exists(),
        "a rebuild removes the thumbnail it replaced"
    );

    // A stored thumbnail path is data: deleting the file must not delete what it points to.
    let outside = directory.path().join("precious.jpg");
    std::fs::write(&outside, b"keep me").unwrap();
    let stored = outside.to_string_lossy().into_owned();
    let tall_id = tall["id"].as_str().unwrap().to_owned();
    let row = tall_id.clone();
    database
        .call(move |connection| {
            connection.execute(
                "UPDATE files SET thumb_path = ?1 WHERE id = ?2",
                [&stored, &row],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    let (status, _) = server
        .send(
            reqwest::Method::DELETE,
            &format!("/files/{tall_id}"),
            Value::Null,
        )
        .await;
    assert_eq!(status, 200);
    assert!(outside.is_file());

    std::fs::create_dir(root.join("Later")).unwrap();
    library::scan(&database).await.unwrap();
    let folders = server.idle_folders().await;
    assert!(folders
        .iter()
        .any(|folder| folder["path"].as_str().unwrap().ends_with("Later")));

    let root_id = folders
        .iter()
        .find(|folder| !folder["path"].as_str().unwrap().ends_with("Later"))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let upload = |folder: String, form: multipart::Form| {
        server
            .client
            .post(format!("{}/folders/{folder}/uploads", server.origin))
            .multipart(form)
            .send()
    };
    let empty = upload(root_id, multipart::Form::new().text("note", "no file"))
        .await
        .unwrap();
    assert_eq!(empty.status(), 400);
    let unknown = upload(
        "missing".into(),
        multipart::Form::new().part(
            "file",
            multipart::Part::bytes(b"x".to_vec()).file_name("a.png"),
        ),
    )
    .await
    .unwrap();
    assert_eq!(unknown.status(), 404);

    for _ in 0..2 {
        let (status, body) = server
            .send(
                reqwest::Method::POST,
                "/read-marks",
                json!({"scope": "post", "keys": ["a:1"]}),
            )
            .await;
        assert_eq!(status, 200, "re-marking a key must not collide: {body}");
    }
    server.stop().await;
}
