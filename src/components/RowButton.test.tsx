import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RowButton } from "./RowButton";

/**
 * `RowButton` — the ONE `role="button"` div row (finding 3, Task C4).
 *
 * Five surfaces spell the same affordance by hand (`SpacesList`'s session row,
 * its Archived-section header, its archived row, and the Skills and Model picker
 * rows) and a sixth (`TodoBoardPanel.tsx:278`) spells a DIFFERENT one — Space
 * also activates there, with `preventDefault`. This file pins the shared half:
 * `role="button"`, `tabIndex={0}`, Enter activates, Space does NOT, and exactly
 * one `role="button"` ancestor per row.
 *
 * The "exactly one" pin is not ceremony. `SpacesList.test.tsx` reaches rows
 * through `.closest('[role="button"]')` at eight sites plus its `rowOf()` helper,
 * so a second `role="button"` anywhere in a row's ancestry resolves to the WRONG
 * node and all nine reads break at once. That is also why the hover-action
 * controls inside a row are plain `<button>`s and NOT this component: they must
 * not carry a `role` at all.
 */

describe("RowButton — the affordance", () => {
  it("renders a div with role=button and tabIndex=0", () => {
    render(
      <RowButton onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    const row = screen.getByText("alpha").closest('[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.tagName).toBe("DIV");
    expect(row!.getAttribute("tabindex")).toBe("0");
  });

  it("contributes EXACTLY ONE role=button ancestor, even with controls inside", () => {
    // The shape of a `SpacesList` row: the row is the affordance and its
    // hover-action buttons are plain <button>s. A nested role would make
    // `.closest('[role="button"]')` resolve differently for the inner nodes than
    // for the title, which is exactly how the nine ancestry reads break.
    render(
      <RowButton onClick={vi.fn()}>
        <span>title</span>
        <button type="button" aria-label="inner action" onClick={vi.fn()}>
          x
        </button>
      </RowButton>,
    );
    const fromTitle = screen.getByText("title").closest('[role="button"]');
    const fromInner = screen
      .getByRole("button", { name: "inner action" })
      .closest('[role="button"]');
    expect(fromInner).toBe(fromTitle);
    // …and the inner control carries NO role attribute of its own (it is a real
    // `<button>`, so an explicit role would be redundant at best and a second
    // `[role="button"]` selector match at worst).
    expect(
      screen.getByRole("button", { name: "inner action" }).getAttribute("role"),
    ).toBeNull();
    // Exactly ONE node in the whole tree matches the selector the sidebar uses.
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
  });

  it("click activates", () => {
    const onClick = vi.fn();
    render(
      <RowButton onClick={onClick}>
        <span>alpha</span>
      </RowButton>,
    );
    fireEvent.click(screen.getByText("alpha"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Enter activates", () => {
    const onClick = vi.fn();
    render(
      <RowButton onClick={onClick}>
        <span>alpha</span>
      </RowButton>,
    );
    fireEvent.keyDown(screen.getByText("alpha").closest('[role="button"]')!, {
      key: "Enter",
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Space does NOT activate (this is a row, not a todo-board tile)", () => {
    // `TodoBoardPanel.tsx:278` handles `Enter || " "` with `preventDefault` —
    // a different affordance, deliberately NOT folded in here. If this test
    // ever goes red because someone added a Space branch, that fold has
    // happened by accident and it changes what a keypress does in five other
    // surfaces.
    const onClick = vi.fn();
    render(
      <RowButton onClick={onClick}>
        <span>alpha</span>
      </RowButton>,
    );
    fireEvent.keyDown(screen.getByText("alpha").closest('[role="button"]')!, {
      key: " ",
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("any other key is inert", () => {
    const onClick = vi.fn();
    render(
      <RowButton onClick={onClick}>
        <span>alpha</span>
      </RowButton>,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    for (const key of ["a", "Escape", "Tab", "ArrowDown"]) {
      fireEvent.keyDown(row, { key });
    }
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("RowButton — the class string is passed through, never re-merged", () => {
  it("renders className verbatim, in the caller's order", () => {
    // Every one of the five sites owns its own class string, and two of them
    // were measured to depend on what `cn()` would DESTROY: the Model picker's
    // disabled row spells `cursor-pointer` (base) and `cursor-not-allowed`
    // (arm) in one tailwind-merge group, and today BOTH reach the DOM. A merge
    // here would silently drop one, so the row shell must not merge.
    const className =
      "group flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1 hover:bg-surface-hover cursor-not-allowed opacity-50";
    render(
      <RowButton className={className} onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.getAttribute("class")).toBe(className);
    // …spelled out, because the pass-through contract is exactly this pair.
    expect(row.className.split(/\s+/)).toContain("cursor-pointer");
    expect(row.className.split(/\s+/)).toContain("cursor-not-allowed");
  });

  it("renders no class attribute at all when the caller passes none", () => {
    render(
      <RowButton onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.getAttribute("class")).toBeNull();
  });
});

describe("RowButton — the disabled row (the Model picker's stale-override case)", () => {
  it("is aria-disabled, unfocusable, and inert to both pointer and Enter", () => {
    // `ModelPickerDialog.test.tsx:174` pins `aria-disabled === "true"` on the
    // row it reaches via `.closest("[role=button]")`, and the same test pins
    // that clicking it selects nothing. `tabIndex="-1"` is the other half of
    // the same fact: a row nothing can select must not be in the tab order.
    const onClick = vi.fn();
    render(
      <RowButton disabled onClick={onClick}>
        <span>gone/m1</span>
      </RowButton>,
    );
    const row = screen.getByText("gone/m1").closest('[role="button"]')!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("an enabled row carries NO aria-disabled attribute at all", () => {
    // `undefined`, not `"false"`: the site passes
    // `aria-disabled={model.disabled ? "true" : undefined}` today, and an
    // explicit `aria-disabled="false"` is a different (and noisier) a11y tree.
    render(
      <RowButton disabled={false} onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.hasAttribute("aria-disabled")).toBe(false);
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("an explicit tabIndex overrides the derived one", () => {
    // The Model picker spells `tabIndex={model.disabled ? -1 : 0}` by hand
    // today; `disabled` derives the same pair, but the override keeps the
    // component honest for a caller that manages focus order itself.
    render(
      <RowButton tabIndex={3} onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    expect(
      screen.getByText("alpha").closest('[role="button"]')!.getAttribute("tabindex"),
    ).toBe("3");
  });
});

describe("RowButton — what it must NOT do", () => {
  it("emits no data-testid (the sidebar rows are reached by role, never by id)", () => {
    // `SpacesList.test.tsx` has no `data-testid` for a row and the plan is
    // explicit that adding one to satisfy nothing is drift, not help.
    render(
      <RowButton onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    expect(screen.queryByTestId(/^row/)).toBeNull();
    expect(
      screen.getByText("alpha").closest('[role="button"]')!.hasAttribute("data-testid"),
    ).toBe(false);
  });

  it("spreads through attributes a caller owns (title, aria-label)", () => {
    render(
      <RowButton aria-label="Archived" title="Toggle" onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.getAttribute("aria-label")).toBe("Archived");
    expect(row.getAttribute("title")).toBe("Toggle");
  });

  it("renders no button element of its own — it is a div with a role", () => {
    // A real <button> would change five surfaces: nesting (a row already holds
    // <button> children, and `button > button` is invalid), and every class
    // string, since a native button brings the user-agent stylesheet with it.
    const { container } = render(
      <RowButton onClick={vi.fn()}>
        <span>alpha</span>
      </RowButton>,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
