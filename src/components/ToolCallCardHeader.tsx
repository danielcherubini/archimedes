import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import {
  failureText,
  summarizeToolCall,
  toolIcon,
  toolVerb,
  type ToolFileSummary,
} from "../lib/toolOutput";
import type { ToolCallUiStatus } from "../store/sessions";
import FileChip from "./FileChip";
import DiffCount from "./DiffCount";
import { TRANSCRIPT_ROW } from "./lib/transcriptRow";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";
import { useCopyButton } from "../hooks/useCopyButton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

/**
 * C7 (finding 6d): what `<Button>`'s base and the `default` size would change on
 * the failure tooltip's COPY button, undone. Both axes are named at the site
 * (`variant="ghost" size="default"`) because `ui/button.tsx:40` sets
 * `defaultVariants {variant: "default"}` and a bare `<Button>` would paint a
 * `bg-primary text-primary-foreground` plate behind a 12px glyph inside the
 * tooltip.
 *
 * Measured twice: through the real `cn()` (the utility SET is exactly the three
 * utilities this button spelled — zero lost), and in a headless browser against
 * the compiled sheet, inside a `flex items-center gap-2` row of the tooltip's
 * own width: the box is 12×12 with the glyph at the origin BOTH before and
 * after, and the neighbouring failure text keeps the same width. What each entry
 * removes:
 *  - `border-0`   — the base's `border` is a 1px ring (preflight sets
 *                   `border: 0 solid`); it would make the box 14×14 and inset the
 *                   glyph 1px. With the width at zero the base's
 *                   `bg-clip-padding` is a no-op besides.
 *  - `h-auto`     — the size's `h-7` is a FIXED 28px: the glyph would gain a
 *                   16px-tall button inside a tooltip that is 12px of glyph, and
 *                   `items-center` on the row would grow the tooltip's height.
 *  - `px-0`       — the size's `px-2` would push the failure text 8px away from
 *                   the icon that belongs at the end of it.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` (this button inherits
 *                   `normal`; the sibling `span` owns the wrapping of the error
 *                   text, and a nowrap on the button would not help it anyway).
 *  - `select-auto`     — the base's `select-none` would make the failure text's
 *                   copy affordance unselectable along with the glyph. Settled
 *                   by the MERGE, not by the sheet: `mergeUiClasses` puts
 *                   `select-auto` and `select-none` in ONE group and keeps the
 *                   LAST, so the base's utility never reaches the attribute. The
 *                   cascade would not have rescued it — in the built sheet
 *                   `.select-auto` is emitted BEFORE `.select-none` (offsets
 *                   45726 / 45781, measured), so if both had survived into one
 *                   class list the base would have won.
 *  - `transition-none` — the base's `transition-colors` would fade the copy →
 *                   check INK swap over 150 ms; the confirmation is instant
 *                   today, and a fade on a "did my click land?" cue is the worst
 *                   place for one.
 *  - `text-[length:inherit]` — the base declares `text-ui-base/relaxed` (14px +
 *                   1.625) and this button inherits `text-ui-sm` from the
 *                   `TooltipContent` around it. The glyph is sized by its own
 *                   `size-3` CLASS so the box is provably unaffected, but the
 *                   button would otherwise GAIN a font-size utility it never had
 *                   — the hazard C7 group 4 hit, where `ChatStream.test.tsx`'s
 *                   `primaryLines()` finds rows by `querySelectorAll
 *                   (".text-ui-base")` and a gained token is selectable code.
 *                   Restoring `inherit` collapses the whole font-size group, so
 *                   no line-height is declared either.
 *  - `hover:bg-transparent` — `ghost` adds `hover:bg-hover`, and this button's
 *                   hover affordance has always been the INK alone
 *                   (`hover:text-foreground`); a grey plate behind the glyph
 *                   inside a tooltip is a new surface.
 * NOT in the wall, because the button spells the group and comes LAST: its
 * `shrink-0` (the base spells the same value) and its two `text-*` utilities,
 * which win the colour group over `ghost`'s `text-foreground` /
 * `hover:text-foreground`. Inert additions: `inline-flex` + `items-center` +
 * `justify-center` (the button is a flex ITEM of the tooltip's row, so it is
 * blockified either way — `inline-block` → `block`, `inline-flex` → `flex` — and
 * with one fixed-size child there is nothing to distribute; the probe measured
 * the same 12×12 box and the same glyph origin for both); `gap-1` (one child);
 * `rounded-md` and `bg-clip-padding` (no background and no border at rest);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus, and again under `forced-colors`); `disabled:*` (never disabled);
 * `aria-expanded:*` — Radix's tooltip sets `aria-describedby` on its TRIGGER,
 * never `aria-expanded`, and this button is not the trigger anyway;
 * `group/button` (nothing reads that group); `has-data-[icon=inline-*]` (lucide
 * sets no `data-icon`); `[&_svg]:pointer-events-none` (the handler is on the
 * button, so the click target moving off the `<svg>` cannot change what runs);
 * `[&_svg]:shrink-0`; and `[&_svg:not([class*='size-'])]:size-3.5` — the glyph
 * carries an explicit `size-3`, so the `:not([class*='size-'])` guard excludes
 * it and it stays 12px (the icon-resize hazard, checked by asserting the class
 * AND the box together in `ToolCallCard.test.tsx`).
 * The `data-slot`/`data-variant`/`data-size` attributes are new; no test reads
 * them here. It stays `text-foreground-subtle` in this file, which is what
 * `themeTokens.test.ts`'s 18-utility de-emphasis count is reading.
 */
const COPY_BUTTON_WALL =
  "border-0 h-auto px-0 whitespace-normal select-auto transition-none text-[length:inherit] hover:bg-transparent";

/**
 * The `ToolCallCard`'s header row (the `<button>`: icon + verb + summary +
 * stat + failure tooltip + chevron) — extracted so the `SubagentDelegatingCard`
 * can reuse it. `files`/`stat`/`range`/`isShell`/`command` are computed ONCE
 * by the caller (the `ToolCallCard`'s body uses them too) and passed in —
 * the header does NOT recompute them (no `SHELL_TOOLS` circular import).
 * The `verb`/`Icon`/`summary`/`failure` derivations + the failure-tooltip
 * copy state live HERE (moved from `ToolCallCard`), the latter via the shared
 * `useCopyButton`. The toggle is delegated to the caller via `onToggle` (the
 * `open` state stays in the `ToolCallCard`, which starts collapsed and changes
 * it only on this toggle).
 */
export function ToolCallCardHeader({
  title,
  status,
  rawInput,
  rawOutput,
  open,
  onToggle,
  files,
  stat,
  range,
  isShell,
  command,
}: {
  title: string;
  status: ToolCallUiStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  open: boolean;
  onToggle: () => void;
  files: ToolFileSummary[];
  stat: { added: number; removed: number } | undefined;
  range: string | undefined;
  isShell: boolean;
  command: string | undefined;
}) {
  const verb = toolVerb(title, status);
  const Icon = toolIcon(title);
  const summary = summarizeToolCall(title, rawInput);
  const failure = status === "failed" ? failureText(rawOutput) : undefined;

  // The failure tooltip's copy button (copy → check for 1.5s; a no-op when
  // there is no failure text), owned by `useCopyButton`. The BUTTON stays here —
  // see the hook's doc-comment for why it must not move into a shared component.
  //
  // It is JSX-nested in the row's own `<button>` but NOT DOM-nested: the tooltip
  // renders through Radix's `Portal`, so in the live tree this button is a child
  // of the tooltip content on `document.body` with no `<button>` ancestor (and
  // `ToolCallCard.test.tsx` keeps the document-wide `button button` count at 0).
  // That distinction is what lets it be a `<Button>` while the row itself cannot
  // be one — the blocker there is `transcriptRow.test.tsx`'s no-`bg-*` rule, and
  // the nesting would be real if the tooltip were inline.
  const { copied, copy: handleCopy } = useCopyButton(failure);

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn("group/tool-summary", TRANSCRIPT_ROW)}
    >
      {/* The row glyph (ADR 0062): `text-row-icon`, not a foreground utility, so
          a Palette can re-hue every transcript row's glyph — and only that —
          without touching this file.
          The verb below takes `text-row-verb`, but only ONCE SETTLED: a pending
          call keeps `animated-gradient-text`, because the shimmer is the "this
          call is working" cue and outranks a static colour. Do not collapse that
          conditional into one class and lose the motion signal. */}
      <Icon className="size-4 shrink-0 text-row-icon" />
      <span
        className={cn(
          "shrink-0 whitespace-nowrap font-medium",
          status === "pending" ? "animated-gradient-text" : "text-row-verb",
        )}
      >
        {verb ?? title}
      </span>
      {files.length > 0 ? (
        <>
          <FileChip path={files[0].path} />
          {range && (
            <span className="shrink-0 text-ui-sm text-foreground-subtlest">
              {range}
            </span>
          )}
        </>
      ) : isShell && typeof command === "string" && command !== "" ? (
        <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
          {command}
        </span>
      ) : summary ? (
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtlest">
          {summary}
        </span>
      ) : null}
      {stat && <DiffCount stat={stat} />}
      {status === "failed" && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 cursor-help whitespace-nowrap text-destructive underline decoration-dotted underline-offset-2">
                Failed
              </span>
            </TooltipTrigger>
            {failure && (
              <TooltipContent side="top" align="start" className="max-w-96">
                <div className="flex max-w-96 items-center gap-2">
                  <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {failure}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="default"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCopy();
                    }}
                    aria-label={copied ? "Error copied" : "Copy error"}
                    title={copied ? "Error copied" : "Copy error"}
                    className={cn(
                      COPY_BUTTON_WALL,
                      "shrink-0 text-foreground-subtle hover:text-foreground",
                    )}
                  >
                    {copied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                </div>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      )}
      {/* LEFT AS A TEMPLATE LITERAL on purpose (Task C8) — the same measured
          blocker as `ChangesGroupCard.tsx`'s chevron: the base spells two
          utilities from tailwind-merge's `transition` group, so `cn` drops
          `transition-transform` (kept today, and winning the cascade —
          `.transition-transform` is emitted after `.transition-opacity` in
          `dist/assets/*.css`). Converting here would stop the rotate from
          animating; the sibling file's comment carries the full reasoning. */}
      <ChevronRightIcon
        aria-hidden
        className={`size-4 shrink-0 text-foreground-subtlest opacity-0 transition-transform transition-opacity duration-200 ease-out group-hover/tool-summary:opacity-100 ${
          open ? "rotate-90 opacity-100" : "rotate-0"
        }`}
      />
    </button>
  );
}
