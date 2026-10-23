import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import MessageBubble from "./MessageBubble";
import type { Message } from "../store/sessions";
import { expandSkillMentions } from "../lib/skills";
import type { SkillInfo } from "../lib/tauri";

/**
 * C7 (finding 6d): the three hand-rolled `<button>`s in `MessageBubble` are
 * routed through `<Button>`. `MessageBubble.test.tsx` and
 * `MessageBubble.codeblock.test.tsx` own the BEHAVIOUR (collapse, copy, the
 * accessible names, the DOM path) and are deliberately UNTOUCHED — a conversion
 * that required editing one of them would be a repaint, not a refactor.
 *
 * This file owns what those tests cannot see: the CLASS CONTRACT. Per site it
 * pins (a) the route (`data-slot`/`data-variant`/`data-size`, with variant AND
 * size named explicitly because `ui/button.tsx:40` sets
 * `defaultVariants {variant:"default"}` and a bare `<Button>` paints
 * `bg-primary text-primary-foreground h-7 px-2`), (b) that every utility the
 * site spelled BEFORE the conversion is still painted, and (c) that none of the
 * utilities `<Button>` contributes survives where it would repaint.
 *
 * (c) is deliberately NOT one flat list. `cn()` drops the loser of a
 * same-group conflict, so a utility the base contributes is only a hazard where
 * the site has not already won that group — and whether an ALIGNMENT utility
 * (`justify-center`, `items-center`, `gap-1`) can paint at all depends on the
 * display the wall restores. At an icon-only button whose display is restored to
 * a BLOCK box (`inline-block`, blockified by `absolute` or by flex-item
 * blockification) those utilities have no flex container to act in, so they
 * survive in the attribute string and paint nothing; pinning their absence would
 * assert a wall the site does not need. Each group below is annotated with the
 * reason it applies where it applies.
 */

const tokens = (className: string): string[] =>
  [...new Set(className.split(/\s+/).filter(Boolean))];

/** The class list each site spelled BEFORE the extraction. Literals, so a
 *  repaint cannot move both sides of the comparison. */
const SKILL_HEADER_BEFORE = "flex w-full items-center gap-2 text-left";
const COPY_GLYPH_BEFORE =
  "shrink-0 text-foreground-subtle hover:text-foreground";
const COPY_RESPONSE_BEFORE =
  "self-end shrink-0 text-foreground-subtle hover:text-foreground";

/** Hazards at EVERY converted site, because each paints wherever a background,
 *  a box or a font-size is observable:
 *   - `bg-primary`/`text-primary-foreground` — the `defaultVariants` trap.
 *   - `h-7`/`px-2` — a fixed 28px tall, 8px-inset box; all three sites are
 *     content-sized (a 12px glyph, or a header exactly as tall as its label row).
 *   - `text-ui-base`/`text-ui-base/relaxed` — a font-size (and line-height) none
 *     of the three spelled. This is C7's recorded trap: `ChatStream.test.tsx`'s
 *     `primaryLines()` finds picker rows with `querySelectorAll(".text-ui-base")`,
 *     so a site that GAINS the token can be selected by a test that never saw it.
 *     `text-[length:inherit]` drops both — tailwind-merge removes the whole
 *     `text-ui-base/relaxed` utility, its `/relaxed` line-height with it, so the
 *     site declares no line-height either, exactly as it does today.
 *   - `transition-colors` — every one of these sites changes instantly today.
 *   - `inline-flex` — the base's display. The header spells `flex`; the two
 *     glyphs are the UA's `inline-block` and the badge is `absolute`, so on all
 *     three the wall restores a block-level box and a switch to flex would move
 *     the glyph from the box's start to its centre.
 *   - `hover:bg-hover` — `ghost`'s hover fill. None of these sites fills on
 *     hover today (the header and the glyphs have no fill at all; the badge keeps
 *     its own `bg-input`), so the wall names a different hover background.
 *   - `rounded-sm`/`size-5` — the `icon-xs` arm's radius and box, which the
 *     badge's own `rounded-full`/`size-4` outrank. Pinned so the merge order that
 *     makes this safe cannot silently invert. */
const COMMON_FORBIDDEN = [
  "bg-primary",
  "text-primary-foreground",
  "h-7",
  "px-2",
  "text-ui-base",
  "text-ui-base/relaxed",
  "transition-colors",
  "inline-flex",
  "hover:bg-hover",
  "rounded-sm",
  "size-5",
];

/** Extra hazards that apply to ONE site, with the reason. */
const SKILL_HEADER_FORBIDDEN = [
  // The header IS a real flex container (`flex w-full`) — unlike the two glyph
  // sites and the badge, whose restored `block` display leaves these inert.
  "justify-center", // it is a left-aligned row (it spells `text-left` for the same reason)
  "gap-1", // it spells `gap-2`
  "whitespace-nowrap", // its skill name wraps today (`normal` is inherited)
  "select-none", // the name is selectable text today
];

const skill = (): SkillInfo => ({
  name: "debug",
  description: "A debug skill",
  path: "/s/.agents/skills/debug/SKILL.md",
  dir: "/s/.agents/skills/debug",
  scope: "space",
  body: "Step 1. Step 2.",
  disableModelInvocation: false,
  shadowed: [],
});

const agentText = (text: string): Message => ({
  kind: "agent-text",
  messageId: "m1",
  text,
  at: 1,
});

/** Assert the contract for one converted site. */
function expectButtonContract(
  node: HTMLElement,
  before: string,
  size: string,
  extraForbidden: string[] = [],
): void {
  expect(node.tagName, "still a <button> element").toBe("BUTTON");
  expect(node.getAttribute("data-slot")).toBe("button");
  expect(node.getAttribute("data-variant")).toBe("ghost");
  expect(node.getAttribute("data-size")).toBe(size);
  const painted = tokens(node.className);
  for (const token of tokens(before)) {
    expect(painted, `the site lost ${token}`).toContain(token);
  }
  for (const banned of [...COMMON_FORBIDDEN, ...extraForbidden]) {
    expect(painted, `<Button> is painting ${banned} here`).not.toContain(
      banned,
    );
  }
}

describe("MessageBubble's three buttons (C7: routed through <Button>)", () => {
  it("the skill card header is a ghost/default Button keeping its row grammar", () => {
    const { container } = render(
      <MessageBubble
        message={{
          kind: "user",
          text: expandSkillMentions("fix $debug", [skill()]),
          at: 1,
        }}
      />,
    );
    const header = container.querySelector("button") as HTMLElement;
    expectButtonContract(
      header,
      SKILL_HEADER_BEFORE,
      "default",
      SKILL_HEADER_FORBIDDEN,
    );
    // `aria-expanded` is the collapse contract `MessageBubble.test.tsx` reads,
    // and it is also why this site needs `aria-expanded:bg-transparent`: `ghost`
    // carries `aria-expanded:bg-hover`, which would fill the OPEN header.
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.className).toContain("aria-expanded:bg-transparent");
    expect(tokens(header.className)).not.toContain("aria-expanded:bg-hover");
    // The icon hazard: the size's `[&_svg:not([class*='size-'])]:size-3.5`
    // selects any svg that does not spell its own `size-*`. Both glyphs do.
    const svgs = [...header.querySelectorAll("svg")];
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) {
      expect(svg.getAttribute("class")).toContain("size-4");
    }
  });

  it("the code fence's copy glyph is a ghost/default Button keeping its ink grammar", async () => {
    const { findByTestId } = render(
      <MessageBubble message={agentText("```json\n{}\n```")} />,
    );
    // `findBy*`: the header is what the codeblock tests wait on (Shiki resolves
    // asynchronously; the fallback branch renders the same header).
    const header = await findByTestId("code-block-header");
    const button = header.querySelector("button") as HTMLElement;
    expect(button.getAttribute("aria-label")).toBe("Copy code");
    expectButtonContract(button, COPY_GLYPH_BEFORE, "default");
    // The icon hazard, and the shape that makes it safe here: this glyph sizes
    // itself with a `size-3` CLASS (not a `size={12}` prop), so the base's
    // `[&_svg:not([class*='size-'])]:size-…` guard excludes it. A PROP would have
    // lost to CSS with nothing in the DOM showing it — the hazard C7 group 3 had
    // to fix. `width="24"` is lucide's DEFAULT attribute and CSS already outranks
    // it today, which is the same CSS-beats-attribute direction that makes the
    // hazard real; pinned so a swap to a `size` PROP is visible here.
    const svg = button.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("class")).toContain("size-3");
    expect(svg.getAttribute("width")).toBe("24");
  });

  it("the response copy glyph is a ghost/default Button and keeps its `self-end` pin", () => {
    const { container } = render(
      <MessageBubble message={agentText("the reply")} />,
    );
    const button = container.querySelector(
      '[data-testid="copy-response"]',
    ) as HTMLElement;
    expectButtonContract(button, COPY_RESPONSE_BEFORE, "default");
    // `MessageBubble.test.tsx:317-318` reads THIS node's className directly:
    // `toContain("self-end")` / `not.toContain("self-start")`. `<Button>`'s base
    // spells no `self-*`, so the site's own `self-end` survives the merge. Pinned
    // here too, so a future base that adds one is caught in the right file rather
    // than as a mystery failure in the behaviour suite.
    expect(button.className).toContain("self-end");
    expect(button.className).not.toContain("self-start");
    const svg = button.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("class")).toContain("size-3");
    expect(svg.getAttribute("width")).toBe("24");
  });

  it("adds the three data attributes and nothing else to the tag", () => {
    const { container } = render(<MessageBubble message={agentText("hi")} />);
    const button = container.querySelector(
      '[data-testid="copy-response"]',
    ) as HTMLElement;
    expect(Object.keys(button.dataset).sort()).toEqual([
      "size",
      "slot",
      "testid",
      "variant",
    ]);
  });
});
