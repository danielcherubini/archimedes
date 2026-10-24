# T05 — the drag gesture (`useDragReorder`) and the store's reorder actions

Written by `specify` (CONSUMED MODE) against the tree at `5078d75` (branch
`feature/manual-list-order`, T01–T04 `done`). Contract: the spec
(`docs/roadmap/manual-list-order.md`) §"Drag mechanics" + §"Write path", ADR 0075, T03's
`## Known limits` (the constraint this task exists to discharge) and T04's D2 handoff (the
DEPRECATED pair). Every jsdom claim below is **measured at this HEAD**, not carried forward.

**Seam (owned by this task):** `src/hooks/useDragReorder.ts` (new) +
`src/hooks/useDragReorder.test.tsx` (new), `src/store/sessions.ts`, `src/store/sessions.test.ts`.
**Nothing else.** No component, no Rust, no `lib/`, no `App.tsx`, no config — see
"Files outside the seam that a task must touch", which is empty this time, and "Out of scope".

---

## Goal

Give the app a drag gesture and the one write path a drag needs, so that the feature T01–T04
built (a stored, user-owned order that the frontend renders verbatim) can actually be **changed**
and **holds**.

Three moves:

1. **`src/hooks/useDragReorder.ts`** — the shared gesture, owned once. It answers three questions
   and no caller answers any of them: what is being dragged, which row is the drop target, and
   where does the dragged id land. Drop is ONTO a row; the pointer's half of that row decides
   before-or-after; the row IS the target (no gap targets, no placeholder rows). It renders nothing,
   touches no DOM beyond `getBoundingClientRect()`, and does not know what a Session or a Space is.
2. **The store's two reorder actions** — `reorderSessions(ids)` / `reorderSpaces(paths)`. This is
   the load-bearing half. T03's recorded constraint, quoted from the status file:
   *"`sessionOrder` is a BOOT SNAPSHOT and nothing writes it mid-boot, so a DRAG will not hold
   across a re-derivation unless T05's optimistic reorder **WRITES THE ORDER MAP ITSELF**, not
   merely the array it just derived. If T05 updates only the array, the next `spaceViewFor`
   recomputes from the stale map and the row snaps back."* So the session action writes
   `sessionOrder`. The space action writes the `spaces` **array**, because for Spaces the array IS
   the order (`spaces.map(...)` is the tab strip verbatim, and `SpaceRow` carries no order field —
   the column never crosses the wire). **That asymmetry is why the snap-back hazard bites sessions
   and not spaces, and why the two actions look different.** Each fires exactly one IPC call, with
   the WHOLE visible slice in the new order, and rolls back on rejection.
3. **T04's handoff** — delete `SpaceView.liveSessionIds` / `storedSessionIds`, whose only remaining
   readers are `src/store/sessions.test.ts` bodies, and with them the two doc comments that still
   promise a deletion someone else was supposed to perform.

---

## Done-when

All observable. Frontend only, repo root. `npx vitest run <path>` scopes; `pnpm test -- <path>`
does **NOT** (it runs every file — re-confirmed by this repo's own measurement twice on this
branch). Counts are **DELTAS** over the figures re-measured at this plan's HEAD (`5078d75`),
which are: `pnpm test` **3070 passed / 149 files** · `pnpm build` green (pre-existing chunk-size
warning) · `cargo test` **1463 passed / 0 failed** · `src/store/sessions.test.ts` **182** ·
`src/components/SpacesList.test.tsx` **79** · `src/components/SpaceTabs.test.tsx` **34** ·
`src/components/SpaceTabs.pill.test.tsx` **4** · `src/components/SessionListRow.test.tsx` **15** ·
`src/components/RowButton.test.tsx` **14** · `src/lib/tauri.test.ts` **26** ·
`src/lib/sessionRecency.test.ts` **7** · `src/hooks/useWindowDropBackstop.test.ts` **4** ·
`src/App.test.tsx` **41** · `src/test/fixtures.test.ts` **25** ·
`src/hooks/useAgentOverridesWrites.test.ts` **16**.

1. `src/hooks/useDragReorder.ts` exists and exports `useDragReorder`, `type DragReorderHandlers`,
   `type DropEdge`. `useDragReorder({ ids, onReorder })` returns
   `{ dragProps(id), draggingId, overId, overEdge }`, where `dragProps(id)` returns **exactly**
   `{ draggable: true, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }` — that exact key
   set, because T06 spreads it onto `RowButton`, whose header pins attribute order as part of its
   contract and byte-compares row serialisation. `overEdge: "before" | "after" | null` is the
   BEFORE-vs-AFTER answer, so T06 adds one prop and zero logic.
   Proofs (repo root):
   `grep -rniE "session|space" src/hooks/useDragReorder.ts` → **0** (comments included — the hook
   may not know what either list is);
   `grep -nE "document\.|querySelector|classList|className|createElement" src/hooks/useDragReorder.ts`
   → **0** (it renders nothing and mutates nothing);
   `grep -n "stopPropagation" src/hooks/useDragReorder.ts` → **0** (hazard 2 — the backstop must
   still see the event).
2. **THE ACCEPTANCE TEST FOR THIS TASK — the snap-back test.**
   `src/store/sessions.test.ts` contains
   `it("a dragged row HOLDS its slot when the list is re-derived from the stored rows (the optimistic write moves the order map, not the array it derived)")`.
   It re-derives after the drag (`setHistorySessions` with the ORIGINAL boot array — the shape any
   refetch or any other writer produces) and asserts the dragged order survives.
   **Two competing answers, and this is the whole task in one assertion:** an implementation that
   reorders the derived array answers the ORIGINAL order (the boot map is still stale, so
   `mergeSessionOrder` re-sorts it back — the row SNAPS BACK); an implementation that writes
   `sessionOrder` answers the NEW order. Nothing else in the suite can see the difference, which is
   precisely why T03 recorded this as a constraint instead of a TODO.
3. The store exposes `reorderSessions: (ids: string[]) => Promise<void>` and
   `reorderSpaces: (paths: string[]) => Promise<void>`, each firing **one** IPC call
   (`reorder_sessions` / `reorder_spaces`, already shipped through the barrel by T02 — verified:
   `grep -rn "reorderSessions\|reorderSpaces" src/store/ src/App.tsx` → **0** call sites today, so
   this task creates the feature's first), each **never rejecting**, each rolling back on failure.
   `grep -c "reorderSessionsCommand\|reorderSpacesCommand" src/store/sessions.ts` → **≥ 2** (the
   aliased imports the store uses, matching its own `deleteSpaceCommand` idiom).
4. The DEPRECATED pair is gone. Proofs:
   `grep -rn "\.liveSessionIds\|\.storedSessionIds" src/` → **11 → 0** (measured today: 11 hits —
   9 in `src/store/sessions.test.ts`, 2 in `src/store/sessions.ts` prose);
   `grep -n "liveSessionIds: string\|storedSessionIds: string" src/store/sessions.ts` → **2 → 0**
   (the two interface field declarations);
   `grep -rn "T04 deletes\|T05 deletes" src/store/sessions.ts` → **2 → 0** — including
   `SpaceView.liveSessionIds`'s doc that still says "T04 deletes it", which dies with the field
   (the brief's instruction);
   and `grep -rn "\.liveSessionId\b" src/` → **6, UNCHANGED** — the tab's live dot is intact, and
   `liveSessionsInSpace` / `mostRecentLiveInSpace` / `archivedInSpace` are untouched.
   The 8 `it(...)` bodies that read the pair are enumerated and dispositioned in Task 1 (delete /
   rewrite / repurpose, one line each).
5. **Both spec hazards are pinned where they are pinnable, and the one that is NOT pinnable here is
   handed with its exact test name rather than faked.** Hazard 2 (the window drop backstop) is
   pinned in `useDragReorder.test.tsx` by two tests, both measured to be writable today:
   a row's `onDrop` wins without `stopPropagation` (`fireEvent` returns `false`, i.e. prevented, and
   a `stopPropagation` spy records **0** calls), and a drop released on `document.body` — outside
   every row — is still swallowed (`defaultPrevented === true`).
   Hazard 1 (the tab pill) lives entirely in `src/components/SpaceTabs.tsx`, which is T07's seam and
   this task's DO-NOT-TOUCH list; see Decision D8 for why a pin written there today would be born
   green, and Out of scope for the exact `it(...)` strings T07 must write.
6. **No Rust change, with a proof.** `git diff --name-only <T05-base>..HEAD | grep -c '^src-tauri/'`
   → **0**, so `cargo test` stays **1463 / 0 failed**, clippy at 0 warnings, `cargo fmt --check`
   clean. `cargo test` is re-run once at the end to prove it rather than assert it. The Rust side
   already takes the slice index as the value (`reorder_sessions` / `reorder_spaces` write
   `UPDATE … SET sort_order = <index>` per id inside one transaction) and rejects a partial reorder
   by construction, so nothing there has to move.
7. `src/components/**` is untouched:
   `git diff --name-only <T05-base>..HEAD | grep -c '^src/components/'` → **0**. This is the seam
   proof, and it is checkable rather than claimed — it is what makes "T05 needs no component change"
   true even though `RowButton` and `SessionListRow` are the components that will wear the gesture.
8. The successor greps still hold: `grep -rn "sort_order" src/` → **0** (the SQL column name never
   enters `src/`); `grep -rn "sortOrder" src/components/` → **0**; and the set of files naming
   `sessionOrder` is **unchanged** by this task (`src/store/sessions.ts`,
   `src/store/sessions.test.ts`, `src/App.test.tsx`, `src/components/SpacesList.tsx`,
   `src/components/SpacesList.test.tsx`) — `useDragReorder.ts` adds no hit, which is the mechanical
   form of "the hook does not know what a list is".
9. `pnpm test` **3070 → 3092, 149 → 150 files** (intended deltas: Task 2 +10 in the new file,
   Task 3 +7, Task 4 +5, Task 1 ±0) and `pnpm build` green. `pnpm build` is a real gate here:
   `tsconfig.json` includes `src` (so **test files are type-checked**), with `strict`,
   `noUnusedLocals`, `noUnusedParameters` and `verbatimModuleSyntax`.

---

## Conventions this plan inherits (and three it measures for the first time)

- **TDD is a repo convention.** Every task writes its failing test first and names the command that
  proves the red.
- **Scoped vitest is `npx vitest run <path>`.** `pnpm test -- <path>` runs every file.
- **The independence rule (this branch has been bitten three times).** Every test that proves an
  ORDER changed is built so the old behaviour gives a DIFFERENT answer, and each test below states
  its two competing answers. The frontend shape of the `now_ms()` trap: `resetStores()` restores
  `sessionOrder: {}` from `getInitialState()`, so a fixture that never seeds the order map gets
  every id unknown, every id tied, and input order preserved — which at this point in the chain is
  byte-for-byte the OLD live-then-stored concatenation. **Every order assertion in this plan seeds
  `sessionOrder` explicitly.**
- **Plan red-count predictions on this feature have been wrong twice** (T03's report: "the plan's
  predicted red counts are not trustworthy on this feature; measure them"). Every count below is an
  INTENTION, stated as one, and the implementer reports what they measure.
- **THE jsdom DRAG FACTS — all measured at `5078d75`, all of them traps.**
  1. `DragEvent` is `undefined` and `DataTransfer` is `undefined` in this repo's jsdom (measured:
     `typeof globalThis.DragEvent === "undefined"`). So every drag test hand-builds a cancelable
     `Event` and attaches what the hook reads.
  2. **`fireEvent.dragStart(el, { dataTransfer: stub })` delivers the stub** as `event.dataTransfer`
     through React's `onDragStart` (measured: a probe handler logged `start:STUBBED`). This is the
     one `fireEvent` init property that survives, because
     `@testing-library/dom`'s `createEvent` special-cases `dataTransfer`/`clipboardData` with
     `Object.defineProperty` after constructing the event.
  3. **`clientY` does NOT survive the init form.** Measured: `fireEvent.dragOver(el, { clientY: 40 })`
     reaches the handler as `clientY === undefined` — the library constructs
     `new (window.DragEvent ?? window.Event)(type, init)` and jsdom has no `DragEvent`, so a plain
     `Event` swallows the unknown init member. **The idiom every midpoint test MUST use** (measured
     working, and it mirrors `event-map.js`'s own `dragOver` defaultInit
     `{ bubbles: true, cancelable: true, composed: true }`):
     ```ts
     const dragOver = (el: Element, clientY: number) => {
       const ev = new Event("dragover", { bubbles: true, cancelable: true, composed: true });
       Object.assign(ev, { clientY });
       return fireEvent(el, ev);   // false === the handler called preventDefault
     };
     ```
     `cancelable: true` is what makes `defaultPrevented` mean anything — the same reason
     `useWindowDropBackstop.test.ts`'s own helpers say "a non-cancelable event can never be
     prevented".
  4. **`getBoundingClientRect()` returns all zeros in jsdom** (measured `{top:0, bottom:0,
     height:0}`), so the midpoint is `0` and EVERY `clientY > 0` answers "after" — before/after is
     UNTESTABLE unless the test overrides the rect. Measured override:
     ```ts
     // jsdom has no layout: the default rect is all zeros, which makes the midpoint 0 and every
     // pointer "after". Override it so the half is a fact the test chooses.
     el.getBoundingClientRect = () =>
       ({ top: 100, bottom: 140, height: 40, width: 200, left: 0, right: 200, x: 0, y: 100,
          toJSON: () => ({}) }) as DOMRect;
     ```
     If `tsc` refuses the cast, use `as unknown as DOMRect` — do not restructure the hook to make
     the cast easier.
  5. **React state set in one discrete drag event IS visible to the next dispatched event**
     (measured: after `fireEvent.dragStart(a)`, a separately dispatched `dragover` on `b` read
     `draggingId === "a"`, and the following `drop` read it too). That is why the hook can hold
     `draggingId` in `useState` and be ref-free: each `fireEvent` is its own discrete task and React
     flushes before the next one. Do not "optimise" the state into refs — the tests would then be
     asserting a value no call site can ever see.
- **The test file is `.tsx`, and that is forced, not stylistic.** The hook's contract is DOM: it
  needs real elements to carry `dragProps` and to stub their rects. JSX inside a `.ts` file fails
  the transform outright (measured: `PARSE_ERROR: Expected '>' but found 'Identifier'`), and
  `src/hooks/` has **no** `.test.tsx` today — this is the first, for the same reason
  `ChatStream.test.tsx` is `.tsx`.
- **A `lib/` or `hooks/` module must not import a store** (`lib/sessionTypes.ts`'s header is the
  reason). `useDragReorder` takes `onReorder` and imports nothing but `react`. That also keeps
  `src/lib/tauriBoundary.test.ts`'s window-shell allowlist (which names exactly two files)
  untouched.
- **The optimistic-write precedent is `useAgentOverridesWrites`, and the properties this task copies
  from it are exactly two**: (a) publish optimistically **before** any await, so the next render sees
  this write; (b) guard the rollback with a **publish epoch checked at commit**, because "a rollback
  IS a publish" and a stale link's rollback must be DISCARDED, not applied. It does NOT copy the
  read-modify-write of a file (there is no document to re-read here) nor the epoch's effect on the
  success path.
- **`file:line` is not a citation.** Symbols and `it(...)` strings only — `sessions.ts` is 1831
  lines and moves under the edit.

---

## Task 1 — delete the DEPRECATED pair (T04's handoff), before anything is built on it

**Files owned:** `src/store/sessions.ts` (the `SpaceView` interface, `spaceViewFor`'s return
literal, three doc paragraphs), `src/store/sessions.test.ts` (8 `it(...)` bodies).

**Why this is first:** it is mechanical, it is independent of the drag work, and doing it last would
mean writing Tasks 2–4's tests against a `SpaceView` shape that is about to lose two fields.

**Write the failing tests FIRST.** There is no new behaviour to make red here — the deletion is the
change — so the red is the existing bodies losing the fields they read. Edit the eight bodies LAST
in this task, not first: the red command below runs after the field deletions and before the
expectation edits, and it reddens **all eight** bodies, in three distinguishable ways (see Red).

The eight bodies that read the pair (measured: 11 dotted reads across these 8 bodies), each with its
disposition:

| `it(...)` | Disposition | Why |
|---|---|---|
| `it("groups a space with a live session and a stored session")` | **REWRITE** | Drop `liveSessionIds` / `storedSessionIds` from the whole-object `toEqual`; keep `sessionIds: ["stored-alpha", "live-alpha"]`, `liveSessionId: "live-alpha"`, `lastReason: "user"` and the order map `{ "live-alpha": 5, "stored-alpha": 2 }`. Its claim — the D11 reversal, a live row rendering BELOW a stored one — survives entirely on `sessionIds`. |
| `it("returns sessionIds in the stored order the boot map carries (no re-sort)")` | **REWRITE** | Same: drop the two keys, keep `sessionIds: ["idX", "idY"]` and the agreeing map. Its subject is "the store invents no sequence", which `sessionIds` already owns. |
| `it("returns an empty shape for a space with no sessions")` | **REWRITE** | Drop the two keys; `sessionIds: []` and `liveSessionId: null` carry the empty shape. |
| `it("a space with TWO coexisting live sessions points at the most-recently-started one (the one-live cap lift)")` | **REPURPOSE** | **Pair as its SUBJECT** (it pins reverse-insertion order *through* `SpaceView`). Retarget the ordering half to `liveSessionsInSpace` — where the same contract is already pinned by `it("returns session IDs for matching cwd in reverse insertion order (newest first)")` — and keep the LIVE DOT half on the view (`view.liveSessionId === "second"`), which is the field that survives and the fact the tab renders. |
| `it("a space with three or more live sessions orders them newest-first")` | **REPURPOSE** | **Pair as its SUBJECT.** Same move: order → `liveSessionsInSpace`, live dot → `view.liveSessionId === "s3"`. |
| `it("handles live sessions from multiple different spaces interleaved")` | **REWRITE** | Its subject is per-Space **membership across Spaces**, not the pair, so it survives on the view: seed an order map and assert each view's `sessionIds` plus both `liveSessionId` reads (`"alpha-3"`, `"bravo-2"`). For Space A use `{ "alpha-3": 0, "alpha-1": 1, "alpha-2": 2 }`, answering `["alpha-3","alpha-1","alpha-2"]`. **Two competing answers:** with no map the sequence is `liveSessionsInSpace`'s reverse insertion order `["alpha-3","alpha-2","alpha-1"]` — note it is REVERSED, not input order, so a fixture that expects `["alpha-1","alpha-2","alpha-3"]` has mis-read the helper; the map answers the fixture's order. This test gets STRONGER, not weaker. |
| `it("reports archivedSessionIds without polluting sessionIds, and lastReason falls back to the most recent archived Session")` | **REWRITE** | Delete the two `view.storedSessionIds` / `archivedOnly.storedSessionIds` assertions only. Nothing is lost: the membership claim it exists to pin is `expect(view.sessionIds).toEqual(["live-a", "stored-a"])`, which stays, as do both `lastReason` halves. |
| `it("adding multiple sessions sequentially via addSession in the same space produces newest-first liveSessionIds in views()")` | **REWRITE** | **Pair as its SUBJECT**, and its name names a field that will not exist. Rename to `it("adding sessions sequentially in one space yields a newest-first LIVE DOT and a newest-first sequence in views()")`; keep the fixture and assert `view.liveSessionId === "s3"` **and** `view.sessionIds` (empty order map → every id unknown → input order, which for all-live rows is reverse insertion → `["s3","s2","s1"]`). Same expected sequence, now pinned on a field that survives. |

**Prose that becomes a lie when the fields go** (all in `src/store/sessions.ts`; each is one
replacement, none is behaviour):

1. `SpaceView.liveSessionIds`'s declaration **and its DEPRECATED doc, which still says "T04 deletes
   it"** — both die with the field (the brief names this comment explicitly).
2. `SpaceView.storedSessionIds`'s declaration and its DEPRECATED doc ("T05 deletes it") — same.
3. `SpaceView`'s header paragraph: "Supports multiple coexisting live sessions per space:
   `liveSessionIds` contains all active live sessions most-recently-STARTED first, while
   `liveSessionId` points to…" → drop the first clause, keep the live-dot sentence, keep the
   "`sessionIds` is what the rows RENDER — one sequence, not a live block" sentence.
4. `mergeSessionOrder`'s doc: "…the answer is `[...liveSessionIds, ...storedSessionIds]`: the
   pre-T03 sequence" → "…the answer is live rows then stored rows in input order: the pre-T03
   sequence." (It names the deletion's fields today; it must not after.)
5. `detachedSessions`'s doc: "`spaceViewFor`'s `storedSessionIds`/`archivedSessionIds` filters" →
   "`spaceViewFor`'s `stored` / `archivedSessionIds` filters". T04's D2 kept this sentence true by
   keeping the field; the field is going, so the sentence moves with it.

**What deliberately KEEPS its name:** `mergeSessionOrder`'s two PARAMETER names and
`spaceViewFor`'s two LOCALS (`liveSessionIds` / `storedSessionIds`). They are not fields, they
describe their inputs correctly, and renaming them churns T03's just-shipped lines for nothing.
That is why Done-when #4's greps are the **dotted-read** form and the **field-declaration** form
rather than a bare name grep, and the reason is written into the Done-when so a reviewer does not
"fix" the grep into something that cannot pass.

**Red:** `npx vitest run src/store/sessions.test.ts` → **8 failures** (one per body; measure, and if
it comes out 8 exactly, the enumeration above is complete). The three failure shapes are worth
naming, because a reviewer can use them to check nothing else depended on the pair: the three
whole-object `toEqual` bodies fail as **"differing keys"** (the expectation carries
`liveSessionIds`/`storedSessionIds` the received object no longer has); the five direct-read bodies
fail as **`expected undefined to deeply equal [...]`** (reading a deleted field answers `undefined`).
If any OTHER test in the file reddens, the enumeration missed a reader — stop and reconcile it here
rather than reporting a private count.

**Green:** `npx vitest run src/store/sessions.test.ts` (**182, UNCHANGED** — 8 bodies edited, 0
added, 0 deleted; the pair's contract moves to `liveSessionsInSpace`, which is already tested) →
`npx vitest run src/components/SpacesList.test.tsx src/components/SpaceTabs.test.tsx
src/components/SpaceTabs.pill.test.tsx src/components/SessionListRow.test.tsx
src/test/fixtures.test.ts` (**79 / 34 / 4 / 15 / 25, all UNCHANGED** — measured: zero reads of the
pair outside `src/store/`, so no component can notice) → `pnpm build` (the gate that proves no
reader was left behind) → Done-when #4's three greps at 0 and the live-dot grep still at 6.

**Commit:** `refactor(store): delete SpaceView's deprecated live/stored id pair (ADR 0075)`

---

## Task 2 — `src/hooks/useDragReorder.ts`: the gesture, owned once

**Files owned:** `src/hooks/useDragReorder.ts` (new), `src/hooks/useDragReorder.test.tsx` (new).
Nothing imports it yet.

**Write the failing tests FIRST** — `src/hooks/useDragReorder.test.tsx`. It renders a probe
component (the hook needs real elements), five rows with ids `r1…r5`, and a `sessionOrder`-free
world: the hook never sees a store. Helpers at the top of the file, with the two measured idioms
quoted in comments so the next reader does not rediscover them:

```ts
/** jsdom has no DataTransfer (measured `undefined`). The hook CALLS exactly one member —
 *  `setData` — so exactly one is stubbed; `getData` is deliberately absent, because a hook that
 *  read it would be inviting a cross-window drop this app cannot serve. */
const stubDataTransfer = () => ({ setData: vi.fn() });

/** `fireEvent.dragOver(el, { clientY })` does NOT deliver clientY (measured: undefined) — see the
 *  Conventions. Build the event and assign it. The return value is `false` iff the handler
 *  called preventDefault, which is how cancelability is asserted. */
const dragOver = (el: Element, clientY: number) => {
  const ev = new Event("dragover", { bubbles: true, cancelable: true, composed: true });
  Object.assign(ev, { clientY });
  return fireEvent(el, ev);
};

/** Rows sit at top 100, 40px tall, so row i's midpoint is 120 + 150*i. jsdom's default rect is all
 *  zeros → midpoint 0 → every pointer "after" (measured). Without this the half is untestable.
 *  Body = the override idiom quoted in Conventions #4, applied with `top` and `height`. */
const layOut = (el: HTMLElement, top: number, height = 40) => { … };
```

1. `it("dragProps returns exactly draggable + the five handlers (T06 spreads this onto a byte-compared row)")`
   — `expect(Object.keys(dragProps("r1")).sort())` equals the six names, and
   `dragProps("r1").draggable === true`. **Two competing answers:** any extra key (`className`,
   `onDragEnter`, a `data-*`) is a red here, and `RowButton`'s header says its serialisation is
   byte-compared, so an extra key is a contract break in T06's file.
2. `it("onDragStart marks the row as the one being dragged, and seeds the native drag with setData")`
   — fire `fireEvent.dragStart(row1, { dataTransfer: stub })`; assert the hook's `draggingId` is
   `"r1"` and `stub.setData` was called with `("text/plain", "r1")`.
   **Two competing answers for the `setData` half:** a hook that skips `setData` is green in jsdom
   and broken in Firefox, which does not start a drag without it. This is the only place that
   requirement can be pinned, so it is pinned as a call assertion.
3. `it("onDragOver makes the row a drop target and reports the pointer's half: above the midpoint is BEFORE, below is AFTER")`
   — `dragStart` on `r5`; `layOut(row2, 100)`; `expect(dragOver(row2, 110)).toBe(false)` (false ===
   prevented === the row accepts drops) and `overId === "r2"`, `overEdge === "before"`; then
   `dragOver(row2, 130)` → `overEdge === "after"`.
   **Two competing answers:** with jsdom's default all-zero rect the midpoint is 0 and BOTH pointers
   answer "after", so a hook that never reads the rect, and a test that never overrides the rect,
   both agree — which is exactly the trap Conventions #4 names. The two assertions only differ
   because the rect was overridden.
4. **The spec's #13 at the hook level** —
   `it("drop on a row's TOP half lands the dragged id ABOVE it; its BOTTOM half lands the id BELOW it, and onReorder gets the whole visible slice")`
   — five rows `r1…r5`; `dragStart(r5)`; `dragOver(r2, 110)` then `drop(r2)` →
   `onReorder` called once with `["r5","r1","r2","r3","r4"]`; repeat with `dragOver(r2, 130)` →
   `["r1","r2","r5","r3","r4"]`.
   **Two competing answers** — gap-target thinking would answer `["r1","r5","r2",…]` for the first
   half and the hook must not; a hook that always inserts after answers the second array twice.
5. `it("dragging a row onto itself is a no-op: it is not even a drop target, and onReorder never runs")`
   — `dragStart(r3)`; `expect(dragOver(r3, 130)).toBe(true)` (**true** — nothing prevented the
   event, so the browser shows its no-drop cursor and the window backstop is what swallows it);
   `overId` stays `null`; `drop(r3)` → `onReorder` not called.
   **Two competing answers:** a hook that treats self-drop as a normal target answers
   `overId === "r3"` and prevented; the spec's "dragging a row onto itself is a no-op" answers
   un-prevented and silent.
6. `it("the gesture state is cleared by onDragEnd (Esc cancels a drag and fires NO drop) and by onDrop")`
   — two acts: `dragStart(r1)` + `dragEnd(r1)` → `draggingId`/`overId`/`overEdge` all `null`; and
   after a completed drop the same three are `null`. The `dragend` half is the reachable one —
   pressing Escape mid-drag fires `dragend` and no `drop`, and a lingering `draggingId` would make
   the next `dragOver` think a drag is on.
7. `it("onDragLeave clears the target only when the pointer leaves the CURRENT target (a stale leave must not flicker the indicator off)")`
   — `dragStart(r1)`; `dragOver(r3, 130)`; then fire `dragLeave` on `r2` (which the browser does
   fire, on the row the pointer came from, AFTER the `dragover` on the new one) → `overId` is still
   `"r3"`; then `dragLeave` on `r3` → `overId` is `null`.
   **Two competing answers:** an unconditional `setOverId(null)` answers `null` after the first
   leave — the indicator would blink off on every row transition; the guarded version keeps `r3`.
8. `it("a row's drop never calls stopPropagation, so the window drop backstop still sees the event")`
   — mount the probe **with `useWindowDropBackstop()`** (this is spec hazard 2, and it is pinnable
   here because both halves are in this task's reach); `dragStart(r1)`, `dragOver(r3, 130)`, then
   dispatch a hand-built `drop` on `r3` carrying a `vi.spyOn(ev, "stopPropagation")`. Assert
   `onReorder` ran, `fireEvent` returned `false`, `ev.defaultPrevented === true`, and the spy
   recorded **0** calls. Measured on this tree: the row handler runs first during bubbling, the
   backstop's `preventDefault` still lands, and 0 `stopPropagation` calls are needed.
   **Two competing answers:** a hook that "helpfully" stops propagation returns `0`→`1` on the spy
   and, in the real webview, leaves the backstop deaf for that event — the exact class of bug the
   spec says to pin, not discover.
9. `it("a reorder drag released OUTSIDE any row is still swallowed by the backstop (no webview navigation)")`
   — same harness; dispatch the `drop` on `document.body` → `ev.defaultPrevented === true` and
   `onReorder` not called. Measured: a body-level drop reaches the window listener and is prevented.
10. `it("an id the list no longer contains gets no reorder (a row that closed mid-drag cannot half-move the list)")`
    — `dragStart` on a row, then re-render the probe with that id removed from `ids`, then
    `dragOver` + `drop` on a surviving row → `onReorder` not called.
    **Two competing answers:** an unguarded `moveId` would splice `undefined` in, or insert nothing
    and still fire the IPC — and a fired IPC with a stale slice is the half-moved list.

**Red:** `npx vitest run src/hooks/useDragReorder.test.tsx` → the file fails to load (no such
module). Isolated; nothing else imports it, so the rest of the suite is untouched and a count IS
quotable. After implementation the intention is **10 passing** — measure it.

**Implementation** (`src/hooks/useDragReorder.ts`; header prose in the file's own voice: it owns the
three questions once, because two implementations of "compute the new index from a drop position" is
exactly the drift this repo documents elsewhere; the row IS the target — no gap targets, no
placeholder rows, because nothing new may need laying out in a list whose contract is one DOM level;
it renders nothing and knows nothing about what a list of ids means; and the `setData` call exists
for Firefox, not for jsdom):

```ts
import { useCallback, useState } from "react";
import type { DragEventHandler } from "react";

/** Which half of the target row the pointer is in — the answer that decides ABOVE or BELOW. */
export type DropEdge = "before" | "after";

/** THE spread surface. `RowButton` emits `...rest` verbatim and its header pins attribute order as
 *  part of its contract, so this is EXACTLY six keys and no more (pinned by test 1). */
export interface DragReorderHandlers {
  draggable: true;
  onDragStart: DragEventHandler<HTMLDivElement>;
  onDragEnd: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export interface UseDragReorder {
  dragProps: (id: string) => DragReorderHandlers;
  /** The row under drag, or `null`. */
  draggingId: string | null;
  /** The row currently offered as the drop target, or `null`. Never `draggingId`. */
  overId: string | null;
  /** Which half of `overId` the pointer is in — so a call site adds ONE class and no logic. */
  overEdge: DropEdge | null;
}

/** The id's new position, given the target and the pointer's half. Pure, and the ONLY copy of the
 *  arithmetic in `src/`: both call sites go through it, which is the point of this hook. */
function moveId(
  ids: readonly string[],
  draggingId: string,
  overId: string,
  edge: DropEdge,
): string[] {
  const rest = ids.filter((x) => x !== draggingId);
  const target = rest.indexOf(overId);
  if (target === -1) return [...ids];
  const at = edge === "before" ? target : target + 1;
  return [...rest.slice(0, at), draggingId, ...rest.slice(at)];
}

export function useDragReorder(args: {
  /** The visible slice, in its current order — the call site's list, whatever it means. */
  ids: readonly string[];
  /** Called with the WHOLE slice in its new order (never just the moved id): the backend writes
   *  the slice index as each row's stored order number, so a partial list is a half-moved list. */
  onReorder: (ids: string[]) => void;
}): UseDragReorder {
  const { ids, onReorder } = args;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overEdge, setOverEdge] = useState<DropEdge | null>(null);

  // Handlers are rebuilt per render and close over THAT render's `ids` / `onReorder`. That is
  // correct rather than sloppy: a drag event is a discrete task and React flushes state between
  // two of them (measured — `dragStart`'s setState is visible to the next dispatched `dragover`),
  // so a drop always reads the list as the last render showed it. No refs, no staleness dance.
  const dragProps = useCallback(
    (id: string): DragReorderHandlers => ({
      draggable: true,
      onDragStart: (e) => {
        // Firefox starts no drag unless the payload is written. jsdom has no DataTransfer, hence
        // the optional chain — and the test that pins this call (test 2) is the only proof it
        // survives in the real webviews.
        e.dataTransfer?.setData("text/plain", id);
        setDraggingId(id);
      },
      onDragEnd: () => {
        setDraggingId(null);
        setOverId(null);
        setOverEdge(null);
      },
      onDragLeave: () => {
        // Guarded, not unconditional: the browser fires `dragleave` on the OLD row AFTER the
        // `dragover` on the new one, so an unguarded clear flickers the indicator off on every
        // row-to-row move.
        if (overId === id) {
          setOverId(null);
          setOverEdge(null);
        }
      },
      onDragOver: (e) => {
        // A row is never a target for the drag it started: un-prevented, so the browser shows its
        // no-drop cursor and the window backstop is what swallows the release.
        if (draggingId === null || draggingId === id) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const edge: DropEdge =
          e.clientY < (rect.top + rect.bottom) / 2 ? "before" : "after";
        // The line that makes this row a drop target at all.
        e.preventDefault();
        if (overId !== id) setOverId(id);
        if (overEdge !== edge) setOverEdge(edge);
      },
      onDrop: (e) => {
        const moved = draggingId;
        if (moved === null || moved === id || !ids.includes(moved)) {
          // Deliberately NO preventDefault here either: an inert release belongs to the backstop.
          setDraggingId(null);
          setOverId(null);
          setOverEdge(null);
          return;
        }
        e.preventDefault();
        const next = moveId(ids, moved, id, overEdge ?? "before");
        setDraggingId(null);
        setOverId(null);
        setOverEdge(null);
        // Nothing moved (a row nudged back onto its own boundary) costs no write.
        if (next.join("\u0000") !== ids.join("\u0000")) onReorder(next);
      },
    }),
    [draggingId, overId, overEdge, ids, onReorder],
  );

  return { dragProps, draggingId, overId, overEdge };
}
```

**Green:** `npx vitest run src/hooks/useDragReorder.test.tsx` → then
`npx vitest run src/hooks/useWindowDropBackstop.test.ts` (**4, UNCHANGED** — the hook is not
modified by this task; tests 8–9 drive it as a collaborator) → `pnpm build` (green; `tsc` checks the
`.tsx` test file too) → Done-when #1's three greps at 0 →
`npx vitest run src/components/RowButton.test.tsx src/components/SessionListRow.test.tsx`
(**14 / 15, UNCHANGED** — nothing in either component was touched, which is the point: `RowButton`
already spreads `...rest`, so `draggable` and the handlers reach the DOM with no change to a file
whose serialisation is byte-compared).

**Commit:** `feat(drag): add useDragReorder — the one gesture both lists will share`

---

## Task 3 — `reorderSessions(ids)`: the optimistic write that writes the ORDER MAP

**Files owned:** `src/store/sessions.ts` (state interface + implementation + module-scope chain),
`src/store/sessions.test.ts` (the `vi.mock` factory + a new describe).

**Why the map, in one sentence a reviewer will ask for:** `historySessions`' array order is NOT the
display order — `mergeSessionOrder` re-sorts the live∪stored union against `sessionOrder` on every
derivation — so writing the array is writing a value that gets thrown away. `sessionOrder` is the
only thing the derivation reads. (For Spaces the situation is inverted and simpler: `SpaceRow`
carries no order field, so the `spaces` array IS the order — Task 4.)

**Write the failing tests FIRST** — `src/store/sessions.test.ts`, a new
`describe("reorderSessions (the sidebar drag write path, ADR 0075)")`.

**Harness first, in the same commit, or the red is a lie:** this file's `vi.mock("../lib/tauri")`
factory spreads `importActual` and mocks ONLY the commands the store calls today.
`reorderSessions`/`reorderSpaces` are not among them, so the REAL wrappers would call `invoke`,
reject in jsdom (the file's own comment documents "no global Tauri mock exists"), and the failure
would look nothing like the cause. Add both to the factory alongside `setSpaceTrusted`:
`reorderSessions: vi.fn().mockResolvedValue(undefined),` and
`reorderSpaces: vi.fn().mockResolvedValue(undefined),` — both here, in one edit, so Task 4 adds no
mock. Report the un-mocked symptom as a **harness red**, then the assertion reds proper.

The file already imports command wrappers by name (`setSpaceTrusted`, `deleteSpace`, …); add
`reorderSessions` to that import list so `vi.mocked(reorderSessions)` talks to the mock.

1. **THE ACCEPTANCE TEST (Done-when #2)** —
   `it("a dragged row HOLDS its slot when the list is re-derived from the stored rows (the optimistic write moves the order map, not the array it derived)")`
   — `/w/alpha`, no live rows, three stored rows `top`/`mid`/`bottom` in that array order with
   `sessionOrder: { top: 0, mid: 1, bottom: 2 }`. Call
   `const done = useSessions.getState().reorderSessions(["mid", "bottom", "top"])` (the whole
   visible slice in its new order — exactly what `useDragReorder` hands `onReorder`). Assert, in
   order: (a) `useSessions.getState().sessionOrder` now carries `{ top: 2, mid: 0, bottom: 1 }` —
   the MAP moved; (b) `spaceViewFor(...)` answers `sessionIds === ["mid","bottom","top"]`; (c) NOW
   re-derive: `useSessions.getState().setHistorySessions([top, mid, bottom])` — the ORIGINAL boot
   array, the shape a refetch or any other writer restores — and assert `spaceViewFor` STILL answers
   `["mid","bottom","top"]`; (d) `await done` and assert it once more.
   **Two competing answers, and this is the task's acceptance:** an implementation that reorders the
   derived array (`historySessions`) is red at BOTH (b) and (c) — the boot map is untouched, so
   `mergeSessionOrder` sorts the array straight back and the answer stays `["top","mid","bottom"]`,
   i.e. the row SNAPS BACK, the defect T03 named. An implementation that writes the map answers
   `["mid","bottom","top"]` at every step. **What (c) is for, stated honestly:** (b) alone already
   reddens the array-only write, so this test's discriminating power does not rest on (c); (c) is
   there because it is the observable form of the constraint as T03 recorded it — *a drag holds
   across a re-derivation* — and it is the step that keeps a future implementation from satisfying
   the paint (b) checks while leaving the durable map stale. Keep both; (c) is the promise, (b) is
   the paint.
2. `it("publishes the new order BEFORE the command resolves (the optimistic publish the sidebar paints from)")`
   — assert `sessionOrder` and `sessionIds` SYNCHRONOUSLY, in the same tick as the call, before any
   `await`, with the command left pending. **Competing answer:** a write-after-await implementation
   leaves the old map at that instant. This is `useAgentOverridesWrites`' "publish first (before the
   awaits)" property, copied.
3. `it("sends the WHOLE visible slice VERBATIM — unsorted, undeduped, unfiltered — and sends nothing for an empty slice")`
   — `reorderSessions(["mid","bottom","top"])` → `expect(reorderSessionsCommand).toHaveBeenCalledWith(["mid","bottom","top"])`
   (one call, the array exactly as given); then `reorderSessions([])` → `toHaveBeenCalledTimes(1)`
   still, and `sessionOrder` unchanged.
   **Two competing answers:** "send just the moved id" answers `["mid"]` — and because the Rust side
   writes the slice index as the value, that is the half-moved list the spec calls a bug. The empty
   half pins the guard without pretending the store can see a list (see D2).
4. `it("a rejected reorder logs and restores the PREVIOUS order map, and the action never rejects")`
   — seed `{a:0,b:1}` (Space `/w/a` rows `a`,`b`), `vi.mocked(reorderSessions).mockRejectedValueOnce(new Error("boom"))`
   with `console.error` spied, `await useSessions.getState().reorderSessions(["b","a"])`; assert the
   map is back to `{a:0,b:1}`, `spaceViewFor` answers `["a","b"]` again, `console.error` was called
   with a message naming the failure, and the awaited promise resolved (the test's own `await` is
   the proof: a rejecting action makes the test fail on the rejection, not on the assertion).
   **Two competing answers:** no rollback leaves `["b","a"]` while the DB holds `["a","b"]` — the
   list the user will see re-arranged at the next boot, which reads as the app ignoring them.
5. `it("a failed OLDER drag does not roll back a NEWER drag's order (the publish epoch, checked at commit)")`
   — two drags in one tick: `first = reorderSessions(["b","a"])`, then
   `reorderSessions(["c","b","a"])`, with the first mock rejecting and the second resolving; await
   both; assert the final map is the SECOND drag's. **Two competing answers:** an unconditional
   rollback restores the pre-first snapshot and silently deletes the second drag — the exact failure
   `useAgentOverridesWrites`' epoch exists to stop, copied here rather than reinvented.
6. `it("reordering one Space leaves another Space's rows exactly where they were")`
   — two Spaces. `historySessions` = `[a1, a2, b2, b1]` — **Space B's rows are in the array in the
   OPPOSITE order to their numbers on purpose** — with
   `sessionOrder: { a1: 0, a2: 1, b1: 0, b2: 1 }`. Assert FIRST that `/w/b` answers
   `["b1","b2"]` (proving the fixture is live: the map beats the array), then
   `await reorderSessions(["a2","a1"])`, then assert `/w/b` STILL answers `["b1","b2"]`.
   **Two competing answers, and the fixture is built so they differ:** an implementation that
   rebuilds the map wholesale (`Object.fromEntries(ids.map(…))`) DELETES `b1`/`b2`, and
   `sortByManualOrder` sinks unknown ids while preserving their input order — so Space B silently
   answers `["b2","b1"]`. Seeding B's array order to AGREE with its numbers would make the two rules
   answer identically and the test would certify nothing, which is the trap Conventions state.
7. `it("ids outside the sent slice keep their map entries (the write touches the slice, as the command does)")`
   — the map-side statement of the same failure: seed `{a:0,b:1,z:7}` with `z` in another Space,
   reorder `["b","a"]`, expect `{a:1,b:0,z:7}` exactly. (Task 6's failure mode at the data layer;
   both are cheap and they fail together, which is the point.)

**Red:** `npx vitest run src/store/sessions.test.ts` → **7 failures** (intention — measure): the
first three as `reorderSessions is not a function`, the rest the same way; after the mock lands,
tests 1–7 are assertion failures. Quote test 1's step-(b) diff as the headline — that is the snap
back, seen.

**Implementation** — `src/store/sessions.ts`:

- Imports: `reorderSessions as reorderSessionsCommand, reorderSpaces as reorderSpacesCommand` into
  the existing `../lib/tauri` block (the file's own aliasing idiom — `deleteSpaceCommand`,
  `closeSessionCommand` — which is what keeps the store action and the wrapper from sharing a name).
- `SessionsState`, beside `setSpaceTrusted` (the nearest neighbour and the same contract family):

```ts
  /**
   * Rewrite the manual order of ONE Space's visible Session rows (the sidebar
   * drag's write path, ADR 0075). Optimistic — the ORDER MAP `sessionOrder` is
   * updated synchronously, then `reorder_sessions` fires with the WHOLE slice in
   * its new order — and on rejection the previous map is restored and the failure
   * logged. NEVER rejects: the call site `void`s it and a rejection would be an
   * unhandled rejection in the webview (see `useAgentOverridesWrites` for why that
   * matters and where the epoch rule comes from).
   *
   * THE MAP, NOT THE ARRAY, AND THAT IS THE WHOLE POINT: `mergeSessionOrder`
   * re-sorts the live∪stored union from `sessionOrder` on every derivation, so a
   * write that only reordered `historySessions` would be undone by the next
   * `spaceViewFor` — the row would snap back. `sessionOrder` is a boot snapshot
   * until this action writes it.
   *
   * `ids` is the whole visible slice (`SpaceView.sessionIds`), live rows included
   * (a live Session HAS a `sessions` row — `record_session` writes it at start —
   * so renumbering it is meaningful) and archived rows EXCLUDED (the Archived
   * section is recency-ordered and must not be renumbered invisibly). The store
   * does not re-derive that slice: what is visible is the render layer's answer,
   * and a second owner of it is a second thing that can disagree.
   */
  reorderSessions: (ids: string[]) => Promise<void>;
```

- Module scope, beside `inFlightToggles` / `committedTrusted` (the file's own home for write-path
  state that is not store state), with a comment naming the two `useAgentOverridesWrites`
  properties it copies and the one it does not (no file to re-read, so no read-modify-write):

```ts
// The reorder write path (ADR 0075). ONE chain per list: two drags in the same
// list must land in the order they happened, exactly as `inFlightToggles` does
// for the trust flag. App-global per LIST (not per Space): the command rewrites
// a whole slice, so two overlapping writes to the same table cannot be ordered
// by anything but a chain. A stored promise never rejects (each link catches), so
// a failed drag cannot poison the next one.
const reorderChain: { sessions: Promise<void>; spaces: Promise<void> } = {
  sessions: Promise.resolve(),
  spaces: Promise.resolve(),
};
// How many optimistic reorder publishes each list has made. A failing link
// compares its own epoch and DISCARDS its rollback if a newer drag has published
// since — a rollback IS a publish, and a stale one deletes a newer move
// (`useAgentOverridesWrites`' rule, copied).
const reorderEpoch = { sessions: 0, spaces: 0 };
```

- The action, immediately after `setSpaceTrusted`:

```ts
  reorderSessions: (ids) => {
    // The store cannot see a visible slice (that is the render layer's answer), so
    // it guards only the one degenerate case it CAN see. The "nothing moved" case
    // is `useDragReorder`'s to refuse, where the list is visible.
    if (ids.length === 0) return Promise.resolve();
    const previous = get().sessionOrder;
    reorderEpoch.sessions += 1;
    const epoch = reorderEpoch.sessions;
    // Optimistic, and the write is the MAP. Slice index = the new number, which is
    // exactly what `Db::reorder_sessions` will store, so the two agree without a
    // round trip. Ids outside the slice keep their entries (test 7) — the command
    // updates only the ids it is given, and a wholesale map would sink every other
    // Space's rows to the bottom.
    set((state) => ({
      sessionOrder: {
        ...state.sessionOrder,
        ...Object.fromEntries(ids.map((id, index) => [id, index])),
      },
    }));
    const link = () =>
      reorderChain.sessions
        .catch(() => {})
        .then(() => reorderSessionsCommand(ids))
        .catch((err) => {
          console.error("Failed to reorder sessions:", err);
          if (reorderEpoch.sessions !== epoch) return; // a newer drag owns the store
          set({ sessionOrder: previous });
        });
    const done = link();
    reorderChain.sessions = done;
    return done;
  },
```

- The ordering note at the top of the file gains ONE clause, because it currently says position is
  "a FIELD the store holds (`sessionOrder`, from the SAME payload)" and that is now incomplete: add
  that a drag writes it (through `reorderSessions`), that the numbers are per-Space comparable only
  (`mergeSessionOrder` is called with one Space's ids, nowhere else — verified by grep), and that
  this is why a slice renumbered 0..n-1 cannot disturb another Space. That last sentence is what
  stops a future reader "fixing" the collision; note also that the Rust command has the identical
  behaviour, so the map agrees with the DB rather than approximating it.

**Green:** `npx vitest run src/store/sessions.test.ts` (**182 → 189**, intention) →
`npx vitest run src/lib/tauri.test.ts` (**26, UNCHANGED, UNEDITED** — T02's
`reorderSessions`/`reorderSpaces` wrapper pins are about the wire KEY, and this task changes no
wrapper) → `npx vitest run src/App.test.tsx src/components/SpacesList.test.tsx
src/test/fixtures.test.ts` (**41 / 79 / 25, all UNCHANGED** — no new state field, so
`resetStores`'s `getInitialState()` proof holds without an edit) → `pnpm build`.

**Commit:** `feat(store): reorderSessions writes the order map, so a dragged row holds its slot`

---

## Task 4 — `reorderSpaces(paths)`: the tab strip, where the ARRAY is the order

**Files owned:** `src/store/sessions.ts`, `src/store/sessions.test.ts`.

The asymmetry, stated once so nobody "unifies" the two actions: `SpaceRow` has no order field (the
column never crosses the wire), so `spaces.map(...)` IS the tab strip and `views = spaces.map(
spaceViewFor)` inherits it — the spec's §4 reason the tab strip and the sidebar's group order cannot
disagree. There is no map to write and therefore no snap-back hazard; what this action owns instead
is the array's integrity.

**Write the failing tests FIRST** — `src/store/sessions.test.ts`, a new
`describe("reorderSpaces (the tab-strip drag write path, ADR 0075)")` (the mock is already in place
from Task 3):

1. `it("reorders the tab strip optimistically and sends the whole strip's PATHS")` — three Spaces
   `/a,/b,/c`; `const done = reorderSpaces(["/c","/a","/b"])`; assert
   `useSessions.getState().spaces.map((s) => s.path)` is `["/c","/a","/b"]` **synchronously** (the
   optimistic publish), and `expect(reorderSpacesCommand).toHaveBeenCalledWith(["/c","/a","/b"])`.
   **Two competing answers:** an after-await write leaves the old array at that instant; sending
   ids/rows instead of paths is a `{ ids }` wire key against Rust's `paths` parameter, which
   `src/lib/tauri.test.ts` says is "a runtime-only failure no Rust test and no component test can
   see" — so it is pinned here too, at the store boundary. `await done`.
2. `it("a rejected tab drag restores the PREVIOUS strip array (no refetch — see the doc)")` — reject
   the command, `await`, assert the array is byte-identical to the pre-drag one and the action
   resolved. **Competing answer:** leaving the dragged order means the strip and the DB disagree
   until a restart, and `removeSpace`'s leftmost-tab fallback then lands on a tab the DB does not
   think is leftmost.
3. `it("a Space the slice does not name is kept, at the BOTTOM (a tab added mid-drag is not dropped)")`
   — strip `/a,/b,/c`; `await reorderSpaces(["/c","/a"])` (as if `/b` were opened mid-gesture);
   assert the array is `["/c","/a","/b"]` — nothing lost, `/b` at the bottom, which is the approved
   new-row rule rather than an accident. **Three competing answers, and the fixture tells them
   apart:** a naive `paths.map(lookup)` answers `["/c","/a"]` — a tab that vanishes from the strip
   while its Space still exists is a data-loss bug wearing a UI costume; an implementation that
   splices the named rows and leaves an unnamed row at its ORIGINAL index answers
   `["/c","/b","/a"]`; the bottom rule answers `["/c","/a","/b"]`. The fixture puts the unnamed row
   in the MIDDLE of the strip precisely so "keep its index" and "go to the bottom" cannot agree —
   seed `/b` last and the two answer identically and the test certifies nothing.
4. `it("an unknown path in the slice is ignored, and an empty slice sends nothing")` —
   `await reorderSpaces(["/ghost","/a"])` leaves the strip as `["/a", …]` (the ghost cannot be
   rendered, so it is not inserted as `undefined`) and still sends the slice verbatim to the command;
   `reorderSpaces([])` sends nothing and changes nothing.
5. `it("after a tab drag, closing the selected tab lands on the NEW leftmost tab (a neighbour means the user's neighbour)")`
   — the ADR 0075 consequence, and the one place another action reads the array's order. Seed the
   strip `/a,/b,/c` with **`activeSpacePath: "/c"`** — the tab that is about to be closed must be the
   SELECTED one, because `removeSpace` answers its fallback ONLY for the Space that was selected and
   `null` otherwise, so selecting anything here makes the test fail for the wrong reason. Then
   `await reorderSpaces(["/c","/b","/a"])`, then
   `await useSessions.getState().removeSpace("/c")` and assert the returned fallback is `"/b"`.
   Use `removeSpace`, NOT `closeSpace`: `removeSpace` returns the fallback directly, which isolates
   the ordering claim, while `closeSpace` additionally runs `selectSpace` → `openSession` → a
   `loadHistory` IPC whose result could muddy an assertion about position. (Both are mocked in this
   file, so `closeSpace` works too — state which you used if you switch.)
   **Two competing answers:** had the reorder been a no-op the strip would still be
   `["/a","/b","/c"]`, and removing `/c` leaves `["/a","/b"]` → leftmost `"/a"`; after a real drag it
   leaves `["/b","/a"]` → leftmost `"/b"`. `removeSpace`'s rule is deliberately unchanged by ADR 0075
   ("the LEFTMOST remaining tab"), so this test proves the reorder was a real change of order and not
   a cosmetic one — it is the pin that `removeSpace`'s deliberately-unchanged leftmost-tab rule now
   reads the user's arrangement.

**Red:** `npx vitest run src/store/sessions.test.ts` → **5 failures** (intention), all
`reorderSpaces is not a function` before the implementation and assertions after. Quote test 2's
diff as the headline.

**Implementation** — the interface entry goes beside `reorderSessions` (same paragraph shape, with
the asymmetry stated: "Spaces carry position in the ARRAY, because `spaces.map(…)` IS the tab strip
and `SpaceRow` has no order field; Sessions carry it in `sessionOrder`") and the action after it:

```ts
  reorderSpaces: (paths) => {
    if (paths.length === 0) return Promise.resolve();
    const previous = get().spaces;
    reorderEpoch.spaces += 1;
    const epoch = reorderEpoch.spaces;
    // Optimistic, and the write is the ARRAY — for Spaces that IS the order (ADR 0075;
    // `views = spaces.map(spaceViewFor)` inherits it, so the tab strip and the sidebar's group
    // order cannot disagree). A path the store has no row for is skipped (it cannot be
    // rendered); a row the slice does not name goes to the BOTTOM (the approved new-row rule,
    // and the reason a tab opened mid-drag survives the write rather than vanishing with it).
    set((state) => {
      const byPath = new Map(state.spaces.map((s) => [s.path, s]));
      const moved = paths.flatMap((p) => {
        const found = byPath.get(p);
        return found ? [found] : [];
      });
      const named = new Set(paths);
      return {
        spaces: [...moved, ...state.spaces.filter((s) => !named.has(s.path))],
      };
    });
    const link = () =>
      reorderChain.spaces
        .catch(() => {})
        .then(() => reorderSpacesCommand(paths))
        .catch((err) => {
          console.error("Failed to reorder spaces:", err);
          if (reorderEpoch.spaces !== epoch) return;
          set({ spaces: previous });
        });
    const done = link();
    reorderChain.spaces = done;
    return done;
  },
```

**Rollback: restore, not refetch — DECIDED, with the refetch's cost stated.** The spec's §Write path
says "a rejection logs and refetches". A refetch is the wrong instrument here and the plan says so
rather than quietly deviating:

- a SESSION reorder's refetch is `sessionRecency()` — which is **not** a per-Space query but a read
  of every non-subagent row, and applying it means `setSessionRecency`, which REPLACES the recency
  map too (T03's D13). It cannot restore array order anyway, and array order is not the display
  order, so the refetch buys nothing the captured map does not already provide;
- a SPACE reorder's refetch is `listSpaces()` → `setSpaces()`, and `setSpaces` is a **boot** action:
  it re-seeds `committedTrusted` and, when nothing is selected, runs `autoSelectActive` and
  `openSession`. A mid-run refetch through it can move the selected tab and fire a transcript load
  — a visible side effect in the middle of an error path;
- and neither is needed, because the command is **one transaction** (`tx.transaction()` …
  `tx.commit()`), so on rejection the database is byte-for-byte where it was before the drag. The
  captured snapshot IS the committed state; a refetch re-reads it to learn nothing new.

So: log through the repo's `void`-command convention and restore the captured snapshot, guarded by
the epoch. **The spec's sentence is now false in its second half and this plan cannot amend it** (the
spec is the orchestrator's to amend, as T04 recorded for §5) — record in the status file that
"logs and refetches" shipped as "logs and restores the captured slice", with the transaction
argument as the reason.

**Green:** `npx vitest run src/store/sessions.test.ts` (**189 → 194**, intention) →
`npx vitest run src/components/SpaceTabs.test.tsx src/components/SpaceTabs.pill.test.tsx`
(**34 / 4, UNCHANGED** — the tabs render `spaces.map(...)` verbatim and gain no drag props in this
task) → `npx vitest run src/components/SpacesList.test.tsx` (**79, UNCHANGED** — the group order
follows the array it already read) → `pnpm build`.

**Commit:** `feat(store): reorderSpaces — the tab strip's optimistic order write, with rollback`

---

## Files outside the seam that a task must touch

**None.** `git diff --name-only <T05-base>..HEAD` must list exactly `src/hooks/useDragReorder.ts`,
`src/hooks/useDragReorder.test.tsx`, `src/store/sessions.ts`, `src/store/sessions.test.ts`. Unlike
T04, no out-of-seam prose edit is forced: the two stale doc sentences T04 left for T05 are
`SpaceView`'s own field docs, which die with the fields in Task 1, and the `SessionListRow.tsx`
citation T04 left is T06's (see Out of scope).

---

## Decisions this plan makes

- **D1 — the hook keeps its gesture state in `useState`, not refs, and rebuilds its handlers per
  render.** Measured: React flushes between two discrete drag events, so a `drop` always sees the
  previous event's state and the last render's `ids`. The alternative (refs for `draggingId`/`overId`)
  would make the hook's return values unobservable to React — T06 and T07 render the indicator from
  `overId`/`overEdge`, so a ref would be invisible exactly where it is needed. Cost: `dragProps(id)`
  returns fresh handler identities per render, which is fine for five rows and a handful of tabs and
  is not a memo boundary either call site is crossing.
- **D2 — the store does NOT re-derive the visible slice; the call site sends it.** Tempting (the
  store could compute `mergeSessionOrder(live, stored, sessionOrder)` for the active Space and be
  immune to a bad caller), and rejected: "what is visible" is the render layer's answer — the sidebar
  excludes archived rows, the tab strip excludes nothing — and a second owner of that question is a
  second thing that can disagree with the DOM. It is also why T03's exported `mergeSessionOrder`
  turns out **not** to be needed by the action, which contradicts the handoff's implication that it
  would be reused: the remedy for the snap-back is writing the MAP, not re-merging. Stated plainly
  so the next reader does not hunt for a call that is deliberately absent. The mitigation for the
  trust placed in the caller is a doc sentence (whole slice, live included, archived excluded, with
  the reason) plus Task 3 test 3's verbatim pin.
- **D3 — rollback restores a captured snapshot; it does not refetch.** Full argument, including what
  each refetch would cost, in Task 4 (it is the same decision for both actions). This deviates from
  the spec's "logs and refetches" and says so, naming the transaction as the fact that makes the
  snapshot provably correct.
- **D4 — a publish epoch guards each rollback; two chains serialize the writes.** Copied from
  `useAgentOverridesWrites` (optimistic publish, epoch checked at commit) and `setSpaceTrusted`
  (per-target promise chain), rather than invented. Per-list, not per-Space: the command rewrites a
  whole slice, so two writes to the same table have no order without a chain. Task 3 test 5 is the
  epoch's proof, and it is not decoration — without it a failed first drag silently deletes a
  successful second one.
- **D5 — the actions return `Promise<void>` and never reject, rather than `void` like
  `setSpaceTrusted`.** A `void` return makes the rollback's timing unobservable: `setSpaceTrusted`'s
  own test `await`s an `undefined` and relies on one microtask happening to be enough. A
  never-rejecting promise is awaitable deterministically and still satisfies the call site's `void`,
  which is the property `useAgentOverridesWrites` documents as load-bearing (a rejection the mount
  cannot attach a handler to is an unhandled rejection in the webview).
- **D6 — the before/after arithmetic is module-private (`moveId`), not an exported pure helper.**
  Exporting it would hand every call site a way to reorder a list without the gesture, which is the
  drift the hook exists to prevent; the arithmetic is pinned through the hook instead (Task 2 test 4),
  which is reachable because the rect-override idiom is measured, not assumed. `lib/sessionRecency`
  is the counter-precedent and it is different: that module's functions have several legitimate
  callers, `moveId` has exactly one.
- **D7 — the hook calls `dataTransfer.setData` and never `getData`.** `setData` is required by
  Firefox to start a drag at all, so omitting it is a real-webview bug that jsdom cannot see — hence
  a test pinning the call (Task 2 test 2). `getData` is deliberately never read: the dragged id is
  held in state, this is a single-window app, and reading the payload would imply support for a
  cross-window drop nobody can serve. The minimum stub is therefore `{ setData }` alone.
- **D8 — spec hazard 1 (the tab pill) is NOT pinned in this task, and the reason is a TDD argument,
  not a seam excuse.** `SpaceTabs.tsx` is T07's seam and this task's DO-NOT-TOUCH list, but the
  deeper reason is that the pin cannot be RED here: `draggable` does not exist on the pill until
  T07 adds it, so `it("a left-drag on the tab pill does not close the tab")` written today would
  pass vacuously — a test certifying the absence of the mechanism, which is the failure mode this
  branch has already been bitten by twice (T03's vacuous `lastReason` fixture, T04's D3 deleted
  test). And the attribute half is **already pinned today**: `SpaceTabs.test.tsx`'s
  `it("the pill opts OUT of the window-drag region and leaves no slack above or below the label")`
  asserts `getAttribute("data-tauri-drag-region") === "false"`. So the attribute's existence is not
  at risk; what is at risk is that its SECOND reason (it is what lets a tab be dragged at all) goes
  undocumented. T07's exact instructions are in Out of scope, with the two `it(...)` strings to add
  and the one existing test whose comment must gain the second reason.
- **D9 — `overEdge` is exposed rather than a `className` or a boolean like `overIsBefore`.** The
  spec's indicator is `border-t-2` / `border-b-2` on the existing element, so the call site needs the
  edge, not a decision about classes — and `null` distinguishes "not a target" from "target, bottom
  half", which a boolean cannot. This is the whole of what T06 needs, which is why T06 adds ONE prop
  and no logic (see Out of scope).
- **D10 — Task 1 (the pair deletion) runs FIRST.** It is mechanical, independent, and every later
  test is then written against the final `SpaceView` shape instead of a shape that is about to lose
  two fields.

---

## Out of scope

- **`src/components/**` entirely — T06 and T07.** Concretely, what they add and T05 does not:
  - **T06 (sidebar rows):** the `useDragReorder` call site over `activeView.sessionIds` with
    `reorderSessions` as `onReorder`; spreading `dragProps(id)` onto `SessionListRow` (through
    `RowButton`'s existing `...rest`, so `RowButton.tsx` itself needs no change); **a NEW drop-edge
    prop on `SessionListRow`** — its props interface is fixed (`title`, `active`, `time`, `leading`,
    `actions`, `onOpen`) and accepts no className or extras, so the indicator prop is a widening of
    T06's own file, and T05 deliberately ships `overId` + `overEdge` so T06 needs zero logic
    (D9). This is the DECISION the brief asked for: **T05 does not touch `SessionListRow.tsx`.**
    Also T06's: `draggable={false}` on the hover actions (Stop / Archive / Unarchive / Delete), so a
    press on a destructive control never starts a drag; and the stale rail-pin citation T04 handed it.
  - **T07 (tabs):** `draggable` + the handlers on the pill; the indicator class; `draggable={false}`
    on the ✕; **the two hazard pins this task could not make red** — a new
    `it("a LEFT-drag started on the tab pill does not close the tab")` (red for T07 because the
    pill's `onMouseDown` closes on `button === 1` and returns early otherwise, so once `draggable`
    lands the non-interference becomes a real, falsifiable property) and an extension of
    `it("the pill opts OUT of the window-drag region …")`'s comment, which must gain the SECOND
    reason the attribute is load-bearing: it is no longer only "a control is not chrome", it is the
    thing that stops Tauri's injected drag script claiming the mousedown a tab drag needs. T07
    should extend that existing test rather than duplicate the assertion.
- **Any indicator rendering, any class, any DOM.** The hook returns state; nothing in this task
  draws an edge.
- **`src/lib/tauri/**` (T02, done) and every Rust file.** `reorderSessions` / `reorderSpaces` and
  their `{ ids }` / `{ paths }` wire keys already exist and are already pinned by
  `src/lib/tauri.test.ts`; the Rust commands already write the slice index inside one transaction.
  Done-when #6 proves the zero-Rust claim.
- **`src/App.tsx`** (no boot wiring; the drag's data comes from the existing boot payload) and
  **`src/test/resetStores.ts`** (no new state field, so `getInitialState()` covers everything for
  free — Task 3's `fixtures.test.ts` check is the proof).
- **Keyboard reordering.** HTML5 DnD is pointer-only; ADR 0075 records the gap and T08 writes it to
  `docs/features/manual-list-order.md`. This task does not add it and does not pretend otherwise.
- **The spec's §5 test #19 ("A rejected reorder refetches and the list snaps back")** is shipped as
  "logs and restores the previous slice, and the list snaps back" (D3). Amending the spec document
  is the orchestrator's, not a plan child's — record it in the status file's Decisions log with the
  transaction argument.
- **`docs/`** (T08 / the orchestrator), including this run's status file.

---

## Verification

Scoped first, then the gate. `npx vitest run <path>` scopes; `pnpm test -- <path>` does not.

    npx vitest run src/hooks/useDragReorder.test.tsx        # 0 → 10 (new file; 0 red-first: no module)
    npx vitest run src/store/sessions.test.ts               # 182 → 182 (T1) → 189 (T3) → 194 (T4)
                                                            #   T1: 8 red (3 "differing keys", 5 undefined reads)
                                                            #   T3: 7 red, T4: 5 red
    npx vitest run src/hooks/useWindowDropBackstop.test.ts  # 4, UNCHANGED (driven as a collaborator)
    npx vitest run src/components/SpacesList.test.tsx        # 79, UNCHANGED (no component is touched)
    npx vitest run src/components/SpaceTabs.test.tsx \
                 src/components/SpaceTabs.pill.test.tsx     # 34 / 4, UNCHANGED (T07 adds the wiring)
    npx vitest run src/components/SessionListRow.test.tsx \
                 src/components/RowButton.test.tsx          # 15 / 14, UNCHANGED — the byte-compare
                                                            #   serialisation proof: nothing moved
    npx vitest run src/lib/tauri.test.ts                    # 26, UNCHANGED and UNEDITED (no wrapper change)
    npx vitest run src/lib/sessionRecency.test.ts           # 7, UNCHANGED
    npx vitest run src/App.test.tsx src/test/fixtures.test.ts   # 41 / 25, UNCHANGED (no new state field)
    pnpm test                                               # 3070 → 3092, 149 → 150 files
    pnpm build                                              # green (tsc checks the .tsx test file too)

Scope proofs (repo root):

    git diff --name-only <T05-base>..HEAD | sort            # ONLY the four files in "Files outside the seam"
    git diff --name-only <T05-base>..HEAD | grep -c '^src-tauri/'      # 0  — NO RUST CHANGE
    git diff --name-only <T05-base>..HEAD | grep -c '^src/components/' # 0  — no component change
    grep -rniE "session|space" src/hooks/useDragReorder.ts             # 0 — the hook knows no list kind
    grep -nE "document\.|querySelector|classList|className|createElement" \
                                                             src/hooks/useDragReorder.ts   # 0 — renders/mutates nothing
    grep -n "stopPropagation" src/hooks/useDragReorder.ts              # 0 — spec hazard 2
    grep -rn "\.liveSessionIds\|\.storedSessionIds" src/               # 11 → 0 (the DEPRECATED pair, dead)
    grep -n "liveSessionIds: string\|storedSessionIds: string" src/store/sessions.ts   # 2 → 0 (the fields)
    grep -rn "T04 deletes\|T05 deletes" src/store/sessions.ts          # 2 → 0 (the stale promises die with them)
    grep -rn "\.liveSessionId\b" src/ | wc -l                          # 6, UNCHANGED — the live dot is intact
    grep -rn "sort_order" src/ | wc -l                                 # 0 — the SQL name never enters src/
    grep -rn "sortOrder" src/components/ | wc -l                       # 0 — no component reads the number
    grep -rln "sessionOrder" src/                                      # the SAME five files as before T05 —
                                                            #   useDragReorder.ts adds no hit (Done-when #8)
    grep -rn "reorderSessions\|reorderSpaces" src/components/          # 0 — the call sites are T06/T07's

From `src-tauri/` — once at the end, to prove the claim rather than assert it:

    cargo test               # 1463 passed / 0 failed, UNCHANGED
    cargo clippy --all-targets   # 0 warnings, unchanged
    cargo fmt --check        # clean

**The anti-vacuity check for this task, stated so a reviewer can run it:** the acceptance test is
Task 3 test 1. Its discriminating assertion is step (b) — reading `sessionIds` right after the drag
and before any re-derivation — because the array-only implementation T03 warned about leaves the
boot map stale and therefore answers the OLD order there. Step (c) (re-running `setHistorySessions`
with the ORIGINAL boot array) is the promise as T03 recorded it — a drag holds *across a
re-derivation* — and it is the step a future implementation could satisfy by accident while leaving
the map stale, so it stays. If an implementer reports this test passing against an implementation
that only reorders `historySessions`, they have written the wrong test: check that step (b) reads
`spaceViewFor`'s `sessionIds` rather than the store's array, because an assertion on the array itself
is the shape that passes for the stale-map implementation.

---

## Known limits this plan accepts

- **A dragged row's new number is client-side until the command lands, and the numbers a drag writes
  collide across Spaces by design.** A slice renumbered `0..n-1` reuses numbers another Space's rows
  already hold. It is safe because `mergeSessionOrder` is the only reader and it is only ever called
  with ONE Space's ids (verified by grep), and it is honest because `Db::reorder_sessions` does the
  identical thing — T01's own test shows a subagent row keeping its number while a reordered visible
  slice renumbers past it. Task 3 test 6 is the pin that keeps the per-Space-only comparison from
  being broken by a future wholesale-map write.
- **A row the DB renumbers mid-boot is still stale until restart** (T03's limit, unchanged by this
  task): a second Client, or a `record_session` collision, moves a number the boot map no longer
  reflects. A drag fixes only the slice it sends. There is no poll and no event, deliberately.
- **The store trusts its call site to send the whole visible slice** (D2). The consequences of a bad
  caller are exactly the half-moved list, and the only defences are a doc sentence and Task 3
  test 3's verbatim pin. The alternative — re-deriving the slice in the store — was rejected because
  it makes the store a second owner of "what is visible", which is the render layer's answer (the
  sidebar excludes archived rows; the tab strip excludes nothing).
- **Rejection restores rather than refetches** (D3), so a concurrent change made by another writer
  during a failed drag is invisible. It is the same class as the boot-snapshot limit above, and the
  rollback is still provably the DB's state because the command is one transaction. The spec's "logs
  and refetches" is amended, not silently dropped — see Out of scope.
- **Spec hazard 1 is handed, not pinned** (D8). If T07 forgets, nothing in the suite catches a tab
  that closes on a left-drag. The reason is stated in full so the omission reads as a decision: the
  pin cannot be red before the mechanism exists, and this branch has twice shipped tests that were
  born green for exactly that reason.
- **The hook is untested against a real browser drag.** Everything here is jsdom with hand-built
  events, and the three measured idioms (`dataTransfer` init, `Object.assign`-delivered `clientY`,
  the rect override) are what make that possible. Two consequences stay unproven locally: the native
  ghost image, and whether any webview reorders `dragleave`/`dragover` in an order jsdom never
  produces. Task 2 test 7 hardens the flicker case as far as an event-order assumption can be
  hardened in a unit test.
- **`dragProps(id)` returns fresh handler identities every render.** With five rows and a few tabs
  that is free. If either list ever becomes virtualised, this is the line to revisit — not a
  correctness limit today, and recorded so it is not discovered as a surprise.
- **`useDragReorder.test.tsx` is the first `.tsx` test under `src/hooks/`.** Forced by the hook's
  DOM contract (JSX in a `.ts` file fails the transform — measured), and it means the file drives a
  probe component rather than `renderHook`, which is the shape `ChatStream.test.tsx` already uses.
- **Five test files still say the store has "sixteen data fields"** (T03's D12; it is eighteen).
  This task adds no field, so the count does not move and the prose stays wrong for the same reason
  T03 left it: out of seam, prose only, and `resetStores.ts`'s discipline is that the field list
  lives in `getInitialState()` and nowhere else.
