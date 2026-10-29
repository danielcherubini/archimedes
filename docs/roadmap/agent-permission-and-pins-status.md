---
status: running
mode: autonomous
updated: 2026-10-29
---

# Agent permission + release pins — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Close the four remaining open enhancement issues on `danielcherubini/archimedes` — **#101** (consume the
`permission:` frontmatter block in Agent definitions), **#104** (pin that a write to a protected dir's own
PARENT stays allowed), **#108** (exactly-once `Usage` guard on the `openai` / `openai-responses` parsers),
**#118** (the MCP proxy tool rejects server-prefixed tool names). Finished means: all four issues' acceptance
criteria measure true, the five gate commands are green, follow-ups folded, one PR into `main`.

There is **no spec doc** at `docs/roadmap/<feature>.md` — the entry is the GitHub issue tracker itself (the
user named the four issues directly). The issues ARE the source documents; their bodies are summarised per
task below and mirrored as comments on each issue.

## Operating mode

The whole wave moves at once — planning fans out, it is not one task at a time.

**On every resume, before dispatching anything:** run `git status --porcelain`. Uncommitted edits inside some
task's Owns set mean the previous iteration died **mid-implementation** — that task is `implemented`, not
`todo`, and its siblings may be half-written. Commit or set aside those edits first; never dispatch a new wave
on a dirty tree. Then re-derive every task's state from the table's Status tests (plan file? changelog?
commit?) — the tree outranks whatever value is written, so correct the column before acting on it. Then rebuild
the **session list** (`manage_todo_list`) from the corrected column — one entry per task row, `W<wave> · <task id>`,
replacing whatever entries are there, including an empty list. Map each row's Status to a list state —
`todo`/`planned`/`vetted` → pending, `implemented` → in-progress, `done` → complete.

Loop protocol, per WAVE, repeat until `status: done`:
1. Read this file. Take the FIRST wave containing a task whose Status is not `done`. Do not pick, reorder, or
   skip. Re-entering a half-finished wave resumes at the first incomplete step below — never re-dispatch a step
   whose output already exists (area already in the Grounding reports table → skip grounding it; plan file
   already present → skip planning it).
2. Verify each task in the wave against the tree. Trust the tree over the task text. Re-check the Owns sets are
   still disjoint.
3. Ground: one `researcher` per area not yet grounded, all in one response, each WRITING
   `docs/roadmap/agent-permission-and-pins-ground-<area>.md`.
4. Plan: dispatch `specify` in CONSUMED MODE to `researcher` (`agentName: "researcher"`) for every todo task in
   the wave with NO plan file yet, all in one response — marker `SPECIFY CONSUMED MODE`, the task text, its Owns
   set, the grounding FILE PATH (not its contents), and `target: docs/roadmap/agent-permission-and-pins-taskNN-<slug>.md`.
5. Vet: one `reviewer` per plan file in one response (max 3 rounds each), told to OPEN the files the plan names;
   findings → re-dispatch consumed specify to refine the SAME target.
6. Commit the plan docs yourself, by pathspec.
7. Implement the wave per implement's wave protocol (children don't commit; orchestrator commits by pathspec;
   scoped tests in-wave; ≤4 implementers). In the SAME response, dispatch planning for the NEXT wave's tasks —
   only for areas this wave's implementers do not touch.
8. Run the gate (full suite once per wave). Green → commit by pathspec → mark `done` → one Changelog line.
   Red → re-dispatch; never fix by hand in the orchestrator.
9. Update THIS FILE **and the session list** before starting the next wave. Then loop.

## Gate — establish before task 1, re-run after every wave (and after each serial task)

```
# repo root
pnpm test
pnpm build
# src-tauri/
cargo test
cargo clippy --all-targets     # must be 0 warnings
cargo fmt --check
```

Baseline measured at `2b6bd26` (branch `main`, clean tree): **Rust 1635 passed / 0 failed**, clippy 0 warnings,
fmt clean, **frontend 154 files / 3252 tests passed**, `pnpm build` succeeds (the chunk-size >500 kB warning is
pre-existing and is not a failure). All five commands exit 0. **Re-measure at your own HEAD** — plans carry
stale baselines within hours on this tree.

## Dependency graph / waves

```
Wave 1: A1, A2, A3, B1   (four disjoint owned file sets — see below)
Wave 2: B2               (consumes B1's `DefinitionPermission` type AND the LaunchConfig field it creates)
Wave 3: B3               (mirrors the Rust DTO B2 widens)
```

**Wave 2 width 1 — recorded so the next iteration does not re-litigate the cut.** #101's five seams (parse →
carry → layer → enforce → report) are a genuine build-graph chain, not an artefact of the cut: the gate
enforcement consumes the `LaunchConfig.permission` field the carry step creates, and the wire DTO carries the
type parse produces. `carry` + `layer` + `enforce` were therefore MERGED into one task (B2: 7 owned files, 6
steps — at the ceiling) rather than paying two implementers for a serial pair.

**B1 and B2 SHARE two files — `commands/agents.rs` and `agent/harness/launch.rs` — and that is legal only
because they are in DIFFERENT waves.** Disjointness is a within-wave requirement; a cross-wave share is just a
serial edge, and here the edge is real (B2 consumes B1's type). The share exists because of a fact measured at
`2b6bd26`, not a design preference: **`AgentDefinition` has no `Default`, so adding a field breaks all three
fully-specified `AgentDefinition` literals in the tree** — `commands/agents.rs`'s `full_definition()` and
`definition()`, and `harness/launch.rs`'s `def_with()` test helper. Because **`archimedes` is ONE compilation
unit** (AGENTS.md), B1 cannot compile without editing those three, so they belong to B1. B1's edits there are
**literal-completion only** — do not let a B1 implementer "helpfully" widen `OverrideFields` there; that is
B2's work and B2 owns the file's semantics. **Re-verify the disjointness of WAVE 1 only** (A1/A2/A3/B1), and
B1's `commands/agents.rs` + `launch.rs` touch must be checked not to collide with any other WAVE 1 member —
none of them own either file, so they do not.

B2 additionally owns `src/bin/fake_worker.rs`: measured, exactly **four** `LaunchConfig` literals are
fully-specified (`fake_worker.rs:509`, `launch.rs:271` the production resolver, `interactive/mod.rs:135` and
the `subagent.rs` declaration) while the other ~20 use `..Default::default()` and absorb a new field silently.
`LaunchConfig` derives `Default`, so `fake_worker.rs:509` is the only *non-test-adjacent* literal B2 must touch.
`interactive/mod.rs:135` already uses `..Default::default()` and needs nothing.

**Wave 3 width 1** because the TypeScript DTO mirror must be written against the Rust DTO that actually exists
after B2; no test cross-checks the two, so planning it blind is how the wire drifts.

Wave 1's four sets are pairwise disjoint and verified against the tree at `2b6bd26`:
`exec/tests/policy.rs`+`boundary.rs` · `provider/openai.rs`+`provider/responses.rs` ·
`agent/mcp/tool.rs`+`harness/tool_specs.rs` · `agents.rs`+`agent/definition_permission.rs`+`agent/mod.rs`.
No two share a `mod.rs`, a barrel, a lockfile, or a fixture. **Note:** B1 owns `agent/mod.rs` (one `pub mod` +
one `pub use` line) and B2 owns `agent/subagent.rs` — `agent/mod.rs` is NOT touched by B2, verified by the fact
that `LaunchConfig` already re-exports from `subagent` today.

## Grounding reports

All five grounded at `2b6bd26` (tree unmoved since — `git status --porcelain` empty, HEAD still `2b6bd26`):

| Area | Report | Grounded at | Tasks that read it |
|---|---|---|---|
| policy-exec | `docs/roadmap/agent-permission-and-pins-ground-policy-exec.md` (436 L) | `2b6bd26` | A1 |
| provider | `docs/roadmap/agent-permission-and-pins-ground-provider.md` (495 L) | `2b6bd26` | A2 |
| mcp | `docs/roadmap/agent-permission-and-pins-ground-mcp.md` (852 L) | `2b6bd26` | A3 |
| definition | `docs/roadmap/agent-permission-and-pins-ground-definition.md` (1955 L) | `2b6bd26` | B1, B2 |
| modal-wire | `docs/roadmap/agent-permission-and-pins-ground-modal-wire.md` (902 L) | `2b6bd26` | B3 |

**Grounded early, deliberately:** `definition` covers B2's seams too (wave 2), and `modal-wire` covers B3's
(wave 3) — both were grounded in wave 1 because a researcher runs no build and the tree had not moved. Re-ground
`definition` before B2's planning ONLY if wave 1's implementers touched a file inside it — they do not: wave 1's
implementers own `exec/tests/policy.rs`, `boundary.rs`, `provider/openai.rs`, `provider/responses.rs`,
`agent/mcp/tool.rs`, `harness/tool_specs.rs`, `agents.rs`, `agent/definition_permission.rs`, `agent/mod.rs`,
and `definition`'s B2-relevant files (`subagent.rs`, `harness/launch.rs`, `harness/loop.rs`,
`harness/loop/gate.rs`, `policy.rs`, `commands/agents.rs`) are outside that set EXCEPT `agents.rs` and
`agent/mod.rs` — which B1 owns. **So re-ground `definition` (or at least re-check its `agents.rs` quotes)
before planning B2.**

## Tasks

| # | Task | Area | Plan file | Wave | Owns (file set — disjointness evidence) | Status |
|---|------|------|-----------|------|------------------------------------------|--------|
| A1 | #104 — pin that a write into a protected dir's own PARENT stays allowed (the falsifier ADR 0081 names) | policy-exec | `docs/roadmap/agent-permission-and-pins-task01-protected-parent-write.md` | 1 | `src-tauri/src/agent/tools/exec/tests/policy.rs`, `src-tauri/src/agent/boundary.rs` (test module only) | `todo` |
| A2 | #108 — exactly-once `Usage` guard on the `openai` (`SseStream`) and `openai-responses` (`ResponsesStream`) parsers | provider | `docs/roadmap/agent-permission-and-pins-task02-usage-exactly-once.md` | 1 | `src-tauri/src/agent/harness/provider/openai.rs`, `src-tauri/src/agent/harness/provider/responses.rs` | `todo` |
| A3 | #118 — MCP proxy resolves `<server>_<tool>` / `mcp__<server>__<tool>`, listings show the callable form, misses name the likely tool and FAIL | mcp | `docs/roadmap/agent-permission-and-pins-task03-mcp-prefixed-names.md` | 1 | `src-tauri/src/agent/mcp/tool.rs`, `src-tauri/src/agent/harness/tool_specs.rs`, `docs/features/mcp-known-gaps.md` | `todo` |
| B1 | #101(a) — parse the `permission:` frontmatter block into `AgentDefinition` (+ announce unknown top-level keys) | definition | `docs/roadmap/agent-permission-and-pins-task04-parse-permission-frontmatter.md` | 1 | `src-tauri/src/agents.rs`, `src-tauri/src/agent/definition_permission.rs` (NEW), `src-tauri/src/agent/mod.rs`, **`src-tauri/src/commands/agents.rs` (the 2 `AgentDefinition` test literals only)**, **`src-tauri/src/agent/harness/launch.rs` (the 1 `AgentDefinition` test literal only)** | `todo` |
| B2 | #101(b) — carry `permission` through `LaunchConfig` / `resolve_agent_launch` / `AgentConfigDto` and ENFORCE it in `gate.rs` (stricter-of-two) + drop whole-tool denies from `enabled_tools` | definition | `docs/roadmap/agent-permission-and-pins-task05-carry-and-enforce.md` | 2 | `src-tauri/src/agent/subagent.rs`, `src-tauri/src/agent/harness/launch.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/agent/harness/loop.rs`, `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/bin/fake_worker.rs` (the one fully-specified `LaunchConfig` literal) | `todo` |
| B3 | #101(c) — mirror the widened DTO to the frontend and render the definition's permission in the Agents modal | modal-wire | `docs/roadmap/agent-permission-and-pins-task06-modal-wire-mirror.md` | 3 | `src/lib/tauri/types.ts`, `src/lib/tauri.ts` (only if the barrel needs it), `src/components/AgentsDialog.tsx`, `src/components/AgentsDialog.test.tsx` | `todo` |

**Status is exactly one of:** `todo` (no plan file) · `planned` (plan file exists) · `vetted` (plan + a
Changelog line for the vet round) · `implemented` (edits in the tree, uncommitted) · `done` `<hash>`
(committed, gate green).

## Task prose (the source text each planner receives)

### A1 — #104 (test-only pin, no production behaviour change intended)

ADR 0081's follow-up table names the missing falsifier exactly: an **ancestor-peeling** compare (peel a
resolved path to its canonical ancestor, ignore the re-applied trailing components) **survives the entire
existing suite** — three tests redden but they die on a *premise* assertion with a non-empty wrong list, not on
the over-refusal itself. There is **no fixture anywhere** that writes into a protected directory's own parent
and asserts success, so `~/.agents/my-notes.md` would be denied by a `~/.agents/skills` entry and nothing would
catch it. ADR 0081 states the concrete shape: an executor test with `writes: Allow` whose target is
`$HOME/.pi/agent/allowed.md` — the **parent** of a protected entry, **with the entry itself missing** —
asserting `!is_error` and that the file lands, placed beside the two session-snapshot tests whose fixture shape
it reuses minus the recreation. The issue adds the evidence requirement: adding the pin makes the mutation count
**five red, not four**, and that delta must be stated in the commit message so a future reader can re-run the
falsifier. (The three-red baseline figure is **T06's implementer's measurement as recorded in ADR 0081**, which
explicitly ran no `cargo` — re-measure it at this HEAD, do not copy it.)

### A2 — #108

`provider/anthropic.rs` has the `usage_emitted` bool + the `anthropic_sse_cost_is_emitted_exactly_once` test.
`SseStream` (`openai.rs`) and `ResponsesStream` (`responses.rs`) have nothing: `openai.rs` pushes a
`ProviderEvent::Usage` from **any** chunk carrying both `prompt_tokens` and `completion_tokens`, and
`responses.rs` pushes one from **every** terminal event that carries `response.usage` (`completed` /
`incomplete` / `failed` — three separate call sites, all guarded only by `terminated`, which does not stop a
second usage-bearing event). Add the same guard, and pin each variant with a test feeding **two** usage chunks
and asserting **one** frame. ADR 0082's constraint: record the residue as **observed, not guaranteed** — the
fix belongs at the parser seam, never in an accumulator.

### A3 — #118

`agent/mcp/tool.rs` matches `ti.name == t.as_str()` in both the call path and `describe`, so a
pi-mcp-adapter-style `atlassian_createJiraIssue` returns `Tool not found` with no hint. Acceptance: prefixed
`tool` and `describe` resolve to the same tool as the raw name; a wrong prefix returns an **error** naming the
likely correct tool; raw names and the existing `server` disambiguation behave unchanged; unit tests cover a
prefixed call, a prefixed describe, a **server name containing an underscore**, and a miss with suggestions.
Do NOT split on the first underscore — resolve against the known server names. Listings (`search`,
`server`) must show the form that actually works. A miss becomes a failed `ToolResult`, not `ok(...)` — the
same rule #68 established, and `miss_result` already exists for exactly that decision.

### B1 — #101(a)

`parse_agent_file` (`agents.rs`) reads exactly five keys and its step-3 scan visits **top-level non-indented
keys only**; `permission:` yields nothing and its indented children are never visited — a confident no-op. Add
a `permission` field to `AgentDefinition` and the first **structured** (nested) value reader the format asks
for: `edit: {"*": "deny", "*.md": "allow"}` (object of pattern → action), `task: deny` (bare action), plus the
`allow`/`ask`/`deny` resolution. State which upstream the reader mirrors (ADR 0020's parity rule;
`skills.rs`'s `parse_value` copy diverges in two documented ways and `the_two_parse_value_copies_diverge_where_their_parity_targets_differ`
pins it). Also: an unrecognised top-level frontmatter key must announce itself (#78's principle applied to
files) so the next dialect miss is not another silent no-op.

### B2 — #101(b)

Carry: add `permission` to `LaunchConfig` and to the `resolve_agent_launch` ladder alongside `model` /
`thinking` / `tools`, so `OverrideSource` can report `Override` / `File` / `Parent`; widen `SourceFields` /
`OverrideFields` in `commands/agents.rs` accordingly (ADR 0068: the effective config is resolved by the
dispatch path, not the renderer). Enforce: consult it in `harness/loop/gate.rs` **after** `decision_for`,
taking the **stricter** of the two verdicts — a definition may only ever NARROW, never widen, the user's
`filePolicy`, and never bypass the protected-dir guard (#92 / ADR 0081). A `deny` reuses the existing
`deny_tool_result` wording so the model's recovery cannot depend on which layer said no (ADR 0030). A
whole-tool `deny` drops the tool from the child's `enabled_tools`, so the model is never offered a call it
cannot make.

### B3 — #101(c)

Mirror the B2-widened DTO into `src/lib/tauri/types.ts` and render the definition's declared permission on the
Agents modal row (ADR 0068 — the row prints what the resolver said, with its layer). No rule-authoring UI:
parsing, enforcing and **displaying** what a file declares is the whole scope.

## Decisions log

- **2026-10-29** — **`docs/roadmap/` is gitignored (`.gitignore:31`), so step 6's "commit the plan docs by pathspec" requires `git add -f docs/roadmap/<file>`** — a plain `git add` prints nothing and commits NOTHING, which would leave the run believing its plans are recorded. Measured: `git check-ignore -v` confirms it ignores the status file, the task plans and the follow-ups file alike. This is also why the repo holds only two tracked files in that directory (`git ls-files docs/roadmap/` → the two `*-follow-ups.md`), both force-added. AGENTS.md's warning applies with force here: an untracked file in this directory is **unrecoverable** — no `git checkout`, no stash, no dangling blob — so force-adding each plan at step 6 is what makes a 6-task, multi-session run survivable. `finish` deletes the family on ship regardless, so committing them costs nothing durable.
- **2026-10-29** — `<feature>` = the branch topic: `feature/agent-permission-and-pins` → `agent-permission-and-pins`. No spec doc exists (entry is the issue tracker); `finish` skips it.
- **2026-10-29** — Entry is the GitHub tracker, not `discuss`/`research`/`codebase-improvement`: the user named issues #101 #104 #108 #118 directly. There is nothing to mirror the breakdown to except the issues themselves, so the task breakdown is posted as a comment on each of the four.
- **2026-10-29** — **#101 bash pattern matching: whole-tool only, per-pattern bash rules parse but do NOT enforce.** The issue names the trap directly — opencode matches command text *including its redirect*, so `grep x file 2>/dev/null` contains a `>` and a naive `*>*` deny blocks the stderr-suppression idiom, and ordering cannot express "redirect to a file but not to an fd". Archimedes has no tree-sitter command parse, so restricting pattern matching to **path-taking** tools (where `FsBackend::validate` already canonicalises) is the honest scope; `bash: deny` (whole tool) works. A `bash:` block carrying per-command patterns must **announce itself as unsupported** rather than enforce a matcher nothing has validated. Evidence for the trap is opencode's own matcher over 62 cases, cited in #101.
- **2026-10-29** — **#118 canonical display form is `<server>_<tool>`**, accepting both `<server>_<tool>` and `mcp__<server>__<tool>` on input. Both are cheap to accept; the only real decision is what `search` prints, and `server_tool` is what existing pi-mcp-adapter skills already write, while `mcp__…` is only named as a candidate in ADR 0018. Resolution matches the **longest known server-name prefix**, never the first underscore.
- **2026-10-29** — **#101 pattern paths are judged canonicalise-then-check against the boundary ROOT SET**, not "workspace-relative" as opencode does. #101 asks "relative to what root?" as a real question; archimedes' boundary is a root set seeded asymmetrically for read vs write (`boundary.rs::read_roots` / `write_roots`), and a pattern layer resolving `..` or a symlink differently from the executor is the #92 / ADR 0081 escape class. So: reuse `FsBackend::validate`'s canonicaliser, one resolver, no second canonicaliser.
- **2026-10-29** — **#101 opencode's `external_directory` / `doom_loop` guard keys are OUT of scope** (the issue's own non-goals): archimedes has the boundary set and ADR 0055's liveness rules.
- **2026-10-29** — A new module `agent/definition_permission.rs` rather than widening `agent/policy.rs`: `AccessPolicy` is per-*direction* and global and its `Sandboxed` carries the Landlock meaning, which has no per-agent reading (#101's own "Reuse `AccessPolicy` or a new type?" answer). `agent/mod.rs` gets one `pub mod` + one `pub use` line — owned by B1 alone.

## Blockers / open questions

None. See `docs/roadmap/agent-permission-and-pins-follow-ups.md` before ship for what is deliberately left.

## Changelog

- `2026-10-29` — gate baseline measured at `2b6bd26`: Rust 1635/0, clippy 0 warnings, fmt clean, frontend 154 files / 3252 tests, `pnpm build` ok. Branch `feature/agent-permission-and-pins` created off `main`. Status file written; task breakdown mirrored to #101 #104 #108 #118.
