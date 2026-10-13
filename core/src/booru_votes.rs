use crate::{
    booru_engines as engines,
    booru_http::{remote, Transport},
    boorus::{self, Site},
    db::Database,
    Error, Result,
};
use axum::{extract::State, Json};
use reqwest::{header::CONTENT_TYPE, Method};
use serde_json::{json, Value};

pub(crate) fn supported(engine: &str) -> bool {
    matches!(engine, "e621" | "danbooru" | "szurubooru")
}

pub(crate) async fn route(
    State(db): State<Database>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let site_id = body["siteId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .ok_or_else(|| Error::Invalid("Choose a site to vote on.".into()))?;
    let id = engines::id(&body["remoteId"])
        .map_err(|_| Error::Invalid("Choose a valid post to vote on.".into()))?;
    let score = body["score"]
        .as_i64()
        .filter(|s| (-1..=1).contains(s))
        .ok_or_else(|| Error::Invalid("Choose an up vote, down vote or remove vote.".into()))?;
    let _guard = db.favorites.writes.lock().await;
    let site = boorus::site(&db, site_id.into())
        .await?
        .ok_or_else(|| Error::Invalid("This site is no longer configured.".into()))?;
    set(&Transport::default(), &site, &id, score).await?;
    Ok(Json(json!({"ok":true})))
}

pub(crate) async fn set(t: &Transport, site: &Site, id: &str, score: i64) -> Result<()> {
    if !site.enabled || !supported(&site.engine) || !(-1..=1).contains(&score) {
        return Err(Error::Invalid(
            "Enable a site that supports voting in Accounts.".into(),
        ));
    }
    let username = site
        .username
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::Invalid("Save your username and API key in Accounts before voting.".into())
        })?;
    if site.key.as_deref().is_none_or(str::is_empty) {
        return Err(Error::Invalid(
            "Save your username and API key in Accounts before voting.".into(),
        ));
    }
    let id = engines::id(&json!(id))?;
    let mut headers = engines::headers(site, false)?;
    let (target, method, body) = match site.engine.as_str() {
        "szurubooru" => {
            headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
            (
                engines::endpoint(site, &format!("/api/post/{id}/score"))?,
                Method::PUT,
                Some(json!({"score":score}).to_string()),
            )
        }
        "e621" => (
            engines::endpoint(site, &format!("/posts/{id}/votes.json"))?,
            if score == 0 {
                Method::DELETE
            } else {
                Method::POST
            },
            (score != 0).then(|| format!("score={score}&no_unvote=true")),
        ),
        "danbooru" if score == 0 => {
            let mut user = engines::endpoint(site, "/users/")?;
            user.path_segments_mut()
                .map_err(|_| remote("Check the site's address in Accounts."))?
                .pop_if_empty()
                .push(&format!("{username}.json"));
            let user = t.json(user, headers.clone()).await?;
            let user_id = engines::id(&user["id"])?;
            let mut lookup = engines::endpoint(site, "/post_votes.json")?;
            lookup
                .query_pairs_mut()
                .append_pair("search[post_id]", &id)
                .append_pair("search[user_id]", &user_id)
                .append_pair("search[is_deleted]", "false")
                .append_pair("limit", "100");
            let found = t.json(lookup, headers.clone()).await?;
            let votes = found.as_array().filter(|v| v.len() <= 100).ok_or_else(|| {
                remote("The site returned an invalid vote list. No vote was removed.")
            })?;
            let mut own = Vec::new();
            for vote in votes {
                let deleted = vote["is_deleted"].as_bool().ok_or_else(|| {
                    remote("The site returned an invalid vote state. No vote was removed.")
                })?;
                if engines::id(&vote["user_id"])? == user_id
                    && engines::id(&vote["post_id"])? == id
                    && !deleted
                {
                    own.push(engines::id(&vote["id"])?);
                }
            }
            if own.is_empty() {
                return Ok(());
            }
            if own.len() != 1 {
                return Err(remote("The site returned conflicting votes. Open the original post to remove your vote."));
            }
            (
                engines::endpoint(site, &format!("/post_votes/{}.json", own[0]))?,
                Method::DELETE,
                None,
            )
        }
        "danbooru" => (
            engines::endpoint(site, &format!("/posts/{id}/votes.json"))?,
            Method::POST,
            Some(format!("score={score}")),
        ),
        _ => return Err(Error::Invalid("This site does not support voting.".into())),
    };
    let response = t.write(target, headers, method, body).await?;
    if response.status().is_success() || (score == 0 && response.status() == 404) {
        return Ok(());
    }
    Err(remote("The site refused the vote. Check your account credentials and voting permissions in Accounts."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, extract::Request, routing::any, Router};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Remote {
        vote: i64,
        favorite: bool,
        writes: Vec<String>,
    }

    #[tokio::test]
    async fn repeated_votes_and_removals_are_idempotent_and_delete_only_our_vote() {
        for engine in ["e621", "danbooru", "szurubooru"] {
            let state = Arc::new(Mutex::new(Remote::default()));
            let app = Router::new().fallback(any(|State(state):State<Arc<Mutex<Remote>>>,request:Request| async move {
                let method = request.method().clone();
                let path = request.uri().path().to_owned();
                let query = request.uri().query().unwrap_or("").to_owned();
                let headers = request.headers().clone();
                let bytes = to_bytes(request.into_body(),1024).await.unwrap();
                let mut remote = state.lock().unwrap();
                if method == Method::GET {
                    let value = if path.starts_with("/users/") {json!({"id":11})}
                        else if path == "/post_votes.json" {
                            let parameters = reqwest::Url::parse(&format!("http://localhost?{query}")).unwrap();
                            assert!(parameters.query_pairs().any(|(name,value)| name == "search[user_id]" && value == "11"));
                            let mut votes = vec![json!({"id":77,"user_id":22,"post_id":7,"is_deleted":false})];
                            if remote.vote != 0 {votes.push(json!({"id":55,"user_id":11,"post_id":7,"is_deleted":false}));}
                            json!(votes)
                        } else {json!({"posts":[{"id":7,"vote":remote.vote}]})};
                    return Json(value);
                }
                remote.writes.push(path.clone());
                if path.ends_with("/favorite") {
                    remote.favorite = method == Method::POST;
                } else if path == "/api/post/7/score" {
                    assert_eq!(method,Method::PUT);
                    assert_eq!(headers[CONTENT_TYPE],"application/json");
                    remote.vote = serde_json::from_slice::<Value>(&bytes).unwrap()["score"].as_i64().unwrap();
                } else if method == Method::DELETE {
                    assert!(["/post_votes/55.json","/posts/7/votes.json"].contains(&path.as_str()));
                    remote.vote=0;
                } else {
                    assert_eq!(headers[CONTENT_TYPE],"application/x-www-form-urlencoded");
                    let values = reqwest::Url::parse(&format!("http://localhost?{}",String::from_utf8(bytes.to_vec()).unwrap())).unwrap();
                    let values = values.query_pairs().collect::<std::collections::HashMap<_,_>>();
                    let score = values["score"].parse::<i64>().unwrap();
                    remote.vote = if values.get("no_unvote").is_some_and(|v| v == "false") && remote.vote == score {0} else {score};
                }
                Json(json!({"ok":true}))
            })).with_state(state.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let site = Site {
                id: "test".into(),
                name: "Test".into(),
                engine: engine.into(),
                base,
                username: Some("test-user".into()),
                key: Some("fake-key".into()),
                cookie: None,
                enabled: true,
                public: json!({}),
            };
            let transport = Transport {
                allow_loopback: true,
            };
            for score in [1, 1, -1, -1, 0, 0] {
                set(&transport, &site, "7", score).await.unwrap();
                assert_eq!(state.lock().unwrap().vote, score, "{engine}");
            }
            if engine == "szurubooru" {
                for desired in [true, true, false, false] {
                    crate::booru_favorites::set(&transport, &site, "7", desired)
                        .await
                        .unwrap();
                    assert_eq!(state.lock().unwrap().favorite, desired);
                }
            }
            assert!(!state
                .lock()
                .unwrap()
                .writes
                .iter()
                .any(|path| path.contains("77")));
            task.abort();
            let _ = task.await;
        }
    }

    #[tokio::test]
    async fn missing_credentials_and_unsupported_engines_fail_before_network() {
        let mut site = Site {
            id: "test".into(),
            name: "Test".into(),
            engine: "e621".into(),
            base: "https://unused.invalid".into(),
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: json!({}),
        };
        assert!(set(&Transport::default(), &site, "7", 1)
            .await
            .unwrap_err()
            .to_string()
            .contains("username and API key"));
        site.engine = "shimmie".into();
        assert!(set(&Transport::default(), &site, "7", 1)
            .await
            .unwrap_err()
            .to_string()
            .contains("supports voting"));
    }
}
