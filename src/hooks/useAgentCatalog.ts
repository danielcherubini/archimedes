import {
  listAgentDefinitionReports,
  type AgentDefinitionReportDto,
} from "../lib/tauri";
import { useCatalogRow } from "./useCatalogRow";

/**
 * The Agent-definition catalog for a Space (or `null` = user-level definitions
 * only), for the sidebar **Agents** modal (ADR 0068).
 *
 * Was a deliberate copy of `useSkillCatalog` — its four cache rules are
 * load-bearing and were copied unchanged:
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
 * happens on a SPACE SWITCH and on a WRITE, never on a plain remount, so two
 * consumers opening the modal in one pane mount still share one (network-bound)
 * discovery. What was added is invalidation-on-write — the Agents modal's write
 * chain (`hooks/useAgentOverridesWrites.ts`, `writeAgentOverrides`) calls
 * `clearAgentCatalogCache()` after a successful save,
 * because `effective.thinking` / `.model` / `.tools` are the resolver's answer for
 * the map that was just replaced. That is exactly what rule 3 assumed someone would
 * add if a writer ever appeared: without it, the modal reopens showing the
 * PRE-EDIT `runs` columns, which is a stale statement about a file the user just
 * changed. It clears the WHOLE cache, not one key: the override map is GLOBAL, so an
 * edit changes the resolution behind every Space's rows.
 *
 * **This fetch is NOT a local disk walk.** `useSkillCatalog`'s doc-comment says
 * discovery is local and therefore needs no loading state, and copying that
 * sentence here would be false: `list_agent_definition_reports` calls `effective_catalog`,
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
 *
 * THE MACHINERY LIVES ELSEWHERE NOW (Task C1 / finding 11c). The four rules above
 * are implemented once, in `useCatalogRow` → `useCatalogPayload`. They are
 * restated here rather than only cross-referenced because rule 3 is the premise
 * of the invalidation-on-write decision in the paragraph above, and a reader of
 * THIS file is the reader who has to evaluate that decision. What this catalog
 * keeps to itself: its own cache Map (so `clearAgentCatalogCache()` cannot evict
 * the skill listing that `App` and `ChatStream` share — the two catalogs share
 * LOGIC, never state) and its own doc-comment, because its reasoning is not
 * `useSkillCatalog`'s. `useAgentCatalog.test.ts` pins all four rules through this
 * hook, unmodified.
 */
const cache = new Map<string, Promise<AgentDefinitionReportDto[]>>();

export function useAgentCatalog(spacePath: string | null): AgentDefinitionReportDto[] {
  // `useCatalogPayload`'s `[spacePath, fetchName]` deps stay inert because both
  // arguments here are module constants, so the effect re-runs on a Space change
  // and on nothing else.
  return useCatalogRow<AgentDefinitionReportDto>(
    cache,
    spacePath,
    listAgentDefinitionReports,
    "listAgentDefinitionReports",
  );
}

/**
 * Evict the whole module-level catalog cache.
 *
 * TWO callers, deliberately: the Agents modal's write chain
 * (`hooks/useAgentOverridesWrites.ts`) after a
 * SUCCESSFUL `agentOverrides` save (invalidation-on-write — see rule 3 above), and
 * every test file that mounts the hook, in `beforeEach`. Clearing everything rather
 * than one key is right for both: the override map is global, so a save changes the
 * resolution behind EVERY Space's rows, and a test wants a cold start.
 */
export function clearAgentCatalogCache(): void {
  cache.clear();
}
