//! Files other apps send through the share sheet. The share extension (`ios/ShareExtension`)
//! copies them into the folder it shares with the app, one batch folder at a time; the app adds
//! them to the library when it opens or returns to the foreground.
// Tested on any host; only an iPhone build calls it.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]
use std::{
    fs, io,
    path::{Path, PathBuf},
};

use gooncave_core::{db::Database, eprintln, files::import_paths};
use serde_json::{json, Value};

/// Same default as `defaultAppGroup` in `ios/ShareExtension/ShareViewController.swift`.
#[cfg(target_os = "ios")]
const APP_GROUP: &str = "group.app.gooncave.ios";
/// Same folder as `inboxName` in `ios/ShareExtension/ShareViewController.swift`.
#[cfg(target_os = "ios")]
const INBOX: &str = "Inbox";

/// The app group named in an `embedded.mobileprovision`, a signed plist inside a binary wrapper.
/// A re-signing can rename the group the project declares, so the profile has the real name.
fn granted_group(profile: &[u8]) -> Option<String> {
    let find = |needle: &[u8]| profile.windows(needle.len()).position(|w| w == needle);
    let start = find(b"<?xml")?;
    let end = find(b"</plist>")? + b"</plist>".len();
    let value = plist::Value::from_reader_xml(io::Cursor::new(profile.get(start..end)?)).ok()?;
    let groups = value
        .as_dictionary()?
        .get("Entitlements")?
        .as_dictionary()?
        .get("com.apple.security.application-groups")?
        .as_array()?;
    let groups: Vec<&str> = groups.iter().filter_map(plist::Value::as_string).collect();
    groups
        .iter()
        .find(|group| group.contains("gooncave"))
        .or(groups.first())
        .map(|group| group.to_string())
}

/// The folder the extension writes to, or `None` when the app was installed without the app
/// group, which only a signing that grants it provides.
#[cfg(target_os = "ios")]
pub fn inbox() -> Option<PathBuf> {
    use objc2_foundation::{NSBundle, NSFileManager, NSString};
    let profile = PathBuf::from(NSBundle::mainBundle().bundlePath().to_string())
        .join("embedded.mobileprovision");
    let group = fs::read(profile)
        .ok()
        .and_then(|profile| granted_group(&profile))
        .unwrap_or_else(|| APP_GROUP.to_string());
    let root = NSFileManager::defaultManager()
        .containerURLForSecurityApplicationGroupIdentifier(&NSString::from_str(&group))?;
    Some(PathBuf::from(root.path()?.to_string()).join(INBOX))
}

/// Tells the page about added files with a `gooncave-drop` event.
#[cfg(target_os = "ios")]
pub fn tell(app: &tauri::AppHandle, detail: Value) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(crate::WINDOW) else {
        return;
    };
    // `detail` is JSON, which is also a valid JavaScript expression.
    let script =
        format!("window.dispatchEvent(new CustomEvent('gooncave-drop', {{ detail: {detail} }}))");
    if let Err(error) = window.eval(script) {
        eprintln!("Cannot tell the page about added files: {error}");
    }
}

/// The batches the extension finished, oldest first. A name starting with a dot is a batch it is
/// still writing.
fn batches(inbox: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(inbox) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut batches = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with('.') && entry.file_type()?.is_dir() {
            batches.push((entry.metadata()?.modified()?, entry.path()));
        }
    }
    batches.sort();
    Ok(batches.into_iter().map(|(_, path)| path).collect())
}

/// Every file under `folder`.
fn files(folder: &Path) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            found.extend(files(&entry.path())?);
        } else {
            found.push(entry.path());
        }
    }
    found.sort();
    Ok(found)
}

/// Adds what the extension left in `inbox` to the library, telling the page as it goes with
/// `gooncave-drop` messages (see `frontend/src/features/folders/useFileImport.ts`). A batch is
/// removed once added; when adding fails, it stays for the next attempt.
pub async fn import_shared(database: &Database, inbox: &Path, tell: impl Fn(Value)) {
    let batches = match batches(inbox) {
        Ok(batches) if batches.is_empty() => return,
        Ok(batches) => batches,
        Err(error) => {
            eprintln!("Cannot read the shared files: {error}");
            return tell(json!({"state": "failed", "error": error.to_string()}));
        }
    };
    let mut paths = Vec::new();
    for batch in &batches {
        match files(batch) {
            Ok(found) => paths.extend(found),
            Err(error) => {
                eprintln!("Cannot read the shared files: {error}");
                return tell(json!({"state": "failed", "error": error.to_string()}));
            }
        }
    }
    tell(json!({"state": "adding", "count": paths.len()}));
    match import_paths(database, paths).await {
        Ok(result) => {
            for batch in batches {
                if let Err(error) = fs::remove_dir_all(&batch) {
                    eprintln!(
                        "Cannot remove the added files in {}: {error}",
                        batch.display()
                    );
                }
            }
            tell(json!({"state": "done", "result": result}));
        }
        Err(error) => tell(json!({"state": "failed", "error": error.to_string()})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn a_batch_still_being_written_is_left_alone() {
        let inbox = tempfile::tempdir().unwrap();
        write(&inbox.path().join(".writing/0/a.png"));
        write(&inbox.path().join("done/0/b.png"));
        let found = batches(inbox.path()).unwrap();
        assert_eq!(found, vec![inbox.path().join("done")]);
    }

    #[test]
    fn the_group_comes_from_the_profile() {
        let profile = b"\x30\x82binary<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>\
            <key>Entitlements</key><dict><key>com.apple.security.application-groups</key>\
            <array><string>group.other</string><string>group.app.gooncave.ios.TEAM1</string></array>\
            </dict></dict></plist>\x00signature";
        assert_eq!(
            granted_group(profile).as_deref(),
            Some("group.app.gooncave.ios.TEAM1")
        );
        assert_eq!(granted_group(b"no profile here"), None);
    }

    #[test]
    fn a_missing_inbox_has_no_batches() {
        let inbox = tempfile::tempdir().unwrap();
        assert!(batches(&inbox.path().join("never-shared"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn files_with_the_same_name_in_one_batch_are_all_found() {
        let batch = tempfile::tempdir().unwrap();
        write(&batch.path().join("0/IMG_1.png"));
        write(&batch.path().join("1/IMG_1.png"));
        let found = files(batch.path()).unwrap();
        assert_eq!(
            found,
            vec![
                batch.path().join("0/IMG_1.png"),
                batch.path().join("1/IMG_1.png")
            ]
        );
    }
}
