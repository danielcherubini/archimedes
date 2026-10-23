import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EmptyListLine } from "./EmptyListLine";

function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

describe("EmptyListLine (the empty-list sentence inside a picker/list, once)", () => {
  it("carries the measured triple verbatim: p-3 + text-ui-sm + text-foreground-subtlest", () => {
    render(<EmptyListLine>No skills found.</EmptyListLine>);
    const tokens = classOf(screen.getByText("No skills found.")).split(/\s+/);
    // Whole tokens, for the same reason `MutedCaption.test.tsx` gives.
    expect(tokens).toContain("p-3");
    expect(tokens).toContain("text-ui-sm");
    expect(tokens).toContain("text-foreground-subtlest");
  });

  it("renders a <p> — the element all 8 measured sites use", () => {
    render(<EmptyListLine>No models found.</EmptyListLine>);
    expect(screen.getByText("No models found.").tagName).toBe("P");
  });

  it("adds no wrapper element (a list's empty state is a sibling of its rows)", () => {
    const { container } = render(<EmptyListLine>x</EmptyListLine>);
    expect(container.children).toHaveLength(1);
  });

  it("interpolates copy the way the sites do (the quote-bearing `No X match \"{query}\"`)", () => {
    const query = "skil";
    render(<EmptyListLine>{`No skills match "${query}".`}</EmptyListLine>);
    expect(screen.getByText('No skills match "skil".')).toBeTruthy();
  });

  it("accepts a className override through cn(); a same-group override WINS, a parent/child pair does NOT", () => {
    // `McpSection`'s empty row is the DIFFERENT variant —
    // `px-4 py-3 text-ui-base text-foreground-subtle` — and the task is explicit
    // that it stays an override rather than a new arm of this component. Pinned
    // here is what an override actually produces, MEASURED against the real
    // `cn()`, because it is not the union and not a clean replacement either:
    //  - `text-ui-sm` yields to `text-ui-base` (one font-size group), and
    //    `text-foreground-subtlest` yields to `text-foreground-subtle` (one
    //    text-colour group) — `cn` DROPS the base's utility;
    //  - `p-3` does NOT get dropped by `px-4`/`py-3`. tailwind-merge treats a
    //    later axis-specific utility as winning by CSS order rather than by
    //    deleting its parent (`dist/assets/*.css` puts `.px-4` after `.p-3`), so
    //    all three survive and the axis pair wins the cascade.
    // That last line is the reason `McpSection:436` is NOT folded onto this
    // component (see the task report): the override would ship a class string
    // carrying a padding utility that does nothing.
    render(
      <EmptyListLine className="px-4 py-3 text-ui-base text-foreground-subtle">
        No MCP servers yet.
      </EmptyListLine>,
    );
    const tokens = classOf(
      screen.getByText("No MCP servers yet."),
    ).split(/\s+/);
    expect(tokens).toContain("px-4");
    expect(tokens).toContain("py-3");
    expect(tokens).toContain("text-ui-base");
    expect(tokens).toContain("text-foreground-subtle");
    expect(tokens).not.toContain("text-ui-sm");
    expect(tokens).not.toContain("text-foreground-subtlest");
    // The measured, slightly-awkward half, asserted rather than wished away.
    expect(tokens).toContain("p-3");
  });

  it("keeps a caller's extra geometry alongside the triple", () => {
    render(<EmptyListLine className="shrink-0">No spaces yet.</EmptyListLine>);
    const tokens = classOf(screen.getByText("No spaces yet.")).split(/\s+/);
    expect(tokens).toContain("shrink-0");
    expect(tokens).toContain("p-3");
    expect(tokens).toContain("text-ui-sm");
    expect(tokens).toContain("text-foreground-subtlest");
  });

  it("emits NO stray whitespace in the class attribute", () => {
    const { container } = render(<EmptyListLine>x</EmptyListLine>);
    const cls = classOf(container.firstElementChild!);
    expect(cls).not.toMatch(/^\s|\s$|\s\s/);
  });
});
