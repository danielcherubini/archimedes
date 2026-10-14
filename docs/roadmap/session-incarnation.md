---
status: approved
done-when: a resumed Worker's ids carry a stamp its predecessor never had, a Retraction in the new incarnation provably leaves every row of the old one intact (asserted both at the display-row seam and across a real resume), `resumeSession` cannot drop a user message to a Retraction racing its history load, and no test still asserts a bare `m1` that would hide a regression to the old shape.
---

# Session incarnation — two Workers, one transcript, no shared ids

## The problem

A **Session** outlives its **Worker**, but its ids do not.

`TurnState` is built once per `AgentLoop` (`harness/loop.rs`, the `turn_state` mutex's `TurnState::default()`), and `AgentLoop` is built once per `Inbound::Start` (`worker/core.rs`, `(self.build_loop)(&env)`). A resume is a new Worker with a new loop, so `msg_counter` and `retract_seq` start at 0 again and the resumed session's first assistant reply is `m1` — the id its first Worker already used — with its first discard line `retract:1` again.

The display store UPSERTs (`storage/db.rs`, `record_message`, on `UNIQUE(session_id, kind, message_key)`), so the new incarnation's `m1` silently overwrites the old one's, and ADR 0048's Retraction — which erases BY `messageId` — can erase rows belonging to a Worker that is gone. Nothing catches it: no test spans two Worker lives (the resume tests at `tests/session_native.rs` and `tests/ipc.rs` assert only that `session_id` survives), and no test on the reset exists either.

It is worse than a counter problem. `agent-text` rows are keyed by five families, and two of them are constants:

| family | minted at | counter? |
|---|---|---|
| `m{n}` | `normalize`, on `message_start` for an `assistant` message | yes |
| `m{n}#{seg}` | `normalize`, the thought arm (`ThoughtState.next` counts segments for the life of the loop, so a second message's run is `m2#2`, `m2#3`) | yes |
| `retract:{n}` | `normalize`, the Retraction's discard line | yes |
| `system` | `normalize`, `system_chunk` — the shared one-liner key | **no** |
| `default` | `normalize`, the fallback when no id is open | **no** |

Because `text_acc` starts empty in the new Worker, its first `"system"` line ("Compacting context…", "Retrying (attempt 1/3…)") UPSERTs over the previous Worker's `"system"` row and destroys it. No seeding of a counter can fix that, because there is no counter.

The neighbouring hazard is on the reader's side. `resumeSession` (`src/store/sessions.ts`) reloads persisted rows after an `await` and merges "what the user added meanwhile" as `current.slice(prior.length)` — an index from a snapshot taken before the await. Now that `applySessionUpdate` can REMOVE messages (the `message_retracted` filter), the array can be shorter than the snapshot assumed, the slice shifts left, and a prompt sent during the window is dropped.

## What we decided

### 1. A Session's ids are scoped to its incarnation (ADR 0049)

The **Supervisor** mints a short opaque token — 6 hex chars from `Uuid::new_v4()`, the `mint_session_id` style — for each `Start` envelope and passes it as a new REQUIRED field `StartEnv.incarnation` (`worker/protocol.rs`). Required, not `Option`, so no call site can forget it. Minted where the envelope is built: `establish_worker_session` (main start/resume) and `dispatch_subagent` (a child), both of which already assemble every other session-scoped fact.

`AgentLoop::new` seeds `TurnState` with it, and `normalize` — the ONLY place a `messageId` is ever put on a frame (the loop never injects one) — stamps everything it mints:

```
a3f9c1:m1        a3f9c1:m1#2        a3f9c1:retract:1        a3f9c1:system        a3f9c1:default
```

`compute_display_rows` takes ids from the frames it is given, so every display key inherits the stamp for free, and the Retraction's erase list is built from ids that already carry it. Fresh sessions are stamped too, and so are **Subagent sessions** (which never resume): one id shape for a whole transcript, so nobody reads `m1` then `a3f9c1:m2` in the same conversation.

The invariant is **one stamp per `Start` envelope**. `worker/core.rs` allows a second `Start` to replace the loop on a live Worker — test-only today, since a real resume always spawns a fresh process through `WorkerManager::attach` — and such an envelope must carry a fresh stamp. Recorded in the ADR rather than policed with machinery.

### 2. The id shape, and the one thing that reads it

`{stamp}:{kind-ish-part}`, token first, so a transcript reads left-to-right grouped by life. Exactly one consumer parses ids structurally: `normalize::is_bookkeeping_message_id`, re-exported as `agent::is_bookkeeping_message_id`, which decides which `agent_message_chunk` ids are harness bookkeeping rather than model output — the predicate that stops a discard line being handed to a parent model as its child's answer (`SubagentCapture::observe_sink_frame`). It becomes a field test on `split(':')` (`system` / `default` / `retract`) instead of a bare-prefix match, and keeps its negative pin: a stamped real reply is still capturable as child output.

Everything else carries ids opaquely and needs no change: `mergeDedupeKey`, `rowToMessages`, the live store's `message_retracted` filter, `MessageRow.messageKey`, and React keys (which are `sessionId:index`, not id-based). The Client's own transcript lines keep their module-local `client:N` namespace, which is never persisted.

There is **no migration**: pre-change rows keep their bare `m1` / `system` keys forever, a bare key can never equal a stamped one, and nothing parses the shape — so a Session that straddles the change simply mixes both shapes and renders correctly.

### 3. The resume merge selects by identity (ADR 0050)

`resumeSession` stops computing `slice(prior.length)` and selects the additions the way the close/reload merge in the same file already does: keep what is not already in the reloaded rows by `mergeDedupeKey`, and for a `user` message (no id on either side) require the matching reloaded row to be newer-or-equal by `at`. Where identity cannot decide, it **keeps** the message: a duplicated bubble beats a lost prompt.

## Deliberately not doing

- **The stalled tail.** A Worker that *crashes* mid-reply never runs a Retraction — nobody is left to emit one — so the partial `agent-text` row stays on screen after Resume, text the model's history never contained. ADR 0048 says abandonment cannot happen silently, and a crash is the one path where it still does. Choosing between erasing that row and keeping it marked truncated is its own decision; recorded as §4 of `compaction-recovery-hardening-follow-ups.md`.
- **The broadcast `Lagged` drop** (§2 of the same doc) — a renderer that falls behind still loses frames, identity or not.
- **Rendering the incarnation boundary.** The stamp makes a resume visible in the data; no divider, badge, or "resumed" marker in the transcript. That is a feature, not this fix.
- **Seeding counters.** Rejected in ADR 0049; it fixes three of five key families and buys a TEXT-column query on the resume path.

## What makes it true

None of these exist today, which is precisely how the collision shipped.

1. **The cross-incarnation persist test (Rust, `normalize.rs` / store-level).** Incarnation A streams an `agent-text` `m1`, a thought, and a `"system"` line; incarnation B — different stamp, counters back at 0 — streams its own `m1` and then retracts it. Assert A's three rows are untouched and non-empty, and B's erase rows carry only B's keys. The `"system"` case is the one a counter-seed would have failed, so it is pinned explicitly.
2. **The resume integration test (Rust, `tests/session_native.rs`).** Extend the existing end-to-end resume path to assert that the first incarnation's `message_key`s are still present and non-empty after the resumed Worker has streamed and retracted, and that the resumed reply's `messageId` carries a stamp the first one did not.
3. **The bookkeeping predicate (Rust).** `{stamp}:retract:1` and `{stamp}:system` are bookkeeping; `{stamp}:m1` is not.
4. **The racing resume (vitest, `sessions.test.ts`).** Drive `resumeSession` so a `message_retracted` arrives after `loadHistory` resolves but before the merge runs, and assert the user message added in that window is still in the transcript.
5. **The existing id pins move, exactly.** Every assertion on `m1` / `m2` / `m1#1` / `retract:N` (Rust unit tests, `tests/harness_loop.rs`, the `fake_worker` fixture, the vitest hydrate/dedupe pins) is re-targeted to a literal stamped id — never loosened into a `contains`/`endsWith` matcher, since matcher-shaped assertions are what failed to catch this.

## Exit condition

`cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` and `pnpm test` / `pnpm build` green, with the five tests above passing and follow-up §3 of `compaction-recovery-hardening-follow-ups.md` retired as resolved-by-design.

## Links

- ADR 0049 — every id the harness mints is stamped with its incarnation
- ADR 0050 — the resume merge selects by identity, never by position
- ADR 0048 — an abandoned reply is retracted by protocol (the erasure this makes safe)
- ADR 0025 — the Worker-process architecture (why a resume is a new process)
- `docs/roadmap/compaction-recovery-hardening-follow-ups.md` — §1 folded in here, §3 retired by ADR 0049, §4 the stalled tail
