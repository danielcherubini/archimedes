---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/62
done-when: >-
  A user with a same-named Skill in the repo and in the home dir sees the repo
  one win AND sees, in the Skills dialog, that N global Skills are hidden with
  their names and paths; a symlinked Skill directory in either root is
  discovered at all; `cargo test`, `cargo clippy --all-targets` (0 warnings),
  `cargo fmt --check`, `pnpm test` and `pnpm build` are green from their two
  roots.
---

# Skill shadowing disclosure + symlinked skill directories

## Problem

A user reports that with Skills in the project directory **and** Skills in the
home directory, "the project directory wins", and asks that the two sources
concat.

Reading the code, discovery **already concats** every differently-named Skill:
`discover_skills` (`src-tauri/src/skills.rs`) builds one root list — Space roots
(innermost level first, `.agents/skills` then `.pi/skills` at each level, up to
the repo root) followed by the user roots — and `discover_in_roots` walks all of
them. What it drops is an exact case-insensitive **name** collision: the first
root wins and the loser is discarded with no diagnostic anywhere (`skills.rs`,
the `by_name.contains_key(&key)` early-continue).

Two distinct defects follow from that reading, and both are in scope.

1. **A shadow is silent.** The precedence itself is correct and is pi-parity
   (pi adds project resources before user ones in
   `dist/core/package-manager.js:2036-2064`, and `loadSkills` is first-wins on
   its `skillMap`, `dist/core/skills.js:321,349`). What pi does and we do not is
   **record a collision diagnostic naming the winner and the loser paths**. A
   user whose global `discuss` is being replaced by the repo's has no way to
   learn that, so the only story the evidence supports is "project wins".
2. **A symlinked Skill directory is never discovered at all.** `walk` decides
   "is a directory" from `entry.file_type()`, which reports `false` for a
   symlink, so a symlinked skill dir matches neither the directory branch nor
   the `SKILL.md` file branch — it is invisible, not shadowed. A symlinked
   `SKILL.md` *file* already works (the file branch matches on name, then
   canonicalizes), which is what marks this as an oversight rather than a rule.
   The mirror module `agents.rs` does accept links explicitly
   (`entry.file_type().is_file() || t.is_symlink()`), and ADR 0020 says the two
   modules mirror each other.

   Verified against a scratch fixture before writing this: a Space root holding
   `linked -> …/home/skills/real` discovered **0**; the home root discovered 1;
   both roots together discovered 1 (the home one). Symlink farms are how people
   share one Skill set across machines — this very machine's `~/.pi/agent/skills`
   holds a symlink into `~/.agents/skills` — so a user wiring project Skills in
   by symlink sees them missing entirely.

## Design

### 1. Ordering and identity do not change

Root order stays exactly as it is, so **the nearest root wins**: any Space level
before any user level, an inner project level before an outer one, and
`.agents/skills` before `.pi/skills` within a level. **Name stays a Skill's
identity.** See ADR 0065 for why this is not open for reconsideration here:
`read_skill`, `list_skills`, the `<available_skills>` prompt section and `$name`
Mention expansion all resolve by name, so a second entry under one name is a
Skill the Agent cannot address.

### 2. Three layers of dedupe

| Layer | Status | Catches |
| --- | --- | --- |
| canonical **path** | exists — `walk`'s `seen` set, shared across roots | the same file reached twice; a symlink farm |
| **normalized bytes** | new | a byte-identical `SKILL.md` copied into two roots |
| **name** | exists | a genuine collision → now *reported*, not only dropped |

The byte check exists because a copy is not a path duplicate: the same file
committed into both `~/.agents/skills/discuss/` and `.agents/skills/discuss/` is
two inodes, so today it collides by name and would be reported as a shadow. A
shadow warning about a Skill whose contents are the ones already listed is pure
noise, so identical content collapses silently. The comparison is on **the
normalized whole file** (`content.replace("\r\n","\n").replace('\r',"\n")`, the
same normalization `parse_skill_file` applies), held in a run-local
`HashMap<name-key, normalized-content>` alongside `by_name` and dropped before
returning.

Two traps this closes, both load-bearing:

- Comparing the stored `body` instead would treat two Skills as duplicates when
  they differ **only in frontmatter** — including the case where the winner is
  model-visible and the loser is model-hidden with an identical body. That is a
  real shadow being swallowed.
- Comparing raw bytes would report a **CRLF vs LF** copy of the same file as a
  shadow, on the platform where line endings differ by checkout config.

### 3. `walk` follows symlinked directories

Determine directory-ness through the link (`path.metadata()`, which follows
symlinks) instead of `entry.file_type()`, keeping the existing `node_modules`
prune and the existing `1..=4` file-depth bound unchanged. Add a visited set of
**canonical directory paths** threaded through the walk: descending links is what
makes `a -> a/sub` reachable, which today is impossible.

State the guard's purpose accurately: the existing depth cap already terminates
recursion, so a link cycle cannot hang the walk today and will not be able to
after this change either. The guard prevents **re-walking** a directory reached
by two links (work and duplicate rows), not a hang.

Scope attribution stays **first-wins**: a project symlink pointing into
`~/.agents/skills` is scanned by the Space root first, so it is tagged `space`
and renders without the dialog's `global` cue and prints `(space)` in
`list_skills`. That is accepted deliberately — "scope" means "the root that
contributed this entry", and the project is what pulled the Skill in. (The
alternative, attributing by canonical location, would need a second canonical
comparison per entry for a cosmetic cue.)

### 4. The report crosses IPC on the winner

`SkillInfo` gains `shadowed: Vec<ShadowedSkill>`, where `ShadowedSkill` is
`{ name, path, scope }` — the loser's frontmatter name, its canonical `SKILL.md`
path, and its scope tag. Serialized `camelCase` like the rest of the struct.

Attach-to-winner rather than a `{ skills, collisions }` envelope or a second
command, because it is additive: `useSkillCatalog`'s cached `SkillInfo[]`,
`ChatStream`'s `$` picker and every existing consumer keep compiling untouched.
Storage is per-winner, **rendering is aggregated** by the dialog.

`AgentDefinition` / `AgentDefinitionDto` gain the same field, computed by the
same helper.

**Recording order is load-bearing.** In `discover_in_roots` the name-dedupe
check currently runs *before* the tag-safety checks on `path`/`dir`, and a
loser can also be dropped later for an unparseable name or a `description` over
1024 chars. So the collision must be recorded only for a loser that would
otherwise have been **kept** — i.e. after those checks. Otherwise we report
"hidden" for a Skill that was never eligible to be listed, and we surface a path
discovery deliberately refuses to surface. Restructure the loop so a candidate is
fully validated, then byte-compared, then name-deduped-with-report.

The report is UI-only data: it is never interpolated into any prompt tag, so no
model-facing seam gains a new injection surface.

### 5. Rendering: one block under the Skills list

Rendered in `SkillsDialog` only when at least one shadow exists, so a clean
install looks byte-identical to today. One block, below the rows, non-clickable,
with no hover affordance — a row that looks clickable but loads a different file
than the one you are reading is exactly the bug being fixed:

```
2 global skills are hidden by a project skill with the same name
  discuss   /home/daniel/.agents/skills/discuss
  review    /home/daniel/.pi/agent/skills/review
```

- **Count-first**, and it names the *cause* — the fact a user needs is "the file
  I wrote at home is not what is running, and this is the one that is".
- **Wording keys off the loser's scope.** A `user` loser reads `global`, matching
  the existing row cue. A `space` loser (shadowed by a nearer project level, e.g.
  a package dir against the repo root) reads `project`, and the count line reads
  "hidden by a nearer project skill" — the same precedence fact one level down.
- **The loser's path is shown.** `read_skill` must never *invent* a path for the
  model; this is the user's own dialog reading the user's own disk, and when two
  files share a name the path is the only useful identifier.
- **The search box filters the block** with the same case-insensitive name
  substring as the rows, so a block that ignores the query cannot contradict the
  list above it.

### 6. Agent definitions: computed, carried, not yet rendered

Settings → Subagents calls `list_agent_definitions()` → `discover_agents(None)`,
which is **user-level roots only**, and the Settings page is app-global with no
active Space to pass as `cwd`. It therefore cannot display a
Space-shadows-user collision at all. So the agent side computes and carries
`shadowed` and renders nothing, and the surface is a documented follow-up: a
per-Space **Agents** button + popup modelled on the Skills dialog, at which
point the same block moves over unchanged.

## Non-goals

- No change to `prompt.rs`, `tool_specs.rs`, `read_skill`'s name resolution, or
  `$` Mention expansion. pi byte-parity of the prompt holds, and a shadowed
  Skill stays unaddressable by design.
- No annotation on the `$` picker, and no annotating the winning row as the
  primary surface (ADR 0065's considered options).
- No `--`-prefixed CLI flag, no settings toggle for precedence, no reordering of
  roots, no content-hash cache, no writing to skill directories (ADR 0013: the
  desktop is a reader, never a writer).
- No per-Space Agents popup in this change — follow-up only.

## Touch points

| File | Change |
| --- | --- |
| `src-tauri/src/skills.rs` | `walk`: follow symlinked dirs + visited-dir set; `discover_in_roots`: byte-identity dedupe, validate-then-dedupe reorder, record `ShadowedSkill`; new `ShadowedSkill` type + `shadowed` field |
| `src-tauri/src/agents.rs` | Same `shadowed` field via the shared collision helper; no discovery change (its `*.md` entries already accept symlinks) |
| shared helper | one small collision-recording helper used by both modules (both already share `home_dir` / `is_tag_safe_name`, so the seam exists) |
| `src-tauri/src/commands/skills.rs` / `commands/agents.rs` | DTO passthrough for the new field |
| `src/lib/tauri.ts` | `ShadowedSkill` type + `shadowed` on `SkillInfo` / `AgentDefinitionDto` |
| `src/components/SkillsDialog.tsx` | the report block + filtering it by `query` |
| `src-tauri/src/agent/tools/exec/skills.rs` | none expected — `skills_for` output shape is unchanged apart from the added field |

## Tests (TDD — write these red first)

Rust (`src-tauri/src/skills.rs`, plus `agent/tools/exec/tests/skills.rs`):

1. **A symlinked skill directory is discovered** — the fixture from the Problem
   section, as a failing test first: Space root + `linked -> real`, expect 1
   entry, tagged `space` (the first-wins attribution decision).
2. **A link cycle terminates and yields one row** — `a -> a/sub`, asserting the
   entry count rather than a timeout.
3. **A byte-identical copy across two roots is silent** — one entry, `shadowed`
   empty.
4. **A CRLF copy of the same file is silent** — the normalization case.
5. **Same `body`, different `disable-model-invocation` is a SHADOW** — the trap
   the byte-identity design closes; `shadowed` has exactly one entry.
6. **A different file with the same name shadows, and the loser is recorded**
   with name, path and `user` scope; winner stays `space`.
7. **A loser that fails validity checks is not reported** — a 1025-char
   `description`, and a name carrying `"`; one entry, `shadowed` empty.
8. **`list_skills` and the `<available_skills>` section are unchanged** — extend
   the existing `the_prompt_catalog_and_the_list_skills_catalog_agree` pin rather
   than adding a parallel one.
9. Agents: `first_wins_dedupe_space_shadows_user` keeps its `len()==1`
   assertion and gains a `shadowed.len()==1` assertion.

TypeScript (`SkillsDialog.test.tsx`):

10. No shadows → the block is absent (the byte-identical-UI pin).
11. Shadows present → count line + one line per loser, paths shown, block is not
    a button and does not dispatch `archimedes:insert-skill`.
12. A `space`-scope loser renders the "nearer project skill" wording.
13. The search query filters the block's lines alongside the rows.

## Verification

From `src-tauri/`: `cargo test`, `cargo clippy --all-targets` (0 warnings),
`cargo fmt --check`. From the repo root: `pnpm test`, `pnpm build`.
