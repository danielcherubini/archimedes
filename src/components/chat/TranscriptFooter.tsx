import PermissionPrompt from "../PermissionPrompt";
import AskQuestionCard from "../AskQuestionCard";
import FileSummaryCard from "../FileSummaryCard";
import type { PermissionPromptData } from "../../store/permissions";
import type { InteractiveRequestData } from "../../store/interactive";
import type { ChildGate } from "../../hooks/useChildGates";
import { childGateKey, isInlineChildGate } from "../../hooks/useChildGates";
import type { StopReason } from "../../lib/tauri";

export interface TranscriptFooterProps {
  activeSessionId: string;
  prompts: PermissionPromptData[];
  stackedAskRequests: InteractiveRequestData[];
  childGates: ChildGate[];
  turnDiffs: { path: string; patch: string }[];
  stopReason: StopReason | undefined;
  inTurn: boolean;
}

export function transcriptFooterIsEmpty(props: TranscriptFooterProps): boolean {
  return (
    props.prompts.length === 0 &&
    props.stackedAskRequests.length === 0 &&
    props.childGates.filter(isInlineChildGate).length === 0 &&
    props.turnDiffs.length === 0 &&
    (props.inTurn || !props.stopReason || props.stopReason === "end_turn")
  );
}

export default function TranscriptFooter({
  activeSessionId,
  prompts,
  stackedAskRequests,
  childGates,
  turnDiffs,
  stopReason,
  inTurn,
}: TranscriptFooterProps) {
  return (
    <>
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
          data-testid="gate-row"
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
    </>
  );
}
