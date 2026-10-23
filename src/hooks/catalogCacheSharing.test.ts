import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentConfig, listSkills } from "../lib/tauri";
import { clearAgentCatalogCache, useAgentCatalog } from "./useAgentCatalog";
import { clearSkillCatalogCache, useSkillCatalog } from "./useSkillCatalog";
import * as catalogRow from "./useCatalogRow";

/**
 * Task C1 / finding 11c: the catalog cache has ONE implementation.
 *
 * `useSkillCatalog` and `useAgentCatalog` were a copy-paste pair — the plan
 * measured them as differing by 8 comment-stripped lines — and
 * `useMentionCatalogs.ts` already held the generalised machinery
 * (`useCatalogPayload`, plus `useCatalogRow`, the array-shaped wrapper that is
 * exactly the API both hooks need). Three copies of four load-bearing cache
 * rules is how one of them drifts.
 *
 * THE BEHAVIOURAL guard for all four rules is the pair of existing hook test
 * files — `useAgentCatalog.test.ts` (8 tests) and `useSkillCatalog.test.ts` (7) —
 * and both run UNMODIFIED as part of this task's gate. This file therefore pins
 * the one thing those files cannot see: that the logic now lives in one place.
 * It is a SOURCE scanner, the same shape as `lib/classNameConvention.test.ts`,
 * `lib/chromeButton.test.ts` and `lib/slabFloatSeparation.test.ts` — this repo
 * has no linter, so a convention with no enforcer is a convention that lapses.
 *
 * WHY A SEPARATE MODULE rather than an export from `useMentionCatalogs.ts`. The
 * plan allowed either. Exporting there would make `useSkillCatalog.ts` import
 * `useMentionCatalogs.ts` while that file already imports `useSkillCatalog` — a
 * cycle in the module graph, and this program has already spent a task (B3)
 * removing a store/lib cycle. Lifting the EXISTING function into its own file is
 * a move, not a new abstraction: there is still exactly one cache implementation
 * and no `useCatalogCache` anywhere.
 */

// The two IPC boundaries are the only fakes; the hooks and the shared cache are
// the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    listSkills: vi.fn().mockResolvedValue([]),
    listAgentConfig: vi.fn().mockResolvedValue([]),
  };
});

const NODE_FS = "node:" + "fs";
const { existsSync, readFileSync } = (await import(NODE_FS)) as {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
};

// `fileURLToPath` through the same computed-specifier idiom (no `@types/node`).
const NODE_URL = "node:" + "url";
const { fileURLToPath } = (await import(NODE_URL)) as {
  fileURLToPath: (url: string | URL) => string;
};

/**
 * Resolve a sibling module's path.
 *
 * `fileURLToPath`, NOT `URL#pathname`. The latter is a URL-path reader and it
 * keeps the leading slash of a Windows drive path: on a Windows runner
 * `new URL("./useSkillCatalog.ts", import.meta.url).pathname` is
 * `/D:/a/archimedes/archimedes/src/hooks/useSkillCatalog.ts`, and `readFileSync`
 * then reports `ENOENT … 'D:\D:\a\archimedes\…'` — the doubled drive letter is
 * Node resolving the leading slash against the current drive. `fileURLToPath`
 * is the function that actually converts a `file:` URL to a native path, and it
 * returns `/a/b` on POSIX and `D:\a\b` on Windows. (CI caught this; every local
 * run is POSIX, where the two agree.)
 */
function pathOf(file: string): string {
  return fileURLToPath(new URL(file, import.meta.url));
}

/** Read a sibling module's SOURCE (the scanner's subject). */
function sourceOf(file: string): string {
  return readFileSync(pathOf(file), "utf8");
}

/** Strip comments — these modules are deliberately the most heavily commented
 * files in `src/hooks/`, and each keeps its OWN doc-comment recording its own
 * reasoning (Skills is a local disk walk; Agents is a network-bound
 * `GET /v1/models` discovery). Only the LOGIC is shared, so a scanner that
 * counted prose would fail on the thing the task requires. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSkillCatalogCache();
  clearAgentCatalogCache();
});

describe("the catalog cache has one owner", () => {
  it("the shared array-shaped row hook is exported from useCatalogRow.ts", () => {
    expect(typeof catalogRow.useCatalogRow).toBe("function");
    // And it is the ONLY shape on offer: no second `useCatalogCache` module was
    // created beside it (the plan forbids a third abstraction).
    expect(
      existsSync(pathOf("./useCatalogCache.ts")),
    ).toBe(false);
  });

  it.each([
    ["useSkillCatalog.ts", "listSkills"],
    ["useAgentCatalog.ts", "listAgentConfig"],
  ])("%s holds NO cache logic of its own", (file) => {
    const code = codeOnly(sourceOf(`./${file}`));
    // The React machinery that implements the four cache rules is gone…
    for (const banned of [
      "useEffect(",
      "useRef(",
      "useState(",
      ".catch(",
      ".then(",
      "console.error(",
      "__global__",
    ]) {
      expect(code, `${file} should no longer contain ${banned}`).not.toContain(
        banned,
      );
    }
    // …and it delegates to the shared hook (the call is generic —
    // `useCatalogRow<SkillInfo>(…)` — so match either spelling).
    expect(code).toMatch(/useCatalogRow[<(]/);
    // Each catalog still owns its OWN cache Map (see the independence test
    // below): sharing the LOGIC must not mean sharing one Map.
    expect(code).toContain("new Map<");
  });

  it("all three consumers import the one shared hook", () => {
    for (const file of [
      "./useSkillCatalog.ts",
      "./useAgentCatalog.ts",
      "./useMentionCatalogs.ts",
    ]) {
      const src = sourceOf(file);
      expect(src, `${file} must import useCatalogRow`).toMatch(
        /import\s*\{[^}]*useCatalogRow[^}]*\}\s*from\s*"\.\/useCatalogRow"/,
      );
    }
  });

  it("useMentionCatalogs keeps its own catalogs on the hook it now imports", () => {
    // The extraction must not fork the machinery in favour of its birthplace:
    // the agents/mcp rows still go through the shared call.
    const code = codeOnly(sourceOf("./useMentionCatalogs.ts"));
    const calls = code.match(/useCatalogRow\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // And the definition moved out, so the file no longer holds a second copy.
    expect(code).not.toContain("function useCatalogRow");
    expect(code).not.toContain("function useCatalogPayload");
  });
});

describe("the two catalogs stay independent caches", () => {
  it("clearSkillCatalogCache does not evict the agent cache (and vice versa)", async () => {
    // Behaviour, not shape. `clearAgentCatalogCache` is invalidation-on-write
    // for the agent override map (`useAgentOverridesWrites`'s `writeAgentOverrides`,
    // reached from `SpacesList`'s Agents modal); if the
    // two catalogs shared one Map, saving an override would also throw away the
    // skill listing that `App` and `ChatStream` share, and the composer's `$`
    // mentions would go blank behind a keystroke.
    const mockedListSkills = vi.mocked(listSkills);
    const mockedListAgentConfig = vi.mocked(listAgentConfig);
    const skills = renderHook(() => useSkillCatalog("/tmp/alpha"));
    const agents = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(mockedListSkills).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(1));

    clearSkillCatalogCache();
    const skills2 = renderHook(() => useSkillCatalog("/tmp/alpha"));
    await waitFor(() => expect(mockedListSkills).toHaveBeenCalledTimes(2));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
    // The warm agent entry survived the skill clear — a new consumer is served
    // from the cache, no second fetch.
    const agents2 = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(agents2.result.current).toEqual([]));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);

    clearAgentCatalogCache();
    const agents3 = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
    expect(mockedListSkills).toHaveBeenCalledTimes(2);

    expect(skills.result.current).toEqual([]);
    expect(agents.result.current).toEqual([]);
    skills2.unmount();
    agents2.unmount();
    agents3.unmount();
  });
});
