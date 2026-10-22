---
status: committed
done-when: Every Phase A task is merged with pnpm test and pnpm build green, so that (a) no test reads a component's source text to assert what it renders, (b) the three copy-to-clipboard machines are one hook, (c) the subagent card's pure derivations are unit-testable library functions, (d) one relative-time rule serves both session lists, (e) the app's own user-facing copy speaks CONTEXT.md's vocabulary, (f) the space switcher is a real tablist, and (g) no shipped module exports a symbol nothing imports.
---

# Frontend component-extraction program — Plan

**Goal:** Land all 18 approved findings from `docs/reviews/2026-10-22-codebase-improvement.md`, in that report's Phase A → D order.
**Architecture:** Behaviour-preserving extraction first (hooks and pure libs), then shared components, then the mega-files. Each task is independently commitable and guarded by the existing suite.
**Tech stack:** React 19, TypeScript (strict, `noUnusedLocals`), Tailwind v4 tokens, Radix, zustand-style stores, vitest + @testing-library/react (jsdom).

**Execution mode: AUTONOMOUS.** No question may be posed to the owner. Decide, act, record in `docs/roadmap/status.md` → Decisions Log. Progress state lives in `docs/roadmap/status.md`, not here.

**Validation gate for every task** (both must be green before the task is `done`):

```bash
pnpm test    # repo root; baseline 121 files / 2650 tests, ~92 s
pnpm build   # repo root; tsc && vite build; baseline green, ~6 s
```

## Parallelisation

**Verdict:** SERIAL — every Phase A task verifies through the full `pnpm test` run, and Tasks A0, A2, A6 all touch files inside `src/lib/` whose tests are selected by path from a shared suite; A1/A3/A4/A5 additionally each require a full-suite green as their acceptance criterion. Gate 4 (scoped verification suffices) fails for all seven tasks, so no wave is valid. Running serially also keeps one task per commit, which the owner's squash-merge convention requires.

Reason recorded because a missing verdict reads as "assumed": the serial decision here is forced by the shared full-suite verification artifact, not by file overlap alone (A4 and A5 do in fact touch disjoint files).

---

### Task A0: Re-point the source-grep gates at rendered behaviour

**Parallel:** none — full-suite verification; shares `src/lib/*.test.ts` suite selection with A2/A6.

**Context:**
Four test files read **component source text** and assert on it. This is the finding that blocks the whole Phase C: the highest-value DRY win in the transcript (the byte-identical hover chevron at `ToolCallCardHeader.tsx:158-163` ≡ `ChangesGroupCard.tsx:222-227`) cannot be extracted because `themeTokens.test.ts` counts `text-foreground-subtle*` utilities **per file**, so moving a muted span into a new child file reddens the donor. The repo has already retired one such pin for exactly this reason — read `src/lib/skills.test.ts:16-24`, which records that a source-reading pin was deleted as "a landmine … with no detection value the component tests did not already have". Argue from that precedent.

Read the four files before editing. Two of their gates are **genuinely textual** (they assert a CSS/palette property that no render can show) and must be **kept**, just re-scoped. Do not delete a gate you have not classified.

**Files:**
- Modify: `src/lib/themeTokens.test.ts` (the `ROW_CONSUMER_FILES` block at `:747-751`, the "keeps the three TRANSCRIPT_ROW consumers reading the tokens" test at `:795-815`, and the "leaves the row's OTHER muted spans on the foreground utilities" test at `:817-849`)
- Modify: `src/lib/slabFloatSeparation.test.ts` (the `describe("the space tabs …")` block at `:196-268`)
- Modify: `src/lib/paletteCompleteness.test.ts` (the chrome-bar test at `:760-768`)
- Modify: `src/lib/subagentSheetLayout.test.ts` (the `SOURCES` list at `:56-62` and the assertions at `:97-115`)
- Test: the files above **are** the tests — this task changes tests only

**What to implement:**

1. **`themeTokens.test.ts:817-849` — replace the per-file counts with a whole-tree count.**
   The gate's real invariant is "de-emphasis text utilities were not deleted by the row repaint" — that is a **total**, not a per-file distribution, and a distribution is exactly what an extraction legitimately changes. Replace the `expected: Record<string, number>` map (`:824-835`) with a single assertion over the union of the three files:

   ```ts
   const total = ROW_CONSUMER_FILES.reduce(
     (n, file) => n + ((stripJsComments(readTextFile(file)).match(/text-foreground-subtle(?:st)?\b/g)) ?? []).length,
     0,
   );
   expect(total).toBe(18); // 5 + 4 + 9 — verified by re-running the reader on 2026-10-22
   ```

   Keep the vacuity guard (`expect(ROW_CONSUMER_FILES.length).toBe(3)` or equivalent already present) and keep the failure-message intent. Comment **why** the count is a total: an extraction that moves a muted span into a shared child must not fail a gate about deletion.

2. **`themeTokens.test.ts:795-815` — keep the `text-row-icon` / `text-row-verb` presence checks, but drop the bounded-window regex.**
   `:814`'s `/status === "pending"[\s\S]{0,120}text-row-verb/` is a byte-offset window that breaks on JSX reordering. Replace with two independent presence assertions (`toContain("status === \"pending\"")` and `toContain("text-row-verb")` plus `toContain("animated-gradient-text")`) and a comment saying the pairing is now asserted structurally, not positionally.

3. **`slabFloatSeparation.test.ts:196-268` — convert the SpaceTabs pill contract into a component test.**
   Create `src/components/SpaceTabs.pill.test.tsx` asserting the **same two invariants on rendered DOM**:
   - every tab pill carries `h-8` and `rounded-md` in its `className`, for both the active and an inactive tab. There is **no `data-testid="space-tab"`** — the pill is `screen.getByRole("tab", { name }).parentElement` (verified: the pill holds the tab label and the ✕, and `SpaceTabs.test.tsx:268-274` relies on exactly that).
   - no active/inactive state pair differs by a **geometry** utility. Render with `/w/alpha` active, then with a different Space active, take each pill's tokenised `classList`, remove the fill/text utilities, and require the two geometry sets to be equal.
   **The stripping rule must be variant-aware, or the test fails on correct code.** Measured: active pill → `flex h-8 max-w-48 items-center rounded-md bg-surface-hover`; inactive → `flex h-8 max-w-48 items-center rounded-md bg-surface hover:bg-surface-hover`. A naive "drop `bg-`" filter leaves `hover:bg-surface-hover` in the inactive set, so the sets differ and the test goes red on a correct component. Strip `bg-*` **including variant-prefixed forms** (`hover:`, `focus-visible:`, `data-*:`) and text utilities (`text-*`); keep only `h-`/`w-`/`size-`/`rounded*` — mirroring the existing `GEOMETRY` regex at `slabFloatSeparation.test.ts:241`.
   Then **delete** the `describe("the space tabs …")` block from `slabFloatSeparation.test.ts` (`:196-268`, including the `throw` sites at `:212-214` and `:226-233`). The float shadow/border gates at `:74-133` stay untouched — their `FLOATS` list (`:112-117`) names only `ui/select.tsx`, `ui/dropdown-menu.tsx`, `ui/dialog.tsx`, `ui/alert-dialog.tsx`, and `:150` reads `ui/tooltip.tsx`; **no other block in that file reads `SpaceTabs.tsx`**, so deleting the tabs block is complete. Carry the vacuity guard across (`expect(pills.length).toBeGreaterThan(0)`).

4. **`paletteCompleteness.test.ts:760-768` — drop the file binding, keep it textual.**
   Replace `readFileSync("src/App.tsx")` with a scan of **all** `src/**/*.tsx` for the element carrying `data-testid="chrome-bar"`, asserting that element's `className` contains `bg-frame`. Do **not** convert this to a render: `paletteCompleteness.test.ts` is a CSS/token test with no component harness, and mounting `App` from it would import the whole app graph into a file that currently imports no React — disproportionate, and it would make a palette test depend on `App`'s store wiring. The invariant here is "the chrome bar wears `bg-frame`", which is a class-string fact about one element; making it file-agnostic but still textual is the honest scope.

5. **`subagentSheetLayout.test.ts:56-62, 97-115` — narrow the negative scan.**
   The `not.toMatch(/w-\[\d+px\]/)` / `not.toMatch(/right-\[\d+px\]/)` scans must keep their force, but they currently apply to whole files, so any future legitimate bracketed utility in `SubagentModals.tsx` fails. Re-scope: keep requiring `SHEET_WIDTH_CLASS` to be named in `SubagentModals.tsx`, and apply the `w-[Npx]`/`right-[Npx]` prohibition to `src/lib/subagentSheetLayout.ts` (where the geometry legitimately lives) rather than to the component files.
   **Two facts the plan must respect** (verified): `SOURCES` (`:55-61`) contains **`SubagentModals.test.tsx` and the test file itself**, and `PROSE` (`:74-76`) contains `docs/features/subagent-sessions.md`. So the comment-scan (`:117-165`) and the SOURCES-driven reads must keep working when a component file drops out of the *negative* scan — narrow only the two `not.toMatch` assertions, leave `SOURCES` itself intact, or the comment-scan silently loses coverage. Also note the existing scan already has to tolerate `max-w-[…]`-style utilities; do not broaden the regex while touching it.

**Do NOT change:** `paletteCompleteness`'s CSS block-order and token-inheritance gates, `themeTokens`'s CSS-layer gates, `fileIconContrast.test.ts`, `packageManifest.test.ts`, `archimedes-film/*` source-text gates. Those assert things no render can express.

**Steps:**
- [ ] Read all four test files and `src/lib/skills.test.ts:16-24`; classify each gate as DOM-observable vs genuinely-textual. Record the classification in the commit body.
- [ ] Write `src/components/SpaceTabs.pill.test.tsx` **first**; run `pnpm test src/components/SpaceTabs.pill.test.tsx` — it must pass against today's DOM (this is a characterisation test, so PASSING on first run is correct here, and failing means the assertion is wrong, not the code).
- [ ] Apply edits 1, 2, 4, 5 and delete the migrated `slabFloatSeparation` block.
- [ ] Run `pnpm test` — must be green with **no test deleted without a replacement assertion**. Compare the test count before/after: it must not drop by more than the count of migrated blocks.
- [ ] Run `pnpm build`.
- [ ] Commit: `test(fe): re-point source-grep gates at rendered behaviour so extraction is possible`

**Acceptance criteria:**
- [ ] No test in `src/lib/` asserts an exact **per-file** count of a Tailwind utility.
- [ ] `slabFloatSeparation.test.ts` contains no `throw` and no reference to `src/components/SpaceTabs.tsx`; an equivalent pill test exists at `src/components/SpaceTabs.pill.test.tsx`.
- [ ] The chrome-bar `bg-frame` invariant survives (rendered, or all-of-`src` scanned).
- [ ] `pnpm test` and `pnpm build` green.

---

### Task A1: `useCopyButton` — one copy machine instead of three

**Parallel:** none — full-suite verification.

**Context:**
The copy→confirm machine is written three times, each with its own `useState` + timer `useRef` + `1500` literal + unmount-cleanup `useEffect`: `MessageBubble.tsx:226-240` (`CodeBlock`), `MessageBubble.tsx:551-568` (`AgentText`), `ToolCallCardHeader.tsx:64-79`. The in-repo comments admit the lineage (`MessageBubble.tsx:223` "the `ToolCallCardHeader` pattern verbatim"). Verified **zero blast radius**: no `text-foreground-*` utility pinned by `themeTokens.test.ts` lives inside these ranges, and no source-grep test touches clipboard state. All three currently use `?.then`, so a rejected `writeText` silently no-ops — the hook must surface failure.

**Files:**
- Create: `src/hooks/useCopyButton.ts`
- Create: `src/hooks/useCopyButton.test.ts`
- Modify: `src/components/MessageBubble.tsx` (`:226-240` + its button at `:273-285`; `:551-568` + its button at `:600-619`)
- Modify: `src/components/ToolCallCardHeader.tsx` (`:64-78` + its button at `:135-151`)
- Modify: `src/components/MessageBubble.test.tsx`, `src/components/MessageBubble.codeblock.test.tsx`, `src/components/ToolCallCard.test.tsx` only if an assertion breaks

**Blast radius — corrected after review.** "Zero blast radius" was overstated. What is true: **no source-grep test touches clipboard state**, so nothing in `src/lib/*.test.ts` blocks this. What is NOT true: the timer semantics are pinned hard by **render** tests, which are the real guard and must stay green — `MessageBubble.test.tsx:366-408` (asserts `getTimerCount() === 1`, `advanceTimersByTime(1500)`, count back to `0`, restart-on-second-click, and unmount → `0`), `MessageBubble.codeblock.test.tsx:453-525` (the `1499`/`1` boundary and "a second click must replace the pending reset"), and the label assertions at `MessageBubble.test.tsx:313,359,385`, `MessageBubble.codeblock.test.tsx:116,167,597`, `ToolCallCard.test.tsx:268`.

Also corrected: `ToolCallCardHeader.tsx:144` (`text-foreground-subtle`) **does** sit inside the cited button range `:135-151` and **is** one of the 5 utilities `themeTokens.test.ts:827` counts. The gate survives only because this task keeps the button markup at the call site. That is the reason the markup stays — state it in the hook's doc-comment so a later reader does not "finish the job" by moving the button into the hook.

**What to implement:**

```ts
// src/hooks/useCopyButton.ts
export interface UseCopyButton {
  copied: boolean;
  failed: boolean;
  copy: () => void;
}
export const COPY_RESET_MS = 1500;
export function useCopyButton(text: string | undefined | null): UseCopyButton;
```

Semantics to preserve exactly:
- `copy()` is a **no-op when `text` is nullish or empty** (the `ToolCallCardHeader` site guards `if (!failure) return;` today).
- Uses `navigator.clipboard?.writeText(text)` — the optional chain stays, because jsdom and non-secure contexts have no `clipboard`.
- On success: `copied → true`, restart the reset timer (a second click restarts it), `failed → false`.
- On rejection: `failed → true`, `copied` stays false, and the timer still clears `failed` after `COPY_RESET_MS`. This is the one **behaviour addition** (today: silent nothing) — keep it minimal and do not add a visible affordance in this task; the three call sites keep their existing markup and labels verbatim.
- Unmount clears the pending timer (no `setState` after unmount).
- The **button markup stays at each call site** — `aria-label`/`title` differ per site (`Copy code` / `Copy response` / `Copy error`, and `Copied` / `Error copied`) and `data-testid="copy-response"` must survive. Do not build a `CopyButton` component here; that is C6/C8 territory.

Each site becomes:
```ts
const { copied, copy } = useCopyButton(failure);
```
plus the existing `<button onClick={copy} aria-label={copied ? … : …}>` — with `ToolCallCardHeader`'s `event.preventDefault(); event.stopPropagation();` kept (it sits inside a Tooltip).

**Steps:**
- [ ] Write `src/hooks/useCopyButton.test.ts` covering: copy sets `copied`; resets after `COPY_RESET_MS` using `vi.useFakeTimers()`; a second click **restarts** rather than stacking; nullish/empty text makes `copy()` a no-op (assert `writeText` not called); a rejected promise sets `failed` and does not set `copied`; unmount clears the timer (assert no state update warning and that a pending advance is inert); missing `navigator.clipboard` does not throw.
- [ ] Run `pnpm test src/hooks/useCopyButton.test.ts` → expect FAIL (module absent).
- [ ] Implement `src/hooks/useCopyButton.ts`; re-run → PASS.
- [ ] Migrate `CodeBlock` in `MessageBubble.tsx`; run `pnpm test src/components/MessageBubble.test.tsx src/components/MessageBubble.codeblock.test.tsx` → green.
- [ ] Migrate `AgentText` in `MessageBubble.tsx`; re-run those → green (this site's `data-testid="copy-response"` and accessible name `Copy response` must be unchanged — `MessageBubble.test.tsx:366-385` exercises it).
- [ ] Migrate `ToolCallCardHeader`; run `pnpm test src/components/ToolCallCard.test.tsx src/components/SubagentDelegatingCard.test.tsx` → green.
- [ ] Run `pnpm test` then `pnpm build`.
- [ ] Commit: `refactor(fe): one useCopyButton hook replaces three copies of the copy machine`

**Acceptance criteria:**
- [ ] The copy-reset interval is declared once (`COPY_RESET_MS`); no copy site hard-codes `1500`. *(Note: `AskQuestionCard.tsx:151` legitimately uses `1500` for an unrelated queued-placeholder timer — do not touch it. "Exactly one `1500` in all of `src/`" is NOT the criterion.)*
- [ ] No `resetRef` remains in `src/components/`.
- [ ] All three accessible names unchanged; `data-testid="copy-response"` unchanged.
- [ ] The timer render tests above (`MessageBubble.test.tsx:366-408`, `MessageBubble.codeblock.test.tsx:453-525`) pass **unmodified** — they are the behaviour-preservation proof.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task A2: `lib/subagentActivity.ts` — move 217 pure lines out of the card

**Parallel:** none — full-suite verification; `SubagentDelegatingCard.test.tsx` is the guard.

**Context:**
`src/components/SubagentDelegatingCard.tsx` is 696 code lines in 792 raw (93% code, the least-documented large file). Four pure derivations sit inline: `extractTargetInfo` (`:68-137`), `estimateTokensFromMessages` (`:139-158`), `getActivityDisplay` (`:186-335`), and the `FAILURE_LABELS` map (`:179-185`), plus the interfaces `RawInputTaskItem` (`:20`), `RawProgressItem` (`:27`), `RawResultItem` (`:49`), `ActivityInfo` (`:160`). They contain **no JSX** and touch no store — moving them is zero structural risk and makes them unit-testable for the first time. Do **not** collapse the two duplicated row-derivation blocks in this task (that is D3).

**Files:**
- Create: `src/lib/subagentActivity.ts`
- Create: `src/lib/subagentActivity.test.ts`
- Modify: `src/components/SubagentDelegatingCard.tsx` (delete the moved declarations, add the import)
- Modify: `src/components/SubagentDelegatingCard.test.tsx` only if it imports a moved symbol

**What to implement:**
Move **verbatim** (including their doc comments — the ADR 0055 rationale in `FAILURE_LABELS`' comment is load-bearing) into `src/lib/subagentActivity.ts`, exporting:

```ts
export interface RawInputTaskItem { … }
export interface RawProgressItem { … }
export interface RawResultItem { … }
export interface ActivityInfo { glyph?: string; text: string; duration?: string; colorClass: string; }
/** The row shape `getActivityDisplay` reads. 5 fields — verified at `:187-193`. */
export interface ActivityRow {
  status: "running" | "completed" | "failed";
  error?: string;
  reason?: SubagentFailureReason;
  progress?: RawProgressItem;
  result?: RawResultItem;
}
export const FAILURE_LABELS: Record<SubagentFailureReason, string>;   // span :179-184
// Verified inferred return type — write it explicitly, do not leave it to inference:
export function extractTargetInfo(rawInput: unknown, rawOutput: unknown): {
  targetTasks: string[];
  targetSessionIds: string[];
  inputItems: RawInputTaskItem[];
  progressList: RawProgressItem[];
  resultsList: RawResultItem[];
  details: Record<string, unknown> | undefined;
};
export function estimateTokensFromMessages(messages: Message[]): number;
export function getActivityDisplay(row: ActivityRow, sessionMessages: Message[] | undefined, now: number): ActivityInfo | undefined;
```

**Imports — corrected after review, this is what makes `tsc` pass.** Verified by scanning the moved ranges (`:68-335`) for symbol usage: only **two** `toolOutput` exports are used inside them. The other six (`formatCost`, `formatTokens`, `getModelContextWindow`, `cleanModelName`, `extractThinkingFromModel`, `formatThinkingIndicator`) are used only in the **component body**, which stays behind. `tsconfig.json:22` sets `noUnusedLocals`, so importing all of them into the new module fails `pnpm build`. The new module imports **exactly**:

```ts
import type { Message } from "../store/sessions";
import type { SubagentFailureReason } from "./tauri";
import { formatDuration, summarizeToolCall } from "./toolOutput";
```

`subagentActivity.ts` must contain **no JSX and no React import** (verified: the four functions touch no store and no hook), and `SubagentDelegatingCard.tsx` keeps its own `toolOutput` import list for the six symbols it still uses.

Keep every `??` fallback chain byte-identical; do not "tidy" the ordering. `SubagentDelegatingCard.tsx` keeps only its component and the row-derivation code, importing the rest.

**Correction to the D3 pointer:** the inline types at `:455-466` and `:579-590` are the **`interactiveCost` cast** (six optional numeric fields), *not* a second copy of `ActivityRow`. The real duplication D3 must collapse is the two row-derivation blocks (`taskKeys.map` `:407-552` vs `matchingStoreEntries.map` `:554-648`), not these casts. `ActivityRow` is exported now so D3 can reuse it — that is the whole reason it is named here.

**Steps:**
- [ ] Write `src/lib/subagentActivity.test.ts` against today's behaviour by reading the four functions: cover `extractTargetInfo` for a task-list `rawInput`, a single-task `rawInput`, and unparseable input; `estimateTokensFromMessages` for empty and populated lists; `getActivityDisplay` for each `SubagentFailureReason` (asserting the four `FAILURE_LABELS` strings, and that `reason` wins over `error`), for `running` with live `progress`, for `completed` with `result`, and for the no-anything case returning `undefined`.
- [ ] Run `pnpm test src/lib/subagentActivity.test.ts` → FAIL (module absent).
- [ ] Move the code; re-run → PASS.
- [ ] Run `pnpm test src/components/SubagentDelegatingCard.test.tsx` → green (this is the behaviour-preservation guard; if a case fails, the move was not verbatim).
- [ ] Run `pnpm test` then `pnpm build`.
- [ ] Commit: `refactor(fe): extract the subagent activity derivations into lib/subagentActivity`

**Acceptance criteria:**
- [ ] `SubagentDelegatingCard.tsx` code-line count drops by ≥180 and contains no `function extractTargetInfo` / `estimateTokensFromMessages` / `getActivityDisplay`.
- [ ] `src/lib/subagentActivity.ts` contains no JSX and imports no React.
- [ ] `SubagentDelegatingCard.test.tsx` passes unmodified except for import lines.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task A3: `lib/sessionTime.ts` + one set of user-visible formatters

**Parallel:** none — full-suite verification; touches `SpacesList.tsx` and `settings/SessionsSection.tsx`.

**Context:**
`relativeTimeFor` is duplicated **verbatim** at `SpacesList.tsx:81-91` and `settings/SessionsSection.tsx:23-33` — the second file's comment at `:18` admits it was copied rather than exported. Separately `SubagentTranscript.tsx:168` renders `{entry.metrics.durationMs} ms` and `${cost.toFixed(2)}`, bypassing the shared `formatDuration`/`formatCost` in `lib/toolOutput.ts`, so the same subagent's cost/duration read differently depending on the surface. **This task is user-visible** and that is intentional — see Decisions Log.

**Files:**
- Create: `src/lib/sessionTime.ts`
- Create: `src/lib/sessionTime.test.ts`
- Modify: `src/components/SpacesList.tsx` (delete `:81-91`, import)
- Modify: `src/components/settings/SessionsSection.tsx` (delete `:23-33` + its stale comment, import)
- Modify: `src/components/SubagentTranscript.tsx` (`:167-169` uses `formatTokens`/`formatCost`/`formatDuration`)
- Modify: `src/components/SubagentTranscript.test.tsx` (`:72`, `:86`, `:97` pins change — see below)

**What to implement:**

```ts
// src/lib/sessionTime.ts
import type { Message } from "../store/sessions";
/** A **Session**'s relative last-activity label: `now` / `Nm` / `Nh`, or null
 *  when no transcript is loaded this boot (`SessionInfo` has no `createdAt`). */
export function relativeTimeFor(messages: Message[] | undefined, now?: number): string | null;
```

Carry over the existing doc comment (both copies agree; merge the "why `null`" rationale). Both call sites import it and delete their local copies.

`SubagentTranscript.tsx` metrics line becomes, preserving the existing separators (`in · out · $ · duration`):
```tsx
{formatTokens(entry.metrics.inputTokens)} in · {formatTokens(entry.metrics.outputTokens)} out · {formatCost(entry.metrics.cost)} · {formatDuration(entry.metrics.durationMs)}
```
Note `formatCost` already returns `""` for a zero cost — that changes `"$0.00"` to nothing for a zero-cost run, which is the shared rule's intent (`formatCost` is what every other surface uses). If a zero cost would leave a dangling `· `, collapse the line by joining non-empty segments with `" · "` rather than hard-coding the separators. Prefer the join.

**Steps:**
- [ ] Write `src/lib/sessionTime.test.ts`: `<60s → "now"`, `<60m → "Nm"`, `≥60m → "Nh"`, boundary values exactly at 60_000 and 3_600_000, `undefined`/empty list → `null`, and that the **latest** (last) message is used. Pass `now` explicitly — do not depend on the clock.
- [ ] Run `pnpm test src/lib/sessionTime.test.ts` → FAIL.
- [ ] Implement; re-run → PASS.
- [ ] Migrate both call sites; run `pnpm test src/components/SpacesList.test.tsx src/components/settings/SessionsSection.test.tsx` → green. Verified pins the shared rule preserves exactly: `SpacesList.test.tsx:561` (`"1h"`), `:602` (`"now"`), `:624` (`"1h"`), `:1892` (`"now"`), `SessionsSection.test.tsx:198` (`"5m"`).
- [ ] **Update `SubagentTranscript.test.tsx:72,86,97` with the CORRECT expected strings.** Verified by executing `formatDuration`: `formatDuration(100)` → **`"0.1s"`** (NOT `"<0.1s"` — that branch is `ms < 100`, and `formatDuration(50)` → `"<0.1s"` is already pinned at `toolOutput.test.ts:540`), and `formatDuration(1234)` → **`"1s"`** (the `ms ≥ 1000` path floors to whole seconds, so `1.2s` is never produced). So: `:72` `/100 ms/` → `/0\.1s/`; `:86` and `:97` `/1234 ms/` → `/1s/`. Say in the test comment that the metric now uses the shared formatter, and why.
- [ ] Change `SubagentTranscript.tsx`; run `pnpm test src/components/SubagentTranscript.test.tsx` → green.
- [ ] Run `pnpm test` then `pnpm build`.
- [ ] Commit: `fix(fe): one relative-time rule; subagent metrics use the shared formatters`

**Note on the join:** `formatTokens(0)` → `"0"` (so the line reads `0 in · 0 out`, same as today) and `formatCost(0)` → `""`, which today leaves a dangling `· `. Joining only the non-empty segments with `" · "` fixes that and does **not** change the corrected regexes above, because none of them matches a separator or the cost field.

**Acceptance criteria:**
- [ ] Exactly one `relativeTimeFor` definition in `src/`.
- [ ] `SubagentTranscript` renders no raw `ms` and no hand-rolled `toFixed(2)`.
- [ ] The metrics-line change is called out in the commit body as an intentional user-visible fix.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task A4: Make the user-facing copy speak the glossary

**Parallel:** none — full-suite verification; 7 files touched.

**Context:**
CONTEXT.md is binding and its `_Avoid_` lists are the app's contract. The copy a **first-time user reads first** contradicts it in six places, and two more places leak internals. Copy fixes have no structural blast radius, so they go early. Fix **exactly** these, and no others:

| Site | Today | Becomes | Rule |
|---|---|---|---|
| `src/components/chat/MessageList.tsx:44` | `Start of conversation` | `Start of session` | **Session** `_Avoid_: Conversation, chat, thread, run` |
| `src/components/NewSpaceDialog.tsx:80` | `` `New conversation in ${…}` `` | `` `New session in ${…}` `` | same |
| `src/components/CloseSpaceDialog.tsx:86` | `…its conversations stay…` | `…its sessions stay…` | same |
| `src/components/settings/GeneralSection.tsx:199` | `…confined to your project folder and the system temp dirs…` | `…confined to your Space folder and the system temp dirs…` | **Space** `_Avoid_: Project, workspace, folder…` — "folder" stays for the OS-level sense; "project" is the violation. Verified clean. |
| `src/components/ChromeControls.tsx:91` | `"Expand sidebar"` / `"Collapse sidebar"` | `"Expand session list"` / `"Collapse session list"` | **Side pane** `_Avoid_: sidebar (unqualified — the LEFT pane is the Space/Session list)`. Its sibling at `:107` already says "side pane" — the two must not disagree. `"session list"` is verified clean: Session's `_Avoid_` does not list "list", and the Side pane entry itself calls the left pane the "Space/Session list". |
| `src/components/AskQuestionCard.tsx:131`, `:275`, `:307` | `` `${request.source} is asking…` `` and `{request.source}`, both gated on `isSubagent` | Key the label on the **resolved agent name**, not on `request.source` — see the recipe below. | **Todo board** `_Avoid_: \`native\` (a transport label, never a name)`; `useChildGates.ts:16` already dropped `source` for this reason. |
| `src/components/settings/ProviderSection.tsx:232` | `Its {modelCount} models will leave the model picker.` | `Its {modelCount} models will no longer be selectable.` | **Config option** `_Avoid_: Model list, model picker, settings, preferences` — the entry rejects **both** candidate words, so "model list" is NOT a valid fix (an earlier draft of this plan proposed it; corrected). Use the reword. |
| `src/components/settings/McpSection.tsx:300-302` | Actual text: *"Stored in the desktop's `settings.json` (pi's entry shape — it copy-pastes to a `mcp.json`). Merged with pi's `mcp.json` files at global precedence (project > desktop > pi-global)."* | Reword to describe the desktop's own MCP config and its precedence only, naming no retired product. | The ADRs removed that embodiment; showing it as a live merge source is a lie to the user. |

**AskQuestionCard — the corrected recipe.** Two verified facts, and the second one is what makes the naive fix a no-op:

1. `agentName` is **not reachable** at `:275`/`:307`. Props are `{ sessionId, requestId, autoFocus }`; the component imports `useInteractive` (`:7`) and `useSessions` (`:9`) but **not** `useSubagents`. The name lives in the wrappers (`TranscriptFooter` / `SubagentModals`), which render their own `↳ {agentName}` chip and pass only the child id down.
2. **`isSubagent` is dead in production.** `:131` is `const isSubagent = request?.source.startsWith("subagent:") ?? false;` — and production writes `source: "native"` unconditionally (`src-tauri/src/agent/harness/ask.rs:79`; also `agent/interactive/mod.rs:1728`, `loop/tools.rs:122,142`). `"subagent:…"` exists **only in test fixtures** (`AskQuestionCard.test.tsx:211`). So a real child gate renders `"Agent is asking…"` / `"Agent question"`, and substituting `agentName ?? "Agent"` **into the `isSubagent` arm changes nothing a user ever sees** — while the `"subagent:x"` fixture would happily go green. That is a false-confidence trap; do not write it.

The executable fix keys on the resolved name:
1. `import { useSubagents } from "../store/subagents";`
2. `const agentName = useSubagents((s) => s.entries[sessionId]?.agentName);` — returns a **primitive** (zustand stable-reference rule). `SubagentEntry.agentName: string` is at `store/subagents.ts:46`; confirm the state field name and key when you open the store.
3. `:275` → `{agentName ? `${agentName} is asking…` : "Agent is asking…"}`
   `:307` → `{agentName ?? "Agent question"}`
   `isSubagent` then remains only for `:136`'s `queued` logic — leave that alone.

**Test required (the existing fixture cannot prove this):** add a case with `source: "native"` **and** a `useSubagents` entry for that `sessionId` carrying an `agentName`, and assert the name renders. Re-seed `:211`/`:223` (which today assert `getByText("subagent:x")`) so it asserts the resolved name too. `:154` asserts `"Agent question"` for the no-name arm and stays.

**Tests this must update in the same commit** (all verified; the earlier draft of this plan named none of them):
- `src/components/chat/MessageList.test.tsx:78,100,126,152` — assert the literal `Start of conversation`.
- `src/components/ChromeControls.test.tsx:93,97,102` — assert the sidebar aria-labels.
- `src/App.test.tsx:311,345-399` — assert the sidebar labels.
- `src/components/SpaceTabs.test.tsx:248-251` and `src/components/SpacesList.test.tsx:2233-2234` — **negative** "no button named …" lists that name the OLD labels; these go stale silently if only the positive assertions are updated. Update both lists.
- `src/components/AskQuestionCard.test.tsx:223` asserts `getByText("subagent:x")` from a fixture seeded at `:211` with `source: "subagent:x"` and **no matching `useSubagents` entry** → with the fix it renders `"Agent"`. Re-seed that test with a `useSubagents` entry carrying an `agentName`, and assert the name appears. `:154` asserts `"Agent question"` (the non-subagent arm) and is unaffected.
- `CloseSpaceDialog.test.tsx:34` asserts only `/stay/i`, so it survives. `NewSpaceDialog`, `GeneralSection`'s "project folder" and `ProviderSection`'s dialog string have **no** test asserting them.

**Do NOT** rename any file, component, prop or type in this task — identifier renames are D5 only.

**Files:**
- Modify: `src/components/chat/MessageList.tsx`, `src/components/NewSpaceDialog.tsx`, `src/components/CloseSpaceDialog.tsx`, `src/components/settings/GeneralSection.tsx`, `src/components/settings/ProviderSection.tsx`, `src/components/ChromeControls.tsx`, `src/components/AskQuestionCard.tsx`, `src/components/settings/McpSection.tsx`
- Test: `src/components/chat/MessageList.test.tsx`, `src/components/ChromeControls.test.tsx`, `src/App.test.tsx`, `src/components/SpaceTabs.test.tsx`, `src/components/SpacesList.test.tsx`, `src/components/AskQuestionCard.test.tsx`

**Steps:**
- [ ] Grep for each string first to find every occurrence and every test that asserts it: `grep -rn "<string>" src`. Update those test assertions **in the same commit** — they pin copy, and copy is what is being fixed.
- [ ] For `AskQuestionCard`: write the failing assertion first — render a child `ask` gate and assert the visible text does **not** contain `native`; assert it contains the agent name. Run `pnpm test src/components/AskQuestionCard.test.tsx` → FAIL.
- [ ] Apply the `AskQuestionCard` fix → PASS.
- [ ] Apply the seven copy edits; run `pnpm test` → green.
- [ ] Run `pnpm build`.
- [ ] Commit: `fix(fe): user-facing copy speaks the CONTEXT.md vocabulary`

**Acceptance criteria:**
- [ ] `grep -rn "conversation" src/components src/lib --include='*.tsx'` finds no **user-visible** string using it.
- [ ] No `aria-label` or visible label in `src/` says "sidebar".
- [ ] `request.source` is not rendered anywhere; a child's own agent name appears instead. **Proven by a test using `source: "native"`** (the value production emits) — not by the `"subagent:x"` fixture, which would pass even if the fix did nothing.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task A5: Make the space switcher a real tablist

**Parallel:** none — full-suite verification.

**Context:**
`SpaceTabs.tsx:232` already sets `aria-selected={active}` (verified — the audit's "add aria-selected" half is already done), but the tabs have **no `role="tablist"` ancestor**, so a screen reader hears an orphaned `role="tab"` with no tablist parent. `ui/tabs.tsx` must NOT be adopted: its `p-[3px] rounded-lg bg-muted` segmented-control geometry is wrong here, and Radix Tabs has no place for the per-tab ✕ or the `New space` button (`:311-318`). **This is a two-attribute change on an existing element** (see the correction below — not a wrapper).

**Ordering:** A5 does not actually depend on A0. Adding `role`/`aria-orientation` changes no `className` string, and `slabFloatSeparation.test.ts`'s pill reader (`/className=\{`([^`$]*h-8[^`$]*)\$\{/`) and its geometry-ternary scan read class text only — so A5 passes with or without A0 landed. A5 is kept last in Phase A anyway, because it is the only task in the phase that touches the **a11y tree** and it is cheapest to land after the test-side reshuffle has settled.

**Files:**
- Modify: `src/components/SpaceTabs.tsx`
- Test: `src/components/SpaceTabs.test.tsx`

**What to implement:**

> ⚠️ **Corrected after review — do NOT wrap `{spaces.map(…)}` in a new element.** The pill wrapper inside the mapped block holds **two** interactive children: the label element carrying `role="tab"` and the ✕ close button. `SpaceTabs.test.tsx:268-274` pins exactly this (`close.parentElement === tab.parentElement`, "the wrapper is one object holding BOTH controls"). Introducing a `role="tablist"` div around the mapped pills would therefore own generic `div` children plus two buttons, which is a worse ARIA tree than the one it replaces.

Put `role="tablist"` on the **existing** container that already carries `data-testid="space-tabs"` (`:144-146`) — it *is* the tab strip:

```tsx
<div
  role="tablist"
  aria-orientation="horizontal"
  className="flex h-full min-w-0 flex-1 items-center gap-1 pl-px pr-2"
  data-testid="space-tabs"
>
```

That is a **one-attribute change** (plus `aria-orientation`). No new DOM level, so `App.test.tsx:279,284,410,433`, the middle-click test at `SpaceTabs.test.tsx:415`, every `getByRole("tab", { name })` query (`:93,94,113,114,148,171,185`) and the pill-parent assertions at `:268-274` all keep passing untouched.

**Accepted limitation — record it in a code comment.** The ✕ close button and the `New space` button remain siblings of the tabs inside the tablist. The ARIA tabs pattern has no owned-element slot for a per-tab close button, and this UI is deliberately browser-style closable tabs (`CONTEXT.md` **Space**, ADR-level: the tab strip is the chrome bar's drag region). Being a tablist with sibling controls is strictly better than orphaned `role="tab"`s with no tablist parent, and it is the same trade-off every browser-tab UI makes. Do **not** attempt to fix it further in this task (no `role="presentation"` wrappers, no restructuring of the pill, no Radix Tabs).

**Steps:**
- [ ] In `SpaceTabs.test.tsx`, write the failing assertion first:
  `expect(screen.getByRole("tablist")).toBeTruthy()` and `expect(screen.getAllByRole("tab")).toHaveLength(spaces.length)`, plus a pin that the `New space` control is not itself a tab (`getByRole("tablist").queryAllByRole("tab")` contains no element whose accessible name is `New space`). Run `pnpm test src/components/SpaceTabs.test.tsx` → FAIL.
- [ ] Add the two attributes → PASS.
- [ ] Confirm every pre-existing query in the file still passes unchanged.
- [ ] Run `pnpm test` (also guards `App.test.tsx`) then `pnpm build`.
- [ ] Commit: `fix(fe): the space switcher is a tablist (ARIA)`

**Acceptance criteria:**
- [ ] `getByRole("tablist")` resolves and every tab is inside it.
- [ ] The `New space` control is not exposed as a `tab`.
- [ ] No DOM level was added; no existing test changed other than the new assertions.
- [ ] The pill still holds both the tab and the ✕ (`SpaceTabs.test.tsx:268-274` green).
- [ ] `pnpm test` and `pnpm build` green.

---

### Task A6: Delete the ceremony nothing imports

**Parallel:** none — full-suite verification + `tsc` is the primary check.

**Context:**
Zero-consumer shipped code is not neutral: `ui/dropdown-menu.tsx` is 64% dead weight, `src/lib/ids.ts` is a branded-type layer no call site adopted (so `sessionId: string` appears 96× and the branding is invisible ceremony), and unconsumed palette tokens must be restated in `theme.css` **and** `dracula.css` **and** enumerated in the 1,472-line completeness test — three files of payroll for hues nothing renders. Verified independently: `ui/badge`, `ui/tabs`, `ui/separator` have zero importers; `lib/ids` is referenced only by its own test.

**Files:**
- Delete: `src/components/ui/separator.tsx`
- Delete: `src/lib/ids.ts`, `src/lib/ids.test.ts`
- Modify: `src/components/ui/dropdown-menu.tsx` (drop the 11 zero-consumer exports: `DropdownMenuPortal`, `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`)
- Modify: `src/components/ui/card.tsx` (drop `CardHeader`, `CardFooter`, `CardTitle`, `CardAction`, `CardDescription`; keep `Card`, `CardContent` — both used by `settings/primitives.tsx:5`)
> ⚠️ **Un-exporting is NOT the fix — delete the declaration.** Verified empirically against this repo's `tsc`: `noUnusedLocals` emits **TS6133** for an unused module-private function (and TS6196 for an unused interface). Removing `ExportName` from an `export { … }` list while leaving the `function ExportName()` body behind therefore *creates* the very error the task is trying to avoid. So: **delete the whole declaration** for anything with no internal caller, and **un-export only** where the symbol is still referenced inside its own file (an internal read counts as a use, so those are safe to keep private).

**What to do per file** (internal-use verified):

| File | Delete the declaration | Un-export, keep declared (used internally) |
|---|---|---|
| `ui/dropdown-menu.tsx` | all 11: `DropdownMenuPortal`, `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent` | — |
| `ui/card.tsx` | `CardHeader`, `CardFooter`, `CardTitle`, `CardAction`, `CardDescription` (`:23-59`) | — |
| `ui/dialog.tsx` | `DialogTrigger` (`:12`), `DialogClose` (`:20`) | `DialogOverlay` — declared `:24`, **rendered at `:57`** |
| `ui/select.tsx` | `SelectSeparator` (`:177`, used nowhere, even internally) | `selectTriggerVariants` (`:12`, used `:70`/`:78`), `SelectScrollUpButton` (`:190`, rendered `:113`), `SelectScrollDownButton` (`:208`, rendered `:127`) |
| `ui/input.tsx` | — | `inputVariants`, `InputProps` (verify an internal reader exists; if not, **delete**) |
| `ui/progress.tsx` | — | `ProgressSegment` (`:13`) if internally used, else delete |
| `ui/braille-loader.tsx` | — | `BrailleLoaderProps` if internally used, else delete |
| `ui/kbd.tsx` | `KbdGroup` (`:22`, its `:32` reference goes with it) | — |

**After pruning `dropdown-menu.tsx`, fix its imports:** `CheckIcon` and `ChevronRightIcon` (imported at `:3`) are used only at `:115`, `:159`, `:236` — all inside pruned functions — so that import becomes unused and `tsc` flags it. Remove them from the import list. The same check applies to every file above: after deleting, grep the file for each icon/util it imported and drop whatever is now unread.

**`select.tsx` and the CI question — definitive.** `slabFloatSeparation.test.ts:114` reads the whole file text for `/shadow-/` and `/border-(popover-border|border)/`. None of those class strings is contributed solely by a removed export, so pruning cannot redden it. No hedge needed.

**`tauri.ts`:** delete the TS wrappers `listAgentDefinitions` (`:959`) and `getStalledInfo` (`:1130`) and the `ToolCallDiff` type (`:129`). **Delete the `:958` comment too** — it says the wrapper is "kept on purpose", and leaving it above a deleted function is worse than the dead code was. **Scope note:** Rust still registers both commands (`src-tauri/src/lib.rs:401` `commands::sessions::get_stalled_info`, `:416`/`:417` the agent-definition commands), so do **not** claim in the commit message that an ADR retired the surface. **Touch no Rust in this task** — retiring the commands is a separate change with its own `cargo test`/`clippy` gate. Other unconsumed payload types stay for D1 (finding 12 keeps the event names).

**Explicitly NOT deletable:** `buttonVariants` in `ui/button.tsx` — consumed by `alert-dialog.tsx:5`.

**Keep, with a note:** `ui/badge.tsx` survives — C2 adds `variant: "settings"` to `badgeVariants` and migrates the 20 `SettingsBadge` sites, so leave a `// Used by settings rows as of C2` comment. `ui/tabs.tsx` has no such future and **is deleted** (A5 explicitly declines to adopt it), along with `ui/separator.tsx`.

**Test files that read source text:** `paletteCompleteness.test.ts` and `themeTokens.test.ts` read **no** `ui/*` file (their `readTextFile` targets are `App.tsx`, `ToolCallCardHeader.tsx` and the three row files), so deleting `ui/*` or `lib/ids.ts` cannot redden them. `slabFloatSeparation.test.ts` reads `ui/select.tsx`, `ui/dialog.tsx` and `ui/dropdown-menu.tsx` text — that is the one gate to re-run after pruning.

**Steps:**
- [ ] For each deletion candidate, re-verify zero consumers yourself: `grep -rn "<Symbol>\|ui/<file>" src` and confirm every hit is the definition or a comment. A hit inside a `.test.tsx` that is a **real** usage blocks the deletion.
- [ ] `git rm src/lib/ids.ts src/lib/ids.test.ts src/components/ui/separator.tsx src/components/ui/tabs.tsx`
- [ ] Prune the dead exports from `dropdown-menu.tsx`, `card.tsx`, `select.tsx`.
- [ ] Delete the two dead `tauri.ts` commands and `ToolCallDiff`.
- [ ] Run `pnpm build` — `tsc` with `noUnusedLocals` is the primary proof. Fix any fallout.
- [ ] Run `pnpm test`. **Expect** `paletteCompleteness`/`themeTokens` to complain about the CSS if you deleted CSS — you are not deleting CSS in this task (see below), so they must stay green.
- [ ] Commit: `chore(fe): delete zero-consumer primitives, dead IPC commands and the unused id brands`
- [ ] **CSS tokens: do not delete in this task.** Instead write `docs/decisions/0072-unconsumed-palette-tokens.md` (ADR format, matching the existing 63; **0072 is verified as the next free number** — highest present is `0071`, and note there is a pre-existing duplicate `0066` you are not involved with). It lists the unconsumed token families, classifies each as **reserved for an unbuilt surface** or **delete when that surface is decided**, and states that the completeness tests keep enforcing them meanwhile.
  **Derive the list yourself; do not copy a number from the audit or from this plan.** Two figures are already known to disagree (the audit says ~87; a naive static scan of `src/styles/theme.css` says 137 of 174 declared `--color-*`). The reason they disagree is the method's weakness, and the ADR must say so: a token consumed through a **runtime-composed class name** (the file-chip and language-descriptor tables build utility strings at render time) reads as unconsumed to any static grep. `--color-file-*` (×26) is the prime suspect — there is a whole `fileIconContrast.test.ts` policing it, so it is consumed by construction. For each family, either find a static consumer or check for a table/record that maps to it before calling it unconsumed. Candidates worth investigating (all live in `src/styles/theme.css` and `src/styles/dracula.css`, **not** `src/index.css`): `--color-terminal-*` (~20), `--color-usage-*` (~11, split `usage-chart`/`usage-heatmap`), `--color-git-*` (×8), `--color-context-*` (~7), `--color-plugin-*`, `--color-workflow-*`, `--color-skill-*`, `--color-command-*`, `--color-subagent-*`, `--color-session-*`, `--color-thinking-*`. The audit's "role-chip families ×18" is **wrong as named** — no `--color-role-*` tokens exist; re-derive rather than transcribe it. Commit separately: `docs: record the unconsumed palette token families (ADR 0072)`

**Acceptance criteria:**
- [ ] No shipped `src/` module exports a symbol with zero importers, except deliberate `ui/*` primitives retained with a comment naming their future consumer.
- [ ] `src/lib/ids.ts` is gone and `sessionId: string` is unchanged everywhere (deleting the brands does not add churn).
- [ ] `pnpm build` green (`noUnusedLocals` satisfied).
- [ ] `pnpm test` and `pnpm build` green.
- [ ] ADR 0072 committed.

---

## After each phase

Update `docs/roadmap/status.md`: mark the phase's tasks `done` with commit SHAs, then plan the **next** phase in this same file (append a `## Phase <N>` section in the same task format) and continue the loop. Do not stop to report to the owner. **Vet every new phase's plan with parallel scoped reviewer dispatches before executing it** (see the Decisions Log: one broad dispatch truncates; several narrow ones do not).

Phase A: **complete** — A0 `22ed787`, A1 `ea6fe14`, A2 `edc2c33`, A3 `3886fae`, A4 `b5d0967`+`ff21d01`, A5 `3b6ffb4`, A6 `287019f`+`3718ffc`.

---

## Phase B — the substrate

**Measured before planning (these numbers are the plan's premises, re-derive them if the tree moves):**

| Fact | Measured 2026-10-22 |
|---|---|
| `historySessions.find` walks outside `store/sessions.ts` | **5** sites: `SidePane.tsx:237`, `ChatStream.tsx:119`, `sessionConfig.ts:65` and `:90`, `useActiveSpaceCwd.ts:43` (the audit said 6; `SidePane.tsx:247-258`'s title walk does *not* use `historySessions.find` on a `SessionInfo` field the same way — verify) |
| `verbatimModuleSyntax` errors if switched on today | **5, not a tree-wide sweep** — measured by flipping it and running `tsc`. See B3 |
| `listen*` wrappers with a bare event-name string | **11** in `tauri.ts` (`:1101`–`:1234`) |
| Test files with their own `vi.mock("../lib/tauri")` factory | **25** |
| Test files stubbing `matchMedia` / `scrollIntoView` | **22 / 14** |
| `src/test/` today | `setup.tsx` 26 lines + `setup.test.tsx` 37 |
| `vite.config.ts` has **no** `test.typecheck` block | so `expectTypeOf` assertions never execute (this is why deleting `ids.test.ts` in A6 cost no real coverage) |

**Phase B order: B4 first, then B1, B2, B3.** The report lists them B1→B4, and B1→B4 is wrong for execution: **B4 is the task that makes every other task cheap to test**, and B1's new `sessionLookup.test.ts` wants session-row fixtures that do not exist yet. Doing B4's *infrastructure* first and migrating test files *along the way* (each migrated file is its own commit) keeps the phase moving. The bulk 25-file migration is explicitly NOT in Phase B — see B4's scope line.

### Parallelisation

**Verdict:** SERIAL — B4 touches test files across the tree and every task's acceptance criterion is a full `pnpm test` run (gate 4). B1 and B2 additionally both touch `src/lib/` and B3 touches `tsconfig.json`, a shared config artifact (gate 3).

---

### Task B4a: Test infrastructure — fixtures, `resetStores()`, `renderWithProviders()`

**Parallel:** none — full-suite verification; creates shared fixtures that later tasks consume (gate 3: shared fixtures are a shared mutable artifact).

**Context:**
`src/test/setup.tsx` is 26 lines holding only a Virtuoso stub and two scroll no-ops. Everything else is re-declared per file: **25** test files carry their own `vi.mock("../lib/tauri")` factory, 22 stub `matchMedia`, 14 stub `scrollIntoView`. Two `AppSettings` literals are byte-identical across `ChatStream.test.tsx:61-91` and `MessageBubble.codeblock.test.tsx:37-67`, and `App.test.tsx:76-105` is **stale — missing the `palette` key**, which is only possible because the literal is untyped. `SpacesList.test.tsx:100-104` names the cause precisely: a hoisted `vi.mock` factory cannot reference an outer `const`, so a new settings field must be added to every literal **by hand**.

That is why extraction currently *costs* coverage: a new small component has no cheap way to get a test, so tested-rate by size is inverted (34% under 50 lines, 92% over 350). This task builds the seam. `src/components/AgentsDialog.test.tsx` is the model — it declares that it needs **no** IPC mock; read it first.

**Files:**
- Create: `src/test/fixtures/settings.ts`, `src/test/fixtures/sessions.ts`, `src/test/fixtures/subagents.ts`, `src/test/fixtures/index.ts`
- Create: `src/test/resetStores.ts`
- Create: `src/test/renderWithProviders.tsx`
- Create: `src/test/fixtures.test.ts`
- Modify: `src/test/setup.tsx` — absorb the `matchMedia` + `scrollIntoView` + pointer-capture stubs **globally** (they are already stubbed identically in 22 and 14 files)
- Migrate (one commit each, ≤3 in this task): `src/components/SpaceTabs.pill.test.tsx`, `src/components/SpaceTabs.test.tsx`, and the new `src/lib/subagentActivity.test.ts` if it seeds stores

**What to implement:**

1. **`src/test/fixtures/settings.ts`** — one typed factory, the single place `AppSettings` is spelled:
   ```ts
   /** A complete `AppSettings` with per-test overrides. Typed, so a new field on
    *  the real type is a COMPILE ERROR here — which is the whole point: today a
    *  new field silently misses all N hand-copied literals (App.test.tsx's
    *  literal is already missing `palette` and nothing noticed). */
   export function makeSettings(overrides?: Partial<AppSettings>): AppSettings;
   export const DEFAULT_SETTINGS: AppSettings;
   ```
   Derive the field set from the real `AppSettings` in `src/lib/tauri.ts` — do not copy a stale literal out of a test file. All **22** top-level fields are required (`theme: "dark"`, `palette: null`, `filePolicy: {reads,writes,shell}`, `web: {…6}`, `font: {…3}`, …), so the factory must supply every one; that is exactly why the untyped literals drifted.
   **Hoisting — corrected after review.** `vi.hoisted()` is *per test file*, so it does not make a fixture module importable from inside a `vi.mock` factory. The mechanism that works here: the repo's 28 `vi.mock` factories are already `async`, so **`await import("../test/fixtures/settings")` inside the factory** is the simple, correct route. Use that, and document it at the top of the module — it is the thing `SpacesList.test.tsx:100-104` says it cannot do today.
2. **`src/test/fixtures/sessions.ts`** — `makeSessionRow(overrides)` (a `SessionInfo`), `makeMessage(overrides)` (a transcript `Message`), and `makeState(overrides)` returning a `SessionConfigSource`-shaped object, since `sessionConfig.ts` and B1's `sessionLookup.ts` are both tested against that shape.
3. **`src/test/fixtures/subagents.ts`** — `makeSubagentEntry(overrides)`, `makeSubagentState(...)`.
4. **`src/test/resetStores.ts`** — `resetStores(): void` over the **seven** stores (`useSessions`, `useSettings`, `useSubagents`, `useInteractive`, `useSubagentSelection`, `useQueuedPrompts`, `usePermissions` — that list is verified complete). Prefer each store's own `setState(<captured initial>)`; do **not** hand-write full shapes when zustand already has the initial.
   **Three verified traps:**
   - **`setState` shallow-merges**, so a partial reset leaves stale keys — reset whole slices and say so in the doc-comment.
   - **Module-scope state is not store state and `resetStores()` cannot touch it.** Verified in `src/store/sessions.ts`: `inFlightToggles` (`:598`), `committedTrusted` (`:606`), `newSessionInFlight` (`:612`), `clientMessageSeq` (`:620`) are module `const`/`let`, and `leftPaneState.ts:43`, `sidePaneState.ts:25`, `newSpaceDialogState.ts:30` hold module-level pane/dialog state (~48 test files reset those by hand today). **Either fold explicit reset functions for them into this helper or name the helper for what it does** (`resetStores()` clears stores; module state needs its own named resets). Do not let the name promise isolation it does not provide — a test that trusts the name and inherits a dirty module Map is the worst kind of flake.
   - **Four test files call `vi.unstubAllGlobals()`** (`EmptyStateFilm.test.tsx`, `lib/theme.test.ts`, `archimedes-film/compositor.test.ts`, `lib/settings.test.ts`). That removes anything a setup file `vi.stubGlobal`s, so a global stub added in step 6 can be pulled out from under a later test in the same worker. Keep per-file stubs in place for exactly that reason (step 6 does not delete them) and note this hazard in `setup.tsx`.
5. **`src/test/renderWithProviders.tsx`** — `renderWithProviders(ui, options?)` wrapping RTL `render` with whatever providers the app needs, so a component test is 3 lines. Keep the plain `render` usable; this is additive.
6. **`src/test/fixtures.test.ts`** — proves the fixtures are real: `makeSettings()` satisfies `AppSettings` (a type-level assertion **plus a runtime** one, since `expectTypeOf` never runs in this repo — no `test.typecheck` block), `makeSessionRow()` defaults are internally consistent, `resetStores()` really clears a dirty store (dirty it, reset it, assert it is clean — this is the test that catches a shallow-merge bug).

**Do NOT** migrate all 25 mock factories in this task. Build the infrastructure, migrate ≤3 files as proof it works, and record the rest as a rolling migration: **every task from here on migrates the test files it already touches.** That is how the 833 lines actually go away without one unreviewable commit.

**Steps:**
- [ ] Read `src/test/setup.tsx`, `src/components/AgentsDialog.test.tsx`, and one heavy file (`SettingsPage.test.tsx:85-324`) to see what the seam must absorb.
- [ ] Write `src/test/fixtures.test.ts` FIRST → confirm FAIL (modules absent).
- [ ] Implement the fixtures + `resetStores` + `renderWithProviders`; re-run → PASS.
- [ ] Move the `matchMedia`/`scrollIntoView`/pointer stubs into `setup.tsx` **without deleting any per-file stub yet** → `pnpm test` must be green. Verified: no test stubs `matches: true`, so that worry is unfounded — but **five files assert on the stub's presence or absence** and must be checked individually: `usePrefersReducedMotion.test.ts:135-138` *deletes* `window.matchMedia` and asserts `typeof !== "function"`; `braille-loader.test.tsx:33`, `QueueRow.test.tsx:25`, `QueueRows.test.tsx:24`, `EmptyStateFilm.test.tsx:297` guard on `typeof matchMedia !== "function"`; `AskQuestionCard.test.tsx:48-50` restores a captured `originalScrollIntoView` via `Reflect.deleteProperty`. A global stub can flip those guards — if a global stub makes any of them non-green, that file keeps its local stub and the global one is scoped down.
- [ ] Migrate `SpaceTabs.pill.test.tsx` and `SpaceTabs.test.tsx` to the shared harness; re-run those two files → green.
- [ ] Run `pnpm test` then `pnpm build`.
- [ ] Commit: `test(fe): shared fixtures, resetStores and renderWithProviders`

**Acceptance criteria:**
- [ ] `src/test/fixtures/` exists and `fixtures.test.ts` proves `resetStores()` fully clears a dirtied store.
- [ ] At least two previously-hand-rolled test files use the new harness and got **shorter**.
- [ ] No existing assertion was weakened or deleted; suite count does not drop.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task B1: `lib/sessionLookup.ts` — the three-list walk, once

**Parallel:** none — `SidePane.tsx` is touched by no other Phase B task but full-suite verification applies.

**Context:**
`sessions.find(...) ?? historySessions.find(...) ?? archivedSessions.find(...)` is re-derived in **five** places, each picking a different field: `useActiveSpaceCwd.ts:43` (cwd), `SidePane.tsx:237` (cwd), `sessionConfig.ts:65` (configOptions), `sessionConfig.ts:90` (contextUsage), `ChatStream.tsx:119` (row). `useActiveSpaceCwd.ts:14-16` already states the rule — "a second consumer re-deriving it is how the two silently disagree" — and `sessionConfig.ts:17-25` already models the right **shape**: a plain function called *inside* the selector, because a hook would force a component to subscribe to every list it does not otherwise show. This is the prerequisite for C8 and D4: any `useChatComposer` would otherwise re-implement the walk and the extraction would just relocate the duplication.

**Two invariants that are easy to break and hard to notice:**
- **Order is load-bearing.** Live → history → archived, and a live row must win over a stored row with the same id (the live row is current truth). `sessionConfig.ts:41-47` documents why archived is included at all: missing it makes an archived session's context bar read 0% and its selectors fall back to empty stubs.
- **Return a primitive.** `SidePane.tsx:243-246` warns zustand v5 re-runs a selector that yields a fresh object on every snapshot read → infinite re-render, which **hangs the test suite rather than failing it**. So `sessionFieldOf` returns the field, never the row and never a `{ cwd, title }` object.

**Files:**
- Create: `src/lib/sessionLookup.ts`, `src/lib/sessionLookup.test.ts`
- Modify: `src/hooks/useActiveSpaceCwd.ts` (call it; keep the doc comment's rationale, trimmed)
- Modify: `src/components/SidePane.tsx:232-240` (the `activeCwd` walk)
- Modify: `src/lib/sessionConfig.ts` (both walks — this is the module that already owns the shape, so it becomes a *caller*, and `SessionConfigSource` moves to or is re-exported from `sessionLookup.ts`)
- Modify: `src/components/ChatStream.tsx:117-124`
- Also in scope (**a sixth walk the audit's grep missed**): `src/components/SpacesList.tsx:818-824`'s `titleOf` walk — it walks `s.sessions`/`s.historySessions`/`s.archivedSessions` via a local `titleOf` helper, so it does not match a `historySessions.find` search and escapes detection entirely. `SidePane.tsx:251-256`'s `storedTitle` walk is the same shape.
- **Not** in scope: `SidePane.tsx:251-256`'s `storedTitle` fold — read it, and if it can take `sessionFieldOf(s, id, "title")` without changing what it returns, fold it in; if folding it would change the `null`-vs-`undefined` distinction the header's render depends on, **leave it and say so in a comment**. `sessionTitle.ts`'s doc-comment already flags `SidePane` as carrying its own copy as known debt.

**What to implement:**
> ⚠️ **Corrected after review — the row type must be widened, or this does not compile.** `sessionConfig.ts:8` defines `type SessionRow = Pick<SessionInfo, "sessionId" | "configOptions" | "contextUsage">` — it has **no `cwd` and no `title`**, which are exactly the fields `useActiveSpaceCwd.ts:43` and the `title` walks read. So the new module cannot reuse that `Pick` as-is: define the row as `Pick<SessionInfo, "sessionId" | "cwd" | "title" | "configOptions" | "contextUsage">` and say in the comment why it is wider than `sessionConfig.ts`'s. (The generic itself is sound — the three lists hold the same `SessionInfo[]`, so `SessionRow[K] | undefined` type-checks once the `Pick` covers the walked fields.)

```ts
// src/lib/sessionLookup.ts
/** The slice of the sessions state the walk reads. Structural, not `SessionsState`
 *  (the store does not export it) — a caller passes its whole state object from
 *  inside a selector and a test builds a plain one. */
export interface SessionLookupSource { … }  // superset of sessionConfig.ts's SessionConfigSource

/** Read ONE field of one session across the three lists, live → history → archived.
 *  Returns the FIELD, not the row: a selector returning a fresh object re-renders
 *  forever under zustand v5. */
export function sessionFieldOf<K extends keyof SessionRow>(
  s: SessionLookupSource, id: string | null, key: K,
): SessionRow[K] | undefined;
```
Decide and document whether the missing case is `undefined` or a caller-supplied default (`sessionConfig.ts` currently returns `null` for "nothing knows the id" so that *no config* stays distinguishable from *config with zero options* — that distinction must survive, so `sessionConfigOptionsOf` may keep its own `?? null` tail rather than delegating it). **Do not let the refactor flatten `null` vs `undefined` vs `[]`.**

**Steps:**
- [ ] Use the B4a fixtures to write `src/lib/sessionLookup.test.ts` FIRST → FAIL. Cover: field found in each of the three lists; **live wins over stored with the same id**; archived is reached (the 0%-bar bug); missing id → the documented empty case; `id === null` → the empty case; and that the result is a primitive (assert `typeof`, and for an object field assert a stable reference across two calls so a future "return the row" change fails here).
- [ ] Implement → PASS.
- [ ] Migrate `useActiveSpaceCwd.ts` → `pnpm test src/hooks/ src/components/ChatStream.test.tsx` green.
- [ ] Migrate `sessionConfig.ts` (both) → `pnpm test src/lib/sessionConfig.test.ts src/components/SessionConfigSelect.test.tsx` green. **The `null`-vs-`[]` and archived-session cases are the ones to watch.**
- [ ] Migrate `SidePane.tsx` + `ChatStream.tsx` → `pnpm test src/components/SidePane.test.tsx src/components/ChatStream.test.tsx` green.
- [ ] Run `pnpm test` then `pnpm build`. Watch for a **hang** (not a failure) — that is the fresh-object-selector symptom.
- [ ] Commit: `refactor(fe): one session-lookup seam replaces five three-list walks`

**Acceptance criteria:**
- [ ] No non-store file re-implements the three-list walk. Check with **two** greps, not one: `grep -rn 'historySessions.find' src --include='*.ts*' | grep -v '\.test\.' | grep -v 'src/store/sessions.ts'` → **0**, **and** `grep -rn 'archivedSessions' src --include='*.ts*' | grep -v '\.test\.' | grep -v 'src/store/sessions.ts' | grep -v sessionLookup.ts` → only the `SessionLookupSource` field declarations. The second grep is the one that catches a local `titleOf(rows)`-style helper (`SpacesList.tsx:818`, `SidePane.tsx:251`) which the first misses. The store's own internal walks stay out of scope — finding 8's non-goal forbids splitting the store.
- [ ] `sessionLookup.test.ts` pins live-wins-over-stored and the archived-reached case.
- [ ] `sessionConfig.ts`'s `null` vs `[]` distinction is preserved and tested.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task B2: `ipc/events.ts` — event names and payload discriminants get an owner

**Parallel:** none — `App.tsx` and `tauri.ts` are both touched; full-suite verification.

**Context:**
The `invoke` boundary is genuinely respected (0 call sites outside `lib/tauri.ts`) but the **event** side has no owner: 11 `listen*` wrappers each carry a bare string, and the `interactive-event` payload discriminants are literals inside `App.tsx:161-172` (`"todos_update"`, `"todos_clear"`, `"state"`, `"cost_update"`, `"session"`) with a comment apologising that the wire name is `cost_update` and not `cost` — which is exactly the class of bug a shared union prevents. Separately `"archimedes:insert-skill"` is a `CustomEvent` string duplicated between `SkillsDialog.tsx:158` and `ChatStream.tsx:854`.

**Files:**
- Create: `src/lib/ipc/events.ts`, `src/lib/ipc/events.test.ts`
- Modify: `src/lib/tauri.ts` (the **11** `listen*` wrappers at `:1098-1237` use the constants; keep every exported wrapper name and signature identical)
- Modify: `src/lib/update.ts:77` — `listenUpdateProgress` listens `"update://progress"` and is a **12th** wrapper outside `tauri.ts`. Include it (the point of the task is one owner for every event name), and note that `lib/update.ts` and `lib/version.ts` are the undocumented parallel IPC modules finding 12 names — organising those is D1's job, this task only takes their event string.
- Modify: `src/App.tsx:157-174` (switch exhaustive over the union)
- Modify: `src/components/SkillsDialog.tsx` + `src/components/ChatStream.tsx` (the `insert-skill` constant)

**What to implement:**
```ts
// src/lib/ipc/events.ts
export const IPC_EVENTS = {
  sessionUpdate: "session-update", sessionClosed: "session-closed",
  sessionStalled: "session-stalled", sessionTitled: "session-titled",
  permissionRequest: "permission-request", interactiveRequest: "interactive-request",
  interactiveRequestClose: "interactive-request-close", interactiveEvent: "interactive-event",
  subagentSessionStarted: "subagent-session-started", subagentClosed: "subagent-closed",
  windowStateChanged: "window-state-changed",   // the 11 in tauri.ts, in file order
  updateProgress: "update://progress",          // the 12th, in lib/update.ts
  insertSkill: "archimedes:insert-skill",       // a CustomEvent, not a Tauri event — keep it
                                                // in a separate const if you prefer the purity
} as const;
export type IpcEventName = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

/** The `interactive-event` payload's `event` discriminants — the wire names. */
export const INTERACTIVE_EVENTS = {
  todosUpdate: "todos_update", todosClear: "todos_clear", state: "state",
  costUpdate: "cost_update", session: "session",
} as const;
export type InteractiveEventName = (typeof INTERACTIVE_EVENTS)[keyof typeof INTERACTIVE_EVENTS];
```
Then make `App.tsx`'s handler **exhaustive over `InteractiveEventName`**: a `switch` on `payload.event` with a `default:` branch that narrows to `never` (the standard `(_exhaustive: never) => never` trick), so adding a Rust-side event without a handler is a **compile error** rather than a silently-dropped frame. Verify the payload type's `event` field is actually typed as the union — if it is currently `string`, tightening it is part of this task and is where the value is; if tightening it forces changes in test fixtures, that is expected and good.
> ⚠️ **Corrected after review — there is NO Rust-parity test. Do not write one.** An earlier draft of this task proposed grepping `src-tauri/src` for `emit(` and asserting every constant has an emitter. That is unsound, and it re-enacts the retired `skills.test.ts:16-24` pin. Verified reasons:
> - **Four of the five `INTERACTIVE_EVENTS` have no Rust emitter at all.** Only `todos_update` is emitted (`interactive/mod.rs:307`); `todos_clear` exists purely as a *consumer* match (`persist.rs:173`), and ADR 0046 records `cost_update` as having no native emitter. A parity test would fail on correct code on day one.
> - **The `COST_UPDATE` / `archimedes:`-prefix-strip "mapping rule" does not exist in Rust** — `grep -rn 'COST_UPDATE\|archimedes:' src-tauri/src --include='*.rs'` returns **0**. That rule lives only in two frontend comments (`App.tsx:159`, `tauri.ts:282`). There is nothing to encode.
> - **Names flow dynamically**: `sink.emit(&event, payload)` (`session/router.rs:44`) forwards arbitrary `SinkFrame` names, so a literal grep is incomplete by construction, and it also misses multi-line `sink.emit(\n  "session-stalled",` forms.
>
> If real parity is ever wanted, the fix is Rust as the single source of truth (a generated or `const`-shared list both sides derive from), not a source-text grep. Out of scope here.

**And make the exhaustive switch's default a LOGGED IGNORE, not a `never` throw.** The inner `interactive-event` name is built by the worker with no Rust-side closed set, so an unlisted-but-real frame is possible; an `assertNever` default turns today's silent drop into a **runtime throw inside the listener** — a behaviour regression dressed as type safety. Keep compile-time exhaustiveness by typing the discriminant as the union, and let the default branch `console.warn` and return.

**Steps:**
- [ ] Enumerate every `listen*` wrapper's event string in `src/lib/` (all of them, not just `tauri.ts`) and write `ipc/events.test.ts` FIRST → FAIL (module absent). The test asserts the constants' **values** are the exact wire strings (a rename that changes a value is a wire break and must fail) — **not** that Rust emits them.
- [ ] Create `ipc/events.ts`; re-run → PASS.
- [ ] Point the 11 wrappers at the constants → `pnpm test` green.
- [ ] Convert `App.tsx:161-173`'s five-arm if-chain to a switch over the union, default = logged ignore → `pnpm test src/App.test.tsx` green. **Expect near-zero fixture fallout**: verified that no test constructs an `InteractiveEventPayload` or invokes the `listenInteractiveEvent` callback (`App.test.tsx:120` stubs it with `vi.fn()`; tests drive `useInteractive.getState().apply*` directly at ~75 sites). Do not budget time for fixture rewrites, and do not "improve" anything beyond the switch.
- [ ] Fold in the duplicated `archimedes:insert-skill` string — `SkillsDialog.tsx:158` and `ChatStream.tsx:854` are byte-identical (verified; no other duplicated `CustomEvent` name exists) — **and its 8 test occurrences**: `SkillsDialog.test.tsx:80,92,113,447,467`, `ChatStream.test.tsx:3072,3098`. → those two test files green.
- [ ] Run `pnpm test` then `pnpm build`.
- [ ] Commit: `refactor(fe): one owner for IPC event names and interactive-event discriminants`

**Acceptance criteria:**
- [ ] No bare event-name string literal remains in any `listen*` body in `src/lib/` (all 12, including `update.ts:77`) or in `App.tsx`'s handler.
- [ ] The switch's default **logs and returns** — it does not throw.
- [ ] No test asserts parity against Rust source text, and none was added.
- [ ] `App.tsx`'s handler is exhaustive (`never`-narrowed default); adding a discriminant breaks the build.
- [ ] The Rust-parity test exists and passes.
- [ ] `pnpm test` and `pnpm build` green.

---

### Task B3: `lib/sessionTypes.ts` + drop the re-export barrel + `verbatimModuleSyntax`

**Parallel:** none — `tsconfig.json` is a shared config artifact (gate 3).

**Context:**
`store/sessions.ts` is simultaneously a store, a type module (fan-in 30) and a re-export barrel of `lib/transcript/*` (`:37-41`) — a cycle kept safe only by convention, because `tsconfig.json:13` sets `isolatedModules` but nothing enforces type-only imports. `SessionsState` is not exported, which is why `sessionConfig.ts:35` works around it with a structural interface.

**Measured, not assumed:** flipping `verbatimModuleSyntax: true` produces exactly **5** errors, not a tree-wide sweep — 4 test files importing `Message`/`SessionConfigOption` as values, and **1 production file**, `src/components/SessionConfigSelect.tsx:15`. That single fact is what makes this task cheap enough to do now, and it is why B3 goes last: the 5 fixes are mechanical and the flag is what makes B1's and D1's `lib → store` type edges *enforced* instead of conventional.

> ⚠️ **Corrected after review — dropping the barrel does not remove the cycle, and a compatibility re-export would make the new module pointless.** Measured: `store/sessions.ts:37-41` re-exports reducer **values** (`applySessionUpdate`, `finalizeSessionMessages`, `rowToMessages`) and `:43-44` re-exports `AcpSessionUpdate`/`SessionConfigOption` — and **zero files import any of the five from the store**, so deleting those lines is safe and is worth doing on its own. But the real cycle is `store/sessions.ts:25-29 → lib/transcript/reducer` (a value edge) against `reducer.ts:8 → store/sessions` (a *type* edge, erased at runtime). If the store then re-exports the moved types "for compatibility", **nine `src/lib/**` modules keep importing them from the store** (`reducer.ts:8`, `identity.ts:2`, `unitKeys.ts:1`, `toolGroups.ts:1`, `toolOutput.ts:2`, `sessionTitle.ts:1`, `sessionActivity.ts:1`, `subagentActivity.ts:1`, `sessionTime.ts:1`) and `sessionTypes.ts` ends up with exactly one consumer — the store. The `lib → store` type edge B3 exists to enforce would survive untouched.
>
> So the move is only worth making **if the `src/lib/**` importers are re-pointed at `../lib/sessionTypes`** (9 files, mechanical, no component churn — the ~69 component importers keep going through the store). If you would rather not touch those 9, then **drop the `sessionTypes.ts` half of this task entirely and ship only the `verbatimModuleSyntax` flag + the 5 TS1484 fixes** — that is a smaller, honest change that still makes the type-only edges enforced. Decide, and say which you did in the commit body. Do not ship a `sessionTypes.ts` that nothing imports.

**Files:**
- Create: `src/lib/sessionTypes.ts` — home for `Message`, `DiffRef`, `ToolCallUiStatus` (all three are **defined** at `sessions.ts:46-69` today, not re-exported; `Message` references only `ImageRef` from `chatAttachments.ts:24`, which is store-free, so the move is clean)
- Modify: `src/store/sessions.ts` — delete the `:37-41` value barrel and the `:43-44` type re-exports (verified zero importers); import the three types from `sessionTypes.ts` and re-export them for the ~69 component call sites
- Modify: the 9 `src/lib/**` importers listed above, re-pointed at `../lib/sessionTypes`
- Modify: `tsconfig.json` — add `"verbatimModuleSyntax": true`
- Modify: the 5 TS1484 sites: `MessageBubble.codeblock.test.tsx:4`, `MessageBubble.markdown.test.tsx:4`, `MessageBubble.test.tsx:5`, `SessionConfigSelect.test.tsx:4`, `SessionConfigSelect.tsx:15`

**Steps:**
- [ ] Create `sessionTypes.ts` with the type definitions moved (not aliased) out of `store/sessions.ts`; have the store re-export them. Run `pnpm build` → green (this is a pure move; nothing else should change).
- [ ] Add `verbatimModuleSyntax: true` to `tsconfig.json`; run `pnpm build` → expect **exactly 5** TS1484 errors. If the count is materially higher, STOP and re-measure — the tree moved and the plan's premise is stale.
- [ ] Fix the 5 by adding `type` to the import specifier. Re-run → green.
- [ ] Run `pnpm test` (the flag changes emit, so this is not optional) then `pnpm build`.
- [ ] Commit: `refactor(fe): session types get a home, and type-only imports are enforced`

**Acceptance criteria:**
- [ ] `verbatimModuleSyntax: true` is set and `pnpm build` is green.
- [ ] `Message`/`DiffRef`/`ToolCallUiStatus` are *defined* in `src/lib/sessionTypes.ts`, not in the store, **and at least one `src/lib/**` module imports them from there** — a `sessionTypes.ts` that only the store imports is the failure mode this task's correction is about.
- [ ] No call site was mass-renamed — the store still re-exports for compatibility.
- [ ] `pnpm test` and `pnpm build` green.
