import { describe, expect, it } from "vitest";
import {
  activityFromKey,
  activityKeyOf,
  lastActivityOf,
  sortByActivity,
} from "./sessionActivity";
import { makeMessage } from "../test/fixtures";

const user = (text: string, at: number) => makeMessage("user", { text, at });
const agent = (text: string, at: number) =>
  makeMessage("agent-text", { text, at });

describe("lastActivityOf (a transcript's last activity, in ms)", () => {
  it("reads the LAST message's stamp", () => {
    expect(lastActivityOf([user("a", 100), agent("b", 900)])).toBe(900);
  });

  it("is null for an absent or empty transcript (never a fake 0)", () => {
    expect(lastActivityOf(undefined)).toBeNull();
    expect(lastActivityOf([])).toBeNull();
  });
});

describe("sortByActivity (most recently active first)", () => {
  const activity: Record<string, number | null> = {
    a: 100,
    b: 300,
    c: null,
    d: 200,
  };

  it("orders known activity descending", () => {
    expect(sortByActivity(["a", "b", "d"], activity)).toEqual(["b", "d", "a"]);
  });

  it("is stable for a tie", () => {
    const tie = { a: 5, b: 5 };
    expect(sortByActivity(["a", "b"], tie)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const ids = ["a", "b"];
    sortByActivity(ids, activity);
    expect(ids).toEqual(["a", "b"]);
  });

  it("returns an empty list for no ids", () => {
    expect(sortByActivity([], activity)).toEqual([]);
  });

  describe("unknowns: 'last' — for a group where no evidence means least relevant", () => {
    it("puts unknown activity LAST, in its input order", () => {
      // `c` has no evidence. It must not float above a session we KNOW was
      // used, and the unknowns keep the server's order among themselves.
      expect(sortByActivity(["c", "a", "d"], activity, "last")).toEqual([
        "d",
        "a",
        "c",
      ]);
      expect(sortByActivity(["c", "e"], activity, "last")).toEqual(["c", "e"]);
    });
  });

  describe("unknowns: 'first' — for the LIVE group, where it means brand new", () => {
    it("puts unknown activity FIRST, in its input order", () => {
      // A LIVE session with no loaded transcript is a session that was just
      // started (`addSession` gives it an empty transcript): the newest
      // activity there is. Sorting it below a session idle for an hour — which
      // 'last' would do — would push the session the user just created to the
      // bottom of the list.
      expect(sortByActivity(["a", "c", "d"], activity, "first")).toEqual([
        "c",
        "d",
        "a",
      ]);
      expect(sortByActivity(["c", "e"], activity, "first")).toEqual(["c", "e"]);
    });
  });

  it("defaults to 'first' (the live group is the one that sorts in the frontend)", () => {
    expect(sortByActivity(["c", "a"], activity)).toEqual(["c", "a"]);
  });
});

describe("activityKeyOf / activityFromKey (the subscription round-trip)", () => {
  const messages = {
    a: [user("hi", 100)],
    b: [user("old", 50), agent("answer", 60)],
  };

  it("round-trips every id's last activity", () => {
    expect(activityFromKey(activityKeyOf(["a", "b", "z"], messages))).toEqual({
      a: 100,
      b: 60,
      z: null,
    });
  });

  it("round-trips an empty id list", () => {
    expect(activityFromKey(activityKeyOf([], messages))).toEqual({});
  });

  it("is the SAME key while no session's last activity changes", () => {
    // The streaming case, and the reason the key exists at all: a chunk
    // APPENDS to the trailing message (same `at`) or grows a session that is
    // not in this list. Subscribing to the `messages` MAP for that would
    // re-render — and re-sort — the session list on every streamed token,
    // because growing a message replaces the array; this key does not move.
    const grewInPlace = { a: [user("hi there", 100)], b: messages.b };
    const untouched = {
      a: messages.a,
      b: messages.b,
      c: [user("a third session", 1)],
    };
    expect(activityKeyOf(["a", "b"], grewInPlace)).toBe(
      activityKeyOf(["a", "b"], messages),
    );
    expect(activityKeyOf(["a", "b"], untouched)).toBe(
      activityKeyOf(["a", "b"], messages),
    );
  });

  it("changes when a session gains a message", () => {
    const appended = { a: [user("hi", 100), agent("yo", 111)], b: messages.b };
    expect(activityKeyOf(["a", "b"], appended)).not.toBe(
      activityKeyOf(["a", "b"], messages),
    );
  });

  it("changes when a session's transcript appears or disappears", () => {
    expect(activityKeyOf(["a"], messages)).not.toBe(activityKeyOf(["a"], {}));
  });

  it("names the ids it covers: a different id list is a different key", () => {
    expect(activityKeyOf(["a"], messages)).not.toBe(activityKeyOf(["b"], messages));
    expect(activityKeyOf(["a", "b"], messages)).not.toBe(
      activityKeyOf(["b", "a"], messages),
    );
  });

  it("survives an id that contains the field separator", () => {
    // Session ids are UUIDs in practice, but a mis-parse would silently sort
    // the whole list on garbage, so the id is read back as everything BEFORE
    // the last two fields rather than as "field 0".
    const odd = { "sp:ace/9": [user("x", 777)] };
    const key = activityKeyOf(["sp:ace/9"], odd);
    expect(activityFromKey(key)).toEqual({ "sp:ace/9": 777 });
  });
});
