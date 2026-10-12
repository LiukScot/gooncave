#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use gooncave_core::{
    db::Database,
    http::{AssetLoader, Frontend, Server},
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

struct CoreRuntime {
    runtime: Mutex<Option<tokio::runtime::Runtime>>,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<std::io::Result<()>>>>,
}

impl CoreRuntime {
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

fn start_core(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Runtime::new()?;
    let directory = app.path().app_data_dir()?;
    let database = Database::open(&directory)?;
    let resolver = app.asset_resolver();
    let assets: AssetLoader = Arc::new(move |path| {
        let path = if path == "/" || path == "/app" || path.starts_with("/app/") {
            "index.html"
        } else {
            path.trim_start_matches('/')
        };
        resolver
            .get(path.into())
            .map(|asset| (asset.bytes, asset.mime_type))
    });
    let server = runtime.block_on(Server::bind(database, 0, Frontend::Embedded(assets)))?;
    let origin = server.origin.clone();
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(origin.parse()?))
        .title("GoonCave")
        .inner_size(1200.0, 800.0)
        .on_navigation(move |url| url.origin().ascii_serialization() == origin)
        .build()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.handle().clone();
    let task = runtime.spawn(async move {
        let result = server.serve(receiver).await;
        if let Err(error) = &result {
            eprintln!("Local core stopped: {error}");
            handle.exit(1);
        }
        result
    });
    app.manage(CoreRuntime {
        runtime: Mutex::new(Some(runtime)),
        shutdown: Mutex::new(Some(sender)),
        task: Mutex::new(Some(task)),
    });
    Ok(())
}

fn main() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(error) = start_core(app) {
                eprintln!("Unable to open local library: {error}");
                let handle = app.handle().clone();
                app.dialog()
                    .message("GoonCave could not open your library. Close other copies of GoonCave, check free disk space and permissions for the app's data folder, then open GoonCave again. Your saved data has not been deleted.")
                    .title("Library unavailable")
                    .kind(MessageDialogKind::Error)
                    .buttons(MessageDialogButtons::OkCustom("Close GoonCave".into()))
                    .show(move |_| handle.exit(1));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("initialize GoonCave desktop");
    application.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(core) = app.try_state::<CoreRuntime>() {
                core.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

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
}
