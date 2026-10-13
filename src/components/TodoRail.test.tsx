import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TodoRail, { boardStateOf } from "./TodoRail";
import type { TodoItem } from "../store/interactive";
import type { TodoBoard } from "../hooks/useTodoBoards";

const items = (...statuses: TodoItem["status"][]): TodoItem[] =>
  statuses.map((status) => ({ content: `t-${status}`, status }));

/** Ids unique per fixture, so a test that builds two boards cannot collide on
 *  the key the rail would use. */
let childSeq = 0;

/**
 * A child board shaped exactly as `todoBoardsOf` builds one — both counts
 * derived from the list, so a fixture cannot drift from the derivation it
 * stands for.
 *
 * The ONE thing a real derivation never yields is a `done` board (all items
 * completed): `todoBoardsOf` drops a child with no open item, so such a board
 * never reaches the rail. The `done` fixtures below hand it over anyway, on
 * purpose — this file pins the rail's OWN mapping (state → shape), and the
 * parent's list is the input that carries `done` in the app.
 */
const board = (label: string, ...statuses: TodoItem["status"][]): TodoBoard => {
  const list = items(...statuses);
  const completed = list.filter((t) => t.status === "completed").length;
  childSeq += 1;
  return {
    childSessionId: `child-${childSeq}`,
    agentName: label,
    label,
    items: list,
    completed,
    open: list.length - completed,
    startedAt: childSeq,
  };
};

/**
 * The rail is a READOUT, not a control: everything asserted here is either
 * something only this file can catch (two boards collapsing into one mark, a
 * scroll container appearing in a 40px sliver) or the geometry that keeps the
 * rail clear of the pane's own toggle.
 */
describe("TodoRail (one mark per todo board, for the collapsed rail)", () => {
  it("renders one mark per BOARD, in order, and NO text at all", () => {
    // The parent is the only ACTIVE board, so the mark that carries
    // `bg-warning` can only be the parent's — which is what makes "the first
    // mark is the parent's" an assertion rather than a coincidence.
    render(
      <TodoRail
        mainItems={items("completed", "in_progress", "pending")}
        boards={[
          board("reviewer", "completed", "completed", "pending"),
          board("researcher", "pending", "pending"),
        ]}
      />,
    );
    const rail = screen.getByTestId("todo-rail");
    const marks = screen.getAllByTestId("todo-mark");
    // One mark per BOARD, not per item: a 20-item parent list must not fill
    // the sliver with 20 dots the eye cannot group, and a child's dozen rows
    // must not be indistinguishable from the parent's.
    expect(marks).toHaveLength(3);
    // The parent's board leads, then the children in board order.
    expect(marks[0]!.className).toContain("bg-warning");
    expect(marks[1]!.className).not.toContain("bg-warning");
    expect(marks[2]!.className).not.toContain("bg-warning");
    // The whole point of the rail: the SHAPE of the boards in a 40px sliver
    // that cannot hold words. A label sneaking in here would render as the
    // one-character-per-line column this replaced.
    expect(rail.textContent).toBe("");
  });

  it("draws the three states apart — tick / filled dot / hollow dot", () => {
    render(
      <TodoRail
        mainItems={[]}
        boards={[
          board("reviewer", "completed", "completed"),
          board("researcher", "completed", "in_progress"),
          board("builder", "pending", "pending"),
        ]}
      />,
    );
    const [done, active, todo] = screen.getAllByTestId("todo-mark");
    // Done: the success ring, and the check while a mark is big enough.
    expect(done!.className).toContain("border-success");
    expect(done!.querySelector("svg")).toBeTruthy();
    // Active: the warning FILL (the rail's one hot dot — the board's `◉`).
    expect(active!.className).toContain("bg-warning");
    expect(active!.className).not.toContain("border-success");
    // Waiting: the hollow dot.
    expect(todo!.className).toContain("border-foreground-subtlest");
    expect(todo!.className).not.toMatch(/\bbg-/);
  });

  it("tells the states apart by SHAPE as well as colour (the dots are read at a glance, and colour-blind at a glance)", () => {
    // The three marks here are the parent's (finished → the tick) plus a live
    // and a waiting child — the shape mix a real run actually produces.
    render(
      <TodoRail
        mainItems={items("completed", "completed")}
        boards={[
          board("reviewer", "completed", "in_progress"),
          board("builder", "pending"),
        ]}
      />,
    );
    const shapes = screen
      .getAllByTestId("todo-mark")
      .map((m) => (m.querySelector("svg") ? "check" : m.className.includes("bg-") ? "filled" : "hollow"));
    expect(shapes).toEqual(["check", "filled", "hollow"]);
  });

  it("distributes its rows over the height it is given, and CLIPS instead of scrolling", () => {
    const { container } = render(
      <TodoRail
        mainItems={[]}
        boards={[
          board("reviewer", "pending"),
          board("researcher", "in_progress"),
          board("builder", "pending"),
        ]}
      />,
    );
    const rail = screen.getByTestId("todo-rail");
    // Never a scroll container: a 40px sliver with a scrollbar is the exact
    // artefact this feature replaces. `overflow-hidden` and NO scroll utility.
    expect(rail.className).toContain("overflow-hidden");
    expect(rail.className).not.toMatch(/overflow-[a-z]*-(auto|scroll)/);
    // Every row grows (`flex-1`) so the marks spread over the pane's height
    // instead of stacking at the top, and carries a MINIMUM height: below the
    // floor the rows stop shrinking, the rail overflows, and `overflow-hidden`
    // clips the tail — which honestly says "more boards than fit" where a
    // scrollbar would say "go scroll inside the sliver".
    const rows = [...container.querySelectorAll("[data-todo-row]")];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.className).toContain("flex-1");
      expect(row.className).toMatch(/min-h-/);
      // …and a CEILING, or a 3-board set stretches its marks 600px apart down
      // a tall pane and stops reading as a group.
      expect(row.className).toMatch(/max-h-/);
    }
    // The column is TOP-anchored. This is not cosmetic: an overflowing flex
    // column CENTERS its overflow when justified to the middle, which would cut
    // the FIRST board off the top of the rail — and the parent's mark is the
    // first one. The head is what says "this is the list", so the tail is what
    // must get cut.
    expect(rail.className).toContain("justify-start");
    expect(rail.className).not.toContain("justify-center");
  });

  it("stays out of the way: no pointer capture (the toggle under it must stay clickable)", () => {
    render(<TodoRail mainItems={[]} boards={[board("reviewer", "pending")]} />);
    expect(screen.getByTestId("todo-rail").className).toContain("pointer-events-none");
  });

  it("clears the frame's bottom-left corner, where the pane's own toggle lives", () => {
    render(<TodoRail mainItems={[]} boards={[board("reviewer", "pending")]} />);
    const cls = screen.getByTestId("todo-rail").className;
    // Anchored to the top and offset from the bottom by at least the toggle's
    // box (`bottom-2` + `size-6` = 32px), or the last dot lands under it.
    const bottom = cls.match(/\bbottom-(\d+)/);
    expect(bottom, "the rail is not offset from the bottom").toBeTruthy();
    expect(Number(bottom![1]) * 4).toBeGreaterThanOrEqual(32);
  });

  it("names every board, with its own count, in the accessible name", () => {
    render(
      <TodoRail
        mainItems={items("completed", "pending", "pending")}
        boards={[
          board("reviewer", "completed", "completed", "pending"),
          board("researcher", "completed", "pending", "pending"),
        ]}
      />,
    );
    // `role="img"` + one term per board: the marks carry no text, so without
    // this the rail is an empty region to a screen reader (and the real board
    // behind it is `invisible` while collapsed, so it is not in the tree
    // either). Each board keeps its OWN fraction — a single app-wide count
    // would say nothing about which board is live.
    expect(
      screen.getByRole("img", {
        name: "Todos — this session 1/3, reviewer 2/3, researcher 1/3",
      }),
    ).toBeTruthy();
  });

  it("omits the `this session` term when the parent has no list of its own", () => {
    // A delegation whose parent never wrote a list is the common shape (ADR
    // 0042): a `this session 0/0` term would announce a board that is not on
    // the rail at all.
    render(<TodoRail mainItems={[]} boards={[board("reviewer", "completed", "completed", "pending")]} />);
    expect(screen.getAllByTestId("todo-mark")).toHaveLength(1);
    const name = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(name).toBe("Todos — reviewer 2/3");
    expect(name).not.toContain("this session");
  });

  it("renders nothing when no board exists at all", () => {
    const { container } = render(<TodoRail mainItems={[]} boards={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("todo-rail")).toBeNull();
  });

  it("decides a board's state from its items: any in_progress wins, all-completed is done, otherwise waiting", () => {
    // The exported derivation, pinned directly: the rail's three arms are only
    // as honest as this rule, and "which item is live" outranks "how many are
    // finished" — a board with a live item is live even at 9/10 done.
    expect(boardStateOf(items("in_progress"))).toBe("active");
    expect(boardStateOf(items("completed", "in_progress", "pending"))).toBe("active");
    expect(boardStateOf(items("completed", "completed"))).toBe("done");
    expect(boardStateOf(items("completed", "pending"))).toBe("waiting");
    expect(boardStateOf(items("pending"))).toBe("waiting");
  });

  it("answers `done` for an EMPTY list — the one input no caller can hand it", () => {
    // The loop never runs, so `allDone` stays `true`. That is the INTENDED answer
    // (an empty list has nothing outstanding, which is what `done` says), and it
    // is pinned instead of left as an accident because `boardStateOf` is exported
    // and a later caller can reach it.
    //
    // Today it is UNREACHABLE through the rail by two guards: the parent's state
    // is pushed only when `mainItems.length > 0`, and every child board comes
    // from `todoBoardsOf`, whose rule 4 drops a child whose list has no open
    // item (`open === 0` → skipped) — so `board.items` is never empty either.
    // Which is also why the rail's `done` arm can only ever be the parent's.
    expect(boardStateOf([])).toBe("done");
  });
});
