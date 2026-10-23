import { listSkills, type SkillInfo } from "../lib/tauri";
import { useCatalogRow } from "./useCatalogRow";

/**
 * The skill catalog for a Space (or `null` = user-level skills only).
 *
 * Cached in a MODULE-LEVEL `Map<string, Promise<SkillInfo[]>>` keyed by
 * `spacePath ?? "__global__"` so the left pane AND the composer (two
 * components, same key) share ONE fetch. Re-fetched when `spacePath`
 * changes (the active Space changed) or on first mount (app start).
 * No loading state (the spec: discovery is a local disk walk — the
 * section simply re-renders when the result arrives). A failed fetch
 * degrades to `[]` (logged via `console.error` — the app's convention
 * for a non-critical background fetch failure).
 *
 * Freshness guarantees:
 * - A key change IMMEDIATELY serves `[]` until the new fetch resolves —
 *   the previous space's rows are never served in the gap (the state
 *   tracks the key its rows belong to), so `expandSkillMentions` cannot
 *   inject the wrong space's skill. (The composer now expands via the
 *   generalized `expandMentions`; the citation stands because
 *   `expandSkillMentions` is the retained `$`-only ORACLE for it, so the
 *   guarantee stated here holds for the path actually in use.)
 * - The LEFT key is evicted from the cache when the effect re-runs for a
 *   DIFFERENT key (tracked via a `useRef`), so a skill created/edited on
 *   disk mid-session is picked up on the next Space switch. An UNCHANGED
 *   key does NOT evict (a remount reuses the settled cache entry) and the
 *   NEW key is never evicted (the two-consumers-same-key in-flight dedupe
 *   keeps working — both mount in the same commit, so no key-change
 *   fires for them).
 *
 * The cache stores the IN-FLIGHT PROMISE, not just the resolved rows
 * (load-bearing: `App` mounts `SpacesList` AND `ChatStream`
 * simultaneously, both call `useSkillCatalog` with the same key in the
 * same commit — if the cache only populated on resolve, both effects
 * would see a cache miss and BOTH call `listSkills` → 2 IPC calls per
 * key).
 *
 * THE MACHINERY LIVES ELSEWHERE NOW (Task C1 / finding 11c). Every rule above is
 * implemented once, in `useCatalogRow` → `useCatalogPayload` (the four rules are
 * listed there). This file used to spell out the `useState`/`useRef`/`useEffect`
 * by hand, and `useAgentCatalog.ts` used to copy it — three copies of four
 * load-bearing rules, which is exactly how one of them drifts. The doc-comment
 * stays HERE (this catalog's reasoning is not that file's reasoning: Skills is a
 * LOCAL DISK WALK, which is why there is no loading state at all), and the four
 * rules above stay as the contract this hook promises its consumers — they are
 * what `useSkillCatalog.test.ts` pins, through this hook, unmodified.
 */
const cache = new Map<string, Promise<SkillInfo[]>>();

export function useSkillCatalog(spacePath: string | null): SkillInfo[] {
  // `useCatalogPayload`'s `[spacePath, fetchName]` deps stay inert because both
  // arguments here are module constants: `cache` is the Map above and
  // `listSkills` an imported function, so the effect re-runs on a Space change
  // and on nothing else.
  return useCatalogRow<SkillInfo>(cache, spacePath, listSkills, "listSkills");
}

/** Test-only: clear the module-level catalog cache (call in `beforeEach`). */
export function clearSkillCatalogCache(): void {
  cache.clear();
}
