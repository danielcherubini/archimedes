---
status: committed
done-when: >
  With a Subagent session holding an `ask` and its parent Session open in front of
  the user, the question is answerable in the parent's transcript without opening
  the subagent sheet; the parent's row says "Waiting"; and no gate is answerable in
  two places at once.
---

# A Subagent session's gates are answered in its parent's transcript — Plan

**Goal:** A **Subagent session**'s four user-facing gates (`ask`, `confirm`, `password`, **Permission prompt**) become answerable in the **parent Session's** transcript, labelled with the child's `agentName`, instead of hiding inside the child's own sheet.

**Architecture:** Purely a **Client** (React/TypeScript) change — **no Rust changes**. The Supervisor already re-emits a child's `interactive-request` / `permission-request` verbatim with the CHILD's `sessionId` (`src-tauri/src/agent/session/router.rs:78-92`), and `respondInteractiveRequest` / `respond_permission` already route by that id. So the work is choosing *where* each gate renders: a new `useChildGates(parentSessionId)` derivation feeds exactly two mutually-exclusive render sites — inline in the parent's transcript when the parent is the active session, otherwise the always-mounted `SubagentModals` overlay.

**Tech Stack:** React 19 + TypeScript, Zustand 5 (`useSubagents` / `useInteractive` / `usePermissions` / `useSessions`), Vitest + @testing-library/react (`pnpm test`), `pnpm build` for the type-check.

**Validation for every task** (repo root, per `AGENTS.md`):
- `pnpm test` — unit tests
- `pnpm build` — `tsc && vite build` (the type-check)

No `src-tauri/` commands are needed: this plan changes no Rust.

---

## Why the design is what it is (read this before any task)

A child's `ask` and **Permission prompt** render today ONLY in `SubagentTranscript` (`src/components/SubagentTranscript.tsx:152-165`), reachable only by opening the child's sheet. Interactive gates carry **no deadline by design** — a prompt ends when the person answers or the session is cancelled, never when a clock runs out (`src-tauri/src/agent/interactive/mod.rs`, the request-flow doc). But the subagent drive races a `settle_timeout` of **30 minutes** (`DEFAULT_SUBAGENT_SETTLE_TIMEOUT`, `src-tauri/src/agent/worker/manager.rs:30`). An unnoticed child gate therefore strands the parent's turn for half an hour, then resolves `Failed { "timed out" }` — a hung delegation that reads as a child failure. The only cue is a dot whose count is app-wide and parent-blind.

Two invariants the whole plan protects:

1. **ONE render site per gate.** Today this holds by partitioning on *method* (`confirm`/`password` → `SubagentModals` only, `ask`/`permission` → `SubagentTranscript` only). After this plan it holds by partitioning on **whether the gate's parent is the active session**. Every task below keeps the invariant true at its own commit — the overlay gains a method *before* the transcript loses it, and inline gains it *before* the overlay loses it. Never leave a gate with two live sites: two instances of one request mean divergent typed-but-unsubmitted `ask` drafts and an Esc-dismiss that closes only one.

2. **A gate is never rendered NOWHERE.** `ChatStream` renders only `activeSessionId`, so the overlay must keep covering the parent-you-navigated-away-from case. That is already `SubagentModals`' stated reason for existing (`src/components/SubagentModals.tsx:9-16`).

The task order is chosen so invariant 1 and 2 both hold at every commit:

| Task | Move |
|---|---|
| 1 | `useChildGates` derivation (additive, nothing moves) |
| 2 | overlay takes ALL FOUR kinds (still the only site for child `ask`/`permission`) |
| 3 | inline takes `ask`/`permission` for the ACTIVE parent; overlay gives them up |
| 4 | delete the hidden host + the child transcript's gate renders |
| 5 | dot + `sessionStatusOf` + the attention alert re-key |
| 6 | ADR 0040 amendment + `CONTEXT.md` glossary |

---

### Task 1: The `useChildGates` derivation

**Context:**
Three surfaces will need the same fact — "which gates are the children of THIS session holding on the user, and who is holding them". If each restates it, they drift (the repo's standing rule: one derivation, many consumers — see `src/hooks/useSessionStatus.ts:18-28` and `useMainOpenTodoCount`). This task adds the derivation only; nothing renders from it yet, so it is a pure addition with zero behaviour change.

**Files:**
- Create: `src/hooks/useChildGates.ts`
- Test: `src/hooks/useChildGates.test.ts`

**What to implement:**

`src/hooks/useChildGates.ts`:

```ts
/** The four gates a Subagent session can hold on the user. */
export type ChildGateKind = "ask" | "confirm" | "password" | "permission";

/** One pending gate held by a child of one parent Session. */
export interface ChildGate {
  /** The SUBAGENT session id — the key every respond command routes on. */
  childSessionId: string;
  /** `SubagentEntry.parentSessionId` — how the overlay excludes the active
   * parent's gates (Task 3) and how the dot attributes a gate (Task 5). */
  parentSessionId: string;
  /** `SubagentEntry.agentName` — the attribution chip's text. */
  agentName: string;
  /** The interactive `requestId`, or the permission prompt's `requestId`. */
  requestId: string;
  kind: ChildGateKind;
  /** `InteractiveRequestData.source` (e.g. `"subagent:reviewer"`); absent for `permission`. */
  source?: string;
  /** `InteractiveRequestData.params`; absent for `permission`. */
  params?: Record<string, unknown>;
  /** `PermissionPromptData.toolTitle`; present only for `permission`. */
  toolTitle?: string;
  /** `PermissionPromptData.options`; present only for `permission`. */
  options?: PermissionOption[];
  /** `SubagentEntry.startedAt` — the sort key for the child's arrival order. */
  childStartedAt: number;
}

export function useChildGates(parentSessionId: string | null): ChildGate[]
```

Derivation rules, all load-bearing:

- **Export the pure core too.** `SubagentModals` (Task 2) needs "every child, regardless of parent", which a single-parent hook cannot express, and a component must not read three stores ad hoc. So export BOTH from this module:
  ```ts
  /** `parentSessionId === null` → EVERY child's gates (the overlay's need). */
  export function childGatesOf(
    entries: Record<string, SubagentEntry>,
    requests: Record<string, InteractiveRequestData[]>,
    prompts: Record<string, PermissionPromptData[]>,
    parentSessionId: string | null,
  ): ChildGate[]
  ```
  and make `useChildGates` the thin wrapper that reads the three stores and calls it. No React in the pure core (it is what the tests drive directly).
- **Parent filter comes first.** Read `useSubagents((s) => s.entries)` — the store's own object reference, stable — and keep only entries whose `parentSessionId === parentSessionId` (when it is non-null). A gate whose child has **no** `SubagentEntry` is dropped — `parentSessionId` is held ONLY by `useSubagents` (`src/hooks/useAttentionAlert.ts:239-241` says so outright), so an evicted entry (`MAX_CLOSED_ENTRIES`, `src/store/subagents.ts:13`) means an unknown parent and the gate has no home. Fail-quiet is safe: `App.tsx`'s `session-closed` handler already calls `dismissSession` / `dismissSessionPrompts`, and the Supervisor's `cleanup_pending_modals` emits `interactive-request-close` regardless.
- **Return `[]` for a `null` parent id in the HOOK only** (no active session). The pure core's `null` means "all children" — that asymmetry is deliberate and must be commented in both signatures, because the same literal means two different things.
- **Selectors return the stores' own slices — never a `?? {}` fallback inside a selector.** That mints a fresh object per call and re-renders forever; the hazard is documented at `src/hooks/useSessionStatus.ts:68-70` and `src/hooks/useAttentionAlert.ts:87-90`. Defaults live OUTSIDE the selector (`?? []` on the read, not in the selector).
- **Order:** by `(childStartedAt, then the store's own per-session array index)` — child arrival, then request arrival. `useSubagents.entries` insertion order is arrival order and `useInteractive.requests[id]` is appended in arrival order (`addRequest` filters-then-appends, `src/store/interactive.ts:103-111`), so a stable sort on those two keys is enough.
- **Both stores contribute:** `ask`/`confirm`/`password` from `useInteractive.requests[childSessionId]`, then `permission` from `usePermissions.prompts[childSessionId]`. Keep the `method` filter explicit (`"ask" | "confirm" | "password"`) even though the union has only these three — same reason as `useAttentionAlert.ts:124-127`: a future method that is not a pause on the user must not start surfacing itself.

**What NOT to change:** no component, no store, no other hook. Do not add a `useChildGates` variant that takes a list of parents — the only caller pattern is one parent at a time.

**Steps:**
- [ ] Write `src/hooks/useChildGates.test.ts` covering: (1) `[]` with no entries; (2) `[]` when `parentSessionId` is `null`; (3) a child's pending `ask` surfaces with `kind: "ask"`, `agentName`, `childSessionId`; (4) a `permission` prompt surfaces with `kind: "permission"` + `toolTitle`; (5) `confirm` and `password` both surface; (6) **a child of a DIFFERENT parent is not returned** (this is the bug the dot currently has); (7) a gate whose child has no entry is dropped; (8) ordering is child-arrival-then-request-arrival with two children and two asks.
- [ ] Run `pnpm test src/hooks/useChildGates.test.ts`
  - Did it fail with "Failed to resolve import ./useChildGates"? If it passed, the test file is not being reached — stop and fix that first.
- [ ] Implement `useChildGates` in `src/hooks/useChildGates.ts`.
- [ ] Run `pnpm test src/hooks/useChildGates.test.ts`
  - All green? If not, fix and re-run before continuing.
- [ ] Run `pnpm test` — the whole suite must stay green (nothing existing should move).
- [ ] Run `pnpm build` — must succeed (this is the type-check for the new export).
- [ ] Commit: `feat(client): derive a session's child gates in one place`

**Acceptance criteria:**
- [ ] `useChildGates(parent)` returns only gates of children whose `parentSessionId === parent`.
- [ ] A gate whose child has no `SubagentEntry` is not returned.
- [ ] No selector in the new hook constructs an object or a `?? {}` fallback.
- [ ] No existing behaviour changed (`pnpm test` green with no existing test edited).

---

### Task 2: The overlay becomes the one site for all four gate kinds

**Context:**
`SubagentModals` renders only a child's `confirm`/`password` (`src/components/SubagentModals.tsx:38-44`); a child's `ask` and Permission prompt render in `SubagentTranscript` instead. Before anything can move INTO the parent's transcript, the overlay must first be able to hold all four kinds — that way the next task can hand `ask`/`permission` from transcript → overlay → inline without ever leaving one of them unrendered. This is the task that makes "a child's gate is answerable without opening the child's sheet" true for all four kinds; the inline half is Task 3's refinement of *where* the user sees it.

**Files:**
- Modify: `src/components/SubagentModals.tsx`
- Modify: `src/components/SidePane.tsx` (doc comment only, `:358-361` and `:77-80`)
- Test: `src/components/SubagentModals.test.tsx`

**What to implement:**

In `src/components/SubagentModals.tsx`:
- Replace the hand-rolled `confirmRefs` / `passwordRefs` loops (`:38-50`) with the pure `childGatesOf(entries, requests, prompts, null)` from Task 1 — `null` meaning "every child", which is what the overlay must cover. Do NOT call `useChildGates(activeSessionId)` here: the overlay is the home for children whose parent is NOT active, so filtering to one parent would drop them (Task 3 narrows this to "not the active parent", never to "the active parent").
- Render, in this order: `SudoConfirmModal` for `kind: "confirm"`, `SudoPasswordModal` for `kind: "password"` (unchanged), plus `AskQuestionCard` for `kind: "ask"` and `PermissionPrompt` for `kind: "permission"` — each passed `sessionId={gate.childSessionId}` and `requestId={gate.requestId}`.
- Wrap the `ask`/`permission` renders in the same `fixed` overlay container style the sudo modals rely on (they are `fixed` so a collapsed `SidePane` — `SIDE_PANE_RAIL` sliver + `overflow: hidden` — never clips them; documented at `src/components/SidePane.tsx:54-58`). `AskQuestionCard` and `PermissionPrompt` are NOT `fixed` themselves (`src/components/AskQuestionCard.tsx`, `src/components/PermissionPrompt.tsx` are plain inline cards), so they need a `fixed` wrapper here: a right-side panel with `overflow-y-auto`, `z-50`, a max height, and the same visual family as the subagent sheet. Give it `role="region"` + `aria-label` naming the child.
- Prepend the attribution chip `↳ <agentName>` to each lifted card (a small muted row above the card, using the existing text scale utilities `text-ui-xs text-foreground-subtle`). The chip lives on the wrapper, NOT inside the card components — those stay parent/child-agnostic and are reused unchanged.
- `key` each render on `gate.childSessionId + ":" + gate.requestId` (a child's `requestId` is the model's tool-call id, which some OpenAI-compatible gateways reuse across responses — `src/lib/attention.ts:38-43` documents that a gate id is NOT globally unique, so a bare `requestId` key can collide across two children).

In `src/components/SidePane.tsx`: update the two doc comments that say `SubagentModals` is the sudo-modals-only site (`:77-80`, `:358-361`) to say it is the overlay host for **all four gate kinds of every child**. Do not hint at Task 3's narrowing — a comment describing a future commit is a lie about this one; Task 3 rewrites it when the narrowing actually lands.

**What NOT to change:** `SubagentTranscript` still renders `ask`/`permission` after this commit — **no, it must not.** To preserve the one-site invariant, this commit REMOVES the `ask` (`:159-165`) and `permission` (`:151-158`) renders from `src/components/SubagentTranscript.tsx` in the same commit that adds them to the overlay. Also update `SubagentTranscript`'s doc comment (`:37-39`, "The prompt cards render HERE") to say the transcript renders no gates and that `SubagentModals` is the only site.

**Steps:**
- [ ] In `src/components/SubagentModals.test.tsx`, write failing tests: (1) a child's pending `ask` renders an `AskQuestionCard` in the overlay, carrying the child's `agentName`; (2) a child's pending permission prompt renders a `PermissionPrompt`; (3) the existing `confirm`/`password` tests stay green; (4) two children with the same `requestId` render two distinct cards (the key-collision regression); (5) nothing renders with no entries.
- [ ] In `src/components/SubagentTranscript.test.tsx`, DELETE the two now-obsolete tests `renders an `ask` request for the subagent session id as an AskQuestionCard` (`:105`) and `renders a permission prompt for the subagent session` (`:128`), and ADD one test asserting the transcript renders NEITHER an ask card nor a permission prompt for a child that holds them (the negative pin).
- [ ] Run `pnpm test src/components/SubagentModals.test.tsx src/components/SubagentTranscript.test.tsx`
  - Did the new overlay tests fail (missing render) and the transcript negative test fail (still renders)? If the negative test passed already, the removal happened before the test was written — reorder.
- [ ] Export the pure `childGatesOf(...)` core from `src/hooks/useChildGates.ts` (Task 1 keeps `useChildGates` as its wrapper).
- [ ] Implement the `SubagentModals` changes (all four kinds, `fixed` wrapper, chip, composite key).
- [ ] Remove the `ask`/`permission` renders and the now-unused imports (`AskQuestionCard`, `PermissionPrompt`) and the now-unused `askRequests`/`promptList` locals from `src/components/SubagentTranscript.tsx`; rewrite its doc comment.
- [ ] Update the `SidePane` doc comments.
- [ ] Run `pnpm test src/components/SubagentModals.test.tsx src/components/SubagentTranscript.test.tsx` — green.
- [ ] Run `pnpm test` — the whole suite green (fix anything that asserted the old placement).
- [ ] Run `pnpm build` — succeeds (unused-import removals included; `tsc` will catch a leftover).
- [ ] Commit: `feat(client): render every Subagent gate in one overlay host`

**Acceptance criteria:**
- [ ] A child's `ask` is answerable with the child's sheet CLOSED (the stranding is gone for all four kinds).
- [ ] `SubagentTranscript` renders no gate of any kind.
- [ ] Exactly one component in the app renders a child's `ask` (`SubagentModals`).
- [ ] A collapsed `SidePane` still shows a pending child `ask` (the `fixed` wrapper escapes the clip).

---

### Task 3: A gate whose parent is the active session renders inline in the parent's transcript

**Context:**
Task 2 put every child gate in a right-side overlay. That answers the stranding bug, but the user still has to deal with a panel rather than seeing the question in the conversation they are already reading. This task makes the common case — the parent is on screen — render inline at the bottom of the parent's transcript, which is the stated goal ("answer it where I'm already looking"). The overlay keeps the case `ChatStream` structurally cannot render: `ChatStream` reads only `activeSessionId` (`src/components/ChatStream.tsx:108-113`), so a child of a session you navigated away from has no transcript to render into. The partition key becomes **is this gate's parent the active session**, and it stays exactly one site.

This mirrors the shape `ChatStream` already uses for a child's `ask`: derive a `Set`, split, give each half exactly one render site (`src/components/ChatStream.tsx:118-134`, anchored vs stacked).

**Files:**
- Modify: `src/hooks/useChildGates.ts` (comment-only, if the `null` asymmetry needs restating — no new API; `useChildGates(activeSessionId)` is the call)
- Modify: `src/components/ChatStream.tsx`
- Modify: `src/components/chat/MessageList.tsx`
- Modify: `src/components/SubagentModals.tsx` (narrow to parents that are NOT active)
- Modify: `src/components/SidePane.tsx` (doc comment)
- Test: `src/components/ChatStream.test.tsx`, `src/components/SubagentModals.test.tsx`, `src/hooks/useChildGates.test.ts`, and `src/components/chat/MessageList.gap.test.tsx` (it constructs `MessageList` props directly — a new REQUIRED prop breaks its type-check)

**What to implement:**

1. `src/components/ChatStream.tsx`: call `useChildGates(activeSessionId)` and pass the result down as a new `childGates` prop to `MessageList` (the render site is `:1285-1298`). **Placement is load-bearing:** the call must sit BEFORE the `if (!activeSessionId)` early return at `:814`, unconditionally — the same trap `usePendingSubagentRequests` documents at `:288-294` ("this hook contains `useSyncExternalStore` (via zustand), so calling it only on the full-frame path would change the hook count when the active session appears/disappears and crash React → white page"). `activeSessionId` is `string | null` and the hook's `null` case returns `[]`.

2. `src/components/chat/MessageList.tsx`: accept `childGates: ChildGate[]`. **Critical:** `MessageList` is props-only BY DESIGN and MUST NOT read the stores (its doc says so at `:42-44`) — do not add a `useChildGates` call there. Render, AFTER the existing `prompts.map` (`:151-157`) and `stackedAskRequests.map` (`:160-165`) blocks and BEFORE `FileSummaryCard`:
   - `AskQuestionCard` for `kind === "ask"`, `PermissionPrompt` for `kind === "permission"`, each with `sessionId={gate.childSessionId}` / `requestId={gate.requestId}`, each wrapped with the `↳ <agentName>` chip.
   - Skip `confirm`/`password` — those stay in the overlay (they are modal by nature and `SudoConfirmModal`/`SudoPasswordModal` are Radix `Dialog`s; inlining a `Dialog` into a transcript is not the change we signed up for). Document that in the component doc so nobody "completes" it later.
   - `key` on `gate.childSessionId + ":" + gate.requestId` (same non-unique-id reason as Task 2).
   - **Rhythm check:** `MessageList.gap.test.tsx` builds props via `createElement` in TWO places (`:44-58` and again from `:68`) — a new REQUIRED prop breaks `tsc` there, so add `childGates: []` to both. Those tests also read `scroll.children` positionally, so a non-empty `childGates` in any of them would shift the rows they index; keep them `[]` and pin the child-gate rendering in `ChatStream.test.tsx` instead.
   - Note the existing hint gate (`:295-303`, "Send a prompt to start") is driven by `hasPendingRequest`; Task 5 makes that count child gates, and until then a child-only gate on an empty transcript could show the hint beside the card. Fix it HERE by OR-ing `childGates.length > 0` into the `hasPendingRequest` value `ChatStream` passes down (`:1019-1026`), so this commit is coherent on its own.

3. `src/components/SubagentModals.tsx`: narrow to gates whose `parentSessionId !== activeSessionId`. Read `activeSessionId` from `useSessions` (already imported in this file's test fixture pattern; add the import). Rewrite the component doc: the overlay owns (a) `confirm`/`password` for EVERY child, and (b) `ask`/`permission` for a child whose parent is NOT the active session — because `ChatStream` renders only the active session, and an unrendered gate strands the child until its 30-minute `settle_timeout` (`src-tauri/src/agent/worker/manager.rs:30`).

4. Update `src/components/SidePane.tsx` doc comments to the narrowed truth.

**What NOT to change:** `useChildGates`' parent filter semantics; the sudo modal components; the anchored/stacked split for the parent's OWN asks (`:118-134`) — a child ask's `source` is `"subagent:<name>"` so it can never anchor, and that logic must stay untouched.

**Steps:**
- [ ] Write failing tests:
  - `src/components/ChatStream.test.tsx`: with `activeSessionId = "main1"`, a `useSubagents` entry `{ sessionId: "sub1", parentSessionId: "main1", agentName: "reviewer", … }` and a pending `ask` on `"sub1"` → an `AskQuestionCard` renders in the transcript AND the child's `agentName` appears (the chip). Assert the card answers against `"sub1"` (spy `respondInteractiveRequest` — the file already mocks `../lib/tauri`).
  - `src/components/SubagentModals.test.tsx`: when `activeSessionId === "main1"` and the child's parent is `"main1"`, the overlay renders NO ask card (it moved inline); when `activeSessionId === "other"`, the overlay DOES render it. Plus: a child's `confirm` still renders in the overlay even when its parent IS active.
  - A **no-double-render** test — the invariant pin: count rendered ask cards for one child gate in each of the two states and assert exactly 1 in both.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx src/components/SubagentModals.test.tsx`
  - Did they fail for the expected reasons (inline missing; overlay still renders when it should not; double-render count 2)? If the double-render test passes already, it is not counting what it claims — inspect before trusting it.
- [ ] Implement 1–4 above.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx src/components/SubagentModals.test.tsx` — green.
- [ ] Run `pnpm test` — green (fix any test asserting the overlay shows an active parent's child ask).
- [ ] Run `pnpm build` — succeeds.
- [ ] Manual check while the app is running (`pnpm tauri dev` if available): ask a subagent something and confirm the card lands in the parent's transcript below its own cards, and that switching to another Session moves it into the overlay rather than duplicating or dropping it. If you cannot run the app, say so explicitly rather than claiming it.
- [ ] Commit: `feat(client): answer a Subagent's gates in its parent's transcript`

**Acceptance criteria:**
- [ ] With the parent active, its child's `ask`/`permission` renders inline, below the parent's own cards, labelled with the child's name.
- [ ] With the parent inactive, the same gate renders in the overlay — never nowhere.
- [ ] Exactly one instance of any child gate is rendered in every state.
- [ ] `MessageList` still reads no stores.

---

### Task 4: Retire the always-mounted hidden host

**Context:**
`SubagentDetailHost` renders two things: the visible sheet for the selected child, and a **hidden** `SubagentTranscript` (`hidden` attribute = `display: none`) for every other one. The hidden host exists for exactly one reason — keeping prompt cards mounted so an unrendered request never hangs (`src/components/SubagentDetailHost.tsx:14-25`). After Task 2 no gate lives in the transcript at all, so the hidden host is dead weight whose doc has become a lie, and it carries two documented oddities nobody wants: local state resets when a child moves between the sheet and the hidden host (`:27-33`), and the sheet's Esc handling needed a `stopPropagation` dance because a nested `AskQuestionCard` lived under it (`:41-58`). Both disappear.

**Files:**
- Modify: `src/components/SubagentDetailHost.tsx`
- Modify: `src/components/SubagentDetailHost.test.tsx`
- Modify: `src/App.tsx` (doc comment at `:310-314`)

**What to implement:**
- Delete the hidden-host block (`SubagentDetailHost.tsx:77-88`) and the `entryList.filter((e) => e.sessionId !== selectedId)` map. `SubagentTranscript` is then rendered EXACTLY ONCE, in the sheet, only while an entry is selected.
- Rewrite the component doc: drop the "exactly once across modal + hidden host" paragraph, the "KNOWN BEHAVIOR (accepted)" state-reset paragraph, and the `AskQuestionCard` half of the Esc analysis. **Keep** the sheet-level Esc reasoning that still applies: `ChatStream` registers a window-level `keydown` that cancels the turn on Escape while `inTurn` (`src/components/ChatStream.tsx:356-364`), and the sheet's React `onKeyDown` + `stopPropagation` is what stops a sheet Esc from cancelling the parent's turn — that reason survives even with no nested cards. Keep the accepted "Esc only closes the modal when focus is inside the sheet" limitation (`:59-62`).
- `src/App.tsx:310-314`: the comment says "the visible modal for the selected subagent + a hidden `SubagentTranscript` for every other one" — rewrite it to describe the sheet only.

**What NOT to change:** the sheet's own markup, the `X` button, `useSubagentSelection`, closing semantics (closing does NOT dismiss the entry), and the modal's `fixed` positioning.

**Steps:**
- [ ] In `src/components/SubagentDetailHost.test.tsx`: delete `renders a HIDDEN SubagentTranscript for every NON-selected entry (the always-mounted host)` (`:186`) and rewrite `closing does NOT dismiss the entry (… the transcript moves to the hidden host in the same render)` (`:164`) to assert only that the entry survives in `useSubagents` and the header disappears. Review `an Escape consumed by a nested AskQuestionCard does NOT close the modal` (`:208`): with no card rendered inside the sheet this test can no longer reach that state — either keep it by mounting a card explicitly through a nested host, or delete it and note in the doc why the interaction is gone. **Verify the sheet-level Esc tests (`:124`, `:142`) still pass unchanged** — that behaviour must not regress.
- [ ] Run `pnpm test src/components/SubagentDetailHost.test.tsx`
  - Fails on the deleted-host expectations? If the Esc-at-window tests already fail, something else changed the sheet — investigate before proceeding.
- [ ] Implement the deletion + the doc rewrites.
- [ ] Run `pnpm test src/components/SubagentDetailHost.test.tsx` — green.
- [ ] Run `pnpm test` — green.
- [ ] Run `pnpm build` — succeeds (watch for a now-unused `entryList`/`useSubagents` import).
- [ ] Commit: `refactor(client): drop the always-mounted hidden subagent host`

**Acceptance criteria:**
- [ ] `SubagentTranscript` is rendered only inside the selected child's sheet.
- [ ] No gate of any kind is rendered by anything other than `MessageList` (active parent) or `SubagentModals` (everything else).
- [ ] Sheet Esc closes the sheet and does NOT cancel the parent's turn.
- [ ] No doc comment references a hidden host or an always-mounted transcript.

---

### Task 5: Make the cues agree — the dot, the row's status, and the alert

**Context:**
Three derivations describe "this session is waiting on you", and all three are wrong for a child's gate:

1. `usePendingSubagentRequests` (`src/hooks/usePendingSubagentRequests.ts`) counts **every** subagent entry app-wide and ignores `parentSessionId` — so a child of Session B lights the dot on Session A. Harmless while it was only a dot; after Task 3 the dot sits beside a transcript that may not contain that card at all. Consumers: `ChatStream`'s `hasPendingRequest` (`src/components/ChatStream.tsx:294,1019-1026`) and `useHasPendingRequest` (`:26-32`, consumed by `SidePane.tsx:246` and `SpacesList.tsx:182`).
2. `sessionStatusOf` (`src/hooks/useSessionStatus.ts:31-45`) derives `waiting` from a session's OWN `prompts`/`requests`. A parent blocked on its child's gate has nothing under its own id, so its row reads **`running`** — it says "working" while it is blocked on the user. Consumers: `useSessionStatus` (one row, `SpacesList.tsx:551`) and `useSessionStatuses` (the collapsed rail, `SpacesList.tsx:149`); `SessionRail` consumes the type only.
3. The **attention alert** ranks subagent ids LAST in `candidateOrder` (`src/hooks/useAttentionAlert.ts:106-116`) and ADR 0040 documents that. Since a child's gate is now visually the parent's card, it should rank at its parent's position.

**Files:**
- Modify: `src/hooks/usePendingSubagentRequests.ts`
- Modify: `src/hooks/useSessionStatus.ts`
- Modify: `src/hooks/useAttentionAlert.ts`
- Modify: `src/components/SpacesList.tsx` (only if the widened `sessionStatusOf` input needs threading)
- Test: `src/hooks/usePendingSubagentRequests.test.ts`, `src/hooks/useSessionStatus.test.ts`, `src/hooks/useAttentionAlert.test.ts`

**What to implement:**

1. **`usePendingSubagentRequests`** → rebuilt on `useChildGates`. It must still return a NUMBER and keep its name (three consumers). Semantics: the count of gates for `activeSessionId`'s children **plus** the gates sitting in the overlay (they are still attention the user owes somewhere — the dot exists to say "you owe something"). Implementation: `useChildGates(activeSessionId).length + childGatesOf(entries, requests, prompts, null).filter(g => parentOf(g) !== activeSessionId).length`, i.e. active-parent gates + everything else. Update the doc comment: it previously justified itself with "a subagent session id is never the ACTIVE session"; the reason now is "a child's gate is the parent's attention to carry".
   - `src/hooks/usePendingSubagentRequests.test.ts` must gain the parent-scoping case the old code lacked: with `activeSessionId = "A"`, a child of `"B"` holding a gate still contributes (overlay), and the count is not parent-blind in a way that misattributes — assert the total is right and, separately, that `useChildGates("A")` excludes it (that pin lives in Task 1's file too).
   - Note the existing test `does NOT count requests for sessions with no subagent entry (the main session)` (`:89`) must stay true.

2. **`sessionStatusOf`** gains one input field:
   ```ts
   export interface SessionStatusInput {
     isLive: boolean;
     inTurn: boolean;
     prompts: PermissionPromptData[];
     requests: InteractiveRequestData[];
     /** Pending gates held by THIS session's CHILDREN — a parent blocked on its
      * child's gate is blocked on the user, so it is `waiting`, not `running`. */
     childGateCount: number;
   }
   ```
   `waiting` becomes `prompts.length > 0 || requests.some(…) || childGateCount > 0`. Update the doc paragraph (`:18-30`) to say so. Thread it in BOTH hooks: `useSessionStatus` computes `useChildGates(sessionId).length`; `useSessionStatuses` must subscribe to `useSubagents.entries` ONCE and derive per id (a hook per row is impossible at a changing list length — that is why the pure function exists, `:65-72`). `SpacesList.tsx:551` and `:149` need no change if the hooks keep their signatures (they should).

3. **The attention alert re-key** in `src/hooks/useAttentionAlert.ts`:
   - Build `waitingIds` keyed by the **PARENT**: for a child session's `ask`/`confirm`/`password` and permission prompts, push the gate id into `waitingIds[entry.parentSessionId]` instead of `waitingIds[childId]`. A child's gates then land in the parent's array, in the parent's `candidateOrder` position, after the parent's own gates (arrival order within the array is preserved because the parent's own gates are pushed first — keep the existing loop order and append child gates after it).
   - **Drop the subagent ids from `candidateOrder`'s tail** (`:106-116`): delete the `for (const id of Object.keys(subagentEntries)) push(id)` loop. This is required, not cosmetic — `attentionCandidates` iterates `candidateOrder` and reads `waitingIds[id]` (`src/lib/attention.ts:160-162`), so a child id absent from `candidateOrder` would never be visited; and R4's evidence rule ends with `!next.candidateOrder.includes(id)` (`src/lib/attention.ts:283-284`), the "a subagent entry that has gone away entirely" arm, which would now fire for EVERY child gate and disarm it immediately.
   - `settledWatch` stays `sessions.map(s => s.sessionId)` (live MAIN sessions) — unchanged, and the `settled` arm's "a subagent finishing is not the user's pause" skip (`src/lib/attention.ts:168`) keeps working for free because child ids are no longer in `candidateOrder`.
   - **Label side effect, and the comment you must write:** `attentionAlertText` does `ctx.parents[trigger.sessionId] ?? trigger.sessionId` (`src/lib/attention.ts:430`). A re-keyed trigger carries the PARENT id, so the `parents` lookup now MISSES and falls through to the id itself — which is already the parent, so the body is still `"Investigate flaky test needs your answer"`. Write a comment at the `parents` construction (`useAttentionAlert.ts:239-245`) saying exactly this, or a future reader will "fix" the now-unused map. Do NOT delete `parents` from `AttentionLabelContext` in this task (its own unit tests at `src/lib/attention.test.ts:1137-1155` still exercise the child-id path; leaving the map correct-but-unused is the smaller change, and the settled-path label for a child id is still harmless).
   - **Tests to change and add** in `src/hooks/useAttentionAlert.test.ts`: the existing `arms for a subagent's gate while the user sits in an unrelated session, naming the PARENT` (`:297`) must STILL PASS with the same expected body — it is the regression pin for the label fall-through. `src/lib/attention.test.ts:172` `carries the SUBAGENT's own id when a subagent holds the gate` asserts the OLD snapshot shape; it lives in the pure module, whose snapshot contract is unchanged (the hook just builds it differently) — leave the pure test alone if it still describes a legal snapshot, and add a hook-level test proving the hook now emits the PARENT key. Add: a child gate and a competing unrelated-session gate, asserting the ranking follows the parent's `candidateOrder` position rather than ranking last.

**What NOT to change:** `src/lib/attention.ts`'s rules (R1–R6) — this is a snapshot-construction change in the hook, and the pure module's contract is unchanged. No Rust, no `attention_arm` protocol change (ADR 0039: Rust is handed a delay and text and learns nothing).

**Steps:**
- [ ] Write the failing tests for all three (dot parent-scoping; `sessionStatusOf` `waiting` via `childGateCount` in both hooks; the hook emitting parent-keyed `waitingIds` with subagent ids absent from `candidateOrder`).
- [ ] Run `pnpm test src/hooks/usePendingSubagentRequests.test.ts src/hooks/useSessionStatus.test.ts src/hooks/useAttentionAlert.test.ts`
  - Did each fail for its own reason? A status test that passes immediately means the hook never wired `childGateCount` — check before continuing.
- [ ] Implement 1, then 2, then 3 (each with its own test-green run).
- [ ] Run `pnpm test` — green. **Expect** `useAttentionAlert.test.ts:297` to be the sensitive one; if its body changed to `"A session needs your answer"`, the `parents` fall-through broke — re-read the label rule above.
- [ ] Run `pnpm build` — succeeds.
- [ ] Commit: `feat(client): a child's gate waits on its parent`

**Acceptance criteria:**
- [ ] A parent whose child holds a gate reads `waiting` in its row pill and its rail mark.
- [ ] The dot's count matches what the user actually owes, and never attributes a child to the wrong parent's transcript.
- [ ] A child gate arms the alert at its parent's rank, and the alert body still names the parent.
- [ ] An armed child-gate countdown is NOT instantly disarmed by R4's "entry gone" arm.

---

### Task 6: Record the decision — amend ADR 0040, update the glossary

**Context:**
Two durable documents now state things that are no longer true. `docs/decisions/0040-one-attention-alert-at-a-time-with-an-oldest-question-first-ladder.md` states that across Sessions rank is `candidateOrder` with subagents LAST, and its Consequences section says a displaced subagent gate is "the accepted price of one alert app-wide" with the in-app affordances carrying it. Task 5 changes the ranking. And `CONTEXT.md`'s *Subagent session* entry says its prompts "go directly to the Client (the Supervisor's relay) without relaying through the main agent" — true, but that sentence is precisely what let the child-sheet placement read as intentional; it needs to say where they render now.

**Files:**
- Modify: `docs/decisions/0040-one-attention-alert-at-a-time-with-an-oldest-question-first-ladder.md`
- Modify: `CONTEXT.md` (the *Subagent session* entry, `:59-60`; consider the *Attention alert* entry, `:148`)

**What to implement:**
- ADR 0040: amend the clause that ranks subagent gates last, and the Consequences paragraph built on it. Record the new rule — **a Subagent session's gate is keyed to its PARENT, so it ranks wherever its parent ranks** — and say why: the gate is answered in the parent's transcript, so an alert that ranked it behind everything would point at a Session the user is not being asked about. Keep the rest of the ladder intact (question-over-finished app-wide; positional rank; oldest-wins within a Session; the announced-pauses-are-a-SET fix). Do NOT supersede 0040 — the ladder itself stands; this is a scoping amendment to its candidate ordering. Follow the ADR format the repo already uses (see any file in `docs/decisions/` for the shape).
- `CONTEXT.md`: extend the *Subagent session* entry with where its gates render (the parent's transcript when the parent is the active Session, otherwise the always-mounted overlay), and keep the "no relaying through the main agent" sentence — it is still the point. Check the *Attention alert* entry (`:148`, which already says "a **Subagent session**'s gate reports its parent") still reads true — it does, and now for a stronger reason.
- Read `docs/decisions/` numbering first: if this decision warrants its own ADR rather than an amendment, the number is the next free one. Prefer the amendment — a decision that revises one clause of an accepted ADR belongs in it.

**Steps:**
- [ ] Read `docs/decisions/0040-*.md` in full and the two `CONTEXT.md` entries.
- [ ] Apply the amendments.
- [ ] Run `pnpm test` and `pnpm build` — unchanged, both green (a docs-only commit; run them to be sure nothing else crept in).
- [ ] `git diff` review: confirm only the two docs changed.
- [ ] Commit: `docs: amend ADR 0040 and the glossary for Subagent gates`

**Acceptance criteria:**
- [ ] No surviving doc says a Subagent session's gate ranks last.
- [ ] `CONTEXT.md` states where a Subagent session's gates are answered.
- [ ] ADR 0040's surviving rules are unchanged.

---

## Out of scope (do not do these)

- **No Rust changes.** The 30-minute `settle_timeout` stays exactly as it is (`src-tauri/src/agent/worker/manager.rs:30`) — this feature removes the *invisibility*, not the no-deadline posture. A gate still ends when the person answers or the session is cancelled, never when a clock runs out.
- **No `ask` in the child tool set changes** — a subagent keeps the parent's tools minus `subagent`/`list_agents` (the three-way rule at `src-tauri/src/agent/worker/manager.rs:896-916`).
- **No inlining of the sudo `Dialog`s** into the transcript (Task 3 keeps them in the overlay).
- **No new Tauri events, commands, or payload fields.** The Supervisor already relays a child's requests verbatim (`src-tauri/src/agent/session/router.rs:78-92`).
- **No rename of `SubagentModals`**, despite the name now covering non-modal cards — renaming churns imports and test filenames for no behaviour. Note it in the component doc instead.
