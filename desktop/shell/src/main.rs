//! The desktop app's core process. The Electron window starts it and talks to it over
//! stdin and stdout, one JSON object per line:
//!
//! - out `{"ready": origin, "scripts": {…}}` once the core serves the app at `origin`;
//! - out `{"id": n, "fetch": {…}}`, `{"id": n, "file": {…}}` and `{"id": n, "signIn": {…}}` for the hidden browser,
//!   answered in with `{"id": n, "ok": …}` or `{"id": n, "error": "unreachable" | "closed"}`;
//! - out `{"failed": {"title", "detail"}}` before exiting when the core cannot run;
//! - in `{"log": "line"}` adds a line of the window process to the app log.
//! - in `{"close": true}`, or the end of stdin, uploads the last sync changes and exits.
//!
//! Anything else the core prints goes to stderr.
use gooncave_core::{
    app_log,
    browser::{
        cookie_domain, cookie_pairs, media_origin, origin, site, Browser, FilePage, Page, Pending,
        CHALLENGED, FETCH, FETCH_FILE, STOPPED, UNREACHABLE, USERNAME,
    },
    db::Database,
    eprintln,
    http::{AssetLoader, Frontend, Server},
};
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::AsyncBufReadExt,
    sync::{mpsc, oneshot},
};

const APP_ID: &str = "app.gooncave.desktop";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);
const BLOCKING_WORK_TIMEOUT: Duration = Duration::from_secs(2);
static FRONTEND: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../frontend/dist");

fn frontend_asset(path: &str) -> Option<(Vec<u8>, String)> {
    let path = if path == "/" || path == "/app" || path.starts_with("/app/") {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };
    let file = FRONTEND.get_file(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some((file.contents().to_vec(), mime.to_string()))
}

/// Writes one message line to the window.
fn send(message: &Value) {
    let mut out = std::io::stdout().lock();
    if let Err(error) = writeln!(out, "{message}").and_then(|()| out.flush()) {
        eprintln!("Cannot reach the GoonCave window: {error}");
    }
}

fn fail(title: &str, detail: &str) {
    send(&json!({"failed": {"title": title, "detail": detail}}));
}

/// The hidden browser in the Electron window, reached through [`send`].
struct Remote {
    next: AtomicU64,
    /// `None` once the window closed: it answers nothing after its close request.
    waiting: Mutex<Option<HashMap<u64, oneshot::Sender<Value>>>>,
}

impl Default for Remote {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(0),
            waiting: Mutex::new(Some(HashMap::new())),
        }
    }
}

impl Remote {
    /// Sends `request` under a new id; the receiver yields the reply line, or an error once
    /// the window has closed.
    fn ask(&self, request: Value) -> oneshot::Receiver<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        match self
            .waiting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            Some(waiting) => waiting.insert(id, reply),
            None => return answer,
        };
        let mut message = request;
        message["id"] = id.into();
        send(&message);
        answer
    }

    fn answer(&self, reply: Value) {
        let Some(id) = reply.get("id").and_then(Value::as_u64) else {
            return eprintln!("The GoonCave window sent a reply without an id: {reply}");
        };
        let waiting = self
            .waiting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .and_then(|waiting| waiting.remove(&id));
        match waiting {
            Some(waiting) => {
                let _ = waiting.send(reply);
            }
            None => eprintln!("The GoonCave window answered request {id}, which is not waiting."),
        }
    }

    /// Fails every waiting and later request, so none holds up the shutdown.
    fn close(&self) {
        self.waiting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }
}

/// The `ok` value of a reply, or the message for its error; `closed` names the site's message.
fn outcome(reply: Result<Value, oneshot::error::RecvError>, closed: &str) -> Result<Value, String> {
    let mut reply = reply.map_err(|_| STOPPED.to_owned())?;
    match reply.get("error").and_then(Value::as_str) {
        Some("closed") => Err(closed.to_owned()),
        Some(_) => Err(UNREACHABLE.to_owned()),
        None => reply
            .get_mut("ok")
            .map(Value::take)
            .ok_or_else(|| UNREACHABLE.to_owned()),
    }
}

struct Window(Arc<Remote>);

impl Browser for Window {
    fn fetch(&self, url: String, cookie: Option<String>) -> Pending<Page> {
        let (Some(origin), Some(site)) = (origin(&url), site(&url)) else {
            return Box::pin(async { Err(UNREACHABLE.to_owned()) });
        };
        let cookies: Vec<_> = cookie
            .as_deref()
            .map(|header| cookie_pairs(header).collect())
            .unwrap_or_default();
        let answer = self.0.ask(json!({"fetch": {
            "url": url,
            "origin": origin,
            "domain": cookie_domain(origin),
            "cookies": cookies,
            "check": {"title": site.check_title(), "message": site.check_message()},
        }}));
        let closed = site.check_closed();
        Box::pin(async move {
            let page = outcome(answer.await, &closed)?;
            Ok(Page {
                status: page
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|status| u16::try_from(status).ok())
                    .ok_or_else(|| UNREACHABLE.to_owned())?,
                body: page
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
    }

    fn fetch_file(&self, url: String) -> Pending<Option<FilePage>> {
        let Some((site, origin)) = media_origin(&url) else {
            return Box::pin(async { Ok(None) });
        };
        let answer = self.0.ask(json!({"file": {
            "url": url,
            "origin": origin,
            "domain": cookie_domain(&origin),
            "check": {"title": site.check_title(), "message": site.check_message()},
        }}));
        let closed = site.check_closed();
        Box::pin(async move {
            let file = outcome(answer.await, &closed)?;
            let status = file
                .get("status")
                .and_then(Value::as_u64)
                .and_then(|status| u16::try_from(status).ok())
                .ok_or_else(|| UNREACHABLE.to_owned())?;
            let body = file
                .get("body")
                .and_then(Value::as_str)
                .ok_or_else(|| UNREACHABLE.to_owned())
                .and_then(|body| {
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body)
                        .map_err(|_| UNREACHABLE.to_owned())
                })?;
            Ok(Some(FilePage { status, body }))
        })
    }

    fn sign_in(&self, base: String) -> Pending<Option<(String, Option<String>)>> {
        let base = base.trim_end_matches('/').to_owned();
        let Some(site) = site(&base) else {
            return Box::pin(async { Err(UNREACHABLE.to_owned()) });
        };
        let answer = self.0.ask(json!({"signIn": {
            "base": base,
            "login": site.login,
            "title": site.sign_in_title(),
            "message": site.sign_in_message(),
            "session": site.session,
            "account": site.account,
        }}));
        Box::pin(async move {
            let signed_in = outcome(answer.await, UNREACHABLE)?;
            if signed_in.is_null() {
                return Ok(None);
            }
            let session = signed_in
                .get("session")
                .and_then(Value::as_str)
                .filter(|session| !session.is_empty())
                .ok_or_else(|| UNREACHABLE.to_owned())?;
            let username = signed_in
                .get("username")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_owned);
            Ok(Some((session.to_owned(), username)))
        })
    }
}

/// `$XDG_DATA_HOME/app.gooncave.desktop`, where earlier versions kept the library too.
fn data_directory() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
        })?;
    Some(base.join(APP_ID))
}

/// Reads the window's lines: replies go to `remote`, and the first close request or the end
/// of stdin is sent on `close`.
async fn read_window(remote: Arc<Remote>, close: mpsc::Sender<()>) {
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                Ok(message) if message.get("close").is_some() => break,
                Ok(message) if message.get("log").is_some() => {
                    app_log::record(message["log"].as_str().unwrap_or("unreadable log line"));
                }
                Ok(message) => remote.answer(message),
                Err(error) => eprintln!("The GoonCave window sent an unreadable line: {error}"),
            },
            Ok(None) => break,
            Err(error) => {
                eprintln!("Cannot read from the GoonCave window: {error}");
                break;
            }
        }
    }
    remote.close();
    let _ = close.send(()).await;
}

async fn run(pictures: Option<PathBuf>) -> Result<(), ()> {
    let Some(directory) = data_directory() else {
        fail(
            "Library unavailable",
            "GoonCave could not find your home folder. Open GoonCave again from your desktop.",
        );
        return Err(());
    };
    // The library lives in the app's own data folder. Earlier versions kept it in Pictures,
    // which the Flatpak manifest still grants (xdg-pictures/gooncave) so it can be moved here.
    let library = directory.join("library");
    let database = match pictures {
        Some(pictures) => Database::open_moving(&directory, &library, &pictures.join("gooncave")),
        None => Database::open(&directory, &library),
    };
    let database = match database {
        Ok(database) => database,
        Err(error) => {
            eprintln!("Unable to open local library: {error}");
            fail("Library unavailable", "GoonCave could not open your library. Close other copies of GoonCave, check free disk space and permissions for the app's data folder, then open GoonCave again. Your saved data has not been deleted.");
            return Err(());
        }
    };
    let assets: AssetLoader = Arc::new(frontend_asset);
    let server = match Server::bind(database.clone(), 0, Frontend::Embedded(assets)).await {
        Ok(server) => server,
        Err(error) => {
            eprintln!("Unable to start the local core: {error}");
            fail("Library unavailable", &format!("GoonCave could not start its library ({error}). Open GoonCave again. Your saved data has not been deleted."));
            return Err(());
        }
    };
    let remote = Arc::new(Remote::default());
    gooncave_core::browser::register(Box::new(Window(remote.clone())));
    send(&json!({
        "ready": server.origin,
        "scripts": {"fetch": FETCH, "file": FETCH_FILE, "challenged": CHALLENGED, "username": USERNAME},
    }));
    let (shutdown, stopped) = oneshot::channel();
    let mut task = tokio::spawn(server.serve(stopped));
    let (close, mut closing) = mpsc::channel(1);
    tokio::spawn(read_window(remote, close));
    tokio::select! {
        result = &mut task => {
            let error = match result {
                Ok(Ok(())) => "the local server ended".to_owned(),
                Ok(Err(error)) => error.to_string(),
                Err(error) => error.to_string(),
            };
            eprintln!("Local core stopped: {error}");
            fail("GoonCave stopped", &format!("The local library stopped working ({error}). Open GoonCave again. Your saved data has not been deleted."));
            return Err(());
        }
        _ = closing.recv() => {}
    }
    database.upload_before_close().await;
    let _ = shutdown.send(());
    match tokio::time::timeout(SHUTDOWN_TIMEOUT, task).await {
        Ok(Ok(Ok(()))) => Ok(()),
        result => {
            eprintln!("Local core did not finish shutdown cleanly: {result:?}");
            Err(())
        }
    }
}

fn main() -> std::process::ExitCode {
    // `--pictures <folder>`: the Pictures folder, where earlier versions kept the library.
    let mut arguments = std::env::args().skip(1);
    let mut pictures = None;
    while let Some(argument) = arguments.next() {
        match (argument.as_str(), arguments.next()) {
            ("--pictures", Some(folder)) => pictures = Some(PathBuf::from(folder)),
            _ => {
                eprintln!(
                    "Usage: gooncave-desktop [--pictures <folder>]. The GoonCave window starts it."
                );
                return std::process::ExitCode::FAILURE;
            }
        }
    }
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Cannot start the core runtime: {error}");
            fail("Library unavailable", "GoonCave could not start its library. Open GoonCave again. Your saved data has not been deleted.");
            return std::process::ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(run(pictures));
    // A disconnected request can leave its SQLite blocking task running. Work cut off
    // after this wait loses nothing: SQLite rolls back an unfinished transaction.
    runtime.shutdown_timeout(BLOCKING_WORK_TIMEOUT);
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(()) => std::process::ExitCode::FAILURE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_routes_serve_the_index_and_assets_keep_their_type() {
        assert_eq!(frontend_asset("/app/gallery").unwrap().1, "text/html");
        assert_eq!(
            frontend_asset("/manifest.webmanifest").unwrap().1,
            "application/manifest+json"
        );
        assert_eq!(frontend_asset("/missing.js"), None);
    }

    #[test]
    fn replies_reach_the_request_with_their_id() {
        let remote = Remote::default();
        let first = remote.ask(json!({"fetch": {}}));
        let mut second = remote.ask(json!({"fetch": {}}));
        remote.answer(json!({"id": 0, "ok": {"status": 200}}));
        let reply = first.blocking_recv();
        assert_eq!(outcome(reply, "closed").unwrap(), json!({"status": 200}));
        assert!(second.try_recv().is_err());
    }

    #[test]
    fn requests_fail_once_the_window_closes() {
        let remote = Remote::default();
        let waiting = remote.ask(json!({"fetch": {}}));
        remote.close();
        assert_eq!(
            outcome(waiting.blocking_recv(), "closed"),
            Err(STOPPED.into())
        );
        let later = remote.ask(json!({"fetch": {}}));
        assert_eq!(
            outcome(later.blocking_recv(), "closed"),
            Err(STOPPED.into())
        );
    }

    #[test]
    fn errors_become_messages_for_the_person() {
        let (sender, receiver) = oneshot::channel();
        sender.send(json!({"id": 1, "error": "closed"})).unwrap();
        assert_eq!(
            outcome(receiver.blocking_recv(), "check closed"),
            Err("check closed".into())
        );
        let (sender, receiver) = oneshot::channel();
        sender.send(json!({"id": 1, "error": "anything"})).unwrap();
        assert_eq!(
            outcome(receiver.blocking_recv(), "check closed"),
            Err(UNREACHABLE.into())
        );
        let (sender, receiver) = oneshot::channel::<Value>();
        drop(sender);
        assert_eq!(
            outcome(receiver.blocking_recv(), "check closed"),
            Err(STOPPED.into())
        );
    }
}
