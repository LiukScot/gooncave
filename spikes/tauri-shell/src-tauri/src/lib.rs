#[tauri::command]
fn ping() -> String {
    format!(
        "Rust answered on {} ({})",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

#[cfg(target_os = "ios")]
fn enable_back_forward_swipes(app: &tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    let window = app
        .get_webview_window("main")
        .expect("the main window is declared in tauri.conf.json");
    window.with_webview(|platform| {
        let view = platform.inner() as *mut objc2::runtime::AnyObject;
        // SAFETY: `inner` is the live WKWebView, and Tauri runs this closure on the main thread.
        unsafe {
            let _: () = objc2::msg_send![
                &*view,
                setAllowsBackForwardNavigationGestures: objc2::runtime::Bool::YES
            ];
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(target_os = "ios")]
            enable_back_forward_swipes(_app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri shell spike");
}
