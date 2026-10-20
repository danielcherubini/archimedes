---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/70
done-when: Hovering a LIVE session row in the sidebar reveals a Stop button and an Archive button where today it reveals nothing; Stop on a row whose turn is in flight cancels the turn and leaves the Session live; Stop on a live-but-idle row reaps the Worker and the row drops to stored; Archive on a live row flips the `archived` flag, closes the Session, and the row lands in the Archived section (openable, resumable, sticky) with no Rust change; and all of it is pinned by tests in `SpacesList.test.tsx` + `sessions.test.ts` on top of the existing `pnpm test` / `pnpm build` bar, with `cargo test` / `cargo clippy --all-targets` / `cargo fmt --check` still green on unchanged Rust.
---

# Sidebar session rows — Stop and Archive on live rows: Plan

**Status note (2026-10-20):** executed on branch `feature/70-sidebar-session-stop-and-archive`; the citations in this plan were re-checked against the post-feature tree, and they prefer SYMBOL anchors (`cancel_session`, `compact_session`, `on_session_exited_expected`) over plain line numbers, because line numbers drift with every commit and the ones left inside the task steps name the positions in the tree the plan was written against, not today's file. Read a bare `file.rs:NNNN` as approximate; the symbol is the address. The changes those steps describe have all landed.

**Goal:** Give a **live** session row in the left panel the two hover actions it has never had — **Stop** and **Archive** — where today only a *stored* row offers Archive and a live row offers nothing at all.

**Architecture:** Two new/changed **store actions** in `src/store/sessions.ts` (`archiveSession` widened to accept a live id and to close it *after* the flag commits; a new `stopSession` that cancels or closes based on `inTurn`), then one **render change** in `SessionRow` (`src/components/SpacesList.tsx`) that stops branching on `isLive` and renders the existing hover-swap for every row. The final task writes the two docs. **No Rust changes** — `close_session` already cancels an in-flight turn, and `handleSessionClosed` already honours the sticky archived flag.

**Tech Stack:** React 19 + TypeScript, zustand v5, Vitest + Testing Library, Tailwind v4. Validation bar from `AGENTS.md`: `pnpm test` / `pnpm build` at the repo root; `cargo test` / `cargo clippy --all-targets` / `cargo fmt --check` in `src-tauri/`.

**Branch:** create `feature/70-sidebar-session-stop-and-archive` from `main` before Task 1 (see the `gitflow-branching` skill — never branch from another feature branch; the checkout may currently sit on `feature/63-global-agent-overrides`).

**Issue:** https://github.com/danielcherubini/archimedes/issues/70 carries the approved spec (WHAT/WHY) this plan implements.

---

## The two facts that make this need no Rust change

Both are already true in the code today; the plan leans on them rather than replacing them.

1. **`close_session` already cancels an in-flight turn.** `SessionManager::close_session`
   (`src-tauri/src/agent/session/mod.rs:1885`) sets `cancel_requested = true` *before*
   the Worker detach, so the race between the router's `agent_settled` arm and the
   `Exited` teardown settles the turn `Cancelled` either way. Consequently **no branch of
   the design can leave a turn running.**
2. **`handleSessionClosed` already honours the sticky flag.** The `historySessions:` arm of
   `handleSessionClosed` (`src/store/sessions.ts`) refuses to append a closing Session to
   `historySessions` when its id is in
   `archivedSessions` (ADR 0016). This is why Archive is **flag-then-close**: the existing
   guard does the landing, and the row surfaces in the Archived section and nowhere else.
   Reversing the two races the async `session-closed` event against the store move and
   flickers the row through the Space group on its way out.

**One transient is expected — do not try to remove it.** Between the store move and the
arriving `session-closed`, the row still reads as a live row in its Space group, because
`ArchivedSection`'s live-id filter (`SpacesList.tsx`, the `visible` computation) keeps live
ids out of the Archived list — the existing test `"a live session that is also archived is
view-filtered out of the Archived section"` in `SpacesList.test.tsx` pins it. So the row
makes **one** visual move — out of the Space group and into Archived, at the moment it stops
being live — rather
than appearing in Archived and then again. Do not "fix" the gap by dropping the live-id
filter: that filter is what stops a resumed archived Session from rendering twice.

Also load-bearing and already true: `Db::set_session_archived`
(`src-tauri/src/storage/db.rs:522`) is an id-only `UPDATE` with no liveness condition, and
`record_session`'s upsert (`:330`) `DO UPDATE`s only `cwd` / `capabilities_json` /
`is_subagent` — **never `archived`** — so a later re-record on resume cannot clobber the
flag. Do not add a Rust-side liveness guard; there is nothing to guard.

## Decisions already made (do not re-open)

- **The hover-swap mechanism stays.** Buttons remain `hidden … group-hover:flex`; the
  relative time remains what the row shows at rest. The reported gap was that live rows
  have *no* buttons, not that the buttons appear on hover.
- **Accepted consequence:** `display: none` at rest means the row's buttons are **not
  keyboard-reachable**. True of Archive today; unchanged for Stop. Fixing it means moving
  the whole row set to `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`,
  which reserves the buttons' width at rest — deliberately out of scope.
- **Stop reads `inTurn` at CLICK time** (inside the store action), not the row's
  render-time status: paint and click are not the same tick. If the turn ended in between,
  `send_abort` is a documented no-op (`cancel_session`'s doc comment in
  `agent/session/mod.rs`, "a no-op if there is no in-flight turn") and a second click
  closes; if it started in between, `close_session` cancels it anyway (fact 1).
- **A Session parked on a gate stops by CANCELLING, not by being reaped.** `inTurn` is a
  superset of `running ∪ waiting`: a permission prompt or `ask` is held *inside* a tool
  execution, so the turn is open and the flag is set. That is the gentler and correct act.
- **A failed `closeSession` does not roll the flag back.** Archive's one job is hiding the
  Session from the next boot's list, and the DB flag has already achieved that. Log and
  carry on, matching `closeSpace`'s existing stance (`sessions.ts`, the `closeSpace` action).
- **`compacting` gets no branch of its own — and the two compaction kinds land on
  different Stop paths, which is fine.** A hand-triggered `/compact` runs on the loop's
  CONTROL channel *while the loop is idle* (`compact_session`'s doc comment,
  `agent/session/mod.rs`: "the composer is locked during a turn, so a hand-triggered
  compaction is always an idle action"), so `inTurn` is false there and Stop takes the
  **close** path — harsher than the Esc chord, which cancels a compaction too
  (`ChatStream.tsx:347` gates on `compacting` as well as `inTurn`). A `threshold` /
  `overflow` compaction happens *inside* a turn, so `inTurn` is true and Stop cancels. Both
  are acceptable: a close ends the Worker, and `handleSessionClosed` already clears
  `compacting` (its comment: the closing `compaction_update` may never arrive, and a
  lingering entry would pin `composerLocked`). Do not add a `compacting` branch to
  `stopSession` to make the two agree.
- **No Delete on live/stored rows** (ADR 0016's archive-first stance stands), and **the
  collapsed rail is untouched** — `SessionRail`'s marks stay `pointer-events-none` readouts.

---

## Parallelisation

**Verdict:** SERIAL — Task 2 consumes Task 1's store actions (gate 2: it calls
`stopSession` and the widened `archiveSession`), and Task 3 is deliberately last so the
glossary and the ADR describe **proven** behaviour rather than intended behaviour. Task 3's
files (`CONTEXT.md`, `docs/decisions/0016-…`) are disjoint from Task 1's, so it *could*
join a wave; it does not, for that reason, and because a doc written before the code is
green is a doc that can be wrong.

---

### Task 1: The two store actions — `archiveSession` accepts a live Session, and `stopSession` exists

**Parallel:** none — Task 2 calls both of this task's actions (gate 2), and Task 3 is held
back deliberately to document proven behaviour.

**Context:**
A live session row today has no action at all, and even if it did, `archiveSession`
(`src/store/sessions.ts`) would silently no-op: it returns early unless the id is in
`historySessions`, so a live id never reaches the backend call. This task makes the store
able to do the two things the row will ask for, and gets the ordering right — flag first,
close second — so the existing sticky guard in `handleSessionClosed` lands the row in the
Archived section by itself. Nothing here touches Rust: `set_session_archived` does not care
whether the Session is live, and `close_session` already cancels a running turn.

**Files:**
- Modify: `src/store/sessions.ts` (import block lines 3–18; `SessionsState` interface near line 276; the `archiveSession` action; add `stopSession` beside it)
- Test: `src/store/sessions.test.ts` (the `vi.mock("../lib/tauri")` factory at lines 40–69; the named `../lib/tauri` import list at 21–28; `describe("archivedSessions (sticky, ADR 0016)")` at line 2489; new `describe("stopSession", …)` beside `describe("closeSpace", …)` at line 2859)

**What to implement:**

**a) Imports — `src/store/sessions.ts:3`.** Add `cancelSession as cancelSessionCommand` to
the `../lib/tauri` import block. The list is alphabetical by imported name, so it goes
**before** `closeSession as closeSessionCommand`. `closeSessionCommand` is already imported.

**b) `archiveSession` — widen the guard and append the close.** Current head of the action:

```ts
const entry = get().historySessions.find((s) => s.sessionId === sessionId);
if (!entry) return;
await setSessionArchivedCommand(sessionId, true);
set((state) => { /* … */ });
```

Change it to:

```ts
const before = get();
const entry =
  before.historySessions.find((s) => s.sessionId === sessionId) ??
  before.sessions.find((s) => s.sessionId === sessionId);
if (!entry) return;
const wasLive = before.sessions.some((s) => s.sessionId === sessionId);
await setSessionArchivedCommand(sessionId, true);
set((state) => { /* … EXACTLY the existing body — do not touch it … */ });
```

- The `set` body stays **byte-identical**. Its existing re-validation already distinguishes
  gone / live / stored, and its existing "append `entry` to `archivedSessions`, deduped"
  works for a live `entry` — that is what the current `"sticky live"` test at line 2600
  proves. Do not "improve" it.
- Capture `wasLive` **before** the `await`, and append after the `set`:

```ts
if (wasLive) {
  // Archive means "put this away", and a live Session is not away while its
  // Worker runs. The order is the whole design: the flag is committed and the
  // lists moved FIRST, so when `session-closed` lands, `handleSessionClosed`'s
  // sticky guard (its `historySessions:` arm refuses to file a closing archived Session
  // under `historySessions`) is what lands the row in `archivedSessions` alone.
  // Close-first would race the async event against the store move and flicker
  // the row through the Space group.
  // Best-effort like `closeSpace`: a mid-await delete makes this
  // `UnknownSession`, and the DB flag has already done Archive's one durable
  // job — hiding it from the next boot — so a failure is logged, not thrown,
  // and the flag is NOT rolled back.
  await closeSessionCommand(sessionId).catch((err) => {
    console.error(`failed to close the archived session ${sessionId}:`, err);
  });
}
```

- A rejection from `setSessionArchivedCommand` must still propagate (unchanged behaviour —
  the row logs it). Only the close is swallowed.
- **`wasLive` is captured BEFORE the `await` on purpose — do not "fix" it by re-reading
  after the `set`.** The existing `"an archive that lands after a resume … (sticky live)"`
  test (line 2600) seeds `historySessions` only, so at click time the id is NOT live; a
  resume then wins the race. `wasLive === false` there, so **no close is sent** — the
  Session stays live and archived, which is exactly what that test asserts
  (`sessions` still contains `s1`). Re-reading liveness after the `set` would close a
  Session the user never clicked Archive on. Leave the capture where it is.
- **A double-click archives once, and the second close is a silent no-op.** Both invocations
  see `wasLive === true`, both commit the flag (the existing `set` dedupe keeps
  `archivedSessions` correct), and the second `close_session` SUCCEEDS having done nothing:
  its guard is the Rust `live` map, and `live.remove` happens only in the router's
  expected-exit teardown (`on_session_exited_expected`), which the Worker's `Exited`
  frame drives: it lands as soon as the Worker exits — the normal case, a Worker that
  honours `close`, publishes `Exited` in milliseconds / a few ticks — so a real
  double-click still finds the `live` entry, misses on `detach` (the Worker is already
  detached), and returns `Ok(())`. That is `close_session`'s documented "idempotent close".
  So there is NO rejection and NO log line for a double-click; the `.catch` above stays quiet.
  A rejection appears when the second close arrives after that teardown has run and
  the `live` entry is gone → `UnknownSession` → logged. (The 2 s in `reap_worker`
  is the TIMEOUT ceiling for a Worker that ignores `close` and has to be `kill`ed — the
  worst case — not a fixed delay the teardown waits behind.) Neither outcome is a
  defect to fix with new de-duplication state. The existing `"archiveSession is idempotent
  under concurrent invocation"` test seeds a STORED row, so `wasLive` is false there and the
  test never reaches the close at all — it stays green unchanged.

**c) `stopSession` — a new action.** Declare it on `SessionsState` immediately after
`unarchiveSession` (line 278; `archiveSession`'s declaration sits just above it at 276), with a doc comment that names both effects, the click-time
read, and why the race is safe:

```ts
  /**
   * Stop ONE Session (the sidebar row's Stop button). TWO effects, decided here
   * at CLICK time from `inTurn` — never from a render-time status, because paint
   * and click are not the same tick:
   *  - a turn in flight → `cancelSession`: the Worker is kept, so the Session is
   *    immediately re-promptable. A Session parked on a gate is HERE too (a gate
   *    is held INSIDE a tool execution, so `inTurn` is set), and reaping a Worker
   *    mid-tool is a harsher act than the button appears to be;
   *  - live and idle → `closeSession`: the Worker is reaped and `session-closed`
   *    drops the row to stored (the transcript survives — a close is a pause).
   * The race is harmless in both directions, which is what makes ONE button
   * honest: a turn that ended in between makes `send_abort` a documented no-op
   * (`cancel_session`'s doc comment, `agent/session/mod.rs`) and a second click
   * closes; a turn that started in between is cancelled by `close_session` regardless
   * (`:1885` sets `cancel_requested` before the detach). No branch of Stop can leave a
   * turn running.
   * A no-op for a non-live id. Rejections propagate — the row logs them.
   */
  stopSession: (sessionId: string) => Promise<void>;
```

Implementation, placed next to `archiveSession`:

```ts
stopSession: async (sessionId) => {
  const state = get();
  if (!state.sessions.some((s) => s.sessionId === sessionId)) return;
  if (state.inTurn[sessionId]) {
    await cancelSessionCommand(sessionId);
    return;
  }
  await closeSessionCommand(sessionId);
},
```

**d) Test scaffolding — `src/store/sessions.test.ts`.** The `vi.mock("../lib/tauri")`
factory (lines 40–69) mocks `closeSession` but **not `cancelSession`**; the real wrapper
would `invoke` and reject in jsdom (there is no global Tauri mock). Add inside the factory:

```ts
// `stopSession` cancels an in-flight turn with this.
cancelSession: vi.fn().mockResolvedValue(undefined),
```

and add `cancelSession` to the named import list at lines 21–28 (next to `closeSession`).
`SessionInfo` fixtures come from the existing `info(sessionId, cwd)` helper (line 76).

**Do NOT run the full `pnpm test`** — this file's suite is large; the steps below scope it.
There is no Prettier/ESLint config in this repo, so there is **no formatter step** for
TypeScript; `pnpm build` (`tsc && vite build`) is the type gate.

**Steps:**
- [ ] In `src/store/sessions.test.ts`, add the `cancelSession` mock to the factory and to the import list.
- [ ] In `describe("archivedSessions (sticky, ADR 0016)")`, add a test
      `"archiveSession on a LIVE session sets the flag, moves the row, and closes it — in that order"`:
      seed `useSessions.setState({ sessions: [info("s1", "/x")] })`, call
      `await useSessions.getState().archiveSession("s1")`, then assert
      `setSessionArchived` was called with `("s1", true)`;
      `closeSession` was called with `"s1"`;
      `archivedSessions` contains `s1`; and the **flag precedes the close** via
      `vi.mocked(setSessionArchived).mock.invocationCallOrder[0] < vi.mocked(closeSession).mock.invocationCallOrder[0]`
      (precedent for that assertion: `SpacesList.test.tsx:1014`).
      Then call `useSessions.getState().handleSessionClosed("s1", "user")` and assert
      `historySessions` does **not** contain `s1` while `archivedSessions` still does —
      that pair is the proof the ordering is load-bearing, not decorative.
- [ ] Add `"a failed close still leaves the session archived"`: arm
      `vi.mocked(closeSession).mockRejectedValueOnce(new Error("gone"))`, install a
      `console.error` spy (`vi.spyOn(console, "error").mockImplementation(() => {})`),
      `await archiveSession("s1")` on a live seed, and assert the flag call happened,
      `archivedSessions` contains `s1`, the promise did not reject, and the spy was called.
      Restore the spy (`spy.mockRestore()`) in the test body — the file has no file-scope
      restore, unlike `SpacesList.test.tsx`.
- [ ] Extend the existing `"archiveSession is a no-op for an unknown id"` test to also
      assert `closeSession` was **not** called.
- [ ] Add `describe("stopSession (the sidebar row's Stop button)", …)` after
      `describe("closeSpace", …)`. **Call `vi.mocked(closeSession).mockClear()` and
      `vi.mocked(cancelSession).mockClear()` at the top of each test** — this file clears
      mocks only inside some describes (lines 2872, 3393), so call counts otherwise leak
      from earlier tests and an assertion about "not called" can pass or fail on test order.
      Three tests:
      1. live + `inTurn: { s1: true }` → `cancelSession` called with `"s1"`, `closeSession`
         not called, and `s1` still in `sessions`;
      2. live + `inTurn: {}` → `closeSession` called with `"s1"`, `cancelSession` not called;
      3. `historySessions: [info("h1", "/x")]` and `archivedSessions: [info("a1", "/x")]`,
         nothing live → `stopSession("h1")` and `stopSession("a1")` call neither command.
- [ ] Run `pnpm test src/store/sessions.test.ts`
      - Did the new tests FAIL — the live-archive ones with "closeSession … not called"
        (the action still returns early for a live id) and the `stopSession` ones with
        `stopSession is not a function`? If they passed, stop and investigate — the test is
        not yet asserting the new behaviour.
- [ ] Implement (a), (b), (c) in `src/store/sessions.ts`.
- [ ] Run `pnpm test src/store/sessions.test.ts`
      - Did every test in the file pass, including the pre-existing
        `"archiveSession is idempotent under concurrent invocation"`,
        `"a delete that completes mid-archive-await leaves no ghost row"` and
        `"an archive that lands after a resume … (sticky live)"`? Those three are the
        regression risk of widening the guard — a red there means the `set` body was
        changed, and it must not be.
- [ ] Run `pnpm build` — must succeed (`tsc` catches the new interface member being
      unimplemented, and the unused-import rule `noUnusedLocals`).
- [ ] Commit: `git add src/store/sessions.ts src/store/sessions.test.ts && git commit -m "feat(sessions): archive a live Session stops it, and stopSession stops one row"`

**Acceptance criteria:**
- [ ] `archiveSession` on a live id calls `set_session_archived(id, true)` **before**
      `close_session(id)`, moves the id into `archivedSessions`, and leaves `sessions`
      untouched (the close event does that).
- [ ] A `close_session` rejection is logged and leaves the flag committed; the returned
      promise still resolves.
- [ ] `archiveSession` on an id in none of the three lists still calls nothing.
- [ ] `stopSession` branches on `inTurn` alone, is a no-op when the id is not live, and
      propagates rejections.
- [ ] No file under `src-tauri/` is modified.

---

### Task 2: The row's right slot — Stop + Archive on a live row

**Parallel:** none — calls Task 1's `stopSession` and its widened `archiveSession`
(gate 2), and shares no file with Task 3 only by luck of the tree.

**Context:**
`SessionRow` today branches: a stored row renders the hover-swap (time → Archive), and a
live row renders `rightSlot` alone with the comment *"Live row: NO hover action (the pause
concept is gone — the session is never paused from the UI)"* — true of Pause, but it left
the live row with no way to be stopped or put away short of opening it. This task removes
the branch so **every** row gets the swap, and chooses the button set from the row's state.
`ArchivedSessionRow` (Unarchive + Delete) already uses the identical mechanism and is not
touched. The state comes from the row's existing `useSessionStatus` mark plus a direct
`inTurn` read, so the tooltip and the action agree on the same field the store reads.

**Files:**
- Modify: `src/components/SpacesList.tsx` (`SessionRow` at line 815, its doc comment at 795–814, and the `lucide-react` import at 9–20)
- Test: `src/components/SpacesList.test.tsx` (mock factory lines 93–170; re-arm block in the `beforeEach` at 361; `describe("SpacesList (archive, ADR 0016)")` at 1708, existing tests at 1731 and 1751)

**What to implement:**

**a) Import the glyph.** Add `SquareIcon` to the `lucide-react` import list (alphabetical,
between `SparklesIcon` and `Trash2Icon`). It is already used by `WindowControls.tsx`, so the
"stop" square is an established glyph in this app — do not invent a new one.

**b) In `SessionRow`, read the turn flag once more** (next to the existing
`const status = useSessionStatus(sessionId);`):

```ts
// The SAME field `stopSession` reads at click time — so the tooltip's promise and
// the action's effect cannot disagree just because a render happened in between.
const inTurn = useSessions((s) => !!s.inTurn[sessionId]);
const stopSession = useSessions((s) => s.stopSession);
```

**c) Replace the `isLive ? rightSlot : <>…</>` block** (lines 902–928) so every row renders
the swap. Keep `rightSlot` exactly as it is defined today (the time, or an empty `size-4`
slot) — the time stays what the row shows at rest:

```tsx
{/* Every row — live or stored — swaps the time for its actions at hover. The
    live row used to render the time with no swap at all: the Pause button was
    deleted and nothing replaced it, so a running Session had no way to be
    stopped or put away without opening it first. */}
<span className="group-hover:hidden">{rightSlot}</span>
{isLive && (
  <button
    type="button"
    title={inTurn ? "Stop this turn" : "Stop this session"}
    aria-label={`Stop ${title}`}
    onClick={(e) => {
      e.stopPropagation();
      void stopSession(sessionId).catch((err) => {
        console.error("Failed to stop session:", err);
      });
    }}
    className="hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover"
  >
    <SquareIcon className="size-4" />
  </button>
)}
<button
  type="button"
  title="Archive"
  aria-label={`Archive ${title}`}
  onClick={(e) => {
    e.stopPropagation();
    void archiveSession(sessionId).catch((err) => {
      console.error("Failed to archive session:", err);
    });
  }}
  className="hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover"
>
  <ArchiveIcon className="size-4" />
</button>
```

- Order is **Stop then Archive**: the irreversible-ish action innermost, matching the
  Archived row's Unarchive-then-Delete order.
- Reuse the existing class string verbatim — do not introduce a variant; the two buttons
  must be pixel-identical to the Archived row's.
- `isLive` stays as it is defined (`useSessions((s) => s.sessions.some(…))`) — it now selects
  the button *set* instead of selecting whether a swap exists.

**d) Rewrite `SessionRow`'s doc comment** (lines 795–814). It currently states *"Hover swaps
it for an Archive button (stored sessions, reversible — no confirm; live rows have no hover
action — the pause concept is gone)."* Replace that clause: every row swaps; a live row
offers Stop (`inTurn` → cancel the turn, else close the Session) then Archive; a stored row
offers Archive alone. Keep the rest of the comment (the mark, the fade mask, the "Waiting
pill is gone" paragraph) — those still hold.

**Do NOT** add Delete to either row kind, **do NOT** touch `ArchivedSessionRow` or
`ArchivedSection`, and **do NOT** touch `SessionRail` / `railIds` — the rail stays a
readout, and a row leaving the list is already reflected because `railIds` derives from
live + stored ids.

**e) Test scaffolding — `src/components/SpacesList.test.tsx`.** The `vi.mock("../lib/tauri")`
factory (lines 93–170) mocks **neither** `closeSession` nor `cancelSession`; the real
wrappers would `invoke` and reject in jsdom. Add to the factory:

```ts
// The row's Stop button: cancel a turn, or close the Session.
closeSession: vi.fn().mockResolvedValue(undefined),
cancelSession: vi.fn().mockResolvedValue(undefined),
```

Add both to the named import list at the top (lines 3–13), and add them to the existing
re-arm `beforeEach` (line 361; the re-arms sit at 381–390) alongside `setSessionArchived` / `deleteSession`:

```ts
vi.mocked(closeSession).mockReset().mockResolvedValue(undefined);
vi.mocked(cancelSession).mockReset().mockResolvedValue(undefined);
```

That re-arm is not optional: the file's own comment there records that `clearAllMocks`
clears call records but leaves `…Once` arms and bare overrides alive into the next test.

**Steps:**
- [ ] Add the mocks, imports and re-arms described in (e).
- [ ] In `describe("SpacesList (archive, ADR 0016)")`, add a small local helper that scopes
      a query to ONE row, and use it in every new test below — a row is itself
      `role="button"` and its inner buttons carry `aria-label`s, so a whole-document
      `getByRole` with a loose regex can match the row as well as the button:

      ```tsx
      const rowOf = (text: string): HTMLElement =>
        within(screen.getByText(text).closest('[role="button"]') as HTMLElement);
      ```

      (The `.closest('[role="button"]')` pattern is the file's own — see lines 528, 570, 596.)
- [ ] Add `"a live in-turn row offers Stop and Archive, and Stop cancels the turn"`:
      the file's `seed()` fixture already gives live `s1` `inTurn: { s1: true }` and the
      message text `"Fix the login bug"`, so `render(<SpacesList />)` then
      `fireEvent.click(rowOf("Fix the login bug").getByRole("button", { name: "Stop Fix the login bug" }))`
      must yield `expect(cancelSession).toHaveBeenCalledWith("s1")` and
      `expect(closeSession).not.toHaveBeenCalled()`.
- [ ] Add `"a live idle row's Stop closes the Session"`: after `render`,
      `useSessions.setState({ inTurn: {} })`, click the same Stop, assert `closeSession`
      called with `"s1"` and `cancelSession` not called.
- [ ] Add `"Archive on a live row sets the flag then closes the Session"`: click
      `rowOf("Fix the login bug").getByRole("button", { name: "Archive Fix the login bug" })`
      and assert `setSessionArchived` was called with `("s1", true)`, `closeSession` with
      `"s1"`, and the flag call's `invocationCallOrder` precedes the close's.
- [ ] Add `"a stored row offers no Stop button"`: the same fixture's stored `h1` has the text
      `"Refactor the parser"`; assert
      `rowOf("Refactor the parser").queryByRole("button", { name: /^Stop / })` is `null`
      while its `Archive Refactor the parser` button exists. Scoping to the row matters —
      `s1` is live in the same render and does have a Stop.
- [ ] Rewrite the existing test at line 1751,
      `"a live row offers no hover action (the pause concept is gone — the time slot is always shown)"`.
      Keep its Pause assertion (`queryByRole("button", { name: /Pause/ })` is still `null`)
      and **invert** its Archive assertion (it currently expects `null` — that is the
      behaviour this feature removes). Give the replacement a name that records the change,
      e.g. `"a live row offers Stop and Archive, and still no Pause (the pause concept is gone)"`.
- [ ] Run `pnpm test src/components/SpacesList.test.tsx`
      - Did the new tests fail with "Unable to find an accessible element with the role
        button and name `Stop …`" and did the rewritten line-1751 test fail on the Archive
        lookup? If the new ones passed before implementing, stop and investigate.
- [ ] Implement (a)–(d) in `src/components/SpacesList.tsx`.
- [ ] Run `pnpm test src/components/SpacesList.test.tsx`
      - Did everything pass — in particular the pre-existing `"a stored row offers an
        Archive hover action that archives it"` (line 1731, must stay green: a stored row
        must still issue no `closeSession`), the Archived-section tests
        (`/Unarchive/`, `/Delete/`), and the collapsed-rail test that counts
        `session-rail-actions` buttons?
- [ ] Run `pnpm test` — the whole suite once here, since this task is the one that changes
      rendered DOM other files' tests may touch (e.g. `SidePane.test.tsx`, `SpaceTabs.test.tsx`).
      Any red must be fixed before continuing.
- [ ] Run `pnpm build` — must succeed.
- [ ] Commit: `git add src/components/SpacesList.tsx src/components/SpacesList.test.tsx && git commit -m "feat(sidebar): Stop and Archive on live session rows"`

**Acceptance criteria:**
- [ ] Hovering a live row reveals `Stop` + `Archive`; hovering a stored row reveals `Archive`
      and nothing else; hovering an Archived row is unchanged (Unarchive + Delete).
- [ ] The relative time is still what every row shows at rest, on all row kinds.
- [ ] Stop's `title` reads `Stop this turn` while `inTurn` is set and `Stop this session`
      when it is not.
- [ ] Neither button triggers the row's own click-to-open (`stopPropagation` on both).
- [ ] `ArchivedSessionRow`, `ArchivedSection`, `SessionRail` and `src/lib/leftPaneState.ts`
      are untouched.
- [ ] Manual pass (the sequence no test can see): start a Session, run a turn, hit Stop
      mid-turn → row stays live and the composer unlocks; hit Stop again at idle → the row's
      mark goes to the stored ring; hit Archive → the row moves to the Archived section;
      reopen it from there and send → it resumes; after that resume it is still listed as
      archived once it closes.

---

### Task 3: The docs — the glossary's "Archived session" and ADR 0016

**Parallel:** none — held after the code on purpose, so the glossary and the ADR describe
what the tests proved instead of what was intended. Disjoint files from Tasks 1–2
(`CONTEXT.md`, `docs/decisions/…`), so the ordering is a judgement, not a gate.

**Context:**
`CONTEXT.md`'s **Archived session** entry states flatly that *"Archiving is a view property,
not a lifecycle one."* After Tasks 1–2 that is true of a **stored** Session (a flag, nothing
else) and false of a **live** one, whose Archive now reaps its Worker. ADR 0016 has the same
blind spot, plus a consequence line that has been **factually wrong since Pause was
deleted** — it reads *"a live row's hover action stays Pause"*. Both need to match the code
in this same change: the repo's rule is that durable decisions live in `docs/decisions/` and
that the glossary is the shared language, and a glossary describing unshipped behaviour is
the exact "code disagrees with CONTEXT.md" hazard the `discuss` skill exists to prevent.
This task is inspection-only — **no test in this repo reads `CONTEXT.md` or
`docs/decisions/`** (verified: the only test that reads repo files for content is
`src/lib/paletteCompleteness.test.ts`, and it reads `src/`), so there is nothing to write
failing first. That is why this task has no TDD steps.

**Files:**
- Modify: `CONTEXT.md` (the **Archived session** entry, lines 79–81 — the entry text is line 80)
- Modify: `docs/decisions/0016-session-archive-first-delete.md` (append an Amendment section)

**What to implement:**

**a) `CONTEXT.md`, the "Archived session" entry.** Replace the sentence
*"Archiving is a view property, not a lifecycle one: …"* so the two cases are separated, and
keep every other clause of the entry (transcript kept, still openable/resumable, **sticky**,
Delete only from the Archived section). The replacement must say:

- for a **stored** Session, archiving is a *view* property — the flag alone;
- for a **live** Session it is also a lifecycle action: `archiveSession` closes the Session
  after committing the flag, so its **Worker** is reaped (ADR 0016 amendment) — and the
  **sticky** rule means the flag survives the resume that follows;
- keep the `_Avoid_` line as it is.

**b) ADR 0016 — append, do not rewrite.** Follow this repo's amendment convention (see
`0025-sessions-in-worker-processes.md` and `0040-…`: the original text stands as written,
and an `## Amendment (date) — <one-line summary>` section at the end carries the change; the
ADR is **not** superseded and its front-matter `status: accepted` is unchanged). The section
must state:

- Archive on a **live** Session now also **stops** it, and the order is **flag-then-close** —
  because `handleSessionClosed` (`src/store/sessions.ts`, the `historySessions:` arm) already refuses to file a
  closing archived Session under `historySessions`, so committing the flag first is what lets
  that existing guard land the row in the Archived section; close-first races the async
  `session-closed` event and flickers the row through the Space group;
- the live row's **Stop** button means cancel-while-a-turn-is-in-flight, close-while-idle,
  and the branch is safe because `close_session` sets `cancel_requested` before the detach
  (`src-tauri/src/agent/session/mod.rs:1885`), so no branch leaves a turn running;
- the Consequences bullet *"Live sessions are never archived: a live row's hover action stays
  Pause; pause → stored → archive is the two-step path"* **no longer holds** — Pause has been
  deleted from the UI, and live sessions are now archived directly. Name it as corrected here
  rather than editing the original bullet;
- Delete stays out of reach of a single misclick: still only from the Archived section.

**Steps:**
- [ ] Read `docs/decisions/0025-sessions-in-worker-processes.md`'s `## Amendment (2026-10-18)`
      section and copy its shape (heading carries the date and the summary; the body says
      what changed and what stands unchanged).
- [ ] Apply (a) to `CONTEXT.md`. Re-read the entry: the words *view property* must now be
      explicitly scoped to a stored Session.
- [ ] Apply (b) to `docs/decisions/0016-session-archive-first-delete.md`, dated 2026-10-20 or
      the day the commit lands.
- [ ] Verify by inspection, both greps:
      `grep -n "view property" CONTEXT.md` shows the narrowed sentence, and
      `grep -n "Amendment" docs/decisions/0016-session-archive-first-delete.md` shows the new
      section. No command proves these are *correct* — re-read both against the code.
- [ ] Run `pnpm build` — cheap, and it confirms nothing in `src/` referenced these files.
- [ ] Commit: `git add CONTEXT.md docs/decisions/0016-session-archive-first-delete.md && git commit -m "docs: archive on a live Session also stops it (ADR 0016 amendment + glossary)"`

**Acceptance criteria:**
- [ ] `CONTEXT.md` no longer claims archiving is never a lifecycle action.
- [ ] ADR 0016 keeps its original text and its `status: accepted`, and carries an Amendment
      section that corrects the stale Pause consequence.
- [ ] Both documents match what Tasks 1–2 actually shipped — including the flag-then-close
      ordering and the file:line references above (re-verify the line numbers against the
      tree at commit time; they may have shifted).

---

## Final verification (whole change)

From the repo root: `pnpm test` and `pnpm build`.
From `src-tauri/`: `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`.
**No Rust file is modified by this plan** — a red in the Rust bar means an unrelated
breakage, exactly as `AGENTS.md` describes for the frontend bar.
