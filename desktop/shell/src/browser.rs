//! The WebKit engine the core sends FurAffinity page requests through, so they pass
//! Cloudflare's browser check, and the window where the person signs in to FurAffinity.
use gooncave_core::browser::{
    cookie_domain, cookie_pairs, origin, Browser, Page, Pending, CHALLENGED, CHECK_CLOSED,
    CHECK_MESSAGE, FETCH, SIGN_IN_MESSAGE, STOPPED, UNREACHABLE, USERNAME,
};
use gtk4::{glib, prelude::*};
use std::rc::Rc;
use tokio::sync::{mpsc, oneshot};
use webkit6::{prelude::*, soup, CookiePersistentStorage, LoadEvent, NetworkSession, WebView};

type SignIn = Option<(String, Option<String>)>;

enum Request {
    Fetch(
        String,
        Option<String>,
        oneshot::Sender<Result<Page, String>>,
    ),
    SignIn(String, oneshot::Sender<Result<SignIn, String>>),
}

struct Remote(mpsc::UnboundedSender<Request>);

impl Remote {
    fn ask<T: Send + 'static>(
        &self,
        request: impl FnOnce(oneshot::Sender<Result<T, String>>) -> Request,
    ) -> Pending<T> {
        let (reply, answer) = oneshot::channel();
        let sent = self.0.send(request(reply));
        Box::pin(async move {
            sent.map_err(|_| STOPPED.to_owned())?;
            answer.await.map_err(|_| STOPPED.to_owned())?
        })
    }
}

impl Browser for Remote {
    fn fetch(&self, url: String, cookie: Option<String>) -> Pending<Page> {
        self.ask(|reply| Request::Fetch(url, cookie, reply))
    }
    fn sign_in(&self, base: String) -> Pending<SignIn> {
        self.ask(|reply| Request::SignIn(base, reply))
    }
}

/// What a window reports while the person works in it.
enum Event {
    Loaded,
    Failed,
    Closed,
}

struct Engine {
    app: gtk4::Application,
    session: NetworkSession,
    /// Stays on a FurAffinity page so its scripts can fetch other pages of the site.
    worker: WebView,
    /// One check window at a time, and no request while it is open.
    busy: tokio::sync::Mutex<()>,
}

/// Registers the engine with the core. Requests run on the GTK thread.
pub(crate) fn start(app: &gtk4::Application) {
    let directory = glib::user_data_dir().join(crate::APP_ID).join("browser");
    let cache = glib::user_cache_dir().join(crate::APP_ID).join("browser");
    let session = NetworkSession::new(directory.to_str(), cache.to_str());
    if let Some(cookies) = session.cookie_manager() {
        // Keeps the FurAffinity session and Cloudflare's clearance across restarts.
        cookies.set_persistent_storage(
            &directory.join("cookies.sqlite").to_string_lossy(),
            CookiePersistentStorage::Sqlite,
        );
    }
    let engine = Rc::new(Engine {
        app: app.clone(),
        worker: WebView::builder().network_session(&session).build(),
        session,
        busy: tokio::sync::Mutex::new(()),
    });
    let (sender, mut requests) = mpsc::unbounded_channel();
    gooncave_core::browser::register(Box::new(Remote(sender)));
    glib::spawn_future_local(async move {
        while let Some(request) = requests.recv().await {
            let engine = engine.clone();
            glib::spawn_future_local(async move {
                match request {
                    Request::Fetch(url, cookie, reply) => {
                        let _ = reply.send(engine.fetch(&url, cookie.as_deref()).await);
                    }
                    Request::SignIn(base, reply) => {
                        let _ = reply.send(engine.sign_in(&base).await);
                    }
                }
            });
        }
    });
}

/// Reports loads, failures and the window closing as events.
fn watch(view: &WebView, window: Option<&gtk4::Window>) -> mpsc::UnboundedReceiver<Event> {
    let (sender, events) = mpsc::unbounded_channel();
    let loaded = sender.clone();
    let load = view.connect_load_changed(move |_, event| {
        if event == LoadEvent::Finished {
            let _ = loaded.send(Event::Loaded);
        }
    });
    let failed = sender.clone();
    let fail = view.connect_load_failed(move |_, _, _, _| {
        let _ = failed.send(Event::Failed);
        false
    });
    let handlers = Rc::new(std::cell::RefCell::new(Some((load, fail))));
    let view = view.clone();
    // The handlers go when the receiver does; a closed channel means nobody is waiting.
    glib::spawn_future_local({
        let sender = sender.clone();
        let handlers = handlers.clone();
        async move {
            sender.closed().await;
            if let Some((load, fail)) = handlers.borrow_mut().take() {
                view.disconnect(load);
                view.disconnect(fail);
            }
        }
    });
    if let Some(window) = window {
        window.connect_close_request(move |_| {
            let _ = sender.send(Event::Closed);
            glib::Propagation::Proceed
        });
    }
    events
}

async fn run(
    view: &WebView,
    script: &str,
    url: Option<&str>,
) -> Result<webkit6::javascriptcore::Value, String> {
    let arguments = url.map(|url| {
        let dict = glib::VariantDict::new(None);
        dict.insert("url", url);
        dict.end()
    });
    view.call_async_javascript_function_future(script, arguments.as_ref(), None, None)
        .await
        .map_err(|error| {
            eprintln!("FurAffinity script failed: {error}");
            UNREACHABLE.to_owned()
        })
}

impl Engine {
    fn window(&self, title: &str, message: &str, view: &WebView) -> gtk4::Window {
        let parent = self.app.active_window();
        let window = gtk4::Window::builder()
            .title(title)
            .default_width(900)
            .default_height(760)
            .application(&self.app)
            .build();
        window.set_transient_for(parent.as_ref());
        let content = gtk4::Box::new(gtk4::Orientation::Vertical, 0);
        let label = gtk4::Label::builder()
            .label(message)
            .wrap(true)
            .xalign(0.0)
            .margin_top(12)
            .margin_bottom(12)
            .margin_start(16)
            .margin_end(16)
            .build();
        content.append(&label);
        view.set_vexpand(true);
        content.append(view);
        window.set_child(Some(&content));
        window
    }

    async fn challenged(&self) -> bool {
        run(&self.worker, CHALLENGED, None)
            .await
            .is_ok_and(|value| value.to_boolean())
    }

    /// Puts the worker on `origin`, showing Cloudflare's check to the person when it asks for one.
    async fn ready(&self, origin: &str, force: bool) -> Result<(), String> {
        let on_origin = self
            .worker
            .uri()
            .is_some_and(|uri| uri.starts_with(origin) && uri[origin.len()..].starts_with('/'));
        if on_origin && !force && !self.challenged().await {
            return Ok(());
        }
        let mut events = watch(&self.worker, None);
        self.worker.load_uri(&format!("{origin}/"));
        match events.recv().await {
            Some(Event::Loaded) => {}
            _ => return Err(UNREACHABLE.to_owned()),
        }
        drop(events);
        if !self.challenged().await {
            return Ok(());
        }
        let window = self.window("FurAffinity check", CHECK_MESSAGE, &self.worker);
        let mut events = watch(&self.worker, Some(&window));
        window.present();
        let result = loop {
            match events.recv().await {
                Some(Event::Loaded) if !self.challenged().await => break Ok(()),
                Some(Event::Loaded | Event::Failed) => {}
                Some(Event::Closed) | None => break Err(CHECK_CLOSED.to_owned()),
            }
        };
        // Hands the worker back so it keeps running without a window.
        if let Some(content) = self.worker.parent().and_downcast::<gtk4::Box>() {
            content.remove(&self.worker);
        }
        window.destroy();
        result
    }

    async fn store(&self, base: &str, header: &str) {
        let Some(cookies) = self.session.cookie_manager() else {
            return;
        };
        let domain = cookie_domain(base);
        for (name, value) in cookie_pairs(header) {
            let mut cookie = soup::Cookie::new(name, value, &domain, "/", -1);
            cookie.set_secure(true);
            cookie.set_http_only(true);
            if let Err(error) = cookies.add_cookie_future(&cookie).await {
                eprintln!("Cannot store the FurAffinity session in GoonCave's browser: {error}");
            }
        }
    }

    async fn fetch(&self, url: &str, cookie: Option<&str>) -> Result<Page, String> {
        let origin = origin(url).ok_or_else(|| UNREACHABLE.to_owned())?;
        let _busy = self.busy.lock().await;
        if let Some(cookie) = cookie {
            self.store(origin, cookie).await;
        }
        let mut force = false;
        loop {
            self.ready(origin, force).await?;
            let value = run(&self.worker, FETCH, Some(url)).await?;
            let field = |name: &str| value.object_get_property(name);
            if field("challenged").is_some_and(|value| value.to_boolean()) && !force {
                // The clearance expired since the worker's page loaded; get a new one.
                force = true;
                continue;
            }
            return Ok(Page {
                status: field("status")
                    .map(|value| value.to_int32())
                    .and_then(|status| u16::try_from(status).ok())
                    .ok_or_else(|| UNREACHABLE.to_owned())?,
                body: field("body")
                    .map(|value| value.to_str().to_string())
                    .unwrap_or_default(),
            });
        }
    }

    async fn sign_in(&self, base: &str) -> Result<SignIn, String> {
        let base = base.trim_end_matches('/');
        let view = WebView::builder().network_session(&self.session).build();
        let window = self.window("Sign in to FurAffinity", SIGN_IN_MESSAGE, &view);
        let mut events = watch(&view, Some(&window));
        view.load_uri(&format!("{base}/login"));
        window.present();
        // An expired session leaves its cookies behind, so they count only once they change
        // or the page shows a signed-in account.
        let stale = self.session_cookie(base).await?;
        loop {
            match events.recv().await {
                Some(Event::Loaded) => {}
                Some(Event::Failed) => continue,
                Some(Event::Closed) | None => return Ok(None),
            }
            let Some(session) = self.session_cookie(base).await? else {
                continue;
            };
            let username = run(&view, USERNAME, None)
                .await
                .ok()
                .map(|value| value.to_str().to_string())
                .filter(|name| !name.is_empty());
            if username.is_some() || stale.as_ref() != Some(&session) {
                window.destroy();
                return Ok(Some((session, username)));
            }
        }
    }

    /// The `a=…; b=…` session cookie the engine holds for `base`, when it holds both.
    async fn session_cookie(&self, base: &str) -> Result<Option<String>, String> {
        let cookies = self
            .session
            .cookie_manager()
            .ok_or_else(|| "GoonCave's browser has no cookie storage.".to_owned())?;
        let jar = cookies
            .cookies_future(&format!("{base}/"))
            .await
            .map_err(|error| format!("Cannot read the FurAffinity session: {error}"))?;
        // soup's getters take `&mut`, so read every cookie once into plain pairs.
        let jar: Vec<(String, String)> = jar
            .into_iter()
            .filter_map(|mut cookie| Some((cookie.name()?.into(), cookie.value()?.into())))
            .collect();
        let session: Vec<String> = ["a", "b"]
            .iter()
            .filter_map(|name| {
                let (_, value) = jar.iter().find(|(found, _)| found == name)?;
                Some(format!("{name}={value}"))
            })
            .collect();
        Ok((session.len() == 2).then(|| session.join("; ")))
    }
}
