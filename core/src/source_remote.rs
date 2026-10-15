use crate::{
    booru_http::{self, Transport, MAX_API_BYTES},
    source_matches::{self, Match},
    Error, Result,
};
use reqwest::{
    multipart::{Form, Part},
    Url,
};

const SAUCENAO: &str = "https://saucenao.com/search.php";
const FLUFFLE: &str = "https://api.fluffle.xyz/exact-search-by-file";
pub(crate) const REQUEST_LIMIT: &str =
    "Image search has reached its request limit. Wait before trying again.";
pub(crate) const SAUCE_DAILY_LIMIT: &str =
    "SauceNAO's daily search limit is reached. Try again later.";
pub(crate) const SAUCE_SHORT_LIMIT: &str =
    "SauceNAO allows only a few searches every 30 seconds. Wait a moment, then try again.";

pub(crate) async fn search(
    transport: &Transport,
    provider: &str,
    key: Option<&str>,
    image: Vec<u8>,
) -> Result<Vec<Match>> {
    let address = match provider {
        "SAUCENAO" => SAUCENAO,
        "FLUFFLE" => FLUFFLE,
        _ => return Err(Error::Invalid("Choose SauceNAO or Fluffle.".into())),
    };
    upload(
        transport,
        transport.media_url(address)?,
        provider,
        key,
        image,
    )
    .await
}

pub(crate) async fn upload(
    transport: &Transport,
    address: Url,
    provider: &str,
    key: Option<&str>,
    image: Vec<u8>,
) -> Result<Vec<Match>> {
    if image.is_empty() || image.len() > 2 * 1024 * 1024 {
        return Err(Error::Invalid(
            "Image search needs a prepared image smaller than 2 MiB.".into(),
        ));
    }
    let part = Part::bytes(image)
        .file_name("image.png")
        .mime_str("image/png")
        .map_err(|_| Error::Storage("Cannot prepare the image upload.".into()))?;
    let form = match provider {
        "SAUCENAO" => {
            let key = key.filter(|s| !s.is_empty()).ok_or(Error::Unavailable(
                "Add your SauceNAO API key in Settings → File sources before searching.",
            ))?;
            Form::new()
                .part("file", part)
                .text("output_type", "2")
                .text("numres", "6")
                .text("db", "999")
                .text("dedupe", "2")
                .text("api_key", key.to_owned())
        }
        "FLUFFLE" => Form::new().part("File", part).text("Limit", "8"),
        _ => return Err(Error::Invalid("Choose SauceNAO or Fluffle.".into())),
    };
    // Upload once: repeating a timed-out request can consume the provider's daily quota twice.
    let response = transport
        .client(&address)
        .await?
        .post(address)
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|_| {
            booru_http::remote(
                "Image search could not be reached. Check your connection and try again.",
            )
        })?;
    if response.status().as_u16() == 429 && provider == "SAUCENAO" {
        // SauceNAO names the exhausted window in the message and sends no reset time.
        let body = read(response).await.unwrap_or_default();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        let message = value["header"]["message"].as_str().unwrap_or_default();
        return Err(booru_http::remote(if message.contains("Daily") {
            SAUCE_DAILY_LIMIT
        } else if message.contains("every 30 seconds") {
            SAUCE_SHORT_LIMIT
        } else {
            REQUEST_LIMIT
        }));
    }
    if !response.status().is_success() {
        return Err(booru_http::remote(match response.status().as_u16() {
            401 | 403 => {
                "Image search refused access. Check the API key in Settings → File sources."
            }
            429 => REQUEST_LIMIT,
            400 | 415 | 422 => "Image search could not read this image. Try another file.",
            _ => "Image search could not finish. Try again later.",
        }));
    }
    let bytes = read(response).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        booru_http::remote("Image search returned an unreadable answer. Try again later.")
    })?;
    if provider == "SAUCENAO" && value["header"]["status"].as_i64().is_some_and(|s| s < 0) {
        return Err(booru_http::remote(
            "SauceNAO could not search this image. Check your API key or try again later.",
        ));
    }
    source_matches::parse(provider, &value)
}

async fn read(mut response: reqwest::Response) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|n| n > MAX_API_BYTES as u64)
    {
        return Err(booru_http::remote("Image search returned too much data."));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| booru_http::remote("The image search answer was interrupted. Try again."))?
    {
        if bytes.len() + chunk.len() > MAX_API_BYTES {
            return Err(booru_http::remote("Image search returned too much data."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Multipart, routing::post, Json, Router};
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[tokio::test]
    async fn uploads_png_and_credentials_in_body_not_url() {
        let fields = Arc::new(Mutex::new(Vec::new()));
        let captured = fields.clone();
        let router = Router::new().route("/search", post(move |mut form: Multipart| {
            let fields=captured.clone();
            async move {
                while let Some(field)=form.next_field().await.unwrap() {
                    let name=field.name().unwrap().to_owned();
                    let filename=field.file_name().map(str::to_owned);
                    let content=field.bytes().await.unwrap();
                    fields.lock().await.push((name,filename,content.to_vec()));
                }
                Json(json!({"header":{"status":0},"results":[{"header":{"similarity":"96"},"data":{"e621_id":7}}]}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address =
            Url::parse(&format!("http://{}/search", listener.local_addr().unwrap())).unwrap();
        assert!(address.query().is_none());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let result = upload(
            &Transport {
                allow_loopback: true,
            },
            address,
            "SAUCENAO",
            Some("fake-key"),
            vec![1, 2, 3],
        )
        .await
        .unwrap();
        assert_eq!(result[0].url, "https://e621.net/posts/7");
        let fields = fields.lock().await;
        assert!(fields
            .iter()
            .any(|(name, _, value)| name == "api_key" && value == b"fake-key"));
        assert!(fields.iter().any(|(name, file, value)| name == "file"
            && file.as_deref() == Some("image.png")
            && value == &[1, 2, 3]));
        drop(fields);
        task.abort();
        let _ = task.await;
    }

    #[tokio::test]
    async fn missing_key_fails_before_network() {
        let error = search(&Transport::default(), "SAUCENAO", None, vec![1])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("API key"));
    }

    #[tokio::test]
    async fn names_the_exhausted_sauce_limit() {
        let router = Router::new().route(
            "/search",
            post(|body: String| async move {
                let message = if body.contains("daily") {
                    "Daily Search Limit Exceeded."
                } else if body.contains("short") {
                    "Search limit reached: only 4 searches every 30 seconds."
                } else {
                    "Too many failed search attempts."
                };
                (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"header":{"message":message}})),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address =
            Url::parse(&format!("http://{}/search", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let transport = Transport {
            allow_loopback: true,
        };
        for (image, expected) in [
            (b"daily".to_vec(), SAUCE_DAILY_LIMIT),
            (b"short".to_vec(), SAUCE_SHORT_LIMIT),
            (b"other".to_vec(), REQUEST_LIMIT),
        ] {
            let error = upload(
                &transport,
                address.clone(),
                "SAUCENAO",
                Some("fake-key"),
                image,
            )
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), expected);
        }
        task.abort();
        let _ = task.await;
    }
}
