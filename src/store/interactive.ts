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
   * fixtures and `bin/fake_worker.rs`. The consumers that still branch on
   * it — `AskQuestionCard`'s `source === "main"` anchoring and its `subagent:`
   * gate for the `queued` placeholder — therefore never fire on production
   * traffic. The card's "who is asking" LABEL no longer reads this field at
   * all: it resolves the child's `agentName` from `useSubagents` (see
   * `AskQuestionCard`). Todo boards no longer branch on
   * it at all: they are keyed by SESSION id, never by this label (ADR 0041), so
   * a future real `source` must arrive as a SESSION identity the Client can
   * join (child id → parent, `agentName` — what `useSubagents` already
   * provides), not a prettier string.
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

/**
 * One session's money and tokens, as the `cost_update` frames leave them in the
 * store (the store-entry type — NOT the wire's inner payload, which is only
 * `{ costUsd, source }`).
 *
 * `costUsd` is D5's key (issue #87). `cost` is the LEGACY alias, still read by
 * `SubagentDelegatingCard.tsx`'s `interactiveCost?.cost` link; see the note on
 * the field below for its two roles and their two expiries.
 */
export interface CostUpdatePayload {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * The compatibility alias of `costUsd` — same value, same writer, one
   * accumulator. It has TWO ROLES and therefore TWO EXPIRIES, and deleting one
   * half while the other is still live is the mistake this note exists to stop:
   *
   * - **read-side**: `SubagentDelegatingCard.tsx`'s fallback chain reads
   *   `interactiveCost?.cost`. It expires when that link is repointed at
   *   `costUsd` — a change that is deliberately SEQUENTIAL and lands strictly
   *   after this alias exists (seam S4), never in the same wave as it.
   * - **input-side**: `applyCost` accepts a frame's legacy `cost` key. It
   *   exists only for a pre-D5 emitter, and T09's wire contract emits
   *   `{ costUsd, source }` and nothing else — so once T09's frames are in tree
   *   the only remaining producer of `cost` is a test fixture. It expires in
   *   the SAME commit as the read-side half (repoint the card, drop the input
   *   fallback, drop the field, drop the legacy test seeds).
   *
   * Note the card's own shape is an `as` assertion, not a checked annotation, so
   * `tsc` will NOT flag a `null` here against its declared `cost?: number`. The
   * safety of the alias is the card's runtime gate (`row.cost > 0`, and `null`
   * fails it), not the type checker — do not trust the types on this link.
   */
  cost?: number | null;
  /**
   * The session's cumulative USD figure, exactly as the provider reported it
   * (D4/D5). `null` is a REACHABLE, MEANINGFUL value: "no frame this session
   * carried a figure" — which is NOT the same fact as `0` ("a frame reported a
   * real zero"). A renderer that cannot tell them apart prints `$0.00` for a
   * session that spent nothing observable, which is the defect #87 was filed
   * to end.
   */
  costUsd?: number | null;
  source?: string;
}

/**
 * THE delta/total seam (issue #87).
 *
 * A `cost_update` frame carries THIS CALL's money, so the session's figure is
 * the SUM — and an unknown frame (`null`) contributes NOTHING:
 * `null + null = null` (still unknown), `null + x = x`, `x + null = x`.
 * That last rule is what stops D5's unknown from being manufactured into a real
 * `$0`; the inline `(prev.cost ?? 0) + (p?.cost ?? 0)` this function replaced
 * did exactly that, and it is why a session with no priced call displayed
 * `$0.00`.
 *
 * `prev` IS the session's cumulative figure — Rust holds no accumulator (T09's
 * Decision 1), so a Worker re-incarnation / `Resume` continues this same number
 * in this same key. Keep this pure ADDITION: never `max`, never assignment, or
 * that continuity breaks silently.
 *
 * SEMANTICS ARE PINNED ON BOTH SIDES (T09's Decision 2 + its AC3), so the flip
 * below is HYPOTHETICAL, recorded for the day an emitter changes its mind: if a
 * frame ever carries a RUNNING TOTAL, this is the only line that changes —
 * last-frame-wins, i.e. return `frame` (with `frame === null ? prev : frame`, so
 * a trailing unknown frame keeps the total). Nothing in `SessionCostLine.tsx` or
 * `SidePane.tsx` changes: the component reads the entry, never the frames. The
 * test that reddens is named for this contract, in `interactive.test.ts`.
 */
function combineSessionCost(
  prev: number | null,
  frame: number | null,
): number | null {
  if (prev === null) return frame;
  if (frame === null) return prev;
  return prev + frame;
}

/**
 * A frame's money, or `null` for "this frame reported no figure".
 *
 * `costUsd` (D5's key) wins; the legacy `cost` key is the fallback for a
 * pre-D5 emitter. Reading them in this order — and ONCE — is what makes a
 * mixed-key session sum a single time: `{ cost: 0.005 }` then
 * `{ costUsd: 0.005 }` is `0.01`, not `0.02`.
 *
 * A value that is not a finite non-negative number is UNKNOWN, not money: a
 * string, `NaN`, `Infinity` and a negative all normalise to `null`. Nothing may
 * invent a figure here.
 */
function frameCost(p: CostUpdatePayload | undefined): number | null {
  const raw = p?.costUsd ?? p?.cost;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

interface InteractiveState {
  /** Pending interactive requests, keyed by the ACP session id. */
  requests: Record<string, InteractiveRequestData[]>;
  /**
   * One session's OWN `manage_todo_list` list, keyed by that session's id
   * (main OR Subagent); one Session runs one Agent harness, so exactly one
   * board (ADR 0041). Boards are persistent session state seeded on
   * open/resume; a clear leaves the board empty until the next `todos_update`.
   */
  todos: Record<string, TodoItem[]>;
  /** The agent state machine (`working`/`idle`/`blocked`) — wired, not rendered in v1. */
  agentState: Record<string, "working" | "idle" | "blocked">;
  /**
   * One session's cumulative money + tokens, keyed by session id (issue #87).
   * **Rendered** — `SessionCostLine` reads this entry and prints the figure
   * under the session title. Written ONLY by `applyCost`, from `cost_update`
   * FRAMES: it is a sum, so a future hydrator holding a stored TOTAL must write
   * the key directly (the way `sessions.ts` copies `contextUsage` off the DB
   * row) and never route it through `applyCost`, or the stored figure is added
   * to itself.
   */
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
   * The key is DELETED, leaving the session's board empty until the next
   * `todos_update`.
   */
  applyTodoClear: (sessionId: string) => void;
  /** A `state` push (`{ state }`) — store, don't render in v1. */
  applyState: (sessionId: string, payload: unknown) => void;
  /**
   * A `cost_update` push: ONE frame's money added to this session's running
   * figure (issue #87). Frames are per-call DELTAS — see `combineSessionCost`.
   * Frames only: a stored total must never come through here.
   */
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
      // The key goes, leaving the session's board empty until the next
      // `todos_update`.
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
      // NO first-frame fast path (rule R3). This used to early-return
      // `{ ...state.cost, [sessionId]: payload }` — storing frame #1 RAW —
      // which left a one-frame session with a key set that depended on the
      // frame COUNT: a legacy first frame had no `costUsd` (so the renderer
      // printed nothing while money existed) and a D5 first frame had no
      // `cost` (so the card's alias link read `undefined`). Every frame now
      // takes the identical normalise → combine → write-both-keys path, with
      // `null` standing in for "no previous entry" — which is exactly the
      // identity `combineSessionCost` needs.
      // The `typeof` half is carried over from the branch this replaced: an
      // entry written outside `applyCost` (a hand-written `setState` in a test,
      // or a future hydrator) is not necessarily an object. It is belt-and-braces,
      // not arithmetic — `frameCost` on a non-object is `null` anyway, which is
      // the same answer the guard produces.
      const hadEntry = prev !== undefined && typeof prev === "object";
      const money = combineSessionCost(
        hadEntry ? frameCost(prev) : null,
        frameCost(p),
      );
      const next: CostUpdatePayload = {
        inputTokens: (prev?.inputTokens ?? 0) + (p?.inputTokens ?? 0),
        outputTokens: (prev?.outputTokens ?? 0) + (p?.outputTokens ?? 0),
        cacheReadTokens: (prev?.cacheReadTokens ?? 0) + (p?.cacheReadTokens ?? 0),
        cacheWriteTokens:
          (prev?.cacheWriteTokens ?? 0) + (p?.cacheWriteTokens ?? 0),
        // ONE total, written under BOTH names (rule R1). `null` — not `0`, and
        // not an absent key — is the honest spelling of "nothing reported yet";
        // the card's `row.cost > 0` gate treats `null` and `undefined` alike, so
        // the alias is safe in the unknown state.
        cost: money,
        costUsd: money,
        source: p?.source ?? prev?.source,
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
