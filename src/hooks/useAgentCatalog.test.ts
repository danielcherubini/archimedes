import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentConfig, type AgentConfigDto } from "../lib/tauri";
import {
  clearAgentCatalogCache,
  useAgentCatalog,
} from "./useAgentCatalog";

// The wrapper is the mock (the SAME style as `useSkillCatalog.test.ts` — the
// hook is the unit under test, so the IPC boundary is the only thing faked).
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // The row is INLINED rather than built by `row()` below: the mock factory is
    // hoisted above this file's imports and runs while they are being
    // evaluated, so relying on a hoisted function declaration here would be a
    // temporal-dead-zone accident waiting to happen.
    listAgentConfig: vi.fn().mockResolvedValue([
      {
        name: "alpha",
        description: "Fast recon",
        scope: "space",
        path: "/p/.agents/agents/alpha.md",
        file: { model: null, thinking: null, tools: null, permission: null },
        override: { model: null, thinking: null, tools: null, permission: null },
        effective: { model: null, thinking: null, tools: null, permission: null },
        source: { model: "parent", thinking: "parent", tools: "parent", permission: "parent" },
        shadowed: [],
        // issue #101: the two new REQUIRED wire fields, at the empty value Rust
        // sends for a file that says nothing about permissions. This literal is
        // INLINED because the factory is hoisted — the `row()` builder below is
        // unreachable from here, so the defaults are repeated rather than shared.
        filePermission: null,
        frontmatterNotes: [],
      } satisfies AgentConfigDto,
    ]),
  };
});

/**
 * One `list_agent_config` row fixture (the local-factory pattern
 * `SkillsDialog.test.tsx` uses for `skill()` — expanding literals by hand in
 * nine places would make every test here read as noise).
 */
function row(overrides: Partial<AgentConfigDto> = {}): AgentConfigDto {
  return {
    name: "alpha",
    description: "Fast recon",
    scope: "space",
    path: "/p/.agents/agents/alpha.md",
    file: { model: null, thinking: null, tools: null, permission: null },
    override: { model: null, thinking: null, tools: null, permission: null },
    effective: { model: null, thinking: null, tools: null, permission: null },
    source: { model: "parent", thinking: "parent", tools: "parent", permission: "parent" },
    shadowed: [],
    // issue #101: the two new REQUIRED fields at Rust's empty value (`null` for
    // the `Option` block, `[]` for the REQUIRED `Vec`) — the `shadowed: []`
    // precedent, so a default row renders no permission line.
    filePermission: null,
    frontmatterNotes: [],
    ...overrides,
  };
}

const mockedListAgentConfig = vi.mocked(listAgentConfig);

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentCatalogCache();
});

describe("useAgentCatalog", () => {
  it("two_simultaneous_consumers_share_one_fetch", async () => {
    // Two consumers with the same key mounted in the same commit share ONE
    // in-flight fetch (the cache stores the PROMISE, not the resolved rows —
    // a resolve-only cache would have both effects miss and issue two IPC
    // calls, which is the exact reason this hook copies that rule).
    const a = renderHook(() => useAgentCatalog("/tmp/alpha"));
    const b = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    await waitFor(() => expect(b.result.current).toHaveLength(1));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("different_spaces_fetch_separately", async () => {
    const a = renderHook(() => useAgentCatalog("/tmp/alpha"));
    const b = renderHook(() => useAgentCatalog("/tmp/beta"));
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    await waitFor(() => expect(b.result.current).toHaveLength(1));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(2);
  });

  it("a_second_consumer_mounted_after_resolve_does_not_refetch", async () => {
    const a = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    // The SETTLED cached promise is reused (an unchanged key does NOT evict —
    // a remount must not re-issue a network-bound discovery).
    const b = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(b.result.current).toHaveLength(1));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("the_null_key_fetches_app_scope_once", async () => {
    // No Space open: the key is `"__global__"` and the wrapper is called with
    // `null` (user-level definitions only — the documented rule).
    const a = renderHook(() => useAgentCatalog(null));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
    expect(mockedListAgentConfig).toHaveBeenCalledWith(null);
    a.unmount();
  });

  it("a_key_change_serves_empty_until_the_new_fetch_resolves", async () => {
    // Freshness hole (1). This matters MORE here than in `useSkillCatalog`:
    // `list_agent_config` runs `effective_catalog`, which does a per-provider
    // `GET /v1/models`, so the gap after a Space switch is a NETWORK round trip,
    // not a disk walk — the previous Space's rows would sit on screen for
    // seconds if the state did not track its key.
    const alpha = row({
      name: "alpha",
      path: "/p/.agents/agents/alpha.md",
    });
    const beta = row({
      name: "beta",
      path: "/q/.agents/agents/beta.md",
    });
    let resolveBeta!: (rows: AgentConfigDto[]) => void;
    const betaPromise = new Promise<AgentConfigDto[]>((resolve) => {
      resolveBeta = resolve;
    });
    // A stable `mockImplementation` (NOT a once-queue — `vi.clearAllMocks()`
    // does not clear the once-queue, so leftovers poison the next test).
    mockedListAgentConfig.mockImplementation((cwd) =>
      cwd === "/tmp/alpha"
        ? Promise.resolve([alpha])
        : Promise.resolve(betaPromise),
    );
    let spacePath: string | null = "/tmp/alpha";
    const a = renderHook(() => useAgentCatalog(spacePath));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    expect(a.result.current[0].name).toBe("alpha");
    // Switch the SAME consumer to space B: IMMEDIATELY (before the deferred
    // fetch resolves) the hook serves [] — NOT A's rows.
    spacePath = "/tmp/beta";
    a.rerender();
    expect(a.result.current).toEqual([]);
    await act(async () => {
      resolveBeta([beta]);
    });
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    expect(a.result.current[0].name).toBe("beta");
    a.unmount();
  });

  it("switching_spaces_back_refetches_the_first_space", async () => {
    // Freshness hole (2): the LEFT key is evicted on a key change, so an
    // agent file edited on disk (or a model whose catalog entry changed) is
    // picked up when you come back rather than served from a warm cache.
    mockedListAgentConfig.mockImplementation(() =>
      Promise.resolve([row({ name: "alpha" })]),
    );
    let spacePath: string | null = "/tmp/alpha";
    const a = renderHook(() => useAgentCatalog(spacePath));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
    spacePath = "/tmp/beta";
    a.rerender();
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
    spacePath = "/tmp/alpha";
    a.rerender();
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(3));
    expect(mockedListAgentConfig).toHaveBeenLastCalledWith("/tmp/alpha");
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    expect(a.result.current[0].name).toBe("alpha");
    a.unmount();
  });

  it("a_failed_fetch_degrades_to_empty_and_a_remount_retries", async () => {
    // A failed fetch degrades to [] (logged) and the FAILED promise is not left
    // cached, so a later consumer retries. More consequential here than for
    // Skills: a provider whose `GET /v1/models` times out must not leave the
    // modal permanently empty for the rest of the session.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    mockedListAgentConfig.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve([row({ name: "alpha" })]);
    });
    const a = renderHook(() => useAgentCatalog("/tmp/alpha"));
    expect(a.result.current).toEqual([]);
    await waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    const b = renderHook(() => useAgentCatalog("/tmp/alpha"));
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(b.result.current).toHaveLength(1));
    expect(b.result.current[0].name).toBe("alpha");
    a.unmount();
    b.unmount();
    errSpy.mockRestore();
  });

  it("a_failed_fetch_does_not_evict_a_fresh_entry_planted_by_clearAgentCatalogCache", async () => {
    // Identity guard: the old failure's eviction deletes the cache entry ONLY if
    // THIS promise is still the cached one — a fresh consumer's promise (planted
    // after the cache clear) must survive the old failure settling.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    mockedListAgentConfig.mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve([row({ name: "alpha" })]);
    });
    const a = renderHook(() => useAgentCatalog("/tmp/alpha")); // call 1 (fails)
    clearAgentCatalogCache(); // wipe the in-flight (failing) entry
    const b = renderHook(() => useAgentCatalog("/tmp/alpha")); // call 2 (succeeds)
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(errSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(b.result.current).toHaveLength(1));
    expect(b.result.current[0].name).toBe("alpha");
    expect(a.result.current).toEqual([]);
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(2);
    a.unmount();
    b.unmount();
    errSpy.mockRestore();
  });
});
