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
- `pnpm test` — unit tests (`vitest run`; pass a path fragment to scope it, e.g. `pnpm test src/hooks/useChildGates`)
- `pnpm build` — `tsc && vite build` (the type-check)

No `src-tauri/` commands are needed: this plan changes no Rust.

**Baseline at planning time:** `pnpm test` → **1610 passed / 75 files**, all green. A red test anywhere means YOUR change broke it — there is no pre-existing failure to blame.

---

## Why the design is what it is (read this before any task)

A child's `ask` and **Permission prompt** render today ONLY in `SubagentTranscript` (`src/components/SubagentTranscript.tsx:152-165`), reachable only by opening the child's sheet. Interactive gates carry **no deadline by design** — a prompt ends when the person answers or the session is cancelled, never when a clock runs out (`src-tauri/src/agent/interactive/mod.rs`, the request-flow doc). But the subagent drive races a `settle_timeout` of **30 minutes** (`DEFAULT_SUBAGENT_SETTLE_TIMEOUT`, `src-tauri/src/agent/worker/manager.rs:30`). An unnoticed child gate therefore strands the parent's turn for half an hour, then resolves `Failed { "timed out" }` — a hung delegation that reads as a child failure. The cues that do exist point at the wrong surface: a dot that says "you owe something" without saying where, and a **Permission prompt** that has no cue at all (`usePendingSubagentRequests` counts `ask`/`confirm`/`password` requests plus permission prompts, but nothing routes the user to the sheet that holds them).

Two invariants the whole plan protects:

1. **ONE render site per gate.** Today this holds by partitioning on *method* (`confirm`/`password` → `SubagentModals` only, `ask`/`permission` → `SubagentTranscript` only). After this plan it holds by partitioning on **whether the gate's parent is the active session**. Every task keeps this true at its own commit, and it holds only if a move is done as **remove-from-the-old-site-and-add-to-the-new-site in the SAME commit** — never "add first, delete next commit". Never leave a gate with two live sites: two instances of one request mean divergent typed-but-unsubmitted `ask` drafts and an Esc-dismiss that closes only one.

2. **A gate is never rendered NOWHERE.** `ChatStream` renders only `activeSessionId`, so the overlay must keep covering the parent-you-navigated-away-from case. That is already `SubagentModals`' stated reason for existing (`src/components/SubagentModals.tsx:9-16`). **This invariant is currently FALSE and Task 2 fixes it:** `SidePane` and `ChatStream` are both inside the `view === "settings"` else-branch (`src/App.tsx:296-315`), so with the Settings view open a child's gate renders nowhere at all today — the hidden host had the same hole. Hence the overlay host moves to the `App` root, OUTSIDE that conditional. Accepted residual exceptions, both documented in code: (a) a gate whose child has no `SubagentEntry` (fail-quiet — the Supervisor's `cleanup_pending_modals` closes it anyway); (b) while a Radix sudo `Dialog` is open, Radix's `hideOthers` + outside-pointer-event lock makes the overlay region `aria-hidden` and inert — harmless, because that modal IS the prompt the user is looking at and the gate underneath stays pending.

   **One move per gate, in ONE commit.** Invariant 1 is preserved by REMOVING a gate's render from the old site in the same commit that adds it to the new one. Do NOT stage it as "add to the new site, remove in the next commit" — that ships two live instances of one request, with divergent typed-but-unsubmitted `ask` drafts and an Esc-dismiss that closes only one.

The task order is chosen so invariant 1 and 2 both hold at every commit:

| Task | Move |
|---|---|
| 1 | `useChildGates` derivation (additive, nothing moves) |
| 2 | `ask`/`permission` move transcript → overlay (all four kinds now in the overlay, which moves to the `App` root — closing the settings-view hole); one commit per gate, no overlap |
| 3 | `ask`/`permission` for the ACTIVE parent move overlay → inline; overlay keeps the non-active parents and all sudo modals |
| 4 | delete the hidden host (dead since Task 2) |
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
  /** `parentSessionId === null` → EVERY child's gates (the overlay's need).
   * NOT the same as `useChildGates(null)`, which returns `[]`. */
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

- **Export `childGateKey` — mandatory, not optional.** `export const childGateKey = (g: ChildGate): string => \`${g.childSessionId}:${g.requestId}\``. Tasks 2, 3 and 5 all need this exact string (React list keys; the attention snapshot's `gateId`). If each site hand-rolls the concatenation, the two meanings silently decouple and Task 5's composite-id fix stops working. Import it everywhere.
- **`PermissionOption` comes from `src/lib/tauri.ts:103`** (re-exported by `src/store/permissions.ts`'s own import) — import the type from `../lib/tauri`, matching how `store/permissions.ts` does it.

**What NOT to change:** no component, no store, no other hook. Do not add a `useChildGates` variant that takes a list of parents — the only caller pattern is one parent at a time.

**Steps:**
- [ ] Write `src/hooks/useChildGates.test.ts` covering, **against the pure `childGatesOf`** (which the tests drive directly): (1) `[]` with no entries; (2) a child's pending `ask` surfaces with `kind: "ask"`, `agentName`, `childSessionId`, `parentSessionId`; (3) a `permission` prompt surfaces with `kind: "permission"` + `toolTitle`; (4) `confirm` and `password` both surface; (5) **a child of a DIFFERENT parent is not returned** when a parent id is passed (this is the scoping the inline card needs — the dot deliberately stays app-wide); (6) **`parentSessionId: null` returns EVERY child's gates** — the overlay's need, and the exact opposite of the hook's `null` behaviour; (7) a gate whose child has no entry is dropped; (8) ordering is child-arrival-then-request-arrival with two children and two asks. Then, against `useChildGates`: (9) `renderHook` with `parentSessionId: null` returns `[]` — labelled in the test name as THE HOOK's rule, so nobody "fixes" the pure core to match.
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
- Modify: `src/App.tsx` (move the `<SubagentModals />` mount from `SidePane` to the `App` root, OUTSIDE the `view === "settings"` conditional)
- Modify: `src/components/SidePane.tsx` (drop the mount + its two doc comments, `:77-80` and `:358-361`)
- Test: `src/components/SubagentModals.test.tsx`, `src/App.test.tsx`
- Test (MUST move with this commit — both currently assert through the OLD sites and go red otherwise):
  - `src/components/SidePane.test.tsx` — `collapses the frame to the sliver (a pending modal stays mounted) and re-opens` (`:522-550`) renders a bare `<SidePane />` and asserts `Sudo password required` is in the document. With the mount moved out, that assertion no longer belongs to `SidePane`. Rewrite: keep the collapse mechanics assertion (frame width `320px` → `SIDE_PANE_RAIL`, the `overflow-hidden` class) in `SidePane.test.tsx`, and MOVE the pending-modal-still-mounted assertion to `src/App.test.tsx` (render `App`, collapse the pane, assert the card survives) — the guarantee it pins is now an `App`-root guarantee.
  - `src/components/SubagentDetailHost.test.tsx` — `an Escape consumed by a nested AskQuestionCard does NOT close the modal…` (`:208`) seeds `useInteractive.addRequest("sub1", …, source: "main")` and expects the card to render THROUGH the transcript. Task 2 removes that render, so this test breaks HERE, not in Task 4. Its subject no longer exists (no card ever renders in the sheet), so DELETE it in this commit and leave a one-line note in `SubagentDetailHost`'s Esc paragraph saying the sheet no longer hosts prompt cards. (Task 4 still verifies the sheet-level Esc tests at `:124`/`:142` are untouched.)

**What to implement:**

In `src/components/SubagentModals.tsx`:
- Replace the hand-rolled `confirmRefs` / `passwordRefs` loops (`:38-50`) with the pure `childGatesOf(entries, requests, prompts, null)` from Task 1 — `null` meaning "every child", which is what the overlay must cover. Do NOT call `useChildGates(activeSessionId)` here: the overlay is the home for children whose parent is NOT active, so filtering to one parent would drop them (Task 3 narrows this to "not the active parent", never to "the active parent").
- **Perf note, accepted deliberately.** This component currently uses `useShallow` to build a per-entry map precisely to avoid re-rendering on other sessions' request churn (`:23-38`). Reading the whole `requests`/`prompts`/`entries` maps — which `childGatesOf` needs — re-introduces "re-render on any session's gate churn". That is fine here (the component renders a handful of cards, and the whole point is that it must react to any child's gate), but DO keep the three selectors themselves returning the stores' own references and do all assembling in the component body — the `?? {}`-inside-a-selector hazard is still an infinite loop, not just a wasted render. Leave a comment saying the whole-map read is intentional.
- Render, in this order: `SudoConfirmModal` for `kind: "confirm"`, `SudoPasswordModal` for `kind: "password"` (unchanged), plus `AskQuestionCard` for `kind: "ask"` and `PermissionPrompt` for `kind: "permission"` — each passed `sessionId={gate.childSessionId}` and `requestId={gate.requestId}`.
- Wrap the `ask`/`permission` renders in a `fixed` container so a collapsed `SidePane` (`SIDE_PANE_RAIL` sliver + `overflow: hidden`) can never clip them — the reason the sudo modals are `fixed` (`src/components/SidePane.tsx:54-58`). `AskQuestionCard` and `PermissionPrompt` are plain inline cards (`src/components/AskQuestionCard.tsx`, `src/components/PermissionPrompt.tsx`), so the wrapper is a right-side panel with `overflow-y-auto` and a max height, plus `role="region"` + `aria-label` naming the child. Three constraints on it, all verified against the code:
  - **Mount the host at the `App` root, not inside `SidePane`.** `SidePane` sits inside the `view === "settings"` ternary's else-branch (`src/App.tsx:296-315`), so a host mounted there renders NOTHING while the Settings view is open — that is today's hole (invariant 2). Move `<SubagentModals />` from `src/components/SidePane.tsx:362` to a position in `App.tsx` that is a SIBLING OF THE WHOLE TERNARY inside the `data-testid="content-row"` div (i.e. after the `{view === "settings" ? … : …}` expression, not inside its else-branch — `SubagentDetailHost` itself is inside the else-branch, so "next to the host" would re-create the hole). A `fixed` overlay does not affect the flex row's layout. Keep the component's name (renaming churns imports and the test filename for no behaviour; note it in the doc).
  - **Stack deliberately.** `DialogContent` is `fixed … z-50` and portals to `document.body` (`src/components/ui/dialog.tsx:34,63`), and Radix calls `hideOthers` + `disableOutsidePointerEvents` while a dialog is open — so this wrapper always paints UNDER an open sudo modal and is `aria-hidden`/pointer-inert while one is open (accepted: that modal IS the prompt in front of the user; the gate underneath stays pending). `SubagentDetailHost`'s sheet is ALSO `z-50` (`src/components/SubagentDetailHost.tsx:97`), so use `z-40` here: below the transcript sheet (opening a child's transcript must not hide the question you need to answer) and below the dialogs. Do NOT use `z-50` — it leaves the tie to resolve on DOM order alone.
  - **Escape must not cancel the parent's turn.** `ChatStream` registers a window-level `keydown` that sends cancel while `inTurn` (`src/components/ChatStream.tsx:356-365`); `AskQuestionCard` stops propagation only when focus is inside ITS OWN root (`src/components/AskQuestionCard.tsx:221-232`), and `PermissionPrompt` has no Esc handler at all. So an Esc landing on the wrapper/scroll container or on a `PermissionPrompt` button reaches the window handler and kills the parent's turn. Add an `onKeyDown` on the wrapper that `stopPropagation()`s `Escape` with no answering action (the region is not dismissible), and pin it with a test. Two facts make this safe rather than over-broad:
  - It does NOT break the cards' own Esc. React runs the innermost handler first and its `stopPropagation` reaches `nativeEvent.stopPropagation()`, so a card that handles Esc itself (`AskQuestionCard.tsx:221-232`) still runs its own dismiss; and a child ask is never anchored (`anchored` requires `source === "main"`, `AskQuestionCard.tsx:100-109`) so it AUTO-FOCUSES (`:135-141`) — the shortcuts work without a click.
  - **Render the sudo modals as SIBLINGS of the wrapper, not inside it.** Radix `Dialog` portals to `document.body` but React events still bubble through the REACT tree, so a `Dialog` rendered inside the wrapper would have its Esc swallowed by the wrapper — silently changing today's Esc-in-sudo-modal behaviour. Keep the existing `SudoConfirmModal`/`SudoPasswordModal` renders outside the new div.
- **Other z-index users, for the record** (this wrapper is `z-40`, so all of these paint above it, which is intended): `alert-dialog.tsx:30,48` (`DeleteSessionDialog`, `z-50` — the same Radix `hideOthers`/inert consequence as the sudo dialogs), `tooltip.tsx:41` (`z-50`), `dropdown-menu.tsx:45` and `select.tsx:106` (`z-[60]`). No ancestor of the `content-row` div carries `transform`/`filter`/`contain`/`isolate`, so `fixed` stays viewport-relative there and escapes both the pane clip and the row.
- **Accepted geometry:** `SubagentDetailHost`'s sheet is `fixed top-0 right-0 z-50 h-full w-[480px]` (`:97`), so a right-side `z-40` panel sits UNDER it — opening a child's transcript covers the overlay's cards. Accepted because after Task 2 the card you answer for an ACTIVE parent is inline in the transcript, not in this panel; the panel serves parents you are NOT looking at. State this in the wrapper's doc comment rather than offsetting the panel.
- Prepend the attribution chip `↳ <agentName>` to each lifted card (a small muted row above the card, using the existing text scale utilities `text-ui-xs text-foreground-subtle`). The chip lives on the wrapper, NOT inside the card components — those stay parent/child-agnostic and are reused unchanged.
- `key` every render on `childGateKey(gate)` (Task 1's helper — never hand-roll the concatenation). A child's `requestId` is the model's tool-call id, which some OpenAI-compatible gateways reuse per response (`src/lib/attention.ts:38-43`), so a bare `requestId` key can collide across two children.

In `src/components/SidePane.tsx`: update the two doc comments that say `SubagentModals` is the sudo-modals-only site (`:77-80`, `:358-361`) to say it is the overlay host for **all four gate kinds of every child**. Do not hint at Task 3's narrowing — a comment describing a future commit is a lie about this one; Task 3 rewrites it when the narrowing actually lands.

**What NOT to change:** to preserve the one-site invariant, this commit REMOVES the `ask` (`:159-165`) and `permission` (`:151-158`) renders from `src/components/SubagentTranscript.tsx` in the SAME commit that adds them to the overlay — never a staged overlap, never a gap. Also update `SubagentTranscript`'s doc comment (`:42-44`, "The prompt cards render HERE (the `SidePane` is the ONLY render site…)") to say the transcript renders no gates and that `SubagentModals` is the only site. **`tsc` has `noUnusedLocals: true` (`tsconfig.json:22`)**, so removing the two render blocks means also removing the locals `requests` (`:63`), `prompts` (`:64`), `requestList` (`:70`), `promptList` (`:71`), `askRequests` (`:75`) — verified: `requestList` feeds only `askRequests` and `promptList` feeds only the permission map, so all five die together — plus the imports `PermissionPrompt` (`:12`) and `AskQuestionCard` (`:13`). Leave `messages` (`:65`) and `parentMessages` (`:69`) alone; the stream and the progress fallback still use them. Expect the build to name each one. **Do NOT extend the fix to the ACTIVE session's own cards:** `ChatStream`/`MessageList` are inside the same settings ternary, so a main session's `ask` has the same settings-view hole — pre-existing, out of scope here, and "fixing" it means moving `ChatStream` too. After this task, child gates are answerable in the Settings view and main-session gates are not; record that asymmetry in the wrapper's doc comment so it reads as a decision, not an oversight.

**Steps:**
- [ ] In `src/components/SubagentModals.test.tsx`, write failing tests: (1) a child's pending `ask` renders an `AskQuestionCard` in the overlay, carrying the child's `agentName`; (2) a child's pending permission prompt renders a `PermissionPrompt`; (3) the existing `confirm`/`password` tests stay green; (4) two children with the same `requestId` render two distinct cards (the key-collision regression); (5) nothing renders with no entries; (6) an `Escape` dispatched on the wrapper (focus NOT inside a card) does not reach the window (the turn-cancel regression) — mount with a window listener spy the way `ChatStream.test.tsx` does for its Esc cases.
- [ ] In `src/components/SubagentTranscript.test.tsx`, DELETE the two now-obsolete tests `renders an `ask` request for the subagent session id as an AskQuestionCard` (`:105`) and `renders a permission prompt for the subagent session` (`:128`), and ADD one test asserting the transcript renders NEITHER an ask card nor a permission prompt for a child that holds them (the negative pin).
- [ ] Run `pnpm test src/components/SubagentModals.test.tsx src/components/SubagentTranscript.test.tsx`
  - Did the new overlay tests fail (missing render) and the transcript negative test fail (still renders)? If the negative test passed already, the removal happened before the test was written — reorder.
- [ ] Export the pure `childGatesOf(...)` core from `src/hooks/useChildGates.ts` (Task 1 keeps `useChildGates` as its wrapper).
- [ ] Implement the `SubagentModals` changes (all four kinds, the `z-40` `fixed` wrapper with the Esc-stop, the chip, the composite key).
- [ ] Move the `<SubagentModals />` mount from `src/components/SidePane.tsx:362` to `src/App.tsx`, outside the `view === "settings"` conditional (next to `<SubagentDetailHost />`). Add a failing `src/App.test.tsx` case FIRST: settings view open + a child holding an `ask` → the card is in the DOM.
- [ ] Remove the `ask`/`permission` renders and the now-unused imports (`AskQuestionCard`, `PermissionPrompt`) and the now-unused `askRequests`/`promptList` locals from `src/components/SubagentTranscript.tsx`; rewrite its doc comment.
- [ ] Update the `SidePane` doc comments (the component no longer mounts there at all — delete the bullet at `:77-80` and the JSX comment at `:358-361`, keep the collapse-mechanism paragraph honest about what it still protects: the pane's OWN content).
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
- Test: `src/components/ChatStream.test.tsx`, `src/components/SubagentModals.test.tsx`, `src/hooks/useChildGates.test.ts`, and `src/components/chat/MessageList.gap.test.tsx` (it constructs `MessageList` props directly — a new REQUIRED prop breaks its type-check)

**What to implement:**

1. `src/components/ChatStream.tsx`: call `useChildGates(activeSessionId)` and pass the result down as a new `childGates` prop to `MessageList` (the render site is `:1285-1298`). **Placement is load-bearing:** the call must sit BEFORE the `if (!activeSessionId)` early return at `:814`, unconditionally — the same trap `usePendingSubagentRequests` documents at `:288-294` ("this hook contains `useSyncExternalStore` (via zustand), so calling it only on the full-frame path would change the hook count when the active session appears/disappears and crash React → white page"). `activeSessionId` is `string | null` and the hook's `null` case returns `[]`.

2. `src/components/chat/MessageList.tsx`: accept `childGates: ChildGate[]`. **Critical:** `MessageList` is props-only BY DESIGN and MUST NOT read the stores (its doc says so at `:42-44`) — do not add a `useChildGates` call there. Render, AFTER the existing `prompts.map` (`:151-157`) and `stackedAskRequests.map` (`:160-165`) blocks and BEFORE `FileSummaryCard`:
   - `AskQuestionCard` for `kind === "ask"`, `PermissionPrompt` for `kind === "permission"`, each with `sessionId={gate.childSessionId}` / `requestId={gate.requestId}`, each wrapped with the `↳ <agentName>` chip.
   - Skip `confirm`/`password` — those stay in the overlay (they are modal by nature and `SudoConfirmModal`/`SudoPasswordModal` are Radix `Dialog`s; inlining a `Dialog` into a transcript is not the change we signed up for). Document that in the component doc so nobody "completes" it later.
   - `key` on `childGateKey(gate)` (same non-unique-id reason as Task 2).
   - **Rhythm check:** `MessageList.gap.test.tsx` builds props via `createElement` in TWO places (`:44-58` and again from `:68`) — a new REQUIRED prop breaks `tsc` there, so add `childGates: []` to both. Those tests also read `scroll.children` positionally, so a non-empty `childGates` in any of them would shift the rows they index; keep them `[]` and pin the child-gate rendering in `ChatStream.test.tsx` instead.
   - **No `hasPendingRequest` change is needed here.** `ChatStream`'s `hasPendingRequest` already ORs `pendingSubagentRequests > 0` (`src/components/ChatStream.tsx:1019-1026`), and `usePendingSubagentRequests` already counts every child's requests, so the "Send a prompt to start" hint (`src/components/chat/MessageList.tsx:86-95`) is already suppressed for a child gate. Do NOT add `|| childGates.length > 0` — it would be a no-op with a comment that misdescribes the code. Task 5 changes what that count *means*; it does not change this line's sufficiency.

3. `src/components/SubagentModals.tsx`: narrow to gates whose `parentSessionId !== activeSessionId`. Read `activeSessionId` from `useSessions` (already imported in this file's test fixture pattern; add the import). Rewrite the component doc: the overlay owns (a) `confirm`/`password` for EVERY child, and (b) `ask`/`permission` for a child whose parent is NOT the active session — because `ChatStream` renders only the active session, and an unrendered gate strands the child until its 30-minute `settle_timeout` (`src-tauri/src/agent/worker/manager.rs:30`).

4. No `SidePane` change in this task — its mount and both doc bullets went in Task 2. If a `SidePane` comment still describes `SubagentModals`, it is stale from Task 2; fix it here and say so in the commit message.

**What NOT to change:** `useChildGates`' parent filter semantics; the sudo modal components; the anchored/stacked split for the parent's OWN asks (`:118-134`) — a child ask's `source` is `"subagent:<name>"` so it can never anchor, and that logic must stay untouched.

**Steps:**
- [ ] Write failing tests:
  - `src/components/ChatStream.test.tsx`: with `activeSessionId = "main1"`, a `useSubagents` entry `{ sessionId: "sub1", parentSessionId: "main1", agentName: "reviewer", … }` and a pending `ask` on `"sub1"` → an `AskQuestionCard` renders in the transcript AND the child's `agentName` appears (the chip). Assert the card answers against `"sub1"` (spy `respondInteractiveRequest` — the file already mocks `../lib/tauri`).
  - `src/components/SubagentModals.test.tsx`: when `activeSessionId === "main1"` and the child's parent is `"main1"`, the overlay renders NO ask card (it moved inline); when `activeSessionId === "other"`, the overlay DOES render it. Plus: a child's `confirm` still renders in the overlay even when its parent IS active.
  - A **no-double-render** test — the invariant pin. It must mount BOTH surfaces, because `ChatStream.test.tsx` renders `<ChatStream />` alone (`:415` etc.) and never mounts the overlay, so counting cards there proves nothing. Put this one in `src/App.test.tsx` (or a small test that renders `<ChatStream />` and `<SubagentModals />` as siblings): for one child gate, assert exactly ONE `AskQuestionCard` is in the document when its parent is active, and exactly ONE when it is not. If this test passes on the first run, it is not counting what it claims — inspect before trusting it.
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
- [ ] In `src/components/SubagentDetailHost.test.tsx`: delete `renders a HIDDEN SubagentTranscript for every NON-selected entry (the always-mounted host)` (`:186`) and rewrite `closing does NOT dismiss the entry (it stays in useSubagents; the transcript moves to the hidden host in the same render)` (`:164`) to assert only that the entry survives in `useSubagents` and the header disappears. (`an Escape consumed by a nested AskQuestionCard…` (`:208`) was already deleted by Task 2 — assert it is gone, do not resurrect it.) **Verify the sheet-level Esc tests (`:124`, `:142`) still pass unchanged** — that behaviour must not regress.
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

1. `usePendingSubagentRequests` (`src/hooks/usePendingSubagentRequests.ts`) sums **every** child's gates app-wide with no `parentSessionId` filter. That app-wide scope is defensible — the dot sits on the pane-toggle chrome, and after Task 2 the overlay really does surface every non-active parent's gates, so "you owe something" matches what is on screen. What is missing is the *attribution*: the count tells the user nothing about which Session, and the count is computed by a hand-rolled loop that Task 1's derivation now owns. This task moves it onto the shared derivation (same value, one source of truth) — **it is not a bug fix, and must not change any number** (consumers: `ChatStream`'s `hasPendingRequest` at `:294,1019-1026`, and `useHasPendingRequest` `:26-32` → `SidePane.tsx:246`, `SpacesList.tsx:182`). The attribution fix is the inline card (Task 3) and the row status (below).
2. `sessionStatusOf` (`src/hooks/useSessionStatus.ts:31-45`) derives `waiting` from a session's OWN `prompts`/`requests`. A parent blocked on its child's gate has nothing under its own id, so its row reads **`running`** — it says "working" while it is blocked on the user. Consumers: `useSessionStatus` (one row, `SpacesList.tsx:551`) and `useSessionStatuses` (the collapsed rail, `SpacesList.tsx:149`); `SessionRail` consumes the type only.
3. The **attention alert** ranks subagent ids LAST in `candidateOrder` (`src/hooks/useAttentionAlert.ts:106-116`) and ADR 0040 documents that. Since a child's gate is now visually the parent's card, it should rank at its parent's position.

**Files:**
- Modify: `src/hooks/usePendingSubagentRequests.ts`
- Modify: `src/hooks/useSessionStatus.ts`
- Modify: `src/hooks/useAttentionAlert.ts`
- Modify: `src/components/SpacesList.tsx` (only if the widened `sessionStatusOf` input needs threading)
- Test: `src/hooks/usePendingSubagentRequests.test.ts`, `src/hooks/useSessionStatus.test.ts`, `src/hooks/useAttentionAlert.test.ts`

**What to implement:**

1. **`usePendingSubagentRequests`** → rebuilt on the pure core. It must still return a NUMBER and keep its name (three consumers). Semantics: **every** child gate the user owes = `childGatesOf(entries, requests, prompts, null).length` — the all-children set is exactly the union of the two render sites (inline for the active parent, the overlay for every other parent), so no filter and no double-count. (Deriving it as `useChildGates(active).length + …` invites double-counting; don't.) **This is a refactor onto the shared derivation, NOT a bug fix — and the wording matters.** The count stays app-wide and that is now CORRECT rather than approximate: after Task 2 the overlay genuinely surfaces every non-active parent's gates, so "you owe something, somewhere" matches what is on screen. Say exactly that in the doc comment, replacing "a subagent session id is never the ACTIVE session".
   - **The count's VALUE does not change** — the old code also summed every child, so every existing expectation in `src/hooks/usePendingSubagentRequests.test.ts` must still pass unchanged. That is the point: this is a behaviour-preserving refactor. The regression to guard against is the tempting "improvement" of filtering to the active parent — that would stop the dot for a gate the user owes that is on screen in the overlay. Add one test that pins it: `activeSessionId = "A"`, a child of `"B"` holding a gate → the count is still ≥ 1. (Parent-scoping is `useChildGates`'s job and is already pinned in Task 1's file.)
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
   `waiting` becomes `prompts.length > 0 || requests.some(…) || childGateCount > 0`. Update the doc paragraph (`:18-30`) to say so. Thread it in BOTH hooks: `useSessionStatus` computes `useChildGates(sessionId).length`; `useSessionStatuses` must subscribe to `useSubagents.entries` ONCE and derive per id (a hook per row is impossible at a changing list length — that is why the pure function exists, `:65-72`). No infinite-loop hazard if the derivation stays OUTSIDE the selectors (`useSessionStatuses` already returns a fresh object per call by design, `:82-92`). For that hook, build a single `Map<parentId, count>` from `entries` ONCE before the per-id loop — never re-scan `entries` per id. For `useSessionStatus`, which runs once per row with unmemoized rows (`SpacesList.tsx:551`), `useChildGates(sessionId)` is fine as-is: closed entries are capped at 20 (`MAX_CLOSED_ENTRIES`) plus the running ones, so the scan is small and bounded — say so in the comment rather than adding a memo layer for a 20-item map. `SpacesList.tsx:551` and `:149` need no change if the hooks keep their signatures (they should).
   - **Test-fixture gap:** `src/hooks/useSessionStatus.test.ts`'s `beforeEach` (`:15-26`) resets `useSessions`/`usePermissions`/`useInteractive` but NOT `useSubagents`, and it never imports it. Add the import and a per-test entries reset (copy the loop from `usePendingSubagentRequests.test.ts:18-20`) BEFORE writing any child-gate test — otherwise an entry added by one test leaks into the next and a `running` expectation fails for a reason that looks unrelated. `src/hooks/useSessionStatus.test.ts` drives everything through `renderHook` (`:36`), never `sessionStatusOf` directly, so add the `childGateCount` cases at the hook level too.

3. **The attention alert re-key** in `src/hooks/useAttentionAlert.ts`. Three coupled edits — all three are load-bearing, and the second one is what makes the first reachable.

   a. **Key `waitingIds` by the PARENT, and make the gate id COMPOSITE.** For a child session's gate, push `gateId = childGateKey(gate)` (Task 1's helper — `${childSessionId}:${requestId}`) into `waitingIds[entry.parentSessionId]`. The composite is load-bearing, not cosmetic: a trigger's identity is `(kind, sessionId, gateId)` (`sameAttentionTrigger`, `src/lib/attention.ts:48-53`) and `pauseOver` tests `waitingIds[sessionId].includes(gateId)` (`:214`). Once the sessionId half is the same parent, two children answering to the same recurring gateway tool-call id (`call_0` — `attention.ts:38-43` says ids recur) collapse into ONE trigger, and after the first is announced the second is muted by `spent` and never alerts. A parent's own gate keeps its bare `requestId`, so the composite (whose first half is a minted session id, never a bare model id) cannot collide with it. `gateId` is opaque to every rule — equality and membership only — so **no change to `src/lib/attention.ts` and no pure-test breakage**. It is the same string the React list keys use, by design.

   b. **Order within the parent's array: the parent's own gates fully first, then child gates in `childGatesOf` order.** `waitingIds` is filled today by iterating `Object.entries(requests)` — **key-insertion order** (`:128-137`). Merely re-mapping the key in that one pass puts a child's gate *before* the parent's own gates whenever the child's key was inserted first, silently inverting ADR 0040's within-Session arrival rule. Two rules, in this order:
   1. **all** of the non-child session's gates go in first — iterate `requests` **and then** `prompts` to completion for non-child sessions, so the parent's own `ask` *and* its own **Permission prompt** both outrank any child gate;
   2. child gates are appended after, taken from `childGatesOf(entries, requests, prompts, null)` and grouped by parent — **do not hand-roll a second ordering** over `Object.entries` keys. That reuses Task 1's `(childStartedAt, request arrival)` sort, keeps ONE derivation (this plan's own rule), and is immune to the fact that `dismissSession` DELETES a session's key (`src/store/interactive.ts:185-195`) so a re-added child would otherwise sort last and flip sibling rank.
   Across two children of the same parent the rank is then `(childStartedAt, arrival)`, e.g. `A:t1, B:t2, A:t3` → `a1, a2, b1`. There is no cross-child arrival stamp in the store, so that is the DEFINED rule, not an approximation of true wall-clock interleave — say so in the comment.

   c. **Replace the subagent tail of `candidateOrder` with the parents.** Delete `for (const id of Object.keys(subagentEntries)) push(id)` (`:115`) and push `entry.parentSessionId` for every entry instead (`push` is already deduping, `:107-109`).

      Why the parent must be pushed explicitly, and why "live main sessions only" is NOT enough: `attentionCandidates` iterates `candidateOrder` and reads `waitingIds[id]` (`src/lib/attention.ts:160-162`), so a key absent from `candidateOrder` is **never visited and can never arm**. `candidateOrder` today is `activeSessionId` + **live** `sessions` + subagent ids (`:114-115`) — `historySessions` never enters it. So re-keying to a parent without registering that parent would drop the alert for every child of a Session the user has navigated away from, which is precisely this feature's motivating case. The hook's own test builds exactly that snapshot — the parent lives in `historySessions` only (`src/hooks/useAttentionAlert.test.ts:302-305`) — so this is not hypothetical.
   - `settledWatch` stays `sessions.map(s => s.sessionId)` (live MAIN sessions) — unchanged, and the `settled` arm's "a subagent finishing is not the user's pause" skip (`src/lib/attention.ts:168`) keeps working for free because child ids are no longer in `candidateOrder`.
   - **Label side effect, and the comment you must write:** `attentionAlertText` does `ctx.parents[trigger.sessionId] ?? trigger.sessionId` (`src/lib/attention.ts:430`). A re-keyed trigger carries the PARENT id, so the `parents` lookup now MISSES and falls through to the id itself — which is already the parent, so the body is still `"Investigate flaky test needs your answer"`. Write a comment at the `parents` construction (`useAttentionAlert.ts:239-245`) saying exactly this, or a future reader will "fix" the now-unused map. Do NOT delete `parents` from `AttentionLabelContext` — the field is still required by the interface (`src/lib/attention.ts:417`), so removing it breaks `pnpm build`, and its unit tests still exercise the child-id path.
   - **Accepted consequences, write them down:**
     - R3's evidence arms now read the PARENT's flags for a child gate — `next.stalled[id]` (`:271`) and the settled `candidateOrder`-membership arm (`:284`). So a stalled parent disarms/re-times a still-open child countdown (self-cancelling: R5 re-arms on the same pass, cost is Rust's deadline re-timed once — the identical cost documented at `src/lib/attention.ts:270-276`).
     - **What happens when a child's `SubagentEntry` disappears — UNCHANGED by this task.** With the entry gone the snapshot loop no longer recognises the id as a child, so the gate keys back to `waitingIds[childId]`; and `childId` is absent from `candidateOrder` both before the change (it was pushed from `subagentEntries`) and after (only parents of live entries are pushed). So `attentionCandidates` never visits it and R3's `!candidateOrder.includes(id)` arm (`:284`) disarms an armed countdown — exactly as today. No behaviour change to document here, only the mechanism comment. Note the asymmetry with `childGatesOf` (Task 1), which drops the same gate because a card needs a parent transcript and there is none; the alert can still name an unknown owner, a card cannot.
     - **A deleted parent still arms.** `deleteSession` (`src/store/sessions.ts:991-1008`) removes the parent from all three session lists but does NOT clear its children's entries or gates, so a parent pushed into `candidateOrder` by (c) can arm `"A session needs your answer"` for a deleted Session. Pre-existing-ish (the child-keyed shape armed `"A session"` too), accepted; one line in the hook comment.
     - **No new silent cases.** A child whose `SubagentEntry` is gone stops being announced — but that is true today too: the child id was itself pushed from `subagentEntries`, so its disappearance already removed it from `candidateOrder`. Nothing regresses; the mechanism just moves from "the child left the list" to "no live entry names its parent". The Task 3 motivating case (parent in `historySessions`, entry alive) still arms — that is what fix (c) is for.
   - **Tests to change and add** in `src/hooks/useAttentionAlert.test.ts`:
     - `arms for a subagent's gate while the user sits in an unrelated session, naming the PARENT` (`:297`) **must still pass, unchanged, with the same expected body** — it is the regression pin for BOTH the label fall-through and fix (c): its parent is in `historySessions` only, so if you skip (c) this test fails by never arming (the `waitFor` times out). If it fails with `arm` never called, you dropped the parent registration; if it fails with body `"A session needs your answer"`, the label fall-through broke.
     - Add: **ordering** — a parent holding its own gate AND a child gate arms the PARENT's own gate first (the two-pass rule in (b)); construct the stores so the child's key would be inserted first, which is what makes the test fail under a naive single pass.
     - Add: **unannounceable regression** — a child whose parent is in `historySessions` only still arms (this is the motivating case; `:297` covers the label, this covers the arm).
     - Add: **entry gone (preservation, not change)** — with an armed child-gate countdown, dismissing the child's `SubagentEntry` disarms exactly once and never re-arms. This documents the pre-existing outcome under its new mechanism; if it re-arms as `"A session"`, you have left the child id in `candidateOrder` somewhere.
     - Add: **composite gate id** — two children of one parent both holding `call_0` (the recurring-gateway-id case, `src/lib/attention.ts:38-43`) are TWO triggers: arm one, answer it, the second still arms. With a bare `requestId` as `gateId` this test FAILS, because both collapse into one `(parent, call_0)` trigger and `spent` mutes the survivor forever.
     - Add: a child gate vs a competing unrelated-session gate, asserting the ranking follows the parent's `candidateOrder` position rather than ranking last.
   - `src/lib/attention.test.ts`: **no test there breaks** — they all hand-construct snapshots, and the pure module's contract is unchanged. `carries the SUBAGENT's own id when a subagent holds the gate` (`:172`), `never settles a subagent` (`:183`), and `follows the candidate order: … live sessions before subagents` (`:198`) now pin a snapshot shape the HOOK can no longer emit. Leave them (they still describe a legal snapshot the pure rules must handle) but add a one-line comment at `:172` and `:198` saying the hook no longer produces that shape since the parent-keying change, and that the hook-level test in `useAttentionAlert.test.ts` pins the emitted shape. Add no new pure-module cases — the rules did not change.

**What NOT to change:** `src/lib/attention.ts`'s rules (R1–R6) — this is a snapshot-construction change in the hook, and the pure module's contract is unchanged. No Rust, no `attention_arm` protocol change (ADR 0039: Rust is handed a delay and text and learns nothing). Also out of scope, both accepted and each worth a one-line comment where it lives: the composer's "Waiting for your input…" line reads `agentState[activeSessionId]` (`src/components/chat/ComposerModals.tsx:45-49`), which a push from the agent sets — a child's blocked state lands under the CHILD's id, so the parent's composer keeps its spinner during a child gate (the inline card and the pill are the cue); and `SubagentStatusIcon` still shows the child itself as `running`, which is true — its turn is open, parked on the gate.

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
- [ ] `usePendingSubagentRequests` returns the SAME number it returned before the refactor (every existing expectation in its test file passes unchanged), now derived from `childGatesOf`.
- [ ] A child gate arms the alert at its parent's rank — including when the parent is only in `historySessions` — and the alert body still names the parent.
- [ ] An armed child-gate countdown is not disarmed while its gate stays open, and is disarmed exactly once when the gate closes (R3's evidence arms, `src/lib/attention.ts:281,284`).
- [ ] Two children of one parent holding the same gateway `requestId` produce two independent alerts in sequence, never one muted forever.

---

### Task 6: Record the decision — amend ADR 0040, update the glossary

**Context:**
Two durable documents now state things that are no longer true. `docs/decisions/0040-one-attention-alert-at-a-time-with-an-oldest-question-first-ladder.md` states that across Sessions rank is `candidateOrder` with subagents LAST, and its Consequences section says a displaced subagent gate is "the accepted price of one alert app-wide" with the in-app affordances carrying it. Task 5 changes the ranking. And `CONTEXT.md`'s *Subagent session* entry says its prompts "go directly to the Client (the Supervisor's relay) without relaying through the main agent" — true, but that sentence is precisely what let the child-sheet placement read as intentional; it needs to say where they render now.

**Files:**
- Modify: `docs/decisions/0040-one-attention-alert-at-a-time-with-an-oldest-question-first-ladder.md`
- Modify: `CONTEXT.md` (the *Subagent session* entry, `:59-60`; consider the *Attention alert* entry, `:148`)

**What to implement:**
- ADR 0040: the clause to amend is at `:29-30` — "ACROSS Sessions `candidateOrder` decides (active Session first, then live main Sessions in store order, **then subagents** — `src/hooks/useAttentionAlert.ts:106-116`)". Replace "then subagents" with the new rule — **a Subagent session's gate is keyed to its PARENT's id and rides in the parent's `waitingIds` array, and every parent named by a live entry joins `candidateOrder` (including one that is only in `historySessions`)** — and say why: the gate is answered in the parent's transcript, so ranking it behind everything would point the alert at a Session the user is not being asked about. Also record the composite `gateId` (`childSessionId:requestId`) and WHY — the recurring-gateway-id collapse (`attention.ts:38-43`) — since that is the surprising half a future reader cannot re-derive. Update the Consequences paragraph at `:70-76` ("A displaced question keeps waiting…"): its "in-app affordances carry it" sentence now also includes the inline card. Keep the rest of the ladder intact (question-over-finished app-wide; positional rank; oldest-wins within a Session; the announced-pauses-are-a-SET fix). Do NOT supersede 0040 — the ladder stands; this is a scoping amendment to its candidate ordering. Follow the ADR format the repo already uses (see any file in `docs/decisions/`).
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
