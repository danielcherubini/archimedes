import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MutedCaption } from "./MutedCaption";

/**
 * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
 * `SVGAnimatedString` for SVG elements and this component may one day render
 * into a non-HTML slot (`IpcErrorLine.test.tsx` / `SessionStatusMark.test.tsx`
 * carry the same note).
 */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

describe("MutedCaption (the quiet one-line caption, once)", () => {
  it("carries the measured pair verbatim: text-ui-xs + text-foreground-subtlest", () => {
    render(<MutedCaption>global</MutedCaption>);
    const cls = classOf(screen.getByText("global"));
    // BOTH utilities, and asserted as whole tokens (a substring match would
    // still pass if `text-ui-xs` were replaced by `text-ui-sm`, since
    // `text-foreground-subtlest` contains `text-`).
    expect(cls.split(/\s+/)).toContain("text-ui-xs");
    expect(cls.split(/\s+/)).toContain("text-foreground-subtlest");
  });

  it("renders a <span> by default (the element 7 of the 10 verbatim sites use)", () => {
    render(<MutedCaption>manual only</MutedCaption>);
    expect(screen.getByText("manual only").tagName).toBe("SPAN");
  });

  it("renders a <p> when asked (the block-shaped sites: footer hints, metrics)", () => {
    render(<MutedCaption as="p">Enter submit · Esc cancel</MutedCaption>);
    expect(screen.getByText("Enter submit · Esc cancel").tagName).toBe("P");
  });

  it("renders a <div> when asked (the flex-container sites)", () => {
    // The six container rows the fold cannot smuggle into a <span>: the agent
    // rule rows, the two shadow-report rows and the subagent metrics row are
    // BLOCKS whose `min-w-0` / `flex-wrap` / `truncate` behaviour depends on
    // being a block-level box. A fold that turned them into spans would be a
    // DOM change wearing a refactor's clothes — so the component offers `div`.
    render(<MutedCaption as="div">edit *.md → allow</MutedCaption>);
    expect(screen.getByText("edit *.md → allow").tagName).toBe("DIV");
  });

  it("forwards the attributes a DOM-identical fold needs (data-permission-rule, aria-hidden)", () => {
    // The carry that makes the fold byte-identical rather than lossy:
    //  - `data-permission-rule` is LOAD-BEARING — AgentsDialog.test.tsx's
    //    `permissionLines()` reads `querySelectorAll("[data-permission-rule]")`,
    //    so dropping it empties that helper and reddens the no-sort test;
    //  - `aria-hidden` is the mention picker's prefix badge declaring itself
    //    decorative (the row's text carries the announcement) — dropping it is
    //    an a11y regression the fold must not smuggle in.
    render(
      <MutedCaption as="div" data-permission-rule="">
        edit *.md → allow
      </MutedCaption>,
    );
    const rule = screen.getByText("edit *.md → allow");
    expect(rule.getAttribute("data-permission-rule")).toBe("");
    // The pair still rides along on a row that brings its own attributes.
    expect(classOf(rule)).toContain("text-ui-xs");

    render(
      <MutedCaption className="shrink-0" aria-hidden>
        $
      </MutedCaption>,
    );
    expect(screen.getByText("$").getAttribute("aria-hidden")).toBe("true");
  });

  it("adds NO element of its own — the caption is the box, no wrapper", () => {
    const { container } = render(<MutedCaption>·</MutedCaption>);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild!.tagName).toBe("SPAN");
  });

  it("merges a caller's geometry WITHOUT dropping the pair", () => {
    // The `min-w-0 truncate` and `shrink-0` variants of the same caption pass
    // through `className`. None of them touches the font-size or text-colour
    // group, so `cn` keeps the pair — the whole reason the conversion is safe
    // (a caller that DID override the size would win, which is the point of
    // `cn`, and is the next test).
    render(<MutedCaption className="min-w-0 truncate">path</MutedCaption>);
    const tokens = classOf(screen.getByText("path")).split(/\s+/);
    expect(tokens).toContain("min-w-0");
    expect(tokens).toContain("truncate");
    expect(tokens).toContain("text-ui-xs");
    expect(tokens).toContain("text-foreground-subtlest");
  });

  it("lets a caller override the SIZE, and keeps the ink (the same-group rule)", () => {
    // `cn` resolves conflicting utilities: `text-ui-base` is the same
    // tailwind-merge font-size group as `text-ui-xs`, so the LATER one wins and
    // the base's `text-ui-xs` is dropped. This is the behavioural difference
    // between `cn` and a template literal, pinned here so a reader of the
    // component knows which way an override resolves.
    render(<MutedCaption className="text-ui-base">bigger</MutedCaption>);
    const tokens = classOf(screen.getByText("bigger")).split(/\s+/);
    expect(tokens).toContain("text-ui-base");
    expect(tokens).not.toContain("text-ui-xs");
    expect(tokens).toContain("text-foreground-subtlest");
  });

  it("carries a title (the tooltip half of the `manual only` caption)", () => {
    render(<MutedCaption title={"Why: shadowed"}>manual only</MutedCaption>);
    expect(screen.getByText("manual only").getAttribute("title")).toBe(
      "Why: shadowed",
    );
  });

  it("renders element children unchanged (the metrics line shape)", () => {
    const { container } = render(
      <MutedCaption as="p">
        <span data-slot="errs">2 errors</span>
        {" · "}
        <span data-slot="tok">1.2k tokens</span>
      </MutedCaption>,
    );
    const caption = container.firstElementChild as HTMLElement;
    // The caption owns its class list and NOTHING else: the children keep their
    // own elements and their own classes (the metrics line nests a
    // `text-destructive` span inside the muted paragraph).
    expect(caption.tagName).toBe("P");
    expect(
      (caption.querySelector('[data-slot="errs"]') as HTMLElement).getAttribute(
        "class",
      ),
    ).toBeNull();
    expect(caption.textContent).toBe("2 errors · 1.2k tokens");
  });

  it("emits NO stray whitespace in the class attribute (clsx joins, no trailing space)", () => {
    const { container } = render(<MutedCaption>x</MutedCaption>);
    const cls = classOf(container.firstElementChild!);
    expect(cls).not.toMatch(/\s$/);
    expect(cls).not.toMatch(/^\s/);
    expect(cls).not.toMatch(/\s\s/);
  });
});
