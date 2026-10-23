import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSettings,
  saveSettings,
  type AgentOverrides,
  type AppSettings,
} from "../lib/tauri";
import { clearAgentCatalogCache } from "./useAgentCatalog";
import { useSettings } from "../store/settings";
import { makeSettings } from "../test/fixtures";
import { resetStores } from "../test/resetStores";
import { useAgentOverridesWrites } from "./useAgentOverridesWrites";

/**
 * The SECOND owner of the settings document (finding 13a — the one the audit
 * missed: it filed only `SettingsPage`). The sidebar Agents modal's
 * `agentOverrides` write chain, which `SpacesList.tsx` used to hold inline (its
 * `writeAgentOverrides` helper, its `patchAgentOverrides`, and the epoch/rollback
 * ordering between them) and which it now calls from here.
 *
 * This is a DIFFERENT contract from `useSettingsDocument`, and the tests below are
 * exactly the reasons it could not share that hook:
 *  - it is a READ-MODIFY-WRITE of the FILE, not a compose over the store (Rust
 *    writes `settings.json` itself, so composing from the store clobbers a
 *    concurrent change);
 *  - it publishes an OPTIMISTIC map to the store synchronously, before any await;
 *  - it SERIALIZES its saves on a held promise;
 *  - it guards the store mirror with a publish EPOCH, checked at COMMIT in both
 *    arms;
 *  - on failure it ROLLS BACK by re-fetching the file and re-seeding the store —
 *    detached, so a hung read cannot strand the chain.
 *
 * Every assertion here is a behaviour `SpacesList.test.tsx` already pinned through
 * the modal; what moves is the ability to drive the ordering deterministically,
 * with no dialog in the way. The component tests run unmodified as the migration's
 * behaviour-preservation proof.
 *
 * THE MOCK DISCIPLINE THIS FILE USES, and why it is not the usual
 * `mockResolvedValueOnce`: an unconsumed `*Once` entry SURVIVES
 * `vi.clearAllMocks()`, and this hook's write chain keeps running after a test
 * ends (that is what "detached" means), so a later link from an earlier test can
 * consume a `*Once` meant for a later one — a failure that passes in isolation and
 * reddens in a full file. Every test therefore installs a whole
 * `mockImplementation` (no once queue to leak) through the `readsTheFile` /
 * `writesTheFile` helpers below, and the store assertions that could be raced by a
 * leaked link are taken SYNCHRONOUSLY. Verified: `vi.clearAllMocks()` leaves the
 * once queue in place (a probe test that set one and never consumed it reddened the
 * NEXT test with `Caused by: leak`).
 */

vi.mock("../lib/tauri", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  };
});

// The eviction is the chain's own observable side effect; the real catalog cache is
// not needed to prove WHEN it runs.
vi.mock("./useAgentCatalog", () => ({
  clearAgentCatalogCache: vi.fn(),
  useAgentCatalog: () => [],
}));

const mockedGetSettings = vi.mocked(getSettings);
const mockedSaveSettings = vi.mocked(saveSettings);
const mockedClearCache = vi.mocked(clearAgentCatalogCache);

/** A file document, distinct from the store seed so "composed from the file, not
 * from the store" is observable. */
function fileDoc(overrides: Partial<AppSettings> = {}): AppSettings {
  return makeSettings({ defaultModel: "fresh/model", ...overrides });
}

/** Resolve on command, so "in flight" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  promise.catch(() => {});
  return { promise, resolve };
}

/** The store seed the modal renders against — deliberately STALE. */
const STORE_SEED = makeSettings({ defaultModel: "stale/model" });

const SCOUT_MODEL: AgentOverrides = { scout: { model: "tama/Qwen3.8" } };
const SCOUT_THINKING: AgentOverrides = { scout: { thinking: "high" } };

/** Install what `getSettings` answers (a fresh file document by default). */
function readsTheFile(
  impl: (call: number) => Promise<AppSettings> | AppSettings,
): void {
  let call = 0;
  // `async` so a helper author may return a bare value: `mockImplementation` is
  // typed against the real signature (`Promise<AppSettings>`), and the async
  // wrapper is what makes a sync `impl` legal without a cast.
  mockedGetSettings.mockImplementation(async () => impl(call++));
}

/** Install what `saveSettings` does (a successful write by default). */
function writesTheFile(
  impl: (doc: AppSettings, call: number) => Promise<void> | void,
): void {
  let call = 0;
  mockedSaveSettings.mockImplementation(async (doc) => {
    await impl(doc, call++);
  });
}

/** Mount with the store seeded (the modal only renders with a document). */
function mounted(seed: AppSettings = STORE_SEED) {
  useSettings.getState().setSettings(seed);
  return renderHook(() => useAgentOverridesWrites());
}

/** Let the chain's held-promise hops run (`.catch().then()` is two microtasks). */
async function drain(hops = 6): Promise<void> {
  for (let i = 0; i < hops; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetStores();
  vi.clearAllMocks();
  mockedClearCache.mockImplementation(() => undefined);
  readsTheFile(() => fileDoc());
  writesTheFile(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("useAgentOverridesWrites — one patch", () => {
  it("publishes the map to the store SYNCHRONOUSLY, before any await", async () => {
    // The optimistic publish is what makes the modal's NEXT edit compose on this
    // one instead of on a snapshot that predates it — so it happens before the
    // read, not after the save.
    const read = deferred<AppSettings>();
    let answered = false;
    readsTheFile(() => {
      answered = true;
      return read.promise;
    });
    const { result } = mounted();

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });

    // The publish is synchronous — observable in the same tick as the call.
    expect(useSettings.getState().settings?.agentOverrides).toEqual(SCOUT_MODEL);
    // …and the file read has not even started (the chain runs on a held promise).
    expect(answered).toBe(false);
    expect(mockedSaveSettings).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(fileDoc());
      await drain();
    });
    expect(answered).toBe(true);
  });

  it("saves the WHOLE file document with the map replaced (read-modify-write, never the store's copy)", async () => {
    const fresh = fileDoc({ agentOverrides: { plan: { thinking: "high" } } });
    readsTheFile(() => fresh);
    const { result } = mounted();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_MODEL);
    });

    // The read happened before the write.
    expect(mockedGetSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSaveSettings.mock.invocationCallOrder[0],
    );
    // Every field other than the map is the FRESH document's; the store's stale
    // `defaultModel` must not appear anywhere.
    expect(mockedSaveSettings).toHaveBeenCalledWith({
      ...fresh,
      agentOverrides: SCOUT_MODEL,
    });
    const saved = mockedSaveSettings.mock.calls[0][0];
    expect(saved.defaultModel).toBe("fresh/model");
    expect(JSON.stringify(saved)).not.toContain("stale/model");
    // The map is replaced WHOLESALE — no field-level merge (ADR 0067: an absent
    // field is both "just cleared" and "never set", so merging resurrects a clear).
    expect(saved.agentOverrides.plan).toBeUndefined();
    // And the store agrees with the file.
    expect(useSettings.getState().settings).toEqual({
      ...fresh,
      agentOverrides: SCOUT_MODEL,
    });
  });

  it("evicts the Agent catalog AFTER the save lands, then publishes", async () => {
    const order: string[] = [];
    readsTheFile(async () => {
      order.push("read");
      return fileDoc();
    });
    writesTheFile(async () => {
      order.push("save");
    });
    mockedClearCache.mockImplementation(() => {
      order.push("evict");
    });
    const { result } = mounted();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_MODEL);
    });

    expect(order).toEqual(["read", "save", "evict"]);
  });

  it("publishes NOTHING when there is no document to publish into", () => {
    // Taken synchronously on purpose: the epoch still counts (one count per patch
    // the user COMMITS, whether or not it reaches the store mirror), and the link
    // still runs — the file write composes from the FILE, not from the store.
    useSettings.setState({ settings: null });
    const { result } = renderHook(() => useAgentOverridesWrites());
    expect(result.current.settings).toBeNull();

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });

    expect(useSettings.getState().settings).toBeNull();
  });
});

describe("useAgentOverridesWrites — serialization + the publish epoch", () => {
  it("serializes the saves: the second write starts only after the first settles", async () => {
    const first = deferred<void>();
    const order: string[] = [];
    writesTheFile(async (_doc, call) => {
      order.push(`save-${call + 1}`);
      if (call === 0) await first.promise;
    });
    const { result } = mounted();

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });
    await act(async () => {
      await drain();
    });
    expect(order).toEqual(["save-1"]);

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_THINKING);
    });
    // Drained, and STILL only one save: the second link waits on the held promise.
    // (Draining here is what makes this assertion bite — without it the mutation
    // "run every link immediately" also shows one save, because no microtask has
    // had a chance to start the second.)
    await act(async () => {
      await drain();
    });
    expect(order).toEqual(["save-1"]);

    await act(async () => {
      first.resolve();
      await drain();
    });
    expect(order).toEqual(["save-1", "save-2"]);
  });

  it("an older link finishing after a newer publish does NOT repaint the store", async () => {
    // The flicker bug: each link mirrors the store with ITS OWN snapshot, so a link
    // for edit A finishing after edit B was published hands the store the
    // {A}-only map and B visibly reverts.
    //
    // Link B's own save is held open on purpose. If it were allowed to complete it
    // would publish B's fresh document LAST and mask a missing epoch guard — the
    // first version of this test did exactly that and stayed green against the
    // mutation "delete the success-path `isStale()` check". With B's save parked,
    // the ONLY thing that can write the store after A lands is A's own publish, so
    // the assertion discriminates.
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    writesTheFile(async (_doc, call) => {
      if (call === 0) await firstSave.promise;
      else await secondSave.promise;
    });
    const { result } = mounted();

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });
    await act(async () => {
      await drain();
    });
    act(() => {
      void result.current.patchAgentOverrides(SCOUT_THINKING);
    });
    await act(async () => {
      await drain();
    });
    // Edit B's optimistic publish owns the store now.
    expect(useSettings.getState().settings?.agentOverrides).toEqual(
      SCOUT_THINKING,
    );

    await act(async () => {
      firstSave.resolve();
      await drain();
    });
    // Link A landed its (older) map in the FILE — that ordering is the queue's job —
    // but it must not publish the store behind edit B.
    expect(mockedSaveSettings).toHaveBeenCalledTimes(2);
    expect(useSettings.getState().settings?.agentOverrides).toEqual(
      SCOUT_THINKING,
    );
    secondSave.resolve();
  });

  it("a stale link STILL evicts the catalog (eviction answers 'the file changed')", async () => {
    const firstSave = deferred<void>();
    writesTheFile(async (_doc, call) => {
      if (call === 0) await firstSave.promise;
    });
    const { result } = mounted();
    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });
    await act(async () => {
      await drain();
    });
    act(() => {
      void result.current.patchAgentOverrides(SCOUT_THINKING);
    });
    await act(async () => {
      firstSave.resolve();
      await drain();
    });
    // Two links ran, so the cache was evicted for both — including the stale one.
    expect(mockedSaveSettings).toHaveBeenCalledTimes(2);
    expect(mockedClearCache).toHaveBeenCalledTimes(2);
  });
});

describe("useAgentOverridesWrites — failure, rollback, and the chain staying alive", () => {
  it("logs the save failure and re-seeds the store from the FILE (the rollback)", async () => {
    const reseeded = fileDoc({ agentOverrides: { plan: { model: "old" } } });
    writesTheFile(() => {
      throw "save failed";
    });
    // Call 0 is the link's own read, call 1 is the rollback's re-read.
    readsTheFile((call) => (call === 0 ? fileDoc() : reseeded));
    const { result } = mounted();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_MODEL);
      await drain();
    });

    expect(console.error).toHaveBeenCalledWith(
      "Failed to save agent overrides:",
      "save failed",
    );
    // The optimistic publish is rolled back: the store holds the FILE's map.
    expect(useSettings.getState().settings).toEqual(reseeded);
    expect(result.current.rolledBackWrites).toBe(1);
    // A save that did not land did not change the file, so the catalog stands.
    expect(mockedClearCache).not.toHaveBeenCalled();
  });

  it("counts each rolled-back write (a counter, not a boolean — a second failure still reads as a change)", async () => {
    writesTheFile(() => {
      throw "save failed";
    });
    const { result } = mounted();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_MODEL);
      await drain();
    });
    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_THINKING);
      await drain();
    });

    expect(result.current.rolledBackWrites).toBe(2);
  });

  it("a rollback whose re-read lands after a newer publish is DISCARDED at commit", async () => {
    // The commit-time epoch check on the FAILURE arm. The rollback's publish is a
    // `getSettings` round trip, so a start-time check says nothing about who owns
    // the store when the read answers: publishing the file's OLDER map here would
    // leave the store permanently behind the file, and the next patch would compose
    // from that mirror and delete fields the file still holds.
    const reseed = deferred<AppSettings>();
    writesTheFile((_doc, call) => {
      // Link 1's save fails (that is the rollback's trigger); link 2 succeeds.
      if (call === 0) throw "save failed";
    });
    readsTheFile((call) =>
      // 0: link 1's read. 1: the rollback's re-read (held open). 2: link 2's read.
      call === 1 ? reseed.promise : fileDoc(),
    );
    const { result } = mounted();

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });
    await act(async () => {
      await drain();
    });
    // A newer edit publishes while the rollback's read is in flight.
    act(() => {
      void result.current.patchAgentOverrides(SCOUT_THINKING);
    });
    await act(async () => {
      reseed.resolve(fileDoc({ agentOverrides: { plan: { model: "older" } } }));
      await drain(12);
    });

    // The stale re-seed published NOTHING — the store keeps edit B's map.
    expect(useSettings.getState().settings?.agentOverrides).toEqual(
      SCOUT_THINKING,
    );
    // …and reported nothing: for a stale link NOTHING was rolled back, so the
    // modal's stored-pin suppression survives.
    expect(result.current.rolledBackWrites).toBe(0);
  });

  it("a failed link does not strand the next write (the chain never carries a rejection)", async () => {
    let failures = 0;
    writesTheFile(() => {
      failures += 1;
      if (failures === 1) throw "save failed";
    });
    const { result } = mounted();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_MODEL);
      await drain();
    });
    mockedSaveSettings.mockClear();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_THINKING);
    });

    expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("a THROWING failure logger does not poison the chain", async () => {
    // The swallow is structural: an error handler that can itself throw used to
    // leave the held promise rejected and silently disable every later write.
    let logged = 0;
    vi.mocked(console).error = vi.fn(() => {
      logged += 1;
      if (logged === 1) throw new Error("logger exploded");
    });
    writesTheFile(() => {
      throw "save failed";
    });
    const { result } = mounted();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_MODEL);
      await drain(10);
    });
    mockedSaveSettings.mockClear();

    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_THINKING);
      await drain();
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("a hung rollback re-read does not block the next write (the rollback is detached)", async () => {
    const hung = deferred<AppSettings>();
    writesTheFile((_doc, call) => {
      if (call === 0) throw "save failed";
    });
    readsTheFile((call) => (call === 1 ? hung.promise : fileDoc()));
    const { result } = mounted();

    act(() => {
      void result.current.patchAgentOverrides(SCOUT_MODEL);
    });
    await act(async () => {
      await drain();
    });
    mockedSaveSettings.mockClear();

    // The next edit runs while the rollback's read is still outstanding.
    await act(async () => {
      await result.current.patchAgentOverrides(SCOUT_THINKING);
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
    hung.resolve(fileDoc());
  });

  it("patchAgentOverrides never rejects, even when the save fails", async () => {
    // The call site `void`s the result and the mount has nowhere to attach a
    // handler, so a rejection here is an unhandled rejection in the webview.
    writesTheFile(() => {
      throw "save failed";
    });
    const { result } = mounted();
    let settled = "pending";
    await act(async () => {
      result.current
        .patchAgentOverrides(SCOUT_MODEL)
        .then(() => {
          settled = "resolved";
        })
        .catch(() => {
          settled = "rejected";
        });
      await drain();
    });
    expect(settled).toBe("resolved");
  });
});

describe("useAgentOverridesWrites — the document it exposes", () => {
  it("reads the store (the modal's render gate needs the document)", () => {
    const seed = makeSettings();
    const { result } = mounted(seed);
    expect(result.current.settings).toBe(seed);
  });

  it("re-renders when another owner publishes the document", () => {
    const { result } = mounted();
    act(() => {
      useSettings.getState().setSettings(makeSettings({ theme: "light" }));
    });
    expect(result.current.settings?.theme).toBe("light");
  });
});
