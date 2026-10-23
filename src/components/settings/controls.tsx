import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { BrailleLoader } from "@/components/ui/braille-loader";
import { brailleLoaderVariants } from "@/lib/braille-loader";
import { cn } from "@/components/lib/utils";
import { Button } from "@/components/ui/button";
import { humanizeVariant } from "./primitives";
/**
 * C7: the two radiogroup pickers below are `<Button>`s, and both cells carried
 * the SAME styling by hand — this constant is that shared shape plus what the
 * base and the `default` size would otherwise change. Both name
 * `variant="ghost"` and `size="default"` explicitly, because `ui/button.tsx:40`
 * sets `defaultVariants {variant:"default"}` and a bare `<Button>` would paint
 * every cell `bg-primary text-primary-foreground` at `h-7 px-2`.
 *
 * Measured with the real `cn()`: the rendered utility SET equals what each cell
 * spelled before. What this wall undoes:
 *  - `bg-clip-border` — the base's `bg-clip-padding` is REAL here (unlike the
 *    borderless sites): these cells DO have a 1px border and the selected arm
 *    DOES paint a background, so clipping to padding-box would stop the fill
 *    from running under the semi-transparent `border-border` ring. This is
 *    preflight's default for a plain `<button>`; the utility restores it.
 *  - `h-auto` — the size's `h-7` is a fixed 28px; the cells are `py-1.5`-high
 *    and content-sized (the spinner cell stacks a live `BrailleLoader` over a
 *    label, so its height is the loader's).
 *  - `whitespace-normal` — the base's `whitespace-nowrap` (the cells inherited
 *    `normal`).
 *  - `select-auto` — the base's `select-none` would make the variant name
 *    unselectable text.
 *  - `text-[length:inherit]` — the size declares `text-ui-base` and the base
 *    declares `text-ui-base/relaxed`; `cn()` keeps the LAST utility of the
 *    font-size group, so this restores the font-size the cell INHERITED and, by
 *    collapsing both, declares no line-height either. It matters for the SPINNER
 *    cell, which spells no font-size at all (its label span spells `text-[10px]`
 *    and its loader sets an inline `fontSize`, but the cell box itself declared
 *    none before); it is DROPPED by the merge for the FILM cell, which spells
 *    `text-[10px]` later and wins the group outright — so that cell keeps its
 *    10px exactly as it did. Restoring rather than arguing away: a `text-ui-*`
 *    class the button gains is a class some other selector can read (see
 *    `ComposerMentions.tsx` for the one that actually bit).
 *  - `hover:bg-primary/10` on the SELECTED arm only — the selected cell spelled
 *    NO hover background, so its fill simply persisted under the pointer.
 *    `ghost` adds `hover:bg-hover`, and `cn()` can only drop it by replacing it
 *    with another `hover:bg-*`; restating the resting fill is the one replacement
 *    that paints what painted before (hover → `bg-primary/10` = the resting
 *    value, so nothing moves). The UNSELECTED arm needs nothing: it already
 *    spells `hover:bg-muted`, which wins the group outright.
 *  - `text-inherit` + `hover:text-inherit` — `ghost` declares
 *    `text-foreground`/`hover:text-foreground`. These cells paint NO ink of
 *    their own (the spinner cell's label span spells its own colour; the film
 *    cell's text is bare and inherits the page ink), so the pair is restored to
 *    inherit on both the base and the hover state.
 * The base's `justify-center` needs NO undo: the spinner cell is `flex-col` at
 * `h-auto`, so its main axis is exactly as tall as its content and there is no
 * free space to distribute; the film cell already spells `justify-center`.
 * Inert here: `shrink-0` (these are GRID items — `flex-shrink` does not apply),
 * `gap-1` (the spinner cell spells `gap-1.5`, which wins; the film cell has one
 * child so a gap cannot show), `outline-none` (`base.css:53-57` forces
 * `outline: none !important` on every focus, and again under `forced-colors`),
 * `disabled:*` (never disabled), `aria-expanded:*` (Radix's `role="radio"` sets
 * `aria-checked`, never `aria-expanded`), `aria-invalid:*`, `group/button`,
 * `rounded-md` (the cells spell `rounded-md`), `bg-clip-*` interplay with
 * `border` (the cell's own `border` + colour win the width and colour groups),
 * `has-data-[icon=inline-*]:pr/pl` (lucide sets no `data-icon`),
 * `[&_svg]:pointer-events-none` / `[&_svg]:shrink-0` /
 * `[&_svg:not([class*='size-'])]:size-3.5` — the spinner cell's only svg-bearing
 * descendant is a `BrailleLoader`, which renders TEXT spans and no `<svg>`; the
 * film cell renders a text label. The icon-resize hazard does not arise.
 */
const PICKER_CELL_WALL =
  "bg-clip-border h-auto whitespace-normal select-auto text-[length:inherit] text-inherit hover:text-inherit";

/**
 * The ZCode `FontSizeInput` pattern: a `w-28` number `Input` (12–20,
 * `px` suffix) with a local draft — commit on blur/Enter (clamped),
 * Escape cancels the draft.
 */
export function FontSizeInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}): ReactElement {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <div className="relative w-28">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
        className="pr-8"
      />
      <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ui-sm text-foreground-subtlest">
        px
      </span>
    </div>
  );
}

/**
 * The thinking-spinner picker (the `Appearance` section): a `4`-column
 * radiogroup grid of the FULL `braille-loader` gallery — every variant as
 * a LIVE `BrailleLoader` preview (an animated 2×N braille block) + its
 * humanized name. A cell picks its variant immediately (the page's
 * immediate-save pattern). The `aria-label` is the humanized name (it
 * wins over the cell's content for naming — the visible label stays a
 * plain visual duplicate).
 */
export function SpinnerStylePicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (variant: string) => void;
  ariaLabel?: string;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? "Thinking spinner"}
      className="grid grid-cols-4 gap-1.5"
    >
      {brailleLoaderVariants.map((variant) => {
        const selected = value === variant;
        const name = humanizeVariant(variant);
        return (
          <Button
            key={variant}
            type="button"
            role="radio"
            variant="ghost"
            size="default"
            aria-checked={selected}
            aria-label={name}
            onClick={() => onChange(variant)}
            className={cn(
              PICKER_CELL_WALL,
              "flex flex-col items-center gap-1 rounded-md border px-2 py-1.5 transition-colors",
              selected
                ? "border-primary bg-primary/10 hover:bg-primary/10"
                : "border-border hover:bg-muted",
            )}
          >
            <BrailleLoader
              variant={variant}
              speed="normal"
              fontSize={14}
              label={name}
            />
            <span className="text-[10px] leading-none text-foreground-subtle">
              {name}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The film's CLOSED vocabulary, in display order — the single source for both
 * the picker's cells and `AppearanceSection`'s `closedSelectValue` membership
 * check, so the two can never disagree about what is a legal stored value.
 * `null` is deliberately absent: it is the stored DEFAULT, not an option, and
 * it resolves to `animated` (the app default) rather than being its own cell.
 */
export const EMPTY_STATE_ANIMATION_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "static", label: "Static" },
  { value: "animated", label: "Animated" },
] as const;

/**
 * The empty-session-animation picker (the `Appearance` section): the three
 * states of the transcript's empty-state film as a 3-column radiogroup.
 *
 * The cells are TEXT, not previews: the film is a WebGL scene that only exists
 * in the transcript, so a live preview would mean running the renderer inside
 * Settings — the opposite of what this control exists to make possible (the
 * user asking for it to stop). The button styling is `SpinnerStylePicker`'s.
 *
 * `value` is the RESOLVED selection (`closedSelectValue` semantics, applied by
 * the caller): the stored default is `null` and it renders as `animated`, and a
 * value outside the vocabulary also renders as the default rather than leaving
 * nothing checked — an unchecked radiogroup would misreport what is on screen.
 * Every click writes a real vocabulary value, so a page that is only opened
 * never rewrites the file.
 */
export function EmptyStateAnimationPicker({
  value,
  onChange,
  ariaLabel = "Empty-session animation",
}: {
  value: string | null;
  onChange: (setting: "off" | "static" | "animated") => void;
  ariaLabel?: string;
}): ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid grid-cols-3 gap-1.5">
      {EMPTY_STATE_ANIMATION_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <Button
            key={option.value}
            type="button"
            role="radio"
            variant="ghost"
            size="default"
            aria-checked={selected}
            aria-label={option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              PICKER_CELL_WALL,
              "flex items-center justify-center rounded-md border px-2 py-1.5 text-[10px] leading-none transition-colors",
              selected
                ? "border-primary bg-primary/10 hover:bg-primary/10"
                : "border-border hover:bg-muted",
            )}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * A provider text field (immediate save): a local draft that commits on
 * blur/Enter ONLY when the value actually changed (a no-change blur saves
 * nothing and re-runs no discovery).
 */
export function TextField({
  value,
  placeholder,
  ariaLabel,
  className,
  type = "text",
  onCommit,
}: {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  type?: "text" | "password";
  onCommit: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  // Re-sync when the committed value changes externally.
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      type={type}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/** A labeled provider field (a small caption above a full-width `TextField`). */
export function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <div className="mb-1 text-ui-sm text-foreground-subtle">{label}</div>
      {children}
    </div>
  );
}
