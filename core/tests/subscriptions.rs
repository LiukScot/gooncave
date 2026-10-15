use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use gooncave_core::{
    db::{Database, OWNER_ID},
    http::{Frontend, Server},
};
use serde_json::{json, Value};
use std::sync::Arc;
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
async fn server(db: Database) -> Server {
    Server::bind(db, 0, Frontend::Embedded(Arc::new(|_| None)))
        .await
        .unwrap()
}
async fn site(server: &Server, engine: &str) -> String {
    let (status, result) = request(
        server,
        "POST",
        "/booru-sites",
        json!({"name":engine,"engine":engine,"baseUrl":format!("https://{engine}.example.com")}),
    )
    .await;
    assert_eq!(status, 200, "{result}");
    result["site"]["id"].as_str().unwrap().into()
}
fn post(id: &str) -> Value {
    json!({"remoteId":id,"previewUrl":"https://cdn.example.com/post.jpg","sampleUrl":null,"fileUrl":null,
        "createdAt":"2026-10-12T00:00:00.000Z","tags":[{"tag":"fixture_artist","category":"artist"}],
        "favorited":null,"fileExt":null})
}
async fn seed(db: &Database, site: &str, ids: &[&str]) {
    let site = site.to_owned();
    let posts = ids
        .iter()
        .map(|id| ((*id).to_owned(), post(id)))
        .collect::<Vec<_>>();
    db.call(move |c| {
        for (id,post) in posts {c.execute("INSERT INTO subscription_feed_items
            (user_id,site_id,remote_id,post_json,sort_at,discovered_at) VALUES (?1,?2,?3,?4,?5,?5)",
            rusqlite::params![OWNER_ID,site,id,post.to_string(),"2026-10-12T00:00:00.000Z"])?;}
        c.execute("INSERT INTO subscription_feed_sync_state(user_id,site_id,search_exhausted,updated_at) VALUES (?1,?2,1,?3)",
            rusqlite::params![OWNER_ID,site,"2026-10-12T00:00:00.000Z"])?;
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn searches_preserve_operators_validate_inputs_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let library = dir.path().join("library");
    let db = Database::open(&data, &library).unwrap();
    let s = server(db.clone()).await;
    assert_eq!(
        request(&s, "GET", "/settings/subscriptions", Value::Null)
            .await
            .1,
        json!({"tags":[],"artistSources":[],"targets":[]})
    );
    let (status,result)=request(&s,"PUT","/settings/subscriptions/tags",json!({"tags":[" Fixture_Artist   score:>10 ","fixture_artist score:>10","~wolf ~fox -photo"]})).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(
        result["tags"],
        json!(["fixture_artist score:>10", "~wolf ~fox -photo"])
    );
    assert_eq!(
        request(
            &s,
            "POST",
            "/settings/subscriptions/tags",
            json!({"tag":"Blue Eyes"})
        )
        .await
        .1["tags"],
        json!(["fixture_artist score:>10", "~wolf ~fox -photo", "blue_eyes"])
    );
    for value in [
        json!({"tags":"wolf"}),
        json!({"tags":[null]}),
        json!({"tags":[""]}),
        json!({"tags":["x".repeat(101)]}),
        json!({"tags":vec!["wolf";501]}),
    ] {
        assert_eq!(
            request(&s, "PUT", "/settings/subscriptions/tags", value)
                .await
                .0,
            400
        );
    }
    drop(s);
    drop(db);
    let s = server(Database::open(&data, &library).unwrap()).await;
    assert_eq!(
        request(&s, "GET", "/settings/subscriptions/tags", Value::Null)
            .await
            .1["tags"],
        json!(["fixture_artist score:>10", "~wolf ~fox -photo", "blue_eyes"])
    );
    assert_eq!(
        request(&s, "GET", "/device", Value::Null).await.1["user"]["capabilities"]["subscriptions"],
        true
    );
}

#[tokio::test]
async fn feed_cursor_is_stable_across_new_posts_and_bookmark_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let library = dir.path().join("library");
    let db = Database::open(&data, &library).unwrap();
    let s = server(db.clone()).await;
    let id = site(&s, "e621").await;
    seed(&db, &id, &["1", "2", "3"]).await;
    let (status, first) = request(&s, "GET", "/explore/subscriptions?limit=1", Value::Null).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["posts"][0]["remoteId"], "1");
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["ready"], true);
    assert!(first["posts"][0]["previewUrl"]
        .as_str()
        .unwrap()
        .starts_with("https://"));
    assert!(first["posts"][0]["colorSourceUrl"]
        .as_str()
        .unwrap()
        .starts_with("/explore/media/"));
    let cursor = first["nextCursor"].as_str().unwrap();
    let added_id = id.clone();
    db.call(move |c| {
        c.execute("INSERT INTO subscription_feed_items(user_id,site_id,remote_id,post_json,sort_at,discovered_at) VALUES (?1,?2,'4',?3,?4,?4)",
            rusqlite::params![OWNER_ID,added_id,post("4").to_string(),"2026-10-13T00:00:00.000Z"])?;Ok(())
    }).await.unwrap();
    let next = request(
        &s,
        "GET",
        &format!("/explore/subscriptions?limit=1&cursor={cursor}"),
        Value::Null,
    )
    .await
    .1;
    assert_eq!(next["posts"][0]["remoteId"], "2");
    assert_eq!(
        request(
            &s,
            "PUT",
            "/explore/subscriptions/bookmark",
            json!({"siteId":id,"remoteId":"2"})
        )
        .await
        .0,
        200
    );
    request(
        &s,
        "POST",
        "/read-marks",
        json!({"scope":"post","keys":[format!("{id}:2")]}),
    )
    .await;
    drop(s);
    drop(db);
    let s = server(Database::open(&data, &library).unwrap()).await;
    let resumed = request(
        &s,
        "GET",
        "/explore/subscriptions?resume=1&limit=1",
        Value::Null,
    )
    .await
    .1;
    assert_eq!(resumed["posts"][0]["remoteId"], "2");
    assert_eq!(resumed["posts"][0]["read"], true);
    assert_eq!(
        request(&s, "GET", "/explore/subscriptions?limit=1", Value::Null)
            .await
            .1["posts"][0]["remoteId"],
        "4"
    );
    for query in ["cursor=garbage", "limit=0", "limit=101", "resume=invalid"] {
        assert_eq!(
            request(
                &s,
                "GET",
                &format!("/explore/subscriptions?{query}"),
                Value::Null
            )
            .await
            .0,
            400
        );
    }
    assert_eq!(
        request(
            &s,
            "PUT",
            "/explore/subscriptions/bookmark",
            json!({"siteId":id,"remoteId":"../../wrong"})
        )
        .await
        .0,
        400
    );
}

#[tokio::test]
async fn search_edits_keep_furaffinity_feed_and_credentials_errors_are_visible() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
    let s = server(db.clone()).await;
    let search = site(&s, "danbooru").await;
    let fa = site(&s, "furaffinity").await;
    seed(&db, &search, &["1"]).await;
    seed(&db, &fa, &["2"]).await;
    assert_eq!(
        request(
            &s,
            "PUT",
            "/settings/subscriptions/tags",
            json!({"tags":["wolf"]})
        )
        .await
        .0,
        200
    );
    let posts = request(&s, "GET", "/explore/subscriptions", Value::Null)
        .await
        .1;
    assert_eq!(posts["posts"].as_array().unwrap().len(), 1);
    assert_eq!(posts["posts"][0]["siteId"], fa);
    let settings = request(&s, "GET", "/settings/subscriptions", Value::Null)
        .await
        .1;
    assert!(settings["artistSources"][0]["error"]
        .as_str()
        .unwrap()
        .contains("Accounts"));
    assert_eq!(
        request(
            &s,
            "POST",
            "/settings/subscriptions/artists",
            json!({"siteId":search,"artist":"fixture-artist"})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(
            &s,
            "POST",
            "/settings/subscriptions/artists",
            json!({"siteId":fa,"artist":"fixture-artist"})
        )
        .await
        .0,
        400
    );
    for rounds in [0, 5] {
        assert_eq!(
            request(
                &s,
                "POST",
                "/explore/subscriptions/refresh",
                json!({"rounds":rounds})
            )
            .await
            .0,
            400
        );
    }
}
