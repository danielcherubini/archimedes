---
status: grounding-report
area: src/components/ChatStream.tsx (whole component, 1,553 lines)
issue: 135 (chatstream decomposition — (a) pure session derivations, (b) attachment lifecycle hook, (c) prompt dispatch + queue flush + resume, (d) orchestrator final form)
repo: /home/daniel/Coding/AI/archimedes-desktop
branch: feature/chatstream-decomposition
base commit: b0071544
---

# Grounding report — `src/components/ChatStream.tsx` body

Everything below is quoted **verbatim** from `src/components/ChatStream.tsx` at
base commit `b0071544`. Line numbers are given once per symbol as a navigation
aid; **symbols, never line numbers**, should survive a commit in any task-plan
wording.

---

## 0. Component shape at a glance

`ChatStream` is a 1,553-line single component. The body decomposes into:

| Region | Lines | Content |
|---|---|---|
| imports / exported type `SendTextImages` | 1–70 | `SendTextImages` doc says: *"The reconciled attachment payload `sendText` takes (id-bearing, unlike the `ImageRef` that goes on the wire). Exported because Task 5's Flush builds one."* |
| unconditional hook + selector block | 74–563 | every hook, selector, ref, and the three non-listener effects, **all** before the early return at 564 |
| early return | 565–574 | `if (!activeSessionId) { … }` |
| post-guard derivations | 576–581 | `let hasImages` (re-derived inside `send`) |
| `sendText` | 601–739 | the shared send tail |
| `send` | 741–1029 | typed-prompt dispatch (296 lines) |
| `flushHead` | 1037–1150 | queue head dispatch |
| `flushRef.current = …` | 1159–1161 | trigger part 2 (render-phase assignment) |
| `resume` | 1163–1176 | stored-session auto-resume |
| `lastUserIndex` / `turnDiffs` | 1188–1203 | file-summary derivations |
| handlers | 1221–1440 | `stageFiles`, `handlePaste`, `handleDrop`, `handleAttachClick`, `removeAttachment` |
| `units` / JSX | 1448–1553 | render |

**Governing planning fact**: every hook and every ref the hooks read lives in
the top block **above** the `!activeSessionId` early return; the handlers, the
send path and the Flush are plain functions whose *placement in the file is
flexible*, but whose *closure scope is not* — anything extracted must be handed
its component-scope inputs explicitly (see §5 for the exact input lists).

---

## 1. The hook-ordering / early-return constraint (single most dangerous constraint)

The file carries **six** load-bearing warning comments about hooks versus the
`!activeSessionId` early return. Every one of them is quoted verbatim here with
the hook(s) it governs. The failure mode named is React's
`"Rendered more hooks than during the previous render"` → white page.

### 1a. The early-return guard itself (lines 565–568)

```tsx
  if (!activeSessionId) {
    return (
      <main className="m-1 flex min-w-0 min-h-0 flex-1 items-center justify-center rounded-xl bg-chat">
        <p className="text-ui-base text-foreground-subtle">
          No active session — open a Space from the tabs above
        </p>
      </main>
    );
  }
```

### 1b. `useSpinQuip` (lines 234–239)

```ts
  // Called UNCONDITIONALLY at the top of the component body (the hook
  // contains `useState`/`useEffect` — invoking it inside the `working`
  // branch would be a conditional hook call and crash React when the
  // state flips).
  const quip = useSpinQuip(workingOrInTurn);
```

### 1c. `useHasPendingRequest` (lines 258–267)

```ts
  // — so counting wide is both honest and safe. Called UNCONDITIONALLY,
  // BEFORE the `!activeSessionId` early return below: it reads stores via
  // `useSyncExternalStore` (zustand), so
  // calling it only on the full-frame path would change the hook count when the
  // active session appears/disappears and crash React ("Rendered more hooks than
  // during the previous render" → white page). Pinned by the ChatStream test that
  // goes no-session → active-session WITH a pending child gate.
  const hasPendingRequest = useHasPendingRequest();
```

### 1d. `useChildGates` (lines 270–278)

```ts
  // … Called UNCONDITIONALLY, BEFORE the `!activeSessionId` early
  // return, for the same reason as the hook above: it reads three stores via
  // `useSyncExternalStore`, so a hook count that depends on the active session
  // crashing React when one appears. `null` → `[]` (no session, no transcript).
  const childGates = useChildGates(activeSessionId);
```

### 1e. The attachment cell + `attachmentsRef` (lines 284–289)

```ts
  // Image attachments staged in the composer (CONTEXT.md: Attachment).
  // ALL of the attachment hooks live HERE, before the `!activeSessionId`
  // early return below — a hook called only on the full-frame path would
  // change the hook count when the active session appears/disappears and
  // crash React (the same bug the `useHasPendingRequest` comment
  // above warns about).
  const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
```

### 1f. The picker hooks block (lines 405–421) — the widest-scoped warning

```ts
  // --- The four-prefix picker (`$` skills / `#` MCP servers / `@` agents —
  // the three Mentions — plus `?` File completion, ADR 0033) + the send-path
  // expansion (which the `?` prefix never enters). ---
  // ALL of the hooks below live in the UNCONDITIONAL top block (before the
  // `!activeSessionId` early return further down) — placing any of them after
  // the early return would change the hook count across the session/no-session
  // transition and crash React (the same bug the `useHasPendingRequest`
  // comment above warns about). `useMentionPicker` is ONE such call and holds
  // every hook of the picker's (the rows memo, the insert-skill effect), so the
  // rule applies to its INSIDES too — nothing inside it may be conditioned on a
  // session. Plain (non-hook) functions like the attachment handlers are
  // placement-flexible and live with the other handlers below.
```

Governed hooks: `useMentionPicker`, `useMentionCatalogs`, `useCompletionDir`,
`useActiveSpaceCwd` (the two later hooks are individually noted "Called ABOVE
the `!activeSessionId` early return with every other hook", line 421).

### 1g. The Flush trigger — `useSessionIdleEdge` (lines 545–563)

```ts
  // ── The **Flush** trigger (part 1 of two — part 2 is the ref assignment below
  // `flushHead`) ──────────────────────────────────────────────────────────────
  // BEFORE the `!activeSessionId` early return: a hook after it is a
  // conditional hook call. `composerLocked` is in scope above, and the Flush's
  // real body lives below next to `sendText`, reached through this ref.
  const flushRef = useRef<() => void>(() => {});
  // `key` is the identity `composerLocked` describes: `composerLocked` is
  // derived from the ACTIVE Session's `inTurn` / `agentState` / `compacting`, so
  // a tab switch can move it `true → false` in one render, and without the key
  // the hook would read that as a fall and **Flush** the ARRIVED-AT Session's
  // head — from `activeSessionIdRef.current`, already re-synced, with no user
  // gesture, and against the new Session's not-yet-resolved **Space** catalogs.
  // `""` for the no-session frame: stable, and idle-on-both-sides can never be a
  // fall either.
  useSessionIdleEdge({
    busy: composerLocked,
    key: activeSessionId ?? "",
    onIdle: () => flushRef.current(),
  });
```

### Why the affected hooks are affected — summary

- **Hooks called conditionally crash React**: the count of hook calls must be
  identical on the no-session frame and the active-session frame. Every hook
  above is a hook (own `useState`/`useEffect`/`useSyncExternalStore`), so it
  must sit in the unconditional block.
- **`useSessionIdleEdge` is additionally a falling-edge detector with a `key`**:
  its `key: activeSessionId ?? ""` makes a session *switch* a re-seed, not an
  edge (see §7, ADR 0069). Any extraction of the Flush trigger must preserve
  both the unconditional placement and the `key`.
- **The hook-count constraint hits nested hooks too**: the comment at 1f
  expressly says nothing inside `useMentionPicker` may be conditioned on a
  session.
- The **JSX** below the early return uses only the values listed in §5; an
  extractor moving hooks "next to their consumers" below the guard would
  trigger the exact white-page crash all six comments describe.

---

## 2. Store selectors and derived values (regions 74–160 and 528–543)

All verbatim. "Inputs" column = what the selector/derivation reads.

### 2a. Active session id and transcript

```ts
  const activeSessionId = useSessions((s) => s.activeSessionId);
```
Input: `store.sessions.activeSessionId`.

```ts
  const messages =
    useSessions((s) =>
      s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
    ) ?? [];
```
Input: `sessions.activeSessionId`, `sessions.messages[id]`, with a `?? []`
fallback applied **outside** the selector. The comment directly above it:

```ts
  // Selectors must return stable references (no fresh `[]` fallbacks inside
  // the selector) or Zustand re-renders forever.
```

```ts
  const liveSession = useSessions((s) =>
    s.activeSessionId
      ? s.sessions.find((x) => x.sessionId === s.activeSessionId)
      : undefined,
  );
```
Input: `sessions.sessions` (find by `sessionId`).

```ts
  const activeCapabilities = useSessions((s) =>
    sessionFieldOf(s, s.activeSessionId, "capabilities"),
  );
```
Input: `sessionFieldOf(s, s.activeSessionId, "capabilities")`
(`lib/sessionLookup.ts` — the ONE three-list walk: live, stored, archived).
The doc comment above it (lines 83–96) is load-bearing:

```ts
  // The active session's CAPABILITIES, over the ONE three-list walk
  // (`lib/sessionLookup.ts`), which searches ALL THREE lists: a session living
  // ONLY in `archivedSessions` (opened from the Archived section) must still
  // resolve here — otherwise it renders no banner, a disabled composer ("This
  // session is closed"), and an unreachable `send()` auto-resume. Live wins, so
  // this is the same value the two row lookups it replaced produced
  // (`liveSession?.capabilities ?? stored?.capabilities`).
  //
  // It reads the FIELD and not the row on purpose: a selector may return the
  // stored row (a stable reference) but never a `{ … }` built per snapshot —
  // zustand v5 re-runs those forever (the rule at `ChatStream.tsx:80-81`).
```

```ts
  const activeSessionIsKnown = useSessions(
    (s) => sessionFieldOf(s, s.activeSessionId, "sessionId") !== undefined,
  );
```
Input: `sessionFieldOf(s, s.activeSessionId, "sessionId")`. Comment:
*"Whether ANY of the three lists knows the active id — the presence test the
old stored-row lookup gave for free. `sessionId` is a required field, so a hit
on it means a row exists; it is read as a primitive for the same reason above."*

```ts
  const inTurn = useSessions((s) => (s.activeSessionId ? !!s.inTurn[s.activeSessionId] : false));
  const stopReason = useSessions((s) => (s.activeSessionId ? s.stopReasons[s.activeSessionId] : undefined));
```

```ts
  const prompts =
    usePermissions((s) =>
      activeSessionId ? s.prompts[activeSessionId] : undefined,
    ) ?? [];
```

### 2b. The interactive-request classification (lines 114–141)

```ts
  const interactiveRequests =
    useInteractive((s) =>
      activeSessionId ? s.requests[activeSessionId] : undefined,
    ) ?? [];
  const askRequests = interactiveRequests.filter((r) => r.method === "ask");
  const confirmRequests = interactiveRequests.filter((r) => r.method === "confirm");
  const passwordRequests = interactiveRequests.filter(
    (r) => r.method === "password",
  );
```

Inputs of the three filters: `interactiveRequests`. Note the comment above
(`…Interactive surfaces for the ACTIVE session (B3): the store is keyed by the
ACP session id, which matches `activeSessionId`.`).

```ts
  const anchoredAskRequestIds = new Set<string>();
  for (const r of askRequests) {
    if (
      r.source === "main" &&
      r.toolCallId &&
      messages.some((m) => m.kind === "tool-call" && m.id === r.toolCallId)
    ) {
      anchoredAskRequestIds.add(r.requestId);
    }
  }
  const stackedAskRequests = askRequests.filter(
    (r) => !anchoredAskRequestIds.has(r.requestId),
  );
```
Inputs: `askRequests`, `messages`. The comment above (lines 122–127):
*"An `ask` request is ANCHORED when a `tool-call` message with its
`toolCallId` is in the stream (correlated by `(source, toolCallId)` — only a
`main` ask can anchor; the desktop has no ACP `tool_call` frame for child tool
calls). Anchored requests render IN PLACE of the `ToolCallCard`; the rest stack
in the stream (arrival order)."*

### 2c. Store actions (lines 142–148)

```ts
  const addUserMessage = useSessions((s) => s.addUserMessage);
  const addSystemLine = useSessions((s) => s.addSystemLine);
  const beginTurn = useSessions((s) => s.beginTurn);
  const turnCompleted = useSessions((s) => s.turnCompleted);
  const resumeSession = useSessions((s) => s.resumeSession);
```
`addSystemLine` doc (*"A Client-authored transcript line — the `/compact`
no-op's only feedback (ADR 0044). Pulled the same way every other store action
is pulled here."*).

### 2d. Agent state / lock derivations (lines 153–234)

```ts
  const agentState = useInteractive((s) =>
    activeSessionId ? s.agentState[activeSessionId] : undefined,
  );
```

```ts
  const workingOrInTurn = agentState === "working" || inTurn;
```

```ts
  const compacting = useSessions((s) =>
    s.activeSessionId ? s.compacting[s.activeSessionId] : undefined,
  );
```

```ts
  const composerLocked =
    workingOrInTurn || agentState === "blocked" || compacting !== undefined;
```
Inputs: `workingOrInTurn`, `agentState`, `compacting`. (Comment: the SAME
predicate the queue fork in `send()` enqueues on and the one `useSessionIdleEdge`
receives as `busy` — see §7 ADR 0069.)

### 2e. Settings-read values (lines 172–219)

```ts
  const spinnerStyle = normalizeVariant(
    useSettings((s) => s.settings?.spinnerStyle ?? "typing"),
  );
  const emptyStateAnimation = useSettings(
    (s) => s.settings?.emptyStateAnimation ?? null,
  );
  const mcpMentionsEnabled = useSettings(
    (s) => s.settings?.mcpMentionsEnabled ?? false,
  );
```
Inputs: `settings.settings.spinnerStyle`, `…emptyStateAnimation`,
`…mcpMentionsEnabled`; `spinnerStyle` passes through `normalizeVariant` (falls
back to the loader's `breathe` default on an unknown name).

### 2f. Capability / resume derivations (lines 525–537)

```ts
  const isLive = !!liveSession;
  const isHistoryOnly = !isLive && activeSessionIsKnown;
  const canResume = isHistoryOnly && activeCapabilities?.loadSession === true;
```

```ts
  const composerEnabled = isLive || canResume;
```
Inputs: `liveSession`, `activeSessionIsKnown`, `activeCapabilities`.
Comment over `composerEnabled`:
*"The composer's SEND is enabled for a live session OR a RESUMABLE stored
session (a non-resumable stored session can't receive a prompt — no agent
process to deliver to, and the harness's `send_prompt` rejects an unknown
session): a resumable stored session auto-resumes on send. The TEXTAREA is
always editable regardless (the draft is kept — it just can't be SENT while
`composerEnabled` is false)."*

### 2g. History pagination (lines 539–543)

```ts
  const history = useSessions((s) => activeSessionId ? s.history[activeSessionId] : undefined);
  const loadOlder = useSessions((s) => s.loadOlderHistory);
  const hasMore = history?.hasMore ?? false;
  const loadingMore = history?.loadingMore ?? false;
  const generation = history?.generation ?? 0;
```

### 2h. `hasImages` (post-guard, line 576–581) and the file-summary derivations (1188–1203)

```ts
  let hasImages = attachments.length > 0 && imageCapable;
```
with the load-bearing comment:
*"`hasImages`: a staged attachment AND the capability — the last line of the
fail-closed defense. … `let`: re-derived after `resume()` below — the FRESH
agent's capabilities (not the saved ones) decide whether images ship."*
Re-derived **only inside `send`** under the `!isLive` auto-resume arm (§6).

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
Inputs: `messages`. The doc comment (lines 1180–1187) is a correctness note:
*"the `tool-call.diff` refs are deliberately NOT used (summing both would count
every file twice)."*

### 2i. Selector stability warning (verbatim, line 76–77)

```ts
  // Selectors must return stable references (no fresh `[]` fallbacks inside
  // the selector) or Zustand re-renders forever.
```

---

## 3. The refs and their contracts

Declaration + doc comment verbatim, with the non-obvious invariants called out.

### `composerRef` (line 283)

```ts
  const composerRef = useRef<HTMLTextAreaElement>(null);
```
No doc comment; passed to `ComposerRow`, `useAutoGrowComposer`, and written by
`selectMention` / `stageFiles` (focus + caret restore). Contract: the owned
textarea; reading `selectionStart`/`setSelectionRange` and focus.

### `attachmentsRef` (lines 291–303)

```ts
  const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
```
```ts
  // Re-sync every render: the handlers read the CURRENT list from the ref
  // (a render closure would be stale for fast successive events — e.g.
  // pasting 8 files then a 9th in separate dispatches without a re-render
  // in between). Also read by the unmount-cleanup effect below (the effect
  // intentionally runs once, so the ref is the only live view it has).
  attachmentsRef.current = attachments;
```
Contract: **the staged list is mutated in-place during async flows**
(`send`'s held move, the failed-send restore, `stageFiles`, `removeAttachment`);
React state is only the render mirror. This is the *attachment lifecycle hook
candidate* — note the ref is the source of truth, the state is the mirror.

### `heldForSendRef` (lines 293–295)

```ts
  /** Attachments handed to a send that has not settled yet, keyed by session id.
   * They are OUT of `attachments` (so their thumbnails leave the composer
   * immediately) but NOT released — a failed send puts them back. */
  const heldForSendRef = useRef<Map<string, ChatComposerAttachment[]>>(new Map());
```
Contract: keyed by **session id** (not just one slot); written by `send`'s
`onCommitted` block; read/cleared by the success, catch-restore, session-switch
effect and unmount effect. The failure path *merges held back in FRONT* of the
staged list, de-duplicated by `id`, capped at `MAX_CHAT_ATTACHMENTS`, and
shifts draft markers by the number actually restored (§6).

### `sendingSessionsRef` (lines 305–311)

```ts
  // Task 5's double-send guard (a hook — must live here, not in `send`):
  // `beginTurn` runs AFTER an `await` (the base64 read), so the composer is
  // not locked until then and a second Enter/click during the read would
  // otherwise double-send. Keyed by session ID (a `Set`) so an in-flight
  // turn in session A never blocks sending in session B (concurrent sessions).
  const sendingSessionsRef = useRef<Set<string>>(new Set());
```
Contract: the **double-send slot shared by `send` and `flushHead`** — both add
before dispatch and delete in `finally`. A `return` *before* the `try` would
strand the session in the set and silently break every later send (the
placement rule quoted in §6).

### `activeSessionIdRef` (lines 313–316)

```ts
  // Re-sync every render (the same pattern as `attachmentsRef` above): `send()`
  // is async and reads the attachment via a FileReader `await` BEFORE
  // `beginTurn`, so the composer is unlocked during the read. If the session
  // switches during the read, the closure's `activeSessionId` is stale — this
  // ref is the LIVE value `send()` checks after the read and aborts on a
  // mismatch (no send, no draft wipe, no turn).
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
```
Contract: the cross-session-leak guard. Used by `send` (post-read abort, the
`onCommitted`/`catch`/`setError` gates), `handlePaste` (the WebKitGTK
clipboard-image fallback captures `pastedInSession` at paste time), and
`flushHead` (reads `sessionId` from it).

### `draftRef` (lines 319–323)

```ts
  // The LIVE draft, re-synced every render (the same pattern as `attachmentsRef`
  // above): `send()` captures `draft` at click time and the composer is not
  // locked until `beginTurn`, so the user can edit the draft during the
  // `resume()`/FileReader awaits. The ref is the live value `send()` checks
  // after the read and aborts on a mismatch (no stale send, no draft wipe).
  const draftRef = useRef(draft);
  draftRef.current = draft;
```
Contract: the stale-draft guard (`draftRef.current.trim() !== rawText`),
marker rewrite target in `removeAttachment` (`renumberImageMarkers`) and the
failed-send restore (`shiftImageMarkers`), and the caret/stage target in
`stageFiles` (`insertAtCaret(draftRef.current, caret, markers)`).

### `prevSessionIdRef` (line 370)

```ts
  const prevSessionIdRef = useRef(activeSessionId);
```
Contract: session-switch detector for the attachments-clear effect (§4). The
effect's comment carries the load-bearing "capture the session being LEFT
BEFORE the overwrite" rule.

### `flushRef` (lines 549–550, 1159–1161)

```ts
  const flushRef = useRef<() => void>(() => {});
```
```ts
  flushRef.current = () => {
    void flushHead();
  };
```
**Why it is a ref** (verbatim from the declaration comment): *"BEFORE the
`!activeSessionId` early return: a hook after it is a conditional hook call."*
The trigger hook (`useSessionIdleEdge`) must run unconditionally at the top,
but `flushHead` closes over post-guard values and is a plain function — so the
hook reaches the body *through the ref*. The part-2 comment (lines 1152–1158)
adds: *"a plain assignment (NOT a hook — the hook already ran above the early
return), the same render-phase ref mirror this file uses for `attachmentsRef`,
`activeSessionIdRef` and `draftRef`. A discarded concurrent render can leave
ITS closure in the ref and the next render re-assigns it — harmless here
(`flushHead` re-reads every value from the stores and the refs when it runs)…"*

---

## 4. The four effects

All four are in the unconditional top block (lines 326–403). Deps verbatim.

### 4a. Unmount cleanup (lines 326–340)

```ts
  useEffect(
    () => () => {
      attachmentsRef.current.forEach(releaseAttachment);
      heldForSendRef.current.forEach((held) => held.forEach(releaseAttachment));
    },
    [],
  );
```
Deps: `[]` (runs once; the cleanup releases on unmount only). Reads:
`attachmentsRef.current`, `heldForSendRef.current`, `releaseAttachment`.
Comment (verbatim, lines 327–331): *"Unmount cleanup: revoke the staged object
URLs exactly once, on unmount ONLY — revoking on every state change would
leak/break live previews (a revoked URL can no longer render the `img`). The
held-for-send map is walked too: an unmount while a turn is in flight leaves
those attachments in NO state the composer can reach again, so this is their
last chance to be released."*

### 4b. Global Esc interrupter (lines 344–367)

```ts
  useEffect(() => {
    if ((!inTurn && compacting === undefined) || !activeSessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void cancelSession(activeSessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inTurn, activeSessionId, compacting]);
```
Deps: `[inTurn, activeSessionId, compacting]`. Reads: `inTurn`, `compacting`,
`activeSessionId`, `cancelSession` (module import). The comment names the
deliberate cosmetic consequence: with `compacting` in the deps, one Esc can
both dismiss an open picker and cancel a compaction.

### 4c. Session-change guard (lines 369–398)

```ts
  const prevSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === activeSessionId) return;
    // Capture the session being LEFT BEFORE the overwrite below: at the
    // release point the ref would otherwise hold the session being ENTERED,
    // so the held-for-send lookup would miss — and the failure path's `delete`
    // drops that entry without releasing it, making the leak permanent.
    const left = prevSessionIdRef.current;
    prevSessionIdRef.current = activeSessionId;
    attachmentsRef.current.forEach(releaseAttachment);
    attachmentsRef.current = [];
    setAttachments([]);
    // A turn still in flight in the session we just left: its held
    // attachments can never be restored there (this effect already cleared the
    // composer) and can never be restored here, so release them now. `left`
    // can be `null` (no session → session), and nothing is ever held under a
    // `null` key, so the guard is both the type narrowing and the truth.
    if (left !== null) {
      const held = heldForSendRef.current.get(left);
      if (held) {
        held.forEach(releaseAttachment);
        heldForSendRef.current.delete(left);
      }
    }
  }, [activeSessionId]);
```
Deps: `[activeSessionId]`. Reads/writes: `prevSessionIdRef` (R+W),
`attachmentsRef` (R+W), `heldForSendRef` (R+W), `setAttachments`,
`releaseAttachment`. Comment (excerpt): *"`ChatStream` is one long-lived
component (no `key`), so `attachments` would otherwise survive a switch to
another session — images staged in session A (image-capable) could be sent to
session B even if B's agent doesn't advertise `promptCapabilities.image`
(breaking the fail-closed guarantee). Clear + release on switch."*

### 4d. The Flush's auto-trigger, via hook (lines 544–563)

The fourth "effect" is the `useSessionIdleEdge({ busy, key, onIdle })` call
quoted in §1g — itself an effect in `src/hooks/useSessionIdleEdge.ts`
(module doc: *"Fires `onIdle` on the FALLING EDGE of a composite busy flag —
the trigger for the **Prompt queue**'s **Flush**"*). Behaviour contract:
`busy: composerLocked`, `key: activeSessionId ?? ""` (a key *change* re-seeds
`seen` and can NEVER fire — the route that prevents flushing the arrived-at
session), `onIdle: () => flushRef.current()`. The hook assigns `cb.current =
opts.onIdle` during render, so `flushHead` is always the current render's
closure (no `useCallback` needed). Extracting the flush trigger keeps this hook
call, the ref, and the `flushRef.current` assignment (§3, lines 1159–1161)
as one unit.

---

## 5. The seams — every candidate boundary, with exhaustive scope

For each: verbatim signature, line span (base `b0071544`), and **everything**
component-scope (closure) + module-scope it reads or writes. "Reads" includes
variables captured by the closure. Module-scope (imports/libs) is listed once
per symbol; component-scope lists are exhaustive.

Key cross-cutting reads (used by almost all seams): `imageCapable` (325),
`activeSessionIdRef` (314), `draftRef` (321), `attachmentsRef` (291),
`composerRef` (283), `setDraft`, `setAttachments`, `setError`.

### 5a. `sendText` — lines 601–739

```ts
  const sendText = async (
    sessionId: string,
    rawText: string,
    images: SendTextImages | undefined,
    onCommitted: (sentIds: Set<string>) => void,
  ): Promise<StopReason | null> => {
```

JSDoc (verbatim, lines 587–599):
*"The shared send tail: expand → normalise → the user row → beginTurn →
sendPrompt. `rawText` is the RAW draft and `images` is the CALLER's already
reconciled attachment list (id-bearing); the caller owns composer STATE, so
this never calls `setDraft` / `setAttachments` and never calls
`turnCompleted`. … `onCommitted(sentIds)` fires immediately BEFORE
`addUserMessage` — that is where `send()`'s `setDraft("")` and its
held-attachment move sit today… Resolves `null` for "NOTHING was dispatched —
bail silently, do NOT settle".*"

Reads:
- component: `skills`, `agents`, `mcpServers` (425/428), `mcpMentionsEnabled`
  (218) — via `expandMentions`;
- module: `expandMentions` (const `marks`/`masked` closure uses it),
  `addUserMessage`, `beginTurn`, `sendPrompt` (2-arg and 3-arg), `StopReason`.
Writes: none to state; calls `onCommitted(sentIds)` (the caller's hook),
`addUserMessage(sessionId, text, imageRefs)`, `beginTurn(sessionId)`;
returns the `sendPrompt` result.

### 5b. `send` — lines 741–1029 (296‑line body)

```ts
  const send = async () => {
```

Reads:
- `activeSessionId` (74), `draft` (280), `hasImages` (576 — and re-derives it
  under the resume arm), `composerLocked` (233), `isLive` (528), `canResume`
  (530), `attachments` (290), `resuming` → no (via `resume`), `attachment…`;
- refs: `attachmentsRef`, `sendingSessionsRef`, `activeSessionIdRef`,
  `draftRef`, `heldForSendRef`;
- store actions: `addSystemLine` (144), `turnCompleted` (147), and the
  imperative `useSessions.getState().sessions` (the `fresh` capability lookup);
- store: `useQueuedPrompts.getState().enqueue`;
- module: `draftIsMarkerOnly`, `parseComposerCommand`, `compactSession`,
  `resume` (local), `readAttachmentAsBase64`, `releaseAttachment`,
  `describeIpcError`, `MAX_CHAT_ATTACHMENTS`, `addImageAttachments` (via
  `stageFiles`? no — not used; the cap constant only), `shiftImageMarkers`,
  `agentSupportsImages`, `sendText` (local), `StopReason`.
Writes:
- state: `setError(null)` / `setError(msg)`, `setDraft("")`,
  `setAttachments([])` (queue fork) / `setAttachments(staged)` (held move) /
  `setAttachments(merged)` (restore), `setDraft(shiftImageMarkers(...))`
  (restore);
- refs: `sendingSessionsRef` (add/delete), `attachmentsRef` (clear, held
  filter, merged), `heldForSendRef` (set, delete);
- store: `useQueuedPrompts.getState().enqueue(targetSessionId, {…})`,
  `addSystemLine`, `turnCompleted(targetSessionId, stopReason)` /
  `turnCompleted(targetSessionId, "end_turn")`;
- module (side effects): `compactSession`, `readAttachmentAsBase64`,
  `releaseAttachment`.

### 5c. `flushHead` — lines 1037–1150

```ts
  const flushHead = async () => {
```

Reads:
- refs: `activeSessionIdRef` (target session), `sendingSessionsRef`;
- component: `imageCapable` (325), `sendText` (local — declared above it; the
  declaration order comment says *"Declared AFTER `sendText` so it closes over
  it"*);
- store: `useQueuedPrompts.getState().takeHead(sessionId)`,
  `useQueuedPrompts.getState().requeueHead(sessionId, {…})`, `turnCompleted`;
- module: `readAttachmentAsBase64`, `releaseAttachment`, `describeIpcError`,
  `SendTextImages`.
Writes:
- refs: `sendingSessionsRef` (add in try, delete in `finally`);
- store: `turnCompleted(sessionId, stopReason)` / `turnCompleted(sessionId,
  "end_turn")` (guarded by the `dispatched` flag), `requeueHead` with
  `{ ...entry, leaving: undefined, failed: true }`;
- state: `setError(describeIpcError(err))` — only when
  `activeSessionIdRef.current === sessionId`.
Local control: the `dispatched` boolean (set immediately before the `sendText`
call) distinguishes a post-`beginTurn` rejection (settle) from a pre-turn
FileReader failure (do NOT settle — would overwrite the previous turn's stop
reason). The `stopReason === null` arm is documented *"UNREACHABLE from this
caller and deliberately UNTESTED"* — kept only to make the `StopReason | null`
union exhaustive for `turnCompleted`.

### 5d. `resume` — lines 1163–1176

```ts
  const resume = async (): Promise<boolean> => {
```

Reads: `activeSessionId` (74), `resuming` (282), `resumeSession` (148).
Writes: `setResuming(true/false)`, `setError(null)` / `setError(describeIpcError(err))`.
Module: `describeIpcError`. Contract: returns `false` on no-session, on a
concurrent resume, or on failure (error already set); `true` otherwise.

### 5e. `stageFiles` — lines 1221–1286

```ts
  const stageFiles = (files: File[]) => {
```

Reads: `attachmentsRef.current` (the *current* list — the "single funnel"
comment), `composerRef.current`, `draftRef.current`, `document.activeElement`.
Writes: `attachmentsRef.current = next`, `setAttachments(next)`,
`setDraft(inserted.text)` (markers inserted at the caret; marker string built
ascending so a multi-file batch numbers `#k #k+1 …`), `setError(rejected.length
> 0 ? rejected.join("; ") : null)`, plus a `requestAnimationFrame` focus +
`setSelectionRange(pos, pos)` restore.
Module: `addImageAttachments` (staging + caps + MIME rejection), `imageMarker`,
`insertAtCaret`.

### 5f. `handlePaste` — lines 1288–1345

```ts
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
```

Reads: `imageCapable` (gate — *"fall through: default text paste"*),
`e.clipboardData` items/text/html, `shouldPreferSpreadsheetClipboardText`,
`activeSessionIdRef.current` (`pastedInSession` capture at paste time).
Writes: `stageFiles(files)` (local); on the empty-clipboard WebKitGTK
fallback path calls `readClipboardImage()` and — if bytes and no session
switch — `stageFiles([file])`.
Module: `shouldPreferSpreadsheetClipboardText`, `readClipboardImage`.

### 5g. `handleDrop` — lines 1358–1361

```ts
  const handleDrop = (e: React.DragEvent) => {
    if (!imageCapable) return;
    e.preventDefault();
    stageFiles(Array.from(e.dataTransfer.files));
  };
```
Reads `imageCapable`; writes via `stageFiles`.
(The long comment at 1346–1357 states the staging-during-turn invariant:
*"a locked composer STAGES, it does not DISPATCH"* — shared by paste, drop and
the picker; a locked Enter moves the staged set into the queue entry.)

### 5h. `handleAttachClick` — lines 1377–1421

```ts
  const handleAttachClick = async () => {
    if (!composerEnabled || !imageCapable) return;
```

Reads: `composerEnabled`, `imageCapable`, `openFileDialog` (module),
`readFileBytes` (module), `basenameOfPath`, `inferAttachmentMimeType`,
`describeIpcError`.
Writes: `stageFiles(files)` (when any file survived the reads),
`setError(readError)` (only when nothing staged).
Comment (verbatim, key rule): *"NO `composerLocked` term, on purpose: the
picker stages, it does not dispatch … `composerEnabled` DOES stay: a session
that cannot be sent to must not accumulate images."*

### 5i. `removeAttachment` — lines 1423–1440

```ts
  const removeAttachment = (id: string) => {
```

Reads: `attachmentsRef.current` (find + findIndex), `draftRef.current`.
Writes: `releaseAttachment(target)` (outside any state updater — updaters must
be pure under StrictMode), `setDraft(renumberImageMarkers(draftRef.current,
position))`, `attachmentsRef.current = next`, `setAttachments(next)`.
Module: `releaseAttachment`, `renumberImageMarkers`.

### 5j. Was already extracted (do NOT re-extract)

Listed in the `src/hooks/` + `src/components/chat/` scan (§8). Within
`ChatStream.tsx` the seams that already left the component are:
`selectMention` (comment at 1442–1444: *"`selectMention` moved to
`hooks/useMentionPicker.ts` (Task D4)"*) and the two standalone hooks
`useWindowDropBackstop` / `useAutoGrowComposer` (comment at 394–401: *"Both
moved out to their own hooks (Phase D / Task D4)"*).

---

## 6. `send()`'s control flow, in order (the 296-line body, lines 741–1029)

The order here is the feature — several of these steps carry comments explicitly
stating the ORDER is load-bearing. The lock-parity and one-turn-at-a-time
rationales are carried in the comments quoted below.

1. **Emptiness guard** (lines 742–761). `const targetSessionId = activeSessionId;
   if (!targetSessionId) return; const rawText = draft.trim();` then

   ```ts
   if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;
   ```
   The comment: *"SPLIT (ADR 0069): the emptiness check and the LOCK check are
   no longer one condition. Empty stays a silent no-op — there is nothing to
   queue — but a non-empty draft while the composer is locked now has somewhere
   to go: the **Prompt queue**."*

2. **The locked-composer fork → the prompt queue** (lines 763–797). *"The fork.
   It sits BEFORE `sendingSessionsRef` and before the `try`, so a queueing
   press never occupies the double-send slot (and, because it returns ahead of
   the `try`, it must not rely on the `finally` for cleanup…)."*
   a. **`/compact` command consumption in the fork** (lines 765–775):
   `const command = parseComposerCommand(rawText); if (command) { addSystemLine(targetSessionId, `/${command.name} runs when this turn ends — try again then.`); return; }` — a Composer command is NEVER queued (ADR 0044: consumed, no user row).
   b. **The move with the text** (lines 776–795): `const moved =
   attachmentsRef.current; attachmentsRef.current = []; setAttachments([]);
   useQueuedPrompts.getState().enqueue(targetSessionId, { id:
   crypto.randomUUID(), text: rawText, attachments: moved, state: "queued" });
   setDraft("");` — with *"The URLs MOVE with the text: never revoke here… The
   `[image #N]` markers travel UNTOUCHED… Nor is the text expanded — ADR 0069
   stores the RAW draft so expansion runs at send, against the catalog of THAT
   moment."*

3. **Double-send guard** (lines 797–798):

   ```ts
   if (sendingSessionsRef.current.has(targetSessionId)) return; // guard: see the ref's comment above
   sendingSessionsRef.current.add(targetSessionId);
   ```

4. **`try` opens; `setError(null)`** (line 800).

5. **`/compact` command consumption in the live path** (lines 801–828). The
   comment is the pair of placement rules, quoted verbatim because both are
   load-bearing:

   ```ts
   // ── A **Composer command** is consumed HERE and goes no further (ADR
   // 0044): no `addUserMessage`, no `beginTurn`, no `sendPrompt`, no
   // `turnCompleted`. ADR 0031's byte-identity contract is deliberately
   // narrower than "nothing in the draft is rewritten" — it governs text that
   // IS SENT, and this sends nothing.
   //
   // TWO PLACEMENT RULES, both load-bearing:
   //  • INSIDE the `try`, not before it. `send()` ends in a
   //    `finally { sendingSessionsRef.current.delete(targetSessionId) }`, so an early `return` above
   //    the `try` would leave the session stuck in the set and silently break EVERY
   //    later send — the composer would look alive and never fire.
   //  • BEFORE the `if (!isLive)` auto-resume block below. A command that
   //    fell through it would RESUME a stored session purely to compact it —
   //    the exact flow ADR 0044 rejects — and would then make
   //    `compact_session` report the session LIVE, so the non-live answer
   //    below could never happen. The order is the feature.
   ```
   Body: `setDraft("");` then, only for `command.name === "compact"`,
   `const live = await compactSession(targetSessionId, command.args || null);`
   and `if (!live) addSystemLine(targetSessionId, "Nothing to compact — this
   session is not open.");` then `return;` — *"a Composer command is not a
   prompt"* (staged attachments are left staged).

6. **`!isLive` auto-resume** (lines 829–857). `if (!isLive) { if (!canResume)
   return; if (!(await resume())) return;` then the fresh-capability
   re-derivation:
   ```ts
   const fresh = useSessions
     .getState()
     .sessions.find((x) => x.sessionId === targetSessionId);
   hasImages =
     attachments.length > 0 && agentSupportsImages(fresh?.capabilities);
   ```
   followed by the re-run of the marker-only emptiness guard (`if (!hasImages
   && (rawText === "" || draftIsMarkerOnly(rawText))) return;`). Comment: the
   SAVED capabilities that gated `hasImages` are stale after resume; a fresh
   agent that can't take images proceeds text-only.

7. **FileReader block** (lines 858–891). `let images: SendTextImages |
   undefined; if (hasImages) { try { const read = await Promise.all(
   attachments.map(async (att) => ({ id: att.id, … data: await
   readAttachmentAsBase64(att) })) );` then reconcile against the LIVE list —
   `const liveIds = new Set(attachmentsRef.current.map((a) => a.id)); images =
   read.filter((i) => liveIds.has(i.id));` — so a thumbnail removed during the
   read is not sent. `catch` sets `setError("Failed to read an attached
   image")` (only if `activeSessionIdRef.current === targetSessionId`) and
   returns (attachments stay staged; slot released in `finally`).

8. **Session-switch abort** (lines 892–894): `if (activeSessionIdRef.current
   !== targetSessionId) return;` — no send, no draft wipe, no turn.

9. **Stale-draft abort** (lines 895–900): `if (draftRef.current.trim() !==
   rawText) return;` — compares the RAW text (expansion re-derives from the
   fresh draft below).

10. **The send tail via `sendText`** (lines 902–941). Comment:
    *"`onCommitted` is where `setDraft("")` and the held-attachment move used to
    sit, merged into ONE callback: today the held block ran three statements
    after `setDraft("")` with **no `await` between them**, and both are
    synchronous ref/state writes that React 19 batches into the same commit —
    so firing them together at `setDraft`'s old position is observationally
    identical, not a reordering a user or a test can see."*
    `onCommitted(sentIds)` body: `setDraft("");` then, guarded by
    `sentIds.size > 0 && activeSessionIdRef.current === targetSessionId`, hold
    the sent attachments out of `attachments` (`heldForSendRef.current.set(
    targetSessionId, held); attachmentsRef.current = staged;
    setAttachments(staged);`).

11. **`null` bail** (lines 942–944): `if (stopReason === null) return;` — still
    runs the `finally`, releasing the double-send slot; do NOT settle (no user
    row, no `beginTurn`).

12. **Success settle + held release** (lines 945–957): read
    `heldForSendRef.current.get(targetSessionId)`; if held, `held.forEach(
    releaseAttachment); heldForSendRef.current.delete(targetSessionId);` then
    `turnCompleted(targetSessionId, stopReason);`.

13. **`catch`: settle, error, attachment restore** (lines 958–1024).
    a. `turnCompleted(targetSessionId, "end_turn");`
    b. `const msg = describeIpcError(err); if (activeSessionIdRef.current ===
    targetSessionId) setError(msg);`
    c. **The restore block must stay in the same synchronous block as
    `setError`** (comment: the test waits on the error line; an `await` between
    them lets the test observe the pre-restore DOM — flaky).
    d. Read `held`; if `held && held.length > 0 && activeSessionIdRef.current
    === targetSessionId`: `live = attachmentsRef.current`; `ids` set; `fitting =
    held.filter((a) => !ids.has(a.id))`; **cap** — `const room = Math.max(0,
    MAX_CHAT_ATTACHMENTS - live.length); const back = fitting.slice(0, room);`
    and `fitting.slice(room).forEach(releaseAttachment);` (the overflow has no
    owner left); `const merged = [...back, ...live]; attachmentsRef.current =
    merged; setAttachments(merged);`
    e. **Marker renumbering** (lines 1011–1019): `if (back.length > 0)
    setDraft(shiftImageMarkers(draftRef.current, back.length));` — shift by the
    number ACTUALLY restored (the cap can make it differ from what left); reads
    the live `draftRef`, not the closure.
    f. `heldForSendRef.current.delete(targetSessionId);` always.
    g. Note (line 1022): the pre-send text is still lost on failure
    (`setDraft("")` ran at send — pre-existing); what survives is post-send
    typing.

14. **`finally`** (lines 1025–1028): `sendingSessionsRef.current.delete(
    targetSessionId);`.

---

## 7. ADRs governing this file's behaviour

Cited in `ChatStream.tsx` (grep for `ADR` gave: 144, 161, 166, 192, 200, 258,
405, 431, 445, 475, 752, 766, 783, 801, 803, 814, 1031). The four the planner
asked about, with one-line constraints:

- **ADR 0069 — the prompt queue is renderer state, not harness state**
  (`docs/decisions/0069-the-prompt-queue-is-renderer-state-and-not-harness-state.md`).
  Constraint: the queue lives in the renderer store; a queued prompt holds the
  RAW draft (expansion runs at send, against that moment's catalog, preserving
  ADR 0031 byte-identity by construction); the Flush sends the visible
  session's head as an ordinary `send_prompt` when `composerLocked` falls.
- **ADR 0044 — the composer command grammar**
  (`docs/decisions/0044-the-composer-command-grammar.md`). Constraint: `/compact`
  is CONSUMED at the composer — nothing sent, no user row, no turn; never
  queued; must be consumed before the auto-resume block (order = feature).
- **ADR 0035 — out-of-space completion is a one-directory peek**
  (`docs/decisions/0035-out-of-space-completion-is-a-one-directory-peek.md`).
  Constraint: the `?` picker's outside-space mode lists exactly ONE directory
  per `dirPrefix` cache key (`dirPartOfOutsideQuery`), with the last `/` of the
  WHOLE remainder (spaces included) as the cut.
- **ADR 0031 — composer mention grammar and emergent tag-safety**
  (`docs/decisions/0031-composer-mention-grammar-and-emergent-tag-safety.md`).
  Constraint: `$ @ #` expansions must be byte-identical when nothing matches;
  the expansion is the single path that produces the text for the live bubble,
  the persisted record and the agent's input alike (the `mergeDedupeKey`
  resume-merge stability depends on it).

Also cited by the file and worth one line each for the extraction: **ADR 0033**
(`?` inserts a PATH, never content — `?` never enters `expandMentions`);
**ADR 0045** (the `compaction_update` frame is the ONLY composer-lock signal
for idling compactions — hence `compacting` in `composerLocked` and in the Esc
effect's deps); **ADR 0055** (a child parked on a gate is an Active Subagent
with no clock — why `useHasPendingRequest` counts app-wide); **ADR 0077**
(compaction leaves a durable history card — not a live busy flag).
(Related-but-not-in-file: ADRs 0037, 0032, 0040, 0042, 0043, 0046, 0047,
0053–0057 live in `docs/decisions/` but are not cited by `ChatStream.tsx`
outside the mentions above.)

---

## 8. Verification commands for this area

Run from the repo root (`/home/daniel/Coding/AI/archimedes-desktop`):

```sh
# 1. The 280 `it()`s that pin this component (7,885 lines) — the primary gate.
npm test -- src/components/ChatStream.test.tsx

# 2. The pieces that already moved out (work with the above; broke = your extraction regressed them)
npm test -- src/hooks/useMentionPicker.test.tsx \
  src/hooks/useSessionIdleEdge.test.ts \
  src/hooks/useAutoGrowComposer.test.ts \
  src/hooks/useWindowDropBackstop.test.ts
npm test -- src/components/chat/QueueRows.test.tsx \
  src/components/chat/AttachmentStrip.test.tsx

# 3. The pure modules the seams (a)–(e) sit on (syntax-identity seams: expansion, markers, staging)
npm test -- src/lib/skills.test.ts src/lib/chatAttachments.test.ts \
  src/lib/composerCommands.test.ts src/lib/sessionLookup.test.ts

# 4. Type gate (script: "build": "tsc && vite build" — `tsc` alone is enough for the extraction)
npx tsc --noEmit

# 5. Store contracts for the queue (renderer state, ADR 0069)
find src/store -name "*.test.ts*" | grep -i -E "queued|sessions|interactive" # run whatever matches
```

Notes:
- `npm test` = `vitest run` (`package.json` scripts) — no `src/` filter needed
  beyond the argument above; `vitest.config.*` does not exist, config lives in
  `vite.config.ts`.
- Do NOT run `npm run dev`/`npm run tauri dev` in an extraction task — they
  start long-running processes.
- The single most sensitive test is the one pinned by the `useHasPendingRequest`
  comment (no-session → active-session WITH a pending child gate): it is the
  anti-regression guard for the hook-ordering constraint in §1.
- The picker `dirPrefix` derivation and the resume/descent-go-live behaviour are
  mutation-checked by `ChatStream.test.tsx` at component level — a hook-level
  cache test cannot prove them (quoted in the source comments at lines 449–456
  and 483–487).

---

## Sources

- `src/components/ChatStream.tsx` (base `b0071544`, branch `feature/chatstream-decomposition`) — all quotes
- `src/hooks/useSessionIdleEdge.ts` — Flush-trigger hook contract
- `docs/decisions/0069-the-prompt-queue-is-renderer-state-and-not-harness-state.md`
- `docs/decisions/0044-the-composer-command-grammar.md`
- `docs/decisions/0035-out-of-space-completion-is-a-one-directory-peek.md`
- `docs/decisions/0031-composer-mention-grammar-and-emergent-tag-safety.md`
- `docs/decisions/0033-file-completion-inserts-a-path-not-content.md`, `0045-context-overflow-is-a-tier-recovered-in-the-turn.md`, `0038-attention-alerts-fire-only-while-unfocused.md` (context)
- `package.json` (scripts: `test` = `vitest run`)
- `src/hooks/` directory listing (already-extracted hooks, §5j)
