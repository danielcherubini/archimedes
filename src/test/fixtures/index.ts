/**
 * The shared test-fixture barrel.
 *
 *   import { makeSettings, makeSessionRow } from "../test/fixtures";
 *
 * Inside a `vi.mock` factory you MUST reach it with `await import()` instead
 * (the factory is hoisted above this file's import) — see the note in
 * `./settings.ts`, and `src/test/fixtures.test.ts`, which proves the route.
 *
 * THERE IS NO `renderWithProviders` HERE, and that is a decision, not an
 * omission (Task B4a gated it on proving need; the need does not exist):
 *  - the app has no provider stack. `grep -c query|redux|swr|trpc|intl
 *    package.json` → zero hits, so there is no React Query client to provide;
 *    zustand stores are module singletons and need no provider at all.
 *  - `src/` defines exactly TWO contexts. `SpaceCwdProvider` deliberately
 *    returns `null` when no provider is mounted (`SpaceCwd.tsx`'s own comment:
 *    "keeps every component renderable in isolation"), and `ReasoningContext`
 *    belongs to a compound component whose tests already wrap in `<Reasoning>`
 *    — the component IS the provider.
 *  - of the 60 test files that call RTL `render`, exactly 3 wrap anything, all
 *    in `SpaceCwdProvider` with a per-test `cwd`, and each also asserts the
 *    NO-provider case (`OpenAnchor.test.tsx:32`). A wrapper would take `cwd` as
 *    an option and still not cover the case those tests exist for.
 *
 * So a wrapper would add an indirection with no consumer — the ceremony
 * finding 17 is about. `render` from `@testing-library/react` is the seam, and
 * `src/test/setup.tsx` supplies the environment a component actually needs. If
 * a future provider becomes mandatory app-wide, this is the file to add it to.
 */
export { DEFAULT_SETTINGS, makeSettings } from "./settings";
export {
  makeConfigOption,
  makeConfigSource,
  makeMessage,
  makeSessionRow,
  makeSpaceRow,
} from "./sessions";
export { makeSubagentEntry, makeSubagentState } from "./subagents";
