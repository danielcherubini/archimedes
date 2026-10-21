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

  // THE GATE IS THE TOTAL ENTRY COUNT, NOT `livePrompts`. A row's exit is the
  // `leaving` field on `animate` plus `forget()` in `onAnimationComplete`, so a
  // row must STAY MOUNTED to finish leaving — unmounting it cancels the exit
  // and skips the only remover. Gating on `livePrompts` strands exactly the
  // rows that are animating out: when the LAST live row leaves, `markLeaving`
  // (or `takeHead`) and that gate land on the same render, so the stack drops
  // the row instead of letting it fly right (deleted) or up into the
  // transcript (sent), `onAnimationComplete` never fires, and `forget` is never
  // called. The entry then sits in `bySession` with `leaving` set until
  // `clearSession`, and because a later `enqueue` re-mounts the stack with that
  // phantom still in `raw`, it paints an invisible band above the composer that
  // never drains (motion re-lands a re-mounted child on its exit target without
  // reporting a completion, so a re-mount does not drain it either).
  //
  // Gating on the total instead makes each row responsible for its own removal,
  // and the stack collapses on its own: Task 1's `forget` DELETES the `bySession`
  // key when the last entry goes, `raw` becomes `undefined`, and this returns
  // `null`. The empty band the `livePrompts` gate was protecting against cannot
  // outlive the animations, because the only thing that keeps the stack mounted
  // is entries that are still being removed. (`livePrompts` remains the UI's
  // read for COUNTING queued prompts — it is simply not the unmount gate.)
  if ((raw?.length ?? 0) === 0) return null;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {(raw ?? []).map((prompt) => (
        <QueueRow key={prompt.id} sessionId={sessionId} prompt={prompt} />
      ))}
    </AnimatePresence>
  );
}
