import { create } from "zustand";

import { listModels, type ModelDto } from "../lib/tauri";

/**
 * The effective model catalog, for the surfaces that need a model's METADATA
 * (today: the subagent card's context-window percentage).
 *
 * WHY A STORE (#85). The catalog was previously fetched into local `useState`
 * inside `SpacesList` (for the Agents modal) and `SettingsPage` — two trees that
 * do not contain the transcript. The subagent card is two components DEEPER than
 * either, under `ChatStream` → `MessageBubble`, so it had no catalog to read and
 * fell back to `getModelContextWindow`'s hardcoded name table, which answers 64k
 * for every deepseek model (a 1M-window model scored at 6% of its real window).
 * Threading a prop from `SpacesList` down through the virtualized message list
 * would put the catalog in the render path of every transcript row for a value
 * one row kind reads; a small store is the narrower seam, and `useSettings`
 * (`store/settings.ts`) is the existing precedent for exactly this shape.
 *
 * The `ModelDto` shape is the backend's own (`list_models` → `ModelDto`), so the
 * consumer's lookup matches on the same `provider` / `id` halves the composed
 * `provider/id` key carries.
 */
interface ModelCatalogState {
  /** The last successfully loaded catalog (`[]` until the first load lands). */
  models: ModelDto[];
  /**
   * True once a load attempt finished (success OR failure), so a caller can stop
   * showing a loading state. Distinct from `models.length > 0`: a provider-less
   * install legitimately has an EMPTY catalog.
   */
  loadStarted: boolean;
  /**
   * True once a load has SUCCEEDED — the re-fetch guard for a plain (non-forced)
   * read. In the STORE rather than a module variable on purpose: module-level
   * mutable state is invisible to `setState`, so a test (or a future reset path)
   * could not clear it, and a leaked "loaded" would silently skip the first real
   * fetch.
   */
  loadedOk: boolean;
  /**
   * Fetch the catalog and store it.
   *
   * `forceRefresh` (a provider id) is the Settings refresh affordance — it
   * bypasses the backend's discovery cache AND (#85) pushes the corrected
   * metadata to live sessions. Pass it whenever the caller is a REFRESH; pass
   * nothing for a normal boot read (a cached catalog is the point).
   *
   * Concurrent callers SHARE one in-flight fetch: the sidebar and the settings
   * page mount independently at boot, and two `list_models` calls would mean two
   * provider-discovery passes for the same data. An already-loaded catalog is not
   * re-fetched without a `forceRefresh`.
   *
   * A FAILED load leaves `models` untouched — a failed refresh must not blank a
   * card's percentage back to the name table — and is not sticky: the next call
   * tries again.
   */
  loadModels: (forceRefresh?: string) => Promise<void>;
}

/**
 * The in-flight fetch, shared by concurrent callers.
 *
 * Module-level rather than store state, deliberately: it is not something any
 * component renders, and putting a `Promise` in the store would make every
 * subscriber re-render when it is created and cleared.
 */
let inFlight: Promise<ModelDto[]> | null = null;

export const useModelCatalog = create<ModelCatalogState>()((set, get) => ({
  models: [],
  loadStarted: false,
  loadedOk: false,
  loadModels: async (forceRefresh) => {
    // A cached catalog answers a plain read; a refresh always goes out.
    if (get().loadedOk && forceRefresh === undefined) return;
    if (!inFlight) {
      inFlight = listModels(forceRefresh);
    }
    try {
      const models = await inFlight;
      set({ models, loadStarted: true, loadedOk: true });
    } catch (error) {
      // Keep the previous catalog (see the interface note) but record that an
      // attempt finished — and allow the next call to retry (`loadedOk` is
      // untouched on failure, so a refresh retries and a boot read retries).
      console.error("Failed to load the model catalog", error);
      set({ loadStarted: true });
    } finally {
      inFlight = null;
    }
  },
}));
