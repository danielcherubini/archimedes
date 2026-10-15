---
status: committed
done-when: a Subagent streaming or tool-calling past the old 30-minute bound completes normally; the Rust test `a_streaming_subagent_outlives_the_dead_bound` exists and passes; a silent child with nothing in flight is still reaped at the bound; `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`, `pnpm test` and `pnpm build` are all green.
---

# Subagent liveness plan — no timeout on an Active Subagent

**Goal:** stop reaping a **Subagent session** that is actively working, and keep the 30-minute bound only for one that is genuinely wedged.
**Architecture:** the Supervisor's subagent drive task currently races a single never-rearmed `sleep` against `agent_settled`, which bounds the *duration of the delegation*. Replace it with a self-rearming silence clock armed on a liveness signal derived from the existing `tool_execution_start` / `tool_execution_end` frames, so a child producing frames or holding an outstanding `tool_call_id` is never cut. Carry the child's captured output and real usage on every failure path, and close a torn-down child's own gates under the child id.
**Tech stack:** Rust (Tauri 2 backend, `src-tauri/`), tokio (`watch`, `select!`, `sleep_until`), React 19 + TypeScript + zustand (`src/`).

**ADR:** `docs/decisions/0055-subagent-liveness-is-tool-boundaries-not-duration.md` — read it before Task 1. It records why the tool boundary is the liveness signal and why a heartbeat was rejected.
**Glossary:** `CONTEXT.md` defines **Active Subagent**, **Dead Subagent**, **Dead bound**, **Gate**. Use those terms in code comments.

Citations below name **symbols, not line numbers** — line numbers re-drift on every commit.

---

## Ground rules for every task

- Work from `src-tauri/` for Rust commands (`cargo test`, `cargo clippy --all-targets`, `cargo fmt`) and the repo root for frontend commands (`pnpm test`, `pnpm build`). `AGENTS.md` is authoritative.
- TDD: write the failing test, run it, confirm it fails for the expected reason, then implement.
- `cargo clippy --all-targets` must be **0 warnings** including `#[cfg(test)]` code — most warnings here will be unused imports after a signature change.
- Do not float the Rust toolchain (`src-tauri/rust-toolchain.toml` is pinned).
- Each task is independently commitable and leaves the full suite green.

---

### Task 1: The liveness signal — `SubagentLiveness` on the drive

**Context:**
`drive_subagent` (in `src-tauri/src/agent/worker/manager.rs`) races `agent_settled` against a single `tokio::time::sleep(settle_timeout)` that is never rearmed — so a child streaming tokens for 30 minutes is reaped mid-work. The fix is a liveness signal the drive can watch. This task ONLY adds the signal and its bookkeeping; the race itself is untouched and behaviour is unchanged. Task 3 consumes it.

Splitting it this way means Task 1 can be verified by unit tests over the pump with no timing at all, instead of entangling the state plumbing with the timer rewrite.

The signal needs two facts: *has the child produced anything lately* and *is it legitimately blocked*. The second is answered by outstanding `tool_call_id`s — `tool_execution_start` and `tool_execution_end` are real `RpcEvent`s (`src-tauri/src/agent/events.rs`) that already arrive at the subagent pump, and they cover every legitimately-silent state: inside any tool, parked on any gate (because `loop.rs` emits `tool_execution_start` at ANNOUNCE time, during the provider stream, while `gate_tool` blocks later inside the same tool call), and awaiting a nested Subagent (which holds `tool_execution_start { tool_name: "subagent" }` open).

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs` (the `SubagentDrive` struct; `start_pump`; `feed_capture`; `dispatch_subagent`'s drive insertion)
- Test: in-file `mod tests` in `src-tauri/src/agent/worker/manager.rs`

**What to implement:**

Add the signal type next to `SubagentCapture`:

```rust
/// The subagent's liveness signal (ADR 0055): `seq` bumps on EVERY frame the
/// pump sees for this child, and `in_flight` holds the `tool_call_id`s that
/// have been ANNOUNCED (`tool_execution_start`) and not yet closed
/// (`tool_execution_end`) — NOT "currently executing" (a batch announces every
/// call before running any of them, so the set is deliberately generous).
/// The skew is one-directional: it can only keep a child alive longer, never
/// cut it sooner.
///
/// A `HashSet` and NOT a counter, deliberately: ADR 0048 has the cancel and
/// turn-abandoned paths emit `tool_execution_end` for calls that were announced
/// but never dispatched, so an `end` without a `start` is LEGAL. A counter would
/// go negative and un-block a child that is still working; a set's removal is
/// idempotent.
pub struct SubagentLiveness {
    pub seq: u64,
    pub in_flight: std::collections::HashSet<String>,
}
```

Task 1 adds ONLY these two fields. Task 4 adds a third, `open_gates` — deliberately NOT now: a field nothing reads until Task 4 trips `dead_code`, and `cargo clippy --all-targets` must be warning-free at every task boundary.

Add a field to `SubagentDrive`:

```rust
liveness_tx: watch::Sender<SubagentLiveness>,
```

In `dispatch_subagent`, where `settle_tx`/`cancel_tx` are created and the `SubagentDrive` is inserted into `state.drives`, create `let (liveness_tx, liveness_rx) = watch::channel(SubagentLiveness { seq: 0, in_flight: Default::default(), open_gates: Default::default() });` and store the sender. **Also thread `liveness_rx` into `drive_subagent`'s argument list** — Task 2 consumes it, so if an unused-parameter warning appears in Task 1, name it `_liveness_rx` there and drop the underscore in Task 2; do NOT delete the parameter.

Extend `feed_capture`'s closure contract. It currently takes `impl Fn(&SubagentCapture) -> bool` where `true` flips the settle watch, and it has **exactly two call sites** — both in `start_pump`'s subagent arms — so the change is contained. It must also reach the liveness state. `SubagentCapture::observe_sink_frame` and `observe_event` both take `&self` (they mutate through internal `StdMutex`es), so keep the capture borrow immutable and add the liveness borrow:

```rust
fn feed_capture(
    state: &ManagerState,
    session_id: &str,
    f: impl FnOnce(&SubagentCapture, &mut SubagentLiveness) -> bool,
)
```

Inside, `drives.get_mut(session_id)` yields `&mut SubagentDrive`, and the two field borrows (`&drive.capture` — via the `Arc`'s `Deref` — and `&mut drive.liveness_tx`) are disjoint fields of the same struct, which Rust permits simultaneously. Do NOT try to pass `&mut SubagentCapture`: it is unnecessary (the observers take `&self`) and would force needless churn on the `Arc`. If the borrow checker objects to passing `&mut drive.liveness_tx` alongside `&drive.capture`, take a local `let SubagentDrive { capture, liveness_tx, settle_tx, .. } = drive;` destructure — disjoint-field borrowing made explicit — rather than cloning anything. After `f`, the settle watch flips on `true` exactly as before.

In `start_pump`, in the two `if is_subagent` arms:
- `WorkerInboundEvent::SinkFrame { .. }` — call `feed_capture` with a closure that bumps `liveness.seq += 1` and feeds `observe_sink_frame` as today.
- `WorkerInboundEvent::Event(e)` — bump `liveness.seq += 1`, maintain `in_flight`, then feed `observe_event` and return whether it is `agent_settled` (unchanged settle behaviour). Maintain the set BEFORE feeding, in this order:
  - `RpcEvent::tool_execution_start { tool_call_id, .. }` → `in_flight.insert(tool_call_id.clone())`
  - `RpcEvent::tool_execution_end { tool_call_id, .. }` → `in_flight.remove(&tool_call_id)`
  - any other event → leave the set alone.

  Both arms must bump `seq` so a child that only emits `SinkFrame`s (the `session-update` text stream) still registers as live.

Everything else in the pump (the `(a)` `on_event` router delivery, `(b)` `SubagentDispatch`, `(b2)` `SubagentCancel`, `(c)` `Exited`) stays exactly as it is.

**What NOT to change:** the `settle_timeout` field, `DEFAULT_SUBAGENT_SETTLE_TIMEOUT`, `drive_subagent`'s `select!`, `SubagentOutcome`, and anything in `src/agent/subagent.rs`. Renames land in Task 5; the outcome in Task 4. This task must be a pure no-op behaviourally.

**Steps:**
- [ ] In `src-tauri/src/agent/worker/manager.rs`'s `mod tests`, add `the_liveness_set_tracks_announced_and_closed_tool_calls`: drive the pump (or call `feed_capture` directly against a seeded `drives` entry, matching how the existing `SubagentCapture` tests reach it) with `tool_execution_start { tool_call_id: "t1" }` and assert `in_flight == {"t1"}`; then `tool_execution_end { tool_call_id: "t1" }` and assert it is empty; then, on a fresh drive, `tool_execution_end { tool_call_id: "ghost" }` alone and assert `in_flight` is still empty and `seq` still advanced (the ADR 0048 legality check — this is the set-vs-counter guard).
- [ ] Add `every_frame_bumps_the_liveness_seq`: a `SinkFrame` (which is NOT an `RpcEvent`) bumps `seq` — this pins that the text stream alone counts as liveness.
- [ ] Run `cargo test the_liveness_set_tracks the_liveness_seq` from `src-tauri/`
  - Did it fail to compile (no `SubagentLiveness`)? Expected. If it passed, the tests are not reaching the real state — investigate.
- [ ] Implement the type, the field, the `feed_capture` signature change and the two pump arms.
- [ ] Run `cargo test` (whole suite) — every pre-existing test must still pass; update call sites of `feed_capture` for the new closure signature (there are few; the capture tests are the main ones).
- [ ] Run `cargo clippy --all-targets` — fix every warning (expect unused imports).
- [ ] Run `cargo fmt`
- [ ] Commit: `feat(subagent): track per-child liveness (frames + outstanding tool calls)`

**Acceptance criteria:**
- [ ] `SubagentLiveness` exists with `seq` + `in_flight`, and its doc comment states both the "announced not executing" scope and the ADR 0048 set-not-counter reason.
- [ ] No behavioural change: `DEFAULT_SUBAGENT_SETTLE_TIMEOUT` still reaps a slow child in the existing `__slow__` tests, unchanged.
- [ ] An `end` without a `start` leaves `in_flight` empty and does not panic or underflow.

---

### Task 2: The drive's race becomes a self-rearming silence clock

**Context:**
This is the fix for the reported bug. Task 1's signal exists; now the drive must act on it. Today `drive_subagent`'s `select!` has one `sleep(settle_timeout)` arm that never rearms, so a child that streams for 30 minutes is reaped *because it is working*. After this task, the clock is rearmed on every frame and disabled outright while any tool call is outstanding — so only a child that is silent AND unblocked can ever be reaped.

A design note the implementer must not lose: **the `in-flight` case is handled by not arming the clock at all, not by using a longer bound.** A child parked on a gate is silent by construction and must never settle on a clock — the same rule the main session's `ask` already holds (see `ask_flow`'s doc and the pinned test `an_unanswered_question_never_settles_on_a_clock`).

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs` (`drive_subagent`; keep the existing name `settle_timeout` on the parameter/field for now — renamed in Task 5)
- Modify: `src/bin/fake_worker.rs` (a new `__long_stream__` scenario + its module doc)
- Test: in-file `mod tests` in `manager.rs`; `src-tauri/tests/harness_dispatch_native.rs` for the end-to-end shape

**What to implement:**

Replace the `sleep(settle_timeout)` arm in `drive_subagent`'s `select!` with a loop that recomputes the deadline whenever liveness changes. The borrow conflict below is real and expected — solve it as written.

```rust
// ADR 0055: the bound is a SILENCE bound, never a duration bound. It is
// rearmed on every frame and NOT armed at all while a tool call is
// outstanding — a child inside a tool, parked on a gate, or awaiting its own
// nested Subagent is Active and has no timeout of any kind.
let mut deadline = std::time::Instant::now() + settle_timeout;
let outcome = loop {
    // EVERY pass of this loop was entered because something changed (the
    // first pass, or the `changed()` arm) — so the deadline is recomputed
    // UNCONDITIONALLY here. That IS the activity reset: a frame bumps `seq`,
    // `changed()` fires, we come round, the clock restarts. Do NOT guard this
    // recompute on `in_flight` — a guarded recompute leaves the deadline at
    // its ORIGINAL arm time for an unblocked quiet child, which silently
    // restores the absolute wall-clock bound this task removes.
    deadline = std::time::Instant::now() + settle_timeout;
    let in_flight = {
        // The borrow is scoped so the `RefMut` CANNOT be held across the
        // `select!` — held across an await point it makes the future
        // non-`Send` and the spawn fails to compile.
        liveness_rx.borrow_and_update().in_flight.iter().next().is_some()
    };
    let mut sleep = Box::pin(tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)));
    tokio::select! {
        _ = settle_rx.wait_for(|v| *v) => break Race::Settled,
        code = handle.exited() => break Race::Exited(code),
        _ = cancel_rx.changed() => break Race::Cancelled,
        _ = liveness_rx.changed() => continue,
        // The guard DISABLES the arm entirely while a tool call is
        // outstanding — a child inside a tool, parked on a gate, or awaiting
        // its own nested Subagent is Active and has NO timeout. In that state
        // the bound is not "longer"; it does not run.
        _ = &mut sleep, if !in_flight => break Race::TimedOut,
    }
};
```

Notes the implementer must honour:
- `liveness_rx.changed()` must be the arm that `continue`s, and the guard `if !in_flight` must be on the sleep arm only.
- The `RefMut` from `borrow_and_update()` **must not be held across the `select!`** — scope it in a block. If the compiler complains the future is not `Send`, this is why.
- Keep the existing `Race` enum variant names in this task (`Race::TimedOut`) — Task 5 renames. Do not rename `settle_timeout`/`DEFAULT_SUBAGENT_SETTLE_TIMEOUT` here either.
- **`borrow_and_update()` is required here, not `borrow()`.** `changed()` is ready when a value is sent after the receiver last saw one; `borrow_and_update()` marks the current value seen at borrow time, so a frame arriving between the borrow and the `select!` still leaves `changed()` ready — no missed wakeup. A plain `borrow()` would leave the value unseen, making `changed()` return immediately every pass: a hot spin that starves the other arms.
- Each pass costs one `sleep_until` re-arm, so a child streaming ~30 frames/sec re-arms ~30 times/sec. Negligible — do NOT "optimise" it by skipping passes, because every pass IS the activity reset.
- A trailing `, if !in_flight` on a `select!` arm is a guard that disables that arm for the pass. If the compiler rejects the guard's position, fall back to `if in_flight { futures::future::pending().await } else { sleep.await }` — but try the guard first; it is valid `tokio::select!` syntax. `Box::pin` on the sleep keeps the future's size stable across the loop.

Add to `src/bin/fake_worker.rs`, in the `Inbound::Prompt` match, a scenario that streams for well over an injected short bound and then settles — the fixture must emit several `SinkFrame` `session-update` `agent_message_chunk` frames with small sleeps between them, then `agent_settled`:

```rust
// The long stream (ADR 0055 — a child that keeps producing frames for far
// longer than the injected bound must COMPLETE, not be reaped; the
// `a_streaming_subagent_outlives_the_dead_bound` regression test).
"__long_stream__" => { /* N chunks, ~50 ms apart, then emit_canned_turn */ }
```

Also add `__in_tool__`: emit `tool_execution_start`, then sleep past any plausible injected bound WITHOUT closing it, then `tool_execution_end` + `agent_settled` — pinning that an in-tool child is not reaped. Update `fake_worker.rs`'s module doc list of scenarios with both.

Write the regression test FIRST and watch it fail against the current single-`sleep` drive:

- `a_streaming_subagent_outlives_the_dead_bound` — a `WorkerManager` with `with_settle_timeout(Duration::from_millis(200))` (the existing test seam), dispatching the `__long_stream__` task, asserting `SubagentOutcome::Completed`. **This test fails before the `select!` change and passes after** — that is the whole point of the task; do not write it after the implementation.
- `a_child_inside_a_tool_call_is_never_reaped` — `__in_tool__`, same short bound, assert `Completed`.
- `a_child_awaiting_its_own_subagent_is_never_reaped` — the nested case. Reuse the existing `__subagent__` / `__slow_subagent__` fixture machinery: a parent whose `tool_execution_start { tool_name: "subagent" }` stays open while its child streams. If the fixture cannot express this without new code, add the minimal scenario to `fake_worker.rs` and say so in the commit message.
- `a_silent_child_with_nothing_in_flight_hits_the_dead_bound` — the existing `__slow__` scenario with a short injected bound still yields the timeout outcome (the surviving safety net). Adapt the existing `a_slow_subagent_hits_the_settle_timeout_outcome` rather than duplicating it.

`tokio::test(start_paused = true)` is used elsewhere in this file for clock-controlled tests — prefer it where the fixture's sleeps are tokio sleeps; the `fake_worker` is a real process, so the tests that spawn it need real (short) durations instead. Keep both bounds small enough that the suite stays fast.

**What NOT to change:** `SubagentOutcome`, the `subagent-closed` payload, anything in `src/agent/harness/`, anything in `src/`. No renames.

**Steps:**
- [ ] Add `__long_stream__` and `__in_tool__` to `src/bin/fake_worker.rs` + its module doc.
- [ ] Write `a_streaming_subagent_outlives_the_dead_bound` in `manager.rs`'s tests.
- [ ] Run `cargo test a_streaming_subagent_outlives_the_dead_bound` from `src-tauri/`
  - Did it FAIL with a timeout outcome (`Failed { error: "timed out" }`) while the child was streaming? That is the reported bug reproduced. If it passed, the bound is not being injected correctly — fix the test before continuing.
- [ ] Replace the `select!` with the self-rearming loop as specified.
- [ ] Run `cargo test a_streaming_subagent_outlives` — passes now.
- [ ] Add the other three tests; run `cargo test` (whole suite). The pre-existing `__slow__` timeout tests must still pass — the safety net is intact.
- [ ] Run `cargo test --test harness_dispatch_native` (the integration suite that spawns the real fixture binary).
- [ ] Run `cargo clippy --all-targets` — 0 warnings.
- [ ] Run `cargo fmt`
- [ ] Commit: `fix(subagent): never reap a child that is producing or blocked (ADR 0055)`

**Acceptance criteria:**
- [ ] `a_streaming_subagent_outlives_the_dead_bound` exists, was observed failing before the implementation, and passes after.
- [ ] A child silent with nothing in flight IS still reaped at the bound.
- [ ] No test needed a longer bound to pass — i.e. the fix is the predicate, not a bigger number.

---

### Task 3: Salvage the partial work on every failure path

**Context:**
`SubagentOutcome::Failed` currently carries only `error: String`, so when a child is reaped (or crashes, or is cancelled) everything the `SubagentCapture` accumulated is discarded and the parent agent is handed the bare string `"timed out"`. Worse, `finish_subagent` builds `SubagentMetrics::default()` for every failed path, so 29 minutes of real tokens are reported as 0 — and the frontend's metrics line reads exactly that payload, since it is the sole channel by which a child's usage reaches the Client.

Decision already made, do not revisit: **a reaped child is never reported as `Completed`.** It was mid-turn and had not decided it was finished; presenting a truncated answer as a real reply is the worse failure. The status stays honest and the *text* carries the salvage.

**Files:**
- Modify: `src-tauri/src/agent/subagent.rs` (`SubagentOutcome::Failed`)
- Modify: `src-tauri/src/agent/worker/manager.rs` (`drive_subagent`'s three non-settle arms; `finish_subagent`'s `Failed` branch)
- Modify: `src-tauri/src/agent/harness/dispatch.rs` (`SubagentWait::Failed`; the `Failed` arm's `ToolResult` text)
- Modify: `src-tauri/src/agent/worker/dispatch.rs`, `src-tauri/src/agent/worker/core.rs` (the other `Failed` construction sites — mechanical field additions)
- Test: in-file tests in each; `src-tauri/tests/harness_dispatch_native.rs`

**What to implement:**

Extend the variant. `SubagentOutcome` has NO serde attribute, so it is **externally tagged** (`{"Failed":{"error":"…"}}`) and `Inbound::SubagentResult` is internally tagged by `type` with the payload nested inside — adding fields keeps the top-level shape, but **new fields are REQUIRED on decode unless defaulted**, and `subagent-result` is in `decode_inbound`'s explicit allow-list, so a mismatch is a hard `ProtoError::Json`, NOT the permissive `Unknown { raw }` fallback. Same-version builds are symmetric, but a stale Worker binary from a previous install would fail to report its result. Give every new field `#[serde(default)]`:

```rust
Failed {
    /// WHY it failed, as DATA not prose — the `subagent-closed` payload's
    /// `reason` field and the card's short line both read this, and neither
    /// may string-match `error` to find out what happened. Set from the
    /// `Race` variant in `drive_subagent`, never inferred from a message.
    #[serde(default)]
    reason: SubagentFailureReason,
    error: String,
    /// Whatever the child had produced before it died (the
    /// `SubagentCapture`'s text) — `""` when there was nothing. Never a
    /// substitute for a `Completed`: the child never finished deciding.
    #[serde(default)]
    output: String,
    /// The REAL accumulated usage + wall clock (the failed path used to
    /// report `SubagentMetrics::default()`, i.e. 0 tokens for work that
    /// really happened and really cost money).
    #[serde(default)]
    metrics: SubagentMetrics,
},
```

`reason` therefore needs `Default` — derive `#[derive(Default)]` with `#[default]` on the `Other` variant.

With the reason as a sibling enum in `subagent.rs`:

```rust
/// Why a **Subagent session** ended without settling (ADR 0055).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentFailureReason {
    /// The **Dead bound** won — silent with nothing in flight.
    Unresponsive,
    /// The **Worker process** exited unexpectedly.
    Crashed,
    /// A Stop on the parent (or an app-exit teardown).
    Cancelled,
    /// Anything else (a preflight failure — the child never started).
    #[default]
    Other,
}
```

**The nested enum needs its OWN `rename_all` — it does NOT inherit one.** `Inbound::SubagentResult`'s `rename_all = "camelCase"` renames only that variant's own payload fields (`id`, `outcome`); `SubagentOutcome` has none at all. Without an explicit attribute, unit variants serialise PascalCase (`"Unresponsive"`). Pick `snake_case` (matching `SubagentMetrics`, whose fields are already snake_case on this wire: `input_tokens`, `output_tokens`, `duration_ms`) and make the TS union match those exact literals in Task 4.

Do NOT "fix" the snake_case-on-the-Worker-wire vs camelCase-in-the-frontend asymmetry: `metrics_json()` builds the `subagent-closed` Tauri payload with explicit camelCase keys, so the two are different contracts on purpose.


In `drive_subagent`, all three non-`Settled` arms (`Race::TimedOut`, `Race::Cancelled`, `Race::Exited`) must read `capture.usage()` and `capture.captured_text()` and the same `start.elapsed()` wall clock the `Completed` arm already uses, and each sets its own `reason` straight from the `Race` variant: `Unresponsive` / `Cancelled` / `Crashed`. That mapping is the whole point of carrying `reason` — nothing downstream infers it from prose. There are several `Failed { .. }` sites in `manager.rs` that fire *before* the drive starts (the preflight failures — "failed to start", "send the subagent task") where there is genuinely nothing to salvage: pass `reason: Other`, `output: String::new()` and `SubagentMetrics::default()` there, and say so with a one-line comment so a reader knows the emptiness is deliberate.

In `finish_subagent`'s `Failed` branch, stop building `SubagentMetrics::default()`; use the metrics the outcome now carries. The `subagent-closed` payload gains only the `reason` field Task 4 surfaces — `output` deliberately does NOT ride to the UI (the transcript is already persisted as a hidden ephemeral row, so the panel can read it; duplicating a 29-minute blob into a lifecycle event is waste).

In `src-tauri/src/agent/harness/dispatch.rs`, `SubagentWait::Failed` gains the same three fields, and the `ToolResult` text becomes the salvage message the parent model reads. Compose it HERE (this is the one place that builds a parent-facing tool result) as:

```
subagent failed: {error}
It may have been making progress; its partial output follows. Its full
transcript is still open in the Subagents panel.
─── partial output ───
{output}
```

**Scope correction on the cancel path — read this before writing the test.** Salvage on cancel exists at ONE of the two layers:
- `drive_subagent`'s `Race::Cancelled` arm DOES produce a `SubagentOutcome::Failed { reason: Cancelled, output, metrics }` — this is what `finish_subagent` emits as `subagent-closed` and delivers to the requesting Worker. Task it here.
- `dispatch_subagent`'s `SubagentWait::Cancelled` has **no outcome in scope at all** and CANNOT carry salvage. Its two arms are `Err(_)` (the sender was dropped — a value never existed) and `turn.cancelled()` (which wins the `select!` race and drops `dispatch_rx` unread, discarding the `Failed` the drive sends). Leave `SubagentWait::Cancelled` emitting its current bare `"cancelled"` text. It is correct: the parent's own turn is being abandoned, so nobody is reading a tool result.

So "salvage on all three failure paths" means: the **UI/outcome** path carries output + metrics for dead / crashed / cancelled; the **parent's tool result** carries it for dead / crashed only. Do not invent a salvage string for `SubagentWait::Cancelled` and do not restructure its `select!` to chase one.

When `output` is empty, omit the banner and the partial-output section entirely — emit only `subagent failed: {error}` so a child that died before producing anything does not get a misleading "partial output follows" line. Pin that branch with a test.

Update `src/lib/tauri.ts`'s `SubagentMetrics` doc comment: its paragraph currently states that a FAILED child carries `SubagentMetrics::default()` "whose token fields ARE 0". That becomes false — rewrite it to say the failed path carries the accumulated usage.

**What NOT to change:** the `Completed` variant and its arm's `Ok(SubagentOutcome::Completed { output, .. })` pattern (it already discards `metrics` — that is existing behaviour and out of scope here), `SubagentMetrics`'s own fields, `cost` (still `0.0` — nothing prices a child's usage), the `subagent-closed` payload (Task 4 adds `reason` there and renders it), and any frontend file — this task is Rust + one Rust-facing doc comment.

**Steps:**
- [ ] Write `every_failure_path_carries_the_partial_output_and_real_usage` in `manager.rs`'s tests — all three cases at the DRIVE/`SubagentOutcome` layer (never via `SubagentWait`, which cannot carry salvage on cancel): the timeout path (`__slow__` + short bound) asserting `output` non-empty and `metrics.input_tokens > 0` / `output_tokens > 0`; a crash case (`__crash__`) — the drive holds its own `Arc<SubagentCapture>` clone, so the capture is readable even though the pump drops the `drives` entry at teardown; and a cancel case using the existing cancel fixture.
- [ ] Write `a_failed_dispatch_with_no_output_omits_the_partial_output_banner` in `src-tauri/src/agent/harness/dispatch.rs`'s tests (the empty-`output` branch).
- [ ] Run `cargo test every_failure_path_carries` from `src-tauri/` — expect a compile failure (the fields don't exist).
- [ ] Add the fields; fix every construction site the compiler names (`grep -rn "SubagentOutcome::Failed" src/ tests/` finds them: `harness/dispatch.rs`, `harness/loop.rs`, `worker/dispatch.rs`, `worker/core.rs`, `worker/manager.rs`, `worker/protocol.rs`, `subagent.rs`).
- [ ] Update the `subagent-result` round-trip test in `worker/protocol.rs`.
- [ ] Compose the salvage `ToolResult` in `harness/dispatch.rs`.
- [ ] Update `src/lib/tauri.ts`'s `SubagentMetrics` doc comment (docs only — no type change, so `pnpm test` should be unaffected).
- [ ] Run `cargo test` — all green, including the existing asserts on `error` strings.
- [ ] Run `pnpm test` (the doc-comment change is inert, but the assertion is cheap).
- [ ] Run `cargo clippy --all-targets`; run `cargo fmt`
- [ ] Commit: `feat(subagent): carry partial output and real usage on every failure path`

**Acceptance criteria:**
- [ ] No `SubagentMetrics::default()` remains on any path that had a real child turn behind it.
- [ ] A reaped child's parent receives the captured text plus an explanation, not the bare string.
- [ ] `status: "failed"` is still what a reaped child settles as — never `completed`.
- [ ] The `subagent-result` IPC frame round-trips with the new fields.

---

### Task 4: A torn-down child closes its own gates (+ the short reason line)

**Context:**
When a Subagent dies with an `ask` or Permission gate open, no close frame reaches the Client and the card stays on screen forever. The reason is a three-link chain, all verified: (1) `router.rs`'s `track_modal(session_id, &id)` records a child's modal under the DELIVERY id — which for a child is the PARENT — even though the payload itself carries the child's own `sessionId`; (2) `route_event`'s `Exited` arm is gated `if !is_subagent`, so a child's exit never reaches `on_session_exited_expected` → `cleanup_pending_modals`; (3) even if reached, `cleanup_pending_modals` returns early because a child has no `live` entry (only `establish_worker_session` inserts one).

ADR 0040 recorded this hole and noted the 30-minute bound was what eventually resolved a parked child's DELEGATION. Task 2 removes that rescue, so the hole must be closed here.

Decision already made, do not revisit: **bypass the router's cleanup path, do not repair it.** Repairing `track_modal`/`live` would touch the main-session path children share. `finish_subagent` is the one unconditional teardown — every exit path reaches it: settle, dead, cancel, crash — and it already knows the child id. Emit from there.

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs` (the pump records `SubagentLiveness::open_gates`; `finish_subagent` drains and emits)
- Modify: `src-tauri/src/agent/session/router.rs` (a comment only, at `track_modal`, recording that it is unused for children)
- Modify: `src/lib/tauri.ts` (`SubagentClosedPayload` gains an optional `reason`), `src/store/subagents.ts` (`SubagentEntry` + `markClosed`), `src/App.tsx` (pass it through)
- Modify: `src/components/SubagentDelegatingCard.tsx` (the short reason line)
- Test: `manager.rs` in-file; `src/store/subagents.test.ts`; `src/components/SubagentDelegatingCard.test.tsx`

**What to implement:**

**Gate bookkeeping is derived, not newly tracked.** The pump ALREADY maintains `in_flight` (Task 1) — the set of announced-and-not-yet-closed `tool_call_id`s — and a gate is by construction held inside its own tool call, so **an unanswered gate IS an outstanding `tool_call_id`**. Add ONE field to `SubagentLiveness` (Task 1 deferred it deliberately):

```rust
/// The subset of `in_flight` whose tool opened a **gate** the user has not
/// answered (`PermissionRequest` / `InteractiveRequest` seen, tool not yet
/// closed). Drained at teardown to close the child's own cards. It lives on
/// `SubagentLiveness`, NOT as a second `SubagentDrive` field, so the pump
/// reaches it through the one `feed_capture` borrow — two overlapping sets on
/// the drive would drift.
pub open_gates: std::collections::HashSet<String>,
```

Adding it means updating the `SubagentLiveness { .. }` literal in `dispatch_subagent`'s `watch::channel(..)` — the compiler names it. Do NOT add a second set to `SubagentDrive`.

In `start_pump`'s subagent path:
- `WorkerInboundEvent::PermissionRequest { id, .. }` and `WorkerInboundEvent::InteractiveRequest { id, .. }` → insert `id` into `open_gates` through `feed_capture`, then deliver to the router **exactly as today** (these two arms currently reach the permissive `_` arm; add explicit handling that records first and does not alter delivery).
- on `tool_execution_end { tool_call_id, .. }` (already handled for Task 1) → also `open_gates.remove(&tool_call_id)`. A gate the user ANSWERED closes its tool call, which removes it here — so **no drain logic reading `payload["requestId"]` is needed**, and an answered gate is correctly absent at teardown.

**Verified facts the implementer must rely on, not re-derive:**
- A Permission gate's `request_id` IS the `tool_call_id` — `gate_tool` passes `&tc.id` to `native_permission_gate`. So one id space serves both the tool boundary and the card.
- An `ask` gate's interactive `requestId` is likewise the `toolCallId`; the sudo sub-prompts are the derived `"{request_id}:confirm"` / `":password"` forms. Record the BARE id, stripping any `:confirm` / `:password` suffix before inserting, so the set holds tool-call ids only. Note this in a comment.
- The child Worker emits **no** `interactive-request-close` for a gate it is merely parked on, and there is **no `permission-request-close` event anywhere in the codebase** — do not go looking for one to relay. `finish_subagent` is the emitter.

In `finish_subagent`, BEFORE the `subagent-closed` emission, get the drive via `state.drives.lock().get(child_id)` (valid here — the entry is removed only AFTER the emissions), clone `open_gates` out of `drive.liveness_tx.borrow()`, drop both guards, then emit one close per entry. Do not snapshot the set in `drive_subagent` instead: a gate can open between that snapshot and the teardown, and this is the path that must be exact.

```rust
// ADR 0055: the child's OWN id, not the parent's delivery id — the Client
// stored the gate under `payload.sessionId` (the child), so a close keyed
// to the parent is a no-op on the child's slice and the card lives forever.
sink.emit(
    "interactive-request-close",
    json!({ "sessionId": child_id, "requestId": request_id }),
);
```

**The frontend needs one real fix, not zero.** `interactive-request-close` is consumed by exactly one listener (`App.tsx`) which calls only `useInteractive.removeRequest`. **Permission prompts live in a DIFFERENT store** (`usePermissions.prompts`, removed only by `PermissionPrompt.tsx`'s local `removePrompt` on an answer), so emitting `interactive-request-close` for a Permission gate closes nothing today. That is not merely this feature's problem: `cleanup_pending_modals` ALREADY emits `interactive-request-close` for tracked Permission modals on the main-session path, and nothing acts on those either.

Fix it in the one listener — `App.tsx`'s `interactive-request-close` handler calls BOTH `useInteractive.removeRequest(payload.sessionId, payload.requestId)` and `usePermissions.removePrompt(payload.sessionId, payload.requestId)`. Both are filter/removal operations, so calling both for either kind is idempotent and harmless, and it repairs the pre-existing main-session gap as a side effect. Add a test that a single close event clears the entry from BOTH stores.

Rust, the reason code. `finish_subagent`'s `Failed` branch gains a `reason` field in the `subagent-closed` payload, read straight from the outcome's `reason: SubagentFailureReason` (added in Task 3) — serialise it with the same camelCase values the enum already produces (`"unresponsive"` / `"crashed"` / `"cancelled"` / `"other"`). There must be NO string-matching of `error` anywhere to work out what happened; if Task 3 is done, the data is already on the outcome.

Frontend. `SubagentClosedPayload` gains `reason?: "unresponsive" | "crashed" | "cancelled" | "other"` — exactly the values `SubagentFailureReason` serialises to (Task 3; all four variants are single words, so snake_case, camelCase and bare lowercase are identical here and the union matches regardless). Optional because a payload from an older backend omits it — with a doc comment saying why it exists (the card renders a short line and must not render the parent-facing salvage prose). Thread it: `App.tsx`'s `listenSubagentClosed` handler passes it to `markClosed`, which stores it on `SubagentEntry`. `markClosed` is called positionally today — add `reason` as a trailing optional parameter and update all call sites (`grep -rn "markClosed(" src/`).

`SubagentDelegatingCard.tsx`: the `row.error` arm currently renders `row.error` verbatim as the card's one-line summary. Change it to prefer a short label from `row.reason` (`"Unresponsive — no output for a long period"` / `"Crashed"` / `"Cancelled"` / `"Failed"`) and fall back to `row.error` when `reason` is absent, so a payload from an older backend still renders. Keep the existing glyph and colour classes.

**What NOT to change:** `router.rs`'s `track_modal` logic, `cleanup_pending_modals`, the `Exited` arm's `if !is_subagent` gate, `live`. Add only a comment at `track_modal` saying a child's gates are closed by `finish_subagent` and this path is not used for them. Do NOT touch `App.test.tsx`'s Settings-view known-hole pin — that is a different defect (a gate left *unrendered* while Settings is open), explicitly a non-goal.

**Steps:**
- [ ] Write `a_torn_down_child_closes_its_own_outstanding_gates` in `manager.rs`'s tests: dispatch the existing `__permission__` fixture WITHOUT answering the gate, then force the teardown (cancel or the dead bound); assert one `interactive-request-close` was emitted with `sessionId == child_id` and the open `requestId`. Add the negative case: a child that answered its gate emits NO close.
- [ ] Run `cargo test a_torn_down_child_closes` from `src-tauri/` — fails (no `open_gates` field, so no child-keyed close is emitted at teardown).
- [ ] Implement the Rust side.
- [ ] Run `cargo test`; then write the frontend tests: `subagents.test.ts` — `markClosed` stores `reason`; `SubagentDelegatingCard.test.tsx` — a `reason: "unresponsive"` entry renders the short label and does NOT render the salvage prose, and an entry with only `error` still renders `error` (the fallback).
- [ ] Run `pnpm test` from the repo root — green.
- [ ] Run `cargo clippy --all-targets`; `cargo fmt`; `pnpm build`
- [ ] Commit: `fix(subagent): close a torn-down child's own gates; short failure reason on the card`

**Acceptance criteria:**
- [ ] A child reaped or cancelled with an `ask`/Permission gate open leaves NO card behind.
- [ ] Every close frame is keyed to the CHILD id.
- [ ] The card shows a short reason; the long salvage text appears only in the parent's tool result.
- [ ] `router.rs`'s main-session cleanup is byte-for-byte unchanged.

---

### Task 5: Configuration + the renames

**Context:**
Two cleanup items that must come last, because they touch every file the earlier tasks touched. (1) The bound becomes a setting — safe now because no value can cut an Active child; the worst a wrong setting does is reap a genuinely wedged one sooner or later. (2) The old name caused this bug's misreading: "settle timeout" reads as an idle timer, and it was an absolute wall-clock cap on the whole delegation. Renaming is what stops the next reader re-introducing it.

**Files:**
- Modify: `src-tauri/src/config.rs` (`Settings`, a `default_*` fn, `Default for Settings`)
- Modify: `src-tauri/src/agent/worker/manager.rs` (the constant, the field, the builder, the `Race` variant; `WorkerManager::new` gains the bound or a setter)
- Modify: `src/lib.rs` (the `WorkerManager::new` call site in `setup_dirs_with_factory`)
- Modify: every `with_settle_timeout` call site (`src/agent/subagent.rs`, `src/agent/harness/dispatch.rs`, `src/agent/harness/loop.rs`, `src/agent/session/mod.rs`, `tests/harness_dispatch_native.rs`, `tests/harness_subagent_dispatch.rs`, `manager.rs`'s own tests)
- Modify: doc comments in `manager.rs`, `subagent.rs`, `src-tauri/src/agent/worker/mod.rs`, and the frontend `src/components/SubagentModals.tsx` paragraph that names the 30-minute bound as the only bound on an unanswered gate
- Modify: `docs/decisions/0040-*.md` — append an amendment note only (see below)
- Test: `src-tauri/src/config.rs` in-file

**What to implement:**

In `config.rs`, mirror `attention_alert_delay_secs` exactly — a module-level default fn plus the serde attribute:

```rust
fn default_subagent_dead_bound_secs() -> u64 {
    1800
}
```

```rust
/// The ADR 0055 **Dead bound**: how many SECONDS a **Subagent session** may
/// stay silent with no tool execution outstanding before it is reaped as
/// Dead. It bounds UNEXPLAINED SILENCE, never the length of the delegation —
/// an **Active Subagent** (producing frames, or holding an outstanding
/// `tool_call_id`) has no timeout of any kind, so no value here can cut a
/// working child. 1800 s: the provider layer already self-bounds a stalled
/// stream at a 5-minute idle `read_timeout`, so a child silent for twice
/// that with nothing in flight is genuinely wedged.
#[serde(default = "default_subagent_dead_bound_secs")]
pub subagent_dead_bound_secs: u64,
```

Add it to `impl Default for Settings`. Note `Settings` derives `PartialEq`, so adding a field is a compile-time break in any struct literal — fix those.

Wire it at construction. `lib.rs`'s `setup_dirs_with_factory` receives `config_dir: PathBuf` (verified in scope: `SessionManager::new(config_dir.clone())` uses it, and `WorkerManager::new` is called below in the same function), so `crate::config::load_settings(&config_dir).subagent_dead_bound_secs` is available at the `WorkerManager::new` call site. Prefer a builder `with_dead_bound_secs(self, secs: u64)` applied at that ONE production call site over a 5th constructor parameter — `WorkerManager::new` has **13 call sites** (verified) and `with_settle_timeout` has **11** (verified), most in tests; a builder keeps 12 of them untouched. Tests keep using `with_dead_bound` to inject a short bound.

Renames, mechanically:
- `DEFAULT_SUBAGENT_SETTLE_TIMEOUT` → `DEFAULT_SUBAGENT_DEAD_BOUND`
- `WorkerManager::settle_timeout` field → `dead_bound`
- `with_settle_timeout` → `with_dead_bound`
- `Race::TimedOut` → `Race::Dead`
- the `Failed { error: "timed out" }` string → `"unresponsive"`, updating every assertion on that string (`grep -rn '"timed out"' src/ tests/`). **This includes the assertions in the tests Tasks 2 and 3 added** (`a_silent_child_with_nothing_in_flight_hits_the_dead_bound`, `every_failure_path_carries_the_partial_output_and_real_usage`) — they had to assert the then-current string, and this is the task that changes it. Where Task 3's `reason` field is now available, prefer asserting `reason == SubagentFailureReason::Unresponsive` over the string.
- free functions that take `settle_timeout: Duration` (`start_pump`, `dispatch_subagent`, the drive) → `dead_bound`

Update the constant's doc comment to state the new predicate, and the `SubagentModals.tsx` comment block that says the only bound on an unanswered gate is the 30-minute `DEFAULT_SUBAGENT_SETTLE_TIMEOUT` — after ADR 0055 a child parked on a gate is **Active** and no clock bounds it, so that paragraph must be rewritten to say so. `SubagentModals.test.tsx` / `App.test.tsx` reference that text in comments; update comments only, never the assertions, unless an assertion genuinely asserts the removed behaviour.

ADR 0040 is append-only: do NOT edit its body. Append a section at the very END of the file, matching the repo's existing amendment convention (ADR 0040 already carries one — see its own `## Amendment (2026-10-13) — …` heading, and the same pattern in 0026/0027/0034/0042/0051):

```markdown
## Amendment (YYYY-MM-DD) — the 30-minute bound is no longer the resolver

<the bound named above as what resolves a parked child's delegation is superseded
by ADR 0055: a child parked on a gate is now Active and is never resolved by a
clock. The orphaned-card hole recorded above is closed by `finish_subagent`
emitting the close under the CHILD id. The ladder itself is unchanged.>
```

Use the real date (`date +%Y-%m-%d`).

**What NOT to change:** any behaviour. This task must be a pure rename plus one additive settings field. No Settings-UI control for the new key (deliberate — it is a `settings.json`-only key like `session_naming_reasoning`; say so in the field's doc comment).

**Steps:**
- [ ] Write `subagent_dead_bound_secs_defaults_to_1800` in `config.rs`'s tests (a `Settings::default()` check AND a `load_settings` on an empty/pre-feature `settings.json` returning 1800 — the pattern the attention-delay tests use).
- [ ] Run `cargo test subagent_dead_bound_secs` — fails (no field).
- [ ] Add the field + default fn + `Default` entry; wire at `lib.rs`.
- [ ] Run the renames; then `grep -rn "settle_timeout\|SETTLE_TIMEOUT\|\"timed out\"" src-tauri/src src-tauri/tests` from the repo root and confirm ZERO hits outside the new names.
- [ ] Update the doc comments + ADR 0040's appended amendment.
- [ ] Run `cargo test`, `pnpm test` from the root — green.
- [ ] Run `cargo clippy --all-targets`; `cargo fmt`; `pnpm build`
- [ ] Commit: `refactor(subagent): Dead bound — rename the settle timeout and make it configurable`

**Acceptance criteria:**
- [ ] `subagentDeadBoundSecs` deserialises with a serde default of 1800 and is honoured at `WorkerManager` construction.
- [ ] No identifier or comment anywhere still says "settle timeout", and no user-visible string still says "timed out".
- [ ] Zero behaviour change attributable to this task alone (all tests pass unchanged in outcome).
- [ ] ADR 0040's body is unmodified; an amendment note is appended.

---

### Task 6: Update the durable feature doc (do NOT create a new one)

**Context:**
`AGENTS.md` says durable design content lives in `docs/features/` and the in-flight plan is deleted on ship. `docs/features/subagent-sessions.md` ALREADY EXISTS (~435 lines) and documents the driver task's race, the interactive tools, and the gate-rendering invariant — including three places that state the 30-minute bound as a safety net this change removes. Creating a second `subagent-liveness.md` would fork the story; UPDATE this doc.

Note the doc carries front-matter `status: live` / `last-verified` / `verified-by` (see `docs/features/model-selection.md` for the shape) — refresh `last-verified` to today and `verified-by` to this PR once CI is green.

**Files:**
- Modify: `docs/features/subagent-sessions.md`
- Read-only: `docs/decisions/0055-*.md`, `CONTEXT.md`'s four new entries, `docs/features/model-selection.md` (house style)

**What to implement:**

1. **`## The driver task (settle / cancel / teardown)`** — its step 6 reads "Races: the child's **settle** vs the **`settle_timeout`** (default 30 min — a hung turn is torn down and reported `failed "timed out"`…)". Rewrite that step for the self-rearming silence clock: settle vs the **Dead bound** vs cancel vs process exit, with one sentence stating that the clock is rearmed on every frame and not armed at all while a `tool_call_id` is outstanding, so an **Active Subagent** is never reaped, and citing ADR 0055. Be aware the surrounding numbered list describes the PRE-ADR-0025 in-process driver (`dispatch_native_inner`, the throwaway `:memory:` `Db`, `TempFileGuard`); do not rewrite that history — change only the race step and, if it is cheap, add a one-line note that the drive now runs Supervisor-side in `WorkerManager` (ADR 0025). Flagging the staleness is enough; fixing it is out of scope.

2. **`## Interactive tools (ask, sudo_exec)`** — it already says the interactive wait carries NO deadline ("a timer that expires on a human wait is not a timeout, it is a lost answer"). Add one sentence that the drive-side bound now agrees: a child parked on a gate holds its tool call open, so it is Active and the Dead bound never runs — the Worker-process-era rule now matches the in-process-era rule.

3. **The "never-nowhere invariant" passage** (in `## Presentation`) — it states an unrendered gate "strands the child until the drive's 30-minute `settle_timeout` … which surfaces as a child `Failed \"timed out\"`". That sentence is now FALSE. Rewrite: the unrendered gate now strands the child **indefinitely** — it is Active, so no clock resolves it; the user escapes by leaving Settings (the gate becomes renderable and answerable) or by Stop. Say plainly that this is the intended trade: the question is no longer silently killed after 30 minutes, and the `App.test.tsx` KNOWN HOLE pin still records the hole itself.

4. **Add a short `## Liveness: Active vs Dead` section** (target ~25 lines, after the driver-task section), containing:
   - the rule in two sentences with links to ADR 0055 (do not restate its rationale),
   - the table of the four legitimately-silent states and the frame that covers each — inside a tool, parked on an `ask`, parked on a Permission/sudo prompt, awaiting a nested Subagent — with the note that `tool_execution_start` fires at ANNOUNCE time while `gate_tool` blocks later inside the same call,
   - the wiring in three sentences: pump bumps `seq` and maintains `in_flight` / `open_gates` under the `drives` lock → drive rearms on `liveness_rx.changed()` → the clock is not armed while `in_flight` is non-empty,
   - the accepted non-goal: a child deadlocked INSIDE a tool holds an outstanding id and is Active forever; `bash` bounds itself so the realistic exposure is a hung MCP call, whose fix belongs in the tool layer,
   - the operator pointer to `subagentDeadBoundSecs`.

5. If the doc has a `## Follow-ups` list, add the MCP-tool hang there.

Do not restate the plan's task list or test table. Cite symbols, not line numbers. This task does NOT delete `docs/roadmap/subagent-liveness-bound.md` — the `finish` skill owns that at merge time.

**Steps:**
- [ ] Read `docs/features/subagent-sessions.md` in full, `docs/decisions/0055-*.md`, `docs/features/model-selection.md` (front-matter style), and `CONTEXT.md`'s **Active Subagent** / **Dead Subagent** / **Dead bound** / **Gate** entries.
- [ ] Apply changes 1-5.
- [ ] `grep -n "settle_timeout\|SETTLE_TIMEOUT\|timed out" docs/features/subagent-sessions.md` → ZERO hits (Task 5 renamed the symbols; the doc must not still name them).
- [ ] Check every claim against ADR 0055 — on disagreement the ADR is right; fix the doc.
- [ ] `git add docs/features/subagent-sessions.md && git commit -m "docs(subagent): the Active/Dead liveness rule in the feature doc"`

**Acceptance criteria:**
- [ ] `docs/features/subagent-sessions.md` names no removed symbol, and its new Liveness section has the four-state table plus the non-goal.
- [ ] The never-nowhere passage states the indefinite strand honestly.
- [ ] Front-matter `last-verified` / `verified-by` refreshed.
- [ ] No new file created under `docs/features/`.

---

## Final verification (run after all tasks)

From `src-tauri/`:
```bash
cargo test
cargo clippy --all-targets   # must be 0 warnings
cargo fmt --check
```
From the repo root:
```bash
pnpm test
pnpm build
```

And confirm the exit condition directly: `cargo test a_streaming_subagent_outlives_the_dead_bound` passes, and `cargo test a_silent_child_with_nothing_in_flight_hits_the_dead_bound` passes — the child that works survives and the child that is wedged is still reaped.

## Task sequencing notes

- **Task 3 adds `reason` while the `Race` variant is still `TimedOut`.** That is fine: Task 3 maps `Race::TimedOut → SubagentFailureReason::Unresponsive` immediately (the *reason* is honest even though the *variant name* is stale), and Task 5 renames the variant only. Do not rename the variant early.
- **The user-visible string changes in Task 5, not Task 2/3.** Tasks 2 and 3 must assert the then-current `"timed out"`; Task 5 updates those assertions. No task may leave the tree red for the next.
- **`open_gates` is added in Task 4, not Task 1** — an unread field trips `dead_code`, and clippy must be warning-free at every task boundary.
- **`docs/features/subagent-sessions.md` still names the old symbols until Task 5 renames them, and Task 6 updates the doc.** Run Task 6 after Task 5.

## Non-goals (do not "helpfully" fix these)

- **Reaping a child deadlocked INSIDE a tool.** It holds an outstanding `tool_call_id`, so it is Active by definition and survives until Stop. That is accepted deliberately — see ADR 0055's consequences and Task 6. The fix belongs in the tool layer.
- **The Settings-view render hole** for a child's gates (`App.test.tsx`'s known-hole pin). Task 4 closes a torn-down child's *orphaned card*; a gate left unrendered while Settings is open is a different defect.
- **Repairing `router.rs`'s modal keying.** Task 4 bypasses it on purpose.
- **A Settings-UI control** for `subagentDeadBoundSecs`. `settings.json` only.
