import { AnimatePresence } from "motion/react";
import QueueRow from "./QueueRow";
import { useQueuedPrompts } from "../../store/queuedPrompts";

/**
 * The **Prompt queue** stack: one **queue row** per **Queued prompt**, mounted
 * between the transcript island and the composer (`ChatStream` renders it as a
 * sibling of `<main>`, so it is IN the island column and in normal flow — it can
 * never float over a **Gate** card or the streaming answer).
 *
 * ORDER IS THE CONTRACT: the array order in the store IS the send order, so the
 * head renders FIRST (top of the stack, nearest the transcript it is about to
 * join) and the newest LAST (bottom, nearest the composer it came from). Nothing
 * here sorts — a sort would silently disagree with `takeHead`, which reads the
 * same array front-to-back.
 */
export default function QueueRows({ sessionId }: { sessionId: string }) {
  // The selector returns the stored array or `undefined` — NEVER a fresh `[]`.
  // Zustand compares selector results by reference, so a selector that
  // allocates re-renders forever (the rule stated in `useSessionStatus.ts:82`).
  const raw = useQueuedPrompts((s) => s.bySession[sessionId]);

  // THE GATE IS THE TOTAL ENTRY COUNT, NOT A LIVE-ONLY COUNT. A row's exit is
  // the `leaving` field on `animate` plus `forget()` in `onAnimationComplete`,
  // so a row must STAY MOUNTED to finish leaving — unmounting it cancels the
  // exit and skips the only remover. Gate on the live count instead and you
  // strand exactly the rows that are animating out: when the LAST live row
  // leaves, `markLeaving` (or `takeHead`) and that gate land on the same
  // render, so the stack drops the row instead of letting it fly right
  // (deleted) or up into the transcript (sent), `onAnimationComplete` never
  // fires, and `forget` is never called. The entry then sits in `bySession`
  // with `leaving` set until `clearSession`, and because a later `enqueue`
  // re-mounts the stack with that phantom still in `raw`, it paints an
  // invisible band above the composer that never drains (motion re-lands a
  // re-mounted child on its exit target without reporting a completion, so a
  // re-mount does not drain it either).
  //
  // Gating on the total instead makes each row responsible for its own removal,
  // and the stack collapses on its own: Task 1's `forget` DELETES the `bySession`
  // key when the last entry goes, `raw` becomes `undefined`, and this returns
  // `null`. The empty band a live-only gate was protecting against cannot
  // outlive the animations, because the only thing that keeps the stack mounted
  // is entries that are still being removed.
  if ((raw?.length ?? 0) === 0) return null;

  // THE WRAPPER IS THE STACK's element (`data-testid="queue-rows"` — the handle
  // the DOM-order test uses to prove the stack sits between the transcript
  // island and the composer). It is a `flex-col` so the rows stay the vertical
  // stack their `m-1` + `shrink-0` were written for: in a plain BLOCK container
  // adjacent vertical margins collapse, which would thin the gap between rows
  // and let their outer margins punch through the wrapper.
  //
  // `relative` is load-bearing for the exit, not decoration: `mode="popLayout"`
  // measures a leaving row against its `offsetParent` and then re-places it with
  // `position: absolute` + `top`/`left`. Those coordinates are resolved against
  // the row's nearest POSITIONED ancestor, so the two frames have to be the same
  // element — without `relative` here the popped row is measured against one
  // box and re-positioned against another, and the exit visibly jumps.
  return (
    <div
      data-testid="queue-rows"
      className="relative flex shrink-0 flex-col"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {(raw ?? []).map((prompt) => (
          <QueueRow key={prompt.id} sessionId={sessionId} prompt={prompt} />
        ))}
      </AnimatePresence>
    </div>
  );
}
