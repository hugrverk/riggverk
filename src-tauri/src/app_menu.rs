//! The app menu. Tauri's default menu, except that on macOS the app menu's Quit is Riggverk's own item.
//!
//! The predefined Quit sends `terminate:` straight to NSApp. tao has no `applicationShouldTerminate`, so that quit
//! never reaches `RunEvent::ExitRequested` and the UI's close guard never gets to ask about unsaved Library drafts or
//! a pending settings change. Riggverk's Quit (same title and Cmd+Q) closes the main window instead: the window's close
//! request runs the guard, and when the guard lets it close, the app exits as the last window goes. Quit from the Dock
//! or at logout still sends `terminate:` and is not guarded.
//!
//! When updates are on (see `app_update`), the app menu also has "Check for Updates…" after About; the UI runs the
//! check. Without the updater config the item is not there.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, Runtime};

use crate::window_placement::MAIN_WINDOW;

const QUIT_ID: &str = "riggverk-quit";
const CHECK_UPDATES_ID: &str = "riggverk-check-updates";

/// Tauri's default menu with the app menu's predefined Quit swapped for [`QUIT_ID`] (macOS only).
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    #[cfg(target_os = "macos")]
    replace_quit(app, &menu)?;
    #[cfg(target_os = "macos")]
    if crate::app_update::configured(app.config()) {
        add_check_for_updates(app, &menu)?;
    }
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn replace_quit<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        return Ok(());
    };
    let items = app_menu.items()?;
    let quit = items.iter().rposition(|item| match item {
        MenuItemKind::Predefined(predefined) => predefined
            .text()
            .map(|text| text.starts_with("Quit"))
            .unwrap_or(false),
        _ => false,
    });
    if let Some(position) = quit {
        app_menu.remove_at(position)?;
        let title = format!("Quit {}", app.package_info().name);
        app_menu.append(&MenuItem::with_id(
            app,
            QUIT_ID,
            title,
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    Ok(())
}

/// "Check for Updates…" right after the app menu's About item.
#[cfg(target_os = "macos")]
fn add_check_for_updates<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        return Ok(());
    };
    let item = MenuItem::with_id(
        app,
        CHECK_UPDATES_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    app_menu.insert(&item, 1)
}

/// Riggverk's Quit: close the main window so its close guard runs; exit directly when there is no window to ask.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == CHECK_UPDATES_ID {
        crate::app_update::request_check_from_menu(app);
        return;
    }
    if event.id() != QUIT_ID {
        return;
    }
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => {
            // The guard may ask in this window; a minimized or hidden one would hide the question.
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            if window.close().is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}
