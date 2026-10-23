/**
 * The two commands that ANSWER a gate — the two shapes of "the Agent is paused,
 * waiting for the user": `session/request_permission` (a permission prompt) and
 * the delegated interactive request (`ask` / `confirm` / `password`).
 *
 * They sit together because the components that call them do too —
 * `InlineGateRow` renders `PermissionPrompt` or `AskQuestionCard` — and because
 * both push a user decision back into an in-flight turn. The `listen*` side of
 * the same two gates is in `../events.ts`; the pairing is by DOMAIN, and the
 * command/listen split is kept because an `invoke` has no business in the events
 * module.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  InteractiveResponseDto,
  PermissionOutcome,
} from "../types";


export async function respondPermission(
  sessionId: string,
  requestId: string,
  outcome: PermissionOutcome,
): Promise<void> {
  return invoke("respond_permission", { sessionId, requestId, outcome });
}


/**
 * Answer an interactive request. The invoke key is `result` (the Rust command's
 * `result: serde_json::Value` param — Tauri's camelCase↔snake_case handles
 * `sessionId`/`requestId` but will not alias `response`↔`result`). The
 * `result` is written into the response frame verbatim (no wrapper).
 */
export async function respondInteractiveRequest(
  sessionId: string,
  requestId: string,
  result: InteractiveResponseDto,
): Promise<void> {
  return invoke("respond_interactive_request", { sessionId, requestId, result });
}
