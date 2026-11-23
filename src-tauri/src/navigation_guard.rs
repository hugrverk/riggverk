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

/// The app's own origin: `tauri://localhost` on macOS and Linux, `http(s)://tauri.localhost` on its default port on
/// Windows, or the dev server's origin when one is given.
fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    is_app_url_on(url, dev_url, cfg!(windows))
}

/// [`is_app_url`] for the platform `windows` names, so that every platform's rule is tested on every platform.
fn is_app_url_on(url: &Url, dev_url: Option<&Url>, windows: bool) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        // Tauri serves the app on the default port only; another port there is another server.
        ("http" | "https", Some("tauri.localhost")) if windows => url.port().is_none(),
        _ => dev_url.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_app_url, is_app_url_on};
    use tauri::Url;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn allows_the_app_origin_only() {
        for windows in [true, false] {
            let windows_forms = [
                "http://tauri.localhost/",
                "https://tauri.localhost/settings",
            ];
            for allowed in ["tauri://localhost", "tauri://localhost/index.html#library"]
                .into_iter()
                .chain(windows_forms.into_iter().filter(|_| windows))
            {
                assert!(
                    is_app_url_on(&url(allowed), None, windows),
                    "{allowed} on windows={windows}"
                );
            }
            for refused in [
                "https://example.com/",
                "http://localhost:1420/",
                "http://tauri.localhost.example.com/",
                "http://tauri.localhost:4242/",
                "tauri://example.com/",
                "file:///etc/hosts",
                "about:blank",
                "data:text/html,hi",
            ]
            .into_iter()
            .chain(windows_forms.into_iter().filter(|_| !windows))
            {
                assert!(
                    !is_app_url_on(&url(refused), None, windows),
                    "{refused} on windows={windows}"
                );
            }
        }
    }

    #[test]
    fn refuses_another_port_on_tauri_localhost() {
        for other_port in [
            "http://tauri.localhost:4242/",
            "https://tauri.localhost:8443/",
        ] {
            assert!(!is_app_url_on(&url(other_port), None, true), "{other_port}");
            assert!(
                !is_app_url_on(&url(other_port), None, false),
                "{other_port}"
            );
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
