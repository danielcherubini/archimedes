import { create } from "zustand";

/**
 * The interactive store — the desktop's delegated interactive UI (Task 5).
 * Mirrors `permissions.ts` (pending prompts keyed by session id).
 *
 * **Password hygiene:** the `password` method's secret lives ONLY in the
 * modal's local `useState` — it is sent via `respondInteractiveRequest` and
 * is NEVER stored here (0010 / ADR 0022 invariant), so there is no
 * `markAnswered` step: a settled request is removed outright.
 *
 * **Session-id identity (B3):** the `sessionId` in every
 * `interactive-request` / `interactive-event` payload is the ACP session id
 * (the native `AgentLoop` is constructed with it, so the events always
 * carry it). The store keys by this ACP id, which is the same id the
 * frontend's `activeSessionId` holds (from `startSession`'s return) — so
 * the keys line up.
 */

/** A pending interactive request (an `interactive-request` event, keyed by `requestId`). */
export interface InteractiveRequestData {
  /** The frame UUID (the correlation key — never the bare `toolCallId`). */
  requestId: string;
  method: "ask" | "confirm" | "password";
  /**
   * The emitter's label. Every `interactive-request` the desktop builds today
   * carries `"native"`: `ask_flow` (`src-tauri/src/agent/harness/ask.rs`) emits
   * it verbatim, and the `sudo_run_flow` core
   * (`src-tauri/src/agent/interactive/mod.rs`) — the `confirm` / `password`
   * sub-prompts — is handed it as its `source` argument by the `AgentLoop`'s
   * tool dispatch (`src-tauri/src/agent/harness/loop.rs`), which passes the same
   * literal to `todo_apply` for its `todos_update` push, for a MAIN session and
   * a Subagent session alike. So this is NOT a main/child discriminator and
   * never was one on the wire: `"main"` and `"sudo"` exist only in Rust
   * fixtures and `bin/fake_worker.rs`. The one consumer that still branches on
   * it — `AskQuestionCard`'s `source === "main"` anchoring and its `subagent:`
   * label — is therefore DEAD: it never draws. Todo boards no longer branch on
   * it at all: they are keyed by SESSION id, never by this label (ADR 0041), so
   * a future real `source` must arrive as a SESSION identity the Client can
   * join (child id → parent, `agentName` — what `useSubagents` already
   * provides), not a prettier string. The dead card branch is recorded as a
   * follow-up in `docs/features/subagent-sessions.md`.
   */
  source: string;
  /** The invoking process's tool-call id (absent for `confirm`/`password`). */
  toolCallId?: string;
  /** The method's params: the ask schema for `ask`; `{ command, reason }` for `confirm`/`password`. */
  params: Record<string, unknown>;
}

/**
 * Whether a `method` is a PAUSE ON THE USER — a request that sits unanswered
 * until a human answers it, and therefore the thing every "this Session is
 * waiting on you" cue is derived from.
 *
 * ONE predicate, exported from the store that owns the union, because four
 * consumers ask the question and a cue that disagrees with another cue is worse
 * than no cue (the standing "one derivation, many consumers" rule
 * `useSessionStatus` documents): `childGatesOf` (which feeds the inline card,
 * the overlay and the dot), `sessionStatusOf`, the attention snapshot, and
 * `useHasPendingRequest`. Each of them hand-writing the three comparisons is
 * how a fourth `method` would be counted by one surface and dropped by
 * another — and `childGatesOf`'s comment promises the filter exists precisely
 * for that day, which `useChildGates.test.ts` now pins.
 */
export const isInteractivePause = (
  method: InteractiveRequestData["method"],
): boolean => method === "ask" || method === "confirm" || method === "password";

/** A todo list item (the `manage_todo_list` `TodoItem` shape). */
export interface TodoItem {
  content: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
}

/** The bus `TODOS_UPDATE` payload (verbatim over the wire). */
export interface TodoUpdatePayload {
  source: string;
  todos: TodoItem[];
}

export interface CostUpdatePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  source?: string;
}

interface InteractiveState {
  /** Pending interactive requests, keyed by the ACP session id. */
  requests: Record<string, InteractiveRequestData[]>;
  /**
   * One session's OWN `manage_todo_list` list, keyed by that session's id
   * (main OR Subagent); one Session runs one Agent harness, so exactly one
   * board (ADR 0041).
   */
  todos: Record<string, TodoItem[]>;
  /** The agent state machine (`working`/`idle`/`blocked`) — wired, not rendered in v1. */
  agentState: Record<string, "working" | "idle" | "blocked">;
  /** The last `cost_update` payload — wired, not rendered in v1. */
  cost: Record<string, unknown>;
  /** The last `session` push payload — wired, not rendered in v1. */
  session: Record<string, unknown>;

  /** Add a request (dedup by `requestId` — a re-delivered frame replaces). */
  addRequest: (sessionId: string, data: InteractiveRequestData) => void;
  /** Remove a settled request. */
  removeRequest: (sessionId: string, requestId: string) => void;
  /**
   * A `todos_update` push: replace this session's board. The payload's
   * `source` is NOT consulted (ADR 0041).
   */
  applyTodoUpdate: (sessionId: string, payload: unknown) => void;
  /**
   * A `todos_clear` push: drop this session's WHOLE board. The payload's
   * `source` is not consulted — a clear names a SESSION, never a label
   * (ADR 0041).
   *
   * The key is DELETED, never written `[]`, and that choice has TWO halves —
   * both pinned (`interactive.test.ts` for the key itself, and
   * `TodoBoardPanel.test.tsx` end-to-end for what renders):
   *
   * - A SUBAGENT session — the only real caller today, `App.tsx`'s
   *   `subagent-closed` handler — has NOTHING to unmask, because that SAME
   *   handler calls `discardSessionMessages`: the transcript the seed would be
   *   read from goes with the board, so there is no list left to show. That is
   *   true but NOT the operative reason: a CHILD's board never consults the seed
   *   at all (`todoBoardsOf`'s rule 7 — the `rawInput` fallback walks the
   *   transcript of the session it was called for, which would be the PARENT's),
   *   so the transcript could not have resurfaced a child's list even if it had
   *   stayed. Do not chase a leak here.
   * - A MAIN session gets its `rawInput` seed BACK: `useMainTodoItems` reads
   *   `board ?? rawTodos ?? []`, so an absent slice re-exposes the
   *   transcript's `manage_todo_list` `rawInput`, where an empty-array write
   *   kept it suppressed. Deliberate. The alternative — writing a "cleared"
   *   marker in place of the board — is per-session state that nothing ever
   *   removes: `dismissSession` runs on `session-closed`, and no
   *   `session-closed` is emitted for a Subagent session at all
   *   (`useChildGates` documents why), so a marker would reinstate exactly the
   *   leak this branch fixed. And a re-appeared seed is not a lie — it is what
   *   the transcript actually shows.
   *
   * The MAIN half is reachable only from a `todos_clear` frame, and
   * `src-tauri/src/` emits none: the path is inert today (the Client's
   * listener and the payload type stay for the day one exists).
   */
  applyTodoClear: (sessionId: string) => void;
  /** A `state` push (`{ state }`) — store, don't render in v1. */
  applyState: (sessionId: string, payload: unknown) => void;
  /** A `cost_update` push — store, don't render in v1. */
  applyCost: (sessionId: string, payload: unknown) => void;
  /** A `session` push — store, don't render in v1. */
  applySession: (sessionId: string, payload: unknown) => void;
  /** Clear everything for a session (called on `session-closed`). */
  dismissSession: (sessionId: string) => void;
}

export const useInteractive = create<InteractiveState>((set) => ({
  requests: {},
  todos: {},
  agentState: {},
  cost: {},
  session: {},

  addRequest: (sessionId, data) =>
    set((state) => {
      const existing = (state.requests[sessionId] ?? []).filter(
        (r) => r.requestId !== data.requestId,
      );
      return {
        requests: { ...state.requests, [sessionId]: [...existing, data] },
      };
    }),

  removeRequest: (sessionId, requestId) =>
    set((state) => {
      const list = (state.requests[sessionId] ?? []).filter(
        (r) => r.requestId !== requestId,
      );
      return { requests: { ...state.requests, [sessionId]: list } };
    }),

  applyTodoUpdate: (sessionId, payload) =>
    set((state) => {
      const p = payload as { todos?: TodoItem[] } | null;
      if (!p || !Array.isArray(p.todos)) return state;
      // Branch-free on purpose: the board is keyed by the SESSION id the frame
      // already carries, never by `payload.source` — every frame the desktop
      // emits says `"native"` for a Main session and a Subagent session alike,
      // so any branch on that label mis-files the board (ADR 0041). Do not
      // "restore" one.
      return { todos: { ...state.todos, [sessionId]: p.todos } };
    }),

  applyTodoClear: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.todos)) return state;
      // The key goes, not an empty array — see the interface doc for both
      // halves: a child's transcript is discarded in the same handler (so
      // nothing is unmasked), while a main session's `rawInput` seed comes back
      // on purpose (ADR 0041).
      const todos = { ...state.todos };
      delete todos[sessionId];
      return { todos };
    }),

  applyState: (sessionId, payload) =>
    set((state) => {
      const s = (payload as { state?: string } | null)?.state;
      if (s !== "working" && s !== "idle" && s !== "blocked") return state;
      return { agentState: { ...state.agentState, [sessionId]: s } };
    }),

  applyCost: (sessionId, payload) =>
    set((state) => {
      const p = payload as CostUpdatePayload | undefined;
      const prev = state.cost[sessionId] as CostUpdatePayload | undefined;
      if (!prev || typeof prev !== "object") {
        return { cost: { ...state.cost, [sessionId]: payload } };
      }
      const next: CostUpdatePayload = {
        inputTokens: (prev.inputTokens ?? 0) + (p?.inputTokens ?? 0),
        outputTokens: (prev.outputTokens ?? 0) + (p?.outputTokens ?? 0),
        cacheReadTokens: (prev.cacheReadTokens ?? 0) + (p?.cacheReadTokens ?? 0),
        cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + (p?.cacheWriteTokens ?? 0),
        cost: (prev.cost ?? 0) + (p?.cost ?? 0),
        source: p?.source ?? prev.source,
      };
      return { cost: { ...state.cost, [sessionId]: next } };
    }),

  applySession: (sessionId, payload) =>
    set((state) => ({ session: { ...state.session, [sessionId]: payload } })),

  dismissSession: (sessionId) =>
    set((state) => {
      const requests = { ...state.requests };
      delete requests[sessionId];
      const todos = { ...state.todos };
      delete todos[sessionId];
      const agentState = { ...state.agentState };
      delete agentState[sessionId];
      const cost = { ...state.cost };
      delete cost[sessionId];
      const session = { ...state.session };
      delete session[sessionId];
      return { requests, todos, agentState, cost, session };
    }),
}));
