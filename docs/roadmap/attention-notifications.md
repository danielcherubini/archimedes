---
status: committed
done-when: With the app unfocused, a settled run and an `ask` question each raise exactly one OS notification after the configured delay; typing, clicking, or scrolling in the window before that delay raises none.
---

# Attention alerts plan

**Goal:** notify the user on the OS level when a Session has been paused on them — a finished run or a gate awaiting an answer — for longer than a configurable delay, and never when they are actually in the window.

**Architecture:** the renderer *decides*, Rust *counts down* (ADR 0039). Pure functions derive the **attention trigger** from the Zustand stores (the same facts behind the "Waiting" pill), a hook turns trigger/evidence transitions into two IPC commands, and the Supervisor sleeps, checks window focus at expiry, and delivers through `tauri-plugin-notification` (ADR 0038). Rust reads no settings and knows no Session vocabulary: it is handed the delay and the text.

**Tech stack:** Tauri 2 + Rust (`tokio`, `tauri-plugin-notification`), React 19 + Zustand, vitest (jsdom), `cargo test` (`tokio::time::pause`).

**The five rules that look like bugs but are the design — read before coding:**

1. **A Stalled session must never announce itself as finished.** `SessionManager::handle_crash` (`src-tauri/src/agent/session/router.rs:114`) resolves the in-flight turn with `StopReason::Cancelled` (the call is at ~line 130) and only *then* emits `session-stalled` — so `ChatStream`'s `await sendPrompt(...)` returns normally, `turnCompleted` runs first, and the stall flag arrives **after**. The exclusion is therefore both a guard on the trigger and an evidence-driven disarm (Task 4/5).
2. **The window's own Minimize button is not an activity signal** (ADR 0038): "run finishes → click Minimize → walk off" is this feature's main use case.
3. **An armed countdown is disarmed only by EVIDENCE or by its own elapsed delay — never by an absent candidate.** The settled trigger is a one-snapshot pulse; the countdown outlives it. Any store write after the pulse (the naming pass pushes `session-titled` a couple of seconds after the first exchange → `titleSession` rewrites `sessions`, `src/store/sessions.ts:932`) would otherwise disarm the alert before its delay elapses and kill the feature's headline case.
4. **The renderer's memory of a countdown retires when the delay elapses, and a spent pause is forgotten when the pause ends.** Rust never reports back (the protocol is one-way), so the renderer retires its own `armed` at its recorded deadline and marks that pause `spent` (the one-shot); and `spent` is *forgotten* the moment the pause it names ends — a new turn starting, or the gate going away. Without the first, a later pause is swallowed by a stale `armed`; without the second, a `settled` trigger (which carries no per-occurrence id) would suppress **every later run of that Session for the whole app lifetime**.
5. **One countdown, last pause wins.** Rust holds exactly one countdown, so a pause arriving while another is live *replaces* it — the earlier pause is never announced. Deliberate: one alert app-wide, naming the most recent pause.

**Glossary (already in `CONTEXT.md`):** **Attention alert**, **attention trigger** (`settled` / `waiting`), **attention timer**, **activity signal**. Do not call it a "notification" in code — the MCP layer owns that word (`mcp::rpc::parse_notification`, `McpHttp::send_notification`).

---

### Task 1: The two settings, end to end

**Context:** the feature ships with a master switch and a delay (default 15 s). Settings live in `crate::config::Settings`, serialized to `settings.json` with `#[serde(rename_all = "camelCase")]`; every field is `#[serde(default)]`-guarded so a pre-feature file parses without migration. The frontend mirrors the struct as `AppSettings` in `src/lib/tauri.ts` and edits it through the Settings page's immediate-save pattern (a `Switch` / `Select` calling the `onSave(partial)` prop `SettingsPage` already provides — it merges `{ ...settings, ...patch }`, so new keys are not dropped).

**Files:**
- Modify: `src-tauri/src/config.rs` — the `Settings` struct, the `default_*` helpers, `impl Default for Settings` (~line 196), and the test module (`settings_round_trip_with_the_new_fields`'s **exhaustive** literal at ~line 857 and its camelCase key list at ~line 906)
- Modify: `src/lib/tauri.ts` — `AppSettings` (line 433)
- Modify: `src/components/settings/GeneralSection.tsx` — two rows in its single `SettingsGroupCard`, beside "Name sessions automatically"
- Test: `src-tauri/src/config.rs` (its own `mod tests`)
- Test: `src/components/settings/SettingsPage.test.tsx`
- Modify (required — `tsc` fails on every full `AppSettings` literal, and jsdom otherwise renders the wrong control):
  - `src/components/settings/SettingsPage.test.tsx` — BOTH the `baseSettings` literal (line 28) AND the **inlined** `getSettings: vi.fn().mockResolvedValue({…})` document inside the `vi.mock("../../lib/tauri")` factory (~line 76). That inline document — not `baseSettings` — is what the page actually renders; without the keys the new Switch renders `aria-checked="false"` and the new Select renders empty.
  - `src/store/settings.test.ts` — `FULL_SETTINGS` (line 17)
  - `src/lib/settings.test.ts` — `settingsFixture()`'s return literal (~line 48) AND the full literal in the `vi.mocked(getSettings).mockResolvedValue({…})` call (~line 136)
  - `src/components/ChatStream.test.tsx` — `SETTINGS_FIXTURE` (line 37)
  - `src/components/MessageBubble.codeblock.test.tsx` — `SETTINGS_FIXTURE` (line 37)
  - Optional but consistent (untyped mock documents, so they affect rendered values only, not compilation): `src/App.test.tsx`, `src/components/SpacesList.test.tsx`

**What to implement:**

In `config.rs`, add to `Settings` (after `session_naming_reasoning`):

```rust
/// Attention alerts (ADR 0038/0039): the master switch for the OS
/// notification raised when a session has been paused on the user
/// (finished, or waiting on a gate) for longer than
/// `attention_alert_delay_secs`. `#[serde(default = "default_true")]` — the
/// feature ships ON, so a pre-feature file reads as enabled (the
/// `session_naming_enabled` pattern, not the `#[serde(default)]`-false one).
#[serde(default = "default_true")]
pub attention_alerts_enabled: bool,
/// The delay between an attention trigger and the alert, in SECONDS.
/// `#[serde(default = "default_attention_delay_secs")]` = 15 — half of
/// pi-archimedes' 30 s terminal default, affordable here because the desktop
/// also gates on window focus. There is no clamping LAYER on purpose: the
/// Settings select is the only producer, and the only bound is the
/// sanity ceiling in `commands::attention` (Task 2).
#[serde(default = "default_attention_delay_secs")]
pub attention_alert_delay_secs: u64,
```

plus

```rust
fn default_attention_delay_secs() -> u64 {
    15
}
```

and the two matching arms in the hand-written `impl Default for Settings` (`true`, `default_attention_delay_secs()`). Do NOT add a `#[derive(Default)]` (a derived one would be a second, divergent default — the reason `FontSettings` is hand-written too).

In `AppSettings` add both as **required** fields with doc comments (the backend always emits them):

```ts
/** Attention alerts (ADR 0038/0039): master switch for the OS notification raised when a session has been paused on you longer than `attentionAlertDelaySecs`. ON by default, so a pre-feature `settings.json` reads as enabled. */
attentionAlertsEnabled: boolean;
/** Seconds between an attention trigger and the alert (default 15). Read at arm time: changing it does not re-time a countdown already running. */
attentionAlertDelaySecs: number;
```

In `GeneralSection.tsx` add two rows using the existing `SettingsRow` primitive and the existing `onSave` prop:

- `label="Notify when the app is waiting on you"` — `Switch` with the same `aria-label`, `checked={settings.attentionAlertsEnabled}`, `onCheckedChange={(checked) => onSave({ attentionAlertsEnabled: checked })}` (copy the "Name sessions automatically" row at ~line 305).
- `label="Delay before notifying"` — a `Select` over `"5s" | "15s" | "30s" | "60s"`, `value={`${settings.attentionAlertDelaySecs}s`}`, `onValueChange={(value) => onSave({ attentionAlertDelaySecs: Number(value.replace("s", "")) })}`, `SelectTrigger aria-label={label} className="w-48"` (the `PolicyRow` shape).
  **Out-of-list values must render, not vanish.** Radix renders the *placeholder* when the value matches no `SelectItem`, and an empty control misrepresents the saved delay — the failure `PolicyRow` documents and solves by passing children to `SelectValue`. Do the same: when the value is not one of the four, render `<SelectValue>{`${secs}s`}</SelectValue>`, so a hand-edited `90s` shows `90s`. Do NOT add a clamp or a normalizer.

Do NOT touch `SettingsPage.tsx`'s save plumbing, and do NOT add per-trigger toggles.

**Steps:**
- [ ] Write the failing Rust test in `config.rs`'s `mod tests`, `attention_alert_defaults_survive_a_pre_feature_file`: `serde_json::from_str::<Settings>("{}")` gives `attention_alerts_enabled == true` and `attention_alert_delay_secs == 15`; and `write_settings` → `load_settings` round-trips `false` / `60`.
- [ ] Run `cargo test attention_alert` from `src-tauri/`.
  - Expected: a compile error on the missing fields. If it passes, stop and confirm you edited `Settings`, not `ProviderConfig`.
- [ ] Implement the `config.rs` fields + defaults. Update `settings_round_trip_with_the_new_fields`: add `attention_alerts_enabled: false,` and `attention_alert_delay_secs: 60,` to its **exhaustive** literal (it will not compile otherwise, and the key-list assertion below would be vacuously satisfied by the serialized defaults), then add `"\"attentionAlertsEnabled\""` and `"\"attentionAlertDelaySecs\""` to its key list.
- [ ] Run `cargo test` from `src-tauri/` — green, including `load_settings_on_a_missing_file_writes_the_defaults`.
- [ ] Run `cargo fmt --all` then `cargo clippy --all-targets -- -D warnings` from `src-tauri/` (CI's exact gates, `.github/workflows/ci.yml:58,65`) — zero warnings.
- [ ] Write the failing frontend tests in `SettingsPage.test.tsx`: the Switch row reflects the fixture value and toggling it calls `saveSettings` with a document carrying `attentionAlertsEnabled: false`; the delay row shows `15s`, and picking `60s` saves `attentionAlertDelaySecs: 60`. Add the two keys to `baseSettings` AND to the inline `getSettings` document.
- [ ] Update `AppSettings` in `src/lib/tauri.ts` and every fixture listed under Files above.
- [ ] Implement the two `GeneralSection.tsx` rows.
- [ ] Run `pnpm test` and `pnpm build` from the repo root — green, `tsc` clean.
- [ ] Commit: `feat: attention-alert settings (master switch + delay)`

**Acceptance criteria:**
- [ ] A `settings.json` without the new keys loads with alerts enabled and a 15 s delay, and is rewritten with both keys present.
- [ ] Toggling either row persists immediately; a hand-edited `90s` renders as `90s`, not as an empty control.

---

### Task 2: The Rust countdown — `attention.rs`, the two commands, the plugin

**Context:** the countdown must not live in the renderer: Tauri throttles a backgrounded webview (tauri-apps/tauri#5250), and a hidden/minimised window is this feature's entire customer. Rust gets a deliberately dumb timer — handed a delay and text, it sleeps, asks one question at expiry ("is the main window focused?"), and either drops the alert (ADR 0038: one-shot, never retried, never held for a later blur) or shows it. Desktop needs no notification permission (the plugin's `request_permission` is a documented no-op on desktop), so there is no capability entry, no npm package, and no first-run prompt.

**Files:**
- Create: `src-tauri/src/attention.rs`
- Create: `src-tauri/src/commands/attention.rs`
- Modify: `src-tauri/src/lib.rs` — `pub mod attention;`; `.plugin(...)` (~line 159); `generate_handler!` (~line 162); the managed-state block in `setup_dirs_with_factory` (~lines 94–131, where `app.manage(sink)` … `app.manage(db)` live)
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod attention;`)
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-notification = "2"`, beside the other `tauri-plugin-*` deps) and `src-tauri/Cargo.lock` (rewritten by the `cargo add` — ~100 transitive crates: `notify-rust`, `zbus`, `zvariant`, `window-vibrancy`; commit it)
- Test: `src-tauri/src/attention.rs` (its own `#[cfg(test)] mod tests`)

**What to implement:**

`src-tauri/src/attention.rs`:

```rust
/// The text of one attention alert — composed by the renderer, which owns
/// every scrap of session vocabulary (ADR 0039).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertText {
    pub title: String,
    pub body: String,
}

/// The seam answering "is the main window the focused window?" — a real one
/// reads the `WebviewWindow`, a test answers from a cell.
pub type FocusProbe = std::sync::Arc<dyn Fn() -> bool + Send + Sync + 'static>;
/// The seam that shows the alert (a real one calls the notification plugin).
pub type Delivery = std::sync::Arc<dyn Fn(&AlertText) + Send + Sync + 'static>;

pub struct AttentionTimer {
    pending: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    focus: FocusProbe,
    deliver: Delivery,
}

impl AttentionTimer {
    pub fn new(focus: FocusProbe, deliver: Delivery) -> Self;
    /// Abort any pending countdown, sleep `delay`, then fire.
    pub fn arm(&self, delay: std::time::Duration, title: String, body: String);
    /// Abort the pending countdown. Idempotent — a no-op when nothing is armed.
    pub fn disarm();
}
```

(The `disarm` signature above is shorthand — write `pub fn disarm(&self);`.)

`arm`: take the `std::sync::Mutex`, `take()` + `abort()` any existing handle, **drop the guard before** `tokio::spawn`, store the new handle. **Clone the two probes out of `self` first** — `let (focus, deliver) = (self.focus.clone(), self.deliver.clone());` — because the spawned future must be `'static` and may not borrow `self` (writing `(self.focus)()` inside the `async move` block is an `E0597` capture error). The task body is then exactly `sleep(delay).await; if focus() { return; } deliver(&AlertText { title, body });` — no retry, no re-arm, no repeat, no logging of the alert text. `arm` / `disarm` are **sync** methods (a command must never hold that lock across an await).

`src-tauri/src/commands/attention.rs`:

```rust
#[tauri::command]
pub async fn attention_arm(
    timer: tauri::State<'_, std::sync::Arc<crate::attention::AttentionTimer>>,
    delay_secs: u64,
    title: String,
    body: String,
) -> Result<(), String>;

#[tauri::command]
pub async fn attention_disarm(
    timer: tauri::State<'_, std::sync::Arc<crate::attention::AttentionTimer>>,
) -> Result<(), String>;
```

Both delegate and return `Ok(())`. Inside `attention_arm`, build the duration as `std::time::Duration::from_secs(delay_secs.min(86_400))`. The reason is **not** overflow (`Duration::from_secs(u64::MAX)` is perfectly valid; the panicking constructors are `from_secs_f64` / `from_secs_f32` / `Duration::new`) — an absurd hand-edited value would become an effectively-never countdown, because `tokio::time::sleep` clamps an overflowing deadline to its far-future sentinel. Say exactly that in the comment: 24 h is the "someone edited the file" sanity ceiling, not a policy clamp, and `0` still means "fire immediately", as typed.

In `lib.rs`:
- `pub mod attention;` in the module list; `pub mod attention;` in `commands/mod.rs`.
- `.plugin(tauri_plugin_notification::init())` beside the other `.plugin(...)` calls.
- `commands::attention::attention_arm,` and `commands::attention::attention_disarm,` in `generate_handler!`.
- In `setup_dirs_with_factory` (generic over `R: tauri::Runtime` — fine, both seams are boxed and erased), build and `app.manage(std::sync::Arc::new(AttentionTimer::new(focus, deliver)))`:

```rust
let focus_handle = app.handle().clone();
let focus: crate::attention::FocusProbe = std::sync::Arc::new(move || {
    use tauri::Manager;
    focus_handle
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        == Some(true)
});
let deliver_handle = app.handle().clone();
let deliver: crate::attention::Delivery =
    std::sync::Arc::new(move |t: &crate::attention::AlertText| {
        use tauri_plugin_notification::NotificationExt;
        let _ = deliver_handle
            .notification()
            .builder()
            .title(&t.title)
            .body(&t.body)
            .show();
    });
```

(The explicit `FocusProbe` / `Delivery` annotations — or an `as`-coercion — are required; a bare `Arc::new(closure)` does not infer to the boxed trait alias.) The window label is `"main"` (the `tauri.conf.json` window has no explicit `label`, so it gets Tauri's default).

The focus probe is deliberately **fail-open for firing**: a missing window or an `is_focused()` error yields `false` = "not focused" → the alert fires. A window that cannot report focus is certainly not the window the user is reading. Put that reasoning in the doc comment.

Do NOT: add a `notification` entry to `src-tauri/capabilities/default.json` (application commands are not capability-gated and the plugin is only called from Rust); add commands to `src-tauri/tests/ipc.rs` (unit-test the timer); install `@tauri-apps/plugin-notification`; emit any Tauri event about the countdown (the protocol is one-way — the renderer's own memory handles "spent").

**Steps:**
- [ ] Write the failing tests in `attention.rs`'s test module with `#[tokio::test]` + an explicit `tokio::time::pause()`. Use explicit `pause()` and NOT `#[tokio::test(start_paused = true)]` (the idiom elsewhere in the repo, e.g. `agent/harness/ask.rs`): `start_paused` turns on auto-advance, which would defeat the "advance to 14.9 s and assert nothing fired yet" assertions. Add a local helper so the spawned task settles: `async fn settle() { for _ in 0..5 { tokio::task::yield_now().await; } }`. Recorder: `std::sync::Arc<std::sync::Mutex<Vec<AlertText>>>`.
  - `fires_once_when_unfocused_at_expiry` — probe `false`; `arm(15s)`; `advance(14.9s)` + `settle()` → recorder empty; `advance(0.2s)` + `settle()` → exactly the armed `AlertText`.
  - `a_focused_window_drops_the_alert_and_never_retries` — probe `true`; advance well past expiry → recorder stays empty.
  - `disarm_before_expiry_sends_nothing`
  - `arming_again_replaces_the_pending_countdown` — arm A, arm B, advance → `[B]` only.
  - `disarm_is_idempotent` — `disarm()` twice with nothing armed → no panic.
- [ ] Run `cargo test attention` from `src-tauri/` — fails (module missing). Create the module; if any test passes before you implement, stop and fix the test.
- [ ] Add the dependency (`cargo add tauri-plugin-notification@2` from `src-tauri/`, then move the `Cargo.toml` line beside the other `tauri-plugin-*` entries with a one-line comment; keep the `Cargo.lock` diff).
- [ ] Wire `lib.rs` (module, plugin, handler list, managed state) + `commands/mod.rs` + the two commands.
- [ ] Run `cargo test` from `src-tauri/` — green.
- [ ] Run `cargo fmt --all` and `cargo clippy --all-targets -- -D warnings` — zero warnings.
- [ ] Commit: `feat: supervisor-side attention countdown and notification delivery`

**Acceptance criteria:**
- [ ] The timer is testable with no window and no OS notification (both seams injected).
- [ ] At most one countdown in flight; `disarm` with nothing armed is a no-op.
- [ ] `src-tauri/capabilities/default.json` and `package.json` are unchanged.

---

### Task 3: The renderer's IPC wrappers

**Context:** every Tauri command has a typed one-line wrapper in `src/lib/tauri.ts`; hooks mock those wrappers, so the wire contract (command name + camelCase arg keys) is asserted only in `src/lib/tauri.test.ts` — a typo there passes every test on both sides and fails only at runtime, in the app. That is why this task exists on its own.

**Files:**
- Modify: `src/lib/tauri.ts` (append with the other command wrappers)
- Test: `src/lib/tauri.test.ts`

**What to implement:**

```ts
/** Arm the Supervisor's attention countdown (ADR 0039: Rust owns the clock).
 * One armed alert at a time — arming REPLACES the pending countdown. */
export async function attentionArm(
  delaySecs: number,
  title: string,
  body: string,
): Promise<void> {
  await invoke("attention_arm", { delaySecs, title, body });
}

/** Disarm the attention countdown. Idempotent; called for EVERY disarm reason. */
export async function attentionDisarm(): Promise<void> {
  await invoke("attention_disarm");
}
```

**Steps:**
- [ ] Write the failing tests in `src/lib/tauri.test.ts` (the file already mocks `@tauri-apps/api/core`): `attentionArm(15, "Archimedes", "b")` → `expect(mockedInvoke).toHaveBeenCalledWith("attention_arm", { delaySecs: 15, title: "Archimedes", body: "b" })`; `attentionDisarm()` → `expect(mockedInvoke).toHaveBeenCalledWith("attention_disarm")` — pin the NO-args form exactly (do not pass `{}`).
- [ ] Run `pnpm test src/lib/tauri.test.ts` — fails (no export).
- [ ] Implement both wrappers.
- [ ] Run `pnpm test` and `pnpm build` — green.
- [ ] Commit: `feat: attention arm/disarm IPC wrappers`

**Acceptance criteria:**
- [ ] Command names match Rust exactly (`attention_arm`, `attention_disarm`) and the arg key is `delaySecs` (→ `delay_secs`).

---

### Task 4: The rule — trigger, evidence, memory, and alert text as pure functions

**Context:** this codebase puts every rule in a pure function so the hook and its tests share one copy (`sessionStatusOf` in `src/hooks/useSessionStatus.ts` is the model). Four pure pieces live here: which pause is the candidate, whether an armed countdown still has evidence to stand on, when the renderer retires its own memory of a countdown, and what the alert says.

Two shapes matter:
- **"waiting" is a state**, identified by the **gate's id**, so a second question from the same Session is a new trigger and alerts again. A Session can hold several gates at once and a frame can be re-delivered, so the snapshot carries the FULL list of pending gate ids — the trigger names the first, the evidence rule asks whether *that gate is still among them*.
  **Provenance of that id, and why nothing may assume it is unique:** on the native path the interactive `requestId` IS the model's tool-call id (`ask_flow(..., &tc.id, ...)` in `agent/harness/loop.rs`, emitted verbatim as `requestId` in `agent/harness/ask.rs`; the sudo flow derives `{toolCallId}:confirm` / `:password`, `agent/interactive/mod.rs`). The comment at `src/store/interactive.ts:21` ("The frame UUID … never the bare `toolCallId`") is **stale for the native path — do not trust it.** Some OpenAI-compatible gateways index tool-call ids per response (`call_0`, `call_1`), so an id CAN recur across turns; that is harmless only because rule R4 forgets a spent pause when its gate closes. Never add an assumption of global uniqueness.
- **"settled" is a pulse** — it exists only on the snapshot where `inTurn` fell. The countdown outlives the pulse (design rule 3), which is why `attentionStep` disarms only on evidence.

**Accepted consequences (do not "fix" these):**
- `ChatStream.tsx:954` maps a rejected `send_prompt` to `turnCompleted(id, "end_turn")`, so a **failed send** can announce "finished — waiting for you" while the UI shows an error banner. Accepted: the renderer has no failure signal to distinguish it, and a new failure channel is out of scope. This is the only known false positive.
- Store writes are batched (React + `createBatchedSessionUpdate`, `App.tsx:46`), so an `inTurn` `false → true → false` collapse inside one commit produces no snapshot boundary and no pulse — the realistically reachable case is the rejected-send path, which calls `beginTurn` (`ChatStream.tsx:935`) and `turnCompleted` (`:954`) back to back. Accepted — the price of a one-snapshot pulse.
- A `settled` disarm on "a new turn started" is scoped to the **armed** Session, not "any turn anywhere" (which the ADR 0038 prose sketches loosely). A turn in a different Session does not make this Session's finished alert a lie.

**Files:**
- Create: `src/lib/attention.ts`
- Create: `src/lib/attention.test.ts`

**What to implement** in `src/lib/attention.ts` — React-free, zustand-free; it may import only `basenameOfPath` from `./paths` and the `StopReason` **type** from `./tauri`:

```ts
export type AttentionKind = "settled" | "waiting";

export type AttentionTrigger =
  /** The gate's identity is part of the trigger: a new question from the same
   * session is a new trigger (and re-arms). A subagent's gate keeps the
   * SUBAGENT's id — its closing is what disarms the alert. */
  | { kind: "waiting"; sessionId: string; gateId: string }
  | { kind: "settled"; sessionId: string };

export function sameAttentionTrigger(
  a: AttentionTrigger | null,
  b: AttentionTrigger | null,
): boolean; // kind + sessionId + gateId

/** What the rule reads. Built by the hook — never inside a zustand selector. */
export interface AttentionSnapshot {
  /** Deterministic candidate order: active session first, then live MAIN
   * sessions in store order, then subagent ids in store order (deduped). */
  candidateOrder: string[];
  /** Live main session ids ONLY (a subagent finishing is not the user's pause —
   * its parent is still in turn). ALSO the liveness test for a settled trigger:
   * a PAUSED session leaves this list, and its "finished" alert goes with it. */
  settledWatch: string[];
  inTurn: Record<string, boolean>;
  /** From `useSessions.stopReasons` — a `cancelled` turn never "finished". */
  stopReasons: Record<string, StopReason | undefined>;
  /** id → EVERY pending gate id for that session (`InteractiveRequestData.requestId`
   * for `ask`/`confirm`/`password`, then `PermissionPromptData.requestId`).
   * Non-empty = that session is waiting. `[0]` is the candidate's `gateId`;
   * membership (not position) is the evidence. */
  waitingIds: Record<string, string[]>;
  /** id → true when STALLED (ADR 0025) — never "settled". */
  stalled: Record<string, boolean>;
}

export interface AttentionMemory {
  /** What the renderer last asked Rust to count (`null` = nothing armed). */
  armed: AttentionTrigger | null;
  /** The monotonic instant (`performance.now()`) at which the armed countdown is
   * over, so the renderer can retire its own memory of a countdown Rust never
   * reports back from. Captured AT ARM TIME from the delay in force then — a
   * later settings change must not re-time a running countdown (Task 1). `null`
   * when unarmed. */
  armedExpiresAt: number | null;
  /** The last countdown that ENDED for the pause it names (ADR 0038's one-shot).
   * Forgotten by rule R4 when that pause ends. */
  spent: AttentionTrigger | null;
}

export interface AttentionOptions {
  enabled: boolean;
  /** **Monotonic** (`performance.now()`), injected so the step stays pure.
   * Never `Date.now()`: a wall-clock step (suspend/resume, NTP correction)
   * would retire the memory while Rust's monotonic countdown is still live,
   * and an armed countdown can then no longer be disarmed by activity. */
  now: number;
  delaySecs: number;
}

export type AttentionEffect =
  | { type: "arm"; trigger: AttentionTrigger }
  | { type: "disarm" }
  | { type: "none" };

export function attentionTriggerOf(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
): AttentionTrigger | null;

export function attentionStep(
  memory: AttentionMemory,
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
  opts: AttentionOptions,
): { effect: AttentionEffect; memory: AttentionMemory };

/** The activity path, pure so its "no IPC when nothing is armed" rule is testable. */
export function attentionActivityStep(memory: AttentionMemory): {
  effect: AttentionEffect;
  memory: AttentionMemory;
};

export const ATTENTION_TITLE = "Archimedes";

export interface AttentionLabelContext {
  /** Live sessions first, then history: the first `sessionId` match wins. */
  sessions: { sessionId: string; cwd: string; title?: string | null }[];
  /** Subagent id → parent id (`SubagentEntry.parentSessionId`). */
  parents: Record<string, string>;
}

export function attentionAlertText(
  trigger: AttentionTrigger,
  ctx: AttentionLabelContext,
): { title: string; body: string };
```

`attentionTriggerOf`, in this exact order:
1. **waiting wins app-wide** — the first id in `next.candidateOrder` with a non-empty `next.waitingIds[id]` → `{ kind: "waiting", sessionId: id, gateId: ids[0] }`. (The same precedence `sessionStatusOf` gives `waiting` over `running`.)
2. **settled is a transition** — `prev` non-null, and the first id in `next.candidateOrder ∩ next.settledWatch` where `prev.inTurn[id] === true`, `next.inTurn[id] === false`, `next.stalled[id] !== true`, and `next.stopReasons[id] !== "cancelled"` → `{ kind: "settled", sessionId: id }`. The two guards are the crash case (`handle_crash` resolves with `Cancelled` BEFORE `session-stalled` lands, so the `stopReasons` guard catches a crash whose stall flag has not arrived) and a user Stop (a cancelled run did not "finish").
3. otherwise `null`.

`attentionStep` — **the order and the fall-through are both load-bearing.** Run the rules in order over a *working copy* of the memory. Some rules only change memory (R2, R3, R4) and therefore **fall through** — mutate, remember any owed command, and keep evaluating; only R1, R5 and R6 return. At most ONE command leaves the hook per pass, and an `arm` subsumes a `disarm` (Rust replaces its single pending countdown), so the returned effect is: `arm` if R5 earned one, else `disarm` if one is owed, else `none`.

- **R1 — disabled (returns).** `!opts.enabled`: if armed, owe a disarm. Clear `armed` and `armedExpiresAt` but **keep `spent`** (switching the setting off and back on must not re-alert a pause that already alerted; R4 owns `spent`'s lifetime). Return `disarm` if owed, else `none`.
- **R2 — retire an elapsed countdown (falls through).** `armed !== null` and `opts.now >= (armedExpiresAt ?? opts.now)` → `spent = armed`, `armed = null`, `armedExpiresAt = null`. **NO command** — the countdown is over, there is nothing to cancel. Retirement is LAZY: it happens on the first snapshot at or after the deadline (the hook owns no timer). That is exactly why this rule must fall through rather than return — the retiring snapshot is frequently the one carrying a brand-new pulse, and returning here would drop that pause forever.
- **R3 — evidence disarm (falls through).** With `t = armed` (`kind`, `id`), any of:
  - `next.stalled[id] === true` (the stall that raced the trigger), or
  - `t.kind === "settled"` and `next.inTurn[id] === true` (a new turn started in that Session — a "finished" alert would be a lie), or
  - `t.kind === "settled"` and `!next.settledWatch.includes(id)` (the Session was **paused/closed** — `handleSessionClosed` keeps `activeSessionId`, so a `candidateOrder` check alone would NOT catch it), or
  - `t.kind === "waiting"` and `!(next.waitingIds[id] ?? []).includes(t.gateId)` (that exact gate closed, timed out, or was replaced — **membership, not position**: a re-delivered frame re-appends the array and must not look like a close), or
  - `!next.candidateOrder.includes(id)` (a subagent entry that has gone away)

  → owe a disarm; `armed = null`, `armedExpiresAt = null`, `spent = null`.
- **R4 — forget a spent pause once that pause has ended (falls through).** `armed === null`, `spent !== null`, and the pause `spent` names has ended:
  - `spent.kind === "settled"` → `next.inTurn[spent.sessionId] === true` (a new turn began) or `!next.settledWatch.includes(spent.sessionId)` (closed/paused), or
  - `spent.kind === "waiting"` → `!(next.waitingIds[spent.sessionId] ?? []).includes(spent.gateId)` (that gate is gone)

  → `spent = null`. No command. **This is what lets a second run of the same Session alert again**: a `settled` trigger carries no per-occurrence identity, so without this the one-shot would silence every later run of that Session for the whole app lifetime. It is also what makes a recycled provider tool-call id harmless.
- **R5 — arm (returns).** `const candidate = attentionTriggerOf(prev, next)`. If `candidate` is non-null and differs (via `sameAttentionTrigger`) from **both** `armed` and `spent` → return `arm(candidate)` with `armed = candidate`, `armedExpiresAt = opts.now + opts.delaySecs * 1000`, `spent` unchanged. This single rule covers the supersede case too (a gate opening over a settled countdown, waiting already beating settled inside `attentionTriggerOf`), and it implements design rule 5: **last pause wins** — a pause arriving while another countdown is live replaces it, so the earlier one is never announced. (A rapid *series* of pulses can keep sliding the deadline; that needs several Sessions finishing in succession, where picking any one of them is arbitrary anyway.)
- **R6 — nothing to do (returns).** Return the owed `disarm` if there is one, else `none`.

The latch is R5's `sameAttentionTrigger(candidate, armed)` arm plus R2's laziness: while armed and evidenced, an empty candidate means NOTHING. Do not disarm, and do not re-arm (re-arming restarts the countdown on every store write).

`attentionActivityStep`: `memory.armed === null` → `{ effect: { type: "none" }, memory }` (**no IPC at all**); else `{ effect: { type: "disarm" }, memory: { armed: null, armedExpiresAt: null, spent: memory.armed } }` — the disarmed pause is spent, so typing without answering does not re-alert it, and R4 (or the next evidence-driven disarm) clears that memory when the pause ends.

`attentionAlertText` — use the codebase's `||` idiom (a `??` chain cannot reach the fallback: `basenameOfPath` returns `""` for empty input or a bare root like `/`, and `""` is not `null`):
- `const id = ctx.parents[trigger.sessionId] ?? trigger.sessionId;`
- `const row = ctx.sessions.find((s) => s.sessionId === id);`
- `const label = row?.title?.trim() || (row ? basenameOfPath(row.cwd) : "") || "A session";`
- body: waiting → `` `${label} needs your answer` ``; settled → `` `${label} finished — waiting for you` ``; title `ATTENTION_TITLE`.

Do NOT read `agentState` (the `working`/`idle`/`blocked` map is not pushed by the native harness; `inTurn` is the ground truth, as `ChatStream.tsx:141` documents). Do NOT add per-session armed state (one alert app-wide). Do NOT export a mutable singleton.

**Steps:**
- [ ] `src/lib/attention.test.ts` — `attentionTriggerOf`: settle with nothing waiting → settled; no fall (`false → false`) → null; `prev === null` → null; a gate → waiting with `ids[0]` as `gateId`; **waiting beats settled** in one snapshot; a stalled session's fall → null; a `cancelled` stopReason → null; a subagent id with a gate → waiting carrying the **subagent's** id; a subagent id is never settled (absent from `settledWatch`); ordering (active beats a later live session; live beats subagents).
- [ ] `attentionStep` cases — write the memory literally in each (`armed`, `armedExpiresAt`, `spent`) and pass `now` explicitly; one `it` per assertion:
  - **R1:** `enabled: false` while armed → `disarm`, `armed`/`armedExpiresAt` cleared, **`spent` preserved**;
  - **R3:** each evidence disarm — the stall landing after arming; `inTurn` true again; the paused Session leaving `settledWatch`; the armed `gateId` no longer among `waitingIds[id]`; the Session gone from `candidateOrder`. Plus the **non**-disarm: a re-delivered gate frame that re-appends `waitingIds[id]` (the armed id still present) → `none`, still armed;
  - **R2:** `armedExpiresAt = now - 1` → `none` effect, `armed: null`, `spent` = the retired trigger; `armedExpiresAt = now + 1` → still armed, `spent` untouched;
  - **R2 falls through (regression):** armed settled-A whose deadline just passed **and** a settled pulse for Session B on the same snapshot → effect `arm(B)`, `armed = B`, `spent = settled-A` (a returning R2 would lose B forever);
  - **R3 falls through:** the armed gate closed AND another Session's gate pending on the same snapshot → ONE effect, `arm(that gate)` — no separate `disarm`;
  - **R4 (regression, the once-per-run bug):** full sequence — settle A → arm → retire (`spent = settled-A`) → `inTurn[A] = true` (spends away) → settle A again → `arm` again. Assert the final effect is `arm`;
  - **R4 for a gate:** `spent = waiting-A-g1` with `waitingIds[A] = []` → `spent` cleared, so the same `g1` id reappearing arms;
  - **R5 last pause wins:** armed settled-A (deadline in the future) + a settled pulse for B → `arm(B)`, `spent` unchanged; and armed settled-A + a waiting candidate for B → `arm(B)`;
  - **R5/R6 latch (regression for the self-disarming bug):** `{ armed: settled-A, armedExpiresAt: now + 14_000, spent: null }`, `prev = null`, no fall → `{ effect: { type: "none" } }`, still armed, `attentionDisarm` never implied;
  - **R5 one-shot:** candidate equal to `spent` → `none`.
- [ ] `attentionActivityStep`: armed → disarm + `spent` = the armed trigger + `armedExpiresAt: null`; nothing armed → `none` (assert no `disarm` effect object exists).
- [ ] `attentionAlertText`: title constant; both bodies; label precedence trimmed title → folder name → `"A session"`; a blank/whitespace title falls through; `cwd: "/"` falls through to `"A session"`; **a subagent trigger labels with the PARENT's title**.
- [ ] Run `pnpm test src/lib/attention.test.ts` — fails (module missing); implement; iterate to green.
- [ ] Run `pnpm build` — `tsc` clean.
- [ ] Commit: `feat: the attention rule, memory, and alert wording, as pure functions`

**Acceptance criteria:**
- [ ] All four functions are pure and React-free, and the whole behaviour is readable from the test file.
- [ ] `attention.ts` imports only `./paths` and (type-only) `./tauri`.
- [ ] Rule order is asserted by tests: R2/R3/R4 fall through (a retiring or disarming pass that also carries a candidate still ARMS), the R5 latch cannot disarm an armed countdown, and R4 lets a Session's second run alert again.

---

### Task 5: The hook — arm, disarm, activity signals, the chrome exemption

**Context:** the hook is the only impure shell. It reads the stores, builds the snapshot, runs `attentionStep` / `attentionActivityStep`, and issues the commands, holding `AttentionMemory` in a ref. Rust never tells the renderer anything: the protocol is one-way, so the renderer's own `armedExpiresAt` retirement (Task 4 rule R2) and its `spent` memory (with R4 forgetting it when the pause ends) are what make an alert fire exactly once per pause while still letting the next pause alert.

Settings ordering, stated so nobody "fixes" a non-bug: `useSettings.settings` is seeded asynchronously by `loadAndApplySettings()` in `src/main.tsx` at boot. Live Sessions do not survive a restart, so a settled pulse can only follow a user send — far later than boot — so a pulse lost before settings land is not a reachable path. Hence `settings === null` means **disabled**, no buffering.

**Files:**
- Create: `src/hooks/useAttentionAlert.ts`
- Create: `src/hooks/useAttentionAlert.test.ts`
- Modify: `src/App.tsx` — call the hook once at the top of `App()`
- Modify: `src/components/WindowControls.tsx` — `data-window-control` on the wrapping `<div>`
- Modify: `src/components/WindowControls.test.tsx` — assert every control sits inside `[data-window-control]`
- Modify: `src/App.test.tsx` — add `attentionArm: vi.fn().mockResolvedValue(undefined)` and `attentionDisarm: vi.fn().mockResolvedValue(undefined)` to its `vi.mock("./lib/tauri")` factory (that factory spreads `importActual`, so an un-mocked export would call the REAL `invoke` and log noise)

**What to implement** in `src/hooks/useAttentionAlert.ts` (returns `void`):

1. **Selectors return stable references** (the standing hazard documented in `useSessionStatus.ts`): `useSessions((s) => s.sessions)`, `s.inTurn`, `s.stopReasons`, `s.stalled`, `s.activeSessionId`, `s.historySessions`; `usePermissions((s) => s.prompts)`; `useInteractive((s) => s.requests)`; `useSubagents((s) => s.entries)`; `useSettings((s) => s.settings)`. Never `?? {}` inside a selector — default outside it.
2. Build the `AttentionSnapshot` in a `useMemo` over those values:
   - `candidateOrder` = dedup of `[activeSessionId?] + live session ids (store order) + Object.keys(subagentEntries)`;
   - `settledWatch` = live main session ids (`sessions.map((s) => s.sessionId)`);
   - `waitingIds[id]` = the gate ids for that session — the `requestId`s of `requests[id]` filtered to `method === "ask" | "confirm" | "password"` (keep the filter even though the union has only these three — the same filter `sessionStatusOf` uses), followed by the `requestId`s of `prompts[id]`; omit the key when the list is empty;
   - `stalled[id]` = `!!stalledMap[id]`.
3. `const enabled = settings?.attentionAlertsEnabled === true;` — `=== true` is the fail-safe FORM (an absent or `undefined` field means OFF; the same fail-safe DIRECTION as the `#`-mention gate's `?? false` in `ChatStream.tsx:186`). `const delaySecs = settings?.attentionAlertDelaySecs ?? 15;`
4. Keep `prevSnapshot` and `memory` in refs. In a `useEffect` on `[snapshot, enabled, delaySecs]`:
   ```ts
   const { effect, memory } = attentionStep(memoryRef.current, prevRef.current, snapshot, {
     enabled,
     now: performance.now(), // monotonic — never Date.now() (see AttentionOptions)
     delaySecs,
   });
   prevRef.current = snapshot;
   memoryRef.current = memory;
   runPass(effect, delaySecs);
   ```
   (`performance.now()` exists in both the webview and jsdom, so the tests need no shim.)
5. **Activity listeners** in a `useEffect` with an empty dep array, on `window`, all **capture** phase: `keydown`, `pointerdown`, `wheel` (`{ passive: true }` for `wheel`). Handler:
   ```ts
   // `event.target` is `window` for a window-dispatched event and `Window` has
   // no `closest` — an optional chain on the target alone would throw.
   const el = event.target instanceof Element ? event.target : null;
   if (el?.closest("[data-window-control]")) return; // chrome is not attention (ADR 0038)
   const { effect, memory } = attentionActivityStep(memoryRef.current);
   memoryRef.current = memory;
   // `attentionActivityStep` can only ever yield `disarm` or `none` — it can
   // never arm, so this handler needs no settings values and holds no ref to them.
   if (effect.type === "disarm") void attentionDisarm().catch(logFailure);
   ```
   Unregister all three in the cleanup, and in that same cleanup: if `memoryRef.current.armed` is set, `void attentionDisarm()` and clear it (a webview reload must not leave a countdown ringing with stale text in the Supervisor). Note in a comment that React StrictMode's double-mount is safe here: nothing is armed at mount, so the cleanup cannot send a spurious disarm.
   Capture is load-bearing: `ChatStream` owns a window `keydown` handler and Radix dialogs stop propagation, so a bubbling listener would miss activity inside a modal — exactly where a **Permission prompt** sits.
6. `runPass(effect, delaySecs)` (the pass path is the only one that can arm): `disarm` → `attentionDisarm()`; `arm` → `attentionArm(delaySecs, title, body)` with `attentionAlertText(trigger, { sessions: [...liveSessions, ...historySessions], parents })` where `parents[id] = entries[id].parentSessionId`; `none` → nothing. Wrap each call in `.catch(logFailure)` with one shared `logFailure = (e) => console.error("attention alert failed:", e)` — a notification failure must never break the chat.
7. Do NOT listen to `blur` / `focus` (a blur must never disarm — the user leaving is the alert's reason to exist), `mousemove`, `pointermove`, `scroll`, `resize`. Do not debounce. Never call `attentionArm` more than once per pass.
8. `src/App.tsx`: `useAttentionAlert();` at the top of `App()`, commented as view-independent (mounted with the app, not the workspace, so it works while Settings is open).
9. `src/components/WindowControls.tsx`: add `data-window-control` to the outer `<div>` with a comment naming the reason (the activity exemption) so a future chrome button is added deliberately. **Scope, stated honestly:** the exemption covers these three buttons only. A click on the rest of the drag bar, a Space tab, or a pane toggle IS attention — the exemption is "the window controls", not "the chrome bar".

**Steps:**
- [ ] Write `src/hooks/useAttentionAlert.test.ts` in the `useHasPendingRequest.test.ts` style (`renderHook`, `store.setState(...)` in `beforeEach`, `vi.mock("../lib/tauri")` for `attentionArm`/`attentionDisarm`). **Use real timers** — the hook owns no timer (Rust owns the clock) and `vi.useFakeTimers()` makes RTL's `waitFor` hang. Reset these stores completely in `beforeEach`: `useSessions` with `sessions, historySessions, archivedSessions, activeSessionId, activeSpacePath, spaces, closeReasons, messages, configOptions, inTurn, stopReasons, stalled` (the `useHasPendingRequest.test.ts` list omits `inTurn`/`stopReasons`/`stalled` — copying it leaks turn state between cases here), plus `usePermissions.setState({ prompts: {} })`, `useInteractive.setState({ requests: {}, todos: {}, agentState: {}, cost: {}, session: {} })`, the subagent dismiss loop, and `useSettings.setState({ settings: <fixture>, loaded: true })`. Unmount between cases so `armed`/`spent` start clean.
- [ ] Cover, one `it` each (wrap command assertions in `await waitFor(...)`):
  - a turn falling with nothing waiting → one `attentionArm(15, "Archimedes", "<label> finished — waiting for you")`;
  - a gate appears → one arm with the "needs your answer" body, and `60` passed through when the fixture says 60;
  - waiting beats settled in one pass;
  - a stalled session's fall → no call; a `cancelled` stopReason → no call;
  - `settings === null` → no call; `attentionAlertsEnabled: false` → no call, and a `disarm` if previously armed;
  - **no re-arm and no disarm:** after arming, unrelated store writes that leave the armed evidence intact → `attentionArm` still 1 call, `attentionDisarm` still 0 (the regression test for the self-disarming bug);
  - the stall landing AFTER arming → exactly one `attentionDisarm`;
  - pausing the armed session (removing it from `sessions`) → exactly one `attentionDisarm`;
  - **spend:** arm, dispatch `keydown` on `window`, re-create the same candidate → still one arm, one disarm; a *different* candidate (another session, or settled→waiting) does arm again;
  - `keydown`, `pointerdown`, `wheel` each disarm exactly once while armed;
  - **input with nothing armed → zero IPC** (neither wrapper called);
  - a `pointerdown` whose target sits inside a `[data-window-control]` container does NOT disarm (mount `<div data-window-control><button data-testid="chrome" /></div>` into `document.body` and dispatch on the button);
  - `blur` does NOT disarm (`window.dispatchEvent(new Event("blur"))`);
  - unmount → the listeners are gone AND an armed countdown is disarmed.
- [ ] Run `pnpm test src/hooks/useAttentionAlert.test.ts` — fails (module missing); implement; iterate to green.
- [ ] Write the failing `WindowControls.test.tsx` assertion (each control has a `[data-window-control]` ancestor), then add the attribute.
- [ ] Mount the hook in `src/App.tsx` and add the two mocks to `src/App.test.tsx`; run `pnpm test src/App.test.tsx` — green and stderr-clean.
- [ ] Run `pnpm test` and `pnpm build` — green.
- [ ] Commit: `feat: attention alerts (arm on a pause, disarm on evidence or activity)`

**Acceptance criteria:**
- [ ] One armed alert app-wide; a subagent's gate alerts while an unrelated Session is open, naming the PARENT.
- [ ] Idle typing costs no IPC; a settled countdown survives every unrelated store write until its delay elapses.
- [ ] Both exemptions tested: chrome click and blur.
- [ ] Note in the hook's comment: `SubagentEntry.parentSessionId` is the ONLY parent source (`useSubagents` is the sole holder), so a gate whose parent is not in `sessions`/`historySessions` labels `"A session"`. Accepted — do not add a second parent map.

---

### Task 6: Full gate, and the platform pass that tests cannot make

**Context:** three platforms differ and only part of it is catchable locally: Windows renders OS notifications properly only for an **installed** app (a dev build shows a mislabelled toast — the plugin's own documented behaviour); macOS suppresses notifications from the frontmost application at the OS level, which the focus gate already matches; Linux is a silent no-op with no notification server running (the same degradation the pi port accepts when a terminal speaks no OSC dialect — degrade silently, never surface an error).

**Files:**
- Modify: `docs/roadmap/attention-notifications.md` — append a `## Verification results` section (this plan file is deleted on ship per `AGENTS.md`; anything durable folds into ADR 0038/0039 or `docs/features/` then)

**What to implement:** no new code. Run the gates and the manual matrix; record what you observed honestly, including "cannot verify here".

**Steps:**
- [ ] From the repo root: `pnpm test`, then `pnpm build`.
- [ ] From `src-tauri/`: `cargo test`, then `cargo fmt --all -- --check`, then `cargo clippy --all-targets -- -D warnings` (CI's exact commands, `.github/workflows/ci.yml:58,65` — a bare `cargo clippy --all-targets` does not fail on warnings locally while CI reddens on them).
- [ ] Manual matrix. Run with `pnpm tauri dev` (NOT `cargo tauri dev` — the CLI is an npm devDependency and `cargo` has no `tauri` subcommand here). Set the delay to `5s` in Settings first and read the row back before trusting it. Use a bundled build for the Windows row.
  - **Settled:** start a prompt, immediately focus another app, wait past the delay → exactly one notification titled `Archimedes` naming the Session.
  - **Settled while the naming pass runs:** same, on a session's FIRST exchange (the `session-titled` push lands mid-countdown and must neither disarm nor re-arm it — Task 5's regression case).
  - **Waiting:** trigger an `ask`, or set the Beyond-boundary Reads policy to `Ask` in an UNTRUSTED Space for a **Permission prompt**; focus out → one notification ending "needs your answer".
  - **Focus suppression:** same trigger, stay in the window untouched past the delay → NO notification.
  - **Activity cancel:** focus out, then click back and type one character / scroll the transcript → NO notification.
  - **Minimise:** click Minimize and walk away → the notification DOES arrive. If it does NOT arrive while minimised, stop and report: the settled trigger is pulse-based and renderer-local, so a fully frozen webview that never observes the `inTurn` fall would need the trigger made evidence-based instead.
  - **Answer closes the gate:** trigger a question, focus out, answer it → no late notification.
  - **Second question:** answer one `ask`, then trigger another in the same Session → it alerts again (the gate identity, not the session id).
  - **Same Session, twice:** let a Session settle and alert, send another prompt, let it settle again → a SECOND notification (rule R4 forgets the spent pause when the new turn starts; without it the Session would alert once per app run).
  - **Two Sessions, two pauses (last pause wins):** settle Session A and focus out; while its countdown runs, settle Session B → exactly ONE notification, naming **B** (Rust holds one countdown and B replaced A's — design rule 5).
  - **Subagent:** delegate a task whose subagent asks a question, sit in an unrelated Session, focus out → one notification naming the PARENT session.
  - **Stall:** kill a session's Worker (`pkill -f -- --worker` while exactly one session is live) → the stalled banner appears and NO "finished" notification fires.
  - **Off:** disable the setting, repeat the Settled row → nothing.
- [ ] On Linux, note whether a notification server is present (`ps -e | grep -i notify`); if absent, record the silent no-op rather than calling it a failure.
- [ ] Append `## Verification results` with one line per row plus the platform(s) used; commit `docs: attention-alert verification results`

**Acceptance criteria:**
- [ ] `pnpm test`, `pnpm build`, `cargo test`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` all green.
- [ ] Every manual row above recorded with its observed outcome, including rows not exercisable on the available OS.
