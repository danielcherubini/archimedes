---
status: committed
parent: docs/roadmap/chatstream-decomposition-status.md
done-when: "Issue #135 §5's final increment ships: `src/components/ChatStream.test.tsx` is left focused on integration wiring — the `ChatStream` describe (152 tests) plus the four remaining attachment/queue integration groups (`[image #N]` staging marker 6, failed-send restore 1, staging-in-flight 4, empty-state film 2) = **165 tests** — while the ADR 0035 out-of-Space directory-completion group (34 tests, including the nested picker-filters describe) lives in `src/components/ChatStreamDirectoryCompletion.test.tsx` and the two child-gate groups (16 tests) live in `src/components/ChatStreamChildGates.test.tsx`; every moved `it` is byte-identical to HEAD, nothing was added/deleted/altered; `pnpm test` from the repo root reports **165 files, 3356 passed | 1 skipped** (pass count UNCHANGED — tests relocated, net 0), exit 0, and `pnpm build` exits 0; the tauri-barrel mock-seam pin reads **43 mockers / 42 importActual-spreaders** with a provenance clause naming both new files, bumped in the same commit as the new files."
---

# ChatStream decomposition — Task 06 (issue #135 §5, final increment): Split the residual test suite into domain files

**Goal:** Carve the two genuinely domain-owned groups out of the residual `src/components/ChatStream.test.tsx` (6286 lines, 215 executed tests at HEAD) into two new `.test.tsx` files — the ADR 0035 out-of-Space Directory completion group (34 tests) and the child-gate groups (16 tests) — leaving the residual file at 165 tests that are all integration wiring (only the real `<ChatStream />` mount, the real `send()`, and the real DOM can prove them). **Tests move verbatim; zero behaviour change; zero tests added/removed.**
**Architecture:** Each new file carries its own verbatim copy of the module scaffold (the `beforeAll`, BOTH inline `vi.mock` factories, the module `beforeEach`, ≈140 lines) because the `vi.mock` probe matrix (scaffolding report appendix, row 1 + row 3) proves the factories **cannot** be shared across files by any module indirection. Two new files, not three: the adjacent child-gate groups (renders-inline + scrolls-into-view) share ONE scaffold. The `dirPrefix` pin moves WITH the ADR 0035 group into `ChatStreamDirectoryCompletion.test.tsx`; the `ChatStream.tsx` comment that names the pin's file, ADR 0035's two `ChatStream.test.tsx` bullets, and `docs/features/subagent-sessions.md`'s child-gate citation are all recorded post-wave follow-ups — the complete set of durable stale references this move creates, re-pathed in §Follow-ups (the sibling owns `ChatStream.tsx` this wave).
**Tech Stack:** Vitest 5 + Testing Library, jsdom (`vite.config.ts`), zustand singletons, pure TypeScript. No source change; the only non-test edit is the tauri-barrel pin count.

**Conventions governing EVERY step below (read first):**
- **Tests are MOVED, not improved.** Every moved `it`/`describe`/helper/banner/banner-comment is a VERBATIM cut from `src/components/ChatStream.test.tsx`. The ONLY permitted additions are each new file's header comment, its pruned import list, and the module scaffold (which is likewise a verbatim copy of the residual's own scaffold). If a moved test looks wrong, record it as a follow-up — do NOT edit it.
- **Anchor by SYMBOL, not line number.** All line numbers below were measured at code HEAD `bab6d68a` / docs HEAD `8013fc42` and are navigation aids only; the contract is the `describe(` title strings quoted verbatim. The grounding reports' line spans carry ±14 lines of slop (the C1 vet already recorded this); never trust a span over a symbol.
- **This task touches EXACTLY the owned set**: `src/components/ChatStream.test.tsx` (modify), the two new `.test.tsx` files (create), `src/lib/tauriBarrel.test.ts` (mock-seam pin bump only). Do NOT edit `src/components/ChatStream.tsx` (its `dirPrefix` comment fix is a recorded follow-up, §Follow-ups), nor `src/lib/chatSessionDerivations.ts` / `src/hooks/useChatSessionDerivations.ts` / `src/hooks/useChatSessionDerivations.test.ts` — the sibling D1-final task owns all four this wave.

---

## Parallelisation

**Verdict:** SERIAL — this plan holds exactly ONE task. The skill's consumed-mode rule: a one-task plan has nothing to parallelise with (parallelism in a `roadmap` run happens BETWEEN tasks, in the wave grouping `roadmap` owns; the status file records the D1 wave as width 1 with a recorded unisolated decision). The sibling task (D1-final, `docs/roadmap/chatstream-decomposition-task05-final-derivations.md`) is a SEPARATE plan in the same wave and its file set is **disjoint from this one by construction**: it owns `src/components/ChatStream.tsx`, `src/lib/chatSessionDerivations.ts`, `src/hooks/useChatSessionDerivations.ts` and `src/hooks/useChatSessionDerivations.test.ts`; this task owns `src/components/ChatStream.test.tsx`, the two new test files, and the tauri-barrel pin. Neither plan edits a file the other owns. The two cross-file seams are both safe by design: (a) D1-final introduces **no** new `vi.mock` mocker (its two test files mock nothing — verified posture), so it does not move the barrel pin this task edits; (b) this task's residual `ChatStream.test.tsx` does not touch `ChatStream.tsx`'s source, so D1-final's rewire (destructuring six new hook names, deleting two derivation blocks) cannot break any moved `it` — every moved test drives the component through the DOM only, never through `workingOrInTurn`/`composerLocked`/`history`/`loadOlder`/`hasMore`/`loadingMore`/`generation` (none appears in blocks 2–4, verified by grep). The one genuine coupling is the `dirPrefix` comment in `ChatStream.tsx` (which D1-final leaves byte-identical — its own plan forbids touching the picker region) — that stale reference is handled as a post-wave follow-up, §Follow-ups. No `**Parallel:**` line is emitted (consumed-mode rule). **Wave note for the orchestrator:** if the wave is run with width 2, each child's in-worktree `ChatStream.test.tsx` check is base-provable (this task: 165 green on the pruned file; D1-final: 215 green on the untouched file), so neither measures the other; after fan-in, the integrated gate (`pnpm test`, §Count gate) is the measurement that counts.

---

### Task 06: Split the residual `ChatStream.test.tsx` into `ChatStreamDirectoryCompletion.test.tsx` + `ChatStreamChildGates.test.tsx`

**Context:**
Waves 1–3 moved every hook-testable domain out of `ChatStream.test.tsx` (7140 → 6286 lines; 215 executed tests). What remains is the test suite reduced to what only the real component can prove — and issue #135 §5's acceptance is exactly that: "leaving `ChatStream.test.tsx` focused on integration wiring". This task performs the final increment of that reduction with an honest cost/benefit.

**The cost, stated plainly (the report's finding, re-verified):** the file's module scaffold — the `beforeAll` (object-URL pair + the three `HTMLElement.prototype` stubs, ≈14 lines incl. its comment), the `vi.mock("../lib/tauri", async () => { … })` OPEN factory (17 named overrides spreading `vi.importActual`, ≈90 lines incl. its comments), the closed `vi.mock("@tauri-apps/plugin-dialog")` factory (≈3 lines), and the module `beforeEach` (timers/side-pane/localStorage/queued-prompt loop/`clearAllMocks`/catalog caches/`resetStores`, ≈37 lines incl. its comments) — **cannot be shared across files**. The probe matrix measured on this tree (scaffolding report Appendix, vitest 5.0.0) kills every delegation shape: a `vi.mock` CALL inside an imported module → transform refuses (row 1 ❌); a helper that reaches the mocked barrel directly → `Cannot access '__vi_import_N__' before initialization` (row 2 ❌); a store-mediated transitive path (the exact shape `src/test/chatStreamFixtures.ts` has — it imports `useSettings`/`useSessions`, whose stores import `../lib/tauri`) → the SAME error, **0 tests run** (row 3 ❌). The only ✅ row is the shape the file has today: factories INLINE in the test file referencing only `vi`, seeds imported from a store-reaching module AFTER the target. **So every split file pays a verbatim ≈140-line copy of the scaffold.** The task04 precedent already accepted this cost twice (`useChatAttachments.test.tsx`, `useChatPromptDispatch.test.tsx`, `usePromptQueueFlusher.test.tsx` each carry the full block verbatim).

**The chosen split set — two new files, exactly, and which blocks stay:**

| Block (exact `describe` title at HEAD) | Tests | ≈Lines | Move? | Rationale (recorded, not assumed) |
|---|---|---|---|---|
| `"ChatStream"` | **152** (149 `it(` + 1 `it.each`×3 rows) | ≈3466 | **STAY** | This IS the integration-wiring mass the issue wants left: send/cancel/Esc, paste/drop/capabilities, mentions expansion, picker `?`/listing wiring, working-indicator/compacting render, session-kind rendering. Splitting it would make no domain file, just three copies of the same scaffold around an undifferentiated residue — the exact "split for the sake of it" the task forbids. |
| `"ChatStream — out-of-Space Directory completion (ADR 0035)"` **incl. its nested** `describe("the picker's two filters …")` (inside this block's span) | **34** | 1609 + 18-line banner | **MOVE → `ChatStreamDirectoryCompletion.test.tsx`** | Best ratio in the file: 34 tests for ONE scaffold (≈4.1 scaffold lines per test). A named, self-contained domain with its own `// ===` banner and its own four block-local helpers (`rowByPrimary`, `completionQueries`, `directoryFetches`, `routeCompletion`), all of which travel verbatim. The nested picker-filters group rides inside it (it calls `seedDiscriminatingCatalogs()` per test, so it is order-independent). **The `dirPrefix` pin lives IN this block** ("typing inside ONE directory derives ONE dirPrefix …" at HEAD ~3920) — moving it moves the pin; the `ChatStream.tsx` comment fix is the recorded follow-up (§Follow-ups), never an edit to the source this wave. |
| `"ChatStream (a child gate renders inline in the PARENT's transcript)"` | 13 | 340 | **MOVE → `ChatStreamChildGates.test.tsx`** | 13-test domain group with a clear owner (`src/hooks/useChildGates.ts` + the component's inline rendering; `SubagentModals` keeps the overlay half). Own local helpers (`childEntry`, `askChild`, `askRequestPayload`) travel verbatim. |
| `"ChatStream (a child gate scrolls into view)"` | 3 | 173 | **MOVE → same new file** | ADJACENT to the group above (the two describes abut at HEAD 5324/5665) and shares its domain. Merging 13+3 = **16 tests for ONE scaffold** — this is the "adjacent groups share a copy" move that keeps the scaffold paid exactly twice, not three times. |
| `"ChatStream — the [image #N] staging marker"` | 6 | 169 | **STAY** | Its own banner records the reason: "What stays here is the half that needs the real `send()` … both of which expand the draft on the wire, which the hook never does." This group is the residual's proof of integration wiring — moving it would relocate the proof to a file named for a hook that does not own it. |
| `"ChatStream — the failed-send attachment restore"` | 1 | 86 | **STAY** | ONE test. A third scaffold copy for a single `it` is ≈140 lines of duplication for one relocation — the clearest "not worth it" in the file. Its local helpers (`composerValue`, `composerThumbs`, `png`) also appear in the next block, keeping it in the residual preserves that sharing for free. |
| `"ChatStream — staging attachments is allowed while a turn is in flight"` | 4 | 128 | **STAY** | Attachment send-side integration (drop/`+`-picker while a turn is in flight, fail-closed capability gate). Even merged with the restore block above (5 tests), it would pay a THIRD full scaffold for groups whose recorded rationale is the real-`send()` half. LEAVE. |
| `"ChatStream — the empty-state film beside a non-empty prompt queue"` | 2 | 66 | **STAY** | A structural layout pin (film/`transcript-scroll`/`queue-rows` DOM adjacency) — component wiring by definition. 2 tests at ≈70 scaffold lines per test is the worst ratio in the file. LEAVE. |

**Total:** moved 34 + 16 = **50 tests**; residual **165 tests**; two new files (34 + 16). The scaffold is duplicated exactly twice, and every relocation is a domain (directory completion; child gates) with a named owner — none is a line-count vanity split.

**File-order safety of the move (verified, must be re-checked by the implementer per §Steps):** the nested picker-filters describe installs PERSISTENT (non-`…Once`) `listSkills`/`listAgentDefinitionsForSpace`/`listMcpServersEffective`/`listSpaceListing`/`listCompletionEntries` mocks that at HEAD leak into the later blocks. Moving block 2 out of the residual and into its own file removes that leak from the residual's file order. Re-verified block by block: block 5's `#`-collision tests seed `listMcpServersEffective` **locally** with `mockResolvedValueOnce` (order-independent); its "markers-only BYTE-IDENTICAL" test only requires that no catalog server is named a digit (true for the default `postgres` row and for the moved-away `skill-manager`/`deploy`/`Deploy` alike); blocks 6–8 seed no MCP expansion. No residual block's assertion changes when block 2 leaves. One residual **comment** goes factually stale (the "mask does NOT disable a real # mention" test's note that the default mock "is overwritten by a `mockResolvedValue` further down this file") — updating that comment is an in-scope step (§Residual edits), because it is a comment in the OWNED residual file and describes the file's new order. The moved tests themselves are byte-identical.

**Files:**
- Create: `src/components/ChatStreamDirectoryCompletion.test.tsx` (34 tests)
- Create: `src/components/ChatStreamChildGates.test.tsx` (16 tests)
- Modify: `src/components/ChatStream.test.tsx` (prune imports; delete the moved spans; fix the one stale comment in §4.c — the ONLY in-task comment edit)
- Modify: `src/lib/tauriBarrel.test.ts` (mock-seam pin: 41→43 mockers, 40→42 `importActual`-spreaders, provenance clause naming both new files — in the SAME commit as the new files)
- **NOT owned (sibling's):** `src/components/ChatStream.tsx`, `src/lib/chatSessionDerivations.ts`, `src/hooks/useChatSessionDerivations.ts`, `src/hooks/useChatSessionDerivations.test.ts`. The plan names NO edit inside any of them.

**What to implement:**

## 1. Prerequisites — verify the base one more time (2 minutes, no tests)

```sh
# The 8 top-level describes and their counts — anchor by these strings, never by line number.
grep -n '^describe(' src/components/ChatStream.test.tsx
# Block counts (executed tests = plain `it(` + `it.each` rows):
#   "ChatStream"                                    : 149 it( + 1 it.each x3 rows = 152  [measured]
#   ADR 0035 (incl. nested "the picker's two filters" describe) = 34  [measured]
#   child gate renders inline                       : 13                             [measured]
#   child gate scrolls into view                    : 3                              [measured]
#   [image #N] staging marker                       : 6                              [measured]
#   failed-send attachment restore                 : 1                              [measured]
#   staging attachments allowed while turn in flight: 4                              [measured]
#   empty-state film                                : 2                              [measured]
# Sum: 152+34+13+3+6+1+4+2 = 215  ✓   (the post-wave3 report's table sums to 213 and is WRONG:
# block 1 is 152 executed, not 150 — its "150/34/13/3/6/1/4/2" adds to 213.)
```

The file's module scaffold (imports, `beforeAll`+comment, tauri factory, dialog factory, `beforeEach`+comments) lives at the top of `src/components/ChatStream.test.tsx` (the first `describe(` is at HEAD ~line 230); copy it from THERE, verbatim, into both new files.

## 2. Create `src/components/ChatStreamDirectoryCompletion.test.tsx` (34 tests)

**Header comment** (short; model on `src/hooks/useChatAttachments.test.tsx`'s header, which records the same facts): name the file's origin (moved verbatim out of `src/components/ChatStream.test.tsx` in task06, issue #135 §5, the ADR 0035 out-of-Space directory-completion group + the nested picker-filters describe), state the scaffold rule (factories INLINE, referencing only `vi`; fixtures imported AFTER the target — the probe matrix's only safe shapes), and record that this file is one of the two new mockers counted by the tauri-barrel pin.

**Imports** (verbatim from the residual's import block, KEEPING ONLY what this file uses — `noUnusedLocals` arbitrates; the list below is the measured keep-set):

```ts
import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatStream from "./ChatStream";
import {
  sendPrompt,
  listSkills,
  listMcpServersEffective,
  listAgentDefinitionsForSpace,
  listSpaceListing,
  listCompletionEntries,
} from "../lib/tauri";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { useQueuedPrompts } from "../store/queuedPrompts";
import {
  seedLiveSession,
  seedMcpMentionsOn,
  flush,
  deferred,
} from "../test/chatStreamFixtures";
import { activeMentionToken, isOutsideSpaceQuery } from "../lib/skills";
import { resetStores } from "../test/resetStores";
import type { CompletionDirDto, CompletionEntryDto } from "../lib/tauri";
```

Import-order rule (probe matrix, ✅ row): `ChatStream` and the fixtures module must run with the mocked barrel's factories INLINE; the fixtures import must come AFTER the `ChatStream` import (the file's own fixture header warns it HAS a transitive path into the barrel via `useSettings`/`useSessions`) — keep the exact order above. Do NOT import `open as openFilePicker` (no moved test calls `vi.mocked(openFilePicker)` — an unused import fails `noUnusedLocals`). Do NOT import `useSessions`/`useInteractive`/`useSubagents`/`usePermissions` (this group seeds only through `seedLiveSession`/`seedMcpMentionsOn`; measured zero direct store reads). Keep the dialog `vi.mock` anyway (it is part of the verbatim scaffold and is cheap insurance; the task04 precedent keeps it in every split file even where `openFilePicker` is not bound).

**Scaffold** (verbatim copy from the residual): the `beforeAll` AND ITS WHOLE COMMENT, the tauri factory AND ITS WHOLE COMMENT, the dialog factory AND ITS COMMENT, the `beforeEach` AND ITS WHOLE COMMENT. Do not trim the comments and do not reword them — the task04 precedent copies the same block verbatim into every hook test file.

**Moved content**: cut from `src/components/ChatStream.test.tsx`, VERBATIM and in order:
1. The `// ====` banner above the ADR 0035 describe ("Out-of-Space Directory completion in the picker (ADR 0035, Task 5). … This is a SEPARATE describe from `ChatStream` above …" — the ~18-line section comment beginning at the first `// ====` line after the `"ChatStream"` describe's closing `});` and ending at the last `// ====` line before the describe).
2. `describe("ChatStream — out-of-Space Directory completion (ADR 0035)", () => { … });` — its four block-local functions (`rowByPrimary`, `completionQueries`, `directoryFetches`, `routeCompletion`), its 30 top-level `it(`s, and its nested `describe("the picker's two filters (substring for Mentions, subsequence for both ? arms)", () => { … });` with its own locals (`DISCRIMINATING_NAME`, `SUBSEQUENCE_ONLY_NEEDLE`, `CONTROL_NAME`, `CONTROL_NEEDLE`, `DIR`, `seedDiscriminatingCatalogs`, `primaryLines`, `typeAndWait`, `waitForRows`) and 4 `it(`s — everything from the banner's start line to the describe's closing `});`.
3. A trailing blank line after the describe's close.

Paste them into the new file after the scaffold block. The moved body is DOM-driven (`render(<ChatStream />)`, `screen`, `fireEvent`), seeds via `seedLiveSession()`/`seedMcpMentionsOn()`, waits via `flush()`/`deferred()`, and asserts on `vi.mocked(listCompletionEntries)`/`vi.mocked(listSpaceListing)`/`vi.mocked(sendPrompt)` etc. — all of which the import list above covers.

## 3. Create `src/components/ChatStreamChildGates.test.tsx` (16 tests)

**Header comment**: same template as §2 — origin (task06, #135 §5, the two child-gate groups), the scaffold rule, and the barrel-pin note (the second of the two new mockers).

**Imports** (measured keep-set; order: `ChatStream` before the fixtures, as in §2):

```ts
import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ChatStream from "./ChatStream";
import { cancelSession, respondInteractiveRequest, respondPermission } from "../lib/tauri";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import { useSubagents } from "../store/subagents";
import { usePermissions } from "../store/permissions";
import { seedLiveSession } from "../test/chatStreamFixtures";
import { resetStores } from "../test/resetStores";
```

No `waitFor` (measured: the two groups call zero `waitFor(`); no `flush`/`deferred`/`waitForCatalog`; no tauri TYPE imports; no `type Mock`; no `open as openFilePicker` (no `+` click in either group). Every import in the keep-set above is LIVE in the moved span — the counts below were re-derived by grep over the exact moved span (HEAD 5325→5837, the two child-gate describes; scaffold excluded) so the implementer can sanity-check. If any counted zero, `noUnusedLocals` reddens the file — trust the compiler over this list, but the list is the expectation:

| Import | Grep-derived uses in the moved span | Kinds of use (all `getState()`-reads — the stores are real, only the tauri barrel is mocked) |
|---|---|---|
| `useSubagents` | **11** | 11 × `useSubagents.getState().addSession(...)` (5 bare `childEntry` + 6 inline objects) |
| `useInteractive` | **12** | 10 × `useInteractive.getState().addRequest(...)` + 2 × `useInteractive.getState().requests["sub1"]` length reads |
| `useSessions` | **4** | 3 × `useSessions.getState().beginTurn("s1")` + 1 × `useSessions.setState({ messages: … })` — **NOT** "three Escape tests"; the `beginTurn` calls seed the three Esc tests, the `setState` seeds the Virtuoso-branch render test. (Earlier drafts' "three history reads" was also wrong — there are no `history` reads in this span.) |
| `usePermissions` | **2** | 2 × `usePermissions.getState().addPrompt("sub1", "p1", …)` — the two "an Escape on a child Permission prompt" tests |
| `cancelSession` | **3** | 3 × `vi.mocked(cancelSession)` assertions |
| `respondInteractiveRequest` | **3** | 3 × `vi.mocked(respondInteractiveRequest)` assertions |
| `respondPermission` | **1** | 1 × `vi.mocked(respondPermission)` |
| `seedLiveSession` | **16** | 16 × `seedLiveSession()` — the ONLY seed used; no `seedMcpMentionsOn`, no `flush`/`deferred`/`waitForCatalog` anywhere in the span |
| `clearSkillCatalogCache`, `clearMentionCatalogsCache`, `setSidePaneCollapsed`, `useQueuedPrompts`, `resetStores` | **0 in the moved body** | scaffold-only (the module `beforeEach` references all five) — exactly why each stays imported |

Also measured on the span: `act` 17, `render(` 16, `screen` 23, `fireEvent` 6, `vi` 7 (all `vi.mocked`), `it(` 16 (13 + 3), `describe(` 2 — reconciling with the 16-test split. The §2 keep-set was NOT re-derived here (block 2's own counts are unchanged and were already measured: zero direct store reads — `useSessions`/`useInteractive`/`useSubagents`/`usePermissions` each 0 in block 2, which is why §2 excludes all four).

**Scaffold**: the SAME verbatim `beforeAll` + tauri factory + dialog factory + `beforeEach` block and comments as §2 — an identical copy per file (this is the accepted, measured cost).

**Moved content**: cut VERBATIM and in order:
1. `describe("ChatStream (a child gate renders inline in the PARENT's transcript)", () => { … });` — its locals (`childEntry`, `askChild`, `askRequestPayload`) and 13 `it(`s.
2. `describe("ChatStream (a child gate scrolls into view)", () => { … });` — its locals (`FAKE_SCROLL_HEIGHT`, `watchScrollWrites`) and 3 `it(`s.
3. A trailing blank line.

The cut starts at the `describe("ChatStream (a child gate renders…` line (HEAD ~5325) and ends at the scrolls-into-view describe's closing `});` — the line immediately BEFORE the `// ── The [image #N] staging marker ──…` banner (which belongs to the marker block and STAYS in the residual).

## 4. Modify `src/components/ChatStream.test.tsx` — the residual

### 4.a Delete the moved spans (anchor by symbol)

- **Delete** from the first `// ====` line of the ADR 0035 banner (immediately after the `"ChatStream"` describe's closing `});`) through the ADR 0035 describe's closing `});` (HEAD ~3715→5324).
- **Delete** from `describe("ChatStream (a child gate renders inline in the PARENT's transcript)", …` through the scrolls-into-view describe's closing `});` (HEAD ~5325→5837), INCLUDING the blank lines that separated the two child-gate describes. Everything up to (but NOT including) the `// ── The [image #N] staging marker` banner stays.

After both deletions the file's structure is: imports → scaffold → `describe("ChatStream", …)` → marker banner → the four remaining groups. The file keeps its existing top-of-file comments verbatim.

### 4.b Prune the import block (`noUnusedLocals` arbitrates; this is the measured death list)

Remove from the tauri named import: `listCompletionEntries`, `respondInteractiveRequest`, `respondPermission` (their only live consumers were blocks 2/3; the tauri factory's own body references no module binding, so the factory survives the import removal untouched — it does not import anything, `vi.importActual` is its only free name).
Remove the entire line `import { activeMentionToken, isOutsideSpaceQuery } from "../lib/skills";` (block 2 only).
Remove the entire line `import { useSubagents } from "../store/subagents";` (blocks 3/4 only).
Remove `CompletionDirDto` and `CompletionEntryDto` from the `import type { … } from "../lib/tauri";` line (block 2 only).
EVERYTHING ELSE in the residual's import block stays, including: `type Mock` (used at HEAD ~3539/3652 in the `"ChatStream"` block), `usePermissions` (one block-1 use), `IPC_EVENTS`, `brailleLoaderVariants`/`generateFrames`/`getVariantGridSize`, `MIN_INDICATOR_WIDTH_CLASS`/`MIN_INDICATOR_WIDTH_PX`, `StopReason`, `AgentDefinitionDto`/`ListingDto`/`AppSettings`, the three fixtures constants (`MONO_ADVANCE_EM`, `SETTINGS_FIXTURE`, `PERSISTED_MCP_MESSAGE`) and every fixture helper, `useQueuedPrompts` (module `beforeEach`), `clearSkillCatalogCache`/`clearMentionCatalogsCache`/`setSidePaneCollapsed`/`resetStores` (module `beforeEach`). **If tsc flags an import this list missed, follow the compiler and report it** (the file at HEAD compiles clean, so every import is live somewhere in blocks 1/5/6/7/8; the only ones that die are the five above).

### 4.c Fix the one stale comment (in-scope; comment-only, no test edit)

In the "the mask does NOT disable a real # mention sharing the draft with a marker" test (residual block 5, the `[image #N]` staging-marker group), its inline comment says the shared default mock "is overwritten by a `mockResolvedValue` further down this file (a persistent implementation, which `clearAllMocks` does not undo)". After block 2 moves out, that override lives in `ChatStreamDirectoryCompletion.test.tsx`, not "further down this file". Reword the comment to say the mock is seeded LOCALLY on purpose (a later describe — now in the directory-completion file — seeds the MCP catalog persistently, so this assertion must not depend on file order), keeping the test body and the `mockResolvedValueOnce(...)` call byte-identical.

## 5. Modify `src/lib/tauriBarrel.test.ts` — the mock-seam pin (SAME COMMIT as the new files)

Both new files mock `../lib/tauri` BY MODULE PATH with an `importActual`-spreading factory, so the pin grows by **one mocker + one spreader per new file** (verified rule: a file that mocks the barrel by path AND spreads `vi.importActual` grows BOTH counts). Exact edits:

- Line ~427: `expect(mockers).toHaveLength(41);` → **`expect(mockers).toHaveLength(43);`**
- Line ~435-437: `expect(mockers.filter((f) => /vi\.importActual/.test(readFileSync(f, "utf8"))).length).toBe(40);` → **`.toBe(42)`**
- Extend the provenance comment (the "SET SIZE, pinned:" comment) with one clause, matching the existing chain's style: `… 39 -> 41 when the chatstream decomposition moved the dispatch/queue/flush tests into src/hooks/useChatPromptDispatch.test.tsx and src/hooks/usePromptQueueFlusher.test.tsx, which mock the barrel the documented way.` — append: "and 41 -> 43 when task06 (issue #135 §5) split the residual `ChatStream.test.tsx` into `src/components/ChatStreamDirectoryCompletion.test.tsx` and `src/components/ChatStreamChildGates.test.tsx`, which mock the barrel the documented way."
- **Cite the assertion, never paraphrase its number in a way that could drift**: the authoritative numbers are the assertions themselves; the implementer bumps what the file HAS (measured 41/40 at HEAD), and the plan's 43/42 is the expectation for the WAS/NOW arithmetic (41+2 / 40+2).

**Verify the two silent conditions of the probe matrix against BOTH new files** before running anything: (a) each tauri factory body references only `vi` and its local `actual` — no module-scope binding (`seedLiveSession`, `SETTINGS_FIXTURE`, etc. appear zero times inside either factory — same as at HEAD); (b) the fixtures import sits AFTER the `ChatStream` import in each file (the ✅ row condition).

## 6. Verification — exact commands (all from the repo root `/home/daniel/Coding/AI/archimedes-desktop`)

```sh
# Per-file (each file in isolation, the only numbers a split child can prove alone):
pnpm exec vitest run src/components/ChatStreamDirectoryCompletion.test.tsx   # expect 34, green
pnpm exec vitest run src/components/ChatStreamChildGates.test.tsx           # expect 16, green
pnpm exec vitest run src/components/ChatStream.test.tsx                     # expect 165, green
pnpm exec vitest run src/lib/tauriBarrel.test.ts                             # green, on 43/42
# Fast type-check without the vite bundle (arbitrates the death list):
npx tsc --noEmit
# The full frontend gate (the count-gate measurement):
pnpm test
pnpm build          # tsc && vite build — this IS the type-check; a lone unused import fails here
```

Do NOT run `pnpm dev` / `pnpm tauri dev` (long-running — forbidden). Do NOT run `npx prettier --check` as a gate (no prettier config; AGENTS.md's bar is `pnpm test` + `pnpm build`; do not reformat verbatim bodies).

**Steps (TDD order — the "failing first" frame for a pure relocation):**
- [ ] Verify the base per §1 (describe strings + counts).
- [ ] Create `src/components/ChatStreamDirectoryCompletion.test.tsx` per §2 (header, imports, scaffold, verbatim banner + describe).
- [ ] Create `src/components/ChatStreamChildGates.test.tsx` per §3 (header, imports, scaffold, verbatim two describes).
- [ ] Run the per-file commands for the two new files. Expected initial state: **RED as 0 tests run or a module/import error** ONLY if the scaffold is broken (a missing import, an out-of-order fixtures import after the target — the `Cannot access '__vi_import_N__' before initialization` signature, or a factory referencing a module binding). This RED is the TDD "failing test": the scaffold is the code under test. Fix the scaffold/imports until each file runs its full count green (34 / 16). **If a moved test body itself fails, do NOT edit it — record it as a follow-up and report it** (behaviour is moved, not improved).
- [ ] Cut the two spans out of `src/components/ChatStream.test.tsx` per §4.a, prune the imports per §4.b, fix the stale comment per §4.c. Do NOT touch `ChatStream.tsx`.
- [ ] Run `npx tsc --noEmit` → clean. If TS6133 names an import beyond the §4.b list, remove ONLY that name (tsc arbitrates; §4.b is the expectation, not a ceiling).
- [ ] Run `pnpm exec vitest run src/components/ChatStream.test.tsx` → **GREEN, 165 tests** (block 1's 152 = 149 `it(` + 3 `it.each` rows; plus 6+1+4+2 = 165). If the run reports fewer, a cut swallowed a test — investigate the cut boundaries, never the assertions.
- [ ] Bump the barrel pin per §5 and run `pnpm exec vitest run src/lib/tauriBarrel.test.ts` → green.
- [ ] Run `pnpm test` → **165 files, 3356 passed | 1 skipped**, exit 0 (expected; see Count gate). If a known flake is red, re-run that file (§Flakes) — never adjust it.
- [ ] Run `pnpm build` → exit 0.
- [ ] Commit with message: `refactor(chatstream): split residual ChatStream.test.tsx into directory-completion and child-gate test files (issue #135 §5)` — ONE commit containing ONLY the four owned files (the two new `.test.tsx`, the residual, `tauriBarrel.test.ts`). The pin bump and its provenance clause MUST be in this same commit (the repo rule: "a commit that says so").

**Acceptance criteria:**
- [ ] `src/components/ChatStreamDirectoryCompletion.test.tsx` = 34 tests, green alone; `src/components/ChatStreamChildGates.test.tsx` = 16 tests, green alone; residual `ChatStream.test.tsx` = 165 tests, green alone.
- [ ] Every moved `it(` title round-trips: the union of the two new files' `it(` titles (plus the territory comment about which file is where) minus the residual's titles = empty set — i.e. `grep -h '^\s*it('` over the two new files, unioned with the residual's `it(` lines, equals the pre-move 212 `it(` lines + the 3 `it.each` rows (215 executed), with zero `it(` appearing in BOTH the residual and a new file (no duplication) and zero missing (no loss).
- [ ] No test body was edited: `git diff` shows the moved lines ONLY as deletions in the residual and identical additions in the new files (byte-identical modulo whitespace at the file seams), plus the scaffold blocks, the pruned imports, and the one reworded comment in §4.c.
- [ ] The residual's module scaffold is unchanged (the `beforeAll`/factories/`beforeEach` and their comments remain verbatim); the two new files each carry the SAME scaffold verbatim (diff the scaffold region across the three files — the task04 precedent files do this).
- [ ] The `dirPrefix` pin test ("typing inside ONE directory derives ONE dirPrefix …" with its `expect(directoryFetches()).toEqual(["~/.config/"])` mutation-checked assertion) is present and green in `ChatStreamDirectoryCompletion.test.tsx`. `src/components/ChatStream.tsx`'s picker region is BYTE-IDENTICAL (no hunk in this task's diff — the follow-ups own the comments only).
- [ ] `npx tsc --noEmit` clean; `pnpm build` exit 0.
- [ ] `src/lib/tauriBarrel.test.ts` reads **43 / 42** and its provenance comment names BOTH new `.test.tsx` files; the pin's numeric literals exist ONLY in that assertion and nowhere in this plan's other files.
- [ ] `pnpm test` → **165 files, 3356 passed | 1 skipped**, exit 0 (NEVER "correct" the pass count toward 3353/3354 — the baseline at `bab6d68a` is 3356; the count is unchanged because tests moved, net 0).
- [ ] Follow-ups recorded in §Follow-ups (the `ChatStream.tsx` comment, ADR 0035's two bullets, and the subagent-sessions citation — the complete durable stale-reference set) are NOT implemented here and are listed for the next wave; item 1 is additionally recorded in the status-file Decisions log and folded into `chatstream-decomposition-follow-ups.md` before the final commit (§Follow-ups, item 1).

## Count gate — get the arithmetic right (this is where a previous plan went wrong)

**Baseline (recorded by the status file at `bab6d68a`, orchestrator-run): `pnpm test` → 163 files, 3356 passed | 1 skipped, exit 0; `pnpm build` → exit 0.** `ChatStream.test.tsx` = **215** tests today.

This task RELOCATES tests — net 0 added, net 0 deleted:
- `ChatStream.test.tsx` residual = 215 − 50 moved = **165** (152 block 1 + 6 marker + 1 restore + 4 in-flight + 2 film).
- `ChatStreamDirectoryCompletion.test.tsx` = **34** (30 top-level `it(` + 4 nested-picker-filters `it(` — all plain, no `it.each`; measured).
- `ChatStreamChildGates.test.tsx` = **16** (13 + 3 — all plain, no `it.each`; measured).
- **Per-file totals for the gate to reconcile against: 165 + 34 + 16 = 215 ✓** — the sum of the three files equals the baseline 215 exactly; any other sum means a test was duplicated or dropped.
- **File count = 163 + 2 = 165 files** (two NEW test files; no file removed). Expected `pnpm test`: **165 files, 3356 passed | 1 skipped**, exit 0 — the PASS COUNT IS UNCHANGED from the baseline. A pass count ABOVE 3356 by exactly the new-executed-`it(` count would mean a test was duplicated (wrong — do not accept); BELOW by any amount means a test was dropped (wrong — reconcile against the per-file totals above, never eyeball).
- **Correction to the caller's numbers (recorded so nobody "fixes" the gate):** the per-block counts in the task dispatch (150/34/13/3/6/1/4/2) came from the post-wave3 report's table, which is internally inconsistent (150+34+13+3+6+1+4+2 = **213** ≠ 215, and its own text contradicts the nested-filters row). Measured directly on the tree: block 1 = **152 executed** (149 `it(` lines + the single `it.each` at HEAD ~3205 with 3 rows → 149+3 = 152), and 152+34+13+3+6+1+4+2 = 215 ✓.

## Flakes (from the status file — re-run, never adjust a threshold or assertion)

- `MessageBubble.codeblock.test.tsx`'s `it.each` JSON fence case (shiki async fallback).
- `Reasoning.test.tsx`'s `is O(last line)` wall-clock assertion.
Neither file is in this task's diff. A full-suite red on either is a re-run, not a defect; the Wave-3 changelog records the exact precedent (3355 passed + 1 flake-red + 1 skipped = 3357 total, re-ran green).

## Follow-ups (recorded, NOT implemented here)

1. **The `dirPrefix` comment fix (hard-constraint 1, plain language):** `src/components/ChatStream.tsx` line ~417 says the one-directory caching property is "Pinned in `ChatStream.test.tsx` at THIS derivation". This task moves that pin into `src/components/ChatStreamDirectoryCompletion.test.tsx`, so the comment's file name becomes a lie. The sibling D1-final task owns `ChatStream.tsx` THIS WAVE and its plan forbids touching the picker region (byte-identity pin), so the fix CANNOT land in this task or the sibling's. The pin itself (the mutation-checked test) is fully live in the new file — nothing reddens in the interim; the comment is prose.
    **This follow-up is recorded TWICE so it survives the plan's own deletion.** `finish` deletes the whole `docs/roadmap/<feature>-*` family (plan, status, task plans) once follow-ups content is folded into `docs/features/` or an ADR (roadmap skill, Step 5 — "plan and status file are deleted on ship, so anything deliberately not fixed dies with them unless written there first"). The orchestrator has ALREADY been handed the same item: it is entered in the run's status-file Decisions log (`docs/roadmap/chatstream-decomposition-status.md`, under "## Decisions log") as the post-wave-4 `dirPrefix` comment fix, and it is folded into `docs/roadmap/chatstream-decomposition-follow-ups.md` before the final commit — that file is the durable home until ship, and `finish` folds its content into `docs/features/` (or an ADR) before deleting the family. Executing from the follow-up file alone, without this plan, the micro-commit is exactly:
    ```sh
    # in src/components/ChatStream.tsx, the comment block above `dirPartOfOutsideQuery`
    # (HEAD ~line 417, "Pinned in `ChatStream.test.tsx` at THIS derivation"):
    sed -i 's/Pinned in `ChatStream\.test\.tsx` at THIS derivation/Pinned in `ChatStreamDirectoryCompletion.test.tsx` at THIS derivation/' src/components/ChatStream.tsx
    # one-line comment-only change; then:
    #   git add src/components/ChatStream.tsx  &&  git commit -m "docs: repoint dirPrefix pin comment at ChatStreamDirectoryCompletion.test.tsx (issue #135 §5)"
    # verify: grep -n 'Pinned in' src/components/ChatStream.tsx  →  ChatStreamDirectoryCompletion.test.tsx
    ```
    (The `sed -i` is the orchestrator's to run — this plan's implementer NEVER edits `ChatStream.tsx`; see the owned-set rule above.) Nothing else in that comment block changes — the surrounding prose ("a hook-level caching test cannot prove it … mutation-checked — passing `token.remainder` here reddens that test") stays byte-identical.
2. **The reworded residual comment in §4.c** — implemented here because the comment is in the owned residual file and describes the residual's new order. (Listed here to prove the only comment edit in the task is exactly that one.)
3. **ADR 0035's `ChatStream.test.tsx` citations (two bullets, five test titles, at lines 30 and 35) — re-path to the new directory-completion file.** Verification (grep-confirmed at HEAD, `bab6d68a`): the ADR's `docs/decisions/0035-out-of-space-completion-is-a-one-directory-peek.md` cites, by their FULL `it(` titles, "an absorbed prose tail DOES match a row when the directory holds a name that contains it" (test at file-wide line 4907), "THE COST WE ACCEPT: a `/` in trailing PROSE reads a directory that cannot exist" (4788), "…and that impossible read holds Enter for ONE round trip, then sends" (4819), "a RELATIVE ?query with no rows still sends on Enter while a completion fetch is in flight" (4483), and "the in-flight gate holds ONLY the token under the caret, never another ? token" (4526) — and says they are "in `ChatStream.test.tsx`". ALL FIVE sit inside the ADR 0035 directory-completion block this plan moves (3716→5324), so after this task the file name in the ADR is stale; the citation text itself (the `it(` titles) stays correct. The OTHER test citations in the ADR (`completion_dir_*`, `a_key_change_*`, `expand_completion_root_*` — the Rust-side and `useMentionCatalogs.test.ts`/`skills.test.ts` pins) are NOT touched by this plan. **Scheduled with follow-up 1: same post-wave-4 micro-commit session** (they are both `ChatStream.tsx`/ADR prose, never test bodies). Exact edit — both ADR bullets, `ChatStream.test.tsx` → `ChatStreamDirectoryCompletion.test.tsx`, nothing else reworded:
    ```sh
    # docs/decisions/0035-out-of-space-completion-is-a-one-directory-peek.md
    # bullets 1 and 2 (the "Pinned in ChatStream.test.tsx on both sides" and the
    # "all in ChatStream.test.tsx" clauses):
    #   line 30: "Pinned in `ChatStream.test.tsx` on both sides: …"  →  `ChatStreamDirectoryCompletion.test.tsx`
    #   line 35: "all in `ChatStream.test.tsx`)"                      →  `ChatStreamDirectoryCompletion.test.tsx`
    # commit: docs: repoint ADR 0035's file citations at ChatStreamDirectoryCompletion.test.tsx (issue #135 §5)
    ```
4. **`docs/features/subagent-sessions.md` — one stale citation, relocated to the child-gates file.** Line 465 says the Esc-inside-the-card guarantee "now lives in `src/components/ChatStream.test.tsx` (`an Escape INSIDE the inline child card answers the CHILD and does NOT cancel the parent`)". That test title is at file-wide line 5483 — inside the renders-inline child-gate block this plan moves to `src/components/ChatStreamChildGates.test.tsx`. The neighboring clause ("with the overlay's half pinned in `src/components/SubagentModals.test.tsx`") is untouched. One re-path in the same post-wave follow-up session:
    ```sh
    # docs/features/subagent-sessions.md, line ~465:
    #   "that guarantee now lives in `src/components/ChatStream.test.tsx` (`an Escape INSIDE …`)"
    #   →  "… in `src/components/ChatStreamChildGates.test.tsx` (`an Escape INSIDE …`)"
    # commit: docs: repoint child-gate Esc citation at ChatStreamChildGates.test.tsx (issue #135 §5)
    ```
    **Completeness check (grep-derived, so this list is the whole set):** grepping `docs/` (excluding `docs/reviews/` and the `docs/roadmap/<feature>-*` family this run owns) for `ChatStream.test.tsx` yields exactly THREE durable files — `docs/decisions/0035-…peek.md` (items above), `docs/features/subagent-sessions.md` (this item), and `docs/decisions/…`'s own two bullets. `docs/reviews/2026-10-22-codebase-improvement.md` mentions `ChatStream.test.tsx` only as a hairlength figure and a guard for the issue's hook extraction (no moved test titles) — it is a point-in-time review and is deliberately left alone. Follow-ups 3 + 4 + 1 therefore close ALL persistent stale file-name references this plan's move creates — nothing else in `docs/` names a test this plan relocates. (The §4.c comment and the §UNVERIFIED banner issue are in-task or in-owned files, and are listed separately so nothing is double-counted.)
5. If any moved test body is found to be wrong during the move (a genuinely broken assertion, not a scaffold issue), record it as a follow-up and complete the relocation with the body byte-identical — the repo rule: behaviour is MOVED, not improved.

## UNVERIFIED (for the caller's vet to target)

- **No test run was performed during planning.** The per-file counts (152/34/13/3/6/1/4/2 and the 34/16/165 expectations) were derived statically with the same method the grounding report used (count `^\s*it(` lines per measured span + the one known `it.each` at HEAD ~3205 with 3 rows); the baseline gate numbers (163 files / 3356 | 1) are the status file's recorded orchestrator run at `bab6d68a`. The implementer must read the RUNNER's numbers, never an assertion.
- **Exact cut line numbers carry the reports' ±14-line slop.** Verified landmarks (grep- and read-confirmed at HEAD): block 1's describe closes with `});` around 3696 (the report's table says 3715 — the span slop the C1 vet recorded); the ADR 0035 banner occupies the ~18 lines immediately before `describe("ChatStream — out-of-Space Directory completion (ADR 0035)"`; the marker banner sits AFTER the scrolls-into-view describe's close and BEFORE `describe("ChatStream — the [image #N] staging marker"`. The plan anchors by symbol (§1) so the slop is harmless — but the vet should confirm the two cut seams against the file.
- **`usePermissions` in the child-gates group** — confirmed by grep: 2 × `usePermissions.getState().addPrompt("sub1", "p1", …)` inside the renders-inline block (the two "an Escape on a child Permission prompt" tests). The import stays regardless — the §3 table's counts are now the reference.
- **The `AppSettings`/`ListingDto`/`AgentDefinitionDto` type imports** are predicted to SURVIVE the cut (block-1 uses: 4/4/4 measured) — flagging them so the vet can confirm none is block-2-only, which would make it die too (tsc arbitrates; §4.b lists only the five certain deaths).
- **Status-file entry for respect-durable content (follow-up 1):** this plan records follow-up 1 for the orchestrator (a gitignored task plan, deleted by `finish` on ship) AND claims it is ALSO in the run's status-file Decisions log and folded into `docs/roadmap/chatstream-decomposition-follow-ups.md` before the final commit, per the roadmap skill's Step-5 rule that durable content must leave the `docs/roadmap/<feature>-*` family before `finish` deletes it. The status file (gitignored like this plan) has NO follow-up entry at the time of writing and the follow-ups file does not yet exist — both are umbrella-run artifacts the orchestrator owns, NOT files this task may write, so this plan cannot create them itself. **If the orchestrator has not entered follow-up 1 by the final commit, the `dirPrefix` comment fix dies with the family — that is the one real risk of this otherwise-safe deferral, and it is the caller's to close** (the vet confirmed nothing mechanically reads the comment and the mutation-checked pin runs green in its new file).
- **Block 2's exact interplay with the `listCompletionEntries` import in the residual:** at HEAD the only `listCompletionEntries` references outside the factory comment are in block 2 (measured), so removing the import from the residual is safe; the factory body is a `vi.fn()` literal and references no binding. The vet may want to re-grep after the cut.
- **The moved ADR 0035 banner says "This is a SEPARATE describe from `ChatStream` above …"** — after the move the `ChatStream` describe is no longer "above" in the directory-completion file (the banner sits at the top of the new file). The plan moves the banner verbatim (§2); if the vet judges "above" materially stale, the banner is moved content (not scaffold) and may be reworded in the same commit as §4.c's comment — the plan deliberately does not edit it pending that judgment.
