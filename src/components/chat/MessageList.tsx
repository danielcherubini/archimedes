import { useRef, useEffect, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChevronDown } from "lucide-react";
import MessageBubble from "../MessageBubble";
import ChangesGroupCard from "../ChangesGroupCard";
import AskQuestionCard, { isAskRowRenderable } from "../AskQuestionCard";
import TranscriptFooter, { transcriptFooterIsEmpty } from "./TranscriptFooter";
import EmptyStateFilm from "./EmptyStateFilm";
import { Spinner } from "../ui/spinner";
import { cn } from "../lib/utils";
import type { RenderUnit } from "../../lib/toolGroups";
import type { PermissionPromptData } from "../../store/permissions";
import { useInteractive } from "../../store/interactive";
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
            Start of session
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

const BOTTOM_THRESHOLD = 80;

/**
 * Checks if an event occurred inside a nested scrollable element (e.g. code
 * block, diff viewer, or tool call output) that absorbs the scroll, rather
 * than the main transcript scroller.
 */
function isInsideNestedScrollable(
  target: EventTarget | null,
  scroller: HTMLElement | null,
  deltaY?: number,
  deltaX?: number,
): boolean {
  let curr: Element | null =
    target instanceof Element ? target : ((target as Node)?.parentElement ?? null);
  if (!scroller || !curr || !scroller.contains(curr)) return false;

  while (curr && curr !== scroller && curr !== document.body) {
    const isClassScrollable =
      typeof curr.className === "string" &&
      /\boverflow-(y-)?(auto|scroll)\b/.test(curr.className);
    const style = window.getComputedStyle(curr);
    const isStyleScrollableY =
      style.overflowY === "auto" ||
      style.overflowY === "scroll" ||
      style.overflow === "auto" ||
      style.overflow === "scroll";
    const isStyleScrollableX =
      style.overflowX === "auto" || style.overflowX === "scroll";

    if (isClassScrollable || isStyleScrollableY) {
      if (curr.clientHeight > 0 && curr.scrollHeight > curr.clientHeight) {
        return true;
      }
      if (
        curr.clientHeight === 0 &&
        (isClassScrollable ||
          (curr instanceof HTMLElement &&
            (curr.style.overflowY === "auto" || curr.style.overflowY === "scroll")))
      ) {
        return true;
      }
    }

    if (
      (isStyleScrollableX ||
        (typeof curr.className === "string" &&
          /\boverflow-x-(auto|scroll)\b/.test(curr.className))) &&
      deltaX !== undefined &&
      Math.abs(deltaX) > Math.abs(deltaY ?? 0)
    ) {
      return true;
    }
    curr = curr.parentElement;
  }
  return false;
}

/**
 * Checks if the transcript is shorter than the viewport (all content fits,
 * so the scroller cannot physically scroll).
 */
function isTranscriptShort(scroller: HTMLElement | null): boolean {
  if (!scroller) return false;
  return scroller.clientHeight > 0 && scroller.scrollHeight <= scroller.clientHeight;
}

interface TranscriptScrollerProps {
  units: RenderUnit[];
  activeSessionId: string;
  generation: number;
  inTurn: boolean;
  askRequests: InteractiveRequestData[];
  prompts: PermissionPromptData[];
  stackedAskRequests: InteractiveRequestData[];
  childGates: ChildGate[];
  turnDiffs: { path: string; patch: string }[];
  stopReason: StopReason | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  onStartReached: () => void;
}

/**
 * The non-empty transcript scroll region rendered using `react-virtuoso`.
 *
 * ## Lock & Follow Model
 *
 * 1. **Geometry At-Bottom vs. User Bottom-Lock Intent**:
 *    - `isAtBottomRef` tracks geometric proximity to the transcript bottom
 *      as reported by Virtuoso's `atBottomStateChange` (using `BOTTOM_THRESHOLD`).
 *    - `isBottomLocked` represents the user's intent to stay pinned to the bottom.
 *
 * 2. **Re-Locking by Geometry**:
 *    - Whenever `atBottomStateChange(true)` fires (user scrolls back to bottom,
 *      or programmatic scroll reaches bottom), `isBottomLocked` is set to `true`
 *      and any floating "Scroll to bottom" button is automatically dismissed.
 *
 * 3. **Unlocking by User Intent Only**:
 *    - Bottom-lock is ONLY released (`isBottomLocked = false`) when deliberate
 *      user scroll-up gestures occur (wheel up `deltaY < 0`, touch drag down,
 *      or upward scroll position decrease).
 *    - Short transcripts (content shorter than the viewport) cannot scroll and
 *      will not falsely unlock.
 *    - Gestures inside nested scrollable elements (e.g. code blocks, diff views)
 *      are ignored so scrolling an inner container does not unlock the transcript.
 *    - Gestures that remain within the bottom threshold do not unlock.
 *
 * 4. **Streaming Tail Follow**:
 *    - While `isBottomLocked` is `true`, Effect 2 follows streaming tail changes
 *      (`tailSig`) by issuing `scrollToIndex({ index: "LAST", align: "end" })`.
 *      Rapid tail updates that momentarily trigger `atBottomStateChange(false)`
 *      before layout lands do NOT disengage `isBottomLocked`.
 *
 * 5. **Accessible Focus Handoff**:
 *    - Clicking the floating button re-locks, scrolls to bottom, and explicitly
 *      focuses the scroller container before unmounting so focus does not drop
 *      to `<body>`.
 */
function TranscriptScroller({
  units,
  activeSessionId,
  generation,
  inTurn,
  askRequests,
  prompts,
  stackedAskRequests,
  childGates,
  turnDiffs,
  stopReason,
  hasMore,
  loadingMore,
  onStartReached,
}: TranscriptScrollerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const [isBottomLocked, setIsBottomLocked] = useState(true);
  const isBottomLockedRef = useRef(true);
  isBottomLockedRef.current = isBottomLocked;

  const isAtBottomRef = useRef(true);

  const getScrollerElement = (): HTMLElement | null => {
    return (
      scrollerElementRef.current ??
      containerRef.current?.querySelector<HTMLElement>(
        '[data-testid="virtuoso-stand-in"], [data-testid="transcript-scroll"]',
      ) ??
      containerRef.current
    );
  };

  const prevLastUserKeyRef = useRef<string | null>(null);
  const keys = unitKeys(units);
  const firstItemIndex = useFirstItemIndex(units, activeSessionId, generation);

  const inlineGateCount = childGates.filter(isInlineChildGate).length;
  // Effect 1: Gate cards — scrolls new permission/ask/child gates into view; reacts to gate counts only (not units) so it never fights scroll position.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    });
    return () => cancelAnimationFrame(id);
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

  // Effect 2: Streaming tail growth — follows in-place reply deltas; guarded by isBottomLockedRef so it never pulls a user who scrolled up.
  const prevTailSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevTailSigRef.current === null) {
      prevTailSigRef.current = tailSig;
      return;
    }
    if (prevTailSigRef.current !== tailSig) {
      prevTailSigRef.current = tailSig;
      if (isBottomLockedRef.current) {
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      }
    }
  }, [tailSig]);

  // Effect 3: Send detection — unconditionally jumps to bottom when the user sends a message; fires only on new trailing user units.
  useEffect(() => {
    if (lastUnit && lastUnit.kind === "single" && lastUnit.message.kind === "user") {
      const key = `${lastUnit.message.at}:${lastUnit.message.text}`;
      if (prevLastUserKeyRef.current !== key) {
        prevLastUserKeyRef.current = key;
        setIsBottomLocked(true);
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
      }
    }
  }, [lastUnit]);

  const handleScrollToBottom = () => {
    const scroller = getScrollerElement();
    if (scroller && typeof scroller.focus === "function") {
      if (!scroller.hasAttribute("tabindex")) {
        scroller.setAttribute("tabindex", "-1");
      }
      scroller.focus();
    }
    setIsBottomLocked(true);
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!isBottomLockedRef.current) return;
    if (e.deltaY < 0) {
      const scroller = getScrollerElement();
      if (isTranscriptShort(scroller)) return;
      if (isInsideNestedScrollable(e.target, scroller, e.deltaY, e.deltaX)) return;

      if (scroller && scroller.clientHeight > 0) {
        const distanceFromBottom =
          scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
        if (
          !isAtBottomRef.current ||
          distanceFromBottom > BOTTOM_THRESHOLD ||
          distanceFromBottom - e.deltaY > BOTTOM_THRESHOLD
        ) {
          setIsBottomLocked(false);
        }
      } else {
        setIsBottomLocked(false);
      }
    }
  };

  const touchStartRef = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = e.touches[0]?.clientY ?? null;
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isBottomLockedRef.current) return;
    if (touchStartRef.current !== null) {
      const currentY = e.touches[0]?.clientY ?? touchStartRef.current;
      const deltaY = currentY - touchStartRef.current;
      if (deltaY > 5) {
        const scroller = getScrollerElement();
        if (isTranscriptShort(scroller)) return;
        if (isInsideNestedScrollable(e.target, scroller, -deltaY)) return;

        if (scroller && scroller.clientHeight > 0) {
          const distanceFromBottom =
            scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
          if (
            !isAtBottomRef.current ||
            distanceFromBottom > BOTTOM_THRESHOLD ||
            distanceFromBottom + deltaY > BOTTOM_THRESHOLD
          ) {
            setIsBottomLocked(false);
          }
        } else {
          setIsBottomLocked(false);
        }
      }
    }
  };
  const handleTouchEnd = () => {
    touchStartRef.current = null;
  };

  const prevScrollTopRef = useRef<number | null>(null);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const currentScrollTop = e.currentTarget.scrollTop;
    if (!isBottomLockedRef.current) {
      prevScrollTopRef.current = currentScrollTop;
      return;
    }
    if (prevScrollTopRef.current !== null && currentScrollTop < prevScrollTopRef.current) {
      const scroller = e.currentTarget;
      if (!isTranscriptShort(scroller)) {
        const distanceFromBottom =
          scroller.scrollHeight - (currentScrollTop + scroller.clientHeight);
        if (distanceFromBottom > BOTTOM_THRESHOLD) {
          setIsBottomLocked(false);
        }
      }
    }
    prevScrollTopRef.current = currentScrollTop;
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 min-h-0 min-w-0 max-w-full flex flex-col"
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(el) => {
          scrollerElementRef.current = el instanceof HTMLElement ? el : null;
        }}
        tabIndex={-1}
        data-testid="transcript-scroll"
        data={units}
        firstItemIndex={firstItemIndex}
        computeItemKey={(index) => `${activeSessionId}:${keys[index - firstItemIndex] ?? index}`}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        alignToBottom
        followOutput={(atBottom) => (isBottomLocked && atBottom ? "auto" : false)}
        atBottomThreshold={BOTTOM_THRESHOLD}
        atBottomStateChange={(atBottom) => {
          isAtBottomRef.current = atBottom;
          if (atBottom) {
            setIsBottomLocked(true);
          }
        }}
        onScroll={handleScroll}
        startReached={onStartReached}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        className="flex-1 min-w-0 max-w-full overflow-x-hidden focus:outline-none"
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
          // The row wrapper. `paddingClass` is `""` for the FIRST unit, so the old
          // hand-rolled version needed `.trim()` to keep a trailing space out of
          // the attribute. `cn` supplies that for free — `clsx` drops the empty
          // string and `tailwind-merge` emits no gap — which is why the `.trim()`
          // is gone rather than carried over. `MessageList.gap.test.tsx:123` reads
          // this list through `split(/\s+/).filter((c) => /^pt-/)`; a stray leading
          // or trailing space would arrive there as an empty token and the filter
          // would still be right, but the attribute would be dirty for a human
          // reading devtools, so it is asserted below that nothing regressed.
          const wrap = (child: ReactNode) => {
            // DEFENCE-IN-DEPTH, NOT THE FIX. Every call site hands `wrap` a JSX
            // ELEMENT, so this arm never fires today — a child component's own
            // `return null` happens during render, after `wrap` has already built
            // the row (that is exactly why the issue #86 guard lives at the
            // anchored call site, below). This exists only for a FUTURE call site
            // that passes a literal `null`/`undefined` and would otherwise get a
            // padded empty row.
            if (child === null || child === undefined) return null;
            return (
              <div
                data-testid="message-row"
                className={cn("flex min-w-0 max-w-full flex-col px-4", paddingClass)}
              >
                {child}
              </div>
            );
          };
          if (unit.kind === "changes-group") {
            return wrap(<ChangesGroupCard messages={unit.messages} />);
          }
          const message = unit.message;
          if (message.kind === "tool-call") {
            const anchored = askRequests.find(
              (r) => r.source === "main" && r.toolCallId === message.id,
            );
            if (anchored) {
              // THE FIX for issue #86 ("empty/blank instead of hidden"), and it
              // lives HERE at the call site rather than inside `wrap`, because
              // `wrap` receives a JSX ELEMENT: `<AskQuestionCard …/>` is a
              // non-null object and the card's own `return null` happens LATER,
              // during render, where `wrap` cannot observe it. A `child === null`
              // guard in `wrap` alone would compile, pass review, and change
              // nothing. So the row evaluates the SAME predicate the card uses
              // (`isAskRowRenderable` — one rule, two callers; a duplicated
              // condition here is the bug returning) on the request it looks up
              // exactly as the card does (`requests[sessionId]` by `requestId`),
              // and emits NO row when it has nothing to draw: a dismissed request
              // (the anchor's `tool-call` message outlives the answer) or a
              // zero-question one would otherwise stay a padded `px-4` +
              // `pt-3`/`pt-7` div holding nothing.
              //
              // READ ON DEMAND, not subscribed — this component subscribes to
              // nothing today (see the `emptyStateAnimation` doc) and the store
              // read is only ever needed at this moment. It cannot be stale: the
              // `askRequests` prop is derived from THIS SAME store slice by
              // `ChatStream`, so any change to the session's request list
              // re-renders here and re-runs this lookup.
              const request = (
                useInteractive.getState().requests[activeSessionId] ?? []
              ).find((r) => r.requestId === anchored.requestId);
              if (!isAskRowRenderable(request)) return null;
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
      {!isBottomLocked && (
        <button
          type="button"
          data-testid="scroll-to-bottom-button"
          aria-label="Scroll to bottom"
          onClick={handleScrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-lg transition-transform hover:bg-hover active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronDown className="size-5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The transcript scroll region: the empty-state hint, the render-unit loop
 * (the `kind`→component dispatch), the stacked permission/`ask` cards, the
 * child gates lifted into this session's transcript, the file summary card,
 * and the stop-reason line.
 *
 * Props-only by design — it MUST NOT read the stores (every value is derived
 * in `ChatStream` and passed down).
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
  const emptyRef = useRef<HTMLDivElement>(null);
  const inlineGateCount = childGates.filter(isInlineChildGate).length;

  useEffect(() => {
    if (units.length === 0 && emptyRef.current) {
      emptyRef.current.scrollTop = emptyRef.current.scrollHeight;
    }
  }, [units.length, prompts.length, stackedAskRequests.length, inlineGateCount]);

  if (units.length === 0) {
    return (
      <div
        ref={emptyRef}
        data-testid="transcript-scroll"
        className="relative flex-1 flex flex-col gap-3 overflow-y-auto overflow-x-hidden min-w-0 max-w-full p-4"
      >
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
    <TranscriptScroller
      key={`${activeSessionId}:${generation}`}
      units={units}
      activeSessionId={activeSessionId}
      generation={generation}
      inTurn={inTurn}
      askRequests={askRequests}
      prompts={prompts}
      stackedAskRequests={stackedAskRequests}
      childGates={childGates}
      turnDiffs={turnDiffs}
      stopReason={stopReason}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onStartReached={onStartReached}
    />
  );
}
