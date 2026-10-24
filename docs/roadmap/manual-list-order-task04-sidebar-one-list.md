# T04 — the sidebar renders ONE list, and `src/lib/sessionActivity.ts` is deleted

Written by `specify` (CONSUMED MODE), against the tree at `1d300ed` (branch
`feature/manual-list-order`, T01–T03 `done`). Contract is the spec at
`docs/roadmap/manual-list-order.md` **as amended inline 2026-10-24**, plus ADR 0075, plus T03's
`## Out of scope` — which is the file that says what T04 is handed:
`SpaceView.sessionIds` (ONE sequence spanning live and stored), `archivedInSpace(spacePath,
archivedSessions, liveSessions, evidence): SessionInfo[]`, and the standing instruction that T04
"deletes `sortByActivity`'s two memos, the `activityKey`/`activity` pair, `viewIds`, `liveIds`,
`storedIds`, sets `railIds = sessionIds`, renders one list … and rewords the rail pin".

**Seam (owned by this task):** `src/components/SpacesList.tsx`, `src/components/SpacesList.test.tsx`,
and the DELETION of `src/lib/sessionActivity.ts` + `src/lib/sessionActivity.test.ts`.
**Two files outside that seam are touched, both comment-only, both because a sentence in them
becomes a lie** — see the "Files outside the seam" table after Task 3. Nothing else. No Rust.

---

## Goal

The sidebar stops owning an order. `SpacesList.tsx` currently keeps a private display sort — a
transcript-activity subscription built for exactly that purpose (`activityKeyOf`/`activityFromKey`),
two `sortByActivity` memos, and two separate render loops — on top of the one order T03 put in the
store. Delete the private sort and render the store's sequence, so that:

1. one construction of the order exists (`activeView.sessionIds`), and the collapsed rail takes its
   marks from that same array rather than from a second one that can drift;
2. the **Archived** section stops inheriting its order from a query that no longer produces recency
   order — **this is a live defect this plan fixes, not a tidy-up** (see the paragraph below and
   Task 2);
3. `src/lib/sessionActivity.ts` and its 16 tests are gone, and no prose anywhere in `src/` still
   describes it as running.

**The defect, stated plainly.** `ArchivedSection` renders
`archived.filter(s => s.cwd === activeSpacePath && !sessions.some(…))` — input order, no sort. Input
order *used to be* recency, because `Db::list_sessions` sorted by the last-activity expression. T01
swapped that `ORDER BY` to `sort_order ASC, id DESC` (verified in the tree: both arms of
`Db::list_sessions` read `ORDER BY sort_order ASC, id DESC`), and `setHistorySessions` splits that
array into `historySessions`/`archivedSessions` preserving order. So **today the Archived section
presents a MANUAL order under a heading that means recency**, and every archived test in
`SpacesList.test.tsx` passes because not one of them asserts the section's ORDER. Measured: the file
has exactly seven `compareDocumentPosition` sites, five of them inside
`describe("SpacesList", …)` in the four ordering tests this plan deletes and two in the rail pin it
rewrites — **zero** in any archived-section test, and the archived block's own helpers never seed a
recency value. ADR 0075 predicted exactly this in its Consequences.
T03 shipped `archivedInSpace` to fix it and left the call site here. The test that proves the fix is
Task 2's `it("lists the Archived rows in RECENCY order when the store's input order (the Manual order) disagrees")`.

## Done-when

All observable. Frontend only, from the repo root (`npx vitest run <path>` scopes;
`pnpm test -- <path>` does **NOT** scope — it runs every file; measured again on this branch).
Counts below are **DELTAS** over the numbers re-measured at this plan's HEAD, not copied figures:
`pnpm test` **3086 passed / 150 files** · `pnpm build` green (with the pre-existing chunk-size
warning) · `cargo test` **1463 passed / 0 failed** · `src/components/SpacesList.test.tsx` **79** ·
`src/lib/sessionActivity.test.ts` **16** · `src/store/sessions.test.ts` **182** ·
`src/components/SessionRail.test.tsx` **13** · `src/components/SessionListRow.test.tsx` **15** ·
`src/components/SpaceTabs.test.tsx` **34** · `src/components/settings/SessionsSection.test.tsx`
**12** · `src/App.test.tsx` **41** · `src/test/fixtures.test.ts` **25**.

1. `SpacesList.tsx` contains **no** import from `../lib/sessionActivity`, no `activityKey` /
   `activity` / `viewIds` / `liveIds` / `storedIds` binding, and exactly ONE `SessionRow` render loop,
   over `activeView.sessionIds`. `grep -c "<SessionRow" src/components/SpacesList.tsx` → **2** before
   (the `{liveIds.map(…)}` block and the `{storedIds.map(…)}` block) → **1** after.
2. `railIds` is `activeView?.sessionIds` (plus a stable empty array for the no-Space case) and is the
   SAME array the rows render — one construction, not two. `useSessionStatuses(railIds)` and
   `<SessionRail rows={railIds.map(…)} />` both read it unchanged.
3. `ArchivedSection`'s rows come from `archivedInSpace(activeSpacePath, archived, sessions, { recency })`
   — the store's exported derivation — and its header count still comes from the SAME array as its
   rows (the joint property `it("the header count counts the active Space's rows only")` pins).
4. `src/lib/sessionActivity.ts` and `src/lib/sessionActivity.test.ts` do not exist. The suite loses
   exactly those 16 tests: **`pnpm test` 3086 → 3070, 150 → 149 files** (the arithmetic is
   −16 from the deleted file, and `SpacesList.test.tsx` nets **0**: 4 tests deleted, 4 added).
5. `src/components/SpacesList.test.tsx` is **79 → 79**, made of **−4 / +4**:
   DELETED (premise is the behaviour being removed — adapt nothing):
   `it("orders the LIVE group by last activity, above the STORED group")`,
   `it("ranks a live session by ITS ACTIVITY, not by which was started last")`,
   `it("sorts a session that CLOSED this boot to the top of the stored group")`, and
   `it("keeps a brand-new live session (no transcript yet) at the TOP of the live group")` — the
   fourth is Decision D3, and it is NOT on the spec's list; and
   REWRITTEN, contract kept, cause corrected:
   `it("keeps the rail's marks POSITIONALLY equal to the rows after the activity sort")` →
   `it("keeps the rail's marks POSITIONALLY equal to the rows, because both come from the store's ONE sequence")`.
   ADDED: `it("renders its rows in the store's ONE sessionIds sequence, so a STORED row above a LIVE one in the manual order renders FIRST")`,
   `it("renders a Session started after the boot fetch at the BOTTOM of the list (the new-row rule, not the live block)")`,
   `it("updates a row's relative time while its POSITION stays frozen")`, and
   `it("lists the Archived rows in RECENCY order when the store's input order (the Manual order) disagrees")`.
6. Every ORDER assertion the file had is accounted for. `grep -c "compareDocumentPosition"
   src/components/SpacesList.test.tsx` → **7** sites before, and all 7 sit inside the four tests this
   plan deletes (5 sites) plus the rail pin it rewrites (2 sites); **7** after, and all 7 sit inside the
   five tests this plan adds or rewrites (the rewritten rail pin keeps its 2, the three new row tests
   add 4, the Archived test adds 1). This is the bounded proof that no surviving test depended on the
   deleted sort — and it is why the file's count is unchanged rather than merely "still green".
7. The successor to the proof T03 retired (T02's `grep … "sort_order\|sortOrder" src/` == 0 was
   deliberately retired by T03; these are the assertions that still bite after T04):
   - `grep -rn "sortByActivity(\|activityKeyOf(\|activityFromKey(\|lastActivityOf(" src/` → **0**
     (before: **35** lines — the call sites plus the module and its test). This is the load-bearing
     one: it counts CALLS, so the historical mentions in `lib/sessionRecency.ts`'s prose do not
     false-positive (D8).
   - `grep -rn "sessionActivity" src/` → **exactly 1** hit (before: 5, in five files), and it is the
     etymology line in `src/lib/sessionRecency.ts`'s header. Zero in `src/components/**`,
     `src/lib/sessionTypes.ts`, `src/store/sessions.ts`.
   - `grep -rn "sort_order" src/` → **0** (T04 introduces no SQL name; unchanged from T03).
   - `grep -rn "sortOrder" src/components/` → **0**, and specifically
     `grep -rn "sortOrder" src/components/SpacesList.test.tsx` → **0**: the new fixtures seed the
     STORE field `sessionOrder`, never the wire field `sortOrder` (D5). No component reads the number.
   - `grep -rn "\.liveSessionIds\|\.storedSessionIds" src/ | grep -v '^src/store/'` → **0** (before:
     3, all in `SpacesList.tsx`): after T04 the DEPRECATED pair has no reader outside the store and
     its own test file. `liveSessionId` (singular) is untouched — 6 dotted reads, all in
     `src/store/sessions.test.ts` — and `liveSessionsInSpace` / `mostRecentLiveInSpace` survive
     untouched, because they feed the tab's live dot and the Landing Session.
   - `grep -rni "recent-first\|recently active first\|newest-first" src/components/SpacesList.tsx` →
     **0** (before: 3 — the `views` memo's comment, the `sortByActivity` block's comment, and the JSX
     comment that names `sortByActivity` as the reason the order and the label agree). T03 imposed
     this ban on `src/store/sessions.ts`; T04 extends it to the file whose prose it is deleting.
   - `grep -rn "lastOpenedAt" src/components/SpacesList.tsx` → **0** (before: 1 — the stale comment
     above the `views` memo that T03 explicitly left for T04).
8. **No Rust change, and that is a claim with a proof, not an assumption.**
   `git diff --name-only <T04-base>..HEAD | grep -c '^src-tauri/'` → **0**;
   `grep -rn "sessionActivity\|sortByActivity\|activityKeyOf\|lastActivityOf" src-tauri/` → **0**
   hits today, so nothing on the Rust side names what is being deleted. `cargo test` therefore stays
   at **1463 / 0 failed**, clippy at 0 warnings, `cargo fmt --check` clean — re-run once at the end to
   confirm nothing moved.
9. `pnpm test` **3070 / 149 files** and `pnpm build` green from the repo root. `pnpm build` is a real
   gate here, not a formality: `tsconfig.json` sets `noUnusedLocals`, so a leftover
   `activityFromKey` import or an orphaned `viewIds` fails the build, and it is also the gate that
   reddens if the `SpaceView` fields are deleted while a reader still exists (which is why they are
   not — D2).

---

## Conventions this plan inherits (do not re-litigate)

- **TDD is a repo convention.** Every task writes its failing test first and names the command that
  proves the red. Task 3 is the one exception and says so: a deletion whose call sites are already at
  zero has no red to offer, and its gate is the grep plus the build.
- **Scoped vitest is `npx vitest run <path>`.** `pnpm test -- <path>` runs all 150 files.
- **The `now_ms()` trap, applied on this side of the wire.** In Rust, `record_session` and
  `record_message` both stamp `now_ms()`, so a recency fixture can tie and pass vacuously. The
  frontend equivalent is real and is the one this plan must dodge: `useSessions` boots with
  `sessionRecency: {}` and `sessionOrder: {}` (T03, and `src/test/resetStores.ts` restores both from
  `getInitialState()`), so **any test that does not seed the order map gets an empty one, and an empty
  map makes every id tie and preserves input order.** That is T03's safety property, and here it is a
  trap: a fixture that leaves the map empty and expects "manual order" is really asserting the old
  live-then-stored concatenation. So **every new ordering test in this plan seeds
  `useSessions.setState({ sessionOrder: { … } })` explicitly**, and every fixture below is built so
  the OLD rule (live block first, and within each group sort by last message) gives a **different**
  answer from the store's sequence. A fixture that cannot tell those two rules apart certifies the bug.
- **Far-future / far-past explicit stamps, never arithmetic that can tie.** Use
  `9_000_000_000_000`-class stamps for "newest". `relativeTimeFor` reads
  `now - latest.at` and buckets `< 60_000` → `now`, `< 60m` → `Nm`, else `Nh`, so a FUTURE stamp
  yields a negative diff and lands in the `now` bucket — which is exactly what Task 1's time test uses
  to get a deterministic label change. The file's existing `Date.now() - 3_600_000` idiom (its `seed()`
  helper) is used only to produce the stable `"1h"` starting label.
- **A component passes `{ recency }`, the store passes `{ recency, messages }`** (T03's D3). This plan
  does not change that, and does not re-introduce a `messages` subscription into the pane: subscribing
  the list to the whole `messages` map re-renders it on every streamed token, which is the hazard the
  deleted `activityKeyOf` existed to dodge. **The row's own time label keeps its per-row
  `useSessions((s) => s.messages[sessionId])`** — that is a per-row subscription the row already had,
  not a list-level one, and Task 1's frozen-slot test depends on it.
- **`docs/` prose is not this task's**, except where the plan says otherwise. `CONTEXT.md` already
  carries **Manual order**, **Landing Session** and the amended **Archived session** entry (verified:
  the Archived entry already states that the section is the one list not under a Manual order and that
  it must sort by `lastActiveAt` EXPLICITLY). `docs/features/manual-list-order.md` is T08.
- **`file:line` is not a citation.** This plan names symbols and `it(...)` strings only, because lines
  in a 1014-line component and a 2685-line test file move under the edit itself.

---

## Task 1 — one loop, one `railIds`, and the display-sort machinery deleted

**Files owned:** `src/components/SpacesList.tsx`, `src/components/SpacesList.test.tsx`.

**Write the failing tests FIRST** — in `src/components/SpacesList.test.tsx`. Tests 1–3 go in
`describe("SpacesList", …)`; test 4 (the rail pin) is REWRITTEN where it already sits, which is
surprisingly inside `describe("SpacesList (archive, ADR 0016)", …)` — that describe spans the archived
block AND the pane's collapse/rail block, so do not go looking for the rail tests in the first
describe. The file-level `beforeEach` runs `seed()` (two Spaces, `/tmp/alpha` selected, live `s1` in a
turn, stored `h1` in `/tmp/alpha`, stored `h2` in `/tmp/beta`) on top of `resetStores()` for EVERY
describe, so each new test writes over the seed with its own `useSessions.setState({ … })`, naming
`sessions`, `historySessions`, `messages`, `activeSessionId` and — the part that makes the fixture
non-vacuous — `sessionOrder`.

1. `it("renders its rows in the store's ONE sessionIds sequence, so a STORED row above a LIVE one in the manual order renders FIRST")`
   — the manual order reaching the DOM. Override the seed COMPLETELY (a row the seed leaves behind
   silently joins the list and can satisfy an order assertion by accident):
   `sessions: [makeSessionRow({ sessionId: "s_live", cwd: "/tmp/alpha", title: "Live row" })]`,
   `historySessions: [makeSessionRow({ sessionId: "h_stored", cwd: "/tmp/alpha", title: "Stored row" })]`,
   `messages: {}`, `activeSpacePath: "/tmp/alpha"`, and
   `sessionOrder: { h_stored: 2, s_live: 5 }`. Expect `"Stored row"` to precede `"Live row"` via
   `compareDocumentPosition`. (Both rows carry a generated `title` so the labels are queryable with no
   transcript — the same trick `it("labels a titled STORED row by its title, and an untitled row by its
   first message")` uses.)
   **Two competing answers, and the fixture tells them apart:** the store's one sequence answers
   `[h_stored, s_live]`; the code being deleted answers `[s_live, h_stored]` — the live block is
   rendered first regardless of any number. This is the exact case T03's
   `it("groups a space with a live session and a stored session")` pins at the store level; this is
   that case in the DOM.
2. `it("renders a Session started after the boot fetch at the BOTTOM of the list (the new-row rule, not the live block)")`
   — `/tmp/alpha` holds stored `h1` (the seed's own transcript gives it the label
   `"Refactor the parser"`) and a live `s-new` (title `"Just created"`) with **no entry** in
   `sessionOrder`, while `h1` has `{ h1: 0 }`. Override `sessions: [makeSessionRow({ sessionId:
   "s-new", cwd: "/tmp/alpha", title: "Just created" })]` — dropping the seed's live `s1`, which would
   otherwise join the list and could satisfy the assertion by accident — and keep the seed's
   `historySessions`/`messages` for `h1`, adding `messages["s-new"] = []` (the empty array is what
   `addSession` gives a fresh session). Expect `"Refactor the parser"` ABOVE `"Just created"`.
   **This is the test that replaces the deleted one** (D3): the deleted
   `it("keeps a brand-new live session (no transcript yet) at the TOP of the live group")` asserted the
   OPPOSITE, on `sortByActivity`'s `unknowns: "first"` rule for the live group; the approved rule is
   "new rows join at the BOTTOM", which T03 pinned at the store level in
   `it("a live row whose id the order map does not know joins at the BOTTOM of the sequence")`. This
   test carries that rule to the DOM. It is red before the change for the strongest reason: the live
   block leads, so the fresh row is FIRST.
3. `it("updates a row's relative time while its POSITION stays frozen")` — the user-visible promise
   this whole branch exists for, and it goes in THIS task because this is the only HEAD where it can
   be red. `/tmp/alpha`, `sessions: []`, `historySessions: [h_first, h_second]` (titles `"Row A"`,
   `"Row B"`), `sessionOrder: { h_first: 0, h_second: 1 }`, `messages` = one user message in each:
   `h_first` at `now - 10_000` (label `now`), `h_second` at `now - 3_600_000` (label `1h`). Assert
   A-above-B and that B's row reads `"1h"`; then
   `act(() => useSessions.setState({ messages: { …, h_second: [makeMessage("user", { text: "Row B answered", at: Date.now() + 9_000_000_000 })] } }))`
   and assert **still** A-above-B **and** that B's row now reads `"now"`.
   **Red at HEAD, and red for the right reason:** the first assertion passes (A is already the most
   active), and after the append `sortByActivity(…, "last")` floats `h_second` to the top of the
   stored group, so the SECOND `compareDocumentPosition` fails. After the change the store's numbers
   decide position and the row's own per-row `messages` subscription decides the label, so both hold.
   A future edit that re-sorts on activity reddens here even if every other test in the file stays
   green.
4. **REWRITE the rail pin** — `it("keeps the rail's marks POSITIONALLY equal to the rows after the
   activity sort")` becomes
   `it("keeps the rail's marks POSITIONALLY equal to the rows, because both come from the store's ONE sequence")`.
   Keep its whole shape (render expanded, read the three rows' order, `unmount()`,
   `act(() => setLeftPaneCollapsed(true))`, re-render, read
   `screen.getByTestId("session-rail-marks")`'s marks and compare the per-position `data-dot` list),
   and change two things: the header comment, and the fixture. KEEP the existing
   messages/inTurn/prompts assignment EXACTLY as it is (`s1` carries the NEWEST message and the
   permission prompt, `s2` is the one in a turn, `h1` the oldest) — they are what make the three marks
   differ by position — and ADD one line: `sessionOrder: { s2: 0, s1: 1, h1: 2 }`, i.e. the manual
   order says the live row `s2` is the FIRST row while `s1` is the row with the most recent message.
   Expected rows: Row two, Row one, Row three (the map's numbers). Expected marks:
   `["running", "waiting", "stored"]`.
   **Two competing answers, and the fixture tells them apart:** the store's sequence answers rows
   two/one/three, hence marks running/waiting/stored; the deleted display sort answers one/two/three
   (`s1`'s message is newer, so it leads the live group), hence marks waiting/running/stored. BOTH
   halves are therefore red at HEAD, and the marks half is the one that catches a rail that re-derived
   its own order.
   **Getting this fixture wrong is easy and silent**, which is why the numbers are stated: seed
   `{ s1: 0, s2: 1, h1: 2 }` instead — the "obvious" ascending order — and the two rules answer
   IDENTICALLY, so the test passes while proving nothing. Same trap T03 recorded ("a merge test that
   cannot tell those two rules apart is worse than no test — it certifies the bug"), and the trap the
   `now_ms()` note in Conventions is about on this side of the wire.
   Also delete the phrase "after the activity sort" from its comment and say what the equality now
   rests on: rows and rail are the same array (`activeView.sessionIds`), so the equality is
   structural, and this test is the pin that keeps it that way if someone re-derives one of the two.

**Also DELETE these four tests outright** (their premise is the behaviour being removed — the spec
names the first three; the fourth is D3):
`it("orders the LIVE group by last activity, above the STORED group")`,
`it("ranks a live session by ITS ACTIVITY, not by which was started last")`,
`it("sorts a session that CLOSED this boot to the top of the stored group")`,
`it("keeps a brand-new live session (no transcript yet) at the TOP of the live group")`.
Do not adapt them and do not port them: each asserts a position the new design refuses to produce.
The closed-this-boot case is already covered where it now lives — T03's
`it("a Session RESUMED this boot keeps the MIDDLE slot the database holds for it (one sequence spans live and stored)")`
and the store's `handleSessionClosed` rule that a closed row keeps its ORDER NUMBER.

**Red:** `npx vitest run src/components/SpacesList.test.tsx` → **4 failures**, all assertion failures
(no compile error is possible in a JS test file): the three new tests fail on the row-order
comparison (they get the live row first / the fresh row first), and the rewritten rail pin fails on
its first `compareDocumentPosition` (two before one). Quote the row-order diff from test 1 as the
headline: it is the manual order being refused at the DOM. File count at this point:
**79 − 4 + 3 = 78**, 4 failing.

**Implementation** — `src/components/SpacesList.tsx`, deletions first:

- Delete the import block `import { activityFromKey, activityKeyOf, sortByActivity } from
  "../lib/sessionActivity";`.
- Delete the `activityKey` selector and the `activity` memo, and the comment block above them that
  explains the primitive-subscription trick. The pane no longer subscribes to transcript activity for
  ordering **at all**; say so in one line where the block was, because a reader will look for it and
  ask where the ordering subscription went:
  ```tsx
  // NO ordering subscription here, on purpose (ADR 0075): the pane used to subscribe to each row's
  // last message stamp — as a primitive key, so streaming would not re-sort it — purely so it could
  // re-rank the rows for display. The order now comes from the store (`sessionIds`) already settled,
  // so the pane reads NOTHING about activity for position. A ROW still subscribes to its own
  // transcript for its time label; that is per-row and does not move a slot.
  ```
- Delete `viewIds` (its only consumer was `activityKeyOf(viewIds, …)`; its comment's promise that
  "the subscription and the rail are derived from the SAME membership the rows render" is now carried
  better by `railIds` being the render array itself).
- Delete `liveIds` and `storedIds` and the long comment above them about the two groups needing
  OPPOSITE `unknowns` placement — that rule died with `sortByActivity`, and its surviving half
  ("an unknown must not be defaulted to `0`") lives in `lib/sessionRecency`'s `sortByManualOrder`.
- Collapse `railIds` to the store's array, and drop the `useMemo`:
  ```tsx
  // The rail's ids are the ROWS' ids — the same array, not a second construction of the same order
  // (ADR 0075; the rail's contract is "the Nth mark is the Nth row", and two derivations of one order
  // is two things that can drift). No `useMemo`: this is a field read, and the module-level empty
  // array keeps the input identity stable while no Space is selected.
  const railIds = activeView?.sessionIds ?? NO_SESSION_IDS;
  ```
  with `const NO_SESSION_IDS: string[] = [];` at module scope beside the other module-level
  constants. `statuses = useSessionStatuses(railIds)` and the `<SessionRail rows={railIds.map(…)}`
  call both stay exactly as they are.
- Replace the two render loops with one:
  ```tsx
  {activeView.sessionIds.map((id) => (
    <SessionRow
      key={id}
      sessionId={id}
      spaceName={activeView.title !== "" ? activeView.title : activeView.path}
      active={activeSessionId === id}
      onOpen={openSession}
    />
  ))}
  ```
  and rewrite the JSX comment above it, which today says "Live sessions first, then stored; within
  each group, MOST RECENTLY ACTIVE FIRST (`sortByActivity` — the same last message the row's time
  prints, so the order and the label agree)". The replacement: the rows render the **Manual order**,
  ONE sequence spanning live and stored, with no group headers — live-ness stays visible as the row's
  `SessionStatusMark`, never as a position — and the row's time is still its last message, which is
  now deliberately DECOUPLED from its slot (pinned by
  `it("updates a row's relative time while its POSITION stays frozen")`). The old sentence's promise
  ("the order and the label agree") is the exact thing this branch removes, so it must be deleted, not
  reworded into a synonym.
- Rewrite the comment above the `views` memo — the stale one T03 left for T04: "Keep the `spaces` list
  order (`lastOpenedAt` desc from `list_spaces`): groups follow the server's recent-first order." →
  the spaces arrive in the **Manual order** and `views = spaces.map(spaceViewFor)` inherits it, so the
  tab strip and the sidebar's group order cannot disagree (spec §4). Also fix the inner comment that
  still says the `{ recency }`-only choice dodges "the exact hazard `activityKeyOf` exists to dodge" —
  that module is being deleted in Task 3, so name the hazard itself (a whole-list `messages`
  subscription re-renders on every streamed token) instead of a module that will not exist.
- Fix the two comments that describe the deleted lists as the row list's source: the one above
  `activeView` ("the ROW LIST's source (`viewIds`, `liveIds` / `storedIds`, the rows themselves …)")
  and the `railIds`-adjacent JSX comment ("live first, then stored, which is why the ids come from the
  SAME `railIds` memo"). And the `SessionRow` doc's parenthetical that its parent "holds
  `liveSessionIds` / `storedSessionIds`, never the rows" → it holds `sessionIds`. Those are the three
  prose sites that make Done-when #7's `recent-first` / `lastOpenedAt` greps come out at 0.

**Green:** `npx vitest run src/components/SpacesList.test.tsx` (**78**, 0 failed) →
`npx vitest run src/components/SessionRail.test.tsx src/components/SessionListRow.test.tsx
src/components/SpaceTabs.test.tsx src/components/settings/SessionsSection.test.tsx` (**13 / 15 / 34 /
12, all unchanged** — the rail takes props, `SessionListRow` takes props, the tabs never read
`SpaceView`, and Settings reads `detachedSessions`) → `npx vitest run src/store/sessions.test.ts`
(**182, unchanged** — the store is untouched by this task) → `pnpm build` (green; this is the gate
that proves no orphaned `activityKeyOf` import or unused `viewIds` survived `noUnusedLocals`).

**Commit:** `fix(sidebar): render the store's ONE session order; delete the display sort and its subscription`

---

## Task 2 — `ArchivedSection` asks the store: the live defect fixed

**Files owned:** `src/components/SpacesList.tsx` (the `ArchivedSection` body and its doc comment),
`src/components/SpacesList.test.tsx`.

**Write the failing test FIRST** — in `src/components/SpacesList.test.tsx`, inside
`describe("SpacesList (archive, ADR 0016)", …)`, beside the existing `seedArchived` /
`seedArchivedElsewhere` helpers (which APPEND, and whose docs warn that `seed()` in the file's
`beforeEach` resets `archivedSessions` first — follow that rule):

`it("lists the Archived rows in RECENCY order when the store's input order (the Manual order) disagrees")`
— `useSessions.setState({ sessions: [], historySessions: [], archivedSessions: [a_first, a_second],
sessionRecency: { a_first: 1_000, a_second: 9_000_000_000_000 } })`, both rows
`makeSessionRow({ sessionId, cwd: "/tmp/alpha", archived: true, title })` with distinct titles
(`"Archived first in the manual order"`, `"Archived last in the manual order"`) so no transcript is
needed for the labels to be queryable. `render(<SpacesList />)`,
`fireEvent.click(screen.getByText("Archived"))` to expand, then assert the SECOND title precedes the
first via `compareDocumentPosition`.
**Two competing answers:** input order (what the component does today, and what the Manual order now
means) answers first-then-last; `archivedInSpace`'s explicit recency sort answers last-then-first.
Flipping the two `sessionRecency` values flips the expectation, so the test cannot pass by accident.
Pair it with one extra assertion in the SAME test — that the header badge still reads `2`, read
through the describe's own `rowOf("Archived")` helper so the query is scoped to the header row (a bare
`getByText("2")` would match a count anywhere in the pane) — because
`archivedInSpace` returns rows and the badge must keep counting the array the rows come from (the
joint property `it("the header count counts the active Space's rows only")` already pins for the
cross-Space case; this closes the sort half).

**Red:** `npx vitest run src/components/SpacesList.test.tsx -t "RECENCY order"` → **1 failed, 78
skipped** (`-t` is a name filter, so the rest of the file reports as skipped, not passed — the number
to quote is the one failure). It is an assertion on the DOM-position comparison: the section answers
input order. Quote that diff.

**Implementation** — `src/components/SpacesList.tsx`, inside `ArchivedSection`:

```tsx
  const archived = useSessions((s) => s.archivedSessions);
  const sessions = useSessions((s) => s.sessions);
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  // The recency the section sorts by (ADR 0075). `{ recency }` only, never
  // `{ recency, messages }`: subscribing this section to the transcripts would
  // re-render it on every streamed token, and the boot map is the same SQL
  // expression the row's label reads (T03's D3, inherited here).
  const sessionRecency = useSessions((s) => s.sessionRecency);
  // ONE call, so the badge and the rows cannot disagree, and so the sort is the
  // STORE's — said out loud — rather than an order inherited from a query that
  // since ADR 0075 returns the Manual order. The defect this line closes: the
  // section used to `archived.filter(…)` in input order and inherit recency for
  // free, and after T01's ORDER BY swap that input order became the Manual
  // order — a manual arrangement under a heading that means recency, passing
  // every test that did not assert the order (this is the one that does).
  const visible = archivedInSpace(activeSpacePath, archived, sessions, {
    recency: sessionRecency,
  });
```

`archivedInSpace` joins `archivedInSpace` into the existing
`import { useSessions, spaceViewFor } from "../store/sessions";` line. The rest of the section —
`visible.length` for the badge, `visible.length === 0` for the "No archived sessions." empty state,
`visible.map(… <ArchivedSessionRow … />)` — is unchanged, because the function returns ROWS for
exactly that reason (T03's D8).

Update `ArchivedSection`'s doc comment: its "Two filters, both load-bearing" list stays (the store
function applies both, and its own doc says why), and the header gains the sentence that the ORDER is
now explicit recency and the two filters are `archivedInSpace`'s, not this component's. Keep the
paragraph about `activeSpacePath === null` matching nothing — `archivedInSpace` preserves it, and
`it("renders the empty state with NO Space selected, even though archived rows exist")` is the pin
that proves it survived.

**Why the existing archived tests (35 in `describe("SpacesList (archive, ADR 0016)")`, of which
measured 15 render the Archived section) keep passing without an edit:** none of them seeds
`sessionRecency` — measured, that file has **zero** reads of `sessionRecency` or `sessionOrder` today —
so `resetStores()` leaves it `{}`, every archived id ties, `sortByRecency` falls
through to input order, and each fixture keeps its current expected order for a now-different reason.
Say that in the commit message — it is the same degradation property T03 named, and it is what makes
this a one-line behavioural fix rather than a fixture rewrite.

**Green:** `npx vitest run src/components/SpacesList.test.tsx` (**79**, 0 failed) →
`npx vitest run src/store/sessions.test.ts` (**182**, unchanged — `archivedInSpace` was already
exported and already tested at the store level by
`it("archivedInSpace sorts by recency and NOT by input order")` and
`it("archivedInSpace drops the sticky live ids and another Space's rows")`; this task adds the CALL
SITE and its DOM proof, not a second store test) → `pnpm build`.

**Commit:** `fix(sidebar): the Archived section sorts by recency, as ADR 0075 says it must`

---

## Task 3 — delete `src/lib/sessionActivity.ts`, and the prose that still names it

**Files owned:** DELETIONS `src/lib/sessionActivity.ts` (120 lines) and
`src/lib/sessionActivity.test.ts` (16 tests); comment-only edits in `src/lib/sessionTypes.ts` and
`src/store/sessions.ts` (both OUTSIDE the seam — see below). No behaviour.

**Red: none available, and the reason is stated rather than papered over.** The red for this deletion
was Task 1: it removed the last call sites, and the grep below proves they are gone BEFORE the files
are removed. So the gate for this task is a grep run BEFORE the deletion (quote the hits) plus the
build and suite after. Do not invent a test that "proves" a file is absent.

Run first, and quote the output:

    grep -rn "sortByActivity(\|activityKeyOf(\|activityFromKey(\|lastActivityOf(" src/   # → 0 (was 35)
    grep -rln "sessionActivity" src/  # → 5 files at T04's HEAD (the module, its own test,
                                      #   sessionTypes.ts, sessionRecency.ts, store/sessions.ts);
                                      #   Task 1 already removed the 6th, SpacesList.tsx's import.
                                      #   Count FILES here, not lines — the module body is one hit.

**Delete** the two files: `git rm src/lib/sessionActivity.ts src/lib/sessionActivity.test.ts`.
`src/lib/sessionTime.ts`'s `relativeTimeFor` is a DIFFERENT module and stays (the rows and the
Archived rows both call it); `lib/sessionRecency.ts` deliberately does not re-export `lastActivityOf`
(T03's D9), so nothing needs to move — the transcript walk already exists there inside `recencyOf`.

**Then the three prose sites that become false** (the brief names the first two; the third is the
comment T03 explicitly left for T04 and Task 1 already rewrote, so it is listed here as a check, not
an edit):

1. `src/lib/sessionTypes.ts`'s header — the list of `lib/` modules that read `Message` includes
   `lib/sessionActivity.ts`. **OUTSIDE THE SEAM; one-token edit:** replace that entry with
   `lib/sessionRecency.ts`, which genuinely does read `Message` from this module
   (`import type { Message } from "./sessionTypes"`), so the list stays TRUE rather than merely
   shorter. Leaving it would advertise a module that no longer exists to the exact reader the header
   is addressing ("a shared vocabulary type belongs at the bottom of the dependency graph").
2. `src/store/sessions.ts` — the DEPRECATED doc on `SpaceView.storedSessionIds` says the field "used
   to be re-sorted for display by `lib/sessionActivity`; **that module still runs in the sidebar until
   T04 deletes it**". After this task that is a lie in the present tense. **OUTSIDE THE SEAM;
   comment-only edit,** and it is the direct consequence of D2 (the field survives, the sentence does
   not): replace the sentence with one that says the display sort is GONE — no surface re-sorts this
   list; these two lists are INPUTS to `mergeSessionOrder` and nothing else reads them (which
   Done-when #7's dotted-read grep proves). Do NOT touch the two fields, `mergeSessionOrder`,
   `spaceViewFor`, or anything else in the file (D2).
3. `src/components/SpacesList.tsx` — the `views` memo's `lastOpenedAt` / "recent-first" comment.
   Already rewritten in Task 1; this task's step is only the grep:
   `grep -rn "lastOpenedAt" src/components/SpacesList.tsx` → 0 and
   `grep -rni "recent-first\|recently active first\|newest-first" src/components/SpacesList.tsx` → 0.

**Green / proof:**

    npx vitest run src/store/sessions.test.ts            # 182, unchanged
    npx vitest run src/lib/sessionRecency.test.ts        # unchanged (7) — its etymology comments are prose, not imports
    npx vitest run src/components/SpacesList.test.tsx    # 79, unchanged
    pnpm test                                            # 3086 → 3070, 150 → 149 files (−16, the deleted file)
    pnpm build                                           # green — the gate that proves no import dangles
    grep -rn "sortByActivity(\|activityKeyOf(\|activityFromKey(\|lastActivityOf(" src/   # 0
    grep -rn "sessionActivity" src/                       # 1 hit: the etymology line in lib/sessionRecency.ts
    grep -rn "sort_order" src/ | wc -l                    # 0
    grep -rn "sortOrder" src/components/ | wc -l          # 0
    grep -rn "\.liveSessionIds\|\.storedSessionIds" src/ | grep -v '^src/store/'   # 0
    grep -rn "\.liveSessionId\b" src/ | wc -l             # 6, all in src/store/sessions.test.ts — the tab's live dot is INTACT

and from `src-tauri/`, once, to confirm the "no Rust change" claim: `cargo test` **1463 / 0 failed**,
`cargo clippy --all-targets` 0 warnings, `cargo fmt --check` clean, and
`git diff --name-only <T04-base>..HEAD | grep -c '^src-tauri/'` → **0**.

**Commit:** `chore(sidebar): delete sessionActivity — the last sort was the display sort (ADR 0075)`

---

## Files outside the seam that a task must touch

The brief's seam row says "`src/components/SpacesList.tsx`, delete `src/lib/sessionActivity.ts` +
`.test.ts`". These two are additions to it, both unavoidable:

| File | Task | What | Why it cannot be avoided |
|---|---|---|---|
| `src/lib/sessionTypes.ts` | 3 | one token in a header list | it names the deleted module as a reader of `Message`; a dangling name in the file whose whole job is "who reads these types" |
| `src/store/sessions.ts` | 3 | one doc sentence on `SpaceView.storedSessionIds` | it says the deleted module "still runs in the sidebar"; the brief itself lists this as now-false prose to clean, and D2 keeps the field, so the sentence is the only thing left to fix |

Both are comment-only, both are one sentence, and neither can change a test result — `pnpm build` is
indifferent to prose, which is precisely why the greps in Done-when #7 are the gate.

**One now-false cross-reference this plan deliberately does NOT fix:**
`src/components/SessionListRow.tsx`'s "THREE CONSTRAINTS THIS FILE EXISTS TO RESPECT" block cites
`SpacesList.test.tsx`'s `"keeps the rail's marks POSITIONALLY equal to the rows after the activity
sort"` by name, and Task 1 renames that test. The brief puts `SessionListRow.tsx` in T06's seam
(`draggable` on the row, the drop-edge indicator prop), so T04 does not edit it. HANDED TO T06:
one line, replace the quoted name with
`"keeps the rail's marks POSITIONALLY equal to the rows, because both come from the store's ONE sequence"`
and drop "after the activity sort". Recorded here and in Known limits rather than fixed, because a
comment-only edit in a file another task is about to rewrite buys a conflict for nothing.
`docs/roadmap/manual-list-order.md` quotes the same old name in §5; the spec is the orchestrator's to
amend, not a plan child's.

---

## Decisions this plan makes

- **D1 — `railIds` is a plain `const` over a module-level empty array, not a `useMemo`.** It is a
  field read with no transformation left in it, and a memo over an identity is ceremony; the module
  constant is what keeps the input identity stable when `activeView` is `undefined` (no Space
  selected), which is the only reason not to write `?? []` inline. `useSessionStatuses` does not key
  off the array's identity, so this is hygiene, not a fix.
- **D2 — the DEPRECATED `SpaceView.liveSessionIds` / `storedSessionIds` pair is NOT deleted here, and
  the deferral is clean rather than a dodge.** The brief asked for a check before deleting; the check
  is: after Task 1, `grep -rn "\.liveSessionIds\|\.storedSessionIds" src/ | grep -v '^src/store/'` →
  0, so **no production code reads them** — and the only remaining readers are **eight `it(...)`
  bodies in `src/store/sessions.test.ts`** (`it("groups a space with a live session and a stored
  session")`, `it("returns sessionIds in the stored order the boot map carries (no re-sort)")`,
  `it("returns an empty shape for a space with no sessions")` — three whole-object `toEqual`s that
  each carry both keys; `it("a space with TWO coexisting live sessions points at the
  most-recently-started one (the one-live cap lift)")`,
  `it("a space with three or more live sessions orders them newest-first")`,
  `it("handles live sessions from multiple different spaces interleaved")`,
  `it("reports archivedSessionIds without polluting sessionIds, and lastReason falls back to the most recent archived Session")`,
  and `it("adding multiple sessions sequentially via addSession in the same space produces
  newest-first liveSessionIds in views()")` — which read `view.liveSessionIds` /
  `view.storedSessionIds` directly). Three of those have the pair as their SUBJECT, pinning
  reverse-insertion order THROUGH `SpaceView`; deleting the fields means deleting or retargeting them,
  in T03's file, which is a bigger out-of-seam blast radius than a comment and buys no behaviour.
  The function-level contract they duplicate is already pinned directly by
  `it("returns session IDs for matching cwd in reverse insertion order (newest first)")` on
  `liveSessionsInSpace`, which survives. **Handed forward:** the pair should go with T05, whose seam
  already includes `src/store/sessions.ts`, and `detachedSessions`' doc names
  `spaceViewFor`'s `storedSessionIds` filter as the join site it must agree with — with the pair kept,
  that sentence stays true. Done-when #7's dotted-read grep is the pin that the deferral does not
  leave a second live order anywhere: the fields exist, and nothing reads them.
- **D3 — a FOURTH test is deleted: `it("keeps a brand-new live session (no transcript yet) at the TOP of the live group")`.**
  It is not on the spec's deletion list, and it survives Task 1 GREEN, which is why it has to be
  reasoned about rather than left alone. Its premise is `sortByActivity`'s `unknowns: "first"` rule
  for the live group — "no transcript means just created, so it is the newest activity there" — and
  the approved replacement rule is the opposite: new rows join at the BOTTOM. It stays green only
  because its fixture never seeds `sessionOrder`, so every id ties and input order (live-first, and
  `liveSessionsInSpace` reverses, so the fresh row leads) survives. That is a test certifying the
  absence of the rule, which T03's plan calls the worst kind. It is deleted and replaced by Task 1's
  `it("renders a Session started after the boot fetch at the BOTTOM of the list (the new-row rule, not the live block)")`,
  so the fresh-session case ends up pinned in the direction the spec chose. (The branch's own
  precedent — a child on this branch finding and fixing a vacuous test the plan itself specified — is
  the reason this is called out instead of quietly dropped.)
- **D4 — `ArchivedSection` subscribes to `sessionRecency` itself; the parent does not thread it as a prop.**
  The section already owns its own three subscriptions (`archivedSessions`, `sessions`,
  `activeSpacePath`), and lifting the recency read into `SpacesList` would subscribe the whole pane to
  a map only the footer section uses. Same `{ recency }`-only evidence bag the `views` memo passes
  (T03's D3), so the section's order and the banner's Landing Session are decided off one map.
- **D5 — the new fixtures seed the store field `sessionOrder`, never the wire field `sortOrder`.**
  `useSessions.setState({ sessionOrder: { … } })` is the seam the component actually reads; a fixture
  that built `SessionRecency` rows and called `setSessionRecency` would be testing T02's reducer
  again, and would put the wire name inside `src/components/**`, which Done-when #7 forbids by design
  (it is the surviving half of the proof T03 retired: a component reading the database's number is how
  this bug was written the first time).
- **D6 — the frozen-slot test lives in Task 1, not in a test-only task after it.** Written after
  Task 1's implementation it would be born green and prove nothing; written as part of Task 1's red
  batch it fails against the real `sortByActivity` behaviour it exists to forbid. Red-first is the
  reason for the placement, and it is also why this plan has three commits and not four.
- **D7 — `archivedInSpace` is called with the store's LIVE list (`sessions`), matching its signature, and this plan adds NO new store test for it.**
  The function and its two store-level tests shipped in T03; T04's contribution is the call site and
  the DOM proof. Adding a third store test would duplicate T03 and widen the seam for nothing.
- **D8 — `src/lib/sessionRecency.ts` is left untouched, so one mention of the deleted module
  survives, and the successor grep is written to allow exactly that one.** Its header says it is "the
  successor of `sessionActivity.ts`'s `lastActivityOf` (which T04 deletes)", and its inline comments
  name `sortByActivity` as the origin of the NaN-tie mechanism. Those are etymology, and they are the
  kind of reference that helps a reader; rewriting someone else's just-shipped comments to satisfy a
  grep would be the grep wagging the dog. Hence Done-when #7 counts CALLS (`sortByActivity(`, with the
  paren) rather than names, and states the surviving hit-set exactly instead of claiming zero.

## Out of scope

- **`src/components/SessionListRow.tsx` (T06), `src/components/SpaceTabs.tsx` (T07), `src/hooks/**`
  (T05), any Rust file.** Plus the `SessionListRow.tsx` comment named above, explicitly handed to T06.
- **Deleting `SpaceView.liveSessionIds` / `storedSessionIds`** (D2) — handed to T05, whose seam already
  covers `src/store/sessions.ts`, together with the eight `src/store/sessions.test.ts` bodies that
  read them. Nothing in production reads them after this task; that is the grep, not a hope.
- **Any drag behaviour, indicator class, `draggable` attribute, or reorder write.** T05/T06/T07. T04
  changes how the list is ORDERED-into-the-DOM and nothing about how it is dragged.
- **`src/store/sessions.ts` beyond the one doc sentence**, `src/App.tsx`, `src/lib/sessionRecency.ts`,
  `src/lib/sessionTime.ts`, `src/components/SessionRail.tsx` (it takes `rows` as props and is
  unaffected — its own 13 tests are the proof), `src/components/settings/SessionsSection.tsx` (it
  calls `detachedSessions` with four unchanged arguments; Settings → Detached sessions keeps the
  Manual order by design, spec §4 / T03's D7).
- **`docs/features/manual-list-order.md` and the status file** (T08 / the orchestrator). Two things
  belong in the status file's Decisions log when this task is committed, and this plan cannot write
  them: that D3 deleted a fourth test beyond the spec's list and why, and that the `SpaceView` pair
  deletion plus the `SessionListRow.tsx` citation moved to T05 and T06 respectively.

## Verification

Scoped first, then the gate. `npx vitest run <path>` scopes; `pnpm test -- <path>` does not (it runs
all 150 files). Counts are deltas from this plan's HEAD, re-measure rather than assert.

    npx vitest run src/components/SpacesList.test.tsx        # 79 → 78 (T1) → 79 (T2), 0 failed at each step
                                                             #   T1: 4 red first (3 new + the rewritten rail pin)
                                                             #   T2: 1 red first, the archived order assertion
    npx vitest run src/lib/sessionActivity.test.ts           # 16 → file DELETED (Task 3)
    npx vitest run src/store/sessions.test.ts                # 182, unchanged — the store is not this task
    npx vitest run src/lib/sessionRecency.test.ts            # 7, unchanged
    npx vitest run src/components/SessionRail.test.tsx \
                 src/components/SessionListRow.test.tsx \
                 src/components/SpaceTabs.test.tsx \
                 src/components/settings/SessionsSection.test.tsx \
                 src/test/fixtures.test.ts                   # 13 / 15 / 34 / 12 / 25, all unchanged
    npx vitest run src/App.test.tsx                          # 41, unchanged (boot wiring is T03's)
    pnpm test                                                # 3086 → 3070, 150 → 149 files
    pnpm build                                               # green (noUnusedLocals is the orphan gate)

Scope proofs (repo root):

    git diff --name-only <T04-base>..HEAD | sort             # ONLY: src/components/SpacesList.tsx,
                                                             #   src/components/SpacesList.test.tsx,
                                                             #   src/lib/sessionTypes.ts,
                                                             #   src/store/sessions.ts,
                                                             #   AND the two DELETED lib/sessionActivity files
    git diff --name-only <T04-base>..HEAD | grep -c '^src-tauri/'   # 0 — NO RUST CHANGE
    grep -rn "sortByActivity(\|activityKeyOf(\|activityFromKey(\|lastActivityOf(" src/
                                                             # 35 → 0  (the deleted machinery, counted as CALLS)
    grep -rn "sessionActivity" src/                          # 5 → 1, the etymology line in lib/sessionRecency.ts
    grep -rn "sort_order" src/ | wc -l                       # 0  (the SQL name never enters src/)
    grep -rn "sortOrder" src/components/ | wc -l             # 0  (no component reads the number — the retired
                                                             #   proof's surviving half, restated where it bites)
    grep -rn "\.liveSessionIds\|\.storedSessionIds" src/ | grep -v '^src/store/'
                                                             # 3 → 0  (the DEPRECATED pair has no reader outside
                                                             #   the store and its own test — D2's safety claim)
    grep -rn "\.liveSessionId\b" src/ | wc -l                # 6, unchanged — the tab's live dot is INTACT
    grep -rni "recent-first\|recently active first\|newest-first" src/components/SpacesList.tsx   # 3 → 0
    grep -rn "lastOpenedAt" src/components/SpacesList.tsx    # 1 → 0  (the stale comment T03 left for T04)
    grep -n "compareDocumentPosition" src/components/SpacesList.test.tsx
                                                             # 7 before → 7 after, but the OWNERSHIP moves: every
                                                             #   site sits inside a test this plan deletes, adds or
                                                             #   rewrites (Done-when #6) — none survives untouched
    grep -n "\.sessionIds" src/components/SpacesList.tsx     # exactly 2 code sites: `railIds` and the ONE row loop —
                                                             #   one construction of the order, read twice

From `src-tauri/` — run once at the end, to prove the "no Rust change" claim rather than assert it:

    cargo test                                               # 1463 passed / 0 failed, UNCHANGED
    cargo clippy --all-targets                               # 0 warnings, unchanged
    cargo fmt --check                                        # clean

**The `now_ms()`-class trap this plan applies, restated for the frontend** (it is why each of the
three new row fixtures names `sessionOrder` explicitly, and why the Archived fixture names
`sessionRecency` instead): `resetStores()` restores both boot maps to
`{}` from `getInitialState()`, so a test that never seeds `sessionOrder` gets every id unknown, every
id tied, and input order preserved — which at this point in the chain is byte-for-byte the OLD
live-then-stored concatenation. An ordering test written that way passes while asserting nothing.
Every fixture in Task 1 therefore seeds numbers that put the live row where the live block would NOT.

## Known limits this plan accepts

- **A dragged row still does not hold its position until the next boot.** `sessionOrder` is a boot
  snapshot and nothing writes it mid-boot; that is T05's optimistic reorder action (T03 recorded the
  constraint, and `mergeSessionOrder` is exported so T05 reuses it). Between T04 and T05 the sidebar
  renders the ONE order correctly and there is no way to change it yet — which is the honest state of
  the feature, and the reason no plan in this chain may call it done.
- **The DEPRECATED pair stays on `SpaceView` for one more task** (D2). Between this commit and T05's,
  a reader sees three id lists on the view. The mitigation is the grep, not a comment: two of the
  three have zero readers outside `src/store/`, and Done-when #7 makes that a checkable claim rather
  than an assertion in a doc comment.
- **`src/components/SessionListRow.tsx` carries a dangling test-name citation** naming the old rail-pin
  string, until T06 edits that file anyway. Out of seam by the brief's own law; named, quoted and
  assigned above rather than left to be rediscovered.
- **The Archived section's order is decided off the BOOT recency map, not the loaded transcript**
  (D4). For the one reachable case where those disagree — an archived row whose transcript was opened
  and then CLOSED this boot, so it is not live and `messages` holds a final stamp newer than the boot
  map — the section can rank it by the boot number while its row prints the newer time. Same trade T03
  accepted for `lastReason` (its D3), and accepted for the same reason: the alternative is a list-level
  `messages` subscription that re-renders on every streamed token, in the one pane whose header has
  always forbidden it. The number is the same SQL expression, read at boot.
- **`it("keeps the rail's marks POSITIONALLY equal to the rows, because both come from the store's ONE sequence")`
  pins equality, not the order itself.** If a future edit gave the rail and the rows two different
  constructions that happened to agree on the fixture's three ids, this test would pass. The
  anti-vacuity here is the fixture's numbers (the map order differs from the activity order, so a
  re-introduced display sort reddens it) plus the structural fact that both read one `const`. Task 1's
  other three tests own the order itself.
- **Relative-time labels stay live, so a row's LABEL changes while its slot does not.** That is the
  intended behaviour and Task 1's frozen-slot test pins it, but it does mean the sidebar can show
  `"now"` on a row sitting at the bottom — the deliberate consequence of ADR 0075 (position is not
  evidence), and the thing the deleted code used to hide by moving the row.
- **The row's time label is a per-row `messages` subscription the pane no longer has at list level.**
  It is unchanged from before this task, but it is now the ONLY place the sidebar reads transcripts,
  and a future "sort by last message again" edit would find it and could be tempted to hoist it. The
  frozen-slot test is the tripwire.
- **`grep -rn "sessionActivity" src/` is no longer zero by design** (D8). One etymology line survives in
  `src/lib/sessionRecency.ts`. Anyone who prefers the strict zero should make that edit in T03's file
  as its own commit, not smuggle it into this one.
