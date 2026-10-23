//! The WebKit engine the core sends FurAffinity and Rule34 page requests through, so they
//! pass Cloudflare's browser check, and the sheet where the person signs in to them.
//! The requests run on the core's tasks; every UIKit and WebKit call hops to the main thread.
use std::{
    cell::{Cell, OnceCell, RefCell},
    future::Future,
    ptr::NonNull,
    sync::Arc,
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use gooncave_core::browser::{
    cookie_domain, cookie_pairs, origin, site, Browser, Page, Pending, Site, CHALLENGED, FETCH,
    STOPPED, UNREACHABLE, USERNAME,
};
use objc2::{
    define_class, extern_class, extern_methods, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieName,
    NSHTTPCookiePath, NSHTTPCookieSecure, NSHTTPCookieValue, NSString, NSURLErrorCancelled,
    NSURLRequest, NSURL,
};
use objc2_ui_kit::{
    NSDirectionalEdgeInsets, UIAction, UIBarButtonItem, UIBarButtonSystemItem, UIColor, UILabel,
    UILayoutConstraintAxis, UINavigationController, UIRectEdge, UIResponder, UIStackView, UIView,
    UIViewController,
};
use objc2_web_kit::{
    WKContentWorld, WKFrameInfo, WKNavigation, WKNavigationDelegate, WKWebViewConfiguration,
    WKWebsiteDataStore,
};
use tokio::sync::{mpsc, oneshot};

type SignIn = Option<(String, Option<String>)>;

extern_class!(
    // objc2-web-kit declares WKWebView for macOS only; on iOS it is a UIView.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct WKWebView;
);

impl WKWebView {
    extern_methods!(
        #[unsafe(method(initWithFrame:configuration:))]
        fn init_with_frame(
            this: Allocated<Self>,
            frame: CGRect,
            configuration: &WKWebViewConfiguration,
        ) -> Retained<Self>;

        #[unsafe(method(setNavigationDelegate:))]
        unsafe fn set_navigation_delegate(
            &self,
            delegate: Option<&ProtocolObject<dyn WKNavigationDelegate>>,
        );

        #[unsafe(method(loadRequest:))]
        fn load_request(&self, request: &NSURLRequest) -> Option<Retained<WKNavigation>>;

        #[unsafe(method(URL))]
        fn url(&self) -> Option<Retained<NSURL>>;

        #[unsafe(method(callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:))]
        fn call_async_javascript(
            &self,
            function_body: &NSString,
            arguments: Option<&NSDictionary<NSString, AnyObject>>,
            frame: Option<&WKFrameInfo>,
            content_world: &WKContentWorld,
            completion_handler: Option<&block2::DynBlock<dyn Fn(*mut AnyObject, *mut NSError)>>,
        );
    );
}

/// What a web view or its sheet reports while the person works in it.
enum Event {
    Loaded,
    Failed,
    Closed,
}

define_class!(
    /// Turns a web view's navigation callbacks and its sheet's Close button into events.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "GoonCaveBrowserWatcher"]
    #[ivars = RefCell<Option<mpsc::UnboundedSender<Event>>>]
    struct Watcher;

    unsafe impl NSObjectProtocol for Watcher {}

    unsafe impl WKNavigationDelegate for Watcher {
        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>) {
            self.send(Event::Loaded);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn failed(&self, _view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            self.report_failure(error);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed_to_start(
            &self,
            _view: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            self.report_failure(error);
        }
    }
);

impl Watcher {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(RefCell::new(None));
        // SAFETY: NSObject's `init` is the designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn send(&self, event: Event) {
        if let Some(sender) = self.ivars().borrow().as_ref() {
            let _ = sender.send(event);
        }
    }

    /// A navigation that a newer one replaced is not a failure: the newer one reports.
    fn report_failure(&self, error: &NSError) {
        if error.code() != NSURLErrorCancelled {
            self.send(Event::Failed);
        }
    }

    /// Sends the events from now on to the returned receiver only.
    fn watch(&self) -> mpsc::UnboundedReceiver<Event> {
        let (sender, events) = mpsc::unbounded_channel();
        *self.ivars().borrow_mut() = Some(sender);
        events
    }
}

/// Lives on the main thread for the app's lifetime.
struct Engine {
    root: Retained<UIViewController>,
    /// Stays on a page of the last site it fetched so its scripts can fetch other pages of it.
    worker: Retained<WKWebView>,
    worker_watcher: Retained<Watcher>,
    sheet: RefCell<Option<Retained<UINavigationController>>>,
    signing_in: RefCell<Option<(Retained<WKWebView>, Retained<Watcher>)>>,
}

thread_local! {
    static ENGINE: OnceCell<Engine> = const { OnceCell::new() };
}

/// Registers the engine with the core. `root` is the app window's view controller.
pub(crate) fn start(root: Retained<UIViewController>, mtm: MainThreadMarker) {
    let worker_watcher = Watcher::new(mtm);
    let worker = web_view(&worker_watcher, mtm);
    let engine = Engine {
        root,
        worker,
        worker_watcher,
        sheet: RefCell::default(),
        signing_in: RefCell::default(),
    };
    engine.hide_worker();
    if ENGINE.with(|cell| cell.set(engine)).is_ok() {
        gooncave_core::browser::register(Box::new(Remote::default()));
    }
}

/// The core's handle on the engine. One sheet at a time, and no request while it is open.
#[derive(Default)]
struct Remote(Arc<tokio::sync::Mutex<()>>);

impl Browser for Remote {
    fn fetch(&self, url: String, cookie: Option<String>) -> Pending<Page> {
        let busy = self.0.clone();
        Box::pin(async move {
            let _busy = busy.lock().await;
            fetch(&url, cookie.as_deref()).await
        })
    }

    fn sign_in(&self, base: String) -> Pending<SignIn> {
        let busy = self.0.clone();
        Box::pin(async move {
            let _busy = busy.lock().await;
            sign_in(&base).await
        })
    }
}

/// Runs `work` with the engine on the main thread.
fn main_thread<T: Send + 'static>(
    work: impl FnOnce(&Engine, MainThreadMarker) -> T + Send + 'static,
) -> impl Future<Output = Result<T, String>> + Send {
    let (reply, answer) = oneshot::channel();
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        ENGINE.with(|engine| {
            if let Some(engine) = engine.get() {
                let _ = reply.send(work(engine, mtm));
            }
        });
    });
    async move { answer.await.map_err(|_| STOPPED.to_owned()) }
}

/// Like `main_thread`, for work WebKit finishes later through a completion handler.
async fn main_thread_later<T: Send + 'static>(
    work: impl FnOnce(&Engine, MainThreadMarker) -> oneshot::Receiver<Result<T, String>>
        + Send
        + 'static,
) -> Result<T, String> {
    main_thread(work)
        .await?
        .await
        .map_err(|_| STOPPED.to_owned())?
}

fn web_view(watcher: &Watcher, mtm: MainThreadMarker) -> Retained<WKWebView> {
    // SAFETY: a new configuration uses the default website data store, shared by every view.
    let view = unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        WKWebView::init_with_frame(WKWebView::alloc(mtm), CGRect::default(), &configuration)
    };
    // SAFETY: the watcher outlives the view: the engine holds both.
    unsafe { view.set_navigation_delegate(Some(ProtocolObject::from_ref(watcher))) };
    view
}

fn load(view: &WKWebView, url: &str) -> Result<(), String> {
    let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
        eprintln!("GoonCave's browser cannot open {url}");
        return Err(UNREACHABLE.to_owned());
    };
    view.load_request(&NSURLRequest::requestWithURL(&url));
    Ok(())
}

/// Runs a script of the core's in the page and returns its result as JSON.
fn run(
    view: &WKWebView,
    script: &str,
    url: Option<&str>,
    mtm: MainThreadMarker,
) -> oneshot::Receiver<Result<String, String>> {
    let (reply, answer) = oneshot::channel();
    let reply = Cell::new(Some(reply));
    let done = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        // SAFETY: WebKit passes a valid NSError or null.
        if let Some(error) = unsafe { error.as_ref() } {
            eprintln!("Browser script failed: {error}");
        }
        // SAFETY: WebKit passes the script's result or null; JSON.stringify returns a string.
        let json = unsafe { result.as_ref() }
            .and_then(|result| result.downcast_ref::<NSString>())
            .map(|json| json.to_string())
            .ok_or_else(|| UNREACHABLE.to_owned());
        if let Some(reply) = reply.take() {
            let _ = reply.send(json);
        }
    });
    let body = NSString::from_str(&format!(
        "return JSON.stringify(await (async () => {{ {script} }})());"
    ));
    let key = NSString::from_str("url");
    let arguments = url.map(|url| {
        let url = NSString::from_str(url);
        NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[&*url])
    });
    // SAFETY: the arguments are strings, which WebKit turns into JavaScript strings.
    unsafe {
        view.call_async_javascript(
            &body,
            arguments.as_deref(),
            None,
            &WKContentWorld::pageWorld(mtm),
            Some(&done),
        );
    }
    answer
}

impl Engine {
    fn view(&self) -> Option<Retained<UIView>> {
        self.root.view()
    }

    /// Keeps the worker in the window, behind the app, where WebKit lets it run.
    fn hide_worker(&self) {
        self.worker.removeFromSuperview();
        self.worker
            .setTranslatesAutoresizingMaskIntoConstraints(true);
        self.worker
            .setFrame(CGRect::new(CGPoint::ZERO, CGSize::new(1.0, 1.0)));
        if let Some(view) = self.view() {
            view.insertSubview_atIndex(&self.worker, 0);
        }
    }

    /// Shows `view` in a sheet under `message`; its Close button reports `Event::Closed`.
    fn present(
        &self,
        title: &str,
        message: &str,
        view: &WKWebView,
        watcher: &Retained<Watcher>,
        mtm: MainThreadMarker,
    ) {
        view.removeFromSuperview();
        let label = UILabel::new(mtm);
        label.setText(Some(&NSString::from_str(message)));
        label.setNumberOfLines(0);
        let header = UIStackView::initWithArrangedSubviews(
            UIStackView::alloc(mtm),
            &NSArray::from_slice(&[label.as_ref() as &UIView]),
        );
        header.setLayoutMarginsRelativeArrangement(true);
        header.setDirectionalLayoutMargins(NSDirectionalEdgeInsets {
            top: 12.0,
            leading: 16.0,
            bottom: 12.0,
            trailing: 16.0,
        });
        let content = UIStackView::initWithArrangedSubviews(
            UIStackView::alloc(mtm),
            &NSArray::from_slice(&[header.as_ref() as &UIView, view.as_ref()]),
        );
        content.setAxis(UILayoutConstraintAxis::Vertical);
        content.setBackgroundColor(Some(&UIColor::systemBackgroundColor()));

        let controller = UIViewController::new(mtm);
        controller.setView(Some(&content));
        controller.setTitle(Some(&NSString::from_str(title)));
        // Starts the message below the navigation bar instead of under it.
        controller.setEdgesForExtendedLayout(UIRectEdge::empty());
        let closer = watcher.clone();
        let closed = RcBlock::new(move |_: NonNull<UIAction>| closer.send(Event::Closed));
        // SAFETY: UIKit copies the handler block.
        let close = unsafe { UIAction::actionWithHandler(RcBlock::as_ptr(&closed), mtm) };
        let button = UIBarButtonItem::initWithBarButtonSystemItem_primaryAction(
            UIBarButtonItem::alloc(mtm),
            UIBarButtonSystemItem::Close,
            Some(&close),
        );
        controller
            .navigationItem()
            .setRightBarButtonItem(Some(&button));

        let sheet = UINavigationController::initWithRootViewController(
            UINavigationController::alloc(mtm),
            &controller,
        );
        // A swipe down would hide the sheet without telling the waiting request.
        sheet.setModalInPresentation(true);
        let mut top = self.root.clone();
        while let Some(presented) = top.presentedViewController() {
            top = presented;
        }
        top.presentViewController_animated_completion(&sheet, true, None);
        *self.sheet.borrow_mut() = Some(sheet);
    }

    /// Closes the sheet and puts the worker back. Without animation, so the next sheet
    /// can open at once: UIKit refuses to present while a dismissal is running.
    fn close_sheet(&self) {
        if let Some(sheet) = self.sheet.take() {
            sheet.dismissViewControllerAnimated_completion(false, None);
        }
        self.signing_in.take();
        self.hide_worker();
    }

    fn worker_url(&self) -> Option<String> {
        let url = self.worker.url()?;
        Some(url.absoluteString()?.to_string())
    }

    /// Stores the session (`a=…; b=…`) for `base` in the cookies every web view shares.
    /// The receiver gets one message per cookie WebKit has stored; returns how many to wait for.
    fn store(
        &self,
        base: &str,
        header: &str,
        mtm: MainThreadMarker,
    ) -> (mpsc::UnboundedReceiver<()>, usize) {
        let domain = NSString::from_str(&cookie_domain(base));
        let path = NSString::from_str("/");
        let yes = NSString::from_str("TRUE");
        // Foundation has no constant for this key; NSHTTPCookie reads it by this name.
        let http_only = NSString::from_str("HttpOnly");
        let (stored, receiver) = mpsc::unbounded_channel();
        // SAFETY: the data store is WebKit's own and lives for the app's lifetime.
        let store = unsafe { WKWebsiteDataStore::defaultDataStore(mtm).httpCookieStore() };
        let mut count = 0;
        for (name, value) in cookie_pairs(header) {
            let name = NSString::from_str(name);
            let value = NSString::from_str(value);
            // SAFETY: the keys are constants exported by Foundation, and every value is a
            // string, as Foundation expects for them.
            let cookie = unsafe {
                let properties = NSDictionary::<NSString, AnyObject>::from_slices(
                    &[
                        NSHTTPCookieName,
                        NSHTTPCookieValue,
                        NSHTTPCookieDomain,
                        NSHTTPCookiePath,
                        NSHTTPCookieSecure,
                        &http_only,
                    ],
                    &[&*name, &*value, &*domain, &*path, &*yes, &*yes],
                );
                NSHTTPCookie::cookieWithProperties(&properties)
            };
            let Some(cookie) = cookie else {
                eprintln!("Cannot store the session in GoonCave's browser.");
                continue;
            };
            let stored = stored.clone();
            let done = RcBlock::new(move || {
                let _ = stored.send(());
            });
            // SAFETY: WebKit copies the completion block.
            unsafe { store.setCookie_completionHandler(&cookie, Some(&done)) };
            count += 1;
        }
        (receiver, count)
    }

    /// The session cookie (`a=…; b=…`) the web views hold for `site` at `base`, when they
    /// hold all of it.
    fn session_cookie(
        &self,
        site: &'static Site,
        base: &str,
        mtm: MainThreadMarker,
    ) -> oneshot::Receiver<Result<Option<String>, String>> {
        let (reply, answer) = oneshot::channel();
        let reply = Cell::new(Some(reply));
        let host = base.strip_prefix("https://").unwrap_or(base).to_owned();
        let read = RcBlock::new(move |jar: NonNull<NSArray<NSHTTPCookie>>| {
            // SAFETY: WebKit passes a valid array.
            let jar = unsafe { jar.as_ref() };
            let mine = |cookie: &NSHTTPCookie| {
                let domain = cookie.domain().to_string();
                let domain = domain.trim_start_matches('.');
                host == domain || host.ends_with(&format!(".{domain}"))
            };
            let session: Vec<String> = site
                .session
                .iter()
                .filter_map(|name| {
                    let cookie = jar
                        .iter()
                        .find(|cookie| cookie.name().to_string() == *name && mine(cookie))?;
                    Some(format!("{name}={}", cookie.value()))
                })
                .collect();
            if let Some(reply) = reply.take() {
                let _ = reply.send(Ok((session.len() == 2).then(|| session.join("; "))));
            }
        });
        // SAFETY: the data store is WebKit's own and lives for the app's lifetime.
        unsafe {
            WKWebsiteDataStore::defaultDataStore(mtm)
                .httpCookieStore()
                .getAllCookies(&read);
        }
        answer
    }
}

/// Which web view a script runs in.
#[derive(Clone, Copy)]
enum On {
    Worker,
    SignIn,
}

async fn script(on: On, script: &'static str, url: Option<String>) -> Result<String, String> {
    main_thread_later(move |engine, mtm| {
        let signing_in = engine.signing_in.borrow();
        let view = match (on, signing_in.as_ref()) {
            (On::Worker, _) => &engine.worker,
            (On::SignIn, Some((view, _))) => view,
            (On::SignIn, None) => {
                let (reply, answer) = oneshot::channel();
                let _ = reply.send(Err(STOPPED.to_owned()));
                return answer;
            }
        };
        run(view, script, url.as_deref(), mtm)
    })
    .await
}

/// Whether the worker shows Cloudflare's check. An error means the page no longer runs
/// scripts, for example because iOS ended its web process.
async fn challenged() -> Result<bool, String> {
    script(On::Worker, CHALLENGED, None)
        .await
        .map(|json| json == "true")
}

/// Closes the open sheet when dropped, also when the core drops the request waiting on it.
struct Sheet;

impl Drop for Sheet {
    fn drop(&mut self) {
        // The work is queued on the main thread at once; nothing waits for it.
        drop(main_thread(|engine, _| engine.close_sheet()));
    }
}

/// Puts the worker on `origin`, showing Cloudflare's check to the person when it asks for one.
async fn ready(site: &'static Site, origin: &str, force: bool) -> Result<(), String> {
    let on_origin = main_thread(|engine, _| engine.worker_url())
        .await?
        .is_some_and(|url| url.starts_with(origin) && url[origin.len()..].starts_with('/'));
    if on_origin && !force && challenged().await == Ok(false) {
        return Ok(());
    }
    let home = format!("{origin}/");
    // One receiver for the whole check, so no load is missed between the steps.
    let mut events = main_thread(move |engine, _| {
        let events = engine.worker_watcher.watch();
        load(&engine.worker, &home).map(|()| events)
    })
    .await??;
    match events.recv().await {
        Some(Event::Loaded) => {}
        _ => return Err(UNREACHABLE.to_owned()),
    }
    if !challenged().await.unwrap_or(false) {
        return Ok(());
    }
    let _sheet = Sheet;
    main_thread(move |engine, mtm| {
        engine.present(
            &site.check_title(),
            &site.check_message(),
            &engine.worker,
            &engine.worker_watcher,
            mtm,
        );
    })
    .await?;
    loop {
        match events.recv().await {
            Some(Event::Loaded) if !challenged().await.unwrap_or(false) => return Ok(()),
            Some(Event::Loaded | Event::Failed) => {}
            Some(Event::Closed) | None => return Err(site.check_closed()),
        }
    }
}

async fn fetch(url: &str, cookie: Option<&str>) -> Result<Page, String> {
    let origin = origin(url).ok_or_else(|| UNREACHABLE.to_owned())?;
    let site = site(origin).ok_or_else(|| UNREACHABLE.to_owned())?;
    if let Some(cookie) = cookie {
        let (base, cookie) = (origin.to_owned(), cookie.to_owned());
        let (mut stored, count) =
            main_thread(move |engine, mtm| engine.store(&base, &cookie, mtm)).await?;
        for _ in 0..count {
            stored.recv().await.ok_or_else(|| STOPPED.to_owned())?;
        }
    }
    let mut force = false;
    loop {
        ready(site, origin, force).await?;
        let json = script(On::Worker, FETCH, Some(url.to_owned())).await?;
        let value: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
            eprintln!("Browser script returned no page: {error}");
            UNREACHABLE.to_owned()
        })?;
        if value["challenged"].as_bool() == Some(true) && !force {
            // The clearance expired since the worker's page loaded; get a new one.
            force = true;
            continue;
        }
        return Ok(Page {
            status: value["status"]
                .as_u64()
                .and_then(|status| u16::try_from(status).ok())
                .ok_or_else(|| UNREACHABLE.to_owned())?,
            body: value["body"].as_str().unwrap_or_default().to_owned(),
        });
    }
}

async fn session_cookie(site: &'static Site, base: &str) -> Result<Option<String>, String> {
    let base = base.to_owned();
    main_thread_later(move |engine, mtm| engine.session_cookie(site, &base, mtm)).await
}

async fn sign_in(base: &str) -> Result<SignIn, String> {
    let base = base.trim_end_matches('/').to_owned();
    let site = site(&base).ok_or_else(|| UNREACHABLE.to_owned())?;
    // An expired session leaves its cookies behind, so they count only once they change
    // or the page shows a signed-in account.
    let stale = session_cookie(site, &base).await?;
    let login = format!("{base}{}", site.login);
    let _sheet = Sheet;
    let mut events = main_thread(move |engine, mtm| {
        let watcher = Watcher::new(mtm);
        let view = web_view(&watcher, mtm);
        let events = watcher.watch();
        load(&view, &login)?;
        engine.present(
            &site.sign_in_title(),
            &site.sign_in_message(),
            &view,
            &watcher,
            mtm,
        );
        *engine.signing_in.borrow_mut() = Some((view, watcher));
        Ok::<_, String>(events)
    })
    .await??;
    loop {
        match events.recv().await {
            Some(Event::Loaded) => {}
            Some(Event::Failed) => continue,
            Some(Event::Closed) | None => return Ok(None),
        }
        let Some(session) = session_cookie(site, &base).await? else {
            continue;
        };
        let username = match site.account {
            Some(account) => cookie_pairs(&session)
                .find(|(name, _)| *name == account)
                .map(|(_, value)| value.to_owned()),
            None => script(On::SignIn, USERNAME, None)
                .await
                .ok()
                .and_then(|json| serde_json::from_str::<String>(&json).ok()),
        }
        .filter(|name| !name.is_empty());
        if username.is_some() || stale.as_ref() != Some(&session) {
            return Ok(Some((session, username)));
        }
    }
}
