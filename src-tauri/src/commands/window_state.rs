use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowFrameState {
    pub is_tiled: bool,
    pub is_maximized: bool,
    pub is_fullscreen: bool,
    pub native: bool,
}

#[cfg(target_os = "linux")]
pub const RELEVANT_STATE_MASK: gtk::gdk::WindowState = gtk::gdk::WindowState::from_bits_truncate(
    gtk::gdk::WindowState::TILED.bits()
        | gtk::gdk::WindowState::TOP_TILED.bits()
        | gtk::gdk::WindowState::RIGHT_TILED.bits()
        | gtk::gdk::WindowState::BOTTOM_TILED.bits()
        | gtk::gdk::WindowState::LEFT_TILED.bits()
        | gtk::gdk::WindowState::MAXIMIZED.bits()
        | gtk::gdk::WindowState::FULLSCREEN.bits(),
);

#[cfg(target_os = "linux")]
pub fn frame_state_from(state: gtk::gdk::WindowState) -> WindowFrameState {
    use gtk::gdk::WindowState;
    let is_tiled = state.intersects(
        WindowState::TILED
            | WindowState::TOP_TILED
            | WindowState::RIGHT_TILED
            | WindowState::BOTTOM_TILED
            | WindowState::LEFT_TILED,
    );
    WindowFrameState {
        is_tiled,
        is_maximized: state.contains(WindowState::MAXIMIZED),
        is_fullscreen: state.contains(WindowState::FULLSCREEN),
        native: true,
    }
}

pub fn should_emit(last: Option<WindowFrameState>, new_state: WindowFrameState) -> bool {
    match last {
        None => true,
        Some(prev) => prev != new_state,
    }
}

/// Returns the current window frame state (tiled, maximized, fullscreen, native).
///
/// This command MUST stay synchronous (not `async`) because GTK calls are only
/// safe on the main thread, and Tauri executes non-async commands on the main thread.
#[tauri::command]
pub fn get_window_state(window: tauri::WebviewWindow) -> WindowFrameState {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        if let Ok(gtk_win) = window.gtk_window() {
            if let Some(gdk_win) = gtk_win.window() {
                return frame_state_from(gdk_win.state());
            }
            // Window not yet realized: check `gtk_win.is_maximized()` so
            // pre-realized maximized state is detected.
            return WindowFrameState {
                is_tiled: false,
                is_maximized: gtk_win.is_maximized(),
                is_fullscreen: false,
                native: true,
            };
        }
    }

    WindowFrameState {
        is_tiled: false,
        is_maximized: window.is_maximized().unwrap_or(false),
        is_fullscreen: window.is_fullscreen().unwrap_or(false),
        native: false,
    }
}

/// Connects GTK window state event notifications on Linux to emit Tauri events.
#[cfg(target_os = "linux")]
pub fn install_gtk_bridge<R: tauri::Runtime>(app: &tauri::App<R>) {
    use gtk::prelude::*;
    use std::cell::Cell;
    use tauri::{Emitter, Manager};

    let Some(main_win) = app.get_webview_window("main") else {
        eprintln!("window_state: main window not found");
        return;
    };

    let Ok(gtk_win) = main_win.gtk_window() else {
        eprintln!("window_state: failed to obtain gtk window");
        return;
    };

    let app_handle = app.handle().clone();
    let last_state = Cell::new(None);
    gtk_win.connect_window_state_event(move |_widget, event| {
        let changed = event.changed_mask();
        if changed.intersects(RELEVANT_STATE_MASK) {
            let current = frame_state_from(event.new_window_state());
            if should_emit(last_state.get(), current) {
                last_state.set(Some(current));
                if let Err(e) = app_handle.emit("window-state-changed", current) {
                    eprintln!("window_state: failed to emit window-state-changed: {e}");
                }
            }
        }

        gtk::glib::Propagation::Proceed
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn relevant_state_mask_contains_expected_window_states() {
        use gtk::gdk::WindowState;

        assert!(RELEVANT_STATE_MASK.contains(WindowState::TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::TOP_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::RIGHT_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::BOTTOM_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::LEFT_TILED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::MAXIMIZED));
        assert!(RELEVANT_STATE_MASK.contains(WindowState::FULLSCREEN));
        assert!(!RELEVANT_STATE_MASK.contains(WindowState::ICONIFIED));
        assert!(!RELEVANT_STATE_MASK.contains(WindowState::STICKY));
    }

    #[test]
    fn window_frame_state_serializes_to_camel_case() {
        let state = WindowFrameState {
            is_tiled: true,
            is_maximized: false,
            is_fullscreen: true,
            native: true,
        };
        let json = serde_json::to_string(&state).expect("failed to serialize");
        assert_eq!(
            json,
            r#"{"isTiled":true,"isMaximized":false,"isFullscreen":true,"native":true}"#
        );
    }

    #[test]
    fn should_emit_deduplicates_identical_states() {
        let s1 = WindowFrameState {
            is_tiled: false,
            is_maximized: false,
            is_fullscreen: false,
            native: true,
        };
        let s2 = WindowFrameState {
            is_tiled: true,
            is_maximized: false,
            is_fullscreen: false,
            native: true,
        };

        // When no previous state, should emit
        assert!(should_emit(None, s1));
        // When state changed, should emit
        assert!(should_emit(Some(s1), s2));
        // When state is identical, should not emit
        assert!(!should_emit(Some(s1), s1));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn frame_state_from_maps_gdk_window_state_bits() {
        use gtk::gdk::WindowState;

        let empty = frame_state_from(WindowState::empty());
        assert_eq!(
            empty,
            WindowFrameState {
                is_tiled: false,
                is_maximized: false,
                is_fullscreen: false,
                native: true,
            }
        );

        let tiled = frame_state_from(WindowState::TILED);
        assert!(tiled.is_tiled);
        assert!(!tiled.is_maximized);
        assert!(!tiled.is_fullscreen);
        assert!(tiled.native);

        let left_tiled = frame_state_from(WindowState::LEFT_TILED);
        assert!(left_tiled.is_tiled);
        assert!(!left_tiled.is_maximized);
        assert!(left_tiled.native);

        let right_tiled = frame_state_from(WindowState::RIGHT_TILED);
        assert!(right_tiled.is_tiled);

        let top_tiled = frame_state_from(WindowState::TOP_TILED);
        assert!(top_tiled.is_tiled);

        let bottom_tiled = frame_state_from(WindowState::BOTTOM_TILED);
        assert!(bottom_tiled.is_tiled);

        let maximized = frame_state_from(WindowState::MAXIMIZED);
        assert!(!maximized.is_tiled);
        assert!(maximized.is_maximized);
        assert!(!maximized.is_fullscreen);
        assert!(maximized.native);

        let fullscreen = frame_state_from(WindowState::FULLSCREEN);
        assert!(!fullscreen.is_tiled);
        assert!(!fullscreen.is_maximized);
        assert!(fullscreen.is_fullscreen);
        assert!(fullscreen.native);

        let tiled_and_maximized = frame_state_from(WindowState::TILED | WindowState::MAXIMIZED);
        assert!(tiled_and_maximized.is_tiled);
        assert!(tiled_and_maximized.is_maximized);
        assert!(tiled_and_maximized.native);
    }
}
