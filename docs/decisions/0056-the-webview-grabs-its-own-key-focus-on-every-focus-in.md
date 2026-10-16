---
status: accepted
date: 2026-10-16
superseded-by:
---

# The webview grabs its own key focus at `Ready` and on every focus-in, because the window's focus does not imply it

On Linux (WebKitGTK) the app launched and ignored every key until the user clicked inside the window — not just a shortcut: the composer took no typing and `Escape` could not stop a turn. GTK has two focuses and we only ever asked for one: `tauri-plugin-window-state` reveals our `visible: false` window with `show()` + `set_focus()`, and that `set_focus` is **window-level** (tao presents the GTK window); the WebKitGTK *widget* is never made the keyboard-focus widget, because wry's `grab_focus()` runs only at webview creation and our window is unmapped at that moment. So we call `Webview::set_focus()` — the webview-level lever, `grab_focus()` under the hood — from the existing `run` callback on `RunEvent::Ready` **and** on every `RunEvent::Focused(true)`, through one `grab_webview_key_focus` seam.

## Considered Options

- **`Ready` only (rejected).** Fixes the one reproducible state and nothing else. Every other path that maps the window without establishing a focus widget — minimise/restore, a Wayland re-map — re-creates the bug, and we have not enumerated those paths, so each would return as a fresh report of "the keyboard stopped working".
- **Native menu items with accelerators (rejected).** Registers a visible menu bar on every platform, and it is the wrong layer: it routes one chord while typing and `Escape` stay dead at launch. The missing focus is the cause; a menu is a second way to ask for one key.
- **A frontend workaround — focus a DOM element on mount (rejected).** Structurally incapable: DOM focus inside a webview widget that holds no GTK key focus receives nothing, so the renderer cannot fix this from inside itself.

## Consequences

- **The `Focused(true)` repeat is load-bearing, not belt-and-braces.** A future reader will see focus being re-asserted on a state the app is already in and be tempted to delete it as redundant; it is the half that makes the fix self-healing rather than point-specific.
- **It is safe to re-assert because it is not DOM focus.** `grab_focus()` selects the keyboard-focus *widget* of the GTK window and cannot move the caret or steal selection from the composer, which is why repeating it on every focus-in costs the page nothing. Do not "optimise" it into a one-shot latch on the assumption it steals focus — it does not.
- **`Ready` is the earliest workable moment, and `setup` is provably too early.** Tauri's own `setup()` — which creates the config-declared window and fires the window-state plugin's reveal — runs inside the `RuntimeRunEvent::Ready` arm *before* the user callback, so a `Ready` handler is strictly after the reveal and cannot race the plugin. Grabbing focus from our `setup` closure would repeat the exact no-op this fixes. This is the reason the call sits in the `run` callback next to `RunEvent::Exit` rather than in `setup`.
- **Reach for the webview through `WebviewWindow`, not `Manager::get_webview`.** `get_webview` is `#[cfg(feature = "unstable")]` and therefore not ours to use; `AsRef<Webview<R>> for WebviewWindow<R>` is ungated and is how `set_focus()` is reached without enabling an unstable feature or adding a dependency.
- **Behaviour is untestable headless.** The `tauri::test` mock runtime has no widget, so Rust tests pin only that the arms route through the seam; the real check is an `#[ignore]`d, human-read test following `tests/attention_alert_survives.rs` — launch, click nothing, press a key. A future contributor should expect no green test to point at this fix.
- **Whether tao's own guard also rejects is unestablished and deliberately not relied on.** `tao`'s `Window::set_focus` is gated on `!minimized && window.get_visible()`; whether that reads false during the plugin's reveal depends on when GTK flips `get_visible()` relative to tao's queued visibility request. Nothing in this decision depends on the answer, and the plugin's call is left untouched — so if it turns out the plugin's `set_focus` was silently doing nothing all along, that is a separate finding, not a prerequisite.
