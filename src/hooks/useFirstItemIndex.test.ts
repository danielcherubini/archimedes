import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RenderUnit } from "../lib/toolGroups";
import { useFirstItemIndex, START_INDEX } from "./useFirstItemIndex";

describe("useFirstItemIndex", () => {
  it("initializes to START_INDEX", () => {
    const units: RenderUnit[] = [
      { kind: "single", message: { kind: "user", text: "hi", at: 100 } },
    ];
    const { result } = renderHook(() => useFirstItemIndex(units, "s1", 1));
    expect(result.current).toBe(START_INDEX);
  });

  it("decrements index by prepended unit count when older messages are loaded", () => {
    const unit1: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "msg1", at: 100 },
    };
    const unit2: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "msg2", at: 200 },
    };

    let units = [unit1, unit2];
    const { result, rerender } = renderHook(
      ({ u, s, g }: { u: RenderUnit[]; s: string; g: number }) =>
        useFirstItemIndex(u, s, g),
      { initialProps: { u: units, s: "s1", g: 1 } },
    );

    expect(result.current).toBe(START_INDEX);

    // Prepend 2 units
    const older1: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "old1", at: 10 },
    };
    const older2: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "old2", at: 20 },
    };
    units = [older1, older2, unit1, unit2];

    rerender({ u: units, s: "s1", g: 1 });
    expect(result.current).toBe(START_INDEX - 2);
  });

  it("keeps index unchanged when messages are appended at the tail", () => {
    const unit1: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "msg1", at: 100 },
    };
    let units = [unit1];
    const { result, rerender } = renderHook(
      ({ u, s, g }: { u: RenderUnit[]; s: string; g: number }) =>
        useFirstItemIndex(u, s, g),
      { initialProps: { u: units, s: "s1", g: 1 } },
    );

    expect(result.current).toBe(START_INDEX);

    // Append a unit
    const unit2: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "msg2", at: 200 },
    };
    units = [unit1, unit2];

    rerender({ u: units, s: "s1", g: 1 });
    expect(result.current).toBe(START_INDEX);
  });

  it("resets to START_INDEX when sessionId changes", () => {
    const unit1: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "msg1", at: 100 },
    };
    let units = [unit1];
    const { result, rerender } = renderHook(
      ({ u, s, g }: { u: RenderUnit[]; s: string; g: number }) =>
        useFirstItemIndex(u, s, g),
      { initialProps: { u: units, s: "s1", g: 1 } },
    );

    const older: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "old", at: 10 },
    };
    units = [older, unit1];
    rerender({ u: units, s: "s1", g: 1 });
    expect(result.current).toBe(START_INDEX - 1);

    // Switch session
    rerender({ u: units, s: "s2", g: 1 });
    expect(result.current).toBe(START_INDEX);
  });

  it("resets to START_INDEX when generation changes", () => {
    const unit1: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "msg1", at: 100 },
    };
    let units = [unit1];
    const { result, rerender } = renderHook(
      ({ u, s, g }: { u: RenderUnit[]; s: string; g: number }) =>
        useFirstItemIndex(u, s, g),
      { initialProps: { u: units, s: "s1", g: 1 } },
    );

    const older: RenderUnit = {
      kind: "single",
      message: { kind: "user", text: "old", at: 10 },
    };
    units = [older, unit1];
    rerender({ u: units, s: "s1", g: 1 });
    expect(result.current).toBe(START_INDEX - 1);

    // Increment generation
    rerender({ u: units, s: "s1", g: 2 });
    expect(result.current).toBe(START_INDEX);
  });
});
