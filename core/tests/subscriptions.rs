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
        json!({"tags":[],"artists":[],"siteHits":{},"artistErrors":[],"targets":[],"artistSearches":[]})
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
async fn the_feed_validates_its_inputs_and_reports_sites_it_cannot_read() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path(), &dir.path().join("library")).unwrap();
    let s = server(db.clone()).await;
    assert_eq!(
        request(&s, "GET", "/explore/subscriptions", Value::Null).await,
        (
            200,
            json!({"posts":[],"hasMore":false,"nextCursor":null,"siteErrors":[]})
        ),
        "with no searches there is nothing to read"
    );
    let search = site(&s, "danbooru").await;
    let fa = site(&s, "furaffinity").await;
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
    // Neither site answers: the danbooru address does not exist and FurAffinity has no login.
    let (status, page) = request(&s, "GET", "/explore/subscriptions", Value::Null).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["posts"], json!([]));
    assert_eq!(page["hasMore"], false);
    let mut failed = page["siteErrors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["siteId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    failed.sort();
    let mut expected = vec![search, fa];
    expected.sort();
    assert_eq!(failed, expected);
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
