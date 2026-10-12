---
status: committed
done-when: With the app unfocused, a settled run and an `ask` question each raise exactly one OS notification after the configured delay; typing, clicking, or scrolling in the window before that delay raises none.
---

# Attention alerts plan

**Goal:** notify the user on the OS level when a Session has been paused on them — a finished run or a gate awaiting an answer — for longer than a configurable delay, and never when they are actually in the window.

**Architecture:** the renderer *decides*, Rust *counts down* (ADR 0039). Pure functions derive the **attention trigger** from the Zustand stores (the same facts behind the "Waiting" pill), a hook turns trigger/evidence transitions into two IPC commands, and the Supervisor sleeps, checks window focus at expiry, and delivers an OS notification (ADR 0038) — through `tauri-plugin-notification` on macOS/Windows and through the session bus itself on Linux/BSD, because there the sending connection is what keeps the alert on screen (see `attention::delivery`). Rust reads no settings and knows no Session vocabulary: it is handed the delay and the text.

**Tech stack:** Tauri 2 + Rust (`tokio`, `tauri-plugin-notification`, `notify-rust` on the session-bus targets), React 19 + Zustand, vitest (jsdom), `cargo test` (`tokio::time::pause`).

**The five rules that look like bugs but are the design — read before coding:**

1. **A Stalled session must never announce itself as finished.** `SessionManager::handle_crash` (`src-tauri/src/agent/session/router.rs:114`) resolves the in-flight turn with `StopReason::Cancelled` (the call is at ~line 130) and only *then* emits `session-stalled` — so `ChatStream`'s `await sendPrompt(...)` returns normally, `turnCompleted` runs first, and the stall flag arrives **after**. The exclusion is therefore both a guard on the trigger and an evidence-driven disarm (Task 4/5).
2. **The window's own Minimize button is not an activity signal** (ADR 0038): "run finishes → click Minimize → walk off" is this feature's main use case.
3. **An armed countdown is disarmed only by EVIDENCE or by its own elapsed delay — never by an absent candidate.** The settled trigger is a one-snapshot pulse; the countdown outlives it. Any store write after the pulse (the naming pass pushes `session-titled` a couple of seconds after the first exchange → `titleSession` rewrites `sessions`, `src/store/sessions.ts:932`) would otherwise disarm the alert before its delay elapses and kill the feature's headline case.
4. **The renderer's memory of a countdown retires when the delay elapses, and an announced pause is forgotten when that pause ends.** Rust never reports back (the protocol is one-way), so the renderer retires its own `armed` at its recorded deadline and marks that pause announced — and `spent` is a **SET**, not a slot: a snapshot can owe several announced pauses at once and each entry mutes ONLY its own pause (`6b8b613`; a single slot there was a real defect — announcing the second pause erased the record of the first and re-alerted a pause the user had already been told about); and an entry is *forgotten* the moment the pause it names ends — a new turn starting, or the gate going away. Without the first, a later pause is swallowed by a stale `armed`; without the second, a `settled` trigger (which carries no per-occurrence id) would suppress **every later run of that Session for the whole app lifetime**.
5. **One countdown, and a precedence ladder — NOT "last pause wins".** Rust holds exactly one countdown, so R5 decides which pause owns that single slot, and the slot changes hands only when a HIGHER-ranked pause appears. The ranking is positional — `candidateOrder`, then each Session's `waitingIds` array (that Session's gate-arrival order); there is no cross-session arrival stamp. The ladder, as implemented in `attentionCandidates`/R5 and pinned by tests: (a) an unanswered question (`waiting`) outranks a finished run (`settled`), app-wide; (b) among open questions the **still-open one that RANKS FIRST holds the slot** — within a Session that is the earliest-arrived gate, so a newer question there ranks behind the live one and changes nothing, and across Sessions it is `candidateOrder` that decides (no cross-Session stamp exists), so a question in a Session ranking behind the armed one changes nothing either; (c) a `settled` countdown **is** displaced, by a question opening over it and by a later-arriving `settled` pulse; (d) a pause already announced never re-alerts, but no longer mutes the pauses under it. So "the alert names the most recent pause" holds only settled-over-settled and gate-over-settled; gate-over-gate within a Session is deliberately oldest-wins, and that is a decision, not an oversight: the alert body names the **Session**, not the question ("X needs your answer"), so naming "the most recent" buys the user nothing actionable, while newest-wins would let a stream of arriving questions keep sliding Rust's deadline so no alert ever lands.

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

**Context:** this codebase puts every rule in a pure function so the hook and its tests share one copy (`sessionStatusOf` in `src/hooks/useSessionStatus.ts` is the model). Four pure pieces live here: which pauses are the candidates, whether an armed countdown still has evidence to stand on, when the renderer retires its own memory of a countdown, and what the alert says.

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
   * Non-empty = that session is waiting. EVERY entry is a candidate, in array
   * order (a second question is a second pause); membership (not position) is the
   * evidence an armed countdown stands on. */
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
  /** The pauses that have ALREADY been announced — ADR 0038's one-shot, and a
   * SET, because a snapshot can owe several pauses at once (`loop.rs` runs tool
   * calls in parallel, so two `ask`s really can be open) and several more can be
   * announced while an earlier one is still held. Each entry is forgotten by rule
   * R4 under its OWN `pauseOver`, never as a group. Empty array = nothing
   * announced. Immutable by convention like the rest of the struct. */
  spent: AttentionTrigger[];
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

/** Every pause the user is owed on this snapshot, in strict precedence order.
 * A LIST and not a single head: the head may be a pause already announced
 * (`spent`), and it must not swallow the pause underneath it. R5 filters this
 * list and takes the first entry it does not already owe. */
export function attentionCandidates(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
): AttentionTrigger[];

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

`attentionCandidates`, in this exact order — **every** pending gate, then **every** settled pulse:
1. **waiting wins app-wide** — every id in `next.candidateOrder`, and within one session every id in `next.waitingIds[id]` in array order, contributes `{ kind: "waiting", sessionId: id, gateId }`. (The same precedence `sessionStatusOf` gives `waiting` over `running`; and a SECOND question from the same Session is a second pause that ranks right after the first.)
2. **settled is a transition** — `prev` non-null, and every id in `next.candidateOrder ∩ next.settledWatch` where `prev.inTurn[id] === true`, `next.inTurn[id] === false`, `next.stalled[id] !== true`, and `next.stopReasons[id] !== "cancelled"` contributes `{ kind: "settled", sessionId: id }`. The two guards are the crash case (`handle_crash` resolves with `Cancelled` BEFORE `session-stalled` lands, so the `stopReasons` guard catches a crash whose stall flag has not arrived) and a user Stop (a cancelled run did not "finish").
3. otherwise whatever accumulated, which may be `[]`.

`attentionStep` — **the order and the fall-through are both load-bearing.** Run the rules in order over a *working copy* of the memory. Some rules only change memory (R2, R3, R4) and therefore **fall through** — mutate, remember any owed command, and keep evaluating; only R1, R5 and R6 return. At most ONE command leaves the hook per pass, and an `arm` subsumes a `disarm` (Rust replaces its single pending countdown), so the returned effect is: `arm` if R5 earned one, else `disarm` if one is owed, else `none`.

- **R1 — disabled (returns).** `!opts.enabled`: if armed, owe a disarm. Clear `armed` and `armedExpiresAt` but **keep `spent`** (switching the setting off and back on must not re-alert a pause that already alerted; R4 owns `spent`'s lifetime). Return `disarm` if owed, else `none`.
- **R2 — retire an elapsed countdown (falls through).** `armed !== null` and `opts.now >= (armedExpiresAt ?? opts.now)` → `spent` **gains** `armed` (deduped — ADD, never replace: the pauses announced before it stay announced), `armed = null`, `armedExpiresAt = null`. **NO command** — the countdown is over, there is nothing to cancel. Retirement is LAZY: it happens on the first snapshot at or after the deadline (the hook owns no timer). That is exactly why this rule must fall through rather than return — the retiring snapshot is frequently the one carrying a brand-new pulse, and returning here would drop that pause forever.
- **R3 — evidence disarm (falls through).** With `t = armed` (`kind`, `id`), any of:
  - `next.stalled[id] === true` (the stall that raced the trigger), or
  - `t.kind === "settled"` and `next.inTurn[id] === true` (a new turn started in that Session — a "finished" alert would be a lie), or
  - `t.kind === "settled"` and `!next.settledWatch.includes(id)` (the Session was **paused/closed** — `handleSessionClosed` keeps `activeSessionId`, so a `candidateOrder` check alone would NOT catch it), or
  - `t.kind === "waiting"` and `!(next.waitingIds[id] ?? []).includes(t.gateId)` (that exact gate closed, timed out, or was replaced — **membership, not position**: a re-delivered frame re-appends the array and must not look like a close), or
  - `!next.candidateOrder.includes(id)` (a subagent entry that has gone away)

  → owe a disarm; `armed = null`, `armedExpiresAt = null`, and drop ONLY that trigger from the `spent` set. Clearing the whole set — which is what the single slot's `spent = null` did — un-mutes other pauses that are still open and were already announced, so the SHAPE of the operation is load-bearing.
- **R4 — forget an announced pause once that pause has ended (falls through).** For EACH entry of `spent` whose own pause has ended:
  - `settled` → `next.inTurn[id] === true` (a new turn began) or `!next.settledWatch.includes(id)` (closed/paused), or
  - `waiting` → `!(next.waitingIds[sessionId] ?? []).includes(gateId)` (that gate is gone)

  → remove that ONE entry (prune per entry, so forgetting one never un-mutes another). No command. **This is what lets a second run of the same Session alert again**: a `settled` trigger carries no per-occurrence identity, so without this the one-shot would silence every later run of that Session for the whole app lifetime. It is also what makes a recycled provider tool-call id harmless. It is NOT gated on `armed === null` any more (`4799f7f` dropped that guard): an entry's `pauseOver` is about ITS OWN pause, so a live countdown in another Session has no claim on it, and pruning emits no command at all — the guard bought nothing and cost an alert (a spent `settled:A` lived for as long as ANY countdown ran, which is most of the time since a gate has no timeout, so A's next pulse was filtered as announced and a pulse is never re-delivered).
- **R5 — arm (returns).** `const target = attentionCandidates(prev, next).find((c) => !spent.some((s) => sameAttentionTrigger(s, c)))` — the FIRST candidate not already in the announced set. (A single head compared against `spent` was the original shape, and it was wrong: one already-announced-but-still-open question — `ask`/`confirm`/`password` gates have no timeout, so that is a steady state — vetoed every later pause in every other Session, and because a `settled` pulse exists on exactly one snapshot and is never re-delivered, those alerts were lost for good.) If `target` is non-null and differs (via `sameAttentionTrigger`) from `armed` → return `arm(target)` with `armed = target`, `armedExpiresAt = opts.now + opts.delaySecs * 1000`, `spent` unchanged. This single rule is also the SUPERSEDE, and it implements design rule 5's ladder, **not** "last pause wins": R5 takes the HEAD of a positionally ordered list, so the slot changes hands only for a higher-ranked pause — a question displaces a `settled` countdown, a later `settled` pulse displaces an earlier one, but a newer question never takes the slot from an older question that is still open (`attention.test.ts`'s four `R5 precedence` clauses pin exactly this). (A rapid *series* of `settled` pulses can keep sliding the deadline; that needs several Sessions finishing in succession, where picking any one of them is arbitrary anyway. Questions cannot do that, because they do not displace each other.)
- **R6 — nothing to do (returns).** Return the owed `disarm` if there is one, else `none`.

The latch is R5's `sameAttentionTrigger(target, armed)` arm plus R2's laziness: while armed and evidenced, an empty candidate list means NOTHING. Do not disarm, and do not re-arm (re-arming restarts the countdown on every store write).

`attentionActivityStep`: `memory.armed === null` → `{ effect: { type: "none" }, memory }` (**no IPC at all**); else `{ effect: { type: "disarm" }, memory: { armed: null, armedExpiresAt: null, spent: announceSpent(memory.spent, memory.armed) } }` — the disarmed pause JOINS the announced set (assigning instead of adding was the same overwrite bug R2 had), so typing without answering does not re-alert it, and R4 (or the next evidence-driven disarm) forgets that entry when the pause ends.

`attentionAlertText` — use the codebase's `||` idiom (a `??` chain cannot reach the fallback: `basenameOfPath` returns `""` for empty input or a bare root like `/`, and `""` is not `null`):
- `const id = ctx.parents[trigger.sessionId] ?? trigger.sessionId;`
- `const row = ctx.sessions.find((s) => s.sessionId === id);`
- `const label = row?.title?.trim() || (row ? basenameOfPath(row.cwd) : "") || "A session";`
- body: waiting → `` `${label} needs your answer` ``; settled → `` `${label} finished — waiting for you` ``; title `ATTENTION_TITLE`.

Do NOT read `agentState` (the `working`/`idle`/`blocked` map is not pushed by the native harness; `inTurn` is the ground truth, as `ChatStream.tsx:141` documents). Do NOT add per-session armed state (one alert app-wide). Do NOT export a mutable singleton.

**Steps:**
- [ ] `src/lib/attention.test.ts` — `attentionCandidates`: settle with nothing waiting → `[settled]`; no fall (`false → false`) → `[]`; `prev === null` → `[]`; a gate → a `waiting` candidate carrying that `gateId`; **several open gates are several candidates** (ordered by `candidateOrder`, then by `waitingIds[id]` array order, so a second question ranks right after the first); **every `waiting` candidate precedes every `settled` one** in one snapshot; a stalled session's fall absent; a `cancelled` stopReason absent; a subagent id with a gate → `waiting` carrying the **subagent's** id; a subagent id never `settled` (absent from `settledWatch`); ordering (active beats a later live session; live beats subagents).
- [ ] `attentionStep` cases — write the memory literally in each (`armed`, `armedExpiresAt`, `spent`) and pass `now` explicitly; one `it` per assertion:
  - **R1:** `enabled: false` while armed → `disarm`, `armed`/`armedExpiresAt` cleared, **`spent` preserved**;
  - **R3:** each evidence disarm — the stall landing after arming; `inTurn` true again; the paused Session leaving `settledWatch`; the armed `gateId` no longer among `waitingIds[id]`; the Session gone from `candidateOrder`. Plus the **non**-disarm: a re-delivered gate frame that re-appends `waitingIds[id]` (the armed id still present) → `none`, still armed;
  - **R2:** `armedExpiresAt = now - 1` → `none` effect, `armed: null`, `spent` gains the retired trigger; `armedExpiresAt = now + 1` → still armed, `spent` untouched;
  - **R2 falls through (regression):** armed settled-A whose deadline just passed **and** a settled pulse for Session B on the same snapshot → effect `arm(B)`, `armed = B`, `spent: [settled-A]` (a returning R2 would lose B forever);
  - **R3 falls through:** the armed gate closed AND another Session's gate pending on the same snapshot → ONE effect, `arm(that gate)` — no separate `disarm`;
  - **R4 (regression, the once-per-run bug):** full sequence — settle A → arm → retire (`spent: [settled-A]`) → `inTurn[A] = true` (that entry is forgotten) → settle A again → `arm` again. Assert the final effect is `arm`;
  - **R4 for a gate:** `spent: [waiting-A-g1]` with `waitingIds[A] = []` → that entry is dropped, so the same `g1` id reappearing arms;
  - **R4 per entry:** two announced gates, one closing → only the closed one is forgotten, the other stays announced; and **R4 while another countdown is armed** (regression for the dropped `armed === null` guard) → the entry is forgotten anyway;
  - **R5 precedence, four clauses** (`4799f7f`): (1) a question outranks a finished run app-wide; (2) among questions the still-open one that ranks FIRST holds the slot — armed `waiting:A/g1` + a fresh `waiting:A/g2` (or a question in a Session ranking behind A) → `none`, still armed on g1; (3) a `settled` pulse never displaces a live question; (4) a `settled` countdown IS displaced — by a question and by a later pulse (`spent` unchanged);
  - **R5/R6 latch (regression for the self-disarming bug):** `{ armed: settled-A, armedExpiresAt: now + 14_000, spent: [] }`, `prev = null`, no fall → `{ effect: { type: "none" } }`, still armed, `attentionDisarm` never implied;
  - **R5 one-shot (regression, the muting bug):** `spent: [waiting-A-g1]` while `waitingIds[A] = ["g1", "g2"]` → `arm(waiting-A-g2)` — the announced head is SKIPPED, not obeyed; only a list whose every entry is announced yields `none`.
- [ ] `attentionActivityStep`: armed → disarm + the armed trigger is ADDED to `spent` + `armedExpiresAt: null`; nothing armed → `none` (assert no `disarm` effect object exists); and **ACCUMULATES** rather than overwriting the set (a spend leaves the earlier entries announced).
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

A reload is two halves, and only one of them is closable from here (ADR 0038). A reload runs no React cleanup, so a countdown armed before it would survive and fire with stale text, uncancellable — closed by the hook disarming unconditionally on mount, declared above the pass effect so boot is disarm-then-arm. The mirror image is NOT closed: the reload also wipes the announced-pause set, so a question that already alerted alerts again afterwards. That is accepted — ADR 0038's one alert per pause is per renderer session, not per pause — and closing it properly needs the Supervisor to own (or persist) the announced set, not more renderer-side cleanup.

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
   Unregister all three in the cleanup, and in that same cleanup: if `memoryRef.current.armed` is set, `void attentionDisarm()` and clear it — but that cleanup covers a REAL unmount (the component going away inside a live page) and **nothing else: a webview reload runs no React cleanup at all**, so it cannot be the reload guard the first draft of this plan claimed it was. The reload guard is a SECOND effect that calls `void attentionDisarm()` unconditionally on mount (`cd68330`), and its **declaration order is the ordering mechanism**: it sits ABOVE the pass effect, because React runs a component's effects in declaration order, which is what makes boot disarm-then-arm. Declared below it, it would cancel the countdown the pass effect just booked for a gate that was already open while the memory still claimed it was armed — which R5 respects by never re-arming, so the alert would be silently dead; both mount tests fail the moment it moves. The unconditional call is free (`AttentionTimer::disarm` is a `take()` on Rust's single slot), and `armed` is `null` in the fresh ref by construction, so it can only ever hit an ORPHAN's countdown — one left by the previous renderer, which nothing else in the fresh page can reach (its memory starts unarmed, so the activity path yields `none` and the user's own typing crosses no IPC). Note in the cleanup's comment that StrictMode's double-invoked mount/unmount ends ARMED (transcript `DISARM, ARM, DISARM, DISARM, ARM` — the transient disarms cost redundant IPC, not a lost alert), and do NOT write that nothing can be armed at mount: with a gate already open (Fast Refresh) it can.
   Capture is load-bearing: `ChatStream` owns a window `keydown` handler and Radix dialogs stop propagation, so a bubbling listener would miss activity inside a modal — exactly where a **Permission prompt** sits.
6. `runPass(effect, delaySecs)` (the pass path is the only one that can arm): `disarm` → `attentionDisarm()`; `arm` → `attentionArm(delaySecs, title, body)` with `attentionAlertText(trigger, { sessions: [...liveSessions, ...historySessions], parents })` where `parents[id] = entries[id].parentSessionId`; `none` → nothing. Wrap each call in `.catch(logFailure)` with one shared `logFailure = (e) => console.error("attention alert failed:", e)` — a notification failure must never break the chat.
7. Do NOT listen to `blur` / `focus` (a blur must never disarm — the user leaving is the alert's reason to exist), `mousemove`, `pointermove`, `scroll`, `resize`. Do not debounce. Never call `attentionArm` more than once per pass.
8. `src/App.tsx`: `useAttentionAlert();` at the top of `App()`, commented as view-independent (mounted with the app, not the workspace, so it works while Settings is open).
9. `src/components/WindowControls.tsx`: add `data-window-control` to the outer `<div>` with a comment naming the reason (the activity exemption) so a future chrome button is added deliberately. **Scope, stated honestly:** the exemption covers these three buttons only. A click on the rest of the drag bar, a Space tab, or a pane toggle IS attention — the exemption is "the window controls", not "the chrome bar".

**Steps:**
- [ ] Write `src/hooks/useAttentionAlert.test.ts` in the `useHasPendingRequest.test.ts` style (`renderHook`, `store.setState(...)` in `beforeEach`, `vi.mock("../lib/tauri")` for `attentionArm`/`attentionDisarm`). **Use real timers** — the hook owns no timer (Rust owns the clock) and `vi.useFakeTimers()` makes RTL's `waitFor` hang. Reset these stores completely in `beforeEach`: `useSessions` with `sessions, historySessions, archivedSessions, activeSessionId, activeSpacePath, spaces, closeReasons, messages, configOptions, inTurn, stopReasons, stalled` (the `useHasPendingRequest.test.ts` list omits `inTurn`/`stopReasons`/`stalled` — copying it leaks turn state between cases here), plus `usePermissions.setState({ prompts: {} })`, `useInteractive.setState({ requests: {}, todos: {}, agentState: {}, cost: {}, session: {} })`, the subagent dismiss loop, and `useSettings.setState({ settings: <fixture>, loaded: true })`. Unmount between cases so `armed`/`spent` start clean.
- [ ] Cover, one `it` each (wrap command assertions in `await waitFor(...)`):
  - **boot:** the FIRST command the hook ever sends is `attentionDisarm`, ordered BEFORE the first arm (regression for `cd68330` — moving the mount effect below the pass effect fails it), and a StrictMode double-invoke ends ARMED; command counts in this file read through `disarmsAfterBoot()`, which SUBTRACTS that boot command rather than hiding it, so the transcript is still there for the order tests;
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

> ⚠ **Corrected after this plan shipped** (see
> `## Verification results` → "Linux banner delivery was broken all along"): the
> fourth Linux case below ("no server → silent no-op") is real, but the *working*
> Linux case was not working. The plugin drops `notify_rust`'s handle, the D-Bus
> connection closes with it, and GNOME destroys the alert when the sender's bus name
> vanishes — so Task 5's "Linux: a toast, attributed by the server to this
> executable's desktop entry" never held on GNOME. Linux now delivers through
> `attention::delivery::bus` and retains the handle; the plugin remains the
> macOS/Windows transport.

**Files:**
- Modify: `docs/roadmap/attention-notifications.md` — append a `## Verification results` section (this plan file is deleted on ship per `AGENTS.md`; anything durable folds into ADR 0038/0039 or `docs/features/` then)

**What to implement:** no new code. Run the gates and the manual matrix; record what you observed honestly, including "cannot verify here".

**Steps:**
- [x] From the repo root: `pnpm test`, then `pnpm build`.
- [x] From `src-tauri/`: `cargo test`, then `cargo fmt --all -- --check`, then `cargo clippy --all-targets -- -D warnings` (CI's exact commands, `.github/workflows/ci.yml:58,65` — a bare `cargo clippy --all-targets` does not fail on warnings locally while CI reddens on them).
- [ ] Manual matrix. Run with `pnpm tauri dev` (NOT `cargo tauri dev` — the CLI is an npm devDependency and `cargo` has no `tauri` subcommand here). Set the delay to `5s` in Settings first and read the row back before trusting it. Use a bundled build for the Windows row. **Not run — needs a human at a GUI; see `## Verification results` for the per-row steps and risk order.**
  - **Settled:** start a prompt, immediately focus another app, wait past the delay → exactly one notification titled `Archimedes` naming the Session.
  - **Settled while the naming pass runs:** same, on a session's FIRST exchange (the `session-titled` push lands mid-countdown and must neither disarm nor re-arm it — Task 5's regression case).
  - **Waiting:** trigger an `ask`, or set the Beyond-boundary Reads policy to `Ask` in an UNTRUSTED Space for a **Permission prompt**; focus out → one notification ending "needs your answer".
  - **Focus suppression:** same trigger, stay in the window untouched past the delay → NO notification.
  - **Activity cancel:** focus out, then click back and type one character / scroll the transcript → NO notification.
  - **Minimise:** click Minimize and walk away → the notification DOES arrive. If it does NOT arrive while minimised, stop and report: the settled trigger is pulse-based and renderer-local, so a fully frozen webview that never observes the `inTurn` fall would need the trigger made evidence-based instead.
  - **Answer closes the gate:** trigger a question, focus out, answer it → no late notification.
  - **Second question, the first still open:** let one `ask` alert, leave it UNANSWERED, then trigger a second `ask` in the same Session → the second one arms too (`attentionCandidates` lists every open gate; R5 skips the spent head instead of obeying it). Answering the first and then asking again also alerts — that path is R4 forgetting the spent pause.
  - **A spent question must not mute another Session:** let an `ask` in Session A alert, leave it open; in Session B let a run finish and focus out → B's "finished" alert DOES arrive (it used to be vetoed by A's spent head, and a `settled` pulse exists on one snapshot only, so it was lost for good).
  - **Same Session, twice:** let a Session settle and alert, send another prompt, let it settle again → a SECOND notification (rule R4 forgets the spent pause when the new turn starts; without it the Session would alert once per app run).
  - **Two Sessions, two finishes:** settle Session A and focus out; while its countdown runs, settle Session B → exactly ONE notification, naming **B** (a `settled` pulse displaces an earlier `settled` countdown — design rule 5, clause c). Do NOT expect the same of two open questions: a newer question that ranks BEHIND the armed one leaves it alone (clause b) — always true within one Session, and across Sessions whenever the armed Session still ranks first.
  - **Subagent:** delegate a task whose subagent asks a question, sit in an unrelated Session, focus out → one notification naming the PARENT session.
  - **Stall:** kill a session's Worker (`pkill -f -- --worker` while exactly one session is live) → the stalled banner appears and NO "finished" notification fires.
  - **Off:** disable the setting, repeat the Settled row → nothing.
- [x] On Linux, note whether a notification server is present (`ps -e | grep -i notify`); if absent, record the silent no-op rather than calling it a failure. _(Done, and the probe itself is the finding: on GNOME it prints nothing while a server IS registered — see `## Verification results`.)_
- [x] Append `## Verification results` with one line per row plus the platform(s) used; commit `docs: attention-alert verification results`
**Acceptance criteria:**
- [x] `pnpm test`, `pnpm build`, `cargo test`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` all green.
- [x] Every manual row above recorded with its observed outcome, including rows not exercisable on the available OS. _Recorded; all 14 as `UNVERIFIED-here` — none was exercised, and none is inferred as passing._

---

## Verification results

Run 2026-10-12 on `feature/attention-alerts` at `4dbfedc` (Tasks 1–5 landed).

**Re-cut after `4a6dd8d`** (the renderer fix: `attentionTriggerOf`'s single head
candidate became the `attentionCandidates` LIST, so an already-announced pause can
no longer mute the pause underneath it). Nothing in the matrix has been exercised
by that re-cut — it adds row 14 and re-cuts row 8, because the fixed case is one
only a human can confirm end to end (a `settled` pulse exists on exactly one
snapshot, so no unit test sees the real store-write ordering). The Rust gates were
re-run at the review-hardening commit `2f1562f` and are reported separately below
that table.

**Re-cut again at `823f36e`** (the third review round: one new pinning test for the
stall that lands on an armed question, plus comment-only corrections — no behaviour
changed). The two frontend rows and the Rust-test row below are now the `823f36e`
measurements: `pnpm test` re-run there (1607 in 74 files; the `4dbfedc` figure was
1588 in 74), and `cargo test` re-run fresh at the same tree — **907 passed / 0
failed / 0 ignored across 21 targets**, 0 compile warnings, which is the same
figure the `2f1562f` re-run reported, so that subsection still stands. `pnpm build`
is unchanged at 3153 modules and the same size advisory. Nothing in the manual
matrix was exercised by either re-cut.

**One platform was used: Linux.** The five automated gates are green and reported
with their real numbers below. The manual matrix was **not** exercised — it
needs a human to focus/minimise windows and answer prompts, and starting a dev
window would have hijacked the live desktop session. Every manual row is
therefore recorded as `UNVERIFIED-here` with the exact steps to exercise it. No
row below is inferred from unit tests into "passing": the unit tests prove the
renderer's rule, not the OS behaviour. Nothing on this machine was disturbed —
no `pnpm tauri dev`, no `notify-send`, no focus changes, and (see the wiring
check) never `attention_arm`.

### Environment (the facts a reviewer cannot re-derive later)

| | |
|---|---|
| OS | Fedora Linux 44 (Workstation), `Linux 7.2.8-200.fc44.x86_64`, GNOME (`XDG_CURRENT_DESKTOP=GNOME`) |
| Display | `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`, `XDG_SESSION_TYPE=wayland` |
| Notification server | **PRESENT**, so this machine is NOT the Linux "silent no-op" case. `busctl --user status org.freedesktop.Notifications` → `PID=3871` = `/usr/bin/gjs -m /usr/share/gnome-shell/org.gnome.Shell.Notifications` (GNOME Shell's own server). `/usr/bin/notify-send` installed. A delivered toast WOULD be visible here. |
| ⚠ The plan's probe is wrong on GNOME | `ps -e \| grep -i notify` prints **nothing** on this box (exit 1) even though a server is running — the server is the Shell's `gjs` host, not a process whose `ps` name contains "notify". Use `busctl --user status org.freedesktop.Notifications` (or `gdbus call`) to answer "is there a server?", never `ps`. A future run on GNOME must not conclude "no server → silent no-op acceptable" from `ps`. |
| Node / pnpm | v22.23.1 / 11.7.0 |
| Rust | From `src-tauri/`: `rustc 1.99.0`, `cargo 1.99.0` — the `rust-toolchain.toml` pin, active in that directory (as in CI). **From the repo root the same `cargo` resolves `rustc 1.95.0`** (the rustup default), so the Rust gates must be run from `src-tauri/` or the numbers come from a different compiler than CI's. |
| On-disk settings | `~/.config/archimedes/settings.json` here predates the feature (15 keys, neither `attentionAlertsEnabled` nor `attentionAlertDelaySecs`) — a real pre-feature file, i.e. the exact input Task 1's acceptance criterion describes. Not exercised (needs the app running); the next dev run on this box doubles as that check. |
| Windows / macOS | Not available. The Windows **installed-vs-dev toast** question and macOS' frontmost-app suppression are therefore **completely unverified** by this plan, and both are platform behaviours no Linux test can reach. |

### The five automated gates — all green (CI's exact commands: `ci.yml:58` fmt, `:65` clippy, `:69` cargo test, `:72` pnpm test, `:75` pnpm build)

| Gate | Command | Where | Result |
|---|---|---|---|
| Frontend tests | `pnpm test` (`vitest run`) | repo root | **PASS** — **1607 tests passed in 74 files**, 0 failed, 48.13s (re-cut at `823f36e`; the `4dbfedc` run measured 1588 in 74 files, 46.20s) |
| Type-check + build | `pnpm build` (`tsc && vite build`) | repo root | **PASS** — `tsc` silent (0 diagnostics), 3153 modules transformed, built in 1.34s, exit 0. One pre-existing advisory only (`index-*.js` is 1 034 kB > 500 kB); unchanged by this feature |
| Rust tests | `cargo test` | `src-tauri/` | **PASS** — **907 passed / 0 failed / 0 ignored** across 21 test targets, 0 compile warnings, 16.85s on a warm crate (re-cut at `823f36e`; the `4dbfedc` run measured 898 there — 897 before that commit's `tests/ipc.rs` addition — in 1m07s) |
| Rust formatting | `cargo fmt --all -- --check` | `src-tauri/` | **PASS** — exit 0, zero diffs |
| Rust lint | `cargo clippy --all-targets -- -D warnings` | `src-tauri/` | **PASS** — exit 0, **0** warning lines |

The Rust gates were deliberately re-run against a cold crate so the green is not
a cached-result artifact: `cargo clean -p archimedes` (which removed 71.8 GiB of
stale artifacts) then `cargo clippy --all-targets -- -D warnings` re-checked the
crate from source in 12.5 s — still 0 warnings — and `cargo test` re-ran green on
the fresh build.

Feature-specific coverage inside those totals: **16 Rust tests in the two
attention modules** (see the `2f1562f` re-run below), plus the `config.rs`
pre-feature-file test and the `tests/ipc.rs` wiring check, and **93 frontend tests in
the two dedicated files** (`src/lib/attention.test.ts` 63 rules,
`src/hooks/useAttentionAlert.test.ts` 30 hook), plus
`src/lib/tauri.test.ts`'s 9 wrapper tests, 3 of which pin the attention IPC
boundary (the `attention_arm` command name + `{delaySecs,title,body}` keys, the
`0`-delay passthrough, and `attention_disarm`'s no-payload form), and the
`[data-window-control]` ancestor assertion in `WindowControls.test.tsx`.

### Rust gates, re-run at the review-hardening commit (`2f1562f`)

`cargo test` / `cargo fmt --all -- --check` / `cargo clippy --all-targets --
-D warnings`, all from `src-tauri/`: **907 passed / 0 failed / 0 ignored** across
21 targets with 0 compile warnings, fmt exit 0, clippy exit 0 with 0 warning
lines. Feature coverage is now **16 Rust tests in the two attention modules**
(`attention.rs` 6 — the 5 countdown tests plus the `Handle::try_current` guard;
`commands::attention` 10 — the 2 delay tests plus 8 for the notification-text
bounds), plus the `config.rs` settings test and the `tests/ipc.rs` wiring check.
The frontend numbers in the table above are no longer the `4dbfedc` ones: they were
re-cut at `823f36e` (see the re-cut note above), so this subsection's Rust figures
and those frontend figures now describe different commits — 907 is common to both,
since no Rust test was added or removed by the review rounds after `2f1562f`.

### The wiring check — one deliberate deviation from the plan

Task 2 says "Do NOT add commands to `src-tauri/tests/ipc.rs`". This commit adds
**one** test there anyway (`attention_disarm_resolves_through_the_real_ipc_surface`,
~10 lines + 1 handler entry) because it covers the single failure mode the unit
tests structurally cannot see: the command name and the managed
`Arc<AttentionTimer>` not being wired into the real app (plausibly broken by the
2.12 stack bump in `f294729`, and invisible to every vitest test, which mocks
`invoke`). It drives the production `setup_dirs_with_factory` through
`mock_builder` + `get_ipc_response`.

Honest scope of the claim:

- It uses `attention_disarm` **only** — `attention_arm` would start a real
  countdown and could show a real toast on the developer's desktop. `disarm`
  with nothing armed is the idempotent no-op, so it is safe to send for real.
- RED was observed first: with the command absent from the harness's
  `generate_handler!`, the test fails with `"Command attention_disarm not
  found"`; registered, it passes (`Ok(())` → `null`).
- Non-vacuity was checked the other way too: with `app.manage(AttentionTimer)`
  temporarily commented out of `lib.rs`, the test fails on its
  managed-state assertion (`lib.rs` was restored immediately; `git status`
  shows only `tests/ipc.rs` + this doc).
- What it does **NOT** prove: that the real `lib.rs` handler list contains both
  commands — this harness declares its own `generate_handler!` list. That
  registration was checked by reading `src/lib.rs:237-238`
  (`commands::attention::attention_arm`, `…_disarm`) and `src/lib.rs:165`
  (`app.manage(Arc::new(attention::AttentionTimer::new(…)))`), i.e. **by eye,
  not by machine**. The JS side of the name is pinned separately by
  `src/lib/tauri.test.ts` (`attention_arm` with `{delaySecs,title,body}`,
  `attention_disarm` with no payload).
- What it does not cover: the focus probe and the delivery closure. Both are
  constructed but never called in the harness, so `is_focused()` on a real
  window and `notification().builder().show()` on a real desktop remain
  un-exercised here — that is precisely the manual matrix below.

### Manual matrix — 14 rows, every one UNVERIFIED-here

Setup for all rows: `pnpm tauri dev` (NOT `cargo tauri dev` — the CLI is an npm
devDependency). Open Settings → General, set **Delay before notifying** to
`5s`, close Settings, and **re-open the row to read `5s` back** before trusting
any timing. Then:

| # | Row | Status | Steps → expected | Risk |
|---|---|---|---|---|
| 1 | Settled | **UNVERIFIED-here** | Start a prompt, immediately focus another app, wait past 5 s → exactly ONE notification titled `Archimedes` whose body names the Session (its title, else the folder name) | Medium — the headline path; needs a real delivery |
| 2 | Settled while the naming pass runs | **UNVERIFIED-here** | Same, on a Session's FIRST exchange → still exactly one notification (the `session-titled` push lands mid-countdown and must neither disarm nor re-arm) | Medium — the renderer half IS tested by name (`does not re-arm or disarm when the naming pass re-titles the session`); that the real naming push lands inside the 5 s window is not |
| 3 | Waiting (`ask` / Permission prompt) | **UNVERIFIED-here** | Trigger an `ask` (or set Beyond-boundary Reads to `Ask` in an UNTRUSTED Space for a Permission prompt), focus out → one notification ending "needs your answer" | Medium — the Permission prompt lives in a modal, which is why the listeners are capture-phase |
| 4 | Focus suppression | **UNVERIFIED-here** | Same trigger, stay in the window untouched past 5 s → **NO** notification | **HIGH** — this is the one real `WebviewWindow::is_focused()` call in the feature; a wrong answer here is noise on every settle. The unit test injects a probe, so it cannot catch that |
| 5 | Activity cancel | **UNVERIFIED-here** | Focus out, click back, type one character (or scroll the transcript) → **NO** notification | Low — the renderer rule is tested; only the DOM event routing is not |
| 6 | Minimise | **UNVERIFIED-here** | Click Minimize, walk away → the notification **DOES** arrive | **HIGHEST.** If it does NOT arrive minimised, STOP and report: the `settled` trigger is a renderer-local one-snapshot pulse, so a fully frozen webview that never observes the `inTurn` fall cannot arm the countdown — the fix is to make the trigger evidence-based (Rust-side), not to tune the delay |
| 7 | Answer closes the gate | **UNVERIFIED-here** | Trigger a question, focus out, answer it → no late notification | Low–Medium — evidence disarm; tested at the rule level |
| 8 | Second question, the first still open | **UNVERIFIED-here** | Let one `ask` alert, leave it UNANSWERED, trigger a second `ask` in the SAME Session → the second one arms too (R5 skips the spent head). Then answer the first and ask a third → it also alerts, via R4 | **HIGH** — the muting bug this row used to miss: `ask`/`confirm`/`password` gates have no timeout, so "spent and still open" is a steady state, not a race |
| 9 | Same Session, twice | **UNVERIFIED-here** | Let a Session settle and alert, send another prompt, let it settle → a SECOND notification (R4 forgets the spent pause when the new turn starts) | Medium — without R4 a Session would alert once per app run; rule-level tested |
| 10 | Two Sessions, two finishes | **UNVERIFIED-here** | Settle Session A and focus out; while its countdown runs, settle Session B → exactly ONE notification, naming **B** | Medium — design rule 5 clause c (settled displaces settled; a question does NOT displace a live question); `arming_again_replaces_the_pending_countdown` covers the Rust half |
| 11 | Subagent | **UNVERIFIED-here** | Delegate a task whose subagent asks a question, sit in an unrelated Session, focus out → one notification naming the **PARENT** session | Medium — depends on `SubagentEntry.parentSessionId` being populated (the only parent source); labels "A session" if it is not |
| 12 | Stall | **UNVERIFIED-here** | With exactly one Session live: `pkill -f -- --worker` → the stalled banner appears and NO "finished" notification fires (the crash resolves the turn with `Cancelled` BEFORE `session-stalled` lands) | **HIGH** — the one known false-positive generator; the guard is a race, so it is worth a few repeats |
| 13 | Off | **UNVERIFIED-here** | Disable "Notify when the app is waiting on you", repeat row 1 → nothing | Low — R1; rule-level tested |
| 14 | A spent question must not mute another Session | **UNVERIFIED-here** | Let an `ask` in Session A alert, then LEAVE IT OPEN; in Session B let a run finish and focus out past the delay → B's "finished" notification DOES arrive | **HIGHEST for the muting fix** — B's alert used to be vetoed by A's spent head, and because a `settled` pulse exists on exactly one snapshot and is never re-delivered, losing it was permanent. The unit test proves the rule; only a human sees the real single-snapshot store write ordering end to end |

**The four rows to do first, if time is short:** 6 (Minimise), 4 (Focus
suppression), 12 (Stall), 14 (the mute). Row 6 can invalidate the architecture,
row 4 is the only path that exercises the real focus probe, row 12 is the only
known way the feature lies to the user, and row 14 is the way it stays silent
about a pause it should announce.

### Platform rows this Linux box cannot answer

| Platform | Status | Notes |
|---|---|---|
| Windows — **installed** build | **UNVERIFIED-here** (no Windows machine) | The plugin documents that a **dev/uninstalled** build shows a mislabelled toast (no AUMID / not registered), so row 1 MUST be repeated on a bundled+installed build before claiming the feature works on Windows; a dev-build pass here proves the countdown, not the label. |
| Windows — dev build | **UNVERIFIED-here** | Expect a toast with the wrong app attribution; do not treat that as a feature bug. |
| macOS | **UNVERIFIED-here** (no macOS machine) | macOS suppresses notifications from the frontmost app at the OS level, which already matches the focus gate — so row 4's expected outcome is doubly true there. Worth confirming that a *minimised* macOS window still delivers (row 6), and that the `tauri-plugin-notification` bundle id behaves under an ad-hoc dev signature. |
| Linux (this box) | Gates green; **matrix unverified** | A server IS registered, so a delivered toast would be visible here and the "no server → silent no-op" degradation is **not** what this machine would demonstrate. The silent-degradation path is **UNVERIFIED-here** — it needs a session with no server (e.g. a bare X/Wayland session without a notification host) to confirm the app neither errors nor logs. What the delivery line logs there is now the error's `Display` (`attention: alert delivery FAILED: …`), because Linux no longer hands the alert to the plugin; see the Linux subsection below. |

### Linux banner delivery was broken all along: GNOME destroyed the alert 23 ms after accepting it

Measured 2026-10-12 on this box (GNOME Shell **50.5**, `FdoNotificationDaemon` from
`resource:///org/gnome/shell/ui/messageList.js` +
`/usr/share/gnome-shell/js/ui/messageTray.js`), fixed in the commit that adds
`src-tauri/src/attention/delivery.rs`. **Every "the banner arrives" claim in the
rows above was made about code that could not have worked on this desktop** — the
countdown, the focus gate and the renderer rules are all still as recorded, but on
GNOME the alert they produced was torn down almost immediately.

**The symptom.** `Notify` was answered normally with an id, the banner painted, and
~23 ms later `NotificationClosed(id, 2)` followed — reason 2 = `DISMISSED`, i.e.
*neither the user nor a timeout* dismissed it.

**The cause, in two quoted lines.** The plugin threw the notification's handle away
(`tauri-plugin-notification-2.6.0/src/desktop.rs`):

```rust
let _ = notification.show();   // notify_rust's Result<NotificationHandle> dropped
```

`notify_rust`'s `NotificationHandle` is what keeps the D-Bus connection that sent the
message alive, and `zbus::Connection` closes its socket when the last clone goes. So
the sender's bus name vanished right after the reply — and GNOME's FDO daemon
name-watches every sender (`shell_notificationDaemon.js`, `_onNameVanished`):

```js
_onNameVanished(connection, name) {
    const source = this._notifyDaemons.get(name)?.source;
    if (!source) return;
    if (this._senderForNotification.has(name))
        source.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
}
```

Destroying the *source* destroys its notifications, hence reason `DISMISSED` and no
timeout involved. (`if (this.app)` guards it: the rule only bites senders GNOME can
resolve to an application, which is why `notify-send` alerts survive a dead sender
and this bug looked like a GNOME quirk rather than a bug of ours.)

**The fix.** On the desktops where an alert is a session-bus message, we now send it
ourselves through the same `notify_rust` the plugin uses, with the same fields
(`summary` = title, `body`, `auto_icon`, no hints), and keep the returned
`NotificationHandle` in a process-lifetime bounded store (`Retained`, cap
`RETAINED_ALERT_CAP` = 8, oldest released first). macOS and Windows keep going
through the plugin unchanged. The `Delivery` seam's shape did not move.

`notify-rust = "4.18"` was added to our `Cargo.toml` under the **same** target gate
the plugin uses, and no features were enabled or disabled: `cargo tree -i
notify-rust` shows one version (4.18.2) and one identical feature set for both
reverse-dependents, and the `Cargo.lock` diff is a single added line — the crate name
in our dependency list. No new version entered the graph.

**The log line is now honest.** The old one said "alert delivered (the notification
call returned Ok)" on a path whose `Ok` could not mean that. Now:

- session bus, accepted: `attention: alert ACCEPTED by the notification server (id=256)`
- session bus, accepted while releasing the oldest: `attention: alert ACCEPTED by the notification server (id=15); the retain cap of 8 released the oldest handle (id=7), so that alert's source may go with it` — because eviction *is* the bug's mechanism, so an eviction has to be visible in the same breath as the success
- session bus, refused: `attention: alert delivery FAILED: <the error's Display>`
- plugin (macOS/Windows): `attention: alert handed to the notification plugin, which reports nothing back (no id, no proof it reached a server)` — it gets no `Ok` to report, so it claims no outcome

**Gates at this commit** (`src-tauri/`, pinned toolchain `rustc 1.99.0`):

| Gate | Command | Result |
|---|---|---|
| Formatting | `cargo fmt --all -- --check` | **PASS** — exit 0, zero diffs |
| Rust tests | `cargo test` | **PASS** — **918 passed / 0 failed / 2 ignored** across 23 targets. The baseline at `e3701c7` (this branch's HEAD before the fix) was **912 / 0 / 0 across 22**; the delta is +7 delivery unit tests, −1 delivery-line test that moved here from `lib.rs`, and a new target holding the 2 `#[ignore]`d manual checks |
| Rust lint | `cargo clippy --all-targets -- -D warnings` | **PASS** — exit 0, **0** warning lines; re-checked from source (`touch` of every touched file) in 3.7 s, not from cache |

The frontend gates were not re-run: this commit touches no file under `src/`, and
`pnpm test` / `pnpm build` measure the renderer, which is byte-identical here.

**The evidence is a bus capture, not an assertion.** Two findings make the
`NotificationClosed` signal unobservable from inside the test binary, and both are
worth keeping (they are also why no `zbus` dev-dependency was added):

1. The daemon emits `NotificationClosed` **at a destination**, not to everyone
   (measured: `Sender=:1.17 Destination=:1.31` — the Shell, then its own
   FDO-forwarding daemon), and in every close this box produced the sending
   connection had already died, which is what caused the close. So whether our own
   connection would have been addressed the signal is not answerable from here, and
   an in-process `zbus` subscription was not a witness worth adding a dependency
   for; `busctl monitor` sees the signal because it eavesdrops. The capture recipe
   is in the manual test's doc comment instead.
2. The destroy is behind `if (this.app)`, so a sender that resolves to no
   application is exempt — which a test binary is, because its bus `app_name` is its
   own mangled executable name and matches no desktop file.

So the manual checks are `#[ignore]`d and human-read (`cargo test --test
attention_alert_survives -- --ignored --nocapture`), and the proof was captured
around them with `busctl --user monitor org.freedesktop.Notifications`:

| Send | shape | `Notify` | `NotificationClosed` | gap |
|---|---|---|---|---|
| `notify-send --app-name=archimedes` (control: a sender that resolves to an app and whose connection dies with it) | drop | 16:10:00.182900 | `(258, 2)` 16:10:00.205196 | **22.3 ms** |
| our binary, `appname("archimedes")`, handle dropped (the plugin's shape) | drop | 16:12:34.529976 | `(259, 2)` 16:12:34.552683 | **22.7 ms** |
| our binary, `appname("archimedes")`, handle **retained** (our shape) | keep | 16:14:37.496874 | `(263, 2)` 16:14:40.524102 | **3.03 s — and that is the test process exiting**, not a destruction |
| same, watched only while the process was alive (8 s window, process lived 12 s) | keep | 16:12:49.971763 | **none** | alert alive for the whole window |
| production `session_bus_delivery` (the seam), id reported by the server | keep | 16:09:30.258829 | **none** in the window | exempt from the rule (no app resolved), so it proves acceptance + retention, not survival |

The dropped/retained pair is reproducible by a person in one command and is what
closes this finding: `cargo test --test attention_alert_survives watch_the --
--ignored --nocapture` shows two alerts, the first destroyed on purpose and the
second not.

**What this does NOT close.** The installed app was never launched here (nor built
into an AppImage), so matrix rows 1 and 6 *on the installed bundle* stay
`UNVERIFIED-here`: what is verified is that a sender resolving to
`~/.local/share/applications/archimedes.desktop` keeps its alert on screen for as long
as it holds the connection, on this GNOME 50.5. That the app's own `app_name` resolves
the same way is inference from `StartupWMClass=archimedes` plus the executable name
`archimedes`, not an observation of the app on the bus. And the eviction edge (the 9th
alert releasing the 1st) is pinned by unit test only — no live session was driven past
the cap.

### Fold-before-delete notes (this plan file is deleted on ship)

Durable facts from this run that belong in ADR 0038/0039 (or `docs/features/`)
when the plan goes:

1. Detect a notification server with `busctl --user status
   org.freedesktop.Notifications`, not `ps -e | grep -i notify` — the latter is
   a false negative under GNOME, whose server is `gjs …/org.gnome.Shell.Notifications`.
2. The Rust gates must run from `src-tauri/` (the pin lives there; the repo root
   resolves an older rustc than CI uses).
3. The `tests/ipc.rs` deviation stands as an exception to Task 2's "no command
   tests there" — keep the comment in the test that explains why `disarm` and
   never `arm`, and that the harness has its own handler list.
4. Windows: the toast is only trustworthy from an installed bundle (ADR 0038's
   platform section should say so, since the manual row cannot be closed on Linux).
5. Rows 4, 6, 12 and 14 are the risky ones; row 6 is the one whose failure mode
   would force the `settled` trigger from pulse-based to evidence-based, and row
   14 is the one that shows the mute (a spent-but-still-open question in one
   Session swallowing a later `finished` alert in another).
6. Design rule 5's **precedence ladder** (design rule 5 above, and R5's four
   tested clauses) is durable and must land in an ADR when this plan goes —
   above all that gate-over-gate within a Session is deliberately OLDEST-wins, and why. The
   blanket "last pause wins / the alert names the most recent pause" this plan
   first wrote is false for two open questions and should not be re-derived
   from memory.
7. **On Linux the notification handle is load-bearing.** `tauri-plugin-notification`
   drops it (`let _ = notification.show();`), the D-Bus connection closes with it,
   and GNOME's FDO daemon destroys the alert when the sender's bus name vanishes
   (`if (this.app) this.destroy()`, reason `DISMISSED`). ADR 0038's platform section
   must carry: retain the handle for the process lifetime (bounded, oldest-first),
   that the destroy is behind `if (this.app)` and so applies only to senders
   resolving to a `.desktop` file, that `NotificationClosed` is emitted at a
   destination rather than broadcast, and that upstream was not reported (open).
   Until that report exists, "a Linux alert vanished seconds after appearing" is a
   symptom of the sender's connection closing, and a D-Bus capture is the only
   witness.
