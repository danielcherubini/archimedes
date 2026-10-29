---
status: planned
task: "task06 (B3, #101 part (c)): mirror the widened DTO to TypeScript and render the definition's permission on the Agents modal row"
base: <re-derive at execution — step 0's truth, not 2b6bd26>
parallel: none
owning-wave: 3 (B3)
---

# B3 — Mirror the B2-widened `AgentConfigDto` / `OverrideFields` / `SourceFields` into `src/lib/tauri/types.ts` and render the definition's declared `permission` on the Agents modal row

**Issue:** https://github.com/danielcherubini/archimedes/issues/101 (part (c) — mirror + render ONLY).

**READ THIS FIRST — the plan is provisional by design.** This task is planned BEFORE its upstream (B2, task05) is implemented, and the modal-wire grounding states plainly that there is **no wire-contract test in this repo**: the frontend mocks `invoke`, the Rust tests never emit IPC, so a Rust↔TS shape drift is invisible to both suites. Consequently **every field shape this plan guesses in Steps 2–5 is provisional until Step 0 confirms it against the FINAL serde shape B2 actually landed**. The grounding report (`docs/roadmap/agent-permission-and-pins-ground-modal-wire.md`, §10) is the authority for that premise; this file is a planning artifact, and where it and the tree disagree, **the tree outranks the plan**. If `src-tauri/src/commands/agents.rs` (and the new permission type B2 created) show a different shape than the one Step 2 sketches, re-derive Steps 2–5 from what is actually there — do not implement a guessed shape to keep this file's wording intact.

---

## Scope (the owned set — exactly these eight files, no other file may be edited)

- `src/lib/tauri/types.ts` (modify — mirror the widened Rust DTO)
- `src/lib/tauri.ts` (modify — ONLY if the mirror introduces a NEW top-level exported type; see Step 3 — a type that exists only as an inline property of `AgentConfigDto` needs NO barrel change)
- `src/components/AgentsDialog.tsx` (modify — render the definition's declared permission on the row)
- `src/components/AgentsDialog.test.tsx` (modify — `row()` fixture + new assertions)
- `src/hooks/useAgentCatalog.test.ts` (modify — TWO fixture sites, one of which is NOT builder-reachable: the inline `satisfies AgentConfigDto` literal inside the hoisted `vi.mock("../lib/tauri")` factory at line 19–31, and the `row()` builder at line 40. Explicitly part of this task's set because `pnpm build` = `tsc && vite build` and `tsconfig.json` `include`s `src`, so this file IS typechecked; both sites get the same two mechanical defaults as the owned builder)
- `src/components/SpacesList.test.tsx` (modify — the `agentRow()` builder at line 62, which imports `type AgentConfigDto` and must keep compiling; same two mechanical defaults)
- `src/lib/tauri.test.ts` (modify — ONE site, the `const row: AgentConfigDto` literal at ~line 440, treated NOT as a fixture to patch silently but as what it is (its own comment says so): a deliberate WIRE-SHAPE PIN. The pin therefore GAINS the new fields' actual wire spellings (`permission` / `frontmatterNotes`, matching B2's serde) and the describe block's existing assertion pins (the `expect(out.override)…` / `expect(out.shadowed)…` lines at 458–461) gain `expect(out.permission…)` — an asserted pin, not a tsc-silencing patch)
- `src/lib/tauriBarrel.test.ts` (modify — only if the mirror adds a top-level exported type: the new name MUST be added to `TAURI_PUBLIC_API`. If the new shapes are inline-only, this file is untouched)

**Barrel decision (stated so both branches stop contradicting):** new DTO types introduced by this mirror ARE re-exported through `src/lib/tauri.ts`'s `export type { … } from "./tauri/types"` block, and consumers (`AgentsDialog.tsx`, `useAgentCatalog.ts`, fixtures) import them FROM THE BARREL — the file's existing consumer imports (`AgentConfigDto` from `../lib/tauri`) are the precedent. The type-only names must be added to `TAURI_RUNTIME_API` NEVER — they vanish at runtime; the `AccessRule` / `AccessDirection` comment precedent stays.

**Display only. No rule-authoring UI.** Parsing, enforcing and displaying what a file declares is the whole scope of #101; authoring is the file's job. Nothing here touches `AgentOverride` / `AgentOverrides` / `AppSettings.agentOverrides` — the per-agent ruleset rides the `AgentConfigDto` REPORT, never the stored override document, and there is no `onPatch` extension of any kind.

---

## Step 0 — Read B2's FINAL serde shape, then re-confirm the currently-open files (mandatory, precedes everything)

1. Re-read the widened DTO in `src-tauri/src/commands/agents.rs`:
   - `AgentConfigDto` — does it now carry a `permission` field? On which of the structs (`AgentConfigDto` itself and/or `OverrideFields` and `SourceFields`)? What is its exact Rust type and serde rename (`#[serde(rename_all = …)]`, any `#[serde(rename = …)]`, any `skip_serializing_if`)?
   - The new permission types B2/B1 created in `src-tauri/src/agent/definition_permission.rs` — `PermissionBlock`, `ToolKey`, `Rules`, `Rule`, `Action`, `UnsupportedReason`, `FrontmatterNote` (B1's plan pinned these names and shapes — verify what ACTUALLY exists now). Note the `FrontmatterNote` doc-comment in B1's plan: `#[serde(tag = "kind", rename_all = "camelCase")]` — a tagged enum whose variants are unit-ish or carry one payload key. **The annotated-serde (`tag`) spelling is the kind of detail no Rust test and no mock-based TS test will ever verify** — the wire values must be copied EXACTLY from `definition_permission.rs`, not from B1's plan file.
   - Whether the notes/report rides a sibling field (B1's hand-off named `frontmatterNotes`-shaped, REQUIRED like `shadowed`) and where — `AgentConfigDto`, or per-column in `OverrideFields`/`SourceFields` (task04's hand-off literally says "`AgentDefinition.frontmatter_notes` exists as of this task; deciding whether `AgentConfigDto` carries it (sibling `Vec<FrontmatterNote>`, `"frontmatterNotes"`, REQUIRED like `shadowed`) and how the modal renders it … is B2/B3's call, and must not ride `shadowed`").
   - Whether `SourceFields` gained a per-field or a ruleset-level source (a new `OverrideSource`-like vocabulary, or a reuse of the three existing layers) — **run whatever B2 chose against ADR 0068's consequence** *"the label space is `override` / `file` / `parent`, and nothing else needs a word"* (grounding §3e). If B2 extended the layer vocabulary for the permission block, the row reuses it; if the ruleset simply has no layer, the row must not invent one.
2. Re-read the still-open files and re-verify the line numbers quoted below against what is in them NOW:
   - `src/lib/tauri/types.ts` — the agent-config declarations (§1b anchors: `AgentConfigDto`, `AgentOverrideFields`, `AgentOverrideSources`, `OverrideSource`, `ShadowedAgent`),
   - `src/components/AgentsDialog.tsx` — the row DOM order (identity → description → pin-diff → Model → Thinking → Tools → `ShadowReport`), the in-file building blocks `LayerTag`, `MutedCaption`, `ShadowReport` (§3),
   - `src/components/AgentsDialog.test.tsx` — the `row()` fixture builder (line 21),
   - `src/hooks/useAgentCatalog.test.ts` — TWO fixture sites: the INLINE `satisfies AgentConfigDto` literal inside the hoisted `vi.mock("../lib/tauri")` factory (lines 19–31 — a builder-based fix CANNOT reach it, edited individually) and the `row()` builder (line 40),
   - `src/components/SpacesList.test.tsx` — the `agentRow()` builder (line 62),
   - `src/lib/tauri.test.ts` — the `listAgentConfig` describe block's `row` literal (`const row: AgentConfigDto` at ~line 440) — the deliberate wire-shape PIN (its own comment says so); the new fields are ASSERTED there (Step 4), not silently patched to quiet `tsc`.
3. If B2/B1 edited any of this task's owned files (eight — Scope; note B1 owns `src-tauri/src/commands/agents.rs` for its two Rust test literals, which this task never touches; the Rust side of the REQUIRED field needs NO change, `shadowed` proves the field is always emitted), treat Steps 2–5 as re-derived from that diff.

**What proves Step 0 was done:** the plan's guessed shapes (below) are annotated as provisional, and the implementer's diff for `types.ts` mirrors the DTO fields (names, alphacase unions, `| null` vs optional, `as const`-free literal unions, `tag`-discriminated notes) exactly as `src-tauri/src/commands/agents.rs` + `src-tauri/src/agent/definition_permission.rs` spell them after B2.

---

## Step 1 — Remember the four repo facts that constrain every later step (state them in the commit)

1. **The `shadowed` precedent for a REQUIRED-always-present field.** The DTO's per-row report fields are REQUIRED, not optional, because Rust always serialises them (`shadowed` is the standing example — "REQUIRED, not optional: the Rust DTO always serializes the Vec (empty as `[]`)", grounding §1b). If B2's `permission`/`frontmatterNotes` fields are the same (a `Vec` or a struct with no `skip_serializing_if`), the TS mirror declares them REQUIRED, and the only blast radius is the FOUR fixture literals listed in Scope and Step 3.1 (the two builders + the `vi.mock` inline literal + the `tauri.test.ts` pin, which is asserted, not patched). Do NOT declare an always-present field `?`-optional to dodge those fixture edits — the `doc types.ts` `SessionInfo.costUsd` precedent is the OPPOSITE case (the field is genuinely absent-capable), and \(a\) a required field that Rust always emits keeps the type an honest mirror, and \(b\) the `?? []` tolerance the row renderer keeps is a defence for old rows, not a licence to omit the fixture field.
2. **The barrel rule (ADR 0074).** A new exported type must be added to BOTH `src/lib/tauri.ts`'s `export type { … } from "./tauri/types"` block AND `TAURI_PUBLIC_API` in `src/lib/tauriBarrel.test.ts` — `tauriBarrel.test.ts`'s `"the barrel re-exports the exact pinned public API"` asserts the surface equals the literal, so a forgotten registration reddens `pnpm test`. It must NOT be added to `TAURI_RUNTIME_API` (type-only names vanish at runtime; the `AccessRule`/`AccessDirection` comment in that file is the precedent). A type that exists only as an inline property of `AgentConfigDto` needs no barrel change at all.
3. **The AGENTS.md `App.test.tsx` trap — verified: it does NOT apply here — and the correct reason travels with it.** `src/App.test.tsx`'s `vi.mock("./lib/tauri", …)` factory spreads `vi.importActual`, so a boot fetch not listed resolves to the real wrapper and rejects outside a webview, reddening every test in that file "looking unrelated". `listAgentConfig` is NOT mocked there (verified at plan time: `grep -n listAgentConfig src/App.test.tsx` → no match) and **no change is needed** — but the reason is not the dialog's mount gate: `SpacesList` calls `useAgentCatalog(activeSpacePath)` **unconditionally** (line 360, at module-render time, NOT gated on the dialog mounting or any `settings &&`), so the fetch ALREADY fires in App's render path today, ALREADY rejects outside a webview whenever it is hit, and ALREADY degrades gracefully because `useCatalogRow`'s `.catch` (useCatalogRow.ts line 96) converts rejection to empty rows. Adding `permission`/`frontmatterNotes` changes no such runtime call and adds no boot-called export. What the task adds is a TYPE and a renderer change — nothing App's boot path calls at runtime — so `App.test.tsx` stays green. Verify once more at execution (Step 0's re-read) before finalizing — a wrong answer on this point is what costs three unrelated test failures.
4. **The permission rules are ORDERED and LAST-MATCH-WINS; the display must NOT sort them.** B1's plan pins `PermissionBlock.tools: Vec<(ToolKey, Rules)>` in FILE ORDER and `Rules.patterns: Vec<Rule>` in file order ("Nothing sorts, nothing dedupes, nothing re-orders") — because opencode resolves a tool's pattern object in order, LAST matching rule wins. Sorting the display would misrepresent which rule actually governs — the same silent-no-op class #101 exists to fix. The row renders the vecs in the order received, verbatim; no `.sort()`, no `.toSorted()`, no Map-key reordering anywhere in the display path. **B3's ordering commitment — T2's fixture must break BOTH plausible sort keys at once** (a pattern-lexicographic sort AND an action-lexicographic sort): one `edit` tool's patterns in the FILE-SCRAMBLED order `[{pattern: "*", action: "deny"}, {pattern: "*.md", action: "allow"}, {pattern: "src/lib/*.ts", action: "deny"}, {pattern: "src/generated/*", action: "allow"}]` is NOT sorted by pattern (`*` < `*.md` < `src/*` lexicographically, so a pattern-sort would reorder it) and its action sequence deny/allow/deny/allow is NOT sorted either (an action-sort would reorder the verdicts). A render path that sorts by EITHER key reproduces a different sequence than the fixture, so the test can only stay green by NOT sorting. Pin the rendered order as an ORDERED sequence (the block's text as a joined string it compares against, or an ordered node list via `within(...).getAllByText(...)` — never per-text `getByText`, which cannot observe order).

---

## Step 2 — `src/lib/tauri/types.ts`: mirror the widened DTO (PROVISIONAL shape — re-derive from Step 0)

If B1's plan's type grammar (as B2 wired it) is what the final code holds, mirror it field-for-field in `types.ts`, one new interface in the file's agent-config region (right after `ShadowedAgent`), spelled with the file's conventions (§1a: camelCase wire names; literal string unions inline — NO named `as const`; `… | null`, never `?`, when Rust serialises the key always):

```ts
/** One matching rule of a path-taking tool's ordered pattern→action map (the
 *  Rust `definition_permission::Rule`; issue #101). The `pattern` is a glob
 *  over the tool's path; the `action` is the LAST-MATCHING rule's verdict.
 *  ORDERED — the display preserves file order and never sorts, because
 *  opencode resolves a tool's patterns in order and the last match governs. */
export interface AgentPermissionRule {
  pattern: string;
  action: "allow" | "ask" | "deny";
}

/** A ≤3-way hint to the matcher (the Rust `ToolKey`); wire spelling is B2's. */
export type AgentPermissionTool =
  | "edit" | "read" | "bash" | "write" | "find"
  | "grep" | "ls" | "readSkill" | "ask" | "webSearch"
  | "fetchContent"
  | (string & {});
  // ^`(string & {})` keeps OPEN unknown tool names representable — B1's
  // `ToolKey::Unrecognized(String)` is a FIRST-CLASS case, never a drop.

/** One tool's ruleset (the Rust `definition_permission::Rules`). */
export interface AgentPermissionRules {
  patterns: AgentPermissionRule[];
  /** True when the tool key carried a BARE verdict (`bash: deny`) — the
   *  action applies to ANY argument. Rows for a bash OBJECT with ≥1 pattern
   *  are parsed but announced unsupported, never enforced (issue #101). */
  wholeTool: boolean;
}

/** The FULL declared permission block, in FILE ORDER (the Rust
 *  `definition_permission::PermissionBlock`). A multi-tool block is exactly
 *  this many ordered entries — no other shape is representable. */
export interface AgentPermission {
  /** `tool` + its ruleset, in file order (`tool` is the parenthesised value
   *  of the `(ToolKey, Rules)` pair). */
  tools: Array<{ tool: AgentPermissionTool; rules: AgentPermissionRules }>;
}

/** One "the file said something the reader does not understand" note (the
 *  Rust `definition_permission::FrontmatterNote`). The `kind` discriminant
 *  and the payload field name MUST match B2's actual serde spelling. */
export interface AgentFrontmatterNote {
  kind: "unknownKey" | "unrecognizedToolKey"
    | "unsupportedUnvalidatedMatcher" | "unknownAction";
  /** All but `unsupportedUnvalidatedMatcher` carry the offending string. */
  value?: string;
}
```

and widen `AgentConfigDto` (PROVISIONAL — add whatever B2 actually added, no more, no less):

```ts
  /** The definition file's declared `permission:` block (issue #101), as
   *  parsed by Rust — REQUIRED, not optional: the DTO always serializes it
   *  (empty/absent as the Rust-side equivalent of `shadowed: []`), and the
   *  row renders it. RULES ARE ORDERED — display preserves order. */
  permission: AgentPermission;
  /** The frontmatter-read notes (unknown top-level keys, unrecognised tool
   *  keys, unsupported bash-pattern rows) — REQUIRED like `shadowed`. */
  frontmatterNotes: AgentFrontmatterNote[];
```

**Follow the file's existing rule for naming:** the wire types are named per surface (`ShadowedAgent` instead of sharing `ShadowedSkill`), so the plan's names (`AgentPermission*`) are placeholders — if B2/B1 used different names (e.g. `PermissionBlock` / `ToolKey` camelCased), reuse B2's OWN Rust naming convention as the modal-wire file does for its other per-surface types and say so. Doc-comments must cite the narrowing-only invariant B1 pinned (*"No shape in this module can express 'allow beyond the user's policy' — the actions are exactly `allow | ask | deny` and a per-agent `allow` is at most a no-op on the outside of the user's boundary"*) so a future editor cannot widen a type into a grant.

---

## Step 3 — TDD with the fixture builder updated (RED → GREEN), and the barrel only if needed

**TDD per repo convention; scoped run:`pnpm exec vitest run src/components/AgentsDialog.test.tsx` (the file stays prop-driven, no IPC mock — §4).**

1. **RED first — and know exactly which red appears where.** Vitest transpiles with esbuild and does NOT typecheck, so a required-field fixture break can never be a vitest red; there are two different reds:
   - **The scoped vitest RED (`pnpm exec vitest run src/components/AgentsDialog.test.tsx`):** the NEW test `T1` (missing-renderer assertion) fails red before Step 4 implements the block. This is the red TDD demands — and historically the only red this task can ever see in the agent-config tests, because…
   - **The `tsc` red surfaces at the BUILD step, not in vitest:** `pnpm build` = `tsc && vite build` and `tsconfig.json` `include`s `src`, so the required fields redden EVERY `AgentConfigDto` literal at `tsc` time. Because that is precisely the red the plan's tripwire used to fire on, the owned set is widened (Scope) to the four fixture sites that required fields would otherwise redden:
     1. `AgentsDialog.test.tsx` — the single `row()` builder (line 21) — the owned builder; `permission: { tools: [] }` and `frontmatterNotes: []` defaults (whatever the wire type's empty value is), mirroring `shadowed: []`. **Verified, not guessed, at plan time:** this file has exactly ONE fixture builder and ZERO other `AgentConfigDto` literals (grep: `AgentConfigDto` appears only as the import (line 5), the `row()` signature (line 21), and the `rows` props types (lines 105, 141); `grep -c "row("` = 24 — all 24 constructions flow through `row()`, one mechanical edit).
     2. `src/hooks/useAgentCatalog.test.ts` — TWO sites: the inline `satisfies AgentConfigDto` literal inside the hoisted `vi.mock("../lib/tauri")` factory (lines 19–31 — the factory is hoisted above the file's imports and runs during their evaluation, so the builder BELOW it at line 40 is unreachable from it; this literal is edited individually, adding the same two defaults) and the `row()` builder (line 40) — one mechanical edit each, identical to the owned builder.
     3. `src/components/SpacesList.test.tsx` — the `agentRow()` builder (line 62) — one mechanical edit.
     4. `src/lib/tauri.test.ts` — the `listAgentConfig` describe block's `row` literal (`const row: AgentConfigDto` at ~line 440). **This one is NOT patched silently to quiet `tsc`:** its own comment (lines 434–439) announces it as a deliberate wire-shape pin ("the payload is a REAL serialized row"), so it must instead GAIN the new fields' actual wire spellings (`permission` / `frontmatterNotes` as B2's serde spells them) and the describe block's assertion pins (the `expect(out.override)…` / `expect(out.source.model)…` / `expect(out.shadowed)…` lines at 458–461) gain `expect(out.permission…)` / `expect(out.frontmatterNotes…)` — the asserted pin, not a tsc-silencing patch.
   The Rust side of the same REQUIRED field needs NO change — `shadowed` proves the field is always emitted.
2. Second, add the NEW modal assertions (this is what makes the TDD test actually test the feature):
   - **T1 `a_row_renders_the_definitions_declared_permission_block`** — a `row()` whose `permission` carries a multi-tool block (`edit` with ordered patterns `"*"`→deny first, `"*.md"`→allow second, then a bare-verdict `bash` with `wholeTool: true`) renders the tool names and their verdicts.
   - **T2 `the_permission_display_preserves_file_order_and_never_sorts`** — feed the four-rule file-scrambled fixture from step-1-fact-4 — `[{pattern: "*", action: "deny"}, {pattern: "*.md", action: "allow"}, {pattern: "src/lib/*.ts", action: "deny"}, {pattern: "src/generated/*", action: "allow"}]` in FILE order — and pin the rendered sequence as an ORDERED assertion: the block's text as one joined string to compare against, or an ordered node list (`within(block).getAllByText(/→/)` checked index-by-index) — never per-text `getByText`, which cannot observe order. A `.sort()` on pattern OR action changes the sequence, so this test can only stay green by not sorting.
   - **T3 `a_row_with_no_permission_block_renders_no_permission_line`** — the default `row()` renders nothing extra (the ordinary case stays lean; exactly like `ShadowReport` returning `null` for zero losers).
   - **T4 (rule-authoring absence) `the_permission_block_is_plain_text_never_a_control`** — the block's containing element `closest('[role="button"]')` is null and it contains no `input`/`button`/`combobox` (mirror the shadow-report test's absence pattern) — the Display-Only scope, pinned.
   - **T5 (if B2 ships the notes) `unrecognised_and_unsupported_rows_are_named_not_dropped`** — a `frontmatterNotes` entry renders its kind + value; an empty array renders nothing.
3. GREEN: the row renderer (Step 4) satisfies the new assertions and the default `row()` keeps every pre-existing test green.
4. **Barrel, only if the mirror introduced a new exported type:** add the new name(s) to the `export type { … } from "./tauri/types"` block in `src/lib/tauri.ts` AND to `TAURI_PUBLIC_API` in `src/lib/tauriBarrel.test.ts` (never to `TAURI_RUNTIME_API` — type-only, like `AccessRule`/`AccessDirection`). Run `pnpm exec vitest run src/lib/tauriBarrel.test.ts` to confirm the pinned-surface assertions are green. If no new top-level type was introduced, `src/lib/tauri.ts` is NOT edited (the dispatch allows it, does not require it).
5. Run the scoped file green: `pnpm exec vitest run src/components/AgentsDialog.test.tsx`.

---

## Step 4 — `src/components/AgentsDialog.tsx`: render the permission block on the row

**Placement decision (decided here, with the reason the dispatch asked for):** a plain-text, muted block rendered between the Tools cell and `<ShadowReport row={row} needle={needle} />`. Reasons:

1. **It is a report, not a field line.** The Model/Thinking/Tools cells are *editable* columns (value + layer + control, with `LayerTag` + `MutedCaption` context). The permission ruleset has a deliberately non-editing row: it is the definition file's declaration, exactly like the shadow report is the definition's name collision. The row's two "plain text under the row" precedents — the stored-pin disagreement cue and the shadowing disclosure — both call themselves "PLAIN TEXT like the shadowing disclosure at the bottom of the row" (grounding §3f, §3e).
2. **It must sit ABOVE `ShadowReport`.** The shadow report is *"the winning row's"* closing disclosure — the row's LAST visual element. The declared permission is definition content (what this agent is allowed to do); the shadow report is collision meta (what this row's name excluded). Name-collision meta closes the row; declared policy belongs to the definition block above it. So the order is: Tools → **permission block** → ShadowReport — DO NOT `reverse` the row's DOM order (Anders CSS alarm applies: `flex-col-reverse` exists precisely to smuggle order changes past a reviewer).
3. **Reuse the row's own building blocks — no second vocabulary.** Leading label `Permission` (the `w-16 shrink-0 text-ui-sm text-foreground-subtlest` span — the same label the Model/Thinking row lines use), values in `MutedCaption` (`text-ui-xs` — the ShadowReport sized the muted loser lines `text-ui-xs` itself). **Do NOT invent a second layer-label vocabulary or a second muted-text style:** ADR 0068's label space is `override` / `file` / `Inherits parent…` for the three overridable FIELDS; the permission block is declaration text, not a resolver layer, so it prints the verdicts (and, where B2 shipped it, the layer/source exactly as B2's DTO spells it) using the same `LayerTag` element the field lines use — the tag component, not a new class.
4. **No controls, no `onPatch`, no new props.** `AgentRow`'s props stay as they are. The render is a short component (mirror `ShadowReport`'s shape): a muted block listing each tool, then its ordered patterns `verbatim` ("`*.md` → allow" in file order), the bare-verdict tools as tool-wide lines (`bash → deny`), and the notes (`frontmatterNotes`) as extra muted lines when ride. Empty ruleset (`permission.tools.length === 0` with the REQUIRED field) renders `null` — the `?? []`-style tolerance is unnecessary for a REQUIRED field but harmless; keep the check as an `if (…) return null` like `ShadowReport`.
5. **If B2 ships a per-ruleset layer/source, run it past ADR 0068** (step-0-1.4): reuse the layer labels exactly, or state clearly why none applies.

---

## Step 5 — Gates (TDD close-out, from the repo root)

1. `pnpm exec vitest run src/lib/tauriBarrel.test.ts` — green (the pinned-API fast fail; a forgotten `TAURI_PUBLIC_API` registration reddens here first).
2. `pnpm exec vitest run src/components/AgentsDialog.test.tsx` — green (all pre-existing 27 + the new T1–T5).
3. **`pnpm test`** — the full frontend gate (`vitest run`; 154 files / 3252 tests at the `2b6bd26` baseline — re-measure at your HEAD). The `tauriBarrel` mock-seam counts (37 mockers / 36 `importActual` spreaders) are already accounted for: this task adds a TYPE, not a mock file, so the counts must stay 37/36.
4. **`pnpm build`** — `tsc && vite build` from the repo root. `tsconfig.json` has `"include": ["src"]`, so **test files ARE typechecked** — the required-field addition reddens the four fixture sites; with the widened owned set (Scope) every one of them has already been edited (mechanical defaults on the three builder sites, asserted wire spellings on the `tauri.test.ts` pin), so `tsc` goes green here with NO blocking report. This step is where the TS-side red surfaces at all — vitest never typechecks. If Step 0 shows B2 made the field optional/`None`-capable, the fixtures legitimately predate it, the four edits shrink to just the new-test literals, and this gate has nothing to do beyond the assertion pins.
5. Report the measured mutation-adjacent figures in the commit: THREE fixture builders updated (`AgentsDialog.test.tsx` `row()`, `useAgentCatalog.test.ts` `row()`, `SpacesList.test.tsx` `agentRow()`), ONE inline `vi.mock` literal updated (`useAgentCatalog.test.ts`), ONE wire-shape pin extended (`tauri.test.ts` — asserted, not patched), barrel registration status (done/not-needed).

---

## Acceptance criteria (gate for THIS task)

1. `types.ts` mirrors the FINAL widened DTO as actually implemented (field names, unions, `| null` vs optional, serde `rename`/`tag` spellings copied from the Rust) — verified by the Step 0 read, not by this file's guess. `AgentDefinitionDto` stays four fields (the `@`-mention surface — B2/B1 pinned that separation).
2. The permission block renders on the Agents row: a muted block after Tools, before `ShadowReport`, reusing `LayerTag`/`MutedCaption`/`ShadowReport` and NO new label or muted-text vocabulary.
3. The display preserves file order — no sort anywhere (T2 pins it).
4. No rule-authoring UI: no new props, no `onPatch` route, no `PermissionSection`/`SettingsBadge` import (T4 pins the block as plain text, exactly as the shadow report is plain text).
5. `AgentsDialog.test.tsx` ships the new assertions and the fixture update; ALL pre-existing tests stay green (`pnpm exec vitest run src/components/AgentsDialog.test.tsx`).
6. Barrel: if the mirror added an exported type, it is in both the `types` block of `src/lib/tauri.ts` and `TAURI_PUBLIC_API` (not `TAURI_RUNTIME_API`) — `tauriBarrel.test.ts` green. If only inline properties were added, `src/lib/tauri.ts` is untouched.
7. `App.test.tsx` is UNTOUCHED and still green — `listAgentConfig` is NOT mocked there, and no change is required because the fetch already runs (unconditionally, via `SpacesList`'s `useAgentCatalog(activeSpacePath)`), already rejects outside a webview, and already degrades via `useCatalogRow`'s `.catch`; the task adds a type + a renderer change, not a boot-called runtime export (verified at plan time, re-verify at Step 0).
8. Full gates green from the repo root: `pnpm test`, `pnpm build`.

## Parallelisation

Not applicable — this is one roadmap task with one owned file set; no `**Parallel:**` line is required. (The status file records wave 3 as width 1.)

## Source-file anchors (line numbers for navigation at plan time — re-verify at execution)

- `src/lib/tauri/types.ts` — agent-config declarations (`AgentConfigDto` / `AgentOverrideFields` / `AgentOverrideSources` / `OverrideSource` / `ShadowedAgent`; file-header conventions), `AccessPolicy`/`AccessDirection`/`AccessRule`/`FilePolicy` (the only existing allow/deny/ask + pattern→action vocabulary)
- `src/lib/tauri.ts` — `export type { … } from "./tauri/types"` block (type-only new names land here AND in `TAURI_PUBLIC_API`)
- `src/lib/tauriBarrel.test.ts` — `TAURI_PUBLIC_API` literal (pinned-API assertion), `TAURI_RUNTIME_API` (the literal pins the count — read it there; must NOT gain type-only names), mock-seam counts 37/36
- `src/lib/tauri.test.ts` — the `listAgentConfig` describe block's `row` literal (`const row: AgentConfigDto` at ~line 440)
- `src/components/AgentsDialog.tsx` — `AgentRow` (DOM order), `LayerTag`, `MutedCaption`, `ShadowReport`, `sourceLabel`/`toolsInheritLabel` (ADR 0068 label space)
- `src/components/AgentsDialog.test.tsx` — `row()` builder (line 21), `shadow()` builder, `openDialog`/`renderControlled`, 27 `it(` / 24 `row(` (re-verify)
- `src/App.test.tsx` — the `vi.mock("./lib/tauri")` factory (NOT touched; `listAgentConfig` NOT mocked)
- `src-tauri/src/commands/agents.rs` — `AgentConfigDto` / `OverrideFields` / `SourceFields` / the `list_agent_config` DTO (post-B2 = the mirror's ground truth)
- `src-tauri/src/agent/definition_permission.rs` — `Action` / `Rule` / `Rules` / `ToolKey` / `PermissionBlock` / `FrontmatterNote` serde spellings (post-B1/B2)
- `docs/roadmap/agent-permission-and-pins-ground-modal-wire.md` (§1 conventions, §2 barrel, §3 row, §4 blast radius, §5 reuse candidates, §6 DTO pins, §7 gates, §8 App.test.tsx, §10 no-wire-contract-test)
- `docs/roadmap/agent-permission-and-pins-task04-parse-permission-frontmatter.md` (B1's type grammar — the provisional source this plan mirrors; superseded by the tree after B1/B2 land)
- `docs/decisions/0074-…barrel…md`, `docs/decisions/0068-…rendered-by-the-dispatch-path…md` (barrel rule; layer-label space)
