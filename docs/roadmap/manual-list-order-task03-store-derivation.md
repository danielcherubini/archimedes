# T03 — the store derivation: `recencyOf`, the recency map, `SpaceView.sessionIds`, the Landing Session

Written by `specify` (CONSUMED MODE), **REFINED after the orchestrator's review**: decision **D11 is
reversed** (the row's stored order number now reaches the frontend, so `sessionIds` is ONE sequence
spanning live and stored), T02's `grep … → 0 hits` proof is **retired on purpose** (see the note under
Done-when), and the two seam overlaps are **granted**, not requested.
Contract is the spec **as amended inline on 2026-10-24** —
recency arrives as the `session_recency()` command + a store side-channel, NOT as a field on
`SessionInfo`. T02's `## The contract T03 consumes` is consumed verbatim and not re-derived, except
where this refinement says it does.

**Seam (owned by this task):** `src/lib/sessionRecency.ts` (new) + `src/lib/sessionRecency.test.ts`
(new), `src/store/sessions.ts`, `src/store/sessions.test.ts`, `src/App.tsx` (the boot `Promise.all`
ONLY — nothing else in that file), `src/App.test.tsx` (the `vi.mock` factory line + one new test),
**`src-tauri/src/storage/db.rs`** (one field on `SessionRecency` + one column on one `SELECT` + one
new test — Task 2), **`src-tauri/src/commands/history.rs`** (the pinned wire-KEY literal in
`session_recency_rows_serializes_to_the_pinned_camel_case_keys` — a TEST-only edit; Task 2), and
**`src/lib/tauri/types.ts`** (`sortOrder: number` on the `SessionRecency` mirror — Task 2).

**Rust is in this task's seam, and that is a change from the first draft of this plan, which claimed
"no Rust change".** It moved into the seam because the approved spec's "ONE order per Space, spanning
live and stored" is unachievable without the row's own number reaching the frontend (Decision D11,
reversed — see below). The cost is precisely measured against the tree: `SessionRecency` has **two
sites in production Rust, both in `db.rs`** (the struct definition and the one `query_map` closure in
`Db::session_recency`), plus **one test assertion** in `commands/history.rs` that pins the wire key
set as literals and therefore has to learn the third name, plus **one TS interface**. It is cheap
precisely because the amendment to the spec chose a separate carrier struct instead of a
`SessionInfo` field: `SessionInfo` — the struct ADR 0064 protects — is built at **40 sites, 16 of them
in production**, which is why this field was never going to be cheap there.

**Temporal overlap, stated so a future reader does not think two tasks shared one tree:**
`src/lib/tauri/types.ts` and `src-tauri/src/commands/history.rs` were T02's declared seam. T02 is
`done` and merged (`3386975`), so the overlap is temporal, not concurrent — T03 edits files T02
shipped, it does not race them. The status file's T03 seam row must gain all three paths.

---

## ⚠️ SEAM OVERLAPS — ARBITRATED BY THE ORCHESTRATOR (recorded, not re-litigated)

1. **`src/components/SpacesList.tsx` — GRANTED, but ONLY for the mechanical call-site updates that
   keep `pnpm build` green.** `spaceViewFor` gains two required parameters (6 and 7 — Decision D14), so
   its one call site (the
   `views` memo) cannot compile without arguments, and `pnpm build` (`tsc`) is a gate. T03 edits the
   two selectors, the `spaceViewFor` call and the dep array — quoted verbatim in Task 3, plus the comment
   lines that explain them — and NOTHING else in that file: no memo deletions, no `sortByActivity`
   change, no `railIds` change, no JSX, no render-order logic. Everything else in `SpacesList.tsx`
   stays T04's. `SpacesList.test.tsx` must stay **79/79 without an edit** (the proof the grant was
   not spent on behaviour). Bounded proof, comment-only lines stripped so it counts CODE changes:
   `git diff -U0 <base>..HEAD -- src/components/SpacesList.tsx | grep -E '^[+-]' | grep -v
   '^[+-][+-][+-]' | grep -vE '^[+-][[:space:]]*(//|\*)'` → **6 added / 2 removed**, in TWO hunk
   regions: the selector pair beside the existing `closeReasons` selector (2 added), and the `views`
   memo (the call spread over 3 code lines + the dep-array line, against the 1 call line and the 1
   dep-array line it replaces). **The first draft of this plan claimed 3/2 there; that figure did not
   match its own quoted snippet**, which spread the call over more lines than it counted. Corrected,
   and the corrected count is what the implementer should expect to measure — if their diff comes out
   different, they must reconcile it here rather than quietly reporting their own number.
2. **`src/App.test.tsx` — GRANTED.** Boot wiring IS T03's contract (T03 adds the boot fetch), and that
   file's `vi.mock("./lib/tauri")` factory spreads `importActual`, so an un-mocked `sessionRecency`
   calls the REAL `invoke`, rejects in jsdom, rejects the whole `Promise.all`, and **the `.catch`
   swallows it — `setHistorySessions`/`setSpaces` never run and ~40 tests in that file go red for a
   reason that looks nothing like the cause.** The mock must land in the same commit as the `App.tsx`
   line. (The file's own header documents this exact trap for the other boot fetches.) The grant covers
   the factory line + one new `describe`; it does NOT cover the file's nine hand-written `clearStores`
   helpers, which keep their recorded limit below (a 9-describe refactor that belongs to nobody in
   this chain).

**Deliberate non-collision, stated:** T03 **KEEPS** `SpaceView.liveSessionIds` and
`SpaceView.storedSessionIds` (marked DEPRECATED) and **ADDS** `sessionIds`. Deleting the pair in T03
would force T03 to rewrite T04's render layer (`viewIds`, `liveIds`, `storedIds`, `railIds`, the two
row lists) — a whole component rewrite in someone else's seam. `sessionIds` is derived *from* the two
arms plus the boot order map by ONE function (`mergeSessionOrder`), so the three cannot disagree, and
T04's job becomes "render `sessionIds`, delete the pair". See Decision D4.

## Goal

Make list position mean only position in the frontend, the way T01 made it mean only position in
SQLite. Four moves: (1) recency becomes a value the store holds and can name — a
`Record<string, number>` fed by T02's `sessionRecency()` — with **one** exported rule, `recencyOf`,
that every surface uses; (2) the four sites in `src/store/sessions.ts` that read a list's HEAD as
evidence of "most recent" stop doing so and ask `recencyOf` instead; (3) the ordering the store
exposes becomes **explicit** — one `SpaceView.sessionIds` that is **a single sequence spanning live
and stored**, ordered by the row's own stored order number (which is why one field rides the existing
recency payload, and why this task touches Rust after all), and an archived derivation that sorts by
recency by name instead of inheriting an order the server no longer produces; (4) the standing
"Ordering note" that ADR 0075 names as the origin of the bug gets rewritten, discharging T01's
recorded exemption for `src/store/sessions.ts`.

## Done-when

All observable. Frontend from repo root (AGENTS.md); the Rust half from `src-tauri/`.

1. `src/lib/sessionRecency.ts` exists and exports exactly `recencyOf`, `sortByRecency`,
   `mostRecentByRecency`, `sortByManualOrder`, `type RecencyEvidence`. `recencyOf(sessionId, loadedMessages, recencyMap)`
   returns the loaded transcript's last message `at`, else `recencyMap[sessionId]`, else `null` —
   the spec's rule verbatim, and the ONLY copy of the "prefer the transcript we have" logic in `src/`.
   `sortByManualOrder(ids, orderMap)` is its ordering twin: ascending by the row's stored order number,
   with ids the map does not know placed **LAST** and, within that, in input order — which is the
   approved "new rows join at the bottom" rule, so it needs no new decision.
   It imports no store (`sessionTitle.ts`/`sessionTypes.ts` precedent).
2. `useSessions` state has **two** boot maps of the same shape — `sessionRecency: Record<string, number>`
   and `sessionOrder: Record<string, number>` — both initialised `{}` and both written by ONE new
   `setSessionRecency(rows: SessionRecency[])` that REPLACES both wholesale (Decision D13 —
   unlike its neighbour `closeReasons`, which is merge-only). They are two readings of ONE payload from
   ONE IPC round-trip, so one action writes both and no render can observe them out of step. Each
   copies `closeReasons`'s *shape*
   exactly: declared in `SessionsState`, initialised in the `create` body, one `set` updater.
   `src/test/resetStores.ts` needs **no change** (it resets from zustand's `getInitialState()`, so a
   new field is covered for free — verified: `src/test/fixtures.test.ts`'s deep-equal proof passes
   without an edit).
3. `src/App.tsx`'s boot `Promise.all` fetches three things (`listSessions(true)`, `listSpaces()`,
   `sessionRecency()`) and the callback calls `setSessionRecency` **before** `setSpaces`, because
   `setSpaces` runs `autoSelectActive`, which reads the map. `App.test.tsx` pins both the fetch and
   that order. **No second IPC call is added for the order map** — it rides the recency payload.
4. `SpaceView` has `sessionIds: string[]`, built by ONE exported function
   (`mergeSessionOrder(liveSessionIds, storedSessionIds, orderMap)`) as **one sequence spanning live
   and stored**: live and stored rows interleave by their real stored numbers, and a row the order map
   does not know — one started after the boot fetch — lands at the BOTTOM. `liveSessionId`,
   `liveSessionsInSpace` and `mostRecentLiveInSpace` all survive unchanged; `liveSessionIds`/
   `storedSessionIds` survive marked `DEPRECATED — T04 deletes` and are the inputs `sessionIds` is
   built from. **A resumed Session therefore keeps the slot the database holds for it** — the symptom
   the mission statement leads with, pinned by the two named tests Task 3 calls 2 and 3.
5. The four position-reading sites: `selectSpace` and `autoSelectActive` take the max `recencyOf` over
   the stored arm (live still preferred); `spaceViewFor`'s `lastReason` reads max `recencyOf` over
   stored, then archived as a last resort; **`removeSpace`'s fallback is UNCHANGED and pinned by a new
   test constructed so the leftmost tab is NOT the most recent Space.**
6. `archivedInSpace(...)` is exported from the store and sorts by recency **explicitly**; its test
   fixture is built so manual order and recency order DISAGREE, so the test cannot pass by accident.
   `detachedSessions` is NOT re-ordered (Decision D7) but its stale ordering doc is rewritten.
7. T01's recorded exemption for `src/store/sessions.ts` is discharged: entries 1–3 of its stale-comment
   list are rewritten or deleted, and
   `grep -rn "recent-first\|recently ACTIVE first\|newest-first" src/store/sessions.ts` → **0 hits**
   (today: 5). Entry 4 (`SpacesList.tsx`) stays T04's.
8. The Rust step is observable, and small. `Db::session_recency()`'s rows carry the row's own stored
   order number, and `session_recency_rows_serializes_to_the_pinned_camel_case_keys` pins **three**
   wire keys (`lastActiveAt`, `sessionId`, `sortOrder`) where it pinned two. Proofs, repo root:
   `git diff --name-only <base>..HEAD | grep '^src-tauri/'` lists ONLY `src-tauri/src/storage/db.rs`
   and `src-tauri/src/commands/history.rs`; `cargo test` from `src-tauri/` reports **+1 test** over this
   plan's base (measured **1462 passed / 0 failed** at `dc3c050` → **1463**) and **0 failures**;
   `cargo clippy --all-targets` stays at **0 warnings**; `cargo fmt --check` clean. The scope proof is
   that those two files and that one test are the entire Rust delta — no command signature, no
   registration, no `SessionRow`/`SessionInfo`/`SpaceRow` field moves.
9. **The successor to the proof this task retires** (see "The proof T02 asserted is retired here",
   below, which says plainly why `grep -rn "sort_order\|sortOrder" src/ → 0 hits` can no longer be the
   assertion):
   `grep -rn "sortOrder" src/ src-tauri/src` hits ONLY — `src/lib/tauri/types.ts` (the wire mirror),
   `src/App.test.tsx` and `src/store/sessions.test.ts` (the fixtures that seed a `SessionRecency` row),
   `src/store/sessions.ts` (the order map and its reduction), `src-tauri/src/commands/history.rs` (the
   pinned wire-key literal), and at most a doc comment in `src-tauri/src/storage/db.rs`. It is an
   ALLOW-list, not an expectation: `src/lib/tauri.test.ts` and `src/lib/sessionRecency.test.ts`
   legitimately have ZERO hits — the first is deliberately left unedited by Task 2 (its wrapper returns
   its payload untouched) and the second tests a bare `Record<string, number>`. And note what does NOT
   move: `commands/spaces.rs` names the column in a doc comment as `sort_order`, which this camelCase
   grep does not match. **`src/components/**` appears ZERO times** — no
   component may read the number, only the store — and `src/lib/sessionRecency.ts` names it, if at
   all, in a doc comment and never in code: the order map is a plain `Record<string, number>` and the
   module does not know where the numbers came from.
10. `pnpm test` and `pnpm build` green from repo root.

**The proof T02 asserted is retired here, on purpose, and not quietly.** T02's Done-when #8 required
that `grep -rn "sort_order\|sortOrder" src/` return **zero** hits, and the orchestrator verified that
at T02's commit. That was a **T02-scoped statement about T02's own diff** — "the column has no
frontend CONSUMER yet" — and never a durable invariant: the very next task in the chain is the one the
spec amends the design for, and a number the frontend may not name could not have been the design.
Adding `sortOrder` to the `SessionRecency` mirror **invalidates that proof by design**, so this plan
does not leave it standing and does not reword it into something unfalsifiable. What survives, in a
form the next reviewer can actually run:

- the column reaches the frontend **only** as a field of the `SessionRecency` payload, and is consumed
  by exactly ONE thing — the store's order derivation (`setSessionRecency` → `sessionOrder` →
  `mergeSessionOrder`);
- **no component reads it**: `src/components/**` must appear zero times in the successor grep above,
  which is the load-bearing half of the old claim restated where it bites (the reason T02's grep
  existed was that a component reading a database number is how this bug was written the first time);
- and the old grep stays useful as a *narrower* check: `grep -rn "sort_order" src/` (the snake_case
  column name) must stay at **0** hits — the column name itself never crosses the wire, only its
  camelCase field does, and `src/` has no business spelling SQL.

**The token rule below is rewritten to match**, because the first draft of this plan told the
implementer to avoid spelling the column into `src/` in comments, and after this task that would be
both impossible to honour and pointless.

Counts are **intended DELTAS**, re-measured at the implementing HEAD. Measured at `dc3c050`:
`pnpm test` **3066 passed / 149 files** · `pnpm build` green · `cargo test` **1462 / 0 failed** ·
`src/store/sessions.test.ts` **170** · `src/App.test.tsx` **40** · `src/components/SpacesList.test.tsx`
**79** · `src/lib/sessionActivity.test.ts` **16** · `src/components/settings/SessionsSection.test.tsx`
**12** · `src/test/fixtures.test.ts` **25**. This plan intends **`pnpm test` +20 → 3086, 150 files**
(new file `sessionRecency.test.ts` +7 — 5 for `recencyOf`/`sortByRecency`/`mostRecentByRecency` + 2 for
`sortByManualOrder`; `sessions.test.ts` 170 → 182 = Task 2 +2, Task 3 +6, Task 4 +4; `App.test.tsx`
40 → 41) and **`cargo test` +1 → 1463** (one new `db.rs` test; the `commands/history.rs` wire-key pin
is EDITED, not added, so it moves no count). Rewrites and KEEPs move no count — every number above
is a NEW `it(...)`/`#[test]`. Scoped Rust counts follow from that: `cargo test --lib -- session_recency`
**3 → 4** (the two `storage::db` pins + the one `commands::history` pin, plus the new one) and
`cargo test --lib -- storage::db` **41 → 42** (T02's own delta took it 38 → 41).

---

## Conventions this plan inherits (do not re-litigate)

- **TDD is a repo convention.** Every task writes its failing test first and names the command that
  proves the red.
- **Scoped vitest is `npx vitest run <path>…`.** `pnpm test -- <path>` does NOT scope — it runs all
  149 files (measured twice on this branch). A frontend red here is a genuine assertion failure, not a
  compile error; quote it.
- `tsconfig.json` sets `noUnusedLocals`/`noUnusedParameters` and `verbatimModuleSyntax`: an unused
  import or an unused parameter reddens `pnpm build`, and type-only imports must be `import type`.
- The store's side-channel precedent is `closeReasons` — declared in `SessionsState`, initialised
  `{}`, written as `{ ...state.closeReasons, [id]: reason }`. Both boot maps copy its *declaration and
  initialisation* exactly; the WRITE differs on purpose (D13: replace, not merge).
- A `lib/` module must not import a store (`src/lib/sessionTypes.ts`'s header is the reason).
  `lib → lib/tauri` for a type IS precedented (`lib/sessionLookup.ts`).
- **The fixture trap this task lives or dies on:** a test where input order and recency order AGREE
  proves nothing. Every "recency wins over position" fixture must put the winner somewhere the old
  rule could not reach it (last in the array, or in a later Space), and every archived fixture must
  make manual order and recency order differ. **The same trap has a second shape after the D11
  reversal:** a fixture where the live row belongs at the FRONT anyway proves nothing about the merge.
  Every merge test must place the live row's number in the MIDDLE or END of the stored rows' numbers,
  so "live block first" and "one DB order" return DIFFERENT sequences. A merge test that cannot tell
  those two rules apart is worse than no test — it certifies the bug.
- Far-future explicit stamps in fixtures (`9_000_000_000_000`-style, T02's rule), never `Date.now()`
  arithmetic, so a fixture cannot accidentally tie.
- **The token rule — a comment in `src/` can redden a gate, but this task changed which gates bite.**
  The FIRST draft of this plan said `sort_order`/`sortOrder` must never be spelled into `src/`, because
  T02's grep was read as standing forever. It is not standing (see the retirement note above), so the
  rule is now:
  - `sort_order` (the snake_case COLUMN name) still stays out of `src/` entirely, comments included —
    `src/` does not spell SQL, and Done-when #9's narrow half asserts this;
  - `sortOrder` may appear in `src/` ONLY at the four places Done-when #9 lists (the wire mirror, the
    test fixtures, the store's reduction, the Rust). It must NOT appear in `src/components/**` at all,
    and a doc comment in `src/lib/sessionRecency.ts` should say "the stored order number" rather than
    name the field, because that module's whole point is that it takes a `Record<string, number>` and
    knows nothing about its origin;
  - the `recent-first` / `recently ACTIVE first` / `newest-first` ban in `src/store/sessions.ts`
    (Done-when #7 requires 0 hits) is UNCHANGED: Task 5's replacement prose says "the manual order" and
    "most recently STARTED", never a synonym of the banned phrases.
- **`archimedes` is ONE compilation unit (AGENTS.md), and Task 2 now has a Rust TDD step, so this
  applies here** (it is T02's inherited convention, not a new one): a Rust "red" that references a
  not-yet-existing FIELD is a **whole-binary compile error**, not a scoped failure — while it stands, no
  gate can be claimed green OR red and no count from it means anything. Task 2's Rust red is exactly
  that (`no field 'sort_order' on type 'SessionRecency'`) and must be REPORTED as a compile red.
  Scoped Rust syntax is `cargo test --lib -- <filter>`, and filters after `--` are an OR'd UNION, not a
  subset.

---

## Task 1 — `src/lib/sessionRecency.ts`: the ONE rule (new pure module)

**Files owned:** `src/lib/sessionRecency.ts` (new), `src/lib/sessionRecency.test.ts` (new). Nothing
else. Nothing imports it yet.

**Write the failing tests FIRST** — `src/lib/sessionRecency.test.ts`, seven tests (five recency, two
order):

1. `it("recencyOf prefers the loaded transcript's last stamp over the boot recency map")` —
   `recencyOf("s1", [msg(1_000), msg(9_000_000_000_000)], { s1: 500 })` is `9_000_000_000_000`. The
   map value is DIFFERENT and LOWER, so an implementation reading the map first is red.
2. `it("recencyOf falls back to the recency map when no transcript is loaded")` — `recencyOf("s1",
   undefined, { s1: 5_000 })` is `5_000` AND `recencyOf("s1", [], { s1: 5_000 })` is `5_000` (an empty
   array is "no evidence", not "zero evidence" — `addSession` gives a fresh session `[]`).
3. `it("recencyOf is null when neither the transcript nor the map can prove recency")` —
   `recencyOf("ghost", undefined, {})` is `null`. This case is REACHABLE, not defensive: a Session
   that CLOSED this boot is appended to `historySessions` by `handleSessionClosed` and has no entry in
   the boot map.
4. `it("sortByRecency orders by recency and NOT by input order, sinking what has no evidence")` —
   `sortByRecency(["a", "b", "c"], { recency: { a: 1, c: 9 } })` is `["c", "a", "b"]`. Input order is
   `[a, b, c]`, so an implementation that sorts by nothing answers `["a","b","c"]` and is red; `b` has
   no evidence and goes LAST (the `-Infinity` sentinel), never `0` — "no evidence" must not be confused
   with "epoch recency", which is the surviving half of `sortByActivity`'s `unknowns: "last"` rule.
5. `it("mostRecentByRecency keeps the FIRST of two equal stamps and answers null for no ids")` —
   `mostRecentByRecency(["x", "y"], { recency: { x: 7, y: 7 } })` is `"x"` (input order is the
   tie-break — the surviving half of `sortByActivity`'s stable-sort rule, and the reason a dragged
   list cannot reshuffle on equal stamps), and `mostRecentByRecency([], { recency: {} })` is `null`.
6. `it("sortByManualOrder orders by the stored number and NOT by input order")` —
   `sortByManualOrder(["a", "b", "c"], { a: 2, b: 0, c: 1 })` is `["b", "c", "a"]`. Input order is
   `[a, b, c]` and its FIRST element has the LARGEST number, so an implementation that sorts by nothing
   — or that sorts DESCENDING — is red. Ascending is not a guess: the database reads the column
   `ASC` (`list_sessions`'s `ORDER BY`), and new rows take `MAX + 1`, so a bigger number is a lower row.
7. `it("sortByManualOrder puts ids the map does not know at the BOTTOM, in input order")` —
   `sortByManualOrder(["known2", "new2", "known1", "new1"], { known1: 0, known2: 1 })` is
   `["known1", "known2", "new2", "new1"]`. The two unknowns go LAST and keep their relative input
   order. This is the "new rows join at the bottom" rule from the spec's closing table, expressed as a
   sentinel — the SAME shape as `sortByRecency`'s "no evidence sinks", and for the same reason: an
   unknown must never be defaulted to `0`, which would jump a brand-new row to the TOP of the list.

**Red:** `npx vitest run src/lib/sessionRecency.test.ts` → the file fails to load (no such module).
Isolated to one file; the rest of the suite is unaffected, so a count IS quotable.

**Implementation** (`src/lib/sessionRecency.ts`, header prose in the file's own voice — it must say:
this is the ONE recency rule, placed beside `sessionTitle.ts` for the same reason `titleFor` is there
("one function so two surfaces cannot disagree"); it is the successor of
`sessionActivity.ts`'s `lastActivityOf`, which T04 deletes, and it deliberately does NOT re-export a
second `lastActivityOf` name so no call site can pick a side; `messages` is optional on the
evidence bag because a component call site cannot afford to subscribe to `messages` — see
`activityKeyOf`'s header for the re-render that costs; and `sortByManualOrder` lives here rather than
beside `mergeSessionOrder` in the store because the bottom-sink rule is the SAME rule as the recency
sink and belongs where a reader can compare the two lines side by side. It must NOT name where the
order numbers come from — this module takes a `Record<string, number>` and knows nothing else):

```ts
import type { Message } from "./sessionTypes";

/** What a recency decision may read. `messages` is OPTIONAL: a component that
 *  subscribed to the whole `messages` map would re-render on every streamed
 *  token (the exact hazard `activityKeyOf` exists to dodge), so a call site
 *  passes the transcript arm only when it already holds it cheaply, and the
 *  boot recency map carries the decision otherwise. */
export interface RecencyEvidence {
  /** Boot recency per session id, from `sessionRecency()` (ADR 0075). */
  recency: Record<string, number>;
  /** Transcripts loaded this boot — the FRESHER evidence, when this call site has it. */
  messages?: Record<string, Message[] | undefined>;
}

/** "When was this Session last active?" — the one answer, in Unix ms, or `null`. */
export function recencyOf(
  sessionId: string,
  loadedMessages: Message[] | undefined,
  recencyMap: Record<string, number>,
): number | null {
  const last = loadedMessages?.[loadedMessages.length - 1];
  if (last !== undefined) return last.at;
  return recencyMap[sessionId] ?? null;
}

/** Most-recent-first over ids. STABLE for ties (input order survives), and an id
 *  with no evidence goes LAST — never `0`, which would be inventing recency. */
export function sortByRecency(
  ids: readonly string[],
  evidence: RecencyEvidence,
): string[] {
  return ids
    .map((id, i) => ({ id, i, at: recencyOf(id, evidence.messages?.[id], evidence.recency) }))
    // Two unknowns are `-Infinity - -Infinity` → NaN → falsy, so the tie falls
    // through to input order. Same mechanism `sortByActivity` documented.
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.i - b.i)
    .map((x) => x.id);
}

/** The id a recency decision lands on, or `null`. The ONLY comparison a call site may use. */
export function mostRecentByRecency(
  ids: readonly string[],
  evidence: RecencyEvidence,
): string | null {
  return sortByRecency(ids, evidence)[0] ?? null;
}

/** Ascending by the stored order number (the database reads it `ASC`, and new
 *  rows take `MAX + 1`, so a BIGGER number is a LOWER row). An id the map does
 *  not know goes LAST — never `0`, which would promote a row started this boot
 *  to the top of a list the user arranged. STABLE for ties and among unknowns
 *  (input order survives), for the same reason `sortByRecency` is. */
export function sortByManualOrder(
  ids: readonly string[],
  orderMap: Record<string, number>,
): string[] {
  return ids
    .map((id, i) => ({ id, i, at: orderMap[id] }))
    // `?? Infinity` sinks the unknowns to the BOTTOM of an ASCENDING sort (the
    // mirror of `sortByRecency`'s `-Infinity`, which sinks them in a DESCENDING
    // one). Two unknowns are `Infinity - Infinity` → NaN → falsy, so their tie
    // falls through to input order — the same mechanism `sortByActivity` documented.
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.i - b.i)
    .map((x) => x.id);
}
```

**Green:** `npx vitest run src/lib/sessionRecency.test.ts` (7 pass) → `pnpm build` (proves the new
module type-checks under `strict`) → `npx vitest run src/lib/sessionActivity.test.ts` (16, unchanged —
this task does NOT touch it; see Out of scope).

**Commit:** `feat(store): add recencyOf as the one recency rule (ADR 0075)`

---

## Task 2 — the row's order number reaches the store, and boot feeds both maps

**Files owned:** `src-tauri/src/storage/db.rs` (one field on `SessionRecency`, one column on one
`SELECT`, one new `#[test]`), `src-tauri/src/commands/history.rs` (the pinned wire-KEY literal in
`session_recency_rows_serializes_to_the_pinned_camel_case_keys` — a TEST-only edit; the command, its
signature and its registration are untouched), `src/lib/tauri/types.ts` (one field on the mirror),
`src/store/sessions.ts` (TWO state fields, TWO interface entries, ONE action, one `SessionRecency`
type import), `src/store/sessions.test.ts` (2 new tests), `src/App.tsx` (the boot
`Promise.all` — nothing else in the file), `src/App.test.tsx` (the `vi.mock` factory + 1 new test).

**Why Rust is in this task at all (the answer a reviewer will ask for).** The spec's approved decision
is "ONE order per Space, spanning live and stored", and the reason it was approved is that keeping a
live/stored split means "a manual drag can't cross the invisible boundary — so 'stop them moving
around' is only half fixed". Interleaving live rows with stored rows by position requires the frontend
to KNOW a live row's position. It did not: T02's `SessionRecency` carried `sessionId` + `lastActiveAt`
only. The first draft of this plan accepted that as a limitation; the orchestrator reversed it, and the
reversal is right — the field is cheap here in exactly the way the spec amendment bought it:
`SessionRecency` is constructed at **two sites, both in `db.rs`** (the struct and the `query_map`
closure in `Db::session_recency`), NOT at the 40 sites `SessionInfo` — the struct ADR 0064 protects —
is built at. And `Db::session_recency`'s SQL already reads **every non-subagent row, archived
included**, so a resumed/live Session's own row is already in the result set: a live session HAS a
`sessions` row, because `record_session` writes it at start (and re-runs on resume, where the
`ON CONFLICT DO UPDATE` branch deliberately **does not renumber** — "a row the user has positioned
must not move when its session is resumed"). That last clause is the whole reversal resting on
existing, shipped behaviour rather than new code.

**Write the failing tests FIRST** (Rust first, because `archimedes` is one compilation unit and the
frontend half depends on the field existing to type-check):

Rust — `src-tauri/src/storage/db.rs`, one new `#[test]` in the existing `mod tests`:

1. `#[test] fn session_recency_reports_the_manual_order_number_and_reorder_moves_it()` — record three
   sessions through `record_session` (the file's own rule: raw `INSERT`s would leave every row on
   `DEFAULT 0` and tie the assertion), so their numbers are 0/1/2 in record order. Assert two things:
   (a) each row's reported number **equals `sort_order_of(&db, "sessions", "id", <id>)`**, the file's
   existing scalar helper — i.e. the payload echoes the column rather than deriving anything; then
   (b) call `db.reorder_sessions(&["c", "a", "b"])` and assert the reported numbers MOVED with it
   (`a` is now 1, `b` is 2, `c` is 0). Half (b) is the point: it proves `Db::session_recency` and
   `Db::reorder_sessions` AGREE about the column, so the frontend's boot order map cannot disagree
   with the write path a drag uses (T05's). Fixture rule inherited from T01/T02: the expectation is
   written as literal integers, never recomputed from a constant under test.

   `src-tauri/src/commands/history.rs` — EDIT the existing
   `session_recency_rows_serializes_to_the_pinned_camel_case_keys`: its `assert_eq!(keys, vec![
   "lastActiveAt", "sessionId"])` literal gains `"sortOrder"` (alphabetical, because
   `serde_json::to_value` emits a `BTreeMap`-ordered object, which is why the two existing names are
   already alphabetical). Also assert the VALUE half on a row whose number is not its record position,
   so a field wired to the wrong column index is caught: after a `reorder_sessions` the fixture's
   `s_rec` reports the moved number, not `0`. **This edit is not optional** — that test's whole purpose
   is "a dropped `rename_all` is invisible to every value assertion, so pin the key NAMES", and a
   three-field struct checked against a two-name list fails the moment the field lands.

**Frontend tests:**

1. `src/store/sessions.test.ts`, a new `describe("sessionRecency (the recency + order side-channel, ADR 0075)")`
   → `it("the store starts with empty sessionRecency and sessionOrder maps (the closeReasons side-channel shape)")` —
   `expect(useSessions.getState().sessionRecency).toEqual({})` and
   `expect(useSessions.getState().sessionOrder).toEqual({})`. Assertion red (today `undefined`), not
   a throw, so the failure text is the missing field itself.
2. Same describe → `it("setSessionRecency reduces one row set into BOTH the per-id recency map and the per-id order map")`
   — call `useSessions.getState().setSessionRecency([{ sessionId: "s1", lastActiveAt: 9_000_000_000_000, sortOrder: 4 }, { sessionId: "s2", lastActiveAt: 8_000_000_000_000, sortOrder: 1 }])`
   and expect `sessionRecency` to equal `{ s1: 9_000_000_000_000, s2: 8_000_000_000_000 }` AND
   `sessionOrder` to equal `{ s1: 4, s2: 1 }` — **the two maps reduce from the SAME array, so a setter
   that fills one and forgets the other is red here, and that is the single most likely way to ship
   this feature broken.** Add a third row for an id already present and assert the later row wins in
   BOTH maps (the maps are a snapshot of the newest read, not append-only like `closeReasons` — say so
   in the doc comment, because the neighbour precedent is merge-only and a reader will otherwise assume
   it).
3. `src/App.test.tsx` → a new `describe("App (the ADR 0075 recency fetch at boot)")` holding
   `it("boot fetches sessionRecency alongside listSessions and listSpaces and fills both maps before setSpaces runs")`
   — `vi.mocked(sessionRecency).mockResolvedValueOnce([{ sessionId: "h1", lastActiveAt: 9_000_000_000_000, sortOrder: 7 }])`,
   `render(<App />)`, drain the boot effect the way the file already does (`await act(async () => {
   await Promise.resolve(); })`), then `expect(sessionRecency).toHaveBeenCalledTimes(1)` — **exactly
   once: the order map must NOT cost a second IPC round-trip** — plus
   `expect(useSessions.getState().sessionRecency).toEqual({ h1: 9_000_000_000_000 })` and
   `expect(useSessions.getState().sessionOrder).toEqual({ h1: 7 })`. Importing
   `sessionRecency` from `./lib/tauri` is what makes the assertion talk to the mock.
   **The new describe needs its own `beforeEach(clearStore)/afterEach(clearStore)`** in this file's
   hand-written pattern, and its key list MUST name `sessionRecency: {}` and `sessionOrder: {}` — this file resets by
   hand-written key lists (nine of them, none importing `src/test/resetStores.ts`), which is precisely
   the leak `resetStores.ts` was written to end. Importing `resetStores` here instead is welcome and
   correct (it covers the new field for free), but it is a 9-describe refactor that belongs to nobody
   in this chain, so this task adds one local helper and records the debt rather than spending the
   blast radius.

**Red:** `cd src-tauri && cargo test --lib -- session_recency` → a **compile red** (`error[E0560]:
struct 'SessionRecency' has no field named 'sort_order'`, or `no field 'sort_order' on type
'SessionRecency'` for the read). Per the inherited convention, while that stands **no Rust gate is
claimable and no count means anything** — report it as a compile red, not a test failure, and do not
quote a passing `cargo test` number from that state. If a genuine ASSERTION red is wanted before the
fix, add the field with a placeholder (`sort_order: 0`) and no `SELECT` change: the new test then fails
on "the reported number tracks `reorder_sessions`" (it stays `0`), which is the assertion the column
satisfies. Either way the reported number for this task's Rust delta is **+1 test**, and the two
existing `session_recency*` pins in `storage::db` stay green — the reversal does not change what they
assert.

`npx vitest run src/store/sessions.test.ts` → 2 failures (assertion: `undefined` is not
`{}`; `setSessionRecency is not a function`). `npx vitest run src/App.test.tsx` → the new test fails
first with a TypeError on `mockResolvedValueOnce` (`vi.mocked` is an identity at runtime, so an
un-mocked export has no mock API to configure) — that IS the red the mock is missing; add the factory
line and the failure becomes the real one, the `sessionRecency` state assertion, because nothing
populates the store yet. Report the first as a harness red and the second as the assertion red.
`src/lib/tauri.test.ts` (25 in that file's recency describe) stays green UNEDITED: its mock payload is
`[{ sessionId, lastActiveAt }]`, the wrapper returns the payload **unchanged**, and `interface
SessionRecency` is compile-time only — an extra interface field is not a runtime shape that test
asserts. Leave it alone; a plan that "helpfully" adds `sortOrder` to that fixture is spending T02's
file for nothing.

**Implementation:**

`src-tauri/src/storage/db.rs` — TWO sites, both in this file, and that is the whole Rust surface:

1. `pub struct SessionRecency` gains `pub sort_order: i64,` after `last_active_at`, with a doc comment
   saying what it is for and why it rides THIS payload ("the row's position in the user's Manual order;
   it travels here so ONE sequence can span live and stored rows — the frontend cannot interleave what
   it cannot see. Nothing in the frontend reads the NAME; the store reduces it into an order map").
   `#[serde(rename_all = "camelCase")]` is already on the struct, so the wire key is `sortOrder` for
   free — which is precisely the drift the `history.rs` key literal exists to catch.
2. `Db::session_recency`'s `SELECT` gains the column, and **nothing else in the statement changes** —
   not the `WHERE is_subagent = 0` filter (whose equality with `list_sessions(true)`'s key set is a
   documented contract), not the `ORDER BY id` determinism clause, not the `{LAST_ACTIVITY}`
   interpolation:

   ```rust
   "SELECT id, {LAST_ACTIVITY}, sort_order FROM sessions WHERE is_subagent = 0 ORDER BY id"
   ```

   and the `query_map` closure gains `sort_order: row.get(2)?`. No new constant is needed or wanted:
   `sort_order` is a plain column name, not a shared expression, and inventing a const for it would
   imply a drift risk that does not exist.

`src/lib/tauri/types.ts` — `export interface SessionRecency` gains

```ts
  /** The row's position in the user's Manual order (bigger = lower). Boot order map input; no component reads it. */
  sortOrder: number;
```

`src/store/sessions.ts` — `type SessionRecency` joins the existing
`import { …, type SessionInfo, type SpaceRow, … } from "../lib/tauri";` block (alphabetical, matching
the file's order). In `SessionsState`, immediately after `closeReasons` (so the side-channels sit
together and the shape is obvious by adjacency):

```ts
  /**
   * Last activity per session id, in Unix ms, from the boot `session_recency`
   * command (ADR 0075: position is not evidence, so anything that wants recency
   * has to hold it as a FIELD). Same shape as `closeReasons`, and the same
   * boot-fetched side-channel — but NOT merge-only: `setSessionRecency`
   * replaces the whole map, because the command answers "every non-subagent
   * session as of now" and a stale id must not outlive its row.
   * Read ONLY through `lib/sessionRecency`'s `recencyOf` — never indexed by a
   * call site, or the one rule has two owners.
   */
  sessionRecency: Record<string, number>;
  /**
   * Position per session id in the user's MANUAL ORDER, from the SAME boot
   * payload as `sessionRecency` (bigger number = lower row; a row started after
   * boot simply has no entry and sorts at the bottom).
   *
   * This is what makes ONE sequence span live and stored: a live row's position
   * is knowable, so a Session RESUMED this boot keeps the slot the database
   * holds for it instead of jumping to the front of a "live block". It is a
   * position and nothing else — never evidence (ADR 0075) — and it is read ONLY
   * by `mergeSessionOrder` via `sortByManualOrder`.
   */
  sessionOrder: Record<string, number>;
  /** Replace BOTH maps from `sessionRecency()`'s rows (boot, alongside `setHistorySessions`). ONE call, ONE IPC round-trip's payload: the two maps must never be observable out of step. */
  setSessionRecency: (rows: SessionRecency[]) => void;
```

Initialise `sessionRecency: {},` and `sessionOrder: {},` in the `create` body next to `closeReasons: {},`,
and implement the action beside `setHistorySessions` (it takes ROWS, not a pre-shaped map —
`setHistorySessions` takes rows for the same reason, so the array→map reduction lives in the store where
it is testable and `App.tsx` stays one line):

```ts
  setSessionRecency: (rows) =>
    set(() => ({
      // ONE payload, TWO readings: the recency a decision needs and the position
      // the one sequence needs. Both replaced wholesale (see the field docs).
      sessionRecency: Object.fromEntries(
        rows.map((r) => [r.sessionId, r.lastActiveAt]),
      ),
      sessionOrder: Object.fromEntries(
        rows.map((r) => [r.sessionId, r.sortOrder]),
      ),
    })),
```

`src/App.tsx` — `sessionRecency` joins the existing `import { …, listSessions, listSpaces, … } from
"./lib/tauri"` block. The boot effect becomes (and this is the whole of T03's edit to the file):

```tsx
    Promise.all([listSessions(true), listSpaces(), sessionRecency()])
      .then(([rows, spaces, recency]) => {
        useSessions.getState().setHistorySessions(rows);
        // BEFORE setSpaces: setSpaces runs autoSelectActive, which decides the
        // Landing Session from these maps (ADR 0075). The three calls above have
        // already settled, so this ordering costs nothing and is the whole
        // contract — a swap lands boot on the map-less fallback. ONE call fills
        // BOTH the recency map and the order map: the order number rides this
        // payload precisely so boot costs no fourth IPC round-trip.
        useSessions.getState().setSessionRecency(recency);
        useSessions.getState().setSpaces(spaces);
      })
      .catch((err) =>
        console.error("failed to load stored sessions/spaces/recency", err),
      );
```

(The `.catch` message gains `/recency` so a rejection names all three fetches. Also amend the effect's
header comment, which currently says "`listSessions(true)` fetches the FULL list … the store splits it
by the flag" — one added sentence naming the third fetch and why its order matters. Nothing else in
`App.tsx`.)

`src/App.test.tsx` — in the `vi.mock("./lib/tauri")` factory, next to the two sibling boot mocks:

```ts
    listSessions: vi.fn().mockResolvedValue([]),
    listSpaces: vi.fn().mockResolvedValue([]),
    // The ADR 0075 recency fetch (which also carries the order number).
    // REQUIRED, not tidy: this factory spreads
    // `importActual`, so an un-mocked `sessionRecency` fires a real `invoke`,
    // the boot `Promise.all` rejects, the `.catch` swallows it, and `setSpaces`
    // never runs — every test in this file then lands `activeSpacePath: null`
    // for a reason that looks nothing like the cause.
    sessionRecency: vi.fn().mockResolvedValue([]),
```

**Green:** `cd src-tauri && cargo test --lib -- session_recency` (3 → 4) ·
`cargo test --lib -- storage::db` (41 → 42) · `cargo test` (1462 → 1463, 0 failed) ·
`cargo clippy --all-targets` (0 warnings) · `cargo fmt --check` ·
`npx vitest run src/store/sessions.test.ts` (170 → 172) ·
`npx vitest run src/App.test.tsx` (40 → 41) ·
`npx vitest run src/lib/tauri.test.ts` (unchanged — see the Red note; the wrapper returns its payload
untouched, so the new interface field is invisible to it) ·
`npx vitest run src/test/fixtures.test.ts` (25, unchanged — `resetStores` covers the new fields via
`getInitialState()`, and `dirtyEveryStore` does not dirty them, so the deep-equal reset proof stays
green without an edit) · `pnpm build`.

**Commit:** `feat(store): carry the row's order number into the boot maps, one IPC round-trip for both`

---

## Task 3 — `SpaceView.sessionIds` as ONE sequence spanning live and stored, the explicit Archived order, and `lastReason` off recency

**Files owned:** `src/store/sessions.ts` (`SpaceView`, `spaceViewFor`, new `mergeSessionOrder`, new
`archivedInSpace`), `src/store/sessions.test.ts`, **and the mechanical call-site lines in
`src/components/SpacesList.tsx`** (granted overlap #1 above — build-green only).

**Write the failing tests FIRST** — `src/store/sessions.test.ts`:

1. REWRITE `it("returns storedSessionIds in the given input order (no re-sort)")` →
   `it("returns sessionIds in the stored order the boot map carries (no re-sort by anything else)")`. Keep
   the fixture's SPECIFIC input order (it still proves the store does not invent a sequence) and give it
   an `orderMap` that AGREES with it (`{ idX: 0, idY: 1 }` — agreeing on purpose: this test is about
   "no re-sort", not about the merge, and test 3 owns the merge). Change the whole-object `toEqual` to
   carry `sessionIds: ["idX", "idY"]` and drop `storedSessionIds`/`liveSessionIds`.
2. REWRITE the two sibling whole-object `toEqual` tests, which must change because a new defined key
   on the received object makes `toEqual` fail:
   `it("groups a space with a live session and a stored session")` and
   `it("returns an empty shape for a space with no sessions")` (expects `sessionIds: []`). For the
   first, give the fixture an order map that puts the LIVE row AFTER the stored one
   (`{ "live-alpha": 5, "stored-alpha": 2 }`) and expect `sessionIds: ["stored-alpha", "live-alpha"]`.
   **This is the reversal showing up in a test that already existed:** the first draft of this plan
   expected `["live-alpha", "stored-alpha"]` here, which is the live-block-first answer the spec
   rejects. `lastReason` stays `"user"` (the live row is still preferred as the Landing Session —
   Done-when #5 — and that preference is orthogonal to where the row RENDERS).
3. **THE test the reversal exists for** —
   `it("a Session RESUMED this boot keeps the MIDDLE slot the database holds for it (one sequence spans live and stored)")`:
   `/w/alpha` holds three stored rows in manual order `stored_top` (order 0), `resumed` (order 1),
   `stored_bottom` (order 2); `resumed` has just become LIVE (the fixture calls the real
   `useSessions.getState().resumeSession(...)` with the boot-shaped state, or — if the IPC mocking in
   this file makes that unreadable — constructs the post-resume state directly: `sessions: [resumed]`,
   `historySessions: [stored_top, stored_bottom]`, `sessionOrder: { stored_top: 0, resumed: 1,
   stored_bottom: 2 }`; **prefer the real action, and say which you used**). Expect
   `view.sessionIds` to equal `["stored_top", "resumed", "stored_bottom"]`.

   **The fixture is built so "live block first" and "one DB order" give DIFFERENT answers**: the live
   block rule answers `["resumed", "stored_top", "stored_bottom"]`, so this test cannot pass by
   accident and cannot be satisfied by the old two-arm concatenation. That single assertion is the
   provable fix for the user's complaint — a row the user positioned does not move when the session is
   resumed, which is the exact symptom the spec's Section 2 names as "only half fixed".
4. `it("a live row whose id the order map does not know joins at the BOTTOM of the sequence")` —
   one stored row (`order 0`) plus a live `fresh` row with **no** entry in `sessionOrder` (a Session
   started after the boot fetch). Expect `["stored_row", "fresh"]`. This pins the approved "new rows
   join at the bottom" rule inside the merge, so the bottom-sink is not accidentally implemented as a
   top-promotion (which is what defaulting an unknown to `0` would do — see Task 1 test 7).
5. `it("archivedInSpace sorts by recency and NOT by input order")` — the Archived test the spec
   demands (#12). Two archived rows of `/w/alpha`, `a_old` FIRST and `a_new` LAST in `archivedSessions`
   (input order = today's manual order), with `{ recency: { a_old: 1_000, a_new: 9_000_000_000_000 } }`.
   `expect(archivedInSpace("/w/alpha", [a_old, a_new], [], evidence).map((r) => r.sessionId))` is
   `["a_new", "a_old"]`. **Reversing the fixture's recency values makes it red, so it cannot pass by
   accident.**
6. `it("archivedInSpace drops the sticky live ids and another Space's rows")` — a live row whose id is
   also in `archivedSessions` is excluded (CONTEXT.md's "Archived session": a resumed archived Session
   renders in its Space group), a row of `/w/beta` is excluded, and `spacePath: null` answers `[]`
   (today's documented empty-state behaviour, which must not silently change).
7. REWRITE `it("reports archivedSessionIds without polluting storedSessionIds, and lastReason falls back to the archived head")`
   → `it("reports archivedSessionIds without polluting sessionIds, and lastReason falls back to the most recent archived Session")`.
   Keep every assertion, retarget `view.storedSessionIds` → `view.sessionIds`, and keep the
   "live wins" and "archived-only Space still gets a reason" halves. (Pass an EMPTY order map, which
   keeps this fixture's live-before-stored sequence — see the safety property below.)
8. `it("spaceViewFor reads lastReason off the max-recency stored Session, not the head")` —
   `/w/alpha` with NO live session and two stored rows, `stored_first` FIRST in `historySessions` with
   reason `"error"` and low recency, `stored_last` LAST with reason `"user"` and the far-future stamp.
   Expect `view.lastReason` to be `"user"`. Today's rule returns the head → `"error"` → red.
9. `it("spaceViewFor falls back to the most recent ARCHIVED Session only when the Space has no stored one")`
   — with one stored row (recency 1_000, reason `"error"`) and one archived row (recency
   9_000_000_000_000, reason `"agent-exited"`), `lastReason` is `"error"`: the STORED arm wins even
   though the archived row is more recent (Decision D5 — "last resort", not "max over both"). Then
   drop the stored row and assert `"agent-exited"`.

**Red:** `npx vitest run src/store/sessions.test.ts` → **9 failures**. Tests 1–4 and 7 fail as clean
assertions (`view.sessionIds` is `undefined`); 5–6 fail as `archivedInSpace is not a function`; 8–9
fail as assertions on `lastReason` (`"error"` where `"user"` is required). Quote the assertion text.
Test 3's red is the headline: it is the one that says a resumed row lost its slot.

**Mechanical, in the same commit:** `spaceViewFor(` has **10** call sites in
`src/store/sessions.test.ts` (7 in the `spaceViewFor (per-space grouping, pure)` describe, 2 in
`spaceViewFor — archivedSessionIds`, 1 in `views (store integration for space views)`) and each gains
**two** arguments: the 6th (`evidence: RecencyEvidence`) and the 7th (`orderMap: Record<string, number>`
— Decision D14 says why it is a parameter and not a field of the bag). Define ONE file-local helper next
to the existing `info`/`row` factories and use it everywhere, so no call site hand-rolls an evidence bag:

```ts
/** The recency evidence bag (ADR 0075). Empty by default: these fixtures are about
 *  membership and live order, and an empty map makes every id equally unevidenced,
 *  which is what the pre-T03 assertions were written against. */
const recencyEvidence = (
  recency: Record<string, number> = {},
  messages?: Record<string, Message[] | undefined>,
): RecencyEvidence => ({ recency, ...(messages ? { messages } : {}) });

/** The boot order map. EMPTY by default, and that default is load-bearing, not lazy:
 *  with no entries every id is unknown, every id ties, and `sortByManualOrder` falls
 *  through to input order — i.e. `[...live, ...stored]`, byte-for-byte the pre-T03
 *  sequence. A pre-existing fixture that did not care about order keeps its expected
 *  answer for the right reason. */
const noOrder = (): Record<string, number> => ({});
```

Tests 5–7 pass `noOrder()`; test 1 passes the agreeing map its text names (`{ idX: 0, idY: 1 }`, so
"no re-sort" is proven without also testing the merge); tests 2, 3 and 4 pass the explicit maps their
sequences are about; test 8
passes `recencyEvidence({ stored_first: 1_000, stored_last: 9_000_000_000_000 })`; test 9 passes the
two-value map it needs. `RecencyEvidence` joins
the file's existing `import type { … } from "../lib/tauri"` neighbourhood as
`import type { RecencyEvidence } from "../lib/sessionRecency";`.

**The safety property worth naming in the commit message:** with an EMPTY order map and an EMPTY
recency map, `sessionIds` is byte-for-byte the old `[...liveSessionIds, ...storedSessionIds]`. That is
why `SpacesList.test.tsx` can stay 79/79 untouched (its boot mock resolves `sessionRecency()` to `[]`,
so the store's order map is `{}` and every fixture keeps live-before-stored), and it is the reason the
behavioural risk of this reversal is confined to the fixtures that deliberately seed the map.

**Implementation** — `src/store/sessions.ts`:

Imports gain `import { mostRecentByRecency, sortByManualOrder, sortByRecency, type RecencyEvidence } from "../lib/sessionRecency";`
(no cycle: `lib/sessionRecency` imports only `lib/sessionTypes`).

`SpaceView` — replace the two id lists' block with the single order, KEEPING both old fields, and fix
the two docs that lean on recency (`archivedSessionIds`'s doc gains one line: its own order comes from
`archivedInSpace`, not from this field; `lastReason`'s doc stops saying "the head of the stored
subsequence"):

```ts
export interface SpaceView {
  path: string;
  /** Display label (base name; `""` if the base name is empty — the UI falls back to `path`). */
  title: string;
  /**
   * THE one order this Space's sidebar rows render (ADR 0075): ONE sequence
   * spanning live and stored, no group headers, no re-sorting by anything the
   * user did not do. Built from the two lists below plus the boot order map by
   * ONE function (`mergeSessionOrder`) so the rows and the collapsed rail cannot
   * disagree, and so a row keeps its slot whether its Worker is live, stored,
   * or has just been resumed.
   * Position here means position, nothing more — recency is `lib/sessionRecency`.
   */
  sessionIds: string[];
  /** DEPRECATED — one INPUT to `sessionIds`; T04 deletes it and renders `sessionIds`. */
  liveSessionIds: string[];
  /** The most recent live session in this space, or `null` (the tab's live dot). */
  liveSessionId: string | null;
  /** DEPRECATED — the other INPUT to `sessionIds`, in the server's manual order; T04 deletes it. */
  storedSessionIds: string[];
  // …`archivedSessionIds`, `trusted` and `lastReason` keep their names and types
  //    unchanged (this is an ILLUSTRATIVE block, not paste-able code: the first
  //    three fields above are the only ones the block shows in full)…
}
```

One new exported function, placed immediately above `spaceViewFor` (it is exported, not inlined, so
Task 3's tests can drive it directly and so T05's optimistic reorder has the same merge to reuse
rather than a second copy):

```ts
/**
 * THE one sequence a **Space**'s sidebar rows render: live and stored rows
 * interleaved by their stored order numbers, ONE sequence with no group
 * boundary (ADR 0075; the spec's Section 2 — the live-before-stored split has
 * no headers, so keeping it was an invisible rule that made a dragged row jump
 * when its Session closed or resumed, i.e. "stop them moving around" half-fixed).
 *
 * A row the order map does not know — a Session started after the boot fetch —
 * goes at the BOTTOM, which is the spec's "new rows join at the bottom" rule
 * restated for a client that has not written the row's number yet.
 *
 * With an EMPTY map every id is unknown, every id ties, and the answer is
 * `[...liveSessionIds, ...storedSessionIds]`: the pre-T03 sequence. That is not
 * a fallback path, it is stability under no information, and it is what keeps
 * every pre-existing fixture's expected order honest.
 */
export function mergeSessionOrder(
  liveSessionIds: readonly string[],
  storedSessionIds: readonly string[],
  orderMap: Record<string, number>,
): string[] {
  // ONE union, ONE sort. A live id is never in `storedSessionIds` (both
  // `addSession` and `resumeSession` filter it out of the stored arm when they
  // add it to the live one), so the concatenation cannot double-count a row.
  return sortByManualOrder([...liveSessionIds, ...storedSessionIds], orderMap);
}
```

`spaceViewFor` gains a REQUIRED 6th parameter (the evidence bag) and a REQUIRED 7th (the order map —
Decision D14), and the recency-based `landingId`:

```ts
export function spaceViewFor(
  space: SpaceRow,
  sessions: SessionInfo[],
  historySessions: SessionInfo[],
  closeReasons: Record<string, CloseReasonStr>,
  archivedSessions: SessionInfo[],
  evidence: RecencyEvidence,
  orderMap: Record<string, number>,
): SpaceView {
  const liveSessionIds = liveSessionsInSpace(sessions, space.path);
  const liveSessionId = liveSessionIds[0] ?? null;
  // Store input order = the server's MANUAL ORDER. NOT re-sorted, and NOT
  // evidence of anything (ADR 0075; the ordering note above says why). The
  // order MAP is what lets a live row rejoin this sequence by position.
  const storedSessionIds = historySessions
    .filter((s) => s.cwd === space.path)
    .map((s) => s.sessionId);
  const archivedSessionIds = archivedSessions
    .filter((s) => s.cwd === space.path)
    .map((s) => s.sessionId);
  // The session the user would LAND on for this Space: a live one first (a
  // Space holding a Worker mid-turn shows that turn), else the most RECENT
  // stored Session by `recencyOf` — NOT the head of the stored subsequence,
  // which since ADR 0075 is merely the first row of a manual arrangement —
  // else the most recent archived one as a last resort (the close-reason banner
  // must not silently vanish for an archived-only Space). Note this ordering
  // PREFERENCE is orthogonal to `sessionIds`: which row a tab opens and where
  // the row RENDERs are different questions with different rules.
  const landingId =
    liveSessionId ??
    mostRecentByRecency(storedSessionIds, evidence) ??
    mostRecentByRecency(archivedSessionIds, evidence);
  return {
    path: space.path,
    title: basenameOfPath(space.path),
    sessionIds: mergeSessionOrder(liveSessionIds, storedSessionIds, orderMap),
    liveSessionIds,
    liveSessionId,
    storedSessionIds,
    archivedSessionIds,
    trusted: space.trusted,
    lastReason: landingId === undefined ? undefined : closeReasons[landingId],
  };
}
```

(The local was `newestId`; it becomes `landingId` because "newest" is precisely the word that meant
"head of the list" here. CONTEXT.md's **Landing Session** entry is the vocabulary it now matches.)

**`handleSessionClosed` is deliberately NOT touched, and after the reversal that is a claim with teeth
rather than an omission.** The spec says it "needs no change": it appends the closed id to the TAIL of
`historySessions`, which is the exact thing `sortByActivity`'s `unknowns: "last"` placement existed to
paper over (`SpacesList.test.tsx`'s `"sorts a session that CLOSED this boot to the top of the stored
group"`). Under `mergeSessionOrder` the append's position in the ARRAY no longer decides where the row
renders — the row's ORDER NUMBER does, and a row that was live at boot already has that number in the
boot map (a live Session has a `sessions` row, which is why `Db::session_recency` covers it), so close
leaves the slot untouched. The one case that does land at the bottom is a Session STARTED this boot,
which has no number yet — and bottom is the approved rule for a new row, not an accident. Task 3 test 3
proves the keep-its-slot half; nothing needs to be written to fix the close case beyond deleting the
sort that hid it (T04's deletion).

New export, immediately after `spaceViewFor` and before `detachedSessions` — the Archived section's
explicit sort, i.e. the function T04's `ArchivedSection` will call (T03 owns the derivation layer; the
component is T04's):

```ts
/**
 * The **Archived** section's rows for one **Space**, in EXPLICIT recency order.
 *
 * This is the list ADR 0075 calls the trap: it used to render `archived.filter(…)`
 * in input order and INHERIT recency for free from `list_sessions`. That query
 * now returns the manual order, so the same filter would present a manual
 * arrangement under a recency heading — and pass every pre-existing test while
 * doing it. So the sort is said out loud, here, by the one function the section
 * calls.
 *
 * The two filters are the section's existing ones and are load-bearing: the
 * sticky live ids are excluded (a resumed archived Session renders in its Space
 * group — CONTEXT.md "Archived session"), and rows of another Space are
 * excluded (a row whose Space has no tab is **Detached** and belongs to
 * Settings, not here). `spacePath === null` matches nothing, so the section's
 * "No archived sessions." empty state with no Space selected is preserved.
 *
 * Returns ROWS, not ids, mirroring `detachedSessions`: the section renders
 * `title`/`cwd` straight off them.
 */
export function archivedInSpace(
  spacePath: string | null,
  archivedSessions: SessionInfo[],
  liveSessions: SessionInfo[],
  evidence: RecencyEvidence,
): SessionInfo[] {
  const liveIds = new Set(liveSessions.map((s) => s.sessionId));
  const visible = archivedSessions.filter(
    (s) => s.cwd === spacePath && !liveIds.has(s.sessionId),
  );
  const byId = new Map(visible.map((s) => [s.sessionId, s]));
  // The `!` is safe by construction — every id came out of `visible` — and the
  // store already uses this idiom (`bySession.get(sessionId)!` in
  // `applySessionUpdates`). `Map.get` cannot be narrowed any cheaper here.
  return sortByRecency(
    visible.map((s) => s.sessionId),
    evidence,
  ).map((id) => byId.get(id)!);
}
```

**The mechanical `src/components/SpacesList.tsx` lines** (granted overlap #1 — nothing else in the
file, and nothing here is behaviour: no memo deleted, no `sortByActivity` touched, no `railIds` touched,
no JSX). Add TWO selectors beside the existing `closeReasons` selector:

```tsx
  const sessionRecency = useSessions((s) => s.sessionRecency);
  // The boot order map (ADR 0075): the ONLY thing that lets a LIVE row keep its
  // slot. Read here because `spaceViewFor` needs it as an argument — the pane
  // does not otherwise care about position, and T04 renders `sessionIds`
  // straight through.
  const sessionOrder = useSessions((s) => s.sessionOrder);
```

and replace the memo body + dep array with:

```tsx
      spaces.map((s) =>
        // `{ recency }` only, on purpose: subscribing this pane to `messages`
        // would re-render the whole list on every streamed token — the exact
        // hazard `activityKeyOf` exists to dodge. The boot recency map is the
        // same SQL expression, so the close-reason banner's Landing Session is
        // decided on the same number, just read at boot.
        spaceViewFor(s, sessions, historySessions, closeReasons, archivedSessions, {
          recency: sessionRecency,
        }, sessionOrder),
      ),
    [spaces, sessions, historySessions, closeReasons, archivedSessions, sessionRecency, sessionOrder],
```

**Green:** `npx vitest run src/store/sessions.test.ts` (172 → 178; 6 new `it(...)`, 3 rewrites move no count) ·
`npx vitest run src/components/SpacesList.test.tsx` (**79, unchanged** — the pane still renders the
pair, and its boot mock leaves the order map empty, so every fixture keeps its old sequence; a movement
here means the call-site-only rule was broken) ·
`npx vitest run src/components/SpaceTabs.test.tsx src/components/settings/SessionsSection.test.tsx`
(unchanged — `SpaceTabs` never reads `SpaceView`, and `detachedSessions`' signature is untouched) ·
`pnpm build`.

**Commit:** `feat(store): one SpaceView.sessionIds spanning live and stored; recency decides lastReason`

---

## Task 4 — the three Landing Session sites stop reading position

**Files owned:** `src/store/sessions.ts` (`autoSelectActive`, `setSpaces`, `selectSpace`, `removeSpace`
comment, the `selectSpace`/`setSpaces`/`removeSpace`/`closeSpace` interface docs),
`src/store/sessions.test.ts`.

**Write the failing tests FIRST** — `src/store/sessions.test.ts`, a new
`describe("Landing Session (ADR 0075: recency decides, position never does)")`:

1. `it("selectSpace lands on the most RECENT stored Session even when it sits LAST in the Space's manual order")`
   — `/b` holds `hist_first` (recency 1_000) then `hist_last` (recency 9_000_000_000_000) in
   `historySessions`, no live session; `selectSpace("/b")` → `activeSessionId === "hist_last"`. Today
   `historySessions.find(cwd === path)` answers `hist_first` → red.
2. `it("autoSelectActive lands on the most recent stored Session of the first Space in manual order, not its head")`
   — `autoSelectActive(spaces, [], stored, evidence)` where the FIRST Space's stored subsequence is
   `["head", "tail"]` and `tail` carries the far-future stamp → `"tail"`. (4th argument required —
   Decision D2.)
3. `it("a Session dragged to the BOTTOM of the manual order is still the Landing Session when it is the most recent")`
   — the spec's #9, at boot: `setSessionRecency([{ sessionId: "bottom", lastActiveAt: 9_000_000_000_000, sortOrder: 5 }])`,
   `setHistorySessions([top, bottom])` with `top` FIRST in the array, `setSpaces([space("/a")])` →
   `activeSessionId === "bottom"`. This is the store-level proof that position and recency are
   provably independent, and it is the one test in this plan that would have caught the original bug.
   **It is also now the test that proves the two maps do not contaminate each other:** `bottom` has the
   LARGEST order number (so it renders LAST) and the newest stamp (so boot lands on it). If a future
   edit made the Landing Session read the order map, this test goes red.
4. `it("removeSpace lands on the LEFTMOST remaining tab even when another Space holds the most recent Session")`
   — **the pin; the rule must NOT change.** Spaces `[space("/a"), space("/b")]`, `/a` selected, recency
   map says `/b`'s session is by far the newest; `removeSpace("/a")` resolves `"/b"` **because `/b` is
   now leftmost**, and the assertion text says so. Pair it with the existing
   `it("removing the active space falls back to the first remaining space (or null)")` — KEEP that one
   verbatim (it still pins the `null`-when-empty half); only its comment's "first remaining" phrasing
   is reworded in Task 5.
5. REWRITE `it("the first (most recent) space wins over a newer session in another")` →
   `it("the FIRST Space in manual order wins over a more recent session in a later Space")`. Same
   fixture and same expected id (`"head-1"`); the *reason* changes, and the fixture's comment ("we
   cannot check timestamps — `SessionInfo` has no `createdAt`") is now false and must go — the map is
   the timestamp. Give it an `evidence` whose recency favours the SECOND Space's row, so the assertion
   now proves the Space-level precedence rather than input order.
6. REWRITE `it("falls back to the head of the first space's stored subsequence")` →
   `it("a stored Session in the FIRST Space still beats a LIVE one in a later Space")`. This is the
   loop's subtle half, and after this change nothing else pins it: `autoSelectActive` walks Spaces
   first and only then arms, so the FIRST Space's stored arm wins over a later Space's live row. Same
   fixture (two rows in `/a/space-one`, no live), plus a live row in `/a/space-two` and an `evidence`
   that favours nothing in Space one — the answer stays `"newest-1"`. Test 2 owns "max recency inside
   one Space"; this owns "Space precedence outranks the live/stored preference".
7. REWRITE `it("selectSpace: live session preferred, then the newest stored, then nothing")` →
   `it("selectSpace: live session preferred, then the most RECENT stored, then nothing")`. Same three
   acts; the middle act's fixture gains a second stored row so "most recent" is distinguishable from
   "first".
8. KEEP, with only the new argument threaded into the calls (their premises are untouched):
   `it("autoSelectActive prefers the most-recently-started live session in the space (the one-live cap lift)")`,
   `it("returns null when there is nothing at all")`, `it("prefers the first space's live session")`,
   `it("skips a space with no sessions and advances to the next")`,
   `it("returns session IDs for matching cwd in reverse insertion order (newest first)")` and
   `it("mostRecentLiveInSpace returns the newest session ID or null")` (both `liveSessionsInSpace`
   tests — the function is KEPT and still reverse-insertion-order, because "most recently STARTED" is
   a different fact from recency and feeds the live dot).
9. KEEP `it("keeps input order: stored rows first, then archived, neither re-sorted")` (`detachedSessions`)
   — the assertion is unchanged; only its comment is rewritten in Task 5 (Decision D7).
10. KEEP `it("closing the SELECTED tab lands on the next Space's session (the same rule a tab click uses)")`
    — it exercises `removeSpace` → `selectSpace` and both arms still behave identically here.

**Red:** `npx vitest run src/store/sessions.test.ts` → tests 1–3 and 5–7 fail as assertions (each
names the head-of-list id it got where the recency id was required); test 4 PASSES — it is a pin, and
a pin that passes before the change is the point. Quote test 1's diff as the headline red.

**Mechanical, in the same commit:** `autoSelectActive(` has **7** call sites in
`src/store/sessions.test.ts` (1 in `spaceViewFor (per-space grouping, pure)`, 6 in
`autoSelectActive (boot auto-select, pure)`) and each gains the 4th argument via the same
`recencyEvidence(…)` helper Task 3 added. **`autoSelectActive` does NOT take the order map** — it
decides which Session to OPEN, not where a row renders, so threading `sessionOrder` in here would be
exactly the "position is evidence" confusion ADR 0075 exists to kill; Task 4 test 3 is the pin that
keeps it that way. Tests 5–7 of THIS task pass a non-empty recency map; the six
pre-existing calls pass `recencyEvidence()` — an empty map makes every id equally unevidenced, ties
fall through to input order, and each keeps its current expected id for the right reason now. That
degradation is the safety property worth naming in the commit message: **with an empty map the new
rule is byte-for-byte the old rule**, which is also why `SpacesList.test.tsx` can stay 79/79.

**Implementation** — `src/store/sessions.ts`:

```ts
export function autoSelectActive(
  spaces: SpaceRow[],
  sessions: SessionInfo[],
  historySessions: SessionInfo[],
  evidence: RecencyEvidence,
): string | null {
  // Spaces are in the user's MANUAL ORDER, so the FIRST Space that owns any
  // session is the leftmost tab with something to show — that is the meaning
  // boot wants, and it is unchanged. What changed is the WITHIN-Space choice:
  // the most RECENT stored Session by `recencyOf`, not the head of the
  // subsequence (ADR 0075).
  for (const space of spaces) {
    const live = mostRecentLiveInSpace(sessions, space.path);
    if (live) return live;
    const stored = historySessions
      .filter((s) => s.cwd === space.path)
      .map((s) => s.sessionId);
    const recent = mostRecentByRecency(stored, evidence);
    if (recent !== null) return recent;
  }
  return null;
}
```

`setSpaces`: `autoSelectActive(rows, state.sessions, state.historySessions, { recency: state.sessionRecency, messages: state.messages })`.
`selectSpace`: replace
`const stored = state.historySessions.find((s) => s.cwd === path)?.sessionId ?? null;` with

```ts
    const evidence: RecencyEvidence = {
      recency: state.sessionRecency,
      messages: state.messages,
    };
    const stored = mostRecentByRecency(
      state.historySessions.filter((s) => s.cwd === path).map((s) => s.sessionId),
      evidence,
    );
```

`removeSpace`'s `fallback = wasSelected ? (remaining[0]?.path ?? null) : null` is **UNCHANGED** — only
its inline comment changes from "input order — `lastOpenedAt` desc" to "the LEFTMOST remaining tab:
since ADR 0075 the first row is the user's left-most tab, which is what a neighbour tab means."
Both store actions DO pass `messages` — they read the store imperatively inside an action, so there is
no subscription and therefore none of the re-render cost that keeps it out of `SpacesList.tsx`.

**Green:** `npx vitest run src/store/sessions.test.ts` (178 → 182; 4 new `it(...)`, 3 rewrites + 3 keeps move no count) ·
`npx vitest run src/App.test.tsx src/components/SpacesList.test.tsx` (41 + 79) · `pnpm build`.

**Commit:** `fix(store): the Landing Session is max recency, never the head of a manual list`

---

## Task 5 — rewrite the Ordering note and discharge T01's exemption (docs only)

**Files owned:** `src/store/sessions.ts` (comments/doc blocks ONLY — zero behaviour).

Rewrites, each one a replacement of a sentence that is now FALSE:

1. **The standing "Ordering note"** above `liveSessionsInSpace` — the block ADR 0075 names as the
   origin of the bug, and entry 1 of T01's exemption. It quotes both old SQL statements verbatim and
   concludes "input order IS the order — `spaces[0]` is the most recently opened space". **Rewrite,
   do not delete:** the "do NOT re-sort" rule is still true and must stay documented — it is now true
   for a *better* reason. The replacement says: both read queries return the **Manual order**, so input
   order IS the display order and the store still never re-sorts; position carries NO evidence and is
   not a proxy for recency (ADR 0075); recency is a FIELD the store holds (`sessionRecency`) and a rule
   `lib/sessionRecency` owns; **so is position** (`sessionOrder`, merged into one sequence by
   `mergeSessionOrder`) — the note must state that a Space's rows are ONE sequence spanning live and
   stored, because that is the sentence a future reader needs in order not to reintroduce the live
   block; `spaces[0]` is the LEFTMOST tab, not the most recently opened one; and the parenthetical about
   the sidebar re-sorting via `lib/sessionActivity` is deleted (T04 removes that module; T03 leaves it
   running, so the note must not describe it as gone — the sentence becomes a pointer to T04's deletion
   rather than a present-tense claim… resolved by naming the module only in the DEPRECATED docs on
   `storedSessionIds`, which is where a reader looking for it will be).

   Naming in this note is now governed by the REVISED token rule, not the old one: the note MAY say
   "the stored order number" and may name `sessionOrder`/`mergeSessionOrder` (both are frontend
   symbols, and the note is where a reader looks for the ordering rules); it must NOT spell the
   snake_case column name, because `src/` does not quote SQL.
2. `spaceViewFor`'s `// Input order = newest-first from list_sessions; NOT re-sorted.` — already
   replaced in Task 3 (T01's entry 3); verify it is gone, not merely reworded into a synonym.
3. `SpaceView.storedSessionIds`'s "in `list_sessions` order (most recently ACTIVE first …)" — already
   replaced in Task 3 (T01's entry 2); verify.
4. `detachedSessions`'s order paragraph ("`historySessions` first (stored rows in `list_sessions`
   order, most-recently-ACTIVE first)… `sortByActivity` needs loaded transcripts… `SessionInfo` carries
   no `createdAt`") → the honest version: the order is the store's input order, i.e. the **Manual
   order**, and that is deliberate — Settings → Detached sessions is a management list, not a recency
   list (spec §4), so it inherits the new order with no code change.
5. `setSpaces`'s interface doc "from `list_spaces`, `lastOpenedAt`-desc" and "(the FIRST row —
   `list_spaces` order is `lastOpenedAt` desc)" → "the MANUAL ORDER" / "the leftmost tab".
6. `selectSpace`'s interface doc "then the newest stored (input order — do NOT re-sort)" → "then the
   most RECENT stored (`recencyOf`), which is not necessarily the first".
7. `closeSpace`'s doc "(live first, else newest stored)" → name recency, and note the fallback path
   means the leftmost tab.
8. The three remaining `newest-first` phrases that describe **live reverse-insertion order** — on
   `liveSessionsInSpace` (two) and `SpaceView.liveSessionIds` (one) — are reworded to "most recently
   STARTED first". They are technically correct today (they never meant recency) but they are what
   makes T01's grep gate unusable, and "started", not "newest", is the word the code means.

Coverage check for the second grep: the six `lastOpenedAt`-phrase hits at `dc3c050` are the ordering
note's three (item 1), `setSpaces`'s interface doc + its inline twin (item 5), and `removeSpace`'s
inline comment — **the last one is already gone, Task 4 rewrote it**, so this task's before-count is
**5**, not 6. If a count of 6 appears here, Task 4's comment edit did not land: stop and fix Task 4
rather than rewording it twice.

**Red:** none — this is a comment-only commit and a red is not available. The gate is the grep, and it
is a RED FLAG check rather than a test: run both BEFORE the edit, quote the hits, and require 0 after.

**Green / proof** (measured at `dc3c050` — the `lastOpenedAt` pattern needs the bounded gap, because
the store writes the phrase as `` `lastOpenedAt`-desc `` with a backtick in the middle and a literal
`lastOpenedAt desc` matches none of the six sites):

    grep -rn "recent-first\|recently ACTIVE first\|newest-first" src/store/sessions.ts        # 5 hits → 0
    grep -rn "lastOpenedAt.\{0,3\}desc\|last_opened_at DESC\|most recently opened" src/store/sessions.ts
                                                             # 6 at dc3c050 → 0 (5 by Task 5's turn — Task 4 took one)
    grep -rn "sort_order" src/                               # STILL 0 — the SQL column name never enters src/
    grep -rn "sortOrder" src/components/                     # 0 — no component may read the number (the retired proof's surviving half)
    grep -rln "sortOrder" src/ src-tauri/src                # ONLY the Done-when #9 allow-list
    pnpm test          # count unchanged from Task 4
    pnpm build         # green — a stale doc comment is not a compile error, which is why the grep is the gate

**Commit:** `docs(store): rewrite the ordering note ADR 0075 blames, and the stale order comments`

---

## Decisions this plan makes

- **D1 — `recencyOf(sessionId, loadedMessages, recencyMap)` keeps the spec's exact three-argument
  shape**, and the two maps travel together in one `RecencyEvidence` bag at the call sites. The spec
  names the rule in that shape; the bag exists so `autoSelectActive` grows by ONE parameter (4) instead
  of two. `spaceViewFor` grows by TWO (6 and 7) — see D14 for why the order map is not a third bag
  member.
- **D2 — the derivation functions take the MAPS, not a pre-resolved accessor or a precomputed stamp
  map.** A resolved `Record<string, number>` would move the "prefer the transcript" decision to the
  call site, which is the one thing this module exists to prevent; and the store already ships maps
  to pure functions (`closeReasons` into `spaceViewFor`), so the shape has a neighbour.
- **D3 — `RecencyEvidence.messages` is OPTIONAL.** A component that subscribes to the whole `messages`
  map re-renders on every streamed token — the exact hazard `activityKeyOf` was engineered around — so
  `SpacesList` passes `{ recency }` only, while the store's own actions (which read state
  imperatively, no subscription) pass both. Cost: `lastReason`'s Landing Session is decided on the
  boot map rather than the live transcript at that one call site — the same SQL expression, read at
  boot. Recorded under Known limits.
- **D4 — `SpaceView` ADDS `sessionIds` and KEEPS the pair, DEPRECATED, for one task.** `sessionIds` is
  `mergeSessionOrder(liveSessionIds, storedSessionIds, sessionOrder)` — one function over the two kept
  fields plus the boot order map — so the three fields cannot disagree, `SpacesList.test.tsx`
  stays 79/79 untouched, and T04's diff stays inside its own file: render `sessionIds`, delete the
  pair. The alternative — deleting the pair in T03 — forces T03 to rewrite T04's `viewIds`/`liveIds`/
  `storedIds`/`railIds`/two row lists, i.e. a component rewrite in another task's seam. (The first
  draft of this decision said `sessionIds` was the concatenation; after the D11 reversal it is the
  merge, which is why the pair is an INPUT to it rather than its definition.)
- **D5 — `lastReason`'s archived arm stays a LAST RESORT, not a max over stored ∪ archived.** Spec
  §4 calls `archivedSessionIds[0]` "a last-resort landing candidate", and today's
  `it("reports archivedSessionIds … lastReason falls back to the archived head")` depends on stored
  beating archived. So: `live ?? maxRecency(stored) ?? maxRecency(archived)`.
- **D6 — `selectSpace`'s stored arm remains STORED-only (no archived fallback).** Today's
  `historySessions.find(...)` lands an archived-only Space on nothing, and T03's charge is "recency
  decides only the stored arm". Widening it would change boot/tab-click behaviour for archived-only
  Spaces with no mandate; `lastReason`'s archived arm is a different question (what banner to show),
  not a landing mandate. Recorded as an asymmetry, not a bug.
- **D7 — `detachedSessions` gets NO explicit sort.** Settings → Detached sessions is a management list
  and the spec says inheriting the new order is fine. Its doc is rewritten so it no longer claims the
  order is recency — which is what actually made this a decision rather than an omission.
- **D8 — `archivedInSpace` returns ROWS, not ids**, mirroring `detachedSessions` ("the Settings
  section renders cwd/title straight off them"): T04's `ArchivedSessionRow` takes a `SessionInfo`, so
  returning ids would make it re-look-up every row and re-create the three-list walk.
- **D9 — `lastActivityOf` is NOT re-exported from `sessionRecency.ts`.** The spec says it "moves"
  there; a two-line inline read of the last message inside `recencyOf` is the move, and shipping a
  second name for the same walk is how two owners appear. `sessionActivity.ts` keeps its own copy
  until T04 deletes the file.
- **D10 — `newestId` stays on `SpaceView` as `lastReason` and is NOT moved out.** It is already there,
  already tested, and moving it is a component-facing redesign T03 has no mandate for; renaming the
  local to `landingId` carries the vocabulary change.
- **D11 — REVERSED by the orchestrator, and the reversal is implemented.** The first draft of this
  decision accepted the live-before-stored split inside `sessionIds` as a limitation, on the premise
  that "a live row's stored number never crosses the wire (T02's proof), so the frontend cannot
  interleave". **Both halves of that were wrong.** The premise was false: `SessionRecency` is built at
  exactly two sites, both in `db.rs`, precisely because the spec amendment refused to touch
  `SessionInfo` (40 construction sites, the struct ADR 0064 protects) — so adding one field was
  never going to be the expensive move the draft assumed, and `Db::session_recency`'s SQL already
  reads every non-subagent row including archived ones, so a resumed/live Session's own row is already
  in the result set. And the consequence was unacceptable: the approved spec says **"ONE order per
  Space, spanning live and stored"**, and gives as its reason that keeping the split means "a manual
  drag can't cross the invisible boundary — so 'stop them moving around' is only half fixed." A row
  that moves within a boot and settles at the next restart IS the user's reported symptom. Accepting
  it as a known limit was the plan limiting the spec.

  The shape now: Task 2 puts the stored order number on the `SessionRecency` payload (two Rust sites +
  one wire-key literal + one TS field) and the store keeps it as `sessionOrder`; Task 3's
  `mergeSessionOrder` produces the ONE sequence, with unknown ids at the bottom (the approved
  "new rows join at the bottom" rule, so no new decision is needed for the fresh-session case); and a
  resumed Session keeps its slot, pinned by
  `it("a Session RESUMED this boot keeps the MIDDLE slot the database holds for it (one sequence spans live and stored)")`.
  **What T05 still owns** is the *write* side: the optimistic reorder action must update `sessionOrder`
  locally when it writes, or a drag will not stick until the next boot. That is a genuine remaining
  dependency, and it is T05's seam by the status file's own row — not a limitation of this design.
- **D11a — the merge is a SORT over a union, not a splice of two arms.** An earlier alternative kept
  the live arm at the front and spliced resumed rows back into their old indices. It is rejected: it
  needs a second notion of "which rows were live last time", and it cannot express a live row that was
  never stored at all. One union + one stable ascending sort by the number is total, and with an empty
  map it degrades to exactly the old concatenation.
- **D12 — the "sixteen data fields" prose in five test files is NOT corrected.** T03 makes the store
  EIGHTEEN (`sessionRecency` + `sessionOrder`); `src/test/resetStores.ts`, `ChatStream.test.tsx`,
  `SpaceTabs.pill.test.tsx`,
  `SpaceTabs.test.tsx` and `SpacesList.test.tsx` each say sixteen in a comment. Out of seam, prose
  only, and `resetStores.ts`'s own discipline is that the field list lives in `getInitialState()` and
  nowhere else — same reasoning T02 recorded for `tauriBarrel.test.ts`'s stale count.
- **D13 — `setSessionRecency` REPLACES both maps on every write**, deviating from the write half of the
  `closeReasons` precedent the brief names (that one is merge-only: "a reason outlives its event, so
  keys are never deleted"). Reason: the command answers "every non-subagent session as of now", so a
  merged map would let a deleted session's recency outlive its row and keep winning
  `mostRecentByRecency` for a Space that no longer has it — and, after the reversal, the same leak
  would keep an orphaned id occupying a POSITION in `sessionOrder`, which is worse because it silently
  shifts nothing but is invisible. `setHistorySessions` — the other boot
  snapshot setter, and the nearer analogue for a snapshot — also replaces. Because
  `setSessionRecency` is boot-only the two choices are indistinguishable today; the difference is what
  a future second caller inherits, and "replace" is the one that cannot leak.
- **D14 — the order map is `spaceViewFor`'s 7th PARAMETER, not a third field of `RecencyEvidence`.**
  Tempting (it would keep the signature at 6) and wrong twice over. First, the bag's name and doc are
  about RECENCY, and `autoSelectActive`/`selectSpace` must not be handed a position at all — a value
  they could reach for is a value a future edit will reach for, which re-imports the exact confusion
  ADR 0075 exists to kill (Task 4 test 3 is the pin). Second, `sortByManualOrder` takes a bare
  `Record<string, number>`, and giving the bag an optional `order` field would make it look like
  evidence the recency rule may consult. Cost: `spaceViewFor` is now 7 positional parameters, which is
  ugly and is recorded below beside the 6-parameter limit it replaces.

## Out of scope

- **`src/components/SpacesList.tsx` — T04 (plus T06).** Except the granted mechanical lines (overlap
  #1: two selectors, the `spaceViewFor` call, the dep array — build-green only). T04
  deletes `sortByActivity`'s two memos, the `activityKey`/`activity` pair, `viewIds`, `liveIds`,
  `storedIds`, sets `railIds = sessionIds`, renders one list, deletes the pair off `SpaceView`'s
  consumer side, and rewords `it("keeps the rail's marks POSITIONALLY equal to the rows after the
  activity sort")`. **The contract T04 consumes:** `SpaceView.sessionIds: string[]` (**ONE sequence
  spanning live and stored** — no group headers, no live block to re-create),
  `mergeSessionOrder(liveSessionIds, storedSessionIds, orderMap)` (only if T04 needs the merge outside
  `spaceViewFor`; normally it does not — it renders `sessionIds`),
  `spaceViewFor(space, sessions, historySessions, closeReasons, archivedSessions, evidence:
  RecencyEvidence, orderMap: Record<string, number>)`, and `archivedInSpace(spacePath,
  archivedSessions, liveSessions, evidence): SessionInfo[]` — pass `{ recency }` from a component,
  `{ recency, messages }` from the store. **T04 must NOT reintroduce a live-first ordering**: the row's
  `SessionStatusMark` is where live-ness stays visible (spec §2).
- **`src/lib/sessionActivity.ts` — NOT deleted here, and its caller count after T03 is exactly ONE
  production importer: `src/components/SpacesList.tsx` (T04's file), plus its own test file (16
  tests).** So T04's deletion is still a REAL task, not a no-op: nothing in T03 stranded it into
  zero-caller state. T04 must still delete the module, its test, and the three ordering tests the
  spec names (`"orders the LIVE group by last activity, above the STORED group"`, `"ranks a live
  session by ITS ACTIVITY, not by which was started last"`, `"sorts a session that CLOSED this boot to
  the top of the stored group"`).
- **`src/components/SessionListRow.tsx` (T06), `src/components/SpaceTabs.tsx` (T07),
  `src/hooks/useDragReorder.ts` (T05), `src/components/settings/SessionsSection.tsx`** (it calls
  `detachedSessions` with 4 unchanged arguments — verified, no edit needed).
- **Rust beyond Task 2's two sites: none, and that is a scope claim, not a limitation.** T02 shipped
  all three commands and the TS wrappers; T03 consumes `sessionRecency()` only and adds ONE field to
  its payload struct. No command signature changes, nothing is added to `generate_handler!`, no
  capability entry moves, and `SessionInfo` / `SessionRow` / `SpaceRow` gain nothing.
  `reorderSessions`/`reorderSpaces` still have no caller until T05 — that is
  intentional and it is T05's seam, not a gap here.
- **No drag UI, no optimistic reorder action, no refetch-on-rejection.** T05. **Including the one thing
  the reversal hands forward:** after a drag, T05's optimistic action must write the new numbers into
  `sessionOrder` as well as calling `reorderSessions`, or a dragged row will not hold its position until
  the next boot. `mergeSessionOrder` is exported so T05 reuses that merge instead of writing a second
  one. This is a real dependency between the two tasks and is stated in T05's terms, not hidden as a
  limit of this one.
- **`docs/features/manual-list-order.md` — T08.** And `CONTEXT.md` already carries **Manual order**,
  **Landing Session** and the amended **Archived session** entry (verified — all three name
  `recencyOf`/`lastActiveAt` and the explicit Archived sort), so T03 has no glossary work left.
- **The snake_case column name `sort_order` never reaches `src/`**, in code or in a comment. What
  reaches it is the camelCase FIELD on the recency payload, and only the store reads it (Done-when #9).

## Verification

From repo root, after each task and in full at the end (`npx vitest run <path>` scopes;
`pnpm test -- <path>` does NOT — measured on this branch):

    npx vitest run src/lib/sessionRecency.test.ts            # 0 → 7 (new file: 5 recency + 2 order)
    npx vitest run src/store/sessions.test.ts                # 170 → 172 → 178 → 182
    npx vitest run src/App.test.tsx                          # 40 → 41
    npx vitest run src/components/SpacesList.test.tsx        # 79, UNCHANGED (the mechanical-lines rule)
    npx vitest run src/lib/tauri.test.ts                     # unchanged (the wrapper returns its payload untouched)
    npx vitest run src/components/SpaceTabs.test.tsx src/components/SpaceTabs.pill.test.tsx \
                 src/components/settings/SessionsSection.test.tsx src/test/fixtures.test.ts
                                                             # all unchanged
    npx vitest run src/lib/sessionActivity.test.ts           # 16, unchanged (T04 deletes it)
    pnpm test                                                # 3066 → 3086, 149 → 150 files
    pnpm build                                               # green (the tsc half is the SpaceView/param gate)

Scope proofs (repo root):

    git diff --name-only <T03-base>..HEAD | sort             # ONLY: src-tauri/src/commands/history.rs,
                                                             #   src-tauri/src/storage/db.rs,
                                                             #   src/App.tsx, src/App.test.tsx,
                                                             #   src/components/SpacesList.tsx,
                                                             #   src/lib/sessionRecency.ts,
                                                             #   src/lib/sessionRecency.test.ts,
                                                             #   src/lib/tauri/types.ts,
                                                             #   src/store/sessions.ts,
                                                             #   src/store/sessions.test.ts
    git diff --name-only <T03-base>..HEAD | grep '^src-tauri/'   # EXACTLY the two Rust files above
    git diff -U0 <T03-base>..HEAD -- src/components/SpacesList.tsx | grep -E '^[+-]' \
      | grep -v '^[+-][+-][+-]' | grep -vE '^[+-][[:space:]]*(//|\*)'
                                                             # 6 added / 2 removed CODE lines (see overlap #1)
    grep -rn "sort_order" src/ | wc -l                       # 0 — the SQL column name never enters src/
    grep -rn "sortOrder" src/components/ | wc -l             # 0 — the retired proof's surviving half
    grep -rln "sortOrder" src/ src-tauri/src                 # ONLY the Done-when #9 allow-list
    grep -rn "recent-first\|recently ACTIVE first\|newest-first" src/store/sessions.ts   # 0 (was 5)
    grep -n "export interface SpaceView" -A 40 src/store/sessions.ts   # sessionIds + liveSessionId present;
                                                             #   liveSessionIds/storedSessionIds DEPRECATED
    grep -rn "sortByActivity" src --include=*.tsx            # still exactly SpacesList.tsx — T04's job

From `src-tauri/` (the ONLY Rust the delta touches is Task 2's two files; the +1 test IS the proof the
change is as wide as it claims and no wider):

    cargo test --lib -- session_recency                      # 3 → 4 (2 in storage::db, 1 in commands::history)
    cargo test --lib -- storage::db                          # 41 → 42
    cargo test --lib -- commands::history                    # 3, UNCHANGED (the wire-key test is EDITED, not added)
    cargo test --test ipc                                    # 9, UNCHANGED (the harness asserts `session_recency`
                                                             #   returns an ARRAY on a fresh db — a third field on a
                                                             #   row cannot move it, and it has no rows to carry one)
    cargo test                                               # 1462 → 1463 passed / 0 failed
    cargo clippy --all-targets                               # 0 warnings
    cargo fmt --check

Registration/IPC is not re-checked here: T02 owns it and shipped it (`3c8238c`..`cc7ae06`). The command
name, its argument list and its handler registration are untouched by T03, so `tests/ipc.rs`'s
name-resolution pin needs no edit — verified against that file's assertions, which check the payload
shape (an array) and not its element fields.

## Known limits this plan accepts

- **A dragged row does not hold its new position until the next boot, because nothing writes
  `sessionOrder` mid-boot yet.** The order map is a BOOT SNAPSHOT (as `sessionRecency` is), and the
  write path — T05's optimistic reorder action — is T05's seam by the status file's own row. T03 hands
  it `mergeSessionOrder` (exported) and the map so the fix is a `set` on one field there, not a redesign
  here. Stated in T05's terms rather than as a defect of this task, but stated: between these two
  commits, a drag is derived correctly and written not at all.
- **A row the DB renumbers mid-boot is stale until restart** (the mirror of the limit above, and the
  same class as `sessionRecency`'s boot-only rule): a second Client, or a `record_session` on a row that
  collides, changes the number the boot map no longer reflects. `sessionRecency()` is re-fetched at boot
  only, deliberately — the alternative is a poll or an event, and neither is in scope or in the spec.
- **`lastReason` at the sidebar call site reads the boot map, not the live transcript (D3).** Chosen
  over subscribing the whole list to `messages` (a re-render per streamed token, in the file whose own
  header forbids it). The number is the same `LAST_ACTIVITY` expression, read at boot.
- **`SpaceView` carries three overlapping id lists for one task** (`sessionIds` plus the DEPRECATED
  pair). Deliberate collision-avoidance (D4); T04 removes the pair. A reader between the two commits
  may think there are two orders — the doc comments say there is one and name its inputs, and the pair
  are now labelled INPUTS rather than lists.
- **`setSessionRecency` is boot-only**, mirroring `setHistorySessions`'s documented boot-only rule.
  A session started after boot has no entry in EITHER map: `recencyOf` covers it from the loaded
  transcript (`addSession` gives `[]`, so a brand-new session is `null` and sorts last — which is right:
  it has no history to be recent about), and `mergeSessionOrder` puts it at the BOTTOM, which is the
  spec's own new-row rule rather than an accident of the sentinel. A session that CLOSED this boot is
  covered on both axes: `handleSessionClosed` keeps its transcript finalised in `messages`, so the
  store's actions (which pass `messages`) see a real stamp, and its order entry survived from boot —
  this is precisely the case `sortByActivity`'s `"last"` placement used to paper over, and after this
  task a closed row keeps its slot too.
- **`recencyOf` can return `null` for a real row**, and `sortByRecency` sinks nulls rather than
  inventing `0`. That is the old `unknowns: "last"` rule surviving; the difference is it is now one
  rule in one file instead of a parameter.
- **`spaceViewFor` now takes 7 positional parameters** (D14). Uglier than the 6 the first draft
  accepted, and the file's convention (positional) is why it stays that way rather than becoming an
  options object mid-chain. `SpacesList.tsx`'s memo is the only external caller. If a reviewer prefers
  an options object, that is a fine call to make — but it is a rename of eight call sites in someone
  else's file plus this one, and it is not free.
- **`App.test.tsx`'s boot mocks are a standing trap** (overlap #2): any future fourth boot fetch
  reddens ~40 tests in that file through a `.catch` that swallows the cause. The mock added here
  carries a comment saying so.
- **`App.test.tsx`'s nine hand-written `clearStores` helpers name neither new field.** Only the
  new describe does, so a map seeded by one boot test can survive into a later test in
  that file. It is inert there today — no existing case in that file reads either map, and every one of
  them boots with `sessionRecency: []`, so both maps are `{}` anyway — but it is the same leak class
  `src/test/resetStores.ts` exists to close, and this task declines that 9-describe refactor. Recorded
  for the follow-ups doc rather than left invisible.
- **Five test files still say the store has "sixteen data fields"** (D12; after this task it is
  eighteen).
- **`grep -rn "lastActiveAt" src/` gains store hits** (`src/store/sessions.ts`'s setter, the new test
  fixtures) on top of T02's two IPC files and the one stale prose line in `sessionActivity.ts` T04
  deletes. T02's Done-when #8 required "no store CONSUMER yet, by design (T03's)" — this plan is the
  design landing, not a regression against it. **`sortOrder` gains the same kind of hits, and that one
  IS a deliberate retirement** — see the note above the counts, and Done-when #9 for the assertion that
  replaces it.
