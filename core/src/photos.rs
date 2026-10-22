//! The iPhone's photo library, which only the shell can reach. A shell registers its picker here;
//! the core adds what the person picks and, when they ask for it, deletes the originals.
use std::{collections::HashMap, future::Future, path::PathBuf, pin::Pin, sync::OnceLock};

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};

use crate::{
    db::{read_setting, Database},
    files::import_paths,
    Error, Result,
};

/// A picture or video the person picked.
pub struct Picked {
    /// A copy in a folder of its own; the core removes that folder once the file is added.
    pub path: PathBuf,
    /// The photo library's identifier for the original, to delete it later.
    pub asset_id: Option<String>,
}

pub type Pending<T> = Pin<Box<dyn Future<Output = std::result::Result<T, String>> + Send>>;

pub trait PhotoLibrary: Send + Sync {
    /// Lets the person pick pictures and videos. Empty when they close the picker.
    fn pick(&self) -> Pending<Vec<Picked>>;
    /// Deletes the originals with `asset_ids`. The system asks the person to confirm, and the
    /// photos stay in Recently Deleted for a while.
    fn delete(&self, asset_ids: Vec<String>) -> Pending<usize>;
}

static LIBRARY: OnceLock<Box<dyn PhotoLibrary>> = OnceLock::new();

/// Registers the photo library once at startup; later calls are ignored.
pub fn register(library: Box<dyn PhotoLibrary>) {
    let _ = LIBRARY.set(library);
}

pub(crate) fn get() -> Option<&'static dyn PhotoLibrary> {
    LIBRARY.get().map(|library| library.as_ref())
}

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/photos/add", post(add))
}

/// Asks the person for photos and adds them. Answers like an upload, plus `deleted`, how many
/// originals were deleted, and `deleteError` when the option is on and they could not be.
async fn add(State(database): State<Database>) -> Result<Json<Value>> {
    let library = get().ok_or(Error::Unavailable(
        "Adding from Photos needs the iPhone app.",
    ))?;
    let picked = library.pick().await.map_err(Error::Remote)?;
    let paths = picked.iter().map(|picked| picked.path.clone()).collect();
    let imported = import_paths(&database, paths).await;
    for picked in &picked {
        if let Some(folder) = picked.path.parent() {
            if let Err(error) = tokio::fs::remove_dir_all(folder).await {
                eprintln!("Cannot remove {}: {error}", folder.display());
            }
        }
    }
    let mut result = imported?;

    let delete_added = database
        .call(|connection| read_setting(connection, "extra.deleteAddedPhotos", &json!(false)))
        .await?
        .as_bool()
        .unwrap_or(false);
    result["deleted"] = json!(0);
    if !delete_added {
        return Ok(Json(result));
    }
    let ids = deletable(&picked, &result);
    if ids.is_empty() {
        return Ok(Json(result));
    }
    match library.delete(ids).await {
        Ok(deleted) => result["deleted"] = json!(deleted),
        Err(error) => result["deleteError"] = json!(error),
    }
    Ok(Json(result))
}

/// The originals of the files that were added. A name two picked files share cannot be told
/// apart in the result, so those originals stay.
fn deletable(picked: &[Picked], result: &Value) -> Vec<String> {
    let added: Vec<&str> = result["uploaded"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| file["name"].as_str())
        .collect();
    let name = |picked: &Picked| {
        picked
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    };
    let mut counts: HashMap<String, usize> = HashMap::new();
    for name in picked.iter().filter_map(name) {
        *counts.entry(name).or_default() += 1;
    }
    picked
        .iter()
        .filter_map(|picked| {
            let name = name(picked)?;
            (added.contains(&name.as_str()) && counts[&name] == 1)
                .then(|| picked.asset_id.clone())
                .flatten()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picked(name: &str, id: &str) -> Picked {
        Picked {
            path: PathBuf::from(format!("/tmp/{id}/{name}")),
            asset_id: Some(id.into()),
        }
    }

    #[test]
    fn only_added_files_with_a_unique_name_lose_their_original() {
        let picked = [
            picked("a.jpg", "A"),
            picked("b.jpg", "B"),
            picked("same.jpg", "C"),
            picked("same.jpg", "D"),
            Picked {
                path: PathBuf::from("/tmp/E/e.jpg"),
                asset_id: None,
            },
        ];
        let result = json!({"uploaded": [
            {"name": "a.jpg", "fileId": "1"},
            {"name": "same.jpg", "fileId": "2"},
            {"name": "e.jpg", "fileId": "3"}
        ], "rejected": [{"name": "b.jpg", "reason": "Unsupported file type"}]});
        assert_eq!(deletable(&picked, &result), vec!["A".to_string()]);
    }
}
