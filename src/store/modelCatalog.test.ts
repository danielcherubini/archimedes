import { describe, expect, it, vi, beforeEach } from "vitest";

import { useModelCatalog } from "./modelCatalog";
import { listModels, type ModelDto } from "../lib/tauri";

// The SPREAD form (`vi.importActual`) — the shape 34 of the 35 barrel mockers
// use, per `lib/tauriBarrel.test.ts`: it keeps every unlisted barrel export
// resolving, so this file's two names cannot break a future import added here.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return { ...actual, listModels: vi.fn() };
});

const dto = (id: string, provider: string, contextWindow: number): ModelDto => ({
  id,
  provider,
  contextWindow,
  supportsThinking: false,
  thinkingLevels: [],
});

describe("useModelCatalog", () => {
  beforeEach(() => {
    useModelCatalog.setState({ models: [], loadStarted: false, loadedOk: false });
    vi.mocked(listModels).mockReset();
  });

  it("loads the catalog once and stores it", async () => {
    vi.mocked(listModels).mockResolvedValue([dto("m1", "p", 1000)]);
    await useModelCatalog.getState().loadModels();
    expect(useModelCatalog.getState().models).toEqual([dto("m1", "p", 1000)]);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("shares ONE in-flight fetch across concurrent callers", async () => {
    // The real boot path mounts the sidebar and the settings page independently;
    // a per-caller fetch would mean two `list_models` round trips (and two
    // provider discovery passes) for the same data.
    let release: (v: ModelDto[]) => void = () => {};
    vi.mocked(listModels).mockReturnValue(
      new Promise<ModelDto[]>((resolve) => {
        release = resolve;
      }),
    );
    const a = useModelCatalog.getState().loadModels();
    const b = useModelCatalog.getState().loadModels();
    release([dto("m1", "p", 1000)]);
    await Promise.all([a, b]);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(useModelCatalog.getState().models).toEqual([dto("m1", "p", 1000)]);
  });

  it("does not re-fetch once loaded, unless forced", async () => {
    vi.mocked(listModels).mockResolvedValue([dto("m1", "p", 1000)]);
    await useModelCatalog.getState().loadModels();
    await useModelCatalog.getState().loadModels();
    expect(listModels).toHaveBeenCalledTimes(1);
    // `forceRefresh` is the Settings refresh path — a corrected window must be
    // able to replace what is stored (#85).
    vi.mocked(listModels).mockResolvedValue([dto("m1", "p", 1_000_000)]);
    await useModelCatalog.getState().loadModels("litellm");
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(listModels).toHaveBeenLastCalledWith("litellm");
    expect(useModelCatalog.getState().models).toEqual([
      dto("m1", "p", 1_000_000),
    ]);
  });

  it("a failed load leaves the previous catalog in place and allows a retry", async () => {
    vi.mocked(listModels).mockResolvedValue([dto("m1", "p", 1000)]);
    await useModelCatalog.getState().loadModels();
    vi.mocked(listModels).mockRejectedValue(new Error("unreachable"));
    await useModelCatalog.getState().loadModels("p");
    // The good data survives (a failed refresh must not blank the card's %).
    expect(useModelCatalog.getState().models).toEqual([dto("m1", "p", 1000)]);
    // A PLAIN read does not retry — the catalog it holds is still valid, and
    // re-fetching on every call is what the `loadedOk` guard exists to prevent.
    await useModelCatalog.getState().loadModels();
    expect(listModels).toHaveBeenCalledTimes(2);
    // A REFRESH does retry — the failure is not sticky, and that is the path
    // the user's button takes when the endpoint comes back.
    vi.mocked(listModels).mockResolvedValue([dto("m1", "p", 2000)]);
    await useModelCatalog.getState().loadModels("p");
    expect(useModelCatalog.getState().models).toEqual([dto("m1", "p", 2000)]);
  });
});
