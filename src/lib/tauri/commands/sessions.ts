/**
 * Session commands: the live-turn lifecycle (`start_session` … `cancel_session`)
 * and the stored-session reads (`list_sessions`, `load_history`, archive,
 * delete).
 *
 * NOTHING outside `src/lib/tauri/` imports this file — `src/lib/tauri.ts` is the
 * only public surface, and `src/lib/tauriBarrel.test.ts` enforces it. The reason
 * is the test seam: 35 test files `vi.mock("@/lib/tauri")` BY MODULE PATH, and a
 * direct import here would silently escape every one of those mocks (green, and
 * hitting real IPC). Read the barrel's header before adding an import.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ImageRef } from "../../chatAttachments";
import type {
  HistoryPage,
  SessionConfigOption,
  SessionInfo,
  StopReason,
} from "../types";


// ---------------------------------------------------------------------------
// Commands (invoke)
// ---------------------------------------------------------------------------

export async function startSession(cwd: string): Promise<SessionInfo> {
  return invoke<SessionInfo>("start_session", { cwd });
}


export async function sendPrompt(
  sessionId: string,
  text: string,
  images?: ImageRef[],
): Promise<StopReason> {
  return invoke<StopReason>("send_prompt", { sessionId, text, images: images ?? [] });
}


/**
 * Compact a session NOW — the `/compact` **Composer command** (ADR 0044), the
 * one control command the Client consumes instead of sending. The command never
 * reaches the Agent, so this invoke is its only route in.
 *
 * `false` is the NOT-LIVE answer, not an error: compacting a stored (non-live)
 * session is a no-op by design, and the composer turns this one boolean into
 * its whole one-line explanation. `true` means the frame was actually written.
 *
 * `instructions` are the user's extra summary instructions (`/compact <args>`),
 * `null` when the command stood alone — passed through VERBATIM, and
 * deliberately NOT normalized the way `sendPrompt` one line above normalizes
 * its `images` (`?? []`): the Rust parameter is `Option<String>`, so `""` is a
 * different instruction to the harness than `None`.
 */
export async function compactSession(
  sessionId: string,
  instructions: string | null,
): Promise<boolean> {
  return invoke<boolean>("compact_session", { sessionId, instructions });
}


export async function closeSession(sessionId: string): Promise<void> {
  return invoke("close_session", { sessionId });
}


export async function resumeSession(
  sessionId: string,
  cwd: string,
): Promise<SessionInfo> {
  return invoke<SessionInfo>("resume_session", { sessionId, cwd });
}


/** Cancel the session's in-flight prompt turn (Esc). The agent resolves the open prompt with `stopReason: "cancelled"`. */
export async function cancelSession(sessionId: string): Promise<void> {
  return invoke("cancel_session", { sessionId });
}


/** Set a session config option (model / thinking level); returns the agent's updated `configOptions`. */
export async function setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
): Promise<SessionConfigOption[]> {
  return invoke<SessionConfigOption[]>("set_session_config_option", {
    sessionId,
    configId,
    value,
  });
}


// ---------------------------------------------------------------------------
// History (SQLite) + settings commands
// ---------------------------------------------------------------------------

/** All stored sessions, newest first. `includeArchived` includes the archived rows (their `archived` flag is set); `undefined` → the Rust default `false`. */
export async function listSessions(
  includeArchived?: boolean,
): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("list_sessions", { includeArchived });
}


/** A stored session's transcript page (ADR 0073). */
export async function loadHistory(
  sessionId: string,
  opts?: { limit?: number; beforeId?: number },
): Promise<HistoryPage> {
  return invoke<HistoryPage>("load_history", {
    sessionId,
    limit: opts?.limit ?? null,
    beforeId: opts?.beforeId ?? null,
  });
}


/** Delete a stored session (its messages cascade). */
export async function deleteSession(sessionId: string): Promise<void> {
  return invoke("delete_session", { sessionId });
}


/** Archive (or unarchive) a stored session (ADR 0016): sets the `sessions.archived` flag; the transcript is NOT touched. `false` when no row matched. */
export async function setSessionArchived(
  sessionId: string,
  archived: boolean,
): Promise<boolean> {
  return invoke("set_session_archived", { sessionId, archived });
}
