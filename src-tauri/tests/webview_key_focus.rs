//! The MANUAL check behind the webview key-focus fix: does the lever that
//! `run`'s `Ready` / focus-in arms pull actually make keys reach the renderer?
//!
//! ```text
//! cd src-tauri && cargo test --test webview_key_focus -- --ignored --nocapture
//! ```
//!
//! # Why a person has to run this
//!
//! The symptom is confirmed — on a fresh launch, with the window never clicked,
//! no key event reaches JS at all: not the `⌘/Ctrl+N`/`⌘/Ctrl+O` chords, not
//! typing into the composer, not `Escape`. Clicking a neutral area of the window
//! makes every one of them work. What is NOT confirmed is *why*, and the fix in
//! `lib.rs` (`grab_webview_key_focus`) is therefore a **candidate**, not a
//! verified repair. The earlier theory — that wry's creation-time `grab_focus()`
//! lands on an unmapped widget because the window is `visible: false` — was
//! refuted outright (`WebviewAttributes::from(&WindowConfig)` never sets
//! `visible`, wry defaults it true, so `show_all()` and `grab_focus()` both run
//! on a realized widget; ADR 0056 records that refutation, and 0057 — which
//! supersedes 0056 — inherits it. **The decision you are testing is 0057's**, so
//! every instruction below names 0057.
//!
//! Nothing in the headless suite can settle it. The mock runtime has **no
//! widget**: `MockRuntime` fakes window and webview handles, so `set_focus()` on
//! one answers `Ok(())` for a widget that does not exist, and no key event has
//! anywhere to go. And a real `App` cannot be built inside the lib unit-test
//! binary at all — a second `generate_context!()` there duplicates
//! `embed_plist`'s `_EMBED_INFO_PLIST`, which is a *link* error that reddens
//! macOS `cargo test` while `cargo clippy`/`check` (metadata-only) stay green.
//! So the only headless coverage is the pure reduction `webview_focus_trace`
//! (what the attempt *says*), and **no green test points at the behaviour
//! itself**. This file is the behaviour's check, and a human with a keyboard is
//! the only instrument that can take the measurement.
//!
//! # What makes the run self-reading
//!
//! `webview_focus_trace` narrates ALL THREE outcomes — success included. That is
//! deliberate and it is what turns "I pressed the keys and nothing seemed to
//! change" into a verdict: without a success line, "keys dead, no log line" is
//! ambiguous between *the arm never ran* and *the arm ran and worked*, which are
//! opposite diagnoses (one means the fix is in the wrong place, the other means
//! the whole hypothesis is wrong). An absent `focus:` line now means exactly one
//! thing: the arm never ran.

/// The measurement, step by step. The body of this test panics — an ignored
/// test's body never runs, so the recipe lives in the panic message too and this
/// command prints the whole thing without opening the source:
///
/// ```text
/// cargo test --test webview_key_focus -- --ignored --nocapture
/// ```
#[test]
#[ignore = "MANUAL: launches the real app at a desktop session and measures whether keys \
            reach JS before the first click — run with `cargo test --test webview_key_focus \
            -- --ignored --nocapture` and read the recipe it prints"]
fn keys_reach_the_renderer_before_the_window_is_ever_clicked() {
    panic!(
        r#"MANUAL RECIPE — read the doc comment (this body never runs; the panic IS the recipe)

WHAT YOU ARE MEASURING
    Whether asserting the webview WIDGET's key focus (ADR 0057) is what makes key
    events reach the renderer on a window that has never been clicked. The fix is
    shipped as a CANDIDATE; the mechanism is UNVERIFIED. Your log lines settle it.

1. WATCH THE LOG, THEN LAUNCH
   Terminal A:
       ARCHIMEDES_DEBUG=1 pnpm tauri dev          # from the repo root
   Terminal B:
       tail -f ~/.local/share/archimedes/supervisor.log | grep --line-buffered 'focus:'
   The file is created LAZILY on the first write (nothing exists until the app
   logs something) and it is SHARED with every Worker-IPC line, hence the grep —
   always filter on the `focus:` prefix rather than reading the file raw. On other
   platforms the same file sits under `dirs::data_dir()/archimedes/`:
   `~/Library/Application Support/archimedes/supervisor.log` (macOS),
   `%APPDATA%\archimedes\supervisor.log` (Windows).

2. PRESS THE CHORD WITHOUT TOUCHING THE WINDOW
   Once the window is on screen, click NOTHING — do not move the pointer into it,
   do not focus the frame. Press `Ctrl+O` (`⌘O` on macOS).
   RECORD: does the Open Space dialog open?

3. READ THE LOG — THE LINE IS THE VERDICT
   `focus: webview key focus grabbed` .............. the lever fired and was accepted
   `focus: no window labelled "main" ...` .......... the arm ran TOO EARLY (no window yet)
   `focus: webview set_focus refused: <msg>` ....... the widget refused; read <msg>
   NO `focus:` line at all ......................... `Ready` never reached the callback
   (A second line at window appearance is expected: the plugin's reveal is a
   window activation, so the focus-in arm usually grabs once more. Two lines with
   the same wording is normal, not a double-grab bug.)

4. EXERCISE THE FOCUS-IN ARM ON PURPOSE
   Minimise the window, then restore it, and press `Ctrl+O` again. This is the
   focus-out/in cycle that the second arm exists for — minimise/restore re-maps
   the window without anything re-asserting the widget's focus, which is how the
   symptom returns even if step 2 passes.
   ⚠ Linux/macOS ONLY. Windows never delivers `WindowEvent::Focused(true)` for a
   window of our shape (one webview, no children), so on Windows that arm cannot
   fire and step 4 proves nothing — record it as "not applicable", not "failed".

THE FOUR VERDICTS (say which one, and quote the log lines)
  (a) Dialog OPENS at step 2, and the log shows `focus: webview key focus grabbed`
      → the fix is CONFIRMED. Quote the line in the report; ADR 0057's first
        consequence ("The fix ships as a candidate") is where the verdict belongs.
  (b) Dialog STILL DEAD at step 2, and the log shows `... grabbed`
      → the widget-focus hypothesis is WRONG. The lever fired and changed nothing.
        Supersede ADR 0057 with whatever the actual cause is — do not "tweak and
        retry" a call that is known to have been made and to have had no effect.
  (c) STILL DEAD, and there is NO `focus:` line at all
      → the `Ready` arm never ran, so nothing was ever attempted. Re-plan: the fix
        has to live wherever the reveal actually happens. (If instead the line
        says `no window labelled "main"`, the arm DID run but before the config
        window existed — a different bug, and one the label names.)
  (d) The chord ALREADY WORKS at step 2 on a build WITHOUT the fix (stash the two
      `run`-callback arms and repeat)
      → there was nothing to fix here; the symptom lives upstream (window
        presentation / the compositor's focus award), and the seam should be
        removed rather than left as a placebo that closes the report.

WHY THE LOG LINE IS WHAT DECIDES
    Steps 2 and 4 only tell you the keys are dead or alive. Verdicts (b) and (c)
    are indistinguishable from the keyboard alone — both look like "nothing
    changed" — and they demand opposite responses (withdraw the hypothesis vs
    move the call). The `focus:` line is the only evidence that separates "we
    tried and it did nothing" from "we never tried", which is exactly why the seam
    narrates its SUCCESS as well as its failures. Read the log before you trust
    your eyes."#
    );
}
