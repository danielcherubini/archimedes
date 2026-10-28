---
status: running
mode: autonomous
updated: 2026-10-28
---

# permissions-section — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Ship the approved permissions model in `docs/roadmap/permissions-section.md` (`status: approved`, mirrored on
GitHub issue **#112**): a `rules` list of `{path, direction, decision}` exceptions evaluated by longest
canonical prefix, and the self-modification guard for agent-definition directories changing from an
unconditional deny to an **ask** when no rule matches. Finished means: rule precedence enforced in one shared
resolver, per-prompt guard options with no `trust-space` shortcut, `allow-directory` persisting exactly one
rule via the Supervisor relay, a Settings → Permissions section with the rules list and the honest bash/trust
copy, and ADR 0083 + the ADR 0030 amendment + `CONTEXT.md` + a `docs/features/` page recording it.

## Operating mode

The whole wave moves at once — planning fans out, it is not one task at a time.

**On every resume, before dispatching anything:** run `git status --porcelain`. Uncommitted edits inside some
task's Owns set mean the previous iteration died **mid-implementation** — that task is `implemented`, not
`todo`, and its siblings may be half-written. Commit or set aside those edits first; never dispatch a new wave
on a dirty tree. Then re-derive every task's state from the table's Status tests (plan file? changelog?
commit?) — the tree outranks whatever value is written, so correct the column before acting on it.

Loop protocol, per WAVE, repeat until `status: done`:
1. Read this file. Take the FIRST wave containing a task whose Status is not `done`. Do not pick, reorder, or
   skip. **Re-entering a half-finished wave resumes at the first incomplete step below — never re-dispatch a
   step whose output already exists** (area already in the Grounding reports table → skip grounding it; plan
   file already present → skip planning it).
2. Verify each task in the wave against the tree. Trust the tree over the task text. Re-check the Owns sets
   are still disjoint — the tree outranks this table.
3. Ground: one `researcher` per area not yet grounded, all in one response, each WRITING
   `docs/roadmap/permissions-section-ground-<area>.md`. Never ground per task.
4. Plan: dispatch `specify` in CONSUMED MODE to `researcher` (`agentName: "researcher"`) for every todo task
   in the wave that has NO plan file yet, all in one response — marker `SPECIFY CONSUMED MODE`, the task text,
   its Owns set, the grounding FILE PATH (not its contents), and
   `target: docs/roadmap/permissions-section-taskNN-<slug>.md`. Not capped at 4; planning is read-only.
5. Vet: one `reviewer` per plan file in one response (max 3 rounds each), told to OPEN the files the plan
   names; findings -> re-dispatch consumed specify to refine the SAME target.
6. Commit the plan docs yourself, by pathspec — the child is forbidden from committing, so an uncommitted plan
   gets re-planned by the next session. **`docs/roadmap/` is gitignored: use `git add -f` with explicit
   pathspecs, never a directory.**
7. Implement the wave per implement's wave protocol (children don't commit; you commit by pathspec; scoped
   tests in-wave; <=4 implementers). In the SAME response, dispatch planning for the NEXT wave's tasks — only
   for areas this wave's implementers do not touch.
8. Run the gate (full suite once per wave). Green -> commit by pathspec -> mark `done` here -> one Changelog
   line. Red -> re-dispatch; never fix by hand in the orchestrator.
9. Update THIS FILE before starting the next wave. Then loop.

## Gate — establish before task 1, re-run after every wave (and after each serial task)

```
# from src-tauri/
cargo test
cargo clippy --all-targets        # must be 0 warnings
cargo fmt --check
cargo check --target x86_64-pc-windows-gnu --all-targets   # only local Windows proof; #[cfg(windows)] never RUNS here
# from the repo root
pnpm test
pnpm build
```

Baseline measured at `a17ba4b` (branch `main`, clean tree): **all legs green** — `cargo test` 1581 passed / 0
failed; `clippy --all-targets` 0 warnings; `fmt --check` clean; `pnpm test` 153 files / 3240 tests passed;
`pnpm build` green (chunk-size warning only, pre-existing). `cargo check --target …windows-gnu` was NOT run at
baseline — run it with the first wave that touches Rust, and treat its first result as that leg's baseline.

The spec's own Verification section says "152 files / 3203 tests" — **already stale at branch HEAD.** Trust the
numbers above, and re-measure rather than copying either.

## Dependency graph / waves

```
Wave 1: T01 (Rust policy core)  ∥  T05 (frontend prompt types/UI)   — disjoint, different languages
Wave 2: T02 (Rust wire shape + prompt)  ∥  T06 (Settings section)   — T02 needs T01's rule resolver types
Wave 3: T03 (gate + executor precedence)      width 1 — needs T01's resolver AND T02's Selected{value}
Wave 4: T04 (Supervisor relay persists rules) width 1 — needs T02's Selected{value}
Wave 5: T07 (ADRs / CONTEXT.md / feature doc) width 1 — records everything above
```

**Why the Rust spine is a chain, recorded so the next iteration does not re-litigate the cut:** `archimedes` is
ONE compilation unit, so two Rust implementation tasks can never share a wave regardless of how the file sets
are cut (established in this repo with a planted syntax error, not assumed). On top of that `gate.rs` is needed
by three separate concerns — rule enforcement (T03), the approve predicate that today reads
`option_id == "allow" || option_id == "trust-space"` (T02), and the guard prompt (T02) — so it cannot be
parallelised by ownership either. The real parallelism in this run is **Rust ∥ Frontend**, and that is what
waves 1 and 2 use. Width-1 for waves 3–5 is the honest shape of the work, not a failed cut.

## Grounding reports

| Area | Report | Grounded at |
|---|---|---|
| policy-core | `docs/roadmap/permissions-section-ground-policy-core.md` | `a17ba4b` |
| frontend-prompt | `docs/roadmap/permissions-section-ground-frontend-prompt.md` | `a17ba4b` |
| permission-wire | `docs/roadmap/permissions-section-ground-permission-wire.md` | `a17ba4b` |
| gate-executor | `docs/roadmap/permissions-section-ground-gate-executor.md` | `a17ba4b` |
| supervisor-relay | `docs/roadmap/permissions-section-ground-supervisor-relay.md` | `a17ba4b` |
| docs | `docs/roadmap/permissions-section-ground-docs.md` | `a17ba4b` |

`frontend-settings` is deliberately **not** grounded here: T05 (wave 1) mutates `src/lib/tauri/types.ts`,
`src/store/permissions.ts` and the barrel, all of which the Settings planner must read. Ground it after wave 1
lands, or its report will describe a tree that no longer exists.

## Tasks

| # | Task | Area | Plan file | Wave | Owns (file set — disjointness evidence) | Status |
|---|------|------|-----------|------|------------------------------------------|--------|
| T01 | Rule model + longest-prefix resolver; `protected_dirs()` becomes the default rule set | policy-core | `docs/roadmap/permissions-section-task01-rule-model-resolver.md` | 1 | `src-tauri/src/agent/policy.rs`, `src-tauri/src/agent/boundary.rs` (both + inline test mods) — **plus the 10-file `FilePolicy` blast-radius set ratified 2026-10-28**: `src-tauri/src/agent/harness/loop.rs`, `src-tauri/src/agent/harness/loop/tools.rs`, `src-tauri/src/config.rs`, `src-tauri/src/agent/web/tools.rs`, `src-tauri/src/agent/web/extract/tests.rs`, `src-tauri/src/agent/tools/exec/tests/support.rs`, `src-tauri/src/agent/tools/exec/tests/bash.rs`, `src-tauri/src/agent/tools/sandbox.rs`, `src-tauri/tests/skill_tools_boundary.rs`, `src-tauri/tests/worker_e2e.rs`, **plus `src-tauri/src/agent/tools/exec/tests/policy.rs`** (found in execution — 3rd Copy-move site, see Changelog) | `done` `c90f5dd` |
| T05 | Wire types + prompt store + guard-prompt UI (`value` echo, generic options) | frontend-prompt | `docs/roadmap/permissions-section-task05-wire-types-prompt-ui.md` | 1 | `src/lib/tauri/types.ts`, `src/lib/tauri.ts`, `src/lib/tauriBarrel.test.ts`, `src/lib/tauri/commands/gates.ts`, `src/store/permissions.ts`, `src/hooks/useChildGates.ts`, `src/hooks/useChildGates.test.ts`, `src/components/PermissionPrompt.tsx`, `src/components/PermissionPrompt.test.tsx`, **plus `src/components/settings/GeneralSection.tsx`** (2-line type narrowing, see Changelog) | `done` `6fd3740` |
| T02 | `PermissionOutcome::Selected { option_id, value }`, per-prompt option lists, approve predicate, drop `trust-space` from the guard prompt | permission-wire | `docs/roadmap/permissions-section-task02-wire-shape-guard-prompt.md` | 2 | `src-tauri/src/agent/permission.rs`, `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/worker/sink.rs`, `…/worker/protocol.rs`, `…/worker/client.rs`, `…/worker/core.rs`, `…/worker/manager/mod.rs`, `…/worker/manager/tests/mod.rs`, `src-tauri/src/bin/fake_worker.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/commands/sessions.rs`, `src-tauri/src/agent/mod.rs` (only if the re-export must change) — **plus ratified: `src-tauri/src/agent/session/mod.rs` (ONE `..`-pattern line only), `src-tauri/tests/worker_e2e.rs`, `src-tauri/tests/harness_loop.rs`** | `done` `140c4a2` |
| T06 | Settings → Permissions section: rules list, posture rows + trust toggle moved out of General, bash/trust copy | frontend-settings | `docs/roadmap/permissions-section-task06-settings-permissions-section.md` | 2 | `src/components/settings/SettingsPage.tsx`, `src/components/settings/SettingsPage.test.tsx`, `src/components/settings/GeneralSection.tsx`, `src/components/settings/PermissionsSection.tsx` (new), `src/components/settings/PermissionsSection.test.tsx` (new) | `done` `3cd6cfc` |
| T03 | Enforce precedence rows 1–4 at the gate and in the executor; default rule set frozen per session | gate-executor | `docs/roadmap/permissions-section-task03-gate-executor-precedence.md` | 3 | `src-tauri/src/agent/harness/loop.rs`, `src-tauri/src/agent/tools/exec/access.rs`, `src-tauri/src/agent/tools/exec/tests/policy.rs`, `src-tauri/src/agent/tools/types.rs`, `src-tauri/src/agent/tools/sandbox.rs`, `src-tauri/src/agent/harness/loop/tests/param_rejection.rs` | `todo` |
| T04 | Supervisor relay persists `allow-directory` as one rule; settings round-trip | supervisor-relay | `docs/roadmap/permissions-section-task04-relay-rule-persistence.md` | 4 | `src-tauri/src/agent/session/mod.rs`, `src-tauri/src/config.rs`, `src-tauri/src/storage/db.rs` | `todo` |
| T07 | ADR 0083 + ADR 0030 amendment, `CONTEXT.md` terms, `docs/features/` permissions page | docs | `docs/roadmap/permissions-section-task07-adrs-docs.md` | 5 | `docs/decisions/0083-*.md` (new), `docs/decisions/0030-*.md` (append amendment only), `CONTEXT.md`, `docs/features/permissions-model.md` (new) | `todo` |

**Status is exactly one of these, and each is checkable from the tree without asking anyone:**

| Value | True when |
|---|---|
| `todo` | no plan file at the Plan path |
| `planned` | plan file exists |
| `vetted` | plan file exists **and** a Changelog line records the vet round for it |
| `implemented` | the task's edits exist in the tree but are not committed |
| `done` `<hash>` | committed, gate green |

## Blockers / open questions

Empty.

## Decisions log

- **2026-10-28** — **T01's Owns set extended to 12 files** (ratifying the plan's Blocker option b). Adding
  `rules: Vec<AccessRule>` to `FilePolicy` removes its `Copy` derive, and I measured the unavoidable cost myself:
  **17 full struct literals** (14 in `src/`, 3 in `tests/`) must name the new field, plus **2 Copy-move sites**
  (`harness/loop.rs`'s per-turn refresh, `harness/loop/tools.rs`'s `ToolCtx` build) = **19 edits across 11 files**.
  The plan's figure of 19/11 is correct; the round-1 reviewer's 20 double-counted. Survivors: 7 spread literals
  using `..FilePolicy::default()` (all in `exec/tests/policy.rs`) and every scalar field read.
- **2026-10-28** — **There is NO green intermediate state; T01's 19 edits land atomically in one step.** I tested
  both phase-1 designs the plan proposed, in a scratch crate and against the real gate:
  (a) inserting `rules: Vec::new(),` before the field exists → `error[E0560]: struct FilePolicy has no field
  named rules`; (b) pre-converting the 17 literals to `..FilePolicy::default()` → compiles, but clippy emits
  `useless_struct_update` ("struct update has no effect"), which is red at this repo's 0-warning gate.
  So the plan's `## Steps:` two-phase ordering is **void** — ignore it and do the field flip plus all 19 sites in
  a single compile. This is unavoidable in any representation that puts a collection on `FilePolicy`: a Rust
  struct literal must name every field, so the blast radius is a property of the language, not of the design.
- **2026-10-28** — **Deliberate cross-wave Owns overlap, do not "fix" it:** T01 (wave 1) now owns `config.rs`,
  `harness/loop.rs`, `tools/sandbox.rs` and `exec/tests/bash.rs`, which T03 (wave 3) and T04 (wave 4) also own.
  Disjointness is only required **within** a wave, and these are strictly sequential waves, so the sets never
  collide at dispatch. T01's edits to those files are the mechanical `rules:` insertions only — no behaviour.
- **2026-10-28** — `<feature>` = `permissions-section`, taken from the spec basename per roadmap Step 0, so the
  branch is `feature/permissions-section` and NOT `feature/112-permissions-section`. The branch topic and the
  spec basename must be the same string or `finish` deletes a family that does not exist.
- **2026-10-28** — Spec's `status: approved` stays `approved`. Flipping it to `committed` would offer a
  task-list-less spec to `implement` as an executable plan. The existence of this file marks the run in progress.
- **2026-10-28** — T02 is 12 owned files, over the 8-file ceiling, merged deliberately: adding `value` to the
  `Selected` variant breaks every match site (`gate.rs`, `worker/core.rs`, `worker/protocol.rs`,
  `worker/client.rs`, `session/mod.rs`) plus the two verbatim three-option fixtures (`permission.rs`'s builder,
  `worker/sink.rs`'s frame test) and `bin/fake_worker.rs`. Splitting it would end a task on a non-compiling
  commit, and one compilation unit means that poisons the entire gate. Watch its implementer for compaction; if
  it compacts, split at a file-set boundary rather than re-running the same oversized dispatch.
- **2026-10-28** — Two spec gaps found by the pre-cut inventory, both assigned rather than left implicit:
  (a) `tools/sandbox.rs` is a **third** consumer of `boundary::protected_dirs()` (confined `bash`), which the
  spec's "gate and executor" framing does not mention → T03 must decide what rules mean there, since the spec
  says rules never apply to `bash`; (b) `AgentLoop::new` freezes `protected` once per session, so the default
  rule set must be frozen the same way or the gate and the executor disagree mid-session → T03.
- **2026-10-28** — `PermissionPrompt` is not a Rust struct: the prompt payload is a `serde_json::json!` literal
  in `agent/permission.rs` with a second verbatim copy in `worker/sink.rs`'s frame test. Any "add a field to the
  prompt" step has two edit sites, not one.
- **2026-10-28** — `commands/sessions.rs` (the `respond_permission` Tauri command wrapper) is owned by T02, not
  T04: it is a pass-through of the same DTO the shape change touches, so it belongs with the shape, not with
  the persistence. If it turns out to need no edit, T02 simply does not touch it.
- **2026-10-28** — Triage of the wider backlog found six other open issues (#118, #108, #104, #101, #79, #28).
  They are **not** in this run: none is an approved block, and #101/#104 hang off this spec's output — they were
  filed from it. Do not widen this slice to include them.

## Changelog

One line per task: hash, what shipped, gate numbers at that moment.

- `a17ba4b` — **gate baseline**: all legs green (see Gate section). No task shipped.
- **VET round 1, T01** (`task01-rule-model-resolver.md`): REVISE. Reviewer found a real design defect — ranking
  by `component_count` ties on sibling paths (`/tmp` vs `/tmpfoo`, both 2 components), so a non-prefix rule wins
  by list order and longest-prefix is silently defeated. Also flagged the `Copy` blast radius, the unpinned
  concat order, and the empty-home limit. All applied in round 2; the algorithm is now
  filter-by-component-prefix → rank → tie-break-last-wins, with the `/tmpfoo` and `~`-vs-`/` pins added.
  Two of the reviewer's own claims were checked and found wrong (the `Path::new(&r.path)` mechanism; "6 spread
  literals" — it is 7), and the plan says so in place rather than silently relabelling.
- **VET round 2, T01**: refined in place. Remaining Blocker (the `Copy` ordering) resolved by the orchestrator,
  not the planner — see the two Decisions entries on the Owns extension and the absence of a green intermediate.
  Now `vetted`.
- **VET round 1, T05** (`task05-wire-types-prompt-ui.md`): PASS with issues. Reviewer confirmed the load-bearing
  claim — `PermissionPrompt.tsx` is the ONLY place an option becomes a wire object, so the single S4 edit covers
  the subagent path too. Fixed in round 2: wrong wire-casing prose (`selected` is the wire key, `option_id`/`value`
  are fields inside it), a tautological backward-compat pin (`toHaveBeenCalledWith` is asymmetric equality and
  passed even if the conditional spread were dropped — now `toStrictEqual` on the raw argument), the barrel needs
  ONE literal array not two, and a triage note for the four unowned files (`App.test.tsx`, `ChatStream.test.tsx`,
  `InlineGateRow.test.tsx`, `SubagentModals.test.tsx`) that seed `optionId: "allow"` fixtures and query by the
  name "Allow". Now `vetted`.

- **Wave 1 IMPLEMENTED + GATED.** T01 `c90f5dd`, T05 `6fd3740`. Gate at `6fd3740`, all six legs green:
  `cargo test` **1597 passed / 0 failed / 4 ignored** (baseline 1581 → +16 new Rust tests); `clippy --all-targets`
  **0 warnings**; `fmt --check` clean; **`cargo check --target x86_64-pc-windows-gnu --all-targets` clean** (first
  baseline for that leg); `pnpm test` **153 files / 3240 tests** (count unchanged — T05 renamed and strengthened
  rather than added); `pnpm build` green. The 4 ignored are all pre-existing manual/live-network tests, verified
  by name — none is ours.
- **Wave 1 deviations, all accepted and committed:**
  - **The `Copy` blast radius is 20 sites, not 19.** `exec/tests/policy.rs`'s
    `read_beyond_the_boundary_succeeds_when_reads_allow` passes one `FilePolicy` local
    through the by-value `ctx_policy()` helper twice — legal under `Copy`, a use-after-move (E0382) without it.
    Its *literals* survive (they use spreads); it is a third Copy-move site, and the file was outside T01's set.
    Accepted: same kind as the two already owned, one line. **Corrected figure: 17 full literals + 3 Copy-moves
    = 20 sites across 12 files.**
  - **`GeneralSection.tsx` needed 2 lines** (`keyof FilePolicy` → `"reads" | "writes" | "shell"`). Adding
    `rules?` made the index return `AccessPolicy | AccessRule[]`, a `pnpm build` blocker. Type-only. T05's plan
    Note D claimed no unowned file churns from the type change — that was wrong, and the implementer caught it,
    proved causation by toggling the field, and refused to edit the file itself.
  - **An `#[ignore]`d pin was deleted.** `default_rules_is_empty_when_the_home_dir_cannot_be_resolved` can never
    pass: unix `home_dir()` falls back to the passwd DB, so removing `HOME`+`USERPROFILE` still resolves
    `/home/<user>`. I confirmed it myself — `--ignored` FAILS red. It was a landmine for whoever ran `--ignored`
    next. The honest limit stays recorded on `default_rules()`, and the reachable consequence is now pinned
    instead (`an_empty_rule_set_matches_nothing_so_the_posture_select_decides`).
  - **A coverage gap the plan missed, now pinned.** Replacing component-wise `starts_with` with string
    `starts_with` — the exact bug the plan forbids twice — left ALL tests green. I verified the divergence is
    reachable in a scratch crate (`/a/bc` is a strict string prefix of `/a/bcd/x`, not a component prefix). New
    pin `a_rule_dir_that_is_only_a_string_prefix_of_the_target_matches_nothing` is the unique discriminator
    (mutation-tested: exactly that one test reddens).
  - **`a_tilde_rule_and_a_slash_rule_tie_at_one_component_and_last_wins` mis-pins its own premise**: a scratch
    `$HOME` is 3 components, not 1, so `~` beats `/` on longest-prefix, not on the tie-break. Test kept (it still
    pins that both spellings reach the path); its doc now says what it actually proves. A genuine `~`/`/` tie
    needs `HOME=/`, which no scratch fixture can be. `an_exact_tie_...` is the only real exact-tie pin.
- **2026-10-28** — `pnpm test -- <path>` does NOT scope — the filter leaks and the whole suite runs. Both the
  grounding report and the T05 plan recommended it. Use `npx vitest run <path>`. Corrected in the grounding
  report; do not re-recommend the `pnpm` form.
- **2026-10-28** — T01's plan doc is stale on one point: it still names the deleted
  `default_rules_is_empty_when_the_home_dir_cannot_be_resolved` pin in three places. Harmless (the plan is a
  historical artifact deleted on ship), noted so nobody re-adds the unpassable test from the plan text.

- **VET round 1, T02** (`task02-wire-shape-guard-prompt.md`): REVISE, two real catches. (a) The plan's
  construction sweep missed `tests/worker_e2e.rs::permission_round_trip_real_worker` and
  `tests/harness_loop.rs::tool_call_gates_executes_loops_and_settles` — both CONSTRUCT `Selected`, neither is
  compiled by `cargo test --lib`, so the plan's own full-suite step was guaranteed red. (b) `#[serde(default)]`
  alone serializes `None` as `"value": null`, contradicting the plan's own byte-shape pin — the pair
  `#[serde(default, skip_serializing_if = "Option::is_none")]` is now stated everywhere. Round 2 also named the
  T03 handoff as a LOUD PIN (`a_guard_allow_directory_runs_the_tool`) instead of a comment, and settled
  `pub(crate)` cannot reach the `fake_worker` bin crate (fixture keeps its literal).
- **2026-10-28** — **Ratified T02's Owns extension**: `session/mod.rs` (the one `Selected { option_id, .. }`
  destructure line, no logic — the relay itself stays T04's), plus `tests/worker_e2e.rs` and
  `tests/harness_loop.rs` (mechanical `value: None`). Cross-wave overlap with T04 is harmless — disjointness is
  a within-wave requirement and these are sequential waves.
- **VET round 1, T06** (`task06-settings-permissions-section.md`): narrow REVISE. Critical: the plan's own
  one-save pins could not see a two-write interleaving (posture save + rule save composing from the
  last-rendered document through `patch`'s pinned compose). Round 2 adds the two-write pin, names the two moved
  sandboxed tests that must carry their own `getAppInfo("windows")` overrides (verbatim copy would red), decides
  the default-rules offer re-appears on an empty list (accepted + pinned), and RE-WORDS the Writes disclosure
  now rather than moving an overclaiming pin verbatim to be un-pinned later.
- **2026-10-28** — **SPEC DEVIATION to carry to #112 and T07**: the spec says the three default rules are
  "written only on first write"; no first-write mechanism exists anywhere in the settings path (no save
  history, no version marker; Rust's missing-file branch is not surfaced to the UI) and the wire cannot
  distinguish empty from absent rules. T06 ships an explicit user-visible "Add default rule" button that
  pre-fills the DRAFT (no write until the user saves the dialog) plus panel copy naming all three defaults.
  No automatic write is possible, so no install silently gains the one real restriction. This is a deviation
  from the spec's letter, recorded deliberately, not a silent substitution.

- **Wave 2 IMPLEMENTED + GATED.** T02 `140c4a2`, T06 `3cd6cfc`, barrel-pin fix (see Changelog head). Gate:
  `cargo test` **1603/0/4-ignored** (+6), clippy **0**, fmt clean, mingw clean; `pnpm test` **154 files / 3252
  tests**, `pnpm build` green. `session/mod.rs` boundary held: one `..` destructure + the authorized comment,
  zero logic (verified by diff before commit).
- **Wave 2 failure mode, exactly as the protocol predicts:** both children reported DONE with green scoped
  tests; the full suite disagreed. `tauriBarrel.test.ts`'s mocker-count pin (a file nobody touched, whose
  input changed) read 37 vs pinned 36 — the new `PermissionsSection.test.tsx` legitimately mocks the barrel,
  and the pin's own comment says the number moves only "in a commit that says so". Fixed by re-dispatch
  (never hand-typed): 36→37 and 35→36 measured, running comment extended in its chain style, sole
  non-spreader named. T06's reviewer had scored this file "stays green" — right about the API lists, wrong
  about the mocker census. Lesson for T07's reviewer: this file counts test FILES by mock idiom, not exports.
- **Execution corrections to the plans:** the scoped filter for the loop tests must be the substring
  `policy_gate` — `harness::loop::` matches nothing because `loop` is a keyword (`r#loop` in the real path);
  T02's `client.rs` `value: Some` round-trip is unobservable there (the oneshot answers a canned object), the
  crate-wide pin lives in `protocol.rs`; T06's `saveRule` needed `replaces?:` identity-passing because
  `draftToRule` makes a fresh object and the plan's `findIndex(r === rule)` appended instead of replacing.
- **2026-10-28** — Wave 3 re-grounding required before planning T03: wave 2 edited `harness/loop/gate.rs`
  (predicate + seam comment), which is inside the gate-executor area; `supervisor-relay`'s `session/mod.rs`
  also moved. Re-ground both at the wave-2 commits, not at `a17ba4b`.
