import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionListRow } from "./SessionListRow";
import { useDragReorder } from "../hooks/useDragReorder";

/**
 * `SessionListRow` — the sidebar's session row, ONCE (finding 3, Task C4).
 *
 * `SessionRow` and `ArchivedSessionRow` were one component drawn twice: the same
 * `RowButton` shell, the same 16px leading slot, the same masked title span, the
 * same time-then-actions swap. They differ in exactly three places, and those
 * three are the only props: the LEADING slot (a status mark, or nothing), the
 * ACTIONS (live offers Stop + Archive, archived offers Unarchive + Delete), and
 * nothing else — the time slot's two arms were duplicated, not different, so the
 * component owns them.
 *
 * The tightest pin on this surface is `SpacesList.test.tsx:583`, which asserts
 * a row's `textContent` is EXACTLY `"alpha"`. That is why this file asserts
 * `textContent` too, and why the component may not add a single node or
 * whitespace of text — not a wrapper, not a label, not an icon with a title.
 */

/** A stable no-op — `SessionListRow`'s `onOpen` takes no argument (the row is
 *  opened by id at the call site), so the fixture must not pass a mock as if it
 *  received the event. */
function noop(): () => void {
  return () => {};
}

/** The hover-action buttons a row can carry, exactly as the call sites build
 *  them: real `<button>`s with NO `role` attribute, an `aria-label` for the name
 *  and an ICON for the glyph — never text. The no-text part is load-bearing:
 *  `SpacesList.test.tsx:583` compares the row's `textContent` for equality and
 *  jsdom keeps these hover-hidden buttons in the DOM. */
function Action({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={vi.fn()}
      className="hidden size-6 items-center justify-center rounded-md group-hover:flex hover:bg-surface-hover"
    >
      <svg aria-hidden="true" />
    </button>
  );
}

// The fade mask is the row's ONLY overflow cue (no ellipsis), and jsdom cannot
// observe it: `CSSStyleDeclaration` drops `maskImage` / `WebkitMaskImage` as
// unknown properties, so React's inline style serialises to NO attribute at all
// (probe-verified — `getAttribute("style")` is `null` for a span carrying both).
// The mask is therefore pinned against the component's SOURCE, the way
// `subagentSheetLayout.test.ts` and `chromeButton.test.ts` pin what jsdom cannot
// see. Node's `fs` through a COMPUTED specifier — this app ships no
// `@types/node`, so a bare `import "node:fs"` does not typecheck.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};

describe("SessionListRow — the shell", () => {
  it("is ONE role=button div carrying the row's class string", () => {
    render(<SessionListRow title="alpha" onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("tabindex")).toBe("0");
    // The class string, verbatim and complete — `SpacesList.test.tsx:635` reads
    // `row.className` and the sidebar's whole layout depends on the rest.
    expect(row.className.split(/\s+/)).toEqual(
      "group flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 hover:bg-surface-hover".split(
        " ",
      ),
    );
  });

  it("an ACTIVE row carries bg-selected and NOT hover:bg-surface-hover", () => {
    render(<SessionListRow title="alpha" active onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    // `SpacesList.test.tsx:635` — the pin the extraction must not disturb.
    expect(row.className).toContain("bg-selected");
    const tokens = row.className.split(/\s+/);
    expect(tokens).not.toContain("hover:bg-surface-hover");
    expect(tokens).toContain("group");
    expect(tokens).toContain("flex");
  });

  it("click and Enter both open the row", () => {
    const onOpen = vi.fn();
    render(<SessionListRow title="alpha" onOpen={onOpen} />);
    fireEvent.click(screen.getByText("alpha"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByText("alpha").closest('[role="button"]')!, {
      key: "Enter",
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("SessionListRow — the text contract (SpacesList.test.tsx:583)", () => {
  it("textContent is the title ALONE when there is no time and no actions", () => {
    // The exact shape of `:583`'s row: no loaded transcript → the title falls
    // back to the Space's base name and the time slot is EMPTY. The assertion
    // is equality, so any added node carrying text — a wrapper label, a
    // tooltip, an aria-only span with content — reddens it.
    render(<SessionListRow title="alpha" onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.textContent).toBe("alpha");
  });

  it("textContent stays the title ALONE once the actions are in the DOM", () => {
    // jsdom applies no CSS, so the hover-only buttons are present in the DOM
    // even though a user sees them only on hover — and `:583`'s row HAS them.
    // They carry `aria-label`s and an icon, never text.
    render(
      <SessionListRow
        title="alpha"
        onOpen={noop()}
        actions={
          <>
            <Action label="Unarchive alpha" />
            <Action label="Delete alpha" />
          </>
        }
      />,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.textContent).toBe("alpha");
  });

  it("adds NO DOM level between the row and its children", () => {
    // The row's children are DIRECT children of the `role="button"` element. A
    // wrapper would not break `:583` but would break every positional read
    // (`compareDocumentPosition` at `:2372`, the rail-vs-row mark equality), and
    // `closest()` walks — the same trap C6 recorded for the picker shell.
    render(
      <SessionListRow
        title="alpha"
        onOpen={noop()}
        leading={<span data-testid="leading" />}
        actions={<Action label="Archive alpha" />}
      />,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(screen.getByTestId("leading").parentElement).toBe(row);
    expect(screen.getByText("alpha").parentElement).toBe(row);
    expect(screen.getByRole("button", { name: "Archive alpha" }).parentElement).toBe(
      row,
    );
    // Exactly four children: leading, title, time slot, action.
    expect(row.children).toHaveLength(4);
  });
});

describe("SessionListRow — the leading slot", () => {
  it("renders an empty 16px slot by default (an archived row has no mark)", () => {
    const { unmount } = render(<SessionListRow title="alpha" onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    const slot = row.firstElementChild!;
    expect(slot.tagName).toBe("SPAN");
    expect(slot.className).toBe("size-4 shrink-0");
    expect(slot.textContent).toBe("");
    unmount();
  });

  it("renders the caller's leading node FIRST, untouched", () => {
    // The live row passes `SessionStatusMark`, which owns its own ink and its
    // own `[data-dot]` — the four `[data-dot=…]` and three `[role="status"]`
    // pins in `SpacesList.test.tsx` all read it THROUGH the row
    // (`row.querySelector(…)`), so the row must neither wrap it nor restyle it.
    render(
      <SessionListRow
        title="alpha"
        onOpen={noop()}
        leading={<svg data-dot="waiting" role="status" />}
      />,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    const mark = row.querySelector('[data-dot="waiting"]')!;
    expect(mark.parentElement).toBe(row);
    expect(row.firstElementChild).toBe(mark);
    expect(row.querySelector('[role="status"]')).toBe(mark);
  });
});

describe("SessionListRow — the time slot (the two arms, owned once)", () => {
  it("a time renders in the hover-hidden slot, in the row's muted small type", () => {
    render(<SessionListRow title="alpha" time="1h" onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    const slot = screen.getByText("1h").parentElement!;
    expect(slot.className).toBe("group-hover:hidden");
    // The slot is a DIRECT child of the row, and the text span is its only child.
    expect(slot.parentElement).toBe(row);
    expect(screen.getByText("1h").className).toBe(
      "text-ui-sm text-foreground-subtle",
    );
    // …and it is the THIRD child (leading, title, time).
    expect(row.children[2]).toBe(slot);
  });

  it("no time renders an EMPTY slot, still inside the hover-hidden wrapper", () => {
    // The empty slot is not cosmetic: it is what keeps the title's indent
    // aligned with the rows above when a transcript was never loaded.
    render(<SessionListRow title="alpha" time={null} onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    const slot = row.children[2];
    expect(slot.className).toBe("group-hover:hidden");
    expect(slot.textContent).toBe("");
    expect(slot.firstElementChild!.className).toBe("size-4");
    expect(row.textContent).toBe("alpha");
  });
});

describe("SessionListRow — the title", () => {
  it("carries the truncation classes the sidebar's pin reads", () => {
    // The three tokens `SpacesList.test.tsx:805-807` reads off the title node.
    render(<SessionListRow title="alpha" onOpen={noop()} />);
    const title = screen.getByText("alpha");
    for (const token of ["overflow-hidden", "whitespace-nowrap", "min-w-0"]) {
      expect(title.className.split(/\s+/)).toContain(token);
    }
    expect(title.className.split(/\s+/)).toContain("flex-1");
    expect(title.className.split(/\s+/)).toContain("text-ui-base");
    expect(title.className.split(/\s+/)).toContain("text-foreground");
    // And the title span is a DIRECT child of the row — the mask clips the
    // title's own box, so a wrapper would clip the wrong box.
    expect(title.parentElement!.getAttribute("role")).toBe("button");
  });

  it("spells the fade mask in both the standard and the -webkit property", () => {
    // jsdom cannot observe this: it drops `maskImage`/`WebkitMaskImage` as
    // unknown properties, so React's inline style serialises to no attribute at
    // all and a DOM-level assertion here would be vacuous in either direction.
    // The mask is the title's SOLE overflow cue (the text is deliberately not
    // `truncate`-ellipsized — it overflows UNDER the fade), and the `-webkit-`
    // spelling is what WebKit/`WKWebView` — the engine this app ships inside —
    // actually reads, so losing it silently removes the fade for the user.
    const src = readFileSync("src/components/SessionListRow.tsx", "utf8");
    const fade =
      /"linear-gradient\(to right, black calc\(100% - 1\.5rem\), transparent\)"/;
    expect(src.match(new RegExp(fade.source, "g"))).toHaveLength(2);
    expect(src).toMatch(/maskImage:/);
    expect(src).toMatch(/WebkitMaskImage:/);
  });
});

describe("SessionListRow — the actions", () => {
  it("render AFTER the time slot, in the caller's order, as plain buttons", () => {
    // Order is a design decision recorded at both call sites (Stop before
    // Archive on a live row; Delete outermost on an archived one), so the
    // component must not sort or wrap them.
    render(
      <SessionListRow
        title="alpha"
        time="now"
        onOpen={noop()}
        actions={
          <>
            <Action label="Stop alpha" />
            <Action label="Archive alpha" />
          </>
        }
      />,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    const stop = screen.getByRole("button", { name: "Stop alpha" });
    const archive = screen.getByRole("button", { name: "Archive alpha" });
    expect(
      stop.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row.lastElementChild).toBe(archive);
    // And they are NOT `role="button"` nodes — `rowOf(…).getByRole("button", …)`
    // in `SpacesList.test.tsx` finds them only because the row itself is not a
    // `<button>` element. A `RowButton` here would make each of those 11 role
    // queries match twice and throw.
    for (const b of [stop, archive]) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("role")).toBeNull();
    }
    // One `role="button"` ancestor for the whole row, from any node inside it.
    expect(row.parentElement?.querySelectorAll('[role="button"]')).toHaveLength(1);
    expect(archive.closest('[role="button"]')).toBe(row);
  });

  it("a click on an action does not reach the row's onOpen (the caller stops propagation)", () => {
    // The row owns no `stopPropagation` — that is the button's own contract,
    // pinned by `SpacesList.test.tsx`'s "Stop and Archive swallow the row's own
    // click-to-open". This asserts the component does not interfere: the row's
    // handler runs on a click that bubbles from a child that does NOT stop it,
    // and does not on one that does.
    const onOpen = vi.fn();
    render(
      <SessionListRow
        title="alpha"
        onOpen={onOpen}
        actions={
          <button
            type="button"
            aria-label="swallow"
            onClick={(e) => e.stopPropagation()}
          />
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "swallow" }));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("alpha"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("SessionListRow — what it must NOT grow", () => {
  it("carries no data-testid and no title/aria attribute of its own", () => {
    // Rows are reached by role, never by id, and the row's accessible name is
    // its title text — an `aria-label` here would shadow it and change every
    // `getByRole("button", { name: "Archive …" })` query's answer.
    render(<SessionListRow title="alpha" onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    for (const attr of ["data-testid", "aria-label", "title"]) {
      expect(row.hasAttribute(attr)).toBe(false);
    }
  });
});

describe("SessionListRow — the drop edge (T06, ADR 0075)", () => {
  // The indicator is a CLASS ON THE REAL ROW, never a node. `SessionListRow`'s
  // own header states the NO-DOM-LEVEL contract and the eight
  // `.closest('[role="button"]')` sites plus `rowOf()` resolve through ancestry,
  // so a portal-drawn ghost or an inserted placeholder breaks them all at once.
  // These tests therefore assert BOTH halves: which class lands, and that
  // NOTHING ELSE about the row changed.

  /** The row's class tokens, read the way the file's other pins read them. */
  const tokens = (): string[] =>
    screen
      .getByText("alpha")
      .closest('[role="button"]')!
      .className.split(/\s+/);

  it("dropEdge=\"before\" adds border-t-2 and NOT border-b-2 — the two edges are different answers", () => {
    render(<SessionListRow title="alpha" onOpen={noop()} dropEdge="before" />);
    const t = tokens();
    // TWO COMPETING ANSWERS: `border-t-2` (the dragged row lands ABOVE this one)
    // vs `border-b-2` (BELOW it). A component that ignores which edge it was
    // handed — or that always paints the top — answers the wrong one here, and
    // the pointer's half is exactly what the user is reading the line to mean.
    expect(t).toContain("border-t-2");
    expect(t).not.toContain("border-b-2");
  });

  it("dropEdge=\"after\" adds border-b-2 and NOT border-t-2", () => {
    render(<SessionListRow title="alpha" onOpen={noop()} dropEdge="after" />);
    const t = tokens();
    // The OTHER answer, so the pair above cannot be satisfied by a component
    // that paints one fixed edge whatever it is handed.
    expect(t).toContain("border-b-2");
    expect(t).not.toContain("border-t-2");
  });

  it("no dropEdge (and dropEdge={null}) serialises EXACTLY the untouched row", () => {
    // The byte-compare half. `SessionListRow.test.tsx:61` pins the class token
    // list of a plain row and `SpacesList.test.tsx` reads `row.className`; the
    // indicator may only appear while a drag is actually over the row, so with
    // no edge — and with the explicit `null` the sidebar passes to every
    // non-target row — the serialisation must be IDENTICAL.
    const before =
      "group flex cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1 py-1 hover:bg-surface-hover";
    for (const edge of [undefined, null] as const) {
      const { unmount } = render(
        <SessionListRow title="alpha" onOpen={noop()} dropEdge={edge} />,
      );
      expect(tokens()).toEqual(before.split(" "));
      unmount();
    }
  });

  it("the indicator costs NO node: same children, same textContent, same single role=button", () => {
    // THE ANTI-PLACEHOLDER PIN. A drop indicator drawn as an inserted element
    // (the obvious shape) would keep the class assertions above green and break
    // `adds NO DOM level between the row and its children` — which asserts the
    // row has EXACTLY four children — plus every positional read in
    // `SpacesList.test.tsx`. So this asserts the row is UNCHANGED apart from the
    // class, with the indicator ON.
    render(
      <SessionListRow
        title="alpha"
        time="1h"
        onOpen={noop()}
        leading={<span data-testid="leading" />}
        actions={<Action label="Archive alpha" />}
        dropEdge="after"
      />,
    );
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.children).toHaveLength(4);
    expect(row.textContent).toBe("alpha1h");
    expect(row.parentElement?.querySelectorAll('[role="button"]')).toHaveLength(1);
    expect(screen.getByTestId("leading").parentElement).toBe(row);
    // …and the edge class is on THAT node, the `role="button"` row itself — not
    // on a wrapper the component added above or below it.
    expect(row.className).toContain("border-b-2");
  });

  it("the row stays ONE role=button and keeps opening on click/Enter while an edge is showing", () => {
    // A drop indicator must not turn the row into a second control, and it must
    // not swallow the affordance it decorates: the row is still the one
    // `role="button"` and click/Enter still open it.
    const onOpen = vi.fn();
    render(<SessionListRow title="alpha" onOpen={onOpen} dropEdge="before" />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(document.querySelectorAll('[role="button"]')).toHaveLength(1);
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("SessionListRow — the drag spread (T06, ADR 0075)", () => {
  // The gesture itself is `useDragReorder`'s (T05, finished). What this row owns
  // is the ROUTE: the hook's six keys reach the DOM through `RowButton`'s
  // existing `...rest`, which is the intended path — `RowButton.tsx` needs no
  // change, and `useDragReorder.test.tsx` pins that the spread surface is
  // EXACTLY six keys so nothing extra can ride in with it.

  /** A row wearing a real hook's `dragProps`, i.e. exactly how `SpacesList`
   *  wears it — a hand-written prop object here would test the fixture, not the
   *  route. */
  function DraggableRow(props: { ids: readonly string[]; dragged: string[] }) {
    const drag = useDragReorder({
      ids: props.ids,
      onReorder: (next) => props.dragged.push(next.join(",")),
    });
    return (
      <>
        {props.ids.map((id) => (
          <SessionListRow
            key={id}
            title={id}
            onOpen={noop()}
            drag={drag.dragProps(id)}
            dropEdge={drag.overId === id ? drag.overEdge : null}
          />
        ))}
      </>
    );
  }

  /** The same rect override `useDragReorder.test.tsx` needs: jsdom returns all
   *  zeros, so the midpoint is 0 and BOTH pointer halves answer "after". */
  const layOut = (el: HTMLElement, top: number, height = 40) => {
    el.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        height,
        width: 200,
        left: 0,
        right: 200,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  };
  /** …and the hand-built `dragover`: `fireEvent.dragOver(el, { clientY })` does
   *  NOT deliver `clientY` in jsdom (measured `undefined`). */
  const dragOver = (el: Element, clientY: number) => {
    const ev = new Event("dragover", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.assign(ev, { clientY });
    return fireEvent(el, ev);
  };

  it("the drag prop reaches the DOM: the row div is draggable=true and its handlers fire", () => {
    const dragged: string[] = [];
    render(<DraggableRow ids={["one", "two"]} dragged={dragged} />);
    const row = screen.getByText("one").closest('[role="button"]') as HTMLElement;
    // TWO COMPETING ANSWERS: `"true"` (the spread reached the element) vs `null`
    // (the component dropped the prop, so nothing in the list can be dragged at
    // all and every drag test above the call site would still pass, because they
    // drive the handlers directly).
    expect(row.getAttribute("draggable")).toBe("true");
    layOut(row, 0);
    const two = screen.getByText("two").closest('[role="button"]') as HTMLElement;
    layOut(two, 100);
    fireEvent.dragStart(row, { dataTransfer: { setData: vi.fn() } });
    dragOver(two, 130); // bottom half → AFTER
    fireEvent(two, new Event("drop", { bubbles: true, cancelable: true }));
    expect(dragged).toEqual(["two,one"]);
  });

  it("a row with NO drag prop (an archived row) is not draggable and carries no handler", () => {
    // Archived rows keep following recency (spec §Archived section), so they are
    // deliberately NOT draggable. TWO COMPETING ANSWERS: `null` (no attribute —
    // the browser's default for a `div` is inert) vs `"false"` (an explicit
    // opt-out, which is a different answer and one no test asked for).
    render(<SessionListRow title="alpha" onOpen={noop()} />);
    const row = screen.getByText("alpha").closest('[role="button"]')!;
    expect(row.hasAttribute("draggable")).toBe(false);
  });
});

