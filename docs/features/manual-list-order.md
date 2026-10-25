---
status: live
last-verified: 2026-10-25
verified-by: every claim below re-read against this tree at `e923a7f`, not lifted from the plan or the loop status file — both read queries' `ORDER BY` and their tie-breakers, the bottom-join expression on all three `INSERT`s, `mergeSessionOrder`'s single non-test call site, `useDragReorder`'s `axis` argument and both call sites' indicator classes, `archivedInSpace`'s explicit sort, and the store's data-field census re-counted from the `SessionsState` interface. Where the roadmap and the tree disagreed the tree won, and the sentence that replaced it says so. Gates re-measured at the same commit: `pnpm test` 3144 passed / 151 files · `pnpm build` green · `cargo test` 1468 passed / 0 failed · `cargo clippy --all-targets` 0 warnings · `cargo fmt --check` clean.
---

# Manual list order — the Space tabs and a Space's Session rows

Two lists in the left of the window used to rearrange themselves: a sidebar row
jumped to the top when its transcript gained a message, and the tab strip came
back in a different order every boot. Both are now **user-owned**. This page is
the shipped behaviour, the one list that is deliberately still sorted by
recency, and the limits that were accepted rather than overlooked.

## What it is

- The **Space tab strip** and one **Space**'s **sidebar Session rows** are a
  **Manual order** — the `sort_order` column on the `spaces` and `sessions`
  rows (CONTEXT.md: **Manual order**). The only thing that changes it is a drag.
- **Nothing moves a row on its own.** A new message leaves it where it is (its
  relative-time label keeps updating; the slot does not — pinned by
  `SpacesList.test.tsx`'s `it("updates a row's relative time while its POSITION
  stays frozen")`). A Session **closing** leaves it where it is:
  `handleSessionClosed` still appends the closed row to the tail of
  `historySessions`, and that tail position is inert, because the rows render
  through `mergeSessionOrder`, which reads the row's stored number and nothing
  else. A **restart** leaves it where it is — the number is what was written to
  SQLite (`db.rs`'s `reorder_spaces_survives_a_reopen`).
- **New rows join at the BOTTOM.** `sort_order = COALESCE((SELECT MAX(sort_order)
  FROM <table>), -1) + 1` inside the `INSERT` that already existed
  (`Db::record_session`, `Db::upsert_space`, and the phase-11 Space backfill in
  `Db::open`), and a row the client has no number for yet sorts at the bottom
  (`mergeSessionOrder` → `sortByManualOrder`, which sends the unknowns last —
  never `0`, which would promote a fresh row to the top of a list the user
  arranged).
- **One sequence spans live and stored.** `SpaceView.sessionIds` is a single
  array built by `mergeSessionOrder` from this Space's live rows, its stored
  rows and the order map. There are no group headers and no live block, so a
  Session **resumed** this boot keeps the middle slot the database holds for it
  rather than jumping to the front (`it("a Session RESUMED this boot keeps the
  MIDDLE slot the database holds for it (one sequence spans live and stored)")`).
  Live/stored stays visible where it is a *fact* — the row's `SessionStatusMark`
  — and never as a position rule.
- **One sequence, so nothing can disagree.** `SpacesList`'s `views` is
  `spaces.map(spaceViewFor)`, the tab strip renders `spaces` verbatim, and the
  collapsed rail's `railIds` IS `activeView.sessionIds`. The tab strip, the rows
  and the rail's marks all read one array.
- **Position means position.** It is not a proxy for recency anywhere in the
  frontend; see the ADR below.

## Why it is affordable — ADR 0075

`docs/decisions/0075-list-position-is-not-evidence.md`. Position used to be a
*derived* fact — tabs ranked by `last_opened_at`, rows by their transcript's
last stamp — and four sites in `src/store/sessions.ts` then read that position
back as **evidence of recency**: `autoSelectActive`, `selectSpace`,
`spaceViewFor`'s landing choice (its `lastReason`; the ADR names it by its
then-name, `newestId`, which is now the local `landingId`) and `removeSpace`'s
fallback. Making the order user-owned breaks that circle, so the two facts were
decided apart: `sort_order` owns display and moves only on a drag, and an
explicit `lastActiveAt` — the same `COALESCE(MAX(messages.created_at),
sessions.created_at)` expression the old sort used, now SELECTed as a field —
owns every decision that needs recency.

That is what makes the **Landing Session** — the Session the Client opens on
boot, on a tab click, and after the selected tab closes — computable without a
sorted list. It goes through `recencyOf` in `src/lib/sessionRecency.ts` (its only
caller in production is `sortByRecency` in the same module, and the store reaches
the answer through `sortByRecency` / `mostRecentByRecency` — a call site may not
index the map itself, or the one rule has two owners): the loaded transcript's
last stamp if this call site holds one, else the boot recency map, else `null`. A
**live** Session is still preferred over any stored one (a Space holding a Worker
mid-turn should show that turn), recency decides the stored arm, and
`removeSpace`'s fallback is unchanged on purpose — landing on the tab to the left
is exactly what a neighbour tab now means, because `spaces[0]` IS the leftmost
tab.

The store's standing rule "input order IS the order, do NOT re-sort" survived
all of this rather than being inverted, which is the reason SQLite beat
`localStorage`: both read queries changed only their `ORDER BY`
(`Db::list_sessions` → `sort_order ASC, id DESC`, both filter arms;
`Db::list_spaces` → `sort_order ASC, path ASC`), and the tie-breakers are kept
so two rows with an equal number cannot swap between reads.

## Boot: one fetch, two readings

`sessionRecency()` returns `Vec<SessionRecency { session_id, last_active_at,
sort_order }>` for every non-subagent session — the same key set as
`list_sessions(true)`, so a session can never meet a recency entry that has no
row, or the reverse. `App`'s boot effect fetches it in the SAME `Promise.all`
that already calls `listSessions` and `listSpaces` (so boot costs no fourth
round-trip), and `setSessionRecency` fills BOTH store maps — `sessionRecency`
and `sessionOrder` — from that one payload, BEFORE `setSpaces` runs, because
`setSpaces` runs `autoSelectActive`, which now decides the Landing Session from
the recency map. The order column never reaches any other wire type:
`SpaceRow` carries no order field, which is why Space position lives in the
`spaces` array and Session position lives in the map.

## How a drag works

`src/hooks/useDragReorder.ts` owns the gesture for both lists and answers three
questions no call site answers: what is being dragged, which row is the target,
and where the dragged id lands. `moveId` is the only copy of that arithmetic in
`src/`.

- **The row is the target.** Drop lands ONTO a row and the pointer's half of it
  decides before-or-after. No gap targets, no placeholder node — the indicator
  is one class on the row that already exists (`border-t-2`/`border-b-2` in the
  sidebar, `border-l-2`/`border-r-2` on the tab pill), because both row
  components carry a no-DOM-level contract that a ghost or an inserted row
  would break, along with the ancestry-resolving test sites built on it.
- **The whole row / pill is the handle**; the hover actions (Stop / Archive /
  Unarchive / Delete) and the tab's ✕ carry `draggable={false}`, so a press on a
  destructive control starts no drag. Native drag image, nothing hand-drawn.
- **The write is optimistic and one transaction.** `reorderSessions` /
  `reorderSpaces` rewrite the store synchronously, then fire one
  `reorder_sessions` / `reorder_spaces` with the WHOLE visible slice, whose
  index becomes each row's `sort_order`. Two drags in one list are chained so
  they reach the database in drag order, and a failing drag that has been
  overtaken discards its own rollback (the publish epoch).
- **A rejection restores the captured slice; it does NOT refetch.** A refetch is
  a wider mutation than the one being undone — `setSessionRecency` replaces the
  recency map and `setSpaces` re-seeds the trusted baseline and can move the
  selected tab — and the command is one transaction, so the snapshot taken
  before the optimistic write already IS the committed state.
- The tab pill's `data-tauri-drag-region="false"` is what makes a tab drag
  possible at all: Tauri's injected drag script walks the composed path and
  stops at `"false"`, so no ancestor chrome bar re-claims the mousedown. The row
  never calls `stopPropagation`, so a release outside any row still reaches
  `useWindowDropBackstop`, which is the only thing between a stray drop and the
  webview navigating to it.

## The one exception: the **Archived** section

The **Archived** section is the sole list still sorted by **recency**, and it
now has to say so out loud. `archivedInSpace` in `src/store/sessions.ts` filters
the active Space's archived rows (dropping the sticky live ids and another
Space's **Detached** rows) and then sorts them with `sortByRecency`;
`ArchivedSection` calls that one function for the badge, the rows and the order,
so the three cannot disagree.

This is a real defect that was found and fixed mid-feature, and it is worth
understanding rather than skimming. The section used to render
`archived.filter(…)` in **input order** and inherit recency for free, because
input order WAS the last-activity order. When `list_sessions`' `ORDER BY` became
`sort_order`, that same filter silently started presenting a **manual**
arrangement under a heading that means recency — and it passed every archived
test in the file, because not one of them asserted the ORDER. The order it used
to get free is precisely the order this change reassigned to `sort_order`, so a
filter left reading input order is not stale-looking, it is a lie that no
existing test can see. The pin is
`it("lists the Archived rows in RECENCY order when the store's input order (the
Manual order) disagrees")`, built so input order and recency order give opposite
answers.

Settings → **Detached sessions** reads `detachedSessions`, which sorts nothing
and advertises no order, so it simply inherits the manual order. That is fine:
it is a management list, not a recency list.

## Accepted gap: a keyboard user cannot reorder

**HTML5 drag-and-drop is pointer-only, so a keyboard user cannot reorder either
list.** This is accepted, not overlooked — recorded in ADR 0075, in
`SpaceTabs.tsx`'s header, and here, rather than left implicit.

The consequence, stated plainly: a user who reorders with the keyboard has no
path at all. The rows and pills are reachable (`RowButton` emits `role="button"`
+ `tabIndex={0}` and activates on Enter), so a keyboard user can open any
Session and close any tab — they simply cannot arrange anything. The order they
inherit is the upgrade seed, and from then on it is whatever a pointer user
dragged. There is no shortcut, no modifier, no hidden command.

The alternative that was considered and declined is worth keeping with the gap,
so it is not re-litigated: **up/down buttons** are trivially testable and
keyboard-accessible, and were rejected because they add two hover controls
competing with Stop / Archive / Delete on a row in the 260px sidebar
(`LEFT_PANE_WIDTH`). If the gap is ever closed, that is the shape to reopen, and
the store actions it needs (`reorderSessions` / `reorderSpaces`) already take a
plain id array and have nothing pointer-specific in them — the work is an
affordance and its tests, not a new write path.

## Other accepted limits

### Order numbers collide across Spaces, on purpose

The numbers a drag writes are the slice's indices, `0..n-1`, so dragging one
Space's rows renumbers those rows and leaves every other Space's rows on their
old numbers — which therefore **collide** with them. That is the intended steady
state, and it is safe for two reasons that both have to hold:
`mergeSessionOrder` is called with one Space's ids and nowhere else (its only
non-test call site is `spaceViewFor`), and `Db::reorder_sessions` does the
identical thing to the same slice, so the map agrees with the database instead
of approximating it. `ORDER BY sort_order ASC, id DESC` is a total order, so a
collision never makes a read nondeterministic — it is pinned by
`reorder_sessions_is_per_space_even_when_numbers_collide_across_spaces`.
Renumbering the untouched rows to keep the column globally unique would move
rows the user did not drag, in Spaces they are not even looking at.
(`Db::reorder_spaces` is the opposite case and always renumbers the whole table:
the tab strip passes every Space it shows.)

### The order map is a boot snapshot

`sessionOrder` is filled once, at boot, and the only mid-run writer is a drag.
There is no poll and no event, deliberately. The consequence: if anything else
renumbers a row while the app is running — a second Client instance, or a
`record_session` collision on an id this app already has — the row stays at its
stale slot until the next restart. Same for the recency map: a session that
becomes the most recent by other means is not the Landing Session until boot,
because the Landing Session is decided from the boot map plus whatever
transcripts are loaded. Closing and re-opening the app re-reads reality. This is
a real limit, not a cosmetic one, and it is the kind of thing a future change may
have to pay for; what closing it would cost is written down with the other
open work of this feature rather than left as an implication here.

### The store trusts its call site to send the WHOLE visible slice

`reorderSessions` takes the ids of the whole visible list and does not
re-derive them: what is visible is the render layer's answer, and giving the
store a second owner of that slice would be a second thing that can disagree. So
the store does not validate it. It guards the one degenerate case it can see (an
empty slice) and refuses nothing else — pass a partial, sorted or deduped slice
and it will write exactly that, renumbering rows the user never dragged. The
whole defence is a sentence in the action's own doc comment plus one pin,
`it("sends the WHOLE visible slice VERBATIM — unsorted, undeduped, unfiltered —
and sends nothing for an empty slice")`. `reorderSpaces` is the same shape with
one addition: a Space the slice does not name is KEPT, at the bottom, so a tab
opened mid-drag survives the write instead of vanishing with it.

## The axis rule — read this before wiring a third list

`useDragReorder` takes an explicit `axis: "x" | "y"` argument (default `"y"`) and
**must not infer the axis from geometry**. A horizontal list passes `"x"`. The
`DropEdge` it reports is axis-neutral — `"before"` means EARLIER in the array,
which is ABOVE in a vertical list and to the LEFT in a horizontal one — and the
call site chooses which physical border paints it, because only the call site
knows how its own list is laid out.

This is a fix, not a design flourish. The hook originally read `clientY` only.
That is right for the sidebar and wrong for a tab strip, where a drag holds Y
essentially constant: measured on a 32px pill grabbed at its vertical centre,
every target answered `"after"`, so a **rightward** tab drag produced the order
the strip already had, the hook's "nothing moved" guard fired, and the drag did
**nothing at all, silently** — while **leftward** drags landed on `"after"` too
and therefore worked **by accident**. No test could see it, because no test
anywhere delivered a `clientX`, and `undefined < midpoint` is `false`, which is
the same answer a zero-width rect gives.

Two rules follow, and both are load-bearing for the next person:

1. Never guess the axis from the rect's proportions. A sidebar row is wider than
   it is tall, so a proportion heuristic would flip the list that has always
   worked onto the X axis.
2. **A test of geometry must supply BOTH axes explicitly, and the axis it is not
   testing must carry a value that answers the OPPOSITE way.** Measured on this
   tree: replacing the `axis` argument with exactly that heuristic — compare the
   rect's `width` to its `height` — reddens **11 tests**, 4 in
   `useDragReorder.test.tsx` (including
   `it("with no axis the hook reads Y, so a vertical list is unaffected by the
   option existing")`) and 7 in `SpacesList.test.tsx` (including
   `it("the SIDEBAR stays on the Y axis: a pointer whose X says the opposite edge
   still moves the row up")`). The tab-strip suite stays green under that
   mutation, which is precisely why the contradicting-axis values in the vertical
   tests are the proof rather than the `axis: "x"` tests.

## Where the code is

| Concern | Symbol |
|---|---|
| The one recency question | `recencyOf` / `sortByRecency` / `mostRecentByRecency` — `src/lib/sessionRecency.ts` (lives beside `sessionTitle.ts`'s `titleFor` for the same reason: one function, so two surfaces cannot disagree) |
| The one order sort | `sortByManualOrder` (same module) and `mergeSessionOrder` — `src/store/sessions.ts` |
| The one gesture, the one `moveId` | `useDragReorder` — `src/hooks/useDragReorder.ts` |
| The two optimistic writes | `reorderSessions`, `reorderSpaces` — `src/store/sessions.ts` (chain + publish epoch beside them) |
| The two call sites | `SpacesList.tsx` (rows, `axis` defaulted to `"y"`), `SpaceTabs.tsx` (pills, `axis: "x"`) |
| Boot wiring | `App`'s boot effect → `setSessionRecency` (fills both maps) before `setSpaces` |
| Storage | `Db::session_recency`, `Db::reorder_sessions`, `Db::reorder_spaces`, `seed_space_sort_order` / `seed_session_sort_order`, the `LAST_ACTIVITY` const — `src-tauri/src/storage/db.rs` |

Two things a changer will want to know before touching the Rust:

- **`LAST_ACTIVITY` is the single copy of the recency expression.** The seed and
  `session_recency` both interpolate it, so the number a row prints and the
  number a recency decision reads cannot drift. `src/lib/sessionActivity.ts` is
  gone (`sortByActivity`, `activityKeyOf`, `activityFromKey` existed only to
  feed the deleted display sort; `relativeTimeFor` in `src/lib/sessionTime.ts`
  is a different module and stays).
- **The seed queries hardcode the OLD display order and must never be pointed at
  `sort_order`.** At seed time every value in that column is still `DEFAULT 0`,
  so `ORDER BY sort_order` is a pure tie and would pick an order nobody ever
  saw. The seed exists so that an upgrade changes nobody's list: the manual order
  begins as a copy of whatever the user was already looking at.
