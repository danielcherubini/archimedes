---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
done-when: In the Skills dialog, a Skill whose name the `$` mention grammar cannot carry is still listed but its row is visibly inert (aria-disabled, out of the tab order, click and Enter do nothing) and says why in a tooltip that carries no `$` glyph; a mentionable name's row inserts its lowercased `$token` exactly as before; the `manual only` tooltip's no-`$` rule is untouched; `pnpm test` and `pnpm build` are green.
---

# Task T2: the Skills dialog stops inserting a dead `$name` token (#10) Plan

**Goal:** A Skills-dialog row whose name the `$` mention grammar cannot carry inserts nothing instead of inserting a token that expands to nothing.

**Architecture:** The fix is at the INTERACTION, not the catalog. `SkillsDialog` already owns the predicate the tooltip uses (`isMentionableSkillName`); the row's `RowButton` already owns a `disabled` affordance (`aria-disabled="true"` + `tabIndex={-1}` + inert click/Enter), which the Model picker uses today. So the change is one boolean per row plus a reason string, entirely inside `src/components/SkillsDialog.tsx`. No shared component is touched, no catalog is filtered, no Rust is touched.

**Tech Stack:** React 19 + TypeScript, Vitest 5 + Testing Library. Validation from the repo root only (`pnpm test`, `pnpm build`).

---

## Parallelisation

**Verdict:** SERIAL — this plan contains exactly one task, so there is no wave to declare here.

(The parent roadmap places T2 in **wave 1a alongside T3**; that grouping is the roadmap's, not this plan's. It holds because T2's `Files:` list is `src/components/SkillsDialog.tsx`, its test file, `src/lib/skills.ts`, `CONTEXT.md` and one ADR — all disjoint from T3's `scripts/` + `.github/workflows/` + `AGENTS.md` set — and because **this task touches no Rust**: Vitest transpiles per file, so a sibling's half-finished `.rs` edit cannot break it. Keep that property: see "Do NOT touch" below.)

---

### Task: The Skills dialog renders an inert row for an unmentionable name

**Parallel:** none — single-task plan; the parent roadmap owns wave grouping.

**Context:**

`src/components/SkillsDialog.tsx` builds every row as a `RowButton` whose `onClick` calls `insertSkill(skill.name)`, which dispatches the `IPC_EVENTS.insertSkill` window `CustomEvent` carrying `"$" + name.toLowerCase() + " "` **unconditionally**. The row's Enter path is the same function (it is `RowButton`'s `onKeyDown`, which hands the keyboard event to the same `onClick`). Nothing on either path consults `isMentionableSkillName` — only `manualOnlyTooltip` does, and only for a model-hidden row's badge.

The `$` token grammar is `[a-z0-9]+(?:-[a-z0-9]+)*` (ADR 0031, `MENTION_RE` in `src/lib/skills.ts`) while Skill discovery screens a name only for tag-safety, so `has space`, `a_b`, `a.b`, `café`, `a--b` are all legal, **discovered** names that no token can ever equal. `expandMentions` leaves an unmatched token **verbatim** (its documented invariant 5, and pinned by `agrees with expansion: a name it rejects is never expandable` in `src/lib/skills.test.ts`), so clicking the row for `has space` puts `$has space ` in the composer and that dead text is recorded in the sent message. The tooltip on the same row correctly says `This name can't be typed as a mention`. The row contradicts the tooltip one node away.

**This deliberately reverses a documented accepted trade-off.** ADR 0036's Consequences bullet that starts *"The flag crosses IPC"* says the click "still inserts a dead token … the **tooltip** is the surface that tells the truth there", and `CONTEXT.md`'s **model-hidden** entry closes with "while that row's own click-insert for such a name is a known follow-up". Both must be amended in this commit or the docs will contradict the code — see the Files list. This is not a silent behaviour change; it is the follow-up landing.

**Decided approach — disable the row, do not give it an alternative action.** The sibling pickers solve the same hazard by dropping the resource from the catalog: `src-tauri/src/commands/agents.rs` (`list_agent_definitions_for_space`) and `src-tauri/src/agent/mcp/config.rs` (`server_infos`) both `.filter(... is_mentionable_name …)` precisely because "offering it would insert a dead token". The `$` SKILL catalog **cannot** be filtered that way: ADR 0036 keeps `discover_skills` total because the same catalog feeds model-facing discovery, and `src-tauri/src/skills.rs`'s own doc-comment on `is_mentionable_name` records "no skill code path filters on it". Filtering the dialog's rows would delete rows the user owns. So the row stays **listed** and becomes **inert**.

Why inert rather than "do something that actually works" (insert the body, copy the path, open the file):

- The dialog's one job is to produce a `$` **Mention**. Every other candidate action is a different feature with its own ADR (inserting a Skill's `body` into the composer would put prompt-shaped content into user text that `splitMentionBlocks` then has to survive; copying a path is a clipboard feature — the repo's only clipboard seam is `src/hooks/useCopyButton.ts`, and the repo has no toast/confirmation surface to say it happened, so a silent copy is a new kind of dead end).
- "Disabled row" is already **expressible in the shared components with no change to them**, which is the cheapest honest option and the reason to take it: `RowButtonProps` declares `disabled?: boolean`, `RowButton` destructures it out so it never reaches the DOM, and emits `aria-disabled="true"` + `tabIndex={-1}` with click and Enter both guarded inside the component. `ModelPickerDialog.tsx` uses it today and `ModelPickerDialog.test.tsx`'s `a disabled row is NOT selectable (the stale-override pattern)` plus `RowButton.test.tsx`'s `is aria-disabled, unfocusable, and inert to both pointer and Enter` already prove the affordance works. `CatalogSearchDialog` takes no position on whether a row is a control at all — it renders whatever `renderRow` returns — so it needs nothing either.
- The inert row is also the surface that finally tells the **model-visible** unmentionable Skill the truth. The badge tooltip only renders for `disableModelInvocation` rows; the bug the issue reports is older than and independent of the flag, so the reason must render regardless of the flag.

**What NOT to change (the over-engineering risks):**

- **Do NOT touch `manualOnlyTooltip`.** Its two rules (both timings; no `$` glyph for an unmentionable name) are pinned by `the_manual_only_tooltip_promises_no_$mention_a_name_cannot_carry` and `the_manual_only_tooltip_offers_the_$mention_and_says_the_refusal_is_live` in `src/components/SkillsDialog.test.tsx`. The first of those is the **hard constraint of this task**: the unmentionable variant keeps emitting **no `$` glyph at all**. Both tests must stay green **unedited**.
- **Do NOT rename or weaken `marks_a_model_hidden_skill_as_manual_only_but_still_inserts_the_mention`.** Its fixture is `Omega`, which IS mentionable, so "still inserts the mention" stays TRUE after this change. Do not "fix" it.
- **Do NOT filter the composer's `$` picker** (`src/hooks/useMentionPicker.ts`, `src/components/ChatStream.tsx`). ADR 0036 keeps that catalog total and both `src/lib/skills.ts` and `src-tauri/src/skills.rs` document that the picker is allowed to offer an unmentionable name. Out of scope.
- **Do NOT touch anything under `src-tauri/`** — not `src-tauri/src/skills.rs`, not `src-tauri/src/agent/tools/exec/skills.rs`, not `CONTEXT.md`'s Rust-facing prose. Editing a Rust doc-comment would drag `cargo test` / `cargo clippy --all-targets` / `cargo fmt --check` into this task and void the reason T2 can share a wave with T3. Those comments enumerate the surfaces that check the predicate for Skills and go stale in completeness (they will say "two surfaces" where there are now three); they do not become false *about Rust* — no Rust code path filters on it, and that stays true. **Record it as a follow-up in the commit message body**: "ADR-0036's Rust-side doc-comments on `skills::is_mentionable_name` and `exec_read_skill` now under-count the frontend surfaces; correcting them is a Rust-doc-only change deliberately kept out of this frontend-only task."
- **Do NOT touch `RowButton.tsx`, `RowButton.test.tsx`, `CatalogSearchDialog.tsx`, `ModelPickerDialog.tsx`.** `RowButton.test.tsx`'s class pass-through pin renders `RowButton` directly, so it is unaffected by what this caller passes.
- **Do NOT touch `src/lib/tauri/types.ts`** (`SkillInfo` gains no field — `isMentionableSkillName` is derivable client-side and already imported).

**Files:**

- Modify: `src/components/SkillsDialog.tsx`
- Test: `src/components/SkillsDialog.test.tsx`
- Modify: `src/lib/skills.ts` — **doc-comment only**, the `isMentionableSkillName` header's "WHERE it is applied for SKILLS, precisely" paragraph (it enumerates the enforcement sites and will otherwise under-count them). No code change, no signature change.
- Modify: `docs/decisions/0036-model-hidden-skills.md` — append an amendment blockquote (see below).
- Modify: `CONTEXT.md` — the **model-hidden** entry's closing clause.

**What to implement:**

1. **`src/components/SkillsDialog.tsx` — the row's mentionability.**

   In `renderRow`, derive the boolean once and use it for both the affordance and the reason:

   ```tsx
   const mentionable = isMentionableSkillName(skill.name);
   ```

   Pass `disabled={!mentionable}` to `RowButton`. That alone makes click AND Enter inert (`RowButton` guards both) and emits `aria-disabled="true"` + `tabIndex={-1}` — do not hand-write any of those three attributes, and do not add a second `role="button"` anywhere (the whole test suite reaches rows through `.closest('[role="button"]')`).

   Add the reason as a native tooltip on the row element ONLY for the inert case:

   ```tsx
   title={mentionable ? undefined : UNMENTIONABLE_ROW_REASON}
   ```

   `title` is a plain `div` prop that `RowButton` forwards through `...rest`, so no shared-component change is needed. `UNMENTIONABLE_ROW_REASON` is a module-level `const` string, worded to be true for a **model-visible** row too (the badge tooltip is not available to it), and it MUST contain **no `$` glyph anywhere** — the same rule the badge tooltip carries, extended to the new surface, because a lie one node from the truth is the bug being fixed. Use this literal:

   ```
   "This name can't be typed as a mention — rename the Skill to give it one"
   ```

   (The fix genuinely is the user's own one-line edit to the frontmatter `name`, or to the directory name it falls back to — ADR 0036 says so. `manualOnlyTooltip`'s existing phrase `This name can't be typed as a mention` is reused verbatim as the sentence's first half so the two surfaces do not disagree; the pinned test asserts that tooltip with `toMatch(/can't be typed/i)` and reads only the badge node's `title`, so nothing collides.)

   Keep the `manual only` badge and `manualOnlyTooltip(skill.name)` exactly as they are. A model-hidden + unmentionable row therefore carries both the badge tooltip and the row tooltip, both `$`-free, both consistent.

2. **`src/components/SkillsDialog.tsx` — keep `insertSkill` guarded in two places.**

   Add the same predicate as an early return at the top of `insertSkill`, before the `dispatchEvent`:

   ```ts
   if (!isMentionableSkillName(name)) return;
   ```

   This mirrors the sibling `ModelPickerDialog.tsx`'s `select`, which keeps `if (item.disabled) return` even though `RowButton` already refuses the click, and its comment states the reason: the function that owns the side effect must not depend on its only caller having filtered. Keep the guard on BOTH — deleting either half is a trap the day a second caller appears. Note the guard means the `onClose()` inside `insertSkill` is also skipped for an inert row, which is what the new test asserts.

3. **`src/components/SkillsDialog.tsx` — the row's class string must go through `cn()`.**

   The row's `className` is today one static string literal:
   `group flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1 hover:bg-surface-hover`.
   An inert row must not look clickable, so the class list becomes conditional — and `src/lib/classNameConvention.test.ts` scans **every production source file under `src/`** and fails on any hand-composed `className` (template literal with `${}`, concatenation, `.join`, array literal) that is not in its measured allowlist. Adding this site to that allowlist is explicitly forbidden by that file's own header. Compose through `cn` with two module-level constants:

   ```ts
   import { cn } from "./lib/utils";

   /** The row shell, shared by both arms (geometry only — nothing cursor- or hover-shaped). */
   const SKILL_ROW_BASE =
     "group flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1";
   const SKILL_ROW_ACTIVE = "cursor-pointer hover:bg-surface-hover";
   const SKILL_ROW_INERT = "cursor-not-allowed opacity-50";
   ```

   then `className={cn(SKILL_ROW_BASE, mentionable ? SKILL_ROW_ACTIVE : SKILL_ROW_INERT)}`.

   `cn` classifies as satisfied by that guard (verified: the scanner's `classify` returns `"cn"` for an expression starting `cn(`). Measured against this repo's real `extendTailwindMerge` config in `src/components/lib/utils.ts`:
   - `cn(SKILL_ROW_BASE, SKILL_ROW_ACTIVE)` → `group flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1 cursor-pointer hover:bg-surface-hover` — the **same token set** as today's literal (different order only), so the active row's rendered appearance is unchanged.
   - `cn(SKILL_ROW_BASE, SKILL_ROW_INERT)` → `group flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1 cursor-not-allowed opacity-50` — `cursor-pointer` and `hover:bg-surface-hover` are **gone**, which is what makes the inert row not look clickable.

   Do **not** copy `ModelPickerDialog`'s hand-rolled template literal and do not add an allowlist entry: that site is allowlisted because it deliberately spells `cursor-pointer` AND `cursor-not-allowed` in one tailwind-merge group so CSS source order decides, and its own comment calls the resulting pointer-cursor-on-a-disabled-row a behaviour nobody owns. This row does not want that; dropping `cursor-pointer` on the inert arm is the point.

   Assert class expectations as **token-set membership** (`className.split(/\s+/)` then `toContain` / `not.toContain`), never as a `toContain` on the raw string — the reason is documented in this file's own `sm:max-w-3xl` test (a substring check cannot tell `max-w-3xl` from `sm:max-w-3xl`). Nothing in the tree byte-compares this row's `class` attribute (verified: `SkillsDialog.test.tsx` uses `toContain`/`not.toContain` only; `RowButton.test.tsx`'s byte-comparison renders `RowButton` directly with its own literal).

4. **`src/components/SkillsDialog.test.tsx` — two new tests, none edited.**

   Add to the existing `describe("SkillsDialog", …)`, reusing the file's local `skill()` fixture builder and its existing event-capture idiom (`window.addEventListener(IPC_EVENTS.insertSkill, listener)` + a `finally` that removes it). The file currently holds 20 tests; the scoped run below must report 22.

   a. `an unmentionable name is listed but its row is inert` — the defect's failing test.
      - Render `skill({ name: "has space", disableModelInvocation: false })`. **Model-visible on purpose**: the flag is irrelevant to the bug, and the badge tooltip does not exist for this row, so a test using `disableModelInvocation: true` would let the fix depend on the badge.
      - The row is still **listed**: `await screen.findByText("has space")` resolves, and `screen.getAllByRole("button")` includes it (ADR 0036's catalog-stays-total rule — assert the row exists, not that it is gone).
      - The row is inert: from `screen.getByText("has space").closest('[role="button"]')`, `getAttribute("aria-disabled")` is `"true"` and `getAttribute("tabindex")` is `"-1"`.
      - Click and Enter both do nothing: `fireEvent.click(row)` then `fireEvent.keyDown(row, { key: "Enter" })`; no captured event has `type === IPC_EVENTS.insertSkill` (assert `undefined` from a `.find`, the file's existing shape) and `expect(onClose).not.toHaveBeenCalled()`.
      - The affordance is not merely styled away: the row's class token set **contains** `cursor-not-allowed` and does **not** contain `cursor-pointer` or `hover:bg-surface-hover`.

   b. `the inert row says why without emitting a $ glyph` — the hard constraint, extended to the new surface.
      - Same fixture. Read the row's `title` (from the same `.closest('[role="button"]')` node) and assert it is non-empty, `toMatch(/can't be typed/i)`, and `expect(title).not.toMatch(/\$/)` — the exact assertion shape the pinned badge-tooltip test uses, applied to the node this task adds.
      - Also render the **model-hidden + unmentionable** shape (`name: "has space", disableModelInvocation: true`) in the same test and assert BOTH `title`s in the tree are `$`-free: the badge's (`await screen.findByText("manual only")`) and the row's. This is what stops a future edit from moving the explanation into a `$`-carrying string.
      - And assert the mentionable arm is unaffected: render `skill({ name: "Omega" })`, its row has **no** `aria-disabled` attribute (`hasAttribute("aria-disabled")` is `false`), `tabindex` is `"0"`, its `title` is `null`, and its class tokens contain `cursor-pointer` and `hover:bg-surface-hover` and not `cursor-not-allowed`. That is the regression pin for every row that works today.

   No existing test in the file may be edited or deleted. If one reddens, the implementation is wrong — read its comment before touching it.

5. **`src/lib/skills.ts` — doc-comment only.**

   The `isMentionableSkillName` header states the rule *"Anything that OFFERS a `$name` route to a user or a model must check this first"* and then says "WHERE it is applied for SKILLS, precisely: `read_skill`'s model-hidden refusal (Rust) and this dialog's tooltip … and NOT the composer's `$` picker". Rewrite that sentence to name the third frontend site — the Skills-dialog **row's affordance** now branches on it too (a row whose name fails the predicate is rendered inert rather than inserting a token) — while keeping the composer-picker exemption and the "`@`/`#` catalogs are filtered Rust-side, the `$` catalog is not" contrast intact. Do not change the regex, the signature, or the MATCHED-PAIR note about `crate::skills::is_mentionable_name`.

6. **`docs/decisions/0036-model-hidden-skills.md` — amend, do not rewrite.**

   `docs/decisions/` is append-only (ADR 0036 says so itself, in its own ADR-0029 bullet), and the house precedent for correcting a shipped ADR is an appended blockquote, e.g. the `> **Amended 2026-10-16 (the \`?\` mark).** …` block in `docs/decisions/0038-attention-alerts-fire-only-while-unfocused.md`. Append ONE such blockquote at the end of the **Consequences** section, dated `2026-10-23`, that:
   - names the two bullets it corrects — *"The flag crosses IPC"* (the click "still inserts a dead token … the tooltip is the surface that tells the truth there") and the closing clause of *"A `$name` route is promised ONLY when the mention grammar can carry the name, and exactly two surfaces check"* ("the picker offers a row whose token expands nothing", "exactly two surfaces");
   - states the shipped rule: for a name the grammar cannot carry, the Skills-dialog row is now **listed and inert** (`aria-disabled`, out of the tab order, click and Enter inert, reason in a `$`-free tooltip), so the row and the tooltip finally agree;
   - states WHY the reversal is right and the catalog still is not filtered: the catalog stays total because it feeds model-facing discovery (that premise is untouched and stands), and the sibling `@`/`#` pickers filter because they exist ONLY to offer a mention token — the Skills dialog does not, so the honest seam is the row's affordance;
   - keeps the composer's `$` picker exactly as ADR 0036 left it (still able to offer an unmentionable name), so "the tools and the picker CAN disagree" survives verbatim for that surface;
   - says the `manual only` tooltip's rules are unchanged, including the no-`$`-glyph rule;
   - leaves the `superseded-by:` frontmatter EMPTY — this amends 0036 from inside its own decision, it is not superseded by a new one, and no new ADR file is created for it.

7. **`CONTEXT.md` — the model-hidden entry.**

   Its final sentence ends "…and the Skills-dialog **tooltip** says so plainly instead of promising a dead token — while that row's own click-insert for such a name is a known follow-up." Replace that last clause with the shipped fact: the row's own click now refuses to insert a token the grammar cannot carry (the row is listed but inert, and says why). Keep the rest of the entry, including the U+212A case-fold hedge and the `_Avoid_` line below it (`hidden`, `disabled` as a *word for the flag* — note that using `disabled` as the glossary word for the flag stays banned; the new UI state is described as an inert / not-selectable row, and the code-level prop name `disabled` is `RowButton`'s existing prop, not new prose).

**Steps:**

- [ ] Verify the premise before writing anything: run `pnpm vitest run src/components/SkillsDialog.test.tsx` from the repo root and confirm **20 passed** (the current baseline). If the count differs, stop and re-read the file — the tree outranks this plan.
- [ ] Write tests (a) and (b) above in `src/components/SkillsDialog.test.tsx`.
- [ ] Run `pnpm vitest run src/components/SkillsDialog.test.tsx`.
  - Both new tests must FAIL, and test (a) must fail on the affordance assertion (`aria-disabled` is `null` today / an insert event IS captured), not on a syntax or import error. If they pass already, stop and investigate — you are not driving the real `SkillsDialog`.
- [ ] Implement 1–3 in `src/components/SkillsDialog.tsx` (the `mentionable` boolean, `disabled={!mentionable}`, the `$`-free `title`, the `insertSkill` early return, the three class constants through `cn`).
- [ ] Run `pnpm vitest run src/components/SkillsDialog.test.tsx`.
  - Expect **22 passed, 0 failed**, including the two pinned tooltip tests `the_manual_only_tooltip_promises_no_$mention_a_name_cannot_carry` (the hard-constraint pin) and `the_manual_only_tooltip_offers_the_$mention_and_says_the_refusal_is_live` green **unedited**, plus `marks_a_model_hidden_skill_as_manual_only_but_still_inserts_the_mention` and `the_shadow_report_is_not_clickable` green. Fix failures; do not edit those tests.
- [ ] Apply the doc-comment change (5) and the two doc changes (6, 7).
- [ ] Run `pnpm test` from the repo root.
  - Green, 0 failed. Watch specifically for `src/lib/classNameConvention.test.ts` (a new hand-composed `className` offender means step 3 bypassed `cn()` — fix the component, never the allowlist), `src/components/RowButton.test.tsx`, `src/components/CatalogSearchDialog.test.tsx`, `src/components/ModelPickerDialog.test.tsx`, `src/components/SpacesList.test.tsx` (its `listSkills` fixtures are all mentionable names, so no inert row appears there and no accessible name changes — if a `getByRole("button", { name: … })` query goes ambiguous anyway, move the `title` from the row onto the name `<span>` and re-run).
- [ ] Run `pnpm build` from the repo root.
  - Exit 0 (`tsc` then `vite build`). `title` and `disabled` are both already in `RowButtonProps`, so no type change is expected anywhere.
- [ ] Confirm no Rust was touched: `git status --short` shows nothing under `src-tauri/`. If it does, revert those paths — this task's wave eligibility depends on it.
- [ ] Commit: `fix(skills): the Skills dialog no longer inserts a dead $token for unmentionable names (#10)`
  - Body: one line noting the reversal of ADR 0036's accepted trade-off, and one line recording the follow-up that `src-tauri/src/skills.rs`'s and `exec_read_skill`'s doc-comments now under-count the frontend surfaces (deliberately deferred to keep this task Rust-free).

**Acceptance criteria:**

- [ ] Clicking or pressing Enter on a Skills-dialog row for a Skill whose name fails `isMentionableSkillName` dispatches **no** `IPC_EVENTS.insertSkill` event and does **not** close the dialog.
- [ ] That row is still **listed** (the catalog stays total) and carries `aria-disabled="true"` + `tabIndex={-1}`, no `cursor-pointer` / `hover:bg-surface-hover` in its class tokens, `cursor-not-allowed` present, and a non-empty `title` explaining why that contains **no `$`**.
- [ ] A row for a mentionable name is unchanged in behaviour and appearance: `role="button"`, `tabIndex="0"`, no `aria-disabled` attribute, `cursor-pointer` + `hover:bg-surface-hover` present, and one `$<lowercased-name> ` event on click (pinned by the untouched `clicking_a_row_dispatches_the_insert_event_and_closes` and `marks_a_model_hidden_skill_as_manual_only_but_still_inserts_the_mention`).
- [ ] `the_manual_only_tooltip_promises_no_$mention_a_name_cannot_carry` and `the_manual_only_tooltip_offers_the_$mention_and_says_the_refusal_is_live` pass **without being edited**, and `manualOnlyTooltip` is byte-unchanged.
- [ ] `src/components/RowButton.tsx`, `src/components/CatalogSearchDialog.tsx`, `src/components/ModelPickerDialog.tsx`, `src/hooks/useMentionPicker.ts` and everything under `src-tauri/` are untouched (`git show --stat` proves it).
- [ ] ADR 0036 carries an appended amendment blockquote naming the corrected bullets and leaving `superseded-by:` empty; `CONTEXT.md`'s model-hidden entry no longer calls the click-insert "a known follow-up"; `src/lib/skills.ts`'s "WHERE it is applied for SKILLS" comment names the row affordance as a third surface.
- [ ] `pnpm test` and `pnpm build` from the repo root are both green.
