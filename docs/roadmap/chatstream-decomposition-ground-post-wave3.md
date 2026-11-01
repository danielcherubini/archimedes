---
status: grounding-report
area: chatstream-decomposition
wave: post-wave-3 delta
branch: feature/chatstream-decomposition
code-head: bab6d68a
trees-read:
  - src/components/ChatStream.tsx (704)
  - src/components/ChatStream.test.tsx (6286)
  - src/hooks/useChatSessionDerivations.ts (98)
  - src/lib/chatSessionDerivations.ts (137)
  - src/hooks/useChatAttachments.test.tsx (947)
  - src/hooks/useChatPromptDispatch.test.tsx (621)
  - src/hooks/usePromptQueueFlusher.test.tsx (740)
  - src/lib/tauriBarrel.test.ts (the mock-seam pin)
  - docs/roadmap/chatstream-decomposition-status.md
  - docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md (probe matrix appendix)
---

# chatstream-decomposition — POST-WAVE-3 GROUNDING DELTA (for wave 4: D1 + D2)

Read-only grounding report. The two wave-4 planners' reports describe the tree at `0aa99ffb`
(D1's annexes) or `b0071544`/earlier (D2's scaffolding report), and wave 3 moved ~500 lines out of
`ChatStream.tsx` (1488 → 704) and 854 lines out of `ChatStream.test.tsx` (7140 → 6286). This report
re-measures the current tree at code HEAD `bab6d68a` (branch tip `8013fc42` is the wave-3 status doc
commit; `git log` tip of the branch is `8013fc42` · "docs: record wave 3 of chatstream-decomposition
(task04)", code HEAD `bab6d68a` · "refactor(chatstream): extract prompt dispatch + queue flush …").
Every number below was re-derived from the tree; nothing was taken from the older reports.

---

## 1. `ChatStream.tsx` as it stands now

### 1.1 Size and comment/code split

`wc -l src/components/ChatStream.tsx` → **704**. My comment-stripping scan:

```
blanks=18 comments=399 code=287 total=704
```

So the caller's split — **399 comment lines / ~287 code / 19 blank** — is **verified within one
line-classification edge**: the file has **18 blank lines**, not 19 (the caller's "19" and mine differ
by exactly one blank-vs-classification boundary; the comment/code pair is exact). The file still
carries a trailing newline and ends with `}`.

### 1.2 Structural map (all line numbers at `bab6d68a`)

| Landmark | Line |
|---|---|
| `const activeSessionId = useSessions((s) => s.activeSessionId)` | 50 |
| `messages` (selector + `?? []` OUTSIDE the selector) | 53–55 |
| `inTurn` | 57 |
| `stopReason` | 58 |
| `prompts` | 59–61 |
| `useChatSessionDerivations()` destructure **closing** | 81 |
| `agentState` (`useInteractive`) | 95–96 |
| `const workingOrInTurn = agentState === "working" \|\| inTurn` | 98 |
| `compacting` | 108 |
| `spinnerStyle` (`normalizeVariant(useSettings…))` | 115–116 |
| `emptyStateAnimation` | 126–127 |
| `mcpMentionsEnabled` | 156–157 |
| `const composerLocked = workingOrInTurn \|\| agentState === "blocked" \|\| compacting !== undefined` | 171–172 |
| `useSpinQuip(workingOrInTurn)` | 177 |
| `useHasPendingRequest()` | 206 |
| `useChildGates(activeSessionId)` | 217 |
| `draft` / `error` cells | 219–220 |
| `sendingSessionsRef` | 234 |
| `activeSessionIdRef` (+ re-sync) | 241–242 |
| `draftRef` (+ re-sync) | 248–249 |
| `useChatAttachments({…})` destructure **closing** | 275 |
| `const hasImages = attachments.length > 0 && imageCapable` | 298 |
| Esc `useEffect` | 306–324 |
| `prevSessionIdRef` + session-change `useEffect` | 330–340 |
| `useWindowDropBackstop()` / `useAutoGrowComposer(composerRef, draft)` | 350–351 |
| `useActiveSpaceCwd()` | 379 |
| `useMentionCatalogs(spacePath)` | 382 |
| `const [picker, setPicker] = useState<MentionPickerState \| null>(null)` | 398 |
| `activeRemainder` / `outside` | 407–408 |
| `const dirPrefix = outside ? dirPartOfOutsideQuery(activeRemainder) : null` | 438 |
| `useCompletionDir(dirPrefix)` | 446–447 |
| `useMentionPicker({…})` | 463–478 |
| history-pagination derivation | **482–486** |
| `flushRef` | 493 |
| `useChatPromptDispatch({…})` **call** (open) | 510 |
| `composerLocked` passed as an **argument** | 516 |
| `usePromptQueueFlusher({…})` **call** | 531 |
| `useSessionIdleEdge({ busy: composerLocked, key: …, onIdle: () => flushRef.current() })` | 547–551 |
| `if (!activeSessionId)` early return | **553** |
| `const units = groupConsecutiveFileWrites(messages)` | 600 |
| `return ( … )` render block | **602** |

### 1.3 Source ORDER of the four extracted hook calls (the order the derived names depend on)

```
  81  } = useChatSessionDerivations();
 275  } = useChatAttachments({   // opened at ~263
 510  const { sendText, send } = useChatPromptDispatch({   // opened at ~509
 531  usePromptQueueFlusher({    // opened at ~530
```

Plus the two earlier unconditional hooks `useHasPendingRequest()` (206) and `useChildGates(activeSessionId)`
(217), `useSpinQuip` (177), `useActiveSpaceCwd` (379), `useMentionCatalogs` (382), `useMentionPicker`
(463), and the effect/state hooks (`useWindowDropBackstop` 350, `useAutoGrowComposer` 351). The four
**extracted** hooks are therefore reached at 81 → 275 → 510 → 531, exactly the caller's stated order,
and the `useSessionIdleEdge` call sits at **547**, with the `!activeSessionId` early return at **553**
and the render at **602**. Good.

The dispatch block's own comment records the order rule (lines ~505–509):

> Source ORDER matters: dispatch first (it produces `sendText`), then the
> flusher (it consumes `sendText` and takes over `flushRef`), then the edge
> (it consumes the ref) — the same "declared after `sendText` so it closes over
> it" order the moved code depended on.

---

## 2. D1's actual target — the derivation logic still in the component

### 2.1 `composerLocked` chain (the load-bearing comments, quoted in full)

**`workingOrInTurn`** (lines 88–98):

```ts
  // The interactive agent state for the active session. `inTurn` is the
  // ground truth for "a turn is in flight" (set by `beginTurn`, cleared
  // by `turnCompleted`) — a STALE `idle` from the previous turn must
  // not unlock the composer or hide the working indicator, so `inTurn`
  // wins alongside `working` (the store does not reset `agentState` on
  // `turnCompleted` — a store follow-up; an agent that hasn't
  // pushed yet is covered the same way: its turn IS in flight).
  const agentState = useInteractive((s) =>
    activeSessionId ? s.agentState[activeSessionId] : undefined,
  );
  const workingOrInTurn = agentState === "working" || inTurn;
```

**`composerLocked`** (lines 160–172):

```ts
  // A `blocked` agent is mid-turn AWAITING a request response
  // (`inTurn` is true) — the SEND must stay disabled for the whole wait
  // (pre-branch, `main`'s composer locked on `inTurn`): the harness is
  // one-turn-at-a-time (a prompt while a turn is in flight is REJECTED,
  // not queued — `send_prompt`'s atomic `pending_turn` claim), so sending
  // concurrently would fail + clobber the turn bookkeeping. The TEXTAREA
  // is always editable (you can draft while the agent works — `send()`'
  // `composerLocked` guard no-ops Enter, the draft is kept for when the
  // turn ends). (`agentState === "blocked"` also covers a blocked state
  // without an in-flight turn, where `inTurn` alone would not lock.)
  // A compaction locks for the same reason: the harness is one-turn-at-a-time
  // and a prompt racing the rewrite would be rejected (or reorder history).
  const composerLocked =
    workingOrInTurn || agentState === "blocked" || compacting !== undefined;
```

### 2.2 The "coupling the Flush trigger" reason — RULED OBSOLETE, seam now exists

The wave-1 grounding report's recorded reason for leaving this chain in the component was that moving
it would "couple the Flush trigger (Task C1's seam)". **C1 has LANDED** (code HEAD `bab6d68a`):

- `useChatPromptDispatch` is called at line 510, and `useChatPromptDispatch.ts` **receives
  `composerLocked` as an `UseChatPromptDispatchArgs` field**: the call site passes
  `composerLocked,` at line **516** (verified in the diff hunk `@@ -493,12 +485,57 @@` which adds the
  `composerLocked,` line inside the new dispatch call).
- `useSessionIdleEdge` receives it too, as the `busy` arg: line **548** `busy: composerLocked,`.

So the Flush seam is now **an explicit argument seam** (dispatch and edge both take `composerLocked`
as a parameter). The original reason for the in-component placement — that a hook-extracted
`composerLocked` could not reach the Flush trigger without coupling the two — **no longer holds**:
both consumers already receive the value as a plain argument, and nothing else reaches into the
component for it. Moving the chain into `useChatSessionDerivations()` is now a pure re-wiring of the
two call sites (which D1 owns) with zero new coupling.

**It is even in scope in the right place already:** `useChatSessionDerivations()` is called at line 81,
&gt;&gt;before&lt;&lt; `useSpinQuip(workingOrInTurn)` at line 177 — so a value returned from
`useChatSessionDerivations()` (e.g. a `composerLocked` and a `workingOrInTurn`) is in scope at the
177 call, exactly where `useSpinQuip`'s argument needs it. No ordering problem.

### 2.3 Every consumer of `workingOrInTurn` / `composerLocked` (checked one by one)

| Consumer | Line | Kind |
|---|---|---|
| `useSpinQuip(workingOrInTurn)` | 177 | hook argument |
| `composerLocked` derivation itself | 171–172 | reads `workingOrInTurn` |
| `useChatPromptDispatch({… composerLocked …})` | 516 | hook ARGUMENT |
| `useSessionIdleEdge({ busy: composerLocked, … })` | 548 | hook argument |
| `<MessageList … workingOrInTurn={workingOrInTurn} …>` | 643 | JSX prop |
| `<ComposerRow … composerLocked={composerLocked}…>` | 686 | JSX prop |
| `<ComposerRow … workingOrInTurn={workingOrInTurn}…>` | 690 | JSX prop |

Five of the seven consumers (spin-quip is a hook argument, the two JSX props, and the derivation
itself) are inside the component; the two extracted hooks receive it as an argument. Moving the chain
upstream therefore changes exactly the two argument sites (516, 548) plus the two JSX props (643, 686)
and the 177 call — all reachable from a hook-returned value at line ~81.

### 2.4 The history-pagination derivation (lines 482–486) — pure over a store slice, moved card

```ts
  const history = useSessions((s) => activeSessionId ? s.history[activeSessionId] : undefined);
  const loadOlder = useSessions((s) => s.loadOlderHistory);
  const hasMore = history?.hasMore ?? false;
  const loadingMore = history?.loadingMore ?? false;
  const generation = history?.generation ?? 0;
```

This is a **pure** read over the `sessions` store slice: it reads `history[activeSessionId]` and the
`loadOlderHistory` action, then derives three booleans/number with the `?? false` / `?? 0` fallbacks
placed OUTSIDE the selector (consistent with the house selector-stability rule). Its consumers are
entirely in the render: `<MessageList>` receives `hasMore`, `loadingMore`, `generation` (lines
~649–651), and `onStartReached={() => { if (activeSessionId) void loadOlder(activeSessionId); }}`
(~652–655). Nothing outside the component touches any of the five names. This is the other genuinely
movable derivation — a `historyDerivations({ history, loadOlder })`-shaped pure function in
`lib/chatSessionDerivations.ts` (or a `useChatSessionDerivations`-returned field) would carry it
verbatim, and the `onStartReached` closure would read it from the hook's return. **Caveat:** D1 must
keep `loadOlder`, the store action, available for the `onStartReached` closure — if the hook returns
only `hasMore`/`loadingMore`/`generation`, `loadOlder` stays a component selector (harmless: it is a
stable store reference, not a hook).

### 2.5 Anything ELSE that is genuinely derivation rather than wiring? (honest answer: ~not much)

Reading the 287 code lines, the remaining candidates are:

- `hasImages = attachments.length > 0 && imageCapable` (298) — **already a pure one-liner with a
  comment recording why it moved UP into the unconditional block** ("Moved UP into the unconditional
  block (issue #135 §2) because it is now a `useChatPromptDispatch` argument"). It is a derivation,
  but it is also consumed by three argument/JSX sites inside the component; worth flagging as a
  "could fold into the hook, but the `composerLocked`/`hasImages` argued-in place is already
  recorded" — D1 should NOT touch it (the comment is itself the recorded decision).
- `units = groupConsecutiveFileWrites(messages)` (600) — a **pure function of messages already**, and
  its consumer is the single `MessageList units` prop. This is a candidate, but it is a plain
  function call, not a session derivation — moving it buys nothing unless D1 is about to make
  `messages` itself hook-owned (it isn't).
- The picker's `dirPrefix`/`outside`/`activeRemainder` — **explicitly NOT to move (see §3).**

Everything else in the 287 code lines is wiring: refs, effects, the two hook calls, props, the early
return. So the honest answer to "anything else?" is: **the composer-lock chain (§2.1) and the
history-pagination slice (§2.4) are the two real targets; `hasImages` and `units` are derivations but
have recorded reasons to stay exactly where they are.**

---

## 3. What D1 must NOT extract — the `dirPrefix` pin (quoted in full, mutation-checked)

The picker region (the `useCompletionDir`/`useMentionPicker` half, ~379–487) carries a **recorded
decision** that `dirPrefix` deliberately lives in the component. Quoted in full (lines ~385–399):

```ts
  // Declared HERE rather than inside `useMentionPicker` below, and the reason is
  // a CYCLE with only one honest way out: `dirPrefix` — the completion catalog's
  // CACHE KEY — is a pure function of `picker`, the completion payload is a
  // function of `dirPrefix`, and the rows memo is a function of the payload. If
  // the `useState` lived in the hook, the caller would need a value the hook
  // returns in order to build an argument the hook takes. The alternatives are
  // worse: reading the payload through a ref inside the memo would hide it from
  // the dep graph (and `completion` in those deps is mutation-checked — dropping
  // it reddens the two descent-goes-live tests), and moving `dirPrefix` into the
  // hook is the pin `ChatStream.test.tsx` forbids at component level. So the
  // cell is declared here, passed in, and handed back out — the same shape as
  // `draft`/`setDraft`, and still exactly ONE state cell.
```

and the completion-key comment (lines ~411–438), which contains the exact pin text the caller quoted:

```ts
  // The remainder up to and INCLUDING its last `/` — the DIRECTORY part
  // (`~/.config/ht` → `~/.config/`, `~/notes` → `~/`, `/etc/pas` → `/etc/`,
  // `C:/Users/you/pro` → `C:/Users/you/`). Every outside remainder has ≥1 `/`
  // (the root alternation in `FILE_ABSOLUTE_TOKEN_RE` requires one), so
  // `lastIndexOf` never misses. This value is the catalog's CACHE KEY, which is
  // why it is the directory and NOT the whole remainder: typing inside one
  // directory then changes only the SEGMENT, so the key is stable and exactly
  // ONE directory read happens per directory — the property the one-directory
  // peek is budgeted on. Pinned in `ChatStream.test.tsx` at THIS derivation (a
  // hook-level caching test cannot prove it: with `dirPrefix` as an argument the
  // hook only shows "same input, same output"), and mutation-checked — passing
  // `token.remainder` here reddens that test. `null` when not outside, which
  // maps to the hook's `__global__` key and the command's `None` arm (no
  // filesystem access at all).
```

**Re-extracting `dirPrefix` into a hook would break that mutation-checked pin** — the pin's premise
is that the derivation happens at component level where `ChatStream.test.tsx` can observe the exact
`dirPrefix` value feeding the cache. Calling a hook that takes `(outside, activeRemainder)` and
returns the same value would look to the test like "same input, same output" and the pin loses its
mutation-detecting power. D1 must leave `dirPrefix`, `activeRemainder`, `outside`, `picker`/`setPicker`
and the `useCompletionDir` call exactly as they are. The `useMentionPicker` call above them is
similarly a recorded Phase-D extraction with its own comment.

### 3.1 Diff evidence that the picker region and the render block are untouched by waves 1–3

- **Picker region vs baseline (`27cec040`, the wave-1 base):** the only content change in the
  379–487 window is the `useMentionPicker({…})` argument block at waves 1–2 (`useChatAttachments`
  threading), shown by `diff of base 399–470 vs current 397–470`:
  - one comment line group moved one line earlier (the "three lines, a pure function of `picker`"
    comment, lines ~460–462 — a reflow, same words);
  - the `useMentionPicker({ draft, setDraft, draftRef, composerRef, picker, setPicker, skills,
    agents, …` argument list is IDENTICAL;
  - `dirPrefix`, `activeRemainder`, `outside`, `useCompletionDir`, the `picker` cell, and every
    comment in the window are **byte-identical** to `27cec040`.
  The wave-2→wave-3 (0aa99ffb→bab6d68a) diff in that window is **zero hunks** (hunk list: `-6,8`,
  `-16`, `-20,7`, `-28`, `+26,2`, `-51,10`, `-95,7`, `-236`, `+284,15` at 299, `-489,2`/`+492` /
  `+494,45` — the last two are the dispatch/flusher insertion at ~489–537, NOT the picker, and the
  `-519,546` / `+562` big block starts past line 560).
- **Render block:** `diff of base 1386–1488 (27cec040) vs current 602–704` is **byte-identical
  (exit 0, zero lines)** — the render from `const units` through `return (…) };` has not changed in
  any wave. `git diff -U2 27cec040..bab6d68a -- src/components/ChatStream.tsx` shows no hunk whose
  post-image lines fall in 602–704 (`+560` max post-line of the big deletion hunk, `+586` of the
  stageFiles hunk's tail; `-1151,228 +585,10` deletes, it doesn't touch 602+).

So the caller's "picker region has had only ONE changed hunk since baseline and the render block
ZERO" is **verified**: one re-flow hunk in the picker's comment/args (waves 1–2), zero in the render.

---

## 4. The `useChatSessionDerivations` surface as it is now (D1 extends, not duplicates)

**`src/hooks/useChatSessionDerivations.ts`** (98 lines) — the full return block, verbatim:

```ts
  return {
    askRequests,
    confirmRequests,
    passwordRequests,
    anchoredAskRequestIds: anchored,
    stackedAskRequests: stacked,
    isLive: kind.isLive,
    isHistoryOnly: kind.isHistoryOnly,
    canResume: kind.canResume,
    composerEnabled: kind.composerEnabled,
    imageCapable,
    lastUserIndex,
    turnDiffs: diffs,
  };
```

There is **no exported `UseChatSessionDerivations` type** in the repo today (grepped
`src/` + `docs/` — zero hits). The hook's return type is inferred; D1 can either add the type in the
same file (matching the `UseChatAttachmentsResult` / `UseChatPromptDispatchResult` precedent the two
child hook files established — both export `type UseChat*Result` and `ChatStream.test.tsx`'s
stays-side does not import them, but the hook test files do) or keep it inferred. The published names
are exactly: `askRequests, confirmRequests, passwordRequests, anchoredAskRequestIds, stackedAskRequests,
isLive, isHistoryOnly, canResume, composerEnabled, imageCapable, lastUserIndex, turnDiffs`.

**`src/lib/chatSessionDerivations.ts`** (137 lines) exports exactly **5 pure functions** (all
`export function`, verified by grep):

1. `classifyInteractiveRequests(requests)` → `{ askRequests, confirmRequests, passwordRequests }`
2. `anchoredAskRequestIds(askRequests, messages)` → `Set<string>`
3. `stackedAskRequests(askRequests, anchored)` → `InteractiveRequestData[]`
4. `sessionKindDerivations({ liveSession, activeSessionIsKnown, activeCapabilities })` →
   `{ isLive, isHistoryOnly, canResume, composerEnabled }`
5. `turnDiffs(messages)` → `{ lastUserIndex, turnDiffs }`

So D1's pure-module target already exists and is the right home for the two §2 candidates: a pure
`composerLocked` can be added either as a new export in `chatSessionDerivations.ts` (it needs
`workingOrInTurn`, `agentState`, `compacting` — three inputs, trivially pure) or folded into the hook.
**The pin to respect:** `ChatStream.test.tsx`'s component-level pins on `dirPrefix` (§3) are the only
mutation-checked pins in this file; the derivation family already HAS its own test homes — both
`src/lib/chatSessionDerivations.test.ts` (230 lines) and `src/hooks/useChatSessionDerivations.test.ts`
(233 lines) exist at HEAD (wave-1 output; the hook file explicitly carries "NO `vi.mock` of any
kind — the same posture the closest house-style precedents"). D1's new pure functions for
`composerLocked`/`workingOrInTurn` and the history slice should be unit-pinned in
`lib/chatSessionDerivations.test.ts` and, if the hook exposes them, extended in
`hooks/useChatSessionDerivations.test.ts` — matching the 5-function pure module shape. Note the hook
test's `it("the NO-SESSION state derives everything empty/false and does not throw")` — a D1 change
to the hook's return must keep the no-session frame returning stable values (the same constraint the
component's `?? false`/`?? 0` fallbacks give the history slice today, §2.4).

---

## 5. D2's target — the residual `ChatStream.test.tsx` (6286 lines, 215 tests)

### 5.1 The 8 top-level `describe` blocks (current spans, counts — verified)

| # | `describe` title (exact) | Start line | Span (lines) | `it(`-lines | 1-run `it.each` rows → executed tests |
|---|---|---|---|---|---|
| 1 | `"ChatStream"` | 230 | 3486 (230–3715) | **149** | +1 (`it.each` at 3205, 3 rows → 3 tests, not 1) ⇒ **150** |
| 2 | `"ChatStream — out-of-Space Directory completion (ADR 0035)"` | 3716 | 1609 (3716–5324) | 34 | 0 ⇒ **34** |
| – | (nested) `"the picker's two filters (substring for Mentions, subsequence for both ? arms)"` | 5116 | 208 | 4 | 0 ⇒ 4 (counted INSIDE block 1's slot; indented 2 spaces, so not top-level) |
| 3 | `"ChatStream (a child gate renders inline in the PARENT's transcript)"` | 5325 | 340 (5325–5664) | 13 | 0 ⇒ **13** |
| 4 | `"ChatStream (a child gate scrolls into view)"` | 5665 | 173 (5665–5837) | 3 | 0 ⇒ **3** |
| 5 | `"ChatStream — the [image #N] staging marker"` | 5838 | 169 (5838–6006) | 6 | 0 ⇒ **6** |
| 6 | `"ChatStream — the failed-send attachment restore"` | 6007 | 86 (6007–6092) | 1 | 0 ⇒ **1** |
| 7 | `"ChatStream — staging attachments is allowed while a turn is in flight"` | 6093 | 128 (6093–6220) | 4 | 0 ⇒ **4** |
| 8 | `"ChatStream — the empty-state film beside a non-empty prompt queue"` | 6221 | 66 (6221–6286) | 2 | 0 ⇒ **2** |

**Test totals reconciled:** raw `it(`-lines = **217** across the file (`awk '/^[ \t]*it\(/ {c++}'`),
of which **212 are plain `it(` and exactly 1 is the `it.each`** (line 3205, 3 rows). Executed test
count = `212 + 3 = 215` — **exactly the caller's "215 tests"**. Block sums from the table:
149+1+34+13+3+6+1+4+2 = **215**. The wave-1 scaffolding report's recorded "214→215" style note
("ChatStream.test.tsx alone must read 215" from task04's plan) is satisfied: there are no
`it.skip`/`describe.skip`/`it.only`/`xit` markers anywhere in the file (grepped: the only matches
are the words `it.each`'s comment and prose). The file's `beforeAll`/`beforeEach` produce no
discipline discrepancy.

(Note for the caller: the scaffold report's pre-wave counts — block 1 150→150 stayed, block 2 34,
child-gate 16→13? — differ slightly from THIS table because the /compact (7), locked-fork (9) and
Flush (13) blocks plus their 4 local helpers moved OUT in wave 3 (net 29 tests despite block-1
holding some moved stays). The 8-block table above is the current truth.)

### 5.2 Module-scope scaffolding every split file would need

The file still holds, all at module scope (lines 1–228):

- **`beforeAll(() => { … })` at line 86** — the object-URL pair + the three `HTMLElement.prototype`
  stubs (own-property override for `scrollIntoView` plus `hasPointerCapture`/`setPointerCapture`/
  `releasePointerCapture`). Its comment (§"KEPT, and neither is redundancy") documents that
  `setup.tsx` stubs `URL` API and `Element.prototype` only, so the object-URL pair and the
  `HTMLElement` trio are file-owned dependencies, not duplicates.
- **`vi.mock("../lib/tauri", async () => { … })` at line 96** — the FULL open factory (17+ named
  overrides, spreads `vi.importActual`).
- **`vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }))` at
  line 186** — the closed factory.
- **`beforeEach(() => { … })` at line 190** — `vi.useRealTimers()`, `setSidePaneCollapsed(false)`,
  `localStorage.clear()`, the `useQueuedPrompts.getState().clearSession(id)` loop, `vi.clearAllMocks()`,
  `clearSkillCatalogCache()`, `clearMentionCatalogsCache()`, `resetStores()`.

Every block seeds store state inside each test via `seedLiveSession()`/`seedLiveSessionWithImages()`/
`seedStoredSession()`/`seedArchivedSession()` (module imports from `../test/chatStreamFixtures`), and
calls `render(<ChatStream />)` per test — so the fixture seeds travel as imports, but the four
module-scope items above (both `vi.mock` factories, `beforeAll`, `beforeEach`) are per-file
requirements for ANY split file that renders `<ChatStream />` in jsdom.

### 5.3 The `vi.mock` constraint — CAN the factories be shared across split files?

**No. Each split `.test.tsx` file must carry its own verbatim copy of both factories + `beforeAll` +
`beforeEach`.** This is decided by the probe matrix in the scaffolding report's appendix
(`docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`, "Appendix — `vi.mock`
hoisting probe matrix (measured on this tree, vitest 5.0.0)"), reproduced here in substance:

| Factory location | Helper module | Import order | Result |
|---|---|---|---|
| `vi.mock` CALL inside an imported module | — | — | ❌ transform refuses to rewrite it |
| test file, delegates to helper | helper imports the mocked module directly | helper after target | ❌ `Cannot access '__vi_import_N__' before initialization` |
| test file, delegates to helper | helper reaches it **transitively via a store** | helper after target | ❌ same error — the store path does not save you |
| test file, delegates to helper | helper clean (no path to mocked module) | helper **before** target | ✅ |
| test file, delegates to helper | helper clean | helper after target | ❌ |
| **factory stays INLINE in the test file** (references only `vi`), seeds moved to a module that reaches the mocked module via a store | — | target first | ✅ |

The rule it establishes:

> a `vi.mock` factory may reference only bindings whose module is BOTH free of any
> transitive import of the mocked specifier AND imported before anything that imports it. Two
> silent conditions; violating either fails as **0 tests run** with a `ReferenceError` pointing at
> an import line, not at the mock.

Applying it to a **shared** factory module (e.g. `src/test/chatStreamTauriMock.ts` exporting a
function that calls `vi.mock`): the first probe row ❌ ("`vi.mock` CALL inside an imported module —
transform refuses to rewrite it") kills that shape outright. Applying it to a **shared helper that
the factory calls** (helper exports `installTauriMock()` invoked from inside each file's factory):
the helper would either (a) import nothing and be "clean" — then the *factory* still cannot be
hoisted without being a `vi.mock` call in the module, and a helper-called `vi.mock` is still the
row-1 ❌; or (b) import the mocked module directly → row-2 ❌; or (c) reach it transitively via a
store (`settings.ts` imports `lib/tauri`) → row-3 ❌. The probe explicitly measured the store path
and it failed. The only ✅ rows are exactly the shape the file has today: factory **inline in the
test file**, referencing only `vi`, with all *seeds* in a separate module (`chatStreamFixtures.ts`,
imported before the target — a store-seeding module, not a factory-delegation target).

**Conclusion (decides D2):** the two `vi.mock` factories, the `beforeAll` and the `beforeEach`
cannot be shared across split files by ANY module indirection that the probe matrix measured — each
split file must carry them verbatim. The only things that CAN be shared are the fixture/seeds module
(`src/test/chatStreamFixtures.ts`, already extracted in task02) and any pure-helper module that
imports neither the barrel nor anything that transitively reaches it — **and `chatStreamFixtures.ts`
itself is on the failing side of the probe**: its own header (lines ~10–26, quoted below) records
that it DOES have a transitive path into the barrel through its imports of `useSettings` and
`useSessions`, whose stores both import `../lib/tauri` — it keeps working today only because the
`vi.mock` factories stay INLINE in the test file and are never delegated to it:

> DO NOT call `vi.mock` from this file, and DO NOT move the `vi.mock` factories
> here: `vi.mock` hoists per module — a factory body may reference only
> bindings whose module is BOTH free of any transitive import of the mocked
> specifier AND imported before anything that imports it. This module imports
> `useSettings` and `useSessions`, whose stores both import `../lib/tauri`, so
> it HAS a transitive path INTO the mocked barrel: a factory delegated here
> fails as 0 tests run (`Cannot access '__vi_import_N__' before
> initialization`). … The only barrel binding this module needs — `listSkills` for
> `waitForCatalog` — is INJECTED as a parameter rather than imported, so this
> module's dependency graph stays free of `../lib/tauri`.

(It does import `type { AppSettings } from "../lib/tauri"` and a `typeof import("../lib/tauri")`
do the same — the graph is kept barrel-free only of RUNTIME imports; the `type`/`typeof` forms are
erased at compile time.)

D2 remains **worth doing** — it is a domain re-organization, not a
scaffolding extraction — but the per-file scaffold duplication (≈140 lines each: ~13 import + ~7
beforeAll + ~90 tauri factory + ~2 dialog factory + ~37 beforeEach) is the fixed cost of every split
file, and the task04 precedent (both new hook files carry verbatim copies of the same four,
`useChatAttachments.test.tsx` lines ~68–80 beforeAll + factory) proves the house accepted that cost.

---

## 6. Gate numbers to reconcile against

**Baseline at `bab6d68a` (recorded in `docs/roadmap/chatstream-decomposition-status.md` §Wave 3,
orchestrator-run at code HEAD):** `pnpm test` → **163 files, 3356 passed | 1 skipped**, exit 0;
`pnpm build` → exit 0. (Arithmetic in the file: 3355 passed + 1 flake-red + 1 skipped = 3357 total,
re-ran green.)

**Component test counts (measured at HEAD, `it(` + its-one-`it.each` executed tests):**

| File | Executed tests |
|---|---|
| `src/components/ChatStream.test.tsx` | **215** (212 `it(` + 1 `it.each` × 3) |
| `src/hooks/useChatAttachments.test.tsx` | **35** |
| `src/hooks/useChatPromptDispatch.test.tsx` | **17** |
| `src/hooks/usePromptQueueFlusher.test.tsx` | **14** |

**The tauri-barrel mock-seam pin** — `src/lib/tauriBarrel.test.ts`, `it("the scanner sees the mock
seam it exists to protect")` (line 398). I re-derived it with a comment-stripping scanner
(`stripJsComments` logic, `^\s*vi\.mock\(\s*["'][^"']*lib\/tauri["']/m` against `.test.tsx?$` files
under `src/`): **41 mockers / 40 spreaders**, exactly the caller's numbers and exactly the file's
own assertions (`expect(mockers).toHaveLength(41)` at line 427; `expect(…spread).toBe(40)` at 435 —
the sole non-spreader is `hooks/useWindowMaximized.test.ts`, per the file's own comment, plus four
other files that only *_mention_* `vi.mock`-free barrels in comments and are correctly NOT counted).
**Do not restate 41/40 as anything to maintain** — the file's comment owns that set ("The number may
only move when a test file is added or removed, in a commit that says so — the provenance comment
already records `… 39 -> 41 when the chatstream decomposition moved the dispatch/queue/flush tests
into src/hooks/useChatPromptDispatch.test.tsx and src/hooks/usePromptQueueFlusher.test.tsx`").

**D2's consequence:** each new domain-focused test file that renders `<ChatStream />` mocks the
barrel by path with an `importActual`-spreading factory (per §5.3, verbatim copies), so the pin
grows by **one mocker + one spreader per new file**. The implementer must, **in the same commit**:
bump `expect(mockers).toHaveLength(41 + N)` and `expect(…).toBe(40 + N)` (N = number of new files),
and extend the provenance comment with a clause naming each new file (the task04 precedent: the
comment grew one clause per wave-2/3 file; the status file's wave-2 note is explicit — "the mock-seam
pin moved by exactly one mocker + one spreader and its provenance comment names the new `.tsx`").
Also verify the two silent conditions from the appendix against each new file's import order (clean
fixtures imported before the target; the factory references only `vi`).

---

## 7. The two live traps, restated for wave 4

### 7.1 Hook ordering (now FOUR extracted hooks in the unconditional block)

The unconditional block above the `!activeSessionId` early return (553) now holds **four extracted
hooks** — `useChatSessionDerivations` (81), `useChatAttachments` (275), `useChatPromptDispatch` (510),
`usePromptQueueFlusher` (531) — plus `useHasPendingRequest` (206), `useChildGates` (217),
`useSpinQuip` (177), `useActiveSpaceCwd` (379), `useMentionCatalogs` (382), `useMentionPicker` (463),
`useWindowDropBackstop`/`useAutoGrowComposer` (350–351) and the `useState`/`useRef` cells. The
comment at 354–375 states the rule in the file's own words:

> ALL of the hooks below live in the UNCONDITIONAL top block (before the
> `!activeSessionId` early return further down) — placing any of them after
> the early return would change the hook count across the session/no-session
> transition and crash React (the same bug the `useHasPendingRequest`
> comment above warns about).

If D1 adds a FIFTH extraction consuming the §2 derivations, it **must sit beside the other four in
that block** — i.e. between line 81 (the session-derivations call it would extend) and line 553 —
with its argument values (whatever D1's new pure core needs) hoisted above it. The §2.4 history
slice is the edge case: it is read AFTER the early return today (used only in the render at
602+), but if D2/D1 moves it into a hook-returned value the **hook call itself** still goes in the
unconditional block; the *values* may be consumed below the return. Do not put a hook below 553.

### 7.2 The `vi.mock` probe matrix

Restated fully in §5.3: a `vi.mock` factory may reference only bindings from a module with NO
transitive import of the mocked specifier AND imported before anything that imports it; violating
either silently fails as **0 tests run** pointing at an import line. Every new D2 file must: keep
both factories inline and referencing only `vi`; copy the `beforeAll`/`beforeEach` verbatim; and
import `chatStreamFixtures` BEFORE the target (`ChatStream`) — the module-order ✅/❌ dependency. Do
NOT delegate the factories to any shared module, including `chatStreamFixtures.ts`: its own header
(fixtures-quoted in §5.3) records that it has a transitive path into the barrel via the stores it
seeds (`useSettings`/`useSessions` both import `../lib/tauri`) — exactly the probe row that fails.

---

## 8. Contradictions / corrections to the caller's measurements

- **Line count:** caller said "705 lines" — `wc -l` = **704** (and `grep -c ''` = 704). One trailing
  empty line of difference from whatever produced 705; the file's last byte is `}\n`, no trailing
  blank. Everything else (399 comment / ~287 code) matches exactly.
- **Blank lines:** caller's "19 blank" vs my **18** — same single-line edge (the 705th phantom line
  was likely counted as blank). Not a functional discrepancy.
- **Block-line spans:** caller's block spans (230/3486, 3716/1609, 5325/340, 5665/173, 5838/169,
  6007/86, 6093/128, 6221/67) match my map for all eight blocks **except the last**: block 8 spans
  **66** lines (6221–6286), not 67 — the 6286th line is the final `});`, so 6221..6286 inclusive =
  66. (My span for the nested filters describe is 208 lines at 5116–5323; the caller didn't list it,
  consistent.)
- **Test counts:** caller's per-block counts (150/34/13/3/6/1/4/2) match my table — **provided** the
  "150" for block 1 counts its single `it.each` as 3 tests. The raw `it(` count for block 1 is 149
  (+1 `it.each` = 150 executed). Total 215 confirmed two independent ways (212 + 3, and the block
  sum).
- **The "one mocker per new file" reading:** the caller says "grows by one mocker per new file".
  Verified against the pin's own filter: each new `.test.ts`/`.test.tsx` under `src/` that mocks the
  barrel by path **and** spreads `vi.importActual` grows BOTH counts by one (mockers AND spreaders).
  The status/plan files record exactly this for waves 2–3 (38→39→41 mockers; 37→38→40 spreaders).
  So the implementer bumps **both** assertions in the same commit, not just the mocker count.

---

## 9. Sources

- `src/components/ChatStream.tsx` (704) — component structure, derivations, pins, hook calls.
- `src/components/ChatStream.test.tsx` (6286) — describe table, `vi.mock`/`beforeAll`/`beforeEach`,
  the `dirPrefix` pin's consumer side.
- `src/hooks/useChatSessionDerivations.ts` (98) — hook return shape.
- `src/lib/chatSessionDerivations.ts` (137) — 5 pure functions.
- `src/hooks/useChatAttachments.test.tsx` | `useChatPromptDispatch.test.tsx` |
  `usePromptQueueFlusher.test.tsx` — per-file scaffold copies (the D2 precedent) + test counts.
- `src/lib/tauriBarrel.test.ts` — mock-seam pin (41/40), provenance comment.
- `docs/roadmap/chatstream-decomposition-status.md` — wave-3 gate (163 files, 3356 passed | 1 skipped).
- `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md` — §5 block table + the
  Appendix probe matrix (quoted in §5.3).
- Git: `27cec040` (wave-1 base), `0aa99ffb` (wave-2), `bab6d68a` (code HEAD), `8013fc42` (branch tip
  docs commit) — diffs for the picker/render-region verification.