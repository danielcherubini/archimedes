---
status: approved
done-when: a Subagent streaming or tool-calling past the old 30-minute bound completes normally; the Rust test `a_streaming_subagent_outlives_the_dead_bound` exists and passes; a silent child with nothing in flight is still reaped at the bound; `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`, `pnpm test` and `pnpm build` are all green.
---

# Subagent liveness — no timeout on an Active Subagent

## Problem

A **Subagent session** is torn down by `DEFAULT_SUBAGENT_SETTLE_TIMEOUT`
(`src-tauri/src/agent/worker/manager.rs`, the module's public constant), a single
`tokio::time::sleep(30 * 60)` armed once after the dispatch preflight and raced
against `agent_settled` in `drive_subagent`'s `tokio::select!`. It is never
rearmed, so it bounds the **duration of the delegation**, not the child's
responsiveness. A child that streams tokens and runs tools for 30+ minutes is
reaped mid-work as `Failed { error: "timed out" }`, with every captured byte
discarded, its metrics reported as zero, and its **Worker process** reaped with
no resume. The bound cannot distinguish a wedged child from a busy one — that
distinction does not exist in it.

The provider layer already fixed this exact defect one level down:
`provider/transport.rs` replaced a total request `.timeout()` with an IDLE
`read_timeout` (the time BETWEEN bytes), and its tests pin that a healthy slow
stream completes rather than being cut. The subagent layer still carries the
pre-fix shape.

Citations name **symbols, not line numbers** — `drive_subagent`'s race, the
pump's `feed_capture` — because line numbers re-drift on every commit.

## Design decisions

ADR 0055 (`docs/decisions/0055-subagent-liveness-is-tool-boundaries-not-duration.md`)
records the liveness-signal choice and its rejected alternatives. `CONTEXT.md`
gains **Active Subagent**, **Dead Subagent**, **Dead bound** and **Gate** (the
last had no entry despite being load-bearing across ADR 0040 and
`src/lib/attention.ts`).

## 1. Active vs Dead replaces duration vs deadline

An **Active Subagent** — producing frames, or legitimately silent because it
holds an outstanding `tool_call_id` (inside any tool execution, parked on any
**gate**, or awaiting a nested **Subagent session**) — has **no timeout of any
kind**. No ceiling, no setting, no exception. A delegation may run three hours
or three days.

A **Dead Subagent** — silent, nothing in flight, no gate open, for the **Dead
bound** (default 30 minutes) — is reaped as
`Failed { error: "unresponsive", .. }`.

The predicate changes from "how long has this delegation run" to "how long has
this child been unexplainedly silent". Three independently-legitimate silent
states had to be recognised, or the fix would only move the bug: a child inside
one long tool call, a child parked on an unanswered `ask`, and — the trap that
reproduces the reported bug one level down — a child whose own delegation is
busy.

## 2. Liveness signal: `tool_execution_start` / `tool_execution_end`

The pump (`start_pump`, the `WorkerInboundEvent::Event` / `SinkFrame` arms)
already receives EVERY `RpcEvent` for a child and already reaches the drive
under `feed_capture`'s existing mutex. `SubagentDrive` gains:

```rust
liveness_tx: watch::Sender<SubagentLiveness>

struct SubagentLiveness {
    seq: u64,                    // bumped on every Event / SinkFrame
    in_flight: HashSet<String>,  // outstanding tool_call_ids
}
```

`in_flight` gains an id on `tool_execution_start`, removes it on
`tool_execution_end`.

**No new protocol message and no heartbeat** — the tool boundary already covers
every silent state, all verified against the current loop:

| Silent state | Why the boundary covers it |
|---|---|
| Inside `bash` / `edit` / an MCP call | `start` emitted, no matching `end` |
| Parked on `ask` / `confirm` / `password` | it is inside the tool; `end` comes only when the flow returns |
| Parked on a **Permission prompt** or sudo prompt | `tool_execution_start` fires at ANNOUNCE time (`loop.rs`, the `ProviderEvent::ToolCall` arm) while `gate_tool` blocks later in the SAME tool call |
| Awaiting a nested **Subagent session** | holds `tool_execution_start { tool_name: "subagent" }` open, AND the grandchild's frames are already relayed into the parent's stream under the PARENT's delivery id, so they count as activity |

`in_flight` means **"announced and not yet closed"**, NOT "currently executing":
`start` fires while the Provider streams each `toolCall`, before the batch's
execution loop runs them one at a time, so a five-call batch has five
outstanding ids immediately. The skew is one-directional — it can only ever keep
a child alive LONGER, never cut it sooner — which is the correct bias for a bound
whose entire failure mode was cutting live children.

A `HashSet`, deliberately NOT a counter: ADR 0048 has the cancel and
turn-abandoned paths emit `tool_execution_end` for calls that were announced but
never dispatched, so an `end` without a `start` is a LEGAL frame. A counter would
go negative and un-block a child that is still working; a set's removal is
idempotent.

## 3. The drive task's race becomes self-rearming

`drive_subagent`'s naked `sleep(settle_timeout)` arm is replaced by a clock that
rearms while the child is **Active**, and is disabled outright while anything is
in flight:

```rust
loop {
    let snap = *liveness_rx.borrow_and_update();
    if snap.in_flight.is_empty() { deadline = Instant::now() + dead_bound }
    tokio::select! {
        _ = settle_rx.wait_for(|v| *v)                          => break Race::Settled,
        code = handle.exited()                                  => break Race::Exited(code),
        _ = cancel_rx.changed()                                 => break Race::Cancelled,
        _ = liveness_rx.changed()                               => continue,
        _ = sleep_until(deadline), if snap.in_flight.is_empty() => break Race::Dead,
    }
}
```

The bound stays at 30 minutes rather than being arbitrary because the provider
layer already self-bounds at a 5-minute IDLE `read_timeout`: a child silent for
30 minutes with nothing in flight cannot be waiting on the model. It is
genuinely wedged.

A park-on-gate child now behaves exactly like a main session's `ask`, which has
had NO deadline by explicit decision since `ask_flow`'s doc removed the suite's
300 s cap — pinned by `an_unanswered_question_never_settles_on_a_clock`. This is
consistency with a rule the codebase already holds, not a new licence.

## 4. Salvage on every failure path

`SubagentOutcome::Failed` (`src/agent/subagent.rs`) gains `output: String` and
`metrics: SubagentMetrics`. Today it carries ONLY `error`, so the
`SubagentCapture`'s text is unreachable by construction and a 29-minute
delegation reports zero tokens.

`finish_subagent`'s failed branch reads `capture.usage()` + the wall clock
instead of `SubagentMetrics::default()`, on **all three** non-complete paths —
Dead, crash (`Race::Exited`) and cancel. The `SubagentDelegatingCard` metrics
line reads exactly this payload, so the reported cost is fixed for free.

The parent agent gets ONE actionable string, because the parent is a model
reading a tool result: why it ended, the reassurance that the partial work may
still be valid, where the full transcript lives (the child's sheet — its
transcript IS persisted as a hidden ephemeral row, ADR 0025), then the captured
text. No new wire field is needed for the parent's sake: the string reaches the
model with no change to the `SubagentResult` contract.

**A Dead child is never reported as `Completed` with a warning.** The child was
mid-turn and had not decided it was finished; silently feeding a truncated
answer back as if it were a real reply is the worse failure, because the parent
cannot tell a complete answer from one amputated at minute 30. The status stays
honest and the TEXT carries the salvage.

The card keeps a SHORT reason line: `row.error` renders verbatim as the card's
one-line summary (`SubagentDelegatingCard.tsx`, the `row.error` arm), so the
salvage blob must not travel there. A structured `reason` code accompanies the
message rather than the UI re-parsing prose.

## 5. A torn-down child closes its own gates

Bundled deliberately. ADR 0040 recorded that a child's open `ask`/Permission
prompt is NOT auto-closed today, and that the 30-minute bound was what eventually
resolved a parked child's DELEGATION. §1 removes that rescue, so the hole stops
being academic. The defect chain has three links:

1. `router.rs`'s `track_modal(session_id, &id)` records a child's modal under the
   DELIVERY id (the parent) — the payload itself rides verbatim and carries the
   CHILD's `sessionId`, so the needed information is present and then discarded.
2. `route_event`'s `Exited` arm is gated `if !is_subagent`, so a child's exit
   never reaches `on_session_exited_expected` → `cleanup_pending_modals`.
3. Even if reached, `cleanup_pending_modals` returns early on `live.get`, and a
   child has no `live` entry (only `establish_worker_session` inserts).

**Fix: do not reuse the main-session cleanup path.** `SubagentDrive` gains
`pending_gate_ids: HashSet<String>`, filled by the pump on
`PermissionRequest` / `InteractiveRequest` (both already seen by the subagent
pump) and drained on a matching close. `finish_subagent` — the ONE unconditional
teardown, reached by every exit path: settle / Dead / cancel / crash — emits one
`interactive-request-close` per outstanding id with **`sessionId: child_id`**.

The frontend needs NO change: `removeRequest(childId, requestId)` already matches
how `App.tsx`'s `interactive-request` listener stored it via
`addRequest(payload.sessionId, …)`, and `removeRequest` filters, so a redundant
close is a harmless no-op.

This BYPASSES rather than repairs the router's mis-keyed `track_modal` / `live`
machinery, which stays wrong for children and becomes unused for them. That is
intentional: repairing it would touch the main-session path children share. Leave
a comment there saying so.

## 6. Configuration

`subagentDeadBoundSecs` in `settings.json`, serde default `1800`, read at
`WorkerManager` construction (one value, no per-dispatch plumbing) — following
the `attention_alert_delay_secs` pattern in `config.rs`.

It is safe to expose now precisely because §1 removed the danger: no value can
any longer cut an Active child. The worst a wrong setting does is reap a
genuinely wedged one sooner or later.

## 7. Renames

The old name caused this bug's misreading — "settle timeout" reads as an idle
timer and was an absolute wall-clock cap.

| Old | New |
|---|---|
| `DEFAULT_SUBAGENT_SETTLE_TIMEOUT` | `DEFAULT_SUBAGENT_DEAD_BOUND` |
| `WorkerManager::settle_timeout` field | `dead_bound` |
| `with_settle_timeout` (test variant) | `with_dead_bound` |
| `Race::TimedOut` | `Race::Dead` |
| `Failed { error: "timed out" }` | `Failed { error: "unresponsive" }` |

Update the code comments that state the old semantics — `manager.rs`'s module and
constant docs, `subagent.rs`, and the `SubagentModals.tsx` paragraph that names
the 30-minute bound as the only bound on an unanswered gate. ADR 0055 is added;
ADR 0040's body stays append-only (it is), carrying an amendment note the way
0040 itself carries its 2026-10-13 amendment.

## Non-goals

- **Reaping a child deadlocked INSIDE a tool.** It holds an outstanding
  `tool_call_id`, so it is Active by definition and survives until Stop. `bash`
  bounds itself (`DEFAULT_BASH_TIMEOUT`, 300 s), so the realistic exposure is a
  hung MCP tool call — and that belongs in the tool layer, where the hang
  actually is, not in a ceiling above it. Re-introducing a ceiling here would
  re-create the defect being removed. Stop-on-parent remains the manual escape
  hatch (`SubagentCancel` → `cancel_drive` → reap).
- **The Settings-view render hole** for a child's gates (`App.test.tsx`'s
  known-hole pin). §5 closes a crashed child's ORPHANED CARD; a gate left
  unrendered while Settings is open is a different defect with a different fix.
- **Repairing the router's modal keying** in general (see §5).

## Tests

Rust, `src-tauri/`. `fake_worker` gains three scenarios: `__long_stream__`
(streams well past the injected bound, then settles), `__in_tool__`
(`tool_execution_start` then silence past the bound), `__nested_silent__` (holds
`tool_execution_start { tool_name: "subagent" }` while a grandchild streams).
Each test injects a short bound via `with_dead_bound` — the production 30 min is
too slow to test, exactly as `transport.rs` injects a 200 ms `read_timeout`.

| Test | Pins |
|---|---|
| `a_streaming_subagent_outlives_the_dead_bound` | THE regression. Bound 200 ms, child streams ~1 s → `Completed`. **Fails on today's code** — write it first. |
| `a_child_inside_a_tool_call_is_never_reaped` | in-tool silence past the bound is not `Dead` |
| `a_child_awaiting_its_own_subagent_is_never_reaped` | the nested false positive, one level down |
| `a_child_parked_on_a_gate_never_settles_on_a_clock` | mirrors the pinned main-session `ask` rule at the child level |
| `a_silent_child_with_nothing_in_flight_hits_the_dead_bound` | the surviving safety net; error reads `"unresponsive"` |
| `every_failure_path_carries_the_partial_output_and_real_usage` | Dead / crash / cancel each carry captured text + non-zero tokens |
| `an_end_without_a_start_does_not_unblock_a_working_child` | ADR 0048's legal frame; guards set-vs-counter |
| `a_torn_down_child_closes_its_own_outstanding_gates` | one close per open gate, keyed to the CHILD id; none when none were open |
| `subagent_dead_bound_secs_defaults_to_1800` | the `config.rs` serde default, read at construction |

Frontend: `SubagentDelegatingCard` renders the short reason and NOT the salvage
blob; the store test covers a close arriving under a child id.

## Verification

From `src-tauri/`: `cargo test`, `cargo clippy --all-targets` (0 warnings),
`cargo fmt --check`. From the repo root: `pnpm test`, `pnpm build`.
