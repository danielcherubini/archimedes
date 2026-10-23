---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 34
done-when: `a_streaming_subagent_outlives_the_dead_bound` and `a_child_inside_a_tool_call_is_never_reaped` inject a **1500 ms** bound against the fixture's 100 ms cadence / 3 s legitimate silence (a 15× margin, not 3×), stay GREEN 10× back-to-back here and under an 8-way CPU load probe, are still RED when the drive is mutated back to its pre-ADR 0055 shape (arm the clock once and never rearm it → the streaming test reddens; let the sleep arm run with a `tool_call_id` outstanding → the in-tool test reddens), and their panic text names the parent's OBSERVATION latency as the first suspect instead of accusing ADR 0055's fix — while every doc that describes the **Dead bound** (`DEFAULT_SUBAGENT_DEAD_BOUND`, the `dead_bound` field, the drive's clock comment, `subagentDeadBoundSecs`, `CONTEXT.md`, `docs/features/subagent-sessions.md`, ADR 0055 via an amendment) says the clock bounds OBSERVED silence.
---

# Task 12 — 10× margin on the streaming-subagent liveness test, and the silence bound says OBSERVED (issue #34)

**Goal:** `agent::worker::manager::tests::a_streaming_subagent_outlives_the_dead_bound` flakes on `macos-latest` because it gives a wall-clock race against a REAL subprocess only 3× headroom (a 300 ms injected bound against a 100 ms frame cadence). Widen the margin to 15× without losing the test's RED-against-the-old-bug teeth, fix the panic text that misattributes the failure to ADR 0055's fix, and make the **Dead bound**'s documentation honest: it bounds the silence the **Supervisor OBSERVES**, not the child's liveness.

**Architecture:** Production behaviour is CORRECT and does NOT change — no logic edit anywhere in this task. Three surfaces move together. (1) The fixture (`src/bin/fake_worker.rs`) streams longer (`LONG_STREAM_CHUNKS` 15 → 30) and holds its open tool call longer (`IN_TOOL_HOLD` 1500 → 3000 ms), so the child's turn is ~3.0 s of legitimate production/silence instead of ~1.5 s. (2) Both ADR 0055 liveness tests in `agent/worker/manager/tests/mod.rs` inject one shared 1500 ms bound (a new module-level const, the file's existing convention for named timings) and their duration floors rise to match; the streaming test's `panic!` text is rewritten to name observation latency first. (3) The wording of the bound is corrected wherever it is stated — the two Rust doc comments and the drive's own clock comment that call it the child's SILENCE, the operator-facing setting doc, `CONTEXT.md`, the feature doc, and an appended amendment block on ADR 0055 (append-only house style; `superseded-by:` stays EMPTY). No behaviour, no signature, no setting default moves.

**Tech Stack:** Rust 2021 (pinned 1.99.0, `src-tauri/rust-toolchain.toml`), `tokio` current-thread `#[tokio::test]` (NOT `start_paused` — see §"Why `#[tokio::test(start_paused = true)]` cannot fix it"), the `fake_worker` fixture binary spawned as a real subprocess over JSONL stdio (ADR 0025), the drive's self-rearming silence clock on `liveness_rx` (`worker/manager/subagent_flow.rs`, ADR 0055). **No new dependency, no frontend change, no new test.**

---

## Parallelisation

**Verdict:** SERIAL — one task cannot be a wave, and the parent roadmap (`docs/roadmap/issue-triage-backlog-status.md`) already puts T12 in the serial column: `archimedes` is **one compilation unit**, so a sibling's half-finished `.rs` edit makes any scoped `cargo test` fail to compile and destroys this task's only RED/GREEN signal (measured by the loop's planted-error experiment, recorded in that doc's §"Why the waves collapsed to serial"). T12 also shares `agent/worker/manager/tests/mod.rs` and `src/bin/fake_worker.rs` with T10 (which explicitly disclaims both — "T12 owns it") and `agent/worker/manager/{mod.rs,subagent_flow.rs}` with T10/T11, so no two of them can share a wave even setting the compile unit aside.

Consequence for the executor: **run the FULL gate**, not a scoped run — a scoped `cargo test --lib <filter>` compiles the whole crate here anyway, so scoping buys nothing. This task runs alone.

### THE SEAM — you are LAST on the branch; re-verify before editing

T10 edits `worker/manager/mod.rs` (the `dispatch_subagent` doc comment), `worker/manager/subagent_flow.rs` (the child envelope) and `worker/protocol.rs`, and disclaims both `manager/tests/mod.rs` and `src/bin/fake_worker.rs` to this task ("T12 owns it"). **T11's plan (read it: `docs/roadmap/issue-triage-backlog-task11-resolve-miss-observability.md`) overlaps three of this task's files** and its own text acknowledges the seam ("T12 owns the file otherwise"):

| File | T11's edit | What it means for T12 |
| --- | --- | --- |
| `agent/worker/manager/tests/mod.rs` | one NEW test, the two `SubagentDispatchWire` literals (at `:349` / `:1798` today), one new assertion in the existing lifecycle test | the file GROWS, so every line number in this plan drifts, and **the module's test count rises** — which is exactly why §Steps makes you measure the baseline at YOUR HEAD rather than quoting the parent doc |
| `agent/worker/manager/subagent_flow.rs` | a `"nameResolution"` key in the step-6 `json!` | far from §4's clock comment; no conflict, but re-read the region |
| `src/bin/fake_worker.rs` | ONE line — the new field in the canned `Outbound::SubagentDispatch` | §1 edits constants and comments, not that arm; no conflict, but re-read before editing |
| `agent/worker/manager/mod.rs` | not listed by T11 | T10's doc-comment edit may already have moved §3's target |

So: every line number in this plan was read at `d2cb1fa` and **will have drifted**. Locate every edit target **by its existing text, not by line number**, and re-read the current bytes of each of the eight files below (and in §Files) immediately before editing it. If any target sentence has already changed (a doc comment you were told to rewrite was already rewritten, or a bound was already widened), **apply the intent, not the diff, and say what you found in the report** — trust the tree over this plan. And because T10/T11 add tests, the "count must not move" rule in §Steps is against **your own measured baseline**, never against the parent doc's stale figure.

---

## Context — why this exists, and what was verified against the tree

### The flake, and why the panic text lies

`a_streaming_subagent_outlives_the_dead_bound` (at HEAD, `manager/tests/mod.rs:1204-1245`) injects `with_dead_bound(300 ms)` against the fixture's `__long_stream__` mode: `LONG_STREAM_CHUNKS = 15` `agent_message_chunk` `SinkFrame`s, `LONG_STREAM_GAP = 100 ms` apart. That is **3× headroom** on a race with a real subprocess. The recorded CI failure (run `39051292438`, `macos-latest`, exit 101, 1053 passed / 1 failed) reported:

```
Failed { reason: Unresponsive, error: "unresponsive", output: "streamed…………………",
         metrics: SubagentMetrics { … duration_ms: 1901 } }
```

`streamed` + 7 dots = **8 of 15 frames observed in 1901 ms**. At a 100 ms cadence 1901 ms should have delivered all 15, so the parent's OBSERVATION of the child ran ~700 ms behind the child's emission. **Precision, because the number is load-bearing below:** that ~700 ms is the issue's DERIVED lag — seven frames' worth of 100 ms that the parent had not seen — not one instrumented single inter-frame gap. The bound has to clear the worst gap, and a 700 ms aggregate lag could equally be one 700 ms stall or several 250 ms ones; 1500 ms clears both readings, which is the reason for choosing on this number rather than on the cadence alone. The child was alive and producing; the drive saw a >300 ms gap between **observed** frames and concluded silence. `emit()` (`fake_worker.rs:126-130`) does `write_all` + `flush` on every frame, so child-side buffering is ruled out — the stall is in the parent's read → decode → `broadcast` → pump → `liveness_rx` chain.

The `panic!` text at HEAD (`tests/mod.rs:1232-1236`) blames this on "the drive bounded the delegation's DURATION instead of the child's SILENCE" — i.e. on ADR 0055's fix not having landed. **It did land**: the drive recomputes `deadline` on EVERY pass of the race loop (`subagent_flow.rs:847`, with the comment "That IS the activity reset"), and `note_liveness_frame` bumps `SubagentLiveness::seq` for every `SinkFrame` (`pump.rs:103-108`, `note_liveness_frame` at `subagent_flow.rs:275-277`). The failure is measurement, not the bug, and the message sends the next reader hunting a defect that is not there.

### Why `#[tokio::test(start_paused = true)]` cannot fix it

The fixture is a **real subprocess** (`FakeWorkerFactory::spawn` → `WorkerHandle::spawn(fixture_path())`, `tests/mod.rs:42-44`) whose `std::thread::sleep(LONG_STREAM_GAP)` (`fake_worker.rs:162`) is REAL time. `start_paused` virtualises only the in-test tokio clock; it cannot slow or speed the child, and there is no seam to make the child's emission deterministic. (It would also make things WORSE: the drive's `sleep_until` (`subagent_flow.rs:869`) is a tokio timer on the SAME runtime as the test, and under a paused clock it only advances when the runtime has no other work and auto-advances — so the silence bound would fire while the real subprocess was still mid-stream.)

### The production consequence, which is documentation-only

The default is 30 min, so a 700 ms observation stall is **0.039%** of it (the issue says 0.04%) — unreachable in practice, and nothing in this flake implies a user-visible bug. But the SHAPE is real and the current wording hides it. What the tree says today, all verified:

| Surface | Current text (HEAD `d2cb1fa`) | Why it misleads |
| --- | --- | --- |
| `manager/mod.rs:57-61` — `DEFAULT_SUBAGENT_DEAD_BOUND` doc | "30 min of UNEXPLAINED SILENCE. It is the most a **Subagent session** may go WITHOUT producing a frame AND with no `tool_call_id` outstanding" | "may go WITHOUT producing" reads as a property of the CHILD. The clock never sees the child; it sees `liveness_rx`. |
| `manager/mod.rs:148-150` — the `dead_bound` field doc | "default 30 min of unexplained silence" | same, in five words |
| `manager/subagent_flow.rs:821-823` — the drive's clock comment | "`dead_bound` is the **child's** maximum run of UNEXPLAINED SILENCE" | the ONE site whose logic reads observed frames, and it says "the child's" |
| `src/config.rs:317-327` — `subagent_dead_bound_secs` doc | "It bounds UNEXPLAINED SILENCE, never the length of the delegation" | the operator-facing doc; an operator shortening this setting needs to know a starved parent can reap a live child |
| `CONTEXT.md:107-109` — the **Dead bound** glossary entry | "It measures a duration of UNEXPLAINED SILENCE" | the glossary is what every later reader quotes |
| `docs/features/subagent-sessions.md:153-157` — §"Liveness: Active vs Dead" | "**Dead** only after `DEFAULT_SUBAGENT_DEAD_BOUND` of silence with NOTHING in flight" | same claim in the feature doc |
| `docs/decisions/0055-….md:9` | "only a child that is silent with nothing in flight for `DEFAULT_SUBAGENT_DEAD_BOUND` (30 min) is **Dead** and reaped" | ADRs are append-only → an amendment, not an edit |

The one place that already gets it right: `docs/features/subagent-sessions.md:106` — "rearmed on EVERY frame **the pump sees** for the child". Keep that phrasing as the model for the others.

### The fixture, verified

`src/bin/fake_worker.rs`:

- `LONG_STREAM_CHUNKS: u32 = 15` (`:94`), `LONG_STREAM_GAP = 100 ms` (`:99`), `IN_TOOL_HOLD = 1500 ms` (`:104`), `SILENCE_AFTER_STREAM = 10 s` (`:110`).
- `emit_long_chunk_stream` (`:146-164`) emits a chunk then sleeps, **including after the last chunk**, so the stream phase costs `CHUNKS × GAP` = 1500 ms today, 3000 ms after this change. `std::thread::sleep` never returns early, so that is a FLOOR, not an estimate.
- Every chunk is `messageId: "m2"` with text `streamed` then `…`; `emit_canned_turn` (`:280+`) then emits its own `messageId: "m1"` chunks LAST, so `SubagentCapture`'s last-`messageId`-with-non-empty-text rule (`subagent_flow.rs:175-184`) leaves the test's `assert_eq!(output, "canned answer")` TRUE at any chunk count. **Nothing in the tree asserts the chunk count** — `__long_stream__` has exactly ONE caller (`tests/mod.rs:1212`) and no test counts the dots or matches `"m2"`.
- The client's frame `broadcast` ring is 256 (`worker/client.rs:389`) and the fixture's own `__crash_burst__` deliberately runs 40 frames "far inside" it, so 30 frames cannot produce a `Lagged` pump.
- `__in_tool__` (`:704+`) emits `tool_execution_start{t1,bash}`, sleeps `IN_TOOL_HOLD`, then `tool_execution_end` + `agent_settled`. Its `args: {"command": "sleep 1.5"}` is decorative — grep shows no assertion on it anywhere.
- `SILENCE_AFTER_STREAM`'s doc claim "LONGER than any bound the tests inject" stays TRUE after this change (10 s > 1.5 s). Do not touch it.

### The drive, verified (what the numbers must respect)

`drive_subagent` (`subagent_flow.rs:766+`) takes `start = Instant::now()` **before** `(state.factory).spawn()` (`:683-684`), so `metrics.duration_ms` covers spawn + `wait_ready` + `send_start` + `send_prompt` + the whole stream + the settle frames. `duration_ms` is therefore ≥ the fixture's sleep budget, always. The race's arms: `settle_rx`, the pump's `exit_rx`, the `handle.exited()` safety net, `cancel_rx`, `liveness_rx.changed() => continue` (the rearm), and `_ = &mut sleep, if !in_flight => break Race::Dead` — i.e. **while a `tool_call_id` is outstanding the bound does not run at all**, it is not merely longer.

---

## The numbers, with their arithmetic

Two ratios matter and they pull in opposite directions. Getting both is the whole task:

1. **bound ÷ cadence** — how many consecutive late/missed frames the parent may tolerate before declaring silence. Today `300 ÷ 100 = 3×` (the issue's complaint). Target ≥ 10×.
2. **total turn − bound** — the RED-against-the-old-bug margin. The pre-ADR 0055 drive had TWO defects: ONE `sleep(dead_bound)` armed after the preflight and never rearmed, and no `in_flight` concept, so that sleep also ran while a `tool_call_id` was outstanding. For each test to stay RED, the fixture's legitimate turn must still OVERSHOOT the bound by a clear margin — and for the in-tool test the probe has to restore the missing guard too (§Steps, mutations A and B).

| Quantity | Today | After | Arithmetic |
| --- | --- | --- | --- |
| Injected bound (both liveness tests) | 300 ms | **1500 ms** | 1500 ÷ 100 = **15× the cadence** (≥ 10×, the issue's target); 1500 ÷ ~700 = **~2.1× the observation lag the one recorded failure implies**, which is the quantity that actually caused the flake |
| `LONG_STREAM_CHUNKS` | 15 | **30** | 30 × 100 ms = **3000 ms** of stream ≥ the child's turn floor |
| Streaming test's RED margin | 1500 − 300 = 1200 ms | **3000 − 1500 = 1500 ms** | the mutated (arm-once) drive reaps at 1500 ms with ~15 of 30 chunks still to come — a GLARING truncation, the same 8-of-15 shape the CI failure showed, not a dead heat |
| `metrics.duration_ms >=` (streaming) | 600 | **2000** | structural floor is 30 × 100 ms = 3000 ms of real sleeps measured from before spawn ⇒ 2000 has ~1000 ms of slack and still fails if the stream is ever shortened |
| `IN_TOOL_HOLD` | 1500 ms | **3000 ms** | must stay clearly ABOVE the bound or the in-tool test loses its teeth: the pre-ADR 0055 sleep arm (which ran even with a `tool_call_id` outstanding) has to expire inside the silent hold |
| In-tool test's RED margin | 1500 − 300 = 1200 ms | **3000 − 1500 = 1500 ms** | the pre-ADR 0055 sleep arm (which ran even with a `tool_call_id` outstanding) fires at 1500 ms inside a 3000 ms hold ⇒ `Failed { Unresponsive }`. The guard is what makes this test's teeth depend on the guard, not only on the clock — see mutation B |
| `metrics.duration_ms >=` (in-tool) | 1000 | **2000** | floor is the 3000 ms real sleep ⇒ ~1000 ms of slack |
| Suite cost | — | **≈ +3.0 s once** | streaming test ~2.05 s → ~3.5 s; in-tool ~2.1 s → ~3.6 s (each = child turn + its existing 500 ms teardown `sleep`). No other test uses either fixture mode. |

### Why 1500 ms and not 1200 ms (and not 1500 ms with the fixture untouched)

The task brief floated "bound 1200 ms, fixture unchanged". Rejected, with the arithmetic: 1200 ms is only **1.7×** the ~700 ms observation lag that actually caused the flake, so the widened test would still be within 1.7× of the one quantity known to break it — the issue's complaint was precisely that 3× on this race was too thin, and 1.7× on the *stall* is no better. Conversely, raising the bound to 1500 ms **without** lengthening the fixture makes the RED margin a dead heat (stream 1500 ms vs bound 1500 ms — the settle and the old sleep fire in the same millisecond), which is the marginal case the brief warns about. So the bound and the fixture move together: cadence stays 100 ms (keeping the 15× frame tolerance), the child's turn doubles, and the bound doubles under it.

### The sibling test `a_child_inside_a_tool_call_is_never_reaped` — widen it too

The issue names only the streaming test. **This task widens both**, because the same runner-load theory applies with a different (and less obvious) exposure profile:

- Once the drive has OBSERVED the `tool_execution_start`, the sleep arm is guarded off (`if !in_flight`) and **no clock runs at all** — so the 3 s legitimate hold needs ZERO margin against load. A 700 ms stall mid-hold is a non-event. That half is already flake-proof, and it is why this test has never reddened CI.
- The exposure is the **cold start**: the drive arms its deadline immediately after `send_prompt`, and the bound only stops being armed once the pump has observed the announce frame and `liveness_rx.changed()` has woken the drive. If the parent's observation chain stalls longer than the injected bound inside that first window, the test reaps a child that never got to announce. At 300 ms that is the same thin margin the streaming test had, in a window this file cannot widen by any other means.
- 1500 ms gives that single frame ~2.1× the lag the recorded failure implies, and `IN_TOOL_HOLD` 3000 ms keeps the RED-against-the-old-bug margin at 1500 ms. Cost: ~1.5 s, once.
- Leaving it means the next macOS flake is this test and the loop re-files the same issue. Fixing both also lets the two tests share ONE documented bound constant, which is what makes the ratio auditable in one place.

### Tests that deliberately do NOT change — and the asymmetry that justifies it

A test that asserts the bound **fires** is flake-proof against runner load; only a test that asserts the bound does **not** fire is exposed. So leave all of these exactly as they are:

- `a_silent_child_with_nothing_in_flight_hits_the_dead_bound` (`:1141`, bound 1 s vs `__slow__`'s 10 s sleep) — load makes the reap arrive SOONER, which is the asserted direction.
- `every_failure_path_carries_the_partial_output_and_real_usage` (`:1307`, bound 400 ms vs `SILENCE_AFTER_STREAM`'s 10 s; its other two arms are crash/cancel, both bounded by the fixture, not by the bound) — same reason. Its `metrics.duration_ms >= 1` floor is load-insensitive.
- The eleven `make_manager(Some(Duration::from_secs(30)))` sites (bounds deliberately LONGER than anything the test waits for) — a stall only helps them.
- Every trailing `tokio::time::sleep(Duration::from_millis(500))` teardown check, and `wait_for_event`'s 20 s deadline (`:297`) — the new ~3.5 s turns fit with ~6× room.

### Decisions the brief asked for, taken

- **Option (2), a fixture env-knob for chunk count/cadence: REJECTED.** It cannot fix this flake (the failure is a STALL, not a cadence problem), and reading a cadence override from the process env would require `unsafe { std::env::set_var }` in a test binary that spawns worker subprocesses from many tests concurrently — a cross-test hazard (this repo's existing `set_var` uses are `HOME` in near-serial contexts: `commands/agents.rs`, `harness/loop/tests/policy_gate.rs`) for a knob with no consumer once the two constants are fixed. Pinning "the knob's default preserves today's cadence" would be a test of a default nobody overrides.
- **Option (3), reap on a second confirmation: NOT done.** Invasive to the drive's race for a 30-minute default whose real-world exposure is 0.04%; recorded as a follow-up with the seam it would need.
- **No new test.** The artefact IS the existing test. A source-scanning gate on the wording of a `panic!` string is the source-grep over-reach this repo has been explicitly retiring (`src/lib/subagentSheetLayout.test.ts`'s own commentary on narrowing its regexes); a message whose job is to be read by a human at 2 a.m. is protected here by saying the same thing in three docs (the const's doc, the ADR amendment, the drive's comment) rather than by a brittle string match. Recorded as a follow-up if the loop wants it machine-pinned.
- **`#[ignore]` is not the answer either** — the repo prefers an availability guard over `#[ignore]` (`tools/exec/tests/search.rs:99`: "Guard on `rg` availability (NOT `#[ignore]`)"), and a 3 s test in a multi-minute suite is affordable.

---

## Files

- Modify: `src-tauri/src/bin/fake_worker.rs` — `LONG_STREAM_CHUNKS` 15 → 30, `IN_TOOL_HOLD` 1500 ms → 3000 ms, the three const docs + the two module-doc bullets + the two `match`-arm comments, and the cosmetic `"sleep 1.5"` → `"sleep 3"`.
- Modify: `src-tauri/src/agent/worker/manager/tests/mod.rs` — one new module-level const, both liveness tests' injected bound, both `duration_ms` floors, both doc comments, the streaming test's `panic!` text.
- Modify: `src-tauri/src/agent/worker/manager/mod.rs` — `DEFAULT_SUBAGENT_DEAD_BOUND`'s doc + the `dead_bound` field's doc (comments only).
- Modify: `src-tauri/src/agent/worker/manager/subagent_flow.rs` — the silence-clock comment at `:821-823` ONLY. **No logic change in this file** (see the mutation-probe warning in §Steps).
- Modify: `src-tauri/src/config.rs` — the `subagent_dead_bound_secs` doc comment (one clause; no config test asserts comment text).
- Modify: `CONTEXT.md` — the **Dead bound** entry only (leave **Dead Subagent** alone; the bound entry is where the claim is made).
- Modify: `docs/features/subagent-sessions.md` — the one sentence in §"Liveness: Active vs Dead".
- Modify: `docs/decisions/0055-subagent-liveness-is-tool-boundaries-not-duration.md` — append a dated amendment block at the END; `superseded-by:` in the front-matter stays EMPTY.
- Test: no new test file — `src-tauri/src/agent/worker/manager/tests/mod.rs` is both the change and its own verification.

**Do NOT touch:** `src-tauri/src/agent/worker/manager/pump.rs`, `worker/client.rs`, `worker/core.rs`, `worker/protocol.rs`, `agent/session/mod.rs`, `Cargo.toml` / `Cargo.lock` (no dependency change; `regex` is already a dependency but is NOT needed), anything under `src/` (the frontend — `pnpm test` / `pnpm build` must report UNCHANGED figures), `src-tauri/tests/*.rs` (no integration test uses either fixture mode — verified by grep), `docs/decisions/0036*` / `0038*` / `0040*` / `0023*` (read 0038 and 0036 for AMENDMENT FORMAT only), `docs/roadmap/issue-triage-backlog-status.md` and the follow-ups doc (the orchestrator owns the status doc, the `done` mark and the Changelog line), and the `#[ignore]`d `src-tauri/tests/attention_alert_survives.rs`. Also: add no `Command::new(` or `.creation_flags(` token to any file — `agent/childproc.rs`'s production-region census scans `src-tauri/src/**/*.rs` for exactly those.

---

## What to implement

### 1. `src-tauri/src/bin/fake_worker.rs` — the fixture gets a longer legitimate turn

1a. `LONG_STREAM_CHUNKS` (`:94`) `15` → `30`, and rewrite its doc (`:90-93`) so the arithmetic and the teeth are both stated:

```rust
/// The `__long_stream__` chunk count (ADR 0055) — `LONG_STREAM_CHUNKS` ×
/// `LONG_STREAM_GAP` = 3.0 s of CONTINUOUS production: TWICE the liveness tests'
/// injected 1500 ms bound, so a drive that bounds the delegation's DURATION
/// instead of its OBSERVED silence is still caught mid-stream (issue #34 widened
/// the bound 300 → 1500 ms to buy 15× margin against the cadence below, and the
/// stream had to grow with it or the regression would have stopped being RED).
/// Real sleeps, so this is a floor: `std::thread::sleep` never returns early.
const LONG_STREAM_CHUNKS: u32 = 30;
```

1b. `LONG_STREAM_GAP` (`:96-99`) stays `from_millis(100)`; its doc's "well INSIDE the tests' 300 ms bound" becomes the ratio:

```rust
/// The gap between two `__long_stream__` chunks (~100 ms — a chunk arrives 15×
/// INSIDE the tests' 1500 ms bound, so a self-rearming silence clock cannot
/// expire while the child is talking unless the PARENT stopped observing for
/// longer than the bound (issue #34: that is exactly what a loaded macOS runner
/// does, and it is an observation-stall failure, not a cadence one).
const LONG_STREAM_GAP: std::time::Duration = std::time::Duration::from_millis(100);
```

1c. `IN_TOOL_HOLD` (`:101-104`) `from_millis(1500)` → `from_millis(3000)`, doc updated:

```rust
/// How long the `__in_tool__` scenario holds its `tool_execution_start`
/// open (3.0 s — TWICE the liveness tests' injected 1500 ms bound, so the
/// pre-ADR 0055 drive this scenario is RED against — whose sleep arm ran even
/// with a `tool_call_id` outstanding — still expires inside the silent window. The bound being LONGER than the old 300 ms is only about the COLD
/// START: once the announce is observed the bound is not armed at all, so the
/// hold itself needs no margin against runner load).
const IN_TOOL_HOLD: std::time::Duration = std::time::Duration::from_millis(3000);
```

1d. Module doc (`:43-52`): the `__long_stream__` bullet's "~100 ms apart for ~1.5 s of CONTINUOUS production" → "~100 ms apart for ~3.0 s of CONTINUOUS production"; the `__in_tool__` bullet's "held OPEN for ~1.5 s" → "held OPEN for ~3.0 s".

1e. The `__long_stream__` match-arm comment (`:684-691`): "~1.5 s of CONTINUOUS `agent_message_chunk` production — 5× the tests' injected 300 ms bound" → "~3.0 s of CONTINUOUS `agent_message_chunk` production — 2× the tests' injected 1500 ms bound, so the arm-once drive is still caught mid-stream; the rearming drive would have to lose fifteen consecutive frames to reap it."

1f. The `__in_tool__` `args` (`:711`): `{"command": "sleep 1.5"}` → `{"command": "sleep 3"}` so the decorative payload matches the real hold. Nothing asserts it (verified); keep the shape (`args: serde_json::json!({...})`) byte-compatible otherwise.

### 2. `src-tauri/src/agent/worker/manager/tests/mod.rs` — one bound, two tests, honest text

2a. Add ONE module-level const immediately after the existing `PUMP_STALL` / `PUMP_STALL_DEADLINE` block (`:165-166`) — that pair is this file's convention for a named timing number with its arithmetic in the doc:

```rust
/// The **Dead bound** both ADR 0055 liveness tests inject (`#34`).
///
/// The arithmetic, because it is the whole point of the number:
/// - **15×** the fixture's 100 ms `LONG_STREAM_GAP`, so the drive may lose
///   fifteen consecutive frames — or the parent's read → decode → broadcast →
///   pump chain may stall fifteen frames deep — before a streaming child is
///   reaped. It used to be 300 ms, i.e. 3×, and ONE >300 ms observation gap on a
///   loaded `macos-latest` runner reddened CI with 8 of 15 frames observed.
/// - ~2× the observation lag the one recorded CI failure implies (~700 ms — seven
///   100 ms frames the parent had not seen at 1.9 s), which is the quantity that
///   actually breaks these tests: a bound sized against the CADENCE alone is
///   answering the wrong question.
/// - **HALF** the fixture's legitimate turn (30 chunks × 100 ms, and a 3.0 s
///   `IN_TOOL_HOLD`). This is what keeps both tests RED against the pre-ADR 0055
///   drive — the reaping still lands inside the child's production (streaming) or
///   inside its silent tool hold (in-tool). Raise the bound without raising the
///   fixture and the regression stops being caught — that trade is the reason both
///   moved.
const LIVENESS_DEAD_BOUND: Duration = Duration::from_millis(1500);
```

2b. `a_streaming_subagent_outlives_the_dead_bound`:

- Replace `make_manager(Some(Duration::from_millis(300)))` with `make_manager(Some(LIVENESS_DEAD_BOUND))`, and the comment above it with `// The bound is 1500 ms — 15× the fixture's cadence, half its ~3.0 s stream.`
- Doc comment (`:1191-1203`): rewrite so it states today's numbers and the measurement caveat. Requirements for the text: (a) "15 chunks" becomes "30 chunks … ~3.0 s of continuous production — 2× the bound injected here"; (b) the RED paragraph says the arm-once sleep fires at 1500 ms while the child is still streaming, with ~15 of the 30 chunks still to come (this scenario has no `tool_call_id` outstanding, so unlike the in-tool test its teeth come from the clock alone); (c) add a short paragraph naming the bound as a bound on **OBSERVED** inter-frame gaps and stating that the test's residual exposure is a >1500 ms OBSERVATION stall, not the child's speed.
- `assert!(metrics.duration_ms >= 600, …)` → `>= 2000`, message `"the child must have run well past the 1500 ms bound (its own sleeps are 30 × 100 ms = 3.0 s), got {metrics:?}"`.
- The `other => panic!(…)` arm becomes this — OBSERVATION latency named FIRST, the ADR 0055 accusation explicitly withdrawn, and the diagnostic ordering a reader can act on:

```rust
        other => panic!(
            "a streaming child is an Active Subagent and must COMPLETE, got {other:?} \
             (FIRST suspect for a `Failed {{ unresponsive }}` here is OBSERVATION \
             latency, NOT the ADR 0055 fix: the silence clock bounds the inter-frame \
             gap the SUPERVISOR OBSERVES on `liveness_rx` (`subagent_flow.rs`), so a \
             stall longer than this test's {bound} ms bound in the parent's \
             read → decode → broadcast → pump chain reads as child silence while the \
             child keeps producing. Compare the frame count in `output` against the \
             fixture's 30 chunks: a TRUNCATED `output` (the CI failure showed 8 of 15 \
             at 1.9 s) means the child was alive and the parent was starved. The \
             DURATION-instead-of-SILENCE bug this test was written for is only the \
             answer if every frame was observed and the drive still reaped.)",
            bound = LIVENESS_DEAD_BOUND.as_millis(),
        ),
```

  Two mechanical notes. (a) The bound is passed as a **named** format arg (`bound = …`) and referenced as `{bound}`. That is a style choice, not a compiler requirement — mixing an inline capture (`{other:?}`) with a positional `{}` does compile (checked on rustc 1.95: `panic!("got {other:?} then {} ms", 1500u128)` renders fine) — but the named form makes the message self-describing at the call site and keeps the number single-sourced from the const. (b) The literal braces in `` `Failed {{ unresponsive }}` `` stay DOUBLED, exactly as they are at HEAD — the message prints one pair. If `cargo fmt` reflows the string, that is fine; the WORDS are what matter.

2c. `a_child_inside_a_tool_call_is_never_reaped`:

- `make_manager(Some(Duration::from_millis(300)))` → `make_manager(Some(LIVENESS_DEAD_BOUND))`; the comment above it → `// The bound is 1500 ms; the tool call stays open for ~3.0 s.`
- Doc comment (`:1247-1256`): "produces NOTHING for ~1.5 s" → "~3.0 s"; and make the RED paragraph precise, because the current wording names only half the old bug. The pre-ADR 0055 drive had NO `in_flight` concept at all, so what this test is RED against is the SLEEP ARM RUNNING WHILE A TOOL CALL IS OUTSTANDING — a never-rearmed clock alone cannot reap it, since today's `if !in_flight` guard already disables the arm (that is mutation A vs mutation B in §Steps). Reword the paragraph to say: against the pre-ADR 0055 drive — whose sleep arm ran even with a `tool_call_id` outstanding — the 1500 ms sleep expires inside the 3.0 s silent tool window → `Failed { error: "unresponsive" }` while `in_flight` holds `t1`. Add ONE sentence naming the test's real load exposure: the bound stops being armed only once the pump has OBSERVED the `tool_execution_start`, so this test's sensitivity is the cold start, not the hold.
- `assert!(metrics.duration_ms >= 1000, …)` → `>= 2000`, message text `the 300 ms bound` → `the 1500 ms bound`.
- Its `other => panic!(…)` text: leave the claim ("a child with an outstanding `tool_call_id` must NEVER be reaped") but append the same first-suspect pointer in one clause — `(first suspect: the announce frame was not OBSERVED within the bound — see the note on OBSERVATION latency in a_streaming_subagent_outlives_the_dead_bound)`.

2d. Do NOT touch `a_silent_child_with_nothing_in_flight_hits_the_dead_bound`, `every_failure_path_carries_the_partial_output_and_real_usage`, `the_dead_bound_secs_seam_sets_the_bound` (it asserts `DEFAULT_SUBAGENT_DEAD_BOUND` and the 45 s seam — the default is unchanged), `make_stalling_manager`, or `PUMP_STALL`.

### 3. `src-tauri/src/agent/worker/manager/mod.rs` — the bound says OBSERVED

3a. `DEFAULT_SUBAGENT_DEAD_BOUND`'s doc (`:57-60`) — replace the whole doc comment with:

```rust
/// The default **Dead bound** (ADR 0055): 30 min of UNEXPLAINED SILENCE **as the
/// Supervisor OBSERVES it**. It is the most a **Subagent session** may go with no
/// frame OBSERVED by the pump AND no `tool_call_id` outstanding — it is NOT a
/// ceiling on the length of the delegation (an **Active Subagent** has no timeout
/// of any kind), and it is NOT a measurement of the child: the clock is rearmed by
/// the frames that actually reach the drive's `liveness_rx`
/// (`subagent_flow.rs`), so a parent starved of CPU can OBSERVE a gap the child
/// never stopped producing into and reap it `Unresponsive` with its partial
/// output. The default is 30 min rather than a second because of exactly that: the
/// observation lag implied by the one recorded CI failure was ~700 ms on a loaded
/// runner (issue #34), 0.04% of this bound, against a provider layer that already
/// self-bounds a stalled stream at 5 min. Overridden in production by
/// `settings.json`'s `subagentDeadBoundSecs`.
```

3b. The `dead_bound` field doc (`:148-150`): "default 30 min of unexplained silence" → "default 30 min of **OBSERVED** unexplained silence — the gap between frames the pump actually read, not the child's own; see [`DEFAULT_SUBAGENT_DEAD_BOUND`]". Keep the rest of the sentence.

3c. Leave `with_dead_bound` / `with_dead_bound_secs` alone EXCEPT: if `with_dead_bound_secs`'s "SECONDS of unexplained silence" (`:199-201`) reads as the child's after 3a, add the word OBSERVED there too. One word, no restructure.

### 4. `src-tauri/src/agent/worker/manager/subagent_flow.rs` — the clock's own comment

The comment at `:821-823` (inside `drive_subagent`, above the race loop) — change only the first clause:

```rust
    // The bound is a SELF-REARMING silence clock: `dead_bound` is the longest run
    // of UNEXPLAINED SILENCE THIS DRIVE OBSERVES — the gap between frames that
    // actually reached `liveness_rx`, NOT a measurement of what the child was
    // doing — so it is recomputed on
```

Keep the remaining lines of that comment ("every pass of the loop below — a pass is only ever entered because something CHANGED … while a `tool_call_id` is outstanding the bound does not run at all (the arm is disabled, not merely lengthened)") verbatim. **NO other edit in this file, and NO logic edit at all.**

### 5. `src-tauri/src/config.rs` — the operator's doc

`subagent_dead_bound_secs`'s doc (`:317-327`): "It bounds UNEXPLAINED SILENCE, never the length of the delegation" → "It bounds UNEXPLAINED SILENCE **as the Supervisor observes it** (the gap between frames the pump actually read — a parent starved of CPU can observe a gap a live child never stopped producing into), never the length of the delegation". Keep the rest of the doc, including the 1800 s rationale and the "`settings.json`-only, no Settings-UI control" clause. No test in `config.rs` asserts comment text (they assert the JSON key/round-trip at `:860-900`) — expect zero test churn here.

### 6. `CONTEXT.md` — the glossary entry

The **Dead bound** entry (`:107-109`): "It measures a duration of UNEXPLAINED SILENCE, never a duration of the delegation, and it is rearmed on every frame and disabled while any `tool_call_id` is outstanding." → "It measures a duration of UNEXPLAINED SILENCE **as the Supervisor OBSERVES it** — the gap between frames the pump actually read, not the frames the child sent, so a starved parent can observe silence in a child that never stopped producing — never a duration of the delegation, and it is rearmed on every observed frame and disabled while any `tool_call_id` is outstanding." Leave the `_Avoid_` line and the `read_timeout` / `timeout_ms` disambiguation verbatim. Leave the **Dead Subagent** and **Active Subagent** entries alone (their claims are about state, not about the measurement).

### 7. `docs/features/subagent-sessions.md` — §"Liveness: Active vs Dead"

`:153-157`: "**Dead** only after `DEFAULT_SUBAGENT_DEAD_BOUND` of silence with NOTHING in flight" → "**Dead** only after `DEFAULT_SUBAGENT_DEAD_BOUND` of silence **the pump actually observed** with NOTHING in flight". Add one sentence after the paragraph: "The clock reads observed frames, not the child: a parent starved of CPU can observe a gap a live child never stopped producing into, which is why the default is 30 min and not a second (issue #34 measured ~700 ms of observation stall on a loaded CI runner — 0.04% of the bound)." Do NOT touch `:106` ("rearmed on EVERY frame the pump sees" — already honest) and do NOT fix the stale `src-tauri/src/agent/worker/manager.rs` paths in this doc or in `src/` — that sweep is a follow-up (§Follow-ups).

### 8. `docs/decisions/0055-subagent-liveness-is-tool-boundaries-not-duration.md` — append, never edit

ADR body is append-only (the house rule T10 states and 0036/0038/0040/0023 all follow). Append at the END of the file, after the last Consequences bullet, as a blockquote in ADR 0038's amendment format — `> **Amended <date> (<parenthetical, in quotes>).** …` — with a blank `>` line handling and the same voice (say what is now false, say what is NOT superseded, say why `superseded-by:` stays empty, name the rejected option). Use today's date from `date +%F` on the machine running the task. Text to adapt verbatim-or-nearly:

> **Amended 2026-10-XX (the bound reads OBSERVED frames, not the child's liveness).**
> The decision's opening sentence — "only a child that is silent with nothing in
> flight for `DEFAULT_SUBAGENT_DEAD_BOUND` (30 min) is **Dead** and reaped" — reads
> as a property of the child. It is a property of the Supervisor's OBSERVATION: the
> clock is rearmed by the frames that reach the drive's `liveness_rx`
> (`worker/manager/subagent_flow.rs`), so what it bounds is the inter-frame gap the
> PARENT observed. A parent starved of CPU can therefore reap a child that never
> stopped producing, `Failed { reason: Unresponsive }` with its partial output and
> real usage — the child was Active, the measurement said otherwise. Nothing above
> is superseded and `superseded-by:` stays EMPTY: the predicate (silence, not
> duration), the rearming and the gate/tool-boundary signal are exactly as decided,
> and at a 30-minute default the exposure is arithmetic rather than operational —
> the observation lag implied by the one recorded failure was ~700 ms on a loaded
> `macos-latest` runner (issue #34 — derived from 8 of 15 frames seen at 1.9 s, not
> instrumented as a single gap), 0.04% of the bound, against a provider layer
> that already self-bounds a stalled stream at 5 minutes (the Consequences bullet
> above that reasons from the 5-minute `read_timeout` still holds; it now has a
> second number beside it). What changed is the WORDING the decision is quoted with
> — `DEFAULT_SUBAGENT_DEAD_BOUND`'s doc, `with_dead_bound_secs`, the
> `subagentDeadBoundSecs` setting doc, `CONTEXT.md`'s **Dead bound** entry,
> `docs/features/subagent-sessions.md`, and the clock comment in `subagent_flow.rs`
> that implements this decision — and the test that tripped over it:
> `a_streaming_subagent_outlives_the_dead_bound` ran a 3× margin between its
> injected 300 ms bound and the fixture's 100 ms cadence, so one >300 ms
> observation gap reddened CI while its panic text accused THIS decision's fix of
> not having landed. The margin is 15× now (1500 ms against a 100 ms cadence, with
> the fixture's stream and its open-tool hold both doubled to 3.0 s so the test
> stays RED against the drive this decision replaced — the never-rearmed sleep for
> the streaming test, and the sleep arm that ran even with a `tool_call_id`
> outstanding for the in-tool one), and the panic text names observation latency
> first. Requiring a SECOND expired deadline before
> reaping — the obvious way to turn a transient stall into a non-event in test and
> production alike — was considered and rejected as invasive to the race for a
> default whose measured exposure is 0.04%; it is recorded as a live follow-up
> against issue #34, not silently dropped.

Leave the front-matter (`status: accepted`, `superseded-by:` empty) and every existing line untouched.

---

## Steps

- [ ] **Re-verify the seam first.** `git log --oneline -8`, then read the CURRENT bytes of all eight targets: `src-tauri/src/bin/fake_worker.rs` (`:43-52`, `:88-110`, `:126-164`, `:680-720`), `src-tauri/src/agent/worker/manager/tests/mod.rs` (`:152-166`, `:1191-1292`), `manager/mod.rs` (`:57-61`, `:146-152`, `:186-205`), `manager/subagent_flow.rs` (`:815-905`), `src/config.rs` (`:317-328`), `CONTEXT.md` (`:106-110`), `docs/features/subagent-sessions.md` (`:150-160`), `docs/decisions/0055-*.md` (whole file), plus `docs/decisions/0038-*.md` and `docs/decisions/0036-*.md` for the amendment format. If T10/T11 already reworded any of these, apply the intent and note it.
- [ ] **Measure the BASELINE at this HEAD before changing anything** (the parent doc's figures are stale — T7 landed after them): from `src-tauri/`, `cargo test 2>&1 | tail -20` and record the exact `N passed; 0 failed; N ignored`. This task adds NO test, so the final count must equal this number exactly.
- [ ] **Implement §1** (the fixture) and §2 (the tests).
- [ ] **Run `cargo test --lib -- --exact agent::worker::manager::tests::a_streaming_subagent_outlives_the_dead_bound`** — did it PASS, and did the reported `duration_ms` land near 3000 (not 1500)? If it passed at ~1500 ms the fixture change did not take effect — stop and investigate (the `fake_worker` binary is rebuilt by `cargo test`; `target/debug/fake_worker` is what the tests spawn).
- [ ] **Run `cargo test --lib -- --exact agent::worker::manager::tests::a_child_inside_a_tool_call_is_never_reaped`** — PASS, with `duration_ms` near 3000 (the 3.0 s hold) and not near 1500?
- [ ] **MUTATION PROBE — this is this task's RED step.** AGENTS.md wants failing-test-first; here the artefact IS the test, so prove its teeth by restoring the old bug for one run. The pre-ADR 0055 drive had TWO missing halves — the rearming AND the `in_flight` guard — so the probe has two mutations, and each reddens a different test. Work in `subagent_flow.rs`'s `drive_subagent` only.
  - **Mutation A (no rearming)** — three edits: (1) `let mut deadline;` → `let deadline;`; (2) insert `deadline = std::time::Instant::now() + dead_bound;` immediately BEFORE `let race = loop {`; (3) delete the in-loop line `deadline = std::time::Instant::now() + dead_bound;` (leave its comment, reworded to say the value is now armed once). The `sleep` is still rebuilt each pass, so it re-arms against a FROZEN absolute deadline — exactly the old one-shot semantics.
    - Run both liveness tests. **`a_streaming_subagent_outlives_the_dead_bound` MUST FAIL with `Failed { reason: Unresponsive }` and a truncated `output`** (~half the chunks) — the streaming scenario has no `tool_call_id` outstanding, so the `if !in_flight` guard never helps it. `a_child_inside_a_tool_call_is_never_reaped` is EXPECTED TO STAY GREEN under A: the guard at `subagent_flow.rs:910` disables the sleep arm while `t1` is outstanding, so freezing the clock alone cannot reap an in-tool child. **That asymmetry is the point** — it is the proof the two halves of ADR 0055 are separate guarantees, and it is why the in-tool test's teeth come from mutation B.
  - **Mutation B (no guard, on top of A)** — additionally delete `, if !in_flight` from the sleep arm (`_ = &mut sleep, if !in_flight => break Race::Dead,` → `_ = &mut sleep => break Race::Dead,`). Now **`a_child_inside_a_tool_call_is_never_reaped` MUST FAIL with `Failed { reason: Unresponsive }`** — the frozen 1500 ms sleep expires inside the 3.0 s silent hold while `in_flight` holds `t1`, which is the pre-ADR 0055 shape the test's doc comment describes.
    - If you prefer the historical shape exactly, run B WITHOUT A (delete only the guard, keep the in-loop recompute): the rearming does not help an in-tool child either, because the announce is the only frame the child sends during the hold, so the arm still expires. Either way the in-tool test must go RED.
  - If a named test PASSES under its own mutation, the widened bound has lost its teeth: STOP, do not proceed, and report which test and what `duration_ms` / `output` it reported.
  - Then `git checkout -- src-tauri/src/agent/worker/manager/subagent_flow.rs` (adjust the path to your cwd) and confirm `git diff --stat` shows `subagent_flow.rs` clean apart from the §4 comment you will now apply. **Never let a mutation reach the commit.** (By reading, not by running: no other test in the module is sensitive to these two mutations — every other site injects a bound either far LONGER than anything it waits for (the eleven 30 s sites) or far SHORTER than its fixture's 10 s silence (`a_silent_child_with_nothing_in_flight_hits_the_dead_bound`'s 1 s, `every_failure_path_carries_the_partial_output_and_real_usage`'s 400 ms), so each resolves the same way either way. Run only the two named tests under the probe; the full `cargo test` below is what proves that claim.)
- [ ] **Apply §3, §4, §5, §6, §7, §8** (the wording: two Rust doc comments, the drive's clock comment, the setting doc, the glossary, the feature doc, the ADR amendment). Then `grep -rn "UNEXPLAINED SILENCE" src-tauri/src CONTEXT.md docs/features docs/decisions` — exactly four hits today (`CONTEXT.md`, `manager/mod.rs`, `subagent_flow.rs`, `config.rs`) and after this change every one of them must carry the OBSERVED qualifier in its sentence. (`docs/roadmap/` is deliberately excluded: the plans and this doc quote the OLD wording as evidence, and a roadmap doc is deleted on ship.)
- [ ] **Determinism, 10× back-to-back, on the FINAL tree** (from `src-tauri/`; the first run pays the rebuild, the rest reuse it). Cargo's own `finished in …` line is the primary measurement — it excludes process startup — with the outer wall clock beside it. Portable bash (macOS `date` has no `%N`, and the person re-running this may be on the platform that flaked):

      for i in $(seq 1 10); do
        s=$SECONDS
        cargo test --lib -- --exact \
          agent::worker::manager::tests::a_streaming_subagent_outlives_the_dead_bound 2>&1 \
          | grep -E "test result|finished in"
        printf 'run %2d  wall %ds\n' "$i" "$((SECONDS - s))"
      done

  Report all ten lines. Required: 10/10 pass; every `finished in` within ~0.5 s of the median; every run well under 6 s. Then repeat the loop for `…::a_child_inside_a_tool_call_is_never_reaped` and report those too.
- [ ] **Load probe (the local proxy for the macOS runner that flaked).** Saturate the box and run the whole module concurrently, which is the shape CI has:

      seq 1 8 | xargs -P8 -I{} sh -c 'timeout 30 yes > /dev/null' &
      cargo test --lib agent::worker::manager::tests 2>&1 | tail -5
      wait

  The `timeout 30` bounds the load so a forgotten background `yes` cannot follow the next step. Required: the module is GREEN under load. If a liveness test reddens HERE, the margin is still too thin — report it as BLOCKED with the observed `duration_ms` and frame count rather than lowering the bound back. If a test that asserts the bound DOES fire (`a_silent_child_with_nothing_in_flight_hits_the_dead_bound`, `every_failure_path_carries_the_partial_output_and_real_usage`) or one of the 30 s-bound tests reddens under load instead, that is a DIFFERENT pre-existing flake this task neither causes nor fixes — record it in the report and in the follow-ups doc, do not widen anything for it.
- [ ] **Run `cargo test`** from `src-tauri/` (full — this task is serial and the crate is one compilation unit). Required: **exactly the baseline count measured above**, 0 failed, same ignored count. If the count moved, something was added or deleted that this plan did not authorise.
- [ ] **Run `cargo clippy --all-targets -- -D warnings`** — 0 warnings. Watch for: an unused-import if you replaced the only `Duration::from_millis` call in a scope (`Duration` is still needed by the new const, so it should not fire); `clippy::approx_constant` is not in play.
- [ ] **Run `cargo fmt --all`** then `cargo fmt --all -- --check` — exit 0.
- [ ] **Run `pnpm test` and `pnpm build`** from the repo root — no frontend file changed, so the figures must be UNCHANGED from the parent doc's current numbers (3051 tests / 149 files at the time of writing; re-measure and report). `pnpm build` exit 0.
- [ ] **`git diff --stat`** must list EXACTLY the eight files in §Files and nothing else. Commit with exactly:

      test(worker): 10x margin on the streaming-subagent liveness test, and the silence bound says OBSERVED (#34)

  Commit body must state: the 3× → 15× arithmetic, the 1500 ms bound vs the ~700 ms measured observation stall, that `IN_TOOL_HOLD` doubled so the in-tool test keeps its teeth, that production logic is UNCHANGED, the mutation-probe result (which tests went RED and with what), and that no test count changed. Do NOT stage `docs/roadmap/issue-triage-backlog-status.md` — the orchestrator marks T12 `done` and writes the Changelog line.

---

## Acceptance criteria

- [ ] Both `a_streaming_subagent_outlives_the_dead_bound` and `a_child_inside_a_tool_call_is_never_reaped` inject `LIVENESS_DEAD_BOUND` (1500 ms) — `grep -n "make_manager(Some(Duration::from_millis(300)))" src-tauri/src/agent/worker/manager/tests/mod.rs` returns NOTHING. (Do NOT grep for a bare `from_millis(300)`: `:493` and `:1423` are unrelated teardown sleeps that this task leaves alone, and they would false-fail the check.)
- [ ] The fixture's legitimate turn is at least TWICE the injected bound in both scenarios: `LONG_STREAM_CHUNKS = 30` (30 × 100 ms = 3000 ms) and `IN_TOOL_HOLD = 3000 ms`.
- [ ] The duration floors moved to `>= 2000` in both tests, and both tests' reported `metrics.duration_ms` lands near 3000 (not near 1500) — the proof the child still runs past the bound rather than winning a race.
- [ ] **Teeth proven, not claimed:** mutation A (arm the clock once, never rearm) makes `a_streaming_subagent_outlives_the_dead_bound` fail with `Failed { reason: Unresponsive }` and a truncated `output`, and leaves the in-tool test GREEN; mutation B (also drop the `if !in_flight` guard) makes `a_child_inside_a_tool_call_is_never_reaped` fail with `Failed { reason: Unresponsive }`. Both mutations are reverted before the commit and `subagent_flow.rs`'s diff is comment-only.
- [ ] The streaming test's panic text names OBSERVATION latency as the FIRST suspect, explicitly withdraws the accusation that ADR 0055's fix did not land, points at the frame-count-in-`output` diagnostic, and quotes the bound from `LIVENESS_DEAD_BOUND` rather than a second hard-coded number.
- [ ] The in-tool test's panic text points at the same note, and its doc comment states that its load exposure is the cold-start announce window, not the hold.
- [ ] Every doc that states what the bound measures now says OBSERVED: `DEFAULT_SUBAGENT_DEAD_BOUND`, the `dead_bound` field, `drive_subagent`'s clock comment, `subagent_dead_bound_secs`, `CONTEXT.md`'s **Dead bound** entry, `docs/features/subagent-sessions.md`'s §"Liveness: Active vs Dead", and ADR 0055 via an appended amendment. `grep -rn "UNEXPLAINED SILENCE" src-tauri/src CONTEXT.md docs/features docs/decisions` shows no unqualified claim left.
- [ ] ADR 0055's body is byte-unchanged above the appended block; its front-matter keeps `status: accepted` and an EMPTY `superseded-by:`; the amendment follows 0038/0036's blockquote format and names the rejected second-confirmation option rather than dropping it.
- [ ] Production behaviour is provably unchanged: `git diff` contains NO logic edit — `subagent_flow.rs`, `mod.rs` and `config.rs` diffs are comment-only, and `pump.rs` / `client.rs` / `core.rs` / `protocol.rs` / `session/mod.rs` are untouched.
- [ ] Determinism measured: 10/10 passes each for both tests back-to-back, spread reported (≤ ~0.5 s), and `agent::worker::manager::tests` GREEN under an 8-way `yes` load.
- [ ] Gate green: `cargo test` at the EXACT baseline count / 0 failed / same ignored, `cargo clippy --all-targets -- -D warnings` 0 warnings, `cargo fmt --all -- --check` exit 0, `pnpm test` unchanged (3051 / 149), `pnpm build` exit 0. No `Cargo.toml` / `Cargo.lock` / `src/**` change.
- [ ] Suite cost stated in the report: ≈ +3.0 s total, both tests ~3.5 s each. `__long_stream__` and `__in_tool__` each have exactly ONE caller (the two liveness tests) and no integration test names either mode. Re-confirm with `grep -rn "__long_stream__\|__in_tool__" src-tauri/src src-tauri/tests`: at HEAD that is 10 hits — 2 call sites in `manager/tests/mod.rs` (`:1212`, `:1265`) and 8 in `src/bin/fake_worker.rs` (two module-doc bullets `:43`/`:49`, three const docs `:90`/`:96`/`:101`, `emit_long_chunk_stream`'s doc `:132`, and the two `match` arms `:692`/`:704`). All ten are inside the two files this task owns, so none of them is an external consumer to protect.

---

## Residual risk, recorded honestly

This task turns a 3× margin into 15× on cadence and ~2.1× on the ~700 ms observation lag the one recorded failure implies. It does **not** make either test deterministic, and no margin does: the flake's root cause is that the silence clock reads frames the parent OBSERVED, and the parent is a real task on a loaded machine. If a runner ever stalls the observation chain for more than 1500 ms these tests redden again — and after this change their panic text will say so, and the mutation probe will still catch a genuine regression. That is the accepted trade; it is written into the const's doc so the next reader does not re-derive it from a red CI run.

## Follow-ups — hand these to the loop's follow-ups doc (do NOT fix here)

1. **Second-confirmation reaping (issue #34 option 3).** Require two consecutive expired deadlines (or a bounded grace beside `PUMP_EXIT_GRACE`, which already exists for the pump-exit race) before declaring `Unresponsive`. Turns a transient observation stall into a non-event in test AND production — the only change that makes these tests deterministic. Invasive to `drive_subagent`'s race for a 30-minute default at 0.04% exposure; deliberately not this task.
2. **A deterministic liveness seam.** `feed_capture` / `note_liveness_frame` / `SubagentLiveness` are already `#[cfg(test)]`-exported (`manager/mod.rs:42-46`) and existing tests poke them directly (`every_frame_bumps_the_liveness_seq`), but the race LOOP is only reachable through a real spawn. Extracting the loop behind a seam that a test can drive with a `liveness_tx` and a virtual clock would let the rearm invariant be asserted with zero wall-clock race. That is the real fix for "assert the invariant without a race" (issue #34 option 2, in the form the fixture knob could not take).
3. **Stale module paths after the `manager.rs` → `manager/mod.rs` split.** `src-tauri/src/agent/worker/manager.rs` no longer exists, yet 10+ comments still cite it: `src/components/SubagentModals.tsx:45,111`, `src/components/SubagentTranscript.tsx:55`, `src/lib/tauri/types.ts:347,374,409`, `src/store/subagents.ts:64`, `src/hooks/useChildGates.test.ts:185`, `src/hooks/useAttentionAlert.ts:242,253`, and `docs/features/subagent-sessions.md:102`. A docs-only sweep; deliberately not folded into a test-hardening commit.
4. **A machine-pinned guard on the liveness panic text.** A source scanner (the `childproc.rs` census / `subagentSheetLayout.test.ts` prose-scan pattern) could assert the message still names observation latency first. Rejected here as a brittle gate on prose whose job is human legibility; recorded so the option is not lost.
