---
status: accepted
date: 2026-10-18
superseded-by:
---

# The focus-in key-focus grab is withheld on Windows, because there `Focused(true)` IS the webview's widget-focus event — and re-asserting it eats the click

A Windows user's report: **nothing is clickable, typing does not reach the app, hovering works, and the text field visibly gains and loses focus in a loop.** That is not a regression in the renderer and not a Windows input bug — it is ADR 0057's `Focused(true)` arm doing exactly what 0057 argued it could never do. We decided: keep the grab on `RunEvent::Ready` on every platform, and keep the `Focused(true)` re-assert on Linux and macOS only. On Windows the focus-in arm must not fire.

The decision is expressed as one pure function, `key_focus_grab_needed(is_windows, trigger)` (`src-tauri/src/lib.rs`), called with `cfg!(windows)` passed in as **data**. That shape is not stylistic: a `cfg`-gated `match` would compile the Windows branch out of the Linux test binary, and the Windows branch is the thing under test. Two mutants are therefore pinned on a Linux machine — removing the gate (the shipped bug) and over-removing `Ready` — and each fails a named test.

## The correction — 0057's delivery matrix is wrong about Windows

ADR 0057 was written after reading `WindowEventWrapper::map_from_tao`, and its matrix records Windows as **"No"** for `WindowEvent::Focused(true)`, with the safety conclusion: *"the focus-in arm runs on Linux and macOS, never on Windows; where it runs it fires on window activation, so it cannot steal a sibling widget's focus."* Reading only that function, that is correct — for our window shape the `#[cfg(windows)]` path there really does return `Self(None)`.

But `map_from_tao` is not the only producer of that event on Windows. `tauri-runtime-wry` installs WebView2 **controller** handlers when it builds the webview:

```rust
#[cfg(windows)]
{ … controller.add_GotFocus(&FocusChangedEventHandler::create(Box::new(move |_, _| {
        … proxy_clone.send_event(Message::Webview(…, WebviewMessage::SynthesizedWindowEvent(
            SynthesizedWindowEvent::Focused(true))))   // ← the event 0057 says Windows never sends
```
(`tauri-runtime-wry-2.11.4/src/lib.rs:5293-5310`)

and that message is dispatched into the very `RunEvent` 0057's arm matches:

```rust
Event::UserEvent(Message::Webview(_, _, WebviewMessage::SynthesizedWindowEvent(event))) => {
    if let Some(event) = WindowEventWrapper::from(event).0 { … callback(RunEvent::WindowEvent { label, … }) }
} // :4237-4252
```

0057 cited this handler as the *alternative* to delivery ("Windows routes webview focus through `add_GotFocus`/`add_LostFocus` **instead**") without following where it sends its message. It sends it to us.

**Read the corrected row: on Windows `Focused(true)` is delivered, and it means the WEBVIEW WIDGET gained focus — including from a click on the webview.** Window activation and element clicks both arrive. The case 0057 argued was impossible is the case that happens on every click.

## Why that is fatal on Windows specifically

`Webview::set_focus()` is not the same operation per platform. On Windows it reaches wry's `focus()` → `MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)` (`wry-0.57.0/src/webview2/mod.rs:1583-1590`), and Microsoft defines what that does:

> WebView gets focus and focus is set to correspondent element in the page hosted in the WebView. **For Programmatic reason, focus is set to previously focused element or the default element if no previously focused element exists.** — `ICoreWebView2Controller::MoveFocus`

So the loop is: click an input → WebView2 `GotFocus` → `Focused(true)` → our arm → `MoveFocus(PROGRAMMATIC)` → WebView2 moves DOM focus to the *previously* focused element (or the default one). The programmatic move races and undoes the focus assignment the click itself was making. The caret lands and is pulled back out — the visible flicker — and the interaction never settles into a focused element, so the click appears to do nothing and keystrokes have no target. Hovering is unaffected because it never touches focus, which is exactly the reported shape: hover fine, click dead, focus oscillating.

**And on Windows the grab was never needed there in the first place.** wry performs the same `MoveFocus(PROGRAMMATIC)` itself, twice: at webview creation when `attributes.focused` (`:610-615`) and in the parent-window subclass for `WM_SETFOCUS | WM_ENTERSIZEMOVE` (`:1325-1328`) — i.e. wry already re-asserts webview focus on real window focus-in, on Windows, unconditionally. Our arm was duplicating wry's own handler and, worse, firing on a trigger wry deliberately does not use. Removing it on Windows gives up nothing.

## Corrected delivery matrix (replaces 0057's)

| Platform | `Focused(true)` delivered? | Emitted from | Meaning of the trigger | Grab on focus-in? |
|---|---|---|---|---|
| Linux (WebKitGTK) | Yes | tao `connect_focus_in_event` (`tao-0.37.1/src/platform_impl/linux/event_loop.rs:641`), via the `#[cfg(not(windows))]` early return (`tauri-runtime-wry/src/lib.rs:522-524`) | GtkWindow focus-in = **window activation** | **Yes** |
| macOS (WKWebView) | Yes | tao `window_did_become_key` → `Focused(true)` (`tao-0.37.1/src/platform_impl/macos/window_delegate.rs:379`), same early return | `windowDidBecomeKey:` = **window becoming key** | **Yes** |
| Windows (WebView2) | **Yes** — 0057 said No | `tauri-runtime-wry`'s `add_GotFocus` on the webview controller (`:5293-5310`) → dispatch `:4237-4252`. `map_from_tao` suppresses only its OWN copy | **webview WIDGET** focus — activation *or* a click inside the page | **No** — see above |

Everything else in 0057 stands: the `Ready` arm, the label filter, the `&event`/`..`/guard `RunEvent` shape traps, the macOS `Webview::focus()` unwrap hazard, and its two corrections of 0056 (macOS does deliver the event; on Linux it is activation, not a widget change). 0057's error was one row of a matrix it derived from a single function.

## Considered Options

- **Gate the whole grab off Windows (`is_windows → false` for every trigger) (rejected).** This was this branch's first implementation, and it is wrong for a reason worth recording: it changes the Windows **startup** path, which has shipped unchanged since v0.3.0 with no complaint attached to it, on the one platform nobody here can test. `Ready` fires once before any interaction exists, so it cannot take part in the click loop. A fix should remove the arm that causes the failure, not the arm next to it. Pinned by `windows_still_grabs_once_at_ready`.
- **Keep the focus-in grab on Windows but skip it when the window "is already focused" (rejected).** The state needed to distinguish "click inside the webview" from "window activation" is exactly what `tauri-runtime-wry` keeps internally (`window.focused_webview`) and does not expose; re-implementing that guesswork in app code to keep an arm wry already performs is the larger risk.
- **Fix it in the renderer — e.g. restore focus on `blur` (rejected).** The DOM is the victim here, not the cause. A renderer workaround would fight a Rust-side focus move with a second focus move, which is how focus bugs become unfixable.
- **Reproduce on a Windows machine first (rejected as a blocker, kept as the verification).** This repo has no Windows host — the same constraint 0057 recorded, and the reason its Windows row went unexamined. The chain is read from the resolved crates and Microsoft's own contract for the one API call involved; step 5 of `src-tauri/tests/webview_key_focus.rs` is the on-machine confirmation. The diagnosis is also directly falsifiable in the field: the grab narrates itself, so a Windows log gaining a `focus:` line during a click means the diagnosis was wrong.

## Consequences

- **The Windows row of any future focus work is "delivered, widget-scoped".** The mistake that produced this bug was deriving an event's *meaning* from one of its producers. `Focused(true)` has two producers on Windows with different meanings, so the meaning is the minimum over both. Do not re-derive this from `map_from_tao`.
- **Platform-dependent behaviour now needs a `cfg`-free seam, and this one is the template.** `key_focus_grab_needed(is_windows: bool, …)` takes the platform as an argument. A `#[cfg(windows)]` arm cannot be tested by the platform that ships the fix, and CI on Linux/macOS is silent about it.
- **`Ready` remains a candidate, still unmeasured, on Windows included.** 0057's first consequence — the mechanism behind the fresh-launch symptom is unverified — is untouched by this change, and step 1–4 of `webview_key_focus.rs` still own that measurement. What changed is only that the second arm no longer runs on Windows.
- **Windows users on v0.3.0 and v0.3.1 are broken and need a patch release.** The arm shipped in 0057's change (PR #31), which is in both releases; the asset shape and updater path are healthy, so a v0.3.2 is the whole remedy. Until then the workaround is nothing — the app is unusable on Windows past launch.
- **This is the second ADR in two days whose platform claim was accepted on inspection of one upstream function.** The first (0052, amended today) asserted a payload layout that upstream code contradicted. The shared failure mode is quoting a helper without following its consumers, and the mitigation is the same in both: cite the path the bytes/events actually take, and gate the claim with a test rather than with a comment.
