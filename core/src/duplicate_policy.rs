//! The duplicate policy: a preview plans, for every duplicate group, which file stays, which
//! favorites point at it and which copies are deleted. Confirming saves the policy and leaves a
//! request; only [`watch`] executes requests, so two runs never work on the library at once.
//! Library, favorite and source changes request a fresh run while the policy is enabled.

use crate::{
    booru_engines, booru_favorites as remote,
    booru_http::Transport,
    boorus::{self, Site},
    db::{read_setting, write_setting, Database, OWNER_ID},
    duplicates,
    library::{self, iso_millis},
    Error, Result,
};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SETTINGS_KEY: &str = "duplicates.policy";
/// How long a preview stays confirmable; the library may drift after that.
const PREVIEW_TTL_SECONDS: i64 = 15 * 60;
/// How often the worker looks for requests. Also the debounce of a burst.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
pub(crate) const CONFIRMATION_REASON: &str = "settings-confirmation";
const RUN_COLUMNS: &[&str] = &[
    "status",
    "total_groups",
    "processed_groups",
    "added",
    "removed",
    "reused",
    "deleted",
    "needs_attention",
    "error",
    "completed_at",
];

fn now() -> String {
    iso_millis(SystemTime::now())
}

fn conflict(message: &str) -> Response {
    (StatusCode::CONFLICT, Json(json!({"error": message}))).into_response()
}

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/duplicates/settings", get(get_settings).put(put_settings))
        .route("/duplicates/policy/preview", post(preview))
        .route("/duplicates/policy/confirm", post(confirm))
        .route("/duplicates/policy/status", get(status))
        .route("/duplicates/policy/retry", post(retry))
}

#[derive(Clone)]
struct Policy {
    style: String,
    preferred: Vec<String>,
}

impl Policy {
    fn keeps(&self, provider: &str) -> bool {
        self.style == "favorite_all" || self.preferred.iter().any(|p| p == provider)
    }
}

fn saved_settings(c: &Connection) -> Result<Value> {
    read_setting(
        c,
        SETTINGS_KEY,
        &json!({"enabled": false, "style": null, "preferredProviders": []}),
    )
}

/// The saved settings, with preferred providers limited to the sites configured now.
async fn settings(db: &Database) -> Result<Value> {
    let available: HashSet<String> = boorus::sites(db)
        .await?
        .iter()
        .map(remote::provider)
        .collect();
    let mut saved = db.call(|c| saved_settings(c)).await?;
    let invalid = || Error::Storage("Invalid duplicate preferred providers setting".into());
    let mut seen = HashSet::new();
    let preferred: Vec<Value> = saved["preferredProviders"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|p| p.as_str().ok_or_else(invalid))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|p| available.contains(*p) && seen.insert(*p))
        .map(|p| json!(p))
        .collect();
    saved["preferredProviders"] = json!(preferred);
    if !matches!(
        saved["style"].as_str(),
        Some("favorite_all" | "preferred_only")
    ) {
        saved["style"] = Value::Null;
    }
    Ok(saved)
}

async fn get_settings(State(db): State<Database>) -> Result<Json<Value>> {
    Ok(Json(settings(&db).await?))
}

async fn put_settings(State(db): State<Database>, body: axum::body::Bytes) -> Result<Json<Value>> {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if body != json!({"enabled": false}) {
        return Err(Error::Invalid(
            "Settings can only be disabled directly; preview and confirm other changes".into(),
        ));
    }
    let mut current = settings(&db).await?;
    current["enabled"] = json!(false);
    let saved = current.clone();
    db.call(move |c| write_setting(c, SETTINGS_KEY, &saved))
        .await?;
    Ok(Json(current))
}

/// Asks the worker for a run of the enabled policy; requests waiting for the worker merge.
/// A disabled policy takes no request: the worker would drop it.
fn request(c: &Connection, reason: &str) -> Result<()> {
    if saved_settings(c)?["enabled"] == true {
        request_run(c, reason, None)?;
    }
    Ok(())
}

/// Requests a run after a library, favorite or source change. The change already happened, so
/// a failed request is logged rather than reported; the next change or a retry requests again.
pub(crate) async fn notify(db: &Database, reason: &'static str) {
    if let Err(error) = db.call(move |c| request(c, reason)).await {
        eprintln!("Cannot request a duplicate policy run ({reason}): {error}");
    }
}

fn unix_millis(text: &str) -> Option<i64> {
    let parsed =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

fn request_run(c: &Connection, reason: &str, preview: Option<&str>) -> Result<()> {
    let existing: Option<(String, Option<String>, String)> = c
        .query_row(
            "SELECT reasons, preview_id, requested_at FROM duplicate_policy_requests WHERE user_id = ?1",
            [OWNER_ID],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let mut reasons: Vec<String> = match &existing {
        Some((raw, _, _)) => serde_json::from_str(raw)
            .map_err(|e| Error::Storage(format!("Invalid duplicate policy request: {e}")))?,
        None => Vec::new(),
    };
    reasons.push(reason.to_owned());
    reasons.sort();
    reasons.dedup();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| Error::Storage(e.to_string()))?
        .as_millis() as i64;
    // The worker deletes a request by this value, so a renewal in the same millisecond still changes it.
    let at = existing
        .as_ref()
        .and_then(|(_, _, at)| unix_millis(at))
        .map_or(now_ms, |previous| now_ms.max(previous + 1));
    let requested_at = iso_millis(UNIX_EPOCH + Duration::from_millis(at as u64));
    let preview = preview
        .map(str::to_owned)
        .or_else(|| existing.and_then(|(_, p, _)| p));
    c.execute(
        "INSERT OR REPLACE INTO duplicate_policy_requests (user_id, reasons, preview_id, requested_at) VALUES (?1, ?2, ?3, ?4)",
        params![OWNER_ID, serde_json::to_string(&reasons).map_err(|e| Error::Storage(e.to_string()))?, preview, requested_at],
    )?;
    Ok(())
}

fn create_run(c: &Connection, kind: &str, policy: &Policy, reason: &str) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let at = now();
    c.execute(
        "INSERT INTO duplicate_policy_runs (id, user_id, kind, status, style, preferred_providers, reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, OWNER_ID, kind, if kind == "apply" { "running" } else { "planning" }, policy.style,
            json!(policy.preferred).to_string(), reason, at],
    )?;
    Ok(id)
}

fn update_run(c: &Connection, id: &str, patch: Value) -> Result<()> {
    let mut sets = vec!["updated_at = ?1".to_owned()];
    let mut values: Vec<rusqlite::types::Value> = vec![now().into()];
    for (key, value) in patch.as_object().into_iter().flatten() {
        if !RUN_COLUMNS.contains(&key.as_str()) {
            return Err(Error::Storage(format!(
                "unknown duplicate run column {key}"
            )));
        }
        let unsupported = || {
            Error::Storage(format!(
                "unsupported value for duplicate run column {key}: {value}"
            ))
        };
        values.push(match value {
            Value::Null => rusqlite::types::Value::Null,
            Value::String(text) => text.clone().into(),
            Value::Number(n) => n.as_i64().ok_or_else(unsupported)?.into(),
            _ => return Err(unsupported()),
        });
        sets.push(format!("{key} = ?{}", values.len()));
    }
    values.push(id.to_owned().into());
    c.execute(
        &format!(
            "UPDATE duplicate_policy_runs SET {} WHERE id = ?{}",
            sets.join(", "),
            values.len()
        ),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

struct Planned {
    group: String,
    kind: &'static str,
    provider: Option<String>,
    remote_id: Option<String>,
    file_id: Option<String>,
    file_name: Option<String>,
    message: String,
}

/// Inserts the planned actions in order; the caller holds the transaction.
fn add_actions(c: &Connection, run: &str, actions: &[Planned]) -> Result<()> {
    let at = now();
    for (position, a) in actions.iter().enumerate() {
        c.execute(
            "INSERT INTO duplicate_policy_actions (id, run_id, group_key, kind, status, provider, remote_id, file_id, file_name, message, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'planned', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![uuid::Uuid::new_v4().to_string(), run, a.group, a.kind, a.provider, a.remote_id, a.file_id, a.file_name, a.message, position as i64, at],
        )?;
    }
    Ok(())
}

fn run_json(c: &Connection, filter: &str, value: &str) -> Result<Option<Value>> {
    let run = c
        .query_row(
            &format!("SELECT * FROM duplicate_policy_runs WHERE user_id = ?1 AND {filter} ORDER BY created_at DESC, rowid DESC LIMIT 1"),
            params![OWNER_ID, value],
            |r| {
                let preferred: String = r.get("preferred_providers")?;
                Ok(json!({
                    "id": r.get::<_, String>("id")?, "kind": r.get::<_, String>("kind")?, "status": r.get::<_, String>("status")?,
                    "style": r.get::<_, String>("style")?,
                    "preferredProviders": serde_json::from_str::<Vec<String>>(&preferred)
                        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
                    "reason": r.get::<_, String>("reason")?, "totalGroups": r.get::<_, i64>("total_groups")?,
                    "processedGroups": r.get::<_, i64>("processed_groups")?,
                    "counts": {"added": r.get::<_, i64>("added")?, "removed": r.get::<_, i64>("removed")?, "reused": r.get::<_, i64>("reused")?,
                        "deleted": r.get::<_, i64>("deleted")?, "needsAttention": r.get::<_, i64>("needs_attention")?},
                    "error": r.get::<_, Option<String>>("error")?, "createdAt": r.get::<_, String>("created_at")?,
                    "updatedAt": r.get::<_, String>("updated_at")?, "completedAt": r.get::<_, Option<String>>("completed_at")?,
                }))
            },
        )
        .optional()?;
    let Some(mut run) = run else { return Ok(None) };
    let mut statement = c.prepare(
        "SELECT id, group_key, kind, status, provider, remote_id, file_id, file_name, message, position
         FROM duplicate_policy_actions WHERE run_id = ?1 ORDER BY group_key, position",
    )?;
    let actions = statement
        .query_map([run["id"].as_str().unwrap_or_default()], |r| {
            Ok(json!({"id": r.get::<_, String>(0)?, "groupKey": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?,
                "status": r.get::<_, String>(3)?, "provider": r.get::<_, Option<String>>(4)?, "remoteId": r.get::<_, Option<String>>(5)?,
                "fileId": r.get::<_, Option<String>>(6)?, "fileName": r.get::<_, Option<String>>(7)?, "message": r.get::<_, String>(8)?,
                "position": r.get::<_, i64>(9)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    run["actions"] = json!(actions);
    Ok(Some(run))
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// Minimum match score for a reverse-image result to count as the file's source.
fn threshold(provider: &str) -> f64 {
    match provider {
        "SAUCENAO" => 90.0,
        "FLUFFLE" => 95.0,
        _ => 0.0,
    }
}

struct Favorite {
    provider: String,
    remote_id: String,
    file_path: String,
}

fn plan_group(
    c: &Connection,
    group: &Value,
    policy: &Policy,
    sites: &[Site],
) -> Result<Vec<Planned>> {
    let key = group["key"].as_str().unwrap_or_default().to_owned();
    let mut files: Vec<&Value> = group["files"].as_array().into_iter().flatten().collect();
    let area = |f: &Value| f["width"].as_i64().unwrap_or(0) * f["height"].as_i64().unwrap_or(0);
    files.sort_by(|a, b| {
        area(b)
            .cmp(&area(a))
            .then(b["sizeBytes"].as_i64().cmp(&a["sizeBytes"].as_i64()))
            .then(a["path"].as_str().cmp(&b["path"].as_str()))
    });
    let Some(canonical) = files.first() else {
        return Ok(Vec::new());
    };
    let canonical_id = canonical["id"].as_str().map(str::to_owned);
    let canonical_path = canonical["path"].as_str().unwrap_or_default().to_owned();
    let canonical_name = Some(base_name(&canonical_path));
    let mut existing = Vec::new();
    let mut statement = c.prepare("SELECT provider, remote_id, file_path FROM favorite_items WHERE user_id = ?1 AND file_path = ?2 ORDER BY updated_at DESC")?;
    for file in &files {
        let rows = statement.query_map(params![OWNER_ID, file["path"].as_str()], |r| {
            Ok(Favorite {
                provider: r.get(0)?,
                remote_id: r.get(1)?,
                file_path: r.get(2)?,
            })
        })?;
        existing.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }

    let mut matches: Vec<(String, String, bool)> = existing
        .iter()
        .map(|f| (f.provider.clone(), f.remote_id.clone(), true))
        .collect();
    // `boorus::sites` lists sites in their saved order, which decides a URL two sites could claim.
    let ordered: Vec<&Site> = sites.iter().filter(|s| s.enabled).collect();
    for file in &files {
        for run in file["providers"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, run)| run)
        {
            if run["status"] != "COMPLETED" {
                continue;
            }
            let provider = run["provider"].as_str().unwrap_or_default();
            let fallback = vec![json!({"sourceUrl": run["sourceUrl"], "score": run["score"]})];
            let candidates = run["results"]
                .as_array()
                .filter(|r| !r.is_empty())
                .unwrap_or(&fallback);
            for candidate in candidates {
                let Some(score) = candidate["score"].as_f64().filter(|s| s.is_finite()) else {
                    continue;
                };
                if score < threshold(provider) {
                    continue;
                }
                let Some(url) = candidate["sourceUrl"].as_str() else {
                    continue;
                };
                let Some((site, id)) = ordered
                    .iter()
                    .find_map(|s| crate::source_store::candidate(s, url).map(|id| (*s, id)))
                else {
                    continue;
                };
                let provider = remote::provider(site);
                if !matches.iter().any(|(p, r, _)| *p == provider && *r == id) {
                    matches.push((provider, id, false));
                }
            }
        }
    }

    let planned = |kind,
                   provider: Option<&str>,
                   remote_id: Option<&str>,
                   file_id: Option<String>,
                   file_name: Option<String>,
                   message: String| Planned {
        group: key.clone(),
        kind,
        provider: provider.map(str::to_owned),
        remote_id: remote_id.map(str::to_owned),
        file_id,
        file_name,
        message,
    };
    let site_name = |provider: &str| {
        sites
            .iter()
            .find(|s| remote::provider(s) == provider)
            .map_or_else(|| provider.to_owned(), |s| s.name.clone())
    };
    let desired: Vec<&(String, String, bool)> =
        matches.iter().filter(|(p, _, _)| policy.keeps(p)).collect();
    if policy.style == "preferred_only" && desired.is_empty() {
        return Ok(vec![planned("attention", None, None, canonical_id, canonical_name,
            "No matching favorite was found on an allowed provider; this group will stay unchanged.".into())]);
    }
    let name = canonical_name.clone().unwrap_or_default();
    let mut actions = vec![planned(
        "reuse_file",
        None,
        None,
        canonical_id.clone(),
        canonical_name.clone(),
        format!("Use {name} as the shared local file."),
    )];
    let removes_existing =
        policy.style == "preferred_only" && existing.iter().any(|f| !policy.keeps(&f.provider));
    for (provider, id, exists) in desired {
        if *exists && !removes_existing {
            continue;
        }
        actions.push(planned(
            if *exists {
                "confirm_favorite"
            } else {
                "add_favorite"
            },
            Some(provider),
            Some(id),
            canonical_id.clone(),
            canonical_name.clone(),
            if *exists {
                format!("Confirm {} post {id} is favorited.", site_name(provider))
            } else {
                format!("Add {} post {id} to favorites.", site_name(provider))
            },
        ));
    }
    for favorite in &existing {
        if policy.keeps(&favorite.provider) && favorite.file_path != canonical_path {
            actions.push(planned(
                "reuse_file",
                Some(&favorite.provider),
                Some(&favorite.remote_id),
                canonical_id.clone(),
                canonical_name.clone(),
                format!(
                    "Reuse {name} for {} post {}.",
                    site_name(&favorite.provider),
                    favorite.remote_id
                ),
            ));
        }
    }
    if policy.style == "preferred_only" {
        for favorite in existing.iter().filter(|f| !policy.keeps(&f.provider)) {
            actions.push(planned(
                "remove_favorite",
                Some(&favorite.provider),
                Some(&favorite.remote_id),
                None,
                None,
                format!(
                    "Remove {} post {} from favorites.",
                    site_name(&favorite.provider),
                    favorite.remote_id
                ),
            ));
        }
    }
    for file in files.iter().skip(1) {
        let path = file["path"].as_str().unwrap_or_default();
        actions.push(planned(
            "delete_file",
            None,
            None,
            file["id"].as_str().map(str::to_owned),
            Some(base_name(path)),
            format!("Delete redundant local file {}.", base_name(path)),
        ));
    }
    Ok(actions)
}

fn counts(actions: &[Planned]) -> Value {
    let count = |kind: &str| actions.iter().filter(|a| a.kind == kind).count();
    json!({"added": count("add_favorite"), "removed": count("remove_favorite"), "reused": count("reuse_file"),
        "deleted": count("delete_file"), "needs_attention": count("attention")})
}

/// Plans `policy` over a full, uncapped duplicate scan and stores it as a preview run.
async fn create_preview(db: &Database, policy: Policy, reason: &'static str) -> Result<Value> {
    let saved = policy.clone();
    let run = db
        .call(move |c| create_run(c, "preview", &saved, reason))
        .await?;
    let planned: Result<(usize, Vec<Planned>)> = async {
        let options = duplicates::Options {
            max_comparisons: u64::MAX,
            ..Default::default()
        };
        let result = duplicates::find(db, &options, |_| {}, &AtomicBool::new(false)).await?;
        let sites = boorus::sites(db).await?;
        let groups = result["groups"].as_array().cloned().unwrap_or_default();
        let total = groups.len();
        let actions = db
            .call(move |c| {
                let mut actions = Vec::new();
                for group in &groups {
                    actions.extend(plan_group(c, group, &policy, &sites)?);
                }
                Ok(actions)
            })
            .await?;
        Ok((total, actions))
    }
    .await;
    let id = run.clone();
    db.call(move |c| {
        match planned {
            Ok((total, actions)) => {
                let transaction = c.transaction()?;
                add_actions(&transaction, &id, &actions)?;
                let mut patch = counts(&actions);
                patch["status"] = json!("ready");
                patch["total_groups"] = json!(total);
                update_run(&transaction, &id, patch)?;
                transaction.commit()?;
            }
            Err(error) => update_run(
                c,
                &id,
                json!({"status": "failed", "error": error.to_string(), "completed_at": now()}),
            )?,
        }
        run_json(c, "id = ?2", &id)?
            .ok_or_else(|| Error::Storage("The duplicate preview was not saved.".into()))
    })
    .await
}

async fn preview(State(db): State<Database>, body: axum::body::Bytes) -> Result<Json<Value>> {
    let body: Value =
        serde_json::from_slice(&body).map_err(|_| Error::Invalid("Invalid payload".into()))?;
    let style = body["style"]
        .as_str()
        .filter(|s| matches!(*s, "favorite_all" | "preferred_only"))
        .ok_or_else(|| Error::Invalid("Invalid payload".into()))?;
    let preferred: Vec<String> = match body.get("preferredProviders") {
        None => Vec::new(),
        Some(list) => list
            .as_array()
            .ok_or_else(|| Error::Invalid("Invalid payload".into()))?
            .iter()
            .map(|p| {
                p.as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| Error::Invalid("Invalid payload".into()))
            })
            .collect::<Result<_>>()?,
    };
    if style == "preferred_only" && preferred.is_empty() {
        return Err(Error::Invalid(
            "Select at least one preferred provider".into(),
        ));
    }
    let available: HashSet<String> = boorus::sites(&db)
        .await?
        .iter()
        .map(remote::provider)
        .collect();
    if preferred.iter().collect::<HashSet<_>>().len() != preferred.len()
        || preferred.iter().any(|p| !available.contains(p))
    {
        return Err(Error::Invalid(
            "Preferred providers must be configured sites".into(),
        ));
    }
    Ok(Json(
        create_preview(
            &db,
            Policy {
                style: style.into(),
                preferred,
            },
            "settings-preview",
        )
        .await?,
    ))
}

enum Refusal {
    /// The preview is gone, applied or expired.
    Conflict,
    Busy,
}

/// A preview still confirmable, with its policy, or why it is not.
fn confirmable(
    c: &Connection,
    id: &str,
) -> Result<std::result::Result<(Value, Policy), &'static str>> {
    let Some(run) = run_json(c, "id = ?2", id)? else {
        return Ok(Err("Preview is no longer available"));
    };
    if run["kind"] != "preview" || run["status"] != "ready" {
        return Ok(Err("Preview is no longer available"));
    }
    let expired: bool = c.query_row(
        "SELECT (julianday('now') - julianday(created_at)) * 86400 > ?2 FROM duplicate_policy_runs WHERE id = ?1",
        params![id, PREVIEW_TTL_SECONDS], |r| r.get(0))?;
    if expired {
        return Ok(Err("Preview expired; create a new preview"));
    }
    let policy = Policy {
        style: run["style"].as_str().unwrap_or_default().to_owned(),
        preferred: serde_json::from_value(run["preferredProviders"].clone())
            .map_err(|e| Error::Storage(e.to_string()))?,
    };
    Ok(Ok((run, policy)))
}

async fn confirm(State(db): State<Database>, body: axum::body::Bytes) -> Result<Response> {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let id = body["previewId"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| Error::Invalid("Invalid payload".into()))?
        .to_owned();
    db.call(move |c| {
        let transaction = c.transaction()?;
        let policy = match confirmable(&transaction, &id)? {
            Ok((_, policy)) => policy,
            Err(message) => return Ok(conflict(message)),
        };
        write_setting(&transaction, SETTINGS_KEY, &json!({"enabled": true, "style": policy.style, "preferredProviders": policy.preferred}))?;
        request_run(&transaction, CONFIRMATION_REASON, Some(&id))?;
        transaction.commit()?;
        Ok(Json(json!({"status": "queued"})).into_response())
    })
    .await
}

async fn status(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| {
        let queued: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM duplicate_policy_requests WHERE user_id = ?1)",
            [OWNER_ID],
            |r| r.get(0),
        )?;
        Ok(Json(
            json!({"latestRun": run_json(c, "kind = ?2", "apply")?, "queued": queued}),
        ))
    })
    .await
}

async fn retry(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| request(c, "manual-retry")).await?;
    Ok(Json(json!({"status": "queued"})))
}

fn active_apply(c: &Connection) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM duplicate_policy_runs WHERE user_id = ?1 AND kind = 'apply' AND status = 'running')",
        [OWNER_ID], |r| r.get(0))?)
}

/// Records an apply run of `preview` and executes it to the end.
async fn apply(
    db: &Database,
    preview: String,
    reason: String,
) -> Result<std::result::Result<(), Refusal>> {
    let started = db
        .call(move |c| {
            let transaction = c.transaction()?;
            let (run, policy) = match confirmable(&transaction, &preview)? {
                Ok(found) => found,
                Err(_) => return Ok(Err(Refusal::Conflict)),
            };
            if active_apply(&transaction)? {
                return Ok(Err(Refusal::Busy));
            }
            let id = create_run(&transaction, "apply", &policy, &reason)?;
            // A preview is applied once: a second confirmation of the same id must plan afresh.
            update_run(
                &transaction,
                &preview,
                json!({"status": "completed", "completed_at": now()}),
            )?;
            let actions: Vec<Planned> = run["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| Planned {
                    group: a["groupKey"].as_str().unwrap_or_default().to_owned(),
                    kind: match a["kind"].as_str() {
                        Some("add_favorite") => "add_favorite",
                        Some("confirm_favorite") => "confirm_favorite",
                        Some("remove_favorite") => "remove_favorite",
                        Some("reuse_file") => "reuse_file",
                        Some("delete_file") => "delete_file",
                        _ => "attention",
                    },
                    provider: a["provider"].as_str().map(str::to_owned),
                    remote_id: a["remoteId"].as_str().map(str::to_owned),
                    file_id: a["fileId"].as_str().map(str::to_owned),
                    file_name: a["fileName"].as_str().map(str::to_owned),
                    message: a["message"].as_str().unwrap_or_default().to_owned(),
                })
                .collect();
            let attention = run["counts"]["needsAttention"].as_i64().unwrap_or(0);
            let total = run["totalGroups"].as_i64().unwrap_or(0);
            add_actions(&transaction, &id, &actions)?;
            update_run(
                &transaction,
                &id,
                json!({"total_groups": total, "needs_attention": attention}),
            )?;
            transaction.commit()?;
            Ok(Ok(id))
        })
        .await?;
    let id = match started {
        Ok(id) => id,
        Err(refusal) => return Ok(Err(refusal)),
    };
    if let Err(error) = execute(db, &id).await {
        let run = id.clone();
        db.call(move |c| {
            update_run(
                c,
                &run,
                json!({"status": "failed", "error": error.to_string(), "completed_at": now()}),
            )
        })
        .await?;
    }
    Ok(Ok(()))
}

async fn site_for(db: &Database, provider: &str) -> Result<Site> {
    boorus::sites(db)
        .await?
        .into_iter()
        .find(|s| remote::provider(s) == provider)
        .ok_or_else(|| Error::Invalid(format!("Unknown booru provider: {provider}")))
}

async fn act(
    db: &Database,
    kind: &str,
    provider: Option<String>,
    remote_id: Option<String>,
    file_id: Option<String>,
    canonical: Option<String>,
) -> Result<()> {
    let target = || Error::Invalid("The action is missing its target.".into());
    match kind {
        "add_favorite" | "confirm_favorite" => {
            let (provider, id, path) = (
                provider.ok_or_else(target)?,
                remote_id.ok_or_else(target)?,
                canonical.ok_or_else(target)?,
            );
            let site = site_for(db, &provider).await?;
            let _guard = db.favorites.writes.lock().await;
            remote::set(&Transport::default(), &site, &id, true).await?;
            crate::subscription_store::favorite_override(db, &site.id, &id, true).await?;
            db.favorites.mark_removed(provider.clone(), &id, false)?;
            let source = booru_engines::post_url(&site, &id)?;
            db.call(move |c| {
                c.execute(&format!("INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, file_url, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, NULL, {now}, {now}) ON CONFLICT(user_id, provider, remote_id)
                    DO UPDATE SET file_path = excluded.file_path, source_url = excluded.source_url, updated_at = excluded.updated_at", now = library::NOW),
                    params![OWNER_ID, provider, id, path, source])?;
                Ok(())
            }).await
        }
        "reuse_file" => {
            if provider.is_none() && remote_id.is_none() {
                return Ok(());
            }
            let (provider, id, path) = (
                provider.ok_or_else(target)?,
                remote_id.ok_or_else(target)?,
                canonical.ok_or_else(target)?,
            );
            db.call(move |c| {
                c.execute(&format!("UPDATE favorite_items SET file_path = ?1, updated_at = {} WHERE user_id = ?2 AND provider = ?3 AND remote_id = ?4", library::NOW),
                    params![path, OWNER_ID, provider, id])?;
                Ok(())
            }).await
        }
        "remove_favorite" => {
            let (provider, id) = (provider.ok_or_else(target)?, remote_id.ok_or_else(target)?);
            let site = site_for(db, &provider).await?;
            let _guard = db.favorites.writes.lock().await;
            remote::set(&Transport::default(), &site, &id, false).await?;
            crate::subscription_store::favorite_override(db, &site.id, &id, false).await?;
            db.favorites.mark_removed(provider.clone(), &id, true)?;
            db.call(move |c| {
                c.execute("DELETE FROM favorite_items WHERE user_id = ?1 AND provider = ?2 AND remote_id = ?3", params![OWNER_ID, provider, id])?;
                Ok(())
            }).await
        }
        "delete_file" => delete_copy(db, file_id.ok_or_else(target)?).await,
        _ => Ok(()),
    }
}

/// Deletes a redundant copy and its row. A copy that a favorite still points at is kept.
async fn delete_copy(db: &Database, id: String) -> Result<()> {
    let lookup = id.clone();
    let record: Option<(String, String, bool)> = db.call(move |c| {
        Ok(c.query_row(
            "SELECT f.path, folders.path, EXISTS(SELECT 1 FROM favorite_items fav WHERE fav.user_id = folders.user_id AND fav.file_path = f.path)
             FROM files f JOIN library_folders folders ON folders.id = f.folder_id WHERE f.id = ?1 AND folders.type = 'LOCAL' AND f.location_type = 'LOCAL'",
            [lookup], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?)
    }).await?;
    let refused = || Error::Invalid("File is still referenced or could not be deleted".into());
    let Some((path, folder, referenced)) = record else {
        return Err(refused());
    };
    if referenced {
        return Err(refused());
    }
    let path = db
        .library()
        .resolve_file(Path::new(&folder), Path::new(&path))?;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!("Cannot delete duplicate {}: {error}", path.display());
            return Err(refused());
        }
    }
    let orphans = db
        .call(move |c| crate::originals::forget_deleted(c, &[id]))
        .await?;
    library::remove_thumbnails(&db.library().thumbnails, orphans).await;
    Ok(())
}

async fn execute(db: &Database, id: &str) -> Result<()> {
    let run_id = id.to_owned();
    let run = db
        .call(move |c| run_json(c, "id = ?2", &run_id))
        .await?
        .ok_or_else(|| Error::Storage("The duplicate run was not saved.".into()))?;
    let actions = run["actions"].as_array().cloned().unwrap_or_default();
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for action in actions {
        let key = action["groupKey"].as_str().unwrap_or_default().to_owned();
        match groups.last_mut() {
            Some((last, bucket)) if *last == key => bucket.push(action),
            _ => groups.push((key, vec![action])),
        }
    }
    let mark = |action: String, status: &'static str, message: Option<String>| async move {
        db.call(move |c| {
            match message {
                Some(m) => c.execute(&format!("UPDATE duplicate_policy_actions SET status = ?1, message = ?2, updated_at = {} WHERE id = ?3", library::NOW), params![status, m, action])?,
                None => c.execute(&format!("UPDATE duplicate_policy_actions SET status = ?1, updated_at = {} WHERE id = ?2", library::NOW), params![status, action])?,
            };
            Ok(())
        }).await
    };
    let mut processed = 0i64;
    // One entry per distinct reason: the first action it stopped and how many it stopped.
    let mut failures: Vec<(String, String, usize)> = Vec::new();
    let mut done = json!({"added": 0, "removed": 0, "reused": 0, "deleted": 0});
    for (_, actions) in groups {
        let text = |a: &Value, key: &str| a[key].as_str().map(str::to_owned);
        if actions.iter().any(|a| a["kind"] == "attention") {
            for action in &actions {
                mark(text(action, "id").unwrap_or_default(), "skipped", None).await?;
            }
            processed += 1;
            continue;
        }
        let canonical = match actions.iter().find(|a| a["kind"] == "reuse_file" && a["provider"].is_null()).and_then(|a| text(a, "fileId")) {
            Some(file) => db.call(move |c| Ok(c.query_row(
                "SELECT f.path FROM files f JOIN library_folders folders ON folders.id = f.folder_id WHERE f.id = ?1",
                [file], |r| r.get::<_, String>(0)).optional()?)).await?,
            None => None,
        };
        let mut failed = false;
        for action in &actions {
            let kind = action["kind"].as_str().unwrap_or_default();
            let (action_id, message) = (
                text(action, "id").unwrap_or_default(),
                text(action, "message").unwrap_or_default(),
            );
            if failed && matches!(kind, "remove_favorite" | "delete_file") {
                mark(
                    action_id,
                    "skipped",
                    Some(format!("{message} Skipped after an earlier failure.")),
                )
                .await?;
                continue;
            }
            match act(
                db,
                kind,
                text(action, "provider"),
                text(action, "remoteId"),
                text(action, "fileId"),
                canonical.clone(),
            )
            .await
            {
                Ok(()) => {
                    mark(action_id, "completed", None).await?;
                    let counter = match kind {
                        "add_favorite" => "added",
                        "remove_favorite" => "removed",
                        "reuse_file" => "reused",
                        "delete_file" => "deleted",
                        _ => "",
                    };
                    if let Some(n) = done.get_mut(counter) {
                        *n = json!(n.as_i64().unwrap_or(0) + 1);
                    }
                }
                Err(error) => {
                    failed = true;
                    let reason = error.to_string();
                    match failures.iter_mut().find(|(r, _, _)| *r == reason) {
                        Some((_, _, count)) => *count += 1,
                        None => failures.push((reason.clone(), message.clone(), 1)),
                    }
                    mark(action_id, "failed", Some(format!("{message} {reason}"))).await?;
                }
            }
        }
        processed += 1;
        let (run, mut patch) = (id.to_owned(), done.clone());
        patch["processed_groups"] = json!(processed);
        db.call(move |c| update_run(c, &run, patch)).await?;
    }
    let (run, mut patch) = (id.to_owned(), done);
    patch["status"] = json!(if failures.is_empty() {
        "completed"
    } else {
        "partial"
    });
    patch["processed_groups"] = json!(processed);
    patch["error"] = if failures.is_empty() {
        Value::Null
    } else {
        let lines: Vec<String> = failures
            .iter()
            .map(|(reason, first, count)| {
                let first = first.trim_end_matches('.');
                match count {
                    1 => format!("{first}: {reason}"),
                    n => format!("{first}, and {} more like it: {reason}", n - 1),
                }
            })
            .collect();
        json!(lines.join(" "))
    };
    patch["completed_at"] = json!(now());
    db.call(move |c| update_run(c, &run, patch)).await
}

struct Request {
    reasons: Vec<String>,
    preview: Option<String>,
    requested_at: String,
}

async fn run_request(db: &Database, request: &Request) -> Result<std::result::Result<(), Refusal>> {
    let mut reasons = request.reasons.clone();
    if let Some(preview) = &request.preview {
        match apply(db, preview.clone(), reasons.join(",")).await? {
            Ok(()) => {
                // Triggers merged into the confirmation came after its plan, so they need a fresh one.
                reasons.retain(|r| r != CONFIRMATION_REASON);
                if reasons.is_empty() {
                    return Ok(Ok(()));
                }
            }
            Err(Refusal::Busy) => return Ok(Err(Refusal::Busy)),
            // The confirmed preview expired while waiting; the saved policy plans the same result below.
            Err(Refusal::Conflict) => {}
        }
    }
    let saved = db.call(|c| saved_settings(c)).await?;
    let Some(style) = saved["style"].as_str().filter(|_| saved["enabled"] == true) else {
        return Ok(Ok(()));
    };
    let policy = Policy {
        style: style.to_owned(),
        preferred: settings(db).await?["preferredProviders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect(),
    };
    let preview = create_preview(db, policy, "settings-preview").await?;
    if preview["status"] != "ready" {
        return Ok(Ok(()));
    }
    apply(
        db,
        preview["id"].as_str().unwrap_or_default().to_owned(),
        format!("automatic:{}", reasons.join(",")),
    )
    .await
}

/// Executes waiting requests. A request renewed while its run was in progress keeps its row and
/// is served on the next pass; so does one that finds another run in progress.
pub(crate) async fn process(db: &Database) -> Result<()> {
    let request = db.call(|c| {
        if active_apply(c)? {
            return Ok(None);
        }
        Ok(c.query_row("SELECT reasons, preview_id, requested_at FROM duplicate_policy_requests WHERE user_id = ?1", [OWNER_ID], |r| {
            Ok(Request {
                reasons: serde_json::from_str(&r.get::<_, String>(0)?)
                    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?,
                preview: r.get(1)?,
                requested_at: r.get(2)?,
            })
        }).optional()?)
    }).await?;
    let Some(request) = request else {
        return Ok(());
    };
    match run_request(db, &request).await {
        Ok(Err(Refusal::Busy)) => return Ok(()),
        Ok(_) => {}
        Err(error) => eprintln!(
            "Duplicate policy run failed ({}): {error}",
            request.reasons.join(",")
        ),
    }
    let at = request.requested_at;
    db.call(move |c| {
        c.execute(
            "DELETE FROM duplicate_policy_requests WHERE user_id = ?1 AND requested_at = ?2",
            params![OWNER_ID, at],
        )?;
        Ok(())
    })
    .await
}

/// Resumes runs a restart interrupted, then serves requests until the task is dropped.
pub(crate) async fn watch(db: Database) {
    let recovered = db.call(|c| {
        let interrupted = active_apply(c)?;
        if interrupted {
            c.execute(&format!("UPDATE duplicate_policy_runs SET status = 'failed', error = 'Run interrupted by restart', updated_at = {now}, completed_at = {now}
                WHERE kind = 'apply' AND status = 'running'", now = library::NOW), [])?;
            request_run(c, "resume-after-restart", None)?;
        }
        Ok(())
    }).await;
    if let Err(error) = recovered {
        eprintln!("Cannot recover duplicate policy runs: {error}");
    }
    loop {
        if let Err(error) = process(&db).await {
            eprintln!("Duplicate policy: {error}");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use std::process::Command;
    use tower::ServiceExt;

    async fn call(db: &Database, method: &str, path: &str, body: Value) -> (u16, Value) {
        let response = routes()
            .merge(duplicates::routes())
            .with_state(db.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn open() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        (dir, db)
    }

    fn picture(path: &Path, source: &str) {
        let status = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                source,
                "-frames:v",
                "1",
                "-y",
            ])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    async fn add_site(db: &Database, id: &str) {
        let id = id.to_owned();
        db.call(move |c| {
            c.execute(&format!("INSERT INTO user_booru_sites (id,user_id,name,engine,base_url,is_preset,enabled,sort_order,created_at,updated_at)
                VALUES (?1,?2,?1,'e621','https://' || ?1 || '.example.org',0,1,0,{now},{now})", now = library::NOW), params![id, OWNER_ID])?;
            Ok(())
        }).await.unwrap();
    }

    async fn preview_and_confirm(db: &Database) -> Value {
        let (status, preview) = call(
            db,
            "POST",
            "/duplicates/policy/preview",
            json!({"style": "favorite_all"}),
        )
        .await;
        assert_eq!(status, 200, "{preview}");
        let (status, body) = call(
            db,
            "POST",
            "/duplicates/policy/confirm",
            json!({"previewId": preview["id"]}),
        )
        .await;
        assert_eq!((status, body), (200, json!({"status": "queued"})));
        preview
    }

    async fn latest_apply(db: &Database) -> Value {
        call(db, "GET", "/duplicates/policy/status", json!({}))
            .await
            .1["latestRun"]
            .clone()
    }

    #[tokio::test]
    async fn copies_stack_and_a_confirmed_policy_keeps_one_file_with_its_favorites() {
        let (_dir, db) = open();
        let root = db.library().root.clone();
        picture(&root.join("copy.png"), "testsrc=s=160x120");
        picture(&root.join("copy.bmp"), "testsrc=s=160x120");
        picture(&root.join("other.png"), "color=c=red:s=160x120");
        picture(&root.join("larger.png"), "testsrc=s=320x240");
        library::scan(&db).await.unwrap();

        let (status, started) = call(&db, "POST", "/duplicates/scan/start", json!({})).await;
        assert_eq!((status, started["status"].as_str()), (200, Some("started")));
        let scan = loop {
            let (_, state) = call(&db, "GET", "/duplicates/scan/status", json!({})).await;
            if state["status"] != "running" {
                break state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(scan["status"], "done", "{scan}");
        let groups = scan["result"]["groups"].as_array().unwrap();
        assert_eq!(
            groups.len(),
            1,
            "only same-size visual copies form a group: {scan}"
        );
        let mut names: Vec<String> = groups[0]["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| base_name(f["path"].as_str().unwrap()))
            .collect();
        names.sort();
        assert_eq!(names, ["copy.bmp", "copy.png"]);

        // The bitmap is the larger copy, so it stays; the favorite of the PNG moves onto it.
        let png = root.join("copy.png").to_string_lossy().into_owned();
        db.call(move |c| {
            c.execute(&format!("INSERT INTO favorite_items (user_id,provider,remote_id,file_path,created_at,updated_at) VALUES (?1,'fixture','8',?2,{now},{now})", now = library::NOW), params![OWNER_ID, png])?;
            Ok(())
        }).await.unwrap();
        let preview = preview_and_confirm(&db).await;
        let kinds: Vec<&str> = preview["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["reuse_file", "reuse_file", "delete_file"]);
        assert!(root.join("copy.png").exists(), "a preview changes nothing");

        process(&db).await.unwrap();
        let run = latest_apply(&db).await;
        assert_eq!(
            (run["status"].as_str(), run["reason"].as_str()),
            (Some("completed"), Some(CONFIRMATION_REASON)),
            "{run}"
        );
        assert_eq!(run["counts"]["deleted"], 1);
        assert!(!root.join("copy.png").exists() && root.join("copy.bmp").exists());
        let favorite: String = db
            .call(|c| {
                Ok(c.query_row(
                    "SELECT file_path FROM favorite_items WHERE remote_id='8'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert!(favorite.ends_with("copy.bmp"));

        // A copy added later is resolved by the automatic run the library scan requests.
        picture(&root.join("again.png"), "testsrc=s=160x120");
        library::scan(&db).await.unwrap();
        assert!(
            call(&db, "GET", "/duplicates/policy/status", json!({}))
                .await
                .1["queued"]
                == true
        );
        process(&db).await.unwrap();
        let run = latest_apply(&db).await;
        assert_eq!(run["reason"], "automatic:local-library-changed", "{run}");
        assert!(!root.join("again.png").exists());
        assert!(root.join("other.png").exists() && root.join("larger.png").exists());
    }

    #[tokio::test]
    async fn preview_is_non_mutating_and_an_applied_preview_cannot_be_replayed() {
        let (_dir, db) = open();
        let (_, before) = call(&db, "GET", "/duplicates/settings", json!({})).await;
        assert_eq!(
            before,
            json!({"enabled": false, "style": null, "preferredProviders": []})
        );
        let (status, preview) = call(
            &db,
            "POST",
            "/duplicates/policy/preview",
            json!({"style": "favorite_all", "preferredProviders": []}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            (
                preview["kind"].as_str(),
                preview["status"].as_str(),
                preview["totalGroups"].as_i64()
            ),
            (Some("preview"), Some("ready"), Some(0))
        );
        assert_eq!(
            call(&db, "GET", "/duplicates/settings", json!({})).await.1["enabled"],
            false
        );

        call(
            &db,
            "POST",
            "/duplicates/policy/confirm",
            json!({"previewId": preview["id"]}),
        )
        .await;
        let settings = call(&db, "GET", "/duplicates/settings", json!({})).await.1;
        assert_eq!(
            (settings["enabled"].as_bool(), settings["style"].as_str()),
            (Some(true), Some("favorite_all"))
        );
        let (_, queued) = call(&db, "GET", "/duplicates/policy/status", json!({})).await;
        assert_eq!(queued, json!({"latestRun": null, "queued": true}));

        process(&db).await.unwrap();
        let (_, status) = call(&db, "GET", "/duplicates/policy/status", json!({})).await;
        assert_eq!(status["queued"], false);
        assert_eq!(
            (
                status["latestRun"]["kind"].as_str(),
                status["latestRun"]["status"].as_str()
            ),
            (Some("apply"), Some("completed"))
        );

        let (status, again) = call(
            &db,
            "POST",
            "/duplicates/policy/confirm",
            json!({"previewId": preview["id"]}),
        )
        .await;
        assert_eq!(
            (status, again["error"].as_str()),
            (409, Some("Preview is no longer available"))
        );

        // Automatic triggers merge into one request and plan from the saved policy.
        db.call(|c| {
            request(c, "provider-post-changed")?;
            request(c, "local-library-changed")
        })
        .await
        .unwrap();
        let reasons: String = db
            .call(|c| {
                Ok(
                    c.query_row("SELECT reasons FROM duplicate_policy_requests", [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(
            reasons,
            r#"["local-library-changed","provider-post-changed"]"#
        );
        process(&db).await.unwrap();
        assert_eq!(
            latest_apply(&db).await["reason"],
            "automatic:local-library-changed,provider-post-changed"
        );
    }

    #[tokio::test]
    async fn a_trigger_merged_into_a_confirmation_still_gets_its_own_plan() {
        let (_dir, db) = open();
        preview_and_confirm(&db).await;
        db.call(|c| request(c, "local-library-changed"))
            .await
            .unwrap();
        process(&db).await.unwrap();
        assert_eq!(
            latest_apply(&db).await["reason"],
            "automatic:local-library-changed"
        );
    }

    #[tokio::test]
    async fn requests_are_dropped_while_the_policy_is_disabled() {
        let (_dir, db) = open();
        db.call(|c| request(c, "local-library-changed"))
            .await
            .unwrap();
        process(&db).await.unwrap();
        assert_eq!(
            call(&db, "GET", "/duplicates/policy/status", json!({}))
                .await
                .1,
            json!({"latestRun": null, "queued": false})
        );
    }

    #[tokio::test]
    async fn a_request_renewed_at_once_is_not_the_one_read_before() {
        let (_dir, db) = open();
        let read = db
            .call(|c| {
                request_run(c, "local-library-changed", None)?;
                let read: String = c.query_row(
                    "SELECT requested_at FROM duplicate_policy_requests",
                    [],
                    |r| r.get(0),
                )?;
                request_run(c, "local-library-changed", None)?;
                c.execute(
                    "DELETE FROM duplicate_policy_requests WHERE requested_at = ?1",
                    [&read],
                )?;
                Ok(
                    c.query_row("SELECT COUNT(*) FROM duplicate_policy_requests", [], |r| {
                        r.get::<_, i64>(0)
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!(read, 1);
    }

    #[tokio::test]
    async fn confirm_waits_for_the_apply_run_in_progress() {
        let (_dir, db) = open();
        let (_, preview) = call(
            &db,
            "POST",
            "/duplicates/policy/preview",
            json!({"style": "favorite_all"}),
        )
        .await;
        db.call(|c| {
            create_run(
                c,
                "apply",
                &Policy {
                    style: "favorite_all".into(),
                    preferred: vec![],
                },
                "test-active-run",
            )
            .map(|_| ())
        })
        .await
        .unwrap();
        let (status, _) = call(
            &db,
            "POST",
            "/duplicates/policy/confirm",
            json!({"previewId": preview["id"]}),
        )
        .await;
        assert_eq!(status, 200);
        process(&db).await.unwrap();
        assert_eq!(
            call(&db, "GET", "/duplicates/policy/status", json!({}))
                .await
                .1["queued"],
            true
        );
        let (status, missing) = call(
            &db,
            "POST",
            "/duplicates/policy/confirm",
            json!({"previewId": "00000000-0000-4000-8000-000000000000"}),
        )
        .await;
        assert_eq!(
            (status, missing["error"].as_str()),
            (409, Some("Preview is no longer available"))
        );
    }

    #[tokio::test]
    async fn settings_can_only_be_disabled_and_previews_need_configured_providers() {
        let (_dir, db) = open();
        add_site(&db, "first").await;
        add_site(&db, "second").await;
        let preview = |body: Value| {
            let db = db.clone();
            async move {
                call(&db, "POST", "/duplicates/policy/preview", body)
                    .await
                    .0
            }
        };
        assert_eq!(
            preview(json!({"style": "preferred_only", "preferredProviders": []})).await,
            400
        );
        assert_eq!(
            preview(json!({"style": "preferred_only", "preferredProviders": ["first", "first"]}))
                .await,
            400
        );
        assert_eq!(
            preview(json!({"style": "preferred_only", "preferredProviders": ["elsewhere"]})).await,
            400
        );
        assert_eq!(preview(json!({"style": "everything"})).await, 400);
        assert_eq!(
            preview(json!({"style": "preferred_only", "preferredProviders": ["second", "first"]}))
                .await,
            200
        );

        for body in [
            json!({"enabled": true}),
            json!({"enabled": false, "style": "favorite_all"}),
            json!({}),
        ] {
            assert_eq!(call(&db, "PUT", "/duplicates/settings", body).await.0, 400);
        }
        db.call(|c| write_setting(c, SETTINGS_KEY, &json!({"enabled": true, "style": "preferred_only", "preferredProviders": ["first", "gone"]}))).await.unwrap();
        assert_eq!(
            call(&db, "GET", "/duplicates/settings", json!({})).await.1["preferredProviders"],
            json!(["first"])
        );
        let (status, off) = call(
            &db,
            "PUT",
            "/duplicates/settings",
            json!({"enabled": false}),
        )
        .await;
        assert_eq!(
            (status, off),
            (
                200,
                json!({"enabled": false, "style": "preferred_only", "preferredProviders": ["first"]})
            )
        );
    }

    #[tokio::test]
    async fn actions_keep_their_safety_order() {
        let (_dir, db) = open();
        let messages = db
            .call(|c| {
                let run = create_run(
                    c,
                    "preview",
                    &Policy {
                        style: "preferred_only".into(),
                        preferred: vec!["e621".into()],
                    },
                    "test",
                )?;
                let action = |kind, message: &str| Planned {
                    group: "group".into(),
                    kind,
                    provider: None,
                    remote_id: None,
                    file_id: None,
                    file_name: None,
                    message: message.into(),
                };
                add_actions(
                    c,
                    &run,
                    &[
                        action("confirm_favorite", "confirm"),
                        action("remove_favorite", "remove"),
                        action("delete_file", "delete"),
                    ],
                )?;
                Ok(run_json(c, "id = ?2", &run)?.unwrap()["actions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a["message"].clone())
                    .collect::<Vec<_>>())
            })
            .await
            .unwrap();
        assert_eq!(
            messages,
            [json!("confirm"), json!("remove"), json!("delete")]
        );
    }

    #[tokio::test]
    async fn a_partial_run_says_which_actions_failed_and_why() {
        let (_dir, db) = open();
        let run = db
            .call(|c| {
                let run = create_run(
                    c,
                    "apply",
                    &Policy {
                        style: "favorite_all".into(),
                        preferred: Vec::new(),
                    },
                    "test",
                )?;
                let add = |group: &str, id: &str| Planned {
                    group: group.into(),
                    kind: "add_favorite",
                    provider: Some("gone".into()),
                    remote_id: Some(id.into()),
                    file_id: None,
                    file_name: None,
                    message: format!("Add Gone post {id} to favorites."),
                };
                add_actions(c, &run, &[add("a", "7"), add("b", "8")])?;
                Ok(run)
            })
            .await
            .unwrap();
        execute(&db, &run).await.unwrap();
        let run = db
            .call(move |c| Ok(run_json(c, "id = ?2", &run)?.unwrap()))
            .await
            .unwrap();
        assert_eq!(run["status"], "partial");
        assert_eq!(
            run["error"],
            "Add Gone post 7 to favorites, and 1 more like it: The action is missing its target."
        );
    }

    #[tokio::test]
    async fn scan_rejects_invalid_options_and_cancel_is_idle_without_a_scan() {
        let (_dir, db) = open();
        assert_eq!(
            call(
                &db,
                "POST",
                "/duplicates/scan/start",
                json!({"pixelThreshold": 2})
            )
            .await
            .0,
            400
        );
        assert_eq!(
            call(&db, "GET", "/duplicates/scan/status", json!({}))
                .await
                .1["status"],
            "idle"
        );
        assert_eq!(
            call(&db, "POST", "/duplicates/scan/cancel", json!({}))
                .await
                .1,
            json!({"status": "idle"})
        );
    }
}
