import { describe, expect, it } from "vitest";
import { relativeTimeFor } from "./sessionTime";
import type { Message } from "../store/sessions";

const user = (text: string, at: number): Message => ({ kind: "user", text, at });
const agent = (text: string, at: number): Message => ({
  kind: "agent-text",
  messageId: "m1",
  text,
  at,
});

const NOW = 1_700_000_000_000;

describe("relativeTimeFor (ONE rule for a Session's relative last-activity label)", () => {
  it("is `now` under a minute", () => {
    expect(relativeTimeFor([user("a", NOW - 1000)], NOW)).toBe("now");
    expect(relativeTimeFor([user("a", NOW - 59_999)], NOW)).toBe("now");
  });

  it("is `Nm` under an hour", () => {
    expect(relativeTimeFor([user("a", NOW - 5 * 60_000)], NOW)).toBe("5m");
    expect(relativeTimeFor([user("a", NOW - 59 * 60_000)], NOW)).toBe("59m");
  });

  it("is `Nh` at or above an hour", () => {
    expect(relativeTimeFor([user("a", NOW - 60 * 60_000)], NOW)).toBe("1h");
    expect(relativeTimeFor([user("a", NOW - 5 * 3_600_000)], NOW)).toBe("5h");
  });

  it("boundary: exactly 60_000 ms leaves `now` for `1m`", () => {
    expect(relativeTimeFor([user("a", NOW - 60_000)], NOW)).toBe("1m");
  });

  it("boundary: exactly 3_600_000 ms leaves `Nm` for `1h`", () => {
    expect(relativeTimeFor([user("a", NOW - 3_600_000)], NOW)).toBe("1h");
  });

  it("is null when no transcript is loaded this boot (absent or empty)", () => {
    // `SessionInfo` has NO `createdAt`, so a stored row never opened this
    // boot has nothing to derive from — the row renders an empty slot.
    expect(relativeTimeFor(undefined, NOW)).toBeNull();
    expect(relativeTimeFor([], NOW)).toBeNull();
  });

  it("uses the LATEST (last) message, not the first", () => {
    expect(
      relativeTimeFor(
        [agent("old", NOW - 10 * 60_000), user("new", NOW - 30_000)],
        NOW,
      ),
    ).toBe("now");
    expect(
      relativeTimeFor(
        [user("new", NOW - 30_000), agent("old", NOW - 2 * 3_600_000)],
        NOW,
      ),
    ).toBe("2h");
  });
});
