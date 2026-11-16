//! Keeps every webview on the app's own pages: a link or a script cannot load another site in place of the app,
//! which would then run where the app's commands are reachable.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// `dev_url` is the dev server of `tauri dev` (`build.devUrl`); it is allowed only in a debug build.
pub(crate) fn plugin<R: Runtime>(dev_url: Option<Url>) -> TauriPlugin<R> {
    let dev_url = dev_url.filter(|_| cfg!(debug_assertions));
    Builder::new("navigation-guard")
        .on_navigation(move |_, url| is_app_url(url, dev_url.as_ref()))
        .build()
}

/// The app's own origin: `tauri://localhost` on macOS and Linux, `http(s)://tauri.localhost` on Windows, or the
/// dev server's origin when one is given.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        _ => dev_url.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

#[cfg(test)]
mod tests {
    use super::is_app_url;
    use tauri::Url;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn allows_the_app_origin_only() {
        for allowed in [
            "tauri://localhost",
            "tauri://localhost/index.html#library",
            "http://tauri.localhost/",
            "https://tauri.localhost/settings",
        ] {
            assert!(is_app_url(&url(allowed), None), "{allowed}");
        }
        for refused in [
            "https://example.com/",
            "http://localhost:1420/",
            "http://tauri.localhost.example.com/",
            "tauri://example.com/",
            "file:///etc/hosts",
            "about:blank",
            "data:text/html,hi",
        ] {
            assert!(!is_app_url(&url(refused), None), "{refused}");
        }
    }

    #[test]
    fn allows_the_dev_server_origin_when_given() {
        let dev = url("http://localhost:1420");
        assert!(is_app_url(
            &url("http://localhost:1420/library"),
            Some(&dev)
        ));
        assert!(!is_app_url(&url("http://localhost:1421/"), Some(&dev)));
        assert!(!is_app_url(&url("https://localhost:1420/"), Some(&dev)));
        assert!(!is_app_url(&url("https://example.com/"), Some(&dev)));
    }
}
