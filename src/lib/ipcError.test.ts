import { describe, expect, it } from "vitest";
import { describeIpcError } from "./ipcError";

describe("describeIpcError", () => {
  // ── rule 1 — `Err(String)` commands (the majority of the surface) ──────
  it("returns a plain string rejection unchanged", () => {
    expect(describeIpcError("no such folder")).toBe("no such folder");
  });

  it("returns a refusal code unchanged", () => {
    expect(describeIpcError("denied-scheme:javascript")).toBe(
      "denied-scheme:javascript",
    );
  });

  it("returns an empty string rejection as empty (no invented text)", () => {
    expect(describeIpcError("")).toBe("");
  });

  // ── rule 2 — real Error instances ──────────────────────────────────────
  it("returns the message of an Error", () => {
    expect(describeIpcError(new Error("disk full"))).toBe("disk full");
  });

  it("prefers the Error's own message over an own-data-property oddity", () => {
    const e = new Error("real message");
    // A subclass that also carries a shadowing own `message`-like key must
    // still read through `Error.message` (rule 2 runs before rule 3).
    Object.defineProperty(e, "detail", { value: "other" });
    expect(describeIpcError(e)).toBe("real message");
  });

  it("returns the empty message of a messageless Error", () => {
    expect(describeIpcError(new Error())).toBe("");
  });

  // ── rule 3 — the Task 1 typed envelope ─────────────────────────────────
  it("returns the message of the typed envelope", () => {
    expect(
      describeIpcError({
        kind: "folder_missing",
        message: "folder not found: C:\\work",
        path: "C:\\work",
      }),
    ).toBe("folder not found: C:\\work");
  });

  it("returns the message of a { kind, message } rejection", () => {
    expect(describeIpcError({ kind: "error", message: "proto" })).toBe("proto");
  });

  // ── rule 4 — `kind` is better than nothing ─────────────────────────────
  it("returns the kind when there is no message", () => {
    expect(describeIpcError({ kind: "command" })).toBe("command");
  });

  it("returns the kind when the message is not a string", () => {
    expect(describeIpcError({ kind: "command", message: 42 })).toBe("command");
  });

  // ── rule 5 — the never-[object Object] safety net ──────────────────────
  it("never renders [object Object] for an empty object", () => {
    const out = describeIpcError({});
    expect(out).not.toBe("[object Object]");
    expect(typeof out).toBe("string");
  });

  it("falls through to String() for a non-string message and no kind", () => {
    expect(describeIpcError({ message: 42 })).toBe("unknown error");
  });

  it("returns String() for a number", () => {
    expect(describeIpcError(42)).toBe("42");
  });

  it("returns String() for null and undefined", () => {
    expect(describeIpcError(null)).toBe("null");
    expect(describeIpcError(undefined)).toBe("undefined");
  });

  it("renders an array without throwing", () => {
    expect(describeIpcError(["a", "b"])).toBe("a,b");
    expect(describeIpcError([])).toBe("");
  });

  it("renders an empty array without printing [object Object]", () => {
    expect(describeIpcError({ foo: {} })).not.toBe("[object Object]");
  });

  // ── hostile / absurd values: the function is documented as total ───────
  it("renders an object whose message is an inherited getter", () => {
    class NotAnError {
      get message(): string {
        return "from the getter";
      }
    }
    expect(describeIpcError(new NotAnError())).toBe("from the getter");
  });

  it("renders Object.create(null) as unknown error without throwing", () => {
    expect(() => describeIpcError(Object.create(null))).not.toThrow();
    expect(describeIpcError(Object.create(null))).toBe("unknown error");
  });

  it("renders { toString: null } as unknown error without throwing", () => {
    expect(() => describeIpcError({ toString: null })).not.toThrow();
    expect(describeIpcError({ toString: null })).toBe("unknown error");
  });

  it("renders a value with a throwing toString as unknown error", () => {
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(() => describeIpcError(hostile)).not.toThrow();
    expect(describeIpcError(hostile)).toBe("unknown error");
  });

  it("never returns [object Object] for any value", () => {
    const values: unknown[] = [
      "s",
      "",
      new Error("m"),
      {},
      { kind: "k" },
      { message: 42 },
      { message: {} },
      Object.create(null),
      { toString: null },
      null,
      undefined,
      0,
      Number.NaN,
      true,
      Symbol("sym") as unknown,
      () => 0,
      [],
      [{}],
      [{ a: 1 }],
      new Map(),
      new Date(0),
    ];
    for (const v of values) {
      expect(describeIpcError(v)).not.toBe("[object Object]");
      expect(typeof describeIpcError(v)).toBe("string");
    }
  });
});
