//! Downloads the iPhone keeps doing while the app is suspended or locked, which only the shell can
//! start (a background `URLSession`). A shell registers its backend here; the core decides which
//! files to fetch and from where, and checks and installs each file when the shell hands it back.
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use crate::db::Database;

pub trait Transfers: Send + Sync {
    /// Downloads `url` with `headers` and moves the finished file to `destination`, replacing
    /// what is there. The transfer goes on while the app is suspended, and the app is woken to
    /// report it through [`finished`] with the same `key`. Does nothing when a transfer with this
    /// key is already running.
    fn enqueue(&self, key: &str, url: &str, headers: &[(String, String)], destination: &Path);
    /// Stops the transfer with `key`, if one is running.
    fn cancel(&self, key: &str);
}

/// How a transfer ended.
pub enum Outcome {
    /// The file is complete at this path, which the core now owns.
    Done(PathBuf),
    /// The iPhone has no room for the file.
    Full,
    /// The server refused, or the transfer broke; the text says why.
    Failed(String),
    /// The core or the system stopped it; the file is downloaded again if it is still wanted.
    Cancelled,
}

static BACKEND: OnceLock<Arc<dyn Transfers>> = OnceLock::new();

#[cfg(test)]
thread_local! {
    // Each test runs on its own thread, so a fake backend never reaches another test.
    static FAKE: std::cell::RefCell<Option<Arc<dyn Transfers>>> = const { std::cell::RefCell::new(None) };
}

/// Registers the backend once at startup; later calls are ignored.
pub fn register(backend: Arc<dyn Transfers>) {
    let _ = BACKEND.set(backend);
}

#[cfg(not(test))]
pub(crate) fn get() -> Option<Arc<dyn Transfers>> {
    BACKEND.get().cloned()
}

#[cfg(test)]
pub(crate) fn get() -> Option<Arc<dyn Transfers>> {
    FAKE.with(|fake| fake.borrow().clone())
}

#[cfg(test)]
pub(crate) fn use_fake(backend: Arc<dyn Transfers>) {
    FAKE.with(|fake| *fake.borrow_mut() = Some(backend));
}

/// Reports a transfer the backend finished. The core checks the file and adds it to the library,
/// or notes why it could not.
pub async fn finished(database: &Database, key: &str, outcome: Outcome) {
    crate::originals::transfer_finished(database, key, outcome).await;
}

/// Tells the core which transfers the system still runs from an earlier launch of the app, by
/// key, so it does not start them again.
pub fn pending(database: &Database, keys: &[String]) {
    crate::originals::transfers_pending(database, keys);
}
