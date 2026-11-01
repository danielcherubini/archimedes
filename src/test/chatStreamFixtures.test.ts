import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MONO_ADVANCE_EM,
  PERSISTED_MCP_MESSAGE,
  SETTINGS_FIXTURE,
  seedArchivedSession,
  seedLiveSession,
  seedLiveSessionWithImages,
  seedMcpMentionsOff,
  seedMcpMentionsOn,
  seedStoredSession,
} from "./chatStreamFixtures";
import { makeSessionRow, makeSettings, makeSpaceRow } from "./fixtures";
import { resetStores } from "./resetStores";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";

/**
 * The seam file for `src/test/chatStreamFixtures.ts` (issue #135 §5 "Split Test
 * Suite", task chatstream-decomposition-task02).
 *
 * Two purposes. (a) Pin the MOVED helpers' behaviour, so the extraction out of
 * `src/components/ChatStream.test.tsx` is provably MOVED-not-rewritten: each
 * seed is asserted against the REAL zustand stores, which is exactly the
 * dependency the fixtures module has. (b) Pin the load-bearing constraint —
 * a `vi.mock` CALL may never live in the fixture module (see the module header
 * there and the probe matrix in
 * `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`).
 *
 * This file deliberately does NOT `vi.mock` `../lib/tauri`: the seeds only
 * mutate stores, and `../lib/tauri` is a side-effect-free re-export barrel (no
 * top-level `invoke`), so importing the stores here costs nothing — the same
 * route `src/test/fixtures.test.ts` already takes.
 *
 * NOT covered here on purpose: `pasteToComposer`, `dropOnComposer`, `flush`,
 * `deferred` and `waitForCatalog`. Those need a rendered `ChatStream` and a
 * mocked `listSkills` to mean anything, and the component suite drives all of
 * them (~50 / ~8 / ~35 / ~14 / 19 call sites in
 * `src/components/ChatStream.test.tsx`); a fixture-level pin would duplicate
 * that coverage without the component that consumes them.
 */

// Node's `fs` through a COMPUTED specifier — this app ships no `@types/node`, so
// a bare `import "node:fs"` does not typecheck. The idiom
// `src/lib/tauriBarrel.test.ts` and `classNameConvention.test.ts` use.
const NODE_FS = "node:" + "fs";
const { readFileSync } = (await import(NODE_FS)) as {
  readFileSync: (path: string, encoding: string) => string;
};
describe("chatStreamFixtures (the moved ChatStream test scaffolding)", () => {
  // The seeds mutate the zustand singletons, so every test starts from the
  // state zustand captured at creation. `resetStores()` restores the whole
  // captured initial state (no-merge), which for `useSessions` INCLUDES
  // `compacting: {}` — that is what makes the "the seeded id is absent"
  // assertions below meaningful rather than vacuous.
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it("seedLiveSession writes the exact live-session state", () => {
    seedLiveSession();

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s1");
    expect(state.sessions).toEqual([
      makeSessionRow({ sessionId: "s1", cwd: "/home/u/proj" }),
    ]);
    expect(state.spaces).toEqual([
      makeSpaceRow({ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1 }),
    ]);
    expect(state.historySessions).toEqual([]);
    expect(state.messages).toEqual({ s1: [] });
    expect(state.inTurn).toEqual({});
    expect(state.stopReasons).toEqual({});
    expect(state.closeReasons).toEqual({});
    expect(state.configOptions).toEqual({});
    expect(state.compacting).toEqual({});
    // NON-VACUOUS: the initial state already carries `compacting: {}`, so a
    // dropped or renamed field would still satisfy `toEqual({})`. `Object.keys`
    // reddens on that.
    expect(Object.keys(state.compacting)).toEqual([]);
  });

  it("seedStoredSession writes the stored-session state (no compacting key)", () => {
    seedStoredSession({ loadSession: true });

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s1");
    expect(state.sessions).toEqual([]);
    expect(state.historySessions).toEqual([
      makeSessionRow({
        sessionId: "s1",
        cwd: "/home/u/proj",
        capabilities: { loadSession: true },
      }),
    ]);
    expect(state.compacting).toEqual({});
    // The absolute-absence tooth: the seeded id must be ABSENT from any
    // compaction bookkeeping, not merely coexist with an empty-looking map.
    expect(Object.keys(state.compacting)).toEqual([]);
  });

  it("seedArchivedSession writes the archived-session state", () => {
    seedArchivedSession({ loadSession: true });

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s9");
    expect(state.archivedSessions).toEqual([
      makeSessionRow({
        sessionId: "s9",
        cwd: "/home/u/arch",
        capabilities: { loadSession: true },
        archived: true,
      }),
    ]);
    expect(state.sessions).toEqual([]);
    expect(state.historySessions).toEqual([]);
    expect(state.messages).toEqual({ s9: [] });
  });

  it("seedLiveSessionWithImages writes the image-capable live session", () => {
    seedLiveSessionWithImages();

    const state = useSessions.getState();
    expect(state.activeSessionId).toBe("s1");
    expect(state.sessions).toEqual([
      makeSessionRow({
        sessionId: "s1",
        cwd: "/home/u/proj",
        capabilities: { promptCapabilities: { image: true } },
      }),
    ]);
    expect(state.sessions[0]?.capabilities).toEqual({
      promptCapabilities: { image: true },
    });
    expect(state.inTurn).toEqual({});
    expect(state.stopReasons).toEqual({});
    expect(state.closeReasons).toEqual({});
    expect(state.configOptions).toEqual({});
    expect(state.compacting).toEqual({});
    expect(Object.keys(state.compacting)).toEqual([]);
  });

  it("seedMcpMentionsOn and seedMcpMentionsOff write the settings store", () => {
    seedMcpMentionsOn();
    expect(useSettings.getState().settings?.mcpMentionsEnabled).toBe(true);

    seedMcpMentionsOff();
    expect(useSettings.getState().settings?.mcpMentionsEnabled).toBe(false);
  });

  it("pins MONO_ADVANCE_EM, SETTINGS_FIXTURE, PERSISTED_MCP_MESSAGE", () => {
    expect(MONO_ADVANCE_EM).toBe(0.6);
    // The drift pin: `AppSettings` has required fields, so a new one is a
    // compile error in `src/test/fixtures/settings.ts` rather than a silent
    // hole in this fixture.
    expect(SETTINGS_FIXTURE).toEqual(makeSettings());
    expect(PERSISTED_MCP_MESSAGE.startsWith("query #postgres\n\n")).toBe(true);
    expect(PERSISTED_MCP_MESSAGE).toContain('<mcp name="postgres">');
    expect(PERSISTED_MCP_MESSAGE).toContain("</mcp>");
  });

  it("the fixture module never calls vi.mock (the seam must live in the test file)", () => {
    // MECHANICAL pin of the load-bearing constraint. `vi.mock` hoists per
    // module, and this module has a transitive import path INTO the mocked
    // barrel (via `useSettings`/`useSessions`), so a factory delegated here
    // fails as 0 tests run with a `ReferenceError` pointing at an import line.
    // The regex is anchored to a line START, so the module header's prose
    // mentions of `vi.mock` (each on a ` * ` line) cannot trip it.
    //
    // Repo-relative path, cwd = repo root: the same convention
    // `src/lib/tauriBarrel.test.ts` reads its scanned sources with. (`import
    // .meta.url` is not usable here — under the jsdom environment it is an
    // `http://` URL, so `fileURLToPath` throws "The URL must be of scheme file".)
    const src = readFileSync("src/test/chatStreamFixtures.ts", "utf8");
    expect(/^\s*vi\.mock\(/m.test(src)).toBe(false);
  });
});
