import { fireEvent, render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import AttachmentStrip from "./AttachmentStrip";
import type { ChatComposerAttachment } from "../../lib/chatAttachments";

/**
 * The composer's staged-image strip, asserted ONLY on the thing C7 changed: the
 * per-thumbnail remove button's route through `<Button>`.
 *
 * The strip's BEHAVIOUR (staging, object-URL release, renumbering) is owned by
 * `ChatStream` and `QueueRow` and is already pinned there — `ChatStream.test.tsx`
 * clicks this button by accessible name in six tests and `QueueRow.test.tsx` in
 * one. This file exists for the markup contract those tests cannot see: that the
 * conversion to `<Button>` neither repaints the badge nor drops a utility the
 * badge paints today.
 */
function attachment(id: string): ChatComposerAttachment {
  return {
    id,
    file: new File([new Uint8Array([1])], `${id}.png`, { type: "image/png" }),
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
    objectUrl: `blob:/${id}`,
  };
}

/** The class list the badge spelled BEFORE C7 routed it through `<Button>`.
 *  Pinned as a literal on purpose: recomputing it from the component would let a
 *  repaint move both sides of the comparison. */
const PRE_EXTRACTION =
  "absolute right-0.5 top-0.5 size-4 rounded-full bg-input p-0 opacity-0 transition-opacity group-hover:opacity-100";

/** Utilities `<Button>` must NOT end up painting here. Each is a real repaint
 *  the component's wall removes: `bg-primary`/`text-primary-foreground` (the
 *  `defaultVariants` trap, `ui/button.tsx:40`), `h-7`/`px-2`/`size-5` (a fixed
 *  box replacing the 16px badge), `rounded-sm` (a square-ish radius replacing
 *  `rounded-full`), `hover:bg-hover` (a different fill on hover),
 *  `text-ui-base`/`text-ui-base/relaxed` (a font-size the badge never spelled —
 *  and the token `ChatStreamDirectoryCompletion.test.tsx`'s `primaryLines()` selects on), and
 *  `inline-flex` (a flex container centring the glyph; the badge's box is
 *  `block`, so its 12px X sits at the top-left of the 16px box, not centred).
 *  `border-transparent` is deliberately NOT here: it survives next to `border-0`
 *  (a different tailwind-merge group) and has nothing to draw at zero width. */
const FORBIDDEN = [
  "bg-primary",
  "text-primary-foreground",
  "h-7",
  "px-2",
  "size-5",
  "rounded-sm",
  "hover:bg-hover",
  "text-ui-base",
  "text-ui-base/relaxed",
  "inline-flex",
];

const tokens = (className: string): string[] =>
  [...new Set(className.split(/\s+/).filter(Boolean))];

describe("AttachmentStrip's remove button (C7: routed through <Button>)", () => {
  const renderOne = () =>
    render(
      <AttachmentStrip attachments={[attachment("a1")]} onRemove={() => {}} />,
    );

  it("is a <Button> naming variant AND size explicitly", () => {
    const { container } = renderOne();
    const button = container.querySelector(
      'button[aria-label="Remove image attachment"]',
    ) as HTMLElement;
    expect(button.getAttribute("data-slot")).toBe("button");
    // Both named: a bare `<Button>` folds in `defaultVariants` and paints the
    // badge `bg-primary text-primary-foreground h-7 px-2`.
    expect(button.getAttribute("data-variant")).toBe("ghost");
    expect(button.getAttribute("data-size")).toBe("icon-xs");
  });

  it("keeps every utility the badge spelled before the extraction", () => {
    const { container } = renderOne();
    const button = container.querySelector(
      'button[aria-label="Remove image attachment"]',
    ) as HTMLElement;
    const painted = tokens(button.className);
    for (const token of tokens(PRE_EXTRACTION)) {
      expect(painted, `the badge lost ${token}`).toContain(token);
    }
  });

  it("paints none of the utilities <Button> would otherwise contribute", () => {
    const { container } = renderOne();
    const button = container.querySelector(
      'button[aria-label="Remove image attachment"]',
    ) as HTMLElement;
    for (const banned of FORBIDDEN) {
      expect(
        tokens(button.className),
        `<Button> is painting ${banned} on the badge`,
      ).not.toContain(banned);
    }
  });

  it("sizes its glyph with a size-* CLASS, so the size's icon rule cannot force 10px", () => {
    // `icon-xs` carries `[&_svg:not([class*='size-'])]:size-2.5`; the guard
    // excludes an svg that spells its own `size-*`, and CSS would beat a `size`
    // PROP anyway. The badge's X spells `size-3`, so it stays 12px in a 16px box.
    const { container } = renderOne();
    const svg = container.querySelector(
      'button[aria-label="Remove image attachment"] svg',
    ) as SVGSVGElement;
    expect(svg.getAttribute("class")).toContain("size-3");
  });

  it("still removes the attachment it belongs to", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <AttachmentStrip attachments={[attachment("a1")]} onRemove={onRemove} />,
    );
    fireEvent.click(
      container.querySelector(
        'button[aria-label="Remove image attachment"]',
      ) as HTMLElement,
    );
    expect(onRemove).toHaveBeenCalledWith("a1");
  });
});
