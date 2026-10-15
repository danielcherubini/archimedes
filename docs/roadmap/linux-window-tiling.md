---
status: committed
done-when: When the Archimedes window is tiled or edge-snapped on Linux (Wayland and X11 in GNOME, KDE, etc.) as well as maximized or fullscreen, the outer container renders with square corners (`rounded-none`). When restored/floating, the outer container renders with rounded corners (`rounded-xl`).
---

# Native Linux Window Tiling & Edge-Snap Detection for Square Corners Plan

**Goal:** Authoritatively detect Linux window tiling/snapping (Wayland and X11) via native GTK `window-state-event` signals and remove window corner rounding (`rounded-none`) when tiled or maximized, while preserving Windows Snap geometry fallback on Windows.
**Architecture:** Expose GTK window state from the Rust backend via a shared pure derivation function `frame_state_from`, a signal connection in `setup()` emitting `"window-state-changed"` (deduped via `Cell<Option<WindowFrameState>>`), and a synchronous `get_window_state` command with `getWindowState()` and `listenWindowState()` wrappers in `src/lib/tauri.ts`. The DTO carries `native: bool` (true only on Linux). When `native: true`, native events authoritatively drive square corners; when `native: false`, Win32 geometry checks drive square corners.
**Tech Stack:** Rust (Tauri 2, GTK 3 / GDK 3 via `gtk` 0.18), TypeScript, React 19, Tailwind CSS, Vitest.

---

### Task 1: Rust Backend GTK Window State Signal & Command

**Context:**
On Wayland, client isolation prevents client windows from knowing their global desktop coordinates, causing `win.outerPosition()` to always return `(0, 0)`. Furthermore, upstream `tao` filters out `GdkWindowState::TILED` in its event loop. To detect tiling on Linux, the Rust backend must access the underlying `gtk::ApplicationWindow` on the main thread, listen to `window-state-event`, and emit the state to the frontend, as well as expose a synchronous `get_window_state` command for initial mount hydration.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/commands/window_state.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**What to implement:**
1. In `src-tauri/Cargo.toml`:
   Create the target dependencies section:
   ```toml
   [target.'cfg(target_os = "linux")'.dependencies]
   gtk = "0.18"
   ```
   (Matches `tao`'s dependency, no extra features needed since `gdk::WindowState::*TILED` is ungated in 0.18.2). Update `Cargo.lock`.
2. In `src-tauri/src/commands/window_state.rs`:
   - Define `WindowFrameState`:
     ```rust
     use serde::Serialize;

     #[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
     #[serde(rename_all = "camelCase")]
     pub struct WindowFrameState {
         pub is_tiled: bool,
         pub is_maximized: bool,
         pub is_fullscreen: bool,
         pub native: bool,
     }
     ```
   - On Linux, define pure helpers:
     ```rust
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
     ```
   - Define synchronous Tauri command (MUST NOT be async, ensuring execution on main thread for GTK safety):
     ```rust
     #[tauri::command]
     pub fn get_window_state(window: tauri::WebviewWindow) -> WindowFrameState {
         #[cfg(target_os = "linux")]
         {
             use gtk::prelude::*;
             if let Ok(gtk_win) = window.gtk_window() {
                 if let Some(gdk_win) = gtk_win.window() {
                     return frame_state_from(gdk_win.state());
                 }
                 // Window not yet realized: report native: true so frontend knows Linux GTK is active
                 return WindowFrameState {
                     native: true,
                     ..Default::default()
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
     ```
   - Add unit tests in `src-tauri/src/commands/window_state.rs` testing `WindowFrameState` serialization to camelCase JSON (`isTiled`, `isMaximized`, `isFullscreen`, `native`), `should_emit` deduplication logic, and (on Linux) `frame_state_from` mapping `WindowState::TILED`, `LEFT_TILED`, `MAXIMIZED`, etc.
3. In `src-tauri/src/commands/mod.rs`:
   Add `pub mod window_state;`.
4. In `src-tauri/src/lib.rs`:
   - Register `commands::window_state::get_window_state` in `.invoke_handler(tauri::generate_handler![...])`.
   - In `.setup(|app| { ... })`, after `setup_dirs` and before `Ok(())`:
     ```rust
     #[cfg(target_os = "linux")]
     {
         use gtk::prelude::*;
         use gtk::gdk::WindowState;
         use std::cell::Cell;
         use tauri::Emitter;

         if let Some(main_win) = app.get_webview_window("main") {
             if let Ok(gtk_win) = main_win.gtk_window() {
                 let app_handle = app.handle().clone();
                 let last_state = Cell::new(None);
                 gtk_win.connect_window_state_event(move |_widget, event| {
                     let changed = event.changed_mask();
                     let tiling_and_max_mask = WindowState::TILED
                         | WindowState::TOP_TILED
                         | WindowState::RIGHT_TILED
                         | WindowState::BOTTOM_TILED
                         | WindowState::LEFT_TILED
                         | WindowState::MAXIMIZED
                         | WindowState::FULLSCREEN;

                     if changed.intersects(tiling_and_max_mask) {
                         let current = commands::window_state::frame_state_from(event.new_window_state());
                         if commands::window_state::should_emit(last_state.get(), current) {
                             last_state.set(Some(current));
                             let _ = app_handle.emit("window-state-changed", current);
                         }
                     }

                     gtk::glib::Propagation::Proceed
                 });
             }
         }
     }
     ```

**Steps:**
- [ ] Create `[target.'cfg(target_os = "linux")'.dependencies]` in `src-tauri/Cargo.toml` with `gtk = "0.18"` and update `Cargo.lock`
- [ ] Write unit tests in `src-tauri/src/commands/window_state.rs` for `WindowFrameState` serialization, `should_emit`, and `frame_state_from`
- [ ] Implement `src-tauri/src/commands/window_state.rs` and export in `commands/mod.rs`
- [ ] Register `commands::window_state::get_window_state` and connect signal in `src-tauri/src/lib.rs`
- [ ] Run `cd src-tauri && cargo test`
  - Confirm all tests pass
- [ ] Run `cd src-tauri && cargo clippy --all-targets -- -D warnings`
  - Confirm 0 warnings
- [ ] Run `cd src-tauri && cargo fmt --check`
  - Confirm clean formatting
- [ ] Commit with message: `feat(desktop): native GTK window state event bridge on Linux`

**Acceptance criteria:**
- [ ] `get_window_state` returns camelCase JSON `{ isTiled, isMaximized, isFullscreen, native }`
- [ ] On Linux, `window-state-changed` emits on initial state and whenever GDK flags transition
- [ ] Cargo tests, clippy, and fmt pass with zero warnings

---

### Task 2: Frontend IPC Wrappers, Hook Integration & Tests

**Context:**
Per the repository's IPC conventions (see `src/lib/tauri.ts` and `src/lib/tauri.test.ts`), all Tauri commands and pushed events must have typed wrappers (`getWindowState` and `listenWindowState`) with wire contract tests. The hook `useWindowMaximized` uses the wrapper for hydration and subscription. When `native: true` (Linux), native events authoritatively drive square corners without interference from geometry checks; when `native: false` (Windows), geometry checks handle snapping and reliably return to rounded corners on un-maximize.

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/tauri.test.ts`
- Modify: `src/hooks/useWindowMaximized.ts`
- Modify: `src/hooks/useWindowMaximized.test.ts`
- Modify: `src/App.test.tsx`

**What to implement:**
1. In `src/lib/tauri.ts`:
   - Export `WindowFrameState` interface:
     ```typescript
     export interface WindowFrameState {
       isTiled: boolean;
       isMaximized: boolean;
       isFullscreen: boolean;
       native: boolean;
     }
     ```
   - Export `getWindowState()` and `listenWindowState()`:
     ```typescript
     export async function getWindowState(): Promise<WindowFrameState> {
       return invoke<WindowFrameState>("get_window_state");
     }

     export async function listenWindowState(
       handler: (payload: WindowFrameState) => void,
     ): Promise<() => void> {
       return listen<WindowFrameState>("window-state-changed", (event) =>
         handler(event.payload),
       );
     }
     ```
2. In `src/lib/tauri.test.ts`:
   - Add contract tests pinning `getWindowState()` to `"get_window_state"` and `listenWindowState()` to `"window-state-changed"`.
3. In `src/hooks/useWindowMaximized.ts`:
   - Import `getWindowState`, `listenWindowState`, `type WindowFrameState` from `../lib/tauri`.
   - Track `isNativeRef = useRef(false)`.
   - Track `hasReceivedEvent = useRef(false)`.
   - Setup `listenWindowState`:
     - When event arrives, set `hasReceivedEvent.current = true`.
     - If `event.native`, set `isNativeRef.current = true`.
     - If `event.isTiled || event.isMaximized || event.isFullscreen`, set `setIsSquare(true)`.
     - Else, if `event.native`, set `setIsSquare(false)`.
     - If not native, trigger `checkGeometry()`.
   - Query `getWindowState()` on mount:
     - If `!hasReceivedEvent.current`:
       - If `state.native`, set `isNativeRef.current = true`.
       - If `state.isTiled || state.isMaximized || state.isFullscreen`, set `setIsSquare(true)`.
   - In `checkGeometry()` (for non-native Windows/macOS):
     - If `isNativeRef.current` is true, do NOT run geometry check (Linux native state governs).
     - Otherwise, check `win.isMaximized()`, `win.isFullscreen()`, and `currentMonitor().workArea` against `outerPosition()` and `outerSize()`.
     - Set `setIsSquare(true)` if maximized/fullscreen/snapped; `setIsSquare(false)` if restored floating.
   - Attach resize and move listeners with debounce.
   - Clean up event unlisten, move unlisten, resize unlisten, DOM listener, and timers on unmount.
4. In `src/hooks/useWindowMaximized.test.ts`:
   - Mock `../lib/tauri` with `getWindowState: vi.fn()` and `listenWindowState: vi.fn().mockResolvedValue(() => {})`.
   - Test:
     - Mount hydration with `getWindowState` returning `{ isTiled: true, native: true }`.
     - Native event `"window-state-changed"` sets `isSquare(true)`.
     - Resize event with non-matching geometry DOES NOT clobber an active native `isTiled: true`.
     - Transition to unrounded when native event says `{ isTiled: false, isMaximized: false, native: true }`.
     - Non-native (Windows): hydrating `{ isMaximized: true, native: false }` and un-maximizing via resize correctly transitions to `false` (unrounded).
     - Non-native (Windows): geometry fallback detects snap when `native: false`.
     - Unmount cleanup.
5. In `src/App.test.tsx`:
   - In `vi.mock("./lib/tauri", ...)`, add `getWindowState: vi.fn().mockResolvedValue({ isTiled: false, isMaximized: false, isFullscreen: false, native: false })` and `listenWindowState: vi.fn().mockResolvedValue(() => {})`.

**Steps:**
- [ ] Add `WindowFrameState`, `getWindowState`, and `listenWindowState` to `src/lib/tauri.ts`
- [ ] Write failing tests in `src/lib/tauri.test.ts` for wire contracts
- [ ] Update `src/hooks/useWindowMaximized.ts` to consume `getWindowState` and `listenWindowState` with `native: bool` distinction
- [ ] Write tests in `src/hooks/useWindowMaximized.test.ts` (including Linux non-clobber and Windows un-maximize transition)
- [ ] Update `src/App.test.tsx` mocks
- [ ] Run `pnpm vitest run src/lib/tauri.test.ts src/hooks/useWindowMaximized.test.ts src/App.test.tsx`
  - Verify all tests pass
- [ ] Run `pnpm test`
  - Verify full test suite passes
- [ ] Run `pnpm build`
  - Verify clean TypeScript and Vite build
- [ ] Run `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
  - Verify Rust suite is green
- [ ] Commit with message: `fix(desktop): consume native window state for Linux edge tiling`

**Acceptance criteria:**
- [ ] `getWindowState` and `listenWindowState` wrappers are tested in `tauri.test.ts`
- [ ] `useWindowMaximized` returns `true` when tiled or maximized on Linux
- [ ] Linux native state is never clobbered by resize geometry checks
- [ ] Windows/non-native floating windows correctly un-maximize back to `rounded-xl`
- [ ] Full quality gates pass cleanly across frontend and Rust
