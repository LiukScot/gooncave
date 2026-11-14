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
        json!({"tags":[],"artists":[],"artistErrors":[],"targets":[]})
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
    assert_eq!(
        request(
            &s,
            "POST",
            "/settings/subscriptions/tags",
            json!({"search":"  Wolf  -photo score:>5 "})
        )
        .await
        .1["tags"],
        json!([
            "fixture_artist score:>10",
            "~wolf ~fox -photo",
            "blue_eyes",
            "wolf -photo score:>5"
        ]),
        "a whole search keeps its spaces and operators"
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
        json!([
            "fixture_artist score:>10",
            "~wolf ~fox -photo",
            "blue_eyes",
            "wolf -photo score:>5"
        ])
    );
    assert_eq!(
        request(&s, "GET", "/device", Value::Null).await.1["user"]["capabilities"]["subscriptions"],
        true
    );
}

#[tokio::test]
async fn feed_cursor_is_stable_across_new_posts() {
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
        request(&s, "GET", "/explore/subscriptions?limit=1", Value::Null)
            .await
            .1["posts"][0]["remoteId"],
        "4"
    );
    for query in ["cursor=garbage", "limit=0", "limit=101"] {
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
    assert!(settings["artistErrors"][0]["error"]
        .as_str()
        .unwrap()
        .contains("Accounts"));
    // The artist is kept in GoonCave and passed to FurAffinity once the account works.
    let (status, followed) = request(
        &s,
        "POST",
        "/settings/subscriptions/artists",
        json!({"artist":"fixture-artist"}),
    )
    .await;
    assert_eq!(status, 200, "{followed}");
    assert_eq!(followed["artists"], json!(["fixture-artist"]));
    assert!(followed["artistErrors"][0]["error"]
        .as_str()
        .unwrap()
        .contains("Accounts"));
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

#[tokio::test]
async fn pool_subscriptions_validate_targets_and_remove_idempotently() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
    let s = server(db.clone()).await;
    let e621 = site(&s, "e621").await;
    let gelbooru = site(&s, "gelbooru").await;
    assert_eq!(
        request(&s, "GET", "/settings/subscriptions/pools", Value::Null).await,
        (200, json!({"pools":[]}))
    );
    for body in [
        json!({"siteId":e621,"poolId":"1 rating:e"}),
        json!({"siteId":e621,"poolId":null}),
        json!({"siteId":"missing","poolId":"1"}),
        json!({"siteId":gelbooru,"poolId":"1"}),
    ] {
        let (status, result) = request(&s, "POST", "/settings/subscriptions/pools", body).await;
        assert_eq!(status, 400, "{result}");
    }
    assert_eq!(
        request(
            &s,
            "DELETE",
            "/settings/subscriptions/pools",
            json!({"siteId":e621,"poolId":"12"})
        )
        .await,
        (200, json!({"pools":[]}))
    );
}

#[tokio::test]
async fn the_end_of_the_saved_feed_asks_for_older_posts_while_a_site_has_more() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
    let s = server(db.clone()).await;
    let id = site(&s, "e621").await;
    seed(&db, &id, &["1", "2"]).await;
    let site_id = id.clone();
    db.call(move |c| {
        c.execute(
            "UPDATE subscription_feed_sync_state SET search_exhausted=0,feed_exhausted=0 WHERE site_id=?1",
            rusqlite::params![site_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let last = request(&s, "GET", "/explore/subscriptions?limit=2", Value::Null)
        .await
        .1;
    assert_eq!(last["posts"].as_array().unwrap().len(), 2);
    assert_eq!(
        last["hasMore"], true,
        "the site can still send older posts: {last}"
    );
    let cursor = last["nextCursor"].as_str().unwrap();
    let past = request(
        &s,
        "GET",
        &format!("/explore/subscriptions?limit=2&cursor={cursor}"),
        Value::Null,
    )
    .await
    .1;
    assert_eq!(past["posts"], json!([]));
    assert_eq!(
        past["ready"], false,
        "older posts have to be fetched first: {past}"
    );
}
