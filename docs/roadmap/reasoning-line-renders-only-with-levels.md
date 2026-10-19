---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/55
done-when: In the Side pane, a session whose model advertises no thinking levels shows no Reasoning control of any kind — no disabled `○ Thinking` trigger, no empty line — while the Model line and the context bar are untouched; the same is true with no active session. `pnpm test` and `pnpm build` are green from the repo root, and `CONTEXT.md`'s **Session config block** entry no longer claims the block is undata-gated.
---

# Hide the Reasoning line when the model has no thinking levels — Plan

**Goal:** Stop the Side pane's **session config block** from rendering a Thinking dropdown for a model that has no thinking levels, and delete the now-unreachable stub that produces it.

**Architecture:** Frontend only. `SessionConfigBlock` stops manufacturing a control when `findConfigOption(...)` returns `undefined` for `thought_level` — the same predicate the Rust harness already uses to omit the option entirely — so the whole Reasoning `<div>` line is absent (Task 1, plus the three comments that state the old rule: `SidePane.tsx`'s call site, `findConfigOption`'s doc, and the test file's section banner). That makes the `option === null && isThinking` stub arm inside `SessionConfigSelect` dead code (`SessionConfigBlock` is the component's only remaining call site), so Task 2 removes the arm, the `kind: "thinking"` half of the `option: null` props variant, and the two imports that only that arm used. Task 3 amends the `CONTEXT.md` glossary entry that currently states the opposite rule.

**Tech Stack:** React 19 + TypeScript (strict, `noUnusedLocals: true`), vitest + `@testing-library/react`, zustand, Radix `Select`. Validation from the repo root: `pnpm test`, `pnpm build` (`tsc && vite build`). No Rust change.

---

## Background the executor needs (read this, you have no other context)

The user's request: *"in the right sidebar, if there's no thinking level found for that model, don't display the thinking dropdown."* In this codebase the right sidebar is the **Side pane** (`src/components/SidePane.tsx`), and its bottom **session config block** (`src/components/SessionConfigBlock.tsx`) holds three stacked lines: Model, Reasoning, Context.

**The backend already does the right thing.** `synthesize_catalog_config_options` (`src-tauri/src/agent/session/mod.rs:1826`) pushes the `thought_level` config option ONLY when `!current.thinking_levels.is_empty()`, and `docs/features/model-selection.md:15` already documents it: *"the selector is ABSENT when the model advertises no levels."* So `thought_level` is simply not in the option list for a non-thinking model. No Rust file changes in this plan.

**The frontend then puts a fake control back.** `SessionConfigBlock.tsx` renders the thinking line unconditionally with `option={thinkingOption ?? null}`, and `SessionConfigSelect`'s `option === null` branch answers with a disabled `Button` showing `○` + `Thinking` + a chevron. That disabled dropdown is exactly what the user is asking to remove. It appears in every "no thinking level" state:

- **(A) known** — config options are present (live or stored) and contain no `thought_level` option: the model advertises zero levels;
- **(B) unknown** — there is no active session at all, or the session's config options are entirely absent (empty catalog).

`findConfigOption` (`src/lib/sessionConfig.ts:144`) returns `undefined` for (A), (B) **and** for a `select` whose `options` are empty — it already requires `type === "select" && (o.options?.length ?? 0) > 0`. It matches by `category` OR `id` because the ACP spec puts `category` on newer agents' frames. So the predicate needed by this change already exists; the plan adds no new derivation.

**Decisions already made — do not re-litigate them:**

1. **One rule, applied to both (A) and (B):** the Reasoning line renders if and only if the session's config options contain a `thought_level` select with at least one option. A control the user can never open is not worth its line, in either state.
2. **Gate at the call site, and delete the dead stub** rather than leaving an unreachable branch behind.
3. **The Model line keeps its always-rendered disabled stub — untouched.** The asymmetry is intentional and load-bearing: a model selector is meaningful for any session (a session can always switch models, and the picker's catalog comes from settings, not from the session's option list), whereas a thinking selector is meaningless for a model with no levels. Do **not** apply the hide rule to Model.
4. A model switch needs no new plumbing: `set_config_option` already re-synthesizes and emits `config_option_update` (`src-tauri/src/agent/session/mod.rs:1516`), so switching to a model with no levels removes the line by itself.

**Resulting rendered states** (the block goes from "always three lines" to "two or three lines", still ordered Model → Reasoning (when present) → Context, one control per line):

| State | Today | After |
|---|---|---|
| Live session, model has levels | populated, enabled `◑ Medium ⌄` | unchanged |
| Live session, model has **no** levels | disabled `○ Thinking ⌄` stub | **line absent** |
| Stored/archived session, model has no levels | disabled stub | **line absent** |
| Session with levels but not live (`disabled`) | populated + disabled | unchanged |
| No active session / config options absent | disabled stub | **line absent** |
| Model line, any of the above | disabled stub where absent | **unchanged** |
| Context bar | always rendered | unchanged |

---

## Known accepted consequences (both pre-existing, neither fixed here)

1. **A hidden-but-live thinking level.** `Model::supports_thinking_level`
   (`src-tauri/src/agent/harness/catalog.rs:66`) soft-passes when a model's
   `thinking_levels` is empty, so the `"model"` arm of `set_config_option`
   treats the current level as valid for a level-less model and skips the
   ADR 0015 reset (`src-tauri/src/agent/session/mod.rs:1454-1469`).
   `config_state.thinking_level` therefore stays `Some("high")` while
   `synthesize_catalog_config_options` omits the selector: a session can be
   running a non-default level with **no visible Reasoning control at all**, and
   the level reappears in the line if the user switches back to a
   level-capable model. The deleted stub painted this state as `○` ("off"),
   which was already a lie — an absent line is not worse. Recorded so the next
   reader does not mistake the missing line for proof the level is unset.
2. **A stored session's fallback model.** When a stored row's
   `capabilities.model` no longer resolves, `list_sessions` falls back to
   `resolve_native_model` (`src-tauri/src/agent/session/mod.rs:1086-1101`) and
   synthesizes options for *that* model, so the Reasoning line's visibility can
   be decided by a model the session never ran. The frontend faithfully renders
   the option list it is handed; noted only so the line is not read as proof of
   the session's own capability.

Two pieces of prose still say "three lines" and are **knowingly left stale**,
being outside every task's file list and untouched by behaviour:
`src/components/chat/ComposerRow.tsx:249` and `src/components/ChatStream.tsx:232`
(both narrate where the controls moved *from*). Correct them if you touch those
files for another reason.

---

## Parallelisation

**Verdict:** PARALLEL — 2 waves
- **Wave 1: Task 1, Task 3** — disjoint files by construction (Task 1: `src/components/SessionConfigBlock.tsx` + `src/components/SidePane.test.tsx` + `src/components/SidePane.tsx`; Task 3: `CONTEXT.md` only). No test in the repo reads `CONTEXT.md` (the source-reading gates are `themeTokens`, `paletteCompleteness`, `slabFloatSeparation`, `subagentSheetLayout`, `fileIconContrast` — none lists it), and **Task 3 deliberately runs no test command**, so only ONE vitest process ever touches the shared `node_modules/.vite` dep-optimizer cache in the wave; Task 1's own full-suite run covers both.
- **Wave 2: Task 2** — gate 2 (build-graph, via the project-wide `tsc`): Task 2 deletes the `option: null; kind: "thinking"` member of `SessionConfigSelectProps`. A `tsc` run in a tree where Task 1's call-site change has NOT landed still sees `option={thinkingOption ?? null}` on a `kind="thinking"` line and fails to type-check. Task 2 therefore cannot start until Task 1 is in the tree.

---

### Task 1: Gate the Reasoning line at the call site

**Parallel:** wave 1 — disjoint from Task 3 (`CONTEXT.md` only); Task 2 runs afterwards (it needs this task's call-site change to type-check)

**Context:**
`SessionConfigBlock` is the only component that renders the session's Model / Reasoning / Context lines, pinned below the **Side pane**'s scroll area. It currently passes `option={thinkingOption ?? null}` unconditionally, which drives `SessionConfigSelect`'s disabled stub. This task makes the line conditional on the option actually existing, which is the user-visible fix. The `?? null` coercion is removed at the same time because the guard makes it impossible to reach. See *Background* for the rule and for why the Model line deliberately keeps its stub.

**Files:**
- Modify: `src/components/SessionConfigBlock.tsx`
- Modify: `src/components/SidePane.tsx` (comment only — no behaviour change)
- Modify: `src/lib/sessionConfig.ts` (doc comment only — no behaviour change)
- Test: `src/components/SidePane.test.tsx`

**What to implement:**

1. In `src/components/SessionConfigBlock.tsx`, wrap the thinking line — the whole `<div className="min-w-0">` at lines **139-147** (line 148 is the first line of the context bar's comment, do not swallow it), containing `<SessionConfigSelect kind="thinking" … />` — in a conditional so the line is absent as a DOM node, not merely empty:

   ```tsx
   {thinkingOption && (
     <div className="min-w-0">
       <SessionConfigSelect
         kind="thinking"
         option={thinkingOption}
         onSet={onSet}
         disabled={!isLive}
         fullWidth
       />
     </div>
   )}
   ```

   Note `option={thinkingOption}` — the `?? null` is gone (inside the guard, `thinkingOption` is narrowed to `SessionConfigOption`).
2. Leave the Model line and the context bar exactly as they are, including `option={modelOption ?? null}`.
3. Update the line-order comment above the Model line ("Model, then Reasoning, then Context: one control per line…") to say Reasoning renders only when the session's options carry a `thought_level` select, and state the asymmetry against the Model line with its reason (a model selector is meaningful for any session; a thinking selector is not for a model advertising no levels; the Rust `synthesize_catalog_config_options` omits the option in exactly that case, and this gate is the frontend honouring it). Also correct the block's own doc comment at the top of the file if it asserts "three lines" unconditionally.
4. Fix the call-site comment in `src/components/SidePane.tsx` (the block above `<SessionConfigBlock collapsed={collapsed} />`, lines ~446-455). It reads *"the three that left the composer's bottom row … NOT data-gated (unlike the todo section): with no active session it renders the two disabled stubs and an empty 0% track"* — after this task there is ONE stub. Say: the Model line and the context bar are never data-gated, the Reasoning line renders only when the session's options carry a `thought_level` select, so with no active session the block is the Model stub and an empty 0% track. Comment text only — do not change a single class or prop in that file.
5. **Do NOT** touch `src/components/SessionConfigSelect.tsx` — the dead stub arm is Task 2's job. After this task the props variant is still legal TypeScript; that is expected.
6. `src/lib/sessionConfig.ts`'s **function behaviour is correct and must not change** — but `findConfigOption`'s doc comment (~lines 136-139) ends *"an empty select is a control with nothing in it, and the call site then renders the disabled stub instead"*, which is now true of Model and false of Reasoning. Re-word that one sentence to say the call site then has no option to render (Model shows its stub, the Reasoning line is gated away by `SessionConfigBlock`). No code in that file changes.

**Steps:**
- [ ] In `src/components/SidePane.test.tsx`, invert the no-active-session case (currently titled `"renders NO TODO section when there are no todos (the config block is always there)"`, lines **149-178**). It currently asserts a Thinking button exists, and at line 177 `expect(container.textContent).toBe("Model○Thinking")`. Replace those with the opposite, and update the surrounding comment (it says "it renders the two DISABLED stubs"): the Model stub still renders disabled, there is NO Thinking control of any role and no `○` glyph, and the pane's text is exactly `"Model"`:
      ```tsx
      expect((screen.getByRole("button", { name: "Model" }) as HTMLButtonElement).hasAttribute("disabled")).toBe(true);
      expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();
      expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
      expect(container.textContent).toBe("Model");
      ```
      The existing `aria-valuenow === "0"` and `context-usage` null assertions stay.
- [ ] Invert the closed/history-only case (titled `"renders the config block for a closed (history-only) session …"`, lines **1122-1150**): keep the Model stub assertions and the empty-track assertions, replace the `thinking` truthiness + disabled assertions with `expect(block.querySelector('[aria-label="Thinking"]')).toBeNull();`, and fix its comment (it says "The model/thinking selects render as DISABLED stubs").
- [ ] Invert `"a live session WITHOUT configOptions renders neither selector (the stubs are the whole block)"` (lines **1573-1583**): keep `expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();`, keep both `queryByRole("combobox", …)` nulls, and add `expect(screen.queryByRole("button", { name: "Thinking" })).toBeNull();`. Update its comment (it says "the block renders two disabled stubs").
- [ ] Fix the section banner comment above those cases (lines ~1104-1105): `THE CONFIG BLOCK (Model / Reasoning / Context) — the three lines that left the composer's bottom row` — "the three lines" is now "the Model / Reasoning / Context lines, Reasoning only when the model has levels".
- [ ] ADD one new case: a live session whose config options hold ONLY the model option (state (A) — a model with zero thinking levels). Seed it the way `"stacks the three lines ONE PER LINE …"` (**line 1194**) seeds: `seedLiveSession()`, then `useSessions.setState({ configOptions: { s1: [ <the model option only> ] }, contextUsage: { s1: { used: 53760, window: 128000 } } })`. Then assert (note: this file's idiom declares `block` and `lines` explicitly — the template case at 1194 declares only `container` + `lines`, so declare `block` yourself):
      ```tsx
      const block = container.querySelector(
        '[data-testid="session-config-block"]',
      ) as HTMLElement;
      const lines = Array.from(
        container.querySelectorAll('[data-testid="session-config-controls"] > div'),
      ) as HTMLElement[];
      expect(lines).toHaveLength(2);
      expect(lines[0]!.querySelector('[aria-label="Model"]')).toBeTruthy();
      expect(lines[0]!.querySelector('[aria-label="Thinking"]')).toBeNull();
      expect(block.querySelector('[aria-label="Thinking"]')).toBeNull();
      expect(lines[1]!.getAttribute("data-testid")).toBe("context-usage-bar");
      ```
      This pins the ORDER contract surviving a missing Reasoning line. Give it a title that says the Reasoning line is absent when the model has no thinking levels.
- [ ] Run `pnpm test src/components/SidePane.test.tsx` from the repo root.
  - Did the inverted/new assertions FAIL (extra Thinking control found, `textContent` still `"Model○Thinking"`, `lines` length 3 rather than 2)? If they passed already, stop and investigate — the gate is not doing anything.
- [ ] Implement the gate in `src/components/SessionConfigBlock.tsx` (steps 1-3), the comment fix in `src/components/SidePane.tsx` (step 4) and the doc-comment re-word in `src/lib/sessionConfig.ts` (step 6).
- [ ] Run `pnpm test src/components/SidePane.test.tsx`
  - All green? If not, fix the failures and re-run before continuing.
- [ ] Run `pnpm build` from the repo root
  - Must succeed. It still passes `noUnusedLocals` because `SessionConfigSelect.tsx` is untouched here. If it fails on `SessionConfigBlock.tsx`, that is this task's error — fix it.
- [ ] Run `pnpm test` (full suite)
  - Green at **96 files / 2200 tests** — the measured baseline on `main` is 96 / 2199, and this task adds exactly one case while the three inversions change no case count. `SessionConfigSelect.test.tsx` must still pass at this point — it renders `kind="thinking" option={null}` directly, which is still legal until Task 2 removes it. If it fails, you changed something in `SessionConfigSelect.tsx`; revert that.
- [ ] Do NOT commit — this is a wave task. Report your file list; the orchestrator commits it as
      `git commit -m "feat(side-pane): hide the Reasoning line when the model has no thinking levels" -- src/components/SessionConfigBlock.tsx src/components/SidePane.tsx src/components/SidePane.test.tsx src/lib/sessionConfig.ts`

**Acceptance criteria:**
- [ ] With a live session whose `configOptions` contain no `thought_level` option, the Side pane renders no element with `aria-label="Thinking"`, no `○` glyph, and the config block has exactly two child lines: Model, then `context-usage-bar`.
- [ ] With no active session, the block's text is exactly `"Model"` (Model stub + context bar only).
- [ ] A session that DOES have a `thought_level` option still renders the trigger, still `w-full`, still disabled when `!isLive` — the existing cases at `SidePane.test.tsx` ~1152 and ~1455 pass untouched.
- [ ] The Model line still renders its disabled stub in every state; `src/components/SessionConfigSelect.tsx` is not modified by this task; the only change in `src/lib/sessionConfig.ts` is a doc comment (`git diff -- src/lib/sessionConfig.ts` shows no code line changing).

---

### Task 2: Delete the dead thinking-stub arm from `SessionConfigSelect`

**Parallel:** none — runs in wave 2 after Task 1. The project-wide `tsc` in `pnpm build` fails if the props variant is removed while any call site still passes `option={thinkingOption ?? null}`, so this task needs Task 1 in the tree.

**Context:**
`SessionConfigSelect` renders either the session's model control (the `ModelPicker` dialog) or its thinking control (a compact Radix `Select`). For a `null` option it renders a disabled stub, on the theory that a control's identity should survive a missing config. Two things killed that branch for thinking: the config row moved out of the composer into the side pane, so `SessionConfigBlock` is the component's ONLY call site; and Task 1 stopped that call site ever passing a `null` thinking option. The arm is unreachable, and its tests would then be pinning a control no code can produce — worse than no test, because it advertises coverage that cannot be exercised. Deleting it also drops the two imports only that arm used.

**Files:**
- Modify: `src/components/SessionConfigSelect.tsx`
- Test: `src/components/SessionConfigSelect.test.tsx`

**What to implement:**

1. In `src/components/SessionConfigSelect.tsx`, inside the `if (option === null) { … }` block: keep the `if (isModel) { … }` return (the `ModelPicker` stub, ending at the `}` on line 195) and DELETE the thinking stub that follows it — **lines 196-221 inclusive**, from that block's second `return (` through its closing `);`, i.e. the `<div className="relative min-w-0">` wrapping the `<Button variant="ghost" size="sm" … aria-label="Thinking" disabled>` containing the `○` span (`data-testid="thinking-level-icon"`), the `Thinking` label span and the `<ChevronDownIcon>`. **Keep line 222** — that `}` closes `if (option === null)`; deleting it unbalances the function.
2. Narrow the props union so a `null` option is model-only. It currently reads:
   ```ts
   | { option: null; kind: "model" | "thinking"; onSet: OnSet; disabled?: boolean; fullWidth?: boolean }
   ```
   Change it to `kind: "model"`. With the union narrowed, the `if (isModel)` test inside `if (option === null)` is always true — you may keep it as a guard or leave the body unconditional, but the code must compile and the model stub must still render identically.
3. Update the props doc comment (above `type SessionConfigSelectProps`) which states the `null` case renders a stub for either kind: it is now model-only, and the thinking line is gated by the caller (`SessionConfigBlock`) because a model with no levels has nothing to select.
4. **Remove the imports that become unused: `ChevronDownIcon` and `Button`.** `tsconfig.json` sets `noUnusedLocals: true`, so `pnpm build`'s `tsc` step FAILS on them — this is not a cosmetic cleanup. Check with `grep -n "Button\|ChevronDownIcon" src/components/SessionConfigSelect.tsx` before and after: after deleting the arm, the only remaining hits should be prose inside comments (the width-contract comment mentions "the Button's `shrink-0`"), never code. Fix the `import { Bot, ChevronDownIcon } from "lucide-react"` line to `import { Bot } from "lucide-react"` and delete `import { Button } from "./ui/button";`.
5. `COMPOSER_THINKING_EDGE` and the `thinkingEdge` variable STAY — they still ride the LIVE thinking trigger (the Radix `SelectTrigger` branch). Do not remove them.
6. Fix the count in `FULL_WIDTH_TRIGGER`'s comment: it enumerates "FOUR sites consume these two strings (the null-model stub, the null-thinking stub, the live model, the live thinking trigger)". It is now THREE (the null-model stub, the live model, the live thinking trigger).
7. In `src/components/SessionConfigSelect.test.tsx`, remove the FOUR `kind="thinking" option={null}` renders (they sit at lines 107, 155-161, 179 and 356). Two whole cases go, two are trimmed:
   - **trim** `"the null-option stubs keep the same width contract as the live triggers"` (~line 96): delete the `unmount();` call, the second `render(<SessionConfigSelect kind="thinking" option={null} … />)` and its three assertions; KEEP the model half. Because the model half no longer needs to be unmounted, **rewrite its opening `const { unmount } = render(` to plain `render(`** — leaving the destructure makes `tsc` fail with `TS6133: 'unmount' is declared but its value is never read` (`noUnusedLocals`). Re-title the case to name the model stub alone.
   - **delete whole** `"FULL WIDTH: the NULL-thinking stub stretches too (it is a Button, not a SelectTrigger — the fourth site)"` (~line 153).
   - **trim** `"without fullWidth the triggers keep the composer's content-sized contract"` (~line 171): same treatment — delete `unmount();` + the thinking `render`/assertion, keep the model half, and **change `const { unmount } = render(` to `render(`** for the same `TS6133` reason.
   - **delete whole** `"a null thinking option renders a disabled stub (the open-circle glyph, no data)"` (~line 354).
   Do NOT touch any other thinking case — the ones that pass `option={thinkingOption}` (the `w-full` / `max-w-72` / `pl-1` / glyph / `disabled` cases) are exactly the coverage that must survive. And note there is a THIRD `const { unmount } = render(` in this file, at **line 221**, inside the loop of `"the thinking glyph's fill follows the level (◔ low, ◕ high, ● xhigh/max)"` — that case renders a REAL option, calls `unmount()` on every loop iteration, and must be left completely alone. Only the two at lines 97 and 172 lose their destructure.
   **Expected count, verified against the current tree:** the file has **23** `it(` cases at baseline; after this step it has **21** — two cases deleted outright, two trimmed but still present. `grep -c "  it(" src/components/SessionConfigSelect.test.tsx` must read 21, and `grep -n "option={null}"` must return exactly **three** hits, all `kind="model"` (baseline: seven, of which four were thinking).
8. **What NOT to change:** the thinking glyph ramp (`thinkingLevelIndicator`, `THINKING_GLYPHS`, the `--color-thinking-*` classes), the `ModelPicker` branch, the error-after-5s behaviour, the `memo` wrapper at the bottom of the file, and `src/components/SessionConfigSelect.memo.test.tsx`.

**Steps:**
- [ ] Run `pnpm test src/components/SessionConfigSelect.test.tsx` and note the current green baseline (all cases pass with the stub still present).
- [ ] Delete the four test cases listed in step 7 first, then run `pnpm test src/components/SessionConfigSelect.test.tsx`
  - Still green, and `grep -c "  it(" src/components/SessionConfigSelect.test.tsx` reads **21** (was 23 — two cases deleted, two trimmed but still present)? If the count is 19 or 20 you deleted a case that passes a real `option={thinkingOption}` — restore it; that is the live-trigger coverage this task must not lose. If a case you meant to keep now fails, you trimmed the wrong block.
- [ ] Apply steps 1-3, 5-6 to `src/components/SessionConfigSelect.tsx` (delete the arm, narrow the props union, fix the two comments).
- [ ] Run `pnpm build` from the repo root
  - Expect it to FAIL, and expect exactly these `noUnusedLocals` / `TS6133` errors: `'ChevronDownIcon' is declared but its value is never read`, `'Button' is declared but its value is never read`, and — if you left either destructure behind in step 7 — `TS6133: 'unmount' is declared but its value is never read` in `SessionConfigSelect.test.tsx` (twice, ~lines 97 and 163). `tsc` type-checks the tests (`tsconfig.json` has `include: ["src"]`), so a test-file error is THIS task's error, not noise. Fix all of them (step 4 for the imports, the destructure rewrite for `unmount`), re-run, and require success.
  - Also expect it to pass a `kind: "model"` narrowing check: if any call site still passes a `null` thinking option, `tsc` says so (`SessionConfigBlock.tsx(140,12): error TS2322` is the shape). If that happens, Task 1 is not in the tree — stop, this task is mis-sequenced.
- [ ] Run `pnpm test` (full suite)
  - Green at **96 files / 2198 tests** (Task 1 left 2200; this task deletes two whole cases). Pay attention to `src/components/SidePane.test.tsx` (the block's live thinking trigger is still found by `[aria-label="Thinking"]`) and `src/lib/sessionConfig.test.ts` (`findConfigOption`'s behaviour is untouched, so its cases must not change).
- [ ] Commit normally (this is a serial task): `git add -A && git commit -m "refactor(side-pane): drop the unreachable thinking stub from SessionConfigSelect"`

**Acceptance criteria:**
- [ ] `grep -n "option === null" -A 20 src/components/SessionConfigSelect.tsx` shows the null branch handling the model stub only; no `aria-label="Thinking"` string remains in that branch (the live trigger's `aria-label={option.name}` is fine and must remain).
- [ ] `SessionConfigSelectProps`'s `option: null` member is `kind: "model"` only.
- [ ] `pnpm build` succeeds — proving `ChevronDownIcon`/`Button` were removed and no call site passes a `null` thinking option.
- [ ] The live thinking trigger's contract tests still pass: `w-full` under `fullWidth`, `max-w-72` without it, `pl-1` seam edge, the fill-ramp glyph, and `disabled` for a stored session.
- [ ] `pnpm test` is green end to end.

---

### Task 3: Amend the glossary entry that states the opposite rule

**Parallel:** wave 1 — disjoint from Task 1 (`CONTEXT.md` only) and from Task 2. Runs no test command, which is what keeps gate 3 clean in a shared tree: no second vitest process contends for `node_modules/.vite`.

**Context:**
`CONTEXT.md` is this project's glossary, and the **Session config block** entry (~lines 227-229) currently asserts the rule this plan reverses: it says the block is "The three lines pinned to the bottom of the **Side pane** — Model, Reasoning, Context, one per line", and its `_Avoid_` line carries `status section (they are NOT data-gated — they always render)`. After Task 1, both statements are false. Leaving them is worse than a stale comment: AGENTS.md tells every future agent to read `CONTEXT.md` for shared language, so the glossary would actively mislead the next person about which lines are data-gated.

**Files:**
- Modify: `CONTEXT.md` (the **Session config block** entry only)

**What to implement:**
Rewrite the entry's body sentence and its `_Avoid_` parenthetical so it reads, in the glossary's existing voice, roughly:

```
**Session config block**:
The lines pinned to the bottom of the **Side pane** — Model, Reasoning when the session has it, Context, one per line — holding the session's model selector, its **Thinking level** selector and the context bar. The Reasoning line IS data-gated: it renders only when the session's config options carry a `thought_level` select with options, which is the same condition under which the harness synthesizes the option at all (`synthesize_catalog_config_options` omits it for a model advertising no thinking levels), so a model with no levels shows no dropdown rather than a dead one. The Model line and the context bar are NOT gated — a model selector is meaningful for any session, and the picker's catalog comes from settings rather than the session's option list. Pinned BELOW the scroll area, not inside it, so the **Todo board** scrolls and these stay reachable. They are the pane's only non-status content, and the composer no longer carries them: with the pane collapsed to its rail there is no way to change model or read context until it is expanded, accepted knowingly.
_Avoid_: composer toolbar (where they used to live), config row, status section (only the Reasoning line is data-gated — the Model line and the context bar always render)
```

Keep the bold term heading, the entry length comparable, and the surrounding entries untouched. **Do NOT** edit the **Side pane** entry above it or the **Thinking level** entry elsewhere — the change is confined to this one entry. Do not restate the diff or cite this plan; the glossary describes what IS.

**Steps:**
- [ ] Read the **Session config block** entry in `CONTEXT.md` (~lines 227-229) and confirm it still carries the "three lines" + "NOT data-gated — they always render" wording. If it already reads as data-gated, stop — this task is already done.
- [ ] Replace the entry's body sentence and `_Avoid_` parenthetical per above.
- [ ] Run `grep -n "NOT data-gated" CONTEXT.md`
  - Must print NOTHING. The only occurrence in the file is this entry's `_Avoid_` line, so a hit means the old claim survived the rewrite.
- [ ] Run `git diff -- CONTEXT.md`
  - Shows ONE entry changed — the **Session config block** entry. The **Side pane** entry above it and every other entry are untouched.
- [ ] **Run no test command.** This task edits prose that no test reads (verified: the repo's source-reading gates are `themeTokens`, `paletteCompleteness`, `slabFloatSeparation`, `subagentSheetLayout`, `fileIconContrast`, and none names `CONTEXT.md`). It runs while Task 1 edits the same working tree, so starting a second vitest here would measure Task 1's half-finished code and contend for `node_modules/.vite` — Task 1's own full-suite run is this task's verification.
- [ ] Do NOT commit — this is a wave task. Report your file list; the orchestrator commits it as
      `git commit -m "docs: the Reasoning line is data-gated — amend the session config block glossary entry" -- CONTEXT.md`

**Acceptance criteria:**
- [ ] The entry no longer claims "three lines" or "they are NOT data-gated — they always render".
- [ ] It states that the Reasoning line renders only with a `thought_level` option, and that the Model line and context bar always render, with the reason for the asymmetry.
- [ ] Bold-term formatting and `_Avoid_` line structure match the rest of `CONTEXT.md`; `git diff --stat -- CONTEXT.md` shows one file with a handful of changed lines, and `git diff -- CONTEXT.md` touches only that entry.
- [ ] `docs/features/model-selection.md` is NOT modified — its line 15 already states the absence rule this plan implements. (That file is stale in other ways — line 19 still says the frontend "renders two selectors in the session header", which died with the composer row — but correcting it is not this plan's scope.)

---

## After the last task ships (the orchestrator's step, not a task)

Once all three tasks are merged, delete this file. `AGENTS.md`: *"in-flight plans live in
`docs/roadmap/<feature>.md` and are deleted on ship"* — its durable content is already
elsewhere (the **Session config block** glossary entry in `CONTEXT.md` carries the rule,
`docs/features/model-selection.md:15` already carries the backend half). The wave commit
pattern (`git commit -- <paths>`) will not pick this up on its own, which is why it is
stated here rather than assumed.
