# Codebase Improvement Report — 2026-10-30

**Scope: both trees, Rust-weighted** (the operator's choice at scan-design time). The Rust backend was
last audited 2026-10-19 and the frontend 2026-10-22; **116 commits** have landed since the latter
(the permissions rule model, agent-definition permissions, per-call cost, compaction-continues,
temp-dir ownership, multi-wire providers).

## Summary

**20 findings across 8 categories. 6 high, 11 medium, 3 low.**

The headline is not size. It is that **the two newest invariants the repo wrote down — ADR 0080
(latch the completion fact before you kill) and ADR 0045 (overflow is recovered in the turn, never
ladder-retried) — are each satisfied in exactly one of the places they apply.** `bash.rs` latches
`pipes_held`; the elevated path has zero occurrences of the concept and fabricates `exit_code: 124`.
Anthropic classifies a mid-stream SSE `error`; the OpenAI-completions parser has **no error arm at
all** and the Responses parser emits a bare terminal `Done(Error)`, so on 2 of 3 wires an in-stream
overflow is ladder-retried 4× — which is the thing ADR 0045 exists to forbid. Both are copies of one
rule where one copy got the ADR and the sibling did not.

The second theme is **three seams where the type and the wire disagree**: `compaction_reason` is a
`&str` whose behaviour keys off `reason == "overflow"` in two places with a silent TS `default`;
`ToolResult.details` is an untyped `Value` envelope that has ALREADY drifted out from under its
reader once (recorded, follow-ups §4) and has three TS fields with no Rust producer; and
`metrics_json` hand-builds a camelCase twin of a struct whose own `Serialize` derive is live on a
*different* wire, so a new field compiles and silently never crosses.

The third is **unowned substrate under the newest code**: `pump.rs` and `registry.rs` (the pump owns
ADR 0055's liveness routing and a `Lagged` arm that drops frames) have zero direct tests, and
`mcp/http.rs` is the largest genuinely-untested production file in the crate at 571 code lines.

Measured baseline (verified at `01dafc8`; the source is byte-identical at HEAD `3a2779d`, which is a
version bump only):

| | files | code lines |
|---|---|---|
| Rust production (excl. inline `#[cfg(test)]` and `tests/` dirs) | 133 | **26,432** |
| Rust inline `#[cfg(test)]` test code | — | **37,031** (1.40× production) |
| Rust code inside sibling `tests/` dirs | 27 files | 15,185 |
| Frontend production (non-test `.ts`/`.tsx`) | 216 | 22,664 |
| Frontend tests | 154 | 49,756 (2.2× production) |

**The Rust "largest files" ranking is mostly a test-size ranking, and that is a finding** (17). The
production ranking is `agent/session/mod.rs` 1,286 · `storage/db.rs` 839 ·
`worker/manager/subagent_flow.rs` 751 · `mcp/oauth.rs` 613 · `harness/loop.rs` 568 ·
`mcp/manager.rs` 560 · `provider/anthropic.rs` 538 · `normalize.rs` 526. `harness/launch.rs`
(baseline 1,668) is **188 production lines** and is not a size problem.

## Context

- **CONTEXT.md**: loaded (329 lines). **No `## Engineering Rules` section** — the 200-code-line
  default holds. Its `_Avoid_` lists were treated as binding naming rules (findings 14–16).
- **ADRs**: 76 exist in `docs/decisions/` (this repo uses `docs/decisions/`, not `docs/adr/`).
  Most-cited here: 0080 (pipe-held completion), 0045 (overflow in-turn), 0046 (cache-inclusive
  input tokens), 0082 (per-call cost from the body), 0025 (worker processes, sole SQLite writer,
  crash attribution), 0055 (liveness at tool boundaries), 0030/0081/0083/0084 (file access +
  permission layers), 0049 (incarnation stamp), 0075 (list position is not evidence), 0063 (IPC
  error envelope), 0013 (skills desktop-owned), 0024/0026 (multi-wire providers).
- **Plans reviewed**: 3 in `docs/roadmap/` (`frontend-component-extraction-follow-ups.md`,
  `compaction-recovery-hardening-follow-ups.md`, `issue-91-fetch-hidden-window-follow-ups.md`).
- **Prior audits**: 2026-10-22 (frontend, 18 findings — all approved, shipped as the Phase A–D
  program), 2026-10-19 (Rust), 2026-10-04. The 102 items of prior findings were treated as
  out-of-scope unless this scan found them **regressed, diverged, or re-caused**.
- **Explicit non-goals honoured** (not re-reported): the `store/sessions.ts` split; `ui/badge.tsx`
  retention; `lib/update.ts`/`lib/version.ts` outside the barrel; `RowButton`'s deliberate
  non-`cn()`; the D5 glossary renames; `SubagentDelegatingCard`'s `details.progress` reader.

## Verification note — read this before quoting any number below

**Six scan claims did not survive verification, and three were corrected upward.** Every figure in
this report is one I re-ran at HEAD. The corrections are load-bearing, so they are in the body, not
an appendix:

| Scan claim | Actual | Effect |
|---|---|---|
| "50 `#[tauri::command]` vs 47 registrations — find the 3-command delta" | **47 / 47, 1:1.** The 4 extra greps were doc-comment backtick mentions (`config.rs:3`, `settings.rs:1`, `spaces.rs:184`, `history.rs:334`); the 48th `commands::` line in `lib.rs` is `install_gtk_bridge(app)`, not a command | Finding 8 has no inverse half. Also: this is the repo's own recorded trap (a comment reads as a consumer) biting a scan |
| "`get_stalled_info` is dead, delete it" | It has a **live integration test** (`tests/ipc.rs:166,520`) and is named in **ADR 0025's 2026-10-18 amendment** ("the pushed event and the pulled `stalled_info` can no longer name different files") | Finding 8 becomes a decision, not a cleanup. Silent deletion would desync an accepted decision |
| "`SubagentMetrics` derive is dead; add `rename_all` and delete the twin" | The derive is **live on the Supervisor→Worker wire** (`Inbound::SubagentResult` at `protocol.rs:97`). Renaming the struct renames that wire and hangs every parent tool call | Finding 6's proposal changed to a derived `MetricsWire` type |
| "`spaces.last_opened_at` has zero readers" | The store **writes** it on every open (`sessions.ts:1110,1122`); ~40 tests construct it. What is dead is *rendering*, and the **prose** is stale | Finding 13 narrowed from "delete the column" to "fix the fixture's false rationale" |
| "the `ToolCallContent`/diff channel is dead code" | The **frontend pipeline is live end-to-end** (`reducer.ts`, `DiffBlock`, `identity.ts:67`, `unitKeys.ts:15`, `FileSummaryCard`, `ChangesGroupCard`, `SubagentTranscript`). Only the **Rust producer** is dead | Finding 9 reframed: forward-compat surface with no written retention decision |
| "no clock seam anywhere → time is untestable" | `crashlog.rs` tests already forge age with `File::set_modified` (`:654-667`, stable since 1.75, no new dep) and have **5 prune tests**; `oauth.rs:66 is_expired(&self, now: i64)` already takes `now` | Finding 10 downgraded from High to Medium; the remaining gap is narrower than claimed |
| "`usePrefersReducedMotion`'s doc omits one copy" | Confirmed, and worse: the doc's *"its only other copy"* claim was **false in the commit that wrote it** (`QueueRow`'s copy is 11 hours older) | Finding 18 raised to Medium/High |

Two scan outputs (lenses 3–6) returned partially garbled and were **re-derived from the files before
use**. One reviewer's severity for the cost-extraction divergence was accepted downward: the
"first-wins vs last-wins" split is *within* the Anthropic parser's two usage objects, not between
parsers — see finding 1's non-finding note.

---

## Findings

### 🔴 High Severity

#### 1. The OpenAI-completions parser has no `error` arm, so an in-stream auth failure becomes 4 doomed retries and ADR 0045's overflow recovery is unreachable on 2 of 3 wires
- **Lens:** DRY Violations (one rule, three copies, three behaviours)
- **Files:** `src-tauri/src/agent/harness/provider/openai.rs:SseStream::handle_chunk`,
  `provider/anthropic.rs:401`, `provider/responses.rs:313`, `agent/harness/loop/turn.rs:255`,
  `agent/harness/retry.rs`, `provider/transport.rs:map_status`
- **Severity:** High · **Confidence:** High
- **Problem.** Three parsers, three different answers to "the stream carried an `error` object":
  - `anthropic.rs:401` → `ProviderEvent::Error(map_anthropic_error(v))`, four tiers, overflow
    detected first (`is_context_overflow_text` runs before the `kind` match).
  - `responses.rs:313` → a bare terminal `Done(FinishReason::Error)`, no tier. Documented as
    deliberate ("the `error` object has no stable `type` taxonomy").
  - `openai.rs` → **no arm exists.** `handle_chunk` reads `usage`, then
    `let Some(choice) = v.get("choices")… else { return; }`, so a `data: {"error":{…}}` chunk
    matches nothing and is discarded in silence.

  The discarded chunk then becomes a *fabricated* diagnosis. When the gateway closes the stream,
  `poll_next` synthesises `Done(FinishReason::Error)`, and `turn.rs:255` converts it:
  ```rust
  if mid_stream_error.is_none() && acc.finish == Some(FinishReason::Error) {
      mid_stream_error = Some(ProviderError::Retryable(
          "the model stream ended without a finish_reason".to_string()));
  }
  ```
  `retry.rs` has `DEFAULT_MAX_ATTEMPTS = 5`, `base = 1s`, doubling: so an
  `authentication_error` is re-issued **4 more times** (1s/2s/4s/8s backoff, 15s of paid round trips
  against a key that cannot become valid), then settles with the fabricated string. The real
  diagnosis never reaches an event, a log line, or the user. On the Anthropic wire the same gateway
  response is `ProviderError::Auth` → returned verbatim, **one call**, and the settings UI keys off
  the auth tier.

  The overflow half is worse because it contradicts an ADR. `retry.rs`'s own test
  `context_overflow_is_never_retried` pins the rule ADR 0045 states — an overflow must be compacted
  in the turn, never ladder-retried. `anthropic.rs:101` states the consequence outright: *"the only
  place a mid-stream `ProviderEvent::Error` is built, so without it nothing could ever produce a
  mid-stream overflow and the loop's mid-stream recovery arm would be dead code."* It is dead code
  on the other two wires. A gateway that accepts the request and then reports *"prompt is too long"*
  inside the stream gets 4 ladder retries of the same oversized bytes and a `settle_error`. (The
  HTTP-status path — `transport.rs:59` `map_status` → `ContextOverflow` — is alive on all three
  wires, so ADR 0045's headline mechanism is not dead; only its mid-stream variant is, and only
  where the wire is OpenAI-shaped.)
- **Proposal.** Do **not** build a `ProviderStream` abstraction: the `handle_chunk` bodies are not
  factorable (Anthropic and Responses dispatch on `event:` tags, completions is a positional
  `usage`-then-`choices[0].delta` walk with the issue-#122 sanitize-placeholder hold interleaved),
  and the `poll_next` tails diverge deliberately. Instead follow the precedent `provider/types.rs`
  already sets with `cost_usd_from_usage` — a shared reader of a `Value` each parser already holds:
  1. Lift `map_anthropic_error`'s body into `provider/types.rs` as the one classifier (it already
     has ADR 0045's ordering and the overflow text check); expose
     `parse_error_chunk(&Value) -> Option<ProviderError>`.
  2. `openai.rs::handle_chunk`: check it **before** the `choices` deref; on `Some`, flush held text,
     set `exhausted`, push `ProviderEvent::Error(e)`.
  3. `responses.rs:313`: keep the terminal-only behaviour for unclassifiable bodies, but let
     `ContextOverflow` and `Auth` upgrade to a real tier. Update `responses_sse_error_event` (which
     currently *pins* the divergence).
  4. Add the missing completions-wire parser test — `openai.rs` has 19 `sse_*` tests and **zero**
     that feed an error chunk; `anthropic_sse_auth_error_event` is the template. Every loop-level
     mid-stream test injects `ProviderEvent::Error` through `ScriptedProvider`, so none can catch a
     parser-side swallow.
  5. After 2–3, `turn.rs:255` fires only when no error event existed — the correct population for
     the retryable conversion. Say so in a comment.
  - **Not a finding, checked:** the cost-extraction split. `anthropic.rs:428 record_cost` is
    last-non-`None`-wins across **its own two** usage objects (`message_start` + `message_delta`,
    genuinely distinct); `openai.rs:367` and `responses.rs:357` have exactly one read site each,
    gated by an exactly-once latch. Different read patterns, each sound. The only theoretical gap is
    a gateway that puts cost on a mid-stream usage chunk and never on a terminal one — worth a
    comment, not a mechanism.

#### 2. The elevated-command path implements none of ADR 0080: a pipe-held success is reported as "command was killed" with a fabricated `exit_code: 124`
- **Lens:** Inconsistent Patterns (the same completion question, three answers)
- **Files:** `src-tauri/src/agent/interactive/sudo_exec.rs:run_sudo_real`,
  `agent/interactive/mod.rs:588-598`, contrast `agent/tools/exec/bash.rs:333,395,559`
- **Severity:** High · **Confidence:** High on the mechanism, Medium on live reachability
- **Problem.** ADR 0080's rule is *"never report an outcome you did not observe."* `bash.rs` obeys it
  by latching the fourth fact above the kill gate —
  ```rust
  let pipes_held = stdout_open || stderr_open;          // bash.rs:333
  …
  let (exit_code, is_error, note) = bash_exit_report(cancelled, timed_out, status, pipes_held);  // :395
  ```
  with the R1 arm `if pipes_held && code == Some(0) && signal.is_none()` at `:559`.
  `grep -c pipes_held` → `sudo_exec.rs`: **0**, `interactive/mod.rs`: **0**.

  The sudo path reads the status inside
  `tokio::time::timeout(timeout_ms, tokio::join!(read_stdout, read_stderr, child.wait()))`, so the
  status arm cannot retire independently: a grandchild holding the pipe end keeps `read` pending, the
  timeout cancels the whole join, and **the observed status is discarded with it**. `:283` then
  reports `exit_code: 124, timed_out: true`, and `interactive/mod.rs:588` renders *"timed out after
  {timeout_ms}ms — command was killed"* with `is_error: true`. `124` is a real `timeout(1)` exit code,
  so it is indistinguishable from a genuine kill. `exit_code: -1` appears at `:108,150,193,252` and
  `status.code().unwrap_or(-1)` at `:266` — five more sentinels where the bash path bans them.

  What hides: a model told a successful privileged command was killed re-runs it. ADR 0080's own
  evidence for why that matters is *"three blind retries in one session"* — here with elevated
  privileges and a non-idempotent command.
- **Proposal.** Port the bash shape: read the pipes in a cancellable way that **does not cancel the
  `wait()`**, latch `pipes_held` before any group kill, and route the result through
  `bash_exit_report` (or a shared `exec_exit_report` — the classifier is already the fourth fact's
  owner, so it should be shared, not copied a third time). Then delete the `-1`/`124` sentinels.
  Also decide the ADR question: read ADR 0080's scope statement — if it scoped only `bash`, this is
  an **amendment** naming the elevated path, not just a bug fix, and the amendment is what stops a
  third exec path repeating it.

#### 3. `WorkerHandle::kill()` re-reads `Child::id()` while the same struct carries a captured `pid` whose doc forbids exactly that
- **Lens:** DRY Violations (four negative-pid group kills, two pid policies)
- **Files:** `src-tauri/src/agent/worker/client.rs:WorkerHandle::kill` (`:722-735`) vs its own
  `pid` field doc (`:157-163`); `agent/tools/exec/bash.rs:kill_bash_process_group`;
  `agent/interactive/sudo_exec.rs:kill_process_group_and_reap` vs `SudoGroupGuard`
- **Severity:** High · **Confidence:** Medium-High
- **Problem.** The field's own doc states the rule:
  > *"The child's pid, captured at spawn (`Child::id()` right after `cmd.spawn()` succeeded) and
  > NEVER re-read: `Child::id()` returns `None` once tokio has reaped the child (`FusedChild::Done`)
  > — the exact state a crash leaves behind — so the LAST KNOWN value is what a crashed Worker's
  > attribution has to work from."*

  `bash.rs` implements it that way, with the same reasoning in its comment. `WorkerHandle::kill()`
  does the forbidden thing while `self.pid` sits one method away, used only by the `pid()` accessor:
  ```rust
  if let Some(pid) = guard.id() {
      let _ = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
  }
  ```
  On the reap-ordered path — the crash path the field exists for — `guard.id()` is `None`, the group
  SIGKILL is skipped, and only `guard.kill().await` runs, which kills the direct child and not the
  group. `SudoGroupGuard` carries `pid: Option<u32>` and is immune; `kill_process_group_and_reap`
  reads live and is not.

  Note the doc-comment at `:717-721` claims the whole group is SIGKILLed, so this is also a comment
  asserting coverage that the code does not provide — a reviewer reading the doc will not look.
- **Proposal.** Use the latched `self.pid` for the group kill and keep `guard.kill().await` as the
  direct-child fallback; add the same latched-pid treatment to `kill_process_group_and_reap`. Then
  count the four independent group-kill implementations and put them behind one owner (check what
  `agent/childproc.rs` already owns — it exists and covers `kill_on_drop`/hide-window policy, so the
  seam is established). Pin with a test that a handle whose child is already reaped still issues the
  negative-pid kill.

#### 4. `compaction_reason` is a `&str` across six layers; the overflow behaviour keys off a string compare and a fourth reason is a silent no-op in two places
- **Lens:** Weak Abstractions
- **Files:** `agent/harness/loop.rs:99,967,982`, `loop/turn.rs:103,122,300`, `agent/events.rs:147,151`,
  `src/lib/tauri/types.ts:255`, `src/store/sessions.ts:529`, `src/lib/toolOutput.ts:113-121`
- **Severity:** High · **Confidence:** High
- **Problem.** The vocabulary `manual | threshold | overflow` is a `&'static str` in Rust, a `String`
  on the event, a bare `string` in TS with the vocabulary demoted to a comment
  (`/** "manual" | "threshold" | "overflow" (ADR 0045's vocabulary). */`), and a `Record<string, …>`
  in the store. Behaviour hangs off two string comparisons —
  ```rust
  let overflow = reason == "overflow";                   // loop.rs:982
  if t.reason == "overflow" && ran == CompactionRan::Skipped   // turn.rs:122
  ```
  and `toolOutput.ts` has a `switch` with three `case` arms and a silent `default: return undefined`.
  Add a fourth reason and `run_compaction` loses its actionable `error_message` and the card loses
  its subtitle, with nothing failing to compile or test.

  The team has already demonstrated it knows better: the sibling `CompactionRan` is a real enum and
  its doc records the cost of getting this wrong — *"Collapsing both into one boolean is what made an
  overflow recovery abandon a turn it should have re-issued (issue #90)."* The trigger beside the
  result is the untyped half of the same pair.
- **Proposal.** `pub(crate) enum CompactionReason { Manual, Threshold, Overflow }` with
  `#[serde(rename_all = "snake_case")]` so the wire strings are byte-identical and `normalize.rs`
  and every TS reader are unchanged. Name per CONTEXT.md's **compaction reason** entry, whose
  `_Avoid_` bans `context_limit`, `trigger`, `cause` and "auto vs manual". Change sites: `loop.rs`
  (5), `turn.rs` (3), `events.rs` (2), tests (`compaction_overflow.rs` 9 set/compare sites,
  `worker/core.rs` 1, `protocol.rs:958`'s fixture still uses the retired `"context_limit"` string);
  TS: `types.ts` union (makes a typo a compile error at the 12 frame-construction sites),
  `toolOutput.ts`'s switch, `sessions.ts:529`. `compact.rs` needs nothing — it is reason-agnostic.
  `src/lib/ipc/events.ts`'s ban on a Rust↔JS parity grep does **not** constrain this: it is scoped to
  event *names* flowing dynamically through the sink, and this is a value vocabulary inside one
  frame, which is exactly the shape that file endorses being pinned by tests on each side.

#### 5. `ToolResult.details: Option<Value>` — a UI envelope with no type, ~28 ad-hoc shapes, one recorded drift, and three TS fields no Rust code produces
- **Lens:** Weak Abstractions
- **Files:** `agent/tools/types.rs`, `agent/harness/dispatch.rs`, `agent/web/tools.rs` (12 sites),
  `agent/interactive/mod.rs` (12), `src/lib/toolOutput.ts`, `src/lib/subagentActivity.ts:53-56`
- **Severity:** High · **Confidence:** High
- **Problem.** `pub details: Option<Value>`, written by 19 `details: None` and ~28
  `details: Some(json!({...}))` sites that each invent a shape on the spot — `{"error":…}`,
  `{"operation":"read","todos":…}`, `{"skills": n}`, `{"path":path,"lines":0}`,
  `{"responseId":…}` — ~10 distinct shapes, no enum, no serde contract. It is read by exactly one
  production Rust site (`interactive/mod.rs:816`, which copies it verbatim) and by 8 TS functions
  doing free `Record<string, unknown>` reads over ~30 field names.

  This seam has **already failed once**, and the repo wrote it down —
  `docs/roadmap/frontend-component-extraction-follow-ups.md` §4: *"The card's whole child-linking
  chain reads `details.progress` / `details.results` off the tool result. No current backend path
  emits either … The chain is dead against today's transport."* Re-verified: zero `"progress"` keys
  in Rust production. And the same drift is still running: `subagentActivity.ts:53-56` reads
  `cacheRead`, `cacheWrite`, `turns` — three fields with **no Rust producer** — and
  `subagentActivityFor` (`toolOutput.ts:465`) has zero callers, prod or in-file, because it consumes
  the dead `progress` entries.
- **Proposal.** A typed `ToolDetails` enum is *feasible* (every Rust consumer is a copy-verbatim pass
  and an untagged-with-unknown-fallback `Deserialize` covers the persisted rows §4 protects) but is
  the wrong buy: it constrains the producer while the ~30 TS reads — the side that actually drifts —
  stay unconstrained, and the dead `progress`/`results` envelope means typing nothing real. Do this
  instead: a **`details`-shape registry test** that (a) enumerates the ~10 shapes with a fixture
  each, (b) asserts the round-trip through `tool_result_response_value`, and (c) asserts the TS
  reader field-set equals the Rust producer key-set. That is the guard that makes §4-class drift
  impossible to reintroduce silently, because a producer key with no reader and a reader field with
  no producer both fail the same test. Fold the three dead TS fields and `subagentActivityFor` in.

#### 6. `AgentLoop` is 44 fields with a 22-argument constructor, and its permission cluster plus one-turn latch are two state machines written as fields
- **Lens:** Weak Abstractions
- **Files:** `agent/harness/loop.rs` (+ `loop/turn.rs`, `loop/gate.rs`, `loop/tools.rs`)
- **Severity:** High · **Confidence:** High
- **Problem.** Measured: **44 fields**, `#[allow(clippy::too_many_arguments)]` on a 22-parameter
  `new()`, 4 `Mutex` accumulators (`turn_state`, `text_acc`, `tool_state`, `thought_state`), and an
  8-field permission cluster (`file_policy`, `rules`, `default_rules`, `rules_home`, `protected`,
  `read_boundary`, `permission_block`, `enabled_tools`) that is refreshed together at one point in the
  turn and handed together to every `ToolCtx`.

  The load-bearing evidence is an apology for an invariant the type cannot hold:
  > *"Its lifetime is ONE TURN, and `handle_turn` ENFORCES that by clearing it on entry: … leaving it
  > armed would make the NEXT prompt run the canceled turn's overflow recovery (and, when that
  > compaction shrinks nothing, end the new turn as an error before its own model call)."*

  `pub force_compact: Option<CompactionTrigger>` with a manual clear-on-entry **is** a two-state
  machine; the paragraph is the compiler being told to check it. Related: `policy.rs` documents that
  `Decision::Confine` means two different things depending on whether the caller passed `is_shell`
  correctly, so for 6 of 7 policed tools that variant is unreachable and the guard is a parameter
  discipline, not a type.
- **Proposal.** Two extractions, both mechanical and both test-guarded by the existing
  `loop/tests/{turn_lifecycle,compaction_overflow,policy_gate}.rs`: (a) a `TurnControl` struct owning
  `force_compact` + `CompactionRan` with `enter_turn()` as the only way to clear it, so the invariant
  is a method; (b) a `PermissionContext` bundle with one `refresh()` and one `to_tool_ctx()`, which
  also collapses the 22-arg constructor materially. For `Decision::Confine`, make the shell-vs-path
  distinction a type (`PolicedTool::Shell{…} | Path{…}`) so the unreachable arm becomes unrepresentable
  rather than undocumented.

### 🟡 Medium Severity

#### 7. The pump owns ADR 0055's liveness routing and a frame-dropping `Lagged` arm, and neither it nor `registry.rs` has a single direct test
- **Lens:** Missing Tests / Testability
- **Files:** `agent/worker/manager/pump.rs` (208 lines, 0 tests), `agent/worker/manager/registry.rs`
  (144 lines, 0 tests), `agent/mcp/http.rs` (571 code lines, 0 tests)
- **Severity:** Medium (High blast radius, low reproduction odds) · **Confidence:** High
- **Problem.** `run_pump_loop`, `start_pump`, `unexpected_exit`, `detach_worker`,
  `get_handle_for` get **zero** mentions in the 1,890-line sibling test module — the pump is exercised
  only end-to-end through the drive task. Its `Lagged` arm is:
  ```rust
  Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
      crate::agent::debuglog::log(&format!("worker pump lagged {n} frames for session {session_id}"));
      continue;
  }
  ```
  So a dropped frame is logged and skipped, and ADR 0055's liveness is defined as *tool boundaries,
  not duration* — the pump is the sole consumer of that signal. The specific untested question is
  whether dropping the frame that would have marked a child live makes it read dead (or the reverse),
  and what `dead_bound` re-arms on after a gap. Existing tests only ever produce the benign shape.
  Separately: `mcp/http.rs` is the largest genuinely-untested production file in the crate; its
  coverage is transitive through `manager.rs`'s `TcpListener` mock, so what is asserted is manager's
  interpretation, never http's own contract (reconnect re-attaching `Authorization`, `cancel`
  aborting an in-flight request).
- **Proposal.** No production seam is needed for either. For the pump: a test that drives a
  `Lagged(n)` burst and asserts the documented salvage ("no worse than a partial salvage"), plus one
  for `Exited` arriving between `detach` and the registry write. For `http.rs`: 4-6 tests against a
  local listener covering initialize→list_tools→call_tool, the 401 branch, the token-provider
  re-attach on reconnect, `cancel` mid-request, and `response_to_result` shape variants.

#### 8. Two registered IPC commands have no caller; one is a decision, the other is ADR-backed and must not be silently deleted
- **Lens:** Dead Code
- **Files:** `src-tauri/src/lib.rs:417` (`commands::sessions::get_stalled_info`), `lib.rs:434`
  (`commands::agents::list_agent_definitions`), `commands/agents.rs:7`, `lib/tauri/types.ts:285`
- **Severity:** Medium · **Confidence:** High
- **Problem.** 47 commands are registered, 45 are invoked from JS. The two exceptions appear **zero
  times in `src/` and zero times in `dist/assets/*.js`** (verified against the shipped bundle —
  `list_agent_definitions_for_space` does ship, do not conflate them). The TS-side cleanup commit
  said so explicitly: *"the Rust commands are still registered in `lib.rs` and retiring them is a
  separate change with its own cargo gates."*

  They are **not** the same decision:
  - `get_stalled_info` is the **pull half of an accepted ADR 0025 amendment** — *"the pushed event and
    the pulled `stalled_info` can no longer name different files for one crash"* — and has a live
    integration test (`tests/ipc.rs:166,520`). Deleting it is a decision, not a cleanup.
  - `list_agent_definitions` is documented dead by its own module comment. Its security framing is
    **weaker than it looks**: the DTO is `{name, description, model, scope}` — no paths, no contents —
    and the webview can already reach `read_file_bytes(path)` and `list_space_files`. It is hygiene,
    not a vulnerability. (Worth recording separately: **CSP is `null`** in `tauri.conf.json:25` and
    `capabilities/default.json` asserts no `app:` capability, so nothing ACL-gates the command
    surface. That is a different finding's subject, and it means "the capability config bounds it" is
    not a true statement about this app.)
- **Proposal.** Order matters. **Ship today, zero-risk:** `NullHooks`
  (`src-tauri/src/test_support.rs:104` — note the path, not `agent/test_support.rs`; delete the struct
  only, the module is heavily used), `_free_port` + its lone unconditional `#[allow(dead_code)]`
  (`agent/mcp/callback.rs:256`), the `StalledInfo` TS interface + its barrel re-export + its pinned
  entry in `tauriBarrel.test.ts:300`, and `@tauri-apps/plugin-opener` from `package.json` (the **Rust**
  crate is live via `open.rs:218` — leave `Cargo.toml` and the capability entry alone). **Then:**
  `partialArgs` (emitted `normalize.rs:297`, merged at `:785`, **zero** readers; retire the emit arm,
  leave persisted rows with the inert key). **Then, as decisions:** `list_agent_definitions` (rework
  `agents.rs:476,691` or drop the app-scope read) and `get_stalled_info` (ADR 0025 amendment or keep —
  do not delete silently).
- **Systemic half.** A CI guard is **allowed here**: assert every `generate_handler!` entry name
  appears in a TS invoke string or in a Rust test that invokes it, with an allowlist whose entries
  must cite a reason. `src/lib/ipc/events.ts` forbids exactly this for **event** names, and its two
  reasons — consumer-only names, and names flowing dynamically through the sink — are structurally
  absent on the command side, where names are static literals and registration is compile-enforced.
  Read the reasoning before writing the guard, and leave rule 2 untouched.

#### 9. The `kind:"diff"` display channel has a live frontend pipeline and no Rust producer, and no written retention decision
- **Lens:** Dead Code / Coupling
- **Files:** `agent/normalize.rs:618`, `src/lib/transcript/reducer.ts:24,171,186,306`,
  `src/lib/tauri/types.ts:199,231,240`, `identity.ts:67`, `unitKeys.ts:15`, `FileSummaryCard`,
  `ChangesGroupCard:259`, `ChatStream.tsx:1201`, `SubagentTranscript.tsx:148`
- **Severity:** Medium · **Confidence:** High
- **Problem.** `grep -rn '"type": *"diff"' src-tauri/src/` → **0**, and `normalize.rs:618` says the
  ACP `content: ToolCallContent[]` channel *"has no RPC input in Phase 1"*. But the frontend side is a
  working end-to-end pipeline with its own identity, keying and rendering. So this is not dead code —
  it is forward-compat surface, and the honest problem is that **no document says so.**
  Follow-ups §4 is the nearest record and it covers a *different* surface
  (`SubagentDelegatingCard`'s `details.progress`), so anyone auditing retention finds a decision that
  does not apply here and may act as if it did.
- **Proposal.** Do not delete the pipeline. Record the decision where retention decisions live, and
  name the bound that makes it safe: every `messages` row carries `created_at`, so a `kind:'diff'`
  row can only pre-date the pi migration and is bounded in age — and note for the next reader that a
  **resume does not clear the display table** (`store.rs:226`, `db.rs:953` clear `native_messages`
  only), so those rows do survive.

#### 10. `agents.rs` and `skills.rs` are a mirrored pair with four same-named functions, and the divergence is pinned by a test instead of resolved
- **Lens:** DRY Violations
- **Files:** `src-tauri/src/agents.rs:121,247,290,611`, `src-tauri/src/skills.rs:115,232,276,756`
- **Severity:** Medium · **Confidence:** High
- **Problem.** Four same-named functions in both files — `discover_in_roots`, `space_roots`,
  `user_roots`, `parse_value` — and `agents.rs:6-9` states the relationship: *"Mirrors `skills.rs`
  (ADR 0013) structurally: the same `space_roots` walk-up, the same `home_dir` reuse, the same
  first-wins dedupe and deterministic sort."* The codebase then **formalized the right to differ**:
  `agents.rs:892` is a test named
  `the_two_parse_value_copies_diverge_where_their_parity_targets_differ`. A root-walk or dedupe fix now
  has to be applied twice, and one copy is explicitly licensed to behave differently.
- **Proposal.** Extract the shared root-discovery walk (roots + walk-up + dedupe + sort) into one
  module parameterized by the item type and scope enum; leave `parse_value` alone if the parity test
  is genuinely describing two different grammars — but then say which of the four is *not* a mirror,
  in the module doc, so the next reader does not have to run the test to find out.

#### 11. Two frontend modules each claim to be the one "when was this Session last active" rule, and they disagree on the no-transcript case
- **Lens:** DRY Violations
- **Files:** `src/lib/sessionTime.ts:relativeTimeFor`, `src/lib/sessionRecency.ts:recencyOf`
- **Severity:** Medium · **Confidence:** High
- **Problem.** Both derive from `messages[messages.length - 1]` and both doc-comments claim sole
  ownership of the question. They differ on one line:
  ```ts
  if (!latest) return null;                        // sessionTime.ts — prints nothing
  if (last !== undefined) return last.at;          // sessionRecency.ts
  return recencyMap[sessionId] ?? null;            //   …falls back to the stored stamp
  ```
  So for a stored session with no transcript loaded this boot, `sortByRecency` places the row by its
  stored stamp while `relativeTimeFor` renders an empty time slot — the list is ordered by a number
  the rows refuse to print, and a "recent" row shows nothing next to an older row showing `3h`.
- **Proposal.** `relativeTimeFor` should take the same `(sessionId, loadedMessages, recencyMap)` triple
  as `recencyOf` and call it — one rule, one fallback, with the no-cwd arm pinned by a test in
  `sessionTime.test.ts` first (that arm is exactly where the two copies already disagree, which is the
  same shape as the `sessionTitle` divergence the Phase A program fixed).

#### 12. `storage/db.rs`: 6 responsibilities in one 29-method `Db`, an 181-line `Db::open`, 9 migration gates with two transaction policies, and hand-indexed row mapping written 3× / 4×
- **Lens:** File Length + Structure
- **Files:** `src-tauri/src/storage/db.rs` (839 production / 2,253 test lines)
- **Severity:** Medium · **Confidence:** High
- **Problem.** One `impl` spanning schema+migrations, legacy backfills, session CRUD, display
  transcript persistence, provider transcript persistence, and spaces/trust/manual ordering. `Db::open`
  is **181 production lines** carrying 11 `ALTER TABLE`s, a crash-recovery `RENAME` branch and a
  FK-rewrite batch, and it is where the cost-column semantics decision physically lives (`db.rs:296`)
  next to the trust column and the sort-order seed. `SessionRow` carries 9 fields spanning 6 unrelated
  ADRs (0016, 0025, 0073, 0082) — one struct, five owners. Every schema change edits the same function,
  which makes this the repo's #1 merge-conflict surface.

  Three concrete sub-shapes, each independently worth fixing:
  - **Row mapping has no owner.** `SessionRow {` is constructed twice and `MessageRow {` three times,
    each beside its own literal `SELECT` column list — 4 coordinated edits to add one column, of which
    the compiler catches only the struct literal. A `SELECT` list edited without its `row.get(n)`
    ladder compiles and mis-maps at runtime (`cost_usd` reading `is_subagent`).
  - **9 migration gates, two policies.** Four are bare `ALTER`s; `cost_usd` wraps a *single* `ALTER` in
    an `unchecked_transaction` that protects nothing, while `todos_json` and the two `sort_order` gates
    wrap because they pair the `ALTER` with a backfill. The real invariant (ALTER + its data step in one
    tx) is convention-only, and the misleading wrapper invites the next gate to copy whichever shape it
    read last.
  - **Split tests, arbitrary line.** Both `tests/storage.rs` (15 tests) and 2,253 inline lines exist
    with the same `temp_db()` fixture shape, so a migration change must be checked against two suites.
- **Proposal.** Cheapest first, all behaviour-preserving: (a) `fn session_row_from(row: &Row<'_>) ->
  rusqlite::Result<SessionRow>` and the same for `MessageRow`/`SpaceRow`, with the `SELECT` list as a
  `const` so the list and the ladder cannot disagree — the compiler then owns the invariant; (b) one
  `fn gate(&self, table, column, add: &dyn Fn(&Transaction))` that takes the tx so the ALTER+backfill
  invariant is a signature, which also removes the misleading single-ALTER wrapper; (c) then split by
  domain (`migrations.rs`, `sessions.rs`, `transcript.rs`, `spaces.rs`) behind `Db`'s current API, and
  move the inline tests to a sibling `tests/` dir alongside `tests/storage.rs` so one suite exists.

#### 13. `agent/session/mod.rs` is the repo's largest production file and has no `SessionState` — four parallel per-session maps and five `OnceLock`s stand in for it
- **Lens:** Weak Abstractions / Coupling
- **Files:** `agent/session/mod.rs:236,499-512`, `agent/session/router.rs`,
  `agent/worker/manager/registry.rs`
- **Severity:** Medium · **Confidence:** High
- **Problem.** 1,286 production lines, 9 responsibilities (construction + 7 late-DI `OnceLock`s, a
  second builder, the `WorkerHooks` adapter, the stalled registry, per-session config/naming/live
  state, the trust read, the crash-log path, and the web-render `AppHandle`). The module admits the
  missing concept in its own comment:
  > *"There is **no backend `SessionState` enum today (session state lives in the frontend store +
  > ad-hoc flags)** — the `stalled` registry is the backend's source of truth for the crash + the
  > crash-log path."*

  What stands in for it: `config_state`, `naming`, `live`, `stalled` — four `HashMap<String, _>` keyed
  by a bare `String`, each with its own removal path, plus two more in the manager. `registry.rs`'s
  `unexpected_exit` is the cost: one question ("did this session exit on purpose?") answered by a
  two-map walk then a default. `set_cwd_registrar` and `attach_cwd_registrar` are two public aliases
  for the same late-wire, and set-once `OnceLock`s mean an unwired manager is a **silent runtime
  `None`**, not a compile error — `subagent.rs:179` documents that failure as accepted.
- **Proposal.** Introduce the `SessionState` the comment says is missing — one map keyed by session id
  holding `{config, naming, live, stalled}` behind one lock with one removal path — and let the four
  existing accessors delegate. That is the change that makes the next 200 lines of supervisor work
  cheaper; splitting the file's other responsibilities (the web-render adapter and the `WorkerHooks`
  adapter are both separable today) can follow. Also delete one of the two registrar aliases.

#### 14. Naming: the newest surfaces are named with words CONTEXT.md bans, including on user-visible copy that exists to disambiguate them
- **Lens:** Naming
- **Files:** `commands/agents.rs:list_agent_config` + `AgentConfigDto`, `commands/files/*` +
  `FileListDto`/`filesCache`, `settings/AppearanceSection.tsx:130`, `settings/GeneralSection.tsx:155,190,204`,
  `SkillsDialog.tsx:122`, `AgentsDialog.tsx:108`
- **Severity:** Medium · **Confidence:** High
- **Problem.** Re-verified counts (my scan's 139 was inflated by doc mentions; `grep -rwe` across both
  trees gives **83** for the `list_agent_config`/`AgentConfigDto`/`listAgentConfig` family):
  - `list_agent_config` / `AgentConfigDto` — **both** the **Agents** and **Agent definition** entries
    list "Agent config" under `_Avoid_`, and the DTO's own doc says *"One row of the **Agents**
    modal"*. This is the exact phrase a reader will use for the definition *file*, which really is
    config — the confusion the entry exists to kill.
  - `list_space_files` / `FileListDto` / `FileListEntry` / `filesCache` / the copy *"File listing
    capped"* — **Listing** `_Avoid_` bans "file list", "file index" and *cache* ("'cached' is a
    property of a Listing, not the thing"). The word `Listing` appears as an identifier **zero**
    times. Its sibling mode IS named from the glossary (`list_completion_entries`, `CompletionDirDto`,
    `useCompletionDir`) — two sibling mechanisms, two vocabularies, and the reader must learn they are
    the same family.
  - **User-visible copy on the two controls whose job is disambiguation:** the Palette row reads
    *"The color scheme. Dracula is dark-only — it overrides the Theme setting"* — and "color scheme" is
    banned on **both** axes. `GeneralSection` says "Notify…"/"notification" for **Attention alert**
    (banned, and `Notification` is a live Rust type in `attention/delivery.rs`) and "session names" for
    **Session title** (banned) while the setting key beside it is `sessionNamingModel`. And two copies
    of one heading print *"…hidden by a project…"* for a **Space** — banned.
- **Proposal.** See finding 15 for the authority question. The copy fixes are cheap and need no
  authority — they are string literals in 4 files with site tests only. The wire renames
  (`list_agent_config` → `list_agent_definitions_for_space`-consistent naming, `FileListDto` →
  `ListingDto`) are cheap too: a command name is **not** persisted, and neither DTO shape appears in
  a stored payload. The one thing to check before moving is that no serde field inside a persisted
  `payload_json` changes spelling.

#### 15. A whole governing layer (`definition_permission`) landed with no glossary entry, and CONTEXT.md's frontmatter list is now wrong
- **Lens:** Naming / Inconsistent Patterns
- **Files:** `agent/definition_permission.rs` (new, `6f501ab`), `agent/policy.rs`,
  `agent/harness/loop/gate.rs:58`, `CONTEXT.md` (**Agent definition** entry), ADR 0084
- **Severity:** Medium · **Confidence:** High
- **Problem.** ADR 0084 calls this *"a third governing layer beside the two `docs/features/permissions-model.md`
  already documents"*. It arrives with `PermissionBlock`, `Rules`, `Rule`, `ToolKey`, `Action`,
  `UnsupportedReason`, `FrontmatterNote` — and **CONTEXT.md has no entry for any of it**, while the
  **Agent definition** entry still enumerates the frontmatter as *`name`, `description`, `model`,
  `thinking`, `tools`*, omitting `permission`, which is now parsed, reported in the modal
  (`AgentsDialog.tsx:770`) and enforced at the gate.

  The consequence is five allow/ask/deny-shaped vocabularies with no shared name for "what a matched
  rule does": `policy::RuleDecision{Allow,Deny}` surfaced as `decision`, `definition_permission::Action`
  surfaced as `action`, `policy::Decision{Allow,Ask,Deny,Confine}`, `gate::DefinitionVerdict{Deny,Ask,
  Allow,AsSelf}` (where `AsSelf` is a third spelling of "this layer does not speak", which the
  **Agent override** entry spells as *"Field ABSENCE is the only meaning of 'this override does not
  speak'"*), and the permission prompt's `option_id` strings. `Action` is the most generic noun in the
  crate sitting beside four others.
- **Proposal.** This is the highest-value-per-minute item in the report and it is a **documentation
  fix, not an ADR amendment**: add the glossary entry (naming the layer, its direction, its
  child-only narrowing-only rule, and its relation to the other two layers), amend the **Agent
  definition** frontmatter list to include `permission`, and add one line to
  `docs/features/permissions-model.md` recording that `decision` and `action` are the same concept
  spelled two ways on two wires. Do it while the author's context is fresh; it is cheaper now than
  after the next layer lands.

#### 16. Glossary-conformance has no authority — which is why the last rename batch died, and why new code keeps drifting
- **Lens:** Naming (process)
- **Files:** `docs/roadmap/frontend-component-extraction-follow-ups.md` §6, `CONTEXT.md`, `src/lib/classNameConvention.test.ts`
- **Severity:** Medium · **Confidence:** High
- **Problem.** §6 records that D5 was deferred **not for cost but for authority**: it cited ADR 0066,
  the citation did not resolve, and no ADR actually authorizes glossary-driven renames. So today the
  glossary has `_Avoid_` lists that nothing enforces, and new code enters drift freely (finding 14's
  `AgentsDialog` hand-spelled strings are `6f501ab`, six days after the component that owns them
  shipped). There is no mechanism by which a contributor learns the rule other than reading 329 lines.
- **Proposal.** Two artifacts, both small.
  1. **The smallest ADR that unblocks conformance without reopening D5.** Decision: *identifier and
     wire names follow the CONTEXT.md term; conformance is enforced on new code and repaired on touch,
     not by sweep.* Explicit non-goal naming the five D5 renames and their measured cost (779/74,
     295/24, 147/17, 71/8) as out of scope, so the ADR cannot be read as resurrecting them.
     Consequences: a rename is a per-name decision with the reference count in its commit message;
     the guard applies to copy and to new identifiers.
  2. **A copy guard, following the `classNameConvention.test.ts` pattern** (recursive walk, strip
     comments, classify, fail with a named list, never a count — that file's own doc explains why a
     count in prose rots). A banned-term scan over user-visible strings is implementable the same way.
     Its hard part is the allow-list: the blessed exceptions are per-symbol (the **Agents** entry
     blesses four `Subagent*` names specifically), and strings that *quote* the glossary must be
     exempt, so the guard needs an explicit exemption set with a reason per entry.

#### 17. The four biggest test bodies in the crate live inside the four biggest source files, and the `tests/` split has not tracked size since it was introduced
- **Lens:** File Length + Structure / Inconsistent Patterns
- **Files:** 90 modules with inline `#[cfg(test)] mod tests` vs 4 with a sibling `tests/` dir
  (`harness/loop`, `tools/exec`, `worker/manager`, `commands/files`) + 1 with a `tests.rs` file
  (`agent/web/extract/mod.rs`)
- **Severity:** Medium · **Confidence:** High
- **Problem.** 37,031 lines of inline test code against 26,432 production lines (**1.40×**). The split
  shipped in Phase A (`b7b4`) and **zero** new `tests/` dirs have been created since; the choice never
  tracked size and still doesn't — `db.rs` (2,897 test lines), `harness/launch.rs`, `tools/sandbox.rs`
  (1,663 test lines), `provider/openai.rs` and `session/naming.rs` are all larger than
  `worker/manager/mod.rs`, which was split. Consequences the repo already pays: every test edit is a
  conflict on a 4,000-line file, and `cargo test` recompiles production code to change an assertion.
  It also makes the size ranking itself wrong — see the baseline table.
- **Proposal.** Adopt the rule the four splits already imply (split when the test body exceeds the
  production body), and apply it opportunistically to the top three — `db.rs`, `sandbox.rs`,
  `launch.rs` — one file per commit, as a pure `git mv` plus a `mod tests;`. `launch.rs` is the best
  first candidate: 188 production lines against 1,526 test lines, so the split is mechanical and makes
  the file's real size legible. Note the third shape (`web/extract/mod.rs`'s single `tests.rs`) is a
  variant, not drift — say which of the two shapes is the convention when writing the rule.

### 🟢 Low Severity

#### 18. `prefersReducedMotion` has three implementations, and the extraction's own doc-comment is false about how many there are
- **Lens:** Inconsistent Patterns
- **Files:** `src/hooks/usePrefersReducedMotion.ts`, `src/components/ui/braille-loader.tsx:36`,
  `src/components/chat/QueueRow.tsx:98-103`
- **Severity:** Low-Medium · **Confidence:** High
- **Problem.** The hook reacts to a mid-session OS toggle (`change` listener + an `addListener`
  fallback for WebKitGTK); `braille-loader` keeps its own synchronous `useState` copy, which the hook's
  doc blesses by name as deliberate; `QueueRow`'s copy reads once per render with **no subscription and
  no fallback**, and the doc-comment does not mention it — its claim to have folded *"its only other
  copy"* was already false at the commit that wrote it (`QueueRow` landed 11 hours earlier, `1654a3f`
  vs `1dad62d`). Behaviourally: a queued prompt row keeps its exit animation after the user enables
  reduce-motion, and on a WebKitGTK build with only `addListener` the hook works while `QueueRow` never
  updates. One accessibility rule, two answers on one screen.
- **Proposal.** Route `QueueRow` through the hook. The hook's doc then becomes true, which matters
  because the doc is what stops the next contributor adding copy #4.

#### 19. `MutedCaption` exists to own one class pair, 11 files adopted it, and 8 sites still hand-spell the pair — 3 of them written after it shipped; the `cn()` guard is structurally blind to this
- **Lens:** Inconsistent Patterns
- **Files:** `src/components/MutedCaption.tsx`, `AgentsDialog.tsx:481,815,834,850,921`,
  `SkillsDialog.tsx:359`, `SubagentDelegatingCard.tsx:535`, `chat/ComposerMentions.tsx:244`
- **Severity:** Low-Medium · **Confidence:** High
- **Problem.** `MutedCaption`'s own rationale is *"A tenth site is a copy-paste away from
  `text-ui-sm`, or from `text-foreground-subtle`, and nothing in this repo would notice."* Eight sites
  still spell `text-ui-xs text-foreground-subtlest` byte-exactly, and `git blame` puts
  `AgentsDialog.tsx:815/834/850` at `6f501ab` (2026-10-29) — six days after the component shipped —
  with `SkillsDialog.tsx:359` landing in the same commit that created it.
  Why no gate catches it: `classNameConvention.test.ts` classifies a **static** string as `"static"`
  and exempts it, so the guard cannot see this duplication by construction — even though the repo has
  17 scanner tests, and `chromeButton.test.ts` is the exact precedent for writing one (it walks
  `src/components` and asserts no production file re-spells the chrome class).
- **Proposal.** Port the `chromeButton.test.ts` walk: assert no production file outside
  `MutedCaption.tsx` contains the pair. Migrate the 8 sites in one commit (pure class-string change,
  site tests only). This is the second audit to flag an unguarded convention in the design layer, so
  the guard is the deliverable and the migration is the prerequisite.

#### 20. 16 of 47 IPC commands flatten their error to `String`, and one commit inside the audit window chose both dialects at once and wrote the anti-convention into its message
- **Lens:** Inconsistent Patterns
- **Files:** `commands/history.rs` (`:53,90,103,110,116,126`), `commands/sessions.rs`,
  `commands/{attention,clipboard,open,skills,update}.rs`, `commands/files/mod.rs`, `src/lib/ipcError.ts`
- **Severity:** Medium · **Confidence:** High
- **Problem.** ADR 0063 makes the typed `{kind, message}` envelope normative and `ipcError.ts`'s
  resolution order is normative for it. Measured: **18** `Result<_, String>` command signatures
  (16 outside test code) against 5 `SessionError`, 5 `SpacesError`, 3 `AgentsError`, 1 each
  `McpError`/`FilesError`, and 3 commands with no error type. `anyhow` is not even a dependency. The
  sharpest file is `commands/sessions.rs`: 9 commands return `SessionError` and `get_stalled_info` —
  the tenth — returns `String`, which ADR 0063 names as part of the bug.

  The drift is accelerating, not decaying: `d509958` (inside the window) added three commands and
  chose **both** dialects in one commit, then recorded the rule that produced it — *"Error types
  follow the file they live in: `String` via `map_err(to_string)` in `history.rs`,
  `SpacesError::Database` in `spaces.rs."* That is a per-**file** rule competing with ADR 0063's
  per-**wire** rule, for two commands wrapping the same `DbError` from the same layer for the same
  user gesture. `describeIpcError` makes both shapes readable, so nothing reddens — the drift is
  invisible by design. What is lost is `kind`, which `UpdateSection.test.tsx` pins as a user-facing
  contract: `DbError`'s three variants (`Sqlite`/`Io`/`Json`) collapse to one sentence, so "history
  won't load" cannot say whether SQLite or the disk failed.
- **Proposal.** Migrate `history.rs` first (6 sites, all wrapping `DbError`, one `HistoryError` with a
  `From<DbError>`), then `sessions.rs`'s tenth, then the rest one file per commit. Add the ADR 0063
  sentence that settles the competing rule: **the error type is chosen by the wire, not by the file.**
  A grep-level guard is feasible in the same shape as finding 19's: every `#[tauri::command]` returns
  `Result<_, E>` where `E: Into<InvokeError>`-via-the-typed-envelope, with an allowlist for the three
  infallible ones.

---

## Considered and not filed

Recorded so the next audit does not re-spend the effort:

- **No clock seam is not the gap it looked like.** `crashlog.rs` tests already forge age with
  `File::set_modified` (`:654-667`, stable since 1.75, no new dependency) and have 5 prune tests
  including `prune_deletes_what_is_older_than_the_age_bound`; `oauth.rs:66 is_expired(&self, now: i64)`
  already takes `now` as a parameter. `attention.rs` uses `tokio::time::pause()` and
  `permission.rs`/`ask.rs` use `start_paused = true`. A `Clock` trait would buy almost nothing here —
  the code under test already expresses time as an argument or as an mtime.
- **Lock poisoning: the count is real, the convention is defensible, and one site is a genuine bug.**
  229 poison-tolerant sites (documented reason: `test_support.rs`'s `env_lock`), 34 that name the
  poison, 12 bare `unwrap()`s. `normalize.rs`'s 11 poisoned-expects are consistent *within* the file
  and per-session, so exposure is narrower than a raw count suggests. The real defect is
  `agent/mcp/stdio.rs:122,137` — bare `unwrap()`s inside the spawned JSON-RPC reader task, where a
  panic skips `exited_tx.send(true)` at `:143` and every `pending` request hangs to its own timeout.
  But the correct fix is to make the reader non-panicking (hoist the `parse_*` work out of the guard),
  not to poison-tolerate a panic that is itself the bug. Filed as part of finding 7's neighbourhood;
  not worth its own item.
- **`spawn_blocking` dialect split is stylistic.** 5 `tauri::async_runtime::spawn_blocking` vs 4
  `tokio::task::spawn_blocking`; Tauri's default async runtime *is* a tokio multi-thread runtime, so
  mixing is functionally harmless. `commands/files/mod.rs:196` states a rule but scopes it to one
  file. Worth one line in AGENTS.md, not a finding.
- **Blocking calls in `async fn` are 2 sites**, both `std::fs::canonicalize` in `start_session` /
  `resume_session` (`session/mod.rs:1388,1411`). Real but sub-millisecond; the convention is strong.
- **Cancellation primitives are consistent** — `CancellationToken` in 30 files, 0 `AtomicBool`s used
  for cancellation, `JoinHandle::abort` in 2 production sites (the other 40 are test mock servers).
  The inconsistency is on the *completion* side, which is finding 2.
- **`serde(rename_all)` direction is clean** — 92 `camelCase` at the IPC boundary, snake_case reserved
  for the internal Supervisor↔Worker protocol, and `types.ts` mirrors it with one snake_case field
  (`whole_tool`) that is documented in four places and pinned by `a_permission_block_serializes_in_file_order`.
  `whole_tool` is a decided mixed casing, not drift — do not "fix" it.
- **Raw `<button>` sweep is DONE**: 3 production raw buttons remain, each with a measured blocker
  comment (`bg-clip-padding` breaking ADR 0062's no-band rule; `disabled:opacity-50` breaking a
  `SpaceTabs` assertion) vs 98 `<Button>` sites.
- **The frontend has no runtime import cycles**, `storage ↛ agent` holds, `harness ↛ commands` holds,
  `tauri::State` below the command layer is 0 hits, the Worker has **zero** rusqlite/`Db`/SQL
  references (ADR 0025 verified positively — its only `storage` edge is the `DbError` type), all 30
  Cargo deps and all 20 npm deps are used, and all 47 emitted `data-testid` literals are queried.
- **`harness ↔ mcp`, `session ↔ harness`, `interactive ↔ worker` mutual dependencies are false
  positives** — doc-comment cross-references, not `use` edges. The real SCCs are 3
  (`subagent ↔ worker`, `tools/exec ↔ web/tools`, one in `harness/dispatch`), and `OnceLock`
  back-references are the documented cycle-breaker. `harness → session` is one 4-line
  `pub(crate)` call (`launch.rs:173` → `resolve_composed_model`) whose home is arguably
  `harness/model_key.rs`, which already cites it — trivially relocatable, not filed.
- **`SqliteTrustSource` is never constructed in production** (`trust.rs`, tests only; the Supervisor
  reads trust and ships the value, the Worker gets `StaticTrustSource`). A vestigial handle whose
  doc-comment still calls itself "the trust lookup" — one-line doc fix, not a finding.

---

## Decisions — 2026-10-30

**All 20 findings approved into the backlog.** Nothing dismissed, nothing deferred. Two scope
modifications from the review discussion:

- **Finding 16** — approved as **the conformance ADR only**. The copy-guard test is explicitly **out
  of the backlog**: the exemption problem (blessed names are per-symbol, glossary-quoting strings must
  be exempt) is a design task in its own right and was not sized here. Do not build it as a
  rider to the ADR.
- **Finding 14** — approved as **copy fixes *and* wire renames**, which makes the wire half
  **dependent on Finding 16's ADR** for authority. Sequence accordingly: the copy fixes need no
  authority and ship in Phase A; the `list_agent_config` / `FileListDto` renames wait for the ADR.
  Before either wire rename: confirm no serde field inside a persisted `payload_json` changes spelling
  (a command *name* is not persisted; a field inside a stored payload is).

### Execution order

Ordering principle, reversed from 2026-10-22: **take the correctness bugs first.** That audit's
principle was "reduce risk before reducing size" because its findings were all structural. This one's
top two findings produce a **wrong answer for a user today**, and they are small. Size work
(12, 17) comes last and is still a consequence, not a target.

Two repo constraints shape the wave structure, both from `AGENTS.md`:
`archimedes` is **one compilation unit**, so **two Rust implementation tasks can never share a wave**
(read-only planning dispatches fan out freely); and `cargo test --lib` does not rebuild `fake_worker`,
so run `cargo build --all-targets` first when a fixture looks like it is lying. TDD throughout: where
a row says a test comes first, write it and see it fail.

#### Phase A — the two ADR-orphaned copies (correctness, user-visible today)

| # | Finding | Change | Test work |
|---|---|---|---|
| A1 | 1 | Lift `map_anthropic_error` into `provider/types.rs` as the one classifier (the `cost_usd_from_usage` precedent puts the seam there); add the `error` arm to `openai.rs` **before** the `choices` deref; let `responses.rs` upgrade `ContextOverflow`/`Auth` to a real tier, terminal-only otherwise | **Failing test first** on the completions wire (`anthropic_sse_auth_error_event` is the template; `openai.rs` has 19 `sse_*` tests and zero error-chunk tests). `responses_sse_error_event` currently *pins* the divergence and must change with it |
| A2 | 1 | Add the missing loop-level test that drives a real parser rather than `ScriptedProvider`; comment `turn.rs:255` to state the invariant it now depends on ("fires only when no error event existed") | Test-only increment |
| A3 | 2 | Port the bash latch to the elevated path: cancellable pipe reads that do not cancel `wait()`, latch `pipes_held` before the group kill, **share** the exit classifier instead of copying it a third time; delete the `-1`/`124` sentinels | **Failing test first**: a pipe-holding grandchild under `sudo -S` with a child that exits 0 |
| A4 | 2 | Decide and record: is this a bug fix or **ADR 0080 amendment** naming the elevated path? The amendment is what stops a third exec path repeating it | Docs, same commit as A3 or immediately after |
| A5 | 3 | `WorkerHandle::kill()` uses the latched `self.pid` for the negative-pid group kill, `guard.kill().await` stays as the direct-child fallback; same treatment in `kill_process_group_and_reap`; then consolidate the four group-kill implementations (check what `agent/childproc.rs` already owns) | Test that an **already-reaped** handle still issues the group kill. Also fix the doc-comment at `client.rs:717-721`, which currently claims coverage the code did not provide |

**Wave note:** A1/A2, A3/A4 and A5 are three separate Rust waves — they cannot be parallelised
(one compilation unit). A2 is test-only so it can share with a docs increment.

#### Phase B — free wins and the docs that stop this recurring

| # | Finding | Change | Note |
|---|---|---|---|
| B1 | 8 | The four verified-zero-risk deletions: `NullHooks` (`src-tauri/src/test_support.rs:104` — **struct only**, the module is heavily used; mind the path, it is not `agent/test_support.rs`), `_free_port` + its lone unconditional `#[allow(dead_code)]`, `StalledInfo` + barrel re-export + its pinned entry in `tauriBarrel.test.ts:300`, `@tauri-apps/plugin-opener` from `package.json` **only** (the Rust crate is live via `open.rs:218`) | Guard is `tsc` + both suites. Then `partialArgs`: retire the emit arm, leave persisted rows with the inert key |
| B2 | 8 | The CI command-consumer guard: every `generate_handler!` entry appears in a TS invoke string **or** a Rust test that invokes it; allowlist entries must cite a reason | Read `lib/ipc/events.ts` rule 2 first — its two objections are structurally absent for commands, so the guard is allowed and rule 2 stays untouched |
| B3 | 15 | The `definition_permission` **glossary entry**, the **Agent definition** frontmatter amendment (add `permission`), and one line in `docs/features/permissions-model.md` recording that `decision` and `action` are one concept spelled two ways on two wires | Docs only. **Highest value per minute in the report** — do it while the author's context is fresh |
| B4 | 16 | The conformance **ADR**: names follow the CONTEXT.md term; enforced on new code, repaired on touch, never by sweep. Explicit non-goal naming the five D5 renames and their measured cost so it cannot be read as resurrecting them | This is the **gate on B6 and half of Phase E**. No copy guard (see the scope modification above) |
| B5 | 9 | Record the diff-channel retention decision where retention decisions live, naming the `created_at` bound and that a resume does not clear the display table; fix the two ADR-0075-stale prose sites (`test/fixtures/sessions.ts:70-71`, `sessions.test.ts:3615`) | Prose only. Do **not** delete the pipeline and do **not** delete the columns |
| B6 | 14 | The user-visible copy fixes: Palette row ("color scheme", banned on both axes), `GeneralSection` ("Notify…"/"notification" for **Attention alert**, "session names" for **Session title**), and the two `"…hidden by a project…"` headings | Copy-only, 4 files, site tests only. No authority needed |
| B7 | 18 | Route `QueueRow` through `usePrefersReducedMotion` | Then the hook's *"its only other copy"* doc becomes true — which is what stops copy #4 |
| B8 | 19 | Port the `chromeButton.test.ts` walk to assert no production file outside `MutedCaption.tsx` contains the pair; migrate the 8 sites | **Guard first, migration second** — the guard is the deliverable, this is the second audit to flag it |

#### Phase C — the type seams

| # | Finding | Change | Guard |
|---|---|---|---|
| C1 | 4 | `CompactionReason` enum, `#[serde(rename_all = "snake_case")]` so the wire is byte-identical | Name per CONTEXT.md's **compaction reason** `_Avoid_`. Fix `protocol.rs:958`'s fixture, still using the retired `context_limit`. `compact.rs` needs nothing |
| C2 | 5 | The `details`-shape **registry test** (shapes + round-trip + producer-key-set vs reader-field-set); delete `cacheRead`/`cacheWrite`/`turns` and `subagentActivityFor` | Do **not** build a `ToolDetails` enum. Fold in the follow-ups §4 residue it finally makes visible |
| C3 | 6 | `TurnControl` (owns `force_compact` + `CompactionRan`, `enter_turn()` the only way to clear) and `PermissionContext` (one `refresh()`, one `to_tool_ctx()`) | Guarded by `loop/tests/{turn_lifecycle,compaction_overflow,policy_gate}.rs`. `PolicedTool::Shell \| Path` so the unreachable `Confine` arm is unrepresentable — separate increment |
| C4 | 13 | The `SessionState` the module comment says is missing: one map keyed by session id holding `{config, naming, live, stalled}`, one lock, one removal path, four accessors delegating | Delete one of `set_cwd_registrar`/`attach_cwd_registrar` in the same commit. Watch the two `ManagerState` maps — the walk in `unexpected_exit` is the thing being removed |

#### Phase D — test the substrate under the newest code

| # | Finding | Change | Note |
|---|---|---|---|
| D1 | 7 | Pump tests: a `Lagged(n)` burst asserting the **documented salvage** (not "cannot happen"), and `Exited` arriving between `detach` and the registry write | No production seam |
| D2 | 7 | 4-6 `mcp/http.rs` tests against a local listener: initialize→list_tools→call_tool, the 401 branch, token re-attach on reconnect, `cancel` mid-request, `response_to_result` shapes | Also no production seam — verify that claim before writing a seam |
| D3 | 11 | Unify `relativeTimeFor` on `recencyOf`'s `(sessionId, loadedMessages, recencyMap)` triple | **Failing test first** in `sessionTime.test.ts` — the same shape as the `sessionTitle` divergence Phase A fixed |
| D4 | 10 | Extract the shared root-discovery walk (roots + walk-up + dedupe + sort) parameterized by item type and scope | Leave `parse_value`; say in the module doc **which of the four is not a mirror** |

#### Phase E — size, now affordable, and the last convention sweeps

| # | Finding | Change |
|---|---|---|
| E1 | 12 | (a) `session_row_from` / `message_row_from` / `space_row_from` with the `SELECT` list as a `const`, so list and ladder cannot disagree; (b) one `gate()` taking `&Transaction` so ALTER+backfill is a signature, removing the misleading single-ALTER wrapper on `cost_usd`; (c) then the domain split behind `Db`'s current API, and move the inline tests to a sibling dir beside `tests/storage.rs` so one suite exists |
| E2 | 17 | Write the rule (**split when the test body exceeds the production body**, naming `tests/` dir vs `tests.rs` file as the convention), then split `launch.rs` (188 prod / 1,526 test — the most mechanical), `sandbox.rs`, `db.rs`. One file per commit, pure `git mv` + `mod tests;` |
| E3 | 20 | `history.rs` first (6 sites, one `HistoryError` with `From<DbError>`), then `sessions.rs`'s tenth, then one file per commit. Add the ADR 0063 sentence: **the error type is chosen by the wire, not by the file**. Grep guard in B8's shape, allowlisting the three infallible commands |
| E4 | 14 | The wire renames (`list_agent_config` family, `FileListDto` → a `Listing` name), each with its reference count in the commit message, per B4's ADR. Verify no persisted serde field changes spelling before each |
| E5 | 8 | The two decision items: `list_agent_definitions` (rework `agents.rs:476,691` or drop the app-scope read) and `get_stalled_info` (**ADR 0025 amendment or keep — never a silent delete**, `tests/ipc.rs:166,520` moves with it) |

**Explicit non-goals carried forward:** do not split `store/sessions.ts`; do not adopt `ui/tabs.tsx`;
do not build the copy guard (F16's scope modification); do not build a `ProviderStream` abstraction
(the `handle_chunk` bodies are not factorable) or a `ToolDetails` enum; do not delete the diff display
pipeline or the `last_opened_at`/`created_at` columns; do not "fix" `whole_tool`'s mixed casing (pinned
in four places); do not rename the five D5 symbols; do not touch `SqliteTrustSource` beyond its stale
doc-comment; and do not re-litigate the four `spawn_blocking` sites, the `stdio.rs` bare `unwrap()`s,
or `MutedCaption`'s static-string exemption as separate items — each is folded into a finding above.

## Top Recommendation

**Phase A, in order: A1, then A3, then A5.**

1. **A1 (the completions parser's missing `error` arm).** A wrong API key on an OpenAI-shaped provider
   costs 5 paid round trips and 15 seconds of backoff, then reports *"the model stream ended without a
   finish_reason"*. One arm plus a shared classifier whose seam already exists (`cost_usd_from_usage`),
   and the missing test is a copy of `anthropic_sse_auth_error_event`. Take `responses.rs`'s upgrade in
   the same increment so ADR 0045's no-ladder rule stops being violated on 2 of 3 wires.
2. **A3/A4 (the elevated path and ADR 0080).** Lower reachability, higher consequence — a
   non-idempotent privileged command re-run because the client lied about a kill. The correct shape is
   already written and tested in `bash.rs`; port it, share the classifier rather than copying it a
   third time, and amend the ADR to name the elevated path so a third exec path cannot repeat this.
3. **A5 (the latched pid).** The in-file doc already states the rule; the code contradicts it on the
   crash path the field exists for, and a second doc-comment claims the coverage that is missing.

Then **B3 and B4 while their context is fresh** — the `definition_permission` glossary entry is minutes
and prevents a five-vocabulary permission layer from getting a sixth, and the conformance ADR is the
gate on half of Phase E and the only thing that stops the next 116 commits re-entering the same drift.

**B1 is the free win** — five deletions verified against the shipped bundle, with `tsc` and both suites
as the whole guard — and **B2 is the one systemic fix** that would have caught both dead commands the
day the TS wrappers were retired. Do not let `get_stalled_info` ride along in B1: it is the pull half of
an accepted ADR 0025 amendment with a live integration test, and deleting it as "dead code" is exactly
the class of silent desync this repo's own docs keep recording.
