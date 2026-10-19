---
status: committed
issue: 52
done-when: Frontend session-closed cleanup is consolidated in `sessionLifecycle.ts` without foreign store mutations in `sessions.ts`, transcript reducers are extracted to pure modules under `src/lib/transcript/`, `SubagentDetailHost` entry selection is O(1), and `pnpm test` and `pnpm build` pass with 0 errors.
---

# Frontend Store Decoupling & UI Hygiene — Plan

**Goal:** Decouple `src/store/sessions.ts` by extracting session cleanup fan-out to `src/lib/sessionLifecycle.ts`, extract pure transcript reducers to `src/lib/transcript/`, and optimize `SubagentDetailHost` entry selection to O(1).
**Architecture:** Centralize event listening and multi-store session termination in `src/lib/sessionLifecycle.ts`, making `useSessions` pure; extract transcript reducers as pure functions using type-only imports; optimize Zustand selectors for O(1) lookups.
**Tech Stack:** React 19, TypeScript, Zustand, Tailwind CSS, Vitest.

**Execution Order & Dependencies:**
- **Phase A (Parallel Foundation):** Spec 5 can be executed in parallel with Spec 1 (`harness-loop-decomposition`), Spec 2 (`tool-exec-modularization`), and Spec 4 (`file-commands-decomposition`).
- Spec 3 (`session-worker-supervision-and-typed-ids`) runs in Phase B.

**Disjoint File Boundary:**
This spec modifies *only* frontend files under `src/`. It does NOT touch any Rust files under `src-tauri/`.

---

### Task 1: Consolidate Session-Close Fan-Out in `src/lib/sessionLifecycle.ts`

**Context:**
Currently, when a session closes, cleanup logic is scattered across `App.tsx` (which calls `useInteractive.dismissSession` and `discardSessionMessages`) and `sessions.ts` (which reaches into `usePermissions.getState().dismissSessionPrompts`). This creates cross-store coupling, making `useSessions` impossible to test without mocking `usePermissions`.

**Files:**
- Create: `src/lib/sessionLifecycle.ts`
- Create: `src/lib/sessionLifecycle.test.ts`
- Modify: `src/store/sessions.ts`
- Modify: `src/store/sessions.test.ts`
- Modify: `src/App.tsx`

**What to implement:**
- In `src/lib/sessionLifecycle.ts`:
  ```ts
  import { useInteractive } from "../store/interactive";
  import { usePermissions } from "../store/permissions";
  import { discardSessionMessages, useSessions, type CloseReasonStr } from "../store/sessions";

  export function onSessionClosed(sessionId: string, reason: CloseReasonStr): void {
    useInteractive.getState().dismissSession(sessionId);
    usePermissions.getState().dismissSessionPrompts(sessionId);
    useSessions.getState().handleSessionClosed(sessionId, reason);
    discardSessionMessages(sessionId);
  }
  ```
- In `src/store/sessions.ts`:
  - Remove `usePermissions.getState().dismissSessionPrompts(sessionId)` from `handleSessionClosed`.
  - Remove `usePermissions` import from `sessions.ts`.
- In `src/App.tsx`:
  - Replace inline store calls in the `session-closed` event listener with `onSessionClosed(payload.sessionId, payload.reason)`.
  - Prune unused imports in `App.tsx` (`useInteractive`, `usePermissions` if unreferenced) to satisfy TypeScript's `noUnusedLocals`.

**Steps:**
- [ ] Write unit tests in `src/lib/sessionLifecycle.test.ts` asserting deterministic order of dismissal across stores.
- [ ] Implement `src/lib/sessionLifecycle.ts`.
- [ ] Remove `usePermissions` call from `src/store/sessions.ts`.
- [ ] Wire `onSessionClosed` into `src/App.tsx` and prune unused imports.
- [ ] Run `pnpm test src/lib/sessionLifecycle.test.ts` and `pnpm test src/store/sessions.test.ts`.
- [ ] Run `pnpm build` to verify clean compilation.
- [ ] Commit with message: "refactor(frontend): consolidate session-close fan-out in sessionLifecycle"

**Acceptance criteria:**
- [ ] Zero `usePermissions` imports in `src/store/sessions.ts`.
- [ ] All stores clean up deterministically on session close.

---

### Task 2: Extract Transcript Reducer to `src/lib/transcript/`

**Context:**
`src/store/sessions.ts` (1,683 lines) contains extensive inline reducer and history merging logic (`applySessionUpdate`, `finalizeSessionMessages`, `rowToMessages`, `mergeDedupeKey`, `diffMessages`, `isStaleCompactionStart`, `mapStatus`, `extractDiffs`). Moving these pure functions into dedicated modules makes them unit-testable in isolation.

**Files:**
- Create: `src/lib/transcript/reducer.ts`
- Create: `src/lib/transcript/reducer.test.ts`
- Create: `src/lib/transcript/identity.ts`
- Modify: `src/store/sessions.ts`

**What to implement:**
- In `src/lib/transcript/identity.ts`:
  - Use `import type { Message } from "../../store/sessions";` to ensure type-only imports.
  - Move and export: `mergeDedupeKey`, `diffMessages`, `isStaleCompactionStart`.
- In `src/lib/transcript/reducer.ts`:
  - Move and export: `applySessionUpdate`, `finalizeSessionMessages`, `rowToMessages`, `mapStatus`, `extractDiffs`.
  - In `reducer.test.ts`, write unit tests covering:
    - Text delta appending and tool call accumulation.
    - Status updates (`running` -> `completed` -> `failed`).
    - Stale compaction event filtering.
- In `src/store/sessions.ts`:
  - Re-export `applySessionUpdate`, `finalizeSessionMessages`, and `rowToMessages` so external test imports continue working unchanged.

**Steps:**
- [ ] Create `src/lib/transcript/identity.ts` and move identity helpers.
- [ ] Create `src/lib/transcript/reducer.ts` and move reduction helpers.
- [ ] Add unit tests in `src/lib/transcript/reducer.test.ts`.
- [ ] Update `src/store/sessions.ts` to import from `src/lib/transcript/` and re-export public helpers.
- [ ] Run `pnpm test` from the repo root.
- [ ] Run `pnpm build`.
- [ ] Commit with message: "refactor(frontend): extract transcript reducers to src/lib/transcript/"

**Acceptance criteria:**
- [ ] Message reduction logic isolated as pure functions.
- [ ] `sessions.ts` reduced in length and complexity.
- [ ] All frontend tests pass.

---

### Task 3: Optimize `SubagentDetailHost` Entry Selection Selector

**Context:**
`src/components/SubagentDetailHost.tsx` currently subscribes to `useSubagents((s) => s.entries)` and calls `Object.values(...).find(...)`. This causes the component to re-render on any subagent entry change, performing an O(N) array search on every render.

**Files:**
- Modify: `src/components/SubagentDetailHost.tsx`
- Modify: `src/components/SubagentDetailHost.test.tsx`

**What to implement:**
- In `SubagentDetailHost.tsx`:
  - Declare `selectedId` first, then retrieve entry via keyed selector:
    ```ts
    const selected = useSubagents((s) => (selectedId ? s.entries[selectedId] : undefined));
    ```
  - Remove `entryList` variable.
- In `SubagentDetailHost.test.tsx`:
  - Add a render-count spy test asserting that updating an entry other than `selectedId` does not re-render `SubagentDetailHost`.

**Steps:**
- [ ] Update `SubagentDetailHost.tsx` to use the keyed selector and remove `entryList`.
- [ ] Add re-render avoidance test in `SubagentDetailHost.test.tsx`.
- [ ] Run `pnpm test src/components/SubagentDetailHost.test.tsx`.
- [ ] Commit with message: "perf(subagents): optimize SubagentDetailHost entry selector to O(1) lookup"

**Acceptance criteria:**
- [ ] `SubagentDetailHost` re-renders only when the active subagent's entry updates.
- [ ] O(1) dictionary lookup replaces O(N) linear array scan.
- [ ] `pnpm test` and `pnpm build` pass cleanly.
