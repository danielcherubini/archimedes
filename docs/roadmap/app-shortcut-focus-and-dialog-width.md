---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/29
done-when: On a Linux (WebKitGTK) build launched fresh and NEVER clicked, `Ctrl+O` opens the Open Space dialog and `Ctrl+N` starts a Session; with the caret in the composer, both still fire; both work with the Settings page open; and the New Space dialog renders ~28rem wide instead of viewport-minus-32px, with `pnpm test`, `pnpm build`, `cargo test`, `cargo clippy --all-targets` and `cargo fmt --check` all green.
---

# App-wide shortcuts, the webview's key focus, and the dialog width default

Three defects, reported as one ("Ctrl+N and Ctrl+O don't work") plus one caught on the way
("why is the New Space modal SO wide"). They share a symptom surface — a keyboard command or a
dialog that is not what the user expects — and nothing else. Each has its own exit condition;
none depends on another shipping first, though the shortcut is only *fully* repaired when
Tasks 1–3 have all landed.

Citations name **symbols, not line numbers**, following the convention set in
`compaction-recovery-hardening-follow-ups.md`: a line number re-drifts on every commit and a
stale one points a reader at the wrong code.

---

## 1. The WebView never receives a key event until the user clicks it

### What is wrong

Two different things are called "focus" in GTK, and this app only ever asks for the second:

| | What it means | Who does it today |
|---|---|---|
| **Window focus** | the OS/GTK *window* is the active window | `tauri-plugin-window-state` calls `show()` then `set_focus()` when it reveals the window (`restore_state`, `lib.rs`); tao's `WindowRequest::Focus` presents the GTK window |
| **Webview key focus** | the WebKitGTK *widget* is the keyboard-focus widget *inside* that window | **nobody** |

With no key-focus widget, WebKit dispatches no `keydown` into JS at all. So the fresh-launch
symptom is not about our chord: **no key reaches the renderer** until the user clicks the
webview's content — not `Ctrl+N`, not `Escape` (the stop-inference listener in `ChatStream` is
equally deaf), not typing. The chord is simply what the user happened to reach for.

Two verified details:

- wry grabs widget focus only at creation — `attributes.focused` runs `grab_focus()` inside the
  webview constructor (`wry/src/webkitgtk/mod.rs`, guarded by `attributes.visible`). Our window is
  declared `"visible": false` in `tauri.conf.json` (the app reveals itself only after the plugin
  restores its geometry), so that call lands on an unmapped widget and does nothing.
- tao's `Window::set_focus` is itself guarded by `!minimized && window.get_visible()`
  (`tao/src/platform_impl/linux/window.rs`), so the plugin's window-level call is suspect in the
  same breath. Whether that guard rejects depends on when GTK's `get_visible()` flips relative to
  tao's queued `WindowRequest::Visible` — **not established, and it does not matter**: the fix is
  a different lever either way.

This is upstream behaviour, not our misuse: [wry #739](https://github.com/tauri-apps/wry/issues/739)
reports keyboard events arriving only "once clicking content within the window".

### Fix

Extend the existing `run` callback in `src-tauri/src/lib.rs` (which already handles
`RunEvent::Exit`) to grab **webview-level** focus, and repeat it on every focus-in:

```rust
if let tauri::RunEvent::Ready = event { … }
if let tauri::RunEvent::Focused(true) = event { … }
```

both calling one small seam, `grab_webview_key_focus(handle)`, that resolves the main window and
asks its **webview** to focus.

The lever needs no new dependency and no `unstable` feature:

`AppHandle::get_webview_window("main")` → `AsRef<Webview<R>> for WebviewWindow<R>`
(`tauri/src/webview/webview_window.rs`) → `Webview::set_focus()` (plain `pub fn`, **not**
feature-gated, `tauri/src/webview/mod.rs`) → `tauri-runtime-wry`'s `WebviewMessage::SetFocus` →
wry `Webview::focus()` → `webview.grab_focus()` (`wry/src/webkitgtk/mod.rs`).

Note which sibling is NOT usable: `Manager::get_webview` is `#[cfg(feature = "unstable")]`, so it
is out; the `AsRef<Webview<R>>` impl on `WebviewWindow` is not gated, and it is how we get there.

**Why `Ready` and not `setup`.** Ordering is verified in tauri's source, not assumed: tauri's own
`setup()` — which creates the config-declared window and fires the window-state plugin's
`on_window_ready` → `restore_state` → `show()`/`set_focus()` — runs *inside* the
`RuntimeRunEvent::Ready` arm, **before** the user callback is invoked
(`tauri/src/app.rs`, `make_run_event_loop_callback`). Our `Ready` handler therefore runs strictly
after the reveal and cannot race the plugin. Calling `grab_focus()` earlier (e.g. from `setup`)
would repeat the exact no-op this fix exists to remove.

**Why the `Focused(true)` repeat is not decoration.** `grab_focus()` on the widget selects the
keyboard-focus *widget* of the GTK window; it never touches DOM focus, so it cannot steal a caret
from the composer or move selection inside the page. That makes it safe to re-assert on every
focus-in, which in turn makes the fix self-healing when the same gap is re-created by
minimise/restore or a Wayland re-map — paths we have not enumerated and will not have to reason
about. Doing `Ready` alone fixes one reproducible state and leaves the rest to be rediscovered as
bug reports.

### Testing

The `tauri::test` mock runtime accepts the call but has no widget, so a Rust test can pin the
*shape* only: that `grab_webview_key_focus` is the single seam and that the `Ready`/`Focused` arms
route through it. Behaviour is unobservable headless, so the real verification follows this repo's
established pattern for live-desktop behaviour — `src-tauri/tests/attention_alert_survives.rs`
(its module doc states exactly why a human must run these) — as an `#[ignore]`d, human-read check
with the recipe in the doc comment:

1. `pnpm tauri dev` (or the built AppImage), launch, **click nothing**, press `Ctrl+O` → the Open
   Space dialog opens.
2. Same, press a printable key → the composer receives it (typing works without clicking first).
3. Minimise, restore, press `Ctrl+O` → still opens (the `Focused(true)` arm).

---

## 2. The chord yields to any text field, and lives inside one view

Two renderer bugs, both in the `keydown` effect in `SpacesList` (`onKeyDown`).

### 2a. The guard treats "caret is in a text field" as "not our key"

The guard returns early when `e.target` is inside
`"input, textarea, [contenteditable]:not([contenteditable='false']), [role='dialog']"`. The
composer is a `textarea` (`ComposerRow`), nothing ever blurs it after a send (there is no `blur()`
in `ChatStream`/`ComposerRow`), and the app has no auto-focus on mount — so one keystroke parks
focus in the composer for the rest of the session and both chords go permanently dead. Combined
with §1, the only state in which `Ctrl+N` worked was "after clicking a neutral area and before
typing anything", which no user chooses to be in.

**Fix — drop the text-field matches, keep the dialog one:**

```diff
- "input, textarea, [contenteditable]:not([contenteditable='false']), [role='dialog']"
+ "[role='dialog']"
```

A `Cmd`/`Ctrl` chord is an app command, not text editing; this is what browsers and native apps do
(`⌘N`/`⌘F` work with the caret in a textarea). `[role='dialog']` alone is sufficient: Radix moves
focus *inside* `DialogContent`, so an `<input>` in the New Space dialog still matches via
`closest()` and chords stay inert in a modal. No conflict with `ComposerRow`, which owns
Enter/Tab/arrows/Escape and takes no `Ctrl`/`Meta` chord.

Accepted cost, stated so it is a decision and not an oversight: on **macOS**, a literal `Ctrl+N`
inside the composer no longer moves the caret down one line (the Emacs binding). `⌘N` already won
before this change. macOS caret movement keeps `↓` and every other binding.

### 2b. The listener is mounted inside `SpacesList`, which the Settings view unmounts

`App` renders `SpacesList` only in the workspace branch (`view === "settings"` swaps in
`SettingsPage`), so on the Settings page there is no listener at all. The codebase already draws
this line deliberately for another app-wide concern: `useAttentionAlert()` is mounted at `App`
root and its comment says *"VIEW-INDEPENDENT … mounted with the app, not with the workspace, so a
pause still alerts while the Settings page is open"*. The shortcuts were the opposite, with no
stated reason.

Hoisting the listener to `App` root drags two dependencies, and they are the real work here:

| What the handler needs | Where it lives today |
|---|---|
| the open flag + the `<NewSpaceDialog>` render | `useState` in `SpacesList` |
| the start action, and `newSession.error` for display | `useStartNewConversation(activeView)`; `SpacesList` renders the error as a `title` on the actions menu |

**Design: the command moves into the `useSessions` store.**

- `startSessionInActiveSpace(): Promise<void>` — an async store action doing what
  `handleNewSession` does today: no active Space → set the open flag; else `startSession(view.path)`
  → `addSession` → `addSpace`. A `newSessionError: string | null` field carries the failure for
  `SpacesList` to render, replacing the hook's local `error` state.
  This is established shape, not a new one: `closeSpace` is already an async action in that store,
  and this action is nothing but `startSession` → `addSession` → `addSpace`. The hook's `inFlight`
  double-invoke guard moves with it and becomes app-global, which is correct — there is one active
  Space and one new-session flow, and two entry points firing it concurrently is the bug the guard
  exists for.
  `useStartNewConversation` is `SpacesList`'s only consumer, so it is absorbed rather than kept
  alongside a second owner of the same flow.
- The **dialog-open flag** goes in a tiny module mirroring `src/lib/leftPaneState.ts` — the
  existing pattern for a UI flag shared across a subtree that unmounts: no store, no React,
  `get`/`set`/`subscribe` with `useSyncExternalStore`. Unlike the left pane it is **not persisted**
  (an auto-opened dialog on launch is not state worth restoring).
- `<NewSpaceDialog>` moves to `App` root, mounted on that flag, exactly as `SubagentModals` sits
  at the root for the same reason (a surface that must survive the view swap).
- The **listener** becomes a root-level hook (`useAppShortcuts`), mounted once beside
  `useAttentionAlert()` in `App`.
- **One derivation of the active Space, not two.** The handler needs the active `SpaceView`, which
  `SpacesList` currently builds inline (`views` → `views.find(v => v.path === activeSpacePath)`).
  Re-deriving it at the root would give the same rule two owners — precisely the failure
  `src/hooks/useActiveSpaceCwd.ts` was extracted to prevent, and its doc says so: *"a second
  consumer re-deriving it is how the two silently disagree, so the rule is one module, not one
  selector per component."* So: extract `useActiveSpaceView()`, and have `SpacesList` and the
  command surface both read it. It keeps that hook's stated rule — return the value directly,
  never a fresh object, or Zustand re-renders forever.

The existing fallback is preserved verbatim: no active Space (none yet, or the last one closed) →
`⌘N` opens the dialog instead of starting a Session.

### Testing

`SpacesList.test.tsx`'s `"ignores ⌘N / Ctrl+O while the target is an input or a dialog"` asserts
the opposite of what we now want; its **dialog** half stays, its **input** half is inverted.

The deeper gap, and the reason these chords could break unnoticed: every existing shortcut test
dispatches on `window`, whose `event.target` is a `Window` — not an `HTMLElement` — so the
`e.target instanceof HTMLElement` branch was **never executed** by any of them. The tests asserted
the chord works in a state the app cannot produce. New pins:

- `Ctrl+N` targeted at a focused `<textarea>` **fires** (the case the old suite could not see).
- `Ctrl+O` targeted at an element inside `role="dialog"` does **not** fire.
- `Ctrl+O` fires with the **Settings view open** — asserted in `App.test.tsx`, which already owns
  the gear/Back view-swap tests.
- the `contenteditable="false"` pin (guard matches the attribute's presence except `false`) is
  deleted with the guard it tested, not converted.

---

## 3. `DialogContent` has no width default

`DialogContent`'s base class carries `w-full max-w-[calc(100%-2rem)]`. `w-full` on a `fixed`
element resolves against the **viewport**, and the only cap is `100% − 2rem`, so a dialog that
passes no width of its own renders the whole window minus 16px a side. `NewSpaceDialog` is the
only caller that passes none — every sibling caps itself (`max-w-md` on the four confirms,
`max-w-lg` in `McpSection`, `max-w-3xl` in `ModelPickerDialog`/`SkillsDialog`).

The intent is visible next door: **`AlertDialogContent`'s base class already carries
`sm:max-w-md`**. The AlertDialog primitive has a default, the Dialog primitive does not. That
asymmetry is the bug.

**Fix — give the primitive the same default:** append `sm:max-w-md` to `DialogContent`'s base,
leaving `max-w-[calc(100%-2rem)]` in place so narrow windows still fit. `NewSpaceDialog` then needs
no class of its own.

### The migration trap, and why seven files change for a one-class fix

`cn()` is `tailwind-merge` (`extendTailwindMerge` in `components/lib/utils`). `max-w-3xl` and
`sm:max-w-md` are **different merge groups** — the modifier differs — so both survive to CSS, and
the `sm:`-prefixed one wins above its breakpoint regardless of the order in the `class` attribute.
Verified against this repo's emitted CSS (`dist/assets/index-*.css`): `.max-w-md` and `.max-w-3xl`
sit in the plain utilities, while `.sm\:max-w-md` lives in a later `@media (width>=40rem)` block.

So a base `sm:max-w-md` would silently shrink `ModelPickerDialog` and `SkillsDialog` from 48rem to
28rem, and **no unit test would notice** — jsdom measures no layout. Every caller therefore moves
to the `sm:` form, so that one merge group is always contested head-to-head and the caller's class
is the later one:

| File | Now | Becomes |
|---|---|---|
| `NewSpaceDialog` | *(none)* | *(none — takes the new default)* |
| `DeleteSessionDialog` | `max-w-md` | `sm:max-w-md` |
| `CloseSpaceDialog` | `max-w-md` | `sm:max-w-md` |
| `SudoConfirmModal` | `max-w-md` | `sm:max-w-md` |
| `SudoPasswordModal` | `max-w-md` | `sm:max-w-md` |
| `settings/McpSection` | `max-w-lg` | `sm:max-w-lg` |
| `ModelPickerDialog` | `max-h-[70vh] max-w-3xl` | `max-h-[70vh] sm:max-w-3xl` |
| `SkillsDialog` | `max-h-[70vh] max-w-3xl` | `max-h-[70vh] sm:max-w-3xl` |

The four `max-w-md` callers already look correct, and are converted anyway: leaving them means two
rules for one property ("some widths rely on merge luck, some on the default"). Unchanged:
`alert-dialog.tsx` (already correct) and `SubagentDetailHost` (a `fixed` panel, not a
`DialogContent`).

### Testing

jsdom measures no layout, so the pin is the class string, read off the existing
`data-slot="dialog-content"` attribute:

- a dialog that passes no width carries `sm:max-w-md`;
- `ModelPickerDialog`'s content carries `sm:max-w-3xl` **and no unprefixed `max-w-3xl`** — this
  second assertion is the standing regression guard against any future caller re-introducing the
  merge trap;
- human check: open New Space, confirm ~28rem rather than the window's width.

---

## Out of scope

- **No native menu bar / accelerators.** Considered for §1 and rejected: it registers a visible
  menu on every platform, and it would fix the chord while leaving typing and `Escape` still dead
  at fresh launch — the focus gap is the cause, and the menu only routes one key.
- **`useAttentionAlert`'s capture-phase activity listener** is untouched. It listens in capture
  precisely because other window `keydown` handlers and Radix dialogs stop propagation
  (`useAttentionAlert`'s comment records this); the guard change in §2a neither adds nor removes a
  listener, so the ordering guarantee holds.
- **A `tauri-plugin-single-instance` second-launch path** (the other way a user can "open the app
  again" and get no keys) is not in scope here, though §1's `Focused(true)` arm covers its focus
  side.
