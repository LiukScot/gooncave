use gooncave_core::{
    db::Database,
    http::{AssetLoader, Frontend, Server},
};
use gtk4::{glib, prelude::*};
use include_dir::{include_dir, Dir};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use webkit6::{prelude::*, NavigationPolicyDecision, PolicyDecisionType, WebView};

mod browser;
mod import;

const APP_ID: &str = "app.gooncave.desktop";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);
static FRONTEND: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../frontend/dist");

struct CoreRuntime {
    runtime: Mutex<Option<tokio::runtime::Runtime>>,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<std::io::Result<()>>>>,
}

impl CoreRuntime {
    fn handle(&self) -> Option<tokio::runtime::Handle> {
        let runtime = self.runtime.lock().unwrap_or_else(|p| p.into_inner());
        runtime.as_ref().map(|runtime| runtime.handle().clone())
    }

    fn stop(&self) {
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        let shutdown = match self.shutdown.lock() {
            Ok(mut shutdown) => shutdown.take(),
            Err(error) => {
                eprintln!("Unable to signal local core shutdown: {error}");
                return;
            }
        };
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(());
        }
        let task = match self.task.lock() {
            Ok(mut task) => task.take(),
            Err(error) => {
                eprintln!("Unable to await local core shutdown: {error}");
                return;
            }
        };
        let runtime = match self.runtime.lock() {
            Ok(mut runtime) => runtime.take(),
            Err(error) => {
                eprintln!("Unable to stop core runtime: {error}");
                return;
            }
        };
        if let Some(runtime) = runtime {
            if let Some(task) = task {
                match runtime.block_on(async { tokio::time::timeout(SHUTDOWN_TIMEOUT, task).await })
                {
                    Ok(Ok(Ok(()))) => {}
                    result => eprintln!("Local core did not finish shutdown cleanly: {result:?}"),
                }
            }
            // A disconnected request can leave its SQLite blocking task running.
            runtime.shutdown_timeout(deadline.saturating_duration_since(Instant::now()));
        }
    }
}

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

/// Starts the core on a loopback port. Returns its origin, the runtime to stop
/// on exit, a receiver that yields a message if the core stops on its own, and
/// the database for the windows.
#[allow(clippy::type_complexity)]
fn start_core() -> Result<
    (
        String,
        CoreRuntime,
        tokio::sync::oneshot::Receiver<String>,
        Database,
    ),
    Box<dyn std::error::Error>,
> {
    let runtime = tokio::runtime::Runtime::new()?;
    let directory = glib::user_data_dir().join(APP_ID);
    // The library lives in the app's own data folder. Earlier versions kept it in Pictures,
    // which the Flatpak manifest still grants (xdg-pictures/gooncave) so it can be moved here.
    let library = directory.join("library");
    let database = match glib::user_special_dir(glib::UserDirectory::Pictures) {
        Some(pictures) => Database::open_moving(&directory, &library, &pictures.join("gooncave"))?,
        None => Database::open(&directory, &library)?,
    };
    let assets: AssetLoader = Arc::new(frontend_asset);
    let status = database.clone();
    let server = runtime.block_on(Server::bind(database, 0, Frontend::Embedded(assets)))?;
    let origin = server.origin.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let (failed, failure) = tokio::sync::oneshot::channel();
    let task = runtime.spawn(async move {
        let result = server.serve(receiver).await;
        if let Err(error) = &result {
            eprintln!("Local core stopped: {error}");
            let _ = failed.send(error.to_string());
        }
        result
    });
    Ok((
        origin,
        CoreRuntime {
            runtime: Mutex::new(Some(runtime)),
            shutdown: Mutex::new(Some(sender)),
            task: Mutex::new(Some(task)),
        },
        failure,
        status,
    ))
}

/// Shows `detail` and closes the app when the reader dismisses it.
fn fail(app: &gtk4::Application, message: &str, detail: &str) {
    // Keeps the app running while no window is open.
    std::mem::forget(app.hold());
    let dialog = gtk4::AlertDialog::builder()
        .message(message)
        .detail(detail)
        .buttons(["Close GoonCave"])
        .build();
    dialog.choose(
        app.active_window().as_ref(),
        gtk4::gio::Cancellable::NONE,
        |_| std::process::exit(1),
    );
}

/// Whether a navigation stays inside the app: its own pages, and the blob:
/// URLs the page makes for downloads, which carry the same origin.
fn is_app_uri(uri: &str, origin: &str) -> bool {
    uri.strip_prefix("blob:")
        .unwrap_or(uri)
        .strip_prefix(origin)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The folder an `{origin}/open-folder?path=…` link asks to show in the file manager.
fn open_folder_path(uri: &str, origin: &str) -> Option<std::path::PathBuf> {
    let path = uri
        .strip_prefix(origin)?
        .strip_prefix("/open-folder?path=")?;
    glib::Uri::unescape_string(path, None::<&str>).map(|path| path.as_str().into())
}

/// What a window needs from the running core.
#[derive(Clone)]
struct Core {
    origin: String,
    database: Database,
    runtime: tokio::runtime::Handle,
}

fn open_window(app: &gtk4::Application, core: &Core) {
    let origin = core.origin.as_str();
    let window = gtk4::ApplicationWindow::new(app);
    window.set_title(Some("GoonCave"));
    window.set_default_size(1200, 800);
    let view = WebView::new();
    if let Some(settings) = WebViewExt::settings(&view) {
        settings.set_enable_developer_extras(cfg!(debug_assertions));
        settings.set_enable_write_console_messages_to_stdout(cfg!(debug_assertions));
    }
    let origin_owned = origin.to_owned();
    view.connect_decide_policy(move |view, decision, kind| {
        if !matches!(
            kind,
            PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction
        ) {
            return false;
        }
        let Some(mut action) = decision
            .downcast_ref::<NavigationPolicyDecision>()
            .and_then(|decision| decision.navigation_action())
        else {
            return false;
        };
        let uri = action
            .request()
            .and_then(|request| request.uri())
            .map(|uri| uri.to_string())
            .unwrap_or_default();
        let folder = open_folder_path(&uri, &origin_owned);
        if folder.is_none() && is_app_uri(&uri, &origin_owned) {
            return false;
        }
        decision.ignore();
        if !action.is_user_gesture() {
            return true;
        }
        // WebKit refuses file:// links from the page, so the page asks for a
        // folder with an app link instead. Only folders: a file could start a program.
        if let Some(folder) = folder {
            if folder.is_dir() {
                let parent = view.root().and_downcast::<gtk4::Window>();
                gtk4::FileLauncher::new(Some(&gtk4::gio::File::for_path(&folder))).launch(
                    parent.as_ref(),
                    gtk4::gio::Cancellable::NONE,
                    move |result| {
                        if let Err(error) = result {
                            eprintln!(
                                "Cannot open {} in the file manager: {error}",
                                folder.display()
                            );
                        }
                    },
                );
            }
            return true;
        }
        // A link the reader clicked opens in their browser; anything else
        // leaving the app, such as a script redirect, is dropped.
        if uri.starts_with("https://") || uri.starts_with("http://") {
            let parent = view.root().and_downcast::<gtk4::Window>();
            gtk4::UriLauncher::new(&uri).launch(
                parent.as_ref(),
                gtk4::gio::Cancellable::NONE,
                move |result| {
                    if let Err(error) = result {
                        eprintln!("Cannot open {uri} in the browser: {error}");
                    }
                },
            );
        }
        true
    });
    import::accept_files(&view, core.database.clone(), core.runtime.clone());
    view.load_uri(origin);
    window.set_child(Some(&view));
    window.present();
}

fn main() -> glib::ExitCode {
    // A development build runs beside the installed app instead of raising it.
    let flags = if cfg!(debug_assertions) {
        gtk4::gio::ApplicationFlags::NON_UNIQUE
    } else {
        gtk4::gio::ApplicationFlags::empty()
    };
    let app = gtk4::Application::new(Some(APP_ID), flags);
    // The core once it runs; a later activation only shows a window.
    let running: Rc<RefCell<Option<Core>>> = Rc::default();
    app.connect_activate(move |app| {
        // The FurAffinity windows are plain windows; only the app's own window counts here.
        if let Some(window) = app
            .windows()
            .into_iter()
            .find(|window| window.is::<gtk4::ApplicationWindow>())
        {
            window.present();
            return;
        }
        if let Some(core) = running.borrow().as_ref() {
            open_window(app, core);
            return;
        }
        match start_core() {
            Ok((core_origin, core, failure, database)) => {
                browser::start(app);
                let Some(runtime) = core.handle() else {
                    fail(app, "Library unavailable", "GoonCave could not start its library. Open GoonCave again. Your saved data has not been deleted.");
                    return;
                };
                let started = Core { origin: core_origin, database: database.clone(), runtime };
                let core = Arc::new(core);
                app.connect_shutdown(move |_| core.stop());
                open_window(app, &started);
                *running.borrow_mut() = Some(started);
                let app = app.clone();
                glib::spawn_future_local(async move {
                    if let Ok(error) = failure.await {
                        fail(&app, "GoonCave stopped", &format!("The local library stopped working ({error}). Open GoonCave again. Your saved data has not been deleted."));
                    }
                });
            }
            Err(error) => {
                eprintln!("Unable to open local library: {error}");
                fail(app, "Library unavailable", "GoonCave could not open your library. Close other copies of GoonCave, check free disk space and permissions for the app's data folder, then open GoonCave again. Your saved data has not been deleted.");
            }
        }
    });
    app.run()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn open_folder_links_carry_a_decoded_path_from_the_app_only() {
        let origin = "http://127.0.0.1:4000";
        assert_eq!(
            open_folder_path(
                "http://127.0.0.1:4000/open-folder?path=%2Fhome%2Fme%2FMy%20Library%231",
                origin
            ),
            Some(std::path::PathBuf::from("/home/me/My Library#1"))
        );
        assert_eq!(
            open_folder_path("https://evil.test/open-folder?path=%2F", origin),
            None
        );
        assert_eq!(
            open_folder_path("http://127.0.0.1:4000/app/gallery", origin),
            None
        );
    }

    #[test]
    fn shutdown_waits_for_pending_core_work() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let result = completed.clone();
        let task = runtime.spawn(async move {
            receiver.await.unwrap();
            tokio::task::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(20));
                result.store(true, Ordering::SeqCst);
            });
            Ok(())
        });
        let core = CoreRuntime {
            runtime: Mutex::new(Some(runtime)),
            shutdown: Mutex::new(Some(sender)),
            task: Mutex::new(Some(task)),
        };
        core.stop();
        assert!(completed.load(Ordering::SeqCst));
        core.stop();
    }

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
    fn only_the_app_origin_and_its_blobs_stay_inside_the_window() {
        let origin = "http://127.0.0.1:39761";
        assert!(is_app_uri("http://127.0.0.1:39761", origin));
        assert!(is_app_uri("http://127.0.0.1:39761/app/gallery", origin));
        assert!(is_app_uri("blob:http://127.0.0.1:39761/8f3c", origin));
        assert!(!is_app_uri("http://127.0.0.1:397610/", origin));
        assert!(!is_app_uri("http://127.0.0.1:39761@evil.test/", origin));
        assert!(!is_app_uri("https://e621.net/posts/1", origin));
        assert!(!is_app_uri("blob:https://e621.net/8f3c", origin));
    }
}
