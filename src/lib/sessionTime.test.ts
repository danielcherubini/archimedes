import { describe, expect, it } from "vitest";
import { relativeTimeFor } from "./sessionTime";
import { makeMessage } from "../test/fixtures";

const user = (text: string, at: number) => makeMessage("user", { text, at });
const agent = (text: string, at: number) =>
  makeMessage("agent-text", { text, at });

const NOW = 1_700_000_000_000;

describe("relativeTimeFor (ONE rule for a Session's relative last-activity label)", () => {
  it("is `now` under a minute", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 1000)], {}, NOW)).toBe("now");
    expect(relativeTimeFor("s1", [user("a", NOW - 59_999)], {}, NOW)).toBe("now");
  });

  it("is `Nm` under an hour", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 5 * 60_000)], {}, NOW)).toBe("5m");
    expect(relativeTimeFor("s1", [user("a", NOW - 59 * 60_000)], {}, NOW)).toBe("59m");
  });

  it("is `Nh` at or above an hour", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 60 * 60_000)], {}, NOW)).toBe("1h");
    expect(relativeTimeFor("s1", [user("a", NOW - 5 * 3_600_000)], {}, NOW)).toBe("5h");
  });

  it("boundary: exactly 60_000 ms leaves `now` for `1m`", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 60_000)], {}, NOW)).toBe("1m");
  });

  it("boundary: exactly 3_600_000 ms leaves `Nm` for `1h`", () => {
    expect(relativeTimeFor("s1", [user("a", NOW - 3_600_000)], {}, NOW)).toBe("1h");
  });

  it("prints the boot recency stamp when no transcript is loaded (the unified fallback)", () => {
    // THE ARM THE TWO MODULES USED TO DISAGREE ON. `recencyOf` (which
    // `sortByRecency` and the Landing pick order by) answered the boot
    // `sessionRecency` stamp here, while the DISPLAYED label rendered an empty
    // slot — the Archived list was ordered by a number its own rows refused to
    // print. `relativeTimeFor` now takes the same
    // `(sessionId, loadedMessages, recencyMap)` triple and delegates, so the
    // string is that one number bucketized: the map's stamp prints.
    // `SessionInfo` has NO `createdAt`, so the boot map is the only evidence a
    // stored row never opened this boot has — and it is evidence.
    expect(relativeTimeFor("s1", undefined, { s1: NOW - 5 * 60_000 }, NOW)).toBe("5m");
    expect(relativeTimeFor("s1", [], { s1: NOW - 5 * 60_000 }, NOW)).toBe("5m");
  });

  it("is null only when neither the transcript nor the map can prove recency", () => {
    // The surviving half of the unified rule, mirroring `recencyOf`'s own test
    // of the same name: the empty slot is NOT gone, it just moved — it now
    // means "no evidence on EITHER side", not "no transcript". REACHABLE, not
    // defensive: a Session that CLOSED this boot is appended to
    // `historySessions` by `handleSessionClosed` with no boot-map entry.
    expect(relativeTimeFor("ghost", undefined, {}, NOW)).toBeNull();
    expect(relativeTimeFor("ghost", [], {}, NOW)).toBeNull();
  });

  it("uses the LATEST (last) message, not the first", () => {
    expect(
      relativeTimeFor(
        "s1",
        [agent("old", NOW - 10 * 60_000), user("new", NOW - 30_000)],
        {},
        NOW,
      ),
    ).toBe("now");
    expect(
      relativeTimeFor(
        "s1",
        [user("new", NOW - 30_000), agent("old", NOW - 2 * 3_600_000)],
        {},
        NOW,
      ),
    ).toBe("2h");
  });
});
