import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionStatusMark } from "./SessionStatusMark";
import type { SessionStatus } from "../hooks/useSessionStatus";

/** The class STRING of an element — `el.className` is an `SVGAnimatedString`
 * for an `<svg>`, so reading the property yields an object for the spinner and
 * the `?` and a string for the ring. The attribute is the same value in both
 * cases, which is why every assertion here goes through it. */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

/** All four states, in one render — the file's premise is that ONE component
 * draws all of them, in all three places that show a session's state. */
function all() {
  const { container } = render(
    <div>
      {(["running", "waiting", "live", "stored"] as SessionStatus[]).map((s) => (
        <span key={s} data-slot={s}>
          <SessionStatusMark status={s} />
        </span>
      ))}
    </div>,
  );
  const slot = (s: SessionStatus) =>
    container.querySelector(`[data-slot="${s}"]`)!.firstElementChild as HTMLElement;
  return { slot, container };
}

/**
 * The ONE session-state glyph, drawn in three places: the open sidebar row's
 * leading slot, the collapsed rail's column of marks, and the tab. Before it
 * existed the rail had its own dot column and the row had a spinner-plus-text-
 * pill, so the two views of the same fact could (and did) diverge — and the
 * IDLE state had no glyph at all in the open row, which is why the dot
 * vanished when the sidebar was expanded.
 */
describe("SessionStatusMark (one glyph for one state, wherever it is drawn)", () => {
  it("draws the spinner for a running session", () => {
    const { slot } = all();
    const run = slot("running");
    expect(run.getAttribute("role")).toBe("status");
    expect(classOf(run)).toContain("animate-spin");
  });

  it("draws a QUESTION MARK for a waiting session, in the attention colour", () => {
    const { slot } = all();
    const wait = slot("waiting");
    // The glyph is an icon, not a dot — it must read as "?" at 10px.
    expect(wait.getAttribute("data-dot")).toBe("waiting");
    expect(wait.tagName).toBe("svg");
    // The app's attention ink (the same token the rail's dot, the todo board's
    // `◉` and the subagent icon use), so "blocked on you" still outranks
    // "working" once the filled dot is gone.
    expect(classOf(wait)).toContain("text-warning");
    // And it is NOT the spinner: waiting outranks running, so the two glyphs
    // must never be confused for one another.
    expect(wait.getAttribute("role")).not.toBe("status");
  });

  it("names a waiting mark to assistive tech (the row's text pill is gone)", () => {
    render(<SessionStatusMark status="waiting" />);
    expect(screen.getByRole("img", { name: /waiting/i })).toBeTruthy();
  });

  it("keeps the ? legible at RAIL size (the stroke does not shrink with the box)", () => {
    const { container, rerender } = render(<SessionStatusMark status="waiting" size={16} />);
    const rowStroke = container
      .firstElementChild!.getAttribute("stroke-width")!;
    rerender(<SessionStatusMark status="waiting" size={10} />);
    const railStroke = container
      .firstElementChild!.getAttribute("stroke-width")!;
    // A 10px lucide icon would draw 2 × 10/24 ≈ 0.83px — a hairline, where the
    // 10px filled dot the rail used to draw was never one.
    expect(Number(railStroke)).toBeGreaterThan(Number(rowStroke));
    expect((Number(railStroke) * 10) / 24).toBeGreaterThanOrEqual(1.2);
  });

  it("goes SILENT with announce={false}, for a surface that names the state itself", () => {
    // The tab: its `title` says "waiting for you", and a name INSIDE the tab
    // button would fold into the tab's accessible name and rename the control.
    const { rerender } = render(<SessionStatusMark status="waiting" />);
    expect(screen.getByRole("img", { name: /waiting/i })).toBeTruthy();
    rerender(<SessionStatusMark status="waiting" announce={false} />);
    expect(screen.queryByRole("img")).toBeNull();
    // The spinner goes silent too — the tab's spinner used to be `aria-hidden`,
    // and its `role="status"` would announce "Loading…" inside the tab name.
    rerender(<SessionStatusMark status="running" announce={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws a FILLED ring for live-and-idle and a DIM ring for stored", () => {
    const { slot } = all();
    const live = slot("live");
    const stored = slot("stored");
    expect(live.getAttribute("data-dot")).toBe("live");
    expect(stored.getAttribute("data-dot")).toBe("stored");
    // The idle cue the user could see in the rail and NOT in the open list: a
    // live session's own ring, so "this session exists and is idle" is visible
    // in both sidebar states.
    expect(classOf(live)).toContain("rounded-full");
    expect(classOf(live)).toContain("border-2");
    // Stored is one step dimmer in BOTH axes — a thinner ring and the quieter ink.
    expect(classOf(stored)).toContain("rounded-full");
    expect(classOf(stored)).not.toContain("border-2");
  });

  it("takes the brighter ink for the ACTIVE session (the rail has no room for a fill)", () => {
    const { container } = render(
      <div>
        <span data-slot="on">
          <SessionStatusMark status="stored" active />
        </span>
        <span data-slot="off">
          <SessionStatusMark status="stored" />
        </span>
      </div>,
    );
    const on = container.querySelector("[data-slot='on']")!.firstElementChild!;
    const off = container.querySelector("[data-slot='off']")!.firstElementChild!;
    expect(classOf(on)).toContain("text-foreground");
    expect(classOf(on)).not.toContain("text-foreground-subtlest");
    expect(classOf(off)).toContain("text-foreground-subtlest");
  });

  it("draws the RING at half the slot while the SLOT stays put", () => {
    // The three states are three different AMOUNTS OF INK, and the ring is the
    // only one that reads as a solid chunk of paint — at a shared 16px the
    // idle state outshouts the working state beside it, which inverts their
    // importance. The row keeps `size={16}` for the spinner and the `?` (both
    // outlines, whose weight is what makes them readable) and halves the dot.
    const { container } = render(
      <div>
        <span data-slot="live">
          <SessionStatusMark status="live" size={16} dotSize={8} />
        </span>
        <span data-slot="spinner">
          <SessionStatusMark status="running" size={16} dotSize={8} />
        </span>
        <span data-slot="question">
          <SessionStatusMark status="waiting" size={16} dotSize={8} />
        </span>
      </div>,
    );
    const live = container.querySelector("[data-slot='live']")!
      .firstElementChild as HTMLElement;
    // THE SLOT IS 16px. The row's leading slot is SHARED geometry: the archived
    // rows below reserve a `size-4` placeholder there purely so their titles
    // start at the same x as these rows'. Shrink the box itself and every title
    // in the list slides 8px left out of alignment with the Archived section —
    // so the mark keeps the slot and shrinks only the glyph inside it.
    expect(live.style.width).toBe("16px");
    expect(live.style.height).toBe("16px");
    // The ring is the CHILD, at half the box.
    const ring = live.firstElementChild as HTMLElement;
    expect(ring.getAttribute("data-dot")).toBe("live");
    expect(ring.style.width).toBe("8px");
    expect(ring.style.height).toBe("8px");
    // And it is CENTRED in the slot, so it still sits on the same vertical as
    // the spinner's and the `?`'s column.
    expect(live.className).toContain("items-center");
    expect(live.className).toContain("justify-center");
    // The other two glyphs are UNTOUCHED by the dot's size — half a spinner is
    // not a spinner, and the `?` is already at its legibility floor.
    expect(
      (
        container.querySelector("[data-slot='spinner']")!
          .firstElementChild as HTMLElement
      ).style.width,
    ).toBe("16px");
    expect(
      (
        container.querySelector("[data-slot='question']")!
          .firstElementChild as HTMLElement
      ).style.width,
    ).toBe("16px");
  });

  it("adds NO slot when the ring is the size of the box (the rail, the tab)", () => {
    // The collapsed rail sizes its dot by the strip's width and passes no
    // `dotSize`; its 10px mark has always been legible and this change is not
    // about it. The wrapper exists only to reconcile two different sizes — with
    // one size it would be a pointless node in the rail's 10px strip.
    const { container } = render(
      <span data-slot="rail">
        <SessionStatusMark status="live" size={10} />
      </span>,
    );
    const el = container.querySelector("[data-slot='rail']")!
      .firstElementChild as HTMLElement;
    expect(el.style.width).toBe("10px");
    expect(el.getAttribute("data-dot")).toBe("live");
    expect(el.firstElementChild).toBeNull();
  });

  it("sizes the glyph in px, so one component fills a 10px rail slot and a 16px row slot", () => {
    const { container } = render(
      <div>
        <span data-slot="rail">
          <SessionStatusMark status="live" size={10} />
        </span>
        <span data-slot="row">
          <SessionStatusMark status="live" size={12} />
        </span>
      </div>,
    );
    for (const [slot, px] of [
      ["rail", "10px"],
      ["row", "12px"],
    ] as const) {
      const el = container.querySelector(`[data-slot='${slot}']`)!
        .firstElementChild as HTMLElement;
      expect(el.style.width).toBe(px);
      expect(el.style.height).toBe(px);
    }
  });

  it("carries an optional test id and extra classes for the surface that places it", () => {
    const { container } = render(
      <SessionStatusMark status="running" testId="tab-mark" className="text-foreground-subtle" />,
    );
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.getAttribute("data-testid")).toBe("tab-mark");
    expect(classOf(mark)).toContain("text-foreground-subtle");
  });
});
