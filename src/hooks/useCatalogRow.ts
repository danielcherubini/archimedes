import { useEffect, useRef, useState } from "react";

/**
 * THE ONE catalog-cache machine (finding 11c).
 *
 * Four consumers used to carry their own copy of the same rules:
 * `useSkillCatalog`, `useAgentCatalog` (a deliberate copy, measured at 8
 * comment-stripped lines of difference), and the three composer catalogs inside
 * `useMentionCatalogs`. This file is that machinery ONCE — `useCatalogPayload`,
 * generalised over any PAYLOAD, and `useCatalogRow`, the array-shaped wrapper the
 * row catalogs use.
 *
 * WHY THIS FILE AND NOT A NEW `useCatalogCache` MODULE. The array-shaped API
 * `useCatalogRow<T>(cache, spacePath, fetch, fetchName): T[]` already existed in
 * `useMentionCatalogs.ts` and was already exactly what the two standalone hooks
 * needed. Creating a second cache module beside it would have been a THIRD
 * abstraction for one machine — the finding in reverse. So the existing function
 * MOVED here and every consumer imports it.
 *
 * WHY IT DOES NOT LIVE IN `useMentionCatalogs.ts`: exporting it there would make
 * `useSkillCatalog.ts` import `useMentionCatalogs.ts` while that file already
 * imports `useSkillCatalog` — a module cycle, and Task B3 spent its whole commit
 * removing one. The two empty-value constants that belong to
 * `useMentionCatalogs`' own consumers (`EMPTY_FILE_LIST`, `EMPTY_COMPLETION_DIR`)
 * stayed there for the same reason — their IDENTITY is pinned by that file's
 * tests, and a move would relocate a pinned thing for no gain.
 *
 * THE FOUR RULES (load-bearing; each is pinned by a test in
 * `useAgentCatalog.test.ts`, `useSkillCatalog.test.ts` or
 * `useMentionCatalogs.test.ts`):
 *
 * 1. The cache stores the IN-FLIGHT PROMISE, keyed by `spacePath ??
 *    "__global__"`, so two components mounted in the SAME commit share one fetch
 *    (a resolve-only cache would have both effects miss → two IPC calls).
 * 2. The payload is tracked TOGETHER with the key it was fetched for, so a key
 *    change serves `empty` immediately rather than the previous Space's rows.
 * 3. The LEFT key is evicted on a key change (a file edited on disk is picked up
 *    when you come back); an UNCHANGED key never evicts (a remount reuses the
 *    settled entry) and the NEW key never evicts (so rule 1 keeps working).
 * 4. A FAILED fetch is not left cached — but it is deleted only if THIS promise
 *    is still the cached entry, so a fresh entry planted meanwhile survives.
 *
 * Every cache Map is created by the CALLING module and passed in. That is not
 * incidental: the two standalone catalogs must keep INDEPENDENT Maps, because
 * `clearAgentCatalogCache()` is invalidation-on-write for the global agent
 * override map (`SpacesList`'s `writeAgentOverrides`) and must not also throw
 * away the skill listing that `App` and `ChatStream` share.
 */

/** The empty row array the array-shaped catalogs degrade to (stable). */
const EMPTY_ROWS: never[] = [];

/**
 * The shared freshness machinery for one catalog. Replicates the original
 * `useSkillCatalog`'s `{ key, rows }` state pattern verbatim, generalised from a
 * ROW ARRAY to any PAYLOAD (the files row is `{ entries, truncated }`, not an
 * array): a key change immediately serves `empty` until the new fetch resolves
 * (the state tracks the key its payload belongs to); the LEFT key is evicted when
 * the effect re-runs for a different key (an unchanged key does NOT evict — a
 * remount reuses the settled cache entry); the cache stores the IN-FLIGHT PROMISE
 * (the two-consumers-same-key in-flight dedupe); a failed fetch degrades to
 * `empty` (logged, and the failed promise is only evicted if it is still the
 * cached entry — a test's `clear*Cache()` + re-mount may have cached a FRESH one
 * under the same key).
 */
export function useCatalogPayload<P>(
  cache: Map<string, Promise<P>>,
  spacePath: string | null,
  fetch: (spacePath: string | null) => Promise<P>,
  fetchName: string,
  empty: P,
): { payload: P; pending: boolean } {
  const key = spacePath ?? "__global__";
  // ONE state object, deliberately: `payload` and `settled` must move together,
  // because "the rows on screen" and "the fetch is over" are the same claim
  // about the same key. Two separate `useState`s could be observed in between
  // (a key change with an older key's payload on screen but a newer key's
  // settle flag), which is precisely the window `pending` is meant to describe.
  const [state, setState] = useState<{
    key: string;
    payload: P;
    settled: boolean;
  }>(() => ({ key, payload: empty, settled: false }));
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
      p = fetch(spacePath)
        .catch((err) => {
          // A failed fetch degrades to the empty value (logged — the app's
          // convention for a non-critical background fetch failure).
          // A FAILED promise is NOT cached (delete it) so a later effect
          // retries — but only if THIS promise is still the cached entry
          // (a test's `clearMentionCatalogsCache()` + re-mount may have
          // cached a FRESH one under the same key; an unconditional
          // delete would evict it).
          console.error(`${fetchName} failed:`, err);
          if (cache.get(key) === p) cache.delete(key);
          return empty;
        });
      cache.set(key, p);
    }
    void p.then((r) => {
      // Stale-response guard: the Space changed while in flight.
      if (!cancelled) {
        // A REJECTION lands here too (the `.catch` above converted it to
        // `empty`), which is exactly what makes this the right place to mark a
        // settle: "settled" means "the fetch is over", never "the fetch
        // returned rows". A dead directory has NO rows ever, and a caller that
        // inferred pending-from-rows would hold Enter down there forever.
        setState({ key, payload: r, settled: true });
      }
    });
    // The deps below intentionally omit `cache`, `fetch` AND `empty`: all
    // three are stable BY CONSTRUCTION — `cache` is a module-level Map owned by
    // the caller, `fetch` an imported module function, and `empty` a module
    // constant (`EMPTY_ROWS` here, `EMPTY_FILE_LIST` / `EMPTY_COMPLETION_DIR` in
    // `useMentionCatalogs`). None can change between renders, so none may be
    // tracked. `empty` is the one that would actually bite IF it ever were
    // tracked: were `empty` added to these deps AND a caller passing a fresh
    // literal (instead of the module constant), the effect would re-fire on
    // EVERY render, each run's `.then` writing a NEW payload object — an infinite
    // render loop. Read that sentence for what it IS: a conditional about a
    // configuration this app does not have. It needs BOTH halves (tracked `empty`
    // AND a literal caller) and neither holds, so the loop has never been
    // observed here — a caller swapping in a literal on its own leaves this hook
    // untouched (measured: the whole suite stayed green). That is precisely why
    // the two stable-identity constants are pinned by IDENTITY assertions in
    // `useMentionCatalogs.test.ts` rather than left to this paragraph: the
    // observable contract today is "the empty value is one object", and that is
    // what a test can actually see. (`empty` must therefore never be tracked —
    // that is the rule, not the loop.)
    return () => {
      cancelled = true;
    };
  }, [spacePath, fetchName]);
  return {
    payload: state.key === key ? state.payload : empty,
    // THE INVARIANT, and it is load-bearing: `pending === true` ⟹ `payload` is
    // the EMPTY constant. Both halves read the same two fields of one state
    // object, so they can never disagree — which matters because `pending` is
    // only ever a reason to HOLD a keystroke while there is nothing to insert,
    // and a `pending` that could be true beside a screen full of rows would
    // swallow an insert the user can see. `state.payload` is the `empty` value
    // whenever `settled` is false (it is only ever written by the settle), so
    // the `state.key === key && !settled` branch cannot show rows either.
    pending: state.key === key ? !state.settled : true,
  };
}

/**
 * An array-shaped catalog row (the skills / agents / mcp lists): the payload hook
 * with the module-level empty array as its empty value.
 *
 * `fetchName` is always a MODULE-CONSTANT string (the fetcher's own name, for the
 * `console.error` line), which is what makes the `[spacePath, fetchName]` deps
 * INERT — they cannot change between renders, so the effect re-runs on a Space
 * change and nothing else.
 *
 * The two standalone hooks deliberately IGNORE the `pending` field
 * `useCatalogPayload` returns: neither the left pane nor the Agents modal gates
 * anything on it, and both render `[]` as "loading or empty" (each hook's own
 * doc-comment records why that ambiguity is acceptable where it is). It is not
 * re-exposed here because a field nothing consumes is a field nothing keeps
 * honest.
 */
export function useCatalogRow<T>(
  cache: Map<string, Promise<T[]>>,
  spacePath: string | null,
  fetch: (spacePath: string | null) => Promise<T[]>,
  fetchName: string,
): T[] {
  return useCatalogPayload<T[]>(cache, spacePath, fetch, fetchName, EMPTY_ROWS)
    .payload;
}
