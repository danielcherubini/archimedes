import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSettings, saveSettings, type AppSettings } from "../lib/tauri";
import { useSettings } from "../store/settings";
import { makeSettings } from "../test/fixtures";
import { resetStores } from "../test/resetStores";
import { useSettingsDocument } from "./useSettingsDocument";

/**
 * The ONE owner of the settings document for a component that holds and edits it
 * (finding 13a). Every assertion here is derived from what `SettingsPage` DID by
 * hand before this hook existed — its `useState` mirror (`:120`), its hand-rolled
 * mount fetch (`:152-157`), and its `update()` (`:219-229`: compose → local
 * setState → store mirror → `saveSettings` → theme-cleanup swap). The hook's
 * contract is that none of that observable ordering moves; what it retires is the
 * SECOND copy of the document, so the store is the single owner and the page reads
 * it like every other consumer does.
 *
 * The other owner surveyed for this design is `SpacesList.tsx` (the Agents modal:
 * `:333`, `:354`, `:596`, `:607` + its own epoch/rollback chain). It is served by
 * `useAgentOverridesWrites`, NOT by this hook — see that hook's file and the
 * "why two hooks" note below.
 */

vi.mock("../lib/tauri", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../lib/tauri");
  const { makeSettings } = await import("../test/fixtures/settings");
  return {
    ...actual,
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedGetSettings = vi.mocked(getSettings);
const mockedSaveSettings = vi.mocked(saveSettings);

/** A `matchMedia` stub that RECORDS the subscribe/unsubscribe calls, so the
 * theme-listener lifecycle is observable (jsdom's stub from `setup.tsx` is a
 * no-op object; `applySettingsTheme` only subscribes for `theme: "system"`). */
function recordMatchMedia(): {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
} {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return { addEventListener, removeEventListener };
}

beforeEach(() => {
  resetStores();
  mockedGetSettings.mockClear();
  mockedSaveSettings.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSettingsDocument — the load", () => {
  it("starts with NO document (a mount is not an instant answer)", () => {
    const { result } = renderHook(() => useSettingsDocument());
    expect(result.current.settings).toBeNull();
  });

  it("loads through the store's own loadSettings, so the store is the one owner", async () => {
    const doc = makeSettings({ theme: "light" });
    mockedGetSettings.mockResolvedValueOnce(doc);

    const { result } = renderHook(() => useSettingsDocument());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    // ONE fetch, and it is the STORE's loader (`store/settings.ts loadSettings`) —
    // the hand-rolled `getSettings().then(setSettings)` this hook replaced had zero
    // callers of `loadSettings`, leaving a dead loader beside a live fetch.
    expect(mockedGetSettings).toHaveBeenCalledTimes(1);
    // The store holds THE SAME OBJECT the hook returns — not a second copy. That
    // identity is the whole point of the extraction: one document, one owner.
    expect(result.current.settings).toBe(doc);
    expect(useSettings.getState().settings).toBe(doc);
    // `loadSettings` marks the attempt complete (success OR failure).
    expect(useSettings.getState().loaded).toBe(true);
  });

  it("a failed load leaves the document alone and marks the attempt (no throw out of the hook)", async () => {
    const error = new Error("backend down");
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockedGetSettings.mockRejectedValueOnce(error);

    const { result } = renderHook(() => useSettingsDocument());
    await waitFor(() => expect(useSettings.getState().loaded).toBe(true));

    expect(result.current.settings).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("re-fetches on EVERY mount (the boot seed is not the freshest answer)", async () => {
    const first = renderHook(() => useSettingsDocument());
    await waitFor(() =>
      expect(first.result.current.settings).not.toBeNull(),
    );
    first.unmount();
    renderHook(() => useSettingsDocument());
    await waitFor(() => expect(mockedGetSettings).toHaveBeenCalledTimes(2));
  });
});

describe("useSettingsDocument — patch (the immediate-save pattern)", () => {
  /** Mount and wait for the document to land. */
  async function mounted() {
    const view = renderHook(() => useSettingsDocument());
    await waitFor(() => expect(view.result.current.settings).not.toBeNull());
    return view;
  }

  it("composes the patch over the document, publishes the store, and saves the COMPLETE document", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.patch({ theme: "light" });
    });

    // ONE save, carrying the whole document (the immediate-save pattern has no
    // save button and no dirty state, so every save is a full write).
    expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
    const saved = mockedSaveSettings.mock.calls[0][0] as AppSettings;
    expect(saved.theme).toBe("light");
    // The untouched fields survive the compose (a patch is not a write).
    expect(saved).toEqual(
      expect.objectContaining({
        font: { sizePx: 14, uiFamily: null, codeFamily: null },
        providers: [],
        agentOverrides: {},
      }),
    );
    // The store mirror is the SAME object that was saved — the page and every
    // other consumer read one document.
    expect(useSettings.getState().settings).toBe(saved);
    expect(result.current.settings).toBe(saved);
  });

  it("applies the document to <html> (font custom property + theme class)", async () => {
    const { result } = await mounted();

    act(() => {
      result.current.patch({ font: { sizePx: 18, uiFamily: null, codeFamily: null } });
    });

    expect(
      document.documentElement.style.getPropertyValue("--ui-font-size"),
    ).toBe("18px");
  });

  it("does nothing before a document exists (no save of a half-built document)", async () => {
    mockedGetSettings.mockImplementationOnce(
      () => new Promise<AppSettings>(() => {}),
    );
    const { result } = renderHook(() => useSettingsDocument());
    expect(result.current.settings).toBeNull();

    act(() => {
      result.current.patch({ theme: "light" });
    });

    expect(mockedSaveSettings).not.toHaveBeenCalled();
    expect(useSettings.getState().settings).toBeNull();
  });

  it("never re-fetches on a patch (a save is not a reload)", async () => {
    const { result } = await mounted();
    const before = mockedGetSettings.mock.calls.length;
    act(() => {
      result.current.patch({ theme: "light" });
    });
    expect(mockedGetSettings).toHaveBeenCalledTimes(before);
  });

  it("two patches in ONE batch compose from the RENDERED document (a pinned non-improvement)", async () => {
    // `update()` read the rendered `settings`, so a second patch delivered in the
    // same batch composed from the PRE-first document and its save dropped the
    // first patch. A `getState()` read would be strictly better and is a BEHAVIOUR
    // CHANGE, so it is pinned as deliberately not taken (the same discipline
    // `useAsyncAction.test.ts` applies to its render-time guard).
    const { result } = await mounted();
    act(() => {
      result.current.patch({ theme: "light" });
      result.current.patch({ defaultModel: "tama/gpt" });
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(2);
    const second = mockedSaveSettings.mock.calls[1][0] as AppSettings;
    expect(second.defaultModel).toBe("tama/gpt");
    expect(second.theme).not.toBe("light");
  });
});

describe("useSettingsDocument — the theme listener lifecycle", () => {
  it("replaces (never stacks) the theme listener across patches", async () => {
    const media = recordMatchMedia();
    const { result } = renderHook(() => useSettingsDocument());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    act(() => {
      result.current.patch({ theme: "system" });
    });
    expect(media.addEventListener).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.patch({ theme: "system", palette: "dracula" });
    });
    // The previous listener is dropped BEFORE the new one is taken — discarding
    // that cleanup leaked one `matchMedia` listener per control change, which is
    // the reason the cleanup is held in a ref at all.
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
    expect(media.addEventListener).toHaveBeenCalledTimes(2);
  });

  it("unmount drops the live listener (no listener outlives the page)", async () => {
    const media = recordMatchMedia();
    const { result, unmount } = renderHook(() => useSettingsDocument());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    act(() => {
      result.current.patch({ theme: "system" });
    });
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    expect(media.removeEventListener).not.toHaveBeenCalled();

    unmount();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("useSettingsDocument — the owner rule (a source guard)", () => {
  /**
   * The finding is about there being TWO owners of one document, so the guard is
   * that the page no longer holds a mirror or writes the file itself. Written as a
   * source scan (the repo idiom — see `classNameConvention.test.ts`) with the
   * computed `node:` specifier `noEmit` + no `@types/node` requires.
   */
  const NODE_FS = "node:" + "fs";

  it("SettingsPage holds no second copy of the document and no hand-rolled load/save", async () => {
    const { readFileSync } = await import(NODE_FS);
    const source = String(
      readFileSync("src/components/settings/SettingsPage.tsx", "utf8"),
    );
    // No local mirror of the document.
    expect(source).not.toMatch(/useState<AppSettings\s*\|\s*null>/);
    // No hand-rolled document IPC (the hook owns the load and the save).
    expect(source).not.toMatch(/\bgetSettings\s*\(/);
    expect(source).not.toMatch(/\bsaveSettings\s*\(/);
    // No imperative store write from the page (it reads the store reactively now).
    expect(source).not.toMatch(/useSettings\.getState\(\)/);
    // And the theme-listener ref moved with the pattern that needs it.
    expect(source).not.toMatch(/applySettingsToDocument/);
    // The hook is the only route in.
    expect(source).toMatch(/useSettingsDocument\s*\(/);
  });
});
