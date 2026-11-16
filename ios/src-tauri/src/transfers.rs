//! Downloads of originals that go on while the app is suspended or locked, through
//! `ios/PhotoLibrary/Downloads.swift`: a background `URLSession` does the transfers and relaunches
//! the app when they finish. The core decides what to download and installs each file; it reaches
//! the session through the backend registered here.
use std::{
    ffi::{c_char, CStr, CString},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, OnceLock},
};

use gooncave_core::{
    db::Database,
    eprintln,
    transfers::{self, Outcome, Transfers},
};
use libloading::Library;
use objc2_foundation::NSBundle;
use tokio::runtime::Runtime;

type Finished = extern "C" fn(*const c_char, i32, *const c_char);
type Known = extern "C" fn(*const c_char);
type Register = unsafe extern "C" fn(Finished, Known);
type Enqueue = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *const c_char);
type Key = unsafe extern "C" fn(*const c_char);

const LIBRARY: &str = "Frameworks/libGoonCavePhotos.dylib";

struct Swift {
    // The functions below point into it, so it stays loaded for the app's lifetime.
    _library: Library,
    enqueue: Enqueue,
    cancel: Key,
    installed: Key,
}

/// What the system reported, before or after the core's library is open.
enum Event {
    Finished(String, Outcome),
    Known(String),
}

#[derive(Default)]
struct Reports {
    database: Option<Database>,
    /// Reports that arrived before the library was open, as when the system relaunches the app
    /// for a finished download.
    waiting: Vec<Event>,
}

static SWIFT: OnceLock<Swift> = OnceLock::new();
static REPORTS: Mutex<Reports> = Mutex::new(Reports {
    database: None,
    waiting: Vec::new(),
});
/// Apart from the core's runtime, which may not exist yet when the system relaunches the app.
static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("the downloads runtime starts")
});

/// Loads the Swift library, reconnects to the downloads the system kept, and registers the
/// backend with the core. Without it, originals download only while the app is open.
pub fn start() {
    let path = PathBuf::from(NSBundle::mainBundle().bundlePath().to_string()).join(LIBRARY);
    // SAFETY: the library is the one this app's build embeds; it only defines these functions.
    let loaded = unsafe {
        Library::new(&path).and_then(|library| {
            let register = *library.get::<Register>(b"gooncave_transfers_register\0")?;
            let swift = Swift {
                enqueue: *library.get::<Enqueue>(b"gooncave_transfers_enqueue\0")?,
                cancel: *library.get::<Key>(b"gooncave_transfers_cancel\0")?,
                installed: *library.get::<Key>(b"gooncave_transfers_installed\0")?,
                _library: library,
            };
            Ok((register, swift))
        })
    };
    match loaded {
        Ok((register, swift)) => {
            if SWIFT.set(swift).is_ok() {
                // SAFETY: `register` is the Swift function loaded above; the callbacks live forever.
                unsafe { register(finished, known) };
                transfers::register(Arc::new(Native));
                eprintln!("[developer] Downloads in the background are on");
            }
        }
        Err(error) => {
            eprintln!("Downloads in the background are off: cannot load {path:?}: {error}")
        }
    }
}

/// Gives the downloads the opened library and handles what the system reported before it opened.
pub fn attach(database: &Database) {
    if SWIFT.get().is_none() {
        return;
    }
    let waiting = {
        let mut reports = REPORTS.lock().unwrap_or_else(|p| p.into_inner());
        if reports.database.is_some() {
            return;
        }
        reports.database = Some(database.clone());
        std::mem::take(&mut reports.waiting)
    };
    for event in waiting {
        handle(database.clone(), event);
    }
}

fn handle(database: Database, event: Event) {
    match event {
        Event::Known(key) => transfers::pending(&database, &[key]),
        Event::Finished(key, outcome) => {
            RUNTIME.spawn(async move {
                transfers::finished(&database, &key, outcome).await;
                let Some(swift) = SWIFT.get() else { return };
                if let Ok(key) = CString::new(key) {
                    // SAFETY: the Swift function reads the C string before returning.
                    unsafe { (swift.installed)(key.as_ptr()) };
                }
            });
        }
    }
}

fn deliver(event: Event) {
    let database = {
        let mut reports = REPORTS.lock().unwrap_or_else(|p| p.into_inner());
        match &reports.database {
            Some(database) => database.clone(),
            None => {
                reports.waiting.push(event);
                return;
            }
        }
    };
    handle(database, event);
}

/// Reads a C string the Swift library passes to a callback.
///
/// # Safety
/// `text` is a valid, null-terminated string.
unsafe fn text(text: *const c_char) -> String {
    CStr::from_ptr(text).to_string_lossy().into_owned()
}

/// A download ended: 0 the file is at `detail`, 1 the iPhone is full, 2 it failed for the reason
/// in `detail`, 3 it was cancelled.
extern "C" fn finished(key: *const c_char, status: i32, detail: *const c_char) {
    // SAFETY: Swift passes null-terminated strings that stay valid for this call.
    let (key, detail) = unsafe { (text(key), text(detail)) };
    let outcome = match status {
        0 => Outcome::Done(PathBuf::from(detail)),
        1 => Outcome::Full,
        3 => Outcome::Cancelled,
        _ => Outcome::Failed(detail),
    };
    deliver(Event::Finished(key, outcome));
}

/// The system still runs the download with this key from an earlier launch.
extern "C" fn known(key: *const c_char) {
    // SAFETY: as in `finished`.
    deliver(Event::Known(unsafe { text(key) }));
}

struct Native;

impl Transfers for Native {
    fn enqueue(&self, key: &str, url: &str, headers: &[(String, String)], destination: &Path) {
        let Some(swift) = SWIFT.get() else { return };
        let headers: String = headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\n"))
            .collect();
        let arguments = (
            CString::new(key),
            CString::new(url),
            CString::new(headers),
            CString::new(destination.to_string_lossy().as_bytes()),
        );
        let (Ok(key), Ok(url), Ok(headers), Ok(destination)) = arguments else {
            eprintln!("Cannot start a download: its address or headers contain a null byte");
            deliver(Event::Finished(
                key.to_owned(),
                Outcome::Failed("The download address is not valid.".into()),
            ));
            return;
        };
        // SAFETY: `enqueue` is the Swift function loaded in `start`; it copies the strings
        // before returning.
        unsafe {
            (swift.enqueue)(
                key.as_ptr(),
                url.as_ptr(),
                headers.as_ptr(),
                destination.as_ptr(),
            )
        };
    }

    fn cancel(&self, key: &str) {
        let (Some(swift), Ok(key)) = (SWIFT.get(), CString::new(key)) else {
            return;
        };
        // SAFETY: as for `enqueue`.
        unsafe { (swift.cancel)(key.as_ptr()) };
    }
}
