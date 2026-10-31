---
feature: chatstream-decomposition
area: frontend-test-scaffolding
file: src/components/ChatStream.test.tsx
status: grounding-report
branch: feature/chatstream-decomposition
base: b0071544
---

# Grounding report — `ChatStream.test.tsx` module-level scaffolding and the frontend test infrastructure it depends on

Area: `src/components/ChatStream.test.tsx` (7,885 lines; 11 top-level `describe` blocks; 275 `it(` cases, one of which is an `it.each` with 3 rows) plus the shared test infrastructure (`src/test/setup.tsx`, `src/test/resetStores.ts`, `src/test/fixtures/`, `src/lib/tauriBarrel.test.ts`, `AGENTS.md`).

Purpose: the roadmap task that extracts this file's module-level scaffolding into a shared fixture module (so the file can be split by domain) must know exactly what the scaffolding is, which failure mode it protects against, what can and cannot be reset, and which repo-wide assertions pin counts that would silently break extraction.

---

## 1. The module-level scaffolding block (from the first line to the first `describe` at the top level)

The file's module level spans the top of the file to line 441; the first top-level `describe` opens the 443 (inside its body, one **nested** `describe` sits at 5667 — "the picker's two filters …", with 4 tests, and there are no other nested blocks; closing lines are not part of the scaffolding block). All symbol names below are pinned by name, not line number.

### 1.1 Imports (in file order, line 1 – line 51)

```ts
import { beforeEach, describe, expect, it, vi, beforeAll, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ChatStream from "./ChatStream";
import {
  sendPrompt,
  resumeSession,
  readClipboardImage,
  readFileBytes,
  cancelSession,
  compactSession,
  listSkills,
  listMcpServersEffective,
  listAgentDefinitionsForSpace,
  listSpaceListing,
  listCompletionEntries,
  respondInteractiveRequest,
  respondPermission,
  type StopReason,
} from "../lib/tauri";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSubagents } from "../store/subagents";
import { useSettings } from "../store/settings";
import {
  brailleLoaderVariants,
  generateFrames,
  getVariantGridSize,
} from "../lib/braille-loader";
import {
  MIN_INDICATOR_WIDTH_CLASS,
  MIN_INDICATOR_WIDTH_PX,
} from "./chat/WorkingIndicator";
import type {
  AgentDefinitionDto,
  AppSettings,
  CompletionDirDto,
  CompletionEntryDto,
  ListingDto,
} from "../lib/tauri";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import * as chatAttachments from "../lib/chatAttachments";
import { activeMentionToken, isOutsideSpaceQuery } from "../lib/skills";
import { IPC_EVENTS } from "../lib/ipc/events";
import { MAX_CHAT_ATTACHMENTS, type ChatComposerAttachment } from "../lib/chatAttachments";
import { makeSessionRow, makeSettings, makeSpaceRow } from "../test/fixtures";
import { resetStores } from "../test/resetStores";
```

Notes the extractor must keep true:

- `../lib/tauri` is imported as a **named-value** import (used by `vi.mocked(...)` across the whole file), not a namespace import.
- `"@tauri-apps/plugin-dialog"` arrives under the alias `open as openFilePicker`.
- `chatAttachments` is a **namespace** import (`* as chatAttachments`), while `MAX_CHAT_ATTACHMENTS`/`ChatComposerAttachment` come as a separate named import from the same module.
- The fixture helpers come from `../test/fixtures` (the barrel), exactly three names: `makeSessionRow`, `makeSettings`, `makeSpaceRow`.

### 1.2 Module-level `const`s

- `const MONO_ADVANCE_EM = 0.6;` — the monospace advance used to convert a braille grid's cell count into px (the `WorkingIndicator` floor is checked against an **independent** statement of the arithmetic).
- `const SETTINGS_FIXTURE: AppSettings = makeSettings();` — the doc comment above it records that "this file's 22-field literal was byte-identical to `DEFAULT_SETTINGS`, which is the drift `src/test/fixtures/settings.ts` exists to make a compile error instead of a silent copy."
- `const PERSISTED_MCP_MESSAGE = "query #postgres\n\n" + '<mcp name="postgres">' + '\nThe user has explicitly named the MCP server "postgres" for this' + '\nrequest. Connect to it via the mcp tool (mcp({ connect: "postgres" }))' + "\nand use its tools. (Server summary: npx -y x-mcp.)" + "\n</mcp>";` — the `<mcp>` block a PERSISTED message carries when the `#` trigger was on.

### 1.3 `beforeAll` — the environment stubs this file keeps on top of `src/test/setup.tsx`

There is exactly one `beforeAll`, preceded by a long comment explaining what was DELETED here by "the rolling B4a migration" (the `matchMedia` `stubGlobal` and four `Element.prototype` stubs are now byte-equivalent to what `src/test/setup.tsx`'s own `beforeAll` installs; they were removed because this file calls no `vi.unstubAllGlobals()`), and why the rest are **not** redundancy:

```ts
beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
```

The comment's explanation for the kept half, verbatim:

> KEPT, and neither is redundancy:
>  - the object-URL pair: `setup.tsx` stubs no `URL` API, and staged
>    attachments need a deterministic `blob:` URL (Node's global `URL` reaches
>    jsdom but rejects web `Blob`s).
>  - the THREE `HTMLElement.prototype` stubs: `setup.tsx` puts `scrollIntoView`
>    on `Element.prototype` only, and two tests below read
>    `HTMLElement.prototype.scrollIntoView` directly and inspect
>    `mock.contexts` to learn WHICH picker row scrolled. Without this own-property
>    override that read is `undefined` and the calls land on the inherited
>    `Element` stub — so this is a dependency, not a duplicate.

### 1.4 The `vi.mock("../lib/tauri", …)` factory — verbatim; this is the seam every extracted hook test needs

```ts
// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "s2",
      cwd: "/home/u/proj",
      capabilities: {},
      archived: false,
    }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true, promptCapabilities: { image: true } },
      archived: false,
    }),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    readClipboardImage: vi.fn().mockResolvedValue(null),
    readFileBytes: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // The `/compact` Composer command (ADR 0044). MOCKED ON PURPOSE, and not
    // optional: this factory spreads `importActual`, so an un-mocked
    // `compactSession` would reach the REAL `invoke` and reject on jsdom's
    // missing `window.__TAURI_INTERNALS__` — a dispatch test would then "pass"
    // on the rejection landing in `send()`'s `catch` rather than on the
    // interception. `true` = "the frame was written" (the live answer).
    compactSession: vi.fn().mockResolvedValue(true),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "debug",
        description: "Debug a failure",
        path: "/s/.agents/skills/debug/SKILL.md",
        dir: "/s/.agents/skills/debug",
        scope: "space",
        body: "Step 1. Step 2.",
        shadowed: [],
      },
      {
        name: "beta",
        description: "Beta skill",
        path: "/s/.agents/skills/beta/SKILL.md",
        dir: "/s/.agents/skills/beta",
        scope: "space",
        body: "B body",
        shadowed: [],
      },
    ]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([
      {
        name: "scout",
        description: "Fast recon.",
        model: null,
        scope: "user",
      },
    ]),
    listMcpServersEffective: vi.fn().mockResolvedValue([
      {
        name: "postgres",
        kind: "stdio",
        summary: "npx -y x-mcp",
      },
    ]),
    // The `?` File-completion listing (ADR 0033). Mocked because EVERY
    // session-mounting test in this file calls it (the catalog hook fetches
    // unconditionally), and the `?` tests need to control the payload per
    // test — including a DEFERRED promise for the in-flight case. Empty by
    // default so the pre-existing `$`/`@`/`#` tests see no file rows.
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    // The out-of-Space Directory completion rows (ADR 0035). Mocked for the
    // same reason as `listSpaceListing`, and it is NOT optional: the composer
    // calls `useCompletionDir(null)` on EVERY mount (an empty draft has no
    // token, so `dirPrefix` is `null` and the cache misses), so an un-mocked
    // export — this factory spreads `importActual` — would fire a REAL
    // `invoke` in jsdom, reject on the missing `window.__TAURI_INTERNALS__`
    // and log a `listCompletionEntries failed:` line in every
    // session-mounting test in this file.
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});
```

Sixteen named overrides: `startSession`, `closeSession`, `sendPrompt`, `resumeSession`, `respondPermission`, `respondInteractiveRequest`, `setSessionConfigOption`, `readClipboardImage`, `readFileBytes`, `cancelSession`, `compactSession`, `loadHistory`, `listSkills`, `listAgentDefinitionsForSpace`, `listMcpServersEffective`, `listSpaceListing`, `listCompletionEntries` — that is 17 with the closing entry; the verbatim factory above is the count's authority.

Fixture data pinned *inside* the factory: the two skills (`debug`, `beta`), one agent definition (`scout`), one MCP server (`postgres`).

### 1.5 The `vi.mock("@tauri-apps/plugin-dialog", …)` factory — verbatim

```ts
// The native file picker (the `+` button's `open` — the real module would
// `invoke` Tauri's dialog plugin, which doesn't exist in jsdom).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
```

A **closed** factory (no `importActual`): the only export is the mocked `open`. Tests reach it as `vi.mocked(openFilePicker)`, and per-test `mockResolvedValueOnce(["/home/u/pics/shot.png"])` calls appear in the attachment-staging blocks (see §4/§5 for which blocks).

### 1.6 The seed helpers — exact signatures and body (all `useSessions.setState({...})` mutations, real stores; only the IPC is mocked)

```ts
function seedLiveSession(): void
```
```ts
function seedStoredSession(
  capabilities: Record<string, unknown> = {},
): void
```
```ts
function seedArchivedSession(
  capabilities: Record<string, unknown> = {},
): void
```
```ts
function seedLiveSessionWithImages(): void
```
```ts
function seedMcpMentionsOn(): void
```
```ts
function seedMcpMentionsOff(): void
```

Documented semantics (from the doc comments, verbatim in substance):

- `seedLiveSession` — "Seed a live session (fresh transcript) in the sessions store"; sets `activeSessionId: "s1"`, `sessions: [makeSessionRow({ sessionId: "s1", cwd: "/home/u/proj" })]`, `spaces: [makeSpaceRow({ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1 })]`, `historySessions: []`, `messages: { s1: [] }`, `inTurn: {}`, `stopReasons: {}`, `closeReasons: {}`, `configOptions: {}`, `compacting: {}`.
- `seedStoredSession(capabilities = {})` — "Seed a STORED (non-live) session: `sessions` is empty, the session lives in `historySessions` (so `isLive` is false). `capabilities` defaults to `{}` (history-only); pass `{ loadSession: true }` for the resumable case." (No `compacting` key in this one.)
- `seedArchivedSession(capabilities = {})` — "Seed a session that lives ONLY in `archivedSessions` (opened from the Archived section)"; `activeSessionId: "s9"`, the row carries `archived: true`.
- `seedLiveSessionWithImages()` — same as `seedLiveSession` but the row's `capabilities` is `{ promptCapabilities: { image: true } }` ("the image-attachment capability gate — fail-closed otherwise").
- `seedMcpMentionsOn()` / `seedMcpMentionsOff()` — both write `useSettings.getState().setSettings({ ...SETTINGS_FIXTURE, mcpMentionsEnabled: true | false })`. "The trigger is OFF by default (it collides with pasted developer text), so every test that exercises the shipped `#` behavior opts in explicitly."

### 1.7 The interaction helpers — exact signatures and bodies

```ts
function pasteToComposer(
  files: File[],
  extra: { text?: string; html?: string } = {},
): boolean
```
Uses `fireEvent.paste(target, { clipboardData: { items: files.map(...), getData: ... } })`, where each `items` entry is `{ kind: "file", type: f.type, getAsFile: () => f }` and `getData` returns `extra.text` for `"text/plain"` or `extra.html` otherwise. The comment explains: "jsdom has no `DataTransfer`, so the plain `clipboardData` object is attached as-is… `files` is EMPTY in real webviews (WebKit/WebView2), so the stub mirrors that — it builds `items` (NOT `files`)". Returns the boolean `fireEvent.paste` returns.

```ts
function dropOnComposer(files: File[]): void
```
Uses `fireEvent.drop(target, { dataTransfer: { files } })` on the single composer textbox.

```ts
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
```
"A promise that has NOT settled yet, plus its resolvers — the shape an in-flight IPC has."

The remaining module-level helpers that should travel with the scaffolding rather than be re-invented per file:

```ts
async function flush(): Promise<void>
```
"Flush the microtask queue" — `await act(async () => { await Promise.resolve(); })`.

```ts
async function waitForCatalog(): Promise<void>
```
"Wait for the skill catalog to load AND render" — `await waitFor(() => expect(vi.mocked(listSkills)).toHaveBeenCalled()); await act(async () => { await new Promise((r) => setTimeout(r, 0)); })` (a macrotask wait so every pending microtask in the `setRows` chain has landed).

### 1.8 The module-level `beforeEach` — verbatim behavior list

```ts
beforeEach(() => {
  // Restore real timers in case a previous test installed fake ones ...
  vi.useRealTimers();
  setSidePaneCollapsed(false);
  localStorage.clear();
  // The prompt queue is a module singleton too — drop every entry ...
  // BEFORE `clearAllMocks` so the URL releases this cleanup performs are not
  // counted against the revocation assertions in the queue tests.
  for (const id of Object.keys(useQueuedPrompts.getState().bySession)) {
    useQueuedPrompts.getState().clearSession(id);
  }
  // `clearAllMocks` clears the call history (the `URL` stub implementations
  // from `beforeAll` survive — `mockClear` semantics, not `mockReset`).
  vi.clearAllMocks();
  // The skill catalog's module-level cache is shared across tests in this
  // file — clear it so each test starts with a COLD cache ...
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  // Every store back to zustand's own captured initial state (the rolling
  // migration). ...
  // The queued-prompt loop ABOVE still runs first and is NOT redundant: its
  // `clearSession` releases staged object URLs, a side effect a state replace
  // cannot perform.
  resetStores();
});
```

Order matters and is documented as deliberate: (1) `vi.useRealTimers()` (three tests a few-hundred lines in use `vi.useFakeTimers()`; a leaked fake timer is the hazard being undressed **before** each test now), (2) `setSidePaneCollapsed(false)`, (3) `localStorage.clear()`, (4) the queued-prompt `clearSession` loop — before mock clearing so URL releases are not counted against revocation assertions, (5) `vi.clearAllMocks()` (mockClear semantics — the `beforeAll` `URL` stubs survive; persistent `mockResolvedValue`s set with `…Value` in earlier tests **do** survive into later tests — see §3's cross-block leak), (6) `clearSkillCatalogCache()` + `clearMentionCatalogsCache()`, (7) `resetStores()`.

This file has **no `afterEach`**.

---

## 2. The AGENTS.md hazard, and which failure mode THIS file's mock protects against

The repo rule lives in `AGENTS.md` (the "Properties of the repo" section), verbatim:

> **A boot fetch that `src/App.test.tsx` does not mock reddens tests that have
> nothing to do with it.** That file's `vi.mock("./lib/tauri")` factory spreads
> `importActual`, so an un-mocked export resolves to the real wrapper, which
> rejects outside a webview; the boot `Promise.all` rejects and its `.catch`
> swallows the reason. Measured by deleting one boot mock: **3 of the file's 41
> tests fail and only one names the fetch** — the other two are Settings /
> start-failure cases that merely need a booted store and fail on
> `activeSpacePath: null`. When `App.tsx` gains a boot fetch, add its mock in the
> same commit.

**Determination for `ChatStream.test.tsx`: it spreads `importActual` — it is an OPEN factory, not a closed one** (`const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri"); return { ...actual, … }`). Therefore an un-mocked name resolves to the REAL wrapper, which `invoke`s and rejects outside a webview (`window.__TAURI_INTERNALS__` missing). **It is not the `undefined` failure mode** (that one belongs to the single closed factory in the tree, `hooks/useWindowMaximized.test.ts` — see §7). So the planner is protecting against **"a missing mock name lands as a rejecting real wrapper"** — the failure `src/App.test.tsx` is famous for, and the failure the factory's own comments name twice ("this factory spreads `importActual`, so an un-mocked `compactSession` would reach the REAL `invoke` and reject…" and the same sentence for `listCompletionEntries`). Two further consequences recorded in the factory comments: an un-mocked name is not a hard failure but a **soft, misleading one** — a dispatch test "passes" because the rejection is swallowed by `send()`'s `catch` (`compactSession` comment), and the `listCompletionEntries` case would "log a `listCompletionEntries failed:` line in every session-mounting test" while still passing.

The old `#`-trigger-picker combine: the `#` (MCP) **display** is not gated (a persisted `<mcp>` block renders its chip with the trigger OFF — `PERSISTED_MCP_MESSAGE`'s whole reason to exist), only **expansion** is gated. The `?` file listing (`listSpaceListing`, ADR 0033) is mocked "because EVERY session-mounting test in this file calls it"; the out-of-Space directory completion (`listCompletionEntries`, ADR 0035) is mocked because the composer calls `useCompletionDir(null)` on EVERY mount.

---

## 3. Store reset discipline

### 3.1 What `src/test/resetStores.ts` cannot reach — quoted

From its header, verbatim:

> THREE THINGS THIS DOES **NOT** DO — read these before trusting it.
>
>  1. It does not MERGE. `zustand`'s `setState` SHALLOW-MERGES by default, so a
>     reset written as `setState({ sessions: [] })` leaves every other dirty key
>     standing. …
>
>  2. It does not touch MODULE-SCOPE state, because it cannot: a module `let`
>     is not store state. `src/store/sessions.ts` holds four of them —
>     `inFlightToggles` (`:598`), `committedTrusted` (`:606`),
>     `newSessionInFlight` (`:612`) and `clientMessageSeq` (`:620`) — and none
>     is exported, so nothing outside that file can reach them. The name is
>     therefore deliberately `resetStores`, not `resetGlobalState`: a test that
>     needs one of those cleared needs a named reset exported from
>     `sessions.ts`, which is a change to the store, not to this file.
>     `src/test/fixtures.test.ts` pins the limitation with a live check on
>     `clientMessageSeq`, so the name cannot quietly promise more than it does.
>
>  3. It does not reset the pane/dialog flags — those are the module-scope
>     state that IS reachable, and they get their own named function,
>     `resetModuleFlags()` below. …

`resetModuleFlags()` restores `leftPaneState`, `sidePaneState` and `newSpaceDialogOpen` to their import-time values (the pane flags seed from `localStorage` at import, so "clean" means "the value at import", not `false`), and its own comment notes "NOT covered: the `listeners` sets these three modules hold."

### 3.2 What `ChatStream.test.tsx`'s `beforeEach` resets

§1.8 verbatim: `vi.useRealTimers()`, `setSidePaneCollapsed(false)`, `localStorage.clear()`, the `useQueuedPrompts.getState().clearSession(id)` loop, `vi.clearAllMocks()`, `clearSkillCatalogCache()`, `clearMentionCatalogsCache()`, `resetStores()`. It does NOT call `resetModuleFlags()` (only `setSidePaneCollapsed(false)`, which is the same value that helper would write — the left pane flag and the `newSpaceDialogOpen` flag are simply not touched by this file).

### 3.3 Which `describe` blocks do NOT call `resetStores()`

**None — every line starting `describe(` in the file is a `describe` with no `beforeEach`, `beforeAll`-reset, or `afterEach` of its own**; the file's ONE `beforeEach` (module-level, §1.8) runs before every test in every block and calls `resetStores()` in every block by construction. There is no `afterEach` anywhere in the file. So the literal AGENTS.md phrasing — "Many `describe` blocks … never call `resetStores()`, so they inherit whatever a previous block left" — does **not** apply to this file at the block level.

BUT there is a **within-suite order dependence actually present in this file**, and the extractor must know it: `vi.clearAllMocks()` uses `mockClear` semantics, so a **persistent** (`mockResolvedValue`, not `…Once`) mock override installed in one block survives into every LATER test in the file. The file's own comment, at the Flush block, names an existing instance and the containment habit:

> RE-SEEDED HERE, and only here, because of a PRE-EXISTING leak this test
> is the first to step in: the picker-filter describe above calls
> `listSkills.mockResolvedValue([skill-manager, …])` — PERSISTENT, not
> `…Once` — and the file's `beforeEach` uses `clearAllMocks()`, which drops
> the CALL HISTORY but keeps the IMPLEMENTATION. Every other
> expansion-asserting test sits EARLIER in the file, so it never sees the
> override; a new one appended at the bottom does, and `$debug` would then
> match nothing and be sent verbatim.

(The author of that comment is the nested "the picker's two filters" `describe`, whose `listSkills.mockResolvedValue([skill-manager, …])` call is the leak.) The extractor's per-block isolation design must treat "tests earlier in the file never see the override" as a **file-order fact that a by-domain split either reproduces per-file or fences with `…Once`**.

Also recorded in-suite: the comment in §1.3 explains why the B4a cleanup deleted this file's `matchMedia` stub but says a `vi.unstubAllGlobals()` call — present in exactly four files — is "the ONLY thing that strips a setup-file `stubGlobal`" (that list of four, from `src/test/setup.tsx`'s guard list: `components/chat/EmptyStateFilm.test.tsx`, `lib/theme.test.ts`, `lib/archimedes-film/compositor.test.ts`, `lib/settings.test.ts`).

---

## 4. The fixture helpers available from `src/test/fixtures` (reuse, don't reinvent)

The barrel is `src/test/fixtures/index.ts`, exporting exactly:

```ts
export { DEFAULT_SETTINGS, makeSettings } from "./settings";
export {
  makeConfigOption,
  makeConfigSource,
  makeMessage,
  makeSessionRow,
  makeSpaceRow,
} from "./sessions";
export { makeSubagentEntry, makeSubagentState } from "./subagents";
```

Signatures and semantics (from `src/test/fixtures/*.ts`):

- `makeSessionRow(overrides: Partial<SessionInfo> = {}): SessionInfo` — defaults `sessionId: "s1"`, `cwd: "/w/space"` (`DEFAULT_CWD`), `capabilities: {}`, `archived: false`; the four OPTIONAL wire keys (`title`, `contextUsage`, `configOptions`, `costUsd`) stay ABSENT unless asked; an explicitly-`undefined` optional key is deleted.
- `makeSpaceRow(overrides: Partial<SpaceRow> = {}): SpaceRow` — defaults `path: "/w/space"`, `createdAt: 1_000`, `lastOpenedAt: createdAt` (`createdAt <= lastOpenedAt` maintained by construction), `trusted: false`.
- `makeSettings(overrides: Partial<AppSettings> = {}): AppSettings` — a complete 22-field `AppSettings`; **every nested object is REBUILT per call** (a spread would share references). `mcpMentionsEnabled` defaults to `false`; `sessionNamingEnabled` to `true`; `palette: null` ("zai").
- `DEFAULT_SETTINGS: AppSettings` — the whole default document, exported for `toEqual`-style assertions; pinned to the type so a field added to the real type is a compile error here.
- `makeMessage<K extends Message["kind"]>(kind?: K, overrides?: Partial<Extract<Message, { kind: K }>>): Extract<Message, { kind: K }>` — one flat factory keyed by the discriminated-union `kind`, `at` defaults to fixed stamp `1_000`.
- `makeConfigSource(overrides: Partial<SessionConfigSource> = {}): SessionConfigSource` and `makeConfigOption(overrides: Partial<SessionConfigOption> = {}): SessionConfigOption` — the three-list walk inputs (`configOptions`, `contextUsage`, `sessions`, `historySessions`, `archivedSessions`) and one select option.
- `makeSubagentEntry(overrides: Partial<SubagentEntry> = {}): SubagentEntry` — defaults to a RUNNING child (`sessionId: "child-1"`, `parentSessionId: "s1"`, `agentName: "scout"`, `status: "running"`, `startedAt: 1_000`); close-stamp/metrics keys absent unless asked. `makeSubagentState(entries: readonly SubagentEntry[] = []): { entries: Record<string, SubagentEntry> }`.

Hoisting rule the extractor MUST carry (from `settings.ts`, verbatim): **"there is NO `renderWithProviders` HERE, and that is a decision"** (barrel header) — do not invent one; and the barrel's header says inside a `vi.mock` factory the fixtures "MUST be reached with `await import()` instead (the factory is hoisted above this file's import)". `ChatStream.test.tsx` imports the three fixtures at module level and uses them only OUTSIDE `vi.mock` factories, so that rule does not bite here today — but an extracted fixture module that is imported from inside a `vi.mock` factory must use the dynamic-import form.

There is also `src/test/setup.tsx` (the shared environment): `react-virtuoso` wrapper (`VirtuosoMockWrapper`, strips `initialTopMostItemIndex`), `Element.prototype.scrollBy`/`scrollTo` fallbacks, and the `beforeAll` stubs `matchMedia` (`matches: false`), `Element.prototype.scrollIntoView`, and the pointer-capture trio — plus the four-file `vi.unstubAllGlobals()` guard list quoted in §3.3. `ChatStream.test.tsx`'s own `beforeAll` adds the object-URL pair and the `HTMLElement.prototype` trio on top (§1.3).

---

## 5. Per-`describe` ownership map

All 11 top-level `describe` blocks, exact name strings, test counts (count of `it(` lines in the block slice, including each block's `it.each` as one line; at `b0071544`), inner helpers, and the future home each belongs in. The four future homes are: **attachment staging** (image staging, staging markers, restore, staging-in-flight), **prompt dispatch / queue flush** (send, Esc-cancel, mentions expansion, queue, flush), **session derivations** (session-kind-hint derivations, interactive-state rendering, compacting row, working indicator), **integration-wiring** (picker `/ ?` `$` `@` `#` wiring, catalog wiring, child gates, empty-state binding). Where a block lean that this report names is a judgment call, the evidence — actual `it(` names — is quoted so later splits can be argued from it.

| # | Exact name string | `it(` count | Inner helpers the block declares | Future home |
|---|---|---|---|---|
| 1 | `"ChatStream"` | 170 | (uses module helpers only) | **split across all four** — it is the undifferentiated mass: session-kind/hint derivations, interactive-state and working-indicator rendering, compacting row, send/Esc dispatch (the "Esc while a turn is in flight calls cancelSession" family), capabilities, paste/drop staging and the send-with-attachments family, mentions expansion (`$ @ #`), the picker keyboard/`?` listings family, the `it.each` "$prefix picker is UNCAPPED" cap tests |
| 2 | `"ChatStream — out-of-Space Directory completion (ADR 0035)"` | 34 | `rowByPrimary(text): Promise<HTMLButtonElement>`, `completionQueries(): (string \| null)[]`, `directoryFetches(): string[]`, `routeCompletion(table: Record<string, CompletionEntryDto[]>, truncated = false): void` | **integration-wiring** (directory-completion wiring — its own `listCompletionEntries` fetches, deferred-in-flight Enter gating) |
| 3 | `"ChatStream (a child gate renders inline in the PARENT's transcript)"` | 16 | `const childEntry` (`sessionId: "sub1", parentSessionId: "s1", agentName: "reviewer"`…), `const askChild = (question = "Which color?")`, `askRequestPayload(requestId, question)` | **integration-wiring** (child-gate rendering — inline `ask`/Permission cards, child-session answers, `confirm`/`password` staying in overlay) |
| 4 | `"ChatStream (a child gate scrolls into view)"` | 3 | `const FAKE_SCROLL_HEIGHT = 1234`, `watchScrollWrites(): { writes(): number; lastValue(): number \| undefined; reset(): void }` (defines `scrollHeight`/`scrollTop` on `transcript-scroll`) | **integration-wiring** (child-gate scroll effect) |
| 5 | `"ChatStream — the /compact Composer command (ADR 0044)"` | 7 | (module helpers only) | **prompt dispatch / queue flush** (the `/compact` interception — sits before the send tail) |
| 6 | `"ChatStream — the [image #N] staging marker"` | 18 | `composerValue(): string` (the textarea's `.value`) | **attachment staging** |
| 7 | `"ChatStream — the failed-send attachment restore"` | 2 | `composerValue()`, `composerThumbs(): string[]` (reads `[data-testid="composer-island"]` img alts left-to-right), `const png = (name: string, byte: number): File` | **attachment staging** (restore renumbers markers, MAX_CHAT_ATTACHMENTS cap) |
| 8 | `"ChatStream — send() forks to the prompt queue while the composer is locked"` | 9 | `composerValue()`, `composerThumbs()`, `queue(sessionId = "s1")` (reads `useQueuedPrompts` `bySession`), `png` | **prompt dispatch / queue flush** |
| 9 | `"ChatStream — the Flush: the queue drains when the Session goes idle"` | 13 | `queue()`, `enqueue(text, over: { id?: string; attachments?: ChatComposerAttachment[] })` (store `enqueue` directly), `queuedAttachment(name, objectUrl): ChatComposerAttachment` (store shape, NOT the factory), `runTurnAndSettle(): Promise<void>` (`beginTurn` + `turnCompleted` + `flush()`), and the file's only nested `describe` — `"the picker's two filters (substring for Mentions, subsequence for both ? arms)"` with its 4 tests (the `skill-manager`/`deploy` discriminator/control pair) | **prompt dispatch / queue flush** (the queue-flush kernel) |
| 10 | `"ChatStream — staging attachments is allowed while a turn is in flight"` | 4 | `composerThumbs()`, `queue()`, `png`, `lockWithTurn(): Promise<void>` (`beginTurn`, the store's ground truth) | **attachment staging** (the `+`-picker/drop-while-locked family) |
| 11 | `"ChatStream — the empty-state film beside a non-empty prompt queue"` | 2 | (module helpers only; probes `main`/`transcript-scroll`/`queue-rows` DOM adjacency with the film's `absolute inset-0`) | **integration-wiring** (the structural layout pin) |

The counts sum to 170+34+16+3+7+18+2+9+13+4+2 = **278** `it(` lines vs. the whole-file raw grep of 275. The difference is the single `it.each` (one `it(` line in the file; three rows) at the end of block 1 — the file's raw `it(` count is 275 lines but the executed test count is 277 (`it(` lines 275 + 2 extra cases from the array). The full-suite raw shape: 275 `it(` lines, of which exactly 1 is `it.each([{prefix:"$"},{prefix:"@"},{prefix:"#"}])(…)`.

Block-level rhythm for the extractor: every one of these blocks seeds its store state at the TOP of each test via `seedLiveSession()` / `seedLiveSessionWithImages()` / `seedStoredSession()` / `seedArchivedSession()` (blocks 3/4 use `useSubagents.getState().addSession(childEntry)` + `useInteractive.getState().addRequest(…)`), calls `render(<ChatStream />)` in each test rather than sharing a render, and only blocks 6–10 declare local helpers — so the extraction seam is clean: module helpers first, per-block helpers next, then the tests.

---

## 6. Source-reading pins — the removed `readFileSync` + `new Function` pattern

### 6.1 The deliberately-removed pin, quoted

The exact comment lives in `src/components/ChatStream.test.tsx` at the head of the nested picker-filters `describe`, immediately after the "a path-shaped relative query…" test (from `src/lib/skills.test.ts`, whose own header confirms the same history — "This file used to pin that split by reading `ChatStream.tsx` with `readFileSync`… That pin is GONE: it was a landmine (a local rename in `ChatStream.tsx` threw at module scope and took the whole file to zero tests run) with no detection value the component tests did not already have"). The `ChatStream.test.tsx` comment, verbatim:

> // --- THE PICKER'S TWO FILTERS, driven through the real picker. -----------
> //
> // This group REPLACES the source-reading pin that used to live at the bottom
> // of `src/lib/skills.test.ts`: it lifted the picker's predicates out of
> // `ChatStream.tsx` with `readFileSync` + `new Function` and evaluated them,
> // which made behaviour-preserving edits (a local rename, extracting the
> // predicate into a named function, a comment that named `fuzzyMatch(`) redden
> // tests that had nothing to do with filters — including one failure mode that
> // threw at module scope and took the whole 119-test file down to ZERO tests
> // run. Its unique detection value was nil: every mutation it caught was caught
> // elsewhere too. What it existed to defend is the guarantee below, and that
> // guarantee IS a behaviour, so it is pinned here by driving the component the
> // way a user drives it.

The guarantee that group pins (same comment, verbatim): "the picker is SHARED, the filters are not. The three **Mention** prefixes (`$` skills / `@` agents / `#` MCP servers) filter on a case-insensitive name SUBSTRING; BOTH `?` arms — the Space **Listing** and out-of-Space **Directory completion** — filter with `fuzzyMatch`, a SUBSEQUENCE… A substring is a special case of a subsequence so unifying them would break no existing query, and it was still refused: `sm` would start matching `skill-manager` and every Mention list would get looser and noisier." The fixture (`skill-manager` discriminates, `deploy` is the control) and the "same prefix, swap the needle" discipline are quoted in §5 block 9. **The extracted tests must not reintroduce the source-reading pattern** — the architecture decision on record is "behaviour is pinned by driving the component the way a user drives it".

### 6.2 Any test that still reads `ChatStream.tsx`'s source text?

Grepped the whole `src/` tree for `readFileSync` + `new Function` and for tests naming `ChatStream`:

- `src/lib/skills.test.ts` — names `ChatStream.tsx` only in the REMOVED-pin comment (history, not a live pin).
- `src/lib/classNameConvention.test.ts` — a **source scanner** that walks `SOURCES` (`readdirSync("src", {recursive…})` filtered to non-test `.tsx?` files, `src/`-prefixed and sorted — i.e. **`src/components/ChatStream.tsx` is in the scanned set**), reads each file with `readFileSync` and asserts no manual `className` composition, declared `className` prop, or class-name literal under `cn(`/`toString` conventions. **Splitting `ChatStream.tsx` into sub-components changes what this scanner sees** (a moved expression is a new site), but a **test-file extraction does not touch it** — the scanner excludes `.test.tsx?` files by construction (its own vacuity guard "expect(SOURCES.filter((f) => f.endsWith(".test.tsx")).length).toBe(0)").
- `src/lib/paletteCompleteness.test.ts`, `src/lib/ipc/events.test.ts`, `src/hooks/catalogCacheSharing.test.ts`, `src/components/settings/primitives.test.tsx`, `src/components/SessionListRow.test.tsx`, `src/components/chromeButton.test.ts`, `src/components/mutedCaption.test.ts`, `src/lib/archimedes-film/compositor.test.ts` — all name `ChatStream`/ChatStream.test in PROSE (doc comments such as `themeTokens.test.ts:697`'s "the lesson … records") or read OTHER sources (`SessionListRow.test.tsx` reads `src/components/SessionListRow.tsx`; `chromeButton`/`mutedCaption`/`primitives` read their own subjects; `paletteCompleteness` reads `src/App.tsx` by design, explicitly NOT `ChatStream`; `catalogCacheSharing.test.ts` reads `src/hooks/useSkillCatalog.ts`).

**Conclusion: no test in `src/` today reads `ChatStream.tsx`'s source text with `readFileSync` or asserts on its contents.** The extraction of the test file's scaffolding is invisible to every source scanner except `classNameConvention.test.ts` — and that one does not scan tests. The one scanner that DOES scan tests, `src/lib/tauriBarrel.test.ts`, is the subject of §7 and is untouched by a test-only move as long as `../lib/tauri` path mocking is preserved.

Also relevant: the file contains no `vi.stubGlobal` (all its stubs are assignments inside `beforeAll`), three `vi.useFakeTimers()` sites inside tests (the mid-read `FileReader` settle), and `SVG` (rejected) / `oversized` / `ninth image` staging cases that depend on the object-URL pair.

---

## 7. Counts pinned by assertions — name the guards, never restate the numbers

The repo rule (from `tauriBarrel.test.ts`'s own header): **"35 test files `vi.mock` `@/lib/tauri` BY MODULE PATH (34 spreading `vi.importActual` — both counts pinned by the assertion below rather than carried by hand; the header used to also state how many named `vi.fn()` overrides sit inside those factories, and had gone stale, so it no longer does)"**.

The guard is `src/lib/tauriBarrel.test.ts`, in the `describe` at the end of the file (the second top-level describe), with two assertions that count mocks. `ChatStream.test.tsx` is one of the counted 38 — the count is currently 38. **Cite these by pointing at the test, and say the number only as "38 as of `b0071544`"**:

- "it(\"the scanner sees the mock seam it exists to protect\")" — counts, via the `mockers` filter (`/^\s*vi\.mock\(\s*["'][^"']*lib\/tauri["']/m` on comment-stripped text), every `.test.tsx?` file that mocks a `lib/tauri` module path, and asserts `expect(mockers).toHaveLength(38);` — its comment records the number "may only move when a test file is added or removed, in a commit that says so", with a history of the moves 34 → 35 → 36 → 37 → 38. It then asserts `expect(mockers.filter((f) => /vi\.importActual/.test(readFileSync(f, "utf8"))).length).toBe(37);` — **37 of the 38 spread `vi.importActual` (ChatStream.test.tsx is in that 37), "so the remaining one is still `hooks/useWindowMaximized.test.ts`, which replaces the module wholesale — so a name it forgets is `undefined`, the case the pinned-surface assertion below covers"**.
- `tauriBarrel.test.ts` also contains two other pins extraction-relevant facts: it is the file that asserts the barrel re-exports exactly `TAURI_PUBLIC_API` (a literal of names measured at the commit before the split) and that the RUNTIME export set is exactly the pinned 49 (`TAURI_RUNTIME_API`), the very set `vi.importActual` spreads into this factory.
- `src/test/fixtures.test.ts` pins the reset limit: "it(\"does NOT reset src/store/sessions.ts's module-scope message-id counter (naming the limit)\")" — `clientMessageSeq` (`src/store/sessions.ts:620`) is a module `let`, not store state, and is deliberately NOT reset by `resetStores()`.
- `src/test/setup.tsx`'s guard list (the four `vi.unstubAllGlobals()` files) is quoted in §3.3.

**Bottom line for the planner**: the extraction must keep `ChatStream.test.tsx` (and any file it is split into) mocking `lib/tauri` BY MODULE PATH with a `vi.importActual`-spreading factory — the moment a new file mocks a domain path instead, the barrel guard's `mockers` count moves (requiring an in-commit edit to a count the header calls pinned), and the moment a name stops being mocked through the module path, every test that imported it silently stops intercepting ("green, and lying" — the header's exact phrase).

---

## 8. Exact commands

All frontend commands run from the **repo root** (`/home/daniel/Coding/AI/archimedes-desktop`) unless noted. Package manager is **pnpm** (`packageManager: pnpm@11.7.0`); vitest is 5.x; there is no `vitest.config.*`, the test config lives in `vite.config.ts` (`environment: "jsdom"`, `setupFiles: ["./src/test/setup.tsx"]`, `testTimeout: 20_000`).

| What | Command (repo root) |
|---|---|
| This file's tests alone | `npx vitest run src/components/ChatStream.test.tsx` |
| A single test by name | `npx vitest run src/components/ChatStream.test.tsx -t "the Flush: the queue drains when the Session goes idle"` (or any substring of an `it(`/`describe(` name) |
| A single new hook's test file | `npx vitest run src/hooks/<hook>.test.ts` (or `…src/components/<name>.test.tsx` for the extracted component) — same single-form for `-t` filtering |
| Whole frontend suite | `pnpm test` (from repo root, per `AGENTS.md` "Frontend unit tests" row) |

Shuffle is legitimate as a discipline check but is NOT the suite's contract — `AGENTS.md` records: "Nothing runs shuffled (no `shuffle` in `vitest.config.*`, `package.json`, or CI), so `pnpm test` is legitimately green — but a new test that asserts on store state must reset first" (this file's order-dependent override-leak is discussed in §3.3).

**Type-check**: the repo has no dedicated `typecheck` script. `AGENTS.md`'s validation table: **"| Frontend type-check + build | `pnpm build` | repo root |"** — `pnpm build` is `"tsc && vite build"` (`package.json`). A type-check WITHOUT the Vite bundle: `npx tsc --noEmit` from the repo root (this is what the `agp-archimedes` monorepo paragraph uses). `tsc` alone is the fastest feedback for the extraction's type-level facts (`StopReason`, `ChatComposerAttachment`, `CompletionDirDto`, the `makeSessionRow` return type).

Rust side is irrelevant to this area (frontend-only), but for completeness: Rust validation runs from `src-tauri/` (`cargo test`, `cargo clippy --all-targets`, `cargo fmt --check`).

---

## Sources

- `src/components/ChatStream.test.tsx` — the scaffolding block, all 11 `describe` headers, the REMOVED-pin comment, the Flush leak comment, the `beforeEach`.
- `AGENTS.md` — the `src/App.test.tsx` spread-`importActual` hazard bullet (lines ~408-423), the suite-order bullet, the Build & Testing table.
- `src/test/resetStores.ts` — the "THREE THINGS THIS DOES NOT DO" note and `resetModuleFlags`.
- `src/test/setup.tsx` — the shared environment stubs and the four-file guard list.
- `src/test/fixtures/index.ts`, `sessions.ts`, `settings.ts`, `subagents.ts` — fixture signatures; the hoisting rule ("Import from a `vi.mock` factory with `await import()`").
- `src/test/fixtures.test.ts` — the `clientMessageSeq` non-reset pin.
- `src/lib/tauriBarrel.test.ts` — the mock-count and spread-`importActual` assertions (37/38), the pinned surface.
- `src/lib/skills.test.ts` — the twin of the REMOVED-pin comment.
- `src/lib/classNameConvention.test.ts` — the source scanner that sweeps non-test `src/` files (does not scan tests).
- `package.json`, `vite.config.ts`.

The only file written by this research pass is this report at the mandated path. No source code, test, config, or lockfile was touched.
