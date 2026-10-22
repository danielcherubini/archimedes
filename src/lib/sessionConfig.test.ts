import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "./tauri";
import { makeConfigOption, makeConfigSource, makeSessionRow } from "../test/fixtures";
import type { SessionConfigSource } from "./sessionConfig";
import {
  contextPercentOf,
  contextRampFor,
  contextUsageOf,
  findConfigOption,
  sessionConfigOptionsOf,
} from "./sessionConfig";

/**
 * A plain object over the `useSessions` state SHAPE (the real store is never
 * imported here — these five functions are pure derivations, and that is the
 * whole reason they left `ChatStream`: the composer and the side pane must be
 * able to run the same fallback inside their own selectors).
 *
 * The lists and rows come from `src/test/fixtures` (the rolling migration): a
 * row is `makeSessionRow`, so it is a real `SessionInfo` rather than a partial
 * literal that only compiles while the walk's row type stays narrow.
 */
const state = (over: Partial<SessionConfigSource> = {}): SessionConfigSource =>
  makeConfigSource(over);

/** The fixture with a `currentValue`, and `options` echoing it (so a test that
 *  asserts WHICH list a value came from cannot match by coincidence). */
const modelOption = (currentValue: string): SessionConfigOption =>
  makeConfigOption({
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  });

/** A row carrying `configOptions`, in the list the test names. */
const rowWithOptions = (configOptions: SessionConfigOption[]) =>
  makeSessionRow({ configOptions });

/** A row carrying `contextUsage`, in the list the test names. */
const rowWithUsage = (contextUsage: { used: number; window: number }) =>
  makeSessionRow({ contextUsage });

describe("sessionConfigOptionsOf (the four-way fallback)", () => {
  it("is null with no session id (no active session)", () => {
    expect(sessionConfigOptionsOf(state({ configOptions: { s1: [modelOption("a")] } }), null)).toBeNull();
  });

  it("prefers the store's live map over every row's copy", () => {
    const s = state({
      configOptions: { s1: [modelOption("live")] },
      sessions: [rowWithOptions([modelOption("row")])],
      historySessions: [rowWithOptions([modelOption("hist")])],
      archivedSessions: [rowWithOptions([modelOption("arch")])],
    });
    expect(sessionConfigOptionsOf(s, "s1")![0]!.currentValue).toBe("live");
  });

  it("falls back to the LIVE session row when the map has no entry", () => {
    const s = state({
      sessions: [rowWithOptions([modelOption("row")])],
      historySessions: [rowWithOptions([modelOption("hist")])],
      archivedSessions: [rowWithOptions([modelOption("arch")])],
    });
    expect(sessionConfigOptionsOf(s, "s1")![0]!.currentValue).toBe("row");
  });

  it("falls back to the stored (history) row", () => {
    const s = state({
      historySessions: [rowWithOptions([modelOption("hist")])],
      archivedSessions: [rowWithOptions([modelOption("arch")])],
    });
    expect(sessionConfigOptionsOf(s, "s1")![0]!.currentValue).toBe("hist");
  });

  it("falls back to the ARCHIVED-only row (a session opened from the Archived section)", () => {
    const s = state({
      archivedSessions: [rowWithOptions([modelOption("arch")])],
    });
    expect(sessionConfigOptionsOf(s, "s1")![0]!.currentValue).toBe("arch");
  });

  it("is null when no list knows the id", () => {
    expect(sessionConfigOptionsOf(state(), "s1")).toBeNull();
  });

  it("returns `[]` (NOT null) for a row whose config has zero options — the two states stay distinct", () => {
    // The invariant B1 must not flatten: `null` means "nothing knows this id"
    // and `[]` means "a config with zero options". `sessionFieldOf` returns
    // `undefined` for the first case and the row's own `[]` for the second, and
    // the `?? null` tail lives in `sessionConfig.ts` so only the first becomes
    // `null`. A `||` tail or a walk that synthesized `[]` would collapse them.
    const empty = rowWithOptions([]);
    const s = state({ sessions: [empty] });
    const found = sessionConfigOptionsOf(s, "s1");
    expect(found).not.toBeNull();
    expect(found).toEqual([]);
    // By reference: the row's own array, so the selector cannot re-render
    // forever on a fresh `[]` (the zustand v5 rule).
    expect(found).toBe(empty.configOptions);
    expect(sessionConfigOptionsOf(state(), "s1")).toBeNull();
  });
});

describe("contextUsageOf (the same four-way fallback)", () => {
  it("is undefined with no session id", () => {
    expect(contextUsageOf(state({ contextUsage: { s1: { used: 1, window: 2 } } }), null)).toBeUndefined();
  });

  it("prefers the store's live map", () => {
    const s = state({
      contextUsage: { s1: { used: 10, window: 100 } },
      sessions: [rowWithUsage({ used: 20, window: 100 })],
      historySessions: [rowWithUsage({ used: 30, window: 100 })],
      archivedSessions: [rowWithUsage({ used: 40, window: 100 })],
    });
    expect(contextUsageOf(s, "s1")).toEqual({ used: 10, window: 100 });
  });

  it("falls back to the live row, then the history row, then the archived row", () => {
    expect(
      contextUsageOf(state({ sessions: [rowWithUsage({ used: 20, window: 100 })] }), "s1"),
    ).toEqual({ used: 20, window: 100 });
    expect(
      contextUsageOf(state({ historySessions: [rowWithUsage({ used: 30, window: 100 })] }), "s1"),
    ).toEqual({ used: 30, window: 100 });
    expect(
      contextUsageOf(state({ archivedSessions: [rowWithUsage({ used: 40, window: 100 })] }), "s1"),
    ).toEqual({ used: 40, window: 100 });
  });

  it("is undefined when nothing knows the usage", () => {
    expect(contextUsageOf(state(), "s1")).toBeUndefined();
  });

  it("an explicit `undefined` map entry still falls through to the rows", () => {
    const s = state({
      contextUsage: { s1: undefined },
      sessions: [rowWithUsage({ used: 20, window: 100 })],
    });
    expect(contextUsageOf(s, "s1")).toEqual({ used: 20, window: 100 });
  });
});

describe("contextPercentOf", () => {
  it("is undefined without a usage", () => {
    expect(contextPercentOf(undefined)).toBeUndefined();
  });

  it("is undefined when the window is 0 (a divide-by-zero would print NaN%)", () => {
    expect(contextPercentOf({ used: 100, window: 0 })).toBeUndefined();
  });

  it("rounds the ratio", () => {
    expect(contextPercentOf({ used: 53760, window: 128000 })).toBe(42);
    expect(contextPercentOf({ used: 78080, window: 128000 })).toBe(61);
    expect(contextPercentOf({ used: 96000, window: 128000 })).toBe(75);
    expect(contextPercentOf({ used: 115200, window: 128000 })).toBe(90);
  });

  it("clamps at 100 (a usage over an under-reported window must not read 118%)", () => {
    expect(contextPercentOf({ used: 200000, window: 128000 })).toBe(100);
  });

  it("is 0 for an empty context", () => {
    expect(contextPercentOf({ used: 0, window: 128000 })).toBe(0);
  });
});

describe("contextRampFor (the traffic-light ramp)", () => {
  it("is success when the percentage is not known yet", () => {
    expect(contextRampFor(undefined)).toEqual({ fill: "bg-success", label: "text-success" });
  });

  it("is success below 50% and success right up to the boundary", () => {
    expect(contextRampFor(0).fill).toBe("bg-success");
    expect(contextRampFor(49).fill).toBe("bg-success");
    expect(contextRampFor(49).label).toBe("text-success");
  });

  it("is caution from 50 to 69", () => {
    expect(contextRampFor(50)).toEqual({ fill: "bg-caution", label: "text-caution" });
    expect(contextRampFor(69)).toEqual({ fill: "bg-caution", label: "text-caution" });
  });

  it("is warning from 70 to 89", () => {
    expect(contextRampFor(70)).toEqual({ fill: "bg-warning", label: "text-warning" });
    expect(contextRampFor(89)).toEqual({ fill: "bg-warning", label: "text-warning" });
  });

  it("is destructive from 90 up", () => {
    expect(contextRampFor(90)).toEqual({ fill: "bg-destructive", label: "text-destructive" });
    expect(contextRampFor(100)).toEqual({ fill: "bg-destructive", label: "text-destructive" });
  });
});

describe("findConfigOption", () => {
  const options: SessionConfigOption[] = [
    { id: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    },
    // A select with NO options is not a selector (nothing to pick).
    { id: "empty", name: "Empty", category: "model", type: "select", currentValue: "", options: [] },
    // A boolean option is not a select.
    { id: "flag", name: "Flag", category: "model", type: "boolean", currentValue: true },
  ];

  it("matches on the CATEGORY", () => {
    expect(findConfigOption(options, "thought_level", "thought_level")!.id).toBe("thought_level");
  });

  it("matches on the ID when the category is absent", () => {
    expect(findConfigOption(options, "model", "model")!.id).toBe("model");
  });

  it("skips a select with no options", () => {
    expect(findConfigOption(options, "model", "nothing")).toBeUndefined();
  });

  it("skips a non-select option", () => {
    expect(findConfigOption([{ id: "flag", name: "Flag", category: "model", type: "boolean", currentValue: true }], "model", "flag")).toBeUndefined();
  });

  it("is undefined for a null option list (no config at all)", () => {
    expect(findConfigOption(null, "model", "model")).toBeUndefined();
  });

  it("is undefined when the list has no match", () => {
    expect(findConfigOption([options[0]!], "thought_level", "thought_level")).toBeUndefined();
  });
});
