import { X } from "lucide-react";
import type { ChatComposerAttachment } from "../../lib/chatAttachments";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";

/**
 * C7: what `<Button>`'s base and the `ghost`/`icon-xs` arms would change on this
 * remove badge, undone. A bare `<Button>` renders
 * `bg-primary text-primary-foreground h-7 px-2` (`ui/button.tsx:40` sets
 * `defaultVariants {variant:"default"}`), so the badge names `variant="ghost"`
 * AND `size="icon-xs"` and carries this wall. `icon-xs` is the arm whose box is
 * already an icon box; the badge's own `size-4 rounded-full bg-input p-0`
 * outranks its `size-5 rounded-sm` in those groups, so the arm contributes no
 * geometry once the merge runs. Measured with the real `cn()`: the rendered
 * utility SET keeps every utility the badge spelled before the conversion.
 *  - `border-0` — the base's `border` is a 1px ring; preflight sets
 *                 `border: 0 solid`, so this badge has none today. It would grow
 *                 the 16px box to 18px and inset the 12px X. With the width at
 *                 zero the base's `bg-clip-padding` is a no-op (padding-box ==
 *                 border-box), which is why the badge's real `bg-input` fill is
 *                 unaffected and needs no `bg-clip-border` like the settings
 *                 picker cells did.
 *  - `block` — the base's `inline-flex`. The badge is `absolute`, so it is
 *                 blockified either way, but the display GROUP is what decides
 *                 whether the base's `items-center justify-center` have a flex
 *                 container to distribute in: under `block` the 12px X sits at
 *                 the box's top-left exactly as it does on the bare `<button>`
 *                 today, under `inline-flex` it would be centred. Restoring the
 *                 display is what makes those two additions inert.
 *  - `text-[length:inherit]` — the base declares `text-ui-base/relaxed` and the
 *                 size declares `text-ui-base`; neither is a font-size this badge
 *                 ever spelled. This is the hazard C7 records:
 *                 `ChatStream.test.tsx`'s `primaryLines()` finds picker rows with
 *                 `querySelectorAll(".text-ui-base")`, so a site that GAINS the
 *                 token can be selected by a test that never saw it. The
 *                 arbitrary-value utility wins the whole font-size group, so no
 *                 line-height is declared either — as today.
 *  - `hover:bg-input` — `ghost` adds `hover:bg-hover`, a DIFFERENT fill from the
 *                 `bg-input` the badge paints. Naming another `hover:bg-*` is the
 *                 only way to displace it (the badge's own `bg-input` is a
 *                 different group), and naming the badge's own colour makes hover
 *                 a no-op, which is what happens today.
 * Inert here: `rounded-md` (the badge's `rounded-full` wins the group);
 * `gap-1` (not a flex container once `block` wins, and one child anyway);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus in every browser, and again under `forced-colors`); `disabled:*` (the
 * badge is never disabled); `aria-invalid:*` and `aria-expanded:*` (a remove
 * badge is neither); `group/button` (grep-verified: nothing reads that group);
 * `has-data-[icon=inline-*]:pr/pl` (lucide sets no `data-icon` attribute);
 * `text-foreground` and `hover:text-foreground` (the badge spells no ink of its
 * own, so `ghost`'s survive the merge — and the only thing it paints is the X,
 * which spells `text-foreground` itself, so the inherited value the badge now
 * also declares is the value the glyph already renders);
 * `whitespace-nowrap` (an icon carries no text); `select-none` (nothing to
 * select); `shrink-0` (the badge is `absolute`, so out of flow and never
 * shrunk); `transition-colors` (the badge's own `transition-opacity` wins the
 * transition group, so the base's is dropped by the merge, not merely
 * overridden); `[&_svg]:pointer-events-none` (the handler is on the button);
 * `[&_svg]:shrink-0` (the X is the only child); and
 * `[&_svg:not([class*='size-'])]:size-2.5` — the icon-size hazard, excluded
 * because the X spells its own `size-3` CLASS (a `size={12}` PROP would have
 * lost to CSS with nothing in the DOM showing it).
 * The `data-slot`/`data-variant`/`data-size` attributes are new, and no test
 * reads them here; the badge is found by `aria-label` in `ChatStream.test.tsx`
 * and `QueueRow.test.tsx`, which is unaffected. It is NOT inside the
 * `SidePane.test.tsx` frame that pins "no absolutely-positioned button", because
 * `SidePane` renders neither the composer nor the transcript.
 */
const REMOVE_BADGE_WALL =
  "border-0 block text-[length:inherit] hover:bg-input";

/**
 * The composer's staged-image thumbnail strip.
 *
 * Props-only: the `attachments` state + the object-URL lifecycle (staging,
 * release-on-remove, release-on-session-switch, release-on-unmount) all stay
 * in `ChatStream` — they coordinate with `send()` and the session-switch
 * effect. Extracted verbatim from `ChatStream` (identical DOM); renders
 * nothing while nothing is staged.
 */
export default function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: ChatComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att, index) => (
            <div
              key={att.id}
              className="group relative size-12 overflow-hidden rounded-lg border border-input-border bg-input"
            >
              <img
                src={att.objectUrl}
                alt={att.filename}
                className="size-full object-cover"
              />
              {/* The `[image #N]` the draft uses for this picture (1-based, in
                  staging order), so the number in the text is checkable against
                  the image it names. Decoration beside the thumbnail, so
                  `aria-hidden`: a screen reader already gets the file name from
                  the `img`, and a bare `#1` in the accessible name would be
                  noise. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-input/90 px-1 text-ui-xs leading-tight text-foreground-subtle"
              >
                {`#${index + 1}`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Remove image attachment"
                onClick={() => onRemove(att.id)}
                className={cn(
                  REMOVE_BADGE_WALL,
                  "absolute right-0.5 top-0.5 size-4 rounded-full bg-input p-0 opacity-0 transition-opacity group-hover:opacity-100",
                )}
              >
                <X className="size-3 text-foreground" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
