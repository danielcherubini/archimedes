import { describe, expect, it } from "vitest";
import { makeConfigSource, makeSessionRow } from "../test/fixtures";
import type { CostUpdatePayload } from "../store/interactive";
import { costUsdOf } from "./sessionCost";

/**
 * The session's stored/live USD figure, spelled once (`lib/sessionCost.ts`).
 *
 * A pure function over the two state shapes — no store, no DOM — which is the
 * whole reason the selector left the component: the precedence rule below is
 * the part that can be wrong silently, and it has to be reachable without
 * rendering anything (the same reason `sessionConfig.ts`'s derivations are
 * plain functions).
 *
 * The inputs are the real shapes: the live entry is `CostUpdatePayload` (the
 * store's own entry type) and the row side is the three-list walk's input
 * (`makeConfigSource` / `makeSessionRow`, so a row is a real `SessionInfo`).
 */
const source = (over: Parameters<typeof makeConfigSource>[0] = {}) =>
  makeConfigSource(over);

/** A live store entry carrying only the money key (the shape `applyCost` writes). */
const entry = (costUsd: number | null): CostUpdatePayload => ({ costUsd });

describe("costUsdOf (the session's money: live entry first, then the stored row, #105)", () => {
  it("reads the ROW's figure when there is no live entry (the boot case)", () => {
    // Boot: the map is empty (the hydrator that fills it runs only from
    // Settings' provider refresh, never at boot), so a stored session's figure
    // exists ONLY on its row. Without this half the feature works after opening
    // Settings and nowhere else.
    const s = source({
      historySessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.25 })],
    });
    expect(costUsdOf(undefined, s, "s1")).toBe(0.25);
  });

  it("is null when nothing knows a figure (no entry, no row — renders nothing)", () => {
    expect(costUsdOf(undefined, source(), "s1")).toBeNull();
  });

  it("prefers null over the row when the live entry exists but holds null (the precedence case)", () => {
    // The deliberate divergence from `contextUsageOf`, which uses `??` and would
    // fall through here. An entry that EXISTS with `costUsd: null` means "frames
    // arrived this session, none carried a figure" — a live session reporting
    // nothing TODAY. Falling through to a stored row would resurrect an old
    // figure over that report, manufacturing money the provider did not send.
    const s = source({
      historySessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.25 })],
    });
    expect(costUsdOf(entry(null), s, "s1")).toBeNull();
  });

  it("prefers the live entry over the row (a resumed session continues its total)", () => {
    // After resume the map is seeded from the row and then accumulates, so the
    // entry is the fresher number by construction. The row is the pre-resume
    // figure and must never win.
    const s = source({
      sessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.25 })],
    });
    expect(costUsdOf(entry(0.75), s, "s1")).toBe(0.75);
  });

  it("is null with no session id (no active session, so the lists are not read)", () => {
    const s = source({
      historySessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.25 })],
    });
    expect(costUsdOf(undefined, s, null)).toBeNull();
    expect(costUsdOf(entry(0.75), s, null)).toBeNull();
    expect(costUsdOf(undefined, s, undefined)).toBeNull();
  });

  it("reads a row figure of 0 as 0, not as null (D5: a real zero IS a figure)", () => {
    // `sessionFieldOf`'s gap test is `??`-style (`!== null && !== undefined`),
    // NOT a truthiness test, so a `0` stops the walk instead of being skipped as
    // a gap. This is the case a `||` would have destroyed.
    const s = source({
      historySessions: [makeSessionRow({ sessionId: "s1", costUsd: 0 })],
    });
    expect(costUsdOf(undefined, s, "s1")).toBe(0);
  });

  it("walks live → history → archived for the row (an archived session lives ONLY in the last list)", () => {
    const archived = source({
      archivedSessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.4 })],
    });
    expect(costUsdOf(undefined, archived, "s1")).toBe(0.4);
    // The live row wins over a stored row with the same id.
    const both = source({
      sessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.1 })],
      historySessions: [makeSessionRow({ sessionId: "s1", costUsd: 0.2 })],
    });
    expect(costUsdOf(undefined, both, "s1")).toBe(0.1);
  });

  it("is null for a row that exists but carries no costUsd key at all", () => {
    // The wire omits the key entirely when the column is NULL, so the fixture
    // must omit it too (see `makeSessionRow`'s allow-list) — and the walk then
    // reports "nothing knows", which renders nothing.
    const s = source({
      historySessions: [makeSessionRow({ sessionId: "s1" })],
    });
    expect(costUsdOf(undefined, s, "s1")).toBeNull();
  });
});
