# Codebase Improvement Report — 2026-10-22

**Scope: the frontend (`src/**`).** The Rust backend was audited on 2026-10-19 and is excluded here.

## Summary
18 findings across 8 categories. 8 high, 7 medium, 3 low.

The headline is not "the files are big" — it is **why they are big and stay big**: the app has a design system (`src/components/ui/`, `src/components/settings/primitives.tsx`, `src/components/lib/transcriptRow.ts`) that the feature layer routes around, and a test suite that pins *source text* rather than rendered behaviour. Those two facts together mean every extraction is either skipped (nothing tells you the shared thing exists) or blocked (a test greps for the code in its original file).

Measured baseline (verified, non-test `src/**`): 33,915 raw lines / 20,268 code lines in 178 files. **30 files exceed the 200-code-line threshold and they hold 55.9% of all frontend lines.** Tests are 121 files / 54,331 raw lines — **1.6× the source they cover**, with `ChatStream.test.tsx` at 7,903 lines against a 1,955-line component.

## Context
- CONTEXT.md: loaded (296 lines). **No `## Engineering Rules` section** — the 200-line default holds. Its `_Avoid_` lists were treated as binding naming rules (finding 16).
- ADRs reviewed: 63 exist in `docs/decisions/` (note: this repo uses `docs/decisions/`, not `docs/adr/`). Most-cited here: 0006 (design system), 0016 (archive-first delete), 0025 (worker processes), 0038/0039/0040 (attention, gates), 0042 (side pane), 0049 (incarnation), 0055 (dead bound), 0062 (row token family), 0063 (IPC error kind), 0065–0071 (shadowing, agent overrides, effective config, palette, films).
- Plans reviewed: 4 (`prompt-queue.md`, `multi-platform-build-and-release.md`, `appimage-child-process-env-scrub.md`, `compaction-recovery-hardening-follow-ups.md`).
- **Prior audit follow-up:** finding 11 of 2026-10-19 ("Standardize React Component Styling with `cn()`") is **not fixed and has regressed** — see finding 15. Findings 6 (session-close fan-out) has since been addressed: the close path is now the single `lib/sessionLifecycle.ts:7-20`.

## Verification note
Three scan claims did not survive verification and are corrected below: raw `<button>`s are **50** (not 37); the `role="button" + tabIndex + Enter` affordance appears **6** times but only **3** are the same control; the busy/error IPC wrapper is written **6** times (not 12 — `describeIpcError` has 21 call sites, 13 of which are one-line catches). `pnpm test` (2,650 tests, 91.5 s) and `pnpm build` are green at `3e355d8`.

---

## Findings

### 🔴 High Severity

#### 1. Source-grep tests pin code to its file, so "pure extraction" is not pure
- **Lens:** Missing Tests / Testability
- **Files:** `src/lib/themeTokens.test.ts:824-835`, `:795-815`, `:915`; `src/lib/paletteCompleteness.test.ts:760-768`; `src/lib/slabFloatSeparation.test.ts:186-268`; `src/lib/subagentSheetLayout.test.ts:56-62`, `:97-115`
- **Severity:** High · **Confidence:** High
- **Problem:** Several tests read component **source text** and assert on it. `themeTokens.test.ts:824-835` asserts an exact per-file count of `text-foreground-subtle*` utilities (`ToolCallCardHeader.tsx: 5`, `ChangesGroupCard.tsx: 4`, `Reasoning.tsx: 9`); `paletteCompleteness.test.ts:765` regexes `App.tsx` for `className="…" data-testid="chrome-bar"`; `slabFloatSeparation.test.ts:190-195` **throws** (not fails) if the `active ? "…" : "…"` pill ternary disappears from `SpaceTabs.tsx`. The byte-identical hover chevron at `ToolCallCardHeader.tsx:158-163` ≡ `ChangesGroupCard.tsx:222-227` is the cheapest DRY win in the transcript and it is blocked by a utility count in a CSS test. The repo already learned this lesson once: `src/lib/skills.test.ts:18-28` documents retiring a source-grep pin as "a landmine … with no detection value the component tests did not already have."
- **Proposal:** One increment whose *only* output is test changes: re-point each DOM-observable invariant at a rendered node (the suite already has the recipes — `SettingsPage.test.tsx:397`, `SessionConfigSelect.test.tsx:90`). Where an invariant genuinely is textual (palette-token completeness), scope it to a token/`data-slot` contract instead of a per-file count. Land the gate migration in the *same* commit as the extraction it unblocks, never as a follow-up.

#### 2. `ChatStream.tsx` is a single 1,857-line component with 18 store subscriptions
- **Lens:** File Length + Structure
- **Files:** `src/components/ChatStream.tsx:99-1955` (822 code lines; JSX is only ~88 of them)
- **Severity:** High · **Confidence:** High
- **Problem:** One top-level declaration, ~47 hook calls, 18 subscriptions across 5 stores (`sessions` ×14, `settings` ×3, `interactive` ×2, `permissions`, `queuedPrompts` via `getState`) plus 4 `getState()` calls (`:1121`, `:1186`, `:1381`, `:1478`). Three cohesive regions live inline: the mention picker (`:468-858`, 125 code lines incl. a 220-line `useMemo`), the send/flush/resume chain (`:935-1521`, 341 code lines), and the attachment + object-URL lifecycle (~200 lines across 6 sites). `hasImages` is a render-phase `let` (`:917`) mutated inside `send()` (`:1189`) and threaded to `ComposerRow` at `:1939`. Its children are props-only (`MessageList` takes **18** props, `ComposerRow` **25**), so extraction is blocked by plumbing, not by rendering.
- **Proposal:** Extract in this order — the hooks, not the JSX: `useMentionPicker` (`:468-858`), `useAttachmentStaging` (`:305-310`, `:349-355`, `:387-411`, `:1554-1619`, `:1756-1773`), `useComposerSend` (`:935-1362`), `usePromptQueueFlush` (`:883`, `:892-896`, `:1370-1494`). Each is guarded by `ChatStream.test.tsx`. Prerequisite: finding 8.

#### 3. `SessionRow` and `ArchivedSessionRow` are one component written twice
- **Lens:** Weak Abstractions
- **Files:** `src/components/SpacesList.tsx:819-954`, `:1053-1130`, `:975-1038`; `src/components/settings/SessionsSection.tsx:48-101`
- **Severity:** High · **Confidence:** High
- **Problem:** The two row bodies (`:871-952` vs `:1071-1128`) share a ~42-line core — identical `role="button" tabIndex={0}` + Enter handler, identical outer class ternary, a **character-for-character duplicate** of the 7-line `maskImage`/`WebkitMaskImage` style object, identical time-slot-with-`size-4`-fallback. They differ only in the leading glyph (`SessionStatusMark` vs a 16px spacer) and the two hover actions. Around them: the hover-action class string is repeated **4×** (`SpacesList.tsx:923,938,1102,1116`), the sidebar command-button block **4×** (`:608-644`), and the `role="button" + tabIndex + onKeyDown(Enter)` affordance is hand-rolled **6×** across the app (`SpacesList.tsx:872,996,1072`; `SkillsDialog.tsx:190`; `ModelPickerDialog.tsx:142`; `TodoBoardPanel.tsx:278`). `settings/SessionsSection.tsx:61-78` is a third variant of the same row, and copies `relativeTimeFor` to get there.
- **Proposal:** `SessionListRow({ title, time, active, leading, actions, onOpen })` owning row chrome + mask + time slot, and `RowButton` owning the focusable affordance. Note the glossary: **Transcript row** owns the word "row" for the conversation column, so name this `SessionListRow`, not `SessionRow`, and say in its doc-comment that it is not a `TRANSCRIPT_ROW` (it carries `bg-selected`).

#### 4. The catalog-picker dialog is written three times
- **Lens:** DRY Violations
- **Files:** `src/components/SkillsDialog.tsx:165-268`, `src/components/ModelPickerDialog.tsx:117-177`, `src/components/AgentsDialog.tsx:288-392`
- **Severity:** High · **Confidence:** High
- **Problem:** Three files, ~272 lines of body, sharing byte-identical `DialogContent className="max-h-[70vh] sm:max-w-3xl"` (3×), `div className="flex max-h-[calc(70vh-7.5rem)] min-w-0 flex-col gap-3"` (3×), the rows scroller, the row class, the muted secondary line, and the empty-state `<p className="p-3 text-ui-sm text-foreground-subtlest">` (**7** sites). Each copy has drifted: only `ModelPickerDialog` fuzzy-matches (3 fields) and re-sorts; only `SkillsDialog` has the shadow report; only `AgentsDialog` guards `settings === null` and uses `gap-2`. Viewport math, filter policy and empty-state copy therefore have three answers.
- **Proposal:** `CatalogSearchDialog` as a **shell** (owns Dialog/Content/Header/Input/scroll wrapper, takes `title`, `placeholder`, `query`/`onQueryChange`, `emptyMessage`/`noMatchMessage`, `children`, `footer`) — not a generic dialog. Hard constraint: emit **exactly** the existing two DOM levels (`DialogContent` → scroll `div`), because `SkillsDialog.test.tsx:313-323` and `ModelPickerDialog.test.tsx:215-222` walk ancestry by `parentElement`. Pass `className` through `cn()` so the token-set assertions on `data-slot=dialog-content` still resolve.

#### 5. The child-gate card exists twice, and it carries an ADR invariant
- **Lens:** DRY Violations
- **Files:** `src/components/chat/TranscriptFooter.tsx:64-106` vs `src/components/SubagentModals.tsx:344-393`
- **Severity:** High · **Confidence:** High
- **Problem:** The per-gate markup is already the same component in both files: same `childGateKey`, byte-identical `onKeyDown` Escape `stopPropagation`, byte-identical `↳ {agentName}` chip, identical `kind === "ask" ? <AskQuestionCard autoFocus={false}/> : <PermissionPrompt/>`. CONTEXT.md's **Subagent session** entry promises "both read the one derivation `useChildGates`/`childGatesOf`" — the *derivation* is shared; the **render is not**. The ADR-0040 guarantee ("a gate is never answerable twice and never rendered nowhere") is currently enforced by two hand-copied blocks plus prose comments in four files restating the same Escape rationale.
- **Proposal:** `InlineGateRow({ gate, autoFocus })` — the card only. The overlay region (`data-testid="subagent-gate-overlay"`, `role="region"`, `pointer-events-*`, dodge geometry) and the `gate-row` wrapper stay at their call sites. The component must receive an **already-filtered** gate: `SubagentModals.renderSite.test.tsx:129-135` is the mechanism pin that catches a component deciding kinds locally. `subagentSheetLayout.test.ts:107-115` requires `SHEET_WIDTH_CLASS` to stay named in `SubagentModals.tsx`, so the dodge string does not move.

#### 6. The design system exists and the feature layer routes around it
- **Lens:** Weak Abstractions
- **Files:** `src/components/ui/{badge,tabs,separator}.tsx`; `src/components/settings/primitives.tsx:75`; 21 files with raw `<button>`s; `src/components/SpaceTabs.tsx:232`
- **Severity:** High · **Confidence:** High
- **Problem:** `ui/badge.tsx`, `ui/tabs.tsx`, `ui/separator.tsx` have **zero** importers (verified) while `SpaceTabs.tsx:232` hand-rolls `role="tab"` and `border-t border-border` is hand-drawn 8×. **50 raw `<button>`s** live outside `ui/` against 58 `<Button>`s; the chrome button class string is byte-identical between `ChromeControls.tsx:76` and `WindowControls.tsx:33`/`:41`, and `SpacesList` repeats two button strings 4× each. `ui/dropdown-menu.tsx` is 64% dead (11 of 17 exports unused). Meanwhile `settings/primitives.tsx:75` `SettingsBadge` re-implements `Badge` and is used at **20** sites, and 4 settings sections hand-draw the exact row wrapper `SettingsRow` owns (`ProviderSection.tsx:120`, `McpSection.tsx:117`, `SessionsSection.tsx:61`, plus `GeneralSection.tsx:418`/`UpdateSection.tsx:392` without `first:border-t-0`).
- **Proposal (deliberately narrower than "convert everything"):**
  1. `CHROME_BUTTON` as a **class constant** (not a component) — `ChromeControls` and `WindowControls` are different domain objects per CONTEXT.md **Chrome controls** and carry different `data-window-control` attention semantics (ADR 0038); a shared component would erase that.
  2. `SettingsDataRow` — a wrapper owning only `border-t border-border px-4 py-3 first:border-t-0`. Do **not** route `ProviderRow`/`McpRow`/`DetachedSessionRow` through `SettingsRow`: it is a `grid-cols-[minmax(0,1fr)_192px]` preference grid and `SessionsSection.tsx:41-46` already argues the distinction.
  3. Add `variant: "settings"` to `badgeVariants` and migrate the 20 `SettingsBadge` sites rather than deleting the orphan.
  4. Do **not** sweep the 50 raw buttons — they are 6 distinct a11y objects (icon toggles, window controls, `role="button"` divs, hover row actions, marks) and `ui/button.tsx` carries `disabled:pointer-events-none` + 8 size variants, so a blind conversion changes hit areas and focus rings.

#### 7. Eight ways to show an error, and 7 of 9 inline error lines are invisible to a screen reader
- **Lens:** Inconsistent Patterns
- **Files:** `NewSpaceDialog.tsx:134,138`; `PermissionPrompt.tsx:82`; `SudoConfirmModal.tsx:63`; `SudoPasswordModal.tsx:116`; `AskQuestionCard.tsx:531`; `ChatStream.tsx:1904`; `SessionConfigSelect.tsx:254,310`; plus 21 `console.error`-only paths
- **Severity:** High · **Confidence:** High
- **Problem:** The same backend failure renders as a `<p className="text-ui-sm text-destructive">` (6 components), a `role="alert"` warning strip (2 banners), a `role="alert"` destructive floating `<span>` on a 5 s timer (2 sites in `SessionConfigSelect`), a badge whose only text is the word "error" with the message in a `title` (5 settings sites), a bare word `Failed` (`QueueRow.tsx:155`), inline transcript prose, or `console.error` with no UI at all (21 sites, including `deleteSession`/`stopSession`/`archiveSession` failures in `SpacesList` and `store/sessions.ts`). Only the two `SessionConfigSelect` spans carry `role="alert"`. ADR 0063 standardised the *message*; nothing standardised the *surface*.
- **Proposal:** `IpcErrorLine({ error, className })` with `role="alert"`, one increment per call site. **This is a behaviour change, not a refactor** — it alters the a11y tree at 7 sites and makes a screen reader announce where it previously did not. It needs its own commit and an ADR 0063 cross-reference. Decide the `console.error`-only sites separately: some are deliberately silent.

#### 8. There is no session-lookup seam: the three-list walk is implemented six times
- **Lens:** DRY Violations
- **Files:** `src/hooks/useActiveSpaceCwd.ts:41-46`; `src/components/SidePane.tsx:232-240` and `:247-258`; `src/components/SpacesList.tsx:840-849`; `src/lib/sessionConfig.ts:62-68` and `:87-92`; `src/components/ChatStream.tsx:117-124`
- **Severity:** High · **Confidence:** High
- **Problem:** `sessions.find(…) ?? historySessions.find(…) ?? archivedSessions.find(…)` is re-derived in six places, each picking a different field (cwd, title, configOptions, contextUsage, owner). `useActiveSpaceCwd.ts:14-16` already states the rule — "a second consumer re-deriving it is how the two silently disagree" — and `lib/sessionConfig.ts:17-25` already models the right shape (a plain function called *inside* the selector, because "a hook would force the pane to subscribe to `activeSessionId` + every list it does not otherwise show"). This is the prerequisite for finding 2: any `useChatComposer`/`useMentionPicker` would otherwise re-implement the walk and the extraction would just relocate the duplication.
- **Proposal:** `src/lib/sessionLookup.ts` exporting `sessionFieldOf(state, id, key)` in the `sessionConfig.ts` shape — **not a hook**. Keep every selector's return a primitive: `SidePane.tsx:243-246` warns that zustand v5 re-runs a selector yielding a fresh object on every read, which would re-render the pane forever.
- **Explicit non-goal:** do **not** split `src/store/sessions.ts` (935 code lines, the actual largest file). Its size is legitimate — ADR 0016's ordering ("the order is the whole design"), 0073, 0049 and 0041 all live in it, and moving actions across module boundaries is exactly how ADR 0016 would break.

---

### 🟡 Medium Severity

#### 9. `src/test/` is 26 lines, so 121 test files re-implement the environment
- **Lens:** Missing Tests / Testability
- **Files:** `src/test/setup.tsx:1-26`; 28 `lib/tauri` mock factories (833 lines); `vite.config.ts:39-52`
- **Severity:** Medium · **Confidence:** High
- **Problem:** Global setup holds only a Virtuoso stub and two scroll no-ops. Everything else is per-file: **28** `vi.mock` factories for `lib/tauri` (833 lines, 114 `vi.fn()` stubs, largest 240 lines at `SettingsPage.test.tsx:85-324`), **10** re-declared `AppSettings` document literals, 323 `useSessions.setState` seeds, 21 `matchMedia` stubs, 15 `scrollIntoView` stubs, 6 pointer-capture stubs. Two `AppSettings` literals are **byte-identical** (`ChatStream.test.tsx:61-91` ≡ `MessageBubble.codeblock.test.tsx:37-67`) and `App.test.tsx:76-105` is already **stale — no `palette` key**, which is only possible because it is untyped. `SpacesList.test.tsx:100-104` names the cause: a hoisted `vi.mock` factory cannot reference an outer typed const, so new settings fields must be added to 10 literals **by hand**.
- **And the economics are inverted:** tested-rate by file size runs 34% for files under 50 lines, 92% for files over 350. `src/components/ui` is 17% tested (15 of 18 untested), `chat/` 50%, `settings/` 55%. Extraction currently *costs* coverage, because nothing gives a new small component a cheap test.
- **Proposal:** `src/test/fixtures/{settings,sessions,subagents}.ts` (using `vi.hoisted()` to survive factory hoisting), a `resetStores()` helper, and one shared `renderWithProviders()`. Start from `AgentsDialog.test.tsx`, which already declares "this file needs NO IPC mock" and is the model to generalise.

#### 10. Formatting rules have an owner and a copy that can drift
- **Lens:** DRY Violations
- **Files:** `src/components/SpacesList.tsx:81-91` vs `src/components/settings/SessionsSection.tsx:23-33`; `src/lib/sessionTitle.ts:19-28` vs `src/components/SidePane.tsx:261-279`; `src/lib/toolOutput.ts:146-166` vs `src/components/SubagentTranscript.tsx:167-168`; `src/components/ChangesGroupCard.tsx:43-45` vs `settings/ClearDetachedSessionsDialog.tsx:58,59,86`
- **Severity:** Medium · **Confidence:** High
- **Problem:** `relativeTimeFor` is duplicated verbatim (11 lines ×2, and `SessionsSection.tsx:18` admits the copy). `titleFor` — documented as "THE one title rule" — is re-implemented inline in `SidePane.tsx:261-279`, and the two **disagree**: `titleFor` falls back to `spaceName`, `SidePane` falls back to `basenameOfPath(activeCwd)` or renders no header. `SubagentTranscript.tsx:168` prints `{durationMs} ms` and `cost.toFixed(2)`, skipping the shared formatters' `⌊ms⌋`→`s` and `<0.01 → 4 decimals` rules. Pluralisation is hand-rolled 7×. This is already user-visible: two surfaces show the same session's age and cost differently.
- **Proposal:** `src/lib/sessionTime.ts` (`relativeTimeFor`), extend `lib/sessionTitle.ts` to cover the `SidePane` arms, and route `SubagentTranscript` through `formatDuration`/`formatCost`. `titleFor`'s two arms are behaviour-affecting — write the no-cwd → `null` case in `sessionTitle.test.ts` **before** folding.

#### 11. Three small machines are each written two or three times
- **Lens:** DRY Violations
- **Files:** `MessageBubble.tsx:226-240`, `:551-568`, `ToolCallCardHeader.tsx:64-79` (clipboard); `PermissionPrompt.tsx:37-43`, `SudoConfirmModal.tsx:39-45`, `SudoPasswordModal.tsx:50-59`, `AskQuestionCard.tsx:242-263`, `NewSpaceDialog.tsx:85-99`, `SessionConfigSelect.tsx:223` (busy/error); `useSkillCatalog.ts:39-91` vs `useAgentCatalog.ts:50-94` (catalog cache)
- **Severity:** Medium · **Confidence:** High
- **Problem:** The copy-to-clipboard machine — `useState` + timer `useRef` + 1500 ms + unmount cleanup + icon swap — exists 3× (the comment at `MessageBubble.tsx:223` says "the `ToolCallCardHeader` pattern verbatim"); all three use `?.then` and silently no-op on rejection. The busy/error/`describeIpcError` wrapper exists **6**×. The catalog cache exists 2× with its four load-bearing rules restated in each (`useAgentCatalog.ts:8-10` calls itself "a deliberate copy of `useSkillCatalog`"), even though `useMentionCatalogs.ts:89` already generalised it as `useCatalogPayload<P>`.
- **Proposal:** `useCopyButton(text)` (highest ratio in the repo: ~49 lines → ~12, **zero** blast radius — no pinned utility lives in the extracted ranges, no test-id affected, no source-grep test involved), `useAsyncAction()` (renders nothing; caller keeps its markup), `useCatalogCache` collapsing the last copy. `useAgentCatalog` has **no direct test file** — transcribe its four documented cache rules into a test first.

#### 12. `src/lib/tauri.ts` is one 1,259-line seam for 13 domains, and event names have no owner
- **Lens:** File Length + Structure
- **Files:** `src/lib/tauri.ts` (643 code lines, 110 exports, fan-in 44); `src/lib/update.ts`; `src/lib/version.ts`
- **Severity:** Medium · **Confidence:** High
- **Problem:** The `invoke` boundary is genuinely respected (**0** call sites outside it) but the module is a flat 1,259 lines spanning session lifecycle, spaces, settings, providers, models, skills, agents, MCP, search, files, completion, window, interactive gates, subagents and attention. 32 exported names have zero consumers, including ~19 payload types (`ToolCallDiff` is fully dead) and 2 dead commands (`listAgentDefinitions:959` — kept "on purpose" for a Settings Agents surface that ADR 0066 deleted; `getStalledInfo:1130`). `lib/update.ts:77` and `lib/version.ts:1` are undocumented parallel IPC modules. The 12 `listen*` wrappers each carry a **bare event-name string** with no constants module, and the `interactive-event` payload discriminators are literals inside `App.tsx:161-172` (`"todos_update"`, `"cost_update"`, …) with a comment apologising that the wire name is `cost_update` and not `cost` — exactly the bug a shared union prevents. `archimedes:insert-skill` is a `CustomEvent` string duplicated across `SkillsDialog.tsx:158` and `ChatStream.tsx:854`.
- **Proposal:** Split by domain (`ipc/sessions.ts`, `spaces.ts`, `settings.ts`, `catalogs.ts`, `gates.ts`, `window.ts`) with `lib/tauri.ts` kept as a re-export barrel so no consumer changes; delete the dead exports; add an `ipc/events.ts` constants + payload-discriminant module and make `App.tsx`'s switch exhaustive over it.

#### 13. `SettingsPage` is a second owner of the settings document
- **Lens:** Coupling Issues
- **Files:** `src/components/settings/SettingsPage.tsx:120`, `:150-160`, `:225`; `src/lib/settings.ts:3`; 27 `getState()` write sites in components
- **Severity:** Medium · **Confidence:** High
- **Problem:** `SettingsPage.tsx:120` holds `useState<AppSettings | null>` and **also** writes the store imperatively at `:157` and `:225`, while every other consumer reads `useSettings` reactively — so within one screen there are two owners of one document and only the page knows which is authoritative. It also carries 9 `useState`s and 8 hand-written IPC mutation functions. More broadly there is no write seam: **42** `useX.getState()` sites in production, **27 of them in `App.tsx` + `src/components/**`**; `lib/settings.ts:3` imports a store, inverting the layer (`lib → store` = 12 edges), and `lib/sessionLifecycle.ts:1-4` imports four. `store/sessions.ts` is simultaneously a store, a type module (fan-in 30, and `SessionsState` is *not* exported, which is why `lib/sessionConfig.ts:35` works around it) and a re-export barrel of `lib/transcript/*` (`:37-41`) — a cycle that is only safe by convention, since `tsconfig.json:16` sets `isolatedModules` but there is no `verbatimModuleSyntax`.
- **Proposal:** Move `SettingsPage`'s document state into `useSettings` (or a `useSettingsDocument()` hook) so one owner holds it; introduce `src/lib/sessionTypes.ts` as the home for `Message`/`DiffRef`/`ToolCallUiStatus` and drop the store's `:37-41` re-export barrel; add `verbatimModuleSyntax` so the type-only edges stop being a convention. Defer any store-action reorganisation — see finding 8's non-goal.

#### 14. `SubagentDelegatingCard.tsx` is 93% code and derives its rows twice
- **Lens:** File Length + Structure
- **Files:** `src/components/SubagentDelegatingCard.tsx:68-137`, `:139-158`, `:186-335`, `:407-552`, `:554-648`
- **Severity:** Medium · **Confidence:** High
- **Problem:** 696 code lines in 792 raw — the least-documented large file in the frontend (40 comment lines). Four large private derivations sit inline, and the row build is written **twice**: `taskKeys.map` (`:407-552`) and `matchingStoreEntries.map` (`:554-648`) share 59 identical non-blank lines including the same six-field inline type annotation (`:457-465`, `:581-588`) and the same `??` fallback chain — with the two copies having already diverged (`storeEntry?.` vs `storeEntry.`). A metric-fallback change must be made in both.
- **Proposal:** Move the four pure derivations to `src/lib/subagentActivity.ts` — 217 code lines, no JSX, trivially unit-testable, **no structural risk**, and needing none of the other prerequisites. Then collapse the two row derivations into one `subagentRowsOf(...)`. This is the cheapest large-file win available.

#### 15. `cn()` convention holds only inside `ui/` — and the design system has no owner
- **Lens:** Inconsistent Patterns
- **Files:** `src/components/lib/utils.ts:21`; `src/components/chat/MessageList.tsx:56,280`; 23 files building classes by concatenation
- **Severity:** Medium · **Confidence:** High
- **Problem:** **Direct follow-up to 2026-10-19 finding 11, which is not fixed.** Of 81 non-test files that set `className`, 22 use `cn()` — and 18 of those are `ui/*`; only 5 call sites live outside it (`App.tsx`, `ModelPicker.tsx`, `Reasoning.tsx`, `settings/controls.tsx`, `settings/primitives.tsx`). 23 files build classes with template literals/ternaries and never import `cn()`; 10 do both in the same file. `cn()` exists precisely because `extendTailwindMerge` must register the `text-ui-*` group (`utils.ts:4-19`) — every hand-concatenated class string skips that merge, so whether a caller-supplied class wins is decided by literal order. `MessageList.tsx:280` even hand-rolls the collision guard (`.trim()`) the helper provides. Related: type/colour pairs that mean one thing are re-spelled as string literals — `text-ui-xs text-foreground-subtlest` 25×/10 files, `text-ui-sm text-foreground-subtlest` 23×/10, `text-ui-sm text-destructive` 9×/7, and the fade-mask gradient duplicated 6× while `src/lib/scrollMask.ts` already builds masks.
- **Proposal:** Cheapest enforceable step: `cn()` on every component that accepts a `className` prop, plus three token-level components the class census is begging for (`MutedCaption`, `ErrorLine`, `EmptyListLine`). Then a lint rule (no raw `className={` template literal in `src/components/**` outside `ui/`) rather than another audit note.

#### 16. Naming: user-visible copy contradicts CONTEXT.md, and six identifier families break `_Avoid_`
- **Lens:** Naming
- **Files:** `chat/MessageList.tsx:44`; `NewSpaceDialog.tsx:80`; `CloseSpaceDialog.tsx:86`; `settings/GeneralSection.tsx:199`; `ChromeControls.tsx:91` vs `:107`; `settings/ProviderSection.tsx:232`; `MessageBubble.tsx`; `ChatStream.tsx`; `Reasoning.tsx`; `TodoBoardPanel.tsx`; `Sudo*Modal.tsx`; `QueuedSummaryContent.tsx`; `settings/McpSection.tsx:300-302`; `AskQuestionCard.tsx:275`
- **Severity:** Medium · **Confidence:** High
- **Problem:** Two halves. **(a) User-visible copy** contradicts the glossary in six places a first-time user reads first: `"Start of conversation"` and `"New conversation in …"` (**Session** `_Avoid_: Conversation, chat, thread, run`), `"…confined to your project folder…"` (**Space** `_Avoid_: Project, workspace, folder…`), `"Its N models will leave the model picker."` (**Config option** `_Avoid_: model picker`), and the clearest defect — `ChromeControls.tsx:91` announces `"Collapse sidebar"` while its sibling button three lines below announces `"Collapse side pane"` (**Side pane** `_Avoid_: sidebar (unqualified…)`). Two more: `McpSection.tsx:300-302` shows users a retired project's name as if it were a live embodiment, and `AskQuestionCard.tsx:275` prints `request.source` **verbatim**, rendering `"native is asking…"` — a transport label CONTEXT.md forbids as a name (`useChildGates.ts:16` already dropped `source` for exactly this reason).
**(b) Identifiers:** `MessageBubble` names the forbidden "bubble" for the **Response band** (whose sanctioned name exists only as `data-testid="agent-band"`); `ChatStream` + `components/chat/` + `bg-chat` + `ChatComposerAttachment` make "chat" the prefix of a whole subsystem; `Reasoning*` names the **Thinking block** with the retired ZCode term while its own props mix `Reasoning*` and `getThinkingMessage`; `TodoBoardPanel` is a reuse blocker (the **Queue row** entry reserves "panel" for the Side pane); bare "rail" means both the collapsed sliver and the readout inside it, exactly the collision the glossary calls out; `QueuedSummaryContent` is not queue-related at all (it is the Thinking block's animated roll); and `SudoConfirmModal`/`SudoPasswordModal` keep `*Modal` against nine `*Dialog` siblings while CONTEXT.md's **Gate** entry forbids "modal".
- **Proposal:** Split the work. **(a) Now:** fix the six user-visible strings and the `source` label — copy is the only place a glossary is enforceable, and a copy fix has no blast radius beyond its own tests. **(b) Later, as one ADR-backed rename PR:** the identifier families. A rename here is not a `git mv` — it touches 4 source-grep test files with hard-coded paths, ~50 `data-testid`s, and requires amending CONTEXT.md (which itself *cites* component names). New components take glossary names from day one; existing files are not renamed inside a component-extraction program (see finding 1's constraints, and note ADR 0066 explicitly **blesses** `SubagentDelegatingCard`/`SubagentTranscript`/`SubagentModals` — those four are not to be renamed).

---

### 🟢 Low Severity

#### 17. Ceremony the compiler cannot see
- **Lens:** Dead Code
- **Files:** `src/components/ui/{tabs,badge,separator,dropdown-menu,card,select}.tsx`; `src/lib/ids.ts`; `src/styles/theme.css`; `src/lib/tauri.ts:959,1130`
- **Severity:** Low · **Confidence:** Medium (unused-export and Tailwind token analysis is heuristic)
- **Problem:** `ui/tabs.tsx` (78 L), `ui/badge.tsx` (46 L), `ui/separator.tsx` (28 L) have zero importers; ~280 further lines sit as unreferenced exports inside live `ui/` files (`dropdown-menu.tsx` 11 dead exports, `card.tsx` 5, `select.tsx` 4). `src/lib/ids.ts` is a branded-type layer (`SessionId`, `RequestId`, `asSessionId`) that **no production call site uses** — every call site passes a bare `string`, so the branding is pure ceremony while `sessionId: string` appears 96× across 24 files. ~87 of 188 CSS custom properties have no consumer (`--color-terminal-*` ×21, the role-chip families ×18, `--color-git-*` ×8), and 12 of them appear in no file at all — not even in the palette tests that exist to enumerate tokens. Because an `export` makes a symbol invisible to `noUnusedLocals`, 174 of 564 exports have no external importer.
- **Proposal:** Delete the orphans, delete the 2 dead IPC commands and the 19 unconsumed payload types, and either adopt branded ids or delete `lib/ids.ts`. For CSS tokens, decide per family: `--color-terminal-*` and the context/usage scales look like ported-but-unbuilt surfaces — record that decision (ADR 0006 territory) so the palette-completeness tests stop enforcing hues nothing renders.

#### 18. `SpaceTabs` renders tabs that are not a tablist
- **Lens:** Inconsistent Patterns
- **Files:** `src/components/SpaceTabs.tsx:144`, `:232`
- **Severity:** Low · **Confidence:** High
- **Problem:** `role="tab"` is emitted with **no `role="tablist"` ancestor** and no `aria-selected`, so the space switcher is announced as an orphaned tab. `ui/tabs.tsx` exists but is incompatible (its `p-[3px] rounded-lg bg-muted` segmented-control geometry, and Radix would force the `+` new-Space button into an illegal `tablist` child).
- **Proposal:** The 2-line ARIA fix (add `role="tablist"` + `aria-selected`), and **leave `ui/tabs.tsx` an orphan**. Do not adopt Radix Tabs here: `slabFloatSeparation.test.ts:186-268` reads `SpaceTabs.tsx` by path, *throws* if the `className={…h-8…}` pattern disappears, and fails its vacuity guard if the class ternary moves — making this the highest-risk change in the whole program for a 2-line defect.

---

## Decisions — 2026-10-22

**All 18 findings approved into the backlog.** Two scope modifications from the review discussion:

- **Finding 4** — `CatalogSearchDialog` covers `SkillsDialog` / `ModelPickerDialog` / `AgentsDialog` only. `McpDialog` (`McpSection.tsx:273-417`) is explicitly excluded: it is a `Field`/`TextField` create/edit **form**, so sharing a shell would give the component two mutually-exclusive prop sets.
- **Finding 6** — the **full** raw-`<button>` → `<Button>` sweep is in scope, not just the class constant. It is therefore sequenced **last within its increment and split by a11y group** (icon toggles → window controls → `role="button"` divs → hover row actions → marks), never one commit. Risks the spec must carry: `ui/button.tsx:12` adds `disabled:pointer-events-none disabled:opacity-50` and 8 `size` variants, so hit areas and focus rings change; `PermissionPrompt.test.tsx:124-126` asserts `bg-primary`/`border-border` on specific buttons; and the window controls' `data-window-control` attention exemption (ADR 0038) must be preserved per-button — `WindowControls.tsx:19-27` warns *"Any control added here inherits the exemption, so add one deliberately."*

### Execution order

Sequenced so every increment is independently shippable and keeps `pnpm test` + `pnpm build` green. Ordering principle: **reduce risk before reducing size.** TDD applies throughout — where a column below says a test is needed first, it is written and seen failing before the extraction.

#### Phase A — unblock and take the free wins (no structural risk)

| # | Finding | Change | Test work |
|---|---|---|---|
| A0 | 1 | Re-point source-grep gates at the DOM: `themeTokens.test.ts:824-835` per-file utility counts, `slabFloatSeparation.test.ts:190-195` (throws), `paletteCompleteness.test.ts:765` (`App.tsx` chrome-bar regex), `subagentSheetLayout.test.ts:107-115`. **Test-only output.** | This *is* the test change; migrate in the same commit as any extraction it blocks |
| A1 | 11a | `useCopyButton(text)` — 3 sites, ~49 → ~12 lines | New: timer reset, unmount cleanup, `undefined` no-op |
| A2 | 14 | `lib/subagentActivity.ts` — 217 pure code lines out of `SubagentDelegatingCard` | New unit tests; trivially testable, no JSX |
| A3 | 10 | `lib/sessionTime.ts`; route `SubagentTranscript` through `formatDuration`/`formatCost`; then fold `SidePane`'s `titleFor` copy | **First**: the no-cwd → `null` arm in `sessionTitle.test.ts` — the two copies currently disagree |
| A4 | 16a | The 6 user-visible copy fixes + `AskQuestionCard.tsx:275` printing `request.source` verbatim | Copy-only; site tests only |
| A5 | 18 | `SpaceTabs.tsx:144`/`:232` — add `role="tablist"` + `aria-selected` (2 lines). **Do not adopt `ui/tabs.tsx`** | New ARIA assertion |
| A6 | 17 | Delete the 3 orphan `ui/` files (decide `badge` first — see C2), the 2 dead IPC commands, 19 unconsumed payload types; decide branded ids; record the CSS-token family decision | Deletion verified by `tsc` + suite |

#### Phase B — the substrate everything else stands on

| # | Finding | Change | Note |
|---|---|---|---|
| B1 | 8 | `src/lib/sessionLookup.ts` → `sessionFieldOf(state, id, key)`, in the `sessionConfig.ts` shape — **a plain function, not a hook**. Keep every selector return a primitive (`SidePane.tsx:243-246`) | Prerequisite for C8 and D4 |
| B2 | 12b | `ipc/events.ts` — event-name constants + the `interactive-event` payload-discriminant union; make `App.tsx:161-172` exhaustive | Mechanical half of finding 12 |
| B3 | 13b | `src/lib/sessionTypes.ts` for `Message`/`DiffRef`/`ToolCallUiStatus`; drop `store/sessions.ts:37-41`'s re-export barrel; add `verbatimModuleSyntax` | Makes the type-only `lib → store` edges enforced, not conventional |
| B4 | 9 | `src/test/fixtures/{settings,sessions,subagents}.ts` (via `vi.hoisted()`), `resetStores()`, `renderWithProviders()`. Generalise `AgentsDialog.test.tsx`, which needs no IPC mock | Makes every later extraction cheap to test; fixes the inverted coverage economics |

#### Phase C — components and hooks

| # | Finding | Change | Guard |
|---|---|---|---|
| C1 | 11b, 11c | `useAsyncAction()` (migrate **one site per increment**); `useCatalogCache` collapsing `useSkillCatalog`/`useAgentCatalog` | **Write `useAgentCatalog`'s 4 documented cache rules as a test first — it has no direct test file** |
| C2 | 6a–6c | `CHROME_BUTTON` class **constant** (not a component — the two clusters differ per CONTEXT.md **Chrome controls** + ADR 0038); `SettingsDataRow` (wrapper only — do **not** route the data rows through `SettingsRow`); `badgeVariants` `variant:"settings"` + migrate the 20 `SettingsBadge` sites | `primitives.test.tsx:97`; `ChromeControls.test.tsx:73` reads `firstElementChild` |
| C3 | 7 | `IpcErrorLine({ error, className })` with `role="alert"`, one increment per call site | **Behaviour change** — own commit + ADR 0063 cross-reference; 7 sites gain a11y announcements |
| C4 | 3 | `SessionListRow` + `RowButton` (6 hand-rolled affordances) | Highest-risk surface: `SpacesList.test.tsx` reaches rows via `.closest('[role="button"]')` — emit exactly one such ancestor |
| C5 | 5 | `InlineGateRow({ gate, autoFocus })` — the **card only**; overlay region + `gate-row` wrapper stay at call sites | Must receive an already-filtered gate (`SubagentModals.renderSite.test.tsx:129-135`); `SHEET_WIDTH_CLASS` stays in `SubagentModals.tsx` |
| C6 | 4 | `CatalogSearchDialog` shell — **excluding `McpDialog`** | Must emit exactly `DialogContent` → scroll `div` with nothing between (`SkillsDialog.test.tsx:313-323`, `ModelPickerDialog.test.tsx:215-222` walk `parentElement`); pass `className` through `cn()` |
| C7 | 6d | The full 50-`<button>` sweep, **one a11y group per commit** | See the modification note above |
| C8 | 15 | `cn()` on every component taking `className`; `MutedCaption`, `ErrorLine`, `EmptyListLine`; **plus the lint rule** so this cannot regress a third time | Second audit to flag this — the rule is mandatory |

#### Phase D — the mega-files, now affordable

| # | Finding | Change |
|---|---|---|
| D1 | 12a | Split `lib/tauri.ts` by domain behind a `lib/tauri.ts` re-export **barrel**, so no consumer changes |
| D2 | 13a | `useSettingsDocument()` — single owner of the settings document; retire `SettingsPage`'s local mirror + its 8 mutation functions |
| D3 | 14b | Collapse `SubagentDelegatingCard`'s two row derivations into `subagentRowsOf(...)` (the two `??` chains have already diverged) |
| D4 | 2 | `ChatStream.tsx` hooks: `useMentionPicker` (`:468-858`), `useAttachmentStaging`, `useComposerSend` (`:935-1362`), `usePromptQueueFlush` — hooks, **not** JSX; guarded by `ChatStream.test.tsx` |
| D5 | 16b | The ADR-backed rename PR: `MessageBubble`, `ChatStream`/`components/chat/`/`bg-chat`, `Reasoning*`, `TodoBoardPanel`, bare `rail`, `QueuedSummaryContent`, `Sudo*Modal`. Touches 4 source-grep test files, ~50 `data-testid`s, and amends CONTEXT.md in the same commit. **`SubagentDelegatingCard`/`SubagentTranscript`/`SubagentModals` are blessed by ADR 0066 — not renamed** |

**Explicit non-goals carried forward:** do not split `store/sessions.ts` (its size holds ADR 0016's ordering, 0073, 0049, 0041); do not adopt `ui/tabs.tsx`; do not extract the ~247 single-consumer JSX blocks — extract the ~15 duplicated ones.

## Top Recommendation

**Start with the two prerequisites, then take the free win.**

1. **Finding 1 (re-point the source-grep tests at the DOM).** Nothing else in this report can land cleanly while `themeTokens.test.ts:824-835` counts utilities per file and `slabFloatSeparation.test.ts` throws at a moved class string. It is the only increment whose entire output is a test change, and the repo has already retired one such pin for the same reason (`skills.test.ts:18-28`) — argue it from that precedent.
2. **Finding 8 (`sessionLookup.ts`).** Six copies of one walk is the substrate under `ChatStream`, `SidePane` and `SpacesList`. Extracting composer or picker hooks *before* this just relocates the duplication.
3. **Finding 11's `useCopyButton`** as the first visible extraction: ~49 lines → ~12, verified zero blast radius, and it makes the pattern of "extract the machine, keep the markup at the call site" concrete before the contested ones (`SessionListRow`, `CatalogSearchDialog`) come up.

The ordering principle throughout: **reduce risk before reducing size.** Findings 14 (`subagentActivity.ts`, 217 pure lines, no structural risk) and 10/15 (formatters, `cn()`) are the same idea — behaviour-preserving increments with existing tests as the guard — and they build the muscle and the test helpers that make findings 2, 3 and 4 affordable. The mega-files come down as a *consequence* of that, not as a target: `ChatStream.tsx` is 822 code lines behind 1,108 lines of documentation, and its test file is 7,903 lines — deleting JSX there would be the least valuable thing you could do.
