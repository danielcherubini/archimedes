import { ArrowUp, Plus } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "../ui/button";
import AttachmentStrip from "./AttachmentStrip";
import ComposerMentions, { type MentionRow } from "./ComposerMentions";
import { activeMentionToken, isOutsideSpaceQuery, type ComposerPrefix } from "../../lib/skills";
import type { ChatComposerAttachment } from "../../lib/chatAttachments";
import type { BrailleLoaderVariant } from "../../lib/braille-loader";
import { WorkingIndicator } from "./WorkingIndicator";

/**
 * The composer: the outer rounded box (drop target), the four-prefix
 * picker (`$` skills / `#` MCP servers / `@` agents — the three **Mention**
 * prefixes — plus `?` File completion, ADR 0033), the
 * staged-attachment strip, the controlled textarea (with the four-prefix
 * token `onChange` / `onKeyDown` logic — `$` skills / `#` MCP servers /
 * `@` agents / `?` paths) and the bottom row, which is ONE LINE: the
 * **working indicator** at the left (`WorkingIndicator` — spinner + quip, or
 * the waiting / Compacting line, `null` when the session is idle) and, at the
 * right, the `+` attach button and Send in one `ml-auto` wrapper. The
 * context-usage bar and the model / thinking selectors used to be this row's
 * middle and they are GONE from it — they are the side pane's three config
 * LINES now (`SessionConfigBlock.tsx`).
 *
 * Props-only by design — ALL state stays in `ChatStream` (the `draft`,
 * `picker` and `attachments` state, the `composerRef` the auto-grow and
 * skill-insert effects need, `send`, and the attachment handlers). The
 * `onChange` / `onKeyDown` closures live here VERBATIM (they are pure given
 * these props: `activeMentionToken` is a free function, the `draft` / `picker`
 * setters and the `send` / `selectMention` callbacks are props). Extracted
 * verbatim from `ChatStream` (identical DOM).
 */
export default function ComposerRow({
  composerRef,
  draft,
  setDraft,
  picker,
  setPicker,
  filtered,
  note,
  activeIndex,
  completionPending,
  selectMention,
  attachments,
  removeAttachment,
  handlePaste,
  handleDrop,
  handleAttachClick,
  send,
  composerEnabled,
  composerLocked,
  imageCapable,
  hasImages,
  agentState,
  workingOrInTurn,
  compacting,
  spinnerStyle,
  quip,
}: {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (value: string) => void;
  picker: { prefix: ComposerPrefix; query: string; index: number } | null;
  setPicker: (
    picker: {
      prefix: ComposerPrefix;
      query: string;
      index: number;
    } | null,
  ) => void;
  filtered: MentionRow[];
  /** The picker's one explanation line (`?`'s cap notes) — NOT a row. */
  note?: string;
  /**
   * A fetch for the out-of-Space directory the OPEN token names has not settled
   * yet, so the empty `filtered` is a GAP and not an answer (ADR 0035). Owned by
   * `useCompletionDir` in `ChatStream` — this component only consumes it, like
   * every other derivation here.
   *
   * WHY a keydown handler needs it at all: the Enter intercept below is gated on
   * `filtered.length > 0` because ADR 0033 decided a picker must never be a gate
   * — and an out-of-Space DESCENT makes that gate load-bearing in a way the
   * pre-ADR-0035 keyboard model never hit. Selecting a DIRECTORY row re-points
   * `dirPrefix` at a directory whose rows are one IPC round trip away, so the
   * picker legitimately has ZERO rows while the user's next Enter means "pick
   * the row that is about to appear". Without this flag the keydown falls
   * through to `sendPrompt` and delivers `?/home/u/.config/htop/` (sigil,
   * absolute path, trailing slash) to the model — and for a directory that
   * cannot be read it does so FOREVER, since a failed fetch degrades to the
   * empty value.
   *
   * The narrowing is deliberate and it is NOT "a picker is now a gate": this
   * flag is true only while a fetch for the CURRENT non-null `dirPrefix` is
   * outstanding, so a relative `?query` (which has no `dirPrefix` at all) and a
   * stray `?` in prose are untouched and still send on Enter with zero rows.
   */
  completionPending: boolean;
  activeIndex: number;
  selectMention: (row: MentionRow) => void;
  attachments: ChatComposerAttachment[];
  removeAttachment: (id: string) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: React.DragEvent) => void;
  handleAttachClick: () => Promise<void>;
  send: () => Promise<void>;
  composerEnabled: boolean;
  composerLocked: boolean;
  imageCapable: boolean;
  hasImages: boolean;
  /** The working indicator's inputs (`WorkingIndicator`). Derived in
   * `ChatStream`, not here: this component renders ALWAYS, so a `useSpinQuip`
   * call in its body would keep rotating quips (and its timer) while the
   * session is idle. */
  agentState: "working" | "idle" | "blocked" | undefined;
  workingOrInTurn: boolean;
  compacting?: string;
  spinnerStyle: BrailleLoaderVariant;
  quip: string;
}) {
  return (
    <div
      data-testid="composer-island"
      // `shrink-0` is LOAD-BEARING. The island is now a flex ITEM of the center
      // column (it used to be a child of the `main`). Flex shrink is weighted by
      // flex-basis, and the `main` has `flex-1` (basis 0) while this has
      // `basis: auto` — so under pressure the `main` cannot shrink at all and
      // the composer absorbs the entire shortfall (a long transcript squashes
      // the input to nothing instead of scrolling).
      className="relative m-1 shrink-0 rounded-xl bg-composer p-3"
      onDrop={handleDrop}
    >
      <ComposerMentions
        open={picker !== null}
        filtered={filtered}
        note={note}
        activeIndex={activeIndex}
        onSelect={selectMention}
      />
      <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
      <textarea
        ref={composerRef}
        value={draft}
        onChange={(e) => {
          // The `$`/`#`/`@`/`?`-trigger: a bare Mention glyph (empty token
          // remainder) opens the picker with the FULL list for that prefix,
          // a `?` needs ≥1 path char (ADR 0033 — what keeps `??` from
          // opening), and any non-token span closes it.
          const token = activeMentionToken(
            e.target.value,
            e.target.selectionStart ?? e.target.value.length,
          );
          setDraft(e.target.value);
          setPicker(
            token
              ? { prefix: token.prefix, query: token.remainder, index: 0 }
              : null,
          );
        }}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          // Re-evaluate the active token at KEYDOWN time (the caret is on
          // the event's target): ArrowLeft/Right, Home/End, and a mouse
          // click move the caret WITHOUT `onChange`, so the `picker` state
          // (only recomputed in `onChange`) can be STALE — the caret may
          // no longer be on the token.
          const el = e.currentTarget;
          const token = activeMentionToken(
            el.value,
            el.selectionStart ?? el.value.length,
          );
          if (picker && !token) {
            // The caret left the token: CLOSE the picker instead of
            // `selectMention`'s silent early-return — a stale picker must
            // never swallow keys (Enter sends, arrows move the caret, Tab
            // falls through to the textarea default).
            setPicker(null);
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            return;
          }
          // The picker is open AND the token is active at the caret: ↑/↓
          // move the highlight (with wrap), Enter/Tab select the highlighted
          // row (ZCode's `MentionPlugin` registers `KEY_TAB_COMMAND` →
          // `selectOption(selectedIndex)` — the same handler Enter uses),
          // Escape closes. `Shift+Enter` (a newline) and `Shift+Tab`
          // (move focus BACKWARD — intercepting it would be a
          // keyboard/a11y trap) fall through to the textarea default
          // (NOT a selection, NOT swallowed). The index used here is
          // `activeIndex` (the derivation above — NOT the raw
          // `picker.index`, which can be stale against a changed
          // `filtered`).
          if (picker && token && filtered.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setPicker({
                ...picker,
                index: (activeIndex + 1) % filtered.length,
              });
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setPicker({
                ...picker,
                index: (activeIndex + filtered.length - 1) % filtered.length,
              });
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              selectMention(filtered[activeIndex]!);
              return;
            }
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              selectMention(filtered[activeIndex]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setPicker(null);
              return;
            }
          }
          // The in-flight DESCENT window (ADR 0035): the token names a directory
          // whose rows have not arrived, so there is NOTHING to insert and the
          // rows are not merely absent — they are on their way. Enter does
          // NOTHING here: not a send (that is the defect this gate exists to
          // stop) and not an insert (there is no row). Every other case falls
          // through unchanged — see the `completionPending` prop for why the
          // flag alone cannot widen ADR 0033's rule to prose. The ROWS branch
          // above already returned when there was something to insert, so
          // `filtered.length === 0` is belt-and-braces, not a condition the
          // behaviour depends on.
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            picker &&
            token &&
            completionPending &&
            token.prefix === "?" &&
            isOutsideSpaceQuery(token.remainder) &&
            filtered.length === 0
          ) {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        // The SINGLE static placeholder (the state if/else is gone — the
        // working indicator carries the working state, and a closed
        // session's send auto-resumes it, so "follow-up changes" is
        // accurate there too).
        placeholder="Ask for follow-up changes"
        rows={2}
        className="max-h-32 w-full resize-none overflow-y-auto bg-transparent text-ui-base outline-none placeholder:text-foreground-subtlest"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {/* The composer's bottom row: the working indicator at the LEFT, the
            two buttons at the RIGHT. What used to sit between the buttons is
            gone: the context bar and the model / thinking selectors are the
            side pane's three config LINES now (`SessionConfigBlock.tsx`,
            pinned under the pane's scroll area), and the `gap-1` cluster that
            knitted the two triggers into one block died with them — a row of
            actions has no cluster to separate from.
            THE ROW'S TWO HALVES HAVE OPPOSITE FLEX JOBS, and that split is
            what keeps a long quip off the buttons. The indicator is `flex-1`
            with a `min-w` floor (its `<p>` carries the `min-w-0 truncate`): it
            absorbs the slack AND is allowed to shrink below its own text, so the
            quip truncates. This wrapper is `ml-auto` (it right-aligns the pair)
            AND `shrink-0` — without the latter flex
            would squeeze two 24–28px hit targets to make room for a
            60-character quip. They are SIBLINGS, not nested: putting the
            indicator inside this wrapper would right-align it too.
            THE SPLIT HAS A FLOOR, and below it the ROW wraps: shrinking the
            indicator forever stops helping once what is left is the spinner,
            which cannot shrink. So the text gives FIRST, and only when the text
            is gone does the line BREAK (the `flex-wrap` above), dropping the
            indicator to its own line above the buttons. The buttons themselves
            never move, never squash, and never get overprinted — see
            `WorkingIndicator` for why the floor is 56px. */}
        <WorkingIndicator
          agentState={agentState}
          workingOrInTurn={workingOrInTurn}
          compacting={compacting}
          spinnerStyle={spinnerStyle}
          quip={quip}
        />
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          {/* The `+` attach button (the native file picker — the same
              staging path as a paste / drop; disabled while the composer
              is locked or the agent doesn't advertise image support,
              fail-closed). */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Attach files"
            disabled={!composerEnabled || composerLocked || !imageCapable}
            title={
              imageCapable
                ? "Attach an image (file picker)"
                : "The agent does not support images"
            }
            onClick={() => void handleAttachClick()}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            size="icon-md"
            aria-label="Send"
            disabled={
              !composerEnabled ||
              composerLocked ||
              (draft.trim() === "" && !hasImages)
            }
            onClick={() => void send()}
            className="bg-primary text-primary-foreground"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
