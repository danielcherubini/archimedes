import { describe, expect, it } from "vitest";
import {
  mostRecentByRecency,
  recencyOf,
  sortByManualOrder,
  sortByRecency,
} from "./sessionRecency";
import { makeMessage } from "../test/fixtures";
import type { Message } from "./sessionTypes";

const msg = (at: number): Message => makeMessage("user", { text: "x", at });

describe("recencyOf (the ONE recency rule, ADR 0075)", () => {
  it("recencyOf prefers the loaded transcript's last stamp over the boot recency map", () => {
    // The two evidences DISAGREE on purpose: the map says 500, the transcript
    // says 9_000_000_000_000. An implementation that read the map first answers
    // 500 and is red here.
    expect(
      recencyOf("s1", [msg(1_000), msg(9_000_000_000_000)], { s1: 500 }),
    ).toBe(9_000_000_000_000);
  });

  it("recencyOf falls back to the recency map when no transcript is loaded", () => {
    // `undefined` = "we never opened it"; `[]` = "opened, nothing in it" (what
    // `addSession` gives a fresh session). Both are "no transcript evidence",
    // so the map carries the answer — and the map value is DIFFERENT from any
    // stamp the fixture could have produced.
    expect(recencyOf("s1", undefined, { s1: 5_000 })).toBe(5_000);
    expect(recencyOf("s1", [], { s1: 5_000 })).toBe(5_000);
  });

  it("recencyOf is null when neither the transcript nor the map can prove recency", () => {
    // REACHABLE, not defensive: a Session that CLOSED this boot is appended to
    // `historySessions` by `handleSessionClosed` with no boot-map entry.
    expect(recencyOf("ghost", undefined, {})).toBeNull();
  });
});

describe("sortByRecency / mostRecentByRecency (recency decides, position never)", () => {
  it("sortByRecency orders by recency and NOT by input order, sinking what has no evidence", () => {
    // Input order is [a, b, c]; recency order is [c, a, b]. A sort by nothing
    // answers the input order and is red. `b` has NO evidence and goes LAST —
    // never treated as epoch-0 recency.
    expect(sortByRecency(["a", "b", "c"], { recency: { a: 1, c: 9 } })).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("mostRecentByRecency keeps the FIRST of two equal stamps and answers null for no ids", () => {
    // Input order is the tie-break (the surviving half of `sortByActivity`'s
    // stable-sort rule — a dragged list must not reshuffle on equal stamps).
    expect(mostRecentByRecency(["x", "y"], { recency: { x: 7, y: 7 } })).toBe(
      "x",
    );
    expect(mostRecentByRecency([], { recency: {} })).toBeNull();
  });
});

describe("sortByManualOrder (the ORDER twin: the stored number decides)", () => {
  it("sortByManualOrder orders by the stored number and NOT by input order", () => {
    // Input order is [a, b, c] and its FIRST element carries the LARGEST
    // number, so a no-op sort AND a descending sort are both red. Ascending is
    // the database's reading (`ORDER BY … ASC`, new rows take MAX + 1), so a
    // bigger number is a LOWER row.
    expect(sortByManualOrder(["a", "b", "c"], { a: 2, b: 0, c: 1 })).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("sortByManualOrder puts ids the map does not know at the BOTTOM, in input order", () => {
    // The "new rows join at the bottom" rule as a sentinel. Defaulting an
    // unknown to 0 would promote a row started this boot to the TOP, so the
    // unknowns go last and keep their relative input order.
    expect(
      sortByManualOrder(["known2", "new2", "known1", "new1"], {
        known1: 0,
        known2: 1,
      }),
    ).toEqual(["known1", "known2", "new2", "new1"]);
  });
});
