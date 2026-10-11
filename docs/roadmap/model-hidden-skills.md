---
status: committed
done-when: "A SKILL.md carrying `disable-model-invocation: true` is absent from the `<skills>` system-prompt section, absent from `list_skills`, and refused by name by `read_skill` (which names the `$name` route back to the model) — while the Skills dialog still lists it, marked `manual only`, and `$name` still expands its body byte-identically."
---

# Model-hidden Skills Plan

**Goal:** Honor the Agent Skills frontmatter key `disable-model-invocation: true` — such a Skill becomes **model-hidden**: invisible to the Agent on all three model-facing surfaces, fully available to the user through the `$name` Mention.

**Architecture:** Discovery (`skills.rs`) stays TOTAL and unfiltered — it is the Client's source and the `$` route's source. Exactly two functions hand skills to the model, and each filters on one new predicate: `format_skills_for_prompt` (the system prompt's `<skills>` section) and the `exec.rs` skill-tool seam. ADR 0036 records the decision, its ceiling, and its rejected alternatives.

**Tech Stack:** Rust (Tauri backend, `src-tauri/`, crate `archimedes_lib`, toolchain pinned 1.99.0 by `rust-toolchain.toml`) + React 19 / TypeScript (`src/`, vitest, tsc via `pnpm build`).

**Read first:** `docs/decisions/0036-model-hidden-skills.md` (the decision + ceiling), `docs/decisions/0029-skill-tools-read-by-name.md` (per-skill containment, name-as-allowlist, the path-disclosure rule), `docs/decisions/0031-composer-mention-grammar-and-emergent-tag-safety.md` (expansion), and `CONTEXT.md` → **Skill**, **model-hidden / model-visible**, **Boundary**, **Mention**.

**Invariant to preserve everywhere:** *to the Agent, a model-hidden Skill is not in the catalog.* It is NOT confidential — `boundary::read_roots` grants the Boundary the skill discovery roots (ADR 0030), so `read`/`ls`/`grep` on a skill path stay in bounds. **Do not** change `boundary.rs`, `POLICIED_TOOLS`, or any policy.

**Commands** (AGENTS.md): Rust from `src-tauri/` — `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --all -- --check`. Frontend from the repo root — `pnpm test`, `pnpm build`.

---

### Task 1: Parse the flag and carry it on `SkillInfo`

**Context:**
The key is parsed away today: `parse_skill_file` (`src-tauri/src/skills.rs`) recognizes exactly two top-level frontmatter keys (`name:`, `description:`) and ignores every other, so `SkillInfo` never carries the flag and every consumer advertises every skill. This task adds the field and the ONE predicate every model-facing seam will filter on (`SkillInfo::model_visible`). It changes NO behavior for any consumer — discovery stays total, because the Skills dialog and the `$` Mention must keep seeing model-hidden skills. Truthiness is the unquoted lowercase literal `true` ONLY: pi YAML-parses frontmatter and tests `=== true`, so `yes` / `True` / `1` / `"true"` leave a Skill model-visible, and we match pi byte-for-byte (ADR 0036).

**Files:**
- Modify: `src-tauri/src/skills.rs` (the `SkillInfo` struct ~line 25; `parse_skill_file` ~line 256; its construction site ~line 119)
- Modify: `src-tauri/src/agent/harness/prompt.rs` (the test helper `fn skill(…)` ~line 315 — it is a FULL struct literal and will not compile until the field is added)
- Test: `src-tauri/tests/skills.rs` (integration — `parse_skill_file` is PRIVATE; go through `discover_in_roots`, and do NOT make it `pub` for a test)

**What to implement:**
1. `SkillInfo` gains, after `body`:
   ```rust
   /// Frontmatter `disable-model-invocation: true` — the Skill is
   /// MODEL-HIDDEN: unadvertised and unresolvable by name (ADR 0036).
   pub disable_model_invocation: bool,
   ```
   `SkillInfo` already has `#[serde(rename_all = "camelCase")]`, so this serializes as `disableModelInvocation` over IPC — no other serde change.
2. An inherent predicate (near the struct):
   ```rust
   impl SkillInfo {
       /// The one predicate every model-facing seam filters on (ADR 0036).
       pub fn model_visible(&self) -> bool {
           !self.disable_model_invocation
       }
   }
   ```
3. `parse_skill_file` returns `Option<(String, String, String, bool)>` — `(name, description, body, disable_model_invocation)`. In the existing top-level-key scan loop (the one that reads `name:` and `description:` and skips indented lines), add a third tracked key with the same "first occurrence wins, top-level lines only" shape — declare `let mut disable: Option<bool> = None;` beside the existing `name`/`description` bindings, then in the loop:
   ```rust
   if disable.is_none() {
       if let Some(rest) = line.strip_prefix("disable-model-invocation:") {
           // pi parses YAML and tests `=== true`, so ONLY the unquoted
           // lowercase literal hides (ADR 0036). Rarer YAML shapes
           // (`true # comment`, a block scalar) therefore do NOT hide here
           // where pi's YAML parser would — accepted, ADR 0036.
           disable = Some(rest.trim() == "true");
       }
   }
   ```
   Then `let disable_model_invocation = disable.unwrap_or(false);` alongside the existing `name`/`description` unwraps, and return it as the 4th tuple element. No other rule changes: `is_tag_safe_name`, the 1024-`char` description skip, the `\r\n` normalization, the missing-`---` → `None` path, and the no-frontmatter fallback (return `false` there) all stay exactly as they are.
4. Update the single production caller — `discover_in_roots` destructures the tuple at `src-tauri/src/skills.rs:93` (`let Some((name, description, body)) = parse_skill_file(…)`), and builds the `SkillInfo` literal at ~line 119 — to take the 4th element and set the new field. Add `disable_model_invocation: false` to the `skill(…)` helper literal in `prompt.rs`'s test module (~line 316). Those are the ONLY two `SkillInfo {` struct literals in the crate.
5. **Do not** filter anything in this task. `discover_skills` / `discover_in_roots` / `commands/skills.rs::list_skills` must still return model-hidden skills.

**Steps:**
- [ ] Write the five failing tests in `src-tauri/tests/skills.rs` (reuse its existing `write_skill` / `find_row` helpers and the `discover_in_roots(&[(root, SkillScope::User)])` convention — never the real `~/.agents/skills`):
  - `frontmatter_flag_hides_a_skill` — `---\nname: alpha\ndescription: D\ndisable-model-invocation: true\n---\nBody.\n` → `rows[0].disable_model_invocation == true` AND `rows[0].model_visible() == false`; and the same file WITHOUT the key → `false` / `model_visible() == true`.
  - `frontmatter_flag_counts_only_the_literal_true` — for each of `yes`, `True`, `TRUE`, `"true"`, `'true'`, `1`, `on`, ` ` (empty), assert `disable_model_invocation == false`. Write them as a loop over `&[("yes"), …]` so one case failing names itself.
  - `frontmatter_flag_is_ignored_when_indented` — the key indented two spaces UNDER a `description: >` block scalar (i.e. it is part of the folded value, not a top-level key) → `false`.
  - `discovery_still_returns_model_hidden_skills` — two skills, one flagged; `discover_in_roots` returns BOTH (`len() == 2`) and `find_row(&rows, "hidden").disable_model_invocation` is true. This test is the total-discovery invariant; it is what stops a later change from filtering at the wrong seam.
  - `skill_info_serializes_the_model_hidden_key` — `serde_json::to_value(&row)` has `disableModelInvocation` (camelCase, exact key) and NO `disable_model_invocation`. Add `serde_json` usage only in the test (it is already a dependency of the crate).
- [ ] Run `cargo test --test skills` from `src-tauri/`
  - Did it fail to COMPILE with "missing field `disable_model_invocation`" / "struct … has no field named …"? That is the expected failure. If the tests ran and failed on assertions only, the test file is reaching something that already exists — re-read step 1.
- [ ] Implement steps 1-4 in `src-tauri/src/skills.rs` + the `prompt.rs` test helper
- [ ] Run `cargo test --test skills` — all pass? If not, fix and re-run before continuing.
- [ ] Run `cargo test` from `src-tauri/` — the whole suite green (the only non-test caller is `discover_in_roots`; anything else failing means a struct literal was missed).
- [ ] Run `cargo clippy --all-targets` — zero warnings. If clippy objects to the 4-tuple (it will not by default), do NOT restructure: add nothing and move on.
- [ ] Run `cargo fmt --all -- --check` — clean; otherwise `cargo fmt --all`.
- [ ] Commit: `feat: carry disable-model-invocation on SkillInfo as model-hidden (ADR 0036)`

**Acceptance criteria:**
- [ ] `SkillInfo.disable_model_invocation` exists, is `true` only for the literal `disable-model-invocation: true` at top level, and serializes as `disableModelInvocation`.
- [ ] `SkillInfo::model_visible()` exists and is the only predicate defined for this concept.
- [ ] Discovery is UNFILTERED — `discovery_still_returns_model_hidden_skills` passes.
- [ ] `cargo test`, `cargo clippy --all-targets`, `cargo fmt --all -- --check` all clean.

---

### Task 2: Filter the system prompt's `<skills>` section — and add pi's second guard

**Context:**
`format_skills_for_prompt` (`src-tauri/src/agent/harness/prompt.rs`) is a declared byte-for-byte port of pi's function of the same name, and pi filters INSIDE itself (`const visibleSkills = skills.filter(s => !s.disableModelInvocation)`, returning `""` before it emits the header lines). Filtering in the port keeps the port honest and removes the now-false comment at `prompt.rs:244-247` ("no `disableModelInvocation` field, so no filtering in v1"). There is a second half that is easy to miss and is the one real bug this design prevents: pi guards TWICE (`system-prompt.js:105` `skills.length > 0`, then `:107` `if (skillsPrompt)` on the FILTERED output), while `build_main_prompt` has only the outer guard `!ctx.skills.is_empty()` evaluated BEFORE the filter. Filter inside the formatter without adding the inner guard and an all-hidden Space ships a `<skills>\n\n</skills>` block — violating `build_main_prompt`'s own promise that an omitted section leaves no trace.

**Files:**
- Modify: `src-tauri/src/agent/harness/prompt.rs` (`format_skills_for_prompt` ~line 248; the `<skills>` push inside `build_main_prompt` ~lines 111-130; delete the stale comment ~lines 244-247)
- Test: same file, its `#[cfg(test)] mod tests` (existing numbered comments run 1–16, incl. 2b and 4b; add after `skills_format_matches_pi_golden` ~line 900)

**What to implement:**
1. At the top of `format_skills_for_prompt`:
   ```rust
   let visible: Vec<&SkillInfo> = skills.iter().filter(|s| s.model_visible()).collect();
   if visible.is_empty() {
       // pi: `if (visibleSkills.length === 0) return ""` — BEFORE the
       // header lines, so an all-hidden catalog leaves NO trace.
       return String::new();
   }
   ```
   Then iterate `visible` instead of `skills` for the `<skill>` blocks. The header lines, the `file_read_tool` wording branches, `escape_xml`, and the exact byte layout are otherwise unchanged.
2. In `build_main_prompt`, replace the pre-filter guard with pi's post-filter guard:
   ```rust
   if let Some(tool) = file_read_tool {
       let body = format_skills_for_prompt(ctx.skills, tool);
       if !body.is_empty() {
           sections.push(format!("<skills>\n{body}\n</skills>"));
       }
   }
   ```
   (i.e. drop the `if !ctx.skills.is_empty()` condition; keep the `file_read_tool` preference order `read_skill` → `read` → `bash` exactly as is.) Rewrite the comment block immediately ABOVE that guard (`prompt.rs:107-110`, currently "`<skills>`: only when skills are present AND a skill-loading tool is advertised") to the new condition — "when the FILTERED body is non-empty AND a skill-loading tool is advertised" — keeping its existing note about the `read_skill`/`read`/`bash` fallback and ADR 0030, and cite ADR 0036.
3. Delete the comment block claiming there is no `disableModelInvocation` field and "no filtering in v1"; replace with a pointer to ADR 0036.
4. **Do not** touch `PREAMBLE`, `<rules>`, `<project_context>`, `<cwd>`, `build_child_system_message`, or the load-bearing golden `skills_format_matches_pi_golden`.

**Steps:**
- [ ] Write the two failing tests in `src-tauri/src/agent/harness/prompt.rs`'s test module, using the existing `skill(…)` / `spec(…)` / `scratch()` helpers and the `PromptContext { cwd, agent_dir: Path::new(""), tools, skills }` shape:
  - First extend the helper WITHOUT changing its call sites: add `fn hidden_skill(name: &str, description: &str, path: &str) -> SkillInfo` next to `fn skill(…)`, identical but setting `disable_model_invocation: true`.
  - `the_skills_section_omits_model_hidden_skills` — skills = `[visible "alpha", hidden "omega"]`, tools = `[spec("read_skill", "Load a skill by name.")]`; assert the skills block contains `<name>alpha</name>` and `!prompt.contains("omega")`.
  - `all_model_hidden_skills_omit_the_skills_section_entirely` — build the prompt twice with the SAME cwd and the SAME `tools = [spec("read_skill", "Load a skill by name.")]` (**`tools` MUST carry a skill-loading tool in BOTH builds** — with `tools: &[]` the pre-existing `file_read_tool` guard already suppresses the section and the test passes before any fix): once with `skills: &[hidden_skill("omega", "…", path)]`, once with `skills: &[]`. Assert (a) `!prompt_with_hidden.contains("<skills>")`, (b) the two prompts are **byte-identical** (`assert_eq!`), which is the strongest form of "leaves no trace", and (c) `!prompt_with_hidden.contains("\n\n\n")`.
- [ ] Run `cargo test --lib agent::harness::prompt` from `src-tauri/`
  - Did `the_skills_section_omits_model_hidden_skills` fail because "omega" IS present, and `all_model_hidden…` fail on assertion (a) with a `<skills>` block in the rendered prompt? If the second test passes already, the guard is not doing its job — inspect the pushed section body.
- [ ] Implement steps 1-3
- [ ] Run `cargo test --lib agent::harness::prompt` — all pass, INCLUDING `skills_format_matches_pi_golden`, `main_prompt_full_shape`, `main_prompt_skills_requires_read_or_bash`, `the_skills_instruction_prefers_read_skill`. If the golden fails, the header lines or the byte layout drifted — fix the formatter, not the golden.
- [ ] Run `cargo test` — green.
- [ ] Run `cargo clippy --all-targets` — zero warnings (a `.iter().filter(…).collect::<Vec<_>>()` is fine; if clippy suggests `impl Iterator::collect` alternatives, follow it and re-run).
- [ ] Run `cargo fmt --all -- --check` — clean.
- [ ] Commit: `feat: omit model-hidden skills from the <skills> section, guarded like pi`

**Acceptance criteria:**
- [ ] A model-hidden skill appears nowhere in the prompt.
- [ ] An all-hidden catalog produces NO `<skills>` section, and the prompt is byte-identical to the no-skills-at-all prompt.
- [ ] `skills_format_matches_pi_golden` still passes unmodified.
- [ ] The "no filtering in v1" comment is gone.

---

### Task 3: Enforce it in the two skill tools

**Context:**
`skills_for(ctx)` (`src-tauri/src/agent/tools/exec.rs` ~line 1176) is the single discovery seam for both `list_skills` and `read_skill`; it owns the `ToolCtx::skill_roots` test seam so no test reads the real `~/.agents/skills`. Per ADR 0036: `list_skills` filters on the list (a hidden skill is simply absent), while `read_skill` filters PER HIT — it resolves against the unfiltered set so it can tell the model *why* the name failed ("model-hidden", naming the `$name` route) instead of falsely claiming the skill does not exist. One discovery call per tool call still. Enforcement lands before any `FsBackend` is constructed, so a hidden skill's `SKILL.md` and its bundled files are never read. Keep ADR 0029's path-disclosure rule: the failure names ONLY what the model sent.

**Files:**
- Modify: `src-tauri/src/agent/tools/exec.rs` (`skills_for` ~1176; add `model_skills_for`; `exec_list_skills` ~1192; `exec_read_skill` ~1220; doc comments at ~150-153 (`ToolCtx::skill_roots`), ~1174, ~1183)
- Test: `src-tauri/src/agent/tools/exec.rs`'s `#[cfg(test)] mod tests` (the `── list_skills / read_skill ──` block ~line 2697, which already has `skill_root(tag, name, content)` and `ctx_with_roots(cwd, roots)`)
- Test: `src-tauri/tests/skill_tools_boundary.rs` (the adversarial file — add the no-path-disclosure case here)

**What to implement:**
1. Keep `skills_for` exactly as is (unfiltered, owns the roots seam) and add beside it:
   ```rust
   /// The skills the tools may ADVERTISE (ADR 0036): `skills_for` minus the
   /// model-hidden ones. `read_skill` does NOT use this — it resolves against
   /// `skills_for` so it can distinguish hidden from unknown.
   fn model_skills_for(ctx: &ToolCtx) -> Vec<crate::skills::SkillInfo> {
       skills_for(ctx).into_iter().filter(|s| s.model_visible()).collect()
   }
   ```
2. `exec_list_skills`: take `model_skills_for(ctx)`. Everything else (the `"none"` result for an empty catalog, the `"{name} ({scope}): {description}"` line shape, the newline flattening) unchanged.
3. `exec_read_skill`: immediately AFTER the existing `let Some(skill) = skills.iter().find(…)` (which keeps the unfiltered `skills_for(ctx)` and the existing `unknown skill` message for a genuine miss), insert the hidden branch BEFORE the per-skill `FsBackend` is built:
   ```rust
   if !skill.model_visible() {
       // `${key}` is LOWERCASED on purpose: the `$` Mention token grammar is
       // lowercase-only, so `$DeBuG` expands nothing while `$debug` does.
       return ToolResult::fail(
           format!(
               "read_skill: {name:?} is model-hidden — the Agent may not load it; ask the user to send ${key}"
           ),
           None,
       );
   }
   ```
   `key` is the existing `name.to_lowercase()` used for the case-insensitive lookup — reuse it. Do not add a path, a dir, or a scope to this message.
4. Update the three doc comments to state the split (`list_skills` filters the list; `read_skill` filters per hit, before any read) and keep the ADR 0029 claim that the tools' catalog cannot drift from the prompt's catalog — both seams now filter on the same predicate.
5. **Do not** touch `boundary.rs`, `POLICIED_TOOLS`, the permission gate, `FsBackend`, or the `PathEscape` arm.

**Steps:**
- [ ] Write the four failing tests in `exec.rs`'s skill-tools test block, following that file's existing conventions (`skill_root` writes `<name>/SKILL.md`; `ctx_with_roots(&cwd, &[root])` pins the roots; `execute_tool(&ctx, "list_skills", &json!({}))`; assert via `text_of(&r)` and `r.is_error`):
  - `list_skills_omits_model_hidden_skills` — TWO roots (because `skill_root` makes exactly one skill per root): `let a = skill_root("tag-a", "alpha", "---\nname: alpha\ndescription: D\n---\nA.\n");` and `let o = skill_root("tag-o", "omega", "---\nname: omega\ndescription: D\ndisable-model-invocation: true\n---\nO.\n");`, passed together as `ctx_with_roots(&cwd, &[a, o])` (both map to `SkillScope::Space`, so the `(space)` assertion holds). Assert `text_of(&r) == "alpha (space): D"` and that it contains no `omega`.
  - `list_skills_is_none_when_every_skill_is_model_hidden` — one hidden skill only → `text_of(&r) == "none"` and `!r.is_error` ("an empty catalog is not a failure", matching `list_skills_empty_is_none_not_error`).
  - `read_skill_rejects_a_model_hidden_skill_with_the_mention_route` — `{ "name": "omega" }` → `r.is_error`, and `text_of(&r) == "read_skill: \"omega\" is model-hidden — the Agent may not load it; ask the user to send $omega"` (pin the WHOLE string — this is the model's only instruction about the route). Add a second dispatch with an uppercase frontmatter name (`DeBuG` + the flag, looked up as `debug`) asserting the tail is `send $debug` — the lowercasing rule.
  - `read_skill_rejects_a_model_hidden_skill_before_reading_a_bundled_file` — a hidden skill that BUNDLES `ref.md`; `{ "name": "omega", "path": "ref.md" }` → the same hidden message (NOT the bundled text, and NOT the `resolves outside the skill directory` message). To make "never read" observable rather than asserted-by-message-only, also bundle a sibling-visible check: assert the visible control case (`alpha` + `ref.md`) still returns its body in the same test, so a regression that filters after the read cannot pass.
- [ ] Run `cargo test --lib agent::tools::exec` from `src-tauri/`
  - Did the three `list_skills`/`read_skill` hidden tests fail (omega listed; and `read_skill` returning the body instead of failing)? If `read_skill` fails with "unknown skill", the lookup set is wrong — it must be the UNFILTERED `skills_for`.
- [ ] Implement steps 1-4
- [ ] Run `cargo test --lib agent::tools::exec` — green, and the pre-existing `read_skill_bundled_escape_is_rejected`, `read_skill_unknown_name_is_error_with_the_catalog`, `read_skill_name_is_case_insensitive_and_flattens_nothing` still pass UNMODIFIED (they pin ADR 0029).
- [ ] Add `a_model_hidden_skill_discloses_no_path` to `src-tauri/tests/skill_tools_boundary.rs`, following that file's `Tmp` / `ToolCtx { skill_roots: Some(…), .. }` conventions. **Note: that file's `write_skill(root, name, body)` emits a fixed `---\nname: {name}\n---\n{body}\n` and CANNOT carry the flag** — write the hidden skill's `SKILL.md` directly (`fs::create_dir_all` + `fs::write(dir.join("SKILL.md"), "---\nname: omega\ndisable-model-invocation: true\n---\nB.\n")`) rather than calling `write_skill`, or add a frontmatter-parameterized sibling helper. Then dispatch `{ "name": "omega" }` and assert the failure text contains NO `/` and does NOT contain the skill's directory path (the ADR 0029 disclosure rule restated for the new branch — it names only what the model sent).
- [ ] Run `cargo test --test skill_tools_boundary` — green, all pre-existing adversarial cases (traversal, absolute paths, `..`, NUL, symlink to an outside file, symlink to a sibling skill, dangling symlink, symlinked directory) untouched and passing.
- [ ] Run `cargo test` — green. In particular `the_skill_tools_stay_outside_the_policy_gate` (in `src-tauri/src/agent/harness/loop.rs`, which dispatches `read_skill` with name `nope` under a `Sandboxed` policy) must still see the `unknown skill` branch and no `escapes the session sandbox` text — it is untouched by this change.
- [ ] Run `cargo clippy --all-targets` — zero warnings.
- [ ] Run `cargo fmt --all -- --check` — clean.
- [ ] Commit: `feat: refuse model-hidden skills in the skill tools, naming the $mention route`

**Acceptance criteria:**
- [ ] `list_skills` never lists a model-hidden skill; an all-hidden catalog prints `none`.
- [ ] `read_skill` refuses a hidden name — with `path` or without — before constructing any `FsBackend`, with the exact pinned message and no path in it.
- [ ] A genuine unknown name still gets the pre-existing `unknown skill` message verbatim.
- [ ] The ADR 0029 adversarial suite passes unmodified.

---

### Task 4: Make the `read_skill` tool description honest

**Context:**
`read_skill`'s `ToolSpec.description` (`src-tauri/src/agent/harness/loop.rs` ~1955-1975) tells the model: "the read tool CANNOT reach them — `read` on a skill path always fails with \"path escapes the session sandbox\"". That died with ADR 0030: `boundary::read_roots` grants the Boundary the skill discovery roots, so `read` on a skill path IS in bounds and succeeds in every policy. It is a claim the model acts on — it will skip a `read` that would work — and `ToolSpec.description` is printed verbatim into every session's `<tools>` section (`build_main_prompt` renders `- {name}: {description}`), so it is also the cheapest place to teach the model about model-hidden skills and the `$name` route. No test pins this description today (only `list_agents`' description is pinned — `list_agents_is_in_the_default_tool_specs` is the precedent to copy), and no golden depends on it: `prompt.rs`'s goldens use synthetic `spec(…)` helpers, and `tests/worker_e2e.rs` asserts only tool NAMES inside `<tools>`.

**Files:**
- Modify: `src-tauri/src/agent/harness/loop.rs` — the `"Load a Skill's instructions by NAME…"` description array only (~lines 1955-1975). Do not touch the `parameters` schema, the `list_skills` spec above it, or `tool_specs()`' ordering.
- Test: `src-tauri/src/agent/harness/loop.rs`'s test module (next to `list_agents_is_in_the_default_tool_specs` ~line 4267)

**What to implement:**
Replace the description array's LAST paragraph (the `so the read tool CANNOT reach them …` one) and append the model-hidden sentence, so the final description is exactly these joined lines (`\n`):

```
Load a Skill's instructions by NAME — the sanctioned way to read a skill file.

`name` matches a discovered Skill (see list_skills, or the `<available_skills>` section); no `path` returns that skill's `SKILL.md` body. `path` reads a file BUNDLED with that skill, resolved against the skill's directory — it must stay inside it.

A Skill whose frontmatter sets `disable-model-invocation: true` is model-hidden: it is not advertised and this tool refuses it — ask the user to send $name instead.

Skills live OUTSIDE the session `cwd` (`~/.agents/skills`, `.agents/skills`). The skill tools are the sanctioned route: `read_skill` resolves a NAME against the discovered catalog and confines every read to that skill's own directory.
```

Keep the paragraph structure as the existing `[…].join("\n")` array of `&str` literals (one entry per line / blank line), matching the file's existing style. Say nothing that ADR 0030 contradicts — specifically, do not claim `read` cannot reach a skill path, and do not claim a model-hidden skill is unreadable by any tool (it is not *advertised*; `read` on its path is still in bounds).

**Steps:**
- [ ] Write the failing test `read_skill_description_is_honest_about_read_and_model_hidden` in `src-tauri/src/agent/harness/loop.rs`'s test module, copying the shape of `list_agents_is_in_the_default_tool_specs`: find the `read_skill` spec in `tool_specs()` and `assert_eq!(spec.description, "<the exact text above>")`. Then add two negative guards so the lie cannot come back: `assert!(!spec.description.contains("always fails"))` and `assert!(!spec.description.contains("CANNOT reach"))`.
- [ ] Run `cargo test --lib 'agent::harness::r#loop'` from `src-tauri/` — **the module is declared `pub mod r#loop;` (`loop` is a Rust keyword), so the test path is `agent::harness::r#loop::…`; filtering on `agent::harness::loop` matches 0 tests and exits 0, silently. If the run reports `0 tests`, the filter is wrong.**
  - Did it fail on the `assert_eq!` diff showing the OLD description? If it fails on the negative guards only, the first two paragraphs drifted — compare against the block above.
- [ ] Replace the description in `loop.rs`
- [ ] Run `cargo test --lib 'agent::harness::r#loop'` — green; and `tool_specs_advertise_exactly_the_executor_param_keys` (which pairs every spec with its executor's param keys) still passes.
- [ ] Run `cargo test` — green, `tests/worker_e2e.rs` included (it asserts only that `<tools>` advertises the ENABLED tool names).
- [ ] Run `cargo clippy --all-targets` — zero warnings.
- [ ] Run `cargo fmt --all -- --check` — clean.
- [ ] Commit: `fix: the read_skill description no longer claims read cannot reach a skill (ADR 0036)`

**Acceptance criteria:**
- [ ] The description matches the block above byte-for-byte and is pinned by a test.
- [ ] It contains no claim contradicted by ADR 0030 and no claim of confidentiality.
- [ ] Full Rust suite, clippy, fmt all clean.

---

### Task 5: Tell the user which Skills are model-hidden

**Context:**
Once a Skill is model-hidden it disappears from every surface the Agent sees, so the Skills dialog is the only place a user can learn that the flag took effect — and the dialog's row click is the *sanctioned* route to a hidden Skill (it inserts `$name `, which `expandMentions` expands on send, ADR 0031). So: cross IPC, mark the row, change nothing about what a click does. Copy is `manual only` — terse, matching the existing `global` scope marker in the same slot — because the glossary bans *hidden* and *disabled* in prose. The composer's own `$` picker is deliberately NOT changed: choosing a skill there is already a deliberate act. And the expansion path must provably ignore the flag — that is the guard against a later "make the flag consistent everywhere" change silently removing the only route to a hidden Skill.

**Files:**
- Modify: `src/lib/tauri.ts` — the `SkillInfo` interface (~line 497)
- Modify: `src/components/SkillsDialog.tsx` — the row's marker slot (~lines 87-99, beside the `scope === "user"` → `global` span at ~95)
- Modify (mechanically, driven by `pnpm build`): every typed full `SkillInfo` literal / mock. The known tsc-flagged sites:
  - `src/lib/skills.test.ts` — `makeSkill` (~29)
  - `src/components/SkillsDialog.test.tsx` — `skill` (~10)
  - `src/components/MessageBubble.test.tsx` — `makeSkill` (~15) — that file has NO other `SkillInfo` literal (its ~273-285 uses are `makeSkill({ … })` overrides)
  - `src/hooks/useSkillCatalog.test.ts` — FOUR `satisfies SkillInfo` literals (~18, ~128, ~168, ~202)
  - `src/components/ChatStream.test.tsx` — five `vi.mocked(listSkills)` value sites (~3536, ~3588, ~3821, ~3916, ~5450; the `skill()` factory at ~5435 feeds the last)
  - NOT flagged by tsc and acceptable as-is (untyped `vi.fn().mockResolvedValue` factories — the field stays `undefined`, which is falsy, so no marker renders: the correct conservative default): `src/hooks/useMentionCatalogs.test.ts:25`, `src/components/SpacesList.test.tsx:48`, `src/components/ChatStream.test.tsx:146`. Do not add the field there just for consistency.
- Test: `src/components/SkillsDialog.test.tsx`, `src/lib/skills.test.ts`

**What to implement:**
1. `src/lib/tauri.ts`: add to `SkillInfo`
   ```ts
   /** Frontmatter `disable-model-invocation: true` — the Agent is not shown
    *  this skill at all; `$name` still works (ADR 0036). */
   disableModelInvocation: boolean;
   ```
   Required, not optional — the Rust side always sends it (`#[serde(rename_all = "camelCase")]` on `SkillInfo`).
2. `src/components/SkillsDialog.tsx`: immediately after the `scope === "user"` marker span, inside the same `flex items-center gap-2` div:
   ```tsx
   {skill.disableModelInvocation && (
     <span
       className="text-ui-xs text-foreground-subtlest"
       title={`Not offered to the Agent — send it yourself with $${skill.name.toLowerCase()}`}
     >
       manual only
     </span>
   )}
   ```
   (In a TS template literal `$$` is a literal `$` followed by the interpolation, so this renders `… with $alpha`.) No other change: `filtered`, the row's `role="button"`, `onClick={() => insertSkill(skill.name)}` and the `Enter` key handler stay exactly as they are — a hidden row is still clickable and still lowercases the token through `insertSkill`.
3. The fixture fixups: add `disableModelInvocation: false` to each typed literal `pnpm build` reports (add `true` only where a test is about the marker). Do not restructure any fixture, and do not touch the three untyped factory mocks listed above.
4. **Do not** touch `src/lib/skills.ts` (`expandMentions`, `expandSkillMentions`, `MENTION_RE`, `MentionCatalogs`), `src/components/chat/ComposerMentions.tsx`, `src/components/chat/ComposerRow.tsx`, `src/components/MessageBubble.tsx`, `src/hooks/useSkillCatalog*`, or `src/hooks/useMentionCatalogs*`. The flag changes nothing about expansion or the picker. (`src/components/ChatStream.tsx:786` owns the `archimedes:insert-skill` listener — also untouched.)

**Steps:**
- [ ] Write the failing test in `src/components/SkillsDialog.test.tsx`, following that file's existing render/`fireEvent` conventions: `marks_a_model_hidden_skill_as_manual_only_but_still_inserts_the_mention` — render `<SkillsDialog skills={[skill({ name: "Omega", disableModelInvocation: true, body: "B" })]} onClose={…} />`, assert `await screen.findByText("manual only")` exists, assert the visible skill `global` marker logic is unaffected (a `scope: "space"` hidden row shows `manual only` and NOT `global`), then `fireEvent.click(screen.getByText("Omega"))` and assert the `archimedes:insert-skill` CustomEvent carried `detail === "$omega "` (the listener is registered by the composer subtree in the existing tests — copy the `window.addEventListener("archimedes:insert-skill", …)` capture pattern that `clicking_a_row_dispatches_the_insert_event_and_closes` in THAT SAME FILE already uses (the dialog is rendered standalone — no composer subtree is involved).
- [ ] Write the failing guard test in `src/lib/skills.test.ts`: `expands_a_model_hidden_skill_byte_identically_to_a_model_visible_one` — take the existing best `expandMentions` case, run it with `disableModelInvocation: true` on the matched skill, and `expect(hiddenOut).toBe(visibleOut)` plus `expect(hiddenOut).toContain("<skill name=")`. Extend the existing `$`-oracle parity test (`dollar_expansion_matches_expandSkillMentions`) to include one hidden skill so the byte-identity oracle still covers it.
- [ ] Run `pnpm test src/components/SkillsDialog.test.tsx src/lib/skills.test.ts` from the repo root
  - Did the dialog test fail with "Unable to find an element with the text: manual only" and the skills test fail to compile / or pass vacuously? If the expansion guard PASSES before you change anything, that is expected (expansion already ignores the flag) — its job is to fail LATER if someone wires the flag in; keep it anyway and note it in the commit message.
- [ ] Apply steps 1-2, then run `pnpm build` (tsc)
  - Fix every `Property 'disableModelInvocation' is missing` error by adding `disableModelInvocation: false` to the reported literal. Re-run until tsc is clean. If tsc reports a site that is an **Agent definition** or MCP literal rather than a `SkillInfo`, leave it alone — those types do not carry the flag.
- [ ] Run `pnpm test src/components/SkillsDialog.test.tsx src/lib/skills.test.ts` — green.
- [ ] Run `pnpm test` — whole frontend suite green (the mock fixups must not change any assertion other than adding the field).
- [ ] Run `pnpm build` — clean.
- [ ] Commit: `feat: mark model-hidden skills "manual only" in the Skills dialog`

**Acceptance criteria:**
- [ ] A model-hidden row shows `manual only`, keeps its existing behavior, and still dispatches `archimedes:insert-skill` with the lowercased `$name ` token.
- [ ] `disableModelInvocation` is on the TS `SkillInfo` and every `SkillInfo` literal compiles.
- [ ] A test proves `expandMentions` output is byte-identical for a model-hidden skill, and the `$`-oracle parity test covers one.
- [ ] `pnpm test` and `pnpm build` are clean.

---

### Final verification (after Task 5)

- [ ] From `src-tauri/`: `cargo test` · `cargo clippy --all-targets` (0 warnings) · `cargo fmt --all -- --check`
- [ ] From the repo root: `pnpm test` · `pnpm build`
- [ ] Manual end-to-end, with a real file: add `disable-model-invocation: true` to a scratch skill under `~/.agents/skills/<name>/SKILL.md`, start a NEW session, and confirm (a) the agent's `<skills>` section no longer names it, (b) `list_skills` omits it, (c) `read_skill` on its name answers with the `$name` route, (d) the Skills dialog lists it with `manual only`, and (e) typing `$<name>` in the composer still injects its body and the agent follows it. Then set the flag to `yes` and confirm a NEW session advertises the skill again (the strict-`true` rule).
- [ ] Note for the ship step (the `finish` skill): on merge, fold the durable content into `docs/features/` (or leave ADR 0036 as the durable record) and DELETE `docs/roadmap/model-hidden-skills.md` — history lives in git. Do NOT edit ADR 0029's body or front-matter: this decision supersedes one sentence of it (the `prompt.rs` "no filtering in v1" comment, already removed in Task 2), not the ADR.
