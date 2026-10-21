import { useEffect, useState, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { PaperclipIcon, PencilIcon, TrashIcon } from "lucide-react";
import { Button } from "../ui/button";
import AttachmentStrip from "./AttachmentStrip";
import { draftIsMarkerOnly, renumberImageMarkers } from "../../lib/chatAttachments";
import { useQueuedPrompts, type QueuedPrompt } from "../../store/queuedPrompts";

/**
 * One **queue row** (ADR 0069): a **Queued prompt** between the transcript and
 * the composer. It is IN-FLOW — never absolutely positioned — so nothing it
 * renders can cover a **Gate** card or the streaming answer.
 *
 * The container reuses the composer island's classes (`ComposerRow.tsx`), one
 * step thinner (`px-3 py-1.5` against the island's `p-3`): the row belongs to
 * the same **island family**, and `bg-composer` is the token the **response
 * band** and the composer wear, so the row reads as the USER's surface rather
 * than the agent's. That also means no new colour token, which is load-bearing:
 * `paletteCompleteness.test.ts` fails any token a **Palette** does not restate.
 *
 * THE EXIT IS STATE, NOT UNMOUNTING. `AnimatePresence` replays an exit for a
 * child that DISAPPEARS, but this row must stay mounted to play its own exit,
 * so `Task 1`'s store marks it `leaving` and the exit direction rides on
 * `animate`: `sent` flies UP into the transcript (it became a transcript row),
 * `deleted` flies RIGHT, out. `onAnimationComplete` is what finally removes the
 * entry with `forget` — the one remover.
 */

/** The exit target per cause. Same field, two directions, because "where did
 *  that row go" is a question the user answers with their eyes. */
function exitTarget(prompt: QueuedPrompt) {
  if (prompt.leaving === "sent") return { opacity: 0, y: -28 };
  if (prompt.leaving === "deleted") return { opacity: 0, x: 160 };
  return { opacity: 1, y: 0, x: 0 };
}

/**
 * `typeof … !== "function"` and NOT `"matchMedia" in window`: this jsdom (and
 * any browser with the property stripped) exposes the PROPERTY with no function
 * behind it, so an `in` test passes and the call throws — the shape at
 * `ui/braille-loader.tsx:29-30`. `lib/theme.ts:16` and
 * `QueuedSummaryContent.tsx:65` guard the way this does.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function QueueRow({
  sessionId,
  prompt,
}: {
  sessionId: string;
  prompt: QueuedPrompt;
}) {
  const setEditing = useQueuedPrompts((s) => s.setEditing);
  const markLeaving = useQueuedPrompts((s) => s.markLeaving);
  const forget = useQueuedPrompts((s) => s.forget);

  const reducedMotion = prefersReducedMotion();

  // Reduced motion has no exit animation to wait for, so `onAnimationComplete`
  // never arrives — without this effect the entry would sit `leaving` forever
  // (invisible to the reader, skipped by `takeHead`, and `forget` is the only
  // remover). Same tick as the render, so the stack never strands a row.
  useEffect(() => {
    if (reducedMotion && prompt.leaving) forget(sessionId, prompt.id);
  }, [reducedMotion, prompt.leaving, prompt.id, sessionId, forget]);

  const rowClasses = "m-1 shrink-0 rounded-xl bg-composer px-3 py-1.5";

  // The reduced-motion branch is a PLAIN div: no transform, no exit, and the
  // `useEffect` above owns removal.
  if (reducedMotion) {
    return (
      <div data-testid="queue-row" className={rowClasses}>
        <QueueRowBody
          sessionId={sessionId}
          prompt={prompt}
          onEdit={() => setEditing(sessionId, prompt.id, true)}
          onDelete={() => markLeaving(sessionId, prompt.id, "deleted")}
        />
      </div>
    );
  }

  return (
    <motion.div
      data-testid="queue-row"
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={exitTarget(prompt)}
      onAnimationComplete={() => {
        // Only an EXIT ends in removal. The entry-arrival animation lands here
        // too, and a live row must survive its own entrance.
        if (prompt.leaving) forget(sessionId, prompt.id);
      }}
      className={rowClasses}
    >
      <QueueRowBody
        sessionId={sessionId}
        prompt={prompt}
        onEdit={() => setEditing(sessionId, prompt.id, true)}
        onDelete={() => markLeaving(sessionId, prompt.id, "deleted")}
      />
    </motion.div>
  );
}

/**
 * The two states, and WHICH ONE IS SHOWN is read from the store:
 * `prompt.state === "editing"` is the flag `takeHead` consults to skip an entry
 * the user is rewriting, so a row-local `useState` could not express it — the
 * Flush would send the text from the LAST Save out from under the caret. Only
 * the editor's TEXT is local (`QueueRowEditor`).
 */
function QueueRowBody({
  sessionId,
  prompt,
  onEdit,
  onDelete,
}: {
  sessionId: string;
  prompt: QueuedPrompt;
  onEdit: () => void;
  onDelete: () => void;
}) {
  if (prompt.state === "editing") return <QueueRowEditor sessionId={sessionId} prompt={prompt} />;

  return (
    <div className="flex items-center gap-2">
      {/* The WHOLE row body is the edit affordance — a thin row has no dead
          space worth reserving, and the pencil is there for the pointer that
          looks for it. */}
      <button
        type="button"
        data-testid="queue-row-body"
        onClick={onEdit}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {/* Its OWN element — never `"Queued: " + text`, or selecting the
            prompt's text drags the label along with it. */}
        <span className="shrink-0 text-ui-xs text-foreground-subtlest">Queued</span>
        {/* A failed Flush is LIVE state the user has to see: nothing will ever
            send this entry but saving an edit of it. `text-destructive` is an
            existing status colour, so no new token enters the Palette. */}
        {prompt.failed && (
          <span className="shrink-0 text-ui-xs text-destructive">Failed</span>
        )}
        {prompt.attachments.length > 0 && (
          // `role="img"` + `aria-label` so the clip is not a nameless glyph in
          // the button's accessible name; `aria-hidden` on the icon itself, the
          // `AttachmentStrip` badge's reasoning.
          <span
            role="img"
            aria-label={`${prompt.attachments.length} image attachments`}
            className="flex shrink-0 items-center gap-0.5 text-ui-xs text-foreground-subtle"
          >
            {/* A count, not thumbnails: this row is one line high and the
                thumbnails belong to the editor. */}
            <PaperclipIcon aria-hidden="true" className="size-3" />
            <span aria-hidden="true">{prompt.attachments.length}</span>
          </span>
        )}
        <span className="truncate text-ui-sm text-foreground">{prompt.text}</span>
      </button>
      {/* `shrink-0` is `WorkingIndicator`'s lesson: at the default 800px window
          the island's content box is ~108px, and an unshrinkable sibling would
          squeeze these 24px hit targets to nothing. ALWAYS visible — a queue
          row is a control, not a Transcript row, so nothing here is
          hover-revealed (and a touch/keyboard user has no hover). */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit queued prompt" onClick={onEdit}>
          {/* The svg carries its own `size-3.5`, so the button variant's
              `[&_svg:not([class*='size-'])]:size-3` rule leaves it alone — the
              idiom at `settings/McpSection.tsx:165-172`. */}
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete queued prompt"
          onClick={onDelete}
        >
          <TrashIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The inline editor. A component of its own so that mounting it seeds the draft
 * from the STORE and unmounting it (Save / Cancel / Esc) discards the local text
 * for free — no reset effect, and no chance of a discarded draft leaking into
 * the next edit session.
 *
 * NO `$` / `#` / `@` / `?` PICKER HERE, and that is a decision, not a gap: the
 * four-prefix picker is `ComposerRow`'s, built on the composer's own caret /
 * draft state. A queue row stores the RAW text (ADR 0069) and **Mention**
 * expansion runs at SEND, on the same raw string, so the picker would only be
 * sugar — the characters edit as plain text and still expand correctly when the
 * entry is **Flush**ed.
 */
function QueueRowEditor({
  sessionId,
  prompt,
}: {
  sessionId: string;
  prompt: QueuedPrompt;
}) {
  const setEditing = useQueuedPrompts((s) => s.setEditing);
  const updateText = useQueuedPrompts((s) => s.updateText);
  const removeAttachment = useQueuedPrompts((s) => s.removeAttachment);
  const [draft, setDraft] = useState(prompt.text);

  const trimmed = draft.trim();
  // An empty edit is REFUSED, never silently deleted — the entry cannot be
  // talked into vanishing by clearing its box. `draftIsMarkerOnly` keeps the
  // composer's own rule: a bare `[image #1]` is prose about a picture, not a
  // prompt, and with no attachments staged it names nothing.
  const canSave = trimmed !== "" && !draftIsMarkerOnly(trimmed);

  const save = () => {
    if (!canSave) return;
    // `updateText` clears `failed` (Task 1) — saving an edit IS the retry,
    // which is why there is no retry button and no `clearFailure`.
    updateText(sessionId, prompt.id, draft);
    setEditing(sessionId, prompt.id, false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      // STOPPING this is not politeness: `ChatStream`'s window-level `keydown`
      // listener (the "Esc stops inference" effect, near `ChatStream.tsx:347`)
      // answers Escape with `session/cancel` while `inTurn` — which is exactly
      // when queue rows exist. Letting it through would cancel the turn the
      // user is queueing BEHIND, for a keypress meant to close a text box. Same
      // reason `TranscriptFooter` stops Esc on its `gate-row` wrapper.
      e.stopPropagation();
      setEditing(sessionId, prompt.id, false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    // The 1-based position IN THE LIST AS SHOWN, computed BEFORE the store's
    // filter — after the filter the index names the SURVIVOR, and the rewrite
    // would delete the wrong marker. `ChatStream`'s own `removeAttachment`
    // (`:1531-1546`) applies the same rule to the composer's draft.
    const position = prompt.attachments.findIndex((a) => a.id === attachmentId) + 1;
    removeAttachment(sessionId, prompt.id, attachmentId);
    setDraft((current) => renumberImageMarkers(current, position));
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Real thumbnails while editing — the user is rewriting the text that
          names them, so the `#N` badge has to be checkable. */}
      <AttachmentStrip attachments={prompt.attachments} onRemove={handleRemoveAttachment} />
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        rows={3}
        className="w-full resize-none bg-transparent text-ui-sm outline-none"
      />
      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(sessionId, prompt.id, false)}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!canSave} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
