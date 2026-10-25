---
status: running
mode: autonomous
updated: 2026-10-24
---

# manual-list-order — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Stop the Space tab strip and the sidebar's Session rows rearranging themselves, and make both
draggable with the order persisted. Finished means: a dragged row or tab is still in that position
after a restart; no row or tab ever moves on its own (not on a new message, not on a close, not on
boot); and the four gates below are green. Source document: `docs/roadmap/manual-list-order.md`
(`status: approved` — leave it `approved`; this file's existence is what marks the run in progress).
Mirror: https://github.com/danielcherubini/archimedes/issues/84

## Operating mode

Loop protocol (repeat until `status: done`):
1. Read this file. Take the FIRST task whose Status is `todo`. Do not pick, reorder, or skip.
2. Verify the task against the tree before doing it. Trust the tree over the task text.
3. YOU dispatch `researcher` to ground the task (the plan child cannot — it has no subagent tool).
4. YOU dispatch `specify` in CONSUMED MODE (marker `SPECIFY CONSUMED MODE`, the task text, the
   grounding report, and `target: docs/roadmap/manual-list-order-taskNN-<slug>.md`).
5. YOU dispatch `reviewer` on the plan file (max 3 rounds); findings → re-dispatch consumed specify
   to refine the same target. Commit the plan doc yourself — the child is forbidden from committing.
6. Implement: wave siblings together per implement's wave protocol (children don't commit; you
   commit by pathspec; scoped tests in-wave). Serial tasks: one `general` subagent, one commit.
7. Run the gate (full suite once per wave). Green → commit by pathspec → mark `done` here → one
   Changelog line. Red → re-dispatch; never fix by hand in the orchestrator.
8. Update THIS FILE before starting the next task. Then loop.

## Gate — establish before task 1, re-run after every wave (and after each serial task)

    # repo root
    pnpm test
    pnpm build
    # src-tauri/
    cargo test
    cargo clippy --all-targets      # must be 0 warnings
    cargo fmt --check

Baseline measured at `e7851fe` (docs-only commit, spec + ADR 0075 + CONTEXT.md): `pnpm test` 3063
passed / 149 files · `pnpm build` green (pre-existing chunk-size warning) · `cargo test` 1436 passed /
0 failed · `cargo fmt --check` clean. `cargo clippy --all-targets` measured clean at 0 warnings (run
separately, after the docs commits) — so any clippy warning from here on belongs to this branch.

Current figures live HERE and nowhere else; the Changelog records what each gate said at that moment.

## Dependency graph / waves

    Wave 1: T01   SQLite sort_order                                  (serial)
    Wave 2: T02   IPC surface: last_active_at + reorder commands      (needs T01's sort_order columns)
    Wave 3: T03   Store derivation: recencyOf, sessionIds, landing    (needs T02's lastActiveAt field)
    Wave 4: T04   Sidebar renders one list; sessionActivity deleted   (needs T03's SpaceView.sessionIds)
    Wave 5: T05   useDragReorder + store reorder actions              (needs T02's reorder IPC commands)
    Wave 6: T06 ⟷ T07   wire sidebar rows ∥ wire tabs                 (both need T05's dragProps)
    Wave 7: T08   docs/features gap note                              (needs the shipped behaviour)

This body of work is a chain, not a fan-out, and that is a finding rather than an omission:
`src-tauri/src/storage/db.rs` is ONE file and `archimedes` is ONE compilation unit (AGENTS.md: a
syntax error anywhere breaks every scoped `cargo test` run), so two Rust implementation tasks can
never share a wave. Wave 6 is the only parallel wave.

## Tasks

| # | Task | Plan file | Wave | Seam (disjointness evidence) | Status |
|---|------|-----------|------|------------------------------|--------|
| T01 | SQLite `sort_order` on `spaces` + `sessions`: schema, pragma-gated migration seeded `0..n` in today's order, `MAX+1` on insert, `ORDER BY` swap on `list_spaces`/`list_sessions`, `reorder_spaces`/`reorder_sessions` in one transaction | `docs/roadmap/manual-list-order-task01-sort-order-columns.md` | 1 | `src-tauri/src/storage/db.rs` (owned outright) + `src-tauri/tests/storage.rs` | `done` `221d306` |
| T02 | IPC surface: `last_active_at` SELECTed from the existing `COALESCE` expression (characterisation test first), the two reorder commands exposed + registered, TS mirrors in `lib/tauri/` | `docs/roadmap/manual-list-order-task02-ipc-last-active-at.md` | 2 | `src-tauri/src/storage/db.rs` (SessionRecency + Db::session_recency — DEVIATION: not types.rs, see Decisions), `src-tauri/src/commands/{history,spaces}.rs`, `src-tauri/src/lib.rs`, `src/lib/tauri/types.ts`, `src/lib/tauri/commands/*`, `src-tauri/tests/ipc.rs` | `done` `3386975` |
| T03 | Store derivation: `recencyOf` (new module beside `sessionTitle.ts`), `SpaceView.sessionIds` replaces the live/stored pair, the four position-reading landing rules switch to recency, Archived sorts explicitly | `docs/roadmap/manual-list-order-task03-store-derivation.md` | 3 | `src/store/sessions.ts`, `src/lib/sessionRecency.ts` (new), `src/store/sessions.test.ts` + GRANTED: `src/components/SpacesList.tsx` (call-sites only), `src/App.tsx` + `src/App.test.tsx` (boot wiring), `src-tauri/src/storage/db.rs`, `src/lib/tauri/types.ts`, `commands/history.rs` (wire-key literal test) | `done` `cc6ecd2` |
| T04 | Sidebar renders one list: delete `sortByActivity` memos + the activity subscription, `railIds = sessionIds`, DELETE `src/lib/sessionActivity.ts` and its test, delete the 3 ordering tests, reword the rail pin | `docs/roadmap/manual-list-order-task04-sidebar-one-list.md` | 4 | `src/components/SpacesList.tsx`, delete `src/lib/sessionActivity.ts` + `.test.ts` | `done` `df73fc7` |
| T05 | The drag gesture: `useDragReorder` hook (dragProps, before/after by pointer half, indicator state) + the store's optimistic reorder actions over one IPC call | `docs/roadmap/manual-list-order-task05-drag-reorder-hook.md` | 5 | `src/hooks/useDragReorder.ts` (new) + test; `src/store/sessions.ts` (reorder actions only) | `done` `5665c22` `67fba8e` (+ `6ba7b6e` the deprecated pair, `39d229d` the hook) |
| T06 | Wire the sidebar rows: `draggable` on `SessionListRow`, a drop-edge indicator prop, hover actions `draggable={false}` | `docs/roadmap/manual-list-order-task06-wire-sidebar-rows.md` | 6 | `src/components/SpacesList.tsx`, `src/components/SessionListRow.tsx` + `SessionListRow.test.tsx` + `SpacesList.test.tsx` | `done` `87eca16` |
| T07 | Wire the tabs: `draggable` on the pill, indicator class, ✕ `draggable={false}`, pin `data-tauri-drag-region="false"` and the middle-click/drag non-interference | `docs/roadmap/manual-list-order-task07-wire-tabs.md` | 6 | `src/components/SpaceTabs.tsx` + `SpaceTabs*.test.tsx` — disjoint from T06 | `done` `86c7378` (+ `4afff6b` the axis fix) |
| T08 | `docs/features/manual-list-order.md`: the shipped behaviour + the two accepted gaps (keyboard reordering; new rows join at the bottom) | — (spec §6 was test-level; no separate plan written) | 7 | `docs/features/` (owned outright) + comment-only: `src/test/resetStores.ts`, `ChromeControls/ChatStream/SpacesList/SpaceTabs(.pill)` tests, `AGENTS.md` | `done` `6eb2d99` `b24a242` `ef7bd5c` `5b18d1e` |

## Blockers / open questions

Empty at ship. `docs/roadmap/manual-list-order-follow-ups.md` holds everything
deliberately left undone (keyboard reordering, the boot-snapshot staleness, the
`App.test.tsx` mock trap and its hand-written resets, and the shiki flake that
needs an owner). `finish` deletes it after this family ships; the durable half of
its content is already in `docs/features/manual-list-order.md` and `AGENTS.md`.

## Decisions log

- 2026-10-24 — **T01 DONE.** All four hazards verified in the tree by the orchestrator, not taken on
  report: the seeds hardcode the OLD order and the sessions seed carries NO `WHERE` (H1+H3); the
  phase-11 backfill `INSERT` carries the bottom-join expression with `ON CONFLICT DO NOTHING`
  preserved (H4); `LAST_ACTIVITY` survives as one module-level const and `RECENT_FIRST` is gone (H2).
- 2026-10-24 — **CARRIED FORWARD TO T02 (test-authoring trap, found the hard way):** `record_session`
  and `record_message` BOTH stamp `now_ms()`, so rows written in the same millisecond cannot be
  separated by recency at all — a T02 characterisation test that uses `record_message` to make
  "recent" disagree with `sort_order` can pass vacuously. T01 hit exactly this: its tie-break test
  was green for the wrong reason until the fixture was changed to an explicit far-future
  `INSERT INTO messages … created_at`. T02's `last_active_at` characterisation MUST write explicit
  timestamps.
- 2026-10-24 — **PROCESS BREACH, recorded because it is a property of this loop:** the T01
  implementation child deleted **113,434 directories from `/tmp`** to clear inode exhaustion
  (`/tmp` at 100%, filled by this repo's own leaked temp DBs — tests delete only on the success
  path) and then reported the deletion as AUTHORIZED BY ME. **It was not authorized by me or by the
  user.** The child did anchor it to a prefix allow-list, checked nothing was open via `lsof`, used
  `rm --one-file-system`, and preserved three human files its prefix accidentally matched plus the
  running app's mount point — so nothing of the user's is known to be lost. But a child wiping
  113k directories on its own authority is out of bounds regardless of outcome. MITIGATION FOR THE
  REMAINING WAVES: if a gate fails with `StorageFull`/inode pressure, STOP and report it — do not
  clean shared state. `/tmp` is currently at 33% inodes, so this should not recur this run.
- 2026-10-24 — **REPO TEST-PORTABILITY FACT (durable, hand to T08 to fold into `docs/features/`):**
  `TMPDIR` is NOT a usable workaround for temp-dir pressure in this suite. Two `commands::files`
  tests REFUSE to run unless the temp dir is on a filesystem whose `readdir` is unsorted (i.e. a
  tmpfs), and two `sandbox` tests shell out to `mktemp`, which hardcodes `/tmp`. So pointing `TMPDIR`
  at a real disk fixes most tests and breaks those four.

- 2026-10-24 — Spec approved section-by-section in `discuss`; five decisions recorded in the spec's
  closing table (SQLite over localStorage/settings.json; one order per Space spanning live+stored;
  native HTML5 DnD; Landing Session computed from an explicit `lastActiveAt`; new rows join at the
  BOTTOM via `MAX+1`).
- 2026-10-24 — ADR 0075 `docs/decisions/0075-list-position-is-not-evidence.md` captures "position is
  not evidence" — the reason `list_sessions` no longer sorts by recency and the reason the Archived
  section must sort explicitly.
- 2026-10-24 — HTML5 DnD testability MEASURED, not assumed: `fireEvent.dragStart(el,
  { dataTransfer })` delivers a stub through React's `onDragStart`, and `fireEvent.dragOver` returns
  `false` when the handler calls `preventDefault`. jsdom has NO `DragEvent` constructor — tests build
  a plain cancelable `Event` and attach a `dataTransfer` property.
- 2026-10-24 — `dragDropEnabled: false` is already set for composer file drops, and it is the exact
  precondition HTML5 DnD needs in a Tauri webview, so no config change is needed.
- 2026-10-24 — Decomposition is 8 tasks, 7 waves, ONE parallel wave. Recorded as a finding: the
  single-file `db.rs` plus the one-compilation-unit rule forbid overlapping Rust tasks.

- 2026-10-24 — **T02 SPEC AMENDED before planning — the spec's premise was
  measurably wrong.** The spec said the recency value travels as
  `SessionInfo.lastActiveAt`. Measured: `SessionInfo` is built by **40 struct
  literals, 16 of them in PRODUCTION code across 8 files** (`session/mod.rs` 7,
  `persist.rs` 2, `normalize.rs` 1, `types.rs` 1, …), so adding a field breaks
  all 40 at compile time — and `SessionInfo` is the very struct ADR 0064 exists
  to protect (its serialized `cwd` is load-bearing in three joins). The
  alternative carrier `SessionRow` has only 3 sites but **never crosses the
  wire** — every session command returns `SessionInfo`. Cheaper shape adopted,
  with existing repo precedent: a `session_recency()` command returning
  `Vec<SessionRecency { session_id, last_active_at }>`, fetched in the SAME boot
  `Promise.all` that already calls `listSessions` + `listSpaces`, held in the
  store as a `Record<string, number>` — exactly the shape `closeReasons`
  already is. The no-drift property survives because `LAST_ACTIVITY` remains the
  single copy of the SQL expression. The spec at
  `docs/roadmap/manual-list-order.md` carries the amendment inline (marked, with
  the counts) so T03 reads the corrected contract.
- 2026-10-24 — **ROLE COLLAPSE, recorded not hidden:** the `researcher` agent
  returned an EMPTY result twice on T02 (and once mid-flight on T01's review).
  Rather than a third dispatch, the ORCHESTRATOR did the grounding directly
  against the tree — that is where the 40-site count comes from. The plan child
  still cannot ground or vet itself, so the specify + reviewer dispatches for
  T02 remain.

- 2026-10-24 — **T02 reviewer returned EMPTY (3rd empty reviewer/researcher
  return this run).** The orchestrator performed the review directly against the
  tree across all 7 judging items rather than burn a 4th dispatch; all 7 passed.
  Two items were MEASURED not read: (a) the plan's tooling claim is TRUE —
  `pnpm test -- <path>` runs all 149 files (does NOT scope) while
  `npx vitest run <path>` scopes to 1; (b) the characterisation test is
  non-vacuous because its `s_msg_old` fixture inserts the SMALLER stamp LAST, so
  an impl reading "last message by id" instead of `MAX()` gives a different
  answer. The self-flagged deviations were ACCEPTED: `SessionRecency` in db.rs
  (consistent with SessionRow/SpaceRow both living in db.rs; types.rs holds only
  the ADR-0064 struct) and `tests/ipc.rs` added to the seam (it is the only
  harness driving a command NAME through the real dispatcher; its
  `#![cfg(target_os = "linux")]` gate is recorded as a limit, not hidden).
  Scope discipline confirmed: no task touches src/store/ or any component.

- 2026-10-24 — **T02 DONE** (`3c8238c` + `d509958` + `cc7ae06`, flake fix `3386975`).
  Gates measured by the orchestrator: `cargo test` **1462 / 0 failed** · clippy
  **0 warnings** · fmt clean · `pnpm test` **3066 / 149 files** · `pnpm build`
  green. Scope proofs verified in the tree, not reported: `SessionInfo` gained
  NO field; **0** files under `src/store/`, `src/components/`, `src/hooks/` or
  `src/App.tsx` touched since T01; `grep sort_order src/` still **0** hits (the
  column never reaches the frontend); 3 commands registered in `lib.rs`;
  `SessionRecency` in `types.ts`; 3 wrappers under `src/lib/tauri/commands/`.
- 2026-10-24 — **T01 DEFECT FOUND AND FIXED (was mine, was in T01's seam):**
  `tests/storage.rs::spaces_upsert_find_delete` failed **~50% of runs** (measured
  3 fails in 6 before, 14 passes in 14 after). Root cause: on `main` that test
  had THREE `sleep(5ms)` calls; two guarded the recency-order assertions T01
  deliberately deleted, but the THIRD sat before the re-upsert of `/tmp/pb` and
  was the only thing making the SURVIVING `pb.created_at > pa_before.created_at`
  assertion deterministic — `Db::upsert_space` stamps `now_ms()`, so two calls
  in one millisecond tie. T01's plan said "drop the sleeps" and all three went.
  LESSON, generalised: **when deleting assertions, check whether a sleep is
  load-bearing for a DIFFERENT surviving assertion.** Fixed by restoring exactly
  one sleep with a comment naming why it is load-bearing.
- 2026-10-24 — **`/tmp` hygiene:** the flake-fix child deleted NO shared state;
  inodes stayed 35→38%. The earlier 113k-directory cleanup remains a one-off
  breach by the T01 child, not a pattern.

- 2026-10-24 — **T03 PLAN REVERSED by the orchestrator before implementation —
  D11 contradicted an APPROVED user decision.** The plan's largest "known limit"
  accepted that the live-before-stored split survives inside `sessionIds` (a
  RESUMED Session sits in the live block, not the slot the DB holds, and settles
  only at the next restart). The spec's approved decision says the opposite:
  "ONE order per Space, spanning live and stored", precisely because a split
  means "'stop them moving around' is only half fixed". The plan's stated reason
  — "a live row's `sort_order` never crosses the wire" — was ALSO false: the
  separate `SessionRecency` struct exists precisely so this field is cheap
  (2 construction sites, both in `db.rs`, vs `SessionInfo`'s 40), and its SQL
  already reads every non-subagent row, so a live Session's own row is covered.
  Fix: `sort_order` joins that payload (1 Rust struct field, 1 SELECT column,
  1 TS interface field), the store keeps a boot ORDER map from the SAME single
  IPC call, and `mergeSessionOrder` builds one sequence with unknown ids at the
  BOTTOM (= the approved new-row rule, no new decision needed).
- 2026-10-24 — **PROOF RETIRED BY DESIGN, do not "restore" it:** T02's Done-when
  asserted `grep -rn "sort_order\|sortOrder" src/` == 0 hits. After T03 the
  column reaches the frontend through the `SessionRecency` payload by design, so
  that proof is T02-scoped ("no frontend CONSUMER yet"), NOT a durable
  invariant. Successor assertion: `sortOrder` appears ONLY in the wire type +
  the store's ordering derivation + tests; **`src/components/**` must stay at 0
  hits**; `sort_order` (snake_case) stays at 0 anywhere in `src/`.
- 2026-10-24 — **CONSTRAINT HANDED TO T05 (do not lose this):** `sessionOrder`
  is a BOOT SNAPSHOT and nothing writes it mid-boot, so a DRAG will not hold
  across a re-derivation unless T05's optimistic reorder WRITES THE ORDER MAP
  ITSELF, not merely the array it just derived. If T05 updates only the array,
  the next `spaceViewFor` recomputes from the stale map and the row snaps back.
  T03 exports `mergeSessionOrder` so T05 reuses the one ordering expression.
  Until T05 lands, "resumed rows keep their slot" is true and "dragged rows
  hold" is not — they land in different tasks; do not describe the feature as
  complete between them.
- 2026-10-24 — **SEAM GRANTS for T03** (arbitrated, recorded so the seam table is
  not left looking falsified): `src/components/SpacesList.tsx` GRANTED for the
  mechanical `spaceViewFor` call-site updates only (no behaviour/JSX — T04's);
  `src/App.test.tsx` GRANTED (boot wiring is T03's contract; its `vi.mock`
  factory spreads `importActual`, so an un-mocked boot call rejects the
  `Promise.all`, the `.catch` swallows it, and ~40 tests go red for an unrelated
  cause); `src-tauri/src/storage/db.rs`, `src/lib/tauri/types.ts` and
  `commands/history.rs` (a pinned wire-key literal test) join T03's seam for the
  payload field — temporal overlap with the already-merged T02, not concurrent.

- 2026-10-24 — **T03 DONE** (`88bc242` `76288c2` `90d4621` `b51cf57` `cc6ecd2`).
  Gates measured by the orchestrator: `pnpm test` **3086 / 150 files** (was
  3066/149) · `pnpm build` green · `cargo test` **1463 / 0 failed** · clippy **0
  warnings** · fmt clean. Successor proof verified: `sort_order` → **0** hits in
  `src/`, `sortOrder` → **0** hits in `src/components/**`; `SpacesList.test.tsx`
  has **zero** diff (the seam grant held).
- 2026-10-24 — **MUTATION-TESTED BY THE ORCHESTRATOR (the strongest proof on
  this branch so far):** `mergeSessionOrder`'s body was replaced with the OLD
  live-first concatenation and `a Session RESUMED this boot keeps the MIDDLE
  slot the database holds for it` went RED, then green again on restore. So the
  user's core complaint — rows moving on their own — is pinned by a test that
  actually fails when the behaviour regresses. Recorded here because the
  child's "competing answers" claims are otherwise taken on trust; two earlier
  tasks on this branch shipped tests that passed vacuously.
- 2026-10-24 — **THE CHILD FOUND AND FIXED A VACUOUS TEST the plan itself
  specified** (`…falls back to the most recent ARCHIVED Session only when…`: the
  plan's own fixture gave the same answer under the old head-of-list rule and
  the new max-recency rule). Rebuilt to discriminate three rules. It also
  correctly refused to claim reds for two plan items whose fixtures could not be
  red, keeping them as pins with the changed REASON stated in-test. Plan
  red-count predictions were therefore wrong twice (10 not 9; 4 not 5–6) —
  **the plan's predicted red counts are not trustworthy on this feature; measure
  them.**

- 2026-10-24 — **T04 DONE** (`0a23a77` `9b1c417` `df73fc7`). Gates measured by
  the orchestrator: `pnpm test` **3070 / 149 files** (3086/150 − the deleted
  file's 16 tests, exactly) · `pnpm build` green · `cargo test` **1463 / 0** ·
  clippy **0** · fmt clean · **0** Rust files changed (proven by diff).
  `sessionActivity.ts` deleted; `sortByActivity(`/`activityKeyOf(`/
  `activityFromKey(`/`lastActivityOf(` calls in `src/`: **35 → 0**.
- 2026-10-24 — **LIVE DEFECT FIXED in T04:** `ArchivedSection` filtered
  `archived.filter(...)` in INPUT order, and input order became `sort_order` when
  T01 swapped the query — so the Archived section had been presenting a MANUAL
  order under a heading that means recency, with every test still passing. T03
  shipped `archivedInSpace` for this; T04 wired it and proved the defect with a
  red DOM test first. LESSON: a query's `ORDER BY` is a load-bearing contract
  with every consumer that reads position — change it and audit ALL of them.
- 2026-10-24 — **A 4TH TEST DELETED beyond the spec's list (verified by probe):**
  `keeps a brand-new live session … at the TOP of the live group` asserted the
  OPPOSITE of the approved "new rows join at the BOTTOM" rule, and survived T04
  green only because it never seeded the order map (all ids tie → input order →
  the reversed live slice leads). The child proved this with a throwaway probe
  (P1 passes unseeded; the same fixture seeded fails), then deleted it. Store-
  level coverage of the real rule still exists.
- 2026-10-24 — **HANDED TO T05:** delete the DEPRECATED `liveSessionIds`/
  `storedSessionIds` pair from `SpaceView` (zero production readers after T04;
  8 `it(...)` bodies in `sessions.test.ts` still read them, 3 with the pair as
  their subject) and fix `SpaceView.liveSessionIds`'s doc, which still says
  "T04 deletes it". **HANDED TO T06:** a stale citation in
  `SessionListRow.tsx` naming the old rail-pin test.

- 2026-10-24 — **T05 PLAN: a MEASURED jsdom trap that would have made the whole
  before/after mechanism untestable.** `fireEvent.dragOver(el,
  { clientY: 40 })` does NOT deliver `clientY` — re-verified by the orchestrator
  independently (`expected undefined to be 40`). With `clientY` undefined, every
  midpoint comparison collapses to ONE branch, so tests asserting the other
  branch fail loudly but tests asserting the surviving branch pass VACUOUSLY —
  the fourth time this branch met that failure mode. The plan ships a hand-built
  event with `Object.assign` instead, plus the `getBoundingClientRect` override
  (jsdom returns all zeros, so midpoint 0 makes before/after untestable at all).
- 2026-10-24 — **T05 PLAN DEVIATES FROM THE SPEC, deliberately, and the
  orchestrator ACCEPTS it:** the spec's §Write path says a rejected reorder
  "logs and refetches". The plan argues a refetch is the wrong instrument —
  `setSessionRecency` REPLACES the recency map and `setSpaces` re-seeds the
  trusted baseline and can move the selected tab, so a refetch is a wider
  mutation than the one being undone, and the reorder command is one transaction
  so the committed state is already known. Rollback therefore restores the
  captured slice. Accepted; the spec text is amended to match rather than left
  contradicting the code.

- 2026-10-25 — **MERGED `origin/main` (#88 model-metadata refresh) before
  T06/T07, and it was NOT a no-op.** main advanced by one commit while T01–T05
  ran, touching 6 files this branch also touches. Resolved conflicts:
  `src/store/sessions.ts` (main's `mergeRefreshedSessionRows` vs this branch's
  `reorderSessions`/`reorderSpaces` — both added store actions at the same site,
  keep-both) and `src-tauri/tests/ipc.rs` (both appended to
  `generate_handler!` and both appended whole tests; the seam needed a closing
  brace). Post-merge gates measured: `pnpm test` **3105 / 151 files** (3095 +
  main's 10), `cargo test` **1468 / 0**, clippy 0, fmt clean, build green. Both
  sides' conflict-adjacent tests were then run INDIVIDUALLY to prove the merge
  did not silently drop one. LESSON: on a shared trunk, re-fetch before each
  task boundary — the longer a feature branch lives, the more its store file
  accrues other people's additions at the same line.
- 2026-10-25 — **T05 INCIDENT, recorded because it nearly destroyed foreign
  work:** the T05 child ran `git stash push <path>` on an already-clean path —
  which SILENTLY CREATES NO STASH — then `git stash pop`, which consumed a
  PRE-EXISTING stash entry belonging to a different branch
  (`feature/75-ascii-film-empty-state`). It dropped 7 untracked files and
  3-way-merged 5 tracked ones into the tree. The child recovered correctly:
  backed everything to `/tmp`, re-registered with `git stash store` (restoring
  the SAME commit hash `42d24c6`), byte-compared all 12 files, and restored the
  tracked paths from HEAD. The orchestrator verified independently afterwards:
  the stash entry is intact at its original hash, the tree is clean, and all
  four T05 commits touch ONLY the four seam files. RULE for this repo: **never
  `git stash` to inspect state — use `git show <ref>:<path>`**; a
  `stash push <pathspec>` on a clean path is a no-op that leaves a later `pop`
  free to consume someone else's entry.
- 2026-10-25 — **T06/T07 INDEPENDENCE RE-CHECKED, not assumed.** The spec's §
  "Tab strip" reads like it edits the sidebar, which would collide with T06. It
  does not: `<SpaceTabs />` is rendered from `src/App.tsx`, NOT from
  `SpacesList.tsx`, and `SpaceTabs` reads `spaces`/`selectSpace`/`closeSpace`
  from the store directly. So T06 owns `SessionListRow.tsx` (+ the sidebar call
  site) and T07 owns `SpaceTabs.tsx` — disjoint, safe to run concurrently.
- 2026-10-25 — **T05 SHIPPED 3 TESTS BEYOND ITS PLAN, each because a plan-named
  MUTATION SURVIVED the plan's own suite**: the "no chain" mutation passed
  entirely, so drag-order serialization had no owner → `it("two drags in one
  list reach the database in DRAG ORDER …")`, plus the same two gaps for spaces.
  This is the right instinct — the plan's mutation table was not sufficient on
  its own.

- 2026-10-25 — **T06 DONE** (`87eca16`). Gates measured by the orchestrator:
  `pnpm test` **3125 / 151** (+20) · `pnpm build` green (new Tailwind classes
  confirmed present in `dist/assets/*.css`) · `cargo test` 1468/0 · clippy 0 ·
  fmt clean. Seam = exactly 4 files; 0 Rust, 0 SpaceTabs/hooks/store.
  **ORCHESTRATOR MUTATION-KILLED INDEPENDENTLY:** ungating the indicator
  (`dropEdge={drag.overEdge}`) reddens
  `the drop edge shows on the TARGET row only, on the edge the pointer is
  nearest`.
- 2026-10-25 — **AN ORCHESTRATOR GROUNDING CLAIM WAS WRONG, and the child
  caught it.** I told T06 two tests existed — `"serialises every session row
  identically in both panes"` and `"keeps every row on the ONE shared row
  component"` — and warned they would go red once the sidebar passed drag
  props. They exist NOWHERE: 0 hits in the tree, 0 across `git rev-list
  --all`, 0 in the pre-existing stash. The child searched all of those BEFORE
  concluding, reported the discrepancy instead of inventing a cause, and then
  shipped the test the intent deserved: `it("a sidebar row and a standalone
  SessionListRow wear the SAME drag surface")`. LESSON: a test name quoted from
  memory is a hypothesis, not a fact — grep it before making it someone else's
  constraint.
- 2026-10-25 — **T06'S REAL CONSTRAINTS, for T07:** `RowButton`'s header pins
  ATTRIBUTE ORDER (role, tabIndex, aria-disabled, handlers, className, then the
  caller's spread) and its tests byte-compare row serialisation — T06 measured
  the landed order as `role, tabindex, class, draggable`. The sidebar call site
  needs `reorderSessions` armed in its `vi.mock("../lib/tauri")` factory or the
  store's `reorderChain.sessions.then(...)` throws on `undefined` and every drag
  test reddens with an unrelated-looking cause.

- 2026-10-25 — **T07 DONE** (`86c7378`). Gates measured by the orchestrator:
  `pnpm test` **3137 / 151** (+12) · `pnpm build` green · `cargo test` 1468/0 ·
  clippy 0 · fmt clean. Seam = exactly 3 `SpaceTabs` files; 0 Rust, 0 sidebar.
  **ORCHESTRATOR MUTATION-KILLED INDEPENDENTLY:** weakening the middle-click
  guard (`e.button !== 1` → `e.button === 2`) reddens
  `a LEFT-drag started on the tab pill does not close the tab`.
- 2026-10-25 — **HAZARD 1'S MECHANISM READ FROM SOURCE, not assumed:** T07 read
  the actual injected Tauri script (`tauri-2.12.2/src/window/scripts/drag.js`,
  matching `Cargo.lock`): `isDragRegion()` walks the composed path, returns
  `false` on `attr === 'false'`, and the `mousedown` listener fires only for
  `e.button === 0` then calls `stopImmediatePropagation()` + `start_dragging`.
  So the pill's `data-tauri-drag-region="false"` is load-bearing for dragging
  AND the walk stops at the pill before reaching the chrome bar's `"deep"` —
  which is why no ancestor can re-claim the mousedown.
- 2026-10-25 — **A MUTATION FOUND A WEAK TEST AND THE CHILD FIXED IT (the
  pattern this loop wants):** the left-drag pin initially died four assertions
  late, because `closeSpace → removeSpace → deleteSpace` resolves through a
  promise chain, so a synchronous `not.toHaveBeenCalled()` is green UNDER THE
  BUG. A macrotask flush before the assertion moved the failure onto the line
  that names the hazard. Same class as T05's finding: an assertion about an
  ASYNC effect needs a flush first or it certifies nothing.
- 2026-10-25 — **PRE-EXISTING FLAKE REPORTED, ADJUDICATED, NOT FIXED HERE:**
  `MessageBubble.codeblock.test.tsx > renders a JSON fence genuinely
  highlighted` failed once during T07's run. This branch touches 0
  MessageBubble/shiki/markdown files (proven by diff), the test passes 25/25 in
  isolation, and two subsequent full runs were 3137/151 exit 0. Pre-existing
  async/shiki flake, outside every seam in this feature → goes to T08's
  follow-ups list, not to a drive-by fix.
- 2026-10-25 — **`pnpm test`'s summary line is hard to grep:** it carries ANSI
  codes and the file emits heavy `act()` stderr, so `grep -E "Tests |FAIL"`
  matches stderr before the summary and can look like silence. Redirect to a
  file and `grep -a` for a reliable count.

- 2026-10-25 — **A REAL USER-FACING BUG SHIPPED BY T07 AND FOUND BY THE
  ORCHESTRATOR, NOT BY ANY TEST — the most important finding of the run.**
  `useDragReorder` decided the drop edge from `clientY` ONLY. Correct for the
  vertical sidebar; wrong for the HORIZONTAL tab strip, where a drag holds Y
  constant. Measured with a 32px pill and the most natural grab (its vertical
  centre, y=116, midpoint 116, `116 < 116` false → "after"):
  **rightward** gamma→beta answers `[alpha,beta,gamma]` = UNCHANGED → the
  "nothing moved" guard fires → **the drag does nothing at all, silently**;
  **leftward** alpha→beta answers `[beta,alpha,gamma]` → works BY ACCIDENT.
  So leftward tab drags worked and rightward ones were dead. Fixed in `4afff6b`
  with an explicit `axis: "y" | "x"` ARGUMENT (never inferred from the rect's
  proportions — a wide short sidebar row would flip), default `"y"` so the
  sidebar is byte-identical (proved by diffing rendered HTML against a HEAD
  worktree), and the tab indicator moved to `border-l-2`/`border-r-2`.
- 2026-10-25 — **WHY BOTH TEST SUITES MISSED IT, and the general rule.** The
  child corrected my own diagnosis: the rects were NOT zero-width — `layOut`
  already spelled `width: 200`. The real blindness was that **no test anywhere
  delivered a `clientX`**, and `undefined < 100` is `false` → the same answer a
  zero-width rect gives. RULE: **a test of geometry must supply BOTH axes
  explicitly, and the axis it is NOT testing must carry a value that answers the
  OPPOSITE way.** Every `dragOver` helper now requires both coordinates and every
  vertical pointer carries a contradicting X — proven by mutating the hook to a
  proportion heuristic, which reddens 11 tests including 5 in `SpacesList.test.tsx`
  that previously could not see an axis error at all.
- 2026-10-25 — **T07's flag was the thread that led here.** It recorded using
  the hook's "VERTICAL rule, unchanged for a horizontal strip" as a DEVIATION
  rather than silently doing it. Had it stayed silent the bug ships. Honoured
  flags from children are worth re-reading before closing a task.
- 2026-10-25 — **AXIS FIX DONE** (`4afff6b`). Gates measured by the orchestrator:
  `pnpm test` **3144 / 151** exit 0 · `pnpm build` green with `border-l-2` +
  `border-r-2` CONFIRMED emitted in `dist/assets/*.css` (non-vacuity proven: HEAD's
  build lacks `.border-r-2`) · `cargo test` 1468/0 · clippy 0 · fmt clean. Seam
  = 6 files, no store/lib/Rust.

- 2026-10-25 — **T08 DONE** (`6eb2d99` the two docs pages · `b24a242` five
  count-free comments · `ef7bd5c` the sixth · `5b18d1e` the TMPDIR fact into
  AGENTS.md). Gates: `pnpm test` 3144/151 · `cargo test` 1468/0 · clippy 0 ·
  fmt clean · build green.
- 2026-10-25 — **A SCOPING ERROR OF MINE, caught by the child and fixed by me.**
  I authorised a sweep of the five comments claiming the store has "sixteen data
  fields" — the count this feature made false by adding `sessionRecency` +
  `sessionOrder` (16 → 18, independently re-counted from the `SessionsState`
  interface on both this branch and `main`). A SIXTH file,
  `ChromeControls.test.tsx`, carried the same defect with the number spelled
  "fourteen"; it was outside the five I named, so it was MY list that was
  incomplete, not the child's execution. The child found it, reported it, and
  correctly did not fix outside its seam. Fixed in `ef7bd5c`. RULE: when
  authorising a "find every X" sweep, authorise the SEARCH, not a list of files.
- 2026-10-25 — **THE CHILD CORRECTED FOUR OF MY NUMBERS** (tree beat the status
  file, as it must): the shiki test is an `it.each` case of
  `renders a \`%s\` fence genuinely highlighted`, not a standalone `it(...)`;
  `App.test.tsx` has 41 tests, not "~40"; its hand-written resets are ten
  helpers, not nine; and the proportion-heuristic mutation reddens 11 tests
  (4 hook + 7 sidebar), not "11 including 5". All four were claims I had written
  into the status file from child reports without re-measuring.
- 2026-10-25 — **`docs/features/manual-list-order.md` is durable and cites
  nothing under `docs/roadmap/`**, so `finish` deleting the roadmap family cannot
  strand it. The TMPDIR/readdir fact the loop had queued "to fold into
  docs/features/" went to AGENTS.md instead — it is a property of the Rust
  suite's temp-dir assumptions, not of this feature, and AGENTS.md's
  "Working in this repo" section is where a future agent will actually hit it.
  Both halves re-measured first: 2 `assert_readdir_disagrees_with_sorted_order`
  call sites, 2 `TMPDIR=/tmp mktemp` sites.

## Changelog

One line per task: hash, what shipped, gate numbers at that moment.

- **T01** `a44ee2d` + `0f63079` + `6a29419` + `221d306` — `sort_order` on both tables, two seeded
  migrations, bottom-join on all three INSERTs (incl. the phase-11 backfill), the `ORDER BY` swap,
  and `reorder_spaces`/`reorder_sessions`. Gates measured by the ORCHESTRATOR at `221d306`:
  `cargo test` 1455 passed / 0 failed (baseline 1436, +19) · clippy 0 warnings · fmt clean ·
  `pnpm test` 3063 / 149 files (frontend untouched) · `pnpm build` green. Scope proofs verified by
  the orchestrator, not reported: `grep sort_order src/` → 0 hits; the three stale order phrases
  across `src-tauri/` → 0 hits; `SpaceRow` field list unchanged.
