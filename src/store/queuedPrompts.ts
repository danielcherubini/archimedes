import { create } from "zustand";
import { releaseAttachment, type ChatComposerAttachment } from "../lib/chatAttachments";

/**
 * One entry of the **Prompt queue** (ADR 0069): a prompt the user sent while
 * its Session's turn was in flight. It lives ONLY in the renderer — the
 * Supervisor is never told a queue exists, so every queue operation (edit,
 * delete, **Flush**) is a plain list mutation here.
 */
export interface QueuedPrompt {
  /** `crypto.randomUUID()` at enqueue; the React key + the edit/delete handle. */
  id: string;
  /** The RAW draft — NEVER the Mention-expanded text (ADR 0069: expansion runs at send). */
  text: string;
  /** MOVED out of the composer, not copied — this entry owns their object URLs. */
  attachments: ChatComposerAttachment[];
  state: "queued" | "editing";
  /**
   * Set at exit; the row calls `forget` when its animation ends.
   * `undefined` = live (rendered, counted, and — unless `failed` or being
   * edited — a **Flush** candidate).
   */
  leaving?: "sent" | "deleted";
  /**
   * A **Flush** of this entry failed. Such an entry is LIVE (it renders and
   * counts) but is never a `takeHead` candidate — only saving an edit clears
   * it. This is what stops a failed send's own busy→idle edge from re-sending
   * it into the same failure.
   */
  failed?: boolean;
}

interface QueuedPromptsState {
  /** Ordered per Session: the first LIVE entry is the next one to **Flush**. */
  bySession: Record<string, QueuedPrompt[]>;
  enqueue: (sessionId: string, prompt: QueuedPrompt) => void;
  /** Puts an entry back at the FRONT (a failed **Flush**), with `leaving` cleared. */
  requeueHead: (sessionId: string, prompt: QueuedPrompt) => void;
  updateText: (sessionId: string, id: string, text: string) => void;
  setEditing: (sessionId: string, id: string, editing: boolean) => void;
  removeAttachment: (sessionId: string, id: string, attachmentId: string) => void;
  takeHead: (sessionId: string) => QueuedPrompt | undefined;
  markLeaving: (sessionId: string, id: string, reason: "deleted") => void;
  forget: (sessionId: string, id: string) => void;
  clearSession: (sessionId: string) => void;
}

/**
 * NO `livePrompts`-style filter is exported, deliberately. The live-versus-
 * `leaving` rule is decided ONCE, inside `takeHead`, together with the `failed`
 * and `editing` skips — so there is exactly one place that answers "may this
 * entry send?", and no second filter to drift from it.
 *
 * The stack deliberately does NOT want a live-only view either: a row must stay
 * MOUNTED to play its exit, so `QueueRows` renders the raw list and gates on its
 * TOTAL length. An earlier `livePrompts` helper invited the stack to gate on it,
 * which strands every animating row — see the comment at that gate.
 */
export const useQueuedPrompts = create<QueuedPromptsState>((set, get) => ({
  bySession: {},

  enqueue: (sessionId, prompt) =>
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: [...(state.bySession[sessionId] ?? []), prompt],
      },
    })),

  requeueHead: (sessionId, prompt) =>
    set((state) => {
      // A CLOSED or DELETED Session has no key: `closeSession` / delete call
      // `clearSession` (ADR 0069 — a reopened Session must not offer a **Flush**
      // whose turn can never arrive), but a **Flush** already in flight doesn't
      // know that. Its `sendPrompt` then rejects with unknown-session and this
      // catch-path requeue runs: inserting unconditionally would re-create a key
      // nobody will ever clear again, orphaning an entry that holds a `File` and
      // previews that were already revoked. A MISSING key therefore means "this
      // Session's queue is gone" — drop the requeue.
      //
      // This CANNOT affect the normal failure path: `takeHead` MARKS the head
      // (`leaving: "sent"`) rather than removing it, so the entry is still in the
      // list and the key is still present whenever a live Session's send fails.
      const current = state.bySession[sessionId];
      if (!current) return state;
      const rest = current.filter((p) => p.id !== prompt.id);
      return {
        bySession: {
          ...state.bySession,
          // `takeHead` MARKS rather than removes, so the entry being requeued is
          // still in the list: dropping the stale copy is what keeps one id from
          // holding two rows. `leaving: undefined` makes it live again — its row
          // stops animating out — and it goes to the FRONT, ahead of anything
          // queued while its turn ran.
          [sessionId]: [{ ...prompt, leaving: undefined }, ...rest],
        },
      };
    }),

  updateText: (sessionId, id, text) =>
    set((state) => {
      const list = state.bySession[sessionId];
      if (!list) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: list.map((p) =>
            // Saving an edited prompt IS the retry gesture, so the save clears
            // `failed` — no separate retry API, hence no second place the flag
            // can be cleared by accident.
            p.id === id ? { ...p, text, failed: undefined } : p,
          ),
        },
      };
    }),

  setEditing: (sessionId, id, editing) =>
    set((state) => {
      const list = state.bySession[sessionId];
      if (!list) return state;
      return {
        bySession: {
          ...state.bySession,
          // `failed` survives: opening the editor is not a request to retry.
          [sessionId]: list.map((p) => {
            if (p.id !== id) return p;
            // ONE ENTRY, ONE EXIT OWNER (the same rule `markLeaving` states): a
            // body click still lands on a row whose exit is animating, because
            // `AnimatePresence mode="popLayout"` keeps it mounted AND
            // hit-testable. Putting a `leaving` entry into `editing` opens an
            // editor whose Save is later destroyed by `forget` — a silently lost
            // edit — and an entry mid-exit is not something to re-open.
            if (p.leaving) return p;
            return { ...p, state: editing ? "editing" : "queued" };
          }),
        },
      };
    }),

  removeAttachment: (sessionId, id, attachmentId) => {
    // Read the target OUT of the store and release BEFORE `set(...)` — never
    // inside the updater, which React may run again.
    const target = get().bySession[sessionId]?.find((p) => p.id === id);
    const doomed = target?.attachments.find((a) => a.id === attachmentId);
    if (doomed) releaseAttachment(doomed);
    set((state) => {
      const list = state.bySession[sessionId];
      if (!list || !doomed) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: list.map((p) =>
            p.id === id
              ? { ...p, attachments: p.attachments.filter((a) => a.id !== attachmentId) }
              : p,
          ),
        },
      };
    });
  },

  /**
   * Marks the next entry to **Flush**, it does not remove it: the row has to
   * stay mounted to play its exit animation, and `leaving` is what makes it
   * invisible to the NEXT **Flush** at the same time.
   *
   * Synchronous on purpose — `get()` then `set()` with no `await` between, so
   * the read-and-mutate pair is atomic against a manual send racing it.
   *
   * Skips an entry that is not READY rather than blocking the ones behind it:
   * a `failed` entry would re-hit the same failure, and an entry under edit
   * holds the text from the LAST Save, so sending it would ship text the user
   * was in the middle of replacing (the hazard `send()`'s draftRef staleness
   * guard covers at `ChatStream.tsx:985-993`).
   */
  takeHead: (sessionId) => {
    const list = get().bySession[sessionId];
    if (!list) return undefined;
    const index = list.findIndex(
      (p) => !p.leaving && !p.failed && p.state !== "editing",
    );
    if (index === -1) return undefined;
    const taken: QueuedPrompt = { ...list[index], leaving: "sent" };
    set((state) => {
      const current = state.bySession[sessionId] ?? [];
      const at = current.findIndex((p) => p.id === taken.id);
      if (at === -1) return state;
      const next = [...current];
      next[at] = taken;
      return { bySession: { ...state.bySession, [sessionId]: next } };
    });
    return taken;
  },

  markLeaving: (sessionId, id, reason) =>
    set((state) => {
      const list = state.bySession[sessionId];
      if (!list) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: list.map((p) => {
            if (p.id !== id) return p;
            // ONE ENTRY, ONE EXIT OWNER. `AnimatePresence mode="popLayout"`
            // keeps an exiting row mounted AND hit-testable for the whole exit
            // (~300 ms), so the trash can still be clicked while a row is
            // flying out. Re-opening a `leaving` row here would hand its
            // attachments to a remover that no longer owns them: overwriting
            // `"sent"` with `"deleted"` flips the exit direction AND makes
            // `forget` release the object URLs the SEND path owns (a
            // double-revoke under the sender's feet), and if that flush then
            // fails `requeueHead` resurrects a row the user just deleted, with
            // previews that were already revoked. So the FIRST cause of the
            // exit is the one that plays.
            if (p.leaving) return p;
            return { ...p, leaving: reason };
          }),
        },
      };
    }),

  /**
   * The only remover — the row calls it when its exit animation ends.
   *
   * It releases an entry's attachments ONLY when it was deleted: for
   * `leaving === "sent"` the dispatch path owns those URLs and releases them,
   * so releasing here too would be a double-revoke under the send path's feet.
   */
  forget: (sessionId, id) => {
    const doomed = get().bySession[sessionId]?.find((p) => p.id === id);
    if (doomed?.leaving === "deleted") {
      for (const attachment of doomed.attachments) releaseAttachment(attachment);
    }
    set((state) => {
      const list = state.bySession[sessionId];
      if (!list) return state;
      const remaining = list.filter((p) => p.id !== id);
      const bySession = { ...state.bySession };
      // Delete the key rather than storing `[]` (the `dismissSessionPrompts`
      // pattern) so the map cannot accumulate empty arrays.
      if (remaining.length === 0) delete bySession[sessionId];
      else bySession[sessionId] = remaining;
      return { bySession };
    });
  },

  /**
   * Session closed / deleted (ADR 0069): the queue goes with it, so a reopened
   * Session never offers a **Flush** whose turn can never arrive. Nobody owns
   * the attachments any more, so this releases every one of them — for both
   * `leaving` values.
   */
  clearSession: (sessionId) => {
    for (const prompt of get().bySession[sessionId] ?? []) {
      for (const attachment of prompt.attachments) releaseAttachment(attachment);
    }
    set((state) => {
      if (!state.bySession[sessionId]) return state;
      const bySession = { ...state.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  },
}));
