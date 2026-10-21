import { AnimatePresence } from "motion/react";
import QueueRow from "./QueueRow";
import { livePrompts, useQueuedPrompts } from "../../store/queuedPrompts";

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

  // `livePrompts`, not `raw`: a list whose every entry is mid-exit has nothing
  // left to show, and rendering a container for it would leave an empty band
  // wedged above the composer once the animations land. The `QueueRow`s
  // themselves are still rendered from `raw` below — the leaving entries are
  // the ones currently animating out, and unmounting them to "hide" them is
  // exactly what `leaving` exists to avoid.
  //
  // THE EDGE THIS CREATES, stated rather than hidden (measured, not reasoned):
  // when the LAST LIVE row is deleted, this gate flips to `null` on the same
  // tick `markLeaving` lands, so that row unmounts instead of flying right and
  // its `forget` never runs. The entry stays in `bySession` as
  // `leaving: "deleted"` until `clearSession` releases it — invisible to
  // `livePrompts`, skipped by `takeHead`, and painting at `opacity: 0` if a later
  // enqueue re-mounts the stack (motion re-lands it on its exit target without
  // reporting a completion, so a re-mount does NOT drain it). Deleting the only
  // queued prompt therefore reads as an instant vanish rather than an exit, and
  // that is the price of a stack that cannot leave an empty band behind.
  if (livePrompts(raw).length === 0) return null;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {(raw ?? []).map((prompt) => (
        <QueueRow key={prompt.id} sessionId={sessionId} prompt={prompt} />
      ))}
    </AnimatePresence>
  );
}
