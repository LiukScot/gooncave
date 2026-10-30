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
use tower::ServiceExt;

#[cfg(unix)]
#[tokio::test]
async fn saved_credentials_protect_existing_database_journals() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let existing = rusqlite::Connection::open(dir.path().join("library.sqlite")).unwrap();
    existing
        .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE legacy_sample (id INTEGER);")
        .unwrap();
    for name in ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"] {
        std::fs::set_permissions(
            dir.path().join(name),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }
    let _db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
    for name in ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"] {
        assert_eq!(
            std::fs::metadata(dir.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "{name}"
        );
    }
}

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
#[tokio::test]
async fn vote_requests_validate_payloads_and_require_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(
        &directory.path().join("data"),
        &directory.path().join("library"),
    )
    .unwrap();
    let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (status, body) = request(
        &server,
        "POST",
        "/booru-sites",
        json!({"name":"Test","engine":"e621","baseUrl":"https://example.com"}),
    )
    .await;
    assert_eq!(status, 200);
    let site = &body["site"]["id"];
    for payload in [
        json!({"siteId":site,"remoteId":"7","score":2}),
        json!({"siteId":site,"remoteId":"../7","score":1}),
        json!({"siteId":site,"remoteId":"7","score":true}),
    ] {
        assert_eq!(
            request(&server, "POST", "/explore/vote", payload).await.0,
            400
        );
    }
    let (status, body) = request(
        &server,
        "POST",
        "/explore/vote",
        json!({"siteId":site,"remoteId":"7","score":1}),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("username and API key"));
}

#[tokio::test]
async fn catalog_configuration_and_credentials_survive_restart_without_exposing_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let library = dir.path().join("library");
    let db = Database::open(&data, &library).unwrap();
    let server = Server::bind(db.clone(), 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (status, catalog) = request(&server, "GET", "/booru-sites/engines", Value::Null).await;
    assert_eq!(status, 200, "{catalog}");
    assert_eq!(catalog["engines"].as_array().unwrap().len(), 9);
    for engine in catalog["engines"].as_array().unwrap() {
        let supported = matches!(
            engine["type"].as_str().unwrap(),
            "e621" | "danbooru" | "gelbooru" | "furaffinity" | "szurubooru"
        );
        assert_eq!(engine["defaultCapabilities"]["favorites"], supported);
        assert_eq!(engine["defaultCapabilities"]["sourceMatch"], true);
        assert_eq!(
            engine["defaultCapabilities"]["vote"],
            matches!(
                engine["type"].as_str().unwrap(),
                "e621" | "danbooru" | "szurubooru"
            )
        );
    }
    let (status,body)=request(&server,"POST","/booru-sites",json!({"name":"Example","engine":"e621","baseUrl":"https://example.com","username":"test-user","apiKey":"fake-key","sessionCookie":"fake-cookie"})).await;
    assert_eq!(status, 200, "{body}");
    assert!(!body.to_string().contains("fake-key"));
    assert!(!body.to_string().contains("fake-cookie"));
    let id = body["site"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        request(
            &server,
            "POST",
            "/booru-sites",
            json!({"name":"Duplicate","engine":"e621","baseUrl":"https://example.com"})
        )
        .await
        .0,
        409
    );
    drop(server);
    drop(db);
    let db = Database::open(&data, &library).unwrap();
    let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (status, body) = request(&server, "GET", "/booru-sites", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(body["sites"][0]["id"], id);
    assert_eq!(body["sites"][0]["hasApiKey"], true);
    let (status, body) = request(
        &server,
        "PUT",
        &format!("/booru-sites/{id}"),
        json!({"apiKey":null}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(body["site"]["hasApiKey"], false);
    for base in [
        "http://127.0.0.1",
        "https://localhost",
        "https://user:password@example.com",
        "file:///etc/passwd",
    ] {
        assert_eq!(
            request(
                &server,
                "POST",
                "/booru-sites",
                json!({"name":"Bad","engine":"e621","baseUrl":base})
            )
            .await
            .0,
            400,
            "{base}"
        );
    }
    for query in [
        "page=0",
        "limit=101",
        "sort=unknown",
        "date=2026-02-30",
        "window=unknown",
    ] {
        assert_eq!(
            request(
                &server,
                "GET",
                &format!("/explore/posts?{query}"),
                Value::Null
            )
            .await
            .0,
            400,
            "{query}"
        );
    }
    assert_eq!(
        request(
            &server,
            "DELETE",
            &format!("/booru-sites/{id}"),
            Value::Null
        )
        .await
        .0,
        200
    );
    let (status, body) = request(&server, "GET", "/explore/posts", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(body["posts"], json!([]));
}

#[tokio::test]
async fn a_known_site_added_by_hand_takes_its_preset_key() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(
        &directory.path().join("data"),
        &directory.path().join("library"),
    )
    .unwrap();
    let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (status, body) = request(
        &server,
        "POST",
        "/booru-sites",
        json!({"name":"My Danbooru","engine":"danbooru","baseUrl":"https://danbooru.donmai.us/"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["presetKey"], "DANBOORU");
    let (status, body) = request(
        &server,
        "POST",
        "/booru-sites",
        json!({"name":"Mirror","engine":"e621","baseUrl":"https://mirror.example"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["presetKey"], Value::Null);
}

#[tokio::test]
async fn a_pasted_cookie_loses_its_line_breaks_and_rule34_offers_sign_in() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(
        &directory.path().join("data"),
        &directory.path().join("library"),
    )
    .unwrap();
    let server = Server::bind(db.clone(), 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (status, body) = request(
        &server,
        "POST",
        "/booru-sites",
        json!({"name":"Rule34","engine":"gelbooru","baseUrl":"https://api.rule34.xxx","sessionCookie":"user_id=1; pass_hash=fake\r\n-hash\t"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["browserSignIn"], "Rule34");
    let cookie: String = db
        .call(|c| {
            Ok(
                c.query_row("SELECT session_cookie FROM user_booru_sites", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(cookie, "user_id=1; pass_hash=fake-hash");
    let (status, body) = request(
        &server,
        "POST",
        "/booru-sites",
        json!({"name":"Mirror","engine":"gelbooru","baseUrl":"https://gelbooru.com"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["browserSignIn"], Value::Null);
}

#[tokio::test]
async fn saved_secrets_stay_behind_when_a_site_moves_to_another_server() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(
        &directory.path().join("data"),
        &directory.path().join("library"),
    )
    .unwrap();
    let server = Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap();
    let (status, body) = request(
        &server,
        "POST",
        "/booru-sites",
        json!({"name":"Mine","engine":"e621","baseUrl":"https://booru.example","username":"someone","apiKey":"fake-key","sessionCookie":"fake-cookie"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let path = format!("/booru-sites/{}", body["site"]["id"].as_str().unwrap());

    let moved = |base: &str| json!({"baseUrl": base});
    let (status, body) = request(&server, "PUT", &path, moved("https://booru.example/api")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["hasApiKey"], true);
    assert_eq!(body["site"]["hasSessionCookie"], true);

    let (status, body) = request(&server, "PUT", &path, moved("https://other.example")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["hasApiKey"], false);
    assert_eq!(body["site"]["hasSessionCookie"], false);

    let (status, body) = request(
        &server,
        "PUT",
        &path,
        json!({"baseUrl":"https://third.example","apiKey":"fake-new-key"}),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["hasApiKey"], true);
}
