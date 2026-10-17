---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/29
done-when: On a Linux (WebKitGTK) build launched fresh and NEVER clicked, `Ctrl+O` opens the Open Space dialog and `Ctrl+N` starts a Session; with the caret in the composer, both still fire; both work with the Settings page open; and the New Space dialog renders ~28rem wide instead of viewport-minus-32px — with `pnpm test`, `pnpm build`, `cargo test`, `cargo clippy --all-targets` and `cargo fmt --check` all green on Linux, Windows and macOS.
---

# App-wide shortcuts, the webview's key focus, and the dialog width default — Plan

**Goal:** Make `⌘/Ctrl+N` and `⌘/Ctrl+O` work in every state the app can be in, and stop a dialog that passes no width from filling the viewport.

**Architecture:** Four independent, commitable tasks. **Task 1 is Rust-only and measurement-gated**: re-assert webview-level key focus (the GTK *widget*, not the window) at `Ready` and on focus-in — the app's confirmed symptom is that no key reaches JS until the user clicks the window, and nothing today ever re-asserts the widget's key focus after the window is revealed. Task 2 moves the new-session command into the `useSessions` store and the Open-Space dialog's open-flag into a tiny shared module, and makes that flag the **single** owner of the dialog (it has two owners today). Task 3 moves the `keydown` listener and the dialog to `App` root and deletes the text-field half of the guard. Task 4 gives `DialogContent` a default width and migrates every caller into the same `tailwind-merge` group.

**Tech Stack:** Tauri 2.12.2 (`tauri-runtime-wry` 2.12.1, **wry 0.57.0** / WebKitGTK, tao 0.37.1), React 19 + Zustand + Radix, Tailwind v4 + `tailwind-merge`, vitest + Testing Library.

**Conventions for every task:** Rust commands run from `src-tauri/` (the pinned toolchain resolves there — AGENTS.md); frontend commands from the repo root. The merge bar is `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (0 warnings), `cargo test`, `pnpm test`, `pnpm build`. CI runs the Rust bar on **ubuntu / windows / macos** (`.github/workflows/ci.yml`), so a Rust change must be green on all three. Branch per gitflow off `main`; squash-merge at the end.

**Evidence this plan stands on** (verified against this tree, the resolved crate versions, and two independent reviewer passes that each returned blocking findings — the executing agent does not re-litigate; ⚠ marks a trap a naive reading falls into):

**Rust (Task 1):**

- **The symptom is confirmed empirically, the mechanism is NOT.** Confirmed by the user on a real Linux build: with nothing clicked, `Ctrl+O`/`Ctrl+N` do nothing; after clicking a neutral area, they work. What is *not* established is why. ⚠ **The earlier draft of this plan claimed wry's creation-time `grab_focus()` "lands on an unmapped widget" — that claim is REFUTED and the plan no longer rests on it.** Verified refutation: `tauri-runtime-2.12.1/src/webview.rs:456-459` (`WebviewAttributes::from(&WindowConfig)`) copies `config.focus` and **never sets `visible`**; `tauri-runtime-wry-2.12.1/src/lib.rs:4737-4746` chains `.with_focused(..)` with **no `with_visible`** (its `.visible(config.visible)` at `:857` is the *tao window* builder); wry's default is `visible: true` (`wry-0.57.0/src/lib.rs:857`). So `wry-0.57.0/src/webkitgtk/mod.rs:383-389` runs **both** `show_all()` and `grab_focus()`, on a realized widget (the hidden-window compensation `set_visible(false)` is at `:180`, *after* `new_gtk` returns). The honest statement is: **the widget is given key focus at creation, and that focus is not observed to survive the `visible:false` → tao `hide()` → plugin `show()`/`present_with_time()` sequence.** Task 1 Step 0 measures that before any fix is written.
- What *is* independently sound, and why re-asserting focus is still the right lever: the plugin's reveal focuses the **window**, never the widget — `tauri-plugin-window-state-2.4.0/src/lib.rs:262-264` (`show()` + `set_focus()`) → tauri `WebviewWindow::set_focus` → `Window::set_focus` → `WryWindowDispatcher::set_focus` (`tauri-runtime-wry:2237-2241`) → tao `WindowRequest::Focus` → `window.present_with_time()` (`tao-0.37.1/src/platform_impl/linux/window.rs:582-591`). No `grab_focus()` on that path. Upstream shape: wry#739 ("keyboard events start to be received once clicking content within the window").
- `RunEvent::Ready` exists (`tauri-2.12.2/src/app.rs:250`) and tauri's own `setup()` — which creates the config window and then runs the user's `setup` closure — runs inside the `Ready` arm **before** the user callback (`app.rs:1442-1448`, then `:2691-2699`). That ordering (Ready-after-setup) is verified and is the reason the call belongs in the `run` callback. ⚠ Do **not** claim "strictly after the plugin's reveal": the plugin's `on_window_ready` is dispatched via `run_on_main_thread` (`tauri-2.12.2/src/manager/window.rs:133-141`) and executes inline (`tauri-runtime-wry:263-274`), so that ordering is coincidence of the inline queue, not a guarantee.
- ⚠ **`RunEvent::Focused` does not exist.** Focus arrives as `RunEvent::WindowEvent { label, event: WindowEvent::Focused(true) }` — `Focused(bool)` is a `WindowEvent` variant (`app.rs:127`), wrapped by `RunEvent::WindowEvent { label: String, event: WindowEvent }` (`app.rs:233-237`).
- ⚠ **`RunEvent::WindowEvent` is `#[non_exhaustive]` on the variant** (`app.rs:234`) and `RunEvent` is `#[non_exhaustive]` (`app.rs:219`), so reaching them cross-crate **requires `..`** — omitting it is `error[E0638]`.
- ⚠ **A by-value `if let` chain over `event` does not compile here.** The callback is `FnMut(&AppHandle<R>, RunEvent)` — `event` is owned, and `label` is a non-`Copy` `String`, so `if let RunEvent::WindowEvent { label, .. } = event` *partially moves* `event` and every later use of it (including the existing `RunEvent::Exit` arm) fails with **E0382**. Match on `&event`. (`clippy::collapsible_match` also fires on the nested-`if` spelling, and CI runs `-D warnings`.)
- **Delivery of `WindowEvent::Focused(true)` — the verified matrix. Only Windows drops it.** `WindowEventWrapper::map_from_tao` opens with `#[cfg(not(windows))] return Self(Some(WindowEvent::Focused(*focused)));` (`tauri-runtime-wry:522-524`), so **Linux and macOS deliver it**; the `Self(None)` fall-through for "no children, non-empty `webviews`" (`:563-565`) is inside a `#[cfg(windows)]` block, so it is Windows-only. On macOS tao emits it from `windowDidBecomeKey:` (`tao-0.37.1/src/platform_impl/macos/window_delegate.rs:379`); on Linux from tao's `connect_focus_in_event` (`tao-0.37.1/src/platform_impl/linux/event_loop.rs:641`) — a GtkWindow focus event, i.e. window activation. So the focus-in arm runs on all three platforms' focus-ins except Windows's.
- ⚠ **Do not believe the two tempting-but-wrong versions of the above.** (a) It is NOT "Linux-only" — the suppression is `#[cfg(windows)]`, not `#[cfg(not(windows))]`. (b) On Linux the arm does NOT additionally fire for intra-window **webview** focus changes: `add_focus_change_listeners` (`tauri-runtime-wry:5333-5336`) and its call site (`:5226`) are both `#[cfg(windows)]`, so the synthesised webview `Focused(true)` is a Windows mechanism. The honest safety statement is therefore platform-split: on Linux/macOS the arm fires on **window** activation and cannot touch another widget's focus; on Windows it never fires. And the macOS path is not free of risk — `Webview::focus()` runs `self.webview.window().unwrap()` before `makeFirstResponder` (`wry-0.57.0/src/wkwebview/mod.rs:1057-1064`), so a detached webview on that path is a panic in the event-loop callback; the plan accepts it (tauri's own macOS build attaches the webview to the window, and the app already crashes hard rather than degrading) but the arm's comment must name the unwrap.
- Windows's own `focus()` is `MoveFocus(PROGRAMMATIC)` (`wry-0.57.0/src/webview2/mod.rs:1583-1590`), which moves focus *within* an already-focused CoreWebView2 and never calls Win32 `SetFocus` — so on Windows the `Ready` arm is the only one that runs and it is the weaker lever. Worth knowing when a Windows keyboard report arrives.
- `Webview::set_focus()` is a plain `pub fn`, **not** feature-gated (`tauri-2.12.2/src/webview/mod.rs:1676-1679`), and `AsRef<Webview<R>> for WebviewWindow<R>` is the **only** `AsRef`/`Deref` impl on that type (`webview_window.rs:1565-1569`) — so `window.as_ref().set_focus()` type-checks with no disambiguation. ⚠ `Manager::get_webview`, `Manager::webviews` and `Manager::get_focused_window` are all `#[cfg(feature = "unstable")]` (`tauri-2.12.2/src/lib.rs:575-600`) and `tauri = { version = "2", features = [] }` — none is available. ⚠ `WebviewWindow::set_focus` (`webview_window.rs:2387`) also exists and is the **wrong** (window-level) lever; a grep for `set_focus()` will find both.
- ⚠ **A second `generate_context!()` in the lib unit-test binary breaks `cargo test` on macOS.** `generate_context!` embeds the plist unless called as `generate_context!(test = true)` (`tauri-macros-2.7.2/src/context.rs` → `tauri-codegen-2.7.2/src/context.rs:145`), and `embed_plist` emits `#[no_mangle] pub static _EMBED_INFO_PLIST` — already emitted once by `lib.rs`. The duplicate is a **link** error, so `cargo clippy`/`check` (metadata-only) stay green while macOS CI reddens. This is the same hazard class that forced `src-tauri/tests/ipc.rs:48-52`'s `#![cfg(target_os = "linux")]` gate (documented in `docs/research/tauri-mock-runtime-test-crashes.md`). `MockRuntime::run` also **blocks** until a `CloseWindow` (`tauri-2.12.2/src/test/mock_runtime.rs:1353-1373`), and `mock_builder().build(generate_context!())` *does* create a `"main"` window once `Ready`→`setup()` runs (`app.rs:2691-2693`; `ipc.rs:168-172` asserts exactly that) — so it cannot serve as "no window labelled main" either. **Conclusion: no mock app in the Rust unit tests.** Use the pure-reduction seam this file already uses — `focus_probe_trace(Option<Result<bool, String>>) -> (bool, String)` at `lib.rs:209`, unit-tested with no `App` at `lib.rs:399-443`.
- ⚠ A crate cannot name itself: inside `src-tauri/src/lib.rs`'s tests use `crate::agent::debuglog`, **not** `archimedes_lib::agent::debuglog` (that path is only valid in `src/main.rs` / `src/bin/*`). `debuglog::init(true, Some(dir))` does **not** create the file — creation is deferred to `append_to` (`agent/debuglog.rs:85`) — so assert the file exists before reading it, and assert on a line's own prefix rather than a substring (`focus_probe_trace`'s `attention:` lines already contain the word `main`, `lib.rs:211-215`).
- The existing `RunEvent::Exit` arm and the Worker reaping are unaffected by the new arms (non-blocking `send_user_message`; `windows.0.borrow()` is dropped before the callback, `tauri-runtime-wry:4216-4227`).

**Frontend (Tasks 2–4):**

- The chord's guard is `e.target.closest("input, textarea, [contenteditable]:not([contenteditable='false']), [role='dialog']")` (`SpacesList.tsx:284`). The composer is a `textarea` (`ComposerRow.tsx:150`) and nothing ever blurs it, so one keystroke kills both chords permanently. `ComposerRow` calls `preventDefault` but **never** `stopPropagation` (`ComposerRow.tsx:170-232`), so a root-level window listener does see the chord with the caret in the composer.
- ⚠ **The two chord tests that dispatch on `window` (`SpacesList.test.tsx:506`, `:526`) never reach the guard** — `window`'s `event.target` is a `Window`, not an `HTMLElement`, so `e.target instanceof HTMLElement` is false and the early-return body is skipped. The element-target tests at `:465`/`:488` *do* exercise the guard (`fireEvent.keyDown` on a real `<input>`/`<div>`), so the guard is not untested in general — it is **never tested with a `textarea` composer target**, which is the exact state that breaks in production. Frame the new test as covering that gap, not as the first guard test.
- ⚠ **`[role='dialog']` alone is not "any open dialog".** `AlertDialogPrimitive.Content` renders `role="alertdialog"`, which does **not** match `[role='dialog']`. Two live confirm-to-destroy dialogs use it: `settings/McpSection.tsx:184` and `settings/ProviderSection.tsx:226`. The guard must be `[role='dialog'], [role='alertdialog']`.
- **The dialog has TWO owners today.** `SpacesList.tsx` (`useState`) and `SpaceTabs.tsx:82` (`newSpaceOpen`) + its render at `:320-321` (asserted at `SpaceTabs.test.tsx:203-207`). Leaving the second one on private state means two independent sources of truth for one dialog, and if both are ever true two dialogs mount (`getByText('New space')` → "Found multiple elements"). Task 2 makes the shared module the single owner.
- The command needs only `activeSpacePath`, not a `SpaceView`: `views = spaces.map(spaceViewFor)` and `spaceViewFor` returns `path: space.path` verbatim (`sessions.ts:571`), so `views.find(v => v.path === p)` is undefined **iff** no `spaces` row has that path. ⚠ The `activeSpacePath === null` clause is semantically redundant (`SpaceView.path: string` can never equal `null`) but is **required for `tsc`** to narrow `string | null` before `startSessionCommand(..)` — keep it and say why.
- `addSession(info)` sets `activeSessionId` to the new session and `addSpace(path)` sets `activeSpacePath` (`sessions.ts:833-849`, `:905-921`), so the command is `startSession` → `addSession` → `addSpace` and the "the start flow always switches the view" invariant is worth pinning explicitly (the deleted hook's test asserted `activeSessionId === "new1"`).
- ⚠ `src/store/sessions.ts` does **not** import `startSession` today; add `startSession as startSessionCommand` to the existing `../lib/tauri` import block (the file already aliases `closeSession`/`deleteSpace`/`resumeSession`/`setSessionArchived`/`setSpaceTrusted` that way).
- **`App`'s boot effect destroys any test seed.** `App.tsx:291-294` runs `Promise.all([listSessions(true), listSpaces()])` → `setSpaces(spaces)`, and `setSpaces` writes `activeSpacePath: owner ? owner.path : rows[0]?.path ?? null` **unconditionally** (`sessions.ts:891`). `App.test.tsx:25` mocks `listSpaces` to `[]`, so every `render(<App/>)` settles on `spaces: []`, `activeSpacePath: null` on the next macrotask, regardless of a prior `useSessions.setState`. A chord test must therefore `mockResolvedValue` its own `listSpaces` rows and let them land, not seed and race.
- ⚠ **A leaked dialog-open flag poisons all of `App.test.tsx`.** A mounted Radix dialog sets `document.body.style.pointerEvents = "none"` and `aria-hidden`s its siblings, so `getByRole("button", { name: "Settings" })` throws for every later test (`App.test.tsx:332`, `:374`, `:389`, `:443`, `:695`, `:995`, `:1103`, and the `"Red"` queries at `:446`, `:473`, `:614`, `:628`, `:790`, `:823`). The reset must be at **file scope**, not inside the new `describe`.
- ⚠ `tsconfig.json:22` sets `noUnusedLocals: true`, and `SpacesList.tsx:278` is the file's **only** `useEffect` — deleting the effect strands the import at `:1` and `pnpm build` (`tsc && vite build`) fails with `TS6133`. `activeView` (`SpacesList.tsx:121`) also stays load-bearing without the hook: it feeds `viewIds` (`:126`), `liveIds`/`storedIds` (`:156`, `:160`), the row list (`:398`) and each row's space name (`:402`).
- ⚠ **`setNewSpaceDialogOpen` (arity 1) is not assignable to `() => void`** (`SessionRail.tsx:10`, consumed at `SpacesList.tsx:248`) **nor to `MouseEventHandler<HTMLButtonElement>`** (`SpacesList.tsx:338`) — `TS2322` both ways. Hence the zero-arg `openNewSpaceDialog()` export.
- All three existing `useSyncExternalStore` sites pass **two** args (`App.tsx:285`, `SpacesList.tsx:209`, `SidePane.tsx:115`) — match that; there is no third-arg precedent.
- A bare `<Dialog open><DialogContent/>` needs **no** stubs or mocks in jsdom (verified: `data-slot="dialog-content"`, `role="dialog"`, base class present), and `NewSpaceDialog` mounts under `App.test.tsx`'s existing `matchMedia` stub alone (`App.test.tsx:152`).
- **Task 4's merge reasoning, verified against this repo's `node_modules` and emitted CSS.** `cn()` is `extendTailwindMerge` (`components/lib/utils.ts:4`) and its `extend` preserves the default `max-w` group, so `sm:max-w-md` + a caller's `sm:max-w-3xl` is **one** group and the caller (later argument) wins; a bare `max-w-3xl` is a **different** group, so both survive. In `dist/assets/index-BV8bYXSz.css`, `.max-w-3xl` (offset ~20279) and `.max-w-md` (~20733) sit in the plain utilities while `.sm\:max-w-md` (~64631) sits inside a later `@media (width>=40rem)` block — so above 640px the `sm:` rule wins **regardless of class order**. `max-h-*` is a separate group, so `max-h-[70vh]` stays unprefixed. `alert-dialog.tsx:48` already ends with ` sm:max-w-md` — that asymmetry is the bug.
- ⚠ Two **existing** width assertions go vacuously green after migration, because `toContain("max-w-3xl")` matches inside `"… sm:max-w-3xl"`: `ModelPickerDialog.test.tsx:202` and `SkillsDialog.test.tsx:255`. Both must become token-set membership checks.
- There are exactly **8** `DialogContent` call sites (`DeleteSessionDialog:36`, `CloseSpaceDialog:70`, `SudoConfirmModal:52`, `SudoPasswordModal:79`, `settings/McpSection:291`, `ModelPickerDialog:119`, `SkillsDialog:104`, `NewSpaceDialog:105`); nothing renders `DialogPrimitive.Content` directly outside `ui/dialog.tsx:58`; `McpSection:184`/`ProviderSection:226` are `AlertDialogContent` and already capped.

---

### Task 0 (gate, no commit): Measure whether the focus hypothesis explains the dead keys

**Context:** Task 1's diagnosis is **unmeasured** — an earlier draft asserted a mechanism (wry's creation-time `grab_focus()` hitting an unmapped widget) that review refuted outright. The symptom is real and user-confirmed (no keys at fresh launch; keys work after clicking the window), but if re-asserting the webview's key focus changes nothing, Task 1 ships a placebo and ADR 0056 records a phantom cause. So measure before writing. Two constraints make this task's shape non-obvious and both are load-bearing: the probe must **log that it ran** (otherwise "nothing changed" is indistinguishable from "the probe never ran"), and there is a **cheaper zero-code check that runs first** — the symptom's shape ("keys start once the user touches the window") is also the signature of the *compositor never giving the window focus at all*, in which case no widget-level call can help and Task 1 must be withdrawn for the right reason. This task changes no committed file and produces no commit; its output is the verdict Task 1's commit message must quote.

**Files:**
- Scratch only: `src-tauri/src/lib.rs` (a temporary `debuglog::log` in the `Ready` and focus-in arms), reverted afterwards.

**Steps:**
- [ ] `git status` — confirm a clean tree before instrumenting.
- [ ] **Do the free check first.** Record `echo "$XDG_SESSION_TYPE"`, then launch the app and, **without clicking it**, ask the compositor who holds focus: `xdotool getwindowfocus getwindowname` (X11), or read `_NET_ACTIVE_WINDOW` via `xprop -root`. This settles the window-level branch before any Rust is edited. Note where the log lives, because Task 0's probe reads it: `ARCHIMEDES_DEBUG=1` writes `~/.local/share/archimedes/supervisor.log` (`agent/debuglog.rs:42-55`, `:81`) — created lazily on first write, shared with every Worker-IPC line, rotated at 5 MB, so always grep a unique prefix.
- [ ] Reproduce the symptom: with the window **never clicked**, press `Ctrl+O`, then a printable key. If the chord already works, **stop** — nothing to fix here; report what actually differs between before and after the click.
- [ ] Instrument **both** arms, logging **on entry** with a unique prefix so that absence is meaningful:
  ```rust
  if let tauri::RunEvent::Ready = event {
      debuglog::log("focus-probe: Ready fired");
      if let Some(w) = handle.get_webview_window("main") {
          let r = w.as_ref().set_focus();
          debuglog::log(&format!("focus-probe: ready grab ok={r:?}"));
      } else {
          debuglog::log("focus-probe: ready grab found NO window");
      }
  }
  if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(true), .. } = &event {
      debuglog::log(&format!("focus-probe: focus-in fired label={label}"));
  }
  ```
  ⚠ `&event` on the second arm: a by-value `if let` binding `label` partially moves the owned `RunEvent` and breaks the `Exit` arm with E0382, and the `..` is required (`#[non_exhaustive]`). Both are Task 1's facts and Task 0 trips over them first.
- [ ] `ARCHIMEDES_DEBUG=1 pnpm tauri dev` with `tail -f ~/.local/share/archimedes/supervisor.log | grep --line-buffered focus-probe:`. Which lines appear is the measurement: no `Ready fired` means the arm never ran (a different bug); `ready grab ok=Ok(())` with keys still dead means the lever fired and did nothing.
- [ ] Exercise the focus-in arm deliberately — focus another window and come back (a focus-out/in cycle, **not** a click on content) — and record whether `focus-in fired` appears and whether keys work after it. Do not infer this; verdict 2 rests on it.
- [ ] Record exactly one verdict, quoted into Task 1's commit message:
  1. **`Ready`'s grab fixes it** — keys work at fresh launch with `ready grab ok=Ok(())` logged → implement Task 1 as planned.
  2. **Only the focus-in path fixes it** — dead at launch, alive after a focus cycle, `focus-in fired` logged → the focus-in arm is load-bearing and `Ready` alone is not enough. Say so in ADR 0056, and note that this verdict still leaves the *first* launch broken, which needs a separate answer.
  3. **Both fire, keys stay dead** → the widget-focus hypothesis is **wrong**. Withdraw Task 1 and ADR 0056, quoting the log lines as the evidence that rules it out.
  4. **The window never held focus** (from the free check) → a compositor focus-award problem at the **window** level, upstream of any widget call. Withdraw; the follow-up concerns window presentation, not `grab_focus`.
  5. **`Ready fired` never appears** → the assumption that the `run` callback sees `Ready` is false in this app; that is itself the finding, and Task 1 must be re-planned around wherever the reveal actually happens.
- [ ] On any withdrawal verdict (3, 4, 5), in ONE commit: set this plan's front-matter `status: superseded` naming the replacement topic, drop the key-focus clause from `done-when` (Tasks 2–4 still ship and their exit condition stands on its own), and set ADR 0056 to `status: superseded` — per the append-only rule, opening the replacement decision that names the measured cause rather than editing 0056's body.
- [ ] `git checkout src-tauri/src/lib.rs` — leave no scratch code behind.

**Acceptance criteria:**
- [ ] One of the five verdicts, with the actual `focus-probe:` log lines quoted.
- [ ] For a withdrawal verdict, the plan's `status`/`done-when` and ADR 0056's `status` change in the same commit, and Task 1 is not executed.
- [ ] No scratch instrumentation left in the tree.

---

### Task 1: Re-assert the webview's key focus at Ready and on focus-in

**Context:** On a fresh launch no key event reaches the renderer at all — not the chord, not typing, not `Escape` — and the user's own test shows keys begin working after clicking inside the window. What the code demonstrably lacks is any **webview**-level key focus: the plugin's reveal calls `set_focus()` on the **window** (tao presents it via `present_with_time`), and nothing ever calls the widget's own `grab_focus()` / `makeFirstResponder` after that reveal. ⚠ This is **not** a Linux-only arm: the focus-in trigger is delivered on **Linux and macOS** and suppressed only on Windows for a single-webview window (the verified matrix in the evidence bullets above, now recorded in ADR 0057), so the seam carries **no `cfg` gate** — the Linux-only framing an earlier draft of this plan (and ADR 0056) carried is false, and the WebKitGTK wording below describes the reported repro, not the code's scope. wry does call it at creation, but that is before the window has been through tao's `hide()` (the config declares `visible: false`) and the plugin's later `show()`, and it is not observed to survive that sequence — Task 0 measured whether re-asserting after it helps. Only implement this task if Task 0 returned verdict 1 or 2. See ADR 0056 for the rejected alternatives (native menu accelerators, `Ready`-only, a frontend focus workaround); its *mechanism* paragraph is **not** amended by this task — 0056 is pushed, so ADR 0057 supersedes it and records that the measurement is deferred to the ignored test rather than filled in at implementation time.

**Files:**
- Modify: `src-tauri/src/lib.rs` — add `webview_focus_trace` (a pure reduction, next to `focus_probe_trace`) + `grab_webview_key_focus` (the impure wrapper), and extend the existing `app.run(..)` callback
- Test: `src-tauri/src/lib.rs` (`#[cfg(test)] mod tests`, appended — the `focus_probe_trace` tests at `lib.rs:399-443` are the model)
- Create: `src-tauri/tests/webview_key_focus.rs` (one `#[ignore]`d, human-read check — the `tests/attention_alert_survives.rs` pattern)
- Modify: `docs/decisions/0057-the-webview-asserts-its-key-focus-ungated-because-both-linux-and-macos-deliver-focus-in.md` — **not** `0056-…`: 0056 is already pushed on `origin/main`, so the append-only rule supersedes it rather than editing its body (0057 carries the verified delivery matrix, and 0056's front-matter gets `superseded-by:`). The measured verdict is **not** recorded here at implementation time either — Task 0's gate needs a human at a keyboard, so the measurement is deferred to the `#[ignore]`d check (`cargo test --test webview_key_focus -- --ignored --nocapture`) and 0057 states the mechanism as unmeasured, with what would refute it.

**What to implement:**

Two functions in `src-tauri/src/lib.rs`, deliberately split the way `focus_probe_trace` / the `FocusProbe` seam are split, so the headless test can pin the decision without an `App`:

```rust
/// Reduce the webview key-focus attempt to its log line (`None` = nothing to
/// say). PURE — the mock runtime has no widget, so this is the half headless
/// can pin; `tests/webview_key_focus.rs` owns the behaviour.
fn webview_focus_trace(lookup: Option<Result<(), String>>) -> Option<String> {
    match lookup {
        None => Some("focus: no window labelled \"main\" — key focus not grabbed".into()),
        Some(Err(e)) => Some(format!("focus: webview set_focus refused: {e}")),
        Some(Ok(())) => None,
    }
}

/// Grab KEY focus for the webview WIDGET (not the window) — see ADR 0056.
/// GTK has two focuses and the window-state plugin only ever asks for the
/// window's; the widget's key focus is what makes WebKitGTK dispatch key
/// events into JS at all.
fn grab_webview_key_focus<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    let line = webview_focus_trace(
        handle
            .get_webview_window("main")
            .map(|window| window.as_ref().set_focus().map_err(|e| e.to_string())),
    );
    if let Some(line) = line {
        debuglog::log(&line);
    }
}
```

`tauri::Manager` (`lib.rs:17`) and `debuglog` (`lib.rs:21`) are already imported. `window.as_ref()` resolves through `AsRef<Webview<R>> for WebviewWindow<R>` — the only such impl, so no disambiguation is needed. Do NOT use `handle.get_webview(..)` / `webviews(..)` / `get_focused_window(..)`: all three are `#[cfg(feature = "unstable")]` and the feature is off. Note in a comment that `WebviewWindow::set_focus` (`webview_window.rs:2387`) is the **window**-level sibling and is not the lever.

Extend the existing `app.run(|handle, event| { … })` callback. ⚠ **Match on `&event`, not `event`**, and place the block **before** the existing `Exit` arm (or after — with `&event` ordering stops mattering); a by-value `if let { label, .. } = event` partially moves the owned `RunEvent` and breaks the `Exit` arm with E0382. ⚠ The `..` is mandatory (`#[non_exhaustive]` variant). Use a match guard, not a nested `if` (`clippy::collapsible_match` fires on the nested spelling and CI runs `-D warnings`):

```rust
// The webview, not the window, must hold GTK key focus or no key event
// reaches JS (ADR 0056). `&event`: `RunEvent` is owned here and `label` is
// a `String`, so a by-value `if let` partially moves `event` and the
// `Exit` arm below stops compiling (E0382). `..` is required —
// `RunEvent::WindowEvent` is `#[non_exhaustive]`.
match &event {
    tauri::RunEvent::Ready => grab_webview_key_focus(handle),
    tauri::RunEvent::WindowEvent {
        label,
        event: tauri::WindowEvent::Focused(true),
        ..
    } if label == "main" => grab_webview_key_focus(handle),
    _ => {}
}
```

Comment the arms with these three facts, each of which a future reader will otherwise get wrong: (a) `Ready` is used because tauri's own `setup()` — which creates the config window — runs inside the `Ready` arm before this callback; do not claim it is ordered after the plugin's reveal, which is an inline-queue coincidence. (b) `Focused(true)` is delivered on **Linux and macOS** and suppressed only on **Windows** for a single-webview window — the early return is `#[cfg(not(windows))]` (`tauri-runtime-wry:522-524`) and the `Self(None)` fall-through is `#[cfg(windows)]` (`:563-565`); on Linux/macOS it comes from *window* activation (tao's focus-in / `windowDidBecomeKey`), not from intra-window widget focus changes (`add_focus_change_listeners` is `#[cfg(windows)]`); and the macOS `focus()` implementation does `self.webview.window().unwrap()` before `makeFirstResponder` (`wry-0.57.0/src/wkwebview/mod.rs:1057-1064`) — name that unwrap in the comment, because it is a panic in the event-loop callback if a detached webview ever reaches it. (c) The `label == "main"` guard is a cheap filter, not a necessity (`grab_webview_key_focus` must look the window up anyway, because no ungated API maps a label to a webview).

What NOT to change: no `cfg(target_os = "linux")` gate on the seam; no Cargo dependency or feature; no `tauri.conf.json` change (leave `"visible": false` — the app reveals itself only after the plugin restores geometry); do not touch the window-state plugin's `set_focus()`; do not touch `setup` or the `RunEvent::Exit` arm's body.

**Steps:**
- [ ] In `src-tauri/src/lib.rs`'s `#[cfg(test)] mod tests`, write the failing tests in the style of the `focus_probe_trace` tests (`lib.rs:399-443`) — **no `mock_builder`, no `generate_context!`, no `App`** (a second `generate_context!` duplicates `_EMBED_INFO_PLIST` and reddens macOS `cargo test` while clippy stays green):
  1. `a_missing_window_says_which_window_was_missing` — `webview_focus_trace(None)` is `Some(line)`; the line contains `focus:` and `main`.
  2. `a_refused_focus_names_the_error` — `webview_focus_trace(Some(Err("focus boom".into())))` names `set_focus` and carries `focus:`.
  3. `a_successful_grab_says_nothing` — `webview_focus_trace(Some(Ok(())))` is `None`.
- [ ] Run `cargo test --lib` from `src-tauri/` — fail first (`cannot find function webview_focus_trace`). Then implement both functions and re-run to green.
- [ ] Add a fourth test that exercises the **logging** path through `grab_webview_key_focus` only if it can be done without a mock app — i.e. skip it. State in a comment at `webview_focus_trace` that the impure wrapper's logging is covered by the pure trace tests plus the ignored manual test, so nobody adds a mock app later and breaks macOS.
- [ ] Add the `match &event` block to `src-tauri/src/lib.rs`'s `run` callback, leaving the `Exit` arm byte-identical.
- [ ] Run `cargo test --lib`, then `cargo fmt`, then `cargo clippy --all-targets` from `src-tauri/` — 0 warnings (this is where E0382 / E0638 / `collapsible_match` would surface; the fixes are the `&event` match and the guard described above).
- [ ] Run `cargo test` from `src-tauri/` on **all three CI OSes if available**; if only Linux is available locally, say so in the commit message — the macOS hazard is precisely the kind that hides behind a metadata-only lint run.
- [ ] Create `src-tauri/tests/webview_key_focus.rs`: one `#[ignore]`d test whose **body panics with the recipe** (`#[ignore]`d bodies never run, so an empty body prints nothing): `panic!("MANUAL RECIPE — see the doc comment");` and the doc comment carries the steps, written in the register of `tests/attention_alert_survives.rs` (which opens by explaining *why a human must run this*). Steps: `ARCHIMEDES_DEBUG=1 pnpm tauri dev`; launch and click **nothing**; press `Ctrl+O` → the Open Space dialog opens; press a printable key → the composer receives it; minimise then restore, press `Ctrl+O` → still opens (**Linux and macOS** — Windows is the only platform that never delivers `WindowEvent::Focused(true)` for a window of our shape, so record step 4 as "not applicable" there rather than "failed"). Explain that the mock runtime has no widget so no green test points at the behaviour. Do **not** gate the file with `#![cfg(target_os = "linux")]`: the recipe is not Linux-only (macOS takes the same arm from `windowDidBecomeKey:`), and only Windows skips step 4 while still running the `Ready` path.
- [ ] Run `cargo test --test webview_key_focus -- --ignored --nocapture` from `src-tauri/` — the recipe prints.
- [ ] Record Task 0's measured verdict in **ADR 0057** — not by editing ADR 0056, which is pushed and is now superseded by 0057 (append-only rule: its front-matter carries `superseded-by:`, its body stays as written). ⚠ In this tree the task shipped with the measurement **deferred** — there was no verdict to record — so 0057 states the mechanism as unmeasured and names the refutation condition; when a human runs `cargo test --test webview_key_focus -- --ignored --nocapture`, the verdict goes into 0057's first consequence, and a verdict (b) or (c) supersedes 0057 with the actual cause rather than tweaking the call.
- [ ] Commit: `fix(desktop): re-assert the webview's key focus so keys reach JS before the first click` — the body quotes Task 0's verdict verbatim.

**Acceptance criteria:**
- [ ] Task 0's verdict is quoted in the commit message, and it is verdict 1 or 2.
- [ ] `Webview::set_focus` is reached only through `grab_webview_key_focus`, and `WebviewWindow::set_focus` (the window-level sibling) is never called in this file.
- [ ] No `App`/`mock_builder`/`generate_context!` appears in `src-tauri/src/lib.rs`'s test module.
- [ ] `cargo test`, `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check` pass; the `Exit` arm is byte-identical.
- [ ] On a real Linux dev build, `Ctrl+O` opens the dialog with the window never clicked.

---

### Task 2: One owner for the new-session command and the Open Space dialog

**Context:** Task 3 must move the `⌘N`/`⌘O` chord to `App` root, and a root listener cannot call a hook closure that lives inside `SpacesList` — the component the Settings view unmounts. So the command moves into `useSessions` (which already owns async command actions like `closeSpace`/`archiveSession` and module-level mutable state) and the dialog's open-flag moves into a module mirroring `src/lib/leftPaneState.ts`, this repo's existing answer to "a UI flag shared across a subtree that unmounts". The flag must also become the **single** owner of the dialog: `SpaceTabs` keeps a second private copy today, and two owners of one dialog is how two dialogs end up mounted at once.

**Files:**
- Create: `src/lib/newSpaceDialogState.ts`
- Create: `src/lib/newSpaceDialogState.test.ts`
- Modify: `src/store/sessions.ts` (add `startSessionInActiveSpace` + `newSessionError`; add `startSession as startSessionCommand` to the `../lib/tauri` import block at `:3-20`)
- Modify: `src/store/sessions.test.ts` (append a `describe`)
- Modify: `src/components/SpaceTabs.tsx` (`newSpaceOpen` state at `:82`, the `onClick` at `:311`, the render at `:320-321`, and the `NewSpaceDialog` **import** at `:10`)
- Modify: `src/components/SpaceTabs.test.tsx` (the `+`-opens-dialog test at `:201-207`)
- Modify: `src/components/SpacesList.tsx` (only its `dialogOpen` `useState` → the shared flag; the render site STAYS here until Task 3)
- Modify: `src/components/SpacesList.test.tsx` (**this task**, not Task 3: add the flag reset to the file-level `beforeEach` at `:151`, and convert the dialog-text assertions that this task's change makes unreachable)

**What to implement:**

`src/lib/newSpaceDialogState.ts` — `leftPaneState.ts`'s shape **minus every line of persistence** (no `STORAGE_KEY`, no `localStorage`, no seeding at import: an auto-opened dialog on launch is not worth restoring). Four exports, one of them the zero-arg opener:

```ts
export function getNewSpaceDialogOpen(): boolean;
export function setNewSpaceDialogOpen(v: boolean): void;   // same-value echo: no notify
export function openNewSpaceDialog(): void;                 // setNewSpaceDialogOpen(true)
export function subscribeNewSpaceDialog(fn: () => void): () => void;
```

⚠ `openNewSpaceDialog` is not sugar: the flag setter has arity 1 and is not assignable to `() => void` (`SessionRail.tsx:10`) nor to `MouseEventHandler<HTMLButtonElement>` (`SpacesList.tsx:338`) — both `TS2322`. The doc comment says why the module exists (a root-level chord listener, the root-rendered dialog, the sidebar and the tab strip all need one flag; `SpacesList` unmounts in the Settings view) and warns that the flag is **module-scoped**, so every test file that can set it must reset it in a **file-level** `beforeEach`.

In `src/store/sessions.ts`:
- Interface: `startSessionInActiveSpace: () => Promise<void>;` and `newSessionError: string | null;`, each documented (the action is the flow the "New Session" button, the rail icon, the `…` menu item and `⌘N` share; `newSessionError` is what the sidebar actions-menu `title` shows).
- Initial state: `newSessionError: null` (the initial-state block ends at `stalled: {},` ~`:822`).
- Module-level, beside `inFlightToggles`/`committedTrusted` (`:778-812`): `let newSessionInFlight = false;` — app-global on purpose, because there is one active Space and one new-session flow and two entry points firing in one tick is exactly what it suppresses.
- The action, in order:

```ts
startSessionInActiveSpace: async () => {
  const { activeSpacePath, spaces } = get();
  // No Space selected, or the selected path is a legacy cwd that is no
  // longer a Space row → route `⌘N` to the Open Space dialog. Equivalent to
  // the old `activeView === undefined` (spaceViewFor returns `path`
  // verbatim, so `views.find(…)` is undefined iff no row has the path).
  // The `=== null` clause is for tsc NARROWING only — a `SpaceView.path`
  // can never be null — so do not "simplify" it away: the build breaks.
  if (activeSpacePath === null || !spaces.some((s) => s.path === activeSpacePath)) {
    openNewSpaceDialog();
    return;   // BEFORE the in-flight guard: opening a dialog is not an
              // in-flight command, and a second press must still open it.
  }
  if (newSessionInFlight) return;
  newSessionInFlight = true;
  set({ newSessionError: null });
  try {
    const info = await startSessionCommand(activeSpacePath);
    // `addSession` selects the new session (it sets `activeSessionId`);
    // `addSpace` refreshes `lastOpenedAt` and sets `activeSpacePath`.
    get().addSession(info);
    get().addSpace(info.cwd);
  } catch (err) {
    set({ newSessionError: err instanceof Error ? err.message : String(err) });
  } finally {
    newSessionInFlight = false;
  }
},
```

In `src/components/SpaceTabs.tsx`: delete `const [newSpaceOpen, setNewSpaceOpen] = useState(false)` and its local `{newSpaceOpen && <NewSpaceDialog …>}` render; the `+` button at `:311` calls `openNewSpaceDialog()`. **Keep exactly one render site through this task**: `SpacesList`'s own render at `:457` stays, so swap `SpacesList`'s `const [dialogOpen, setDialogOpen] = useState(false)` (`:97`) for `useSyncExternalStore(subscribeNewSpaceDialog, getNewSpaceDialogOpen)` and gate the render on that, with `onClose={() => setNewSpaceDialogOpen(false)}`. That is safe because `SpaceTabs` and `SpacesList` unmount together (`App.tsx:332-356` renders `SpaceTabs`, and `:404` renders `SpacesList`, both only in the workspace branch), so the workspace always has the one render site for the one flag — no click becomes a dead button mid-plan. ⚠ Do NOT leave `SpaceTabs`'s render in place "to be safe": with `SpacesList` also rendering on the shared flag, both are true at once and `getByText('New space')` becomes "Found multiple elements". The render moves to `App` root in Task 3, which is what makes it survive the Settings view.

What NOT to change: `addSession`, `addSpace`, `activeSpacePath` semantics, `spaceViewFor`; `useStartNewConversation.ts` (Task 3 deletes it); no `SpaceView` is passed to the action; no new `useActiveSpaceView()` hook (the derivation has one owner already). Do not clear `newSessionError` anywhere but the reset at the top of the action.

**Steps:**
- [ ] Write `src/lib/newSpaceDialogState.test.ts` first: starts `false`; `openNewSpaceDialog()` flips it and notifies; setting the same value again does not notify; `subscribeNewSpaceDialog`'s return unsubscribes; `setNewSpaceDialogOpen(false)` returns to `false`. Run `pnpm test src/lib/newSpaceDialogState.test.ts` — fail (module missing), then create the module, then pass.
- [ ] Append `describe("useSessions.startSessionInActiveSpace")` to `src/store/sessions.test.ts`, seeded with `useSessions.setState({ … })` directly (the file's rule — NOT `getState().setSpaces(…)`, which triggers boot auto-select and a `loadHistory` IPC). Add `startSession: vi.fn().mockResolvedValue({ sessionId: "new1", cwd: "/tmp/ws", capabilities: {}, archived: false })` to that file's `vi.mock("../lib/tauri")` factory if absent, and `setNewSpaceDialogOpen(false)` to the suite's `beforeEach`. Cases:
  1. `starts a native session at activeSpacePath, records session + space, and SELECTS the new session` — seed `spaces: [row("/tmp/alpha", 1)]`, `activeSpacePath: "/tmp/alpha"`; assert `startSession` called with `"/tmp/alpha"`, `sessions` contains `new1`, `spaces` contains `/tmp/ws`, **and `activeSessionId === "new1"`** (this last assertion is the "the start flow always switches the view" invariant carried over from the deleted hook's test — do not drop it).
  2. `opens the Open Space dialog when activeSpacePath is null` — `startSession` not called, `getNewSpaceDialogOpen() === true`.
  3. `opens the Open Space dialog when the path matches no Space row (a legacy cwd)` — `activeSpacePath: "/tmp/gone"`, same assertions.
  4. `suppresses a concurrent double-invoke` — call twice without awaiting, await both, `startSession` called once (mirror `archiveSession is idempotent under concurrent invocation (double-click)` at `:2498`).
  5. `records the rejection message in newSessionError, and clears it on the next run` — `mockRejectedValueOnce("no such folder")` → `newSessionError === "no such folder"`; then a success run → `null`. Note in the plan-adjacent comment that the hook's `clearError` is dropped because `grep -rn clearError src/` finds it only in the hook and its own test — no consumer existed.
- [ ] Run `pnpm test src/store/sessions.test.ts` — fail, implement, pass.
- [ ] Migrate `SpaceTabs.tsx` to `openNewSpaceDialog()` and delete its local state + render; update `SpaceTabs.test.tsx:203-207` to assert `getNewSpaceDialogOpen() === true` after clicking `+` (the dialog itself is asserted in `App.test.tsx`, Task 3), and add `setNewSpaceDialogOpen(false)` to that file's `beforeEach`.
- [ ] Run `pnpm test` and `pnpm build` from the repo root — green (`tsc` is what catches the interface/implementation mismatch and any stale `newSpaceOpen`).
- [ ] Commit: `feat(store): one owner for the new-session command and the Open Space dialog`

**Acceptance criteria:**
- [ ] `useSessions.getState().startSessionInActiveSpace()` works with no component mounted, and selects the new Session.
- [ ] Both "no Space" cases open the dialog rather than starting anything; the in-flight guard is app-global.
- [ ] `SpaceTabs` holds no dialog state and renders no `NewSpaceDialog`; `grep -rn "NewSpaceDialog" src/` shows exactly one render site after Task 3 (in `App.tsx`) plus the import.
- [ ] `src/lib/newSpaceDialogState.ts` persists nothing.
- [ ] `pnpm test` and `pnpm build` pass.

---

### Task 3: Make the chord app-wide — root listener, root dialog, no yield to text fields

**Context:** Two independent renderer bugs. (a) The guard treats "caret is in a text field" as "not our key": the composer is a `textarea` nothing ever blurs, so after one keystroke both chords are dead for the rest of the session — and `ComposerRow` never calls `stopPropagation`, so the listener would have seen the chord anyway. A `Cmd`/`Ctrl` chord is an app command, not text editing; browsers and native apps fire it with the caret in a textarea. (b) The listener lives inside `SpacesList`, which the Settings view unmounts, so on that page the chords do not exist at all. This repo already solved (b) for another app-wide concern by mounting `useAttentionAlert()` at `App` root with the comment "VIEW-INDEPENDENT — mounted with the app, not with the workspace"; the same rule applies here, on top of Task 2's store command and shared flag.

**Files:**
- Create: `src/hooks/useAppShortcuts.ts`
- Create: `src/hooks/useAppShortcuts.test.ts` (the chord's own unit tests, dispatching on real element targets)
- Modify: `src/App.tsx` (call the hook next to `useAttentionAlert()`; render `<NewSpaceDialog>` as a sibling of the view ternary, next to `<SubagentModals>`)
- Modify: `src/components/SpacesList.tsx` (delete the `keydown` effect + the `NewSpaceDialog` render + `useStartNewConversation`; prune the `useEffect` import)
- Modify: `src/App.test.tsx` (the Settings-view chord test)
- Modify: `src/components/SpacesList.test.tsx` (the fallout list below)
- Modify: `src/hooks/useAttentionAlert.test.ts` (`:38` cites the deleted `useStartNewConversation.test.ts`)
- Delete: `src/hooks/useStartNewConversation.ts` + `src/hooks/useStartNewConversation.test.ts`

**What to implement:**

`src/hooks/useAppShortcuts.ts`:

```ts
export function useAppShortcuts(): void {
  const startSessionInActiveSpace = useSessions((s) => s.startSessionInActiveSpace);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      // Auto-repeat fires once per repeat and each sequential repeat starts a
      // Session (the store's in-flight guard absorbs only CONCURRENT ones);
      // Shift/Alt combinations are not ours to claim.
      if (e.repeat || e.shiftKey || e.altKey) return;
      // Stand aside ONLY inside an open modal. Radix moves focus INSIDE the
      // content, so an `<input>` there still matches via `closest`. BOTH roles
      // are needed: Radix's AlertDialog renders `role="alertdialog"`, which
      // does NOT match `[role='dialog']`, and the Settings remove-confirmations
      // are AlertDialogs — ⌘N under a "Remove provider?" confirm would move
      // the active Space out from under it.
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("[role='dialog'], [role='alertdialog']")
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        void startSessionInActiveSpace();
      } else if (key === "o") {
        e.preventDefault();
        openNewSpaceDialog();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startSessionInActiveSpace]);
}
```

Its doc comment records: mounted exactly once at `App` root, for the same reason `useAttentionAlert` is; the accepted cost is that on macOS a literal `Ctrl+N` in the composer no longer moves the caret down a line (the Emacs binding) — `⌘N` already won before this change and `↓` still moves the caret; and no interaction with `useAttentionAlert` is needed, since that listener is capture-phase precisely because other handlers stop propagation, and this task adds a bubbling listener without removing one.

In `src/App.tsx`: call `useAppShortcuts()` beside `useAttentionAlert()`; read the flag with `useSyncExternalStore(subscribeNewSpaceDialog, getNewSpaceDialogOpen)` — **two args**, matching all three existing sites (`App.tsx:285`, `SpacesList.tsx:209`, `SidePane.tsx:115`); render `{newSpaceDialogOpen && <NewSpaceDialog onClose={() => setNewSpaceDialogOpen(false)} />}` as a **sibling of the `view === "settings"` ternary**, next to `<SubagentModals sheetMounted={…} />` at `:433` — not inside the workspace branch, or the Settings page loses the dialog again. Comment it with the `SubagentModals` reason (the else-branch renders nothing while Settings is open).

In `src/components/SpacesList.tsx`: delete the `keydown` `useEffect` and its comment; delete the `{dialogOpen && <NewSpaceDialog …/>}` render (`:457`) and the now-unused `NewSpaceDialog` import; delete the `useStartNewConversation` import/call; replace the two `newSession.*` reads. The handlers become:

```ts
const handleOpenSpace = openNewSpaceDialog;   // zero-arg module fn, stable forever
const handleNewSession = useCallback(
  () => void startSessionInActiveSpace(),
  [startSessionInActiveSpace],
);
```

⚠ `openNewSpaceDialog` must be the **zero-arg** export — `setNewSpaceDialogOpen` has arity 1 and fails against `SessionRailAction.onClick: () => void` (`SessionRail.tsx:10`) and against `MouseEventHandler<HTMLButtonElement>` (`SpacesList.tsx:338`), `TS2322` both ways. The actions-menu trigger's `title={newSession.error ?? undefined}` becomes `title={newSessionError ?? undefined}` with `const newSessionError = useSessions((s) => s.newSessionError);`, and the menu item's `onSelect` becomes `() => void startSessionInActiveSpace()`.

⚠ Two edits this file's own logic will otherwise get wrong: prune `useEffect` from the `react` import at `:1` (it is the file's only `useEffect`, and `noUnusedLocals` turns the orphan into a `TS6133` build failure); and **keep `activeView`** (`:121`) plus the `views` memo — with the hook gone it is still what feeds `viewIds` (`:126`), `liveIds`/`storedIds` (`:156`, `:160`), the row list (`:398`) and every row's space name (`:402`). Keep the `⌘N`/`⌘O` `Kbd` hints — they are now honest.

Behaviour note, deliberate and unannounced until now: the `…` menu's "New Session in this Space" item calls the hook **directly** today (`:381`) with no no-Space routing, unlike the button at `:219-228`. Routing it through `startSessionInActiveSpace` gives it the dialog fallback too. That is the fix; pin it with a test.

Delete `src/hooks/useStartNewConversation.ts` + `.test.ts`. All four of the deleted file's cases have store-level equivalents from Task 2 (the fourth assertion — `activeSessionId === "new1"` — was carried into Task 2's case 1); `clearError` had no consumer outside the hook.

**Steps:**
- [ ] Write `src/hooks/useAppShortcuts.test.ts` first — the chord's own tests, rendering a tiny host component that calls the hook, so every dispatch can target a **real element** (a `window` dispatch has a `Window` target and never touches the guard — the blind spot that hid these bugs). Cases, each with `setNewSpaceDialogOpen(false)` + a `useSessions.setState` reset in `beforeEach`:
  1. `⌘N on a focused <textarea> starts a Session` — the case the old suite structurally could not express.
  2. `⌘O on a focused <textarea> opens the Open Space dialog`.
  3. `⌘O on an <input> inside role="dialog" does nothing`.
  4. `⌘O on an <input> inside role="alertdialog" does nothing` — the `alertdialog` half, which a `[role='dialog']`-only guard silently fails.
  5. `⌘O targeted at a contenteditable="false" element fires` — the behaviour the deleted `SpacesList` test pinned, moved rather than dropped.
  6. `⌘N ignores auto-repeat` (`repeat: true`) and `⌘N ignores Ctrl+Shift+N`.
  7. `a bare key with no modifier does nothing`.
- [ ] Run `pnpm test src/hooks/useAppShortcuts.test.ts` — fail (no hook), then implement `useAppShortcuts.ts`, then pass.
- [ ] In `src/App.test.tsx`, add `describe("App (the ⌘O chord reaches the dialog from the SETTINGS view)")`. ⚠ Two harness requirements this file's conventions do not give you for free: add `startSession: vi.fn().mockResolvedValue({ sessionId: "new1", cwd: "/tmp/ws", capabilities: {}, archived: false })` to that file's `vi.mock("./lib/tauri")` factory (it is not mocked there today, and the factory spreads `importActual`, so the real `invoke` rejects in jsdom and prints noise — the failure mode `App.test.tsx`'s own comment describes); and **move the dialog-flag reset to FILE scope**, next to the existing module-flag resets at `:171-173`, as `beforeEach(() => setNewSpaceDialogOpen(false))` — a leaked `true` makes every later `render(<App/>)` mount a real Radix modal, which sets `document.body.style.pointerEvents = "none"` and `aria-hidden`s its siblings, reddening the `getByRole("button", { name: "Settings" })` queries at `:332`, `:374`, `:389`, `:443`, `:695`, `:995`, `:1103` and the `"Red"` ones at `:446`, `:473`, `:614`, `:628`, `:790`, `:823`. Case: `⌘O with the Settings view open opens the dialog` — open Settings the way `the_gear_icon_swaps_to_the_settings_view` (`:369`) does, then `fireEvent.keyDown(document.body, { key: "o", ctrlKey: true })` (a body target is not swallowed by the guard, and this keeps the "no chord test dispatches only on `window`" rule honest), then assert `getNewSpaceDialogOpen() === true` and that the dialog's title text renders — proving the root render site works in the view where `SpacesList` does not exist.
- [ ] Run `pnpm test src/App.test.tsx` — the new case fails (no root listener/render yet). Then wire `App.tsx` (hook + root render + `useSyncExternalStore`) and re-run to green.
- [ ] Do the `SpacesList.tsx` edits (delete effect/render/hook, prune the import, keep `activeView`, the two new handlers, `newSessionError`).
- [ ] Run `pnpm test` and fix the fallout. The complete list, verified against the file: the `contenteditable="false"` test (`:488`) is **moved** to `useAppShortcuts.test.ts`, not deleted; the input half of `ignores ⌘N / Ctrl+O while the target is an input or a dialog` (`:465`) is inverted to "fires" and its `role="dialog"` half stays; the four `"New space"` text assertions — `:165` (`opens the Open Space dialog from the action button`), `:172` (`…from the New Session button when no space is selected`), `:1128` (`…from the rail icon`), `:683` (`New Session with an archived session active … (not the Open Space dialog)`) — become `getNewSpaceDialogOpen()` assertions (`true` for the three openers; `false` + `startSession` called for the archived one), because `SpacesList` no longer renders the dialog; and the two chord tests `:506` and `:526` move to `useAppShortcuts.test.ts` since no listener remains in this component. Add `setNewSpaceDialogOpen(false)` to the existing file-level `beforeEach` at `:151`. Add the `…`-menu no-Space routing test (menu item with `activeSpacePath: null` → the flag is `true`).
- [ ] Delete `src/hooks/useStartNewConversation.ts` + `.test.ts`; fix the dangling citation in `src/hooks/useAttentionAlert.test.ts:38` (it names the deleted test as the `importActual` precedent — point it at another surviving file).
- [ ] Run `pnpm test` and `pnpm build` — green (`tsc` catches stale imports and the arity trap).
- [ ] Commit: `fix(ui): the ⌘N/⌘O chords are app-wide and no longer yield to the composer`

**Acceptance criteria:**
- [ ] The chord fires with the caret in a `textarea`; it is inert inside `role="dialog"` **and** `role="alertdialog"`.
- [ ] Both chords work with the Settings page open, where `SpacesList` is unmounted, and the dialog renders there.
- [ ] `useStartNewConversation.ts` is gone; the chord lives in one hook at `App` root; exactly one `NewSpaceDialog` render site exists in `src/`.
- [ ] At least one chord test dispatches on a real element target (not `window`), so the guard is genuinely exercised.
- [ ] `pnpm test` and `pnpm build` pass.

---

### Task 4: Give DialogContent a default width, and migrate every caller into the same merge group

**Context:** `DialogContent`'s base class caps itself at `max-w-[calc(100%-2rem)]`, and `w-full` on a `fixed` element resolves against the viewport — so a caller that passes no width fills the window, which is why the New Space dialog spans the app. `NewSpaceDialog` is the only caller that passes none; every sibling caps itself, and the sibling primitive `AlertDialogContent` already ends its base class with `sm:max-w-md`. That asymmetry is the bug. The migration is not cosmetic: `cn()` is `tailwind-merge`, which puts `max-w-3xl` and `sm:max-w-md` in **different** groups so both survive, and the emitted CSS places the `sm:` rule later than the plain ones — so an unmigrated `max-w-3xl` loses above 640px and `ModelPickerDialog`/`SkillsDialog` silently become 28rem, invisible to jsdom.

**Files:**
- Modify: `src/components/ui/dialog.tsx` (`DialogContent`'s base class)
- Modify: `src/components/DeleteSessionDialog.tsx`, `src/components/CloseSpaceDialog.tsx`, `src/components/SudoConfirmModal.tsx`, `src/components/SudoPasswordModal.tsx` (`max-w-md` → `sm:max-w-md`)
- Modify: `src/components/settings/McpSection.tsx` (`max-w-lg` → `sm:max-w-lg`)
- Modify: `src/components/ModelPickerDialog.tsx`, `src/components/SkillsDialog.tsx` (`max-w-3xl` → `sm:max-w-3xl`; `max-h-[70vh]` stays unprefixed — it is a separate group)
- Create: `src/components/ui/dialog.test.tsx`
- Modify: `src/components/ModelPickerDialog.test.tsx` (`:202`), `src/components/SkillsDialog.test.tsx` (`:255`)
- Do NOT change: `src/components/ui/alert-dialog.tsx` (already correct), `src/components/NewSpaceDialog.tsx` (takes the new default; needs no class), `src/components/SubagentDetailHost.tsx` (a `fixed` panel, not a `DialogContent`).

**What to implement:**

Append ` sm:max-w-md` to the `DialogContent` base class string, leaving `w-full` and `max-w-[calc(100%-2rem)]` exactly where they are — the viewport-relative cap is what keeps a dialog inside a narrow window; `sm:max-w-md` is the missing default. Comment it with the trap: callers must state their width in the `sm:` form, because a bare `max-w-*` is a different `tailwind-merge` group, both classes survive to CSS, and the `sm:` rule appears later in the emitted sheet, so it wins above 640px.

Then convert each caller above. Change nothing else in those files — no spacing, no structure, no `showCloseButton` churn.

**Steps:**
- [ ] Create `src/components/ui/dialog.test.tsx`: render `<Dialog open><DialogContent data-testid="c">x</DialogContent></Dialog>` and assert the `sm:max-w-md` token is present in `className`. No stubs and no mocks are needed — verified that a bare dialog mounts clean in jsdom with `data-slot="dialog-content"`, `role="dialog"` and the base class. Assert via `className.split(/\s+/)` membership, never `toContain`, so `sm:max-w-md` and a bare `max-w-md` cannot be confused.
- [ ] Run `pnpm test src/components/ui/dialog.test.tsx` — fail (no default), add the class, pass.
- [ ] In `src/components/ModelPickerDialog.test.tsx`, replace the existing `expect(content?.className).toContain("max-w-3xl")` (`:202`) with token-set membership asserting **both** halves: the set contains `sm:max-w-3xl` and does **not** contain `max-w-3xl`. Do the same at `src/components/SkillsDialog.test.tsx:255`. ⚠ The existing assertions are the trap: `toContain("max-w-3xl")` matches inside `"… sm:max-w-3xl"`, so leaving either line makes it pass while testing nothing.
- [ ] Run `pnpm test src/components/ModelPickerDialog.test.tsx src/components/SkillsDialog.test.tsx` — both new assertions fail (callers still pass a bare `max-w-3xl`).
- [ ] Apply the base-class change and all seven caller migrations.
- [ ] Run `pnpm test` (root) — green. If another snapshot or class assertion names an old width, update it and say which in the commit message.
- [ ] Run `pnpm build` (root) — green. Then the straggler check: `grep -rn "<DialogContent" src/ | grep -v "sm:max-w"` must return **two** lines — `src/components/NewSpaceDialog.tsx:105` (the caller that takes the new default) and `src/components/ui/dialog.test.tsx`, this task's own new test, which renders `<DialogContent>` bare on purpose to assert the default token. Expecting one line hunts a phantom and reads as a false failure. Run the check as `grep -rn --exclude=*.test.tsx "<DialogContent" src/ | grep -v "sm:max-w"` to get the caller-only answer it is meant to give; `ui/dialog.tsx` never contains the literal `<DialogContent` (it renders `<DialogPrimitive.Content`), so it appears in neither. Because that grep is line-local, also eyeball the 8 known call sites listed in Files.
- [ ] Manual check on a dev build: New Space is ~28rem, not the window's width; Skills and the Model picker are still 48rem.
- [ ] Commit: `fix(ui): DialogContent defaults to sm:max-w-md, and every caller caps itself in the same merge group`

**Acceptance criteria:**
- [ ] `NewSpaceDialog` passes no width class and its content carries the `sm:max-w-md` token.
- [ ] No `DialogContent` caller passes an unprefixed `max-w-*`; the caller-only grep (with `--exclude=*.test.tsx`) returns only `NewSpaceDialog.tsx`.
- [ ] Both `ModelPickerDialog.test.tsx:202` and `SkillsDialog.test.tsx:255` assert token membership with the negative half — neither is vacuous.
- [ ] `pnpm test` and `pnpm build` pass.

---

## Verification of the whole (after all four)

- [ ] `pnpm test` and `pnpm build` from the repo root; `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/` — remembering CI runs the Rust bar on ubuntu, windows **and** macos.
- [ ] On a Linux dev build, the four manual checks: keys work at fresh launch with no click; the chords work with the caret in the composer; they work on the Settings page; New Space is ~28rem.
- [ ] `grep -rn "NewSpaceDialog" src/` shows one render site (`App.tsx`); `grep -rn "useStartNewConversation" src/` is empty.
