import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IpcErrorLine } from "./IpcErrorLine";

/**
 * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
 * `SVGAnimatedString` for SVG elements and this component may one day render
 * into a non-`<p>` slot (`SessionStatusMark.test.tsx` has the same note).
 */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

describe("IpcErrorLine (the inline IPC error a screen reader hears)", () => {
  it("renders NOTHING for a null error — no empty alert region in the tree", () => {
    const { container } = render(<IpcErrorLine error={null} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders NOTHING for an undefined error, and for the empty string", () => {
    // `undefined` reaches a caller whose state field is optional; `""` is the
    // falsy value every one of the nine sites already guards on (`{error && …}`),
    // so the component must agree with that guard and stay silent.
    expect(render(<IpcErrorLine error={undefined} />).container.firstChild).toBeNull();
    expect(render(<IpcErrorLine error={""} />).container.firstChild).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("renders the message inside a role=\"alert\" — the whole point of the component", () => {
    render(<IpcErrorLine error={"permission denied"} />);
    // `getByRole` (not `getByText`): if the attribute is missing this throws for
    // the right reason, and it is the query the migrated sites' tests will use.
    expect(screen.getByRole("alert").textContent).toBe("permission denied");
  });

  it("carries the destructive ink and the small size by default", () => {
    render(<IpcErrorLine error={"boom"} />);
    const cls = classOf(screen.getByRole("alert"));
    expect(cls).toContain("text-destructive");
    expect(cls).toContain("text-ui-sm");
  });

  it("is a <p> by default (the element 9 of 9 migrated sites use today)", () => {
    render(<IpcErrorLine error={"boom"} />);
    expect(screen.getByRole("alert").tagName).toBe("P");
  });

  it("merges a caller's padding WITHOUT dropping text-destructive", () => {
    // The per-site padding (`px-3 pb-2` at PermissionPrompt / AskQuestionCard,
    // `mb-2 px-3` at ChatStream) passes through `className` so rendered spacing
    // is byte-identical to the hand-written line it replaces.
    render(<IpcErrorLine error={"boom"} className="px-3 pb-2" />);
    const cls = classOf(screen.getByRole("alert"));
    expect(cls).toContain("px-3");
    expect(cls).toContain("pb-2");
    expect(cls).toContain("text-destructive");
    expect(cls).toContain("text-ui-sm");
  });

  it("renders EXACTLY the class string the migrated sites hand-wrote", () => {
    // The byte-identical-rendering proof. `cn` is `tailwind-merge`, which can
    // reorder and drop classes, so "contains" is not enough — the three shapes
    // below are the literal strings that sit in the source today, and the
    // merged output must equal them.
    expect(
      renderClass({ className: "px-3 pb-2" }),
    ).toBe("text-ui-sm text-destructive px-3 pb-2");
    expect(
      renderClass({ className: "mb-2 px-3" }),
    ).toBe("text-ui-sm text-destructive mb-2 px-3");
    expect(renderClass({})).toBe("text-ui-sm text-destructive");
  });

  it("lets a caller OVERRIDE the font size (UpdateSection's text-ui-base sites)", () => {
    // UpdateSection.tsx:281 + :291 are `text-ui-base text-destructive`, not
    // `text-ui-sm`. `cn` registers `text-ui-*` as a font-size group
    // (`lib/utils.ts:8-18`) so the caller's `text-ui-base` wins, and
    // `text-destructive` survives because it is a colour, not a size. Asserted
    // on the MERGED STRING: a naive `clsx` concat would leave two sizes in the
    // class list and let CSS specificity decide, and a plain `tailwind-merge`
    // without the extension would let `text-ui-base` eat the colour.
    const cls = renderClass({ className: "text-ui-base" });
    expect(cls).toContain("text-ui-base");
    expect(cls).not.toContain("text-ui-sm");
    expect(cls).toContain("text-destructive");
    // And the exact byte-for-byte output, which is what UpdateSection renders.
    expect(cls).toBe("text-destructive text-ui-base");
  });

  it("keeps the colour when a caller repeats it alongside the size override", () => {
    // The other way UpdateSection could be written (passing its whole current
    // class string). `text-destructive` must not be dropped as a duplicate.
    const cls = renderClass({ className: "text-ui-base text-destructive" });
    expect(cls).toBe("text-ui-base text-destructive");
  });

  it("renders as a <span> when asked, for a site that lives inside a <p>", () => {
    // Element type is a caller choice, not a component decision: a `<p>` inside
    // a `<p>` is invalid HTML and React's parser-recovery would move nodes.
    render(<IpcErrorLine error={"boom"} as="span" />);
    const alert = screen.getByRole("alert");
    expect(alert.tagName).toBe("SPAN");
    expect(alert.textContent).toBe("boom");
    // Same classes either way — the element is orthogonal to the styling.
    expect(classOf(alert)).toBe("text-ui-sm text-destructive");
  });

  /** Renders one line, reads its merged class string, un-mounts it — so the
   * three shapes in a single `it` do not stack up and make `getByRole("alert")`
   * throw on multiple matches. */
  function renderClass(props: { className?: string }): string {
    const { unmount } = render(<IpcErrorLine error={"boom"} {...props} />);
    const cls = classOf(screen.getByRole("alert"));
    unmount();
    return cls;
  }
});
