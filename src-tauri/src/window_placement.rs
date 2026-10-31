//! Where the main window opens. tauri-plugin-window-state remembers its size, position and maximized state in
//! `.window-state.json` in the app config dir (written when the app quits) and restores them when the window is
//! created, before anything is shown: the window starts hidden (`visible: false` in tauri.conf.json) and
//! `place_and_show` shows it once it is placed, so it never flashes at its default size first.
//!
//! The first launch has no saved state: the window is maximized (the menu bar and the Dock stay; never macOS
//! fullscreen). A saved place whose display is gone, or that has no grip left on any display, is maximized on the
//! display the window is on instead. The minimum size from tauri.conf.json applies to a restored size too.

use std::collections::HashMap;
use std::io::Read;

use serde::Deserialize;
use tauri::{Manager, PhysicalPosition, Runtime};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

pub(crate) const MAIN_WINDOW: &str = "main";

/// What is remembered. Not fullscreen, decorations or visibility: a saved state never puts the window in fullscreen,
/// and never keeps it hidden, since this module shows it.
pub(crate) const STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// The state file holds a few numbers per window; anything larger is not ours and is treated as no state.
const MAX_STATE_BYTES: u64 = 64 * 1024;

/// How far below its top edge the window is grabbed to move it: the title bar, in physical pixels.
const GRIP_DEPTH: i32 = 8;

/// A rectangle in physical pixels: a saved window or a display's work area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn contains(&self, x: i32, y: i32) -> bool {
        let right = i64::from(self.x) + i64::from(self.width);
        let bottom = i64::from(self.y) + i64::from(self.height);
        x >= self.x && i64::from(x) < right && y >= self.y && i64::from(y) < bottom
    }
}

/// The main window as the plugin saved it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) struct SavedWindow {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// The plugin restored a maximized window on a display that is still there.
    Keep,
    /// Put the window back where it was (the plugin moves it only when a corner is on a display).
    Restore { x: i32, y: i32 },
    /// The first launch, or the saved place is out of reach.
    Maximize,
}

/// The main window's saved state, from the text of the state file; None when there is none or it cannot be read.
pub(crate) fn saved_window(json: &str) -> Option<SavedWindow> {
    let mut windows: HashMap<String, SavedWindow> = serde_json::from_str(json).ok()?;
    windows
        .remove(MAIN_WINDOW)
        .filter(|saved| saved.width > 0 && saved.height > 0)
}

/// Where the window goes: back where it was while the middle of its title bar is on one of the displays, maximized
/// otherwise (and always on the first launch).
pub(crate) fn placement(saved: Option<SavedWindow>, displays: &[Rect]) -> Placement {
    let Some(saved) = saved else {
        return Placement::Maximize;
    };
    let grip_x = saved
        .x
        .saturating_add(i32::try_from(saved.width / 2).unwrap_or(i32::MAX));
    let grip_y = saved.y.saturating_add(GRIP_DEPTH);
    if !displays
        .iter()
        .any(|display| display.contains(grip_x, grip_y))
    {
        return Placement::Maximize;
    }
    if saved.maximized {
        Placement::Keep
    } else {
        Placement::Restore {
            x: saved.x,
            y: saved.y,
        }
    }
}

fn read_saved<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<SavedWindow> {
    let path = app.path().app_config_dir().ok()?.join(app.filename());
    let file = std::fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(MAX_STATE_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > MAX_STATE_BYTES {
        return None;
    }
    saved_window(&text)
}

/// Places the main window (after the plugin restored it) and shows it. Runs in the setup closure; a failure to place
/// it still shows it.
pub(crate) fn place_and_show<R: Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let displays: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Rect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect();
    match placement(read_saved(app.handle()), &displays) {
        Placement::Keep => {}
        Placement::Restore { x, y } => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        Placement::Maximize => {
            let _ = window.maximize();
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect {
        x: 0,
        y: 50,
        width: 3024,
        height: 1814,
    };
    const EXTERNAL: Rect = Rect {
        x: 3024,
        y: 0,
        width: 5120,
        height: 2880,
    };

    fn saved(x: i32, y: i32, maximized: bool) -> Option<SavedWindow> {
        Some(SavedWindow {
            x,
            y,
            width: 2560,
            height: 1600,
            maximized,
        })
    }

    #[test]
    fn the_first_launch_is_maximized() {
        assert_eq!(placement(None, &[LAPTOP]), Placement::Maximize);
    }

    #[test]
    fn a_window_on_a_display_that_is_there_goes_back_where_it_was() {
        assert_eq!(
            placement(saved(200, 120, false), &[LAPTOP]),
            Placement::Restore { x: 200, y: 120 }
        );
        assert_eq!(
            placement(saved(4000, 300, false), &[LAPTOP, EXTERNAL]),
            Placement::Restore { x: 4000, y: 300 }
        );
    }

    #[test]
    fn a_maximized_window_on_a_display_that_is_there_is_left_as_the_plugin_restored_it() {
        assert_eq!(placement(saved(0, 50, true), &[LAPTOP]), Placement::Keep);
    }

    #[test]
    fn a_window_whose_display_is_gone_is_maximized_on_one_that_is_there() {
        assert_eq!(
            placement(saved(4000, 300, false), &[LAPTOP]),
            Placement::Maximize
        );
        assert_eq!(
            placement(saved(4000, 300, true), &[LAPTOP]),
            Placement::Maximize
        );
    }

    #[test]
    fn a_window_with_its_title_bar_off_every_display_is_maximized() {
        // Mostly on the laptop, but the title bar is above its top edge (under the menu bar or off screen).
        assert_eq!(
            placement(saved(100, 20, false), &[LAPTOP]),
            Placement::Maximize
        );
        // Only a sliver on the laptop: the middle of the title bar is past its right edge.
        assert_eq!(
            placement(saved(2900, 120, false), &[LAPTOP]),
            Placement::Maximize
        );
    }

    #[test]
    fn no_display_known_means_maximized() {
        assert_eq!(placement(saved(200, 120, false), &[]), Placement::Maximize);
    }

    #[test]
    fn reads_the_main_window_from_the_plugin_file_and_nothing_else() {
        let json = r#"{"main":{"width":2560,"height":1600,"x":200,"y":120,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;
        assert_eq!(saved_window(json), saved(200, 120, false));
        assert_eq!(
            saved_window(r#"{"other":{"width":1,"height":1,"x":0,"y":0}}"#),
            None
        );
        assert_eq!(
            saved_window(r#"{"main":{"width":0,"height":0,"x":0,"y":0}}"#),
            None
        );
        assert_eq!(saved_window("not json"), None);
        assert_eq!(saved_window(""), None);
    }

    #[test]
    fn remembers_size_position_and_maximized_but_never_fullscreen_or_visibility() {
        assert!(
            STATE_FLAGS.contains(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        );
        assert!(!STATE_FLAGS
            .intersects(StateFlags::FULLSCREEN | StateFlags::VISIBLE | StateFlags::DECORATIONS));
    }
}
