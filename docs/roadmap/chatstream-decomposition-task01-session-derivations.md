---
status: committed
parent: docs/roadmap/chatstream-decomposition-status.md
done-when: |
  `src/lib/chatSessionDerivations.ts` and `src/hooks/useChatSessionDerivations.ts` exist; `ChatStream.tsx`
  consumes the hook and no longer declares the moved derivations itself (including `imageCapable` and its
  `activeCapabilities` selector — `grep -n "activeCapabilities" src/components/ChatStream.tsx` returns
  nothing); the full gate is green from the repo
  root — `pnpm test` (all files pass; the existing `ChatStream.test.tsx` suite, which pins the component's
  derived behaviour, passes unchanged and unmodified) and `pnpm build` (exit 0). Both new test files pass
  individually. The `tauriBarrel.test.ts` mock-set pin is UNCHANGED — read the count at that assertion,
  never restate it (the repo's rule: a count a test asserts is cited by pointing at the test, never copied)
  — and it is unchanged because the new test files mock nothing (the precedents
  `useChildGates.test.ts` / `useSessionStatus.test.ts` contain zero `vi.mock`).
---

# Task 01 — Session State & Capability Derivations (issue #135 §3)

**Goal:** Extract the pure derivation logic out of `ChatStream.tsx`'s component body into a pure module plus a
thin hook, so it can be unit-tested without mounting the ChatStream tree — with **behaviour moved, not improved**.

**Architecture:** `src/lib/chatSessionDerivations.ts` holds PURE functions (no React, no store reads) taking
explicit inputs; `src/hooks/useChatSessionDerivations.ts` is a thin adapter that reads the zustand stores via
selectors and calls the pure functions; `ChatStream.tsx` keeps the selectors that must stay (see below) and
consumes the hook. This is the same "pure core + thin hook" shape the repo already runs for the cue family
(`childGatesOf` + `useChildGates`, `sessionStatusOf` + `useSessionStatus`).

**Tech Stack:** TypeScript (strict), React 19, zustand v5, vitest 5.x, pnpm.

---

## Parallelisation

**Verdict:** SERIAL — this is a single consumed-mode task (one roadmap wave member, Wave 1 of the
`chatstream-decomposition` wave). It has nothing inside itself to parallelise: parallelism lives BETWEEN tasks,
in the wave grouping the roadmap owns; never inside one task. The sibling Wave-1 task (A2) is dispatched by the
roadmap, not by this plan.

---

### Task 1: Extract session/capability derivations into `lib/chatSessionDerivations.ts` + `hooks/useChatSessionDerivations.ts`, and consume the hook from `ChatStream.tsx`

**Parallel:** none — this is the whole consumed-mode task; it has no sibling task inside itself.

**Context:**

`ChatStream.tsx` (1,553 lines at base `b0071544`) derives a cluster of UI facts from store state directly in its
component body: which interactive requests are pending and which `ask`s are anchored vs stacked, whether the
session is live / history-only / resumable, whether the composer is enabled, whether the agent supports images,
and the active turn's `diff` messages. These derivations are pure functions of store slices, but today they are
inline, untestable without mounting the whole component tree (the 7,885-line `ChatStream.test.tsx` is the only
place they are pinned). This task moves them — byte-for-byte where possible — into a pure module plus a thin
hook, and adds focused unit tests for both. It is a refactor commit: any behaviour that looks wrong must be
recorded as a follow-up note, NOT fixed here.

The task is governed by the component's hook-ordering constraint: every hook must be called in the unconditional
block ABOVE the `!activeSessionId` early return (line 565), or React crashes with "Rendered more hooks than
during the previous render" → white page. The new hook must live in that block, and the plan below states
exactly where.

**Files:**

- Create: `src/lib/chatSessionDerivations.ts`
- Create: `src/lib/chatSessionDerivations.test.ts`
- Create: `src/hooks/useChatSessionDerivations.ts`
- Create: `src/hooks/useChatSessionDerivations.test.ts`
- Modify: `src/components/ChatStream.tsx`

Nothing outside this set is touched. `src/components/ChatStream.test.tsx` is NOT modified by this task (it pins
the moved behaviour at component level and must keep passing unchanged).

---

**What to implement:**

### 1. `src/lib/chatSessionDerivations.ts` — the pure module (new)

No React imports. Imports are type-only where possible (`verbatimModuleSyntax` is on — every type-only import
must use `import type`):

```ts
import type { InteractiveRequestData } from "../store/interactive";
import type { Message } from "../lib/sessionTypes";
```

(The `InteractiveRequestData` import is type-only: the pure functions never call store actions. The
`Message` import is type-only. `sessionLookup.ts`'s `sessionFieldOf` is NOT imported here — the walk lives in
the HOOK's selectors (§2), not in this pure module.)

Export exactly these five pure functions, with the bodies below **byte-for-byte** from `ChatStream.tsx`
(verified against the tree at base `b0071544`):

**a. `classifyInteractiveRequests(requests: InteractiveRequestData[]): { askRequests: InteractiveRequestData[]; confirmRequests: InteractiveRequestData[]; passwordRequests: InteractiveRequestData[] }`**

Body — byte-for-byte from `ChatStream.tsx:119-121` (the three `.filter` lines, including the `password` one's
line-break shape):

```ts
  const askRequests = requests.filter((r) => r.method === "ask");
  const confirmRequests = requests.filter((r) => r.method === "confirm");
  const passwordRequests = requests.filter(
    (r) => r.method === "password",
  );
```

Return `{ askRequests, confirmRequests, passwordRequests }`.

**b. `anchoredAskRequestIds(askRequests: InteractiveRequestData[], messages: Message[]): Set<string>`**

Body — byte-for-byte from `ChatStream.tsx:129-137`:

```ts
  const anchored = new Set<string>();
  for (const r of askRequests) {
    if (
      r.source === "main" &&
      r.toolCallId &&
      messages.some((m) => m.kind === "tool-call" && m.id === r.toolCallId)
    ) {
      anchored.add(r.requestId);
    }
  }
  return anchored;
```

**c. `stackedAskRequests(askRequests: InteractiveRequestData[], anchored: Set<string>): InteractiveRequestData[]`**

Body — byte-for-byte from `ChatStream.tsx:139-141`:

```ts
  return askRequests.filter(
    (r) => !anchored.has(r.requestId),
  );
```

**d. `sessionKindDerivations(input: { liveSession: SessionInfo | undefined; activeSessionIsKnown: boolean; activeCapabilities: Record<string, unknown> | undefined }): { isLive: boolean; isHistoryOnly: boolean; canResume: boolean; composerEnabled: boolean }`**

Bodies — byte-for-byte from `ChatStream.tsx:528-530,537`:

```ts
  const isLive = !!input.liveSession;
  const isHistoryOnly = !isLive && input.activeSessionIsKnown;
  const canResume = isHistoryOnly && input.activeCapabilities?.loadSession === true;
  const composerEnabled = isLive || canResume;
```

`SessionInfo` is imported type-only from `../lib/tauri` (the barrel — never from `../lib/tauri/types`; the
barrel guard in `tauriBarrel.test.ts` forbids direct domain-module imports). `activeCapabilities` is
`Record<string, unknown> | undefined` — the exact type `sessionFieldOf` returns for the `"capabilities"` key
and the type `agentSupportsImages` already takes.

**e. `turnDiffs(messages: Message[]): { lastUserIndex: number; turnDiffs: { path: string; patch: string }[] }`**

Bodies — byte-for-byte from `ChatStream.tsx:1189-1200`:

```ts
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "user") return i;
    }
    return -1;
  })();
  const turnDiffs =
    lastUserIndex === -1
      ? []
      : messages
          .slice(lastUserIndex + 1)
          .flatMap((m) =>
            m.kind === "diff" ? [{ path: m.path, patch: m.patch }] : [],
          );
```

Return `{ lastUserIndex, turnDiffs }`.

Carry the load-bearing doc comments over with each function, in substance: the anchored-vs-stacked comment
(`ChatStream.tsx:122-127` — "An `ask` request is ANCHORED when a `tool-call` message with its `toolCallId` is in
the stream… only a `main` ask can anchor; the desktop has no ACP `tool_call` frame for child tool calls") and
the turn-diffs comment (`ChatStream.tsx:1180-1187` — "the `tool-call.diff` refs are deliberately NOT used
(summing both would count every file twice)"). The `composerEnabled` comment (`ChatStream.tsx:531-536` — the
resumable-stored-session rationale) travels with `sessionKindDerivations`.

**What NOT to put in the pure module** (`imageCapable` moves to the HOOK, not here — see §2; the rest
stays in `ChatStream.tsx`, by design — see §3): `composerLocked` and its chain, and the `hasImages`
re-derivation. `imageCapable` is a one-line call to `agentSupportsImages` over the hook's own
`activeCapabilities` selection, so it belongs in the hook (§2), not in the pure module.

### 2. `src/hooks/useChatSessionDerivations.ts` — the thin adapter (new)

Imports (all type-only except the stores):

```ts
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import {
  anchoredAskRequestIds,
  classifyInteractiveRequests,
  sessionKindDerivations,
  stackedAskRequests,
  turnDiffs,
} from "../lib/chatSessionDerivations";
import { sessionFieldOf } from "../lib/sessionLookup";
import { agentSupportsImages } from "../lib/chatAttachments";
```

The hook — the selectors are **verbatim copies** of the ones it replaces in `ChatStream.tsx` (the
selector-stability rule at `ChatStream.tsx:76-77` is preserved exactly — no fresh `[]` fallback inside any
selector; every `?? []` fallback sits OUTSIDE the selector). NOTE the asymmetry: `messages` and
`interactiveRequests` carry `?? []` OUTSIDE their selectors, while `activeCapabilities` and
`liveSession`/`activeSessionIsKnown` are plain selectors — `activeCapabilities` stays
`Record<string, unknown> | undefined` (matching `agentSupportsImages`'s parameter type), it must NOT gain a
`?? {}` fallback. The TWO load-bearing comments above the moved selectors travel with them verbatim (the
three-list-walk / `field-not-row` comment above `activeCapabilities`, and the presence-test comment above
`activeSessionIsKnown` — both quoted in the grounding report's §2a).

```ts
export function useChatSessionDerivations() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const messages =
    useSessions((s) =>
      s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
    ) ?? [];
  const liveSession = useSessions((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.sessionId === s.activeSessionId)
      : undefined,
  );
  const activeCapabilities = useSessions((s) =>
    sessionFieldOf(s, s.activeSessionId, "capabilities"),
  );
  const activeSessionIsKnown = useSessions(
    (s) => sessionFieldOf(s, s.activeSessionId, "sessionId") !== undefined,
  );
  const interactiveRequests =
    useInteractive((s) =>
      activeSessionId ? s.requests[activeSessionId] : undefined,
    ) ?? [];

  const { askRequests, confirmRequests, passwordRequests } =
    classifyInteractiveRequests(interactiveRequests);
  const anchored = anchoredAskRequestIds(askRequests, messages);
  const stacked = stackedAskRequests(askRequests, anchored);
  const kind = sessionKindDerivations({
    liveSession,
    activeSessionIsKnown,
    activeCapabilities,
  });
  const { lastUserIndex, turnDiffs: diffs } = turnDiffs(messages);
  const imageCapable = agentSupportsImages(activeCapabilities);

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
}
```

**Do NOT memoise** the derived arrays with `useMemo`: the component's `MessageList`/`ComposerRow` consumers are
unmemoised today and the component re-derives these arrays on every render already (the filters at
`ChatStream.tsx:119-121` and the anchored loop at `:129-137` run per render). Adding `useMemo` would be a
behaviour change (new array identities) with no consumer that reads identity. The hook re-derives per render,
exactly as the inline code did. (Contrast: `useChildGates` memoises because it is called once per sidebar row;
this hook is called once per ChatStream render.)
`imageCapable` follows the same rule: `agentSupportsImages(activeCapabilities)` is a pure one-liner over a
value the hook already selects, re-derived per render — nothing to memoise.

**No tauri mock needed in the hook's test** — see §5.

### 3. `src/components/ChatStream.tsx` — the modify

**3a. The component's selectors — stay / delete verdicts** (each with its consumer evidence; "stays" means
it is read by code this task does not move):

- `activeSessionId` (`:74`) — read by ~30 sites including the early return, all four effects, `send`, the
  picker, the JSX.
- `messages` (`:76-80`) — read by `units` (`:1449`), `messageCount` (`:1484`), and the anchored-ask loop
  (which moves into the hook — the component's copy of `messages` is still needed for `units`/`messageCount`).
- `liveSession` (`:81-85`) — read ONLY by `isLive` (`:528`), which moves into the hook. **This selector is
  deleted** (its value is now read inside the hook). Confirm no other use: `grep -n "liveSession"` shows only
  `:81`, `:92` (comment), `:528`.
- `activeCapabilities` (`:96-101`) — **This selector is DELETED, verbatim into the hook.** It has exactly TWO
  consumers in the whole component — `imageCapable` (`:325`) and `canResume` (`:530`) — and BOTH move into the
  hook (§2, §3b). Its load-bearing three-list-walk/`field-not-row` comment (`:83-96` — "the ONE three-list
  walk (`lib/sessionLookup.ts`)", "It reads the FIELD and not the row on purpose") travels with it; the hook
  takes the selector and its comment over verbatim. After the edit `grep -n "activeCapabilities"
  src/components/ChatStream.tsx` returns NO matches (the check is the final **Check** line after §3c step 12).
- `activeSessionIsKnown` (`:103-107`) — read ONLY by `isHistoryOnly` (`:529`), which moves into the hook.
  **This selector is deleted** (its value is now read inside the hook). Confirm no other use: `grep -n
  "activeSessionIsKnown"` shows only `:104`, `:525` (comment), `:529`.
- `inTurn` (`:107`) — read by `workingOrInTurn` (`:160`), the Esc effect (`:356,364`), `useSessionIdleEdge`'s
  comment, and `MessageList`'s `inTurn` prop (`:1486`). **Stays.**
- `stopReason` (`:108`) — read by `MessageList`'s `stopReason` prop (`:1494`). **Stays.**
- `prompts` (`:109-113`) — read by `MessageList`'s `prompts` prop (`:1488`). **Stays.**
- `interactiveRequests` (`:114-117`) — read ONLY by the three filters that move. **This selector is deleted**
  (its value is now read inside the hook). Confirm no other use: `grep -n "interactiveRequests"` shows only
  `:115`, `:119-121`.
- The store actions (`addUserMessage`, `addSystemLine`, `beginTurn`, `turnCompleted`, `resumeSession`, `:142-148`)
  — read by `send`/`sendText`/`resume`/`flushHead`, which stay. **Stays.**
- `agentState` (`:157-158`) — read by `workingOrInTurn`, `composerLocked`, and the `agentState` props
  (`:1493,1538`). **Stays.**
- `compacting` (`:170-171`) — read by `composerLocked`, the Esc effect, and the `compacting` prop (`:1540`).
  **Stays.**
- `history`/`loadOlder`/`hasMore`/`loadingMore`/`generation` (`:539-543`) — read by `MessageList`'s props and
  `onStartReached`. **Stays.**
- `spinnerStyle`/`emptyStateAnimation`/`mcpMentionsEnabled` (`:172-219`) — read by `ComposerRow`/`MessageList`
  and `expandMentions`. **Stays.**

**3b. What STAYS in the component, deliberately** (behaviour is moved, not improved — these are NOT moved
because their inputs or consumers are outside the pure seam):

- **`composerLocked` and its chain** (`workingOrInTurn` `:160`, `composerLocked` `:233-234`) — `workingOrInTurn`
  is read by `useSpinQuip` (`:239`, a hook that must stay in the unconditional block), `composerLocked` is read
  by `send`'s queue fork (`:764`), by `useSessionIdleEdge` (`:560`), and by `ComposerRow` (`:1535`). Moving the
  chain would force `useSpinQuip`/`useSessionIdleEdge`/`send` to read the hook's return, coupling the Flush
  trigger (Task C1's seam) to this task. The chain is pure over its inputs (`agentState`, `inTurn`,
  `compacting`), but those inputs are three separate store slices already selected in the component and the
  chain's consumers are all component-scope. **It stays.**
- **`hasImages`** (`:584`) — post-guard (its own comment: "the last line of the fail-closed defense"), and
  re-derived inside `send` under the auto-resume arm (`:856`). **Stays, as Task C1's seam** — its consumer
  `ComposerRow` (`:1537`) and the `send`/`flushHead` paths that read it stay with the component, and its
  post-resume re-derivation is `send`'s own (untouched by this task, see §3c step 10). **`imageCapable` moves
  into the hook** — the component destructures the hook's return and keeps the name in scope, so every
  `imageCapable` consumer reads the SAME value it reads today:
  - `hasImages` (`:584`) — `attachments.length > 0 && imageCapable`, post-guard (Task C1's seam);
  - `flushHead` (`:1074`) — the fail-closed `entry.attachments.length > 0 && imageCapable` gate (Flush never
    resumes, so this stays a render-derived closure read);
  - the three attachment handlers — `handlePaste` (`:1289`), `handleDrop` (`:1359`),
    `handleAttachClick` (`:1378`) — each `if (!imageCapable) return;` (the `:1378` one also reads
    `composerEnabled`);
  - `ComposerRow`'s `imageCapable` prop (`:1536` — `ComposerRow.tsx:110` types it `boolean`, read at `:308`).
  There is NO coupling problem: the value comes from the hook's return, held in component scope, and no
  selector is left for a later task to "still need". (`stageFiles`/`removeAttachment` do NOT read
  `imageCapable` — only the three gates above and the two flag reads do. The comment at `:1351` describes the
  gate, it is not a consumer.)

**Why `imageCapable` moves and nothing else does**: its input `activeCapabilities` is already selected by the
hook (as `canResume`'s input), and `agentSupportsImages` is already exported from `src/lib/chatAttachments.ts`
— the hook imports and calls it (§2), it does NOT reimplement it. This also closes the gap against the
acceptance criteria of issue #135 §3, which names `imageCapable` explicitly (per the task authoring
dispatch; the issue itself is the GitHub tracker, not in this tree).

**3c. The deletions and the hook consumption** (the actual edit):

1. Delete the `interactiveRequests` selector and the three filters (`:114-121`).
2. Delete the anchored-ask block (`:122-141`) including its comment (the comment travels to the pure module).
3. Delete the `liveSession` selector (`:81-85`) and the `activeSessionIsKnown` selector (`:103-107`).
4. **Delete the `activeCapabilities` selector (`:96-101`) INCLUDING its load-bearing three-list-walk /
   `field-not-row` comment (`:83-96`) — the whole block moves verbatim into the hook (§2), comment and all.**
   This is the largest seam reduction available in this task, not a no-op: the `sessionFieldOf` walk leaves
   `ChatStream.tsx` entirely, and with both its consumers (`imageCapable` `:325`, `canResume` `:530`) moved
   there is not one selector left in the component for a later task to "still need".
5. Delete the `isLive`/`isHistoryOnly`/`canResume`/`composerEnabled` block (`:524-537`) including the
   `composerEnabled` comment (it travels to the pure module). The `isLive` mention in the comment at `:245`
   ("`isLive` below stays — the composer still needs it for the auto-resume path") is now stale; update that
   comment's wording to say the value comes from `useChatSessionDerivations` (a comment-only edit — the
   `send()` auto-resume arm at `:842` still reads `isLive`).
6. Delete the `lastUserIndex`/`turnDiffs` block (`:1188-1200`) including the `:1180-1187` comment (it travels
   to the pure module).
7. Delete the `imageCapable` derivation (`:325` — `const imageCapable = agentSupportsImages(activeCapabilities);`
   plus the "Capability gate (FAIL-CLOSED)…" comment directly above it). It moves into the hook (§2); the
   consumers need only the VALUE, which the `useChatSessionDerivations` destructure below provides.
8. Add the hook call. **The new hook call goes in the unconditional top block, immediately after the
   `interactiveRequests`-era position — concretely: directly after the `prompts` selector (the former `:113`),
   before the store-action selectors at `:142`.** It is a hook (it calls `useSessions`/`useInteractive`, which
   read via `useSyncExternalStore`), so it MUST sit above the `!activeSessionId` early return at `:565` — the
   hook-ordering rule. It must also sit before `useSpinQuip`/`useSessionIdleEdge` only in the sense that all of
   them are in the unconditional block; the exact order among unconditional hooks does not matter for React's
   hook count, but placing it with the selectors it replaces keeps the diff readable. Place the call so the
   destructured values are in scope for every consumer below.
9. Destructure the hook's return, keeping the names byte-identical so the JSX and `send` read unchanged:
   `const { askRequests, confirmRequests, passwordRequests, stackedAskRequests, isLive, canResume,
   composerEnabled, turnDiffs, imageCapable } = useChatSessionDerivations();` — do NOT move the
   component's existing store-action selectors (`addUserMessage`/`addSystemLine`/`beginTurn`/
   `turnCompleted`/`resumeSession`, `:142-148`) into the hook: they are actions, not derivations, and they
   must keep their position relative to the other selectors (shuffling them is a gratuitous diff this task
   does not need). The essential constraint is only that the hook call sits in the unconditional block ABOVE
   the `!activeSessionId` early return; its exact position among the unconditional selectors is cosmetic.
   (`lastUserIndex` is returned by the hook but NOT destructured here — see step 10's note below; a
   destructured-but-unused name WOULD trip `noUnusedLocals`, so it is simply not destructured, which is
   legal — object members are not locals.)
10. Replace the consumers with the hook's returns, keeping the names byte-identical so the JSX and `send` read
    unchanged:
    - `askRequests` → `MessageList`'s `askRequests` prop (`:1487`)
    - `stackedAskRequests` → `MessageList`'s `stackedAskRequests` prop (`:1489`)
    - `confirmRequests` → `ComposerModals`'s `confirmRequests` prop (`:1548`)
    - `passwordRequests` → `ComposerModals`'s `passwordRequests` prop (`:1549`)
    - `isLive` → `send`'s `!isLive` auto-resume arm (`:842`) and the `canResume` guard (`:843`)
    - `canResume` → `send`'s `:843` guard
    - `composerEnabled` → `handleAttachClick` (`:1378`) and `ComposerRow`'s `composerEnabled` prop (`:1534`)
    - `turnDiffs` → `MessageList`'s `turnDiffs` prop (`:1494`)
    - `imageCapable` → `hasImages` (`:584`), `flushHead` (`:1074`), the three handlers (`:1289,1359,1378`),
      and `ComposerRow`'s `imageCapable` prop (`:1536`). Verified consumer map: `grep -n "imageCapable"
      src/components/ChatStream.tsx` hits the derivation (`:325`, which step 7 deletes), these SIX code
      consumers, and four COMMENTS (`:579,1035,1067,1351`) that describe the gate — none of which keep the
      value in scope; every code read of `imageCapable` is one of the six consumers.
    - `lastUserIndex` → nothing (its only consumer is the `turnDiffs` derivation, which moved together; it is
      NOT destructured in the component — see step 9's note — but the hook still returns it, and the
      pure-module test pins it).
11. Add the import: `import { useChatSessionDerivations } from "../hooks/useChatSessionDerivations";` (with the
    other `../hooks/` imports at `:36-47`).
12. **Delete the now-dead `sessionFieldOf` import** (`:17`). With `activeCapabilities` (step 4) and
    `activeSessionIsKnown` (step 3) both gone, `sessionFieldOf` has ZERO callers left in the component —
    `grep -n "sessionFieldOf" src/components/ChatStream.tsx` returns nothing after those two deletions, and
    with `noUnusedLocals` on an unused import fails `tsc --noEmit`.

**Check: `grep -n "activeCapabilities" src/components/ChatStream.tsx` → NO matches.** (It returns nothing
after the deletions; the name exists only inside the hook's module now.)

**Do NOT touch** `ChatStream.test.tsx`, any handler, `send`/`sendText`/`flushHead`/`resume`, the effects, the
refs, or the JSX beyond the prop-name-identical consumption above. **`send`'s post-auto-resume `hasImages`
re-derivation (`:856`) is NOT a consumer of `activeCapabilities` — rebuttal for a later implementer:** it
reads a FRESH value via `useSessions.getState().sessions.find((x) => x.sessionId === targetSessionId)` and
calls `agentSupportsImages(fresh?.capabilities)` directly, because the resume may have changed capabilities
and the SAVED capabilities that gated `hasImages` are stale. That code stays `send`'s and is untouched by
this task — do NOT re-introduce an `activeCapabilities` read here (there is none today; the earlier plan and
its vet were wrong on this point, which is exactly why the selector gets deleted instead of staying).

### 4. `src/lib/chatSessionDerivations.test.ts` — the pure-module tests (new)

**No `vi.mock` of any kind** (see §5 — this is the deliberate choice). Import the five functions from
`./chatSessionDerivations`. Use the fixtures barrel (`src/test/fixtures`) — `makeMessage` for `Message`s and
`makeSessionRow` for the `SessionInfo` `sessionKindDerivations` takes — never hand-rolled fixtures. (The barrel
header's hoisting rule — "inside a `vi.mock` factory use `await import()`" — does not bite here: this file has
no `vi.mock`.)

`InteractiveRequestData` fixtures are built inline (there is no fixture for them; `useChildGates.test.ts` builds
them inline with a small `ask()` helper — follow that house style):

```ts
const ask = (requestId: string, over: Partial<InteractiveRequestData> = {}): InteractiveRequestData => ({
  requestId,
  method: "ask",
  source: "main",
  params: {},
  ...over,
});
```

Cases (each pins the byte-identical behaviour from the component):

- `classifyInteractiveRequests`: mixed list of `ask`/`confirm`/`password` → three arrays split by `method`;
  empty list → three empty arrays.
- `anchoredAskRequestIds`: an `ask` with `source: "main"` + `toolCallId` matching a `tool-call` message's `id`
  → anchored; the same request with NO matching message → not anchored; `source: "child"` (or any non-`"main"`)
  with a matching message → NOT anchored (the `source === "main"` gate); a `toolCallId`-less ask → not
  anchored. Build the `tool-call` message with `makeMessage("tool-call", { id: "t1" })`.
- `stackedAskRequests`: an anchored id is excluded, a non-anchored id is kept, arrival order preserved.
- `sessionKindDerivations`: live session (`makeSessionRow({ sessionId: "s1" })`) → `isLive: true`,
  `isHistoryOnly: false`, `canResume: false`, `composerEnabled: true`; no live session + `activeSessionIsKnown:
  true` + `activeCapabilities: undefined` → history-only, `canResume: false`, `composerEnabled: false`; no live
  session + known + `activeCapabilities: { loadSession: true }` → resumable, `composerEnabled: true`;
  `activeCapabilities: { loadSession: false }` → NOT resumable (the `=== true` strictness); no live session +
  `activeSessionIsKnown: false` → `isHistoryOnly: false`, `canResume: false`, `composerEnabled: false`
  (the full row is load-bearing: `canResume` is `isHistoryOnly && activeCapabilities?.loadSession === true`,
  so without asserting it a future `isHistoryOnly = activeSessionIsKnown` typo stays green — `composerEnabled`
  alone would not catch it).
- `turnDiffs`: messages ending in a `user` message → `lastUserIndex` is that index, `turnDiffs` is `[]`;
  trailing `diff` messages after the last `user` → collected as `{ path, patch }`; a `tool-call` message
  carrying a `diff` field after the last user → NOT collected (pins the "summing both would count every file
  twice" rule — use `makeMessage("tool-call", { id: "t1", diff: { path: "x", patch: "y" } })` and assert it is
  absent from `turnDiffs`); no `user` message at all → `lastUserIndex: -1`, `turnDiffs: []`; a `diff` BEFORE
  the last user → not collected.

### 5. `src/hooks/useChatSessionDerivations.test.ts` — the hook tests (new)

**Mocking decision: NO tauri mock, and no `vi.mock` at all.** The hook reads only the sessions and interactive
stores (real zustand singletons), the pure module, and `agentSupportsImages` from `src/lib/chatAttachments.ts`
— no `lib/tauri` import is reachable from the hook or its dependencies (`sessionLookup.ts` imports only
`lib/tauri`'s TYPES, which vanish at runtime; `store/sessions.ts`
imports the barrel but the hook never calls an action, so no IPC path is exercised; `chatAttachments.ts`
imports only `./chatAttachmentMetadata`, which itself imports nothing — no barrel, no runtime tauri value).
This is exactly the shape
`useChildGates.test.ts` and `useSessionStatus.test.ts` already run — both mock nothing (verified: zero
`vi.mock` in each). **Consequence: the `tauriBarrel.test.ts` pin is UNCHANGED (read the count at the
assertion — 38 mockers / 37 spreading `vi.importActual` as of `b0071544`; the repo's rule is that a count a
test asserts is cited by pointing at the test, never copied).** If during implementation the hook somehow needs
a barrel mock, STOP and record it as a
blocker — do not silently grow the pin (a growth would require updating `tauriBarrel.test.ts`, which is
outside this task's owned file set).

Structure: `beforeEach(() => resetStores())` (from `../test/resetStores` — the store half of isolation; the
hook tests need no `vi.clearAllMocks` since there are no mocks). Seed with the real stores, exactly like
`ChatStream.test.tsx`'s seeds but via `useSessions.setState`/`useInteractive.setState` — the hook test's
minimal inline seeding is DELIBERATELY self-contained and is NOT `src/test/chatStreamFixtures.ts`: that file
is the Owns boundary of a SIBLING TASK in this same wave (Task 02 — it extracts the module-level scaffolding
from `ChatStream.test.tsx`), so nobody reaches across the Owns boundary by importing it here. The history-only
seed sets ONLY `historySessions` (leaving `sessions` and `archivedSessions` at their `[]` initial values) and
that is sound because the three-list walk reads all three lists — `sessions`, `historySessions`,
`archivedSessions` — and all three are `[]` in `src/store/sessions.ts`'s initial state (verified at
`:993-995`); `resetStores()` has restored that initial state in `beforeEach`, so a partial `setState` shallow
merge leaves the other two lists at `[]` exactly as intended:

- Live: `useSessions.setState({ activeSessionId: "s1", sessions: [makeSessionRow({ sessionId: "s1" })], messages: { s1: [...] } })`.
- History-only: `activeSessionId: "s1"`, `sessions: []`, `historySessions: [makeSessionRow({ sessionId: "s1" })]`.
- Resumable: as history-only with `makeSessionRow({ sessionId: "s1", capabilities: { loadSession: true } })`.
- Requests: `useInteractive.setState({ requests: { s1: [...] } })`.

Use `renderHook` from `@testing-library/react` (the house style — `useChildGates.test.ts` uses it). Cases:
each pure-module case re-driven through the stores (live → `isLive`/`composerEnabled` true; history-only →
false; resumable → `canResume`/`composerEnabled` true; requests seeded → `askRequests`/`confirmRequests`/
`passwordRequests` split; a `tool-call` message + matching ask → `stackedAskRequests` excludes it; trailing
diffs → `turnDiffs` populated; no-session state → all empty/false, and the hook does NOT throw). `imageCapable`
is asserted the same way — live with image-capable capabilities
(`makeSessionRow({ sessionId: "s1", capabilities: { promptCapabilities: { image: true } } })`) →
`imageCapable: true`; capabilities without `promptCapabilities.image` (or `{}`) → `imageCapable: false`;
and no-session → `imageCapable: false` (fail-closed — `agentsSupportsImages(undefined)` is `false`, the exact
posture the component's comment calls "FAIL-CLOSED"). Note the `?? []` fallback IS NOT applied to
`activeCapabilities` — it is `Record<string, unknown> | undefined` and stays so, matching
`agentSupportsImages`'s parameter type. Also pin the selector-stability rule: with an active session and
empty `messages`/`requests`, the arrays returned are stable across two `renderHook` rerenders (the `?? []`
fallbacks live outside the selectors).

### 6. Follow-up notes (behaviour is MOVED, not improved — record, do not fix)

- The `interactiveRequests`/`prompts`/`messages` selectors each apply `?? []` OUTSIDE the selector — preserved
  exactly. No improvement attempted.
- The `anchoredAskRequestIds` loop's `Set` is rebuilt per render — preserved (the pure function returns a fresh
  `Set` per call, exactly as the inline code did).
- `sessionKindDerivations`'s `composerEnabled` is derived from `isLive || canResume` — preserved verbatim,
  including the "textarea always editable" nuance which lives in the component's comment.
- Nothing in the in-scope list looked wrong; if the implementer spots something that does, record it in the
  commit message / a follow-up note rather than fixing it.

---

**Steps:**

- [ ] Write `src/lib/chatSessionDerivations.ts` (the five pure functions, §1).
- [ ] Write `src/lib/chatSessionDerivations.test.ts` (§4), then run `npx vitest run src/lib/chatSessionDerivations.test.ts`
  - Did it pass? If a case fails, the pure body was not copied byte-for-byte — fix the copy, not the test.
- [ ] Write `src/hooks/useChatSessionDerivations.ts` (§2).
- [ ] Write `src/hooks/useChatSessionDerivations.test.ts` (§5), then run `npx vitest run src/hooks/useChatSessionDerivations.test.ts`
  - Did it pass? If a case fails, check the seeding, not the derivation.
- [ ] Modify `src/components/ChatStream.tsx` (§3): delete the moved blocks (including the
      `activeCapabilities` selector + comment), add the hook call in the
      unconditional block after the `prompts` selector, replace the consumers with the hook's returns
      (names byte-identical), update the stale `:245` comment.
- [ ] Run `grep -n "activeCapabilities" src/components/ChatStream.tsx` — expect NO matches (the **Check**
      line after §3c step 12; the name now lives only in the hook's module).
- [ ] Run `npx vitest run src/components/ChatStream.test.tsx` — the 278-test suite (count per the vitest
      runner, measured at HEAD; `grep -c "it("` on the file gives a different number because of `it.each` —
      cite the runner's count, never hand arithmetic) must pass UNCHANGED (this is the primary
      anti-regression gate: it pins the moved behaviour at component level).
      - Did it pass? If not, the hook call may have landed after the early return, or a consumer name
        changed — re-check §3.
- [ ] Run `npx tsc --noEmit` (the fastest type gate; `noUnusedLocals` is on, so unused destructured names
      surface here — including the now-dead `sessionFieldOf` import if step 12 was skipped).
- [ ] Run the full gate from the repo root:
      - `pnpm test` — all files pass (baseline at `b0071544`: 157 files, 3318 passed | 1 skipped; the two
        known flakes — `MessageBubble.codeblock.test.tsx`'s `it.each` JSON fence case and
        `Reasoning.test.tsx`'s wall-clock assertion — are load-dependent; re-run before investigating).
      - `pnpm build` — `tsc && vite build`, exit 0.
- [ ] Commit with message: `refactor(chatstream): extract session/capability derivations into lib + hook (issue #135 §3)`
      - **Wave 1 member:** this task is dispatched in a wave of width 2 (A1 + A2), so the child does NOT
        commit; the orchestrator commits its files after the wave, using this message verbatim. The child
        works in its own worktree on its own branch and runs the full suite there (its result measures only
        its own task).

**Acceptance criteria:**

- [ ] `src/lib/chatSessionDerivations.ts` exports exactly `classifyInteractiveRequests`,
      `anchoredAskRequestIds`, `stackedAskRequests`, `sessionKindDerivations`, `turnDiffs`; each body is the
      byte-for-byte copy named in §1 (verified by the tests' exact-value assertions).
- [ ] `src/hooks/useChatSessionDerivations.ts` reads stores only through the six selectors named in §2 (all
      verbatim copies, `?? []` outside the selectors — `activeCapabilities` stays `Record<string, unknown> |
      undefined`, NO `?? []` applied to it) and calls the pure functions PLUS `agentSupportsImages`
      (`src/lib/chatAttachments.ts`, imported, never reimplemented) to derive `imageCapable`; it contains no
      `useMemo`, no `useEffect`, no `lib/tauri` import.
- [ ] `ChatStream.tsx` calls `useChatSessionDerivations()` in the unconditional block ABOVE the
      `!activeSessionId` early return (the hook-ordering rule, §3c step 8), and no longer declares
      `interactiveRequests`, `askRequests`, `confirmRequests`, `passwordRequests`, `anchoredAskRequestIds`,
      `stackedAskRequests`, `liveSession`, `activeSessionIsKnown`, `activeCapabilities`, `imageCapable`,
      `isLive`, `isHistoryOnly`, `canResume`, `composerEnabled`, `lastUserIndex`, or `turnDiffs` itself
      (`grep -n` each name: the only hits are the hook call's destructuring and the consumers).
- [ ] `ChatStream.tsx` still declares `composerLocked`, `workingOrInTurn`, `hasImages`, `agentState`,
      `compacting`, `inTurn` — and `grep -n "sessionFieldOf" src/components/ChatStream.tsx` returns NOTHING
      (the import at `:17` is dead once the two walk selectors move into the hook; `noUnusedLocals` fails the
      build if it is left behind).
- [ ] `grep -n "activeCapabilities" src/components/ChatStream.tsx` → NO matches (the walk is the hook's now,
      comment and all); `grep -n "imageCapable" src/components/ChatStream.tsx` hits only the
      `useChatSessionDerivations` destructure, the six code consumers (`:584` `hasImages`, `:1074` `flushHead`,
      `:1289,1359,1378` the three handlers, `:1536` the `ComposerRow` prop), and the four comments that
      describe the gate (`:579,1035,1067,1351`).
- [ ] `src/components/ChatStream.test.tsx` is UNMODIFIED and passes unchanged — the component-level pin of the
      moved behaviour is green.
- [ ] Both new test files pass individually (commands in Steps).
- [ ] `pnpm test` and `pnpm build` are green from the repo root.
- [ ] `src/lib/tauriBarrel.test.ts`'s "the scanner sees the mock seam it exists to protect" assertion still
      reads the same count as before — the new test files mock nothing (the precedents
      `useChildGates.test.ts` / `useSessionStatus.test.ts` contain zero `vi.mock`), so the pin is untouched.
      Read the count AT THE ASSERTION (`expect(mockers).toHaveLength(…)` — currently 38, with 37 spreading
      `vi.importActual`); never copy it here. Verify by running `npx vitest run src/lib/tauriBarrel.test.ts`.
- [ ] No file outside the owned set was created, modified, or deleted (check `git status --porcelain` in the
      worktree: exactly the five owned files, plus whatever the orchestrator's `pnpm install` produced).

---

## Notes for the caller's vet (things verified on the tree, and the few that could not be)

All facts below were verified by reading the tree at `b0071544` (branch `feature/chatstream-decomposition`,
HEAD `22f16d3a` — the grounding commit on top of `b0071544`):

- **Hook-ordering comments quoted** (§1a–1g of the grounding report; re-read in the file): the six load-bearing
  comments at `:234-239` (`useSpinQuip`), `:258-267` (`useHasPendingRequest`), `:270-278` (`useChildGates`),
  `:284-289` (attachment cell), `:405-421` (picker block), `:545-563` (`useSessionIdleEdge`). The new hook is
  designed to sit with the selectors it replaces, all above the `:565` early return.
- **Selector-stability rule** verified at `:76-77` and preserved: every `?? []` fallback stays outside its
  selector.
- **`sessionFieldOf` walk** verified in `src/lib/sessionLookup.ts`: the ONE three-list walk (live → history →
  archived), returns the FIELD not the row; the `activeCapabilities`/`activeSessionIsKnown` selectors move
  verbatim into the hook, walk untouched — and therefore LEAVE `ChatStream.tsx` entirely (both consumers of
  `activeCapabilities` were `imageCapable` + `canResume`, both now in the hook; `activeSessionIsKnown`'s only
  consumer was `isHistoryOnly`). The component's `sessionFieldOf` import dies with them.
- **`tauriBarrel.test.ts` pin** read at the source: `expect(mockers).toHaveLength(38)` and
  `expect(mockers.filter(...vi.importActual...).length).toBe(37)`. The plan deliberately does not restate these
  numbers as "current" beyond the verification note — they are read from the assertion, never copied into the
  plan as a value to maintain by hand.
- **No-tauri-mock choice verified against the tree**: `useChildGates.test.ts` and `useSessionStatus.test.ts`
  (the closest house-style precedents) contain zero `vi.mock`; the hook's dependency graph reaches no runtime
  `lib/tauri` value (only type imports). This SURVIVES the `imageCapable` move: `src/lib/chatAttachments.ts`
  (the new `agentSupportsImages` import) imports only `./chatAttachmentMetadata`, which itself imports
  nothing — no barrel, no runtime tauri value. So the pin is untouched by design.
- **`ChatStream.test.tsx` count measured at HEAD**: `npx vitest run src/components/ChatStream.test.tsx`
  reports **278 tests** (the `grep -c "it("` method undercounts because of `it.each` and multi-line `it(`
  calls — the runner is the only trustworthy count).
- **Fixtures barrel** verified: `makeSessionRow`, `makeSettings`, `makeSpaceRow`, `makeMessage` all exported
  from `src/test/fixtures`; `makeMessage` keyed by `kind` with `at: 1_000` default.
- **`resetStores`** verified: resets all seven stores to zustand's captured initial state with `replace: true`.
- **Types verified**: `InteractiveRequestData` (`src/store/interactive.ts`, `method: "ask" | "confirm" |
  "password"`, `source: string`, `toolCallId?: string`), `Message` (`src/lib/sessionTypes.ts`, `diff` kind has
  `path`/`patch`), `SessionInfo.capabilities` (`Record<string, unknown>`), `CompactionReason` union, store
  shapes (`messages`, `inTurn`, `stopReasons`, `compacting` maps keyed by session id).
- **`noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`** verified on in `tsconfig.json` — the plan's
  type-only-import and unused-destructured-name guidance follows from them.
- **Commands verified**: `package.json` has `"test": "vitest run"` and `"build": "tsc && vite build"`; the
  grounding report's command table confirms `npx vitest run <file>` per-file form and `npx tsc --noEmit`.

**UNVERIFIED / could not be checked by this planner:**

1. **The exact current line numbers in `ChatStream.tsx`** — measured at `b0071544`; HEAD is `22f16d3a` (a
   docs-only commit on top), and this planner re-read the relevant regions and confirmed the quoted text at
   the reported lines — CONFIRMED in this refinement round: `git diff b0071544..HEAD -- src/components/ChatStream.tsx`
   is empty (verified), so the numbers are current. The plan's steps name SYMBOLS, not line numbers, so small
   drift would be harmless anyway.
2. **RESOLVED in this refinement** — `useSessions.setState` partial seeding: `src/store/sessions.ts`'s
   initial state is `sessions: []`, `historySessions: []`, `archivedSessions: []` (all three verified at
   `:993-995`), and `resetStores()` restores exactly that captured initial state with `replace: true` before
   each test, so a partial (shallow-merge) `setState({ historySessions: [...] })` leaves the other two lists
   at `[]` — the walk resolves the session from `historySessions`, exactly as the history-only seed intends.
   (The earlier note's "dim: `:1002`-region" misremembering is corrected: the three initializers are at
   `:993-995`.)
3. **The `SessionInfo` import path for the pure module** — the plan says `import type { SessionInfo } from
   "../lib/tauri"` (the barrel). The barrel guard allows it; the vet should confirm `SessionInfo` is in the
   pinned public API (it is, per `tauriBarrel.test.ts`'s `TAURI_PUBLIC_API` list — verified at `:292`).
4. **Whether `MessageList`/`ComposerRow`/`ComposerModals` prop types accept the hook's returned arrays
   unchanged** — the arrays are the same element types the component passes today, so this should hold; the
   vet can confirm by reading the three components' prop types.
5. **`send`'s post-auto-resume `hasImages` re-derivation (`:856`)** — NOT a consumer of `activeCapabilities`,
   and deliberately left `send`'s by this task. It reads a FRESH value via
   `useSessions.getState().sessions.find((x) => x.sessionId === targetSessionId)` and calls
   `agentSupportsImages(fresh?.capabilities)` directly (verified at `:850-857`), because the resume may have
   changed capabilities and the SAVED capabilities that gated the component-scope value are stale. This is
   the objection that made the earlier plan and its vet both wrong ("`activeCapabilities` must stay because
   `imageCapable` stays" is circular once the one-line derivation that consumes the selector moves too) — it
   is stated here so a later implementer does not re-derive it. That code stays `send`'s and is untouched by
   this task.

**Sources:**

- `docs/roadmap/chatstream-decomposition-ground-chatstream-body.md` (the grounding report — all verbatim quotes)
- `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md` (test infra, the tauri mock seam, fixtures)
- `src/components/ChatStream.tsx` (base `b0071544`) — the moved blocks, the six hook-ordering comments, the usage map
- `src/lib/sessionLookup.ts` — `sessionFieldOf` contract
- `src/lib/tauriBarrel.test.ts` — the 38/37 mock-seam pin
- `src/store/interactive.ts`, `src/store/sessions.ts`, `src/store/permissions.ts` — store shapes
- `src/lib/sessionTypes.ts`, `src/lib/chatAttachments.ts` — `Message`, `agentSupportsImages`
- `src/hooks/useChildGates.ts` + `useChildGates.test.ts`, `src/hooks/useSessionStatus.ts` — the pure-core + thin-hook house shape
- `src/test/fixtures/index.ts` + `sessions.ts`, `src/test/resetStores.ts` — fixtures and reset discipline
- `tsconfig.json`, `package.json` — compiler flags and commands