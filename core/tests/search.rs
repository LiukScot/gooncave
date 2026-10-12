use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use gooncave_core::{
    db::Database,
    http::{Frontend, Server},
};
use serde_json::{json, Value};
use std::sync::Arc;
use tempfile::TempDir;
use tower::ServiceExt;

async fn request(server: &Server, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = server
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", server.origin.trim_start_matches("http://"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn fixture() -> (TempDir, Database, Server) {
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("library");
    let db = Database::open(&directory.path().join("data"), &root).unwrap();
    let path = root.to_string_lossy().into_owned();
    db.call(move |c| {
        c.execute("INSERT INTO folders (id,user_id,path,type,created_at,updated_at,status) VALUES ('root','device-owner',?1,'LOCAL','now','now','IDLE')", [path])?;
        c.execute("INSERT INTO active_library_folders VALUES ('root')", [])?;
        for id in ["a", "b", "c"] {
            c.execute("INSERT INTO files (id,folder_id,location_type,path,size_bytes,mtime,sha256,media_type,created_at,updated_at) VALUES (?1,'root','LOCAL',?1,1,'now',?1,'IMAGE','now','now')", [id])?;
        }
        c.execute("INSERT INTO tag_aliases VALUES ('puppy','dog','e621')", [])?;
        c.execute("INSERT INTO tag_implications VALUES ('dog','animal')", [])?;
        Ok(())
    }).await.unwrap();
    let server = Server::bind(db.clone(), 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    (directory, db, server)
}

#[tokio::test]
async fn manual_tags_aliases_negation_blacklist_and_suggestions() {
    let (_dir, db, server) = fixture().await;
    for (id, tags) in [
        ("a", vec!["puppy", "blue_eyes"]),
        ("b", vec!["dog", "hidden"]),
        ("c", vec!["cat"]),
    ] {
        for tag in tags {
            let (status, body) = request(
                &server,
                "POST",
                &format!("/files/{id}/tags/manual"),
                json!({"tag": tag, "category":"species"}),
            )
            .await;
            assert_eq!(status, 200, "{body}");
        }
    }
    // Blacklist terms are added to the search by the existing frontend.
    for (query, ids) in [
        ("puppy%20-hidden%20-cat", vec!["a"]),
        ("animal", vec!["a", "b"]),
        ("~dog%20~cat", vec!["a", "b", "c"]),
        ("dog%20blue_eyes", vec!["a"]),
        ("-dog", vec!["c"]),
        ("score:0", vec!["a", "b", "c"]),
    ] {
        let (status, body) = request(
            &server,
            "GET",
            &format!("/files?tags={query}&sort=mtime_asc&limit=1"),
            Value::Null,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["total"], ids.len());
        assert_eq!(body["files"][0]["id"], ids[0]);
    }
    let reference: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/core-search-reference.json"
    ))
    .unwrap();
    for case in reference.as_array().unwrap() {
        let mut url = reqwest::Url::parse("http://localhost/files").unwrap();
        url.query_pairs_mut()
            .append_pair("tags", case["query"].as_str().unwrap())
            .append_pair("sort", "mtime_asc");
        let (_, body) = request(
            &server,
            "GET",
            &format!("/files?{}", url.query().unwrap()),
            Value::Null,
        )
        .await;
        let ids: Vec<_> = body["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["id"].clone())
            .collect();
        assert_eq!(json!(ids), case["ids"], "query {}", case["query"]);
        assert_eq!(body["total"], case["ids"].as_array().unwrap().len());
    }
    let (_, body) = request(&server, "GET", "/tags/suggest?q=dog", Value::Null).await;
    assert_eq!(body, json!({"suggestions":[{"tag":"dog", "files":2}]}));
    let (_, tags) = request(&server, "GET", "/files/a/tags", Value::Null).await;
    assert_eq!(tags["implied"], json!(["animal"]));
    assert_eq!(tags["tags"][1]["canonicalTag"], "dog");
    let (status, _) = request(
        &server,
        "POST",
        "/files/a/tags/suppress",
        json!({"tags":["puppy"]}),
    )
    .await;
    assert_eq!(status, 200);
    let (_, body) = request(&server, "GET", "/files?tags=dog", Value::Null).await;
    assert_eq!(body["total"], 1);
    let count = db.call(|c| Ok(c.query_row("SELECT count(*) FROM file_tags WHERE file_id='a' AND source='MANUAL' AND canonical_tag='dog'", [], |r| r.get::<_,i64>(0))?)).await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn tag_boundaries_and_inactive_libraries_are_enforced() {
    let (_dir, db, server) = fixture().await;
    for (path, body) in [
        ("/files/missing/tags/manual", json!({"tag":"cat"})),
        ("/files/a/tags/manual", json!({"tag":"***"})),
        (
            "/files/a/tags/manual",
            json!({"tag":"cat","category":"unknown"}),
        ),
        ("/files/a/tags/suppress", json!({"tags":[]})),
    ] {
        let (status, _) = request(&server, "POST", path, body).await;
        assert_eq!(status, if path.contains("missing") { 404 } else { 400 });
    }
    db.call(|c| {
        c.execute("DELETE FROM active_library_folders", [])?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        request(
            &server,
            "POST",
            "/files/a/tags/manual",
            json!({"tag":"cat"})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        request(&server, "GET", "/files/a/tags", Value::Null)
            .await
            .0,
        404
    );
    assert_eq!(
        request(&server, "GET", "/tags/suggest?limit=51", Value::Null)
            .await
            .0,
        400
    );
}
