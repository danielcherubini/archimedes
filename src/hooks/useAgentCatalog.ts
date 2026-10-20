import { useEffect, useRef, useState } from "react";
import { listAgentConfig, type AgentConfigDto } from "../lib/tauri";

/**
 * The Agent-definition catalog for a Space (or `null` = user-level definitions
 * only), for the sidebar **Agents** modal (ADR 0068).
 *
 * A deliberate copy of `useSkillCatalog` — its four cache rules are load-bearing
 * and are copied unchanged:
 *
 * 1. A module-level `Map<string, Promise<T[]>>` keyed by `spacePath ??
 *    "__global__"` storing the IN-FLIGHT PROMISE, so two components mounted in
 *    the same commit share ONE fetch (a resolve-only cache would have both
 *    effects miss and issue two IPC calls).
 * 2. Rows are tracked TOGETHER with the key they were fetched for, so a key
 *    change serves `[]` immediately rather than the previous Space's rows.
 * 3. The LEFT key is evicted on a key change (a definition edited on disk is
 *    picked up when you come back); an UNCHANGED key never evicts (a remount
 *    reuses the settled entry) and the NEW key never evicts (so rule 1 keeps
 *    working).
 * 4. A FAILED fetch is not left cached — but it is deleted only if THIS promise
 *    is still the cached entry, so a fresh entry planted meanwhile survives.
 *
 * Rule 3 keeps this a DELIBERATE SHALLOW CACHE, and it still holds: the eviction
 * below happens on a SPACE SWITCH and on a WRITE, never on a plain remount, so two
 * consumers opening the modal in one pane mount still share one (network-bound)
 * discovery. What was added is invalidation-on-write — `SpacesList`'s
 * `writeAgentOverrides` calls `clearAgentCatalogCache()` after a successful save,
 * because `effective.thinking` / `.model` / `.tools` are the resolver's answer for
 * the map that was just replaced. That is exactly what rule 3 assumed someone would
 * add if a writer ever appeared: without it, the modal reopens showing the
 * PRE-EDIT `runs` columns, which is a stale statement about a file the user just
 * changed. It clears the WHOLE cache, not one key: the override map is GLOBAL, so an
 * edit changes the resolution behind every Space's rows.
 *
 * **This fetch is NOT a local disk walk.** `useSkillCatalog`'s doc-comment says
 * discovery is local and therefore needs no loading state, and copying that
 * sentence here would be false: `list_agent_config` calls `effective_catalog`,
 * which performs per-provider `GET /v1/models` discovery (cached per provider,
 * but a cold or invalidated cache is a real network round trip). So this fetch
 * can be NETWORK-BOUND, and it runs on EVERY Space switch — which is exactly why
 * rule 2 matters MORE here than it does for Skills. Serving the previous Space's
 * rows across a multi-hundred-millisecond gap would put stale rows (and stale
 * remove buttons) in front of the user for long enough to click; serving `[]`
 * says "loading" honestly instead. The rows below still carry no explicit
 * loading flag — `[]` is what the modal renders as "loading or empty" — but the
 * `orphanedOverrides` gate in `AgentsDialog` is what keeps that ambiguity from
 * producing a live remove button against nothing.
 */
const cache = new Map<string, Promise<AgentConfigDto[]>>();

export function useAgentCatalog(spacePath: string | null): AgentConfigDto[] {
  const key = spacePath ?? "__global__";
  // Rows + their key, together (rule 2): a key change immediately serves []
  // until the new fetch resolves.
  const [state, setState] = useState<{
    key: string;
    rows: AgentConfigDto[];
  }>(() => ({ key, rows: [] }));
  // The key the PREVIOUS effect run fetched for — so a key change evicts the
  // LEFT key (rule 3) without touching the new one.
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prevKey = prevKeyRef.current;
    prevKeyRef.current = key;
    if (prevKey !== null && prevKey !== key) {
      cache.delete(prevKey); // stale on disk: re-fetch when we come back
    }
    let cancelled = false;
    let p = cache.get(key);
    if (!p) {
      p = listAgentConfig(spacePath)
        .catch((err) => {
          // A failed fetch degrades to [] (logged — the app's convention for a
          // non-critical background fetch failure), and the FAILED promise is
          // dropped so a later effect retries — but only while THIS promise is
          // still the cached entry (rule 4).
          console.error("listAgentConfig failed:", err);
          if (cache.get(key) === p) cache.delete(key);
          return [] as AgentConfigDto[];
        });
      cache.set(key, p);
    }
    void p.then((r) => {
      // Stale-response guard: the Space changed while in flight.
      if (!cancelled) setState({ key, rows: r });
    });
    return () => {
      cancelled = true;
    };
  }, [spacePath]);
  return state.key === key ? state.rows : [];
}

/**
 * Evict the whole module-level catalog cache.
 *
 * TWO callers, deliberately: `SpacesList`'s `writeAgentOverrides` after a
 * SUCCESSFUL `agentOverrides` save (invalidation-on-write — see rule 3 above), and
 * every test file that mounts the hook, in `beforeEach`. Clearing everything rather
 * than one key is right for both: the override map is global, so a save changes the
 * resolution behind EVERY Space's rows, and a test wants a cold start.
 */
export function clearAgentCatalogCache(): void {
  cache.clear();
}
