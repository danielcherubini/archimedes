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
Wave 1 (SERIAL — see the 2026-10-29 decision): A1 → A2 → A3 → B1
Wave 2: B2a → B2b   (serial: B2b consumes B2a's `LaunchConfig.permission`; B2a consumes B1's `PermissionBlock`)
Wave 3: B3   (mirrors the Rust DTO B2a widens — its Step 0 re-reads the ACTUAL serde shape)
```

**Every wave here is width 1, for two independent reasons.** (1) The build graph, below. (2) AGENTS.md's
one-compilation-unit rule: **two Rust implementation tasks can never share a wave on this tree**, and A1/A2/A3/B1/B2
are all Rust. The four wave-1 owned file sets ARE pairwise disjoint — that was verified — but disjointness buys
parallelism only when a scoped test run can isolate its own writer, and `cargo test --lib <filter>` compiles the
whole crate. Wave 1's disjointness still earns something: the four tasks are independently commitable, so the
orchestrator commits each by pathspec and a failure bisects cleanly.

Wave 1's sets, verified pairwise disjoint at `2b6bd26`:
`exec/tests/policy.rs`+`boundary.rs` · `provider/openai.rs`+`provider/responses.rs` ·
`agent/mcp/tool.rs`+`harness/tool_specs.rs` · `agents.rs`+`agent/definition_permission.rs`+`agent/mod.rs`
(+ the 3 completion-only test literals in `commands/agents.rs` and `harness/launch.rs`).

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
| A1 | #104 — pin that a write into a protected dir's own PARENT stays allowed (the falsifier ADR 0081 names) | policy-exec | `docs/roadmap/agent-permission-and-pins-task01-protected-parent-write.md` | 1 | `src-tauri/src/agent/tools/exec/tests/policy.rs`, `src-tauri/src/agent/boundary.rs` (test module only) | `done` `9193993` |
| A2 | #108 — exactly-once `Usage` guard on the `openai` (`SseStream`) and `openai-responses` (`ResponsesStream`) parsers | provider | `docs/roadmap/agent-permission-and-pins-task02-usage-exactly-once.md` | 1 | `src-tauri/src/agent/harness/provider/openai.rs`, `src-tauri/src/agent/harness/provider/responses.rs` | `done` `af83c9b` |
| A3 | #118 — MCP proxy resolves `<server>_<tool>` / `mcp__<server>__<tool>`, listings show the callable form, misses name the likely tool and FAIL | mcp | `docs/roadmap/agent-permission-and-pins-task03-mcp-prefixed-names.md` | 1 | `src-tauri/src/agent/mcp/tool.rs`, `src-tauri/src/agent/harness/tool_specs.rs`, `docs/features/mcp-known-gaps.md` | `done` `32a9852` |
| B1 | #101(a) — parse the `permission:` frontmatter block into `AgentDefinition` (+ announce unknown top-level keys) | definition | `docs/roadmap/agent-permission-and-pins-task04-parse-permission-frontmatter.md` | 1 | `src-tauri/src/agents.rs`, `src-tauri/src/agent/definition_permission.rs` (NEW), `src-tauri/src/agent/mod.rs`, **`src-tauri/src/commands/agents.rs` (the 2 `AgentDefinition` test literals only)**, **`src-tauri/src/agent/harness/launch.rs` (the 1 `AgentDefinition` test literal only)** | `done` `2ccf1ff` |
| B2a | #101(b) — CARRY + LAYER + WIRE only: `LaunchConfig.permission`, the `[File]`-only resolver rung, `AgentConfigDto` widening, the whole-tool-deny resolver-side drop, and the rot-proof notes test. **Enforces nothing** — see its honesty statement. | definition | `docs/roadmap/agent-permission-and-pins-task05a-carry-and-wire.md` | 2 | `src-tauri/src/agent/subagent.rs`, `src-tauri/src/agent/harness/launch.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/bin/fake_worker.rs` | `vetted` |
| B2b | #101(c) — ENFORCE and make it LIVE: stricter-of-two in `gate.rs` (`Allow < Confine < Ask < Deny`), `AgentLoop` field+setter, `StartEnv.permission`, the `core.rs` application line, `subagent_flow.rs` pass-through, `Deserialize` on the B1 aggregate, + the real-worker e2e live-proof | definition | `docs/roadmap/agent-permission-and-pins-task05b-enforce-and-live.md` | 2 | `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/harness/loop.rs`, `src-tauri/src/agent/worker/protocol.rs`, `src-tauri/src/agent/worker/core.rs`, `src-tauri/src/agent/worker/manager/subagent_flow.rs`, `src-tauri/src/agent/definition_permission.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` (+ `src-tauri/tests/worker_e2e.rs` tests-only) | `vetted` |
| B3 | #101(d) — mirror the widened DTO to the frontend and render the definition's permission in the Agents modal | modal-wire | `docs/roadmap/agent-permission-and-pins-task06-modal-wire-mirror.md` | 3 | `src/lib/tauri/types.ts`, `src/lib/tauri.ts`, `src/components/AgentsDialog.tsx`, `src/components/AgentsDialog.test.tsx`, `src/hooks/useAgentCatalog.test.ts`, `src/components/SpacesList.test.tsx`, `src/lib/tauri.test.ts`, `src/lib/tauriBarrel.test.ts` | `vetted` |

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
- **2026-10-29** — **WAVE 1 IS SERIAL, NOT 4-PARALLEL. The cut announced at Step 0 was wrong for this repo and is corrected here.** All four wave-1 tasks are **Rust**, and AGENTS.md records as a measured property (established with a planted error, not assumed): *"`archimedes` is ONE compilation unit, so a syntax error anywhere breaks every scoped `cargo test` run: two Rust implementation tasks can never share a wave."* Disjoint owned file sets are necessary but NOT sufficient here: `cargo test --lib <filter>` compiles the whole crate, so a sibling's half-written `agents.rs` makes A2's scoped run fail to compile — each child's gate would measure its siblings, which is the "gates that mean nothing" failure the wave protocol exists to prevent. **Wave 1 therefore runs A1 → A2 → A3 → B1, one writer at a time.** Merging was checked and rejected against Step 2's ceiling: A1(1 file)+A2(2)+A3(3)+B1(5) = 11 files across four test trees and ~20 steps, far over 8 files / one test tree / 6 steps, and merging would trade a green gate for an implementer that compacts mid-task. Wall clock is 4 serial dispatches; this is the honest shape of Rust work on this tree, and the same rule forces wave 2 and wave 3 to stay width 1 for a second reason besides the build graph. **Frontend work is NOT subject to this** (vitest is per-file), so wave 3 keeps its own dispatch but gains nothing from parallelism as it is also width 1.
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
- `2026-10-29` — **vet round, task01** (`#104`): reviewer APPROVE, 4 findings all NON-BLOCKING. The reviewer adjudicated the plan-vs-grounding disagreement in the plan's favour — the grounding's §5 claim that a deny-rule fixture reddens on `!is_error` is wrong (correct code already refuses via `rule_deny_text`'s `or_else`), so the discriminating assertion is the WORDING, not `is_error`. Mutation arithmetic A: 3→5, B: 0→1 traced correct. No plan change needed.
- `2026-10-29` — **vet round, task02** (`#108`): the assigned `reviewer` truncated twice with no verdict, so the orchestrator vetted against the tree and found **TWO blocking defects**, both fixed by re-dispatched consumed-`specify` (not hand-edited by the orchestrator): (1) the openai guard was an early `return` inside `handle_chunk`'s usage block — `handle_chunk` continues into `delta` + `finish_reason` handling, so it would silently DROP `TextDelta`/`ToolCallDelta`/`Done` on any chunk carrying both usage and content; the guard is now a conditional wrapping the push, and the pin asserts the FULL vector so a delta-eating guard cannot pass. (2) the responses pin asserted `[Usage, Done(Stop)]`, but `terminated` is consulted ONLY at stream end, so a correct guard yields `[Usage, Done(Stop), Done(Stop)]` — the pin would have been RED against correct code. Both expected vectors re-verified by the orchestrator against `handle_chunk` / the terminal arms / `map_finish_reason`.
- `2026-10-29` — **vet round, task03** (`#118`): reviewer APPROVE, 5 findings (3 major, all about new-test mechanics, none architectural). Fixed by re-dispatched consumed-`specify`: the plan now states the resolved prefix dispatches the RAW tool name to `call_tool` (the fixture's `tools/call` implements only `echo`/`hang`/`err`, so a carried `a_echo` would hit the unknown-tool arm and `text == "x"` could never hold); Step 1 stubs the helpers so RED is assertion-level not compile-level; the `server` param description is pinned byte-identical including punctuation; the `search` filter change is stated as purely additive; the gaps-doc `verified-by` stamp shape is given verbatim.
- `2026-10-29` — **vet round, task04** (`#101a`): reviewer REVISE — 1 blocking + 2 major + 4 minor, all addressed by re-dispatched consumed-`specify` (plan 261 → 402 lines). Blocking: the `Tools` type was self-contradictory (`Option<Tools>` + one-tool-per-variant vs a T5 fixture needing `edit:`+`bash:`+`read:` together) — an implementer could silently DROP tools of a multi-tool block, the exact class #101 exists to fix; now pinned as an ordered `PermissionBlock { tools: Vec<(ToolKey, Rules)> }` with `ToolKey::Unrecognized(String)` RETAINING unknown keys. Also corrected: the `AgentDefinition` literal count is **four**, not three — the orchestrator verified `agents.rs:182` (the production construction inside `discover_in_roots`) is the fourth, which the plan had never named; plus blank-line handling in the nested reader, quote stripping, the duplicated-and-divergent `mod.rs` re-export list, and a backwards claim about `#[cfg(test)]` under `cargo test --lib`.
- `2026-10-29` — plan docs committed by pathspec at `95cd963` (`git add -f` — `docs/roadmap/` is gitignored). Wave 1 rows now read `vetted`.
- `2026-10-29` — **A1 `done` `9193993`** (#104). Two tests in `exec/tests/policy.rs`. Gate after the task: Rust **1637/0** (baseline 1635 + 2), clippy 0, fmt clean. MEASURED falsifier, re-run independently by the orchestrator: ancestor-peel in `protected_refusal_text` reddens **0 before → 1 after**, exactly `a_parent_deny_rule_does_not_move_the_guard_onto_the_parent_file`, on its WORDING assertion. The child's reported deviation stands: variant A (peel in `canonicalize_lenient`) is **5→7** across the three scopes, not the plan's 3→5 — the plan enumerated two scopes and `policy_gate` was already 2-red pre-pin; the pin's own delta is +2 either way.
- `2026-10-29` — **A2 `done` `af83c9b`** (#108). Guard wraps the push in `openai.rs` (NO early return — `handle_chunk` continues into delta + `finish_reason`); three terminal arms in `responses.rs` hoisted into `emit_terminal_usage`. Gate: Rust **1639/0**, clippy 0, fmt clean. The child proved the full-vector pin earns its keep: writing the forbidden early-return shape emits ONE `Usage` (a count-only pin would pass) and reddens only on the missing `TextDelta`. Residue left open and recorded: a doubled terminal still yields a doubled `Done` — out of #108's scope, asserted by the pin rather than hidden.
- `2026-10-29` — **B3's plan exists** (`task06`, written during wave 1's serial A1 dispatch) → row reads `planned`. Its Step 0 is mandatory: re-read B2's FINAL serde shape before mirroring, because this repo has **no wire-contract test** — the frontend mocks `invoke` and the Rust tests never emit IPC, so a Rust↔TS drift is invisible to both suites.
- `2026-10-29` — **A3 `done` `32a9852`** (#118). Gate: Rust **1645/0** (1639 + 6 new), clippy 0, fmt clean. Two things the orchestrator caught that the implementer's own report did not: (a) the child resolved a plan self-contradiction toward "a known-server prefix always commits", which is right and matches the shadowing residual the gaps doc records; (b) **the child MISSED half of acceptance item 2** — #118 says "show the form that works in `search` **and `server`** listings", and only `search` was changed. Re-dispatched scoped against the gap (not hand-fixed), then a second scoped dispatch for the `tool_specs.rs` clause the fix made stale. Lesson recorded below.
- `2026-10-29` — **B3 plan REVISED** (`task06`, 192→207 lines) after a full reviewer vet: 2 blocking + 1 major + 3 minor. Blocking: the required-field blast radius was **four sites in three files**, not one (`SpacesList.test.tsx`'s `agentRow`, and TWO in `useAgentCatalog.test.ts` including an inline literal in a hoisted `vi.mock` factory a builder fix cannot reach) — the plan's own `pnpm build` gate would have tripped its BLOCKED tripwire three times; and the plan forbade editing `tauriBarrel.test.ts` while requiring barrel registration there, which is unresolvable either way. Owned set now 8 files (at the ceiling). Major: the no-sort test's fixture was already in lexicographic order, so the `.sort()` it exists to catch would have passed it.
- `2026-10-29` — **Wave-1 lesson: an implementer's DONE report is not an acceptance check.** A3 reported DONE with green scoped tests and had implemented 3 of 4 acceptance items. The missing one was visible only by re-reading the issue's proposal against the diff, not by running anything. **For every task, re-read the issue's acceptance list against the diff before committing, even when the child reports green.**
- `2026-10-29` — **B1 `done` `2ccf1ff`** (#101a). Gate: Rust **1674/0** (1645 + 29), clippy 0, fmt clean. 29 tests across the new module and `agents.rs`. `skills.rs` byte-untouched (verified `git diff --stat` empty), both `parse_value` copies intact, divergence pin green.
- `2026-10-29` — **B1's comment defect was found by READING, not by running.** #101's Evidence section names `~/.agents/agents/researcher.md`; that file has **7 comment lines inside its `permission:` block**, one of them `# Known gap: …`. A colon inside a comment made `split_key_value` split it into a tool key, so the reader pushed `Unrecognized("# Known gap")` into the parsed block as if it were a rule and announced the other six as whole-sentence `UnknownKey`s. **The motivating file still did not parse.** Both the implementer's DONE report and my own acceptance re-read passed it — the defect surfaced only when I opened the evidence file the issue itself names. **New standing rule for this run: for any task whose issue cites a real file, sample, or reproduction, open it and run the implementation against it before committing.** A green suite plus a passing acceptance checklist is not evidence the motivating case works.
- `2026-10-29` — B1's two accepted deviations, both adjudicated correct by the orchestrator: (a) `CHANGELOG.md` does not exist and never has (verified `git log --all -- CHANGELOG.md` empty) — the plan's changelog step was decoration, the status file's Changelog is the real one; (b) `FrontmatterNote` is **externally** tagged, not `#[serde(tag = "kind")]` as the plan specified — internally-tagged serde requires map-shaped payloads and every payload here is a bare `String`/unit, so the plan's spelling would panic on the first wire send. Pinned by `frontmatter_notes_serialize_as_a_tagged_object_per_note`. B3's Step 0 must read the ACTUAL shape (it already requires re-reading B2's final serde shape — this is why).
- `2026-10-29` — **Wave 1 complete** (A1 `9193993`, A2 `af83c9b`, A3 `32a9852`, B1 `2ccf1ff`). Gate at HEAD: Rust 1674/0, clippy 0, fmt clean. **`definition` area RE-GROUNDED as a delta** (below) rather than re-derived.
- `2026-10-29` — **`definition` area re-grounded as a DELTA report** (`-ground-definition-delta.md`, 1122 lines, at `27d761c`), not a full re-derivation: the original stays valid for `launch.rs`/`subagent.rs`/`loop.rs`/`gate.rs`/`policy.rs`/`fs_backend.rs`/`commands/agents.rs`/`policy_gate.rs` (wave 1 touched none of them but two literal-completion lines); only `agents.rs` and the new `definition_permission.rs` moved. It caught what the original could not: `FrontmatterNote` is **externally tagged** (`{"unknownKey":"…"}`), NOT `#[serde(tag="kind")]`, and `Rule`/`Rules`/`PermissionBlock` carry **no `rename_all`**, so `whole_tool` is snake_case — a camelCase guess in the TS mirror would drift silently because **this repo has no wire-contract test**. It also corrected the `LaunchConfig` literal census: only `launch.rs:271` (production resolver) and `fake_worker.rs:509` are fully-specified. **My own earlier grep reported four and was wrong** — its 14-line window missed `..Default::default()` in `interactive/mod.rs:135`. The re-grounded report beat the orchestrator's stale scan; trust the fresh one.
- **2026-10-29** — **B2 SPLIT INTO B2a + B2b, because the planner reported a genuine scope blocker and acting on it was correct.** Its plan completed carry + layer + gate enforcement + the DTO wire, but the ONE production line that would make enforcement LIVE — `loop_.set_permission(...)` in `worker/core.rs`, fed by a `StartEnv.permission` field — is outside its owned set, so enforcement would ship **dormant**: real, unit-tested, never consulted. That is the confident-no-op class #101 itself exists to fix, so calling it "complete" would have been the worst available outcome. Verified independently: `resolve_agent_launch` has exactly two callers — `commands/agents.rs` (the modal's read-only report) and `harness/dispatch.rs` → `resolve_launch` (the `subagent` tool call) — and **no main-session path passes an `AgentDefinition` at all**, so a definition's `permission:` governs CHILDREN only and the child loop is built in `worker/core.rs` from `StartEnv`. Split, both halves under the ceiling:
  - **B2a — carry + layer + wire (4 files):** `subagent.rs` (`LaunchConfig.permission`), `harness/launch.rs` (the `[File]`-only rung + `ResolvedLaunch` + the production literal), `commands/agents.rs` (DTO widening + the wire-shape pin's column lists + **the rot-proof notes test B1 mandated**), `bin/fake_worker.rs`. The whole-tool-deny drop goes **resolver-side**, so it is production-effective WITHOUT touching `subagent_flow.rs` — that file reads `wire.launch.tools` VERBATIM, so a narrowed `launch.tools` flows through for free.
  - **B2b — enforce + make it LIVE (6 files):** `harness/loop/gate.rs` (stricter-of-two over `Allow < Confine < Ask < Deny`), `harness/loop.rs` (field + setter), `worker/protocol.rs` (`StartEnv` + `from_parts`), `worker/core.rs` (apply it), `worker/manager/subagent_flow.rs` (pass `wire.launch.permission`), `harness/loop/tests/policy_gate.rs`.
  Serial either way (B2b consumes B2a's field), so the split costs one extra dispatch and buys a green gate per half plus a bisectable seam. `SubagentDispatchWire` already carries `launch: LaunchConfig` verbatim, so `permission` rides the wire the moment the field exists — the gap is only `StartEnv` plus the one `core.rs` line.
- **2026-10-29** — **Two standing rules added this wave.** (1) For any task whose issue cites a real file, sample, or reproduction, OPEN it and run the implementation against it before committing — B1's comment defect passed both the child's DONE report and my own acceptance re-read, and only the evidence file caught it. (2) **A planner's BLOCKED report about its own owned set is evidence to act on, not to overrule** — B2's is what stopped dormant enforcement from shipping.
- `2026-10-29` — **Wave 2 plans vetted.** B2a: reviewer found **no BLOCKING finding** — its compile census (`fake_worker.rs:509` the only fully-specified `LaunchConfig` literal), the 8 `OverrideFields`/`SourceFields` expectation literals, the no-`Default`-on-`SourceFields` claim, the `[File]`-only rung, and the verbatim three-way `subagent_flow` rule all verified. Two non-blocking refinements noted (name the PRODUCTION `OverrideFields` sites — `file_fields` and the `From` impl — not just the test literals; pin the notes test on the JSON element, not a `contains`). B2b: refined 662 → 804 lines on the `Deserialize` build break + the 14-site `from_parts` census. Both rows `vetted`; plans committed at `1a40cba`.
- `2026-10-29` — **A stale `.git/index.lock` (0 bytes, 16 min old, no holder per `fuser`) blocked the plan commit.** Checked for a holder before removing rather than deleting blind — a live index lock is a concurrent writer, and this run shares one tree with children that run `git status`/`git diff` constantly. Removed, commit re-run.
