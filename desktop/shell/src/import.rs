//! WebKitGTK hands the page only the links of files dropped or pasted from the desktop, never
//! their contents, so the window takes drops and pastes itself, adds the files through the
//! core, and tells the page with `gooncave-drop` events: `over`, `left`, `adding`, then `done`
//! or `failed`.
use std::path::PathBuf;

use gooncave_core::db::Database;
use gtk4::{gdk, gio, glib, prelude::*};
use serde_json::{json, Value};
use webkit6::{prelude::*, WebView};

#[derive(Clone)]
struct Importer {
    page: WebView,
    database: Database,
    runtime: tokio::runtime::Handle,
}

pub fn accept_files(view: &WebView, database: Database, runtime: tokio::runtime::Handle) {
    let importer = Importer {
        page: view.clone(),
        database,
        runtime,
    };

    let target = gtk4::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
    // Ahead of WebKit's own drop handling, which would keep only the links.
    target.set_propagation_phase(gtk4::PropagationPhase::Capture);
    // A picture or link dragged inside the page stays WebKit's: it has no file to add.
    target.connect_accept(|_, drop| drop.drag().is_none());
    let page = view.clone();
    target.connect_enter(move |_, _, _| {
        tell(&page, json!({"state": "over"}));
        gdk::DragAction::COPY
    });
    let page = view.clone();
    target.connect_leave(move |_| tell(&page, json!({"state": "left"})));
    let dropped = importer.clone();
    target.connect_drop(move |_, value, _, _| {
        let Ok(list) = value.get::<gdk::FileList>() else {
            return false;
        };
        dropped.import(
            list.files()
                .iter()
                .filter_map(gio::prelude::FileExt::path)
                .collect(),
            None,
        );
        true
    });
    view.add_controller(target);

    let keys = gtk4::EventControllerKey::new();
    keys.set_propagation_phase(gtk4::PropagationPhase::Capture);
    keys.connect_key_pressed(move |_, key, _, modifiers| {
        let paste = modifiers.contains(gdk::ModifierType::CONTROL_MASK)
            && matches!(key, gdk::Key::v | gdk::Key::V);
        if paste && importer.paste() {
            glib::Propagation::Stop
        } else {
            glib::Propagation::Proceed
        }
    });
    view.add_controller(keys);
}

impl Importer {
    /// Takes a paste of copied files or a copied picture. A text field gets them too: the page's
    /// focus is not known here, and pasting a file's path into a search is rarely meant.
    fn paste(&self) -> bool {
        let clipboard = self.page.clipboard();
        let formats = clipboard.formats();
        if formats.contains_type(gdk::FileList::static_type()) {
            let importer = self.clone();
            clipboard.read_value_async(
                gdk::FileList::static_type(),
                glib::Priority::DEFAULT,
                gio::Cancellable::NONE,
                move |value| match value.and_then(|value| {
                    value.get::<gdk::FileList>().map_err(|error| {
                        glib::Error::new(gio::IOErrorEnum::InvalidData, &error.to_string())
                    })
                }) {
                    Ok(list) => importer.import(
                        list.files()
                            .iter()
                            .filter_map(gio::prelude::FileExt::path)
                            .collect(),
                        None,
                    ),
                    Err(error) => importer.failed(&error.to_string()),
                },
            );
            return true;
        }
        if formats.contains_type(gdk::Texture::static_type()) {
            let importer = self.clone();
            clipboard.read_texture_async(gio::Cancellable::NONE, move |texture| match texture {
                Ok(Some(texture)) => importer.import_picture(&texture),
                Ok(None) => importer.failed("the copied picture is empty"),
                Err(error) => importer.failed(&error.to_string()),
            });
            return true;
        }
        false
    }

    /// A copied picture has no file, so it is saved under a name that does not repeat.
    fn import_picture(&self, texture: &gdk::Texture) {
        let stamp = glib::DateTime::now_local()
            .and_then(|now| now.format("%Y-%m-%dT%H-%M-%S"))
            .map(|stamp| stamp.to_string())
            .unwrap_or_else(|_| "picture".into());
        let directory = match tempfile::tempdir() {
            Ok(directory) => directory,
            Err(error) => return self.failed(&error.to_string()),
        };
        let path = directory.path().join(format!("pasted-{stamp}.png"));
        if let Err(error) = std::fs::write(&path, texture.save_to_png_bytes()) {
            return self.failed(&error.to_string());
        }
        self.import(vec![path], Some(directory));
    }

    /// Adds `paths` through the core; `scratch` is removed once they are copied.
    fn import(&self, paths: Vec<PathBuf>, scratch: Option<tempfile::TempDir>) {
        // Files on a network share or a phone have no local path to copy from.
        if paths.is_empty() {
            return self.failed("only files saved on this device can be added");
        }
        tell(&self.page, json!({"state": "adding", "count": paths.len()}));
        let database = self.database.clone();
        let import = self.runtime.spawn(async move {
            let result = gooncave_core::files::import_paths(&database, paths).await;
            drop(scratch);
            result
        });
        let page = self.page.clone();
        glib::spawn_future_local(async move {
            let detail = match import.await {
                Ok(Ok(result)) => json!({"state": "done", "result": result}),
                Ok(Err(error)) => json!({"state": "failed", "error": error.to_string()}),
                Err(error) => json!({"state": "failed", "error": error.to_string()}),
            };
            tell(&page, detail);
        });
    }

    fn failed(&self, error: &str) {
        tell(&self.page, json!({"state": "failed", "error": error}));
    }
}

fn tell(view: &WebView, detail: Value) {
    // `detail` is JSON, which is also a valid JavaScript expression.
    let script =
        format!("window.dispatchEvent(new CustomEvent('gooncave-drop', {{ detail: {detail} }}))");
    view.evaluate_javascript(&script, None, None, gio::Cancellable::NONE, |result| {
        if let Err(error) = result {
            eprintln!("Cannot tell the page about added files: {error}");
        }
    });
}
