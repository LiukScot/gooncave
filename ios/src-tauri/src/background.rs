//! Work that goes on while the app is not in the foreground, through `ios/PhotoLibrary/Background.swift`:
//! a pass of the core when iOS wakes the app, and, on iOS 26, a favorites sync the person started
//! that iOS lets finish after they leave. The Swift library holds the iOS side; this file runs the core.
use std::{
    ffi::c_char,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex, OnceLock,
    },
    time::Duration,
};

use gooncave_core::{background, db::Database, eprintln};
use libloading::Library;
use objc2_foundation::NSBundle;
use tokio::{runtime::Runtime, task::JoinHandle};

type Signal = extern "C" fn();
type Launched = extern "C" fn(bool);
type Register = unsafe extern "C" fn(Launched, Signal, Signal, Signal);
type Finish = unsafe extern "C" fn(bool);
type Begin = unsafe extern "C" fn(*const c_char, *const c_char);
type Progress = unsafe extern "C" fn(u64, u64);

const LIBRARY: &str = "Frameworks/libGoonCavePhotos.dylib";
const POLL: Duration = Duration::from_secs(1);

struct Swift {
    // The functions below point into it, so it stays loaded for the app's lifetime.
    _library: Library,
    finish: Finish,
    uploaded: unsafe extern "C" fn(),
    begin: Begin,
    progress: Progress,
    end: Finish,
}

static SWIFT: OnceLock<Swift> = OnceLock::new();
static DATABASE: OnceLock<Database> = OnceLock::new();
/// The pass iOS asked for, while it runs.
static PASS: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
/// iOS gave a long processing window, which the pass keeps while tagging or originals have work.
static LONG: AtomicBool = AtomicBool::new(false);
/// Apart from the core's runtime, which does not exist yet when iOS may launch a task.
static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("the background runtime starts")
});

/// Loads the Swift library and hands iOS the launch handlers of the background tasks. iOS
/// requires this before the app finishes launching, so it runs before the window is built.
pub fn register() {
    let path = PathBuf::from(NSBundle::mainBundle().bundlePath().to_string()).join(LIBRARY);
    // SAFETY: the library is the one this app's build embeds; it only defines these functions.
    let loaded = unsafe {
        Library::new(&path).and_then(|library| {
            let register = *library.get::<Register>(b"gooncave_background_register\0")?;
            let swift = Swift {
                finish: *library.get::<Finish>(b"gooncave_background_finish\0")?,
                uploaded: *library
                    .get::<unsafe extern "C" fn()>(b"gooncave_background_uploaded\0")?,
                begin: *library.get::<Begin>(b"gooncave_continued_begin\0")?,
                progress: *library.get::<Progress>(b"gooncave_continued_progress\0")?,
                end: *library.get::<Finish>(b"gooncave_continued_end\0")?,
                _library: library,
            };
            Ok((register, swift))
        })
    };
    match loaded {
        Ok((register, swift)) => {
            if SWIFT.set(swift).is_ok() {
                // SAFETY: `register` is the Swift function loaded above; the callbacks live forever.
                unsafe { register(launched, expired, cancelled, left) };
                eprintln!("[developer] Background tasks are registered");
            }
        }
        Err(error) => eprintln!("Background tasks are off: cannot load {path:?}: {error}"),
    }
}

/// Gives the background work the opened library. A manual favorites sync is followed from here.
pub fn attach(database: &Database) {
    if SWIFT.get().is_none() || DATABASE.set(database.clone()).is_err() {
        return;
    }
    RUNTIME.spawn(follow_manual_syncs(database.clone()));
}

/// Shows each sync the person starts as an iOS 26 task, so it goes on after they leave the app.
async fn follow_manual_syncs(database: Database) {
    let Some(swift) = SWIFT.get() else { return };
    loop {
        background::manual_sync_started(&database).await;
        // SAFETY: the Swift functions take C strings it reads before returning, and plain numbers.
        unsafe {
            (swift.begin)(
                c"Syncing favorites".as_ptr(),
                c"Reading your favorites".as_ptr(),
            )
        };
        while let Some((done, total)) = background::favorites_progress(&database) {
            unsafe { (swift.progress)(done, total) };
            tokio::time::sleep(POLL).await;
        }
        unsafe { (swift.end)(true) };
    }
}

/// iOS woke the app for a task: runs one pass, then tells iOS it is done. `long` is a processing
/// task, given minutes while the phone charges.
extern "C" fn launched(long: bool) {
    if long {
        LONG.store(true, Ordering::Relaxed);
    }
    let mut pass = PASS.lock().unwrap_or_else(|p| p.into_inner());
    // The pass that is running completes every task iOS has launched.
    if pass.as_ref().is_some_and(|pass| !pass.is_finished()) {
        return;
    }
    *pass = Some(RUNTIME.spawn(async {
        let database = opened().await;
        background::refresh(&database).await;
        while LONG.load(Ordering::Relaxed) && background::working(&database).await {
            tokio::time::sleep(POLL).await;
        }
        LONG.store(false, Ordering::Relaxed);
        if let Some(swift) = SWIFT.get() {
            // SAFETY: the Swift function loaded in `register`.
            unsafe { (swift.finish)(true) };
        }
    }));
}

/// The app left the screen: uploads its last changes in the time iOS gives, then says so.
extern "C" fn left() {
    RUNTIME.spawn(async {
        if let Some(database) = DATABASE.get() {
            background::upload(database).await;
        }
        if let Some(swift) = SWIFT.get() {
            // SAFETY: the Swift function loaded in `register`.
            unsafe { (swift.uploaded)() };
        }
    });
}

/// A task may fire before the window's setup has opened the library; the expiry ends the wait.
async fn opened() -> Database {
    loop {
        if let Some(database) = DATABASE.get() {
            return database.clone();
        }
        tokio::time::sleep(POLL).await;
    }
}

/// iOS is taking the time back: drops the pass. A favorites sync it started stays "running" while
/// the app is suspended and goes on at the next wake, so it is not cancelled here.
extern "C" fn expired() {
    LONG.store(false, Ordering::Relaxed);
    let pass = PASS.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(pass) = pass {
        pass.abort();
    }
}

/// The person stopped the continued sync from the Lock Screen, or iOS ended it.
extern "C" fn cancelled() {
    if let Some(database) = DATABASE.get() {
        background::cancel_favorites(database);
    }
}
