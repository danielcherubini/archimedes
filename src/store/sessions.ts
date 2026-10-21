import { create } from "zustand";
import type { ImageRef } from "../lib/chatAttachments";
import {
  cancelSession as cancelSessionCommand,
  closeSession as closeSessionCommand,
  deleteSession as deleteSessionCommand,
  deleteSpace as deleteSpaceCommand,
  loadHistory,
  resumeSession as resumeSessionCommand,
  setSessionArchived as setSessionArchivedCommand,
  setSpaceTrusted as setSpaceTrustedCommand,
  startSession as startSessionCommand,
  type AcpSessionUpdate,
  type CloseReasonStr,
  type SessionConfigOption,
  type SessionInfo,
  type SpaceRow,
  type StopReason,
} from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { describeIpcError } from "../lib/ipcError";
import { openNewSpaceDialog } from "../lib/newSpaceDialogState";
import type { SessionUpdateBatchItem } from "../lib/batchSessionUpdates";
import { isStaleCompactionStart, mergeDedupeKey } from "../lib/transcript/identity";
import {
  applySessionUpdate,
  finalizeSessionMessages,
  rowToMessages,
} from "../lib/transcript/reducer";
import { useSubagents } from "./subagents";
import { useInteractive, type TodoItem } from "./interactive";
import { useQueuedPrompts } from "./queuedPrompts";

export const INITIAL_HISTORY_PAGE = 500;
export const OLDER_HISTORY_PAGE = 200;

export {
  applySessionUpdate,
  finalizeSessionMessages,
  rowToMessages,
};

export type { AcpSessionUpdate } from "../lib/tauri";
export type { SessionConfigOption } from "../lib/tauri";

export type ToolCallUiStatus = "pending" | "completed" | "failed";

export interface DiffRef {
  path: string;
  patch: string;
}

export type Message =
  | { kind: "user"; text: string; at: number; images?: ImageRef[] }
  | { kind: "agent-text"; messageId: string; text: string; at: number }
  | { kind: "agent-thought"; messageId: string; text: string; at: number }
  | {
      kind: "tool-call";
      id: string;
      title: string;
      status: ToolCallUiStatus;
      diff?: DiffRef;
      /** The ACP `rawInput` (the tool's raw input). */
      rawInput?: unknown;
      /** The ACP rawOutput (the tool's result — the RPC AgentToolResult, live-partial while running). */
      rawOutput?: unknown;
      at: number;
    }
  | { kind: "diff"; path: string; patch: string; at: number };

/**
 * Free a Subagent session's transcript from the store — delete it outright
 * instead of keeping a finalized copy. THIS IS THE CHILD'S ONLY CLEANUP PATH:
 * `subagent-closed` is the one frame that ever names the end of a child session
 * (see `SubagentClosedPayload`), and `App`'s `listenSubagentClosed` handler calls
 * this there, BEFORE `markClosed` — the order matters because `markClosed` can
 * evict the very `SubagentEntry` this function's guard reads. `App`'s
 * `listenSessionClosed` handler calls it too, but only as a guard that cannot
 * fire: no `session-closed` ever names a child id.
 *
 * Deleting is safe because nothing can ask for that transcript back: a child's
 * rows DO persist (`TranscriptPersister::apply` writes them with the
 * `is_subagent` flag), but `list_sessions` filters those rows out, so no surface
 * can re-open a closed child — while leaving the in-memory copy would keep every
 * child's transcript for the life of the window. MAIN sessions are untouched (the
 * guard below returns for any id with no `SubagentEntry`); a MAIN transcript is
 * kept — finalized by `handleSessionClosed` — for the history list.
 */
export function discardSessionMessages(sessionId: string): void {
  // ASSUMES the minted session ids (`mint_session_id` — `arch_<uuid v4>`,
  // ADR 0022) are globally unique across main + child sessions: the
  // subagent-entry guard below would delete a MAIN transcript if a child id ever
  // collided with a main id (a collision would already merge the two sessions'
  // `session-update` streams into one `messages[id]` before the delete matters;
  // the Rust side keeps the two apart by construction — main sessions live in
  // `SessionManager`'s `live` map, children in `WorkerManager`'s `drives`).
  if (!useSubagents.getState().entries[sessionId]) return; // main: keep
  useSessions.setState((state) => {
    if (!(sessionId in state.messages)) return state;
    const { [sessionId]: _gone, ...rest } = state.messages;
    return { messages: rest };
  });
}

/**
 * The session a fresh boot should land on: the most recently opened
 * space's newest session, live (in `sessions`) preferred over stored.
 * `null` when there's nothing.
 *
 * **Ordering note:** `SessionInfo` over IPC has NO `createdAt` field (it is
 * `{ sessionId, cwd, capabilities }` — the Rust `SessionInfo` struct has no
 * such field). So we CANNOT sort by `createdAt`.
 * We rely on SERVER order instead: `Db::list_sessions` returns
 * `ORDER BY COALESCE(last message's created_at, created_at) DESC, id DESC` —
 * LAST ACTIVITY, so the head of a space's `historySessions` subsequence is the
 * session of that space the user used most recently, not the one they started
 * most recently — and `Db::list_spaces` returns
 * `ORDER BY last_opened_at DESC, path ASC`, and the store slices only
 * `filter`/`map` those rows (preserving order). Therefore "most recently active
 * first" **is** the input order — `spaces[0]` is the most recently opened space.
 * Do NOT re-sort by a field that doesn't exist.
 *
 * (The SIDEBAR additionally re-sorts by the loaded transcript's last stamp —
 * `lib/sessionActivity` — because a session that CLOSED this boot is appended
 * to `historySessions` by `handleSessionClosed` and no server order can know
 * about it.)
 */

/**
 * All live session IDs belonging to a space, ordered newest-first (most
 * recently started at index 0).
 *
 * `sessions` is in insertion order (appended by `addSession` / `resumeSession`),
 * so reversing the filtered slice yields newest-first.
 */
export function liveSessionsInSpace(
  sessions: SessionInfo[],
  spacePath: string,
): string[] {
  return sessions
    .filter((s) => s.cwd === spacePath)
    .reverse()
    .map((s) => s.sessionId);
}

/**
 * The ID of the most recent live session a space "points at" (for the space row's
 * live dot and boot auto-select), or `null`.
 *
 * **Multi-live (the one-live cap is lifted):** a space may hold
 * MORE than one live session (a second `start_session` / `resume_session`
 * no longer supersedes the first). Returns the most-recently-started live session
 * in the space (the head of `liveSessionsInSpace`), keeping the space row's live dot
 * coherent with the active chat. With a single live session (the common case) it is
 * just that session.
 */
export function mostRecentLiveInSpace(
  sessions: SessionInfo[],
  path: string,
): string | null {
  return liveSessionsInSpace(sessions, path)[0] ?? null;
}

export function autoSelectActive(
  spaces: SpaceRow[],
  sessions: SessionInfo[],
  historySessions: SessionInfo[],
): string | null {
  for (const space of spaces) {
    // A space may hold MORE than one live session (the one-live cap is
    // lifted): `mostRecentLiveInSpace` picks the
    // most-recently-started one (coherent with `activeSessionId`).
    const live = mostRecentLiveInSpace(sessions, space.path);
    if (live) return live;
    // No re-sort: input order IS newest-first (see the ordering note).
    const stored = historySessions
      .filter((s) => s.cwd === space.path)
      .map((s) => s.sessionId);
    if (stored.length > 0) return stored[0];
  }
  return null;
}

/**
 * One per-space group for the UI (used by both this store and the Task 6
 * components). Built with the same input-order rule as `autoSelectActive`.
 *
 * Supports multiple coexisting live sessions per space: `liveSessionIds`
 * contains all active live sessions ordered newest-first, while `liveSessionId`
 * points to the most recently started live session (or `null`).
 *
 * Note: a session without a space is NOT a case here by design — a space is
 * born at the same time as a session (the `record_session → upsert_space`
 * hook), and it references a space row on boot after backfill. So there is
 * no "unknown sessions" group to render.
 */
export interface SpaceView {
  path: string;
  /** Display label (base name; `""` if the base name is empty — the UI falls back to `path`). */
  title: string;
  /** All live sessions in this space, most recently STARTED at index 0
   * (reverse insertion order). The SIDEBAR re-sorts this by last ACTIVITY for
   * display — `lib/sessionActivity` — because "started last" and "used last"
   * are different facts once a space holds more than one Worker. */
  liveSessionIds: string[];
  /** The most recent live session in this space, or `null`. */
  liveSessionId: string | null;
  /** Stored sessions of this space, in `list_sessions` order (most recently
   * ACTIVE first — see the ordering note above). Do NOT re-sort here; the
   * sidebar re-sorts what it can prove (`lib/sessionActivity`). */
  storedSessionIds: string[];
  /**
   * Archived sessions of this space (NOT rendered in the Space group —
   * used only for `view` membership, so a space whose only sessions are
   * archived still resolves its `view`).
   */
  archivedSessionIds: string[];
  /** Whether the space is trusted (permission prompts for gated tools are auto-approved). */
  trusted: boolean;
  /** Close reason of the space's newest session (live one preferred, else the head of the stored subsequence, else the head of the archived subsequence), if any. */
  lastReason: CloseReasonStr | undefined;
}

export function spaceViewFor(
  space: SpaceRow,
  sessions: SessionInfo[],
  historySessions: SessionInfo[],
  closeReasons: Record<string, CloseReasonStr>,
  archivedSessions: SessionInfo[],
): SpaceView {
  const liveSessionIds = liveSessionsInSpace(sessions, space.path);
  const liveSessionId = liveSessionIds[0] ?? null;
  // Input order = newest-first from `list_sessions`; NOT re-sorted.
  const storedSessionIds = historySessions
    .filter((s) => s.cwd === space.path)
    .map((s) => s.sessionId);
  // Archived sessions are view-membership only (never rendered in the
  // Space group — see `SpaceView.archivedSessionIds`).
  const archivedSessionIds = archivedSessions
    .filter((s) => s.cwd === space.path)
    .map((s) => s.sessionId);
  // The close reason of the session the user would LAND on: the live one, else
  // the head of the stored subsequence (which `list_sessions` puts there by last
  // ACTIVITY, so this is the session the boot would open, not the one created
  // last), else the head of the archived subsequence (an archived session is
  // still the space's most recent stored session — the close-reason banner must
  // not silently vanish for an archived-only space); nothing when the space has
  // no sessions.
  const newestId =
    liveSessionId ?? storedSessionIds[0] ?? archivedSessionIds[0];
  return {
    path: space.path,
    title: basenameOfPath(space.path),
    liveSessionIds,
    liveSessionId,
    storedSessionIds,
    archivedSessionIds,
    trusted: space.trusted,
    lastReason:
      newestId === undefined ? undefined : closeReasons[newestId],
  };
}

/**
 * Every **Detached session** — a stored Session whose `cwd` matches no open
 * **Space** row, so the sidebar (which files every row under a Space) cannot
 * show it at all (CONTEXT.md; ADR 0016 amendment, 2026-10-21).
 *
 * This is a VIEW PROPERTY OF THE SIDEBAR, not of the Session: it changes when
 * a Space tab is opened or closed, sets no flag, and touches no row —
 * re-opening the folder makes the row an ordinary Space row again. Closing a
 * tab *forgets* the Space and deletes nothing (ADR 0043 — `closeSpace` →
 * `removeSpace` touches no `sessions` row), so these rows are normal, not
 * corrupt. Archived and unarchived rows both qualify: an unarchived Session of
 * a closed Space has always been equally invisible.
 *
 * The match is the same raw byte-for-byte string equality every other
 * Space↔session join in this file uses (`liveSessionsInSpace`,
 * `spaceViewFor`'s `storedSessionIds`/`archivedSessionIds` filters). Do NOT
 * normalise or canonicalise the path here — a normalised key would silently
 * disagree with those sites. It is also pure string equality with no
 * filesystem access: a row whose folder was deleted from disk is simply
 * another non-match.
 *
 * Live ids are excluded (`liveSessions` is the LIVE list, the store's `sessions`
 * slice — not `historySessions`). Required, not defensive: `CloseSpaceDialog`'s
 * Close-anyway path calls `closeSpace` with no `stopSessionIds` (ADR 0043), so
 * a live session with no Space row is reachable.
 *
 * Order is the input order — `historySessions` first (stored rows in
 * `list_sessions` order, most-recently-ACTIVE first), then `archivedSessions`.
 * Do NOT "fix" this by sorting: `sortByActivity` needs loaded transcripts,
 * which the consuming Settings section has none of, and `SessionInfo` carries
 * no `createdAt` (see the ordering note above).
 */
export function detachedSessions(
  spaces: { path: string }[],
  historySessions: SessionInfo[],
  archivedSessions: SessionInfo[],
  liveSessions: SessionInfo[],
): SessionInfo[] {
  const spacePaths = new Set(spaces.map((space) => space.path));
  const liveIds = new Set(liveSessions.map((s) => s.sessionId));
  return [...historySessions, ...archivedSessions].filter(
    (s) => !spacePaths.has(s.cwd) && !liveIds.has(s.sessionId),
  );
}

interface SessionsState {
  /** Live (in-memory) sessions for this app run. */
  sessions: SessionInfo[];
  /** Stored sessions from the database that are not currently live (archived flag OFF). */
  historySessions: SessionInfo[];
  /**
   * Stored sessions with the archived flag ON (ADR 0016). STICKY: a
   * resumed archived session stays here while it is live (the Archived
   * view filters out live ids), and a closing archived session does NOT
   * land in `historySessions`. The flag changes only via
   * `archiveSession` / `unarchiveSession` (which call the backend).
   */
  archivedSessions: SessionInfo[];
  /**
   * Archive a Session (`set_session_archived(id, true)` + the id lands in
   * `archivedSessions`). Works on a STORED row and on a LIVE one: a live id is
   * additionally closed AFTER the flag and the move, so the row ends up in the
   * Archived section alone (see the action for why that order is load-bearing).
   */
  archiveSession: (sessionId: string) => Promise<void>;
  /** Unarchive a session (`archivedSessions` → `historySessions` + `set_session_archived`). */
  unarchiveSession: (sessionId: string) => Promise<void>;
  /**
   * Stop ONE Session (the sidebar row's Stop button). TWO effects, decided here
   * at CLICK time from `inTurn` — never from a render-time status, because paint
   * and click are not the same tick:
   *  - a turn in flight → `cancelSession`: the Worker is kept, so the Session is
   *    immediately re-promptable. A Session parked on a gate is HERE too (a gate
   *    is held INSIDE a tool execution, so `inTurn` is set), and reaping a Worker
   *    mid-tool is a harsher act than the button appears to be;
   *  - live and idle → `closeSession`: the Worker is reaped and `session-closed`
   *    drops the row to stored (the transcript survives — a close is a pause).
   * The race is harmless in both directions, which is what makes ONE button
   * honest: a turn that ended in between makes the cancel a documented no-op
   * (`cancel_session`'s abort does nothing when no turn is in flight) and a
   * second click closes; a turn that started in between is cancelled regardless,
   * because `close_session` sets `cancel_requested` before the Worker detach. No
   * branch of Stop can leave a turn running.
   *
   * A THIRD state exists beyond those two arms and takes the harsher one: a
   * hand-triggered `/compact` runs on the loop's CONTROL channel while the loop is
   * IDLE (see `compact_session`'s doc — it is always an idle action) and
   * deliberately never calls `beginTurn`, so `inTurn` is false and Stop CLOSES the
   * Session. The Esc chord additionally gates on `compacting` (see `ChatStream`)
   * and only ever cancels, so Stop is harsher there. That asymmetry is ACCEPTED,
   * not an oversight: a close ends the Worker and `handleSessionClosed` already
   * clears `compacting`, so nothing pins the composer. (A threshold/overflow
   * compaction runs INSIDE a turn, so it takes the cancel arm.) Adding a
   * `compacting` branch here is a decision to make, not a tidy-up to do.
   *
   * A FOURTH state reaches this action and stops nothing: a STALLED Session (its
   * Worker crashed) is still a live row. `handle_crash`
   * (`src-tauri/src/agent/session/router.rs`) marks it stalled and emits
   * `session-stalled`, but removes no `live` entry and emits no `session-closed` —
   * only the expected-exit teardown does that, and a crash's `Exited` is terminal,
   * so it never runs; `markStalled` touches only `stalled` / `compacting`, so the
   * id stays in `sessions`. Whichever arm Stop takes there is no Worker behind it:
   * `cancel_session` writes an `Abort` nobody is left to read (the result is
   * discarded), and `close_session` passes the `live` guard, reaps nothing
   * and answers `Ok(())` — so Stop RESOLVES HAVING STOPPED NOTHING and the row does
   * not move. The banner's Resume is the way out of a stalled Session. Repairing
   * that row's liveness bookkeeping is its own decision, not a tidy-up to fold in
   * here.
   *
   * A no-op for a non-live id. Rejections propagate — the row logs them.
   */
  stopSession: (sessionId: string) => Promise<void>;
  /**
   * Record a generated title on the session's row (the `session-titled`
   * push): `title` is set on whichever of the three lists holds the id, so
   * the sidebar rows and the side pane re-label without a refetch.
   */
  titleSession: (sessionId: string, title: string) => void;
  activeSessionId: string | null;
  /**
   * The selected Space's path — the top tabs' state (a Space is a tab,
   * like a browser tab): the sidebar's Sessions list shows this space's
   * sessions, and `⌘N` / `New Session` start in it. `null` when no space
   * is selected (no spaces yet, or the last one was removed).
   */
  activeSpacePath: string | null;
  /** Space bookkeeping rows (from `list_spaces` on boot; upserted by `addSpace`). */
  spaces: SpaceRow[];
  /**
   * Close reason recorded on `session-closed`, per session id (for the
   * paused banner copy). Merge-only: a reason outlives its event, so
   * keys are never deleted.
   */
  closeReasons: Record<string, CloseReasonStr>;
  /** Transcript per session id. Kept after close for history. */
  messages: Record<string, Message[]>;
  /** Config options per session id. */
  configOptions: Record<string, SessionConfigOption[]>;
  /**
   * The session's context usage per session id (the composer's
   * context-percentage display — from `context_usage_update` frames the
   * harness emits: the current context size vs the model's window).
   * `undefined` until the first frame (a fresh session, or a stored
   * session that isn't live).
   */
  contextUsage: Record<string, { used: number; window: number } | undefined>;
  /**
   * The session's in-flight compaction per session id — the value is the
   * `compaction_update` frame's `reason` (`"manual" | "threshold" |
   * "overflow"`, ADR 0045's vocabulary) while one runs, `undefined` when
   * none does (set on `active: true`, cleared on `active: false`, on
   * `handleSessionClosed` and on `markStalled`). The composer's working
   * indicator reads it (an idle compaction has no turn, so neither
   * `inTurn` nor `agentState` says "working"), and the composer locks on it
   * — hence the clears: a lingering entry would pin the composer locked on
   * a session that can no longer compact (its Worker is closed, or crashed,
   * and will never emit the closing frame). A stalled session also IGNORES an
   * `active` frame that was still in the rAF batch when it crashed — see
   * `isStaleCompactionStart`, or the lock would come straight back.
   */
  compacting: Record<string, string | undefined>;
  /** History pagination window state per session id (ADR 0066). */
  history: Record<
    string,
    {
      oldestRowId: number | null;
      hasMore: boolean;
      loadingMore: boolean;
      generation: number;
      epoch: number;
    }
  >;
  /** Load older history rows for a session (prepends to transcript). */
  loadOlderHistory: (sessionId: string) => Promise<void>;
  /** Whether a prompt turn is in flight for a session. */
  inTurn: Record<string, boolean>;
  /** Last stop reason reported for a session's turn. */
  stopReasons: Record<string, StopReason>;
  /**
   * The stalled state per session id (a Worker crash — the
   * `session-stalled` event, ADR 0025 Task 6): `null`/absent when the
   * session is healthy. Set by `markStalled`; cleared by a successful
   * `resumeSession` (the Supervisor re-spawned the Worker) and by
   * `handleSessionClosed` (a closed session cannot be stalled — the
   * banner would otherwise linger on the paused transcript).
   */
  stalled: Record<string, { at: number; crashLog: string | null } | undefined>;
  /** Mark a session stalled (the `session-stalled` event — the `StalledInfo` shape: `at` + `crashLog`). */
  markStalled: (sessionId: string, at: number, crashLog: string | null) => void;

  addSession: (info: SessionInfo) => void;
  setActiveSession: (sessionId: string | null) => void;
  /**
   * Select a Space (the tab click): it becomes `activeSpacePath` and its
   * most recent session opens — a LIVE session first (the most-recently
   * started one, the one-live-cap-lifted rule), then the newest stored
   * (input order — do NOT re-sort), then NOTHING (an empty space lands
   * on the chat's empty state). A no-op for an unknown path.
   */
  selectSpace: (path: string) => void;
  /**
   * Boot: replace the spaces list (from `list_spaces`, `lastOpenedAt`-desc).
   * If nothing is active yet, select via `autoSelectActive` (the most recent
   * space's newest session, live preferred) and load it: `autoSelectActive`
   * lands on a stored session (live ones never survive a restart), so the
   * `openSession` call loads its transcript and boot lands on CONTENT, not
   * an empty chat (no-op for live / already-loaded sessions; the fetch is
   * self-guarding against a mid-flight switch).
   */
  setSpaces: (rows: SpaceRow[]) => void;
  /**
   * Single-space upsert after a successful `start_session` (from the dialog):
   * existing row → refresh `lastOpenedAt`; missing row → append with
   * `createdAt = lastOpenedAt = Date.now()` (approximate; the next boot's
   * `list_spaces` corrects reality on the server side).
   */
  addSpace: (path: string) => void;
  /**
   * "Forget this space": `delete_space` command + local removal. Does NOT
   * touch `sessions`/`historySessions` (conversations stay stored — design
   * decision) and does NOT touch `activeSessionId` — this knows which Space is
   * gone, not what the user should be looking at next.
   *
   * RETURNS the Space the view has to fall back to when the removed one WAS
   * the selected one: the first remaining row (input order — `lastOpenedAt`
   * desc), or `null` when none remains. Removing a Space that was NOT selected
   * also answers `null` (there is nothing to fall back to), so a caller that
   * must tell "no Space left" from "a background Space went" has to remember
   * whether the removed Space was the selected one — which is exactly what
   * `closeSpace` does.
   */
  removeSpace: (path: string) => Promise<string | null>;
  /**
   * Close a Space TAB (the tab bar's ×, or a middle-click): stop the Sessions
   * the caller named, then `removeSpace`. The caller decides WHICH Sessions to
   * name — the tab bar asks the user first when the Space still has a live one
   * (`CloseSpaceDialog`), so the store carries no opinion about that; it only
   * guarantees the three consequences of a close:
   *
   * 1. Stopping is BEST-EFFORT. A `close_session` failure (the Worker already
   * gone → `UnknownSession`) is logged, not propagated: a tab that cannot be
   * closed because something is already dead is a worse bug than a session
   * that outlives its tab, which is what the "Close anyway" button is for.
   * 2. Conversations survive — `removeSpace` touches no `sessions` row (the
   * standing decision recorded on it), so re-opening the folder returns the
   * Space WITH its history.
   * 3. Closing the SELECTED tab lands the user on the neighbour it fell back
   * to, through `selectSpace` — so the chat shows that Space's most recent
   * Session (live first, else newest stored) rather than a transcript whose
   * tab is gone. The fallback path itself is `removeSpace`'s decision; this
   * reads the result instead of restating the rule. When there is NO fallback
   * (the last tab), this clears `activeSessionId` so the chat shows its empty
   * state — see the note in the implementation.
   */
  closeSpace: (path: string, stopSessionIds?: string[]) => Promise<void>;
  /**
   * Start a new Session in the SELECTED Space (`activeSpacePath`) — the one
   * flow the sidebar's "New Session" button, the collapsed rail's icon, the
   * `Sessions` header's `…` menu item and the `⌘N` chord all share.
   *
   * It lives in the store rather than in a hook closure because its callers
   * do not share a component: a root-level chord listener has to reach it
   * with nothing mounted, and the sidebar it used to live behind unmounts in
   * the Settings view.
   *
   * With NO Space to start in — nothing selected, or a selected path that is
   * no longer a Space row (a legacy cwd) — it opens the Open Space dialog
   * instead of starting anything, which is what the sidebar's button did with
   * an `undefined` view. On success it records the Session (`addSession`,
   * which SELECTS it) and the Space (`addSpace`, which selects that too).
   */
  startSessionInActiveSpace: () => Promise<void>;
  /**
   * Why the last `startSessionInActiveSpace` failed, as the command's message
   * (`null` when the last run succeeded or none has run) — what the sidebar's
   * actions-menu item shows as its `title`, so a dead menu item says why.
   * Cleared ONLY by the reset at the top of the next run: a stale message on
   * an item that has since worked would blame the wrong thing.
   */
  newSessionError: string | null;
  /**
   * Flip a space's `trusted` flag: optimistic local update first (the spaces
   * store has NO live refresh — the flag must flip immediately, not wait for
   * a round-trip), then the `set_space_trusted` command; on rejection the
   * flag rolls back to the previous value.
   */
  setSpaceTrusted: (path: string, trusted: boolean) => void;
  /** Populate the history list from `list_sessions` (boot). */
  setHistorySessions: (rows: SessionInfo[]) => void;
  /**
   * Open a session (live or stored). For a stored session whose transcript
   * is not loaded yet, fetch its history first.
   */
  openSession: (sessionId: string) => void;
  /** Delete a stored session (command + local cleanup). */
  deleteSession: (sessionId: string) => Promise<void>;
  /**
   * Resume a stored session via `session/load`. On success the session
   * becomes live; the in-memory transcript is cleared so the agent's replay
   * is the source of truth (the database keeps the persistent record).
   */
  resumeSession: (sessionId: string) => Promise<SessionInfo>;
  addUserMessage: (sessionId: string, text: string, images?: ImageRef[]) => void;
  /**
   * Append ONE Client-authored line to the transcript, shaped exactly like an
   * agent-text message (so it renders in the stream with no new renderer).
   * Used by the `/compact` **Composer command** when there is nothing to
   * compact (ADR 0044): a command produces no user row and no model call, so
   * without this the no-op would be SILENT — the user would type something and
   * the app would do nothing at all.
   *
   * It DELEGATES to `applySessionUpdate` with an `agent_message_chunk` rather
   * than touching `messages` itself, and it MUST pass a UNIQUE `messageId` per
   * call: `case "agent_message_chunk"` APPENDS to the trailing agent-text when
   * that message carries the SAME id, with NO separator, so reusing the
   * harness's `"system"` key would weld two local lines (or a local line onto
   * a real harness system message) into one run-on bubble. Hence
   * `clientSystemMessageId()` below.
   */
  addSystemLine: (sessionId: string, text: string) => void;
  beginTurn: (sessionId: string) => void;
  applyConfigOptions: (sessionId: string, options: SessionConfigOption[]) => void;
  applySessionUpdate: (sessionId: string, update: AcpSessionUpdate) => void;
  applySessionUpdates: (updates: SessionUpdateBatchItem[]) => void;
  handleSessionClosed: (sessionId: string, reason: CloseReasonStr) => void;
  turnCompleted: (sessionId: string, stopReason: StopReason) => void;
}

// Per-path queue of in-flight `set_space_trusted` commands: a toggle is
// chained after the previous one for the same path, so the DB commits in
// click order (two overlapping invokes could otherwise land in either
// order and the DB could end on the OPPOSITE value from the optimistic
// UI). The stored promise never rejects (its errors are handled below),
// so a failed toggle cannot break the chain for later ones.
const inFlightToggles = new Map<string, Promise<void>>();
// The last value known to be committed per path: a failed command rolls
// the flag back to THIS (not the value at click time — which may itself
// be an optimistic value from a still-pending toggle, and rolling two
// failures back to their per-click `previous` could settle on the wrong
// side). Seeded from the DB rows in `setSpaces` / `addSpace` (and
// pruned in `removeSpace`), so every known path has a committed
// baseline; the UI-value fallback below is a last resort only.
const committedTrusted = new Map<string, boolean>();

// One new-session command at a time. APP-GLOBAL, not per-Space: there is one
// selected Space and one new-session flow, and the thing it suppresses is two
// entry points (the button and the `⌘N` chord, or a double-click) firing in the
// same tick — a key per Space would let both through.
let newSessionInFlight = false;

// The `messageId` for a Client-authored transcript line (see `addSystemLine`).
// A MODULE-LOCAL counter, not a timestamp: two lines appended in the same
// millisecond must still differ, or `agent_message_chunk`'s same-id append
// welds them into one bubble. It is not persisted either — a reloaded
// transcript comes from the harness's own rows, and a Client line is by
// definition not one of them.
let clientMessageSeq = 0;
function clientSystemMessageId(): string {
  return `client:${++clientMessageSeq}`;
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  historySessions: [],
  archivedSessions: [],
  activeSessionId: null,
  activeSpacePath: null,
  spaces: [],
  closeReasons: {},
  messages: {},
  history: {},
  configOptions: {},
  contextUsage: {},
  compacting: {},
  inTurn: {},
  stopReasons: {},
  stalled: {},
  newSessionError: null,

  markStalled: (sessionId, at, crashLog) =>
    set((state) => ({
      stalled: { ...state.stalled, [sessionId]: { at, crashLog } },
      // A crashed Worker never emits the closing `compaction_update`, so
      // the indicator would spin forever and the composer would stay locked
      // on a session that can no longer compact.
      compacting: { ...state.compacting, [sessionId]: undefined },
    })),

  addSession: (info) =>
    set((state) => ({
      sessions: [
        ...state.sessions.filter((s) => s.sessionId !== info.sessionId),
        info,
      ],
      historySessions: state.historySessions.filter(
        (s) => s.sessionId !== info.sessionId,
      ),
      // A fresh session id never collides with an archived one (defensive
      // no-op — keeps the "live ids are out of Archived" invariant cheaply
      // at the write site).
      archivedSessions: state.archivedSessions.filter(
        (s) => s.sessionId !== info.sessionId,
      ),
      // A session that was just *started* (dialog or "new conversation")
      // is the one the user wants to look at: start flows ALWAYS switch
      // the view to it. (The live-session handling in `openSession` is
      // unchanged.)
      activeSessionId: info.sessionId,
      messages: { ...state.messages, [info.sessionId]: [] },
      configOptions: info.configOptions
        ? { ...state.configOptions, [info.sessionId]: info.configOptions }
        : state.configOptions,
    })),

  applyConfigOptions: (sessionId, options) =>
    set((state) => ({
      configOptions: { ...state.configOptions, [sessionId]: options },
    })),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setSpaces: (rows) => {
    const state = get();
    const selectedId =
      state.activeSessionId === null
        ? autoSelectActive(rows, state.sessions, state.historySessions)
        : state.activeSessionId;
    // The selected session's space (matched by `cwd` — the session's `cwd`
    // IS the Space's folder); when nothing is selected, the most recent
    // space (the FIRST row — `list_spaces` order is `lastOpenedAt` desc).
    const owner =
      selectedId === null
        ? null
        : rows.find((s) => {
            const live = state.sessions.find(
              (x) => x.sessionId === selectedId,
            );
            const stored =
              state.historySessions.find(
                (x) => x.sessionId === selectedId,
              ) ?? state.archivedSessions.find((x) => x.sessionId === selectedId);
            return (live?.cwd ?? stored?.cwd) === s.path;
          }) ?? null;
    set({
      spaces: rows,
      activeSessionId: selectedId,
      activeSpacePath: owner ? owner.path : rows[0]?.path ?? null,
    });
    // Seed the committed-trusted baseline from the DB rows: every path
    // now has a known-committed value, so a rollback target is never
    // inferred from a possibly-optimistic UI value.
    for (const s of rows) committedTrusted.set(s.path, s.trusted);
    // `autoSelectActive` lands on a stored session (live ones never survive
    // a restart): load its transcript so boot lands on content, not an
    // empty chat. (No-op for live / already-loaded sessions.)
    if (selectedId) get().openSession(selectedId);
  },

  addSpace: (path) => {
    // A fresh space is committed as `trusted: false` in the DB: seed the
    // baseline so the first toggle's rollback targets the DB value, not
    // a possibly-optimistic UI value. (A re-added space keeps its
    // existing baseline — `setSpaces` re-seeds it from the DB.)
    if (!committedTrusted.has(path)) committedTrusted.set(path, false);
    set((state) => {
      const existing = state.spaces.find((s) => s.path === path);
      const now = Date.now();
      const spaces = existing
        ? state.spaces.map((s) =>
            s.path === path ? { ...s, lastOpenedAt: now } : s,
          )
        : [...state.spaces, { path, createdAt: now, lastOpenedAt: now, trusted: false }];
      // The start flow (the dialog / `⌘N`) lands on the new space: it
      // becomes the selected one (the tab bar highlights it).
      return { spaces, activeSpacePath: path };
    });
  },

  selectSpace: (path) => {
    const state = get();
    if (!state.spaces.some((s) => s.path === path)) return;
    // Live first (the most-recently-started one — the one-live-cap-lifted
    // rule), then the newest stored (input order — do NOT re-sort), then
    // nothing (an empty space → the chat's empty state).
    const live = mostRecentLiveInSpace(state.sessions, path);
    const stored =
      state.historySessions.find((s) => s.cwd === path)?.sessionId ?? null;
    const id = live ?? stored;
    set({ activeSpacePath: path, activeSessionId: id });
    // Load the opened session's transcript (a no-op when already loaded —
    // `openSession` self-guards a mid-flight switch too).
    if (id) get().openSession(id);
  },

  removeSpace: async (path) => {
    await deleteSpaceCommand(path);
    // Prune the per-path state: a re-added space must not inherit a
    // stale rollback target (or a stale in-flight queue entry) from a
    // removed one.
    inFlightToggles.delete(path);
    committedTrusted.delete(path);
    // The fallback is decided from the SAME `set` updater that removes the row
    // (so the two can never disagree) and handed back to the caller, which is
    // the only thing that knows what the view should show next.
    let fallback: string | null = null;
    set((state) => {
      const remaining = state.spaces.filter((s) => s.path !== path);
      const wasSelected = state.activeSpacePath === path;
      fallback = wasSelected ? (remaining[0]?.path ?? null) : null;
      return {
        spaces: remaining,
        // The removed space was the selected one: fall back to the first
        // remaining space (input order — `lastOpenedAt` desc) or `null`.
        ...(wasSelected ? { activeSpacePath: fallback } : {}),
      };
    });
    return fallback;
  },

  closeSpace: async (path, stopSessionIds = []) => {
    const wasSelected = get().activeSpacePath === path;
    // All settled together: every named Session's Worker is detached (or fails
    // to be) BEFORE the Space row goes, so a rejection cannot be mistaken for
    // "the Space was never asked to close".
    const settled = await Promise.allSettled(
      stopSessionIds.map((id) => closeSessionCommand(id)),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        console.error(`failed to stop a session of ${path}:`, result.reason);
      }
    }
    const landing = await get().removeSpace(path);
    if (!wasSelected) return;
    // This close removed the Space the user was looking at, so the view has to
    // be moved by hand. A landing Space goes through `selectSpace`, which does
    // what a click on that tab would do — including loading the transcript it
    // lands on. With NO landing (the last tab) the honest surface is the chat's
    // empty state ("No active session — open a Space from the tabs above"), so
    // the session is dropped here: `removeSpace` deliberately leaves
    // `activeSessionId` alone, and leaving it pointed at a Session whose Space
    // row is gone would show a transcript the sidebar can no longer reach —
    // a transcript with no tab is not a view.
    if (landing) get().selectSpace(landing);
    else set({ activeSessionId: null });
  },

  startSessionInActiveSpace: async () => {
    const { activeSpacePath, spaces } = get();
    // No Space selected, or the selected path is a legacy cwd that is no
    // longer a Space row → route the request to the Open Space dialog.
    // Equivalent to the old `activeView === undefined` (`spaceViewFor`
    // returns `path` verbatim, so `views.find(…)` was undefined iff no row
    // carried the path). The `=== null` clause is for tsc NARROWING only — a
    // `SpaceView.path` can never be null — so do not "simplify" it away: the
    // build breaks.
    if (
      activeSpacePath === null ||
      !spaces.some((s) => s.path === activeSpacePath)
    ) {
      // BEFORE the in-flight guard: opening a dialog is not an in-flight
      // command, and a second press must still open it.
      openNewSpaceDialog();
      return;
    }
    if (newSessionInFlight) return;
    newSessionInFlight = true;
    set({ newSessionError: null });
    try {
      const info = await startSessionCommand(activeSpacePath);
      // `addSession` selects the new session (it sets `activeSessionId`);
      // `addSpace` refreshes `lastOpenedAt` and sets `activeSpacePath`.
      get().addSession(info);
      get().addSpace(info.cwd);
    } catch (err) {
      set({ newSessionError: describeIpcError(err) });
    } finally {
      newSessionInFlight = false;
    }
  },

  setSpaceTrusted: (path, trusted) => {
    // Optimistic: flip the flag now, roll back if the command fails (the
    // spaces store has no live refresh — the flag must not wait for a
    // round-trip). The rollback target is the last COMMITTED value, not
    // the UI value at click time (see `committedTrusted` above).
    const previous =
      committedTrusted.get(path) ??
      get().spaces.find((s) => s.path === path)?.trusted ??
      false;
    set((state) => ({
      spaces: state.spaces.map((s) =>
        s.path === path ? { ...s, trusted } : s,
      ),
    }));
    // Chain this command after the previous one for the path (the
    // per-path queue above) so the DB commits in click order. The stored
    // `done` promise never rejects (its errors are handled below), so a
    // failed toggle cannot break the chain for later ones.
    const run = () =>
      inFlightToggles
        .get(path)
        ?.then(() => setSpaceTrustedCommand(path, trusted))
        ?? setSpaceTrustedCommand(path, trusted);
    const done = run().then(
      () => {
        // Gate on the path still being present in the store: a success
        // that lands AFTER a `removeSpace` (its prune) must not
        // re-insert a baseline entry — a re-added space would then keep
        // the stale value over its fresh `trusted: false` DB row. (The
        // rejection handler below only maps `state.spaces` — a no-op for
        // a removed path — and never writes `committedTrusted`.)
        if (get().spaces.some((s) => s.path === path)) {
          committedTrusted.set(path, trusted);
        }
      },
      (err) => {
        console.error(`Failed to set trusted for ${path}:`, err);
        set((state) => ({
          spaces: state.spaces.map((s) =>
            s.path === path ? { ...s, trusted: previous } : s,
          ),
        }));
      },
    );
    inFlightToggles.set(path, done);
  },

  setHistorySessions: (rows) =>
    set((state) => {
      // Split by the archived flag; live ids go in NEITHER list (they are
      // already in `sessions`). Boot-only: do NOT re-run this mid-run
      // (re-splitting would drop sticky live+archived entries and silently
      // un-archive on the next close).
      const liveIds = new Set(state.sessions.map((s) => s.sessionId));
      const archived = rows.filter(
        (r) => r.archived && !liveIds.has(r.sessionId),
      );
      const history = rows.filter(
        (r) => !r.archived && !liveIds.has(r.sessionId),
      );
      return { historySessions: history, archivedSessions: archived };
    }),

  archiveSession: async (sessionId) => {
    // No-op when the id is in NONE of the lists — a Session this app run has
    // never heard of gets no flag and no close. A LIVE id IS accepted (the
    // sidebar offers Archive on a live row too): the stored row is what
    // `historySessions` holds, but the live row is the same Session, and the
    // backend flag does not care which list the id came from. (Re-checked
    // inside `set` below as well — the entry may have been deleted or moved
    // mid-await, and a double click may have landed the move already.)
    const before = get();
    const entry =
      before.historySessions.find((s) => s.sessionId === sessionId) ??
      before.sessions.find((s) => s.sessionId === sessionId);
    if (!entry) return;
    // Captured BEFORE the `await`, deliberately: this is the question "was the
    // row I clicked on live at CLICK time?", and the sticky-live race below
    // turns on the answer. A resume that wins the mid-await race makes the id
    // live by the time the `set` runs, but the user clicked a STORED row — that
    // Session stays live and archived, and nobody asked to close it.
    const wasLive = before.sessions.some((s) => s.sessionId === sessionId);
    await setSessionArchivedCommand(sessionId, true);
    set((state) => {
      // Re-validate against the CURRENT state: a concurrent delete (or a
      // prior move of the same id) must leave no ghost row, and the
      // dedupe below keeps the id in `archivedSessions` exactly once.
      // Distinguish "gone" (in NEITHER list — deleted) from "live" (in
      // `sessions` — a resume landed mid-await and removed the id from
      // `historySessions`): the DB flag is now `true`, so a live id must
      // land in `archivedSessions` (the sticky semantics) — not no-op. The row
      // appended is `entry` — a snapshot taken at CLICK time, from whichever
      // list held the id then (the LIVE `SessionInfo`, or the click-time STORED
      // copy) — so its `.archived` is only how that row last came to be:
      // `false` on a fresh start, the STORED flag on a resume (the Rust
      // `ResumeCtx` carries it), the boot-time read on a stored row. It is in
      // general NOT a trustworthy copy of what this action just committed:
      // these lists are read by MEMBERSHIP, which is the source of truth, and
      // the `.archived` field on a moved row must not be read off them.
      const inHistory = state.historySessions.some(
        (s) => s.sessionId === sessionId,
      );
      const isLive = state.sessions.some(
        (s) => s.sessionId === sessionId,
      );
      if (!inHistory && !isLive) return state;
      return {
        // Only remove from `historySessions` when it is still there (a
        // resume already removed it — the "move" is then just "ensure it
        // is in `archivedSessions`").
        historySessions: inHistory
          ? state.historySessions.filter((s) => s.sessionId !== sessionId)
          : state.historySessions,
        // Append, preserving order (deduped — a concurrent move of the
        // same id already landed it here).
        archivedSessions: [
          ...state.archivedSessions.filter((s) => s.sessionId !== sessionId),
          entry,
        ],
      };
    });
    if (wasLive) {
      // Archive means "put this away", and a live Session is not away while its
      // Worker runs. The order is the whole design: the flag is committed and the
      // lists moved FIRST, so when `session-closed` lands, `handleSessionClosed`'s
      // sticky guard (it refuses to file a closing archived Session under
      // `historySessions`) is what lands the row in `archivedSessions` alone.
      // Close-first would race the async event against the store move and flicker
      // the row through the Space group.
      // Best-effort like `closeSpace`: a mid-await delete makes this
      // `UnknownSession`, and the DB flag has already done Archive's one durable
      // job — hiding it from the next boot — so a failure is logged, not thrown,
      // and the flag is NOT rolled back. A STALLED Session's close no-ops the same
      // way `stopSession`'s does — silently and successfully, no Worker and no
      // `session-closed` — so the flag lands while the row stays visible in its Space
      // group until the next boot.
      await closeSessionCommand(sessionId).catch((err) => {
        console.error(`failed to close the archived session ${sessionId}:`, err);
      });
    }
  },

  unarchiveSession: async (sessionId) => {
    // The mirror of `archiveSession`: no-op when the entry is not in the
    // archived list. (Re-checked inside `set` below as well — the entry
    // may have been deleted or moved mid-await, and a double click may
    // have landed the move already.)
    const entry = get().archivedSessions.find(
      (s) => s.sessionId === sessionId,
    );
    if (!entry) return;
    await setSessionArchivedCommand(sessionId, false);
    set((state) => {
      // Re-validate against the CURRENT state: a concurrent delete (or a
      // prior move of the same id) must leave no ghost row, and the
      // dedupe below keeps the id in `historySessions` exactly once.
      // Distinguish "gone" (in NEITHER list — deleted) from "live" (in
      // `sessions` — a resume landed mid-await): a live id must NOT be
      // appended to `historySessions` (it would be in BOTH lists at once
      // — a duplicate sidebar row) — `handleSessionClosed` lands it in
      // `historySessions` on close (and only when not archived, which it
      // no longer is).
      const inArchived = state.archivedSessions.some(
        (s) => s.sessionId === sessionId,
      );
      const isLive = state.sessions.some(
        (s) => s.sessionId === sessionId,
      );
      if (!inArchived && !isLive) return state;
      return {
        archivedSessions: state.archivedSessions.filter(
          (s) => s.sessionId !== sessionId,
        ),
        // Append, preserving order (deduped — a concurrent move of the
        // same id already landed it here). Skipped while live — see
        // above.
        historySessions: isLive
          ? state.historySessions
          : [
              ...state.historySessions.filter(
                (s) => s.sessionId !== sessionId,
              ),
              entry,
            ],
      };
    });
  },

  stopSession: async (sessionId) => {
    // The whole decision is a CLICK-time read of `inTurn` (see the
    // declaration): a render-time status would be a tick stale by the time the
    // button's handler runs, and the two commands are not interchangeable. A
    // non-live id — stored or archived — has no Worker to stop, so it gets
    // neither command.
    const state = get();
    if (!state.sessions.some((s) => s.sessionId === sessionId)) return;
    if (state.inTurn[sessionId]) {
      await cancelSessionCommand(sessionId);
      return;
    }
    // Unlike `archiveSession`'s best-effort close, these rejections PROPAGATE:
    // Stop has no durable effect behind it, so a Stop that reported success
    // while the Worker kept running would be a lie the row cannot correct.
    await closeSessionCommand(sessionId);
  },

  titleSession: (sessionId, title) =>
    set((state) => {
      // The id lives in ONE of the three lists — `sessions` for a live
      // session (the push is the title's ONLY source there: the boot
      // `list_sessions` fetch predates it), `historySessions` /
      // `archivedSessions` for a stored one (its row carries the title the
      // database already has, and a later write must not leave a stale copy
      // behind). A RESUMED archived session sits in TWO of them at once (the
      // sticky membership), so EVERY list that holds the id is rewritten —
      // its two copies may not disagree. A list without the id keeps its
      // SAME array (no re-render for its rows), and an id in NONE of them (a
      // session deleted while the title was in flight) is a no-op: no ghost
      // row is appended.
      const renamed = (rows: SessionInfo[]) =>
        rows.some((s) => s.sessionId === sessionId)
          ? rows.map((s) =>
              s.sessionId === sessionId ? { ...s, title } : s,
            )
          : rows;
      return {
        sessions: renamed(state.sessions),
        historySessions: renamed(state.historySessions),
        archivedSessions: renamed(state.archivedSessions),
      };
    }),

  openSession: (sessionId) => {
    // The opened session's space (matched by `cwd` — live, stored, OR
    // archived membership) becomes the selected one (the tab bar follows
    // the session); a session whose cwd is no Space (a legacy row) leaves
    // the selection alone.
    const state = get();
    const owner = state.spaces.find((s) => {
      const live = state.sessions.find((x) => x.sessionId === sessionId);
      const stored =
        state.historySessions.find((x) => x.sessionId === sessionId) ??
        state.archivedSessions.find((x) => x.sessionId === sessionId);
      return (live?.cwd ?? stored?.cwd) === s.path;
    });
    set({
      activeSessionId: sessionId,
      ...(owner ? { activeSpacePath: owner.path } : {}),
    });
    if (state.messages[sessionId]) return; // already loaded
    void (async () => {
      try {
        const page = await loadHistory(sessionId, { limit: INITIAL_HISTORY_PAGE });
        // The user may have switched away while the fetch was in flight.
        if (get().activeSessionId !== sessionId) return;
        // Seed the board FIRST, then write the transcript (ADR 0042 no-pop rule)
        if (
          Array.isArray(page.todos) &&
          page.todos.length > 0 &&
          !(sessionId in useInteractive.getState().todos)
        ) {
          useInteractive
            .getState()
            .applyTodoUpdate(sessionId, { todos: page.todos as TodoItem[] });
        }
        const messages = page.rows.flatMap(rowToMessages);
        const prevHist = get().history[sessionId];
        const prevGen = prevHist?.generation ?? 0;
        const prevEpoch = prevHist?.epoch ?? 0;
        set((state) => ({
          messages: { ...state.messages, [sessionId]: messages },
          history: {
            ...state.history,
            [sessionId]: {
              oldestRowId: page.rows[0]?.id ?? null,
              hasMore: page.hasMore,
              loadingMore: false,
              generation: prevGen + 1,
              epoch: prevEpoch,
            },
          },
        }));
      } catch (err) {
        console.error(`failed to load history for ${sessionId}`, err);
      }
    })();
  },

  deleteSession: async (sessionId) => {
    await deleteSessionCommand(sessionId);
    useInteractive.getState().applyTodoClear(sessionId);
    // A DELETE has no `onSessionClosed` to fan out through, so the queue is
    // dropped here: the Session is unreachable, its rows never render, `forget`
    // never runs, and without this its queued attachments' object URLs are held
    // by nothing but released by nothing for the process lifetime (ADR 0069).
    useQueuedPrompts.getState().clearSession(sessionId);
    set((state) => {
      const { [sessionId]: _gone, ...rest } = state.messages;
      const { [sessionId]: _goneHist, ...restHist } = state.history;
      return {
        sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
        historySessions: state.historySessions.filter(
          (s) => s.sessionId !== sessionId,
        ),
        archivedSessions: state.archivedSessions.filter(
          (s) => s.sessionId !== sessionId,
        ),
        activeSessionId:
          state.activeSessionId === sessionId ? null : state.activeSessionId,
        messages: rest,
        history: restHist,
      };
    });
  },

  resumeSession: async (sessionId) => {
    const state = get();
    // Search ALL THREE lists: an archived session must be resumable from
    // the Archived section (otherwise this throws `unknown session`).
    const session = [
      ...state.sessions,
      ...state.historySessions,
      ...state.archivedSessions,
    ].find((s) => s.sessionId === sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const info = await resumeSessionCommand(sessionId, session.cwd);
    // STICKY: `archivedSessions` is deliberately NOT touched — a resumed
    // archived session stays in it while live (the Archived view filters
    // out live ids).
    set((st) => ({
      sessions: [
        ...st.sessions.filter((s) => s.sessionId !== sessionId),
        info,
      ],
      historySessions: st.historySessions.filter(
        (s) => s.sessionId !== sessionId,
      ),
      activeSessionId: st.activeSessionId ?? sessionId,
      // A successful resume clears the stalled state (the Supervisor
      // re-spawned the Worker — the banner hides; the `session-stalled`
      // bookkeeping is backend-side, this is the frontend's view).
      stalled: { ...st.stalled, [sessionId]: undefined },
      configOptions: info.configOptions
        ? { ...st.configOptions, [sessionId]: info.configOptions }
        : st.configOptions,
    }));
    // ACP `session/load` does not re-stream the transcript — reload it from
    // the persisted history so the pane shows the conversation on resume.
    void (async () => {
      try {
        // Invalidate in-flight older-page loads at the start of resume
        // without bumping `generation` (Virtuoso remount key).
        // Keep `loadingMore: true` while the resume reload is pending so
        // subsequent `loadOlderHistory` calls refuse to start.
        set((st) => {
          const prev = st.history[sessionId];
          const prevEpoch = prev?.epoch ?? 0;
          return {
            history: {
              ...st.history,
              [sessionId]: prev
                ? { ...prev, epoch: prevEpoch + 1, loadingMore: true }
                : {
                    oldestRowId: null,
                    hasMore: false,
                    loadingMore: true,
                    generation: 0,
                    epoch: 1,
                  },
            },
          };
        });
        // The reload is fire-and-forget (NOT awaited by the caller): a
        // `send()` on the resumed session adds the user message to
        // `messages[sessionId]` WHILE the reload is in flight. Applying the
        // reloaded rows verbatim would WIPE that message (the reload
        // predates its persistence — the user message is `record_message`d
        // by `send_prompt`, which runs after the reload starts). Merge
        // instead: the reloaded rows, then any messages added after the
        // reload started, appended after.
        const prior = get().messages[sessionId] ?? [];
        const page = await loadHistory(sessionId, { limit: INITIAL_HISTORY_PAGE });
        // The user may have switched away while the fetch was in flight.
        if (get().activeSessionId !== sessionId) {
          set((st) => {
            const entry = st.history[sessionId];
            if (!entry) return st;
            return {
              history: {
                ...st.history,
                [sessionId]: { ...entry, loadingMore: false },
              },
            };
          });
          return;
        }
        const reloaded = page.rows.flatMap(rowToMessages);
        // WHAT ARRIVED WHILE WE WERE LOADING — selected by IDENTITY, never by
        // position (ADR 0050). `slice(prior.length)` assumed the array could
        // only grow across the await; a Retraction (ADR 0048) REMOVES a
        // message, which shifts every index left and silently dropped a prompt
        // the user sent in the window — and dropped the retry that reused a
        // retracted id, and anything prepended. Identity is `mergeDedupeKey` +
        // the message's own `at`, COUNTED: two identical messages in the same
        // millisecond are two messages, and the second is the new one. Where
        // identity cannot decide we KEEP the message — a duplicated bubble
        // beats a lost prompt. Three duplications are accepted, one per mutator
        // of the window: a live thought (its persisted key is `{stamp}:m1#1`, so
        // it can never match its own row), a pre-existing message the reducer
        // MUTATES in place (`applySessionUpdate`'s same-`messageId` append, or a
        // `tool_call_update` rewriting a card), and a `pending` tool call that
        // `handleSessionClosed`'s `finalizeSessionMessages` flips to `failed`
        // mid-window. `mergeDedupeKey` is content-inclusive — `|<text>` for
        // text, `|<title>|<status>` for a tool card — so a changed message is
        // simply no longer "in the snapshot"; all three replace the old rule's
        // silent truncation of the streamed tail.
        const current = get().messages[sessionId] ?? [];
        let added: Message[];
        if (current === prior) {
          // Nothing landed during the window — the overwhelmingly common case.
          // Every store write that adds or removes a message REPLACES the
          // array (the reducer's arms spread, `addUserMessage` spreads,
          // `finalizeSessionMessages` maps, and the batch reducer stores only
          // what the pure reducer returned — nothing pushes or pops in place),
          // so reference equality proves it. This fast path skips the identity
          // pass and its multiset counting over the LIVE snapshot, and that is
          // all it skips: `mergeDedupeKey`'s `user` case concatenates every
          // attachment's FULL base64 `data`, so keying the live snapshot of an
          // attachment-heavy session on every resume would allocate a copy of
          // every attachment to conclude that nothing changed. The RELOADED
          // side is untouched by this branch — the dedupe pass below still keys
          // every reloaded row, and `rowToMessages` has already hydrated each
          // persisted `user` row with its full base64 `data`, so an
          // attachment-heavy resume still allocates a copy of every attachment,
          // just from the other side: that O(n) allocation lives there, not
          // here.
          //
          // The premise is that no write mutates a transcript in place, so
          // `current === prior` proves nothing landed — which is exactly what
          // SILENCE takes, and why it is cheap rather than what it avoids. One
          // write shape breaks it: a `tool_call_update` whose content changes
          // nothing still returns a fresh array, so it re-keys the slow path.
          // Correct (the identity pass selects nothing) but not O(1).
          added = [];
        } else {
          const priorCount = new Map<string, number>();
          for (const m of prior) {
            const k = `${mergeDedupeKey(m)}|${m.at}`;
            priorCount.set(k, (priorCount.get(k) ?? 0) + 1);
          }
          const seenNow = new Map<string, number>();
          added = current.filter((m) => {
            const k = `${mergeDedupeKey(m)}|${m.at}`;
            const nth = (seenNow.get(k) ?? 0) + 1;
            seenNow.set(k, nth);
            return nth > (priorCount.get(k) ?? 0);
          });
        }
        // DEDUPE the merge: `send_prompt`'s `record_message` can commit
        // the new user message BEFORE the history query reads — then the
        // reloaded rows INCLUDE it while `added` still holds its local
        // copy, and appending verbatim would render the prompt TWICE
        // (attachments included). Drop an `added` message already present
        // in the reloaded rows on the SAME `mergeDedupeKey` the identity pass
        // above uses — so the match is id AND content together
        // (`tool-call|<id>|<title>|<status>`, `agent-text|<messageId>|<text>`),
        // and for a `user` message (NO id on either side) `user|<text>|<images>`
        // — but ONLY when the matching reloaded row is NEWER-OR-EQUAL by
        // timestamp. Content alone is ambiguous because user messages have
        // no stable id: the matching reloaded row is either the SAME
        // message committed after the local copy was created (committed-
        // before-read: the DB commit's `createdAt` >= the local `at` =
        // `Date.now()` at `addUserMessage` time → dedup, no duplicate)
        // or an OLDER re-sent prompt (the reloaded row predates the new
        // message's creation time → the new turn is NOT a duplicate and
        // must be kept). Equal timestamps dedup (the safe direction).
        const reloadedKeys = new Set<string>();
        const reloadedUserAt = new Map<string, number>();
        for (const m of reloaded) {
          const key = mergeDedupeKey(m);
          if (m.kind === "user") {
            // Several reloaded rows can share a content key (the prompt was
            // re-sent earlier): the LATEST one is the only one that could
            // be the just-committed message.
            reloadedUserAt.set(key, Math.max(reloadedUserAt.get(key) ?? 0, m.at));
          } else {
            reloadedKeys.add(key);
          }
        }
        const fresh = added.filter((m) => {
          const key = mergeDedupeKey(m);
          if (m.kind === "user") {
            const reloadedAt = reloadedUserAt.get(key);
            return reloadedAt === undefined || reloadedAt < m.at;
          }
          return !reloadedKeys.has(key);
        });
        if (
          Array.isArray(page.todos) &&
          page.todos.length > 0 &&
          !(sessionId in useInteractive.getState().todos)
        ) {
          useInteractive
            .getState()
            .applyTodoUpdate(sessionId, { todos: page.todos as TodoItem[] });
        }
        set((st) => {
          const prevHist = st.history[sessionId];
          const prevGen = prevHist?.generation ?? 0;
          const currentEpoch = prevHist?.epoch ?? 0;
          return {
            messages: { ...st.messages, [sessionId]: [...reloaded, ...fresh] },
            history: {
              ...st.history,
              [sessionId]: {
                oldestRowId: page.rows[0]?.id ?? null,
                hasMore: page.hasMore,
                loadingMore: false,
                generation: prevGen + 1,
                epoch: currentEpoch,
              },
            },
          };
        });
      } catch (err) {
        console.error(`failed to load history for ${sessionId}`, err);
        set((st) => {
          const entry = st.history[sessionId];
          if (!entry) return st;
          return {
            history: {
              ...st.history,
              [sessionId]: { ...entry, loadingMore: false },
            },
          };
        });
      }
    })();
    return info;
  },

  loadOlderHistory: async (sessionId: string) => {
    const sessionHistory = get().history[sessionId];
    if (
      !sessionHistory ||
      !sessionHistory.hasMore ||
      sessionHistory.loadingMore ||
      sessionHistory.oldestRowId === null
    ) {
      return;
    }
    const gen = sessionHistory.generation;
    const ep = sessionHistory.epoch;
    set((state) => ({
      history: {
        ...state.history,
        [sessionId]: { ...state.history[sessionId]!, loadingMore: true },
      },
    }));
    try {
      const page = await loadHistory(sessionId, {
        limit: OLDER_HISTORY_PAGE,
        beforeId: sessionHistory.oldestRowId,
      });
      set((state) => {
        // Bail if session resumed (generation or epoch bumped) or deleted in the interim
        const current = state.history[sessionId];
        if (
          !current ||
          current.generation !== gen ||
          current.epoch !== ep
        ) {
          return state;
        }
        const currentMessages = state.messages[sessionId] ?? [];
        const prepended = page.rows.flatMap(rowToMessages);
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...prepended, ...currentMessages],
          },
          history: {
            ...state.history,
            [sessionId]: {
              oldestRowId: page.rows[0]?.id ?? sessionHistory.oldestRowId,
              hasMore: page.hasMore,
              loadingMore: false,
              generation: gen,
              epoch: ep,
            },
          },
        };
      });
    } catch (err) {
      console.error(`failed to load older history for ${sessionId}`, err);
      set((state) => {
        const current = state.history[sessionId];
        if (
          !current ||
          current.generation !== gen ||
          current.epoch !== ep
        ) {
          return state;
        }
        return {
          history: {
            ...state.history,
            [sessionId]: { ...current, loadingMore: false },
          },
        };
      });
    }
  },

  addUserMessage: (sessionId, text, images) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] ?? []),
          {
            kind: "user" as const,
            text,
            at: Date.now(),
            ...(images && images.length > 0 ? { images } : {}),
          },
        ],
      },
    })),

  beginTurn: (sessionId) =>
    set((state) => ({ inTurn: { ...state.inTurn, [sessionId]: true } })),

  // A Client-authored line, appended through the SAME reducer the harness's own
  // frames go through — see the interface doc for why the `messageId` has to be
  // unique per call. Deliberately NOT a `user` message: a **Composer command**
  // is consumed, it is neither a prompt nor a row the Agent will ever see.
  addSystemLine: (sessionId, text) =>
    get().applySessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId: clientSystemMessageId(),
    }),

  applySessionUpdate: (sessionId, update) =>
    set((state) => {
      const messages = applySessionUpdate(
        state.messages[sessionId] ?? [],
        update,
        Date.now(),
      );

      let configOptions = state.configOptions;
      if (update.sessionUpdate === "config_option_update") {
        configOptions = { ...state.configOptions, [sessionId]: update.configOptions };
      }

      let contextUsage = state.contextUsage;
      if (update.sessionUpdate === "context_usage_update") {
        contextUsage = {
          ...state.contextUsage,
          [sessionId]: { used: update.usedTokens, window: update.windowTokens },
        };
      }

      // The compaction STATE frame (ADR 0045): the reason while one runs,
      // `undefined` when it ends. `undefined` under a spread rather than
      // `delete` — the store's convention for a cleared per-session flag
      // (see `stalled`), and cheap: the key keeps its slot.
      let compacting = state.compacting;
      if (update.sessionUpdate === "compaction_update") {
        // The stall guard (see `isStaleCompactionStart`): a frame that was in
        // flight when the Worker crashed must not undo the clear `markStalled`
        // already made.
        if (!isStaleCompactionStart(update, state.stalled[sessionId] !== undefined)) {
          compacting = {
            ...state.compacting,
            [sessionId]: update.active ? update.reason : undefined,
          };
        }
      }

      return {
        messages: {
          ...state.messages,
          [sessionId]: messages,
        },
        configOptions,
        contextUsage,
        compacting,
      };
    }),

  // Batch form of `applySessionUpdate`: applies a frame's worth of updates in
  // ONE `setState` (one React render per frame, not one per event — see
  // `createBatchedSessionUpdate`). Grouped per session in arrival order; the
  // pure reducer returns the SAME reference for no-op updates, so a batch that
  // changes nothing returns the same state object and notifies nobody.
  applySessionUpdates: (updates) =>
    set((state) => {
      if (updates.length === 0) return state;
      const now = Date.now();

      const order: string[] = [];
      const bySession = new Map<string, AcpSessionUpdate[]>();
      for (const { sessionId, update } of updates) {
        const list = bySession.get(sessionId);
        if (list) {
          list.push(update);
        } else {
          bySession.set(sessionId, [update]);
          order.push(sessionId);
        }
      }

      let messages = state.messages;
      let messagesChanged = false;
      let configOptions = state.configOptions;
      let configChanged = false;
      let contextUsage = state.contextUsage;
      let contextChanged = false;
      let compacting = state.compacting;
      let compactingChanged = false;
      for (const sessionId of order) {
        const sessionUpdates = bySession.get(sessionId)!;
        let sessionMessages = messages[sessionId] ?? [];
        let sessionChanged = false;
        for (const update of sessionUpdates) {
          const next = applySessionUpdate(sessionMessages, update, now);
          if (next !== sessionMessages) sessionChanged = true;
          sessionMessages = next;
          if (update.sessionUpdate === "config_option_update") {
            configOptions = { ...configOptions, [sessionId]: update.configOptions };
            configChanged = true;
          }
          // Last-wins within the batch: a later frame in the same batch
          // replaces the earlier one (the compaction re-estimate lands
          // after the pre-compaction `Usage` frames).
          if (update.sessionUpdate === "context_usage_update") {
            contextUsage = {
              ...contextUsage,
              [sessionId]: { used: update.usedTokens, window: update.windowTokens },
            };
            contextChanged = true;
          }
          // The compaction STATE frame. It carries NO message content, so the
          // pure reducer below reports no change for it — without this own
          // sentinel the early `return state` at the bottom of this reducer
          // would silently DISCARD the frame and the indicator would never
          // appear. Last-wins within the batch, which is what makes a
          // `Skipped` compaction's two frames (active, then inactive — they
          // can coalesce into ONE rAF batch) end cleared rather than stuck on.
          // An ACTIVE frame for a session that is already STALLED is dropped —
          // see `isStaleCompactionStart`.
          if (
            update.sessionUpdate === "compaction_update" &&
            !isStaleCompactionStart(update, state.stalled[sessionId] !== undefined)
          ) {
            compacting = {
              ...compacting,
              [sessionId]: update.active ? update.reason : undefined,
            };
            compactingChanged = true;
          }
        }
        if (sessionChanged) {
          if (!messagesChanged) messages = { ...messages };
          messages[sessionId] = sessionMessages;
          messagesChanged = true;
        }
      }

      if (
        !messagesChanged &&
        !configChanged &&
        !contextChanged &&
        !compactingChanged
      )
        return state;
      return {
        ...state,
        ...(messagesChanged ? { messages } : {}),
        ...(configChanged ? { configOptions } : {}),
        ...(contextChanged ? { contextUsage } : {}),
        ...(compactingChanged ? { compacting } : {}),
      };
    }),

  handleSessionClosed: (sessionId, reason) => {
    const closedInfo = useSessions
      .getState()
      .sessions.find((s) => s.sessionId === sessionId);
    set((state) => {
      return {
        sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
        // The session remains in the database: it moves to the history
        // list — UNLESS it is archived (sticky, ADR 0016): a closing
        // archived session stays ONLY in `archivedSessions`.
        historySessions:
          closedInfo &&
          !state.archivedSessions.some((s) => s.sessionId === sessionId)
            ? [
                ...state.historySessions.filter(
                  (s) => s.sessionId !== sessionId,
                ),
                closedInfo,
              ]
            : state.historySessions,
        // A close is a PAUSE, not a discard: the conversation moves to the
        // history list but STAYS the displayed one, so `ChatStream` renders
        // its stored/paused banner instead of the `No active session` empty
        // state. (Required for the Task 6 `Pause` behavior.)
        activeSessionId: state.activeSessionId,
        // Merge-only: a close reason outlives its event (never delete keys).
        closeReasons: { ...state.closeReasons, [sessionId]: reason },
        // The config options + context usage STAY (a pause, not a
        // discard): the last known values populate the stored session's
        // bottom bar — the selectors render disabled; a resume's
        // `config_option_update` / `context_usage_update` frames refresh
        // them. (The row's own `configOptions` / `contextUsage` — the Rust
        // `list_sessions` shape, persisted on every frame — is the
        // fallback when the store's map has no entry: a session never
        // live in this app session.)
        messages: {
          ...state.messages,
          [sessionId]: finalizeSessionMessages(state.messages[sessionId] ?? []),
        },
        inTurn: { ...state.inTurn, [sessionId]: false },
        // A closed session cannot be stalled (the banner would linger on
        // the paused transcript — a close supersedes the crash).
        stalled: { ...state.stalled, [sessionId]: undefined },
        // Nor compacting: a close ends the Worker, so the closing
        // `compaction_update` may never arrive, and a lingering entry would
        // pin `composerLocked` on a session that can no longer compact.
        // (`contextUsage` above deliberately SURVIVES the close — a pause,
        // not a discard, pinned by its own test; this flag is not state the
        // bottom bar reads, so it does not.)
        compacting: { ...state.compacting, [sessionId]: undefined },
      };
    });
  },

  turnCompleted: (sessionId, stopReason) =>
    set((state) => ({
      inTurn: { ...state.inTurn, [sessionId]: false },
      stopReasons: { ...state.stopReasons, [sessionId]: stopReason },
    })),
}));
