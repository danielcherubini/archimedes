---
status: committed
parent: docs/roadmap/chatstream-decomposition-status.md
done-when: >
  (1) `src/components/ChatStream.test.tsx` STILL contains the two `vi.mock` CALLS
  AND their full factory BODIES (the tauri factory verbatim, with
  `vi.importActual`, the dialog factory verbatim) — this is a DELIBERATE
  non-extraction, see the load-bearing constraint; (2) the moved scaffolding
  (the 14 exported names below) lives in `src/test/chatStreamFixtures.ts` with
  IDENTICAL behaviour; (3) `src/test/chatStreamFixtures.test.ts` passes (7
  tests) and pins each moved helper plus the "no `vi.mock(` call may live in the
  fixture module", the absolute-absence compaction assertions, and the byte-
  identity deltas; (4) the two runnable files BOTH pass — `npx vitest run
  src/components/ChatStream.test.tsx` reports `278 passed` and `npx vitest run
  src/test/chatStreamFixtures.test.ts` reports `7 passed`; (5) the whole
  frontend suite `pnpm test` (repo root) passes; (6) `npx tsc --noEmit` (repo
  root) and `pnpm build` (repo root) pass; (7) the executed-test count did NOT
  move: exactly 278 in `src/components/ChatStream.test.tsx` BEFORE and AFTER
  (measured by `npx vitest run` on the base and on the result — run it, do not
  read count prose; the 278 is the runner's own line, not a hand derivation);
  (8) a BYTE-IDENTITY diff of the moved regions (block of code removed from the
  test file vs. block added to the fixtures module) shows the ONLY deltas are
  the added `export ` keywords and the `waitForCatalog` parameter line — this
  is the "nothing changed" proof, run programmatically per the Steps; (9)
  `src/lib/tauriBarrel.test.ts` stays green UNCHANGED — its `mockers` set still
  counts `ChatStream.test.tsx`, read the current numbers at that assertion and
  never restate them as values you maintain (the set is unchanged because the
  `vi.mock("../lib/tauri")` CALL and its `vi.importActual` factory body both
  stay in the `.test.tsx` file).
---

# ChatStream decomposition — Task 02: extract `ChatStream.test.tsx`'s module-level scaffolding into `src/test/chatStreamFixtures.ts`

**Goal:** Move `src/components/ChatStream.test.tsx`'s module-level seeding/interaction scaffolding (the six seed helpers, the five interaction helpers, and the three constants — 14 exported names) into a new shared fixture module `src/test/chatStreamFixtures.ts`, keeping every exported name's behaviour byte-identical, keeping **both `vi.mock` CALLS AND their factory BODIES in place** in `ChatStream.test.tsx` (see the load-bearing constraint — the bodies do NOT move), and landing with the SAME executed test count (278, per the vitest runner) — the count plus the byte-identity diff is what proves the extraction dropped and changed nothing.

**Architecture:** Per the probe matrix in the grounding report's appendix (read it first — it is the measurement that decides this plan), the factory bodies DO NOT MOVE. The corrected shape: both `vi.mock` calls AND both factory bodies stay VERBATIM in `ChatStream.test.tsx`; a new fixtures module `src/test/chatStreamFixtures.ts` holds the seeds, interaction helpers, and the three constants, and is imported at module level from the test file (never from inside a `vi.mock` factory). `waitForCatalog` needs `listSkills`; rather than importing the mocked barrel into the fixtures module, the mocked function is injected as a parameter — this keeps the fixtures module's dependency graph simple and, decisively, keeps the injection decision independent of the factory decision (see decision 3 below). `src/test/chatStreamFixtures.test.ts` pins the moved helpers and the no-`vi.mock` rule.

**Tech Stack:** TypeScript (`strict`, `noUnusedLocals: true`, `noUnusedParameters: true` in `tsconfig.json` — verified), vitest 5.0.0 (config in `vite.config.ts`, `environment: "jsdom"`, `setupFiles: ["./src/test/setup.tsx"]`, `testTimeout: 20_000`), @testing-library/react, zustand, pnpm 11.7.0. All frontend commands run from the repo root (`/home/daniel/Coding/AI/archimedes-desktop`). Verified: `package.json` scripts are `test: "vitest run"`, `build: "tsc && vite build"`; there is no dedicated `typecheck` script.

---

## Parallelisation

**Verdict:** SERIAL — this consumed-mode plan contains exactly one task, so there is nothing to parallelise with (a one-task plan cannot be a wave, and per the skill's consumed-mode rule no `**Parallel:**` line is emitted). Reason for the record: this task's owned file set (`src/test/chatStreamFixtures.ts`, `src/test/chatStreamFixtures.test.ts`, `src/components/ChatStream.test.tsx`) is disjoint from the sibling task that owns `src/components/ChatStream.tsx`, but wave grouping belongs to the caller (`roadmap`); as a single-task plan it emits the SERIAL verdict by definition.

---

### Task 02: Extract the seed/interaction scaffolding into `src/test/chatStreamFixtures.ts` — factories stay home

**Parallel:** none — single-task plan. This task's files are `src/test/chatStreamFixtures.ts`, `src/test/chatStreamFixtures.test.ts`, `src/components/ChatStream.test.tsx` — do NOT touch `src/components/ChatStream.tsx` (a sibling task in this same wave owns it and creates `src/lib/chatSessionDerivations.ts` + `src/hooks/useChatSessionDerivations.ts`; this plan does NOT create, modify, or depend on any of those) and do NOT edit `src/lib/tauriBarrel.test.ts` (it must stay green UNCHANGED).

**Context:**

`src/components/ChatStream.test.tsx` is 7,885 lines with roughly 400 lines of module-level scaffolding sitting ABOVE its first `describe` (line 443 at HEAD `22f16d3a`) — imports, the `beforeAll` stubs, the two `vi.mock` factories, the seed/interaction helpers, and the `beforeEach`. Later roadmap tasks must split this file by domain; every split would need to duplicate that scaffolding. This task extracts the seed/interaction helper block (roughly half of that scaffolding, ~225 lines) once into `src/test/chatStreamFixtures.ts` so a split becomes an import. The grounding report (the source of truth; the appendix at its end is the measure that decided the architecture) pins every name, body, comment, and behaviour below. Behaviour is MOVED, not improved: outcome-identical tests, same executed test count, no "fixing" of known quirks (the cross-block `listSkills.mockResolvedValue` leak via `mockClear` semantics in particular) inside a refactor commit.

**THE LOAD-BEARING CONSTRAINTS — read these first; the first is the vetted correction.**

**(A) The two `vi.mock` CALLS AND their factory BODIES stay in `ChatStream.test.tsx` — DO NOT MOVE THE BODIES.** The original design (moving the factory bodies into exported factory functions and delegating from the test file) was VETTED AND FOUND BROKEN on this exact tree. The probe matrix (grounding report appendix, rows measured with real `npx vitest run` runs on transient probes):

| Factory location | Helper module | Import order | Result |
|---|---|---|---|
| `vi.mock` CALL inside an imported module | — | — | ❌ transform refuses to rewrite it |
| test file, delegates to helper | helper imports the mocked module directly | helper after target | ❌ `Cannot access '__vi_import_N__' before initialization`, 0 tests run |
| test file, delegates to helper | helper reaches it **transitively via a store** | helper after target | ❌ same error — the store path does not save you |
| test file, delegates to helper | helper clean (no path to mocked module) | helper **before** target | ✅ |
| test file, delegates to helper | helper clean | helper after target | ❌ |
| **factory stays INLINE in the test file** (references only `vi`), seeds moved to a module that reaches the mocked module via a store | — | target first | ✅ |

The rule the matrix yields: a `vi.mock` factory may reference only bindings whose module is BOTH free of any transitive import of the mocked specifier AND imported before anything that imports it — two silent, order-fragile conditions; violating either fails as **0 tests run** with a `ReferenceError` pointing at an import line. **The store-mediated path does NOT help**: `src/store/settings.ts` imports `{ getSettings, type AppSettings } from "../lib/tauri"` and `src/store/sessions.ts` imports nine commands plus types from `"../lib/tauri"` (verified), so ANY fixtures module that seeds the settings or sessions store has a transitive path INTO the mocked barrel — exactly the row that fails when a factory delegates to it.

**Measured facts about the two factories** (verified against the file): the tauri factory body references ONLY `vi.importActual("../lib/tauri")` plus `vi.fn()` — it touches NO module-scope binding (`SETTINGS_FIXTURE`, `MONO_ADVANCE_EM`, `PERSISTED_MCP_MESSAGE`, and the `make*` fixtures all appear zero times inside it; at HEAD the factory spans roughly lines 133–221, orient by the `vi.mock("../lib/tauri"` call, not by these numbers). The dialog factory (`vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }))` — three lines plus two comment lines) is likewise self-contained. **Therefore moving the bodies buys nothing and costs the ordering constraint. The bodies stay. Do not "finish the extraction" by moving them: a later "simplification" that moves the factory bodies into a shared module — with or without delegation — lands the suite at 0 tests run.** This plan contains NO `createTauriMock`/`createDialogMock` anywhere (that design was vetted and abandoned). Note: the fixtures-module's store→barrel path (via `useSessions`/`useSettings`) is real but HARMLESS once the factories stay inline — probe row 6 IS this plan's shape and it passes.

**(B) A cross-file guard you can trip:** `src/lib/tauriBarrel.test.ts`'s `it("the scanner sees the mock seam it exists to protect")` (§7 of the report) scans every `.test.tsx?` file under `src/` for the regex `/^\s*vi\.mock\(\s*["'][^"']*lib\/tauri["']/m` and pins (a) the SET of matching files and (b) how many of those contain `vi.importActual`. Read the assertion for the current numbers; never restate them as values you maintain (the numbers are cited by pointing at the test). Because the `vi.mock("../lib/tauri")` CALL **and its `vi.importActual` factory body stay in `ChatStream.test.tsx`**, both pins stay green — the counted set is unchanged (38 files as of base `b0071544`; `ChatStream.test.tsx` is in the 37 spreading `vi.importActual` — quote those ONLY as prose citing the assertion, never as values you maintain). If the call or the `vi.importActual` text ever moved out of the `.test.tsx` file, the pins would redden and the fix is to restore them HERE. Do NOT edit `tauriBarrel.test.ts`.

**(C) The order-critical `beforeEach` and the in-file order dependence:** there is exactly ONE module-level `beforeEach` (lines 403–441 at HEAD; §1.8 of the report: `vi.useRealTimers()`, `setSidePaneCollapsed(false)`, `localStorage.clear()`, the `useQueuedPrompts.clearSession(id)` loop BEFORE `clearAllMocks` so URL releases are not counted against revocation assertions, `vi.clearAllMocks()` — mockClear semantics —, `clearSkillCatalogCache()`, `clearMentionCatalogsCache()`, `resetStores()`). It stays in `ChatStream.test.tsx` VERBATIM. The report also records the in-file order dependence: `vi.clearAllMocks()` uses `mockClear` semantics, so the nested picker-filters `describe`'s PERSISTENT `listSkills.mockResolvedValue([skill-manager, …])` override leaks into later tests (the Flush-block comment, §3.3, documents this as PRE-EXISTING). This task touches none of the `describe` bodies, so the leak is untouched by construction — do NOT "fix" it in this refactor commit.

Required decisions made and why:

1. **Factory bodies do NOT move.** This is the corrected architecture (constraint A). The fixtures module contains NO `vi.mock(` text and never calls `vi.mock`. The test file keeps both calls AND both bodies verbatim.
2. **The seeds, interaction helpers, and the three constants move** to `src/test/chatStreamFixtures.ts` as exported names. The module MAY import the zustand stores and `../test/fixtures` — with inline factories there is no delegation, so the store→barrel path is harmless (verify against probe row 6, not against the failed rows — row 6 IS this shape).
3. **`waitForCatalog` resolves `listSkills` by INJECTING the mocked function as a parameter** — the fixtures module does NOT import `../lib/tauri`. Why: (a) the fixtures module already reaches `../lib/tauri` transitively via the stores, so a direct barrel import would add nothing functionally but WOULD make the dependency graph visually ambiguous; (b) the decision must be independent of the factory decision — had the plan chosen "import the mocked specifier because the factory is inline", it would silently re-introduce a delegation-shaped dependency the moment someone later moves the factories; (c) `waitForCatalog`'s only use of the barrel is `vi.mocked(listSkills)` — one bound identifier, cleanly parameterized. **Call sites verified first**: `waitForCatalog()` is called 19 times in the test file, always from `await waitForCatalog()` inside test bodies — zero call sites are inside the scaffolding, so the signature change touches only the moved function and the seam test; no test-body call changes. The signature `waitForCatalog(listSkills: typeof import("../lib/tauri")["listSkills"]): Promise<void>` keeps the type correct (the barrel exports `listSkills(spacePath: string | null): Promise<SkillInfo[]>` — the mocked instance is assignment-compatible).
4. **`SETTINGS_FIXTURE`, `MONO_ADVANCE_EM`, `PERSISTED_MCP_MESSAGE` stay module constants and are EXPORTED** from the fixtures module: they have consumers below the moved region — `SETTINGS_FIXTURE` spread at lines ~745 and ~818, `MONO_ADVANCE_EM` used at line ~672, `PERSISTED_MCP_MESSAGE` used at line ~3434 (verified at HEAD).
5. **`useSettings`, `useSessions`, `useQueuedPrompts`, `useInteractive`, `usePermissions`, `useSubagents` STAY in `ChatStream.test.tsx`; `makeSessionRow`/`makeSettings`/`makeSpaceRow` and `AppSettings` are PRUNED from it** (details in §6 of What to implement; the prunes are the `noUnusedLocals: true` consequence).
6. **The new module is NOT registered anywhere** — `src/test/` has no barrel (only `src/test/fixtures/` does, verified), so a new module there registers nothing and needs no barrel edit. `chatStreamFixtures.ts` is imported directly by path from the test files that need it.

**Files:**
<!-- Owned file set for this task — plan nothing outside it. -->
- Create: `src/test/chatStreamFixtures.ts`
- Create: `src/test/chatStreamFixtures.test.ts`
- Modify: `src/components/ChatStream.test.tsx`
- (NOT owned, do NOT plan any edit: `src/components/ChatStream.tsx` — a sibling task in this same wave owns it and creates `src/lib/chatSessionDerivations.ts` + `src/hooks/useChatSessionDerivations.ts`; this task must not create, modify, or depend on those. Also do NOT edit `src/lib/tauriBarrel.test.ts` — it must stay green UNCHANGED.)

**What to implement:**

Anchor every move BY SYMBOL, not by line range. The old plan's line ranges were vet-shown to be off by one or two, and its tauri-factory block boundary would have deleted the dialog mock's comment lines; line numbers go stale on the first edit anyway. Line numbers in this plan are HEAD `22f16d3a` orientation only, marked with `~`; they are NOT the anchor. The block to extract is everything from the `MONO_ADVANCE_EM` doc comment down to the closing brace of `waitForCatalog` (the last module-level symbol before `beforeEach`), MINUS the `beforeAll` block (its long comment through the closing `});`), MINUS the two `vi.mock` blocks, MINUS the `beforeEach` block.

**1. What moves OUT of `ChatStream.test.tsx` (verbatim, in file order, as EXPORTED names):**

- `MONO_ADVANCE_EM` — the doc comment ("The monospace advance as a fraction of font size…", a multi-line `/** … */` block) + `const MONO_ADVANCE_EM = 0.6;` → `export const MONO_ADVANCE_EM = 0.6;`. Keep the whole doc comment with the constant.
- `SETTINGS_FIXTURE` — the doc comment ("A full settings fixture (the spinner-style tests seed the store with it)…") + `const SETTINGS_FIXTURE: AppSettings = makeSettings();` → `export const SETTINGS_FIXTURE: AppSettings = makeSettings();`.
- `seedMcpMentionsOn()` / `seedMcpMentionsOff()` — the doc comments + both functions, verbatim → `export function seedMcpMentionsOn(): void { … }` and `export function seedMcpMentionsOff(): void { … }` (bodies byte-identical: `useSettings.getState().setSettings({ ...SETTINGS_FIXTURE, mcpMentionsEnabled: true | false })`).
- `PERSISTED_MCP_MESSAGE` — the doc comment + the string-literal concatenation → `export const PERSISTED_MCP_MESSAGE = "query #postgres\n\n" + '<mcp name="postgres">' + … + "\n</mcp>";` — value byte-identical.
- The session seed helpers — `seedLiveSession`, `seedStoredSession(capabilities: Record<string, unknown> = {})`, `seedArchivedSession(capabilities: Record<string, unknown> = {})`, `seedLiveSessionWithImages()` — each with its doc comment, exported (`export function …`), bodies byte-identical. (With the two mention seeds above, the full seed set is six: `seedLiveSession`, `seedStoredSession`, `seedArchivedSession`, `seedLiveSessionWithImages`, `seedMcpMentionsOn`, `seedMcpMentionsOff`.)
- The interaction helpers, exported: `pasteToComposer(files: File[], extra: { text?: string; html?: string } = {}): boolean` (the `// fireEvent.paste wraps the dispatch in act…` comment + the function, through its closing brace), `dropOnComposer(files: File[]): void`, `flush(): Promise<void>`, `deferred<T>()`, `waitForCatalog(listSkills): Promise<void>` (the parameter is the ONLY body change — see §4).

**2. What STAYS in `ChatStream.test.tsx`, in place, VERBATIM (with the two prunings in §6):**
- The whole import block, minus `makeSessionRow, makeSettings, makeSpaceRow` (line 50) and `AppSettings` (line 40).
- The `beforeAll` environment stubs and their long comment — §1.3 of the report: the object-URL pair plus the three `HTMLElement.prototype` stubs; these are the minimal documented complement to `src/test/setup.tsx`'s own stubs, and the moved helpers do not depend on them. Do NOT move or duplicate them.
- The `vi.mock("../lib/tauri", async () => { … })` factory — the `// Mock the Tauri IPC layer; everything else (stores) is the real code.` comment through the closing `});` — the ENTIRE body, verbatim, with all internal comments (the `compactSession`/ADR 0044 comment, the `listSpaceListing`/ADR 0033 comment, the `listCompletionEntries`/ADR 0035 comment) and all 17 overrides (`startSession`, `closeSession`, `sendPrompt`, `resumeSession`, `respondPermission`, `respondInteractiveRequest`, `setSessionConfigOption`, `readClipboardImage`, `readFileBytes`, `cancelSession`, `compactSession`, `loadHistory`, `listSkills` (2-skill `debug`/`beta` array), `listAgentDefinitionsForSpace` (the `scout` array), `listMcpServersEffective` (the `postgres` array), `listSpaceListing`, `listCompletionEntries`). DO NOT TOUCH A SINGLE LINE OF IT.
- The `vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }))` call AND its two preceding comment lines ("The native file picker (the `+` button's `open`…" and the line above it) — verbatim.
- The `beforeEach` — verbatim (§1.8; the eight behaviours listed in constraint C).

**3. The import to ADD to `ChatStream.test.tsx`** — with the other `../test` imports, right after the `resetStores` import:

```ts
import {
  MONO_ADVANCE_EM,
  SETTINGS_FIXTURE,
  PERSISTED_MCP_MESSAGE,
  seedLiveSession,
  seedStoredSession,
  seedArchivedSession,
  seedLiveSessionWithImages,
  seedMcpMentionsOn,
  seedMcpMentionsOff,
  pasteToComposer,
  dropOnComposer,
  flush,
  deferred,
  waitForCatalog,
} from "../test/chatStreamFixtures";
```

**4. `src/test/chatStreamFixtures.ts` — full layout** (imports first, then constants, then seeds, then interaction helpers, in the SAME order as today's file so a reviewer can diff by eye; the `beforeAll`/`vi.mock` blocks and the `beforeEach` are NOT moved):

```ts
/**
 * Shared module-level scaffolding for `ChatStream` tests (issue #135 §5
 * "Split Test Suite").
 *
 * Everything here was MOVED VERBATIM out of `src/components/ChatStream.test.tsx`
 * (task chatstream-decomposition-task02). Behaviour is MOVED, not improved:
 * the seed helpers mutate the real zustand stores exactly as before, the
 * interaction helpers drive the RTL queries exactly as before, and the three
 * constants keep their exact values and doc comments.
 *
 * DO NOT call `vi.mock` from this file, and DO NOT move the `vi.mock` factories
 * here: `vi.mock` hoists per module — a factory body may reference only
 * bindings whose module is BOTH free of any transitive import of the mocked
 * specifier AND imported before anything that imports it. This module imports
 * `useSettings` and `useSessions`, whose stores both import `../lib/tauri`, so
 * it HAS a transitive path INTO the mocked barrel: a factory delegated here
 * fails as 0 tests run (`Cannot access '__vi_import_N__' before
 * initialization`). The two `vi.mock` CALLS AND their factory bodies therefore
 * stay in `src/components/ChatStream.test.tsx` — which is also what keeps
 * `src/lib/tauriBarrel.test.ts`'s mock-seam pin green (it scans every
 * `.test.tsx?` file under `src/` for `vi.mock` of a `lib/tauri` module path;
 * the call text, which contains `vi.importActual`, stays in the test file).
 *
 * The only barrel binding this module needs — `listSkills` for
 * `waitForCatalog` — is INJECTED as a parameter rather than imported, so this
 * module's dependency graph stays free of `../lib/tauri`. `./fixtures` here
 * resolves to the barrel at `src/test/fixtures/index.ts`.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { AppSettings } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { makeSessionRow, makeSettings, makeSpaceRow } from "./fixtures";
```

Then, in order: `export const MONO_ADVANCE_EM`; `export const SETTINGS_FIXTURE`; `export function seedMcpMentionsOn`; `export function seedMcpMentionsOff`; `export const PERSISTED_MCP_MESSAGE`; `export function seedLiveSession`; `export function seedStoredSession`; `export function seedArchivedSession`; `export function seedLiveSessionWithImages`; `export function pasteToComposer`; `export function dropOnComposer`; `export async function flush`; `export function deferred`; `export async function waitForCatalog` (with the injected parameter).

`waitForCatalog`'s new signature — the ONLY body change in the whole move (the fixtures module imports `{ expect, vi }` from `"vitest"` so the body text stays identical to today's except the parameter line):

```ts
export async function waitForCatalog(
  listSkills: typeof import("../lib/tauri")["listSkills"],
): Promise<void> {
  await waitFor(() => expect(vi.mocked(listSkills)).toHaveBeenCalled());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
```

`vi.mocked(listSkills)` binds to the INJECTED parameter (typed as the real `listSkills` signature), not to any barrel import — the body's behaviour is identical to today's (`vi.mocked(listSkills)` on the mocked instance reaches the mock's call history). Why import `vi` at all: `vi.mocked(...)` needs the vitest object for its type-level mock-cast; importing `{ expect, vi }` in a non-mocking module is the same thing the seam test file itself does (`import { describe, expect, it, vi } from "vitest"`), and it costs a single import line in the new module while keeping the moved body byte-identical for the Step 11 gate.

`useSettings`-seeding note: `seedMcpMentionsOn`/`Off` call `useSettings.getState().setSettings(...)`, which the settings store implements as `set({ settings, loaded: true })` (verified in `src/store/settings.ts`) — the seeds' `{ ...SETTINGS_FIXTURE, mcpMentionsEnabled }` becomes the whole stored settings, unchanged from today.

`noUnusedLocals` in the fixtures module: every import must be used. `act` in `flush`/`waitForCatalog`; `fireEvent`+`screen` in `pasteToComposer`/`dropOnComposer`; `waitFor` in `waitForCatalog`; `expect`+`vi` in `waitForCatalog`; `makeSessionRow`/`makeSpaceRow` in the session seeds; `makeSettings` in `SETTINGS_FIXTURE`; `useSessions` in the session seeds; `useSettings` in the mention seeds; `AppSettings` in `SETTINGS_FIXTURE`'s annotation. All used — but the tsc gate (Step 9) is the final authority.

What the fixtures module does NOT import: `render`, `beforeEach`, `describe`, `it`, `beforeAll` — none are used. It does NOT import `../lib/tauri` as a value (by design — the injection decision; the `type { AppSettings }` import is type-only and vanishes at runtime). It does NOT call `vi.mock` ever.

**5. `src/test/chatStreamFixtures.test.ts` — new seam file, 7 tests.** It does NOT mock `../lib/tauri`: it asserts the moved helpers against the REAL stores (importing `useSessions`/`useSettings`, whose modules import the real `../lib/tauri` barrel — that import is side-effect-free at module scope; `src/lib/tauri.ts` is a re-export barrel with no top-level `invoke`, verified, and `src/test/fixtures.test.ts` already imports the same stores in a non-mocked file). That is the point of a seam file: prove the moved helpers are self-sufficient (they only mutate zustand stores). `waitForCatalog` is deliberately NOT exercised here (driven by the component suite's 19 call sites; see the note below), so the fixtures module's `listSkills` parameter remains a type-only concern in the seam. Two purposes: (a) pin the moved helpers' behaviour so the extraction is provably MOVED-not-rewritten; (b) pin the "no `vi.mock(` call may live in the fixture module" rule.

Test list (imports: `{ describe, expect, it, vi }` from `"vitest"`, `readFileSync` from `node:fs`, `fileURLToPath` from `node:url`, the fixtures module, `makeSessionRow`/`makeSpaceRow`/`makeSettings` from `./fixtures`, `useSessions`/`useSettings` from the stores, `resetStores` from `./resetStores`):

1. `it("seedLiveSession writes the exact live-session state")` — call `seedLiveSession()`, assert `useSessions.getState()`: `activeSessionId === "s1"`, `sessions` toEqual `[makeSessionRow({ sessionId: "s1", cwd: "/home/u/proj" })]`, `spaces` toEqual `[makeSpaceRow({ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1 })]`, `historySessions` toEqual `[]`, `messages` toEqual `{ s1: [] }`, and `inTurn`/`stopReasons`/`closeReasons`/`configOptions`/`compacting` each toEqual `{}`.
2. `it("seedStoredSession writes the stored-session state (no compacting key)")` — `seedStoredSession({ loadSession: true })`: assert `activeSessionId === "s1"`, `sessions` toEqual `[]`, `historySessions` toEqual `[makeSessionRow({ sessionId: "s1", cwd: "/home/u/proj", capabilities: { loadSession: true } })]`, and the NON-VACUOUS compaction tooth: `expect(useSessions.getState().compacting).toEqual({})` **and** `expect(Object.keys(useSessions.getState().compacting)).toEqual([])` — the seeded id must be ABSENT from any compaction bookkeeping. This is the vet-mandated strengthening: the store's initial state ALREADY has `compacting: {}` (verified at `src/store/sessions.ts`), so a bare `toEqual({})` passes even if a refactor dropped or renamed the field; `Object.keys(...)` reddens on a dropped/renamed key. (Hermetic reset first — see the note below.)
3. `it("seedArchivedSession writes the archived-session state")` — `seedArchivedSession({ loadSession: true })`: `activeSessionId === "s9"`, `archivedSessions` toEqual `[makeSessionRow({ sessionId: "s9", cwd: "/home/u/arch", capabilities: { loadSession: true }, archived: true })]`, `sessions` and `historySessions` both `[]`, `messages` `{ s9: [] }`.
4. `it("seedLiveSessionWithImages writes the image-capable live session")` — the row's `capabilities` toEqual `{ promptCapabilities: { image: true } }`, `activeSessionId === "s1"`, and `compacting` pinned as in test 1 (all five empty maps).
5. `it("seedMcpMentionsOn and seedMcpMentionsOff write the settings store")` — after `seedMcpMentionsOn()`: `useSettings.getState().settings?.mcpMentionsEnabled === true`; after `seedMcpMentionsOff()`: `false`. (The store's `settings` field is `AppSettings | null`; `setSettings` does `set({ settings, loaded: true })` — the seed's spread becomes the whole settings.)
6. `it("pins MONO_ADVANCE_EM, SETTINGS_FIXTURE, PERSISTED_MCP_MESSAGE")` — `MONO_ADVANCE_EM === 0.6`; `SETTINGS_FIXTURE` toEqual `makeSettings()` (the drift pin — a field added to the real type is a compile error here); `PERSISTED_MCP_MESSAGE.startsWith("query #postgres\n\n")` is true AND it contains `'<mcp name="postgres">'` and `"</mcp>"`.
7. `it("the fixture module never calls vi.mock (the seam must live in the test file)")` — `const src = readFileSync(fileURLToPath(new URL("./chatStreamFixtures.ts", import.meta.url)), "utf8");` then `expect(/^\s*vi\.mock\(/m.test(src)).toBe(false);`. (Mechanical pin of the load-bearing constraint. The regex is anchored to a line START, so the module header comment that mentions "`vi.mock`" cannot trip it — the comment line begins with ` * DO NOT call`; verify against the file after writing. Do NOT assert `vi.importActual` absence — nothing in this design references it in the fixtures module anyway.)

**Seam-test hermeticity note:** the seed tests mutate the zustand singletons. Before EACH seed test, reset the stores: a `beforeEach(() => { vi.clearAllMocks(); resetStores(); })` inside the seam `describe` covers all 7 (no timers, no caches involved). `resetStores()` (verified exported from `src/test/resetStores.ts`) restores each store to zustand's captured initial state — for `useSessions` that includes `compacting: {}` in the initial state (verified), which is exactly why test 2's `Object.keys(compacting)` tooth is meaningful: the initial state HAS the key; the assertion pins that the SEED does not add an id to it. `resetStores` does NOT reset `clientMessageSeq` (§3.1 of the report) — none of the seam tests touch message ids, so that limitation is irrelevant here.

**What the seam test does NOT cover** (deliberately): `pasteToComposer`/`dropOnComposer`/`deferred`/`flush`/`waitForCatalog` — those are driven by the 278 `ChatStream.test.tsx` tests themselves (call counts at HEAD `22f16d3a`, for orientation: `pasteToComposer` ~50 sites, `flush` 34–35, `deferred` 14, `waitForCatalog` 19; the runner's executed-count gate is what matters). A fixture-level pin would duplicate coverage without the component. (Calling them requires a mocked `listSkills`/RTL render that only the component suite provides meaningfully.)

**6. `ChatStream.test.tsx` prune list (exact, verified at HEAD, driven by `noUnusedLocals: true`):**

- DELETE line 50 wholesale: `import { makeSessionRow, makeSettings, makeSpaceRow } from "../test/fixtures";` (verified: those three names appear only at line 50 and inside the moved seed bodies — `makeSessionRow` at ~237/262/286/309, `makeSpaceRow` at ~238/260/283/315, `makeSettings` at ~67 — all gone after the move).
- REMOVE `AppSettings,` from the `type { ... }` import of `../lib/tauri` (line 40; verified: `AppSettings` appears only at line 40 and line ~67 — both gone after the move).
- KEEP (each verified to have uses below the first `describe` / outside the moved region): `useSettings` (~744, ~817), `useSessions` (140 hits — the moved seed bodies at ~234–319 use it AND the test bodies below the first `describe` use it extensively), `useQueuedPrompts` (the kept `beforeEach` loop plus block bodies — `getState().bySession`/`enqueue` reads in blocks 8/9/10/11), `useInteractive` (30), `usePermissions` (4), `useSubagents` (12 — child-gate block bodies). Do NOT prune any of these.
- The named-value `../lib/tauri` import (lines 4–14: `sendPrompt` … `respondPermission`, `type StopReason`) STAYS — the whole file uses `vi.mocked(...)` on those bindings (e.g. `vi.mocked(listSkills)` at ~3774, ~3828, ~3850, ~4063, ~4160, ~5697, ~7271).
- ADD the fixtures import (§3) right after the `resetStores` import.

**Steps** (TDD order — the seam file is created first as the failing spec):

**Step 0 — Baseline count (run FIRST, before any edit):** from the repo root, run `npx vitest run src/components/ChatStream.test.tsx` → expect the runner to print `278 passed` (that is the runner's own line; re-measure at the actual base — do not trust prose, including this plan's). WRITE DOWN the number. Do this before ANY edit.

**Step 1 — Write the failing seam spec** `src/test/chatStreamFixtures.test.ts` with the 7 tests above (importing from `./chatStreamFixtures`).

**Step 2 — Run** `npx vitest run src/test/chatStreamFixtures.test.ts` → must FAIL (module not found / no exports). Expected red. (If it unexpectedly passes — e.g. a stale cached module — investigate before continuing.)

**Step 3 — Create** `src/test/chatStreamFixtures.ts` per "What to implement": imports + the 14 exported names (constants → seeds → interaction helpers), bodies and comments moved verbatim, `waitForCatalog` with its injected `listSkills` parameter. No `vi.mock(` text.

**Step 4 — Run** `npx vitest run src/test/chatStreamFixtures.test.ts` → all 7 PASS. (If one fails, fix the seam-test expectation to match the module — the module is the authority, moved verbatim from the test file; do NOT change the moved bodies to satisfy a badly-spelled expectation.)

**Step 5 — Modify** `src/components/ChatStream.test.tsx`, anchored BY SYMBOL (never by the orientation numbers):
- DELETE the moved blocks: the `MONO_ADVANCE_EM` doc comment + constant; the `SETTINGS_FIXTURE` doc + constant; the two mention-seed doc comments + functions; the `PERSISTED_MCP_MESSAGE` doc + declaration; the four session-seed doc comments + functions; the `pasteToComposer` comment + function; and `dropOnComposer`, `flush`, `deferred`, `waitForCatalog` (each with its doc comment).
- KEEP, untouched: the import block (after the §6 prunes), the `beforeAll` comment + stubs, BOTH `vi.mock` blocks, the `beforeEach`, and everything from the first `describe(` onward.
- PRUNE per §6: delete the `../test/fixtures` import line and `AppSettings,` from the `type { ... }` import.
- ADD the fixtures import (§3) right after the `resetStores` import.
- Sanity check before running: the module scope must read, in order: imports → `beforeAll` → the two `vi.mock` blocks → `beforeEach` → first `describe`.

**Step 6 — Run the file alone:** `npx vitest run src/components/ChatStream.test.tsx` → expect `278 passed` (UNCHANGED). If the count differs, STOP and investigate (a moved body diverged, or a name binds differently) before continuing.

**Step 7 — Single-test sanity (moved-helper consumers):** `npx vitest run src/components/ChatStream.test.tsx -t "runs the configured spinner style"` (uses `SETTINGS_FIXTURE` + `useSettings`) and `npx vitest run src/components/ChatStream.test.tsx -t "the Flush: the queue drains when the Session goes idle"` (uses `flush`/`deferred`/`waitForCatalog`).

**Step 8 — Re-run the seam file:** `npx vitest run src/test/chatStreamFixtures.test.ts` → `7 passed`.

**Step 9 — Type-check:** `npx tsc --noEmit` (repo root) → no errors. If tsc names an unused import you kept, remove it (owned set).

**Step 10 — Cross-file guard:** `npx vitest run src/lib/tauriBarrel.test.ts` → expect the existing assertions to PASS UNCHANGED. Do NOT edit this file. If it fails, the call text or `vi.importActual` moved — restore them in `ChatStream.test.tsx` and redo Step 5.

**Step 11 — Byte-identity gate (the "nothing changed" proof):** for each moved symbol, diff the text removed from the test file against the text added in the fixtures module and require the ONLY deltas to be (a) the added `export ` keywords and (b) the `waitForCatalog` parameter line. Mechanical form, run from the repo root — no temp files: extract each moved block from the BASE (`git show b0071544:src/components/ChatStream.test.tsx`, which is byte-identical to HEAD in the scaffolding region — only two doc commits and the roadmap markdown changed since, verified) and from the new module, and `diff` the pair after inserting `export ` before each top-level symbol on the module side; a non-empty diff means a moved body changed — STOP and fix before continuing. (A precise way: for each symbol, `diff <(git show b0071544:src/components/ChatStream.test.tsx | awk '/^function seedLiveSession/,/^}/' …)` against `awk '/^export function seedLiveSession/,/^}/' src/test/chatStreamFixtures.ts` — the symbol anchor is the region delimiter on BOTH sides, so no line numbers are involved.) The gate is the combination of Step 6's executed-count equality AND this byte-identity — either alone is insufficient (a moved helper whose body subtly changed can still pass all 278; that is the hole this step closes).

**Step 12 — Whole frontend suite:** `pnpm test` (repo root) → all green.

**Step 13 — Post-count:** `npx vitest run src/components/ChatStream.test.tsx` → still `278 passed`. This equality (before/after) is part of the `done-when` proof that nothing was dropped.

**Step 14 — Build:** `pnpm build` (repo root; script is `tsc && vite build`) → success (type-check + vite bundle).

**Step 15 — Commit:** ONE commit `test: extract ChatStream test scaffolding into src/test/chatStreamFixtures.ts` containing exactly the three owned files and nothing else. (This task is not in a parallel wave; a serial task commits normally. There is no `**Parallel:**` line — see the Parallelisation verdict.)

**Acceptance criteria:**
- [ ] `src/test/chatStreamFixtures.ts` exists and exports exactly: `MONO_ADVANCE_EM`, `SETTINGS_FIXTURE`, `PERSISTED_MCP_MESSAGE`, `seedLiveSession`, `seedStoredSession`, `seedArchivedSession`, `seedLiveSessionWithImages`, `seedMcpMentionsOn`, `seedMcpMentionsOff`, `pasteToComposer`, `dropOnComposer`, `flush`, `deferred`, `waitForCatalog`. There is NO `createTauriMock`/`createDialogMock` anywhere (that design was vetted and abandoned — see the load-bearing constraint).
- [ ] The two `vi.mock` CALLS **and both factory bodies** remain VERBATIM at module scope in `src/components/ChatStream.test.tsx` — the tauri factory with its `vi.importActual` spread, all 17 overrides, and all internal comments; the dialog factory with its two comment lines. NO `vi.mock(` call text exists in `src/test/chatStreamFixtures.ts` — pinned by seam test 7.
- [ ] `src/lib/tauriBarrel.test.ts` passes UNCHANGED (its mock-seam pin still counts `src/components/ChatStream.test.tsx` — same set, same numbers; the call text and `vi.importActual` both stay in the `.test.tsx` file). Never restate the pinned numbers as values you maintain — quote 38/37 only in prose citing the assertion as the tree's values as of base `b0071544`.
- [ ] The order-critical `beforeEach` (the eight behaviours of §1.8) and the `beforeAll` environment stubs (§1.3: object-URL pair + three `HTMLElement.prototype` stubs) remain in `ChatStream.test.tsx` verbatim, untouched.
- [ ] Behaviour is moved, not improved: doc comments preserved; every moved body byte-identical; the ONLY allowed body change is `waitForCatalog` gaining its `listSkills` parameter (same body text otherwise); the cross-block `listSkills.mockResolvedValue` leak (mockClear semantics) is NOT "fixed" in this commit.
- [ ] The seam seed assertions are NON-VACUOUS: the `seedStoredSession` test asserts `Object.keys(useSessions.getState().compacting)` is `[]` (seeded id ABSENT), not merely `compacting` toEqual `{}`.
- [ ] `src/components/ChatStream.test.tsx` executed-test count is EXACTLY the same BEFORE and AFTER (gate: the vitest runner's `… passed` line on the base and on the result; measured 278 at HEAD `22f16d3a`, re-measure at base).
- [ ] The byte-identity gate (Step 11) shows the ONLY deltas between the removed and added text are the added `export ` keywords and the `waitForCatalog` parameter line.
- [ ] `src/test/chatStreamFixtures.test.ts` passes (7 tests) and pins: the four session seeds' exact store state, the two settings seeds' flag, the three constants, the "no `vi.mock(` in the fixture module" rule, and the absolute-absence compaction assertions.
- [ ] `npx tsc --noEmit`, `pnpm test`, and `pnpm build` all pass from `/home/daniel/Coding/AI/archimedes-desktop`.
- [ ] ONE commit, three files, nothing else; message `test: extract ChatStream test scaffolding into src/test/chatStreamFixtures.ts`. No `src/components/ChatStream.tsx`, no `src/lib/chatSessionDerivations.ts`, no `src/hooks/useChatSessionDerivations.ts`, no `src/lib/tauriBarrel.test.ts` in the commit.

**Exact commands** (all from `/home/daniel/Coding/AI/archimedes-desktop`):

| What | Command |
|---|---|
| This file's tests alone | `npx vitest run src/components/ChatStream.test.tsx` |
| New seam file alone | `npx vitest run src/test/chatStreamFixtures.test.ts` |
| A single test by name | `npx vitest run src/components/ChatStream.test.tsx -t "runs the configured spinner style"` (substring of an `it(`/`describe(` name) |
| The cross-file guard | `npx vitest run src/lib/tauriBarrel.test.ts` |
| Raw `it(`-line shape (reference only — NEVER a gate) | `grep -cE "^\s*it\(" src/components/ChatStream.test.tsx` (275 at HEAD; one is `it.each` with 3 rows; the executed count is the runner's line, not this grep) |
| Byte-identity gate | block-by-block `diff` of removed vs. added text (Step 11) |
| Type-check without bundling | `npx tsc --noEmit` |
| Whole frontend suite | `pnpm test` |
| Type-check + build | `pnpm build` (script is `tsc && vite build`) |

(There is no dedicated `typecheck` script in `package.json` — verified; `pnpm build` is the AGENTS.md-validated type-check+build; `npx tsc --noEmit` is the fast type-check-only form. Rust side is irrelevant to this task.)

**UNVERIFIED items (for the caller's vet):**
- UNVERIFIED (environment): the baseline run `npx vitest run src/components/ChatStream.test.tsx` → `278 passed` was measured by me at HEAD `22f16d3a` (a superset of base `b0071544` — only two doc commits and the two roadmap markdown files differ since; zero `src/` changes in between; `git status` shows only the two roadmap doc files modified). The implementer MUST re-run the baseline at the actual base before editing.
- UNVERIFIED (byte-identity gate form): Step 11's `awk`/`diff` form is illustrative but executable; the exact region delimiters are the symbol anchors, which the implementer derives at execution time (numbers are explicitly NOT anchors). If the vet wants a tighter script, derive it in the vet — this is a plan, not a script.
- UNVERIFIED (seam-test file-open form): `readFileSync(fileURLToPath(new URL("./chatStreamFixtures.ts", import.meta.url)), "utf8")` is the named form; fallback is `tauriBarrel.test.ts`'s plain `readFileSync` with a repo-relative path (it has a `relPath` helper). If the `node:url` import trips the build, use that convention.
- UNVERIFIED (module-side-effect-freeness of `../lib/tauri` for the seam file's imports): I confirmed `src/lib/tauri.ts` is a re-export barrel with no top-level `invoke`, and non-mocking test files already import the same stores (e.g. `src/test/fixtures.test.ts` imports `useSessions` from `../store/sessions`), but I did not run the seam file (it does not exist yet). The design (seam file does NOT `vi.mock` the barrel) relies on that; if the first seam run hits a real IPC call, mock `../lib/tauri` in the seam file with the standard `vi.mock("../lib/tauri", async () => { const actual = await vi.importActual(…); … })` pattern — legal inside a `.test.ts` — and re-check the barrel guard (the seam file would then count as a mocker, so the pinned numbers would have to move in the same commit with the barrel file's own comment saying so; prefer the no-mock design first).
- UNVERIFIED (exact line anchors at the actual base): all line numbers in this plan are HEAD `22f16d3a` orientation only, marked `~`; the implementation anchors BY SYMBOL. The `beforeEach` boundary (~403) and first `describe` (~443) were verified at HEAD.

**Sources:**
- `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md` — the grounding report; its appendix "`vi.mock` hoisting probe matrix" is the measurement that decides the corrected architecture (read it first).
- `src/components/ChatStream.test.tsx` — the scaffolding block (lines 1–441), the two `vi.mock` factories (§1.4/§1.5), the seed/interaction helpers (§1.6/§1.7), the `beforeEach` (§1.8), the 11 `describe` headers, the Flush leak comment (§3.3).
- `src/test/fixtures/index.ts`, `settings.ts` — the barrel, `makeSettings`, the hoisting rule.
- `src/test/resetStores.ts` — `resetStores`/`resetModuleFlags` and the "THREE THINGS THIS DOES NOT DO" note.
- `src/store/settings.ts`, `src/store/sessions.ts` — the stores the fixtures module imports; both import `../lib/tauri` (the transitive path that makes delegation fail, and that this design renders harmless).
- `src/lib/tauriBarrel.test.ts` — the mock-count and `vi.importActual` assertions (the authority for 38/37, cited never restated as maintained); `src/lib/tauri.ts` — the re-export barrel.
- `package.json`, `vite.config.ts`, `tsconfig.json` — scripts and compiler flags (`noUnusedLocals: true` verified).
- `AGENTS.md` — the "Properties of the repo" mock-seam and suite-order bullets, the Build & Testing table.
