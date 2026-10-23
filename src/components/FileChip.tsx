import { basenameOfPath } from "../lib/paths";
import { fileIconFor } from "../lib/fileIcons";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";

const CHIP_CLASSES =
  "inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle";

/**
 * C7: what `<Button>`'s base and the `default` size would change HERE, undone.
 * A bare `<Button>` renders `bg-primary text-primary-foreground h-7 px-2`
 * (`ui/button.tsx:40` sets `defaultVariants {variant:"default"}`), so this chip
 * names `variant="ghost"` AND `size="default"` and carries the wall below.
 * Measured with the real `cn()` — the utility SET of the rendered class
 * attribute is identical to `CHIP_CLASSES + "cursor-pointer hover:text-foreground
 * text-left"`; every entry here removes a real repaint:
 *  - `border-0`        — the base's `border` is a 1px ring; preflight sets
 *                        `border: 0 solid`, so this chip has none today. It
 *                        would grow the box 2px and inset the glyph. With the
 *                        width at zero the base's `bg-clip-padding` is a no-op
 *                        (padding-box == border-box) and the chip paints no
 *                        background anyway.
 *  - `h-auto` / `px-0` — the size's `h-7 px-2` is a fixed 28px tall, 8px
 *                        inset chip; the chip is content-sized on both axes.
 *  - `shrink`          — the chip is a FLEX ITEM in `ToolCallCard`'s file row
 *                        (`flex … items-center gap-2`), and the base's
 *                        `shrink-0` would make it refuse to shrink, so the row
 *                        (which is `overflow-hidden`) would CLIP the basename
 *                        instead of eliding it.
 *  - `text-[length:inherit]` — the size declares `text-ui-base` (14px via
 *                        `--ui-font-size`) and the base declares
 *                        `text-ui-base/relaxed`; `cn` keeps the LAST of the
 *                        font-size group, so this arbitrary-value utility wins
 *                        both and the chip keeps the font-size AND the
 *                        line-height it inherits from whatever card hosts it
 *                        (the transcript body is `text-ui-sm` in places — this
 *                        is a real repaint, not a hypothetical).
 *  - `whitespace-normal` — the base's `whitespace-nowrap` (the chip inherited
 *                        `normal`).
 *  - `transition-none` — the base's `transition-colors` would animate the
 *                        `hover:text-foreground` ink change; the chip is
 *                        instant today.
 *  - `select-auto`     — the base's `select-none` would make a file's basename
 *                        unselectable.
 *  - `justify-start`   — the base centres on the main axis; the chip is a
 *                        left-aligned label (it already spells `text-left` for
 *                        the same reason — the UA's centred `text-align`).
 *  - `hover:bg-transparent` — `ghost` adds `hover:bg-hover`, and this chip's
 *                        hover affordance is the INK only.
 * Inert additions: `rounded-md`/`bg-clip-padding` (no background, no border);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus in every browser and again under `forced-colors`); `disabled:*` and
 * `aria-expanded:*` (a chip is never disabled and never expanded);
 * `group/button` (nothing reads that group — grep-verified);
 * `gap-1` (the chip spells `gap-1.5`, which wins);
 * `has-data-[icon=inline-*]:pr/pl` (lucide icons set no `data-icon`);
 * `[&_svg]:pointer-events-none` (the handler is on the button, so the click
 * target moving off the `<svg>` cannot change what runs);
 * `[&_svg]:shrink-0` and `[&_svg:not([class*='size-'])]:size-3.5` (the glyph
 * carries an explicit `size-4`, so the `:not([class*='size-'])` guard excludes
 * it — this is the icon-resize hazard, checked).
 */
const CHIP_BUTTON_WALL =
  "border-0 h-auto px-0 shrink justify-start whitespace-normal transition-none select-auto text-[length:inherit] hover:bg-transparent";

/**
 * A file chip: a 16px language icon + the basename (`title` = the full path).
 *
 * It is interactive ONLY where the caller passes `onOpen` — then the SAME
 * icon + name markup sits inside a `<button>` (a `<button>`, not an `<a>`,
 * because the target is a FILE and the click is an **External open** of the
 * path — an anchor would advertise a URL it does not have).
 *
 * Exactly ONE of the five call sites does: the `ToolCallCard`'s EXPANDED-BODY
 * file row (`ToolCallCard.tsx:123`). The other four render INSIDE a toggle
 * `<button>` — `ToolCallCardHeader.tsx:99` (inside the button opened at `:82`)
 * and `ChangesGroupCard.tsx:211`/`:229`/`:234` (inside the button opened at
 * `:168`) — where a nested `<button>` would be invalid HTML whose click also
 * toggles the card. So the DEFAULT stays the inert `<span>`, byte-identical to
 * before, which additionally keeps `ChangesGroupCard`'s responsive chip-width
 * measurement (it measures the chip wrappers) untouched.
 */
export default function FileChip({
  path,
  onOpen,
}: {
  path: string;
  onOpen?: () => void;
}) {
  const spec = fileIconFor(path);
  const name = basenameOfPath(path) || path;
  const Icon = spec.icon;
  // Shared so both shapes carry identical inner markup — the inert shape is
  // what the four button-nested call sites render.
  const glyph = (
    <>
      <Icon className={cn("size-4 shrink-0", spec.className)} />
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
  if (onOpen) {
    // `text-left` is not decoration: a `<button>` takes the UA stylesheet's
    // centred `text-align` (Tailwind's preflight does not reset it), which
    // would shift a truncated basename relative to the inert `<span>`.
    return (
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={onOpen}
        title={path}
        className={cn(
          CHIP_BUTTON_WALL,
          CHIP_CLASSES,
          "cursor-pointer hover:text-foreground text-left",
        )}
      >
        {glyph}
      </Button>
    );
  }
  return (
    <span className={CHIP_CLASSES} title={path}>
      {glyph}
    </span>
  );
}
