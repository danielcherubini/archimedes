---
status: committed
parent: docs/roadmap/chatstream-decomposition-status.md
done-when: "Issue #135 §2 is shipped: `sendText`, `send`, `resume` and the `/compact` interception live in `src/hooks/useChatPromptDispatch.ts`; `flushHead` and the `flushRef.current` assignment live in `src/hooks/usePromptQueueFlusher.ts`; `ChatStream.tsx` calls both hooks in its unconditional block above the `!activeSessionId` early return and the one `sendingSessionsRef` Set (declared exactly once in `ChatStream.tsx`) is passed to both; the `/compact`, locked-fork and Flush test groups have moved out of `ChatStream.test.tsx` into the two new `.test.tsx` files; `pnpm test` from the repo root reports 163 files, 3356 passed | 1 skipped, exit 0, and `pnpm build` exits 0."
---

# ChatStream decomposition — Task C1 (issue #135 §2): Prompt Dispatch & Queue Flush Orchestration

**Goal:** Move `sendText`, `send`, `resume` and the `/compact` Composer-command handling into `useChatPromptDispatch`, and `flushHead` + the `flushRef` assignment into `usePromptQueueFlusher`, with ZERO behaviour change; relocate the dispatch/queue/flush test groups to match.
**Architecture:** Two new hooks, both called in `ChatStream`'s unconditional hook block (above the `!activeSessionId` early return), sharing the ONE `sendingSessionsRef` Set which `ChatStream` keeps declaring and passes to both. The dispatch hook receives the `useChatAttachments` boundary functions as arguments (it re-owns none of the attachment state). The flusher hook receives `flushRef` + the dispatch hook's `sendText` — preserving today's "`flushHead` is declared after `sendText` so it closes over it" ordering.
**Tech Stack:** React 19 hooks, zustand stores (module singletons), Vitest 5 + Testing Library (jsdom), `vi.mock` inline factories.

**Conventions governing EVERY step below (read first):**
- **Behaviour is MOVED, not improved.** Every body below is a VERBATIM move; the only permissible edits are (a) the arg-threading substitutions listed in §"Equivalence substitutions (must be documented, must not change behaviour)" and (b) renames of the moved `describe` titles to name their owning hook. Any improvement discovered mid-move is recorded in a comment in the commit body, never made.
- **Anchor by SYMBOL, not line number.** Line numbers cited below are the positions measured at code HEAD `0aa99ffb` / docs HEAD `77cb4f1a` and are navigation aids only; symbols are the contract.
- **The implementer executes this plan verbatim and context-free.** Where a count or comment must be read off the tree, the plan says "read/measure", never "trust this number".

---

## Parallelisation

**Verdict:** SERIAL — this plan holds exactly ONE task. The skill's consumed-mode rule is that a one-task plan has nothing to parallelise with (parallelism in a `roadmap` run happens between tasks, in the wave grouping `roadmap` owns; the status file already records wave 3 as width 1, unisolated in the primary tree). No `**Parallel:**` line is emitted.

---

### Task C1: Extract `useChatPromptDispatch` + `usePromptQueueFlusher`, move the dispatch/queue/flush tests

**Context:**
`ChatStream.tsx` (1206 lines at HEAD) still holds the whole dispatch path: `sendText` (the shared send tail), `send` (the typed-prompt dispatch with the ADR 0069 queue fork, the ADR 0044 `/compact` interception and the double-send guard), `flushHead` (the Prompt-queue Flush, ADR 0069) and `resume`. These four functions are INTERLOCKED through refs and the `useChatAttachments` boundary: `send` reads `attachmentsRef.current` and calls `clearStaged`/`moveOutForSend`/`restoreHeldForSend`/`releaseHeldForSend`; `send` and `flushHead` both claim/release the SAME `sendingSessionsRef` Set; `flushHead` invokes `sendText`; `useSessionIdleEdge` (already a hook, stays in the component) reaches `flushHead` through `flushRef`. Issue #135 §2 therefore cuts ONE task: the dispatch core, the queue flush and resume share `sendingSessionsRef`, `flushRef` and the held-attachment boundary functions, so they can never be separate tasks (the status file's "Merged on purpose (C1)" decision records this). Wave 2 already handed this task its seam: `useChatAttachments` (issue #135 §1) landed with a 12-name returned surface and the held map (`heldForSendRef`) no longer exists in `ChatStream.tsx` (verified: grep shows only one comment hit at line 678 — the map lives inside the attachment hook; do NOT plan to move it again).

**Files:**
- Create: `src/hooks/useChatPromptDispatch.ts`
- Create: `src/hooks/useChatPromptDispatch.test.tsx` (`.tsx` — the moved tests render `<ChatStream />`, i.e. JSX; `tsc` rejects JSX in a `.ts` file, measured)
- Create: `src/hooks/usePromptQueueFlusher.ts`
- Create: `src/hooks/usePromptQueueFlusher.test.tsx` (`.tsx`, same reason)
- Modify: `src/components/ChatStream.tsx`
- Modify: `src/components/ChatStream.test.tsx`
- Modify: `src/lib/tauriBarrel.test.ts` (mock-seam pin update ONLY — see §Barrel pin)

All paths are inside the dispatcher's owned set. Nothing else is touched.

**What to implement:**

## 1. The two new hooks — signatures

### 1a. `src/hooks/useChatPromptDispatch.ts`

Exports (all new):

```ts
export type SendTextImages = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: string;
}[];
```
(Verbatim move of the type + its doc comment from `src/components/ChatStream.tsx` lines 52–58; that comment says "Exported because Task 5's Flush builds one" — now it is exported because the FLUSHER's `sendText` argument is typed with it. Verified with `grep -rn "SendTextImages" src/`: the only importer is `ChatStream.tsx` itself, so moving it breaks nothing.)

```ts
export interface UseChatPromptDispatchArgs {
  // component setters — the hook owns neither cell (the same split as
  // useChatAttachments: "the hook owns none of them").
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
  // live refs — handled in, exactly as `send` reads them today.
  draftRef: RefObject<string>;
  activeSessionIdRef: RefObject<string | null>;
  // THE ONE double-send Set — created by ChatStream, handed to BOTH hooks.
  // Never create a second Set anywhere (see §2).
  sendingSessionsRef: RefObject<Set<string>>;
  // render values, captured per render exactly as `send`'s closure captured them:
  composerLocked: boolean;
  isLive: boolean;
  canResume: boolean;
  hasImages: boolean;            // the component's `hasImages` derivation (see §3)
  attachments: ChatComposerAttachment[]; // the RENDER-SNAPSHOT staged list
  attachmentsRef: RefObject<ChatComposerAttachment[]>;
  // the mention catalogs + # gate — `sendText` expands against THESE
  // (the catalog of THAT moment; see §6).
  skills: SkillInfo[];
  agents: AgentDefinitionDto[];
  mcpServers: McpServerInfo[];
  mcpMentionsEnabled: boolean;
  // the useChatAttachments boundary — RECEIVED, never re-owned (see §2b):
  moveOutForSend: (targetSessionId: string, sentIds: Set<string>) => void;
  restoreHeldForSend: (
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ) => void;
  releaseHeldForSend: (targetSessionId: string) => void;
  clearStaged: () => void;
}

export interface UseChatPromptDispatchResult {
  sendText: (
    sessionId: string,
    rawText: string,
    images: SendTextImages | undefined,
    onCommitted: (sentIds: Set<string>) => void,
  ) => Promise<StopReason | null>;
  send: () => Promise<void>;
}

export function useChatPromptDispatch(
  args: UseChatPromptDispatchArgs,
): UseChatPromptDispatchResult
```

- `SendTextImages`, `StopReason`, `ChatComposerAttachment`, `SkillInfo`, `AgentDefinitionDto`, `McpServerInfo` imported by type (`StopReason`/the DTO types from `../lib/tauri`, `ChatComposerAttachment` from `../lib/chatAttachments`).
- Inside the hook: `const [resuming, setResuming] = useState(false);` — `resuming` is dispatch-private; verified `resuming` appears in `ChatStream.tsx` ONLY as the declaration (line 236) and inside `resume` (1051–1060), with zero JSX or other consumers. The hook owns this one state cell; `ChatStream` deletes its `useState(false)` (see §3).
- **`resume` is NOT returned.** The task text says "move … resume … into useChatPromptDispatch" — it moves in as a private closure used by `send`'s `!isLive` arm. The public result is `{ sendText, send }` ONLY. Rationale: `ChatStream` would not destructure a `resume` handle, and `noUnusedLocals` would reject the binding (the wave-2 precedent: `stageFiles` is returned by `useChatAttachments` but deliberately not destructured because its consumers moved with it; here `resume`'s only consumer is `send` itself, so exposing it adds a dead handle).
- Module scope inside the hook file: `useSessions` (store selector for `addSystemLine`, `turnCompleted`, `addUserMessage`, `beginTurn`, plus the imperative `useSessions.getState()` for the fresh-capability re-derive), `useQueuedPrompts` (getState), `sendPrompt`, `compactSession`, `parseComposerCommand`, `describeIpcError`, `expandMentions`, `draftIsMarkerOnly`, `readAttachmentAsBase64`, `agentSupportsImages`, `useState`/`useRef`. (`cancelSession`, `releaseAttachment`, `readFileBytes`, `readClipboardImage`, `ImageRef` do NOT move — `cancelSession` stays for the Esc effect, `releaseAttachment` stays for the flusher, the rest have no consumer in these bodies.)
- `sendText` body: the **verbatim** body of `src/components/ChatStream.tsx`'s `sendText` (the expansion mask/PUA-guard block, the images-empty normalisation, the `ImageRef` field-by-field map, `onCommitted(sentIds)`, `addUserMessage(sessionId, text, imageRefs)`, `beginTurn(sessionId)`, the 2-arg/3-arg `sendPrompt` split, the "NOTE: no `turnCompleted` here" trailing comment). `skills/agents/mcpServers/mcpMentionsEnabled` come from the args in place of the closure (`expandMentions(masked, { skills, agents, mcpServers: mcpMentionsEnabled ? mcpServers : [] })`).
- `send` body: the **verbatim** body of `ChatStream.tsx`'s `send` (lines 685–915 at HEAD), i.e. in EXACTLY this order, with the placement comments quoted in §2a preserved verbatim:
  1. `const targetSessionId = activeSessionIdRef.current;` (equivalence substitution, see §Equivalence) — the original `const targetSessionId = activeSessionId;`.
  2. `const rawText = (draftRef.current ?? "").trim();` (equivalence substitution — the original `draft.trim()`).
  3. The emptiness/marker-only guard `if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;`.
  4. **The locked-composer fork** — sits BEFORE the double-send claim and BEFORE the `try` (a queued press never occupies the double-send slot and needs no `finally` cleanup): `parseComposerCommand(rawText)` → `addSystemLine(targetSessionId, \`/${command.name} runs when this turn ends — try again then.\`)` and `return` (a Composer command is NEVER queued, ADR 0044); then `const moved = attachmentsRef.current; clearStaged();` then `useQueuedPrompts.getState().enqueue(targetSessionId, { id: crypto.randomUUID(), text: rawText, attachments: moved, state: "queued" }); setDraft(""); return;` — the "URLs MOVE with the text" comment stays; `URL.revokeObjectURL` must NOT be called anywhere in this fork.
  5. `if (sendingSessionsRef.current.has(targetSessionId)) return;` then `.add(targetSessionId);` then `try { setError(null);`.
  6. **The `/compact` consumption INSIDE the `try`, BEFORE the `!isLive` auto-resume** — with the TWO PLACEMENT RULES comment word-for-word: "INSIDE the `try`, not before it" (an early return above the `try` would leave the session stuck in the Set — "the composer would look alive and never fire") and "BEFORE the `if (!isLive)` auto-resume block below" (ADR 0044 rejects resuming a stored session purely to compact it). Body: `setDraft("");` then for `command.name === "compact"` `const live = await compactSession(targetSessionId, command.args || null);` and `if (!live) addSystemLine(targetSessionId, "Nothing to compact — this session is not open.");` then `return;`.
  7. The `!isLive` auto-resume: `if (!isLive) { if (!canResume) return; if (!(await resume())) return;` then the fresh-capability re-derive `hasImages = attachments.length > 0 && agentSupportsImages(fresh?.capabilities);` (via `useSessions.getState().sessions.find(...)`, exact as today — `attachments` is the ARG snapshot) and the re-run marker-only guard.
  8. The FileReader block (`attachments.map(...)` over the ARG snapshot; `readAttachmentAsBase64`; reconcile `const liveIds = new Set(attachmentsRef.current.map((a) => a.id)); images = read.filter((i) => liveIds.has(i.id));`; the catch sets `setError("Failed to read an attached image")` guarded by `activeSessionIdRef.current === targetSessionId` and `return`s — attachments stay staged, slot released in `finally`).
  9. The session-switch abort (`activeSessionIdRef.current !== targetSessionId`), the stale-draft abort (`draftRef.current.trim() !== rawText`), the `sendText` call with the `onCommitted` callback whose FIRST statement is `setDraft("")` and whose held move is `if (sentIds.size > 0 && activeSessionIdRef.current === targetSessionId) moveOutForSend(targetSessionId, sentIds);` (the `activeSessionIdRef` guard comment stays).
  10. `if (stopReason === null) return;` (still the `finally`), then `releaseHeldForSend(targetSessionId); turnCompleted(targetSessionId, stopReason);`.
  11. The `catch`: `turnCompleted(targetSessionId, "end_turn")` FIRST; `const msg = describeIpcError(err);` then `restoreHeldForSend(targetSessionId, msg, setError, setDraft);` (the whole restore block is ONE synchronous call — the batching comment stays; `setError` is passed THROUGH, the component owns the error cell).
  12. `finally { sendingSessionsRef.current.delete(targetSessionId); }`.
- `resume` body: verbatim, with `activeSessionId` → `activeSessionIdRef.current` (equivalence; resume is only ever invoked from `send`, which runs from an event handler after the render-phase re-sync — see §Equivalence). Uses the internal `resuming` state and `resumeSession` via a `useSessions((s) => s.resumeSession)` selector, `describeIpcError`, `setError`, `setResuming`.

### 1b. `src/hooks/usePromptQueueFlusher.ts`

```ts
export interface UsePromptQueueFlusherArgs {
  // the trigger's far end: ChatStream's useSessionIdleEdge calls flushRef.current()
  flushRef: RefObject<() => void>;
  // passed in from useChatPromptDispatch's result — preserves "flushHead is
  // declared AFTER sendText so it closes over it".
  sendText: UseChatPromptDispatchResult["sendText"];
  sendingSessionsRef: RefObject<Set<string>>; // the SAME Set as the dispatch hook's
  activeSessionIdRef: RefObject<string | null>;
  imageCapable: boolean;
  setError: (value: string | null) => void;
}

export function usePromptQueueFlusher(args: UsePromptQueueFlusherArgs): void
```

- Body: `const flushHead = async () => { ... }` — the **verbatim** body of `ChatStream.tsx`'s `flushHead` (the Visible-Session comment, the `sendingSessionsRef` guard comment, `takeHead`, the `dispatched` flag with its comment, the fail-closed `imageCapable` read, `readAttachmentAsBase64` map, `sendText(sessionId, entry.text, images, () => {})` with the empty-`onCommitted` comment, the `null` guard, `entry.attachments.forEach(releaseAttachment)` with the ownership comment, the success `turnCompleted(sessionId, stopReason)`, the `catch` with the `dispatched`-gated settle + `requeueHead(sessionId, { ...entry, leaving: undefined, failed: true })` + error line guarded by `activeSessionIdRef.current === sessionId`, and the `finally` delete). `sessionId`, `sendingSessionsRef`, `activeSessionIdRef`, `imageCapable`, `sendText`, `setError` come from the args; `useQueuedPrompts.getState()`, `readAttachmentAsBase64`, `releaseAttachment`, `describeIpcError`, `turnCompleted` (via `useSessions` selector) are module scope in the hook file.
- Then, IN THE HOOK BODY (render phase, exactly the current statement at ChatStream.tsx 1044–1047 plus its "Part 2 of the trigger … render-phase ref mirror" comment): `flushRef.current = () => { void flushHead(); };`.
- Placement note (must be documented, not "fixed"): today this assignment runs only on the full-frame path (below the early return); the hook runs it on EVERY render including the no-session frame. That is observationally identical: in the no-session frame `composerLocked` is always false (no `inTurn`, no `agentState`, no `compacting`) so the edge never fires, `key` is the stable `""`, and the moment a session appears the key change RE-SEEDS the edge — and `flushHead` short-circuits on `!sessionId` anyway. No test distinguishes the two placements (the "renders with no active session without crashing, and still flushes once one appears" test covers both directions).

## 2. The one-Set double-send invariant and the attachment boundary

### 2a. Who owns `sendingSessionsRef` — and why

**`ChatStream.tsx` keeps the declaration; BOTH hooks receive the same instance.** The declaration comment (ChatStream.tsx 248–249) states the failure mode verbatim — "`beginTurn` runs AFTER an `await` … a second Enter/click during the read would otherwise double-send", and an early return above a recreated `try` strands a session id in the Set so "the composer would look alive and never fire". `send` and `flushHead` both read and write this Set; TODAY they are in one file, TOMORROW they are in two. The invariant is ONE `Set` instance shared by both paths — two Sets would defeat the guard (a manual send in flight would not be visible to the Flush's check-and-add).

- The component keeps `const sendingSessionsRef = useRef<Set<string>>(new Set());` (line 250, in the unconditional block above the early return) because it is the one place where the two hook calls meet: it is shared infrastructure neither hook alone owns, and either hook creating it and handing it to the other would couple the two hooks to each other (the component is already their meeting point — it passes `sendText` from the first to the second).
- The dispatch hook claims/releases it in `send` exactly as today (add after the fork returns, delete in the `finally`). The flusher hook does the same in `flushHead` (check before `takeHead`, add after the entry exists, delete in `finally`).
- **Proof-of-one-Set acceptance:** after implementation, `grep -rn "useRef<Set<string>>" src/components/ChatStream.tsx src/hooks/useChatPromptDispatch.ts src/hooks/usePromptQueueFlusher.ts` must produce EXACTLY one hit (ChatStream.tsx line 250). Neither new hook may call `useRef` for this Set.

### 2b. The `useChatAttachments` boundary — quote the REAL signature, thread the RETURNED functions

The task consumes the landed boundary; it must NOT re-own any attachment state. From `src/hooks/useChatAttachments.ts` (verbatim, the REAL landed types — note `setError` IS in the args; wave 2's plan omitted it and the implementer had to add it, so quote the file, never a plan):

```ts
export interface UseChatAttachmentsArgs {
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
  draftRef: RefObject<string>;
  activeSessionIdRef: RefObject<string | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  imageCapable: boolean;
  composerEnabled: boolean;
}
```

The names `useChatAttachments` RETURNS (the 12-name surface pin in `useChatAttachments.test.tsx` line 350–351): `attachments, attachmentsRef, stageFiles, handlePaste, handleDrop, handleAttachClick, removeAttachment, moveOutForSend, restoreHeldForSend, releaseHeldForSend, clearAll, clearStaged`. `attachmentsRef` is a LIVE ref (`attachmentsRef.current = attachments` every render, line 170) — `send` reads it mid-async; the hook owns `heldForSendRef` internally and neither returns it nor exposes `setAttachments` ("who may revoke an object URL" stays inside that module).

- `src/components/ChatStream.tsx` destructures 11 names today (lines 279–292; `stageFiles` is deliberately absent — `noUnusedLocals` proves its only callers moved with it). The dispatch hook RECEIVES five of them plus the ref: `attachmentsRef`, `clearStaged`, `moveOutForSend`, `restoreHeldForSend`, `releaseHeldForSend` — as `UseChatPromptDispatchArgs` fields (see 1a), threaded by ChatStream from its own destructure. `clearAll` stays in ChatStream (session-switch effect), `attachments` stays (the snapshot arg + the strip render), `setDraft`/`setError`/`draftRef`/`activeSessionIdRef`/`composerRef` stay.
- **`heldForSendRef` does not exist in `ChatStream.tsx` anymore** (verified: `grep -n heldForSendRef src/components/ChatStream.tsx` → exactly one hit, line 678, inside a comment). Do NOT write a plan sentence that "extracts heldForSendRef out of ChatStream" — the correct wording is what this plan uses: "thread `useChatAttachments`'s returned boundary functions into `useChatPromptDispatch` as arguments." The failed-send restore's marker shift, `MAX_CHAT_ATTACHMENTS` cap, overflow release and `activeSessionIdRef` re-check all live INSIDE `restoreHeldForSend`; the dispatch hook just calls it as one synchronous unit with `(targetSessionId, msg, setError, setDraft)`.

## 3. `ChatStream.tsx` edits (the orchestrator slim-down)

1. **Unconditional block** (above the early return at ~509). After the `useMentionCatalogs(spacePath)` call (the `skills/agents/mcpServers` args need it) and AFTER the `flushRef` declaration (the flusher needs it), in this EXACT source order — dispatch first (produces `sendText`), then flusher (consumes it and assigns `flushRef`), then the edge (consumes the ref):

   ```tsx
   const flushRef = useRef<() => void>(() => {});
   const { sendText, send } = useChatPromptDispatch({ ...all 18 args... });
   usePromptQueueFlusher({
     flushRef,
     sendText,
     sendingSessionsRef,
     activeSessionIdRef,
     imageCapable,
     setError,
   });
   useSessionIdleEdge({
     busy: composerLocked,
     key: activeSessionId ?? "",
     onIdle: () => flushRef.current(),
   });
   ```

2. **`hasImages` moves ABOVE the early return** (it is needed as a dispatch-hook arg, and hook args must be in scope in the unconditional block). Today it is the `let hasImages = attachments.length > 0 && imageCapable;` at lines 519–528 BELOW the guard, with the load-bearing fail-closed comment. Move the comment + expression up to directly after the `useChatAttachments` destructure (~line 300; `attachments` and `imageCapable` are both in scope there) and make it `const hasImages = ...` — the `let` and its mid-`send` REBIND move INSIDE the hook's `send` (the hook does `let hasImages = args.hasImages;` then the resume-arm re-derivation). The JSX use at line 1190 (`hasImages={hasImages}`) keeps working from the const. This is a pure-derivation placement move; the no-session frame never rendered `hasImages` because no `ComposerRow` exists there, and nothing observable changes.
3. **Delete** the four function definitions now inside the hooks: `sendText` (546–683), `send` (685–915), `flushHead` (924–1037), the standalone `flushRef.current = () => { void flushHead(); };` statement (1044–1047), `resume` (1050–1068). Also delete `const [resuming, setResuming] = useState(false);` (236).
4. **Keep** `const sendingSessionsRef = useRef<Set<string>>(new Set());` (250), `activeSessionIdRef` + re-sync (257–258), `draftRef` + re-sync (264–265), `flushRef` (494 — moved up per step 1, or keep it where it is and only move the two hook calls after it; either is fine as long as the flusher call is after the `flushRef` declaration), `useSessionIdleEdge` (503–507).
5. **Handlers/props**: `send={send}` in `ComposerRow` (line 1186) now reads the hook's returned `send`; the picker/child-gate/Esc/session-switch code is untouched.
6. **Import cleanup** (dead unless used elsewhere — the plan lists EVERY removed binding and its consumer so none is "missing"): remove from `ChatStream.tsx` the imports whose only consumers moved: `compactSession` (only `send`), `describeIpcError` (only `send`/`flushHead`/`resume`), `parseComposerCommand` (only `send`), `expandMentions` (only `sendText`), `agentSupportsImages` (only `send`'s re-derive), `draftIsMarkerOnly` (only `send`), `readAttachmentAsBase64` (only `send`/`flushHead`), `releaseAttachment` (only `flushHead` — and the flusher hook now imports it), `useQueuedPrompts` (only `send`/`flushHead`), `type ImageRef` (only `sendText`), `sendPrompt` (only `sendText`/`flushHead`), `StopReason` if now unused (check `grep -n "StopReason" src/components/ChatStream.tsx` after the move — it may still be needed for the flusher call's inference; remove only if tsc flags it). **KEEP**: `cancelSession` (Esc effect), `useMentionCatalogs`/`useMentionPicker`/`useActiveSpaceCwd`/`useSessionIdleEdge`/`useChatSessionDerivations`/`useChatAttachments` (block), `useSessions` (selectors + effects), `useSettings` (spinner/`mcpMentionsEnabled`), `useInteractive`/`usePermissions` (rendering derivations), `groupConsecutiveFileWrites`, `dirPartOfOutsideQuery`/`isOutsideSpaceQuery` (picker), the lib imports used by handlers (`petty` none left), `ChatComposerAttachment` type if the destructure still names it.
   - **If `tsc` (either `npx tsc --noEmit` or `pnpm build`) reports a TS6133 unused-import error, remove THAT import** — the rule is: the only imports that may stay are the ones a remaining line references. Let the compiler be the arbiter; the list above is the expectation, not a ceiling.

## 4. `ChatStream.test.tsx` — the three groups move OUT

Move (RELOCATE — net zero tests) exactly these three `describe` blocks, currently at these line anchors (measured at HEAD), each moved VERBATIM (`it` titles and assertion bodies unchanged; the ONLY edits are the `describe` title prefix and, for the flush file, nothing else — the groups already reference the module-level seeds/helpers they need):

| Block (exact current `describe` title) | Current lines | Tests | New home |
|---|---|---|---|
| `ChatStream — the /compact Composer command (ADR 0044)` | 5835–5965 | 7 | `useChatPromptDispatch.test.tsx` as `describe("useChatPromptDispatch — the /compact Composer command (ADR 0044)")` |
| `ChatStream — send() forks to the prompt queue while the composer is locked` | 6223–6443 | 9 + its 4 local helpers (`composerValue`, `composerThumbs`, `queue`, `png`) | `useChatPromptDispatch.test.tsx` as `describe("useChatPromptDispatch — send() forks to the prompt queue while the composer is locked")` |
| `ChatStream — the Flush: the queue drains when the Session goes idle` | 6444–6946 | 13 + its 4 local helpers (`queue`, `enqueue`, `queuedAttachment`, `runTurnAndSettle`) | `usePromptQueueFlusher.test.tsx` as `describe("usePromptQueueFlusher — the Flush: the queue drains when the Session goes idle")` |

The moved tests all `render(<ChatStream />)` — they KEEP doing that (imported from `../components/ChatStream`), because they prove the hooks through the real component wiring (the `useChatAttachments.test.tsx` precedent moved tests with their behaviour owner; the `sendRelay` harness belongs to the NEW surface pins in §5, not to these relocated integration tests).

- The comment inside the fork group's "a Composer command while locked is NOT queued" test cites a stale line anchor ("pinned at `:6402`") and other moved tests cite ChatStream line numbers in prose. Leave them (behaviour moved, not improved; the plan forbids chasing stale comment anchors). If one becomes actively wrong enough to mislead, a one-word update is permitted — text edits to COMMENTS only, never to assertions.
- What STAYS in `ChatStream.test.tsx` (do NOT move): the failed-send end-to-end restore group (6135–6222 — its comment already says its second send needs the real `sendText` + `readAttachmentAsBase64`), the `[image #N]` staging-marker group (5966–6134), the staging-while-in-flight group (6947), the empty-state-film group (7075), the capability-provenance pin, the `+`-button trio, "switching sessions clears staged attachments", the full-send image family, the resume-capability pins, `"double-send is guarded by sendingRef"` (line ~1715 — THE one-Set pin; it drives the real component, two synchronous clicks before the FileReader await), the `#`-collision/mask pins, the out-of-Space group, the child-gate groups, and the main `ChatStream` block. These prove the hooks' wiring THROUGH `ChatStream` and are precisely the integration the two-hook split must keep green.
- **`ChatStream.test.tsx` import edits (in scope — lesson (a): required/preserved call sites are listed, not ignored):**
  - `ChatComposerAttachment` type import (line 47): after the move its only uses were in the moved flush group — verify with a grep; if zero remaining uses, remove the import (TS6133 otherwise).
  - `compactSession` named import (line 9): after the move the stays-side references it only inside the `vi.mock` factory (as a returned-object KEY) and in prose comments — the import binding becomes unused; remove it. **KEEP the factory's `compactSession: vi.fn().mockResolvedValue(true)` override exactly as-is** (the factory shape is shared, "green-but-lying" protection is its whole point; an override that nobody imports is harmless and stays for parity).
  - Everything else the stays-side still uses (verified by identifier scan of the stays-side slice): `deferred` (14), `waitForCatalog` + `listSkills` (18), `useQueuedPrompts` (8), `useInteractive` (28), `pasteToComposer` (25), `dropOnComposer` (4), `seedMcpMentions*` (4), `PERSISTED_MCP_MESSAGE` (2), `SETTINGS_FIXTURE` (3), `MONO_ADVANCE_EM` (2), `* as chatAttachments` (the `readAttachmentAsBase64` spy at ~6861 stays), `StopReason` (the 6135 restore group uses `deferred<StopReason>`). Do not touch these.
  - The three moved groups' LOCAL helpers (`composerValue`, `composerThumbs`, `queue`, `png`, `enqueue`, `queuedAttachment`, `runTurnAndSettle`) move with their groups; the stays-side groups (6947, 7075) have their OWN local copies — do not delete those.

## 5. The two new test files — shape (constraints 7 & 8)

Both files follow `src/hooks/useChatAttachments.test.tsx`'s module shape EXACTLY:

- **Header comment** recounting the moved groups and the two placements that stay in `ChatStream.test.tsx`.
- **`beforeAll` with the SIX environment stubs** (copy verbatim from `useChatAttachments.test.tsx` lines ~68–80): the object-URL pair (`URL.createObjectURL` = `vi.fn((file: File) => \`blob:mock-${file.name}\`)`, `URL.revokeObjectURL` = `vi.fn()`) — REQUIRED because the fork test asserts `URL.revokeObjectURL` not called and the Flush test asserts it WAS called (`toHaveBeenCalledWith("blob:mock-q.png")`) — plus the three `HTMLElement.prototype` stubs. (`setup.tsx` stubs no `URL` API and puts `scrollIntoView` on `Element.prototype` only — the parent's rationale comment moves with the block.)
- **`vi.mock("../lib/tauri", ...)` — the full OPEN factory, copied VERBATIM from `ChatStream.test.tsx`** (all 17+ named overrides incl. `compactSession`, `listSkills` with the `debug`/`beta` fixture rows, `listAgentDefinitionsForSpace` with `scout`, `listMcpServersEffective` with `postgres`, `resumeSession`, `sendPrompt` defaulting to `"end_turn"`, `listSpaceListing`/`listCompletionEntries` empty). The moved groups render the real `ChatStream`, which mounts the catalog hooks on every render — an un-mocked name that reaches the real wrapper would reject on jsdom's missing `window.__TAURI_INTERNALS__` (soft, misleading green is the documented failure — the same reason the parent has the factory).
- **`vi.mock("@tauri-apps/plugin-dialog", ...)` — the closed factory, copied verbatim.** No moved test clicks Attach, so it is not strictly exercised, but it is part of the parent's file shape and protects the seam (a future click would otherwise hit the real plugin in jsdom). Two lines, include it.
- **Module `beforeEach` copied verbatim** from `useChatAttachments.test.tsx`/`ChatStream.test.tsx` (same order, order is deliberate): `vi.useRealTimers()`, `setSidePaneCollapsed(false)`, `localStorage.clear()`, the `useQueuedPrompts.getState().clearSession(id)` loop (BEFORE `clearAllMocks`, so the URL releases it performs are not counted against revocation assertions), `vi.clearAllMocks()`, `clearSkillCatalogCache()`, `clearMentionCatalogsCache()`, `resetStores()`. No per-block `beforeEach`/`afterEach` anywhere.
- **IDEA: the factories MUST stay INLINE referencing only `vi`/`actual`** (`const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri")`), exactly like the parent — the probe matrix (in `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md` appendix) measured that a factory delegating to `src/test/chatStreamFixtures.ts` fails as **0 tests run** with `Cannot access '__vi_import_N__' before initialization`, because that module imports `useSessions`/`useSettings`, whose stores import `../lib/tauri` (a transitive path into the mocked specifier). Both new files MUST use the fixtures module only OUTSIDE factories (seeds, `flush`, `deferred`, `waitForCatalog(listSkills)` — note the INJECTED `listSkills` parameter; the fixtures header says it is injected precisely so the fixture module stays free of the barrel).
- One **surface pin per hook** (the only NEW tests — see §Count gate):
  - `useChatPromptDispatch.test.tsx`: `it("returns exactly the two dispatch handles ChatStream and the flusher consume, and no more")` — a `renderHookLike`-style stub host (copy the `useChatAttachments.test.tsx` pattern at lines 928–946): a `Probe` component passing stub args (no-op setters, `useRef("")`, `useRef<string|null>("s1")`, `useRef<Set<string>>(new Set())`, `true`/`false` booleans, empty arrays/list, no-op boundary fns) and capturing the hook's result; assert `expect(Object.keys(result).sort()).toEqual(["send", "sendText"])`. Comment: the sorted key list IS the contract wave 4 codes against; a handle added/dropped reddens here. ("resume" is deliberately absent — internal by design, see 1a.)
  - `usePromptQueueFlusher.test.tsx`: `it("hands the idle edge a LIVE flushHead: assigns flushRef.current and guards the Visible-Session rule")` — a `Probe` passing a `flushRef`, a `sendText: vi.fn().mockResolvedValue("end_turn")`, stub refs, `imageCapable: true`, `setError: vi.fn()`; after render assert `flushRef.current` is a fresh function (the initial `() => {}` was replaced); then `await act(async () => { flushRef.current(); })` with `activeSessionIdRef.current = null` and assert `sendText` was NOT called (the `!sessionId` short-circuit is flushHead's first verbatim line). Comment: this is the seam `useSessionIdleEdge`'s `onIdle: () => flushRef.current()` rests on — a hook that stopped assigning the ref (or assigned a stale one) would silently kill the Flush.
- Imports each new file needs (the moved groups' identifier scans, verified): vitest (`beforeEach, describe, expect, it, vi, beforeAll`), RTL (`act, fireEvent, render, screen, waitFor, within` — `within` only in the flush file), `ChatStream` (default), from `../lib/tauri`: `sendPrompt, compactSession, resumeSession, listSkills, type StopReason`; from `../test/chatStreamFixtures`: `seedLiveSession, seedLiveSessionWithImages, seedStoredSession, pasteToComposer, flush, deferred, waitForCatalog`; from the stores `useSessions, useQueuedPrompts` and (dispatch file) `useInteractive`; `setSidePaneCollapsed`, `clearSkillCatalogCache`, `clearMentionCatalogsCache`, `resetStores`; the flush file also `import * as chatAttachments from "../lib/chatAttachments"` (the `readAttachmentAsBase64` spy) and `type ChatComposerAttachment`. Drop any import tsc proves unused.

## 6. Mention expansion / ADR 0031 byte-identity / ADR 0069 — preserved by construction

- The queue stores the RAW draft (`text: rawText` at enqueue) and `expandMentions` runs at SEND inside `sendText`, against `{ skills, agents, mcpServers: mcpMentionsEnabled ? mcpServers : [] }` — the catalog of THAT moment (the args are the render's catalog, exactly as the closure was). ADR 0031's "The persisted text IS the expanded text" and ADR 0069's "A queued prompt holds the RAW draft; `expandMentions` runs at send" both survive verbatim — the quote is preserved in the hook bodies' comments (the "URLs MOVE with the text… raw so expansion runs at send" fork comment and the sendText mask/PUA comment move verbatim).
- ADR 0044: a Composer command is NEVER queued — the fork's `parseComposerCommand` first branch and the live-path interception (with `setDraft("")` before `compactSession`, `args || null`, the `if (!live) addSystemLine(...)` feedback) move verbatim. `parseComposerCommand`'s non-command fall-through returns prose BYTE-IDENTICALLY (the `?`-File-completion contract) — untouched.
- The mask machinery (`\uE000` sentinel, the bounded replacer, the `marks.length > 0 && rawText.includes("\uE000")` degrade) moves verbatim with `sendText`.

## Equivalence substitutions (must be documented in the hook files; MUST NOT change behaviour)

These are the ONLY sanctioned textual substitutions in the moved bodies; each is observationally identical because every entry point runs from an event handler or the render-phase-assigned flush ref, i.e. AFTER the render-phase ref re-syncs (`draftRef.current = draft`, `activeSessionIdRef.current = activeSessionId` at ChatStream lines 258/265) — so at call time the ref holds exactly what the matching render's closure held:

1. `send`'s opening: `const targetSessionId = activeSessionId;` → `const targetSessionId = activeSessionIdRef.current;`. Both are "the active session of the render that produced the click". The post-await switch is still guarded by the SEPARATE `activeSessionIdRef.current !== targetSessionId` check (unchanged).
2. `send`'s `const rawText = draft.trim();` → `const rawText = (draftRef.current ?? "").trim();`. The stale-draft guard that later compares `draftRef.current.trim() !== rawText` is unchanged — it still reads the LIVE ref after the awaits, exactly as today.
3. `hasImages` initial value → the `hasImages` ARG (the component's const); the resume-arm re-derivation rebinds the hook's LOCAL `let hasImages`, reading `attachments.length` from the ARG snapshot (the render-snapshot staged list) — identical to the closure read, including the pre-window "drop during the resume await is not seen" semantics.
4. `resume`'s `if (!activeSessionId || resuming)` → `if (!activeSessionIdRef.current || resuming)` — same reasoning as (1); `resume` is only called from `send`.
5. The render-snapshot reads inside `send` (`attachments.length` at the re-derive, `attachments.map` in the FileReader block) use the `attachments` ARG; the LIVE reads (`attachmentsRef.current` at the fork's `const moved`, the `liveIds` reconcile) use the `attachmentsRef` arg. Do NOT collapse the two — the original deliberately read the ref for the move/reconcile and the snapshot for the payload build.

## Barrel pin (constraint 9 — read the assertion, never copy its numbers)

`src/lib/tauriBarrel.test.ts`, `it("the scanner sees the mock seam it exists to protect")` (line 398), asserts a SET SIZE: measured at code HEAD `0aa99ffb` it is **39 mockers** (`expect(mockers).toHaveLength(39)` at line 424) of which **38 spread `vi.importActual`** (line 432). Both NEW test files mock `../lib/tauri` BY MODULE PATH with `importActual`-spreading factories — so both counts grow by exactly **one each**: **39 → 41 mockers, 38 → 40 spreaders**.

The implementer MUST, in the SAME commit as the two new test files (both are one commit — task C1 is a single commit):
- Bump BOTH assertions to the new values (read the current values off the file at implement time; they are 41/40 by the arithmetic above — the plan trusts the +1-per-file rule, not the absolute numbers).
- Extend the provenance comment so its last clause names BOTH new files, e.g.: `…, and 40 -> 41 when the chatstream decomposition moved the dispatch/queue/flush tests into src/hooks/useChatPromptDispatch.test.tsx and src/hooks/usePromptQueueFlusher.test.tsx, which mock the barrel the documented way`. (The current comment ends at the `38 -> 39 … useChatAttachments.test.tsx` clause; append the new clause, do not rewrite history.)
- Do NOT touch the `classNameConvention`/`paletteCompleteness` scanners — verified they sweep non-test sources only (`classNameConvention` excludes `.test.tsx?` by its own vacuity guard; a test-file move is invisible to both).

## Count gate — get the arithmetic right (constraint: a previous plan's gate was wrong)

**Baseline (post-wave-2, at `0aa99ffb`): 161 files / 3354 passed | 1 skipped.** `ChatStream.test.tsx` = **244** today (241 `it(` + 3 `it.each` rows — measured statically and matching the status file).

Moved tests are RELOCATED — **net 0**:
- `ChatStream.test.tsx` loses 7 + 9 + 13 = **29** → **215** (212 `it(` + 3 `it.each` rows).
- The 29 reappear in the two new files unchanged.

Every NEW test grows the total by exactly its own count. This task adds exactly **2** new tests (the two surface pins, §5):
- New files: 2 → file count **161 + 2 = 163**.
- New tests: 2 → passed total **3354 + 2 = 3356**.

**Expected post-task gate: `pnpm test` reports 163 files, 3356 passed | 1 skipped, exit 0.** Say it plainly: **a total ABOVE the baseline by exactly the new-test count (2) is CORRECT and must not be "fixed".** If the runner reports anything else, reconcile by computing `moved-out (29) − moved-in (29) + new (2)` — do not "correct" 3356 toward 3354. (Do NOT restate 244/3354/3356 inside any tracked test or assertion — these are the RUNNER's numbers; the acceptance criteria below measure them with commands, they are not pinned in code.)

Known flakes on THIS box (re-run before investigating, do NOT "fix" the threshold or assertion):
- `MessageBubble.codeblock.test.tsx`'s `it.each` JSON fence case (shiki async fallback).
- `Reasoning.test.tsx`'s `is O(last line)` wall-clock assertion.
Both are load under full-suite pressure; a red on either is a re-run, not a defect.

## 7. Verification — commands (all from the repo root unless stated)

```sh
# The three files of this task, individually (TDD loop — see Steps):
pnpm exec vitest run src/hooks/useChatPromptDispatch.test.tsx
pnpm exec vitest run src/hooks/usePromptQueueFlusher.test.tsx
pnpm exec vitest run src/components/ChatStream.test.tsx
# The barrel mock-seam pin that must have moved in the same commit:
pnpm exec vitest run src/lib/tauriBarrel.test.ts
# Fast type-check without the vite bundle:
npx tsc --noEmit
# The full frontend gate (the count-gate measurement):
pnpm test
pnpm build        # tsc && vite build — this IS the type-check; a TS6133 unused import fails here
```

Do NOT run `pnpm dev` / `pnpm tauri dev` (long-running processes — forbidden).

**Steps (TDD order):**
- [ ] Copy the three `describe` blocks (§4) into their two new `.test.tsx` files, retitled per §4, with the module shape of §5 (six stubs, the two factories verbatim, the `beforeEach` verbatim, the fixtures import). Write the two surface pins (§5).
- [ ] Run `pnpm exec vitest run src/hooks/useChatPromptDispatch.test.tsx src/hooks/usePromptQueueFlusher.test.tsx`. Expected: RED — the files cannot collect because `./useChatPromptDispatch` / `./usePromptQueueFlusher` do not exist yet (module-not-found at the import line; 0 tests run). If they are green, the files are importing the wrong module — stop and investigate.
- [ ] Create `src/hooks/useChatPromptDispatch.ts` (§1a) and `src/hooks/usePromptQueueFlusher.ts` (§1b) — verbatim moves with the substitutions of §Equivalence only.
- [ ] Rewire `src/components/ChatStream.tsx` (§3): move `hasImages` above the guard, call both hooks in the unconditional block in the specified source order, delete the four old definitions + the `resuming` state, clean the imports (let `tsc` name any TS6133).
- [ ] Run the two new files → GREEN (moved tests + pins). Run `pnpm exec vitest run src/components/ChatStream.test.tsx` → GREEN, **215 tests**. Run `npx tsc --noEmit` → clean.
- [ ] Edit `src/lib/tauriBarrel.test.ts` (§Barrel pin): bump both counts, extend the provenance comment naming both new files. Run `pnpm exec vitest run src/lib/tauriBarrel.test.ts` → GREEN.
- [ ] Run `pnpm test` (full gate) → expect **163 files, 3356 passed | 1 skipped**, exit 0. If a known flake (§Count gate) is red, re-run that file rather than adjusting it.
- [ ] Run `pnpm build` → exit 0.
- [ ] Commit with message: `refactor(chatstream): extract prompt dispatch + queue flush into useChatPromptDispatch/usePromptQueueFlusher (issue #135 §2)` — one commit containing the two hook files, the two test files, the `ChatStream` rewiring, the `ChatStream.test.tsx` group moves and the barrel-pin bump (the pin MUST move in the same commit as the new test files, §Barrel pin).

**Acceptance criteria:**
- [ ] `src/hooks/useChatPromptDispatch.ts` exists and exports `SendTextImages`, `UseChatPromptDispatchArgs`, `UseChatPromptDispatchResult`, `useChatPromptDispatch` with the signatures of §1a; `send`'s body preserves the §2a order (emptiness guard → locked fork BEFORE the Set and the `try` → claim → `/compact` inside the `try` BEFORE the auto-resume → resume → read → aborts → `sendText` → success release → catch settle-then-restore → `finally` release), with the quoted placement comments present verbatim.
- [ ] `src/hooks/usePromptQueueFlusher.ts` exists with the §1b signature; its body assigns `flushRef.current = () => { void flushHead(); }` at render phase.
- [ ] **One-Set proof:** `grep -rn "useRef<Set<string>>" src/components/ChatStream.tsx src/hooks/useChatPromptDispatch.ts src/hooks/usePromptQueueFlusher.ts` → exactly ONE hit (in `ChatStream.tsx`); both hook files receive it as an argument and never construct one.
- [ ] `grep -n "heldForSendRef" src/components/ChatStream.tsx` → at most the one existing comment hit (line 678) and NO declaration/use; the dispatch hook receives the five `useChatAttachments` handles per §2b and re-owns none.
- [ ] `ChatStream.tsx` calls `useChatPromptDispatch` and `usePromptQueueFlusher` in the unconditional block above the `!activeSessionId` early return, dispatch before flusher, flusher before `useSessionIdleEdge`; the old `sendText`/`send`/`flushHead`/`resume` definitions and `const [resuming, setResuming]` are gone; `send={send}` (ComposerRow) still compiles.
- [ ] The three blocks of §4 no longer exist in `ChatStream.test.tsx` (grep each `describe` title → 0 in `ChatStream.test.tsx`, present in the two new files); `ChatStream.test.tsx` runs **215** tests (212 `it(` + 3 `it.each` rows) and every test green.
- [ ] `pnpm exec vitest run src/lib/tauriBarrel.test.ts` green with both counts bumped and the provenance comment naming BOTH new files.
- [ ] `pnpm test` → 163 files, 3356 passed | 1 skipped, exit 0 (3354 baseline + exactly 2 new tests; 161 + 2 new files; 29 moved net-zero). `pnpm build` → exit 0.
- [ ] The `vi.mock` factories in both new files reference ONLY `vi` and their local `actual` (no `chatStreamFixtures` or other imported binding inside any factory body); no `revokeObjectURL` call appears anywhere in the new hooks or moved fork code (the "URLs MOVE with the text" contract).

**Follow-up notes (recorded, NOT implemented — behaviour is moved, not improved):**
- Once the `/compact` group leaves `ChatStream.test.tsx`, the stays-side factory's `compactSession` override becomes latent (no stays test types `/compact`). Pruning it later is a deliberate seam change needing its own reasoning — out of scope today.
- The flush test file's `beforeAll`/`beforeEach` blocks are byte-copies of the parent's; a later "shared test environment" extraction (if ever pursued for wave 4) would de-duplicate them. Not this task.

**UNVERIFIED (for the caller's vet to target):**
- The full-suite numbers (161/3354/1, and the expected 163/3356/1) come from the status file's recorded orchestrator run at `0aa99ffb` plus static `it(`/`it.each` counts I re-measured — I did not re-run `pnpm test` (a 180s-timeboxed run is the recorded reason earlier reports decline too). The 244 = 241+3, the 29 moved, and the 6 stages of the stays-side/`beforeAll` shape are all verified structurally from the file.
- Whether `pnpm build`'s `tsc` in fact flags the exact imports I predict as dead (e.g. `StopReason` in `ChatStream.tsx`) — the plan tells the implementer to let the compiler arbitrate; the list in §3.6 is the expectation, marked with "if tsc flags it".
- The barrel pin's absolute values 39/38 were read at `0aa99ffb` by me and by post-wave-2's report; the +1-per-file rule is arithmetic, but the implementer should read the file's current numbers before editing (the plan says so, twice).
- `useChatPromptDispatch.test.tsx`'s moved groups reference stale ChatStream line anchors in comments (`:6402`) — deliberately left; a vet satisfied these are comments only is the goal.
