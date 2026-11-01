//! Comments on a post, read-only: every site that publishes them answers in its own shape, and they
//! leave here as one list of `{id, author, body, score, createdAt}`, oldest first. `body` is the
//! Markdown subset the frontend renders (see `post_text`).

use crate::{
    booru_engines,
    booru_http::{self, Transport},
    boorus::Site,
    post_text, Result,
};
use serde_json::{json, Value};

const MAX_COMMENTS: &str = "100";
const UNEXPECTED_LIST: &str = "The site returned an unexpected comment list.";

/// Engines whose comments are a plain API call. The others need a page scrape or a login.
pub(crate) fn supported(engine: &str) -> bool {
    matches!(
        engine,
        "e621" | "danbooru" | "moebooru" | "philomena" | "gelbooru"
    )
}

fn comment(
    id: &Value,
    author: Option<&str>,
    body: Option<String>,
    score: Option<i64>,
    created_at: Option<&Value>,
) -> Option<Value> {
    let id = id
        .as_u64()
        .map(|n| n.to_string())
        .or_else(|| id.as_str().map(str::to_owned))?;
    Some(json!({
        "id": id,
        "author": author.unwrap_or("Anonymous"),
        "body": body?,
        "score": score,
        "createdAt": created_at.and_then(Value::as_str),
    }))
}

fn sorted(mut comments: Vec<Value>) -> Vec<Value> {
    let key = |c: &Value| c["id"].as_str().and_then(|id| id.parse::<u64>().ok());
    comments.sort_by_key(key);
    comments
}

fn items<'a>(value: &'a Value, wrapper: &str) -> Result<&'a [Value]> {
    match value {
        Value::Array(list) => Ok(list),
        Value::Object(map) => map.get(wrapper).and_then(Value::as_array).map_or_else(
            || Err(booru_http::remote(UNEXPECTED_LIST)),
            |list| Ok(list.as_slice()),
        ),
        _ => Err(booru_http::remote(UNEXPECTED_LIST)),
    }
}

/// e621 and Danbooru: DText bodies, `creator_name` (e621) or `creator.name`, hidden or deleted
/// comments left out.
fn from_dtext_site(value: &Value, base: &str) -> Result<Vec<Value>> {
    Ok(sorted(
        items(value, "comments")?
            .iter()
            .filter(|c| !c["is_hidden"].as_bool().unwrap_or(false))
            .filter(|c| !c["is_deleted"].as_bool().unwrap_or(false))
            .filter_map(|c| {
                let author = c["creator_name"]
                    .as_str()
                    .or_else(|| c["creator"]["name"].as_str());
                let fallback = c["creator_id"].as_u64().map(|id| format!("User #{id}"));
                comment(
                    &c["id"],
                    author.or(fallback.as_deref()),
                    post_text::dtext_to_markdown(c["body"].as_str(), base),
                    c["score"].as_i64(),
                    Some(&c["created_at"]),
                )
            })
            .collect(),
    ))
}

/// Moebooru: `creator` is the name; there is no score.
fn from_moebooru(value: &Value, base: &str) -> Result<Vec<Value>> {
    Ok(sorted(
        items(value, "comments")?
            .iter()
            .filter_map(|c| {
                comment(
                    &c["id"],
                    c["creator"].as_str(),
                    post_text::dtext_to_markdown(c["body"].as_str(), base),
                    None,
                    Some(&c["created_at"]),
                )
            })
            .collect(),
    ))
}

/// Philomena: the body is already Markdown.
fn from_philomena(value: &Value) -> Result<Vec<Value>> {
    Ok(sorted(
        items(value, "comments")?
            .iter()
            .filter_map(|c| {
                let body = c["body"].as_str()?.trim();
                comment(
                    &c["id"],
                    c["author"].as_str(),
                    (!body.is_empty()).then(|| body.to_owned()),
                    None,
                    Some(&c["created_at"]),
                )
            })
            .collect(),
    ))
}

/// Gelbooru and Rule34: `comment` is a list, or one object when there is a single comment. Any
/// other kind of answer is a refusal: Rule34 sends a plain string when the key is missing.
fn from_gelbooru(value: &Value) -> Result<Vec<Value>> {
    let list: Vec<&Value> = match value {
        Value::Array(list) => list.iter().collect(),
        Value::Object(_) => match &value["comment"] {
            Value::Array(list) => list.iter().collect(),
            single @ Value::Object(_) => vec![single],
            _ => vec![],
        },
        _ => return Err(booru_http::remote(UNEXPECTED_LIST)),
    };
    Ok(sorted(
        list.into_iter()
            .filter_map(|c| {
                let body = c["body"].as_str()?.trim();
                comment(
                    &c["id"],
                    c["creator"].as_str(),
                    (!body.is_empty()).then(|| body.to_owned()),
                    None,
                    Some(&c["created_at"]),
                )
            })
            .collect(),
    ))
}

/// The documented comment API of these sites has no JSON option, so the answer can be XML: this
/// turns it into the shape `from_gelbooru` reads. A comment loses only an attribute it cannot read.
fn gelbooru_xml(xml: &str) -> Result<Value> {
    use quick_xml::{events::Event, Reader};
    let unexpected = || booru_http::remote(UNEXPECTED_LIST);
    let mut reader = Reader::from_str(xml);
    let mut list = Vec::new();
    let mut root = false;
    loop {
        match reader.read_event().map_err(|_| unexpected())? {
            Event::Start(e) | Event::Empty(e) => match e.name().as_ref() {
                "comments" => root = true,
                "comment" => {
                    let mut item = serde_json::Map::new();
                    for attribute in e.attributes().flatten() {
                        if let Ok(value) =
                            attribute.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        {
                            item.insert(attribute.key.as_ref().into(), json!(value));
                        }
                    }
                    list.push(Value::Object(item));
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    if root {
        Ok(json!({ "comment": list }))
    } else {
        Err(unexpected())
    }
}

pub(crate) async fn fetch(t: &Transport, site: &Site, remote_id: &str) -> Result<Vec<Value>> {
    let headers = booru_engines::headers(site, false)?;
    match site.engine.as_str() {
        "e621" | "danbooru" => {
            let mut url = booru_engines::endpoint(site, "/comments.json")?;
            url.query_pairs_mut()
                .append_pair("group_by", "comment")
                .append_pair("search[post_id]", remote_id)
                .append_pair("limit", MAX_COMMENTS);
            from_dtext_site(&t.json(url, headers).await?, &site.base)
        }
        "moebooru" => {
            let mut url = booru_engines::endpoint(site, "/comment.json")?;
            url.query_pairs_mut().append_pair("post_id", remote_id);
            from_moebooru(&t.json(url, headers).await?, &site.base)
        }
        "philomena" => {
            let mut url = booru_engines::endpoint(site, "/api/v1/json/search/comments")?;
            url.query_pairs_mut()
                .append_pair("q", &format!("image_id:{remote_id}"))
                .append_pair("per_page", MAX_COMMENTS);
            from_philomena(&t.json(url, headers).await?)
        }
        "gelbooru" => {
            let mut url = booru_engines::endpoint(site, "/index.php")?;
            url.query_pairs_mut()
                .append_pair("page", "dapi")
                .append_pair("s", "comment")
                .append_pair("q", "index")
                .append_pair("post_id", remote_id)
                .append_pair("json", "1");
            if let Some(key) = &site.key {
                url.query_pairs_mut().append_pair("api_key", key);
            }
            if let Some(username) = &site.username {
                url.query_pairs_mut().append_pair("user_id", username);
            }
            // These sites answer an empty body when there is nothing to list.
            let text = t.text(url, headers).await?;
            if text.trim().is_empty() {
                return Ok(vec![]);
            }
            if text.trim_start().starts_with('<') {
                return from_gelbooru(&gelbooru_xml(&text)?);
            }
            let value: Value =
                serde_json::from_str(&text).map_err(|_| booru_http::remote(UNEXPECTED_LIST))?;
            from_gelbooru(&value)
        }
        _ => Ok(vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e621_comments_keep_dtext_as_markdown_and_skip_hidden_ones() {
        let list = json!([
            {"id": 12, "created_at": "2026-09-28T13:48:14.132-04:00", "score": 3,
             "creator_name": "Obomna", "creator_id": 5, "is_hidden": false,
             "body": "[quote]\"fan\":/users/1 said:\nhi\n[/quote]\n\nsee [spoiler]this[/spoiler]"},
            {"id": 5, "created_at": "2026-09-27T10:00:00.000-04:00", "score": 0,
             "creator_name": "Early", "creator_id": 6, "is_hidden": false, "body": "[b]first[/b]"},
            {"id": 9, "creator_name": "Gone", "is_hidden": true, "body": "removed"}
        ]);
        let out = from_dtext_site(&list, "https://e621.net").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["author"], "Early");
        assert_eq!(out[0]["body"], "**first**");
        assert_eq!(out[1]["id"], "12");
        assert_eq!(out[1]["score"], 3);
        assert_eq!(
            out[1]["body"],
            "> [fan](https://e621.net/users/1) said:\n> hi\n\nsee ||this||"
        );
    }

    #[test]
    fn danbooru_names_come_from_creator_or_fall_back_to_the_id() {
        let list = json!([
            {"id": 2, "body": "named", "score": 1, "creator": {"name": "Alice"}, "created_at": "2026-01-01T00:00:00Z"},
            {"id": 3, "body": "unnamed", "score": 0, "creator_id": 77, "created_at": "2026-01-02T00:00:00Z"},
            {"id": 4, "body": "deleted", "is_deleted": true}
        ]);
        let out = from_dtext_site(&list, "https://danbooru.donmai.us").unwrap();
        let authors: Vec<_> = out.iter().map(|c| c["author"].as_str().unwrap()).collect();
        assert_eq!(authors, ["Alice", "User #77"]);
    }

    #[test]
    fn an_empty_or_wrapped_list_is_no_comments_and_a_wrong_shape_is_an_error() {
        assert!(from_dtext_site(&json!([]), "https://e621.net")
            .unwrap()
            .is_empty());
        assert!(
            from_dtext_site(&json!({"comments": []}), "https://e621.net")
                .unwrap()
                .is_empty()
        );
        assert!(from_dtext_site(&json!("oops"), "https://e621.net").is_err());
    }

    #[test]
    fn philomena_and_moebooru_and_gelbooru_shapes() {
        let philomena = json!({"total": 1, "comments": [
            {"id": 8, "author": "Anonymous #DAA1", "body": "1000 pots \r\n", "created_at": "2026-04-17T11:34:20Z"}]});
        let out = from_philomena(&philomena).unwrap();
        assert_eq!(out[0]["author"], "Anonymous #DAA1");
        assert_eq!(out[0]["body"], "1000 pots");

        let moebooru = json!([{"id": 4, "creator": "mo", "body": "[b]hi[/b]", "created_at": "2026-02-01T00:00:00Z"}]);
        assert_eq!(
            from_moebooru(&moebooru, "https://yande.re").unwrap()[0]["body"],
            "**hi**"
        );

        let one = json!({"comment": {"id": "7", "creator": "gel", "body": "ok", "created_at": "2026-03-01 10:00:00"}});
        assert_eq!(from_gelbooru(&one).unwrap()[0]["author"], "gel");
        assert!(from_gelbooru(&json!({"@attributes": {"count": 0}}))
            .unwrap()
            .is_empty());
        assert!(from_gelbooru(&json!([])).unwrap().is_empty());
        assert!(from_gelbooru(&json!("Missing authentication.")).is_err());
    }

    #[tokio::test]
    async fn rule34_comments_arrive_as_xml() {
        use axum::{response::IntoResponse, routing::any, Router};
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
            <comments type="array">
              <comment created_at="2026-03-02 10:00:00" post_id="1" body="second &amp; last" creator="bob" id="9" creator_id="2"/>
              <comment created_at="2026-03-01 10:00:00" post_id="1" body="first" creator="amy" id="7" creator_id="1"/>
            </comments>"#;
        let app = Router::new().fallback(any(move || async move {
            ([("content-type", "text/xml")], xml).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let site = Site {
            id: "rule34".into(),
            name: "Rule34".into(),
            engine: "gelbooru".into(),
            base,
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        };
        let transport = Transport {
            allow_loopback: true,
        };
        let out = fetch(&transport, &site, "1").await.unwrap();
        server.abort();
        let bodies: Vec<_> = out.iter().map(|c| c["body"].as_str().unwrap()).collect();
        assert_eq!(bodies, ["first", "second & last"]);
        assert_eq!(out[0]["author"], "amy");
    }

    #[test]
    fn an_xml_answer_without_comments_is_empty_and_any_other_page_is_an_error() {
        let empty = gelbooru_xml(r#"<comments type="array"></comments>"#).unwrap();
        assert!(from_gelbooru(&empty).unwrap().is_empty());
        assert!(gelbooru_xml("<html><title>Rule34.xxx CAPTCHA</title></html>").is_err());
    }

    #[test]
    fn only_engines_with_a_comment_api_are_supported() {
        assert!(supported("e621") && supported("philomena") && supported("gelbooru"));
        assert!(!supported("furaffinity") && !supported("sankaku") && !supported("shimmie"));
    }
}
