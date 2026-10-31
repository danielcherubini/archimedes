---
status: grounding-report
area: worker-e2e
issue: "#138"
branch: feature/macos-ci-flakes
grounded-at: 60470d23b4408ec124672afa5865e1195099052c
grounded-on: 2026-10-31
---

# Grounding report — worker-e2e area (issue #138)

Grounded read-only at `60470d2` (`feature/macos-ci-flakes`, clean tree — `git status`
porcelain empty, `git show HEAD:src-tauri/tests/worker_e2e.rs` hash == working-tree hash
`e8890904…`). All line numbers below are as of that HEAD, against
`src-tauri/tests/worker_e2e.rs` (78 429 bytes, 1836 lines). Quotes are verbatim.

This report grounds the AREA; it does not propose a fix, rank options, or emit tasks —
the planner owns that.

## The issue's claim, verified against the tree

Claim (paraphrase given to me): `subagent_dispatch_end_to_end_real_workers` reads the
child's persisted transcript once, un-polled, and asserts an exact row count of 3; on
macOS the assistant row sometimes has not landed yet, so it sees 2 and fails; every
other row-count read in this file already goes through `wait_for_rows` (or polls
inline); this test never got that treatment.

**Verdict: the claim is TRUE at this HEAD.** The child read at lines 1311–1318 is
un-polled and asserts exactly 3; the sibling main-session read in the SAME test (line
1263) already uses `wait_for_rows`, and the file's other four row-count asserts are all
bounded. **Contradiction worth noting:** the tree's own historical record of the flake
— the comment at lines 1520–1529 — attributes the OBSERVED `macos-latest` instance to
`a_child_with_a_tools_list_and_an_empty_body_gets_no_main_prompt`, NOT to
`subagent_dispatch_end_to_end_real_workers`, and that sibling was ALREADY converted to
`wait_for_rows` (in commit `6f501ab`, per `git log -S`). Issue #138's claim is that
the SAME race still exists in the dispatch test at the un-converted read (line 1311) —
consistent with the tree: the dispatch test's child read is the sole remaining
un-polled row-count read, and it is `subagent-closed`-adjacent just like the converted
sibling. The corrected list of "what the race reaches" is §5 below.

Files examined:

| File | Notes |
|---|---|
| `src-tauri/tests/worker_e2e.rs` | the whole file (1836 lines) |
| `src-tauri/src/storage/db.rs` | `load_native_messages` (lines 795–806) + `Db` shape |
| `src-tauri/src/test_support.rs` | `ENV_LOCK` (line ~14), `ScratchDir::in_env_temp` (line ~224), premise tests |
| `.github/workflows/ci.yml` | the `lint-test-build` job's gate steps |
| `scripts/check-temp-dir-census.sh` | attribution table entry `worker-e2e-` (line 172) |
| git history | `git log -S wait_for_rows`, `git log -p -S load_native_messages(&child_id)` |

---

## 1. `wait_for_rows` in full

Defined in `src-tauri/tests/worker_e2e.rs`, lines 276–292 (doc comment 276–280, body
281–292). Verbatim:

```rust
/// Poll the transcript rows until `want` rows are persisted (bounded).
/// The `native_messages` rows are written by the `TranscriptPersister`
/// from the WORKER's store frames, which arrive on their own schedule —
/// the `agent_settled` RpcEvent does NOT imply the last message's row has
/// landed, so a read right after the settle races it.
async fn wait_for_rows(db: &Db, session_id: &str, want: usize) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let rows = db
            .load_native_messages(session_id)
            .expect("the transcript loads");
        if rows.len() >= want || tokio::time::Instant::now() >= deadline {
            return rows;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
```

Facts a caller must not guess:

- **Signature**: `async fn wait_for_rows(db: &Db, session_id: &str, want: usize) -> Vec<String>`.
  `Db` is `archimedes_lib::storage::Db` (file import at line 27: `use archimedes_lib::storage::Db;`).
  No generic bounds, not generic over a harness type, no lifetime params.
- **Session id type**: `&str`. Call sites pass both string literals (`"e2e-full"`) and
  `&child_id` where `child_id: String` (auto-deref).
- **Polling interval**: `tokio::time::sleep(Duration::from_millis(10))` between polls
  (line 290).
- **Deadline**: `tokio::time::Instant::now() + Duration::from_secs(30)` captured ONCE
  before the loop (line 282). Note the loop condition is the natural `>=` — the deadline
  check is `tokio::time::Instant::now() >= deadline` (line 287).
- **Returns on timeout rather than panicking or asserting**: when either `rows.len() >= want`
  OR the deadline is reached, it `return rows;` — the partial list on timeout. **The caller's
  assert is what fails on timeout**, it does not panic inside the helper. (This is the exact
  semantic the sibling test at lines 1539–1546 leans on: "it is what fires when the wait
  TIMES OUT rather than filling.")
- **The DB read it wraps**: `Db::load_native_messages(&self, session_id: &str) -> Result<Vec<String>, DbError>`
  (`src-tauri/src/storage/db.rs` lines 795–806; helper calls it with `.expect("the transcript loads")`).
  Verbatim from `db.rs`:

```rust
    pub fn load_native_messages(&self, session_id: &str) -> Result<Vec<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT content_json FROM native_messages WHERE session_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
```

Rows come back as `Vec<String>` — JSON-serialized `ChatMessage`s, one per `seq`, the
denormalized `role` column is NOT read. Note: `Db` wraps `rusqlite::Connection` in a
`StdMutex`; the persistence side (`insert_native_message`, line ~780 in db.rs) holds the
same `std::sync::Mutex` — the guard serializes reads AND writes on the parent's single
connection, so the race being grounded is NOT intra-process; it is the OTHER process's
uncommitted/not-yet-written rows (see §4).

The helper's own companion `Db` access used by display-row asserts
(`h.db.messages_for("e2e-full")`, line 662) reads the `messages` table and is unrelated to
`native_messages` counting.

---

## 2. Every existing call site of `wait_for_rows`, plus the inline poller

There are exactly **four** call sites at this HEAD (grep `wait_for_rows\(` → lines 600,
858, 1263, 1534), one per bounded read, plus the helper's own internal `load_native_messages`.
All four are shown with surrounding context (argument order: `(&h.db, session_id, want)` —
`&h.db` where `h: E2e` and `E2e.db: Arc<Db>`; deref lands on `&Db`).

**Call site 1 — `full_turn_real_worker_canned_provider` (lines 594–609):**

```rust
    // (e) The `native_messages` rows — the COMPLETE transcript (the
    // store frames applied by the `TranscriptPersister`): the system
    // prompt (seq 0 — the Worker's `build_main_prompt` +
    // `prepend_system`), the user message, the assistant message with
    // the `tool_calls`, the tool-role message with the result, the
    // final assistant text. A resume of the session would work.
    let rows = wait_for_rows(&h.db, "e2e-full", 5).await;
    assert_eq!(
        rows.len(),
        5,
        "system + user + assistant(tool_calls) + tool + final assistant, got {rows:?}"
    );
```

The follow-up assert phrases the EXPECTED count both as the `want` argument AND in the
`assert_eq!` message (the count is asserted twice: once to bound the wait, once to pin
the exact total).

**Call site 2 — `permission_round_trip_real_worker` (lines 854–859):**

```rust
    // The transcript: the user + assistant(tool_calls) + tool + final
    // assistant rows (the system prompt at seq 0) — polled (the rows are
    // written by the persister from the worker's store frames, which are
    // not ordered against the settle — see `full_turn`'s (c)).
    let rows = wait_for_rows(&h.db, "e2e-perm", 5).await;
    assert_eq!(rows.len(), 5, "the complete transcript, got {rows:?}");
```

Here the comment explicitly names the polled pattern and cross-references
`full_turn`'s step (c) — the sibling convention in this file is, verbatim,
"polled (the rows are written by the persister from the worker's store frames,
which are not ordered against the settle — see `full_turn`'s (c))."

**Call site 3 — `subagent_dispatch_end_to_end_real_workers`, the MAIN-session read
(lines 1260–1276):**

```rust
    // The main's final assistant text (the tool-result turn's `stop`) —
    // polled (the store frames are not ordered against the settle — see
    // `full_turn`'s (c)).
    let rows = wait_for_rows(&h.db, "e2e-sub", 5).await;
    let v: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::from_str(r).expect("the row is JSON"))
        .collect();
    assert_eq!(
        v.len(),
        5,
        "system + user + assistant(subagent tool_calls) + tool + final assistant, got {v:?}"
    );
```

Note this MAIN read lives inside the SAME flaking test, ~50 lines above the un-polled
CHILD read — the contrast the issue points at (§3).

**Call site 4 — `a_child_with_a_tools_list_and_an_empty_body_gets_no_main_prompt`,
the CONVERTED sibling (lines 1520–1546):** quoted in full in §4 (the helper call is
line 1534: `let child_rows = wait_for_rows(&h.db, &child_id, 2).await;`).

**The inline poller for contrast — `crash_path_on_crash_fires_and_rows_stay_intact`,
pre-crash user-row wait (lines 938–959):**

```rust
    // The pre-crash state: the user message row is persisted (the
    // `TranscriptInsert` applied by the `TranscriptPersister` — the
    // turn is now in its first model call / retry backoff).
    let mut rows = Vec::new();
    for _ in 0..100 {
        rows =
            h.db.load_native_messages("e2e-crash")
                .expect("the transcript loads");
        if rows.iter().any(|r| {
            serde_json::from_str::<Value>(r)
                .map(|v| v["role"] == "user")
                .unwrap_or(false)
        }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let v: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::from_str(r).expect("the row is JSON"))
        .collect();
```

Differences from `wait_for_rows`: fixed iteration budget (100 × 50 ms = up to 5 s) instead
of an instant-based deadline; it polls for a PREDICATE (a user-role row present) and breaks
out, not for a count; and it keeps the last read's value (does not return early with `rows`
before the loop — it MUST be identical to the loop variable, which the format does by
reusing `rows`). The same test's POST-crash read (lines 1010–1027) is deliberately
un-polled — quoted in §5, since it is the one un-polled read in the file that is NOT a
count assert.

---

## 3. The flaking test, in the relevant region

`subagent_dispatch_end_to_end_real_workers` spans lines 1057–1398 (`#[tokio::test]` at
1056). The region from `child_id` binding through the end of the row-count asserts —
steps (b) through (e) — lines 1196–1345, verbatim:

```rust
    let started = sink_events
        .iter()
        .find_map(|(e, p)| (e == "subagent-session-started").then_some(p.clone()))
        .expect("the subagent-session-started payload");
    let child_id = started["sessionId"]
        .as_str()
        .expect("the child session id")
        .to_string();
    assert_eq!(started["parentSessionId"], "e2e-sub");
    assert_eq!(started["agentName"], "scout");
    assert_eq!(started["task"], "find the answer");
    assert_eq!(
        started["model"], "fake/sub-model",
        "the child's resolved model (the frontmatter override)"
    );
    let enabled: Vec<String> = started["enabledTools"]
        .as_array()
        .expect("the enabledTools list")
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        enabled,
        vec!["bash"],
        "the child's tool set (launch.tools verbatim minus the guard)"
    );

    // (c) The main's `agent_settled` (the `SubagentResult`
    // (`Completed` with the `SubagentCapture`'s final text) delivered
    // to the main Worker → the main's `subagent` tool resolves → the
    // final model call → the turn settles). The predicate matches the
    // MAIN's `agent_settled` (`is_subagent: false` — the child's
    // `agent_settled` is delivered under the parent's id with
    // `is_subagent: true` and would match a naive predicate early —
    // the `SubagentResult` delivery lands only after the child's reap
    // grace).
    let evs = h
        .wait(Duration::from_secs(60), |evs| {
            evs.iter().any(|(_, is_sub, e)| {
                !is_sub
                    && matches!(e, WorkerInboundEvent::Event(ev) if ev.kind() == "agent_settled")
            })
        })
        .await
        .expect("the main turn settles within the bound");
    // The `subagent` tool resolved with the child's captured final text
    // (`Completed` — NOT an error).
    let (result, is_error) =
        tool_execution_end(&evs, Some("subagent")).expect("the subagent tool_execution_end");
    assert!(
        !is_error,
        "the subagent dispatch Completed (not Failed), got {result:?}"
    );
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        text.contains("the answer is 42"),
        "the SubagentCapture's final text (the child's last message), got {text:?}"
    );
    // The main's final assistant text (the tool-result turn's `stop`) —
    // polled (the store frames are not ordered against the settle — see
    // `full_turn`'s (c)).
    let rows = wait_for_rows(&h.db, "e2e-sub", 5).await;
    let v: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::from_str(r).expect("the row is JSON"))
        .collect();
    assert_eq!(
        v.len(),
        5,
        "system + user + assistant(subagent tool_calls) + tool + final assistant, got {v:?}"
    );
    assert_eq!(
        v[4]["content"], "all done",
        "the main's final assistant text"
    );

    // (d) The `subagent-closed` UI lifecycle event (the
    // `subagent.rs:721/743` payload shape — on EVERY exit path):
    // `status: "completed"` + the `metrics` populated (the
    // `SubagentCapture`'s final text + the wall clock).
    let sink_events = h
        .wait_sink(Duration::from_secs(30), |evs| {
            evs.iter().any(|(e, _)| e == "subagent-closed")
        })
        .await
        .expect("subagent-closed arrives within the bound");
    let closed = sink_events
        .iter()
        .find_map(|(e, p)| (e == "subagent-closed").then_some(p.clone()))
        .expect("the subagent-closed payload");
    assert_eq!(closed["sessionId"], child_id);
    assert_eq!(
        closed["status"], "completed",
        "the dispatch Completed, got {closed:?}"
    );
    let metrics = &closed["metrics"];
    assert_eq!(
        metrics["output"], "the answer is 42",
        "the metrics' output is the SubagentCapture's final text"
    );
    assert!(
        metrics["durationMs"].as_u64().unwrap_or(0) > 0,
        "the metrics' wall clock is populated, got {metrics:?}"
    );

    // (e) The child's `native_messages`: seq 0 = the `system_prompt`
    // envelope field (the `build_child_system_message` output — the
    // frontmatter body, `has_todo_tool` = `false`), then the user task
    // + the child's final text.
    let child_rows =
        h.db.load_native_messages(&child_id)
            .expect("the child transcript loads");
    assert_eq!(
        child_rows.len(),
        3,
        "system + user + assistant, got {child_rows:?}"
    );
    let cv: Vec<Value> = child_rows
        .iter()
        .map(|r| serde_json::from_str(r).expect("the row is JSON"))
        .collect();
    assert_eq!(
        cv[0]["role"], "system",
        "the child's seq-0 row is the system message"
    );
    // The `build_child_system_message` output (the frontmatter body —
    // `has_todo_tool` = `false` → the body verbatim, no TODO guidance).
    let expected_system =
        build_child_system_message(Some("You are a scout. Answer concisely."), false)
            .expect("a non-empty body yields a system message");
    assert_eq!(
        cv[0]["content"], expected_system,
        "the child's seq-0 row is the build_child_system_message output"
    );
    assert_eq!(cv[1]["role"], "user");
    assert_eq!(
        cv[1]["content"], "find the answer",
        "the child's user row is the task"
    );
    assert_eq!(cv[2]["role"], "assistant");
    assert_eq!(
        cv[2]["content"], "the answer is 42",
        "the child's final text"
    );
```

The un-pollled read is lines **1311–1313**, the count assert lines **1314–1318**
(`child_rows.len(), 3, "system + user + assistant, got {child_rows:?}"`). Key framing the
planner needs: step (d)'s `subagent-closed` `wait_sink` (lines 1289–1305) is the barrier
immediately before it — the race window is the gap between the parent's sink event and
the child process's last row landing in the shared SQLite file. The sibling MAIN read
(lines 1263–1276) sits above the `subagent-closed` wait and is already polled. Also note
steps (f)/(g) (lines 1347–1398) do follow-up `Db` reads (`session`, `list_sessions`,
honest clean-exit waits) that need no polling because they touch the `sessions` row /
process bookkeeping, not a racing transcript column — quoted only if the planner needs them;
they are unchanged by any fix here.

---

## 4. The documented mechanism

The comment block in the CONVERTED sibling
`a_child_with_a_tools_list_and_an_empty_body_gets_no_main_prompt`, lines 1520–1533 —
the file's own explanation of WHY the parent's connection may not observe the child's
row, verbatim:

```rust
    // The child's persisted transcript. The four sibling e2es all bound this
    // read with `wait_for_rows`; this one used to read ONCE and assert, on the
    // theory that the store frames all land before the child's
    // `agent_settled`. That premise does not hold end to end: `subagent-closed`
    // is the PARENT's sink event, and the child is a SEPARATE PROCESS writing
    // the same SQLite file, so the parent's connection is not guaranteed to
    // observe the child's answer row at the instant the close arrives. When it
    // didn't, the read saw only the task row and the vacuity guard below fired
    // ("got [\"{\\\"role\\\":\\\"user\\\"...}\"]") — observed once on
    // `macos-latest`, green on the sibling job of the same SHA.
    //
    // Bounding the read is the same contract the siblings use, and it costs
    // nothing when the ordering DOES hold: `wait_for_rows` returns on the first
    // poll that already has `want` rows.
```

Followed by the converted call (line 1534) and the load-bearing vacuity guard (lines
1539–1546):

```rust
    let child_rows = wait_for_rows(&h.db, &child_id, 2).await;
    let cv: Vec<Value> = child_rows
        .iter()
        .map(|r| serde_json::from_str(r).expect("the row is JSON"))
        .collect();
    // The guard that keeps "no `system` row" from passing on an EMPTY
    // transcript (a child that never persisted anything is a DIFFERENT bug).
    // Still load-bearing after the bounded read: it is what fires when the
    // wait TIMES OUT rather than filling.
    assert!(
        child_rows.len() >= 2,
        "the child persisted its task + its answer, got {child_rows:?}"
    );
```

History (`git log -p -S "load_native_messages(&child_id)" -- src-tauri/tests/worker_e2e.rs`):
this conversion landed in commit `6f501ab` ("feat: parse, enforce and report
agent-definition permissions (#101) + three defects (#104 #108 #118) (#123)"), which
turned that sibling's one-shot read (with the old comment "the store frames all land
before the child's `agent_settled` — the pump's capture-feed ordering — so no
`wait_for_rows` count race is needed") into the bounded read, and recorded the
`macos-latest` observation in the new comment. `git log -S wait_for_rows` shows the
helper itself first appearing in `d122332` (with `121f402` and `6f501ab` touching call
sites). The dispatch test's child read at line 1311 is the one read that never received
that conversion.

---

## 5. Census of row-count reads (verify / refute "sole un-polled")

`load_native_messages` call sites and row-count asserts in the file, marked polled vs
un-polled:

| # | Line(s) | Test / location | Read | Polled? | Count assert? |
|---|---|---|---|---|---|
| 1 | 284–285 | inside `wait_for_rows` | helper's own read | n/a (the poll) | no |
| 2 | 600 / 602–605 | `full_turn_real_worker_canned_provider` (e) | `wait_for_rows(&h.db, "e2e-full", 5)` | **polled** | yes — `rows.len() == 5` |
| 3 | 858 / 859 | `permission_round_trip_real_worker` | `wait_for_rows(&h.db, "e2e-perm", 5)` | **polled** | yes — `rows.len() == 5` |
| 4 | 943–954 | `crash_path_on_crash_fires_and_rows_stay_intact` pre-crash | inline `for _ in 0..100` + 50 ms sleep | **polled (inline)** | no — predicate: a user row present |
| 5 | 1010–1012 | `crash_path_on_crash_fires_and_rows_stay_intact` post-crash | direct `load_native_messages("e2e-crash")` | **UN-POLLED** | no — presence/role asserts only |
| 6 | 1263 / 1268–1272 | `subagent_dispatch_end_to_end_real_workers` MAIN read | `wait_for_rows(&h.db, "e2e-sub", 5)` | **polled** | yes — `v.len() == 5` |
| 7 | 1311–1313 / 1314–1318 | `subagent_dispatch_end_to_end_real_workers` CHILD read | direct `load_native_messages(&child_id)` | **UN-POLLED** | **yes — `child_rows.len() == 3`** ← the flake |
| 8 | 1534 / 1543–1546 | `a_child_with_a_tools_list_and_an_empty_body...` (converted) | `wait_for_rows(&h.db, &child_id, 2)` | **polled** | yes — `child_rows.len() >= 2` (guard) |

So:

- **Row-count asserts on `native_messages`: five total — four polled (rows 2, 3, 6, 8),
  one un-polled (row 7).** The issue's "five reads / four polled" is **correct at this
  HEAD** if it counts row-count asserts (five) — the one un-polled one is exactly the
  dispatch test's child read. The issue's count is *not* correct as a count of ALL
  `load_native_messages` reads (there are seven outside the helper), and the planner
  should know the census has exactly one more un-polled corner: **row 5**,
  `crash_path`'s post-crash read. That one is safe un-polled because it asserts
  presence/role (a system row first, a user row somewhere), never a count, and — more
  importantly — it runs AFTER the child was SIGKILLed (the writer process is dead, so
  no in-flight write can land behind it; the transcript is frozen at kill time).
- **The claim "every other row-count read goes through `wait_for_rows` or polls
  inline" holds** at this HEAD: row 4 is the only inline-poller row-count-relevant read
  and it predates the helper's need (predicate, not count); every truthful row-count
  assert not in the flaking child read is bounded.
- **The dispatch test is the ONE test whose child read "never got that treatment"**:
  its sibling-main read (row 6) has it; its child read (row 7) does not — and the
  converted sibling (row 8) shows the fix pattern already in the tree, same shape
  (`subagent-closed` barrier + separate child process + shared SQLite file).

---

## 6. What this test costs to run

- **Not `#[ignore]`d**: zero occurrences of `#\[ignore\]` in the file (grep-verified).
- **Not cfg-gated**: zero `cfg(` occurrences, no `#[cfg(target_os…)]`, nothing gated on
  real binaries beyond the file's own design — the REAL binary is `env!("CARGO_BIN_EXE_archimedes")`
  (line ~44, inside `RealWorkerFactory::spawn`), i.e. the test harness's bin is built
  automatically by cargo as part of `cargo test` (cargo sets `CARGO_BIN_EXE_*` for
  integration tests and builds the package's bins). The bin itself is the app binary
  (`src-tauri/src/main.rs`, `default-run = "archimedes"`; `--worker` arm dispatches to
  `archimedes_lib::run_worker()`). The WorkerFactory seam means the requirement is "the
  real binary exists", which every `cargo test` run satisfies.
- **Runs in plain `cargo test`** (the file's six `#[tokio::test]`s are ordinary tests;
  the suite is what CI runs on all three OSes, §7).
- **The exact command that runs ONLY this test locally** (from `src-tauri/`, the
  package root):

  ```bash
  cargo test --test worker_e2e subagent_dispatch_end_to_end_real_workers
  ```

  (the test filter is the bare fn name; `--test worker_e2e` scopes to this integration
  test target). The test needs no flags, no fixtures on disk beyond what it mints itself
  (wiremock servers bind ephemeral ports; the `~/.pi/agent/agents/scout.md` definition
  is written into a scratch `HOME` it creates and restores under `ENV_LOCK`).
- **Not macOS-gated — it can pass on Linux.** The whole file is platform-free (no
  `cfg` at all); CI runs the identical suite on `ubuntu-latest`, and this test is in
  the `worker_e2e` integration target that runs there. The macOS attribution in the
  comment (§4) describes where the flake was OBSERVED, not a platform requirement.
- **Can the flake be observed locally?** The race is a scheduling accident: the child
  is a separate process writing the shared SQLite file, and the parent's sink event
  (`subagent-closed`) is not ordered against the child's last row landing. It is
  theoretically observable on ANY OS by running the test (loop it); it was never
  observed deterministically — the tree's only recorded instance is the one
  `macos-latest` run, with the sibling job of the same SHA green. A planner should
  treat "reproduce locally" as unreliable: the failure mode is timing, and the
  pre-fix read has a 30-second-plus window to be late only under load/CI scheduling.

---

## 7. The file's gate commands as CI runs them

`.github/workflows/ci.yml`, job `lint-test-build` on matrix `os: [ubuntu-latest,
windows-latest, macos-latest]` (all three run the full Rust suite; `fail-fast: false`).
Steps, in order (`working-directory: src-tauri` where noted):

1. `rustup toolchain install` + `rustup default "$(rustup show active-toolchain | cut -d' ' -f1)"` (pin from `src-tauri/rust-toolchain.toml`).
2. `Swatinem/rust-cache@v2` (workspaces: src-tauri), `pnpm/action-setup@v4`, `actions/setup-node@v4` (node 22, cache pnpm).
3. Linux-only: apt `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils`.
4. `pnpm install --frozen-lockfile`.
5. `cargo fmt --all -- --check`.
6. `cargo clippy --all-targets -- -D warnings` (with the comment: "`--all-targets` is the documented gate (AGENTS.md); without it the integration tests under `src-tauri/tests/` are never linted").
7. Temp-dir census bracket, non-Windows only: `bash scripts/check-temp-dir-census.sh --self-test` (prove-it-can-fail), then a snapshot step that resolves the census base and writes `ARCHIMEDES_TEST_CENSUS_BASE` into `$GITHUB_ENV` (state file in `$RUNNER_TEMP`, outside the base).
8. `cargo test` — THE suite step, OS-shaped:
   - **Linux**: `env: XDG_DATA_HOME: ${{ runner.temp }}/archimedes-test-data`, `ARCHIMEDES_TEST_DATA_DIR: ${{ runner.temp }}/archimedes-test-data`, `run: cargo test`.
   - **macOS**: `env: HOME: ${{ runner.temp }}/archimedes-test-data`, `ARCHIMEDES_TEST_DATA_DIR: …`, `run: cargo test` (comment notes a redirected HOME can trigger a rustup auto-install into the fake home if `RUSTUP_HOME`/`CARGO_HOME` are unset; on hosted runners they are set outside HOME so it is instant).
   - **Windows**: plain `cargo test`, no redirect possible (`dirs` resolves via `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`, ignores `%APPDATA%`).
9. Non-Windows: `bash scripts/check-test-data-dir.sh "$ARCHIMEDES_TEST_DATA_DIR"` (crash-log leak guard), then `bash scripts/check-temp-dir-census.sh verify --state "$RUNNER_TEMP/archimedes-temp-census.txt"` (gated on the snapshot having succeeded).
10. `pnpm test --reporter=default --reporter=junit --outputFile=vitest-results.xml` (junit uploaded on failure, name includes `${{ matrix.os }}`), `pnpm build`.

**Data-dir/HOME redirection the suite needs:** on Linux/macOS the CI `cargo test` step
redirects the app data dir into `$RUNNER_TEMP/archimedes-test-data`; `test_support`
asserts the redirect took effect
(`the_ci_data_dir_redirect_took_effect` in `src-tauri/src/test_support.rs`, which reads
the inert-if-unset `ARCHIMEDES_TEST_DATA_DIR` and verifies `dirs::data_dir()` is under
it). The worker-e2e tests do NOT read the data dir they assert on (every `Db` is a
temp-dir `ScratchDir` from `temp_dir()` → `ScratchDir::in_env_temp("worker-e2e-", "scratch")`,
which is what the temp-dir census attribution table line 172, budget row
`worker-e2e-	src-tauri/tests/worker_e2e.rs`, tracks — a red `worker-e2e-` above budget
is a leak, NOT this flake). Tests that touch `HOME` (the subagent e2es, including the
flaking test at lines 1058–1095) do so under `archimedes_lib::test_support::ENV_LOCK`
with a `RestoreHome` drop guard — serializing against the other HOME-mutating tests'
`HOME` reads (`ENV_LOCK` defined at `src-tauri/src/test_support.rs:14`:
`pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());`).

---

## 8. What I could NOT verify from this machine

- **The race itself**: no test suite was run (read-only grounding; also prohibited).
  Whether `subagent_dispatch_end_to_end_real_workers` can actually see 2 rows at the
  line-1311 read is a timing observation I cannot reproduce here; the tree's evidence
  for the mechanism is the sibling's recorded `macos-latest` instance (§4) plus the
  structural argument (separate writer process vs parent connection).
- **GitHub issue #138's exact wording/numbering**: not fetched — I verified only the
  paraphrase supplied with this dispatch. If the planner needs the issue body verbatim,
  that fetch was not done here.
- **Whether the flake has a macOS-specific accelerator**: `macos-latest` was the
  recorded observation site, but nothing in the tree gates that platform or explains
  why macOS specifically; the runner's scheduling/IO characteristics are outside the
  tree.
- No builds, no `cargo metadata` resolution of transitive tool versions — the pinned
  toolchain exists but nothing was compiled (compile status of the quoted code at this
  HEAD is implied by the last green CI run, not by a local build).