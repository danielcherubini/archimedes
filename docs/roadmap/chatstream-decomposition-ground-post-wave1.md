---
status: grounding-report
title: "chatstream-decomposition — post-wave-1 delta (what moved, what did not)"
base: b0071544
head: 27cec040
branch: feature/chatstream-decomposition
generated: 2026-11-01
supersedes: parts of chatstream-decomposition-ground-chatstream-body.md and chatstream-decomposition-ground-chat-test-scaffolding.md (both still valid; read them first)
---

# Post-Wave-1 delta — `ChatStream.tsx` / `ChatStream.test.tsx`

Wave 1 (commits `35d1efaf` = task A1 session/capability derivations, `99166759` = task A2 test scaffolding extraction, merged at `27cec040`) changed exactly two files:

- `src/components/ChatStream.tsx` — 1488 lines at HEAD, was 1553 at `b0071544` (−65 net; `git diff --stat` = +14/−113, i.e. 127 changed lines: 14 insertions, 113 deletions).
- `src/components/ChatStream.test.tsx` — 7673 lines at HEAD, was 7885 at `b0071544` (−212 net; `git diff --stat` = +35/−247).

Everything a Wave 2–4 planner needs that is NOT listed below is unchanged from the two earlier grounding reports. Verify nothing below against earlier reports; this delta is stricter and supersedes only what it names.

## 1. Where the session/capability derivations live now

They moved OUT of `ChatStream.tsx` into two new files (both tracked at HEAD):

- **Pure logic:** `src/lib/chatSessionDerivations.ts` (137 lines) — five exported functions:
  `classifyInteractiveRequests`, `anchoredAskRequestIds`, `stackedAskRequests`, `sessionKindDerivations`, `turnDiffs`.
- **The hook:** `src/hooks/useChatSessionDerivations.ts` (98 lines) — one export, `useChatSessionDerivations()`, an un-memoised adapter that reads the stores (`useSessions`, `useInteractive`) and calls the pure module plus `agentSupportsImages` (from `../lib/chatAttachments`) and `sessionFieldOf` (from `../lib/sessionLookup`, which is still in the tree).

The hook returns **12 names**: `askRequests`, `confirmRequests`, `passwordRequests`, `anchoredAskRequestIds`, `stackedAskRequests`, `isLive`, `isHistoryOnly`, `canResume`, `composerEnabled`, `imageCapable`, `lastUserIndex`, `turnDiffs`.

The component destructures 9 of them at the top of the component body (above the early return):

```tsx
  const {
    askRequests,
    confirmRequests,
    passwordRequests,
    stackedAskRequests,
    isLive,
    canResume,
    composerEnabled,
    turnDiffs,
    imageCapable,
  } = useChatSessionDerivations();
```

(Current lines 96–105; the import is line 46: `import { useChatSessionDerivations } from "../hooks/useChatSessionDerivations";`)

**Critical for the attachment and dispatch planners:**

- `imageCapable`, `composerEnabled`, `isLive` and `canResume` are NO LONGER component-local `const`s. The `activeCapabilities` selector is GONE from the component (grep count = 0), the `sessionFieldOf` import is GONE (grep count = 0; the `import { sessionFieldOf } from "../lib/sessionLookup";` line was deleted — the diff's first hunk). A hook extracted from this file must therefore receive `isLive`, `canResume`, `composerEnabled`, `imageCapable` (and/or their inputs) as ARGUMENTS.
- The pure derivation for `imageCapable` is `agentSupportsImages(activeCapabilities)` — still exported from `src/lib/chatAttachments.ts` at line 134 (byte-identical file, see §2). The `activeCapabilities` value itself now only exists inside `useChatSessionDerivations`; a new hook needing to recompute `imageCapable` must recompute the capabilities (store selector walking all three session lists via `sessionFieldOf`, per the comment now living in the hook) or receive the already-derived booleans as props.
- `isHistoryOnly` has no consumer left in the component (it is still returned by the hook). Note also `lastUserIndex` and `turnDiffs` are now supplied by the hook; `lastUserIndex` is NOT destructured by the component (unused there) — the component's `turnDiffs` comes from the hook.

Consumers of the destructured names inside the current component (for the planners' own seam audits):

- `imageCapable`: destructure line 104; comment 530; `hasImages = attachments.length > 0 && imageCapable` line 535 (`let`, re-derived after `resume()`); flushHead comment 986 + fail-closed gate 1018/1025; `handlePaste` gate 1224; comment 1286; `handleDrop` gate 1294; `handleAttachClick` gate 1313; prop `imageCapable={imageCapable}` line 1471.
- `composerEnabled`: `handleAttachClick` gate 1313; prop `composerEnabled={composerEnabled}` line 1469 (plus the "composerEnabled DOES stay" comment 1310).
- `isLive`: auto-resume block inside `send` (`if (!isLive) { if (!canResume) return; if (!(await resume())) return; … }`).
- `canResume`: the same auto-resume block.
- `turnDiffs`: passed to the `Changes`/file-summary render path.

## 2. What did NOT move (planners keep trusting their area reports)

Verified byte-identical to `b0071544` by extraction from `git show` both sides and `diff -q` — zero diff hunks inside any handler span; `git log b0071544..HEAD` shows NO commits touching these files:

- `src/lib/chatAttachments.ts`
- `src/lib/chatAttachmentMetadata.ts`
- `src/components/chat/AttachmentStrip.tsx`
- The attachment/dispatch seams `sendText` (new 553–691 = old 602–740), `send` (new 692–987 = old 741–1036), `flushHead` (new 988–1113 = old 1037–1162) — all nine seam bodies byte-identical (see the table in §3).
- `resume` — new 1114–1127 = old 1163–1176 byte-identical. It is NOT a body change; the single hunk near it is a comment ABOUT the moved derivations (see below).

Current `resume` body, unchanged (quote for the dispatch planner):

```tsx
  const resume = async (): Promise<boolean> => {
    if (!activeSessionId || resuming) return false;
    setResuming(true);
    setError(null);
    try {
      await resumeSession(activeSessionId);
    } catch (err) {
      setError(describeIpcError(err));
      return false;
    } finally {
      setResuming(false);
    }
    return true;
  };
```

The **only** changes in `ChatStream.tsx` (7 unified hunks, `--unified=0` old-line headers: `-17` imports, `+46` import, `-81`(81–106), `-113`(113–141), `-245`(245–246), `-323`(323–325), `-523`(523–537), `-1183`(1183–1202)):

1. Deleted `import { sessionFieldOf } from "../lib/sessionLookup";`
2. Added `import { useChatSessionDerivations } from "../hooks/useChatSessionDerivations";`
3. Removed `liveSession` + `activeCapabilities` + `activeSessionIsKnown` selectors (the whole `activeCapabilities`/`sessionFieldOf` tree) and the `interactiveRequests` + ask/confirm/password/anchored/stacked block — replaced by the destructure call (hunk `-81,26`).
4. Comment-only tweak at 245: "`isLive` below stays" → "`isLive` comes from `useChatSessionDerivations` (above)".
5. Removed the component-local `imageCapable = agentSupportsImages(activeCapabilities)` (hunk `-323,3`) — now in the hook.
6. Removed the `isLive`/`isHistoryOnly`/`canResume`/`composerEnabled` block + long comment (hunk `-523,15`); replaced by a comment pointing at the hook.
7. Removed the `lastUserIndex`/`turnDiffs` block (hunk `-1183,20`) — moved to the hook, comment and all.

No other hunks. Confirmed: no changed hunks inside any of the nine seam bodies, `hasImages`, or the auto-resume block.

## 3. Current line spans in `ChatStream.tsx` (1488 lines at HEAD)

| Symbol | New lines (HEAD `27cec040`) | Old lines (`b0071544`) | Bytes vs old |
|---|---|---|---|
| `sendText` | 553–691 | 602–740 | identical |
| `send` | 692–987 | 741–1036 | identical |
| `flushHead` | 988–1113 | 1037–1162 | identical |
| `resume` | 1114–1127 | 1163–1176 | identical (body; see §2) |
| `stageFiles` | 1156–1222 | 1221–1287 | identical |
| `handlePaste` | 1223–1292 | 1288–1357 | identical |
| `handleDrop` | 1293–1311 | 1358–1376 | identical |
| `handleAttachClick` | 1312–1357 | 1377–1422 | identical |
| `removeAttachment` | 1358–1385 | 1423–1450 | identical |
| `if (!activeSessionId)` early return | 516 (through ~525, the no-session `<main>` frame) | 565 | moved up with its block |
| unconditional hook block | ~74 (first selector after `export default function ChatStream()`) through 515 (`useSessionIdleEdge`), the last hook before the early return; `useChatSessionDerivations` destructure at 96–105 | — | — |

Line count: **`src/components/ChatStream.tsx` = 1488 lines** (`wc -l`).

Span notes (orientation, symbol names in prose): `sendText` spans the "shared send tail" doccomment straight above and ends before `send`; `send` is the long send path (includes the auto-resume block, the `liveIds` reconcile, the mid-send `FileReader` restore, the MAX_CHAT_ATTACHMENTS restore); `flushHead` is the Flush implementation reached via `flushRef` (whose ref assignment + `useSessionIdleEdge` block sit at 497–515, before the early return); the five attachment handlers are still in a contiguous run 1156–1385 behind the "Image-attachment handlers (plain functions…)" comment; `composerLocked` and the `hasImages` re-derivation sit between the early return and `sendText` (see 524–538).

## 4. What `ChatStream.test.tsx` looks like now (7673 lines at HEAD)

The scaffolding moved to `src/test/chatStreamFixtures.ts` (262 lines, tracked; 14 exported symbols — 3 constants, 6 seeds, 5 interaction helpers). The import (lines 50–65):

```tsx
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

That is the full 14-name pull from `} from "../test/chatStreamFixtures";` (line 65). All seeds/helpers are IMPORTED now, not local definitions.

Remaining at module scope (line numbers current):

- Line 87: `beforeAll(() => { … })` — the two `URL` object stubs + three `HTMLElement.prototype` stubs (all five still DEPENDENCIES, kept locally, per the comment at 67–85; the setup-file `stubGlobal`s were removed in earlier B-migrations, not wave 1).
- Line 97: `vi.mock("../lib/tauri", async () => { … })` — factory INLINE, spreads `await vi.importActual("../lib/tauri")` and overrides `startSession`/`closeSession`/`sendPrompt`/`resumeSession`/`respondPermission`/`respondInteractiveRequest` (+ more; body spans 97–183).
- Line 187: `vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }))` — closed factory, INLINE.
- Line 191: module-scope `beforeEach(() => { … })` — real timers, `setSidePaneCollapsed(false)`, `localStorage.clear()`, the queued-prompt singleton `clearSession` loop, `vi.clearAllMocks()`, `clearSkillCatalogCache()`, `clearMentionCatalogsCache()`, `resetStores()`.
- The 11 `describe`s, unchanged count:

| `describe` start line (current) | Title |
|---|---|
| 231 | `ChatStream` |
| 4055 | `ChatStream — out-of-Space Directory completion (ADR 0035)` |
| 5664 | `ChatStream (a child gate renders inline in the PARENT's transcript)` |
| 6004 | `ChatStream (a child gate scrolls into view)` |
| 6174 | `ChatStream — the /compact Composer command (ADR 0044)` |
| 6302 | `ChatStream — the [image #N] staging marker` |
| 6625 | `ChatStream — the failed-send attachment restore` |
| 6756 | `ChatStream — send() forks to the prompt queue while the composer is locked` |
| 6977 | `ChatStream — the Flush: the queue drains when the Session goes idle` |
| 7480 | `ChatStream — staging attachments is allowed while a turn is in flight` |
| 7608 | `ChatStream — the empty-state film beside a non-empty prompt queue` |

New file line count: **7673** (`wc -l`); old 7885. `git diff --stat` = +35/−247.

## 5. Wave-1 gate numbers (for later-waves reconciliation)

Recorded by the status file's wave-1 changelog entry (this report does not re-run the suite):

- Integrated `pnpm test` → **160 files, 3353 passed | 1 skipped**, exit 0, measured on the integrated tree at `27cec040`.
- Identity: baseline at `b0071544` = **157 files, 3318 passed | 1 skipped**; task01 added 28 (`src/lib/chatSessionDerivations.test.ts` = 17 + `src/hooks/useChatSessionDerivations.test.ts` = 11), task02 added the 7-test seam file `src/test/chatStreamFixtures.test.ts`; 3318 + 28 + 7 = **3353**. Nothing lost, nothing silently skipped.
- `ChatStream.test.tsx` alone → **278** (`npx vitest run src/components/ChatStream.test.tsx`), unchanged from baseline — this is the component-level pin count.
- `pnpm build` (tsc + vite) → exit 0.

Do NOT restate 38 as anything to maintain: the tauri-barrel mock-set pin did NOT move — `src/lib/tauriBarrel.test.ts` (`it("the scanner sees the mock seam it exists to protect", …)` at line 398) still owns that count (`expect(mockers).toHaveLength(38)` at line 421; 37 spread `vi.importActual`). `ChatStream.test.tsx`'s tauri factory still spreads `vi.importActual`, so the count is untouched by wave 1. The pin is a SET-SIZE assertion — a number that may only move when a test file is added/removed, not something the extraction tasks maintain by hand.

## 6. The two traps still live for waves 2–4

**(a) The hook-ordering / early-return rule is unchanged and now coexists with one extracted hook.** The rule (stated at `ChatStream.tsx` 92–95, 498–499): a hook below the `if (!activeSessionId)` early return at line 516 is a conditional hook call and white-screens the app with "Rendered more hooks than during the previous render". `useChatSessionDerivations()` now sits in the unconditional block at 96–105 (the last hook before the return is `useSessionIdleEdge` at ~511–515). A new hook extracted from this component must be called IN that unconditional block, beside `useChatSessionDerivations` — any plan that wants to locate the new call below the early return (e.g. "next to `sendText`") is a white-screen bug.

**(b) The `vi.mock` probe matrix binds every new hook test file.** Appendix "vi.mock hoisting probe matrix (measured on this tree, vitest 5.0.0)" in `chatstream-decomposition-ground-chat-test-scaffolding.md` (lines 550–565, added to the working tree after base — read it BEFORE moving any factory or importing the mocked barrel from a module a `vi.mock` factory references). The operative rule: a `vi.mock` factory may reference only bindings whose module is BOTH free of any transitive import of the mocked specifier AND imported before anything that imports it. Measured rows include: helper importing the mocked module directly after target → `Cannot access '__vi_import_N__' before initialization`; reaching it transitively via a store does NOT save you; helper clean + helper-before-target is the only delegation shape that works; and the factories in `ChatStream.test.tsx` are themselves self-contained (tauri factory references only `vi.importActual`; the dialog factory only `vi`), so moving them buys nothing and costs the ordering constraint. Also carried: the "Import from a `vi.mock` factory with `await import()`" hoisting rule from `src/test/fixtures/` (scaffolding report §"fixture signatures", line 539).

Both traps are unchanged by wave 1 except that (a) now names the extracted hook as the adjacent anchor.

## Verification notes / flags

- Working tree has two uncommitted docs changes (`chatstream-decomposition-ground-chat-test-scaffolding.md` +32, `chatstream-decomposition-status.md` +38/−2) — the probe-matrix appendix and the gate record; neither touches source. Left alone.
- All line numbers above re-measured at HEAD `27cec040`; the seam-body "identical" verdicts are `sed`-extraction `diff` comparisons against `git show b0071544:…`, all nine IDENTICAL.
- The old `ChatStream.test.tsx` was 7885 lines; the new is 7673 (−212 net, −247/+35). The earlier `ground-chatstream-body.md` figures that quote the old line numbers are the stale parts this delta supersedes.