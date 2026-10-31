---
status: committed
task: A2
wave: 1
issue: "#138"
area: worker-e2e
parent: docs/roadmap/macos-ci-flakes-status.md
owned:
  - src-tauri/tests/worker_e2e.rs
base: 60470d2
done-when: The child-transcript read in `subagent_dispatch_end_to_end_real_workers` runs through `wait_for_rows(&h.db, &child_id, 3)` with the exact-count assert `child_rows.len() == 3` kept verbatim, the file's direct `load_native_messages` occurrences are capped at exactly three by a green regression guard, and every gate command passes from a clean `src-tauri/` checkout.
---

# Task A2 — Route the child-transcript row-count read through `wait_for_rows`

**Goal:** Route the one un-polled row-count read in `subagent_dispatch_end_to_end_real_workers` (the child transcript read) through the file's existing `wait_for_rows` helper so the exact-count assert fails on the helper's 30 s deadline instead of racing the child process, and pin the read-discipline invariant with a cheap grep-style regression guard.

**Grounding:** this plan is written against `docs/roadmap/macos-ci-flakes-ground-worker-e2e.md` (grounded at `60470d2`), which carries the full census and mechanism; it is NOT restated here. Line numbers below are as of `60470d2` and were re-confirmed by direct read before writing — they will shift if the implementer edits earlier in the file, so every anchor names its landmark text.

**Context — corrected provenance (do not repeat the issue's error):**

Issue #138's phrasing ("this test never got that treatment") implies the recorded flake was observed here. It was not. The tree's only recorded instance — observed once on `macos-latest`, green on the sibling job of the same SHA — belongs to `a_child_with_a_tools_list_and_an_empty_body_gets_no_main_prompt` and is documented in that test's own comment block (currently lines 1520–1533). That sibling was ALREADY converted to `wait_for_rows` in commit `6f501ab`. What is true, and is the whole scope of this task: the dispatch test's CHILD read (currently lines 1311–1313) is the file's sole un-polled row-**count** read — its sibling MAIN read in the SAME test (line 1263) and every other count read already poll (five count asserts, four polled — the census is in the grounding report). The fix shape is unaffected by the attribution correction.

**Mechanism** (the file's own documented one, see the sibling comment at 1520–1533): `subagent-closed` is the PARENT's sink event; the child is a SEPARATE PROCESS writing the same SQLite file, so the parent's connection is not guaranteed to observe the child's answer row at the instant the close arrives. The un-polled read at 1311 sits immediately after the `wait_sink(30 s, "subagent-closed")` barrier (1289–1305) — the race window is the gap between that sink event and the child's last row landing.

**Decision — `crash_path_on_crash_fires_and_rows_stay_intact`'s post-crash read (line 1011): OUT of scope, by the default.** Reason recorded: it asserts presence/role (a `system` row first, a `user` row somewhere), never a count, and it runs AFTER the child is SIGKILLed — the writer process is dead, the transcript is frozen at kill time, no in-flight write can land behind it. It is therefore not the flake this task was given, and converting it would buy nothing. Residual risk is recorded in the grounding report's census (`docs/roadmap/macos-ci-flakes-ground-worker-e2e.md` §5, row 5); if the crash test ever asserts a POST-crash row COUNT, that read becomes in scope. The pre-crash inline poller (lines 938–959) is already bounded (its own `for _ in 0..100` loop) and is also untouched.

---

## Parallelisation

**Verdict:** SERIAL — this plan is exactly one commitable unit (one file, one commit), so at task grain it contains no wave: ordered work is carried by the `Steps:` checkboxes, not by sibling tasks, and no `**Parallel:**` line is emitted. The six gates are nonetheless settled at this grain: this task owns `src-tauri/tests/worker_e2e.rs` and nothing else; its sibling A1 owns `scripts/` + `docs/features/` (gate 1 disjoint), no symbol crosses the two (gate 2), no shared mutable artifact is touched by either (gate 3 — the gate commands here run inside `src-tauri/` and write no lockfile), each is provable from the base alone (gate 4), neither mutates the whole tree (gate 5), wave width 2 ≤ 4 (gate 6). Wave-level parallelism (A1 ∥ A2 in per-task worktrees) is the orchestrator's call and is recorded in `docs/roadmap/macos-ci-flakes-status.md`.

---

### Task A2: Poll the child-transcript row-count read and pin the read discipline

**Context:**

`subagent_dispatch_end_to_end_real_workers` (lines 1057–1398) reads the child's persisted transcript once, un-polled, and asserts exactly 3 rows (`system + user + assistant`). On `macos-latest` the assistant row has at times not landed by that read → 2 rows → red. While a deterministic repro is not possible here (the failure is a cross-process scheduling accident; see *Unverified*), the structural argument is settled and already accepted in this same file: the sibling test's conversion (commit `6f501ab`) fixed the identical shape. This task gives the dispatch test's child read the same treatment and adds a cheap guard so a fourth un-polled direct read cannot silently reappear.

**Files:**

- Modify: `src-tauri/tests/worker_e2e.rs` (the child read + its comment; adds one `#[test]` guard)
- Test: `src-tauri/tests/worker_e2e.rs` (the guard rides this same integration target — one test tree)

This is the task's entire owned set; nothing outside it is touched. Do not edit `src-tauri/src/storage/db.rs`, the `wait_for_rows` helper itself, or any other test.

**The helper the implementer must use — real signature, verbatim** (line 281):

```rust
async fn wait_for_rows(db: &Db, session_id: &str, want: usize) -> Vec<String>
```

- `Db` is `archimedes_lib::storage::Db` (file import at line 27). Existing call sites pass `(&h.db, "…", N)` / `(&h.db, &child_id, N)`; `&h.db` auto-derefs from `Arc<Db>`.
- Contract (do not rely on memory; the body is quoted in the grounding report): polls every 10 ms under a one-time 30 s deadline, and RETURNS THE PARTIAL LIST on timeout rather than panicking — the caller's `assert_eq!` is what fires on timeout. When the rows are already there (the normal case), it returns on the first poll and costs nothing.

**What to implement:**

1. **Convert the child read.** Replace (currently lines 1311–1313):

   ```rust
       let child_rows =
           h.db.load_native_messages(&child_id)
               .expect("the child transcript loads");
   ```

   with:

   ```rust
       let child_rows = wait_for_rows(&h.db, &child_id, 3).await;
   ```

   and append a bounded-read note to the step-(e) comment (currently lines 1306–1309) — keep the existing description and add the mechanism pointer, e.g. "The read is POLLED: `subagent-closed` is the PARENT's sink event and the child is a SEPARATE PROCESS writing the same SQLite file, so the parent's connection is not guaranteed to observe the child's answer row at the instant the close arrives (see the mechanism note at the `a_child_with_a_tools_list_and_an_empty_body_gets_no_main_prompt` sibling) — a no-op when the ordering holds." Do NOT use the literal token `load_native_messages` in this comment (see the guard, item 2).

2. **KEEP the exact-count assert VERBATIM** (currently lines 1314–1318) — unchanged:

   ```rust
       assert_eq!(
           child_rows.len(),
           3,
           "system + user + assistant, got {child_rows:?}"
       );
   ```

   This is what makes a genuinely missing row still fail — on the 30 s timeout, not on a race.

   Leave everything below it alone (the `cv` role/content asserts, lines 1319–1345, and steps (f)/(g)) — they assert per-row content, which the async `wait_for_rows` return does not disturb (`cv` derives from `child_rows` exactly as before).

3. **Add the regression guard** immediately after `wait_for_rows`'s closing brace (the helper currently occupies lines 281–292; the next landmark is the `/// The \`RpcEvent\` kinds among the collected frames (in order).` doc comment). Insert verbatim:

   ```rust
   /// Regression guard for this file's read discipline: a `native_messages`
   /// row-COUNT read must go through `wait_for_rows`; a DIRECT call to the
   /// native-messages loader is allowed at exactly three sites:
   ///   1. inside `wait_for_rows` itself (it IS the poll),
   ///   2. `crash_path_on_crash_fires_and_rows_stay_intact`'s pre-crash
   ///      inline poller (bounded by its own `for _ in 0..100` loop), and
   ///   3. the same test's POST-crash read — deliberately un-polled, but
   ///      safe: it runs after the child is SIGKILLed (the writer process
   ///      is dead, so no in-flight write can land behind it) and it
   ///      asserts presence/role, never a count.
   /// The needle below is SPLIT on purpose so this guard's own source
   /// cannot match the contiguous token it counts: keep the
   /// `concat!("load_native_", "messages")` form intact, and never write
   /// the contiguous token in this guard's comments or assert message —
   /// an un-split spelling inflates the count by 1 and reds the guard
   /// on itself.
   #[test]
   fn direct_native_transcript_reads_are_capped_at_three_sites() {
       let src = std::fs::read_to_string(concat!(
           env!("CARGO_MANIFEST_DIR"),
           "/tests/worker_e2e.rs"
       ))
       .expect("worker_e2e.rs reads — CARGO_MANIFEST_DIR anchors the path, CWD-independent");
       let needle = concat!("load_native_", "messages");
       let hits: Vec<usize> = src
           .lines()
           .enumerate()
           .filter(|(_, line)| line.contains(needle))
           .map(|(i, _)| i + 1)
           .collect();
       assert_eq!(
           hits.len(),
           3,
           "a direct {needle} read escaped the three legal sites above — every other \
            read must go through `wait_for_rows` (row counts must fail on the helper's \
            deadline, not on a race). Hits at file lines: {hits:?}"
       );
   }
   ```

   **False-positive verification for this guard (required by the task):** after the Step-1 conversion, the file contains exactly three occurrences of the contiguous token `load_native_messages` — line 285 (the helper's own read), line 944 (the crash test's pre-crash inline poller), line 1011 (the crash test's post-crash read). The guard's own source never contains the contiguous token (needle split via `concat!`, comments/message reference it as `native-messages`/`{needle}` only), so it cannot match itself. It therefore asserts `3` with zero false positives on the helper body, the inline poller, and the post-crash read — verified against the tree at `60470d2`, and re-provable by the Step-2 run. Cost/benefit: ~30 lines and one `#[test]` that runs everywhere `cargo test` runs; in exchange the invariant is machine-enforced, because the comment-convention alternative demonstrably already failed once — the sibling conversion (commit `6f501ab`) added a comment asserting all siblings bound their reads while line 1311 stayed direct and slipped past review. A `miri`-grade lint would be overkill for a one-file invariant; this grep guard is the cheap honest option and the assert message doubles as the convention note. If a legal site's shape legitimately changes later, the guard reds with the three-site explanation and is trivially re-pinned — that is the intended maintenance cost.

**What NOT to change:** the helper itself; the main-session read at line 1263; the crash test's two reads (lines 944, 1011 — recorded out of scope above); any `#[ignore]` or `cfg` gate (this test is neither, and must keep running in plain `cargo test` on all three OSes); any other file.

**Steps:**

- [ ] Add the regression guard `direct_native_transcript_reads_are_capped_at_three_sites` after `wait_for_rows`'s closing brace (snippet above), still with the child read un-converted.
- [ ] From `src-tauri/`: `cargo build --all-targets` (rebuilds `fake_worker` — a stale binary makes `manager::tests` lie), then `cargo test --test worker_e2e direct_native_transcript_reads_are_capped_at_three_sites`
  - Did it FAIL with 4 hits, one of them ~line 1312 (`h.db.load_native_messages(&child_id)`)? That failure is the proof the straggler exists (hits: 285 helper, 944 poller, 1011 post-crash, 1312 the child read). If it passed with 3, STOP — the tree differs from the grounding at `60470d2`; report it instead of proceeding.
- [ ] Convert the child read (lines 1311–1313) to `let child_rows = wait_for_rows(&h.db, &child_id, 3).await;`, append the bounded-read note to the (e) comment, and keep the `assert_eq!(child_rows.len(), 3, "system + user + assistant, got {child_rows:?}")` verbatim. Touch nothing else.
- [ ] Re-run from `src-tauri/`: `cargo test --test worker_e2e direct_native_transcript_reads_are_capped_at_three_sites` (must now PASS with 3 hits) and `cargo test --test worker_e2e subagent_dispatch_end_to_end_real_workers` (must pass; a local green on Linux is necessary but NOT the proof — see Acceptance 3).
- [ ] Full gate from `src-tauri/`: `cargo test` (lib + every integration suite), `cargo clippy --all-targets` (0 warnings — CI builds with `-- -D warnings`), `cargo fmt --check` (clean — CI runs `cargo fmt --all -- --check`). All green before committing; the baseline at `60470d2` was 1652 passed / 0 failed / 1 ignored in the lib plus every integration suite green, clippy 0 warnings.
- [ ] Commit, message: `test(worker_e2e): poll the child transcript row-count read (issue #138)`. Wave 1 of this run executes A2 in its own worktree on branch `feature/macos-ci-flakes-task02` — commit there, never on the feature branch or `main`; if the orchestrator fans the files in itself, leave this message verbatim for it.

**Acceptance criteria:**

- [ ] **Criterion 1 — rerouted read, assert kept.** `subagent_dispatch_end_to_end_real_workers`'s child-transcript read is `let child_rows = wait_for_rows(&h.db, &child_id, 3).await;` and the exact-count assert `assert_eq!(child_rows.len(), 3, "system + user + assistant, got {child_rows:?}")` is kept verbatim — a genuinely missing row still fails, on the helper's 30 s timeout rather than on a race.
- [ ] **Criterion 2 — regression guard for the invariant.** The file carries `direct_native_transcript_reads_are_capped_at_three_sites`, green in plain `cargo test`, asserting exactly 3 direct `load_native_messages` occurrences, verified not to false-positive on the helper's own body (line 285), the crash pre-crash inline poller (944), or the post-crash read (1011), and not on its own source (split needle). The NEXT un-polled row-count read in this file reds immediately.
- [ ] **Criterion 3 — honest proof legs.** The local Linux legs (targeted test + full `cargo test` + clippy + fmt) passing are necessary but NOT sufficient; nothing in this task claims local verification of the race. The actual proof is the `macos-latest` CI leg of the `worker_e2e` integration target on the integrated tree (after the orchestrator fans in Wave 1: A1 + A2), since this test runs un-gated in plain `cargo test` on all three matrix OSes. The task is the commit above; the flake's resolution is certified by the `macos-latest` leg, not by this machine.

## Unverified

- **The race itself** — not observable from this machine (cross-process scheduling accident; the tree's only recorded instance is the sibling test's `macos-latest` run). The structural argument + the sibling conversion are the basis; the `macos-latest` leg is the proof (Acceptance 3). Per `AGENTS.md`, macOS behaviour is unverifiable here.
- **`env!("CARGO_MANIFEST_DIR")` resolution** — for this package it is the directory of `src-tauri/Cargo.toml`, so `concat!(env!(...), "/tests/worker_e2e.rs")` is CWD-independent. No build was run while writing this plan (forbidden in this dispatch); Step 2's compile of the guard exposes any path surprise immediately.
- **Line numbers** — valid at `60470d2`; the implementer should re-anchor by the quoted landmarks (the helper's closing brace, the (e) comment text, the assert message) rather than by absolute numbers.
