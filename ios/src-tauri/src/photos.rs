//! The photo library, through `ios/PhotoLibrary`: a Swift library the build puts in the app's
//! `Frameworks` folder, because PhotoKit has no Rust bindings in use here. The core calls the
//! picker and the deletion through the traits it registers.
// Tested on any host; only an iPhone build calls it.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]
use std::path::PathBuf;

use gooncave_core::photos::Picked;
use serde_json::Value;

/// What the Swift library answers to `gooncave_pick_photos`.
fn parse_picked(answer: &str) -> Result<Vec<Picked>, String> {
    let answer: Value = serde_json::from_str(answer).map_err(|error| error.to_string())?;
    if let Some(error) = answer["error"].as_str() {
        return Err(error.to_owned());
    }
    let files: Vec<Picked> = answer["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            Some(Picked {
                path: PathBuf::from(file["path"].as_str()?),
                asset_id: file["assetId"].as_str().map(str::to_owned),
            })
        })
        .collect();
    let failed = answer["failed"].as_u64().unwrap_or(0);
    if failed > 0 {
        eprintln!("{failed} picked photos could not be copied");
    }
    if files.is_empty() && failed > 0 {
        return Err("The photos you picked could not be read.".into());
    }
    Ok(files)
}

/// What the Swift library answers to `gooncave_delete_photos`.
fn parse_deleted(answer: &str) -> Result<usize, String> {
    let answer: Value = serde_json::from_str(answer).map_err(|error| error.to_string())?;
    match answer["error"].as_str() {
        Some(error) => Err(error.to_owned()),
        None => Ok(answer["deleted"].as_u64().unwrap_or(0) as usize),
    }
}

#[cfg(target_os = "ios")]
mod native {
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        path::PathBuf,
        sync::OnceLock,
    };

    use gooncave_core::photos::{self, Pending, PhotoLibrary, Picked};
    use libloading::Library;
    use objc2_foundation::NSBundle;
    use tokio::sync::oneshot;

    use super::{parse_deleted, parse_picked};

    type Done = unsafe extern "C" fn(*mut c_void, *const c_char);
    type Pick = unsafe extern "C" fn(Done, *mut c_void);
    type Delete = unsafe extern "C" fn(*const c_char, Done, *mut c_void);

    const LIBRARY: &str = "Frameworks/libGoonCavePhotos.dylib";
    const STOPPED: &str = "The photo library did not answer.";

    struct Swift {
        // The functions below point into it, so it stays loaded for the app's lifetime.
        _library: Library,
        pick: Pick,
        delete: Delete,
    }

    static SWIFT: OnceLock<Swift> = OnceLock::new();

    /// Loads the Swift library and registers the photo library with the core. Without the
    /// library, adding from Photos is off.
    pub fn start() {
        let path = PathBuf::from(NSBundle::mainBundle().bundlePath().to_string()).join(LIBRARY);
        // SAFETY: the library is the one this app's build embeds; it only defines its two functions.
        let loaded = unsafe {
            Library::new(&path).and_then(|library| {
                let pick = *library.get::<Pick>(b"gooncave_pick_photos\0")?;
                let delete = *library.get::<Delete>(b"gooncave_delete_photos\0")?;
                Ok(Swift {
                    _library: library,
                    pick,
                    delete,
                })
            })
        };
        match loaded {
            Ok(swift) => {
                if SWIFT.set(swift).is_ok() {
                    photos::register(Box::new(Native));
                }
            }
            Err(error) => eprintln!("Adding from Photos is off: cannot load {path:?}: {error}"),
        }
    }

    /// Called by the Swift library with its JSON answer; frees the sender `ask` gave it.
    unsafe extern "C" fn answered(context: *mut c_void, json: *const c_char) {
        // SAFETY: `context` is the sender `ask` leaked, and Swift answers once.
        let reply = unsafe { Box::from_raw(context.cast::<oneshot::Sender<String>>()) };
        // SAFETY: Swift passes a NUL-terminated string that lives through this call.
        let json = unsafe { CStr::from_ptr(json) }
            .to_string_lossy()
            .into_owned();
        let _ = reply.send(json);
    }

    fn ask(call: impl FnOnce(Done, *mut c_void)) -> Pending<String> {
        let (reply, answer) = oneshot::channel();
        call(answered, Box::into_raw(Box::new(reply)).cast());
        Box::pin(async move { answer.await.map_err(|_| STOPPED.to_owned()) })
    }

    struct Native;

    impl PhotoLibrary for Native {
        fn pick(&self) -> Pending<Vec<Picked>> {
            let swift = SWIFT.get().expect("registered after loading");
            // SAFETY: `pick` is the Swift function loaded above, called with its documented arguments.
            let answer = ask(|done, context| unsafe { (swift.pick)(done, context) });
            Box::pin(async move { parse_picked(&answer.await?) })
        }

        fn delete(&self, asset_ids: Vec<String>) -> Pending<usize> {
            let swift = SWIFT.get().expect("registered after loading");
            let ids = match serde_json::to_string(&asset_ids)
                .map_err(|error| error.to_string())
                .and_then(|ids| CString::new(ids).map_err(|error| error.to_string()))
            {
                Ok(ids) => ids,
                Err(error) => return Box::pin(async move { Err(error) }),
            };
            // SAFETY: as for `pick`; Swift reads `ids` before returning.
            let answer =
                ask(|done, context| unsafe { (swift.delete)(ids.as_ptr(), done, context) });
            Box::pin(async move { parse_deleted(&answer.await?) })
        }
    }
}

#[cfg(target_os = "ios")]
pub use native::start;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picked_files_keep_their_original_identifier() {
        let picked = parse_picked(
            r#"{"files":[{"path":"/tmp/a/IMG_1.jpg","assetId":"ABC/L0/001"},{"path":"/tmp/b/clip.mp4"}],"failed":0}"#,
        )
        .unwrap();
        assert_eq!(picked.len(), 2);
        assert_eq!(picked[0].asset_id.as_deref(), Some("ABC/L0/001"));
        assert_eq!(picked[1].asset_id, None);
    }

    #[test]
    fn closing_the_picker_picks_nothing_but_unreadable_photos_are_an_error() {
        assert!(parse_picked(r#"{"files":[],"failed":0}"#)
            .unwrap()
            .is_empty());
        assert!(parse_picked(r#"{"files":[],"failed":2}"#).is_err());
        assert_eq!(
            parse_picked(r#"{"error":"No window."}"#).err().as_deref(),
            Some("No window.")
        );
    }

    #[test]
    fn deletion_reports_the_count_or_the_reason() {
        assert_eq!(parse_deleted(r#"{"deleted":3}"#), Ok(3));
        assert_eq!(
            parse_deleted(r#"{"error":"Cancelled"}"#),
            Err("Cancelled".into())
        );
    }
}
