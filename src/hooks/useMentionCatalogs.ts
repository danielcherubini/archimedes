import {
  listAgentDefinitionsForSpace,
  listCompletionEntries,
  listMcpServersEffective,
  listSpaceFiles,
  type AgentDefinitionDto,
  type CompletionDirDto,
  type FileListDto,
  type McpServerInfo,
  type SkillInfo,
} from "../lib/tauri";
import { useSkillCatalog } from "./useSkillCatalog";
import { useCatalogPayload, useCatalogRow } from "./useCatalogRow";

/**
 * THE MACHINERY LIVES IN `useCatalogRow.ts` NOW (Task C1 / finding 11c).
 * `useCatalogPayload` and `useCatalogRow` were born private to this file, as the
 * generalisation of `useSkillCatalog`'s hand-rolled `{ key, rows }` state — while
 * `useSkillCatalog` and `useAgentCatalog` each still carried their own copy of the
 * same four cache rules. So the machinery moved out and all three consumers import
 * it: ONE implementation, and no `useCatalogCache` module beside it (the
 * array-shaped `useCatalogRow` API both standalone hooks need already existed
 * here, and a second cache abstraction would have been the finding in reverse).
 * The four rules and the deps/`empty` render-loop reasoning are documented at
 * their new home. WHAT DID NOT MOVE: the two `empty` constants below — their
 * module-level IDENTITY is what this file's test pins, and they belong here.
 */

/**
 * The FOUR composer catalogs for a Space (or `null` = user-level /
 * app-scope only) — skills, agents, MCP servers, and the `?` file
 * listing. Mirrors `useSkillCatalog`'s module-level promise cache (the
 * in-flight PROMISE is cached — the two-consumers-same-key in-flight
 * dedupe keeps working; a key change evicts the LEFT key; a key change
 * IMMEDIATELY serves the empty value until the new fetch resolves — a
 * stale Space's rows must never be offered; a failed fetch degrades to
 * the empty value with a `console.error`). Three module-level caches
 * (agents + mcp + files), keyed the same way
 * (`spacePath ?? "__global__"`).
 *
 * `null` key: `listAgentDefinitionsForSpace(null)` = user-level only
 * (the `cwd: None` command case); `listMcpServersEffective(null)` =
 * the desktop + pi-global layers (the `cwd: None` project-layer skip);
 * `listSpaceFiles(null)` = the empty listing (no Space, nothing to walk).
 */
const agentsCache = new Map<string, Promise<AgentDefinitionDto[]>>();
const mcpCache = new Map<string, Promise<McpServerInfo[]>>();
const filesCache = new Map<string, Promise<FileListDto>>();
/**
 * The out-of-Space Directory completion rows (ADR 0035), keyed by the
 * token's DIRECTORY PREFIX rather than by the Space — everything else is
 * the same machinery. NOT one of `useMentionCatalogs`' three — it belongs to
 * `useCompletionDir` below. Keying per directory (not per keystroke) is what
 * makes "one listing per directory" true: the engine returns the whole
 * UNFILTERED directory (Task 1) so the renderer filters it synchronously
 * and the token's non-directory tail never invalidates the entry.
 */
const completionCache = new Map<string, Promise<CompletionDirDto>>();

/**
 * The empty `?` listing — a MODULE-LEVEL stable identity, pinned by
 * `the_empty_files_value_is_one_module_constant_across_consumers` in
 * `useMentionCatalogs.test.ts` (mutation-checked: a fresh object literal at the
 * call site reddens it, and reddens NOTHING else — which is why the pin exists).
 * It must not be a fresh literal per render because it is the `empty` argument of
 * `useCatalogPayload`: the caller-side half of the render-loop hazard that hook's
 * deps comment describes. Stated exactly, because the hazard is conditional — the
 * loop needs BOTH a literal caller AND `empty` tracked in those deps, and today
 * neither half holds. Nobody has ever observed the loop; what HAS been observed is
 * a literal caller passing every test in the file, so identity is asserted here
 * rather than predicted.
 */
const EMPTY_FILE_LIST: FileListDto = { entries: [], truncated: false };

/**
 * The empty Directory completion payload — a MODULE-LEVEL stable identity
 * for the same reason `EMPTY_FILE_LIST` exists above (it is the `empty`
 * argument of `useCatalogPayload`), and pinned the same way: the identity
 * assertion in `the_null_dir_prefix_serves_the_stable_empty_dir` reddens when
 * this constant is replaced by a fresh literal at the call site
 * (mutation-checked). The loop itself is conditional — see `EMPTY_FILE_LIST`.
 */
const EMPTY_COMPLETION_DIR: CompletionDirDto = { entries: [], truncated: false };

export function useMentionCatalogs(
  spacePath: string | null,
): {
  skills: SkillInfo[];
  agents: AgentDefinitionDto[];
  mcpServers: McpServerInfo[];
  files: FileListDto;
} {
  const skills = useSkillCatalog(spacePath);
  const agents = useCatalogRow(
    agentsCache,
    spacePath,
    listAgentDefinitionsForSpace,
    "listAgentDefinitionsForSpace",
  );
  const mcpServers = useCatalogRow(
    mcpCache,
    spacePath,
    listMcpServersEffective,
    "listMcpServersEffective",
  );
  const files = useCatalogPayload(
    filesCache,
    spacePath,
    listSpaceFiles,
    "listSpaceFiles",
    EMPTY_FILE_LIST,
  ).payload;
  return { skills, agents, mcpServers, files };
}

/**
 * The out-of-Space completion rows for ONE directory (ADR 0035). `null`
 * = no out-of-Space token open; it maps to the `__global__` cache key and
 * the command's `None` arm, which touches no filesystem at all.
 *
 * `null` is still a FETCH: the wrapper is called with `null` on that cache miss
 * (exactly as `listSpaceFiles(null)` is), so "no token costs nothing" is a
 * RUST-side guarantee, pinned there, and NOT something a hook test can show by
 * absence — an assertion here that the fetcher was not called could never go
 * green, and mutation-checked, a client-side short-circuit for `null` reddens
 * `the_null_dir_prefix_serves_the_stable_empty_dir` rather than passing quietly.
 *
 * ONE accepted consequence of the machinery being shared: the LEFT key is evicted
 * (the same rule the Space catalogs use, so a directory edited on disk mid-session
 * is re-listed), which also means re-entering a directory you walked away from
 * reads it again instead of serving the row set you left behind. That is the
 * freshness half of the trade — stale rows must never be insertable into a token
 * that no longer names their directory.
 *
 * THE OTHER HALF OF THE GAP (why the return shape is a pair and not the DTO).
 * Freshness is served by serving `empty` for a key that has not landed — which
 * leaves the picker with ZERO ROWS for one IPC round trip, and the row count is
 * what gates the Enter intercept in `ComposerRow` (ADR 0033's "a picker is never
 * a gate" is implemented as "no rows, so nothing to intercept"). So a blank
 * picker is not merely a STALENESS question, it is an INPUT question: while the
 * rows for the directory the user just clicked into are in flight, Enter would
 * send the half-typed `?/home/u/.config/htop/` instead of waiting for the row it
 * was about to be offered. `pending` is that signal: true ONLY while a fetch for
 * the CURRENT non-null `dirPrefix` has not settled, false for `null`, false for
 * a cache hit that has settled, false after a resolve AND false after a REJECT
 * (a dead directory is blank forever, so a flag derived from "rows arrived"
 * would swallow Enter there for good). It is derived from the fetch SETTLING —
 * never from a timer. Pinned clause by clause in `useMentionCatalogs.test.ts`
 * and end-to-end in `ChatStream.test.tsx`.
 *
 * The returned WRAPPER object is a fresh literal each render (React does not
 * care; nothing memoises on it), so the half that carries the identity promise
 * is `.dir`: it stays the module-level `EMPTY_COMPLETION_DIR` while empty, and
 * `ChatStream` uses `.dir` (never the wrapper) as its `useMemo` dep. That is why
 * the identity assertions in `useMentionCatalogs.test.ts` read through `.dir`.
 *
 * ADR 0035's own note is worth correcting when it is next read: it reasoned
 * about this window ONLY as a staleness question — "blank is better than stale
 * and insertable" — and the half that was MISSING is the input half, that
 * blankness is also what removes the Enter intercept. Both halves are true; the
 * fix keeps the blankness (it is still the right answer for stale rows) and
 * holds Enter still for the one round trip it takes to know which one this is.
 */
export function useCompletionDir(dirPrefix: string | null): {
  dir: CompletionDirDto;
  pending: boolean;
} {
  const { payload, pending: rawPending } = useCatalogPayload<CompletionDirDto>(
    completionCache,
    dirPrefix,
    listCompletionEntries,
    "listCompletionEntries",
    EMPTY_COMPLETION_DIR,
  );
  return {
    dir: payload,
    // `dirPrefix === null` is NOT a pending fetch even though the hook still
    // calls the fetcher with `null` on that cache miss (see above): with no
    // out-of-Space token open there is no descent in flight to wait for, and a
    // flag that counted that fetch would swallow Enter in an ordinary composer.
    pending: dirPrefix !== null && rawPending,
  };
}

/**
 * TEST-ONLY: clear the agents + mcp + files + completion module-level caches (the
 * `clearSkillCatalogCache` pattern from `useSkillCatalog` — the skills
 * cache itself is cleared by `clearSkillCatalogCache()`, which the
 * consuming test files' `beforeEach` already calls). Without the clear,
 * a key cached by an earlier test in the file serves WARM rows and the
 * gap-state / called-once assertions fail.
 */
export function clearMentionCatalogsCache(): void {
  agentsCache.clear();
  mcpCache.clear();
  filesCache.clear();
  completionCache.clear();
}
