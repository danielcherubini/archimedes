---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/84
done-when: >
  Dragging a Space tab or a sidebar Session row to a new position and restarting
  the app leaves both lists exactly where they were left; no Session row and no
  tab changes position on its own at any point (not on a new message, not on a
  close, not on boot); and `pnpm test` + `pnpm build` + `cargo test` +
  `cargo clippy --all-targets` (0 warnings) + `cargo fmt --check` are green.
---

# Manual list order for Spaces and Sessions

## Problem

Two lists rearrange themselves and the user cannot stop them.

**Session rows move under the cursor.** `src/lib/sessionActivity.ts`'s
`sortByActivity` re-ranks the sidebar's rows by the loaded transcript's last
message stamp, so a row jumps to the top the moment its transcript gains a
message. `SpacesList.tsx` subscribes to that stamp specifically so the sort can
run on it (`activityKeyOf`), which means the list exists in a state designed to
be re-sorted.

**Space tabs rearrange overnight.** They do *not* move during a boot —
`addSpace` refreshes `lastOpenedAt` in place without re-sorting — but at the
*next* boot `Db::list_spaces` re-ranks by
`ORDER BY last_opened_at DESC, path ASC`, so the tab strip is rebuilt in an
order the user never chose. It reads as the app rearranging itself while they
weren't looking.

## The design in one line

**Position stops being evidence.** Today a list's position is *derived* from
recency, and four places in `src/store/sessions.ts` then read that position back
as meaning "most recent". After this change, position is a *stored* fact owned by
the user, and recency becomes an explicit field that any surface may sort by
when it wants recency.

## Scope

**In:** the Space tab strip's order; the sidebar's Session rows within the active
Space.

**Out:** the **Archived** section keeps following recency (a deliberate choice —
see §Archived section); keyboard reordering (recorded as an accepted gap in
`docs/features/`).

## Terminology

Two terms enter `CONTEXT.md` (see §Glossary):

- **Manual order** — a list's user-owned sequence, stored as `sort_order`. The
  only thing that changes it is a drag.
- **Landing Session** — the Session the Client opens on boot, on a tab click, or
  after closing a tab. Currently implicit in list position; becomes an explicit
  computation over a recency field.

## Section 1 — Storage

`sort_order INTEGER NOT NULL DEFAULT 0` on both `spaces` and `sessions`, added
by the repo's existing pragma-gated migration pattern (`db.rs:171` `trusted`,
`db.rs:190` `archived`): probe `pragma_table_info`, `ALTER` only when absent, so
a re-open never issues it and no error string is matched.

### Seeding

In Rust, not SQL: read the rows in *today's* order, write `0, 1, 2 …` back. A
`ROW_NUMBER()` window function inside a correlated `UPDATE` is the clever
version; the loop is the testable one, and `list_spaces` at desktop scale is not
a performance question. **Nobody's list changes shape on upgrade** — the manual
order begins as a copy of whatever they were already looking at.

### New rows join at the bottom

`sort_order = COALESCE((SELECT MAX(sort_order) FROM <table>), -1) + 1`, inside
the `INSERT` that already exists (`upsert_space` at `db.rs:749`, `record_session`
at `db.rs:333`).

The MAX is **global**, not per-Space. Display order is per-Space, but a global
sequence still lands a new Session last *within its own Space*, and it is one
expression instead of a correlated subquery per row. Consequence, accepted
deliberately: **a newly started Session appears at the bottom of the sidebar**
and stays there.

### Read queries change only their `ORDER BY`

| Query | Before | After |
|---|---|---|
| `Db::list_spaces` (`db.rs:777`) | `ORDER BY last_opened_at DESC, path ASC` | `ORDER BY sort_order ASC, path ASC` |
| `Db::list_sessions` (`db.rs:480`, the shared `RECENT_FIRST` const) | `ORDER BY COALESCE(MAX(messages.created_at), sessions.created_at) DESC, id DESC` | `ORDER BY sort_order ASC, id DESC` |

The tie-breaker (`path ASC` / `id DESC`) is kept: two rows with a equal
`sort_order` must not swap between reads.

This is why SQLite beat `localStorage`: the store's standing rule — *"input
order IS the order, do NOT re-sort"* (`src/store/sessions.ts:98`) — stays
**true** instead of being inverted. The frontend still never sorts.

### The recency field is not a new column

The expression `list_sessions` already sorts by —
`COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.session_id =
sessions.id), sessions.created_at)` — stops being only a sort key and becomes a
**selected field** on the row, and it reaches the frontend as a **separate
per-session recency map**, not as a field on `SessionInfo`.

> **Amended 2026-10-24, during T02's grounding.** The original text said
> `SessionRow.last_active_at` → `SessionInfo.lastActiveAt`. Measured against the
> tree, that is the expensive shape: `SessionInfo` is constructed by **40 struct
> literals — 16 of them in production code across 8 files** — and adding any
> field breaks every one of them at compile time. `SessionInfo` is also the
> struct ADR 0064 exists to protect (its serialized `cwd` is load-bearing in
> three joins), so widening it for a display field is the wrong door.
> `SessionRow`, by contrast, has 3 construction sites — but `SessionRow` never
> crosses the wire; every session command returns `SessionInfo`.
>
> The cheap shape, with repo precedent: a `session_recency()` command returning
> `Vec<SessionRecency { session_id, last_active_at }>`, fetched in the SAME
> boot `Promise.all` that already calls `listSessions` + `listSpaces`, and held
> in the store as a `Record<string, number>` side-channel — exactly the shape
> `closeReasons: Record<string, CloseReasonStr>` already is. One new small
> struct, one new command, zero edits to `SessionInfo`. The SQL expression still
> has exactly ONE copy (the `LAST_ACTIVITY` const), so the no-drift property the
> original design wanted is preserved.

Zero new write path and zero staleness, because the number is computed from the
`messages` rows at read time. It preserves the invariant the current code
explicitly fights for (`sessionActivity.ts`'s own header): *the number the row
prints and the number any recency decision reads are the same expression.*

`#[serde(default)]` on the TS side, matching how `title` and `is_subagent`
handle rows predating their field.

### The one landing rule

```
recencyOf(session, loadedMessages) →
  loadedMessages?.last.at ?? recencyMap[session.sessionId]
```

Prefer the transcript we have; else believe the row. This is the same
"prefer evidence" shape the deleted `unknowns: "first" | "last"` parameter
encoded, and unlike that parameter it is total. It lives beside `titleFor`
(`src/lib/sessionTitle.ts`), which is the repo's existing precedent for "one
function so two surfaces cannot disagree".

### Deletion

`src/lib/sessionActivity.ts` is **deleted outright** — `sortByActivity`,
`activityKeyOf`, `activityFromKey`, `lastActivityOf` have no remaining caller
(`relativeTimeFor` in `src/lib/sessionTime.ts` is a separate module and stays;
`lastActivityOf` moves into `recencyOf`'s file rather than being duplicated).
The sidebar stops subscribing to transcript activity for ordering purposes
entirely.

## Section 2 — The sidebar list

One order per **Space**, spanning live and stored. The live-before-stored split
today has no group headers, so it is invisible — purely an ordering rule — and
keeping it would mean a dragged row still jumps groups when it closes or
resumes, i.e. "stop them moving around" only half fixed. Live/stored remains
visible where it is a *fact*: the row's `SessionStatusMark` (spinner / `?` /
ring / dim ring) already says it.

`SpaceView` (`src/store/sessions.ts:177`) collapses its two id lists:

```ts
sessionIds: string[]         // was liveSessionIds + storedSessionIds, in sort_order
liveSessionId: string | null // unchanged — the tab's live dot still needs it
```

`liveSessionsInSpace` survives (it feeds `liveSessionId` and `mostRecentLiveInSpace`);
only the *display* list changes.

In `SpacesList.tsx`:

- the two `sortByActivity` memos (`:331`, `:335`) and the `activityKey` /
  `activity` pair (`:322`, `:323`) are deleted; the rows render `sessionIds`
  straight through;
- `railIds` (`:303`) stops being `[...liveIds, ...storedIds]` and becomes
  `sessionIds`. The collapsed rail's contract is "the Nth mark is the Nth row"
  (pinned at `SpacesList.test.tsx:2383`); one construction of that order is one
  fewer thing that can drift.

`handleSessionClosed` needs **no change**. It appends the closed id to the tail
of the array today — the bug `sortByActivity`'s `"last"` placement existed to
paper over (`SpacesList.test.tsx:709` "sorts a session that CLOSED this boot to
the top"). With `sort_order` the row keeps its number and therefore its slot, so
the fix is that the paper is deleted.

### The four places that read position as recency

| Site | Today | After |
|---|---|---|
| `selectSpace` (`sessions.ts:725`) | live (most-recently-**started**) else **head** of stored | live (unchanged) else **max `recencyOf`** of stored |
| `autoSelectActive` (`sessions.ts:144`) | first Space's first session | **first Space in manual order**, then max `recencyOf` |
| `spaceViewFor.newestId` (`sessions.ts:229`, the close-reason banner) | head of the stored subsequence | max `recencyOf` |
| `removeSpace` fallback (`sessions.ts:468`) | `spaces[0]` = "most recently opened" | `spaces[0]` — **unchanged**, now meaning "leftmost tab" |

`removeSpace` is unchanged on purpose: when a tab closes, landing on the tab to
its left is what a neighbour tab should mean, and that is exactly what the first
row of the manual order now is.

Tab-click still prefers a **live** Session over any stored one. A Space holding
a Worker mid-turn should show that turn, not the last finished chat. Recency
only decides the stored arm.

## Section 3 — Drag mechanics

### A shared hook

`src/hooks/useDragReorder.ts` owns the gesture; both lists use it.

```ts
useDragReorder({ ids, onReorder })
  → { dragProps(id): { draggable, onDragStart, onDragEnd,
                       onDragOver, onDrop, onDragLeave },
      draggingId: string | null,
      overId: string | null }
```

It answers three questions — what is being dragged, which row is the target,
where does the dragged id land — and both call sites supply their own
`onReorder` (one writes Space order, one writes Session order). Two independent
implementations of "compute the new index from a drop position" is precisely the
drift this repo documents elsewhere.

### Insertion rule

Drop **onto** a row; the pointer's position within it decides before-or-after.
`onDragOver` compares `e.clientY` against the target's `getBoundingClientRect()`
midpoint. No gap drop targets and no inserted placeholder row: the row *is* the
target, so nothing new needs laying out.

### Indicator — a class on the real row

`border-t-2` / `border-b-2` on the existing `SessionListRow` / tab pill. This is
forced, not preferred: `SessionListRow`'s file states a **no DOM level** contract
(every child is a direct child of the `role="button"` element), and 8
`.closest('[role="button"]')` sites plus `rowOf()` in `SpacesList.test.tsx`
resolve through ancestry. A portal-drawn ghost or an inserted placeholder breaks
both.

`RowButton` already spreads `...rest`, so `draggable` and the drag handlers reach
the DOM with **no change to that component** — which matters because its header
pins attribute order as part of its contract and byte-compares row serialisation.

### Handle

The whole row / pill is draggable. The existing hover-action controls (Stop /
Archive / Unarchive / Delete) and the tab's ✕ get `draggable={false}`, so a press
on a destructive control never starts a drag. Native ghost image, no hand-drawn
preview.

### Write path

Optimistic, matching `useAgentOverridesWrites`: the store rewrites the affected
slice in memory at once, then fires `invoke("reorder_spaces", { ids })` /
`invoke("reorder_sessions", { ids })`. A rejection logs through the repo's
existing `void`-command convention and **restores the captured slice**.

> **Amended 2026-10-24, during T05's planning.** This said "and refetches". A
> refetch is the wrong instrument for undoing a reorder: `setSessionRecency`
> REPLACES the recency map and `setSpaces` re-seeds the trusted baseline and can
> move the selected tab, so refetching is a WIDER mutation than the one being
> undone — it could move the user's selection while undoing their drag. And the
> command is one transaction, so after a rejection the committed state is already
> known: it is the slice captured before the optimistic write. Restoring that
> snapshot is strictly narrower and needs no round-trip.

The command takes the **whole visible slice's ids** and writes their `sort_order`
in **one transaction** (`unchecked_transaction`, the pattern `db.rs:239` uses for
the `todos_json` migration). A partial reorder is exactly the half-moved list
that reads as a bug, and sending the whole slice means the Rust side never has to
reconcile a partial set.

### Two hazards to pin in tests, not discover later

1. **The chrome bar is a Tauri drag region.** The tab pill already carries
   `data-tauri-drag-region="false"` (`SpaceTabs.tsx:383`) — that attribute is
   what stops Tauri's injected drag script claiming the mousedown, and it is
   what makes a tab drag possible at all. It becomes load-bearing for a second
   reason and needs a pin.
2. **The window-level drop backstop.** `useWindowDropBackstop` calls
   `preventDefault` on every window `dragover`/`drop`, because the webview's
   default for a drop is to *navigate to it*. It listens on `window` and the
   row's handler fires first during bubbling, so reordering works — but the row's
   `drop` must not need `stopPropagation` to win, and a reorder drag released
   outside any row must still be swallowed.

### Why native HTML5 DnD is safe here

`dragDropEnabled: false` is already set (`src-tauri/tauri.conf.json:18`) for
composer file drops (`docs/features/image-attachments.md:40`) — and that setting
is precisely the precondition for HTML5 drag-and-drop in a Tauri webview, so it
is already satisfied on all three platforms. Verified testability in this repo's
stack: `fireEvent.dragStart(el, { dataTransfer })` delivers a stub
`dataTransfer` through React's `onDragStart`, and `fireEvent.dragOver` returns
`false` when the handler calls `preventDefault` (both measured, not assumed).
jsdom has no `DragEvent` constructor, so tests construct a plain cancelable
`Event` with a `dataTransfer` property attached.

## Section 4 — Tabs and the Archived section

### Tabs

`SpaceTabs.tsx` renders `spaces.map(...)` — the store's order verbatim — and gains
the same hook with `reorder_spaces` as its write. `views` in `SpacesList` is
`spaces.map(spaceViewFor)`, so it inherits the manual order from the same array:
the tab strip and the sidebar's group ordering cannot disagree, because there is
one source.

The pill's middle-click close (`onMouseDown`, `button === 1`) must not fire on a
drag. It already returns early for `button !== 1`, so a left-drag falls through —
pin that.

### The Archived section keeps recency — and loses its free ride

It renders `archived.filter(...)` in input order, and input order *was* recency.
Once `list_sessions` returns `sort_order`, that filter silently renders in manual
order while still claiming to be recency — and it would pass every existing test
while reading as a random list in the app. So it must sort **explicitly** by
`recencyOf`, and so must `archivedSessionIds[0]` in `spaceViewFor.newestId`
(which reads the archived head as a last-resort landing candidate).

This needs its own test, not a comment.

Settings → Detached sessions inherits the new `list_sessions` order with no code
change. That is fine — the same benefit, and it is a management list, not a
recency list.

## Section 5 — Tests

### Deletions (behaviour we are removing — adapt nothing)

- `src/lib/sessionActivity.test.ts` — whole file.
- `SpacesList.test.tsx:609` "orders the LIVE group by last activity, above the
  STORED group"; `:647` "ranks a live session by ITS ACTIVITY, not by which was
  started last"; `:709` "sorts a session that CLOSED this boot to the top of the
  stored group".

`SpacesList.test.tsx:2383` ("keeps the rail's marks POSITIONALLY equal to the
rows after the activity sort") is **kept and reworded** — the contract it pins
survives, only its cause changes.

### New — Rust (`src-tauri/`)

1. The migration seeds `sort_order` `0..n` in today's order (spaces by
   `last_opened_at DESC`; sessions by the old recency expression), so an upgrade
   does not reshuffle anything.
2. The migration is idempotent on re-open (the `pragma_table_info` gate).
3. A new Space / Session gets `MAX + 1`, including the empty-table case
   (`COALESCE` → 0).
4. `reorder_spaces` / `reorder_sessions` write the given slice in one
   transaction; a mid-write failure leaves the prior order intact.
5. **Characterisation:** `session_recency`'s `last_active_at` equals the old `COALESCE(MAX(messages.
   created_at), created_at)` expression — including the no-messages case, where
   it must fall back to `created_at` rather than `NULL`. This is the pin that
   stops the field drifting from what the row prints.
6. `list_sessions` / `list_spaces` return `sort_order` order, with the tie-breaker
   holding for two equal values.

### New — store (`src/store/sessions.test.ts`)

7. `recencyOf` prefers a loaded transcript's stamp and falls back to
   `lastActiveAt`.
8. `selectSpace` picks the max-`recencyOf` stored session even when it is *not*
   the first in the manual order — the exact case the old code conflated.
9. A Session dragged to the bottom is still the **Landing Session** when it is
   the most recent. Position and recency are provably independent.
10. `autoSelectActive` lands on the first Space in manual order.
11. `spaceViewFor.newestId` reads max `recencyOf`, including the archived-only
    Space case.
12. The **Archived** section sorts by `recencyOf` and *not* by input order —
    constructed so the two orders differ, so the test cannot pass by accident.

### New — components

13. Five rows, drag row 5 onto row 2's top half → assert the exact resulting
    order; drag onto the bottom half → the other answer.
14. The rail's marks stay positionally equal to the rows after a drag.
15. A row's relative-time label updates while its position does not move.
16. The tab pill keeps `data-tauri-drag-region="false"` after a drag.
17. A `drop` released outside any row still reaches the window backstop (no
    navigation).
18. Hover actions and the tab ✕ carry `draggable={false}`.
19. A rejected reorder restores the slice captured before the optimistic write,
    and the list snaps back to its pre-drag order.

## Section 6 — Docs

- `CONTEXT.md`: add **Manual order** and **Landing Session**; **amend** the
  existing **Archived session** entry, whose "listed in the Archived section"
  wording currently leans on the server's recency order.
- `docs/decisions/0075-…`: *list position is not evidence* — hard to reverse (a
  schema change), surprising (a reader will ask why `list_sessions` no longer
  sorts by recency), and a real trade-off against the obvious "keep sorting, add
  a pin".
- `docs/features/manual-list-order.md`: the shipped behaviour, plus the accepted
  gap — **HTML5 DnD is pointer-only, so a keyboard user cannot reorder**, and the
  accepted consequence that a new Session joins at the bottom.

## Decisions taken during the discussion

| Question | Choice |
|---|---|
| Which orders become user-owned | Tabs + Session rows; the Archived section keeps following recency |
| Where the order lives | SQLite — a `sort_order` column on `spaces` and `sessions` |
| Does manual order span live/stored | Yes, one order per Space |
| Drag mechanism | Native HTML5 drag-and-drop |
| What the Landing Session becomes | Computed from an explicit `lastActiveAt` field |
| Where new rows enter | The bottom (`MAX + 1`) |

## Rejected alternatives

- **localStorage** (a `space-order` / `session-order` key, like
  `lib/leftPaneState.ts`): zero Rust and fastest to ship, but it makes order
  renderer state shadowing DB rows — the frontend must re-sort after every
  `setSpaces`/`setSessions`, inverting the "do NOT re-sort" rule — and clearing
  webview storage silently loses everyone's arrangement.
- **settings.json** (the `agentOverrides` precedent, ADR 0066): one write path
  already exists, but a per-Session order in an app-global settings document
  grows unbounded with history and needs its own GC on delete.
- **Pointer-events drag**: identical behaviour on all three webviews and
  fully-testable with real events, but it means hand-drawing the drag preview,
  handling `pointercancel`, and adding a movement threshold so a click still
  opens a Session — 2–3× the code for a benefit (`dragDropEnabled: false`) we
  already have.
- **Up/down buttons**: trivially testable and keyboard-accessible, but two more
  hover controls competing with Stop / Archive / Delete on a 260px row.
- **Land on the top row of the Space**: simplest possible rule, but it means
  booting into whatever happens to sit at the top rather than what was last
  worked on.
