import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./tauri";
import { makeSessionRow } from "../test/fixtures";
import {
  sessionFieldOf,
  type SessionLookupSource,
} from "./sessionLookup";

/**
 * The three-list walk, in ONE place.
 *
 * These tests are written against a PLAIN object over the `useSessions` state
 * SHAPE — the real store is never imported here, because the whole reason the
 * walk is a free function and not a hook is that a component calls it INSIDE
 * its own selector (see the note on `SessionLookupSource`).
 *
 * What the file pins, in order of how each break would be noticed:
 *  1. every list is reachable (live / stored / ARCHIVED — missing the last is
 *     the bug where an archived session's context bar reads 0% and its
 *     selectors fall back to empty stubs),
 *  2. the ORDER live → history → archived, live winning over a stored row with
 *     the same id (a resume can move a session; the live row is current truth),
 *  3. the documented EMPTY case (`undefined`, and never a synthesized `null` or
 *     `[]` — `sessionConfig.ts` needs "nothing knows this id" to stay
 *     distinguishable from "config with zero options"),
 *  4. that the result is the FIELD and not the row, by REFERENCE — the
 *     invariant whose violation does not fail the suite but HANGS it (a
 *     selector yielding a fresh object re-runs forever under zustand v5).
 */

/** A `SessionLookupSource` from the shared fixtures — the lists are the only
 *  keys the walk reads, so nothing else is spelled here. */
const source = (
  over: Partial<SessionLookupSource> = {},
): SessionLookupSource => ({
  sessions: [],
  historySessions: [],
  archivedSessions: [],
  ...over,
});

/** One row per list, the same id, each carrying a distinguishable value for
 *  `key` so a wrong list is a visible wrong answer rather than a coincidence. */
const rowWith = (
  sessionId: string,
  field: Partial<SessionInfo>,
): SessionInfo => makeSessionRow({ sessionId, ...field });

describe("sessionFieldOf (the three-list walk, one owner)", () => {
  describe("each list is reachable", () => {
    it("reads `cwd` from the LIVE list", () => {
      const s = source({ sessions: [rowWith("s1", { cwd: "/live" })] });
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/live");
    });

    it("reads `cwd` from the STORED (history) list", () => {
      const s = source({
        historySessions: [rowWith("s1", { cwd: "/stored" })],
      });
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/stored");
    });

    it("reads `cwd` from the ARCHIVED list (a session opened from Archived)", () => {
      const s = source({
        archivedSessions: [rowWith("s1", { cwd: "/archived" })],
      });
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/archived");
    });

    it("reads `title` from each of the three lists", () => {
      expect(
        sessionFieldOf(
          source({ sessions: [rowWith("s1", { title: "Live title" })] }),
          "s1",
          "title",
        ),
      ).toBe("Live title");
      expect(
        sessionFieldOf(
          source({ historySessions: [rowWith("s1", { title: "Stored title" })] }),
          "s1",
          "title",
        ),
      ).toBe("Stored title");
      expect(
        sessionFieldOf(
          source({
            archivedSessions: [rowWith("s1", { title: "Archived title" })],
          }),
          "s1",
          "title",
        ),
      ).toBe("Archived title");
    });

    it("reads `configOptions` from each of the three lists", () => {
      for (const list of [
        "sessions",
        "historySessions",
        "archivedSessions",
      ] as const) {
        const options = [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: list,
            options: [],
          },
        ];
        const s = source({ [list]: [rowWith("s1", { configOptions: options })] });
        expect(sessionFieldOf(s, "s1", "configOptions")?.[0]?.currentValue).toBe(
          list,
        );
      }
    });

    it("reads `contextUsage` from the ARCHIVED list — the 0%-bar bug", () => {
      // The regression this exists to prevent: an archived session's context bar
      // read 0% and its selectors fell back to empty stubs, because the walk
      // stopped at `historySessions` and never reached `archivedSessions`.
      const usage = { used: 40, window: 100 };
      const s = source({
        archivedSessions: [rowWith("s1", { contextUsage: usage })],
      });
      expect(sessionFieldOf(s, "s1", "contextUsage")).toEqual(usage);
    });

    it("reads `capabilities` from the ARCHIVED list (a stored session's resume gate)", () => {
      // `ChatStream`'s `canResume` reads `capabilities.loadSession` off the
      // stored row: unreachable archived rows would disable the composer for an
      // archived-but-resumable session.
      const s = source({
        archivedSessions: [
          rowWith("s1", { capabilities: { loadSession: true } }),
        ],
      });
      expect(sessionFieldOf(s, "s1", "capabilities")).toEqual({
        loadSession: true,
      });
    });
  });

  describe("order is load-bearing: live → history → archived", () => {
    it("the LIVE row wins over a stored row with the same id", () => {
      // A resume can move a Session between Spaces; the live row is the truth.
      const s = source({
        sessions: [rowWith("s1", { cwd: "/live", title: "Live" })],
        historySessions: [rowWith("s1", { cwd: "/stored", title: "Stored" })],
        archivedSessions: [
          rowWith("s1", { cwd: "/archived", title: "Archived" }),
        ],
      });
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/live");
      expect(sessionFieldOf(s, "s1", "title")).toBe("Live");
    });

    it("the STORED row wins over an archived row with the same id", () => {
      const s = source({
        historySessions: [rowWith("s1", { cwd: "/stored" })],
        archivedSessions: [rowWith("s1", { cwd: "/archived" })],
      });
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/stored");
    });

    it("an earlier list that lacks the FIELD falls through to the next one", () => {
      // The walk is per-FIELD with `??`, exactly as the six call sites wrote it:
      // a live row with no `title` yet must not shadow a stored row's title.
      const s = source({
        sessions: [rowWith("s1", { cwd: "/live" })],
        historySessions: [rowWith("s1", { title: "Stored" })],
      });
      expect(sessionFieldOf(s, "s1", "title")).toBe("Stored");
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/live");
    });

    it("an explicit `null` title is a gap and falls through (it is not a value)", () => {
      // `SessionInfo.title` is `string | null | undefined`; `??` treats a stored
      // `null` as "no title here", which is what every one of the six walks did.
      const s = source({
        sessions: [rowWith("s1", { title: null })],
        historySessions: [rowWith("s1", { title: "Stored" })],
      });
      expect(sessionFieldOf(s, "s1", "title")).toBe("Stored");
    });

    it("an EMPTY `configOptions` array is a value and does NOT fall through", () => {
      // The `??` (not `||`) is load-bearing here: `[]` means "a config with zero
      // options", which the caller must keep distinguishable from "no config".
      const empty: SessionInfo["configOptions"] = [];
      const populated = [
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: "stored",
          options: [],
        },
      ];
      const s = source({
        sessions: [rowWith("s1", { configOptions: empty })],
        historySessions: [rowWith("s1", { configOptions: populated })],
      });
      const found = sessionFieldOf(s, "s1", "configOptions");
      expect(found).toBe(empty);
      expect(found).toHaveLength(0);
    });
  });

  describe("the documented empty case is `undefined`", () => {
    const all = source({
      sessions: [rowWith("other", { cwd: "/live" })],
      historySessions: [rowWith("other", { cwd: "/stored" })],
    });

    it("is `undefined` for an id no list knows", () => {
      expect(sessionFieldOf(all, "s1", "cwd")).toBeUndefined();
      expect(sessionFieldOf(all, "s1", "title")).toBeUndefined();
      expect(sessionFieldOf(all, "s1", "configOptions")).toBeUndefined();
      expect(sessionFieldOf(all, "s1", "contextUsage")).toBeUndefined();
    });

    it("is `undefined` for a `null` id (no active session), without reading the lists", () => {
      // Every call site guards on `activeSessionId`; the walk does it too, so a
      // caller cannot accidentally match a row whose id is `null`.
      expect(sessionFieldOf(all, null, "cwd")).toBeUndefined();
      expect(sessionFieldOf(all, null, "title")).toBeUndefined();
      expect(sessionFieldOf(all, null, "configOptions")).toBeUndefined();
    });

    it("is `undefined` for an `undefined` id", () => {
      expect(sessionFieldOf(all, undefined, "cwd")).toBeUndefined();
    });

    it("is `undefined` for the empty string id (a guard, not a lookup)", () => {
      expect(sessionFieldOf(all, "", "cwd")).toBeUndefined();
    });

    it("does NOT synthesize `null` or `[]` for the empty case", () => {
      // `sessionConfigOptionsOf` owns its own `?? null` tail precisely because
      // the walk must not decide what "missing" means for its caller.
      const missing = sessionFieldOf(source(), "s1", "configOptions");
      expect(missing).toBeUndefined();
      expect(missing).not.toBeNull();
      expect(Array.isArray(missing)).toBe(false);
    });
  });

  describe("returns the FIELD, never the row (the hang-the-suite invariant)", () => {
    /** A row whose object fields the assertions can compare BY REFERENCE. */
    const usage = { used: 10, window: 100 };
    const options = [
      {
        id: "model",
        name: "Model",
        type: "select" as const,
        currentValue: "gpt-5",
        options: [],
      },
    ];
    const capabilities = { loadSession: true };
    const live = rowWith("s1", {
      cwd: "/live",
      title: "Live",
      contextUsage: usage,
      configOptions: options,
      capabilities,
    });
    const s = source({ sessions: [live] });

    it("a primitive field comes back as a primitive, not wrapped", () => {
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/live");
      expect(typeof sessionFieldOf(s, "s1", "cwd")).toBe("string");
      expect(typeof sessionFieldOf(s, "s1", "title")).toBe("string");
    });

    it("an object field IS the row's own field, not a copy and not the row", () => {
      // `toBe` is identity: a `{ … }` rebuilt per call (or the row itself) fails
      // here. That is the change that would not fail the suite but HANG it — a
      // zustand v5 selector yielding a fresh object re-runs on every snapshot
      // read — so the pin lives in a pure unit test instead.
      expect(sessionFieldOf(s, "s1", "contextUsage")).toBe(usage);
      expect(sessionFieldOf(s, "s1", "configOptions")).toBe(options);
      expect(sessionFieldOf(s, "s1", "capabilities")).toBe(capabilities);
      expect(sessionFieldOf(s, "s1", "contextUsage")).not.toBe(live);
    });

    it("is reference-STABLE across two calls for every object field", () => {
      // Two calls stand in for two snapshot reads of the same selector.
      for (const key of ["contextUsage", "configOptions", "capabilities"] as const) {
        expect(sessionFieldOf(s, "s1", key)).toBe(sessionFieldOf(s, "s1", key));
      }
    });

    it("is reference-stable for `sessionId` too (the presence test some caller uses)", () => {
      expect(sessionFieldOf(s, "s1", "sessionId")).toBe("s1");
    });
  });

  describe("the source's lists are the store's own arrays (structural typing)", () => {
    it("accepts full `SessionInfo` rows, so a caller passes `s.sessions` unchanged", () => {
      // The store types its lists `SessionInfo[]`; the walk's row type is a
      // `Pick` of it. This assignment is the compile-time half of that claim.
      const rows: SessionInfo[] = [makeSessionRow({ sessionId: "s1", cwd: "/x" })];
      const s: SessionLookupSource = source({ sessions: rows });
      expect(sessionFieldOf(s, "s1", "cwd")).toBe("/x");
    });
  });
});
