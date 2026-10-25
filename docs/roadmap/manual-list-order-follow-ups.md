---
status: approved
---

# Manual list order — the things it does not fix

Follow-ups to `manual-list-order.md` (the `sort_order` columns, `recencyOf`,
`useDragReorder` and the two optimistic reorder actions). Every item below was
found while building this feature, or handed to the last task by the loop's
status file, and deliberately NOT fixed by it. None blocks the merge. They are
recorded here because `finish` deletes the whole `manual-list-order-*` roadmap
family on ship — spec, status file and task plans alike — and anything left
undone dies with it unless it is written down here or in
`docs/features/manual-list-order.md` first.

**Citations name symbols and `it(...)` strings, never `file:line`** — a line
number re-drifts on the next commit and a stale one points a reader at the wrong
code.

**Measured at `e923a7f`, not carried over from the status file.** Two of the
candidates this file was handed came out different against the tree, and the
tree won: the shiki flake's test name (its real name comes from an `it.each`, so
the status file's version never existed as written) and the count of hand-written
reset helpers in `App.test.tsx` (the file's own comment says nine; HEAD has ten).
One candidate was **checked and dropped rather than padded in**: "Windows
behaviour is not behaviourally verified from this machine" does not apply to this
feature, because the Rust it touched contains no `#[cfg(windows)]` surface at all
— `grep` for it across `storage/db.rs`, `commands/history.rs`, `commands/spaces.rs`
and `storage/mod.rs` returns zero hits, and the branch's Rust diff adds and
removes no `cfg` attribute anywhere. The migration, both seeds and both reorder
commands are plain ungated SQL, and the 22 new `#[test]`s this branch adds to
`db.rs` live in that file's own ungated `mod tests`, so they compile and run on
every platform including CI's `windows-latest` leg. The one platform-gated thing
the branch touched is `tests/ipc.rs`'s whole-file
`#![cfg(target_os = "linux")]`, which predates this feature; the new
`the_list_order_commands_resolve_through_the_real_ipc_surface` inherits it, which
is a limit of that harness, not a Windows behaviour claim. So there is no Windows
path here for CI to be the sole witness of, and the item is dropped rather than
restated.

---

## 1. A keyboard user cannot reorder either list

**Status: accepted gap, not open work — recorded so it is not re-litigated.**

Both lists reorder through native HTML5 drag-and-drop, which is pointer-only. A
keyboard user can reach and activate a row or a tab (`RowButton` emits
`role="button"` + `tabIndex={0}` and fires on Enter) and can close a tab, but has
**no path at all** to change an order. The consequence is not cosmetic: the order
a keyboard-only user lives in is the upgrade seed plus whatever a pointer user
dragged, and nothing in the app tells them the list is reorderable in the first
place.

The alternative was considered and rejected during the design discussion, and the
rejection is worth keeping with the gap: **up/down buttons** are trivially
testable and keyboard-accessible, and were declined because they are two more
hover controls competing with Stop / Archive / Delete on a row in a 260px pane
(`LEFT_PANE_WIDTH`). If the gap is ever closed, that is the shape to reopen, and
the write side is already gesture-free — `reorderSessions` and `reorderSpaces`
take a plain array of ids/paths and know nothing about pointers, so the work is
an affordance and its tests, not a new write path.

The gap is stated in three places on purpose (`docs/features/manual-list-order.md`,
ADR 0075's Consequences, and `SpaceTabs.tsx`'s header) because a single
mention in a deleted plan is how it would have been lost.

## 2. `manual-list-order-status.md`'s Blockers section points at THIS file

**Status: recorded so nobody "fixes" it.**

The loop's status file carries `Blockers / open questions: Empty. See
docs/roadmap/manual-list-order-follow-ups.md …`. After ship that reference
resolves to nothing, because `finish` deletes both the status file and this one
in the same step — which is correct, not dangling. Do not "repair" the pointer by
moving it, and do not keep either file alive to make it valid. The durable half of
this feature lives in `docs/features/manual-list-order.md` and ADR 0075, which are
not deleted; this file is the open-work half, and if any item below is still open
when it is read, the right move is to file it, not to resurrect the roadmap.

## 3. `App.test.tsx`'s `vi.mock` factory spreads `importActual`, so an un-mocked boot fetch reddens the whole file

**Status: open hazard, cheap to close, and this feature is the reason it is now a trap.**

`App.test.tsx` mocks the whole IPC surface with `const actual = await
vi.importActual("./lib/tauri"); return { ...actual, listSessions: …, listSpaces:
… }`. Spreading `importActual` means **any export the factory does not name keeps
its real implementation**, and the real one calls `invoke`, which rejects in jsdom
(`window.__TAURI_INTERNALS__` is undefined). That is fine for a noisy log line and
fatal for a boot fetch: `App`'s boot effect runs
`Promise.all([listSessions(true), listSpaces(), sessionRecency()])`, and if any
member rejects the whole `Promise.all` rejects into a `.catch` that only
`console.error`s. So `setHistorySessions`, `setSessionRecency` and `setSpaces`
never run, every test lands `activeSpacePath: null`, and the failures look nothing
like the cause.

This feature put the third fetch in that array, and the mock is now load-bearing
for the Landing Session: `setSpaces` runs `autoSelectActive`, which decides where
boot lands from the recency map, so the map has to be filled before it — pinned by
`it("boot fetches sessionRecency alongside listSessions and listSpaces and fills
both maps before setSpaces runs")`.

**The trap for the next person:** a fourth boot fetch, added to `App.tsx` without
a matching line in this file's factory, reddens this file — and the count is not
small. `App.test.tsx` holds **41 tests** at HEAD (measured: vitest reports `src/
App.test.tsx (41 tests)`), and the in-file comment's "~40 reds, none of them about
recency" is the same claim; treat it as the file's own estimate rather than a
figure anyone has measured per-cause.

**What it would cost:** one line, whenever the next fetch is added — but only if
the person adding it knows. Closing the hazard properly means either failing
loudly instead of silently (a `.catch` that rethrows, or a boot-effect test that
asserts `setSpaces` ran, which would turn the next omission into one red test with
the right name), or dropping the `importActual` spread in favour of an explicit
factory so an un-mocked export is `undefined` and throws at the call site instead
of quietly rejecting. The second is the honest fix and is a rewrite of this file's
top block, which is why it was not folded into a docs task.

## 4. `App.test.tsx` still resets the stores by hand, in helpers that cannot know about new fields

**Status: open, and this feature widened it by two fields.**

`src/test/resetStores.ts` exists precisely to end this class of leak: its header
records that a hand-written key list names "the keys it happens to remember" and
that everything else leaks from one case to the next inside a file. `App.test.tsx`
does not import it. Measured at HEAD the file carries **ten** hand-written
`clearStores` / `clearStore` helpers, **seven** of which write a `useSessions` key
list by hand, and **none** of them routes through `resetStores()`. (The comment
`App.test.tsx` itself carries says "nine of them, none importing
`src/test/resetStores.ts`"; that was true of the file this feature inherited and
is one short of HEAD, because the boot-recency `describe` this branch added
started a tenth.)

This feature added **two** store fields those lists can strand — `sessionRecency`
and `sessionOrder`. Exactly one of the seven names them (the boot-recency
describe's own `clearStore`); the other **six** clear `sessions`,
`historySessions`, `archivedSessions`, `spaces`, `messages` and the two ids, and
leave both maps standing. So a test in one of those six describes that seeds a
recency or order map hands it to every later test in the file, and the next such
test's expectation is being set by its predecessor. That is the leak
`resetStores()` installs the whole captured state to prevent, and it is invisible
until two tests in the same file disagree about a map.

**What it would cost:** mechanical but not trivial — replace the **seven**
helpers' `useSessions.setState({ … })` blocks with `resetStores()`, keeping the
non-store lines each one also does (the `useSubagents` / `useInteractive` /
`usePermissions` `dismiss*` calls, `useSubagentSelection.select(null)`, the
`vi.mocked(externalOpen).mockClear()` in the anchor describe). The other **three**
of the ten touch no `useSessions` key at all, so they are not this item's problem
and should stay exactly as they are. One commit, and it wants a run of this file
alone afterwards — a reset that is a whole-store replace can surface an order
dependency the file currently relies on without knowing it.

**Evidence:** the helpers are the `const clearStores = () => {` /
`const clearStore = () =>` declarations inside each `describe`; the rule they
should follow is `resetStores`'s own header, including its three explicit
limitations (no merge, no module-scope state, no pane/dialog flags — those are
`resetModuleFlags()`).

## 5. The shiki/`MessageBubble` flake needs an owner

**Status: NOT this feature's; recorded here because the loop adjudicated it and nothing else owns it.**

`MessageBubble.codeblock.test.tsx`'s `renders a \`JSON\` fence genuinely
highlighted, with the lowercased label` failed once during this feature's tab-strip
task. Two corrections to how the status file recorded it, both measured:

- **The name.** It is an `it.each(["TypeScript", "JSON", "python"])` case, so the
  test's real name is the formatted template `renders a \`%s\` fence genuinely
  highlighted, with the lowercased label` and the failing instance is the `JSON`
  one. The status file's shorter form never existed as written. (The file holds 25
  tests, not the 23 `it(` sites suggest, because that `it.each` contributes three.)
- **The claim that it is not ours, re-verified at HEAD.** The branch diff against
  `main` touches **zero** files matching `MessageBubble`, `shiki` or `markdown`, in
  either language. This feature changed two read queries' `ORDER BY`, one store
  derivation, one drag hook and two list components; it has no path to syntax
  highlighting.
- **Isolation:** `npx vitest run src/components/MessageBubble.codeblock.test.tsx`
  → 25 passed / 1 file, measured again for this document. The loop's own count was
  25/25, and two full runs after the failure were green; this document's own full
  run is green too.

So it is a pre-existing flake outside every seam in this feature, and the shape
fits the usual one for this file (a highlight that renders asynchronously against
an assertion that can run first) — but that is a hypothesis, not a diagnosis:
nothing here reproduced it even once. **What it needs is an owner**, not a
drive-by fix from a branch that cannot reproduce it and must not be blamed for
it. Whoever takes it should start from the `it.each` above and the other tests in
that file that assert on a rendered `pre.shiki` element, since whatever makes one
of them slip makes all of them able to.

## 6. `sessionOrder` (and `sessionRecency`) are boot snapshots, and the staleness is user-visible

**Status: deliberate, and someone may eventually have to pay for it.**

`sessionOrder` is written by exactly two things: `setSessionRecency` at boot, and
`reorderSessions` when the user drags. There is no poll, no `session-recency`
event, and no refresh on any other path — `mergeRefreshedSessionRows` merges
`contextUsage` and `configOptions` only and deliberately touches neither map. That
was the accepted design (a refetch is a wider mutation than the one being undone,
which is also why the rollback restores a snapshot instead), and it is what keeps
boot at three IPC round-trips.

The consequence, stated as the user sees it: anything that renumbers a row while
this app is running is invisible until the next restart. Two concrete cases —
a **second Client instance** sharing the same database, and a `record_session`
collision on an id this app already has (`record_session`'s `ON CONFLICT … DO
UPDATE` never renumbers, deliberately, so the row keeps its number; but a row
another writer created while this app sat open has no entry in this app's map and
therefore sorts to the bottom regardless of where its number puts it). The same
staleness applies to the recency half: a Session that became the most recent by
some other route is not the Landing Session until the next boot, because
`selectSpace` / `autoSelectActive` / `spaceViewFor` read the boot map plus whatever
transcripts are loaded in this window.

**What it would cost:** a refresh path that is narrower than a boot. The minimum
honest version is re-running `sessionRecency()` (one command, one round-trip) on
the events that plausibly mean "someone else moved something", then feeding it to
`setSessionRecency` — which is safe today, since it replaces both maps wholesale
and `mergeSessionOrder` re-derives every Space from them. The hazard to design
around is a refresh landing **between a drag's optimistic write and its command
resolving**: it would replace a map the drag had just written and undo the user's
drag on screen, so it needs to respect the same publish epoch the rollback already
compares. That is the reason this is a follow-up and not a line.

## 7. Three `describe` blocks assert store state without resetting it first

Found in the full-branch review, by running the suite under
`vitest --sequence.shuffle`. `src/store/sessions.test.ts`'s
`it("(a) stores a user message with image attachments")` fails under any order
that puts it after a test that wrote `messages.s1` — it asserts
`toHaveLength(1)` on a map it never clears. Its `describe` has no `beforeEach`
reset, and neither do two neighbours.

**This is not this feature's.** `origin/main` has the identical structure,
byte-identical in the same three blocks — verified by extracting the file at
`origin/main` and reading the same `describe`. It is recorded here only because
this loop's review is what found it, and the roadmap family dies on ship.

**Latent, not live.** Nothing runs the suite shuffled — no `shuffle` in
`vitest.config.*`, `package.json`, or `.github/workflows/` — so `pnpm test` is
green and has been. The cost is real but unpaid: 27 of that file's 37 `describe`
blocks do not call `resetStores()`, so today's green depends on file order, and
the next test added to the wrong block inherits state and passes for a reason
nobody intends. That is the exact failure class `src/test/resetStores.ts` exists
to close, and its own header says a caller adding a partial reset re-introduces
the hazard.

**What it would cost.** Per-`describe` `resetStores()` in the ~27 blocks, then
re-run green — mechanical, but it touches a large file at once and each block
needs a look to confirm it was not *relying* on inherited state (the interesting
case: if a block passes only because a neighbour dirtied the store, that block
was never testing what it says). Worth doing as its own change, with the shuffle
flag left OFF, so any ordering dependence it exposes is triaged rather than
blindly reset. Verify with `npx vitest run src/store/sessions.test.ts
--sequence.shuffle` at several `--seed` values, not one.
