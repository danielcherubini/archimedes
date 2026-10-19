---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/62
done-when: >-
  A user with a same-named Skill in the repo and in the home dir sees the repo
  one win AND sees, in the Skills dialog, that N Skills are hidden with their
  names and paths; a symlinked Skill directory in either root is discovered at
  all; `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`,
  `pnpm test` and `pnpm build` are green from their two roots.
---

# Skill shadowing disclosure + symlinked skill directories — Plan

**Goal:** make Skill **Shadowing** visible instead of silent, and make a symlinked Skill directory discoverable at all.

**Architecture:** Skill discovery (`src-tauri/src/skills.rs`) keeps its root order and its identity rule (NAME, nearest root wins, pi-parity). It gains a second dedupe layer (normalized-byte identity, so a copy is a **Duplicate** and stays silent), and records the genuinely-different losers of a name collision on the winner as `shadowed`, which the Skills dialog renders as one non-clickable report block under the list. `agents.rs` shadows identically and gets the same recorded data through the same shared rule, unrendered.

**Tech Stack:** Rust (Tauri 2, `src-tauri/`), React 19 + TypeScript + vitest (`src/`). No new dependencies.

Reference: ADR 0065 owns the "why"; `CONTEXT.md` defines **Shadowing** / **Duplicate**. Do not re-litigate the identity rule: `read_skill`, `list_skills`, the `<available_skills>` prompt section and `$name` Mention expansion all resolve by name.

---

## Parallelisation

**Verdict:** PARALLEL — 3 waves, one real overlap. `skills.rs` is the choke point: Tasks 1–3 all edit it, so they are strictly serial. Task 4 is `src/`-only, in a separate build graph (`tsc` never compiles Rust), and verified disjoint — `src/lib/tauri.ts` is **hand-written** (no `ts-rs`/`specta`/typegen step exists; `src-tauri/build.rs` runs only `tauri-build`/winres), so Task 4's edit there cannot collide with a Rust task.

- **Wave 1:** Task 1 (`src-tauri/**`) ∥ Task 4 (`src/**`)
- **Wave 2:** Task 2 (edits the `skills.rs` Task 1 edited — gate 1)
- **Wave 3:** Task 3 (consumes `Shadowed<T>` / `normalize_line_endings` — gate 2)

**Two mechanics the disjoint-file argument does NOT cover — both are load-bearing:**

1. **Each wave-1 task runs in its own worktree/branch.** Wave children share one `.git/index`; disjoint *files* do not make concurrent `git add`/`commit` safe. The orchestrator commits each by explicit pathspec.
2. **The wire, not just the compilers, must be safe across the wave boundary.** Task 4's interface declares `shadowed` required while the Rust side does not serialize it until Task 2 merges. Task 4 therefore **also** writes the component defensively (`s.shadowed ?? []`, step 3) — that is what makes wave 1 → wave 2 shippable in either merge order, and it is the same tolerance the repo already documents for a missing `disableModelInvocation` (see `SkillsDialog.test.tsx`'s `legacyRow`, `:195`). Do not resolve this by making the field optional; `tsc` needs it required to find the fixture sites, and the component needs `?? []` to survive a row that lacks it.

---

### Task 1: Discovery follows symlinked Skill directories

**Parallel:** wave 1 — disjoint from Task 4 (`src/**`). Tasks 2 and 3 are later waves because they edit this same file. Run in its own worktree/branch.

**Context:**
`find_skill_files`'s `walk` (`src-tauri/src/skills.rs:236`) decides "is a directory" from `entry.file_type()`, which reports `false` for a symlink. A symlinked Skill **directory** therefore matches neither the directory branch nor the `entry.file_name() != "SKILL.md"` file branch, and is never descended — it is invisible, not shadowed. A symlinked `SKILL.md` **file** already works (the file branch matches on name, then canonicalizes); that asymmetry is what marks the directory case as an oversight. The mirror module `agents.rs:97` accepts links explicitly (`t.is_file() || t.is_symlink()`), and ADR 0020 says the two modules mirror each other.

Symlink farms are how people share one Skill set across machines — `~/.pi/agent/skills/*` entries are commonly links into `~/.agents/skills` — so a user wiring project Skills in by symlink sees them missing entirely. Measured against a scratch fixture while writing this plan: Space root holding `linked -> <home>/skills/real` → **0** discovered; home root → 1; both → 1 (the home one, tagged `user`).

**Measured facts this task must respect** (verified on a real fixture, do not re-derive differently):
- `entry.file_type().is_dir()` → `false` for a link-to-dir. `entry.metadata().is_dir()` → **also `false`** (`DirEntry::metadata` does NOT follow the link on unix). `std::fs::metadata(path).is_dir()` and `path.is_dir()` → **`true`**. Naming `entry.metadata()` here silently no-ops the whole task.
- A link **cycle cannot hang the walk today and still cannot after this change** — the existing `dir_depth < 4` / file-depth `1..=4` bounds already terminate recursion. The visited set prevents **re-walking** a directory reached by two links (duplicate work, duplicate rows), not a hang. Do not describe this as a hang fix, in code or commit message.

**Files:**
- Modify: `src-tauri/src/skills.rs` (`walk`, `find_skill_files`, and its `mod tests`)
- Test: `src-tauri/src/skills.rs` (`mod tests` — the crate's convention is unit tests in the module's own `#[cfg(test)]`, as `agents.rs` does)

**What to implement:**

1. In `walk`, decide directory-ness **through the link** using `std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)` — or equivalently `path.is_dir()`. Keep the `node_modules` prune evaluated on the entry NAME **before** any metadata call.
2. Thread a **separate** depth-aware visited set, `HashMap<PathBuf /*canonical dir*/, u32 /*shallowest depth first seen*/>`, seeded with the canonical path of `root` (depth 0) inside `find_skill_files` (`:226`). Skip a directory only when its canonical path is present **with a stored depth ≤ the current `dir_depth`**; otherwise descend and store the minimum. Rationale to put in the comment: walking a directory at its shallowest depth is strictly more capable (the file-depth `1..=4` bound is measured from the walk root), so a second, deeper visit is pure duplicate work — but blindly skipping a directory that was *first* seen deeper would drop Skills whose only path to root was the deeper link, and make discovery depend on `read_dir` order.
   Do NOT reuse the existing `seen` set: it holds canonical **file** paths and is shared across roots by design (its comment at `:85` is load-bearing).
3. Do NOT change the depth rules themselves — `1..=4` on a `SKILL.md`'s file depth and the `dir_depth < 4` descent guard stay byte-identical. `dir_depth` keeps counting walk steps.
4. Update the two doc comments whose spec this change falsifies: `find_skill_files`'s (`:220-225`, which currently enumerates the walk rules and says nothing about links) and `discover_in_roots`'s `:85-86` ("a symlink in a later root pointing at an earlier root's `SKILL.md` collapses by PATH" — still true, but it is now only one of two link cases).
5. Scope attribution stays **first-wins**. Add no canonical-location attribution and no "a link never wins" rule: a project symlink into `~/.agents/skills` is scanned by the Space root first, so it is tagged `space`, renders without the `global` cue, and prints `(space)` in `list_skills`. Accepted by design (ADR 0065): "scope" means "the root that contributed this entry".

**Accepted risk — record it in the code comment AND hand it to Task 3's ADR amendment.** A symlinked Skill makes `SkillInfo.dir` (which is `fs::canonicalize(parent)`) the link's **target**, and `exec_read_skill` installs that `dir` as its per-skill containment boundary — so `read_skill` on that Skill can reach files outside the project. This is **pre-existing, not introduced here**: measured on today's code, `root/alpha/SKILL.md -> <victim>/secret.txt` already discovers as `name="victim"`, `dir="<victim>"`. The narrow new reach is a link to a *directory* that itself contains a `SKILL.md` at depth 1..4. Do not "fix" it by requiring links to resolve inside the root — that kills the feature. State the trade-off where the change is made.

**Do NOT touch:** `discover_in_roots`'s dedupe logic, `SkillInfo`, `parse_skill_file`, `space_roots`, `user_roots`, `boundary.rs` (`push_roots` already canonicalizes each discovery root, so a linked *root* is already in the read Boundary), or `agents.rs`.

**Steps:**
- [ ] In `skills.rs`'s `mod tests` (`:587`), widen `use super::{is_mentionable_name, is_tag_safe_name};` to `use super::*;` — the file-level `use std::fs;` / `use std::path::{Path, PathBuf};` (`:14-17`) are NOT in scope inside the child module, and the new helpers need `fs` and `PathBuf`. Then add two helpers modelled on `agents.rs:458-472`: `scratch()` (a fresh `std::env::temp_dir().join(format!("archimedes-skills-{}", uuid::Uuid::new_v4()))`, created) and `write_file(path, content)` (creates parents). **Do NOT copy `agents.rs`'s empty-`.git/`-dir step or its comment** — that exists because `discover_agents` runs a context walk that stops at a `.git`; `discover_in_roots` takes its roots as given and never walks up (the upward search lives in `space_roots`, `:159`), so the dir is inert here and its comment would be a false claim. **Do not add `canon()` yet** — it is first used by Task 2, and an unused `fn` is a `dead_code` warning that fails this task's own 0-warning clippy gate on all three OSes. (`uuid` is a main dependency, `Cargo.toml:69`; `tempfile` is a dev-dependency at `:97` and is what `src-tauri/tests/skills.rs` uses — `scratch()` mirrors `agents.rs` deliberately, per ADR 0020's mirror convention. Neither cleans up its scratch; that matches every existing test in both modules.)
- [ ] Write the failing test `a_symlinked_skill_directory_is_discovered`, `#[cfg(unix)]`: `scratch()` as the Space root; a second `scratch()` holding `real/SKILL.md` (`---\nname: real\ndescription: D.\n---\nB.\n`); `std::os::unix::fs::symlink(&real_dir, &root.join("linked"))`; `discover_in_roots(&[(root, SkillScope::Space)])` returns **1** entry with `name == "real"` and `scope == SkillScope::Space`. Assert on `len()`, `name`, `scope` — never a path string (`temp_dir()` is itself a symlinked prefix on macOS).
- [ ] Run `cargo test --lib skills::tests::a_symlinked_skill_directory_is_discovered` from `src-tauri/`.
  - Expected RED: `left: 0`. If it passes, STOP — the premise is wrong and the task must be re-scoped.
- [ ] Write `a_link_cycle_yields_one_entry_and_terminates` (`#[cfg(unix)]`): root contains `loopdir`, and `loopdir/self -> loopdir`; the call must return, and a Skill inside must appear at most once (assert the COUNT, not timing).
- [ ] Write `a_directory_walked_twice_keeps_the_deeper_skills_reachable` (`#[cfg(unix)]`) — the test that pins the depth-aware rule in step 2: a root with two links to the same directory, one at the root level and one nested one step deeper; assert every Skill under it is found exactly once. If you implement step 2 as a plain visited-set skip, this test goes red — that is the point.
- [ ] Write `following_links_does_not_change_plain_nesting`: a root with `alpha/SKILL.md` and `group/beta/SKILL.md`, no links → exactly 2 entries (pin: depth rules untouched).
- [ ] Write `a_link_named_node_modules_is_still_pruned` (`#[cfg(unix)]`): `node_modules -> <dir holding a valid Skill>` → 0 entries.
- [ ] Comment the `#[cfg(unix)]` gates: creating a **directory** symlink on Windows needs privileges CI lacks, so a Windows arm would be vacuous. The `walk` change is platform-neutral code and compiles on all three CI OSes. (The existing `read_skill_rejected_symlink_does_not_disclose_its_target` can be dual-arity because it links a *file*.)
- [ ] Implement steps 1–4.
- [ ] Run `cargo test --lib skills::` from `src-tauri/` — green, including the three pre-existing predicate tests.
- [ ] Run `cargo test` (full suite). `agent/tools/exec/tests/skills.rs` builds roots with `skill_root()` and no links, so it must be unmoved — if it moved, the change is too broad.
- [ ] Run `cargo clippy --all-targets` from `src-tauri/` — **0 warnings** (this is the gate that catches a prematurely-added `canon()`).
- [ ] Run `cargo fmt` then `cargo fmt --check`.
- [ ] Commit: `fix(skills): discover symlinked skill directories`

**Acceptance criteria:**
- [ ] A symlinked Skill directory yields one `SkillInfo`; before, zero.
- [ ] A link cycle returns with ≤1 row per Skill.
- [ ] Two links to one directory at different depths still find every Skill under it exactly once.
- [ ] Depth bounds and the `node_modules` prune unchanged (proven by the nesting and prune tests).
- [ ] Attribution still first-wins.

---

### Task 2: Record the shadow — `Shadowed<T>`, byte-identity dedupe, validate-then-dedupe order

**Parallel:** none — edits the `src-tauri/src/skills.rs` Task 1 just edited (gate 1). Wave 2.

**Context:**
`discover_in_roots` drops a name collision silently: `if by_name.contains_key(&key) { continue; }` at `:112` (its "First-wins across the whole run" comment sits at `:108-110` and must move with it). The precedence is correct and pi-parity (pi adds project resources before user ones, `package-manager.js:2036-2064`, and is first-wins on its `skillMap`, `core/skills.js:321,349`). What pi does and we do not is **record the collision naming winner and loser paths**. So a user whose global `discuss` is replaced by the repo's cannot learn it, and the only story the evidence supports is "project wins".

ADR 0065 fixes the shape: the losers ride on the **winner** as `shadowed` (additive — every existing `SkillInfo` consumer keeps compiling), stay unaddressable, and the dialog renders them. Three rules here are traps that must not be "simplified":

- **Compare normalized whole-file content, never the stored `body`.** `body` is frontmatter-stripped and trimmed, so body-comparison would call two Skills duplicates when they differ **only in frontmatter** — including a model-visible winner and a model-hidden loser with an identical body, i.e. a real shadow swallowed. Raw (un-normalized) bytes would report a CRLF-vs-LF copy as a shadow.
- **Record only after the validity checks, and note which check actually moved.** Verified line-by-line: exactly **one** rejection runs after the dedupe — `if !is_tag_safe_name(&path) || !is_tag_safe_name(&dir) { continue; }` at `:126`. Everything else (unparseable frontmatter, `description` over 1024, unsafe `name`) is inside `parse_skill_file`, which returns `None` and is called at `:104`, i.e. **before** the dedupe already. So the reorder is precisely: move the name-dedupe check below the tag-safety guard. Do not claim the description cap is reorder evidence — it passes either way.
- **A user-scoped loser can lose to a user-scoped winner.** `user_roots()` returns TWO roots, both tagged `User` (`~/.agents/skills`, then `~/.pi/agent/skills`), and each Space level contributes two roots too (`.agents/skills`, then `.pi/skills`). So "shadowed ⇒ shadowed by a project skill" is FALSE, and the dialog wording in Task 4 must derive from the winner's scope, not the loser's.

**Files:**
- Modify: `src-tauri/src/skills.rs` (`Shadowed<T>`, `normalize_line_endings`, `SkillInfo.shadowed`, `discover_in_roots`, `parse_skill_file` calling the shared normalizer, `mod tests`)
- Modify: `src-tauri/src/agent/harness/prompt.rs` — **one** literal: `fn skill` (`:329-338`) gains `shadowed: Vec::new()`. `fn hidden_skill` (`:343-348`) is `SkillInfo { disable_model_invocation: true, ..skill(..) }` and inherits the field; **verify, do not add** (adding it invites a later agent to drop the spread).
- Test: `src-tauri/src/skills.rs` (`mod tests`) + `src-tauri/src/agent/tools/exec/tests/skills.rs` (extend the existing drift pin)

**What to implement:**

1. In `skills.rs`:
   ```rust
   /// One Skill (or Agent definition) excluded by **Shadowing**: another root
   /// contributed the same name first and this file is genuinely different.
   /// Generic over the scope enum because `skills.rs` and `agents.rs` share the
   /// rule with different tags — the shape `boundary::push_roots<T>` uses.
   /// ADR 0065. UI-only: never interpolated into a prompt tag.
   #[derive(Debug, Clone, Serialize)]
   #[serde(rename_all = "camelCase")]
   pub struct Shadowed<T> {
       pub name: String,
       /// Canonical path to the shadowed `SKILL.md`.
       pub path: String,
       pub scope: T,
   }
   ```
   Derive no `PartialEq` (the tests compare fields, not whole structs).
2. `pub(crate) fn normalize_line_endings(s: &str) -> String` = `s.replace("\r\n", "\n").replace('\r', "\n")`, and **refactor `parse_skill_file` step 1 to call it** so the rule has one owner (behaviour-neutral; the existing frontmatter tests are the pin).
3. `SkillInfo` gains `pub shadowed: Vec<Shadowed<SkillScope>>` (serializes as `shadowed`; doc-comment naming ADR 0065 + "UI-only").
4. In `discover_in_roots`, keep a run-local `HashMap<String /*lowercased name*/, String /*normalized content*/>` alongside `by_name` (both dropped on return). After a candidate passes `parse_skill_file` **and** the `path`/`dir` tag-safety guard:
   - key taken && stored content equals this candidate's normalized content → **silent Duplicate**, `continue`, no `shadowed` push (`CONTEXT.md`: a Duplicate is not a shadow);
   - key taken && content differs → push `Shadowed { name, path, scope }` onto the winner in `by_name`, then `continue`;
   - else insert as today and record the normalized content.
5. Keep `Vec<SkillInfo>` output and the `sort_by_cached_key(|s| (s.name.to_lowercase(), s.path.clone()))` as-is. `shadowed` within a winner needs no sort — losers append in root-precedence order by construction.
6. **Do NOT** change `list_skills`'s output text, `format_skills_for_prompt`, `tool_specs.rs`, `read_skill` resolution, or `src/lib/skills.ts` expansion. The advertised name sets stay byte-identical.
7. Do NOT touch `AgentDefinitionDto` (Task 3 explains why).

**Steps:**
- [ ] Write the failing tests in `skills.rs`'s `mod tests` (reuse Task 1's `scratch()`/`write_file()`; **now** add the `canon()` helper, modelled on `agents.rs:476-478`):
  1. `a_byte_identical_copy_across_roots_is_silent` — same bytes in a Space and a User root → `len() == 1`, `shadowed.is_empty()`.
  2. `a_crlf_copy_across_roots_is_silent` — winner LF, loser CRLF, else identical → `shadowed.is_empty()`.
  3. `same_body_with_a_different_disable_model_invocation_is_a_shadow` — identical body, winner visible / loser `disable-model-invocation: true` → `shadowed.len() == 1`. Goes red if the comparison uses `body`.
  4. `a_different_file_with_the_same_name_records_the_loser` — Space `description: space version`, User `description: user version` → `len() == 1`, winner `scope == Space`, `shadowed[0].name == <name>`, `shadowed[0].scope == SkillScope::User`, `shadowed[0].path` canonicalizes to the loser's `SKILL.md` (compare with `canon`).
  5. `a_user_skill_shadowed_by_another_user_root_is_recorded_with_a_user_winner` — two **User** roots, same name, different bytes → `len() == 1` and `shadowed[0].scope == SkillScope::User`. This is the case Task 4's wording depends on.
  6. `a_loser_with_an_unsafe_directory_name_is_not_reported` — the loser's `SKILL.md` sits in a directory whose name contains a `"`. Gate it `#[cfg(unix)]` and, on Windows, delegate to the established pattern in `src-tauri/tests/skills.rs:200-208` (`#[cfg(windows)] fn assert_quote_component_is_unconstructible`, which asserts NTFS refuses the name — the skip is unreachable-by-construction there, and the RULE stays pinned on Windows via the frontmatter route). Expect `len() == 1`, `shadowed.is_empty()`. **This is the only test that exercises the reorder.**
  7. `a_loser_over_the_description_limit_is_not_reported` — 1025-char description → `len() == 1`, `shadowed.is_empty()`; comment it as a parse-time rejection that passes either side of the reorder (kept so a future move of the cap into the loop is caught).
  8. `several_losers_from_several_roots_all_land_on_the_winner` — three roots, same name, different bytes → `len() == 1`, `shadowed.len() == 2`, in root order.
- [ ] Run `cargo test --lib skills::tests::` from `src-tauri/`.
  - Expected RED: compile error (`unknown Shadowed` / `no field shadowed`). If any new test PASSES pre-implementation, stop — it pins nothing.
- [ ] Implement steps 1–5.
- [ ] Add `shadowed: Vec::new()` to `fn skill` in `prompt.rs`; leave `hidden_skill`'s spread alone.
- [ ] In `src-tauri/src/agent/tools/exec/tests/skills.rs`, extend the existing anti-drift pin `the_prompt_catalog_and_the_list_skills_catalog_agree` (`:169`) with one same-named Space+User pair differing in bytes. **Two assertions in that pin encode the old fixture size and must be updated in the same edit**: `assert_eq!(skills.len(), 4)` (`:223-226`) and the `visible` BTreeSet literal `["alpha", "beta"]` (`:262`). Add the shadowed name to neither (it must stay unadvertised); bump the count. Then confirm the anti-drift equality (`prompt_names == tool_names`) and the "exactly the model-visible set" assertion still hold. Prefer extending this pin over writing a parallel one — it exists precisely to make catalog drift a test failure.
- [ ] Run `cargo test` (full suite) — green, every pre-existing `list_skills`/prompt assertion byte-identical.
- [ ] Run `cargo clippy --all-targets` — **0 warnings**.
- [ ] Run `cargo fmt` then `cargo fmt --check`.
- [ ] Commit: `feat(skills): report shadowed skills on the winning entry`

**Acceptance criteria:**
- [ ] A genuine collision yields one entry whose `shadowed` names each loser with canonical path + scope; winner and its scope unchanged.
- [ ] Byte-identical and CRLF-only copies collapse with an empty `shadowed`.
- [ ] Same body + different frontmatter is reported as a shadow.
- [ ] A loser failing the tag-safety guard is not reported; the description-cap test documents itself as parse-time.
- [ ] A User-over-User shadow records a `user` loser.
- [ ] `list_skills` text and the `<available_skills>` section unchanged.

---

### Task 3: Agent definitions record the same report, and ADR 0065 gets corrected

**Parallel:** none — consumes `skills::Shadowed<T>` / `skills::normalize_line_endings` (Task 2) and edits `agents.rs`. Wave 3.

**Context:**
`agents.rs` shadows identically and silently — `if by_name.contains_key(&key) { continue; }` (`:126`), pinned by `first_wins_dedupe_space_shadows_user` (`:613`); ADR 0023 already documents that a Space definition shadows a user one of the same name. The user asked for the reporting code to be unified now, so the rule has one owner even though only one surface renders it.

Why the agent side is **computed but not rendered**: the only list is Settings → Subagents → `list_agent_definitions()` → `discover_agents(None)`, which is **user-level roots only**, and the Settings page is app-global with no active Space to pass as `cwd` — it structurally cannot see a Space-shadows-user collision. The surface is a follow-up: a per-Space **Agents** button + popup modelled on the Skills dialog, at which the same block moves over unchanged.

Also here: ADR 0065's consequences currently claim the agent-side report "**is carried on `AgentDefinitionDto`**". This plan deliberately does **not** put it on that DTO — the DTO documents that it excludes fields the UI doesn't need **including `path`**, which the report would re-introduce. Fix the ADR so the doc and the code agree, in this commit.

**Files:**
- Modify: `src-tauri/src/agents.rs` (`AgentDefinition.shadowed`, `discover_in_roots`, the existing shadow test)
- Modify: `src-tauri/src/commands/agents.rs` — **only** the `fn full_definition()` test literal (`:84-95`, the struct literal itself starts at `:85`) gains `shadowed: Vec::new()`. The DTO struct and `impl From<AgentDefinition> for AgentDefinitionDto` (`:24-32`, field-by-field) stay untouched. Skipping this file fails the build with `E0063: missing field shadowed in initializer`, and `#[serde(skip)]` / making the field optional are both wrong.
- Modify: `docs/decisions/0065-a-shadowed-skill-is-a-report-not-an-entry.md`
- Test: `src-tauri/src/agents.rs` (`mod tests`)

**What to implement:**

1. `AgentDefinition` gains `pub shadowed: Vec<crate::skills::Shadowed<AgentScope>>` (`agents.rs` already imports `crate::skills::home_dir`, so the seam exists and there is no module cycle). Reuse `crate::skills::normalize_line_endings` — add no second copy of the normalization rule.
2. Apply Task 2's three-way rule (silent Duplicate / shadow-and-record / insert) in `agents.rs::discover_in_roots`, with the same normalized-content side map keyed by lowercased name. `agents.rs` has no tag-safety skip (its `path` is never interpolated unescaped), so there is no reorder here — only the byte layer and the recording.
3. Leave `AgentDefinitionDto`, `list_agent_definitions` and `list_agent_definitions_for_space` unchanged.
4. Leave the `@`-mention picker, `is_mentionable_name` filtering and `agentName` dispatch unchanged.
5. Amend ADR 0065 in this commit, two bullets, no renumbering:
   - the consequences bullet that says the agent report is carried on `AgentDefinitionDto` → say it is computed on `AgentDefinition` and **not** carried on the DTO, because the DTO excludes `path` deliberately;
   - the "recorded after the validity checks" bullet currently lists three post-dedupe rejections; only the `path`/`dir` tag-safety guard runs after the dedupe — the unparseable name and the 1024-char cap are inside `parse_skill_file`, which runs before it. Correct it to say the reorder moved the dedupe below the tag-safety guard.

**Steps:**
- [ ] Extend `first_wins_dedupe_space_shadows_user` (`src-tauri/src/agents.rs:613`): keep `out.len() == 1` and `description == "space version"`, add `out[0].shadowed.len() == 1` and `out[0].shadowed[0].scope == AgentScope::User`.
- [ ] Add `identical_agent_files_across_roots_are_silent` (same bytes both roots → `shadowed.is_empty()`) and `a_shadowed_agent_names_its_loser_path` (differing bytes → `shadowed[0].path` canonicalizes to the loser's `.md`, using the module's existing `canon()`).
- [ ] Run `cargo test --lib agents::tests::` from `src-tauri/`.
  - Expected RED: `no field shadowed`. The pre-existing assertions in the shadow test must still hold unchanged — `len() == 1` and the space description ARE ADR 0065.
- [ ] Implement steps 1–2, add `shadowed: Vec::new()` to `full_definition()` in `commands/agents.rs`, and make the two ADR edits.
- [ ] Run `cargo test` (full suite) — green.
- [ ] Run `cargo clippy --all-targets` — **0 warnings**.
- [ ] Run `cargo fmt` then `cargo fmt --check`.
- [ ] Commit: `feat(agents): record shadowed agent definitions with the shared rule`

**Acceptance criteria:**
- [ ] `AgentDefinition::shadowed` is populated by the same rule as the Skill one, with no duplicated normalization.
- [ ] `first_wins_dedupe_space_shadows_user` keeps every prior assertion and gains one.
- [ ] `AgentDefinitionDto` and both agent commands unchanged; `commands/agents.rs` compiles via the test literal only.
- [ ] ADR 0065 matches the code on both corrected points.

---

### Task 4: The Skills dialog reports what is hidden

**Parallel:** wave 1 — `src/**` only; no Rust task touches it, separate build graph, separate verify commands, no lockfile change. Reads the wire shape from this plan (`shadowed`, items `{ name, path, scope }`), so it neither imports nor needs Task 2's code. Run in its own worktree/branch, and ship the `?? []` guard so merge order cannot break the app.

**Context:**
Discovery will hand the client, on each winning `SkillInfo`, the entries it shadowed. The dialog is the one surface that sees the **merged** set (`SpacesList` passes `useSkillCatalog(activeSpacePath)` into `SkillsDialog`), so that is where the fact becomes visible.

Two constraints decide the rendering:
- A shadowed entry has **no `$` route and no tool route in this Space**, so it must not be a row. A row's `onClick` calls `insertSkill(skill.name)` → dispatches `archimedes:insert-skill` with `$<name> `, which resolves to the **winner**. A row for the loser is a button that loads a different file than the one you are reading — the bug being fixed. So: non-clickable block, and the winner stays the only row.
- It renders **only when a shadow exists**, so a clean install's DOM is unchanged.

**Wording must be derived from the winner's scope, not the loser's.** Measured against `space_roots`/`user_roots`: each Space level contributes two roots (`.agents/skills`, then `.pi/skills`) and `user_roots()` returns two User roots — so a `user` loser can lose to a `user` winner (`~/.pi` → `~/.agents`), and a `space` loser can lose to a same-level `space` winner in the other vendor directory. Phrases like "hidden by a project skill" keyed on the loser's scope are therefore **false** in shipped configurations, including the symlink farm this feature exists to serve.

**Files:**
- Modify: `src/lib/tauri.ts` (`ShadowedSkill` + required `shadowed` on `SkillInfo`)
- Modify: `src/components/SkillsDialog.tsx` (report block, filtered by `query`)
- Test: `src/components/SkillsDialog.test.tsx`
- Modify (mechanical, required by `tsc`): `src/lib/skills.test.ts`, `src/components/MessageBubble.test.tsx`, `src/hooks/useSkillCatalog.test.ts`, `src/components/ChatStream.test.tsx`
- Modify (NOT found by `tsc`): `src/components/SpacesList.test.tsx`, `src/hooks/useMentionCatalogs.test.ts`

**What to implement:**

1. In `src/lib/tauri.ts`, above `SkillInfo` (`:627`):
   ```ts
   /** One Skill excluded by **shadowing** (camelCase over IPC — Rust `skills::Shadowed`).
    *  It has NO `$` mention route and no `read_skill` route in this Space: another
    *  root contributed the same name first, and name is a Skill's identity (ADR 0065).
    *  Rendered as a report, never as a row. */
   export interface ShadowedSkill {
     name: string;
     /** Canonical path to the shadowed SKILL.md. */
     path: string;
     scope: "space" | "user";
   }
   ```
   Add `shadowed: ShadowedSkill[];` — **required**, not optional (Rust always serializes the `Vec`, empty as `[]`), with a doc line naming ADR 0065 and "UI-only, never sent to the model".
2. Do NOT add `shadowed` to `AgentDefinitionDto` (`:611`) — Rust does not send it (Task 3).
3. In `src/components/SkillsDialog.tsx`, build the report as a **sibling of the existing three-branch ternary** (empty / no-match / rows), NOT inside the rows branch, and gate it on its own non-empty condition so it cannot render in the two empty states:
   - `const shadows = skills.flatMap((s) => s.shadowed ?? [])` — the `?? []` is required, not defensive noise: the file already tolerates a row that genuinely lacks a field over IPC (see `legacyRow`, `SkillsDialog.test.tsx:195`), and a bare `flatMap` over such a row yields `undefined` entries that throw on the first property access. Comment it as that same tolerance.
   - Filter by the **same** case-insensitive name substring the rows use, so the block cannot contradict the list above it.
   - Find each loser's winner by lowercased-name equality against `skills` (a loser's `name` is by construction equal to its winner's — the dedupe key — so the lookup always resolves for data Rust emits), and **group by the winner's scope**:
     - winner `space` → `1 skill is hidden by a project skill with the same name` / `N skills are hidden by a project skill with the same name`
     - winner `user` → `… hidden by a global skill with the same name`
   - One line per loser: its `name` and its `path`. A `user` loser may legitimately be labeled `global` on its line if you show the loser's scope — the CAUSE clause is what must come from the winner.
   - Render with plain `<div>`/`<p>`/`<span>`: **no** `role="button"`, `tabIndex`, `onClick`, or `hover:bg-surface-hover`. Reuse existing tokens only (`text-ui-sm`, `text-ui-xs`, `text-foreground-subtlest`); no new CSS, and do not add class tokens a `themeTokens` census might have to account for.
4. Mechanical fixtures — both classes, because `tsc` finds only one:
   - **Found by `tsc`** (verified: adding the required field yields 22 errors across exactly these 5 files): `SkillsDialog.test.tsx`, `skills.test.ts`, `MessageBubble.test.tsx`, `useSkillCatalog.test.ts`, `ChatStream.test.tsx`. Add `shadowed: []` in the `Partial<SkillInfo>` helpers (`SkillsDialog.test.tsx:10`, `skills.test.ts:30`, `MessageBubble.test.tsx:15`) and in every full literal, including the `const skill = (name: string) => ({…})` factory at `ChatStream.test.tsx:5682`.
     - One special case: `SkillsDialog.test.tsx:195` `const legacyRow: Omit<SkillInfo, "disableModelInvocation">` — `tsc` DOES error there, and `shadowed: []` must be ADDED to that literal while leaving the `Omit` keyed on `"disableModelInvocation"` alone (that omission is the test's subject; widening it or making the field optional defeats it).
   - **NOT found by `tsc`** (verified: untyped `vi.fn().mockResolvedValue([...])` factories are not contextually typed, so they compile clean and fail at runtime): grep for `listSkills: vi.fn()` / `mockResolvedValue` returning skill rows and add `shadowed: []` — the grep must catch every `listSkills: vi.fn().mockResolvedValue([...])` site — there are five known: `SpacesList.test.tsx:65`, `useMentionCatalogs.test.ts:25`, `useSkillCatalog.test.ts:10`, `ChatStream.test.tsx:188` (NB: `tsc` DOES flag `ChatStream.test.tsx` elsewhere at `:5682`, so fixing that and getting a green build still leaves `:188` broken at runtime), and `App.test.tsx:38` (resolves `[]`, so no change — confirm it). Do this step regardless of what `pnpm build` reports.
5. Do NOT touch `expandMentions` / `expandSkillMentions` / `isMentionableSkillName` / `useSkillCatalog` / `useMentionCatalogs` / the `$` picker in `ChatStream.tsx`. No shadow annotation in the picker.

**Steps:**
- [ ] Add `ShadowedSkill` and the required `shadowed` field to `SkillInfo` in `src/lib/tauri.ts`.
- [ ] Write the failing tests in `src/components/SkillsDialog.test.tsx` (extend `skill()` with `shadowed: []`):
  1. `renders_no_shadow_report_when_nothing_is_shadowed` — plain skills → `queryByText(/hidden by/)` is `null`. This is the "clean install looks identical" pin; it should pass before implementation, and that is correct.
  2. `reports_a_skill_shadowed_by_a_project_skill_with_its_path` — a `space` winner carrying a `user` loser → "is hidden by a project skill", plus the loser's `name` and `path`.
  3. `pluralises_the_shadow_count` — two losers → `2 skills are hidden`.
  4. `a_shadow_whose_winner_is_a_global_skill_says_global` — winner `scope: "user"` → wording says `global`, and NOT `project`. This is the case the loser-keyed wording got wrong.
  5. `the_shadow_report_is_not_clickable` — register a real `window.addEventListener("archimedes:insert-skill", …)` listener exactly as `clicking_a_row_dispatches_the_insert_event_and_closes` does (`:66`), `fireEvent.click` the loser's line, assert no event fired and `onClose` was not called. (There is no `addEventListener` spy helper in this file — copy the existing pattern.)
  6. `the_search_query_filters_the_shadow_report` — needs **two** winner+shadow pairs (`alpha` with a shadow, `beta` with a shadow), because a loser's `name` always equals its winner's: typing `alpha` keeps alpha's line and drops beta's. A fixture with an "unrelated" loser name is a shape Task 2 can never emit — do not build one.
  7. `an_empty_catalog_renders_no_shadow_report` and `the_no_match_state_renders_no_shadow_report` (query matching nothing).
  8. `a_row_without_the_shadowed_key_does_not_crash_the_dialog` — render the existing `legacyRow`-style object WITHOUT `shadowed` and assert the rows still render (this is the `?? []` pin).
- [ ] Run `pnpm test src/components/SkillsDialog.test.tsx` from the repo root.
  - Expected RED: the new shadow tests (no `hidden by` text), and test 8 crashing on `undefined`. Test 1 passing pre-implementation is correct.
- [ ] Implement steps 3–4 (including the grep for untyped mocks).
- [ ] Run `pnpm build` — `tsc` will list the full-literal sites. Fix each by adding the field. If making the field optional looks easier, that is the wrong fix.
  - Ends with 0 errors and a successful `vite build`?
- [ ] Run `pnpm test` (full frontend suite) — `skills.test.ts`, `useSkillCatalog.test.ts`, `MessageBubble.test.tsx`, `ChatStream.test.tsx`, `SpacesList.test.tsx`, `useMentionCatalogs.test.ts` green with fixture additions only.
- [ ] Commit: `feat(skills): show which skills are hidden by a skill with the same name`

**Acceptance criteria:**
- [ ] No shadows → nothing new in the DOM (both empty states included).
- [ ] Shadows → one non-clickable block; count + names + paths; the "hidden by a project/global skill" clause comes from the winner's scope.
- [ ] The block respects the search query, and only for shapes discovery can emit.
- [ ] A row lacking `shadowed` over IPC renders without throwing.
- [ ] `pnpm build` is clean with `shadowed` required.

---

## Out of scope (do not "improve" in passing)

- Reordering roots or making the user root win — nearest-root precedence is pi-parity, ADR 0065.
- Any change to `prompt.rs` output, `tool_specs.rs` descriptions, `read_skill`'s resolution, or `$`/`@`/`#` mention expansion.
- Making a shadowed Skill addressable (scope-qualified name, a `path`/`dir` param on `read_skill`).
- Annotating the `$` picker, or annotating the winning row as the primary surface.
- The per-Space **Agents** button + popup that will render the agent-side report — follow-up, in ADR 0065's consequences.
- Making Settings → Subagents Space-aware.
- Constraining symlink targets to stay inside the root (kills the feature); closing the pre-existing `dir`-as-boundary reach in `read_skill`.
- Writing to any skill directory (ADR 0013: reader, never a writer); precedence toggles; content-hash caching.

## Final verification (all five, from the right root)

From the repo root: `pnpm test`, `pnpm build`.
From `src-tauri/`: `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`.

Manual check that started this: put a `discuss/SKILL.md` in a Space's `.agents/skills/` differing in content from `~/.agents/skills/discuss/SKILL.md`; open the Skills dialog; confirm the repo Skill is listed and the block says one skill is hidden by a project skill, naming `/…/.agents/skills/discuss/SKILL.md`. Then symlink a Skill directory into a project's `.agents/skills/` and confirm it appears. Finally, put a same-named pair in `~/.agents/skills/` and `~/.pi/agent/skills/` and confirm the wording says **global**, not project.
