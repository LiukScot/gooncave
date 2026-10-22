use crate::{booru_http, Error, Result};
use serde_json::{json, Value};

const MAX_RESULTS: usize = 32;

#[derive(Clone, Debug)]
pub(crate) struct Match {
    pub url: String,
    pub name: Option<String>,
    pub thumbnail: Option<String>,
    pub score: f64,
    pub distance: Option<f64>,
}

impl Match {
    pub fn json(&self) -> Value {
        json!({"sourceUrl":self.url,"sourceName":self.name,"thumbUrl":self.thumbnail,
            "score":self.score,"distance":self.distance})
    }

    /// Whether the match is safe to copy tags from. Fluffle also calls a match "exact" when it is
    /// far from the image, as it does for a dark screenshot with a line of text, so its distance
    /// has to be small too; a result saved without one counts as close.
    pub fn trusted(&self, provider: &str) -> bool {
        self.score.is_finite()
            && self.score <= 100.0
            && match provider {
                "FLUFFLE" => {
                    self.score >= 95.0 && self.distance.is_none_or(|d| d <= MAX_FLUFFLE_DISTANCE)
                }
                "SAUCENAO" => self.score >= 90.0,
                _ => false,
            }
    }
}

/// The farthest a Fluffle match can be and still be trusted. Matches of the same image sit at
/// 0.05 or less; the false ones that Fluffle still calls exact sit above 0.5.
const MAX_FLUFFLE_DISTANCE: f64 = 0.05;

fn malformed() -> Error {
    booru_http::remote("The image search service returned an unexpected answer. Try again later.")
}

fn text(value: &Value) -> Result<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.len() <= 8192 => Ok(Some(s.clone())),
        _ => Err(malformed()),
    }
}

fn link(value: &Value) -> Result<Option<String>> {
    let Some(raw) = text(value)? else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    booru_http::url(&raw).map_err(|_| malformed())?;
    Ok(Some(raw))
}

fn number(value: &Value) -> Result<f64> {
    let value = match value {
        Value::String(s) => s.parse::<f64>().map_err(|_| malformed())?,
        _ => value.as_f64().ok_or_else(malformed)?,
    };
    if !value.is_finite() {
        return Err(malformed());
    }
    Ok(value)
}

fn post_id(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        return Ok(None);
    }
    let id = value
        .as_u64()
        .map(|n| n.to_string())
        .or_else(|| value.as_str().map(str::to_owned))
        .filter(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|c| c.is_ascii_digit()))
        .ok_or_else(malformed)?;
    Ok(Some(id))
}

pub(crate) fn parse(provider: &str, value: &Value) -> Result<Vec<Match>> {
    let rows = value["results"]
        .as_array()
        .filter(|r| r.len() <= MAX_RESULTS)
        .ok_or_else(malformed)?;
    let mut matches = Vec::new();
    for row in rows {
        if !row.is_object() {
            return Err(malformed());
        }
        let found = match provider {
            "SAUCENAO" => {
                let header = &row["header"];
                let data = &row["data"];
                if !header.is_object() || !data.is_object() {
                    return Err(malformed());
                }
                let score = number(&header["similarity"])?;
                if !(0.0..=100.0).contains(&score) {
                    return Err(malformed());
                }
                let e621 = data
                    .get("e621_id")
                    .or_else(|| data.get("e621Id"))
                    .unwrap_or(&Value::Null);
                let danbooru = data
                    .get("danbooru_id")
                    .or_else(|| data.get("danbooruId"))
                    .unwrap_or(&Value::Null);
                let mut url = if let Some(id) = post_id(e621)? {
                    Some(format!("https://e621.net/posts/{id}"))
                } else if let Some(id) = post_id(danbooru)? {
                    Some(format!("https://danbooru.donmai.us/posts/{id}"))
                } else {
                    None
                };
                if let Some(urls) = data.get("ext_urls").filter(|v| !v.is_null()) {
                    let urls = urls
                        .as_array()
                        .filter(|v| v.len() <= MAX_RESULTS)
                        .ok_or_else(malformed)?;
                    for candidate in urls {
                        let candidate = link(candidate)?;
                        if url.is_none() {
                            url = candidate;
                        }
                    }
                }
                if url.is_none() {
                    if let Some(source) = text(&data["source"])?
                        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
                    {
                        url = link(&json!(source))?;
                    }
                }
                url.map(|url| -> Result<Match> {
                    Ok(Match {
                        url,
                        score,
                        distance: None,
                        name: text(&header["index_name"])?,
                        thumbnail: link(&header["thumbnail"])?,
                    })
                })
                .transpose()?
            }
            "FLUFFLE" => {
                let distance = number(&row["distance"])?;
                if !(0.0..=1.0).contains(&distance) {
                    return Err(malformed());
                }
                // Fluffle defines trust by match class; distance is only a relative ranking.
                let score = match row["match"].as_str() {
                    Some("exact") => 100.0,
                    Some("probable") => 90.0,
                    Some("unlikely") => 0.0,
                    _ => return Err(malformed()),
                };
                let url = link(&row["url"])?.ok_or_else(malformed)?;
                Some(Match {
                    url,
                    score,
                    distance: Some(distance),
                    name: text(&row["platform"])?,
                    thumbnail: link(&row["thumbnail"]["url"])?,
                })
            }
            _ => return Err(Error::Invalid("Choose SauceNAO or Fluffle.".into())),
        };
        if let Some(found) = found {
            matches.push(found);
        }
    }
    matches.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| {
            a.distance
                .unwrap_or(0.0)
                .total_cmp(&b.distance.unwrap_or(0.0))
        })
    });
    let mut seen = std::collections::HashSet::new();
    matches.retain(|found| seen.insert(found.url.clone()));
    Ok(matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fluffle_trusts_an_exact_match_only_when_it_is_close() {
        let result = parse(
            "FLUFFLE",
            &json!({"results":[
                {"url":"https://e621.net/posts/1","match":"probable","distance":0.001},
                {"url":"https://e621.net/posts/2","match":"exact","distance":0.97},
                {"url":"https://e621.net/posts/3","match":"exact","distance":0.01}
            ]}),
        )
        .unwrap();
        assert_eq!(result[0].url, "https://e621.net/posts/3");
        assert_eq!(result[1].url, "https://e621.net/posts/2");
        assert!(!result[1].trusted("FLUFFLE"));
        assert!(!result[2].trusted("FLUFFLE"));
        assert!(result[0].trusted("FLUFFLE"));
    }

    #[test]
    fn saucenao_prefers_post_identity_and_preserves_confidence() {
        let result = parse("SAUCENAO", &json!({"results":[
            {"header":{"similarity":"92.5","index_name":"e621"},"data":{"e621_id":12,"ext_urls":["https://example.com/image.png"]}},
            {"header":{"similarity":"80"},"data":{"danbooru_id":"42"}}
        ]})).unwrap();
        assert_eq!(result[0].url, "https://e621.net/posts/12");
        assert_eq!(result[0].score, 92.5);
        assert!(result[0].trusted("SAUCENAO"));
        assert!(!result[1].trusted("SAUCENAO"));
    }

    #[test]
    fn rejects_malformed_and_private_matches() {
        for row in [
            json!({"url":"https://e621.net/posts/1","match":"exact","distance":-1}),
            json!({"url":"http://127.0.0.1/private","match":"exact","distance":0}),
            json!({"url":"https://e621.net/posts/1","match":"unknown","distance":0}),
            json!({"url":"https://user:secret@e621.net/posts/1","match":"exact","distance":0}),
        ] {
            assert!(parse("FLUFFLE", &json!({"results":[row]})).is_err());
        }
        assert!(parse(
            "SAUCENAO",
            &json!({"results":[{"header":{"similarity":"NaN"},"data":{}}]})
        )
        .is_err());
        assert!(parse("FLUFFLE", &json!({})).is_err());
        assert!(parse("FLUFFLE", &json!({"results":[]})).unwrap().is_empty());
    }

    #[test]
    fn saucenao_accepts_legacy_id_spelling_and_skips_titles_without_a_link() {
        let result = parse(
            "SAUCENAO",
            &json!({"results":[
                {"header":{"similarity":"95"},"data":{"e621Id":"12"}},
                {"header":{"similarity":"99"},"data":{"source":"A title without a post link"}}
            ]}),
        )
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].url, "https://e621.net/posts/12");
    }
}
