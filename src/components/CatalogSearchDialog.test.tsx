import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CatalogSearchDialog } from "./CatalogSearchDialog";

/**
 * THE CONTRACT OF THE PICKER SHELL (finding 4).
 *
 * Three dialogs — **Skills**, **Agents** and the **model picker** — spell the
 * same six pieces: the `Dialog` + `DialogContent` box, the `DialogHeader` /
 * `DialogTitle` pair (with NO `DialogDescription`), the bounded wrapper column,
 * the unlabelled search `<Input>`, the empty-state `<p>`, and the scroll
 * container. This file pins what the shell OWNS and, more importantly, the
 * three things it must NOT do, each of which a naive merge gets wrong and no
 * existing test would catch:
 *
 * 1. **It may not add a DOM level.** `SkillsDialog.test.tsx` and
 *    `ModelPickerDialog.test.tsx` walk `row.parentElement` → scroller → wrapper
 *    and assert class tokens at each step. A React component boundary adds no
 *    DOM; an element would. Hence the `keyOf` + `<Fragment>` row mapping, and
 *    the `children.length` assertions below — they are the mechanical form of
 *    "the ancestry pins still pass".
 * 2. **It may not reorder the region.** `AgentsDialog` renders its
 *    `noSpaceOpen` line ABOVE the search input and its orphan block BELOW the
 *    rows. A shell shaped `header → input → children` would silently move the
 *    notice below the search field — a visual regression with no test behind it
 *    — so `beforeSearch` is a first-class insertion point and its ORDER (not
 *    merely its presence) is asserted here.
 * 3. **It may not decide anything about the rows.** The filter stays at the
 *    site (name-only substring in Skills/Agents, `fuzzyMatch` + a sort in the
 *    model picker), the row markup stays at the site, and keyboard navigation
 *    stays at the site — the **Agents** rows are deliberately NOT
 *    `role="button"`, so a shell that added nav or a row affordance would change
 *    the a11y tree. The shell therefore renders no `role`, no `tabIndex` and no
 *    handler of its own, which the "adds no affordance" test measures.
 */

type Row = { id: string; label: string };

const ROWS: Row[] = [
  { id: "a", label: "alpha" },
  { id: "b", label: "beta" },
];

/** The smallest legal call: rows, no empty state, no extra regions. */
function shell(
  props: Partial<Parameters<typeof CatalogSearchDialog<Row>>[0]> = {},
) {
  const onQueryChange = vi.fn();
  render(
    <CatalogSearchDialog<Row>
      open
      onOpenChange={vi.fn()}
      title="Things"
      searchPlaceholder="Search things…"
      query=""
      onQueryChange={onQueryChange}
      rows={ROWS}
      keyOf={(row) => row.id}
      renderRow={(row) => <div data-testid={`row-${row.id}`}>{row.label}</div>}
      emptyMessage={null}
      {...props}
    />,
  );
  return { onQueryChange };
}

/** The wrapper column: the child of `dialog-content` that holds everything
 *  below the header. Read positionally, exactly like the dialog tests do. */
const wrapperOf = (node: Element): HTMLElement => {
  const content = node.closest("[data-slot=dialog-content]");
  // The wrapper column is the header's NEXT sibling — not `lastElementChild`,
  // because `ui/dialog.tsx` appends the close `Button` as content's last child.
  const header = content?.querySelector("[data-slot=dialog-header]");
  return (header?.nextElementSibling ?? node) as HTMLElement;
};

describe("CatalogSearchDialog — the box", () => {
  it("is bounded like the three dialogs it replaces (sm:max-w-3xl, max-h-[70vh])", () => {
    shell();
    const content = screen
      .getByText("Things")
      .closest("[data-slot=dialog-content]") as HTMLElement;
    const tokens = content.className.split(/\s+/);
    // Token SETS, both directions — the `sm:`-prefix trap `ui/dialog.tsx`
    // documents: a bare `max-w-3xl` is a DIFFERENT tailwind-merge group from
    // the base's `sm:max-w-md`, so both reach CSS and the `sm:` rule wins above
    // 640px, silently shrinking the dialog to 28rem. A substring assertion
    // cannot tell the two apart; `toContain` on the split token list can.
    expect(tokens).toContain("sm:max-w-3xl");
    expect(tokens).not.toContain("max-w-3xl");
    expect(tokens).not.toContain("sm:max-w-md");
    expect(tokens).toContain("max-h-[70vh]");
  });

  it("a caller className merges through cn() without dropping the base's bounds", () => {
    shell({ className: "sm:max-w-4xl" });
    const tokens = (screen
      .getByText("Things")
      .closest("[data-slot=dialog-content]") as HTMLElement).className.split(
      /\s+/,
    );
    expect(tokens).toContain("sm:max-w-4xl");
    // The same-group utility from the base is GONE — that is `cn` merging, not
    // concatenating (concatenation would leave both and let CSS order decide).
    expect(tokens).not.toContain("sm:max-w-3xl");
    // …and the unrelated base utility survives, which is the half a hand-rolled
    // string is most likely to lose while someone retypes the class list.
    expect(tokens).toContain("max-h-[70vh]");
  });

  it("has a title and NO description (the three dialogs have none)", () => {
    shell();
    const content = screen
      .getByText("Things")
      .closest("[data-slot=dialog-content]") as HTMLElement;
    expect(content.querySelector("[data-slot=dialog-header]")).toBeTruthy();
    expect(content.querySelector("[data-slot=dialog-description]")).toBeNull();
  });

  it("renders exactly ONE dialog-content node (the Agents test takes the LAST one)", () => {
    shell();
    expect(document.querySelectorAll("[data-slot=dialog-content]")).toHaveLength(
      1,
    );
  });
});

describe("CatalogSearchDialog — the region and its ORDER", () => {
  it("renders header → beforeSearch → input → list → children, in that order", () => {
    shell({
      beforeSearch: <p data-testid="before">before the field</p>,
      children: <div data-testid="after">after the rows</div>,
    });
    const wrapper = wrapperOf(screen.getByTestId("row-a"));
    // The scroller is the only child without a test id, so name it explicitly —
    // the point of the assertion is that it sits between the input and the
    // caller's trailing block, not that it is invisible.
    const label = (el: Element): string =>
      el.getAttribute("data-testid") ??
      (el === screen.getByTestId("row-a").parentElement ? "scroller" : el.tagName.toLowerCase());
    expect([...wrapper.children].map(label)).toEqual([
      "before",
      "input",
      "scroller",
      "after",
    ]);
    expect([...screen.getByTestId("row-a").parentElement!.children]).toHaveLength(2);
  });

  it("beforeSearch renders ABOVE the search input, not below it", () => {
    // The regression this exists for: `AgentsDialog`'s `noSpaceOpen` line sits
    // above the `<Input>`. A shell that took only a trailing `children` slot
    // would render it after the field, and every test in the repo would stay
    // green while the dialog changed shape under the user.
    shell({ beforeSearch: <p data-testid="before">notice</p> });
    const wrapper = wrapperOf(screen.getByTestId("row-a"));
    const before = screen.getByTestId("before");
    const input = screen.getByPlaceholderText("Search things…");
    expect(before.nextElementSibling).toBe(input);
    expect([...wrapper.children].indexOf(before)).toBe(0);
  });

  it("omits the beforeSearch slot entirely when it is not passed", () => {
    shell();
    const wrapper = wrapperOf(screen.getByTestId("row-a"));
    expect(wrapper.children[0].tagName).toBe("INPUT");
  });

  it("children render after the rows, as siblings of the list (Skills' shadow report, Agents' orphans)", () => {
    shell({ children: <div data-testid="after">tail</div> });
    const wrapper = wrapperOf(screen.getByTestId("row-a"));
    expect(wrapper.lastElementChild).toBe(screen.getByTestId("after"));
    // Siblings of the scroller, not inside it — a report inside the scroller
    // would scroll with the rows and change `row.parentElement` for the tests
    // that walk it.
    expect(screen.getByTestId("after").parentElement).toBe(wrapper);
    expect(screen.getByTestId("row-a").parentElement).not.toBe(wrapper);
  });

  it("children render after the empty state too (a block can never ride inside it)", () => {
    shell({ emptyMessage: "Nothing here.", children: <div data-testid="after">tail</div> });
    const wrapper = wrapperOf(screen.getByText("Nothing here."));
    // input → empty <p> → the caller's block: the report stays a SIBLING of the
    // empty state, never content inside it.
    expect([...wrapper.children].map((el) => el.tagName)).toEqual([
      "INPUT",
      "P",
      "DIV",
    ]);
    expect(wrapper.children[1].textContent).toBe("Nothing here.");
  });
});

describe("CatalogSearchDialog — no new DOM level", () => {
  it("row → scroller → wrapper → dialog-content, with no level in between", () => {
    shell();
    const row = screen.getByTestId("row-a");
    const scroller = row.parentElement as HTMLElement;
    expect(scroller.className.split(/\s+/)).toEqual(
      "flex min-w-0 flex-col gap-0.5 overflow-y-auto pr-2".split(" "),
    );
    const wrapper = scroller.parentElement as HTMLElement;
    expect(wrapper.className.split(/\s+/)).toEqual(
      "flex max-h-[calc(70vh-7.5rem)] min-w-0 flex-col gap-3".split(" "),
    );
    expect(wrapper.parentElement?.getAttribute("data-slot")).toBe(
      "dialog-content",
    );
  });

  it("emits exactly one element per row (the key wrapper is a Fragment, not a div)", () => {
    shell();
    const scroller = (screen.getByTestId("row-a") as HTMLElement)
      .parentElement as HTMLElement;
    expect(scroller.children).toHaveLength(ROWS.length);
    expect([...scroller.children].every((el) => el.tagName === "DIV")).toBe(true);
    expect(scroller.querySelector("[data-testid=row-b]")?.parentElement).toBe(
      scroller,
    );
  });

  it("the row gap comes from the caller and splices into the base's own position", () => {
    shell({ rowGapClassName: "gap-2" });
    const scroller = (screen.getByTestId("row-a") as HTMLElement)
      .parentElement as HTMLElement;
    // The exact STRING, not merely the token set: Agents spells `gap-2` and
    // Skills/the model picker spell `gap-0.5`, and tailwind-merge MOVES an
    // override to the end of the attribute (`cn(base_with_gap, "gap-2")` →
    // `"… overflow-y-auto pr-2 gap-2"`). Same utility set, different attribute
    // order — which would make the `outerHTML` parity evidence below impossible
    // to read. So the shell splices the gap into the position the sites spell
    // it, and the rendered attribute is byte-identical.
    expect(scroller.className).toBe(
      "flex min-w-0 flex-col gap-2 overflow-y-auto pr-2",
    );
  });
});

describe("CatalogSearchDialog — the empty state", () => {
  it("renders the empty sentence in the list's place, with the shared shape", () => {
    shell({ emptyMessage: "No things found." });
    const p = screen.getByText("No things found.");
    expect(p.tagName).toBe("P");
    expect(p.className.split(/\s+/)).toEqual(
      "p-3 text-ui-sm text-foreground-subtlest".split(" "),
    );
    // It REPLACES the scroller — an empty `<div>` scroller beside the sentence
    // would be a DOM level the tests' `parentElement` walk could land on.
    const wrapper = wrapperOf(p);
    // The whole region is the input and the sentence — no scroller survived.
    expect([...wrapper.children].map((el) => el.tagName)).toEqual(["INPUT", "P"]);
    expect(wrapper.querySelector("div")).toBeNull();
  });

  it("an empty rows array with no message renders NO scroller at all", () => {
    shell({ rows: [] });
    const wrapper = wrapperOf(screen.getByPlaceholderText("Search things…"));
    expect(wrapper.children).toHaveLength(1);
  });

  it("the caller's message wins verbatim (the copy is pinned per dialog, by its own tests)", () => {
    shell({ emptyMessage: 'No things match "zzz".' });
    expect(screen.getByText('No things match "zzz".').textContent).toBe(
      'No things match "zzz".',
    );
  });
});

describe("CatalogSearchDialog — the search field", () => {
  it("is the unlabelled input the three dialogs render, with the caller's placeholder", () => {
    shell();
    const input = screen.getByPlaceholderText("Search things…");
    expect(input.getAttribute("data-slot")).toBe("input");
    // Unlabelled, exactly as today: none of the three gives it a label, and
    // adding one now would change the a11y tree in a refactor commit.
    expect(input.closest("label")).toBeNull();
    expect(input.getAttribute("aria-label")).toBeNull();
  });

  it("reports the raw value to the caller and renders the caller's value back", () => {
    const { onQueryChange } = shell();
    fireEvent.change(screen.getByPlaceholderText("Search things…"), {
      // The raw value reaches the caller: trimming and lowercasing is the
      // site's business (it also feeds the shadow report and the row internals).
      target: { value: "  BeT a  " },
    });
    expect(onQueryChange).toHaveBeenCalledWith("  BeT a  ");
  });

  it("owns no filter and no row decision — it renders `rows` in the caller's order", () => {
    // The filter difference is the reason the shell has no `filter` prop it
    // applies itself: Skills/Agents filter by name substring, the model picker
    // by `fuzzyMatch` across three fields AND re-sorts. Both shapes have to
    // survive untouched, so the shell renders what it is handed.
    shell({ rows: [ROWS[1]!, ROWS[0]!] });
    const scroller = (screen.getByTestId("row-b") as HTMLElement)
      .parentElement as HTMLElement;
    expect([...scroller.children].map((el) => el.textContent)).toEqual([
      "beta",
      "alpha",
    ]);
  });
});

describe("CatalogSearchDialog — adds no affordance of its own", () => {
  it("the shell adds no role, tabIndex, or click handler to anything it owns", () => {
    shell({
      beforeSearch: <p>notice</p>,
      children: <div>tail</div>,
    });
    const content = screen
      .getByText("Things")
      .closest("[data-slot=dialog-content]") as HTMLElement;
    const wrapper = wrapperOf(screen.getByTestId("row-a"));
    // Only the caller's rows and the dialog's own close button may be buttons.
    const buttons = [...content.querySelectorAll('[role="button"], button')];
    expect(buttons.map((b) => b.getAttribute("data-slot"))).toEqual([
      "dialog-close",
    ]);
    // The wrapper column the shell owns: no role, no tabIndex (its PARENT is
    // Radix's own `dialog-content`, which legitimately carries `role="dialog"`
    // and `tabindex="-1"` — that is the primitive's, not the shell's addition).
    expect(wrapper.getAttribute("role")).toBeNull();
    expect(wrapper.getAttribute("tabindex")).toBeNull();
    expect(wrapper.tagName).toBe("DIV");
  });

  it("passes open/onOpenChange through to the Dialog (the picker owns its own state)", () => {
    const onOpenChange = vi.fn();
    render(
      <CatalogSearchDialog<Row>
        open
        onOpenChange={onOpenChange}
        title="Things"
        searchPlaceholder="Search things…"
        query=""
        onQueryChange={vi.fn()}
        rows={ROWS}
        keyOf={(row) => row.id}
        renderRow={(row) => <div data-testid={`row-${row.id}`}>{row.label}</div>}
        emptyMessage={null}
      />,
    );
    // The box is mounted because `open` is true…
    expect(screen.getByText("Things")).toBeTruthy();
    // …and the shell does not swallow the close request: it belongs to the
    // caller, which decides whether a close is a `onClose()` or a `setOpen(false)`.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
