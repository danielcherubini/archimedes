import { useRef, useEffect, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import MessageBubble from "../MessageBubble";
import ChangesGroupCard from "../ChangesGroupCard";
import AskQuestionCard from "../AskQuestionCard";
import TranscriptFooter, { transcriptFooterIsEmpty } from "./TranscriptFooter";
import EmptyStateFilm from "./EmptyStateFilm";
import { Spinner } from "../ui/spinner";
import type { RenderUnit } from "../../lib/toolGroups";
import type { PermissionPromptData } from "../../store/permissions";
import type { InteractiveRequestData } from "../../store/interactive";
import type { ChildGate } from "../../hooks/useChildGates";
import { isInlineChildGate } from "../../hooks/useChildGates";
import type { StopReason } from "../../lib/tauri";
import { unitKeys } from "../../lib/transcript/unitKeys";
import { useFirstItemIndex } from "../../hooks/useFirstItemIndex";

/** A unit that reads as a TOOL ROW (a tool call, or a folded `Changes` group). */
function isToolUnit(unit: RenderUnit): boolean {
  return unit.kind === "changes-group" || unit.message.kind === "tool-call";
}

interface VirtuosoContext {
  loadingMore: boolean;
  hasMore: boolean;
  activeSessionId: string;
  prompts: PermissionPromptData[];
  stackedAskRequests: InteractiveRequestData[];
  childGates: ChildGate[];
  turnDiffs: { path: string; patch: string }[];
  stopReason: StopReason | undefined;
  inTurn: boolean;
}

function TranscriptHeader({ context }: { context?: VirtuosoContext }) {
  if (!context) return null;
  return (
    <div className="pt-4">
      <div className="flex h-6 items-center justify-center">
        {context.loadingMore ? (
          <Spinner className="size-4 text-foreground-subtle" />
        ) : !context.hasMore ? (
          <p className="text-ui-sm text-foreground-subtlest">
            Start of conversation
          </p>
        ) : null}
      </div>
    </div>
  );
}

function VirtuosoFooterWrapper({ context }: { context?: VirtuosoContext }) {
  if (!context) return null;
  const isEmpty = transcriptFooterIsEmpty(context);
  return (
    <div className={isEmpty ? "px-4 pb-4" : "px-4 pb-4 pt-3 flex flex-col gap-3"}>
      <TranscriptFooter
        activeSessionId={context.activeSessionId}
        prompts={context.prompts}
        stackedAskRequests={context.stackedAskRequests}
        childGates={context.childGates}
        turnDiffs={context.turnDiffs}
        stopReason={context.stopReason}
        inTurn={context.inTurn}
      />
    </div>
  );
}

export interface MessageListProps {
  units: RenderUnit[];
  messageCount?: number;
  activeSessionId: string;
  inTurn: boolean;
  askRequests: InteractiveRequestData[];
  prompts: PermissionPromptData[];
  stackedAskRequests: InteractiveRequestData[];
  childGates: ChildGate[];
  hasPendingRequest: boolean;
  workingOrInTurn: boolean;
  agentState: "working" | "idle" | "blocked" | undefined;
  turnDiffs: { path: string; patch: string }[];
  stopReason: StopReason | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  generation: number;
  onStartReached: () => void;
  /**
   * The empty-session film's setting (`AppSettings.emptyStateAnimation`),
   * threaded by `ChatStream` from the settings store.
   *
   * OPTIONAL, defaulting to `"off"` — deliberately, and load-bearing. Every
   * pre-existing render of this component in the suite (and every one that
   * intends no film) omits it, and `"off"` makes `EmptyStateFilm` answer
   * synchronously with the pre-feature text line: no WebGL probe, no dynamic
   * `import()` of the scene chunk, no engine. A REQUIRED prop would have to be
   * added to all of those call sites, and a `null` default would make "the app
   * default, animated" the default of a component nobody asked for it in.
   *
   * Read as a prop and NEVER from the settings store: this component subscribes
   * to nothing today, and a store subscription would construct the real film in
   * every existing jsdom test that renders an empty transcript, pulling a WebGL
   * render loop (and, one careless value import away, `three`) into the graph of
   * tests that never intended to touch it. `ChatStream` already consumes the
   * store for `spinnerStyle`, so the reactive path exists above and a Settings
   * change still lands without a reload.
   */
  emptyStateAnimation?: string | null;
}

/**
 * The transcript scroll region: the empty-state hint, the render-unit loop
 * (the `kind`→component dispatch, each unit wrapped in the rhythm row above),
 * the stacked permission/`ask` cards, the CHILD gates lifted into this
 * Session's transcript, the file summary card, and the stop-reason line.
 *
 * Rendered using `react-virtuoso` when non-empty, and a plain flex column
 * when empty.
 */
export default function MessageList({
  units,
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
  hasMore,
  loadingMore,
  generation,
  onStartReached,
  emptyStateAnimation = "off",
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevLastUserKeyRef = useRef<string | null>(null);
  // Read whether Virtuoso is mounted through a ref so unit prepend/append does not trigger the gate effect.
  const hasUnitsRef = useRef(units.length > 0);
  hasUnitsRef.current = units.length > 0;

  // Reset atBottomRef when the Virtuoso instance remounts (session switch or generation bump).
  useEffect(() => {
    atBottomRef.current = true;
  }, [activeSessionId, generation]);

  // Reset prevLastUserKeyRef on session change to avoid a stale match across sessions.
  useEffect(() => {
    prevLastUserKeyRef.current = null;
  }, [activeSessionId]);

  const keys = unitKeys(units);
  const firstItemIndex = useFirstItemIndex(units, activeSessionId, generation);

  const inlineGateCount = childGates.filter(isInlineChildGate).length;
  // Effect 1: Gate cards — scrolls new permission/ask/child gates into view; reacts to gate counts only (not units) so it never fights scroll position.
  useEffect(() => {
    if (hasUnitsRef.current) {
      const id = requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      });
      return () => cancelAnimationFrame(id);
    } else if (emptyRef.current) {
      emptyRef.current.scrollTop = emptyRef.current.scrollHeight;
    }
  }, [prompts.length, stackedAskRequests.length, inlineGateCount]);

  const lastUnit = units[units.length - 1];
  let tailSig = "";
  if (lastUnit) {
    if (lastUnit.kind === "changes-group") {
      tailSig = `changes:${lastUnit.messages.length}`;
    } else {
      const m = lastUnit.message;
      if (m.kind === "agent-text" || m.kind === "agent-thought") {
        tailSig = `${m.kind}:${m.text.length}`;
      } else if (m.kind === "tool-call") {
        tailSig = `tool:${m.id}:${m.status}`;
      } else {
        tailSig = m.kind;
      }
    }
  }
  // Effect 2: Streaming tail growth — follows in-place reply deltas; guarded by atBottomRef so it never pulls a user who scrolled up.
  useEffect(() => {
    if (atBottomRef.current) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    }
  }, [tailSig]);

  // Effect 3: Send detection — unconditionally jumps to bottom when the user sends a message; fires only on new trailing user units.
  useEffect(() => {
    if (lastUnit && lastUnit.kind === "single" && lastUnit.message.kind === "user") {
      const key = `${lastUnit.message.at}:${lastUnit.message.text}`;
      if (prevLastUserKeyRef.current !== key) {
        prevLastUserKeyRef.current = key;
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      }
    }
  }, [lastUnit]);

  if (units.length === 0) {
    return (
      <div
        ref={emptyRef}
        data-testid="transcript-scroll"
        className="relative flex-1 flex flex-col gap-3 overflow-y-auto overflow-x-hidden min-w-0 max-w-full p-4"
      >
        {/* The empty-session film, in the hint's old slot and under the hint's
            old condition (UNCHANGED — these three terms are also what the 7
            `queryByText("Send a prompt to start").toBeNull()` assertions cover,
            and `TranscriptFooter` below must keep rendering so a permission or
            `ask` gate stays visible in an empty session). `relative` on the
            wrapper is what the film's `absolute inset-0` layer positions
            against, so the film never adds content height to this `overflow-y-auto`
            region and the `emptyRef` effect above still owns `scrollTop`. */}
        {!hasPendingRequest && !workingOrInTurn && agentState !== "blocked" && (
          <EmptyStateFilm setting={emptyStateAnimation} />
        )}
        <TranscriptFooter
          activeSessionId={activeSessionId}
          prompts={prompts}
          stackedAskRequests={stackedAskRequests}
          childGates={childGates}
          turnDiffs={turnDiffs}
          stopReason={stopReason}
          inTurn={inTurn}
        />
      </div>
    );
  }

  return (
    <Virtuoso
      key={`${activeSessionId}:${generation}`}
      ref={virtuosoRef}
      data-testid="transcript-scroll"
      data={units}
      firstItemIndex={firstItemIndex}
      computeItemKey={(index) => `${activeSessionId}:${keys[index - firstItemIndex] ?? index}`}
      initialTopMostItemIndex={{ index: "LAST", align: "end" }}
      alignToBottom
      followOutput={(atBottom) => (atBottom ? "auto" : false)}
      atBottomThreshold={80}
      atBottomStateChange={(b) => {
        atBottomRef.current = b;
      }}
      startReached={onStartReached}
      increaseViewportBy={{ top: 600, bottom: 600 }}
      className="flex-1 min-w-0 max-w-full overflow-x-hidden"
      context={{
        loadingMore,
        hasMore,
        activeSessionId,
        prompts,
        stackedAskRequests,
        childGates,
        turnDiffs,
        stopReason,
        inTurn,
      }}
      components={{
        Header: TranscriptHeader,
        Footer: VirtuosoFooterWrapper,
      }}
      itemContent={(index, unit) => {
        if (!unit) return null;
        const i = index - firstItemIndex;
        const prev = units[i - 1];
        const breathes = i > 0 && prev !== undefined && (isToolUnit(prev) || isToolUnit(unit));
        const paddingClass = i === 0 ? "" : breathes ? "pt-7" : "pt-3";
        const wrap = (child: ReactNode) => (
          <div
            data-testid="message-row"
            className={`flex min-w-0 max-w-full flex-col px-4 ${paddingClass}`.trim()}
          >
            {child}
          </div>
        );
        if (unit.kind === "changes-group") {
          return wrap(<ChangesGroupCard messages={unit.messages} />);
        }
        const message = unit.message;
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
      }}
    />
  );
}
