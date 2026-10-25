use gooncave_core::{
    db::Database,
    http::{AssetLoader, Frontend, Server},
};
use include_dir::{include_dir, Dir};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    task::JoinHandle,
};

#[cfg(target_os = "ios")]
mod browser;
#[cfg(target_os = "ios")]
mod media;
mod photos;
mod share;

const WINDOW: &str = "main";
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
/// Where Tauri serves the bundled `ios/ui` pages on Apple platforms.
const BUNDLED_PAGES: &str = "tauri://localhost/";
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

/// The bundled page that says why the library did not open; it reads `reason` from its query.
fn error_page(reason: &str) -> Url {
    Url::parse_with_params(BUNDLED_PAGES, [("reason", reason)])
        .expect("BUNDLED_PAGES is a valid URL")
}

/// Whether the server answers a request. A connection alone proves nothing: the kernel accepts
/// it into the backlog of a listening socket whose accept loop iOS froze while suspended.
async fn answers(address: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect(address).await else {
        return false;
    };
    if stream
        .write_all(b"GET /health HTTP/1.0\r\n\r\n")
        .await
        .is_err()
    {
        return false;
    }
    let mut first = [0u8; 1];
    matches!(stream.read(&mut first).await, Ok(1))
}

/// The server answering on the saved loopback port, and what stops it.
struct Serving {
    address: SocketAddr,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

/// The core for the app's lifetime. The database stays open; only the server restarts.
struct Core {
    runtime: tokio::runtime::Runtime,
    data: PathBuf,
    database: Mutex<Option<Database>>,
    serving: Mutex<Option<Serving>>,
    /// The library's address. The saved port keeps it the same across restarts.
    origin: OnceLock<String>,
    /// Held while shared files are added, so two openings of the app do not add them twice.
    #[cfg(target_os = "ios")]
    sharing: tokio::sync::Mutex<()>,
}

impl Core {
    /// Opens the library if needed and serves it. Returns the origin to load.
    fn start(&self) -> Result<String, String> {
        let mut database = self.database.lock().unwrap_or_else(|p| p.into_inner());
        if database.is_none() {
            let library = self.data.join("library");
            *database = Some(Database::open(&self.data, &library).map_err(|e| e.to_string())?);
        }
        let database = database.clone().expect("opened above");
        let assets: AssetLoader = Arc::new(frontend_asset);
        let server = self
            .runtime
            .block_on(Server::bind(database, 0, Frontend::Embedded(assets)))
            .map_err(|e| e.to_string())?;
        let origin = server.origin.clone();
        let address = server.listener.local_addr().map_err(|e| e.to_string())?;
        let (shutdown, receiver) = oneshot::channel();
        let task = self.runtime.spawn(async move {
            if let Err(error) = server.serve(receiver).await {
                eprintln!("Local core stopped: {error}");
            }
        });
        let _ = self.origin.set(origin.clone());
        *self.serving.lock().unwrap_or_else(|p| p.into_inner()) = Some(Serving {
            address,
            shutdown,
            task,
        });
        Ok(origin)
    }

    /// iOS may take back a listening socket while the app is suspended (Apple TN2277).
    /// When the server no longer answers, start it again on the same port, or show why not.
    fn revive(self: &Arc<Self>, app: AppHandle) {
        let address = (self.serving.lock().unwrap_or_else(|p| p.into_inner()))
            .as_ref()
            .map(|serving| serving.address);
        let Some(address) = address else { return };
        let core = self.clone();
        self.runtime.spawn(async move {
            if tokio::time::timeout(PROBE_TIMEOUT, answers(address))
                .await
                .is_ok_and(|answered| answered)
            {
                return;
            }
            let stale = core
                .serving
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            let Some(stale) = stale else { return };
            // A graceful stop waits for open connections, and the web view's frozen ones can
            // keep it waiting for seconds. The old server is dead; drop it and bind again.
            stale.task.abort();
            let _ = stale.task.await;
            let restarted = match tokio::task::spawn_blocking(move || core.start()).await {
                Ok(restarted) => restarted,
                Err(error) => Err(error.to_string()),
            };
            if let Err(reason) = restarted {
                eprintln!("Cannot restart the local core: {reason}");
                if let Some(window) = app.get_webview_window(WINDOW) {
                    if let Err(error) = window.navigate(error_page(&reason)) {
                        eprintln!("Cannot show why the library did not open: {error}");
                    }
                }
            }
        });
    }

    /// Back in the foreground: serves again if iOS took the socket, then adds what was shared.
    fn resumed(self: &Arc<Self>, app: AppHandle) {
        self.revive(app.clone());
        #[cfg(target_os = "ios")]
        self.import_shared(app);
    }

    /// Adds the files other apps sent through the share sheet.
    #[cfg(target_os = "ios")]
    fn import_shared(self: &Arc<Self>, app: AppHandle) {
        let Some(inbox) = share::inbox() else { return };
        let database = self
            .database
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let Some(database) = database else { return };
        let core = self.clone();
        self.runtime.spawn(async move {
            let Ok(_adding) = core.sharing.try_lock() else {
                return;
            };
            share::import_shared(&database, &inbox, |detail| share::tell(&app, detail)).await;
        });
    }

    fn stop(&self) {
        let serving = self
            .serving
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(serving) = serving {
            let _ = serving.shutdown.send(());
            let _ = self.runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(10), serving.task).await
            });
        }
    }
}

/// Whether a navigation stays on the library's own pages.
fn is_app_url(url: &Url, origin: &str) -> bool {
    url.origin().ascii_serialization() == origin
}

/// Opens the library again from the error page.
#[tauri::command]
fn retry(window: WebviewWindow, core: tauri::State<'_, Arc<Core>>) -> Result<(), String> {
    let origin = Url::parse(&core.start()?).map_err(|e| e.to_string())?;
    window.navigate(origin).map_err(|e| e.to_string())
}

/// Gives the FurAffinity browser the window's view controller, where its sheets open.
#[cfg(target_os = "ios")]
fn start_browser(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|platform| {
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return eprintln!(
                "FurAffinity is unavailable: its browser must start on the main thread."
            );
        };
        // SAFETY: `view_controller` is the window's live UIViewController.
        let root = unsafe {
            objc2::rc::Retained::retain(
                platform
                    .view_controller()
                    .cast::<objc2_ui_kit::UIViewController>(),
            )
        };
        match root {
            Some(root) => browser::start(root, mtm),
            None => eprintln!("FurAffinity is unavailable: the window has no view controller."),
        }
    })
}

/// Opens the window on the bundled "opening" page and the library on another thread: opening
/// can repair the database after an update, and iOS ends an app whose launch blocks too long.
fn open_window(app: &tauri::App, core: &Arc<Core>) -> Result<(), Box<dyn std::error::Error>> {
    let opening = Url::parse(&format!("{BUNDLED_PAGES}?opening"))?;
    let opener = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::CustomProtocol(opening))
        .on_navigation(move |url| {
            let app_page = url.scheme() == "tauri"
                || opener
                    .try_state::<Arc<Core>>()
                    .and_then(|core| core.origin.get().map(|origin| is_app_url(url, origin)))
                    .unwrap_or(false);
            if app_page {
                return true;
            }
            // Booru links open in Safari; anything else leaving the app is dropped.
            if matches!(url.scheme(), "https" | "http") {
                if let Err(error) = opener.opener().open_url(url.as_str(), None::<&str>) {
                    eprintln!("Cannot open {url} in Safari: {error}");
                }
            }
            false
        })
        .build()?;
    #[cfg(target_os = "ios")]
    {
        start_browser(&window)?;
    }
    let core = core.clone();
    #[cfg(target_os = "ios")]
    let app = app.handle().clone();
    std::thread::spawn(move || {
        let page = match core.start() {
            Ok(origin) => Url::parse(&origin).map_err(|e| e.to_string()),
            Err(reason) => Err(reason),
        }
        .unwrap_or_else(|reason| error_page(&reason));
        if let Err(error) = window.navigate(page) {
            eprintln!("Cannot leave the opening page: {error}");
        }
        #[cfg(target_os = "ios")]
        core.import_shared(app);
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![retry])
        .setup(|app| {
            #[cfg(target_os = "ios")]
            gooncave_core::decoder::register(Box::new(media::Native));
            #[cfg(target_os = "ios")]
            photos::start();
            let core = Arc::new(Core {
                runtime: tokio::runtime::Runtime::new()?,
                data: app.path().app_data_dir()?,
                database: Mutex::default(),
                serving: Mutex::default(),
                origin: OnceLock::new(),
                #[cfg(target_os = "ios")]
                sharing: tokio::sync::Mutex::new(()),
            });
            app.manage(core.clone());
            open_window(app, &core)
        })
        .build(tauri::generate_context!())
        .expect("GoonCave could not start its window");
    app.run(|app, event| {
        let Some(core) = app.try_state::<Arc<Core>>() else {
            return;
        };
        match event {
            RunEvent::Resumed => core.resumed(app.clone()),
            // `RunEvent::Resumed` starts an event-loop poll. The return to the foreground
            // arrives as the window's own `Resumed`, which exists on mobile only.
            #[cfg(mobile)]
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::Resumed,
                ..
            } => core.resumed(app.clone()),
            RunEvent::Exit => core.stop(),
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_origin_stays_inside_the_window() {
        let origin = "http://127.0.0.1:3976";
        let inside = |raw: &str| is_app_url(&raw.parse().unwrap(), origin);
        assert!(inside("http://127.0.0.1:3976/app/gallery"));
        assert!(!inside("http://127.0.0.1:39761/"));
        assert!(!inside("http://127.0.0.1:3976@evil.test/"));
        assert!(!inside("https://e621.net/posts/1"));
    }

    #[test]
    fn app_routes_serve_the_index_and_assets_keep_their_type() {
        assert_eq!(frontend_asset("/app/gallery").unwrap().1, "text/html");
        assert_eq!(frontend_asset("/missing.js"), None);
    }

    #[test]
    fn the_error_page_carries_the_reason() {
        let page = error_page("disk full & locked");
        assert_eq!(page.scheme(), "tauri");
        let reason = page
            .query_pairs()
            .find(|(key, _)| key == "reason")
            .unwrap()
            .1;
        assert_eq!(reason, "disk full & locked");
    }
}
