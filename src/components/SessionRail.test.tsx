import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SessionRail, {
  type SessionRailAction,
  type SessionRailRow,
} from "./SessionRail";

const row = (over: Partial<SessionRailRow> & { key: string }): SessionRailRow => ({
  status: "stored",
  active: false,
  ...over,
});

/**
 * The left rail is the sidebar's session list reduced to icons, for the 40px
 * collapsed sliver. Same grammar as `TodoRail` (see its doc for why the
 * geometry is CSS and why the strip CLIPS instead of scrolling), so this file
 * asserts the STATES and the geometry that keeps it clear of the sidebar's own
 * footer toggle.
 */
describe("SessionRail (the session list as icons, for the collapsed left rail)", () => {
  it("renders one row per session, in the list's order, and NO text", () => {
    const { container } = render(
      <SessionRail
        rows={[
          row({ key: "s1" }),
          row({ key: "s2", status: "running" }),
          row({ key: "s3", status: "waiting" }),
        ]}
      />,
    );
    expect(screen.getAllByTestId("session-row")).toHaveLength(3);
    // ORDER is the list's order, exactly as the caller passes it (live first,
    // then stored, each group most-recently-active first). The rail never
    // re-sorts: it is a POSITIONAL map of the list, and the Nth mark is the Nth
    // row — which is the only reason a textless column means anything.
    const rows = [...container.querySelectorAll("[data-testid='session-row']")];
    expect(rows[1]!.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
    expect(rows[2]!.querySelector("[data-dot]")).toBeTruthy();    expect(container.textContent).toBe("");
  });

  it("draws a SPINNER for a running session — the same glyph the open row uses", () => {
    render(<SessionRail rows={[row({ key: "s1", status: "running" })]} />);
    const mark = screen.getByTestId("session-mark");
    // One glyph for "this session is working" in the rail AND the list (the
    // open row's leading slot is the same `Spinner`), so the two views of the
    // same fact cannot look like two different facts.
    expect(mark.tagName).toBe("svg");
    expect(mark.getAttribute("class")).toContain("animate-spin");
    // `Spinner`'s own `role="status"` is silenced HERE (the rail's marks are
    // decoration under one summarising `role="img"` — see the a11y test below),
    // so the spin is a visual fact, not a second announcement.
    expect(mark.getAttribute("role")).toBe("presentation");
    // No folder behind it: the row IS the activity, and 10px cannot hold both.
    expect(screen.getAllByTestId("session-mark")).toHaveLength(1);
  });

  it("tells the four states apart — spinner / ? / live ring / stored ring", () => {
    render(
      <SessionRail
        rows={[
          row({ key: "run", status: "running" }),
          row({ key: "wait", status: "waiting" }),
          row({ key: "live", status: "live" }),
          row({ key: "stored", status: "stored" }),
        ]}
      />,
    );
    const [run, wait, live, stored] = screen.getAllByTestId("session-row");
    // Running: the spinner (silent — see the a11y test; the spin is the cue).
    expect(run!.querySelector('[data-testid="session-mark"]')!.tagName).toBe("svg");
    // Waiting (a pending permission / ask / password): the QUESTION MARK — the
    // same glyph the open row and the tab draw, in the app's attention ink
    // (`text-warning`, the token the toggle dots and the board's `◉` carry).
    // It replaced the warning DOT: a blocked session is asking you something,
    // and "?" survives being 10px and colour-blind while a tinted dot does not.
    // The attribute is the STATUS, so a test can name the state rather than the
    // colour it happens to paint with.
    const waiting = wait!.querySelector('[data-dot="waiting"]');
    expect(waiting).toBeTruthy();
    expect(waiting!.getAttribute("class")).toContain("text-warning");
    expect(wait!.querySelector('[role="status"]')).toBeNull();
    // Live and idle: the filled live ring.
    expect(live!.querySelector('[data-dot="live"]')).toBeTruthy();
    // Stored: a bare, dimmed ring — the session exists, nothing is happening.
    expect(stored!.querySelector('[data-dot="stored"]')).toBeTruthy();
  });

  it("marks the ACTIVE session, by weight rather than a new colour", () => {
    render(<SessionRail rows={[row({ key: "a", active: true }), row({ key: "b" })]} />);
    const [a, b] = screen.getAllByTestId("session-mark");
    expect(a!.getAttribute("class")).not.toBe(b!.getAttribute("class"));
    // The open list marks the active row with `bg-selected` (a fill); a 12px
    // dot has no room for a fill, so it takes the brighter INK instead — and
    // both values are existing tokens, not a rail-only colour.
    expect(a!.getAttribute("class")).toContain("text-foreground");
    expect(a!.getAttribute("class")).not.toContain("text-foreground-subtlest");
    expect(b!.getAttribute("class")).toContain("text-foreground-subtlest");
  });

  it("announces the SUMMARY only — the marks themselves are silent", () => {
    // The marks sit inside a `role="img"` container whose label is the whole
    // summary. A mark carrying its own name would be either dead weight (an AT
    // that prunes children of `role="img"`) or a doubled announcement (one that
    // does not) — so the rail asks for presentation explicitly.
    render(
      <SessionRail
        rows={[
          row({ key: "wait", status: "waiting" }),
          row({ key: "run", status: "running" }),
        ]}
      />,
    );
    // The summary is the ONE image in the tree…
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Sessions 2, 1 running, 1 waiting" })).toBeTruthy();
    // …and the waiting glyph exists without being named.
    const marks = screen.getAllByTestId("session-mark");
    expect(marks[0]!.getAttribute("data-dot")).toBe("waiting");
    expect(marks[0]!.getAttribute("aria-label")).toBeNull();
  });

  it("clips instead of scrolling, and keeps the marks out of the actions' click path", () => {
    render(
      <SessionRail rows={Array.from({ length: 40 }, (_, i) => row({ key: `s${i}` }))} />,
    );
    const marks = screen.getByTestId("session-rail-marks");
    const frame = screen.getByTestId("session-rail");
    expect(marks.className).toContain("overflow-hidden");
    expect(frame.className).toContain("overflow-hidden");
    for (const el of [marks, frame]) {
      expect(el.className).not.toMatch(/overflow-[a-z]*-(auto|scroll)/);
    }
    // Top-anchored: an overflowing flex column CENTERS its overflow when
    // justified to the middle, which would cut the FIRST sessions off the top.
    expect(marks.className).toContain("justify-start");
    // Rows share the height with a floor and a ceiling (see `TodoRail`).
    const rows = screen.getAllByTestId("session-row");
    expect(rows).toHaveLength(40);
    for (const r of rows.slice(0, 3)) {
      expect(r.className).toContain("flex-1");
      expect(r.className).toMatch(/min-h-/);
      expect(r.className).toMatch(/max-h-/);
    }
    // The frame is inset from the bottom by ordinary padding. It used to be
    // `bottom-9`, because the pane's own collapse toggle sat in the footer's
    // inner corner and the last mark would have landed under it; the toggle is
    // in the chrome bar now (`ChromeControls`), so the marks may use the whole
    // sliver. Asserted as a SMALL offset — a `>= 32` test would have passed
    // forever after a regression back to the old reservation.
    const bottom = frame.className.match(/\bbottom-(\d+)/);
    expect(bottom, "the rail is not offset from the bottom").toBeTruthy();
    expect(Number(bottom![1]) * 4).toBeLessThanOrEqual(8);
    // The MARKS are a readout and must not steal a click; the ACTIONS are
    // buttons and must not be click-through. One `pointer-events` rule per
    // block, because they have opposite jobs in the same 40px column.
    expect(marks.className).toContain("pointer-events-none");
    // The FRAME carries no such class: it also holds the action buttons, and a
    // `pointer-events-none` inherited from it would make them click-through
    // (the actions tests assert the other half).
    expect(frame.className).not.toContain("pointer-events-none");
  });

  it("summarises itself for the accessible name (the marks carry no text)", () => {
    render(
      <SessionRail
        rows={[
          row({ key: "a", status: "running" }),
          row({ key: "b", status: "waiting" }),
          row({ key: "c" }),
        ]}
      />,
    );
    // Counts, not titles: the rail is positional (the Nth mark is the Nth row)
    // and the titles live in the list and the transcript.
    expect(
      screen.getByRole("img", { name: "Sessions 3, 1 running, 1 waiting" }),
    ).toBeTruthy();
  });

  it("omits zero counts from the summary (a plain list reads as a plain list)", () => {
    render(<SessionRail rows={[row({ key: "a" }), row({ key: "b" })]} />);
    expect(screen.getByRole("img", { name: "Sessions 2" })).toBeTruthy();
  });

  it("renders nothing for an empty list (an empty rail is just the rail)", () => {
    const { container } = render(<SessionRail rows={[]} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  // -- The action strip (the collapsed rail's other job: the pane's own
  // -- commands, so collapsing the sidebar does not cost you those commands).
  // -- `Settings` is NOT one of them any more — the gear lives in the chrome
  // -- bar's `ChromeControls` in both states, so the rail has one strip, not
  // -- two. --

  const actions: SessionRailAction[] = [
    { id: "open", label: "Open Space", icon: <i />, onClick: vi.fn() },
    { id: "new", label: "New Session", icon: <i />, onClick: vi.fn() },
    { id: "skills", label: "Skills", icon: <i />, onClick: vi.fn() },
  ];
  it("renders the actions ABOVE the marks, each clickable by name", () => {
    const onClick = vi.fn();
    render(
      <SessionRail
        rows={[row({ key: "s1" }), row({ key: "s2" })]}
        actions={actions.map((a) => ({ ...a, onClick }))}
      />,
    );
    const box = screen.getByTestId("session-rail-actions");
    expect(box.children).toHaveLength(actions.length);
    for (const a of actions) {
      const btn = screen.getByRole("button", { name: a.label });
      // `title` too: the rail has no room for a label, so the hover text is
      // the only thing that says what the icon is.
      expect(btn.getAttribute("title")).toBe(a.label);
      // The actions come FIRST: the marks keep the positional rule (the Nth
      // mark is the Nth row), which only holds if they start at a FIXED offset
      // — a marks-first layout with actions below would shift nothing, but
      // actions-last would put them under the clipped tail.
      expect(box.compareDocumentPosition(screen.getByTestId("session-rail-marks"))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the marks clickable-free and the actions clickable (opposite jobs, one column)", () => {
    render(<SessionRail rows={[row({ key: "s1" })]} actions={actions} />);
    expect(screen.getByTestId("session-rail-marks").className).toContain("pointer-events-none");
    for (const a of actions) {
      expect(screen.getByRole("button", { name: a.label })).toBeTruthy();
    }
  });

  it("renders no action strip at all when none are given (the readout-only case)", () => {
    render(<SessionRail rows={[row({ key: "s1" })]} />);
    expect(screen.queryByTestId("session-rail-actions")).toBeNull();
  });

  it("shrinks the marks area to whatever the actions leave, and still clips not scrolls", () => {
    render(
      <SessionRail
        rows={Array.from({ length: 30 }, (_, i) => row({ key: `s${i}` }))}
        actions={actions}
      />,
    );
    const marks = screen.getByTestId("session-rail-marks");
    // `flex-1` + `min-h-0`: the marks take the leftover height and are allowed
    // to shrink below their content — without `min-h-0` a flex child's
    // automatic minimum is its content's height, which would push the action
    // strip (and the frame) taller instead of clipping the marks.
    expect(marks.className).toContain("flex-1");
    expect(marks.className).toContain("min-h-0");
    expect(marks.className).toContain("overflow-hidden");
    expect(marks.className).not.toMatch(/overflow-[a-z]*-(auto|scroll)/);
  });

});
