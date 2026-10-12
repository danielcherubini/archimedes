---
status: approved
done-when: >
  With a Subagent session holding an `ask` and its parent Session open in front of
  the user, the question is answerable in the parent's transcript without opening the
  subagent sheet, and no gate is answerable in two places at once.
---

# A Subagent session's gates are answered in its parent's transcript

## What

A **Subagent session**'s four user-facing gates — `ask`, `confirm`, `password`, and the
**Permission prompt** — become answerable in the **parent Session's** transcript, labelled
with the child's `agentName`, instead of hiding inside the subagent's own sheet where
nothing points to them.

## Why

A child's `ask` and **Permission prompt** render only in `SubagentTranscript`
(`src/components/SubagentTranscript.tsx:152-165`), reachable only by opening the child's
sheet in `SubagentDetailHost`. Interactive gates carry **no deadline by design** — a prompt
ends when the person answers or the session is cancelled, never when a clock runs out
(`src-tauri/src/agent/interactive/mod.rs`, the request-flow doc). But the subagent drive
races a `settle_timeout` of **30 minutes**
(`DEFAULT_SUBAGENT_SETTLE_TIMEOUT`, `src-tauri/src/agent/worker/manager.rs:30`).

So a child gate the user never notices strands the parent's turn for half an hour and then
resolves `Failed { "timed out" }` — a hung delegation that reads as a child failure. The
only cue today is a dot whose count is app-wide and parent-blind.

## Design

### 1. Ownership — one render site per gate, gates leave the child transcript

Every gate keeps exactly **one** render site. This is an existing invariant, enforced today
by partitioning on *method*: `confirm`/`password` render only in `SubagentModals`
(`src/components/SubagentModals.tsx:12-16`) and `ask`/`PermissionPrompt` only in
`SubagentTranscript`.

- `SubagentTranscript` renders **no gates at all** — it becomes purely a log.
- `SubagentDetailHost`'s always-mounted hidden host is **deleted**. Its sole documented
  purpose was keeping gate cards mounted so a request is never unrendered
  (`src/components/SubagentDetailHost.tsx:19-24`); with no gates there, that reason is gone.
  The two documented consequences of the hidden host go with it: the "local state resets on
  the modal swap" known-behaviour, and the sheet-`onKeyDown` Esc analysis written for
  `AskQuestionCard` (`SubagentDetailHost.tsx:41-58`) — the card no longer lives in the
  sheet's subtree.
- **Rust is untouched.** `respondInteractiveRequest` / `respond_permission` already route by
  `sessionId`, and both card components already take `(sessionId, requestId)` and are
  indifferent to whose session they are answering. This is entirely a Client change.

### 2. The partition — keyed on parent activity, not on method

`ChatStream` renders only the active session (`src/components/ChatStream.tsx:108-113`), so a
lifted gate needs a rule for the parent the user is not looking at. The partition mirrors the
existing anchored/stacked split, which already derives a `Set` and gives each half exactly one
render site (`ChatStream.tsx:118-134`):

```
entry.parentSessionId === activeSessionId  →  inline, bottom of the parent's transcript
otherwise                                  →  the generalized overlay at SidePane root
```

New single source of truth:

```ts
// src/hooks/useChildGates.ts
useChildGates(parentSessionId): ChildGate[]
// ChildGate = { childSessionId, agentName, requestId,
//               kind: "ask" | "confirm" | "password" | "permission" }
```

It filters `useSubagents.entries` on `parentSessionId`, then joins that child-id set against
`useInteractive.requests` and `usePermissions.prompts`. Selectors return the stores' own
slices — never a `?? {}` fallback inside a selector, which mints a fresh object per call and
re-renders forever (the standing hazard documented in `src/hooks/useSessionStatus.ts:68-70`).

Three consumers, no restatement of the derivation:

1. **`MessageList`** — inline half: the `ask` + `permission` entries, rendered after the
   existing `prompts` and `stackedAskRequests` blocks (`src/components/chat/MessageList.tsx:151-165`).
2. **`SubagentModals`** — overlay half: generalized from `confirm`/`password` to all four
   kinds, rendering only gates whose parent is **not** active. It keeps its `fixed` position at
   the `SidePane` root and its documented reason for being there (a `fixed` overlay escapes the
   collapsed frame's `width: 0` + `overflow: hidden` clipping).
3. **The cue derivations** (section 3).

The overlay must survive for inactive parents: `ChatStream` renders only the active session, so
an unrendered child gate is the same stranding this feature exists to kill. That is already
`SubagentModals`' stated reason for existing (`SubagentModals.tsx:9-16`).

### 3. Attribution and cues

- **Chip:** every lifted card carries `↳ <agentName>`, from the existing
  `SubagentEntry.agentName` — the same label the directory and `SubagentDelegatingCard` use, so
  no new field. It goes on the card's **outer wrapper**, not inside `AskQuestionCard` /
  `PermissionPrompt`, which stay parent/child-agnostic.
- **Stack order:** child gates append *after* the parent's own cards, ordered by
  (child arrival, request arrival). The parent's own question is answerable without a context
  switch, so it ranks first.
- **The dot:** `usePendingSubagentRequests` (`src/hooks/usePendingSubagentRequests.ts`) is
  rebuilt on `useChildGates`, counting the active session's children plus the overlay's share.
  This fixes a latent bug: it currently counts **every** subagent entry app-wide and ignores
  `parentSessionId`, so a child of Session B lights the dot on Session A
  (`src/components/ChatStream.tsx:1019-1026`, `src/hooks/useHasPendingRequest.ts:26-32`).
  Harmless while it was only a dot; wrong once it is a card sitting in A's transcript.
  `useHasPendingRequest` keeps its shape — one source of truth, three consumers unchanged.
- **The attention alert:** child gates are **re-keyed into `waitingIds` under their parent's
  id**, and subagent ids drop from `candidateOrder`'s tail
  (`src/hooks/useAttentionAlert.ts:106-116`). Re-keying is required, not cosmetic:
  `attentionCandidates` iterates `candidateOrder` and looks up `waitingIds[id]`
  (`src/lib/attention.ts:158-162`), so a child id absent from `candidateOrder` is never
  visited. A child's gate therefore ranks at its parent's position, and the alert body resolves
  through `parents[id]` (`useAttentionAlert.ts:243-245`) so it names the parent directly. The
  `settled` arm is unaffected — `attention.ts:168` already skips ids absent from `settledWatch`.
  **This amends ADR 0040**, which documents "a subagent's gate ranks last"
  (`docs/decisions/0040-…:32`); that clause was written about the `settled` ladder
  ("its parent is still in turn, so it is never `settled`") and its side effect — a child's gate
  is last to win the single alert slot — is exactly the invisibility being removed here.

### 4. Edge cases

- **Stale entry.** A gate whose `childSessionId` has no `SubagentEntry` renders **nothing**.
  `parentSessionId` is held only by `useSubagents` (`useAttentionAlert.ts:239-241` says so
  outright), so an evicted entry (`MAX_CLOSED_ENTRIES`, `src/store/subagents.ts:13`) means an
  unknown parent and the gate has no home. Fail-quiet is safe: the store already dismisses a
  closed session's gates (`dismissSession`, `src/App.tsx:70`) and the Supervisor's
  `cleanup_pending_modals` emits `interactive-request-close` on teardown either way, so nothing
  can hang.
- **`settle_timeout` stays at 30 minutes.** This removes the *invisibility*, not the
  no-deadline posture: a gate still ends when the person answers or the session is cancelled.
- **A parent close cannot orphan a child's gate** — verified in Rust rather than assumed.
  `close_session` marks the turn cancelled and `detach`es the parent's Worker
  (`src-tauri/src/agent/session/mod.rs:1618-1639`); the child's drive lives in a separate
  `drives` map keyed by child id, and the turn-cancel arm fires the child's
  `SubagentCancel.cancel()` → `cancel_subagent` → `send_abort` + reap
  (`src-tauri/src/agent/subagent.rs`, `worker/manager.rs:500`). No card can outlive its child.
  The render path still tolerates the absent entry, per the case above.
- **Status must follow the gate.** `sessionStatusOf` derives `waiting` from a session's *own*
  `prompts`/`requests` only (`src/hooks/useSessionStatus.ts:37-42`), so a parent blocked on its
  child's gate reads **`running`** while it is in fact blocked on the user — and after section 3
  the re-ranked alert would disagree with the row pill. It gains a `childGateCount` input so the
  row pill, the rail mark, and the alert all agree. Both consumers thread it:
  `useSessionStatus` (one row) and `useSessionStatuses` (the collapsed rail, which subscribes to
  `useSubagents.entries` once rather than minting an array per row).

## Consequences

- **The subagent sheet is no longer answerable.** Opening a child's transcript shows a log, not
  a form. Acceptable because the gates are always visible where the parent is visible, or in the
  overlay — never nowhere.
- **`sessionStatusOf`'s input widens**, so every caller must supply the child-gate fact; the
  pure-function shape is what keeps the row and the rail from restating the rule.
- **ADR 0040 needs an amendment** for the ranking clause, and `CONTEXT.md`'s *Subagent session*
  entry — which says prompts "go directly to the Client (the Supervisor's relay)" — should say
  where they now render, since that sentence is what let the child-sheet placement read as
  intentional.
