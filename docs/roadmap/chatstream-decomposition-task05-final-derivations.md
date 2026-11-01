---
status: committed
parent: docs/roadmap/chatstream-decomposition-status.md
done-when: "Issue #135 §3's final increment is shipped: `workingOrInTurn`, `composerLocked` and the `history`/`loadOlder`/`hasMore`/`loadingMore`/`generation` slice are derived by `src/lib/chatSessionDerivations.ts` (two new pure exports) + `src/hooks/useChatSessionDerivations.ts` (returned names) and consumed by `ChatStream.tsx` from the hook's return; the picker's `dirPrefix`/`activeRemainder`/`outside`, `hasImages` and `units` stay exactly where they are; `ChatStream.tsx`'s existing imports of `useSpinQuip`, the `useChatSessionDerivations` import and the `ComposerRow`/`MessageList` props are all unchanged; `pnpm test` from the repo root reports 163 files, 3356+N passed | 1 skipped (N = 12, this task's new tests), exit 0, and `pnpm build` exits 0."
---

# ChatStream decomposition — Task D1-final (issue #135 §3, final increment): Session State & Capability Derivations

**Goal:** Move the LAST two derivation families out of `ChatStream.tsx` into the existing pure module `src/lib/chatSessionDerivations.ts` and the existing hook `src/hooks/useChatSessionDerivations.ts` — the `composerLocked` chain (`workingOrInTurn` + `composerLocked`) and the history-pagination slice (`history` / `loadOlder` / `hasMore` / `loadingMore` / `generation`) — with ZERO behaviour change, by EXTENDING the two derivation files rather than duplicating them. The component keeps only its wiring: selectors whose values the two hooks cannot see (`inTurn`, `compacting`, `agentState` stay — see §3), the JSX, and the already-extracted hook calls.
**Architecture:** Extend the 5-function pure module with two new pure exports (`composerLockDerivations`, `historyPaginationDerivations`), extend the un-memoised hook with two new store reads and the two new returned names, and rewire the component's five call sites. The two in-scope derivations are MOVED VERBATIM with their load-bearing comments; three derivations stay in the component for recorded reasons quoted in §2.
**Tech Stack:** React 19 hooks, zustand module singletons, Vitest 5 + Testing Library, pure TypeScript functions. No new files are created; the two existing `.test.ts` files are the new tests' homes.

**Conventions governing EVERY step below (read first):**
- **Behaviour is MOVED, not improved.** Every moved expression and comment is a VERBATIM move; the only permitted additions are the two new pure functions' JSDoc, the two new hook selectors' comments, and the returned-name lines. Any behaviour change discovered mid-move is recorded in the commit body, never made.
- **Anchor by SYMBOL, not line number.** Line numbers below were measured at code HEAD `bab6d68a` / docs HEAD `8013fc42` and are navigation aids only; symbols are the contract. Where the plan says "read/measure", never trust a number here.
- **This task is a narrow, additive move.** Four files are in scope, ALL of them owned (see `Files:`). Do NOT create any file. Do NOT touch `src/components/ChatStream.test.tsx` or `src/lib/tauriBarrel.test.ts` — a sibling owns both (proof of their arms-length status, §7). In particular: this task introduces **no `vi.mock` anywhere** — neither owned test file has a single `vi.mock` today (verified, §5), and keeping it that way is what leaves the sister `tauriBarrel.test.ts` mock-seam pin exactly where the sibling finds it.

---

## Parallelisation

**Verdict:** SERIAL — this plan holds exactly ONE task. The skill's consumed-mode rule: a one-task plan has nothing to parallelise with (parallelism in a `roadmap` run happens BETWEEN tasks, in the wave grouping `roadmap` owns; the status file records the D1 wave as width 1). The sibling task that owns `src/components/ChatStream.test.tsx` and `src/lib/tauriBarrel.test.ts` is a SEPARATE plan in the same wave — it needs no code from this task and provides none, so the two plans are disjoint by construction. The one shared seam is `tauriBarrel.test.ts`'s mock-seam pin: because this task's two test files keep mocking NOTHING, the pin's mocker/spreader counts do not move this task's way, and the sibling edits those two files without colliding with any file this task owns. No `**Parallel:**` line is emitted (consumed-mode rule).

---

### Task D1-final: Move `composerLocked` chain + history-pagination slice into `chatSessionDerivations` + `useChatSessionDerivations`

**Context:**
`ChatStream.tsx` (704 lines at HEAD) was down to two derivation families still living in its body. Issue #135 §3's final increment moves both, because the reason they stayed has aged out and because both are pure over store slices the hook already reads.

1. **The `composerLocked` chain was deliberately refused by wave 1, for a reason that has LANDED.** `docs/roadmap/chatstream-decomposition-task01-session-derivations.md` (§"What STAYS … deliberately") records, verbatim:

   > Moving the chain would force `useSpinQuip`/`useSessionIdleEdge`/`send` to read the hook's return, coupling the Flush trigger (Task C1's seam) to this task.

   **C1 has LANDED** (code HEAD `bab6d68a`). `src/hooks/useChatPromptDispatch.ts` now declares `UseChatPromptDispatchArgs` with `composerLocked: boolean;` as a plain field (verified in the file, inside the interface), and `ChatStream.tsx` passes it: `composerLocked,` at the `useChatPromptDispatch({…})` call, and `busy: composerLocked,` to `useSessionIdleEdge` (the edge hook's own doc says: "The composite busy flag — pass `composerLocked` verbatim."). The refusal names THREE consumers, not one — the verbatim quote names `useSpinQuip`/`useSessionIdleEdge`/`send` — so the "has landed" argument must square all three legs, and it does:
  1. **`useSpinQuip(workingOrInTurn)`** — reads the hook's return directly: the destructure at line 81 (before the 177 call) supplies the value; ordering is verified in §3.a.
  2. **`useSessionIdleEdge({ busy: composerLocked })`** — receives a plain `boolean` argument (the edge hook's own doc: "The composite busy flag — pass `composerLocked` verbatim.").
  3. **`send`'s queue-fork read of `composerLocked`** (task01's `:764` fork — the "queue fork" that task01 recorded as a consumer) — is now **C1-INTERNAL**: the ADR 0069 queue fork lives in `src/hooks/useChatPromptDispatch.ts` and its `if (composerLocked) { … }` arm (verified in the file) reads the hook's own **argument**, not a hook return — and this task does NOT rewire that arm (it re-wires only the two argument sites above). So the queue-fork leg is satisfied by the hook's own argument, not by this task.

All three consumers now receive a plain boolean, exactly as they receive every other render value. This task therefore re-wires the two argument sites (`useChatPromptDispatch` args, `useSessionIdleEdge` `busy`) and nothing else. The decision aged out; it is not being reversed on a hunch. (This is the fact the task text requires recorded, and it is re-recorded in the hook file's comment per §Steps step 1.)

2. **The history-pagination derivation is pure over a store slice and consumed only by the render.** `ChatStream.tsx` (before this task) runs:

   ```ts
   const history = useSessions((s) => activeSessionId ? s.history[activeSessionId] : undefined);
   const loadOlder = useSessions((s) => s.loadOlderHistory);
   const hasMore = history?.hasMore ?? false;
   const loadingMore = history?.loadingMore ?? false;
   const generation = history?.generation ?? 0;
   ```

   Its consumers are all in the render: `<MessageList>`'s `hasMore`, `loadingMore`, `generation` props and `onStartReached={() => { if (activeSessionId) void loadOlder(activeSessionId); }}`. The store slice is `src/store/sessions.ts`'s `history: Record<string, { oldestRowId: number | null; hasMore: boolean; loadingMore: boolean; generation: number; epoch: number }>` (verified at `src/store/sessions.ts` §store-state; `loadOlderHistory: (sessionId: string) => Promise<void>` is the store action; THREE of the component's `?? false`/`?? 0` fallbacks are exactly the "no-session frame" stability the hook's no-session test already pins (§5). The `loadOlderHistory` action DOES reach an IPC command (`load_history` inside `src/store/sessions.ts`), but no new test in this task ever invokes the action — the pure function takes it as a value, and `MessageList`'s `onStartReached` (which would invoke it) is exercised only by sibling/legacy component tests that already mount with the tauri barrel mocked. So the move costs the new tests nothing.

3. **What stays, and why** (each with the code's own recorded comment — behaviour is moved, not improved):
   - **The picker region's `dirPrefix` / `activeRemainder` / `outside` derivation stays component-local, and it is a deliberate, mutation-checked pin.** The comment above `dirPrefix` in `ChatStream.tsx` states, verbatim:
     > This value is the catalog's CACHE KEY, which is why it is the directory and NOT the whole remainder: typing inside one directory then changes only the SEGMENT, so the key is stable and exactly ONE directory read happens per directory — the property the one-directory peek is budgeted on. Pinned in `ChatStream.test.tsx` at THIS derivation (a hook-level caching test cannot prove it: with `dirPrefix` as an argument the hook only shows "same input, same output"), and mutation-checked — passing `token.remainder` here reddens that test.
     Extracting it into a hook would break that pin: with `dirPrefix` computed at hook level, the component test could no longer observe the exact cache-key value feeding `useCompletionDir`. **Do NOT move `dirPrefix`, `activeRemainder`, `outside`, `picker`/`setPicker`, or the `useCompletionDir` call.** The two `useMention*`/`useCompletionDir` picks stay exactly as they are (their side of `ChatStream.test.tsx`'s ADR 0035 group is a sibling-owned file, and this pin is why).
   - **`hasImages` stays.** Wave 3 already moved it up into the unconditional block with its own recorded comment: "Moved UP into the unconditional block (issue #135 §2) because it is now a `useChatPromptDispatch` argument" — it is a pure one-liner (`attachments.length > 0 && imageCapable`) whose consumers (`useChatPromptDispatch` arg, three handlers, `ComposerRow` prop) all live inside the component and the attachment/dispatch hooks, and its mid-`send` RE-DERIVATION under the auto-resume arm lives inside `useChatPromptDispatch` (it re-derives a LOCAL copy from the fresh agent's capabilities). It is not a session derivation, and the wave-3 comment is itself the recorded decision. **Do NOT touch it.**
   - **`units` stays.** `groupConsecutiveFileWrites(messages)` is already a pure function call; its only consumer (`MessageList`'s `units` prop) is one line away. It is a function call, not a session derivation — moving it would buy nothing (the ground report: "moving it buys nothing unless D1 is about to make `messages` itself hook-owned (it isn't)"). **Do NOT touch it.**
   - **The four already-extracted hooks (including `useChatSessionDerivations`) were the seams this task completes.** Constraint 1's "fifth extracted hook call" of the task text reads on the sewer: this task does NOT add a fifth extracted hook call. `useChatSessionDerivations()` is ALREADY the hook call, called at `ChatStream.tsx` line ~81, BEFORE `useSpinQuip(workingOrInTurn)` at line ~177 — so when the hook gains a `workingOrInTurn` return, that value is in scope at the 177 call with exactly the ordering constraint 1 records (verified, §3.a). The "beside the four already there" placement is the existing call's home; this task extends it, it does not add a sibling.

**Files:**
- Modify: `src/lib/chatSessionDerivations.ts` — ADD two pure functions (`composerLockDerivations`, `historyPaginationDerivations`). No existing export changes.
- Modify: `src/lib/chatSessionDerivations.test.ts` (230 lines, 17 tests) — ADD the new pure-function tests. No existing test changes.
- Modify: `src/hooks/useChatSessionDerivations.ts` — ADD two store reads + two returned names (`workingOrInTurn`, `composerLocked`). No existing return name changes.
- Modify: `src/hooks/useChatSessionDerivations.test.ts` (233 lines, 11 tests) — ADD the new hook tests. No existing test changes.
- Modify: `src/components/ChatStream.tsx` — delete the two in-component derivations, destructure the new names, re-wire the five call sites.
- **NOT owned (sibling's):** `src/components/ChatStream.test.tsx`, `src/lib/tauriBarrel.test.ts`. The plan names NO edit inside either.

All `Modify:` paths are inside this task's owned set. No file is created. The barrel mock-seam pin **must not move** because of this task (§7).

**What to implement:**

## 1. `src/lib/chatSessionDerivations.ts` — extend with two pure functions

The file today exports exactly **5 pure functions** (verified): `classifyInteractiveRequests`, `anchoredAskRequestIds`, `stackedAskRequests`, `sessionKindDerivations`, `turnDiffs` — all `export function`, all taking explicit inputs, none touching a store (the module doc: "this module never touches a store, not even through a lookup helper"). The two additions follow the same pure shape.

**Add (placing them after `turnDiffs`):**

```ts
/**
 * The composer-lock derivation for the ACTIVE session (issue #135 §3, final
 * increment). Pure over the three inputs the component used to select.
 *
 * A `blocked` agent is mid-turn AWAITING a request response (`inTurn` is
 * true) — the SEND must stay disabled for the whole wait (pre-branch,
 * `main`'s composer locked on `inTurn`): the harness is one-turn-at-a-time
 * (a prompt while a turn is in flight is REJECTED, not queued —
 * `send_prompt`'s atomic `pending_turn` claim), so sending concurrently
 * would fail + clobber the turn bookkeeping. The TEXTAREA is always
 * editable (you can draft while the agent works — `send()`'s
 * `composerLocked` guard no-ops Enter, the draft is kept for when the
 * turn ends). (`agentState === "blocked"` also covers a blocked state
 * without an in-flight turn, where `inTurn` alone would not lock.) A
 * compaction locks for the same reason: the harness is one-turn-at-a-time
 * and a prompt racing the rewrite would be rejected (or reorder history).
 */
export function composerLockDerivations(input: {
  agentState: "working" | "idle" | "blocked" | undefined;
  inTurn: boolean;
  compacting: unknown; // `CompactionReason | undefined`; `unknown` keeps the type import out of the pure module
}): {
  workingOrInTurn: boolean;
  composerLocked: boolean;
} {
  const workingOrInTurn = input.agentState === "working" || input.inTurn;
  const composerLocked =
    workingOrInTurn || input.agentState === "blocked" || input.compacting !== undefined;
  return { workingOrInTurn, composerLocked };
}

/**
 * The history-pagination window for the ACTIVE session (issue #135 §3, final
 * increment). Pure over ONE store slice: the `history[sessionId]` entry and
 * the `loadOlderHistory` action. The action is returned UNWRAPPED (the
 * component hands it straight to `MessageList`'s `onStartReached`) and is
 * never invoked here; the three `?? false` / `?? 0` fallbacks sit OUTSIDE any
 * selector, exactly as they did in the component (the fallbacks are what keep
 * the no-session frame returning stable booleans).
 */
export function historyPaginationDerivations(input: {
  history: {
    oldestRowId: number | null;
    hasMore: boolean;
    loadingMore: boolean;
    generation: number;
    epoch: number;
  } | undefined;
  loadOlder: (sessionId: string) => Promise<void>;
}): {
  loadOlder: (sessionId: string) => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  generation: number;
} {
  return {
    loadOlder: input.loadOlder,
    hasMore: input.history?.hasMore ?? false,
    loadingMore: input.history?.loadingMore ?? false,
    generation: input.history?.generation ?? 0,
  };
}
```

- The `composerLockDerivations` comment above is the component's own lock comment (quoted at `ChatStream.tsx` §"composerLocked"), moved with the expression — behaviour is moved, not improved.
- The lock chain reads `agentState` (a union from `src/store/interactive.ts`: `agentState: Record<string, "working" | "idle" | "blocked">`), `inTurn` (from `sessions`), `compacting` (from `sessions`: `Record<string, CompactionReason | undefined>`; `CompactionReason = "manual" | "threshold" | "overflow"`). **Deliberate choice:** the pure module takes `compacting: unknown` and the hook's selector reads `compacting !== undefined` with `s.compacting[s.activeSessionId]` — the strict `!== undefined` (which the component uses today, and which is what ADR 0045's "`null` = not compacting" contract requires) lives in the HOOK, keeping the type import out of the pure module (its doc refuses store/type coupling). This is the ONE sanctioned deviation from a byte-for-byte move and it is recorded in both files.
- `historyPaginationDerivations`'s shape is verbatim: today's `hasMore = history?.hasMore ?? false` etc., with `loadOlder` passed straight through so `MessageList`'s `onStartReached` still closes over the same function value. **The action is never invoked inside the pure module or the hook.**
- No existing export changes; no import changes in this file (the additions reference only the parameter types; `Record` is lib-typed).

## 2. `src/hooks/useChatSessionDerivations.ts` — extend with two store reads + two returned names

The hook today is an un-memoised adapter with **5 store reads** (verified: `activeSessionId`, `messages`, `liveSession`, `activeCapabilities`, `activeSessionIsKnown` via `useSessions` + `interactiveRequests` via `useInteractive` — the `grep -c` counted 5 selector calls) and the 12-name return:

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

**Add, after the existing `imageCapable` line and before the `return`:**

```ts
  // The composer-lock chain (issue #135 §3, final increment). The pure
  // predicate is `lib/chatSessionDerivations.composerLockDerivations`; the
  // THREE inputs are selected here and passed in — the hook owns the store
  // reads, the pure module owns the boolean. `inTurn` is `false` for the
  // no-session frame and `compacting` is `undefined` for it, so the chain
  // derives `{ workingOrInTurn: false, composerLocked: false }` there —
  // the same values the component's `?? false`/`!== undefined` fallbacks
  // produced. Wave 1 refused this move because it would "force
  // `useSpinQuip`/`useSessionIdleEdge`/`send` to read the hook's return"
  // (task01's recorded reason — ALL THREE legs). C1 has landed with
  // `composerLocked` as a PLAIN ARGUMENT of `useChatPromptDispatch` and of
  // `useSessionIdleEdge` (`busy`), and `send`'s queue-fork read sits INSIDE
  // `useChatPromptDispatch` — the `if (composerLocked)` arm reads the
  // argument, not a hook return — so all three legs are satisfied by
  // re-wiring two argument sites; the queue-fork arm is not a consumer this
  // task rewires.
  const inTurnLock = useSessions((s) =>
    s.activeSessionId ? !!s.inTurn[s.activeSessionId] : false,
  );
  const compacting = useSessions((s) =>
    s.activeSessionId ? s.compacting[s.activeSessionId] : undefined,
  );
  const agentStateForLock = useInteractive((s) =>
    s.activeSessionId ? s.agentState[s.activeSessionId] : undefined,
  );
  const lock = composerLockDerivations({
    agentState: agentStateForLock,
    inTurn: inTurnLock,
    compacting,
  });
  // The history-pagination slice (issue #135 §3, final increment). The
  // `history[sessionId]` entry and the `loadOlderHistory` action are read
  // here; the `?? false` / `?? 0` fallbacks are OUTSIDE the selectors (the
  // house stable-reference rule) and now live in the pure function.
  const historyEntry = useSessions((s) =>
    s.activeSessionId ? s.history[s.activeSessionId] : undefined,
  );
  const loadOlder = useSessions((s) => s.loadOlderHistory);
  const pagination = historyPaginationDerivations({
    history: historyEntry,
    loadOlder,
  });
```

**And extend the return block** (append, keeping every existing line — the 12 existing names and their values do NOT change):

```ts
    workingOrInTurn: lock.workingOrInTurn,
    composerLocked: lock.composerLocked,
    loadOlder: pagination.loadOlder,
    hasMore: pagination.hasMore,
    loadingMore: pagination.loadingMore,
    generation: pagination.generation,
```

**`UNVERIFIED` (one deliberate judgment call for the vet to confirm):** the plan names the internal locals `inTurnLock`, `agentStateForLock`, `historyEntry` to avoid colliding with the component's own `inTurn` / `compacting` / `agentState` names across the two files (none are in scope here — hook and component have separate scopes — but the distinct names make the move reviewable). `composerLockDerivations` takes the `"working" | "idle" | "blocked" | undefined` union inline; re-declaring the union instead of importing `InteractiveRequestData`-adjacent types is the pure module's established rule (imports stay lean). If the vet prefers importing the union from `../store/interactive`, that is compatible with this plan's file lists — the union literal `"working" | "idle" | "blocked"` is asserted identical to the store field's type (`src/store/interactive.ts` line ~195, verified).

- **Selector stability (constraint 3):** every new selector returns either a store slice reference (`s.history[id]`, `s.loadOlderHistory`) or a primitive (`!!s.inTurn[...]`, `s.agentState[...]`, `s.compacting[...]`); NO fresh `[]`/`{}` inside any selector; the `?? false`/`?? 0` fallbacks live in the pure function, OUTSIDE the selectors. This matches the existing file's and the component's rule comments verbatim.
- **The no-session frame** (constraint: the hook's existing no-session test must stay green): all five new reads return their stable no-session values (`false`, `undefined`, the action reference), and `composerLockDerivations`/`historyPaginationDerivations` derive exactly `{ workingOrInTurn: false, composerLocked: false }` and `{ loadOlder, hasMore: false, loadingMore: false, generation: 0 }` — identical to what the component derived on that frame today.
- The hook file's import list gains `composerLockDerivations` and `historyPaginationDerivations` from `../lib/chatSessionDerivations`. Nothing leaves the existing import list.

## 3. `src/components/ChatStream.tsx` — delete the two derivations, destructure the new names, re-wire the five call sites

### 3.a Confirmed current structure (constraint 1 — the ordering that keeps `workingOrInTurn` in scope)

Verified at HEAD: the unconditional block above the `if (!activeSessionId)` early return (line ~553) holds, IN THIS ORDER: `useChatSessionDerivations()` destructure **closing** at line **81**, ... `workingOrInTurn`/`composerLocked` computed at lines **98 / 171–172**, ... `useSpinQuip(workingOrInTurn)` at line **177**, `useHasPendingRequest` (206), `useChildGates` (217), `useChatAttachments` (275), ... `useChatPromptDispatch` (510), `usePromptQueueFlusher` (531), `useSessionIdleEdge` (547), then the early return (553). So:

- **`useChatSessionDerivations()` is called BEFORE `useSpinQuip(workingOrInTurn)`** — when the hook returns `workingOrInTurn`, that value is in scope at the 177 call. The "fifth extracted hook call sits beside the four already there" task expectation is satisfied by EXTENDING the existing, already-first call; no new hook call is added. A new call would be harmless but redundant — the instruction "beside the four already there" is met by the existing call's position (line 81, the first of the four extracted hooks).
- The chain's five consumers are re-wired as follows (constraint 2 — a missed consumer is a `tsc` failure at best and a silently-unlocked composer at worst):

| Consumer (verified at HEAD) | Line | Change |
|---|---|---|
| `useSpinQuip(workingOrInTurn)` | 177 | already reads component `workingOrInTurn` — now the DESTRUCTURED name |
| `composerLocked` derivation | 171–172 | deleted (moves to the hook) |
| `useChatPromptDispatch({ ... composerLocked, ... })` args | 516 | the argument stays, now reading the destructured name |
| `useSessionIdleEdge({ busy: composerLocked, ... })` | 548 | the argument stays, now reading the destructured name |
| `<MessageList workingOrInTurn={workingOrInTurn} ... />` | 643 | unchanged — reads the destructured name |
| `<ComposerRow composerLocked={composerLocked} ... />` | 686 | unchanged — reads the destructured name |
| `<ComposerRow workingOrInTurn={workingOrInTurn} ... />` | 690 | unchanged — reads the destructured name |
| `<MessageList hasMore={hasMore} loadingMore={loadingMore} generation={generation} onStartReached={...loadOlder...} />` | 647–653 | all four now read the destructured names |

Every one of these reads a name the hook now returns; if the hook's return misses one, `tsc` reddens the missing destructure identifier (`noUnusedLocals`/property-not-found) — the compiler arbitrates, and §Steps step 5 makes that explicit.

### 3.b Edits

1. **Destructure the five new names.** Change the existing destructure (`const { askRequests, confirmRequests, passwordRequests, stackedAskRequests, isLive, canResume, composerEnabled, turnDiffs, imageCapable } = useChatSessionDerivations();` at line ~63–81) to add, inside the braces: `workingOrInTurn, composerLocked, loadOlder, hasMore, loadingMore, generation`. The existing nine names and their order are untouched.
2. **Delete `const workingOrInTurn = agentState === "working" || inTurn;`** (line 98). The comment above it (the "`inTurn` is the ground truth … a STALE `idle` from the previous turn must not unlock the composer" block, ~6 lines) MOVES VERBATIM into the hook next to the new `inTurnLock` selector (or into `composerLockDerivations`'s JSDoc — implementer's choice, but the words must travel; the contract is that no load-bearing comment is dropped).
3. **Delete `const composerLocked = workingOrInTurn || agentState === "blocked" || compacting !== undefined;`** (lines 171–172) AND its load-bearing comment (the ~13-line "A `blocked` agent is mid-turn AWAITING a request response …" block quoted in §1). The comment moves VERBATIM into the hook (per §1's JSDoc and the added hook comment above the `composerLockDerivations` call).
4. **Delete the history slice** (the 5 lines at §Context point 2) and its consumers' dependency stays local: `<MessageList>`'s `hasMore`/`loadingMore`/`generation` props and `onStartReached` now read `hasMore`/`loadingMore`/`generation`/`loadOlder` from the destructure. The `onStartReached` inline arrow `() => { if (activeSessionId) void loadOlder(activeSessionId); }` is UNCHANGED — it closes over the destructured `loadOlder`.
5. **Deleting what the deleted lines consumed:** `inTurn` (line 57) and `compacting` (line 108) are still selected and still used — by the Esc effect's deps (`[inTurn, activeSessionId, compacting]`) and by `<MessageList inTurn={inTurn}>` / `<ComposerRow compacting={compacting}>` (lines 637, 691 — verified). **Keep both.** `agentState` (line 95) is still consumed by `<MessageList agentState={agentState}>` (644) and `<ComposerRow agentState={agentState}>` (689). **Keep it.** So no store selector dies; the only deletions are the two `const` derivation lines and the five-line history block. (The component keeps its `useInteractive` import — `grep` confirms lines 20, 95 — and `useSessions`, `useSettings`.)
6. **What dies instead (constraint 4 — name them, and let `tsc` arbitrate):** the component's LOCAL `const workingOrInTurn`, `const composerLocked`, `const history`, `const loadOlder`, `const hasMore`, `const loadingMore`, `const generation` all disappear. `history` has no other consumer (the `history[activeSessionId]` selector was the only read). **No import dies.** The component's import of `../lib/chatSessionDerivations` doesn't exist today (the hook imports it), `useInteractive`/`useSessions`/`useSettings` stay (their live consumers listed in step 5), and no new import is needed. The `useChatSessionDerivations` import (line 46, verified) stays.
7. **Nothing else changes.** `hasImages`, `units`, the picker region, the four extracted hook calls (now five names deeper in an existing destructure), the refs, the effects, the handlers, the JSX are untouched.

## 4. Tests — additive, in the two existing homes

**Both owned test files have ZERO `vi.mock` today** (verified: `grep "vi.mock" src/lib/chatSessionDerivations.test.ts` → no match; `src/hooks/useChatSessionDerivations.test.ts` → no match; that hook file's header states it explicitly — "NO `vi.mock` of any kind — the same posture the closest house-style precedents take"). The new tests keep that posture. This is the load-bearing reason the sibling's `tauriBarrel.test.ts` mock-seam pin does not move on this task's side (constraint: this task introduces NO new mocker and NO new spreader; §7).

### 4.a `src/lib/chatSessionDerivations.test.ts` — the pure functions (new `describe` blocks appended, do not modify existing blocks)

Following the file's existing style (direct calls, `makeMessage`/`makeSessionRow` fixtures from `../test/fixtures`, no store, no render). Add one `describe` per new function:

- **`describe("composerLockDerivations")`** — FIVE cases, each named for the regression it pins (the pins the component's 215 tests already cover at integration level; these become the focused pins). Dropped from the first draft: the `idle` + `inTurn: true` row (a re-pin of the identical `|| inTurn` byte — hook `it` 1's second re-seed already pins it), the second `CompactionReason` value (the `compacting !== undefined` term is value-uniform across `"manual" | "threshold" | "overflow"`, so a second value re-pins the identical byte), and the `agentState: undefined` no-session row (the hook's dedicated no-session `it` already catches a bug there):
  1. `working` agent + `inTurn: true` → both true (`{ workingOrInTurn: true, composerLocked: true }`).
  2. `working` agent + `inTurn: false` → `{ true, true }` (a STALE `idle`/`working` from the previous turn must not UNLOCK — the chain's ground-truth rule: `inTurn` wins alongside `working` because the store does not reset `agentState` on `turnCompleted`).
  3. `blocked` agent + `inTurn: false` → `{ false, true }` (the `agentState === "blocked"` term covers a blocked state WITHOUT an in-flight turn — the case `inTurn` alone would not lock).
  4. `idle` + `inTurn: false` + `compacting: undefined` → `{ false, false }` (idle unlocks).
  5. `idle` + `inTurn: false` + `compacting: "manual"` → `{ false, true }` (a compaction locks for the same one-turn-at-a-time reason; ONE `CompactionReason` value pins the uniform `!== undefined` term).
- **`describe("historyPaginationDerivations")`** — EXACTLY ONE case (pegged by the vet: a second differing entry would re-pin the byte-identical pass-through, and the `?? false`/`?? 0` fallback row is already covered by the hook's no-session frame pin — see the §Count gate trim):
  1. An entry with `{ oldestRowId: 1, hasMore: true, loadingMore: false, generation: 3, epoch: 0 }` → `{ hasMore: true, loadingMore: false, generation: 3 }` and `loadOlder` passed through IDENTITY (`out.loadOlder === input.loadOlder` — the `onStartReached` closure keeps the same function value).
  - No test may INVOKE `loadOlder` (it is a store action reaching IPC; passing it as a value is the point).

### 4.b `src/hooks/useChatSessionDerivations.test.ts` — the hook (new `it`s appended inside the existing `describe`, do not modify existing `it`s)

Follow the file's existing shape (real zustand singletons, `seedLive`/`seedHistoryOnly` local helpers, `resetStores()` in `beforeEach`, `renderHook`). New `it`s:

1. **"derives the composer lock from the ACTIVE session's agent state and in-turn flag"**: `useInteractive.setState({ agentState: { s1: "working" } })` (+ `seedLive`) → `result.current.workingOrInTurn === true`, `result.current.composerLocked === true`; then re-seed `agentState: { s1: "idle" }` + `useSessions.setState({ inTurn: { s1: true } })` → still locked (`workingOrInTurn` true, `composerLocked` true).
2. **"a `blocked` agent locks the composer even without an in-turn flag"**: `agentState: { s1: "blocked" }`, `inTurn: {}` → `workingOrInTurn` false, `composerLocked` true (the term `inTurn` alone would miss).
3. **"a compaction locks the composer (ADR 0045)"**: `useSessions.setState({ compacting: { s1: "manual" as const } })` with idle/not-in-turn → `workingOrInTurn` false, `composerLocked` true.
4. **"idle + no compaction → the composer is unlocked"**: default seed → both false.
5. **"the pagination slice returns the session's history window and the load-older action"**: set `useSessions.setState({ history: { s1: { oldestRowId: 1, hasMore: true, loadingMore: true, generation: 2, epoch: 0 } } })` → `hasMore` true, `loadingMore` true, `generation` 2, and `result.current.loadOlder === useSessions.getState().loadOlderHistory` (IDENTITY — the same stable action reference the component passes to `onStartReached`). EXACTLY ONE entry — the first draft's second entry (`hasMore: false, loadingMore: false, generation: 0`) was a third pin of the byte-identical pass-through (vet's finding); this hook case plus the one pure case are the two history-pagination pins.
6. **extend the existing no-session test only if untouched-assertion-free**: the plan does NOT modify the existing "the NO-SESSION state derives everything empty/false and does not throw" `it`. The new no-session frame is pinned by a NEW `it`: **"the NO-SESSION frame derives the new names empty/false and does not throw"** — `activeSessionId` stays `null` → assert `workingOrInTurn` false, `composerLocked` false, `hasMore` false, `loadingMore` false, `generation` 0, `loadOlder === useSessions.getState().loadOlderHistory`. (Everything else already asserted by the existing no-session test.)
   - The hook's existing selector-stability `it` (the "`?? []` fallback sits OUTSIDE" render-count pin) stays green: the new selectors return store slices/primitives, so the unrelated `spaces` write it performs still does not re-render (none of the new selectors read `spaces`).

**Both test sections keep `vi.mock`-free (verified posture).** The tauri-barrel mock-seam pin (§7) expects this file's mocker/spreader counts UNCHANGED; the sibling edits that assertion alone.

## Count gate — get the arithmetic right

**Baseline (recorded by the status file at `bab6d68a`, orchestrator-run): `pnpm test` → 163 files, 3356 passed | 1 skipped, exit 0; `pnpm build` → exit 0.** `ChatStream.test.tsx` = **215 tests** and MUST STAY 215 — it is the sibling's file; this task's behavioural coverage is identical, so no `it` in it changes (and the plan contains no edit to it).

This task's tests are **ADDITIVE**:
- New pure tests in `src/lib/chatSessionDerivations.test.ts`: exactly **5** (`composerLockDerivations`) + **1** (`historyPaginationDerivations`) = **6**.
- New hook tests in `src/hooks/useChatSessionDerivations.test.ts`: exactly **6**.
- **New tests total: N = 12.** No test MOVES and none is deleted (this task touches no `it` in any file, owned or not).

The **N = 12 trim is deliberate, not a miscount.** The first draft over-generated at 16 (7+3 pure, 6 hook) for two small derivations, and the padding sat exactly where review could find no catchable regression. Per the vet's option (b), every test now earns its slot by naming a specific regression: the composer-lock truth table pins `working` + in-turn, a stale `working` without an in-flight turn, `blocked` without an in-flight turn, compaction, and idle-unlocked; history pagination gets exactly **one pure pass-through/identity case** and **one hook case** (the pure second-entry pass-through row, the pure `?? false`/`?? 0` fallback case and the second hook entry were all re-pins of the identical byte — the hook's dedicated no-session frame already catches a bug there). This is this repo's own recorded rule (roadmap skill's `status-file-template.md`, the "Cost is a legitimate answer" guidance the status file's Decisions log applies): **"prefer the cheap, correct-enough fix plus an honest recorded limitation over the expensive complete one"** — while **"Pay any cost to satisfy a criterion exactly"** is a recorded anti-pattern (roadmap skill's Common-mistakes table). A padded suite is a maintenance liability, not coverage.

**Expected total = 3356 + 12 = 3368 passed | 1 skipped, still 163 files.** State it plainly: **a total ABOVE the baseline by exactly the new-test count (12) is CORRECT and must not be "fixed".** File count stays 163 (no file created or removed). If the runner reports anything else, reconcile by computing `baseline + 12` — never "correct" 3368 toward 3356. (Once again: 215 for `ChatStream.test.tsx` is the sibling's number; do not "fix" a red there — §7.)

Known flakes on this box (from the status file; re-run before investigating, do NOT "fix" the threshold or assertion — a red on either is a re-run, not a defect):
- `MessageBubble.codeblock.test.tsx`'s `it.each` JSON fence case (shiki async fallback).
- `Reasoning.test.tsx`'s `is O(last line)` wall-clock assertion.
Both are load under full-suite pressure. Neither file is in this task's diff.

## 5. The zero-`vi.mock` verification — how to re-prove it before implementation

The dispatch's constraint: keep the two existing test files mocking NOTHING, because a new mocker would move `tauriBarrel.test.ts`'s mock-seam pin, which the sibling edits. Re-verify with:

```sh
grep -n "vi.mock" src/lib/chatSessionDerivations.test.ts src/hooks/useChatSessionDerivations.test.ts
```

Both must print nothing (exit non-zero). They do at HEAD (verified). Preserve that after this task: the new `describe`/`it` blocks import only vitest + RTL + the two derivation modules + the store singletons + `../test/fixtures` + `resetStores` — none of which reaches the tauri barrel at runtime in a test that only READS state (the hook test's header already proves the library graph: `sessionLookup.ts` imports only the barrel's TYPES, `chatAttachments.ts` imports only `chatAttachmentMetadata`, and no store ACTION is ever called). `seedLive`/`seedHistoryOnly` never invoke `loadOlder` (it is returned, not called), so no IPC path opens.

## 6. Verification — commands (all from the repo root)

```sh
# Step 2 (after the pure-function test writes): the two owned files, individually
pnpm exec vitest run src/lib/chatSessionDerivations.test.ts        # expect 17 + 6 = 23, green
pnpm exec vitest run src/hooks/useChatSessionDerivations.test.ts   # expect 11 + 6 = 17, green
# Step 4: the component-level gate — MUST stay 215 and green (no edits, sibling-owned)
pnpm exec vitest run src/components/ChatStream.test.tsx
# The barrel pin MUST NOT move (run to confirm it still passes on the sibling's numbers):
pnpm exec vitest run src/lib/tauriBarrel.test.ts
# Fast type-check without the vite bundle:
npx tsc --noEmit
# The full frontend gate (the count-gate measurement):
pnpm test
pnpm build        # tsc && vite build — this IS the type-check; a lone unused import/dead name fails here
```

Do NOT run `pnpm dev` / `pnpm tauri dev` (long-running processes — forbidden).

**Steps (TDD order):**
- [ ] In `src/lib/chatSessionDerivations.test.ts`, append the `describe("composerLockDerivations")` (5 cases) and `describe("historyPaginationDerivations")` (exactly 1 case) blocks per §4.a. Do not modify any existing `it`.
- [ ] Run `pnpm exec vitest run src/lib/chatSessionDerivations.test.ts`. Expected: **RED** — `composerLockDerivations`/`historyPaginationDerivations` are not exported yet (module-resolution failure naming the missing export). If it is green, the tests import the wrong module — stop and investigate.
- [ ] Implement §1 in `src/lib/chatSessionDerivations.ts`: the two pure functions with the §1 JSDoc. (Keep the module's "no imports beyond the three type imports" doc honestly — the additions need no new import at all.)
- [ ] Run `pnpm exec vitest run src/lib/chatSessionDerivations.test.ts` → **GREEN (23 tests)**.
- [ ] In `src/hooks/useChatSessionDerivations.test.ts`, append the 6 new `it`s per §4.b (inside the existing `describe`, after the existing `it`s — no existing `it` modified). Seed with the file's own `seedLive`/`seedHistoryOnly` helpers + direct `useSessions`/`useInteractive.setState` calls, as its `it`s already do.
- [ ] Run `pnpm exec vitest run src/hooks/useChatSessionDerivations.test.ts`. Expected: **RED** — `workingOrInTurn`/`composerLocked`/`loadOlder`/`hasMore`/`loadingMore`/`generation` are not properties of the hook's return (property-not-found). If green, the tests read a wrong return — investigate.
- [ ] Implement §2 in `src/hooks/useChatSessionDerivations.ts`: the five new selectors, `composerLockDerivations`/`historyPaginationDerivations` calls, and the six appended return keys (+ import the two new pure functions). Keep every existing selector, comment and return key byte-identical.
- [ ] Run `pnpm exec vitest run src/hooks/useChatSessionDerivations.test.ts` → **GREEN (17 tests)**; the existing 11 are untouched and pass (their no-session and selector-stability pins must not need edits).
- [ ] Rewire `src/components/ChatStream.tsx` per §3.b: add the six names to the existing destructure; delete the two `const workingOrInTurn`/`const composerLocked` derivations, the five-line history block, and the `const history`/`const loadOlder` locals — moving their load-bearing comments into the hook per §3.b steps 2–3; keep `inTurn`/`compacting`/`agentState` selectors (their consumers listed in §3.b step 5). Change nothing else in the file.
- [ ] Run `npx tsc --noEmit` → clean. If TS6133 names an unused local/import, remove ONLY that name (`tsc` arbitrates; the plan's §3.b step 6 prediction is the expectation, not a ceiling — e.g. if the destructure of `workingOrInTurn` were accidentally not added, tsc flags the still-referenced-but-undeclared name instead; follow the compiler).
- [ ] Run `pnpm exec vitest run src/components/ChatStream.test.tsx` → **GREEN, still 215**. (No edits to that file were made; this run proves the rewire.) Run `pnpm exec vitest run src/lib/tauriBarrel.test.ts` → GREEN on its current numbers (this task introduced no mocker/spreader).
- [ ] Run `pnpm test` (full gate) → expect **163 files, 3368 passed | 1 skipped**, exit 0 (`3356 + 12`; re-read §Count gate before "fixing" 3368). If a known flake (§Count gate) is red, re-run that file rather than adjusting it.
- [ ] Run `pnpm build` → exit 0.
- [ ] Commit with message: `refactor(chatstream): move composerLocked chain + history pagination into chatSessionDerivations (issue #135 §3 final)` — one commit containing ONLY the four owned files (§Files). The sibling owns the other two; do not include them.

**Acceptance criteria:**
- [ ] `grep -n "const composerLocked\|const workingOrInTurn\|const history =\|const loadOlder\|const hasMore\|const loadingMore\|const generation" src/components/ChatStream.tsx` → **no matches** (all six locals deleted); `grep -n "workingOrInTurn\|composerLocked\|loadOlder\|hasMore\|loadingMore\|generation" src/components/ChatStream.tsx` → matches ONLY inside the `useChatSessionDerivations()` destructure (the six new names), the five re-wired call sites (§3.a table), the `onStartReached` arrow, and comments.
- [ ] `src/hooks/useChatSessionDerivations.ts` returns the ORIGINAL 12 names value-identical to before (existing hook tests pass unchanged) PLUS the six new names; its new selectors carry no fresh `[]`/`{}` in any selector body and no `??` fallback inside a selector (grep the new block: `?? false`/`?? 0` appear only in the pure functions).
- [ ] `src/lib/chatSessionDerivations.ts` exports `composerLockDerivations` and `historyPaginationDerivations` per §1; the file still exports the original five unchanged (the existing 17 pure tests pass untouched).
- [ ] The five consumers of §3.a all read the hook-returned names; `useSpinQuip(workingOrInTurn)` at the unconditional block uses the destructured value (ordering verified: destructure line < 177).
- [ ] `inTurn` (Esc effect deps + `MessageList` prop), `compacting` (Esc effect deps + `ComposerRow` prop) and `agentState` (both JSX props) remain selected in the component; `useInteractive`/`useSessions`/`useSettings` imports remain (grep).
- [ ] The picker region's `dirPrefix`/`activeRemainder`/`outside`/`picker`/`useCompletionDir` block, `hasImages`, `units` and the `onStartReached` arrow are BYTE-IDENTICAL to HEAD (diff the file's own diff — `git diff` on the four owned files shows no hunk inside the picker region, the `hasImages` block, the `units` line or the `onStartReached` arrow).
- [ ] Both owned test files contain ZERO `vi.mock` (grep returns nothing) and their totals are 23 (`lib`) and 17 (`hooks`); `ChatStream.test.tsx` still runs **215** tests green; `npx tsc --noEmit` clean.
- [ ] `pnpm test` → 163 files, **3356 + 12 = 3368** passed | 1 skipped, exit 0 (a total above baseline by exactly the new-test count is CORRECT — do not "fix"); `pnpm build` → exit 0.

**UNVERIFIED (for the caller's vet to target):**
- The full-suite numbers (163/3356/1, and the expected 163/3368/1) come from the status file's recorded orchestrator run at `bab6d68a` plus static `it(` counts I re-measured; I did not re-run `pnpm test` (a 180s-timeboxed run is the recorded reason earlier reports decline too). 17+11=28 existing + 12 new = the totals above are arithmetic; the plan tells the implementer to read the RUNNER's numbers, never an assertion.
- Whether `tsc` names exactly the six component locals as dead — the compiler arbitrates (§3.b step 6); the plan's list is the expectation. No IMPORT is predicted dead, but if tsc says otherwise, follow it (TS6133).
- The `composerLockDerivations` input type uses the inline union `"working" | "idle" | "blocked" | undefined` — verified identical to the store field's type at `src/store/interactive.ts`; an alternative is importing the union — noted §2.
- The exact new-test count (12) is the plan author's design after the vet's trim (5+1 pure, 6 hook); the arithmetic gate uses N = 12, so a vet challenging a specific case should adjust N and the sum together.

**Follow-up note (recorded, NOT implemented — behaviour is moved, not improved):**
- The hook now returns `loadOlder`, `hasMore`, `loadingMore`, `generation` — names that are only meaningful per active session (the same "active-session shape" all 12 existing returns share). No change to `MessageList`'s props is proposed; the `onStartReached` arrow stays in the component because it is wiring (a closure over the hook's `loadOlder`), not derivation.

---

## 7. The sibling boundary and the parse of "verify that zero-mock claim yourself"

**"The two existing test files" that must keep mocking NOTHING are THIS task's two owned test files** — `src/lib/chatSessionDerivations.test.ts` and `src/hooks/useChatSessionDerivations.test.ts`. Verified directly: both contain zero `vi.mock` calls (grep). (`src/components/ChatStream.test.tsx` DOES contain `vi.mock` calls — two factories, `../lib/tauri` and `@tauri-apps/plugin-dialog` — which is why the sibling owns it; `src/lib/tauriBarrel.test.ts` mentions `vi.mock` only in comments — it is the scanner pin's host, also sibling-owned.)

**The parse that keeps the wave disjoint:** this task introduces no new `.test` mocker and no new spreader, so `tauriBarrel.test.ts`'s mock-seam pin (its counts and provenance) is untouched on this task's side. The sibling edits that file to its own end; the two plans' file lists share zero paths. The only cross-file promise is behavioural: `pnpm exec vitest run src/components/ChatStream.test.tsx` must stay 215 and green AFTER this task's rewire, and `src/lib/tauriBarrel.test.ts` must still pass on its current (sibling-managed) numbers. If either red is observed mid-task, do NOT edit either file — report it as a blocker (the sibling's worktree state outranks this task's tree).

## Sources

- `src/components/ChatStream.tsx` (704 lines @ HEAD) — hook-order block (lines 50–553), `workingOrInTurn`/`composerLocked` (98, 171–172), history slice (482–486), dispatcher args (510–516), `useSessionIdleEdge` (547–551), early return (553), JSX consumers (643–653, 686–690); picker-pin comment and `hasImages`/`units` stays.
- `src/lib/chatSessionDerivations.ts` (137 lines) — the 5 existing exports; the module doc "this module never touches a store".
- `src/lib/chatSessionDerivations.test.ts` (230 lines, 17 tests) and `src/hooks/useChatSessionDerivations.test.ts` (233 lines, 11 tests) — both `vi.mock`-free, seeding styles, no-session + selector-stability pins.
- `src/hooks/useChatSessionDerivations.ts` (98 lines) — 5 selectors, 12-name return.
- `src/hooks/useChatPromptDispatch.ts` — `UseChatPromptDispatchArgs.composerLocked: boolean`.
- `src/hooks/useSessionIdleEdge.ts` — `busy`/`key`/`onIdle` contract, "pass `composerLocked` verbatim".
- `src/hooks/useSpinQuip.ts` — `useSpinQuip(working: boolean, deps?)`.
- `src/store/sessions.ts` — `history` slice type (lines ~532–540), `loadOlderHistory`, `inTurn`, `compacting`, `CompactionReason` import.
- `src/store/interactive.ts` — `agentState` union (line ~195).
- `src/lib/tauri.ts` — barrel re-export of `CompactionReason` (type-only).
- `src/components/chat/MessageList.tsx` — `workingOrInTurn`/`hasMore`/`loadingMore`/`generation`/`onStartReached` props.
- `docs/roadmap/chatstream-decomposition-task01-session-derivations.md` (line ~324) — the wave-1 refusal quote.
- `docs/roadmap/chatstream-decomposition-ground-post-wave3.md` — §2.1–2.5 (the movable/target map), §3 (the `dirPrefix` pin quote), §4 (the hook/pure-module surface), §7.1 (hook ordering), §9.
- `docs/roadmap/chatstream-decomposition-status.md` — gate records (§Gate, Wave 3 changelog), flakes, D1 row.