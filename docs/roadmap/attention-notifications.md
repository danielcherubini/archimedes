---
status: approved
done-when: With the app unfocused, a settled run and an `ask` question each raise exactly one OS notification after the configured delay; typing, clicking, or scrolling in the window before that delay raises none.
---

# Attention alerts — desktop notifications when the app is waiting

## Problem

A run finishes, or an `ask` question blocks a **Session**, and the user is in another
window. None of the app's existing attention UI (the **Waiting** pill, the working
spinner, the collapsed rail's dot) reaches them, because all of it lives inside a
window they are not looking at.

The behaviour is ported in spirit from `@pi-archimedes/notify`
(`~/Coding/Javascript/pi-archimedes/packages/notify`), but re-shaped for a desktop.
A terminal has one signal — keystrokes — and no idea whether the user is looking at
it; the port deliberately does no focus tracking. The desktop has both, so the
feature keys off window focus instead, and keeps pi's core semantic: **this is a
delay, not an idle timer.** Nothing measures how long the user has been reading;
the pause starts the clock and input stops it.

## Language

| Term | Definition |
|---|---|
| **Attention alert** | The OS notification this feature produces. _Avoid_: toast, reminder, ping, and *notification* used alone (that is `mcp::manager::notification` here) |
| **Attention trigger** | The pause that arms the timer. Exactly two: **settled** and **waiting** |
| **Attention timer** | The configurable delay between trigger and alert. An alert is **armed**, **disarmed**, or **fired** |
| **Activity signal** | Deliberate input to the app's *content* while an alert is armed — `keydown`, `pointerdown`, `wheel`. Window chrome and blur are not activity |

**waiting** is already the Session status of a Session holding a gate
(`sessionStatusOf`); **settled** names the case the status vocabulary calls `live`
(a live Session whose turn has ended). No status concept is invented here.

## Behaviour

### Triggers

Both are derived from the existing `sessionStatusOf` rule, so an alert can never
contradict what the UI paints:

- **waiting** — any Session anywhere is `waiting`: an `ask` / `confirm` /
  `password` interactive request (main session **or** a **Subagent session**,
  whose gates arrive directly on the Client) or a **Permission prompt**.
- **settled** — a Session's `inTurn` falls `true → false` while nothing app-wide
  is `waiting`.

**Precedence:** waiting beats settled, app-wide — the same reason `waiting` beats
`running` per-Session. **One armed alert at a time** (pi's single pending timer).

### Arming

A trigger arms the timer with the configured delay. A trigger **identical** to the
armed one (same kind, same Session) does **not** restart the countdown: repeated
settles must not be able to postpone the alert indefinitely. A change of kind or of
Session re-arms (so a gate that opens over a pending settled alert becomes the
alert the user hears about).

### Disarming (no alert)

- any **activity signal**
- a turn starting anywhere (`beginTurn`) — the app is working again, so a
  "finished" alert would be a lie
- the armed gate closing with nothing left waiting (including a gate closed by
  itself: pi's rule that a long-gone question cannot ring)
- the armed Session closing
- the armed Session **stalling**
- the setting switched off

### Firing

The Rust side checks the main window's focus at expiry. **Focused → the alert is
dropped silently and never retried** (a one-shot; no hold-until-blur). Unfocused →
one notification, once. Recorded as **ADR 0038**.

### The two traps this design exists to avoid

1. **A Stalled session looks exactly like a settle to the renderer.**
   `SessionManager::handle_crash` resolves the in-flight `send_prompt`, so
   `ChatStream`'s `await sendPrompt(...)` returns normally and calls
   `turnCompleted` — the very transition the settled trigger watches. Left alone, a
   Worker crash would announce *"N finished — waiting for you"*. So a Session with
   a `stalled` entry never yields a settled alert, and `session-stalled` disarms an
   alert armed for that Session.
2. **Minimise is not activity.** "The run finished → I click Minimize → I walk off"
   is the feature's use case, not an exception to it. The `WindowControls` buttons
   (minimize / maximize / close) are excluded from the activity rule: activity is
   input to the app's content, not to the window chrome — the same reasoning that
   already makes the drag region a non-signal.

### Wording

Title is always `Archimedes`. The body names the Session:

| Trigger | Body |
|---|---|
| waiting | `<label> needs your answer` |
| settled | `<label> finished — waiting for you` |

`<label>` is the **Session title** (ADR 0037), else the **Space**'s folder name,
else `A session`. A **Subagent session**'s gate uses its **parent's** label — a
subagent is never titled, and the parent is the thing the user recognises.

### Settings

`settings.json`, both `#[serde(default)]` (a pre-feature file parses to the
defaults; no migration):

| Key | Default | Meaning |
|---|---|---|
| `attentionAlertsEnabled` | `true` | Master switch |
| `attentionAlertDelaySecs` | `15` | Delay between trigger and alert |

Two immediate-save rows in Settings → General, using the existing Switch / Select
row pattern. The delay is read **at arm time**: changing it does not re-time a
countdown already running (re-timing would mean re-arming on every settings change
for no observable gain on a 15-second window).

## Design

**The renderer decides; Rust counts down.** Each half sits where its facts are:

- The **triggers** are store facts (`inTurn`, `usePermissions`, `useInteractive`,
  `stalled`) and the **activity signals** are DOM facts. Both live only in the
  renderer.
- The **clock** must not live in the renderer: Tauri throttles a backgrounded
  webview (cf. tauri-apps/tauri#5250), and a hidden or minimised window is exactly
  this feature's customer. A `setTimeout` there is a notification that silently
  never fires.

Rust does not read the settings and does not know what a Session is: it is handed
the delay and the text. Recorded as **ADR 0039**.

### Renderer

- `src/lib/attention.ts` — `attentionTriggerOf(input) → null | { kind, sessionId }`,
  a pure function holding the whole rule table (the `sessionStatusOf` pattern: the
  rule is pure so the hook and its tests share one copy of it).
- `src/hooks/useAttentionAlert.ts` — mounted once in `App.tsx` beside the existing
  Tauri listeners, so it is view-independent (it works with the Settings page
  open). Subscribes the stores, runs the pure function, calls `attention_arm` /
  `attention_disarm`, and owns the three window-level **capture-phase** listeners
  (`keydown`, `pointerdown`, `wheel` with `{ passive: true }`).
  - Capture matters: `ChatStream` has its own window `keydown` handler and Radix
    dialogs stop propagation on purpose — a bubbling listener would miss activity
    inside a modal, which is precisely where a **Permission prompt** waits.
  - Input while nothing is armed is handled locally and produces **zero IPC**; a
    disarm is idempotent, so no debouncing is needed.
  - Not signals: window blur (the user leaving must never disarm), mouse motion,
    programmatic auto-scroll of the transcript, resize, anything app-synthesised.

### Rust

- `src-tauri/src/attention.rs` — `AttentionTimer` in managed state: an abort-and-
  respawn `tokio` task (`tokio::time::sleep` → focus check → deliver). The focus
  probe (`Fn() -> bool`) and the deliver step are injected seams, the way
  `provider_factory` is injected into `SessionManager`, so the rules are testable
  without a window or an OS.
- Commands: `attention_arm { delay_secs, title, body }` (aborts any pending task,
  spawns the new one) and `attention_disarm {}` (aborts; idempotent).
- `tauri-plugin-notification` registered in `lib.rs` beside the dialog / opener
  plugins; delivery via `app.notification().builder().title(…).body(…).show()`.
  Desktop needs no permission grant — the plugin's `request_permission` is a
  documented no-op on desktop — so there is **no npm package, no capability entry,
  and no first-run prompt**. Application commands are not capability-gated.

### Non-goals

No per-trigger toggles; no alert for a **Stalled session**; no in-app flash or
banner while the window is visible (the **Waiting** pill already does that job); no
hold-until-blur; no acting on a notification click (no focus-the-Session jump); no
repeat alerts for the same pause.

## Verification

Frontend (`pnpm test`):

1. `attentionTriggerOf` rule table: settle with nothing waiting → `settled`; gate
   appears → `waiting`; waiting beats settled app-wide; a **subagent** gate counts
   although its Session is never the active one; a **Stalled** session never yields
   `settled`; a closing Session removes its trigger; disabled → `null`.
2. `useAttentionAlert` under fake timers with mocked `lib/tauri` commands: arming
   passes the configured delay and the right title/body; `keydown` / `pointerdown` /
   `wheel` dispatched at `window` → exactly one `attention_disarm`; `blur` → no
   disarm; a `pointerdown` inside `WindowControls` → no disarm; input with nothing
   armed → no IPC at all.
3. Label resolution: Session title → Space folder name → `A session`; a subagent
   gate reports the parent's label.
4. Re-arm policy: an identical trigger does not restart the countdown; a change of
   kind or Session does.
5. `SettingsPage.test.tsx`: the two new rows render and save through the
   immediate-save pattern.

Rust (`cargo test`, `src-tauri/`):

6. `AttentionTimer` against a recording deliver seam and a stub focus probe:
   expiry + unfocused → delivered once with the given title/body; expiry + focused
   → nothing; disarm before expiry → nothing; a second arm replaces the pending
   task (exactly one delivery). Drive time with `tokio::time::pause()` so the suite
   never sleeps.
7. `load_settings` on a pre-feature file → `attentionAlertsEnabled = true`,
   `attentionAlertDelaySecs = 15`.

Both roots green per `AGENTS.md`: `pnpm test`, `pnpm build`, `cargo test`,
`cargo clippy --all-targets` (0 warnings), `cargo fmt --check`.

### Platform caveats to verify by hand, not assume

- **Windows:** OS notifications display properly only for an *installed* app; a dev
  build shows a mislabelled toast. Verify on a bundled build.
- **macOS:** the OS suppresses notifications from the frontmost app anyway, which
  the focus gate already honours. Verify on a bundled `.app`.
- **Linux:** with no notification server running, `show()` is a silent no-op — the
  same degradation pi accepts when a terminal speaks no OSC dialect. Degrade
  silently; do not surface an error.
