use crate::{
    booru_http::{self, Transport},
    boorus::Site,
    Error, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, COOKIE, REFERER},
    Url,
};
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, Date, Month, OffsetDateTime};

#[derive(Clone)]
pub(crate) struct Search {
    pub tags: Vec<String>,
    pub sort: String,
    pub window: String,
    pub date: Date,
    pub page: usize,
    pub limit: usize,
}
impl Default for Search {
    fn default() -> Self {
        Self {
            tags: vec![],
            sort: "new".into(),
            window: "day".into(),
            date: OffsetDateTime::now_utc().date(),
            page: 1,
            limit: 40,
        }
    }
}
pub(crate) fn date(raw: &str) -> Result<Date> {
    let invalid = || Error::Invalid("Use a valid calendar date in YYYY-MM-DD format.".into());
    if raw.len() != 10
        || raw.as_bytes()[4] != b'-'
        || raw.as_bytes()[7] != b'-'
        || !raw
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return Err(invalid());
    }
    Date::from_calendar_date(
        raw[0..4]
            .parse::<i32>()
            .ok()
            .filter(|n| (1..9999).contains(n))
            .ok_or_else(invalid)?,
        Month::try_from(raw[5..7].parse::<u8>().map_err(|_| invalid())?).map_err(|_| invalid())?,
        raw[8..10].parse().map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())
}
pub(crate) fn period(s: &Search) -> Option<(Date, Date)> {
    if s.window == "all" {
        return None;
    }
    let d = s.date;
    let (start, end) = match s.window.as_str() {
        "week" => {
            let start = d - time::Duration::days(d.weekday().number_days_from_monday().into());
            (start, start + time::Duration::days(6))
        }
        "month" => {
            let start = Date::from_calendar_date(d.year(), d.month(), 1).unwrap();
            let next = if d.month() == Month::December {
                Date::from_calendar_date(d.year() + 1, Month::January, 1).unwrap()
            } else {
                Date::from_calendar_date(d.year(), d.month().next(), 1).unwrap()
            };
            (start, next - time::Duration::days(1))
        }
        "year" => (
            Date::from_calendar_date(d.year(), Month::January, 1).unwrap(),
            Date::from_calendar_date(d.year(), Month::December, 31).unwrap(),
        ),
        _ => (d, d),
    };
    Some((start, end))
}
fn date_tag(start: Date, end: Date) -> String {
    if start == end {
        format!("date:{start}")
    } else {
        format!("date:{start}..{end}")
    }
}
pub(crate) fn endpoint(site: &Site, path: &str) -> Result<Url> {
    Url::parse(&format!("{}{}", site.base.trim_end_matches('/'), path))
        .map_err(|_| booru_http::remote("The site has an invalid API address."))
}
pub(crate) fn headers(site: &Site, media: bool) -> Result<HeaderMap> {
    let mut h = HeaderMap::new();
    let mut put = |key: reqwest::header::HeaderName, value: String| -> Result<()> {
        h.insert(
            key,
            HeaderValue::from_str(&value).map_err(|_| {
                Error::Invalid(
                    "The saved credentials contain invalid characters. Update Accounts.".into(),
                )
            })?,
        );
        Ok(())
    };
    if media {
        put(REFERER, format!("{}/", website(site).trim_end_matches('/')))?;
        return Ok(h);
    }
    match site.engine.as_str() {
        "e621" | "danbooru" | "szurubooru" => {
            if let (Some(username), Some(key)) = (&site.username, &site.key) {
                put(
                    AUTHORIZATION,
                    format!(
                        "{} {}",
                        if site.engine == "szurubooru" {
                            "Token"
                        } else {
                            "Basic"
                        },
                        STANDARD.encode(format!("{username}:{key}"))
                    ),
                )?;
            }
        }
        "sankaku" => {
            if let Some(key) = &site.key {
                put(AUTHORIZATION, format!("Bearer {key}"))?;
            }
        }
        "philomena" => {
            if let Some(key) = &site.key {
                put(
                    reqwest::header::HeaderName::from_static("x-philomena-api-key"),
                    key.clone(),
                )?;
            }
        }
        "furaffinity" => {
            if let Some(cookie) = &site.cookie {
                put(COOKIE, cookie.clone())?;
            }
        }
        _ => {}
    }
    Ok(h)
}
pub(crate) fn web_headers(site: &Site) -> Result<HeaderMap> {
    let mut h = headers(site, false)?;
    if let Some(cookie) = &site.cookie {
        h.insert(
            COOKIE,
            HeaderValue::from_str(cookie).map_err(|_| {
                Error::Invalid("Update the saved session cookie in Accounts.".into())
            })?,
        );
    }
    Ok(h)
}
pub(crate) fn website(site: &Site) -> String {
    if site.engine == "gelbooru"
        && Url::parse(&site.base).is_ok_and(|u| u.host_str() == Some("api.rule34.xxx"))
    {
        "https://rule34.xxx".into()
    } else {
        site.base.clone()
    }
}
pub(crate) fn post_url(site: &Site, id: &str) -> Result<String> {
    let path = match site.engine.as_str() {
        "e621" | "danbooru" => format!("/posts/{id}"),
        "gelbooru" => format!("/index.php?page=post&s=view&id={id}"),
        "moebooru" | "sankaku" => format!("/post/show/{id}"),
        "philomena" => format!("/images/{id}"),
        "shimmie" => format!("/post/view/{id}"),
        "szurubooru" => format!("/post/{id}"),
        _ => format!("/view/{id}/"),
    };
    Ok(format!("{}{}", website(site).trim_end_matches('/'), path))
}
pub(crate) fn id(v: &Value) -> Result<String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) if n.as_u64().is_some() => n.to_string(),
        _ => {
            return Err(booru_http::remote(
                "The site returned a post with an invalid ID.",
            ))
        }
    };
    if s.is_empty()
        || s.len() > 50
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(booru_http::remote(
            "The site returned a post with an invalid ID.",
        ));
    }
    Ok(s)
}
fn number(v: &Value) -> Value {
    let n = v
        .as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()));
    n.filter(|n| n.is_finite())
        .map_or(Value::Null, |n| json!(n))
}
fn boolean(v: &Value) -> bool {
    v.as_bool().unwrap_or_else(|| {
        v.as_i64().is_some_and(|n| n != 0) || v.as_str().is_some_and(|s| s == "true" || s == "1")
    })
}
fn parent(v: &Value) -> Result<Value> {
    if v.is_null() || v == 0 || v == "0" || v == "" {
        Ok(Value::Null)
    } else {
        Ok(json!(id(v)?))
    }
}
fn timestamp(v: &Value) -> Value {
    if let Some(s) = v.as_str() {
        if let Ok(date) = OffsetDateTime::parse(s, &Rfc3339)
            .or_else(|_| OffsetDateTime::parse(s, &time::format_description::well_known::Rfc2822))
        {
            return date.format(&Rfc3339).map_or(Value::Null, |s| json!(s));
        }
    }
    let seconds = v
        .as_i64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .or_else(|| v["s"].as_i64());
    seconds
        .and_then(|s| OffsetDateTime::from_unix_timestamp(s).ok())
        .and_then(|d| d.format(&Rfc3339).ok())
        .map_or(Value::Null, |s| json!(s))
}
fn media(site: &Site, v: &Value) -> Result<Value> {
    let Some(s) = v.as_str().filter(|s| !s.is_empty()) else {
        if !v.is_null() && !v.is_string() {
            return Err(booru_http::remote(
                "The site returned an invalid media address.",
            ));
        }
        return Ok(Value::Null);
    };
    let base = Url::parse(&format!("{}/", site.base.trim_end_matches('/')))
        .map_err(|_| booru_http::remote("Invalid site address."))?;
    let url = base
        .join(s)
        .map_err(|_| booru_http::remote("The site returned an invalid media address."))?;
    booru_http::url(url.as_str())
        .map_err(|_| booru_http::remote("The site returned an unsafe media address."))?;
    if site.engine == "furaffinity"
        && !url
            .host_str()
            .is_some_and(|h| h == "furaffinity.net" || h.ends_with(".furaffinity.net"))
    {
        return Err(booru_http::remote(
            "FurAffinity returned a media address outside its domains.",
        ));
    }
    Ok(json!(url.as_str()))
}
fn fallback<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if a.is_null() || a == "" {
        b
    } else {
        a
    }
}
fn extension(url: &Value) -> Value {
    url.as_str()
        .and_then(|s| Url::parse(s).ok())
        .and_then(|u| {
            u.path()
                .rsplit('.')
                .next()
                .filter(|s| s.len() <= 10 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
                .map(str::to_lowercase)
        })
        .map_or(Value::Null, |s| json!(s))
}
fn tag(tag: &str, category: &str) -> Value {
    json!({"tag":crate::tags::normalize(tag),"category":category})
}
fn string_tags(v: &Value, category: &str) -> Result<Vec<Value>> {
    match v {
        Value::Null => Ok(vec![]),
        Value::String(s) => Ok(s
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| tag(s, category))
            .collect()),
        Value::Array(a) => a
            .iter()
            .map(|s| {
                s.as_str()
                    .map(|s| tag(s, category))
                    .ok_or_else(|| booru_http::remote("The site returned malformed tags."))
            })
            .collect(),
        _ => Err(booru_http::remote("The site returned malformed tags.")),
    }
}
fn tags(engine: &str, p: &Value) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    match engine {
        "e621" => {
            let Some(groups) = p["tags"].as_object() else {
                if p["tags"].is_null() {
                    return Ok(result);
                }
                return Err(booru_http::remote(
                    "The site returned malformed tag groups.",
                ));
            };
            for (category, v) in groups {
                result.extend(string_tags(v, category)?);
            }
        }
        "danbooru" => {
            for c in ["general", "artist", "character", "copyright", "meta"] {
                result.extend(string_tags(&p[format!("tag_string_{c}")], c)?);
            }
        }
        "sankaku" if p["tags"].is_array() => {
            for entry in p["tags"].as_array().unwrap() {
                let name = entry["name"]
                    .as_str()
                    .ok_or_else(|| booru_http::remote("The site returned malformed tags."))?;
                let c = entry["type"]
                    .as_str()
                    .unwrap_or(match entry["type"].as_u64() {
                        Some(1) => "artist",
                        Some(3) => "copyright",
                        Some(4) => "character",
                        Some(5) => "meta",
                        _ => "general",
                    });
                result.push(tag(name, c));
            }
        }
        "szurubooru" => {
            if let Some(entries) = p["tags"].as_array() {
                for entry in entries {
                    result.extend(string_tags(
                        &entry["names"],
                        entry["category"].as_str().unwrap_or("general"),
                    )?);
                }
            }
        }
        _ => result.extend(string_tags(&p["tags"], "general")?),
    }
    Ok(result)
}
pub(crate) fn normalize(site: &Site, p: &Value) -> Result<Value> {
    if !p.is_object() {
        return Err(booru_http::remote("The site returned a malformed post."));
    }
    let remote_id = id(&p["id"])?;
    let e = site.engine.as_str();
    let (
        preview,
        sample,
        file,
        width,
        height,
        score,
        md5,
        created,
        uploader,
        favs,
        size,
        ext,
        par,
        children,
        pools,
    ) = match e {
        "e621" => (
            &p["preview"]["url"],
            &p["sample"]["url"],
            &p["file"]["url"],
            &p["file"]["width"],
            &p["file"]["height"],
            &p["score"]["total"],
            &p["file"]["md5"],
            &p["created_at"],
            &p["uploader_name"],
            &p["fav_count"],
            &p["file"]["size"],
            &p["file"]["ext"],
            &p["relationships"]["parent_id"],
            &p["relationships"]["has_children"],
            &p["pools"],
        ),
        "danbooru" => (
            &p["preview_file_url"],
            &p["large_file_url"],
            fallback(&p["file_url"], &p["large_file_url"]),
            &p["image_width"],
            &p["image_height"],
            &p["score"],
            &p["md5"],
            &p["created_at"],
            &p["uploader_name"],
            &p["fav_count"],
            &p["file_size"],
            &p["file_ext"],
            &p["parent_id"],
            &p["has_children"],
            &Value::Null,
        ),
        "philomena" => (
            fallback(
                &p["representations"]["medium"],
                &p["representations"]["thumb"],
            ),
            fallback(
                &p["representations"]["large"],
                &p["representations"]["medium"],
            ),
            fallback(&p["view_url"], &p["representations"]["full"]),
            &p["width"],
            &p["height"],
            &p["score"],
            &Value::Null,
            &p["created_at"],
            &p["uploader"],
            &p["faves"],
            &p["size"],
            &p["format"],
            &Value::Null,
            &Value::Null,
            &Value::Null,
        ),
        "szurubooru" => (
            &p["thumbnailUrl"],
            &p["contentUrl"],
            &p["contentUrl"],
            &p["canvasWidth"],
            &p["canvasHeight"],
            &p["score"],
            &p["checksumMD5"],
            &p["creationTime"],
            &p["user"]["name"],
            &p["favoriteCount"],
            &p["fileSize"],
            &Value::Null,
            &Value::Null,
            &Value::Null,
            &Value::Null,
        ),
        "sankaku" => (
            &p["preview_url"],
            &p["sample_url"],
            fallback(&p["file_url"], &p["sample_url"]),
            &p["width"],
            &p["height"],
            &p["total_score"],
            &p["md5"],
            &p["created_at"],
            &p["author"]["name"],
            &p["fav_count"],
            &p["file_size"],
            &Value::Null,
            &p["parent_id"],
            &p["has_children"],
            &Value::Null,
        ),
        _ => (
            &p["preview_url"],
            fallback(&p["sample_url"], &p["jpeg_url"]),
            fallback(&p["file_url"], fallback(&p["jpeg_url"], &p["sample_url"])),
            &p["width"],
            &p["height"],
            &p["score"],
            fallback(&p["md5"], &p["hash"]),
            fallback(&p["created_at"], fallback(&p["date"], &p["change"])),
            fallback(&p["author"], &p["owner"]),
            &p["fav_count"],
            &p["file_size"],
            &Value::Null,
            &p["parent_id"],
            &p["has_children"],
            &Value::Null,
        ),
    };
    let file = media(site, file)?;
    let mut preview = media(site, preview)?;
    if e == "gelbooru"
        && website(site) == "https://rule34.xxx"
        && matches!(
            extension(sample).as_str(),
            Some("jpg" | "jpeg" | "png" | "webp" | "avif" | "gif")
        )
    {
        preview = media(site, sample)?;
    }
    let pools = if let Some(pools) = pools.as_array() {
        json!(pools.iter().map(id).collect::<Result<Vec<_>>>()?)
    } else if matches!(e, "shimmie" | "philomena" | "szurubooru") {
        json!([])
    } else {
        Value::Null
    };
    let mut sources = Vec::new();
    if let Some(entries) = p["sources"].as_array() {
        for source in entries {
            let value = source
                .as_str()
                .ok_or_else(|| booru_http::remote("The site returned malformed source links."))?;
            if let Ok(url) = booru_http::url(value) {
                sources.push(json!(url.as_str()));
            }
        }
    }
    Ok(
        json!({"remoteId":remote_id,"previewUrl":preview,"sampleUrl":media(site,sample)?,"fileUrl":file,"width":number(width),"height":number(height),"score":number(score),
 "rating":if e=="philomena"{Value::Null}else{fallback(&p["rating"],&p["safety"]).clone()},"md5":md5,"createdAt":timestamp(created),"uploader":uploader,"tags":tags(e,p)?,"sourceUrls":sources,
 "favCount":number(favs),"fileSize":number(size),"fileExt":if ext.is_null(){extension(&file)}else{ext.clone()},"parentId":parent(par)?,"hasChildren":boolean(children),"poolIds":pools,
 "favorited":p["is_favorited"].as_bool(),"voted":p["vote"].as_i64().filter(|v|(-1..=1).contains(v))}),
    )
}
fn entries<'a>(site: &Site, v: &'a Value) -> Result<Vec<&'a Value>> {
    let e = site.engine.as_str();
    let value = match e {
        "e621" => &v["posts"],
        "philomena" => &v["images"],
        "szurubooru" => &v["results"],
        "gelbooru" if v.get("post").is_some() => &v["post"],
        _ => v,
    };
    if let Some(a) = value.as_array() {
        if a.len() > 100 {
            return Err(booru_http::remote(
                "The site returned more posts than requested.",
            ));
        }
        return Ok(a.iter().collect());
    }
    if value.is_object() && value.get("id").is_some() {
        return Ok(vec![value]);
    }
    if e == "gelbooru" && v.is_object() && v.get("@attributes").is_some() && v.get("post").is_none()
    {
        return Ok(vec![]);
    }
    Err(booru_http::remote(
        "The site returned an unexpected post list. Check its engine in Accounts.",
    ))
}
const ID_RATE_SAMPLE_SPAN: i64 = 20_000;
fn gel_auth(site: &Site, url: &mut Url) {
    url.query_pairs_mut()
        .append_pair("page", "dapi")
        .append_pair("s", "post")
        .append_pair("q", "index")
        .append_pair("json", "1");
    if let Some(key) = &site.key {
        url.query_pairs_mut().append_pair("api_key", key);
    }
    if let Some(username) = &site.username {
        url.query_pairs_mut().append_pair("user_id", username);
    }
}
async fn gel_window(t: &Transport, site: &Site, s: &Search) -> Result<Vec<String>> {
    let period = if s.sort == "hot" {
        let today = OffsetDateTime::now_utc().date();
        Some((today - time::Duration::days(1), today))
    } else {
        period(s)
    };
    let Some((start, end)) = period else {
        return Ok(vec![]);
    };
    let mut url = endpoint(site, "/index.php")?;
    gel_auth(site, &mut url);
    url.query_pairs_mut().append_pair("limit", "1");
    let newest = t.json(url.clone(), headers(site, false)?).await?;
    let newest = entries(site, &newest)?.first().copied().ok_or_else(|| {
        booru_http::remote("The site's upload rate could not be measured for this period.")
    })?;
    let newest_id = newest["id"]
        .as_i64()
        .or_else(|| newest["id"].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| booru_http::remote("The site's upload rate could not be measured."))?;
    let newest_at = newest["change"]
        .as_i64()
        .or_else(|| newest["change"].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| {
            booru_http::remote(
                "The site did not report upload times. Choose New or an all-time search.",
            )
        })?;
    url.query_pairs_mut()
        .append_pair("tags", &format!("id:<{}", newest_id - ID_RATE_SAMPLE_SPAN));
    let older = t.json(url, headers(site, false)?).await?;
    let older = entries(site, &older)?.first().copied().ok_or_else(|| {
        booru_http::remote("The site's upload rate could not be measured for this period.")
    })?;
    let older_id = older["id"]
        .as_i64()
        .or_else(|| older["id"].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| booru_http::remote("Invalid upload rate sample."))?;
    let older_at = older["change"]
        .as_i64()
        .or_else(|| older["change"].as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| booru_http::remote("Invalid upload rate sample."))?;
    if newest_id <= older_id || newest_at <= older_at {
        return Err(booru_http::remote(
            "The site's upload times cannot describe this period. Choose New or all time.",
        ));
    }
    let rate = (newest_id - older_id) as f64 / (newest_at - older_at) as f64;
    let estimate = |time: i64| {
        ((newest_id as f64) - (newest_at - time) as f64 * rate)
            .round()
            .max(0.) as i64
    };
    let mut tags = vec![format!(
        "id:>{}",
        estimate(
            start
                .with_hms(0, 0, 0)
                .unwrap()
                .assume_utc()
                .unix_timestamp()
        )
    )];
    let ceiling = (end + time::Duration::days(1))
        .with_hms(0, 0, 0)
        .unwrap()
        .assume_utc()
        .unix_timestamp();
    if ceiling < OffsetDateTime::now_utc().unix_timestamp() {
        tags.push(format!("id:<{}", estimate(ceiling)));
    }
    Ok(tags)
}
pub(crate) async fn search(t: &Transport, site: &Site, s: &Search) -> Result<Vec<Value>> {
    if matches!(site.engine.as_str(), "shimmie" | "furaffinity") && s.sort != "new" {
        return Err(booru_http::remote(
            "This site supports only New in Explore.",
        ));
    }
    if site.engine == "furaffinity" {
        if !s.tags.is_empty() {
            return Err(booru_http::remote(
                "FurAffinity does not support tag search in Explore.",
            ));
        }
        let path = if s.page == 1 {
            "/browse/".into()
        } else {
            format!("/browse/{}/", s.page)
        };
        let html = t
            .text(endpoint(site, &path)?, headers(site, false)?)
            .await?;
        return super::explore::fa_listing(site, &html);
    }
    let mut tags = s.tags.clone();
    let period = period(s);
    if s.sort == "hot" {
        match site.engine.as_str() {
            "e621" | "danbooru" => tags.push("order:rank".into()),
            "sankaku" => tags.push("order:popular".into()),
            "moebooru" | "szurubooru" => {
                tags.push(
                    if site.engine == "moebooru" {
                        "order:score"
                    } else {
                        "sort:score"
                    }
                    .into(),
                );
                let today = OffsetDateTime::now_utc().date();
                tags.push(if site.engine == "moebooru" {
                    date_tag(today - time::Duration::days(1), today)
                } else {
                    format!("creation-time:{}..{today}", today - time::Duration::days(1))
                });
            }
            "gelbooru" => {
                tags.push("sort:score".into());
                tags.extend(gel_window(t, site, s).await?);
            }
            _ => {}
        }
    }
    if s.sort == "popular" {
        match site.engine.as_str() {
            "e621" | "danbooru" | "moebooru" | "sankaku" => {
                tags.push(
                    if site.engine == "sankaku" {
                        "order:popular"
                    } else {
                        "order:score"
                    }
                    .into(),
                );
                if let Some((a, b)) = period {
                    tags.push(date_tag(a, b));
                }
            }
            "szurubooru" => {
                tags.push("sort:score".into());
                if let Some((a, b)) = period {
                    tags.push(format!("creation-time:{a}..{b}"));
                }
            }
            "gelbooru" => {
                tags.push("sort:score".into());
                tags.extend(gel_window(t, site, s).await?);
            }
            _ => {}
        }
    }
    let path = match site.engine.as_str() {
        "e621" | "danbooru" => "/posts.json",
        "moebooru" => "/post.json",
        "gelbooru" => "/index.php",
        "sankaku" => "/posts",
        "philomena" => "/api/v1/json/search/images",
        "szurubooru" => "/api/posts/",
        "shimmie" => "/api/danbooru/find_posts/index.xml",
        _ => return Err(booru_http::remote("Unknown engine.")),
    };
    let mut url = endpoint(site, path)?;
    if site.engine == "philomena" {
        let q = if s.tags.is_empty() {
            "*".into()
        } else {
            s.tags.join(" AND ")
        };
        let q = if s.sort == "popular" {
            period.map_or(q.clone(), |(a, b)| {
                format!("({q}) AND created_at.gte:{a} AND created_at.lte:{b}")
            })
        } else {
            q
        };
        url.query_pairs_mut()
            .append_pair("q", &q)
            .append_pair("sd", "desc")
            .append_pair(
                "sf",
                match s.sort.as_str() {
                    "hot" => "wilson_score",
                    "popular" => "score",
                    _ => "created_at",
                },
            )
            .append_pair("per_page", &s.limit.to_string())
            .append_pair("page", &s.page.to_string());
    } else if site.engine == "szurubooru" {
        url.query_pairs_mut()
            .append_pair("query", &tags.join(" "))
            .append_pair("offset", &((s.page - 1) * s.limit).to_string())
            .append_pair("limit", &s.limit.to_string());
    } else {
        if site.engine == "gelbooru" {
            gel_auth(site, &mut url);
        }
        url.query_pairs_mut()
            .append_pair("tags", &tags.join(" "))
            .append_pair("limit", &s.limit.to_string())
            .append_pair(
                if site.engine == "gelbooru" {
                    "pid"
                } else {
                    "page"
                },
                &if site.engine == "gelbooru" {
                    (s.page - 1).to_string()
                } else {
                    s.page.to_string()
                },
            );
    }
    if site.engine == "shimmie" {
        let xml = t.text(url, headers(site, false)?).await?;
        return shimmie(site, &xml);
    }
    let v = t.json(url, headers(site, false)?).await?;
    entries(site, &v)?
        .into_iter()
        .map(|p| normalize(site, p))
        .collect()
}
fn shimmie(site: &Site, xml: &str) -> Result<Vec<Value>> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    let mut posts = Vec::new();
    let mut root = false;
    loop {
        match reader
            .read_event()
            .map_err(|_| booru_http::remote("Shimmie returned malformed XML."))?
        {
            Event::Start(e) | Event::Empty(e) => {
                if e.name().as_ref() == "posts" {
                    root = true;
                }
                if e.name().as_ref() == "post" {
                    let mut p = serde_json::Map::new();
                    for a in e.attributes() {
                        let a = a.map_err(|_| {
                            booru_http::remote("Shimmie returned malformed attributes.")
                        })?;
                        let key = a.key.as_ref();
                        let value = a
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .map_err(|_| booru_http::remote("Invalid Shimmie attribute."))?;
                        p.insert(key.into(), json!(value));
                    }
                    posts.push(normalize(site, &Value::Object(p))?);
                    if posts.len() > 100 {
                        return Err(booru_http::remote("Shimmie returned too many posts."));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root {
        return Err(booru_http::remote("Shimmie returned an unexpected page."));
    }
    Ok(posts)
}
pub(crate) async fn single(t: &Transport, site: &Site, remote_id: &str) -> Result<Option<Value>> {
    let safe = id(&json!(remote_id))?;
    if site.engine == "furaffinity" {
        let html = t
            .text(
                endpoint(site, &format!("/view/{safe}/"))?,
                headers(site, false)?,
            )
            .await?;
        return super::explore::fa_submission(site, &safe, &html).map(Some);
    }
    if site.engine == "philomena" || site.engine == "szurubooru" {
        let path = if site.engine == "philomena" {
            format!("/api/v1/json/images/{safe}")
        } else {
            format!("/api/post/{safe}")
        };
        let p = t
            .json(endpoint(site, &path)?, headers(site, false)?)
            .await?;
        return normalize(
            site,
            if site.engine == "philomena" {
                &p["image"]
            } else {
                &p
            },
        )
        .map(Some);
    }
    let s = Search {
        tags: vec![format!("id:{safe}")],
        limit: 1,
        ..Default::default()
    };
    Ok(search(t, site, &s)
        .await?
        .into_iter()
        .find(|p| p["remoteId"] == safe))
}
pub(crate) async fn by_ids(t: &Transport, site: &Site, ids: &[String]) -> Result<Vec<Value>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    if !matches!(site.engine.as_str(), "e621" | "danbooru") {
        return Err(booru_http::remote("This site does not support pool pages."));
    }
    let s = Search {
        tags: vec![format!("id:{}", ids.join(","))],
        limit: ids.len(),
        ..Default::default()
    };
    let posts = search(t, site, &s).await?;
    Ok(ids
        .iter()
        .filter_map(|id| posts.iter().find(|p| p["remoteId"] == *id).cloned())
        .collect())
}
pub(crate) async fn probe(t: &Transport, site: &Site) -> Result<bool> {
    let result = search(
        t,
        site,
        &Search {
            limit: 1,
            ..Default::default()
        },
    )
    .await?;
    // Engine-specific fields prevent the shared Danbooru route from detecting e621 as Danbooru.
    if let Some(p) = result.first() {
        return Ok(match site.engine.as_str() {
            "danbooru" => p["tags"].as_array().is_some_and(|a| !a.is_empty()),
            "e621" => p["poolIds"].is_array(),
            _ => true,
        });
    }
    Ok(false)
}

fn authenticated_page(engine: &str, html: &str) -> bool {
    let document = scraper::Html::parse_document(html);
    let anchors = scraper::Selector::parse("a[href]").unwrap();
    document.select(&anchors).any(|anchor| {
        let href = anchor.value().attr("href").unwrap();
        if engine == "furaffinity" {
            href.starts_with("/fav/") || href.starts_with("/unfav/")
        } else {
            Url::parse("https://example.org/")
                .unwrap()
                .join(href)
                .is_ok_and(|url| {
                    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
                    query.get("s").is_some_and(|s| s == "login")
                        && query.get("code").is_some_and(|code| code == "01")
                })
        }
    })
}

pub(crate) async fn check_cookie(t: &Transport, site: &Site, posts: &[Value]) -> Result<()> {
    let target = if site.engine == "furaffinity" {
        let id = posts
            .first()
            .and_then(|p| p["remoteId"].as_str())
            .ok_or_else(|| {
                booru_http::remote("The site returned no post to check the session. Try again.")
            })?;
        endpoint(site, &format!("/view/{id}/"))?
    } else {
        let mut url = Url::parse(&website(site))
            .map_err(|_| Error::Invalid("Check the site address in Accounts.".into()))?
            .join("index.php")
            .map_err(|_| Error::Invalid("Check the site address in Accounts.".into()))?;
        url.query_pairs_mut()
            .append_pair("page", "account")
            .append_pair("s", "home");
        url
    };
    let html = t.text(target, web_headers(site)?).await?;
    if authenticated_page(&site.engine, &html) {
        Ok(())
    } else {
        Err(booru_http::remote(
            "The session cookie is expired or incomplete. Save a fresh cookie in Accounts.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Request, response::IntoResponse, routing::any, Router};
    use std::sync::{Arc, Mutex};
    #[test]
    fn cookie_checks_require_authenticated_actions() {
        assert!(authenticated_page(
            "gelbooru",
            "<a href='index.php?page=account&amp;s=login&amp;code=01'>Log out</a>"
        ));
        assert!(!authenticated_page(
            "gelbooru",
            "<a href='index.php?page=account&amp;s=login'>Log in</a>"
        ));
        assert!(authenticated_page(
            "furaffinity",
            "<a href='/fav/7/?key=fake'>Favorite</a>"
        ));
        assert!(authenticated_page(
            "furaffinity",
            "<a href='/unfav/7/?key=fake'>Unfavorite</a>"
        ));
        assert!(!authenticated_page(
            "furaffinity",
            "<a href='/login/'>Log in</a>"
        ));
    }
    struct Fixture {
        base: String,
        requests: Arc<Mutex<Vec<(String, HeaderMap)>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn fixture(body: String, content_type: &'static str) -> Fixture {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let body = body.clone();
            let log = log.clone();
            async move {
                log.lock()
                    .unwrap()
                    .push((request.uri().to_string(), request.headers().clone()));
                ([(reqwest::header::CONTENT_TYPE, content_type)], body).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Fixture {
            base,
            requests,
            task,
        }
    }
    fn site(engine: &str, base: &str) -> Site {
        Site {
            id: "test-site".into(),
            name: "Test site".into(),
            engine: engine.into(),
            base: base.into(),
            username: Some("fake-user".into()),
            key: Some("fake-key".into()),
            cookie: Some("a=fake-session".into()),
            enabled: true,
            public: Value::Null,
        }
    }
    #[test]
    fn calendar_periods_use_inclusive_monday_weeks_and_leap_years() {
        for (window, anchor, start, end) in [
            ("day", "2026-10-13", "2026-10-13", "2026-10-13"),
            ("week", "2026-10-13", "2026-10-12", "2026-10-18"),
            ("month", "2024-02-29", "2024-02-01", "2024-02-29"),
            ("year", "2026-10-13", "2026-01-01", "2026-12-31"),
        ] {
            let s = Search {
                window: window.into(),
                date: date(anchor).unwrap(),
                ..Default::default()
            };
            assert_eq!(period(&s), Some((date(start).unwrap(), date(end).unwrap())));
        }
        assert_eq!(
            date_tag(date("2026-10-13").unwrap(), date("2026-10-13").unwrap()),
            "date:2026-10-13"
        );
        for raw in [
            "2026-02-30",
            "9999-12-31",
            "0000-01-01",
            "2026-1-01",
            "ééééé",
        ] {
            assert!(date(raw).is_err(), "{raw}");
        }
    }
    #[tokio::test]
    async fn detection_does_not_guess_an_engine_from_an_empty_shared_response() {
        let f = fixture("[]".into(), "application/json").await;
        assert!(!probe(
            &Transport {
                allow_loopback: true
            },
            &site("danbooru", &f.base)
        )
        .await
        .unwrap());
    }
    #[tokio::test]
    async fn cookie_check_reads_account_pages_with_the_saved_cookie() {
        let transport = Transport {
            allow_loopback: true,
        };
        for (engine, html, path) in [
            (
                "gelbooru",
                "<a href='index.php?s=login&amp;code=01'>Log out</a>",
                "/index.php?page=account&s=home",
            ),
            ("furaffinity", "<a href='/fav/7/'>Favorite</a>", "/view/7/"),
        ] {
            let f = fixture(html.into(), "text/html").await;
            let site = site(engine, &f.base);
            check_cookie(&transport, &site, &[json!({"remoteId":"7"})])
                .await
                .unwrap();
            let requests = f.requests.lock().unwrap();
            assert_eq!(requests[0].0, path);
            assert_eq!(requests[0].1.get(COOKIE).unwrap(), "a=fake-session");
        }
    }
    #[tokio::test]
    async fn all_nine_engines_search_and_preserve_ids_media_and_tag_categories() {
        let cases=[
   ("e621",json!({"posts":[{"id":7,"file":{"url":"https://cdn.example.com/file.webm","width":640,"height":480,"ext":"webm"},"preview":{"url":"https://cdn.example.com/thumb.jpg"},"sample":{"url":"https://cdn.example.com/sample.jpg"},"score":{"total":22},"tags":{"artist":["test_artist"],"species":["canine"]},"pools":[3],"relationships":{"parent_id":4,"has_children":true},"is_favorited":true,"vote":-1}]}).to_string(),"application/json","/posts.json",Some("Basic ZmFrZS11c2VyOmZha2Uta2V5")),
   ("danbooru",json!([{"id":7,"file_url":"https://cdn.example.com/file.png","preview_file_url":"https://cdn.example.com/thumb.jpg","tag_string_general":"plain","tag_string_artist":"test_artist","parent_id":4}]).to_string(),"application/json","/posts.json",Some("Basic ZmFrZS11c2VyOmZha2Uta2V5")),
   ("moebooru",json!([{"id":7,"file_url":"https://cdn.example.com/file.jpg","tags":"plain"}]).to_string(),"application/json","/post.json",None),
   ("gelbooru",json!({"post":[{"id":"7","file_url":"https://cdn.example.com/file.gif","tags":"plain"}]}).to_string(),"application/json","/index.php",None),
   ("sankaku",json!([{"id":"abc-7","file_url":"https://cdn.example.com/file.png","tags":[{"name":"test_artist","type":1}],"created_at":{"s":1720000000}}]).to_string(),"application/json","/posts",Some("Bearer fake-key")),
   ("philomena",json!({"images":[{"id":7,"view_url":"https://cdn.example.com/file.png","tags":["plain"],"representations":{"medium":"https://cdn.example.com/thumb.png"}}]}).to_string(),"application/json","/api/v1/json/search/images",None),
   ("szurubooru",json!({"results":[{"id":7,"contentUrl":"https://cdn.example.com/file.png","tags":[{"names":["test_artist"],"category":"artist"}]}]}).to_string(),"application/json","/api/posts/",Some("Token ZmFrZS11c2VyOmZha2Uta2V5")),
   ("shimmie","<posts count='1'><post id='7' file_url='https://cdn.example.com/file.png?x=1&amp;y=2' tags='plain' width='640'/></posts>".into(),"application/xml","/api/danbooru/find_posts/index.xml",None),
   ("furaffinity","<main id='pageid-browse'><figure id='sid-7' class='r-general'><a href='/view/7/'><img src='//t.furaffinity.net/7.jpg' data-tags='u_test_artist s_canine plain' data-width='640'></a><a href='/user/test_artist/'>Artist</a></figure></main>".into(),"text/html","/browse/",None),
  ];
        let t = Transport {
            allow_loopback: true,
        };
        for (engine, body, mime, path, auth) in cases {
            let f = fixture(body, mime).await;
            let s = site(engine, &f.base);
            let posts = search(&t, &s, &Search::default())
                .await
                .unwrap_or_else(|e| panic!("{engine}: {e}"));
            assert_eq!(posts.len(), 1, "{engine}");
            assert!(!posts[0]["tags"].as_array().unwrap().is_empty(), "{engine}");
            let requests = f.requests.lock().unwrap();
            let (path_requested, h) = &requests[0];
            assert!(
                path_requested.starts_with(path),
                "{engine}: {path_requested}"
            );
            assert_eq!(
                h.get(AUTHORIZATION).map(|h| h.to_str().unwrap()),
                auth,
                "{engine}"
            );
            if engine == "gelbooru" {
                assert!(path_requested.contains("api_key=fake-key"));
                assert!(path_requested.contains("pid=0"));
            }
            if engine == "philomena" {
                assert_eq!(h.get("x-philomena-api-key").unwrap(), "fake-key");
            }
            if engine == "furaffinity" {
                assert_eq!(h.get(COOKIE).unwrap(), "a=fake-session");
            }
            if engine == "e621" {
                assert_eq!(posts[0]["poolIds"], json!(["3"]));
                assert_eq!(posts[0]["parentId"], "4");
                assert_eq!(posts[0]["voted"], -1);
                assert_eq!(posts[0]["fileExt"], "webm");
                assert_eq!(posts[0]["favorited"], true);
            }
            if engine == "shimmie" {
                assert_eq!(
                    posts[0]["fileUrl"],
                    "https://cdn.example.com/file.png?x=1&y=2"
                );
                assert_eq!(posts[0]["height"], Value::Null);
            }
        }
    }
    #[tokio::test]
    async fn search_period_pagination_and_engine_authentication_are_sent_to_the_remote_api() {
        let t = Transport {
            allow_loopback: true,
        };
        for (engine, body, expected) in [
            (
                "e621",
                json!({"posts":[]}),
                "order:score date:2026-10-12..2026-10-18",
            ),
            (
                "danbooru",
                json!([]),
                "order:score date:2026-10-12..2026-10-18",
            ),
            (
                "moebooru",
                json!([]),
                "order:score date:2026-10-12..2026-10-18",
            ),
            (
                "sankaku",
                json!([]),
                "order:popular date:2026-10-12..2026-10-18",
            ),
            (
                "szurubooru",
                json!({"results":[]}),
                "sort:score creation-time:2026-10-12..2026-10-18",
            ),
            (
                "philomena",
                json!({"images":[]}),
                "(canine) AND created_at.gte:2026-10-12 AND created_at.lte:2026-10-18",
            ),
        ] {
            let f = fixture(body.to_string(), "application/json").await;
            let s = Search {
                tags: vec!["canine".into()],
                sort: "popular".into(),
                window: "week".into(),
                date: date("2026-10-13").unwrap(),
                page: 3,
                limit: 20,
            };
            search(&t, &site(engine, &f.base), &s).await.unwrap();
            let logs = f.requests.lock().unwrap();
            let u = Url::parse(&format!("{}{}", f.base, logs[0].0)).unwrap();
            let q: std::collections::HashMap<_, _> = u.query_pairs().collect();
            let key = if engine == "philomena" {
                "q"
            } else if engine == "szurubooru" {
                "query"
            } else {
                "tags"
            };
            assert!(q[key].contains(expected), "{engine}: {:?}", q);
            if engine == "szurubooru" {
                assert_eq!(q["offset"], "40");
            } else {
                assert_eq!(q["page"], "3");
            }
        }
    }
    #[test]
    fn malformed_responses_and_private_media_are_not_presented_as_empty_results() {
        let site = site("e621", "https://example.com");
        assert!(entries(&site, &json!({"success":false})).is_err());
        assert!(normalize(&site, &json!({"id":"../../secret"})).is_err());
        assert!(normalize(
            &site,
            &json!({"id":1,"file":{"url":"http://127.0.0.1/private"}})
        )
        .is_err());
        let s = site.clone();
        let mut s = Site {
            engine: "danbooru".into(),
            ..s
        };
        assert!(normalize(&s, &json!({"id":1,"tag_string_artist":true})).is_err());
        s.engine = "shimmie".into();
        assert!(shimmie(&s, "<html><body>Challenge</body></html>").is_err());
        assert!(shimmie(&s, "<posts><post id='1' tags='plain' broken></posts>").is_err());
    }
    #[tokio::test]
    async fn redirects_never_forward_credentials_to_another_origin() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(any(|| async {
            (
                axum::http::StatusCode::FOUND,
                [("location", "https://example.com/steal")],
            )
        }));
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let result = Transport {
            allow_loopback: true,
        }
        .json(
            Url::parse(&base).unwrap(),
            headers(&site("e621", &base), false).unwrap(),
        )
        .await;
        task.abort();
        assert!(result.is_err());
        let message = result.unwrap_err().to_string();
        assert!(!message.contains("fake-key"));
        assert!(!message.contains("fake-user"));
    }
}
