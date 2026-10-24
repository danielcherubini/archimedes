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
| T01 | SQLite `sort_order` on `spaces` + `sessions`: schema, pragma-gated migration seeded `0..n` in today's order, `MAX+1` on insert, `ORDER BY` swap on `list_spaces`/`list_sessions`, `reorder_spaces`/`reorder_sessions` in one transaction | `docs/roadmap/manual-list-order-task01-sort-order-columns.md` | 1 | `src-tauri/src/storage/db.rs` (owned outright) + `src-tauri/tests/storage.rs` | `in progress` |
| T02 | IPC surface: `last_active_at` SELECTed from the existing `COALESCE` expression (characterisation test first), the two reorder commands exposed + registered, TS mirrors in `lib/tauri/` | `docs/roadmap/manual-list-order-task02-ipc-last-active-at.md` | 2 | `src-tauri/src/types.rs`, `src-tauri/src/commands/{history,spaces}.rs`, `src-tauri/src/lib.rs`, `src/lib/tauri/types.ts`, `src/lib/tauri/commands/*` | `todo` |
| T03 | Store derivation: `recencyOf` (new module beside `sessionTitle.ts`), `SpaceView.sessionIds` replaces the live/stored pair, the four position-reading landing rules switch to recency, Archived sorts explicitly | `docs/roadmap/manual-list-order-task03-store-derivation.md` | 3 | `src/store/sessions.ts`, `src/lib/sessionRecency.ts` (new), `src/store/sessions.test.ts` | `todo` |
| T04 | Sidebar renders one list: delete `sortByActivity` memos + the activity subscription, `railIds = sessionIds`, DELETE `src/lib/sessionActivity.ts` and its test, delete the 3 ordering tests, reword the rail pin | `docs/roadmap/manual-list-order-task04-sidebar-one-list.md` | 4 | `src/components/SpacesList.tsx`, delete `src/lib/sessionActivity.ts` + `.test.ts` | `todo` |
| T05 | The drag gesture: `useDragReorder` hook (dragProps, before/after by pointer half, indicator state) + the store's optimistic reorder actions over one IPC call | `docs/roadmap/manual-list-order-task05-drag-reorder-hook.md` | 5 | `src/hooks/useDragReorder.ts` (new) + test; `src/store/sessions.ts` (reorder actions only) | `todo` |
| T06 | Wire the sidebar rows: `draggable` on `SessionListRow`, a drop-edge indicator prop, hover actions `draggable={false}` | `docs/roadmap/manual-list-order-task06-wire-sidebar-rows.md` | 6 | `src/components/SpacesList.tsx`, `src/components/SessionListRow.tsx` + `SessionListRow.test.tsx` | `todo` |
| T07 | Wire the tabs: `draggable` on the pill, indicator class, ✕ `draggable={false}`, pin `data-tauri-drag-region="false"` and the middle-click/drag non-interference | `docs/roadmap/manual-list-order-task07-wire-tabs.md` | 6 | `src/components/SpaceTabs.tsx` + `SpaceTabs*.test.tsx` — disjoint from T06 | `todo` |
| T08 | `docs/features/manual-list-order.md`: the shipped behaviour + the two accepted gaps (keyboard reordering; new rows join at the bottom) | `docs/roadmap/manual-list-order-task08-feature-doc.md` | 7 | `docs/features/` (owned outright) | `todo` |

## Blockers / open questions

Empty. See `docs/roadmap/manual-list-order-follow-ups.md` (written before the last task) for anything
deliberately left undone.

## Decisions log

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

## Changelog

One line per task: hash, what shipped, gate numbers at that moment.
