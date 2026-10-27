import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SessionCostLine } from "./SessionCostLine";
import { useInteractive } from "../store/interactive";
import { formatCost } from "../lib/toolOutput";

/**
 * Every case seeds through `applyCost`, not by hand-writing a store entry: the
 * store's normalisation (`frameCost` → `combineSessionCost` → write-both-keys)
 * is part of the contract this line depends on, and a test that bypassed it
 * would pass while the store manufactured a phantom `0`.
 */
function seed(sessionId: string, frames: unknown[]): void {
  for (const frame of frames) {
    useInteractive.getState().applyCost(sessionId, frame);
  }
}

beforeEach(() => {
  // NOT `dismissSession("s1")`: the file's own id is `s1`, and a self-reset in
  // each place keeps the cases order-independent rather than relying on a hook
  // that a later edit could scope differently.
  useInteractive.setState({ cost: {} });
});

describe("SessionCostLine (the session's cumulative USD figure under its name, #87)", () => {
  it("renders the figure the provider reported", () => {
    seed("s1", [{ costUsd: 0.0042 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.0042");
  });

  it("renders a two-decimal figure above $0.01", () => {
    seed("s1", [{ costUsd: 0.15 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.15");
  });

  it("renders a REAL zero as $0.00 (D5: a real zero IS a figure)", () => {
    seed("s1", [{ costUsd: 0 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.00");
    // And the element exists — this is the assertion that separates "free" from
    // "unknown"; the unknown case below asserts the opposite.
    expect(screen.getByTestId("session-cost")).toBeTruthy();
  });

  it("renders NOTHING when the frames carried no figure (D5's unknown, not $0.00)", () => {
    seed("s1", [{ costUsd: null }, { costUsd: null }]);
    const { container } = render(<SessionCostLine sessionId="s1" />);
    // No element at all — not an empty row, not a gap-child in the pane's
    // `gap-4` column.
    expect(container.firstChild).toBeNull();
    // And no dollar sign anywhere, so a `$0.00` cannot hide behind a wrapper.
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("renders NOTHING when no cost frame ever arrived", () => {
    // The first-call-before-any-usage state: D4's "an unknown price renders as
    // nothing" covers it, by composition.
    const { container } = render(<SessionCostLine sessionId="s1" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("renders NOTHING for a session id that is null (no active session)", () => {
    seed("s1", [{ costUsd: 0.0042 }]);
    const { container } = render(<SessionCostLine sessionId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("sums frames: an unknown frame then a priced frame shows the figure", () => {
    seed("s1", [{ costUsd: null }, { costUsd: 0.03 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.03");
  });

  it("keeps the figure when a later frame reports nothing", () => {
    seed("s1", [{ costUsd: 0.03 }, { costUsd: null }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.03");
  });

  it("is a MutedCaption (the pane's caption type scale, no invented class string)", () => {
    seed("s1", [{ costUsd: 0.15 }]);
    render(<SessionCostLine sessionId="s1" />);
    const caption = screen.getByTestId("session-cost").firstElementChild;
    expect(caption).not.toBeNull();
    expect(caption!.tagName).toBe("P");
    expect(caption!.className).toContain("text-ui-xs");
    expect(caption!.className).toContain("text-foreground-subtlest");
  });

  it("reads ONLY its own session's entry", () => {
    seed("other", [{ costUsd: 0.5 }]);
    const { container } = render(<SessionCostLine sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });
});

/**
 * SEAM S3a — THE `$0.0000` CLIFF.
 *
 * `formatCost` (`src/lib/toolOutput.ts`) prints `"$" + cost.toFixed(4)` below
 * `$0.01`, so EVERY non-zero figure under `$0.00005` becomes the literal string
 * `"$0.0000"` — and `formatCost(v) || null` cannot catch it, because `"$0.0000"`
 * is a truthy string. T08's live-proxy probes put the real per-call cost inside
 * that band (`0.000011662` on the completions wire, `2.122e-05` on the Responses
 * wire), so a fresh session would have read `$0.0000` — "free" — while money was
 * genuinely being spent. That is issue #87's own defect class arriving through
 * the formatter instead of the harness.
 *
 * Every input below is a REAL measured magnitude, deliberately: the examples
 * this plan originally carried (`$0.0042`, `$0.15`) sit ABOVE the cliff, which is
 * exactly how the defect survived two review rounds.
 *
 * Each case asserts that `"$0.0000"` is ABSENT. A case that only checked that
 * some `$` text exists passes with the bug present and is worth nothing.
 */
describe("a real per-call cost never renders as free (issue #87's cliff)", () => {
  it("renders T08's primary measured per-call cost as a NON-ZERO figure", () => {
    seed("s1", [{ costUsd: 0.000011662 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.000012");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders the smallest measured per-call cost as a NON-ZERO figure", () => {
    seed("s1", [{ costUsd: 0.0000047597 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.0000048");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders the second measured completions-wire cost as a NON-ZERO figure", () => {
    seed("s1", [{ costUsd: 0.00001243 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.000012");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders the measured Responses-wire cost as a NON-ZERO figure", () => {
    seed("s1", [{ costUsd: 0.00002122 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.000021");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders a realistic first-five-calls session (four unpriced calls, one priced) as the priced call's money", () => {
    // T08's probe P6: absence is PER-CALL — on the live proxy 4 of the first 5
    // calls carry no `cost` at all. This is the exact state a user's first
    // session is in, and it is the case the cliff used to win: the total is one
    // call's `0.000011662`, which `toFixed(4)` printed as `$0.0000`.
    seed("s1", [
      { costUsd: null },
      { costUsd: null },
      { costUsd: null },
      { costUsd: 0.000011662 },
      { costUsd: null },
    ]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.000012");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders the four measured priced calls SUMMED as a NON-ZERO figure", () => {
    // 0.000011662 + 0.0000047597 + 0.00001243 + 0.0000052633 = 0.000034115 —
    // still below the seam, so the shared helper printed `$0.0000` for the
    // session's whole visible spend.
    seed("s1", [
      { costUsd: 0.000011662 },
      { costUsd: 0.0000047597 },
      { costUsd: 0.00001243 },
      { costUsd: 0.0000052633 },
    ]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.000034");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders the seam value itself exactly as the shared helper does", () => {
    // `0.00005` is the first value `toFixed(4)` renders truthfully, so at the
    // seam the local rule and `formatCost` MUST agree — the seam was chosen at
    // this value precisely so the two surfaces never disagree about the same
    // money wherever both are defined.
    seed("s1", [{ costUsd: 0.00005 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("$0.0001");
    expect(screen.getByTestId("session-cost").textContent).toBe(formatCost(0.00005));
  });

  it("renders the value just below the seam as a NON-ZERO figure", () => {
    // The invariant is what is pinned here, not a rounding accident: below the
    // seam the local rule takes over and must still print something truthful.
    seed("s1", [{ costUsd: 0.000049999 }]);
    render(<SessionCostLine sessionId="s1" />);
    const text = screen.getByTestId("session-cost").textContent!;
    expect(text).not.toBe("$0.0000");
    expect(text).not.toBe("$0.00");
    expect(text.startsWith("$")).toBe(true);
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("renders a figure too small to print as a truthful inequality, not as free", () => {
    seed("s1", [{ costUsd: 1e-9 }]);
    render(<SessionCostLine sessionId="s1" />);
    expect(screen.getByTestId("session-cost").textContent).toBe("<$0.000001");
    expect(screen.queryByText("$0.0000")).toBeNull();
  });

  it("matches formatCost exactly wherever formatCost is truthful (no split-brain between surfaces)", () => {
    // Above the seam the digits MUST match the shared helper, or two surfaces
    // print two strings for the same money. An edit to either formatter that
    // splits them reddens this case.
    for (const value of [0.00005, 0.0042, 0.0099, 0.01, 0.15]) {
      useInteractive.setState({ cost: {} });
      seed("s1", [{ costUsd: value }]);
      const { unmount } = render(<SessionCostLine sessionId="s1" />);
      expect(screen.getByTestId("session-cost").textContent).toBe(formatCost(value));
      unmount();
    }
  });
});
