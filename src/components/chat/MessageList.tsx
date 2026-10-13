import type { ReactNode, RefObject } from "react";
import MessageBubble from "../MessageBubble";
import ChangesGroupCard from "../ChangesGroupCard";
import PermissionPrompt from "../PermissionPrompt";
import AskQuestionCard from "../AskQuestionCard";
import FileSummaryCard from "../FileSummaryCard";
import type { RenderUnit } from "../../lib/toolGroups";
import type { PermissionPromptData } from "../../store/permissions";
import type { InteractiveRequestData } from "../../store/interactive";
import type { ChildGate } from "../../hooks/useChildGates";
import { childGateKey, isInlineChildGate } from "../../hooks/useChildGates";
import type { StopReason } from "../../lib/tauri";

/**
 * The transcript's VERTICAL RHYTHM (ZCode's model: rows carry no padding and
 * the CONTAINER owns the spacing — its work-item block is a `gap-4` flex
 * column and the turn's blocks ride a `gap-5`, never per-row `py-*`).
 *
 * Base gap (`gap-3`, 12px) on the scroll container: the prose ↔ `Thought`
 * rhythm, unchanged. `TRANSCRIPT_BREATHING_GAP` is then added to a row whose
 * IMMEDIATE NEIGHBOUR is a tool row — so a tool call gets 12+16 = 28px of air
 * on each side while thinking and chat stay as close together as they were.
 * It is a property of the PAIR (applied to whichever side is second), which
 * is what keeps a run of tool calls at a steady 28px instead of alternating.
 *
 * THE DELTA HAS TO BE LEGIBLE. A real turn interleaves `Ran`/`Thought`
 * one-after-another, so ALMOST EVERY pair touches a tool row and the base gap
 * rarely shows — the breathing value is effectively the transcript's rhythm.
 * At `mt-2` (20px against a 12px base) the column read as uniform and still
 * cramped; 28px is the point where the tool rows visibly separate.
 */
const TRANSCRIPT_BREATHING_GAP = "mt-4";

/** A unit that reads as a TOOL ROW (a tool call, or a folded `Changes` group). */
function isToolUnit(unit: RenderUnit): boolean {
  return unit.kind === "changes-group" || unit.message.kind === "tool-call";
}

/**
 * The transcript scroll region: the empty-state hint, the render-unit loop
 * (the `kind`→component dispatch, each unit wrapped in the rhythm row above),
 * the stacked permission/`ask` cards, the CHILD gates lifted into this
 * Session's transcript, the file summary card, and the stop-reason line.
 *
 * Props-only by design — it MUST NOT read the stores (every value is derived
 * in `ChatStream` and passed down). That includes `childGates`: this component
 * must not call `useChildGates` itself, because the partition it renders is
 * defined by WHO ASKS (`ChatStream`'s `activeSessionId`) and a second reader
 * would be a second opinion on which gates belong here.
 *
 * CHILD GATES (`childGates`): a Subagent session's `ask` and Permission prompt
 * render HERE — at the bottom of the PARENT's transcript, under the parent's
 * own cards — when the parent is the ACTIVE session, because that is the
 * conversation the user is already reading. `↳ <agentName>` names whose
 * question each is. The child's `confirm` / `password` are deliberately NOT
 * rendered here even though they arrive in the same list: `SudoConfirmModal`
 * and `SudoPasswordModal` are Radix `Dialog`s — modal by nature — and inlining
 * a `Dialog` into a scrolling transcript is a different change than this one.
 * They stay in `SubagentModals` for EVERY child, active parent or not. Do not
 * "complete" this by rendering them: that would move a gate out of the ONE
 * site that owns it. The kinds that DO render here are one predicate —
 * `isInlineChildGate`, which `ChatStream` also counts for its auto-scroll dep —
 * so the scroll can never follow a row this component would not draw.
 *
 * The child-gate row also stops `Escape` (non-dismissibly, exactly like the
 * overlay's panel) — see the comment on that wrapper: without it an Esc landing
 * on the row cancels the PARENT's turn from `ChatStream`'s window-level
 * listener, and a lifted card no longer takes focus to protect itself.
 *
 * ACCEPTED (and pre-existing for the parent's own cards below): while a sudo
 * `Dialog` is open, Radix's `hideOthers` + `disableOutsidePointerEvents` make
 * the WHOLE rest of the document inert, so these INLINE child cards are
 * unanswerable too — not just the overlay's panel (`App.test.tsx` pins the
 * overlay's half). Nothing is lost by it: the gate stays mounted and pending,
 * and is answerable again the moment the `Dialog` settles, which is the prompt
 * the user was already being shown.
 */
export default function MessageList({
  scrollRef,
  units,
  messageCount,
  activeSessionId,
  inTurn,
  askRequests,
  prompts,
  stackedAskRequests,
  childGates,
  hasPendingRequest,
  workingOrInTurn,
  agentState,
  turnDiffs,
  stopReason,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  units: RenderUnit[];
  messageCount: number;
  activeSessionId: string;
  inTurn: boolean;
  askRequests: InteractiveRequestData[];
  prompts: PermissionPromptData[];
  stackedAskRequests: InteractiveRequestData[];
  /** This Session's children's gates (`ChatStream` derives them — this
   * component reads no store). Only `ask`/`permission` render here; see the
   * component doc for why the sudo kinds do not. */
  childGates: ChildGate[];
  hasPendingRequest: boolean;
  workingOrInTurn: boolean;
  agentState: "working" | "idle" | "blocked" | undefined;
  turnDiffs: { path: string; patch: string }[];
  stopReason: StopReason | undefined;
}) {
  return (
    <div
      ref={scrollRef}
      data-testid="transcript-scroll"
      className="flex-1 flex flex-col gap-3 overflow-y-auto p-4"
    >
      {/* The request cards and the working/blocked/stop-reason lines
          render UNCONDITIONALLY (regardless of the transcript's
          length — a native agent that asks at session start, or the
          window between `openSession` and `loadHistory` hydration,
          must not have its request swallowed by the hint). */}
      {messageCount === 0 &&
        !hasPendingRequest &&
        !workingOrInTurn &&
        agentState !== "blocked" && (
          <div className="flex h-full items-center justify-center">
            <p className="text-ui-base text-foreground-subtlest">
              Send a prompt to start
            </p>
          </div>
        )}
      {units.map((unit, i) => {
        // The PAIR's breathing room (see `TRANSCRIPT_BREATHING_GAP`): this row
        // gets it when the row ABOVE it is a tool row or this row IS one, and
        // it is not the first row (the container's `p-4` is its air). Applied
        // to the wrapper — never to the row itself, which stays padding-free.
        const breathes =
          i > 0 && (isToolUnit(units[i - 1]!) || isToolUnit(unit));
        const wrap = (child: ReactNode) => (
          <div
            key={`${activeSessionId}:${i}`}
            className={
              breathes
                ? `flex flex-col ${TRANSCRIPT_BREATHING_GAP}`
                : "flex flex-col"
            }
          >
            {child}
          </div>
        );
        if (unit.kind === "changes-group") {
          return wrap(
            <ChangesGroupCard messages={unit.messages} />,
          );
        }
        const message = unit.message;
        // The key is session-scoped: switching sessions must not reuse the
        // previous session's component at the same index (a `Reasoning`
        // would otherwise carry over expanded state, duration, and timers).
        // The `AskQuestionCard` replaces the pending `ask`
        // `ToolCallCard` (correlated via `(source, toolCallId)`/
        // `requestId` — a `main` ask whose `toolCallId` matches this
        // tool-call message).
        if (message.kind === "tool-call") {
          const anchored = askRequests.find(
            (r) => r.source === "main" && r.toolCallId === message.id,
          );
          if (anchored) {
            return wrap(
              <AskQuestionCard
                sessionId={activeSessionId}
                requestId={anchored.requestId}
              />,
            );
          }
        }
        return wrap(
          <MessageBubble
            message={message}
            isStreaming={
              message.kind === "agent-thought" && inTurn && i === units.length - 1
            }
            sessionId={activeSessionId}
          />,
        );
      })}
      {prompts.map((prompt) => (
        <PermissionPrompt
          key={prompt.requestId}
          sessionId={activeSessionId}
          requestId={prompt.requestId}
        />
      ))}
      {/* Stacked interactive `ask` cards (one per pending request, arrival
          order — concurrent asks stack vertically in the stream). */}
      {stackedAskRequests.map((r) => (
        <AskQuestionCard
          key={r.requestId}
          sessionId={activeSessionId}
          requestId={r.requestId}
        />
      ))}
      {/* This Session's CHILDREN's gates (see the component doc): below the
          parent's own cards, above the file summary. `confirm`/`password` are
          filtered out with `isInlineChildGate` — the SAME predicate `ChatStream`
          counts inline gates with for its auto-scroll dep, so the count can
          never include a row this component would not draw. `ChatStream` derives
          the full gate list for its own reasons and this component renders the
          two kinds that are inline by nature. */}
      {childGates.filter(isInlineChildGate).map((gate) => (
          // Keyed by `childGateKey` (child id + request id), imported — never
          // re-derived here: a child's `requestId` is the model's tool-call id,
          // which some gateways reuse per response, so a bare `requestId`
          // collides across children and silently drops one card.
          <div
            key={childGateKey(gate)}
            // Escape is stopped here with NO answering action (the row is not
            // dismissible), mirroring `SubagentModals`' panel: `ChatStream`'s
            // window-level `keydown` sends `session/cancel` while a turn is in
            // flight, `PermissionPrompt` has no Esc handler at all, and a lifted
            // `AskQuestionCard` stops propagation only once focus is INSIDE it —
            // which `autoFocus={false}` now makes the normal case. Without this
            // stop an Esc meant for the row would cancel the PARENT's turn while
            // the child's question sits unanswered in this very transcript. It
            // does not break a card's own Esc: React runs the innermost handler
            // first, so a card that answers Esc never reaches this one.
            onKeyDown={(e) => {
              if (e.key === "Escape") e.stopPropagation();
            }}
            className="flex flex-col"
          >
            {/* The chip lives on the WRAPPER, never inside the card: both card
                components stay parent/child-agnostic and are reused unchanged
                by the main chat (the overlay labels them the same way). */}
            <p className="mb-1 text-ui-xs text-foreground-subtle">
              ↳ {gate.agentName}
            </p>
            {gate.kind === "ask" ? (
              <AskQuestionCard
                sessionId={gate.childSessionId}
                requestId={gate.requestId}
                autoFocus={false}
              />
            ) : (
              <PermissionPrompt
                sessionId={gate.childSessionId}
                requestId={gate.requestId}
              />
            )}
          </div>
        ))}
      {turnDiffs.length > 0 && <FileSummaryCard diffs={turnDiffs} />}
      {!inTurn && stopReason && stopReason !== "end_turn" && (
        <p className="text-ui-sm text-foreground-subtlest">
          Turn ended: {stopReason}
        </p>
      )}
    </div>
  );
}
