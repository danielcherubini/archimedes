---
status: planned (round 3 — spec-reading correction; supersedes the blocked round-2 plan)
done-when: "The precedence table of `docs/roadmap/permissions-section.md` is enforced in `policy_verdict` (rows 1–4) and in the write executors (rows 1–2) through ONE resolver, `rule_for`, with the concatenation contract (`default_rules()` FIRST, user rules SECOND — never inverted); the WRITE TARGET IS RESOLVED ONCE — the executor's `FsBackend::resolve` under the `write_backend(ctx)` roots is the binding resolution, the gate's guard arm derives the ancestor from the SAME resolved value through `fs_backend::canonicalize_lenient` (ADR 0081's lenient canonicalizer, NOT strict `canonicalize`), and the emitted guard `path` is CANONICAL so a persisted rule is something `rule_for` can match (pinned by `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches`; an absent/empty `path` is handled the way the sibling helpers default it — a `find`/`grep`/`ls` absent path is the `cwd` (`"."` in `exec_find`/`exec_grep`/`exec_ls`), a `write`/`edit` absent path is the existing early-`Allow` arm — and never reaches a guard ask); the guard ask reuses the `Decision::Ask` → `gate_tool` corridor and emits `permission_options(false)` with the REAL nearest-existing-ancestor path replacing the `""` placeholder, `gate_tool`'s approve predicate accepts `allow-directory`, and the loud pin `a_guard_allow_directory_runs_the_tool` lands (protected write → guard ask → `answer_permission(session, \"allow-directory\", value: Some(<the emitted canonical path>))` → the tool RUNS, failing loudly if the predicate or wiring is wrong) together with its trusted-Space variant (same drive on a trusted Space: no prompt, write lands); **the spec-reading correction (round 3, mandated reading A): `default_rules()` no longer emits `Write`/`Deny` for the four agent dirs — it returns the SPEC'S THREE PRE-FILLED DEFAULTS, EMPTY, or (settled below) the exact shape this plan decides, with the four dirs moved OUT of the rule set into a separate guard-membership set; the four dirs are NO LONGER default-deny rules, so a write into one at the default posture with no user rule is the ROW-3 ASK (never a silent `Deny`); `protected_dirs()` MUST keep returning the same four canonical paths it returns today — its own list / `guard_dirs()`, NOT a rule-derived view — so `sandbox.rs`'s Landlock subtraction is UNCHANGED (rules never apply to `bash`; DD2 stays true); the executor's unconditional `protected_refusal` becomes RULE/guard-driven — under an untrusted Space a guard hit produces the ASK (not a refusal), under a Trusted Space it proceeds silently, a USER deny rule refuses with the protected wording; `protected_refusal_text`'s wording survives for the deny case;** rules are frozen `default_rules() ++ per-turn user rules` with the concat made ONCE per turn (the per-turn `rules` field holds `Vec::new()` until the first `handle_prompt`, at which point the concat first runs); a `~`-named rule with `ToolCtx.home = None` matches NOTHING while the same rule with a real home matches and decides (pinned — the `ToolCtx.home` doc states `None` means exactly that); the sandbox's Landlock subtraction continues to use `boundary::protected_dirs()` (the four-dir plain list, NOT default-deny-rule-derived — a user `allow` rule can NEVER widen confined `bash`, pinned load-bearing: `protected_dirs()` is unchanged by a user allow AND a confined `exec_bash` whose `ctx.rules` carries the user allow still cannot write the protected dir; `Sandbox::create` KEEPS its `(cwd) -> Result<Self, String>` signature — `tools/exec/bash.rs:156` is its ONLY call site and stays untouched; **bash.rs remains UNOWNED**: DD2 says no signature change and no rule consult in the shell, so T03 makes zero edits there); gate and executor consult the SAME resolver (one canonicalizer — ADR 0029/0030; quoted and honoured); the crate compiles (`cargo build --all-targets` — `fake_worker` and `tests/` included), `cargo test`, clippy `--all-targets` 0 warnings, fmt clean, mingw `cargo check --target x86_64-pc-windows-gnu --all-targets` clean."
parent: docs/roadmap/permissions-section.md
---

# Plan — T03: enforce precedence rows 1–4 at the gate and in the executor; wire the guard ASK; land the loud pin

> **ROUND 3 — this is a refinement in place of a BLOCKED round-2 plan.** The implementer proved a real defect (0 of 16
> measured cases reach row 3) and the orchestrator resolved it by mandating **reading (A)** of the spec. This plan
> incorporates the correction and the orchestrator's ratification of the owned-file set. Previous rounds' architecture,
> DD1, the single-canonical-resolution fix, the loud pin, and the Honest-limits voice survive **unchanged**; the 
> corrected pieces are marked with the callout boxes. Read the [resolution entry](#the-ruling-reading-a-mandated) before
> the body: every structural decision below is justified against the spec quotes it records.

**Goal:** Make rows 1–3 of the spec's precedence table real code: rule `deny` and rule `allow` in the gate verdict AND
the write executors (via `rule_for`, shared), and the no-rule + under-an-agent-dir case become an ASK through the
existing `Decision::Ask` → `gate_tool` corridor, emitting the guard option list with a real resolved path (`value`)
and accepting `allow-directory` in the approve predicate. Row 4 (no rule → posture select) is today's `decision_for`
fall-through and stays. **The four agent-definition dirs are a GUARD-MEMBERSHIP set, not a rule set** — reading (A)
of the spec (see the ruling box below). Then add the load-bearing pins: the loud pin
`a_guard_allow_directory_runs_the_tool` (with its CLICK spelled — `answer_permission(session, "allow-directory",
value: Some(<the emitted canonical path>))` — plus the trusted-Space variant), rule-deny-on-a-trusted-Space,
guard-prompt end-to-end shape, gate-side not-yet-existing-dir match, the default-posture **ask** pins (converted from
the old "refused under EVERY policy" pins — the churn the spec predicted), the `~`-ancestor-rule_for-match seam pin,
the `home: None` consequence pin, the read-not-ask pin, and the sandbox non-widening pin (load-bearing).

**Architecture:** One shared resolver (`policy::rule_for`) consulted by the gate (`harness/loop/gate.rs`) and the
write executors (`tools/exec/fs_tools.rs` via `access.rs`), reading a rule list carried on `ToolCtx`; the default half
frozen in `AgentLoop::new`, the user half per-turn by Deviation 4, concatenated ONCE per turn in `handle_prompt`
(contract: defaults FIRST, user SECOND). **The write target is resolved ONCE**: the executor's
`FsBackend::resolve` under the `write_backend(ctx)` roots (`exec_write`/`exec_edit`, bound BEFORE
`protected_refusal`) is the binding resolution; the gate's guard arm derives BOTH the rule-for decision and the
guard ancestor from the SAME resolved value, through the ONE canonicalizer (`fs_backend::canonicalize_lenient` —
ADR 0081's lenient peel, NOT strict `canonicalize`, whose failure on a not-yet-created dir is what the leniency
exists to absorb). The guard's `value` is the nearest-existing-ancestor of the resolved write target; it is CANONICAL
(never a `~` residue), so the persisted rule is something `rule_for` can match. The sandbox keeps subtracting
`boundary::protected_dirs()` (the four-dir plain list — the guard-membership set) — rules never reach it, and
`Sandbox::create` keeps its `(cwd) -> Result<Self, String>` signature (its only call site, `tools/exec/bash.rs:156`,
needs ZERO edits).

---

## The ruling — reading (A), mandated; quote, then decide

The spec resolves the blocked contradiction itself; **reading (A) is the correct and now-mandated reading**:

- Spec, "The prompt → Precedence" (line ~45): **"Step 3 is the only behavioural change in this spec**: today's
  hardcoded deny becomes an ask." A `Deny` default for the four dirs means the deny stayed a deny and that sentence is
  false. Keeping the unconditional deny ships the exact defect the spec exists to fix (the refusal was SILENT).
- Spec, "Settings → Pre-filled defaults": the table lists **exactly THREE rules** — `~` readWrite `allow`, `/` read
  `allow`, `~/.pi/agent` read `deny` — **none of them an agent-definition dir**. So the spec's "default rule set" is
  NOT the four dirs.
- Spec, "Honest limits" accepts the consequence TWICE: "Trust suppresses the guard. A Trusted Space permits silent
  self-modification" and the shipped Settings copy "A trusted Space's agent can also write its own instruction
  directories without asking".
- **Consequence (measured by the implementer, verified by the orchestrator):** `boundary::protected_dirs()` is
  `default_rules().filter(|r| r.decision == Deny).map(canonicalize_lenient)`, and `push_default` shapes the four agent
  dirs as `Write`/`Deny`. So the guard-membership set (row 3's trigger) and the default DENY set are the SAME paths
  under the SAME prefix predicate. Row 3 ("no rule matches AND under an agent-definition dir") is therefore `A AND
  NOT A`: **0 of 16 measured cases** across four dirs × four nesting depths reach it. Both escape hatches fail
  empirically — an exact-tie user `allow` lands on row 2 (silent, no ask), a broad `~` allow loses to the longer
  default-deny prefix (row 1), and `is_guard_path` has no fifth member to sit outside. T02's guard option list,
  T04's relay, and the whole `allow-directory` flow would be dead code.

**What the mandate requires of this plan** (the round-3 change directives, each with its resolution):

1. **`default_rules()` stops emitting `Write`/`Deny` for the four agent dirs.** (Decided below — D1.)
2. **The four dirs become a guard-membership set that is NOT a rule set.** `protected_dirs()` MUST keep returning the
   same four canonical paths it returns today — `sandbox.rs`'s Landlock subtraction consumes it, and DD2 stays true
   precisely because this list stops being rule-derived. `protected_dirs()` goes back to being its own list (the four
   literal dirs through the `skills::user_roots`/`agents::user_roots` feeders), and `is_guard_path` consumes THAT
   list — so row 3 is reachable **by construction** (pin: `policy_verdict == Some(Decision::Ask)` for a plain
   agent-dir write at default posture, untrusted Space).
3. **The executor's unconditional `protected_refusal` becomes rule/guard-driven.** Under an untrusted Space a guard
   hit must produce the ASK, not a refusal; under a Trusted Space it proceeds silently; a USER deny rule refuses with
   the protected wording. `protected_refusal_text`'s wording survives for the deny case.
4. **The churned pins are re-specified honestly** — T01's pins asserting "a protected write is refused under EVERY
   policy" change meaning; each is named below by its test name and what it now asserts.
5. **One authoritative owned-file list and one complete `ToolCtx` construction-site census** — reconciling the
   dispatch's ratification (ALL of: `loop/turn.rs`, `exec/fs_tools.rs`, `exec/search.rs`, plus `agent/policy.rs`,
   `agent/boundary.rs`, and `src-tauri/tests/skill_tools_boundary.rs` with its **2** missed `ToolCtx` literals) with
   the round-2 `## Files` that claimed ratification the dispatch never granted.
6. **`stash@{0}` is recoverable** — it holds the `ToolCtx` `rules`/`home` fields, the frozen
   `default_rules`/`rules_home` on `AgentLoop`, the per-turn concat, and mechanical literal churn — plumbing that
   survives the correction. The implementer should RE-APPLY it, not re-derive it, and NOT pop it blindly (it predates
   the correction — its `default_rules()` semantics are the pre-correction deny-floors).

---

## D1 — what `default_rules()` returns now (the decision the mandate demands)

**Decision: `default_rules()` returns an EMPTY `Vec`.** The spec's three "pre-filled defaults" are NOT code defaults:
the spec says they are **"written only on first write"** so an existing install never silently gains a restriction —
and T06 shipped that as a user-visible draft-prefill button in the Settings UI, not as `policy.rs` code. The four dirs
move to a separate guard-membership function (`boundary::protected_dirs()` keeps its exact four-path output, but its
derivation is no longer `default_rules().filter(Deny)` — D2).

Why empty, over the two alternatives:

- **(i) Return the spec's three pre-filled rules as code** (`~` rw `allow`, `/` read `allow`, `~/.pi/agent` read
  `deny`). REJECTED: the "written only on first write" clause is a UI-side draft-prefill the settings does on write,
  not a runtime code default. Making them code defaults would (a) contradict "an existing install never silently
  gains a restriction" (the third rule, `~/.pi/agent` read `deny`, IS a genuine restriction — the spec's own table
  labels it "the one genuinely new restriction" and says the row "can be deleted, so it never reads as hidden
  behaviour"), and (b) force `rule_for` to evaluate three rules on every call against nothing the executor needs —
  the two `allow` rows are explicitly "**nothing** — the executor floor is already `[\"/\"]`" and "**nothing** — same
  reason". They only exist to make the rules panel honest, which is T06's job, not T03's.
- **(ii) Keep the four `Write`/`Deny` floors as `default_rules()`** and let `is_guard_path` consume a different set.
  REJECTED — this is what the block proved: it makes row 3 `A AND NOT A` (the guard set and the default deny set
  become the SAME paths under the SAME prefix; a plain agent-dir write matches a default deny → row 1, never the ask),
  ships the silent-deny defect the spec exists to fix, and makes the "Step 3 is the only behavioural change" sentence
  false.
- **(iii) EMPTY — chosen.** `default_rules()` returns `Vec::new()`. The four dirs are a guard-membership set on
  `boundary::protected_dirs()` (D2). Consequence, stated plainly in `default_rules()`'s doc: the count pin
  `default_rules().len() == 4` no longer holds — it is `0` — and `an_empty_rule_set_matches_nothing_so_the_posture_select_decides`
  (T01's boundary test, `boundary.rs::an_empty_rule_set_matches_nothing_so_the_posture_select_decides`) now describes
  the DEFAULT posture, not just a no-home edge: at defaults `rule_for` answers `None` for an agent-dir write and the
  caller falls to row 4 (posture select) → for an untrusted Space a plain agent-dir write is the **row-3 ASK**. That
  is the behavioural change the spec names. `an_empty_rule_set_matches_nothing…` itself does NOT change — it asserts
  `rule_for(&[], …) == None`, which is still exactly true; only its doc comment gains the sentence that the empty
  set is now the DEFAULT, not a no-home edge.

The T01 `done` status survives as-measured-against-T01 (T01 implemented the ambiguous "protected_dirs becomes the
default rule set" clause literally); this is a **spec-reading correction**, not a T01 defect, so T03 owns the
correction in `policy.rs` and `boundary.rs` (both ratified into T03's owned set — see `## Files`).

---

## D2 — `protected_dirs()` returns the four dirs as its own list; `is_guard_path` consumes it

**The four dirs are a guard-membership set, not a rule set.** `protected_dirs()` MUST keep returning the exact four
canonical paths it returns today (`~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents`)
because:

- **`sandbox.rs`'s Landlock subtraction consumes it** (`rule_write_root(&dir, &protected, …)` — the 
  `cwd`-inside-a-protected-dir case, the `cwd`-containing-a-protected-dir carve-out, both canonical-compare against
  this list). If the list came from `default_rules().filter(Deny)` and `default_rules()` stopped emitting the four
  dirs, the subtraction would silently contain NOTHING and a confined `bash` could write the agent's own instructions
  — the exact escape DD2 exists to forbid. DD2 stays true **precisely because this list stops being rule-derived**:
  it is back to being its own list of the four literal dirs.
- **`is_guard_path` consumes THAT list** — the row-3 membership check is `self.protected.iter().any(|root| resolved.starts_with(root))`.
  Since the guard set and the default-deny set are now DIFFERENT sets (the guard set is `protected_dirs()`; the rule
  set is whatever `default_rules()` ++ user rules is — empty at defaults), row 3 is reachable **by construction**:
  at defaults, `rule_for(&[], Write, target-in-an-agent-dir, …) == None` AND `is_guard_path == true` → `Decision::Ask`.
  Pinned by the loud pin's row-3 precondition and by `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny`.

**Implementation shape (`boundary.rs`):** `protected_dirs()` reverts to a NON-rule-derived function over the same two
feeders, preserving its exact current output and its leniency:

```rust
/// The write GUARD-MEMBERSHIP list (ADR 0030, D3-as-corrected): the four
/// user-level discovery dirs — `~/.agents/skills`, `~/.pi/agent/skills`,
/// `~/.agents/agents`, `~/.pi/agent/agents`. A write whose resolved path is
/// under one of these, with NO rule matching, is the ROW-3 ASK (the guard
/// prompt) — NEVER the silent hardcoded deny of ADR 0030 as-built (reading A
/// of the permissions spec: "Step 3 is the only behavioural change").
///
/// NOT a rule set: this list feeds (a) `is_guard_path` (the gate's row-3
/// membership), (b) the executor's guard hit, and (c) the Landlock
/// subtraction — and it is what `sandbox.rs` consumes, so it is kept as a
/// PLAIN four-path list (never derived from `default_rules()`, or a rules
/// change could silently widen confined `bash`). User rules NEVER apply to
/// `bash`, and a user `allow` rule for one of these dirs NEVER drops it from
/// this list / never widens the sandbox.
pub fn protected_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    push_protected(&mut out, crate::skills::user_roots());
    push_protected(&mut out, crate::agents::user_roots());
    out
}
```

(`push_protected` is the four-dir feeder: canonicalize each root LENIENTLY — keep a missing dir as its canonical
nearest-existing ancestor plus its trailing components, exactly the issue-#92 behaviour `protected_dirs_keep_a_missing_dir`
pins, and keep a fully-unresolvable entry raw, exactly `protected_dirs_keeps_an_unresolvable_entry_raw` pins. This
restores T01's deleted `push_protected` (or an equivalent private helper) — T01 removed it when it made
`protected_dirs()` rule-derived; the correction brings it back. Order is preserved: skills two first, then agents two.)

`rule_for`'s own `default_rules()` callers — the gate and executor still hand `self.rules`/`ctx.rules` to it; with
`default_rules()` empty, an agent-dir write with NO user rule matches `None` → row 4 → the GUARD arm fires (the specs'
"no rule → posture select" row, where the guard membership makes the posture select an ask). The `policy.rs`
`default_rules()` doc is rewritten (empty — why, and the honest limit that the "defaults-then-user concat" contract
now begins with an empty foundation).

**`is_guard_path` consumes the `protected_dirs()` list (S2.3).** The `protected` field on `AgentLoop` and `ToolCtx`
ALREADY is `protected_dirs()` frozen at `new` — so `is_guard_path` needs no new field, it reuses `self.protected`
exactly as the gate's `deny_tool_result` and the executor's `protected_refusal` already do.

---

## The two design decisions and why

### DD1 — What the gate and executor evaluate against (the freeze matrix) — UNCHANGED

**Decision: freeze `default_rules()` at `AgentLoop::new`; concatenate `defaults ++ user rules` ONCE per turn in
`handle_prompt`; carry the concatenated list + the home on `ToolCtx` per call.**

The freeze matrix (grounding §3): `read_boundary`/`protected` freeze at `AgentLoop::new`; `file_policy` (with the user
`rules`) re-reads per turn; `ToolCtx` has neither `home` nor `rules`; `rule_for` needs both. Option (A) — freeze the
default half and per-turn concat — matches the task brief's "default rule set frozen per session" and the spec's
"effective next turn" promise (per-turn rule edits land next turn, exactly like `reads`/`writes`/`shell` under
Deviation 4). Option (B) — derive `default_rules()` per verdict — re-canonicalizes paths and re-reads `$HOME` on
every policed call and contradicts "frozen per session". **(A) is the cheap correct-enough fix**: one concat per turn,
no new `$HOME` reads after `new`, and a user rule edit lands next turn with no restart. The cheaper still — carrying
only `file_policy` and re-deriving the default half in `rule_for` per call — is REJECTED: it repeats the `$HOME`
canonicalization on every `policy_verdict` and every write, and it silently un-freezes a layer the brief freezes.
(With `default_rules()` EMPTY per D1, the freeze is now trivial-the-default-half — the concat is `file_policy.rules`
into an init-empty vector — but the field, the single `$HOME` read for `rules_home`, and the ONCE-per-turn discipline
stay, because a user rule edit must land at the next prompt and every call in a turn must agree.)

The concat is done ONCE per turn, next to the existing `file_policy` re-read in `handle_prompt`, not per call: the
gate and the executor then see the SAME list for the whole turn — what "every tool call in a turn must agree"
(Deviation 4, pinned) demands. The concat ORDER is the load-bearing contract:
`self.default_rules.clone() ++ self.file_policy.rules.clone()` — defaults FIRST, user SECOND. Pinned in BOTH orders
by T01's own test (`an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`); the executor will
see it as one new gate-level test asserting the ORDER of the `AgentLoop::rules` field (defaults then user), and the
round-trip `allow-directory` equivalent through the REAL loop (the next-turn rule beats the default deny — still the load-bearing order contract even with `default_rules()` empty, because it pins how an appended user rule beats any T06-prefilled default the user set).

**`ToolCtx` gains exactly TWO fields** (see `tools/types.rs` below, names final):

- `pub rules: Vec<crate::agent::policy::AccessRule>` — "The concatenated rule list (defaults first — the
  CONCATENATION CONTRACT of `default_rules()` — then user rules; frozen defaults + per-turn user half). Every
  consumer (the gate's twin in the executors) hands this SAME list to `rule_for`, never a partial one. Hermetic in
  tests: an EMPTY list means no rules, exactly the semantics `rule_for(&[], …) == None`."
- `pub home: Option<std::path::PathBuf>` — "The home dir `rule_for` expands a leading `~` against (the crate's
  `skills::home_dir()` chain, exactly what `default_rules()`/`protected_dirs()` go through). **`None` = no home:
  `rule_for`'s `expand_rule_path` expands nothing, so a `~`-named rule matches NOTHING — a `~` rule is a silent
  no-op (never wider than the rules present); with a real home the SAME rule matches and, appended after the
  defaults, beats a default deny. `None` is what every direct `ToolCtx` construction in the test fixtures passes
  (the `home` pin, S6)."**

**Every `ToolCtx { … }` literal in the tree, and who owns each** (the complete construction-site census — the
round-2 census listed 7 sites and missed 2; this is the reconciled, authoritative list, verified on the tree at HEAD
`cd7553e`):

| Site | File | Churn kind (owned by whom) |
|---|---|---|
| `dispatch_tool` production build | `harness/loop/tools.rs` — **OWNED (T03)** | add `rules: self.rules.clone(),` + `home: self.rules_home.clone(),` |
| `ctx` + `ctx_policy` helpers | `tools/exec/tests/support.rs` — **OWNED (T03)** | gains `rules: Vec::new(),` + `home: None,` (the previous plan wrongly labeled this "ratified B1"; the status file's decisions log and this round's dispatch ratify it into T03's owned set) |
| `confined_ctx` helper + 4 spread literals | `tools/sandbox.rs` — **OWNED (T03)** | only `confined_ctx` names the fields (`rules: Vec::new(),` + `home: None,`); the 4 spread literals (the two `loose` at ~1546/1719 and the two `ctx` at ~1755/2012) all use `..confined_ctx(...)`, so they gain the fields for free — verify at execution |
| `test_ctx` ×2 | `agent/web/tools.rs`, `agent/web/extract/tests.rs` — **OWNED (T03)** | gains the two fields |
| 2 full literals | `tools/exec/tests/bash.rs` — **OWNED (T03)** | gains the two fields |
| `ctx_with_roots` full literal + spread-site (`ToolCtx { … }` with `..ctx_with_roots`) | `tools/exec/tests/skills.rs` — **OWNED (T03)** | gains the two fields |
| literals in the `exec/tests/policy.rs` tests + the inline `c` builds | `tools/exec/tests/policy.rs` — **OWNED (T03)** | each `ToolCtx { … }` gets `rules: …` + `home: …` |
| **`ctx` + `ctx_roots` full literals + the `let c = ToolCtx` full literal** | **`tests/skill_tools_boundary.rs` — OWNED (T03) — the 2 the round-2 census missed** | `ctx` (line ~101) and the `let c` at line ~580 are FULL literals (must name both fields); `ctx_roots` (~125) spreads from `ctx` (`..ctx(cwd, roots)`) and needs NO edit unless it overrides one of the new fields (it does not) |

The `…` `..ctx(&cwd)` spread sites (support.rs `ctx_policy`, sandbox `confined_ctx`+loose, skills.rs) get the fields
for free if they spread from `ctx`; the FULL literals (bash.rs ×2, web ×2, `exec/tests/policy.rs` tier literals,
`tests/skill_tools_boundary.rs` `ctx` + the `let c` at ~580) must name both. The rule: missing either field on a full
literal is a compile-error (the field count of `ToolCtx` changes), and missing it on a spread site is NOT — so the
spread sites need no edit unless they override `..ctx(&cwd)` (none do). **`param_rejection.rs` is owned but its
helpers build no `ToolCtx` literal — expect ZERO edits there; record the verification in `## Honest limits`.**

### DD2 — `sandbox.rs`, the third consumer (rules must never apply to `bash`) — UNCHANGED, strengthened by D2

**Decision: the Landlock subtraction keeps using `boundary::protected_dirs()` — now the four-dir PLAIN guard list (D2),
which is BY CONSTRUCTION unable to see a user `allow` rule — and `Sandbox::create` CHANGES NOT AT ALL (no signature
change, zero edit to the sandbox module's `create`/`rule_write_root`, no new field, no new param).**

Why this is the correct subtraction source, stated precisely:

- Landlock is ADD-ONLY: a `PATH_BENEATH` rule grants its rights on the fd's path AND everything beneath it, and the
  ruleset is the UNION of the rules — "there is no narrower rule that takes a right back from an ancestor"
  (sandbox.rs module doc, verbatim). The subtraction (rule the write root read+execute, every sibling read-write, the
  protected subtree never read-write) is the ONLY way the four agent dirs stay unwritable inside a confined `bash`.
- **The round-2 blocker made this load-bearing in the loudest possible way:** if the subtraction source were "whatever
  the tools see" (a rules-derived `protected_dirs()`), then the moment `default_rules()` stopped emitting the four
  `Deny`s the subtraction would contain NOTHING and confined `bash` could write the agent's own instructions. D2 fixes
  that by construction: `protected_dirs()` is its own four-path list, and a user `allow` rule for a protected dir
  DROPS NOTHING from it.
- There is NO way for a user rule to reach `boundary::protected_dirs()`: it derives ONLY from the two `user_roots`
  feeders — the user `rules` half is never an input to it. Keeping the subtraction on `protected_dirs()` means an
  allow rule can NEVER widen bash, by construction, not by enforcement.
- The cost: a confined command stays STRICTER than the path tools under an allow-rule (the shell cannot write a dir
  the tools can). That is the spec's chosen posture — the "guard-rail" and its honest limit, recorded in
  `## Out of scope` — and it is what "bash runs with your own user's OS permissions" means in practice.

The pin lives in TWO halves (see S5; both are load-bearing, neither is a tautology):

1. the sandbox module's unit test computes `boundary::protected_dirs()` with a user-rule present (an `allow` rule
   naming one of the four, under a pinned `$HOME`) and proves it is IDENTICAL to the no-user-rule result — PLUS the
   contrast half: the SAME allow rule applied to `rule_for` (as `default_rules() ++ [user_allow]`) WINS over the
   (empty-default) posture, proving "unchanged" is not vacuous (the rule genuinely changes the PATH tools, so an
   unchanged subtraction is the bash exclusion doing its job, not a dead assertion);
2. the end-to-end pin in `exec/tests/policy.rs`: an `allow` rule for a protected dir makes the WRITE TOOL succeed
   while a CONFINED `exec_bash` carrying that rule in `ctx.rules` still cannot write the dir. `Sandbox::create`
   takes ONLY `cwd` (there is no rules parameter to thread), so the observable write-refusal inside the shell is
   the executable half this pin asserts.

---

## Context: what this task is, and what it is not

Wire facts this plan builds on (grounded verbatim at `4395bed`; verified on the tree at HEAD `cd7553e`; verify
volumes on the tree, do not trust memory):

- **`policy_verdict` (gate.rs)** is the single insertion point for rows 1–3: after `beyond` is known for a
  `Read`/`Write` call, BEFORE `decision_for`. Today it computes `(policy, beyond)` and hands straight to
  `decision_for`. The rules branch applies ONLY to `Read`/`Write` calls with a usable `path`; `Shell` and the no-path
  case skip it entirely (row 4 unchanged for `bash`; rules never apply to `bash`).
- **The `Decision::Ask` corridor** (turn.rs `run_tool_batch`: `Some(Decision::Ask) => if self.gate_tool(tc, turn).await { dispatch_tool } else { "permission denied" }`). Row 3 returns `Decision::Ask`, so the corridor runs unchanged.
- **`gate_tool` (gate.rs)** calls `native_permission_gate(session_id, request_id=tc.id, title=permission_title(&tc.name, &tc.arguments), sink, pending_permissions, trust, space_cwd, turn)` and approves `Selected { option_id } if option_id == "allow" || option_id == "trust-space"`. T02's seam comment names the T03 contract: the guard ask reaches `gate_tool` only when the verdict sends a protected write to `Ask`, the prompt offers `permission_options(false)`, and `allow-directory` must become an allow id HERE. The loud pin is `a_guard_allow_directory_runs_the_tool`.
- **`native_permission_gate`** hardcodes `permission_options(true)` and takes NO path argument. The guard prompt needs `permission_options(false)` with the REAL ancestor path in `allow-directory`'s `path`. The gate call site (`gate_tool`) computes the ancestor and passes it in.
- **`permission_options(false)`** (T02) emits `allow` "Allow once" / `allow-directory` "Always allow this directory" with `"path": ""` PLACEHOLDER / `reject` "Block". The `""` is T03's to replace. `trust-space` is deliberately ABSENT (the spec's rationale is load-bearing and must not reappear).
- **The executor's unconditional refusal** (access.rs doc, verbatim): *"The DENY-LIST is not one of the things the policy moves: both executors call [`protected_refusal`] unconditionally … so a protected write is refused by the EXECUTOR in every mode — `writes: Allow` included."* That is row-3's executor-side blocker: an allow rule cannot take effect unless the executor consults rules BEFORE/A-INSTEAD-AT the `protected_refusal` call. **And after D1/D2, a protected write with NO rule matching must NOT be refused by the executor at all — it must be dispatched (the gate's ASK already decided; the executor is only the deny-list enforcement for USER denies).**
- **The one-resolver rule** (policy.rs module doc, verbatim — QUOTE IT in `access.rs`'s new doc): *"per ADR 0029/0030's one-canonicalizer rule the gate and the executor must both go through [`rule_for`], never a second matcher."*
- **The reader direction mapping** (the `find` vs `glob` note): the gate's `POLICIED_TOOLS` has `find` (no `glob`; `find` is the glob/search tool) in the `Read` group. `grep`, `ls` Read; `write`, `edit` Write; `bash` Shell.
- **`ToolCtx`** is Clone, has `cwd`, `cancel`, `skill_roots`, `boundary`, `file_policy`, `protected`, `web`, `render_requester` — NO `home`, NO `rules`.
- **`AgentLoop`** has NO stored home; `dirs::home_dir()` is read in `McpManager::new` then discarded. The crate's canonical home chain is `crate::skills::home_dir()` (`HOME` → `USERPROFILE` → `std::env::home_dir()`, `pub(crate)`), which is what `default_rules()`/`protected_dirs()` go through. T03 needs a `rules_home` field from it.
- **`AgentLoop::new`** already computes `read_boundary` and `protected` once; `handle_prompt` re-reads `file_policy` once per turn; `dispatch_tool` builds one `ToolCtx` per call with `..`-free literal fields.
- **The row-3-only edge — REWRITTEN after the correction.** With `default_rules()` EMPTY (D1), the four dirs are NOT
  covered by any default rule, so `rule_for` returns `None` for them at defaults and the gate's guard arm fires: row 3
  is the DEFAULT posture for an agent-dir write with no user rule. Row 3 no longer needs a user-rule-override or a
  future fifth dir — the membership set (`protected_dirs()`, the four dirs) and the rule set are DIFFERENT sets, so
  `rule_for == None AND is_guard_path == true` is the ordinary, reachable default case. Row 2 remains silently
  reachable when a USER allow names the dir (the ask is suppressed by the rule); row 1 when a user deny names it.
- **What T03 does NOT do:** T04 owns the relay that persists a rule (this plan only makes `value` carry a real path); T07 owns ADR 0083 / docs. No `session/mod.rs`, no `config.rs`, no frontend. **`tools/exec/bash.rs` is NOT owned — DD2 says no signature change and no rule consult in the shell, so T03 touches only its `ToolCtx` test literals in `exec/tests/bash.rs` (the production `exec/bash.rs` itself needs ZERO edits).**

---

## What to implement

### S1. `AgentLoop` gains the frozen default rules + per-turn concatenated list + home (`harness/loop.rs` — OWNED)

**Fields** (next to `protected` / `file_policy`'s docs, same doc voice; the round-2 plan's field docs survive — see
`stash@{0}` for the text — with the `default_rules` doc updated for D1):

```rust
/// (T03) The DEFAULT rule set (`policy::default_rules()` — read the D1
/// decision: with the four dirs moved OUT of the rule set into the guard
/// membership set, this is EMPTY at session start and the concat is
/// `file_policy.rules` into an init-empty vector). Computed ONCE at
/// construction exactly like `protected` (same `$HOME` read:
/// `skills::home_dir()`), frozen for the session's life. The USER half
/// lives in `file_policy.rules` (per-turn by Deviation 4); the two halves
/// are concatenated per turn into `rules`.
default_rules: Vec<crate::agent::policy::AccessRule>,
/// (T03) The home `rule_for` expands a leading `~` against — the SAME value
/// `default_rules()`/`protected_dirs()` go through, captured in `new` so no
/// per-call `$HOME` read happens. `None` = no home: a `~` rule matches
/// NOTHING (silently — `rule_for`'s `expand_rule_path` expands nothing
/// against `None`; pinned by
/// `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_matches_and_decides`).
rules_home: Option<std::path::PathBuf>,
/// (T03) The rule list IN FORCE for the current turn:
/// `default_rules() ++ file_policy.rules` (defaults FIRST — the
/// CONCATENATION CONTRACT, so an exact-tie appended user allow beats a
/// default deny), reassembled at the top of every `handle_prompt` next to
/// the `file_policy` re-read (ONE concat per turn — every tool call in a
/// turn agrees). Handed to every `ToolCtx` so the gate's twins in the
/// executors judge the SAME list.
///
/// INITIAL VALUE (before the first `handle_prompt`): `Vec::new()` — the
/// same construction-time stance as `file_policy` (`FilePolicy::default()`
/// until the first prompt; there are no tool calls before a prompt, so the
/// empty value is inert). The concat first runs at the top of the FIRST
/// `handle_prompt`, so the first turn's calls ALWAYS see
/// `default_rules() ++ user rules` — never `vec![]` when a prompt was
/// handled. The concat site therefore needs no "was a turn handled yet?"
/// branch: `self.rules = defaults ++ user` unconditionally, once per turn.
rules: Vec<crate::agent::policy::AccessRule>,
```

**`new`:** next to `let protected = crate::agent::boundary::protected_dirs();` add:

```rust
let rules_home = crate::skills::home_dir();
let default_rules = crate::agent::policy::default_rules();
```

(the two may share one `$HOME` read if `skills::home_dir()` is cheap — it IS the same chain `default_rules()` uses;
do NOT call `skills::home_dir()` twice if a single binding suffices). Init the three fields in the struct literal:
`default_rules` (empty — D1), `rules: Vec::new()` — the pre-first-turn value — and `rules_home` holds the
`skills::home_dir()` result.

**`handle_prompt`:** after the `self.file_policy = …` re-read (ONCE per turn, inside the same block, so a mid-turn
hand-edit is observed at the NEXT prompt):

```rust
// (T03) The rules in force for this turn: the frozen defaults FIRST,
// the user rules SECOND — the CONCATENATION CONTRACT of `default_rules()`
// (an exact-tie user allow must beat a default deny). ONE concat per
// turn, so the gate and the executor judge the SAME list all turn.
self.rules = {
    let mut rules = self.default_rules.clone();
    rules.extend(self.file_policy.rules.iter().cloned());
    rules
};
```

The concat is UNCONDITIONAL (no "first turn?" branch): `self.rules` starts as `Vec::new()` in `new` (S1's field
doc) and is overwritten here on every prompt, so after the FIRST prompt it is never the empty init again. The
executor-side gate's twin reads `ctx.rules` — the value `dispatch_tool` copies from `self.rules` — so the
per-turn field's pre-first-turn state is what any hypothetical pre-prompt call would see; there are none, but the
doc makes the invariant explicit so the concat site is unambiguous.

(*Recoverable from `stash@{0}`: this whole S1 — fields, `new` bindings, init, concat — is in the stash verbatim
except the `default_rules` doc line. Re-apply, do not re-derive; do not pop blindly — see `## Recoverable work`.*)

### S2. `gate.rs` — `policy_verdict` consults `rule_for` (rows 1–3); `gate_tool` computes the ancestor and emits the guard list; the predicate accepts `allow-directory` (OWNED)

**S2.1 `policy_verdict`** — insert after `beyond` is computed for `Read`/`Write`, before the `trusted`/`decision_for`
towards the end. The path-param arm binds `resolved` ONCE (the ONLY path resolution this task adds):

```rust
let policy = self.direction_policy(dir);
let beyond = self.beyond_error(dir, Path::new(raw)).is_some();
// (T03) THE binding resolution: `raw` comes from the `let Some(raw) =
// …` arm BELOW — see the missing-path rule at the end of this block.
// The write target is resolved ONCE, the SAME way the executor
// resolves it (`FsBackend::resolve` under the `write_backend(ctx)`
// roots = `canonicalize_lenient` on the raw candidate — ONE primitive,
// ADR 0081, so this value and the executor's `&resolved` are THE SAME
// PATH). NOT strict `Path::canonicalize`: a not-yet-created dir FAILS
// strict canonicalization — the silent no-op ADR 0081 / issue #92
// exist to close. Emitted guards carry THIS value (S2.2) so a rule
// that T04 persists from an `allow-directory` click comes back to
// `rule_for` in a form it can match.
let resolved = crate::agent::fs_backend::canonicalize_lenient(Path::new(raw));
(policy, beyond, resolved)
```

- The `if let Some(raw) = tc.arguments.get("path").and_then(|v| v.as_str()) else { return Some(Decision::Allow) }`
  arm (the existing code) stays: a `write`/`edit`/`read` whose `path` is ABSENT or `Some("")` falls to this
  `else` — `return Allow` BEFORE `rule_for`, `is_guard_path`, or any guard arm. That is the "no usable path"
  handling this task keeps (the gate's existing rule — a malformed call is not a policy event — and
  `deny_tool_result`'s `None` arm's sibling; the executor's own missing-parameter refusal still fires, ungated).
  A `find`/`grep`/`ls` whose `path` is ABSENT gets `"."` before this branch's raw fetch in the EXECUTOR
  (`exec_find`/`exec_grep`/`exec_ls` default it), so NO absent-path call ever reaches a guard ask — there is
  nothing to guard and no question to ask.
- **The `~` residue hazard (round 2's critical fix, KEPT):** `canonicalize_lenient` on a `~`-spelled raw sees a
  parent that does not exist, so it returns the RAW `~/.pi/agent/…` form (the canonicalizer's documented fallback for
  an unresolvable path). A PER-TURN user rule `~/.pi/agent/agents` matches fine against the `~`-shaped raw — but a
  guard ancestor derived from the raw would persist a `~`-shaped rule that T04's relay later persists and `rule_for`
  can NEVER match against the executor's canonicalized targets. **Consequence: the ancestor used for the guard prompt
  is derived from the RESOLVED value, not from `raw`** (S2.2) — and the resolution itself must happen BEFORE the
  executor's `validate` sees anything: the executor's `FsBackend::resolve` (and `canonicalize_lenient`) have NO home
  input, so a literal `~` target stays `~`-shaped through both the executor AND a home-less canonicalize — which is
  exactly why the fixture drives a NON-`~` raw argument (an absolute path under the pinned `$HOME`) OR a per-turn
  `~`-matching user rule, and the end-to-end pin
  `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches` proves the resolved (canonical) spelling is
  what `rule_for` subsequently MATCHES. (The `~` in a USER RULE is expanded by `rule_for` against `rules_home` — that
  is the `~` spelling that is load-bearing, and it is a RULE path, not a raw target.)

```rust
// (T03 rows 1–3) For a path-param tool, a RULE may decide before
// the posture does. `rule_for` is the ONE resolver (ADR 0029/0030's
// one-canonicalizer rule: the gate and the executor consult the SAME
// function, never a second matcher). Rows:
// 1. a `Deny` rule → a Deny (tool-result error, trust-immune);
// 2. an `Allow` rule → proceed silently (the posture is not reached);
// 3. NO rule AND the target is under an agent-definition dir → ASK
//    (`Decision::Ask` → `gate_tool`) — unless TRUST suppresses it
//    (a trusted Space silences the ask; row 3 is an ask);
// 4. no rule → fall through to the posture select (`decision_for`) below.
if dir == PolicyDirection::Write {
    // `RuleDirection` for the resolver.
    let rdir = crate::agent::policy::RuleDirection::Write;
    // `raw` and `resolved` are already bound by the path-param arm above
    // — the rules branch lives INSIDE that arm, so no re-fetch and no
    // re-resolution. The rule check and the row-3 membership both use
    // `resolved` (the ONE path).
    if let Some(rule) = crate::agent::policy::rule_for(
        &self.rules,
        rdir,
        &resolved,
        self.rules_home.as_deref(),
    ) {
        return Some(match rule.decision {
            crate::agent::policy::RuleDecision::Deny => Decision::Deny,      // row 1
            crate::agent::policy::RuleDecision::Allow => Decision::Allow,    // row 2 — silent, posture not consulted
        });
    }
    // Row 3: no MATCHING rule, but the target is under an agent-definition
    // dir. `guard_roots` is the frozen `protected` list (the four dirs) —
    // now a GUARD-MEMBERSHIP set, deliberately NOT a rule set (D1/D2): with
    // `default_rules()` EMPTY the plain, default-posture write into one of
    // the four dirs reaches this arm — the row-3 ASK, the spec's single
    // behavioural change. A USER rule that matches (row 1 deny / row 2
    // allow) already returned above. `resolved`, not `raw` — a `~`-spelled
    // target can never reach the ancestry compare in a form the
    // canonicalized roots cannot see.
    //
    // WRITE-ONLY: a READ of an agent-definition file is NOT an ask at any
    // posture (the default denies are gone, and the ROW-3 ASK is
    // Write-only — a read falls to row 4 and the posture select, silently
    // under default `reads: Allow`; see `is_guard_path`'s doc + the
    // read-not-ask pin). Restricting THIS arm to `Write` is how that
    // contract is enforced in code.
    if self.is_guard_path(dir, &resolved) {
        // Trust suppresses the ask (row 3 is an ask; `decision_for`'s trust
        // check already handled the OTHER ask rows — here it is checked
        // directly so a trusted Space needs no prompt for THIS ask either).
        let trusted = self
            .trust
            .as_ref()
            .map(|t| t.is_trusted(&self.space_cwd))
            .unwrap_or(false);
        if !trusted {
            return Some(Decision::Ask);
        }
    }
}
```

READS are NOT run through this write-branch — a Read rule is consulted by the EXECUTOR only (S3's READ-side bullet)
and the gate's Read verdict stays `decision_for`'s (row 3 for reads: no matching rule + under an agent dir → the
posture select — which under the default `reads: Allow` is a silent allow, exactly the read-not-ask pin). Add
`is_guard_path` as a `pub(super)` helper (see S2.3). The "trusted Space suppresses the guard ask" is then pinned in
one place (the trust check above) and the end-to-end trusted test asserts no prompt.

**S2.2 `gate_tool`** — the guard-ask arm. `gate_tool` must know WHICH kind of ask it is answering. Today the only
path is the boundary ask (posture `Ask`, beyond). The guard ask carries the resolved target. Add ONE parameter to
`gate_tool(tc, turn)` → `gate_tool(tc, turn, guard: Option<&Path>)` (the call site in turn.rs is OWNED — ratified):

```rust
pub(super) async fn gate_tool(
    &self,
    tc: &ToolCall,
    turn: &CancellationToken,
    guard: Option<&Path>,   // Some = the resolved WRITE TARGET of a guard ask (row 3)
) -> bool {
```

When `guard` is `Some`, the emit must use `permission_options(false)` with the real ancestor replacing the `""`
placeholder, and the approve predicate must accept `allow-directory`. **The chain that carries the guard prompt:**

- `gate_tool` (guard arm) computes the ancestor, then calls a path-carrying gate function. Keep the trusted/cancel
  semantics in `native_permission_gate` BY REUSING it — do NOT duplicate the trusted auto-approve. The minimal
  change: extend `native_permission_gate` with ONE `options: Vec<Value>` parameter (replacing its internal hardcoded
  `permission_options(true)`) and compute the option list at the CALLER (RATIFIED as B2 — the round-2 plan's `## Blocker`:
  `agent/permission.rs`'s `native_permission_gate` is owned for ONE parameter; the `permission.rs` edit is one
  signature line + one `let options = options;` + its own tests passing `permission_options(true)` at the 2 call-site
  constructions; prompt content stays T02's):
  - boundary ask → `permission_options(true)`;
  - guard ask → `permission_options(false)` clone; replace
    `options[1]["path"] = json!(ancestor.to_string_lossy())` (index 1 is `allow-directory`, by construction — the
    guard list is exactly `[allow, allow-directory, reject]`, pinned by `permission_options`'s own test).
- Keep the trusted auto-approve inside `native_permission_gate` UNCHANGED — a trusted Space never registers a
  oneshot and never emits, so the guard's "no prompt on a trusted Space" works exactly because `policy_verdict`
  already excluded the guard arm for trusted Spaces (S2.1), and the gate's own trusted short-circuit is the second
  (redundant-but-fail-closed) half.

**The approve predicate** becomes:

```rust
matches!(
    outcome,
    PermissionOutcome::Selected { option_id, .. }
        if option_id == "allow" || option_id == "trust-space" || option_id == "allow-directory"
)
```

(`trust-space` stays approved — it is still in the BOUNDARY list and the mid-session flip + Supervisor persist key
on it; `allow-directory` is the NEW allow id for the guard arm. There is no "reject-only" path to remove.)

**The nearest-existing-ancestor computation — exact inputs and where it lives.** Computed in `gate_tool` (the ONLY
place that has both the resolved target and the mindset "this is a guard"), from the RESOLVED value — NOT from the
raw `path` argument (S2.1's hazard: a `~`-spelled raw has no existing parents, so the canonicalizer returns the raw
`~`-residue, and a rule persisted from THAT could never be matched by `rule_for` against a canonicalized target):

```rust
fn guard_ancestor(&self, resolved: &Path) -> std::path::PathBuf {
    crate::agent::fs_backend::canonicalize_lenient(resolved)
}
```

Its input is the SAME value S2.1 resolved and the executor resolved (`&resolved` on both sides — the executor hands
the guarded write's already-resolved path through, so the ancestor, the rule-for decision, and the executor's
`dry`/refusal all agree). `canonicalize_lenient` peels to the DEEPEST EXISTING ancestor and re-appends the trailing
components — exactly the "nearest existing ancestor of the resolved target" the spec names (permission.rs's own doc:
*"the real nearest-existing-ancestor path is computed at the guard's call site (Task 3), whose prompt signature
carries the target path that `native_permission_gate`'s does not"*), and because the input is already
lenient-canonical, the peel is IDEMPOTENT (a canonical path canonicalizes to itself). The emitted `path` is the
CANONICAL (component-normal, `~`-expanded, symlink-resolved as far as it exists) form — so what T04 persists from
the `allow-directory` click is a rule `rule_for` can match. Edge: a resolved target whose ancestor `$HOME` itself
is missing comes back with a length-peeled form — a raw-boundary residue, fine for the prompt's display, and
impossible to hit in the fixtures (the loud pin keeps `.pi/agent` existing so the ancestor is canonical).
A `""`/absent `path` is handled BEFORE the guard (S2.1's early-`Allow` arm — the `else { return Allow }` for a
missing/empty raw) and never has a guard ancestor computed. `guard_ancestor`'s `&Path` is the already-`resolved`
value S2.1 produced; `gate_tool`'s `guard: Option<&Path>` param is passed that resolved value from the corridor
(turn.rs), NOT re-fetched from `tc.arguments`.

**S2.3 `is_guard_path`** — the row-3 membership helper:

```rust
/// (T03 row 3) Whether a `Write` call's path is inside an agent-definition
/// dir — the four dirs (`boundary::protected_dirs()`, the GUARD-MEMBERSHIP
/// set, D2 — a set that is deliberately NOT a rule set, so reaching it is
/// the ordinary default posture, not an override). The check is the SAME
/// compare the gate's own refuse-wording uses (`protected_refusal_text`'s
/// canonicalize-lenient-both-sides starts_with) so gate and executor cannot
/// disagree about "under an agent dir". The input is the ALREADY-RESOLVED
/// path (S2.1).
fn is_guard_path(&self, dir: PolicyDirection, resolved: &Path) -> bool {
    // The ROW-3 ASK is WRITE-only: the default denies are gone (D1), a READ
    // of an agent-definition file is NOT an ask at ANY posture — without a
    // matching rule a read falls to row 4 and the posture select, which
    // under the default `reads: Allow` proceeds silently. The membership
    // set is direction-agnostic (one set, the four dirs), and the DRAWING
    // distinction (writes ask, reads do not) comes from the WRITE-side
    // branch in S2.1, not from this helper.
    self.protected.iter().any(|root| resolved.starts_with(root))
}
```

The resolved input is canonical (S2.1), each `root` is canonical (`protected_dirs()`), so the compare is canonical
on both sides — no second canonicalizer and no raw-vs-canonical miss. The doc says plainly: **a read of an
agent-definition file is not an ask** (pinned by the read-not-ask pin, S6).

**S2.4 `deny_tool_result`** — **NO change required for the default posture**: with `default_rules()` empty a
default-denied protected write no longer exists; the protected-wording branch (`protected_refusal_text(&self.protected, …)`)
keeps working for `Decision::Deny` results — now produced by a USER `deny` rule (row 1) which for a protected dir
names the dir with the SAME sentence (the spec: *"a denied write must still explain why"*). A user `deny` rule on a
NON-protected dir gets the `escape_text` branch (the boundary escape sentence) — see the `rule_deny_text` in S3 for
the row-1 wording of a non-protected rule deny (the round-2 plan's wording choice stands: the rule-deny sentence
names the rule's path; `PROTECTED_WRITE_ROUTE` stays the sanctioned route for the protected case).

### S3. The executor: `access.rs` + `fs_tools.rs` + `search.rs` (OWNED — the executors consult `rule_for` too)

**The unconditional refusal becomes rule/guard-driven.** Today:

```rust
if let Some(msg) = protected_refusal(ctx, "write", &resolved) { … }
```

After T03, in BOTH `exec_write` and `exec_edit` (identical shape, `"write"` / `"edit"`):

```rust
// (T03 rows 1-2) Rules FIRST — the ONE resolver (`rule_for`), so the
// executor agrees with the gate (ADR 0029/0030's one-canonicalizer rule:
// never a second matcher; quoted from `policy.rs`'s module doc — "per ADR
// 0029/0030's one-canonicalizer rule the gate and the executor must both
// go through [`rule_for`], never a second matcher"). The path fed here is
// the SAME `&resolved` the deny-row / dispatch branch below reads — the executor's
// binding resolution (`FsBackend::resolve` under the `write_backend(ctx)`
// roots, bound straight after `validate` in `exec_write`/`exec_edit`,
// BEFORE `protected_refusal`). That is the ONE resolution this task
// shares with the gate (S2.1): the gate's `resolved` and this
// `&resolved` are the same path, so the guard ancestor, the gate's rule
// decision, and the executor's decision cannot disagree. The direction
// is Write; `~` expands against `ctx.home` (`None` = no expansion — the
// pinned consequence, S6).
if let Some(rule) = crate::agent::policy::rule_for(
    &ctx.rules,
    crate::agent::policy::RuleDirection::Write,
    &resolved,
    ctx.home.as_deref(),
) {
    match rule.decision {
        crate::agent::policy::RuleDecision::Deny => {
            // Row 1: refuse with the protected sentence when the target
            // falls under the deny-list half (a user deny naming one of
            // the four); otherwise the rule-deny wording (`rule_deny_text`
            // below) — the DENY is real either way, only the SENTENCE
            // differs.
            if let Some(msg) = protected_refusal(ctx, tool, &resolved) {
                return ToolResult::fail(msg, None);
            }
            return ToolResult::fail(rule_deny_text(tool, rule, &resolved), None);
        }
        crate::agent::policy::RuleDecision::Allow => {
            // Row 2: proceed silently — SKIP the protected-floor refusal
            // entirely for this write (the user rule overrides the guard;
            // this is the ONLY place the old unconditional refusal yields).
        }
    }
} else {
    // NO rule: the target may still be under an agent-definition dir —
    // but at this seam the GATE already decided (row 3 → Ask → the USER
    // answered → dispatch). The executor's job here is only the DENY
    // floor for USER denies + the TRUSTED-Space silent path. A guard hit
    // with no rule is therefore DISPATCHED — never refused — because
    // under an untrusted Space the gate's Ask decided it, and under a
    // Trusted Space the spec says the write proceeds silently
    // ("Trust suppresses the guard"; "A trusted Space's agent can also
    // write its own instruction directories without asking").
    //
    // What this does NOT do: a USER `deny` ruling THIS target was
    // already caught by the `rule_for` branch above (row 1). The executor
    // does not second-guess the gate's Ask/Allow — it only enforces the
    // rule rows, which the gate already enforced.
}
```

The `else` branch — **after the correction it dispatches**, it no longer calls `protected_refusal` (a plain
no-rule protected write must reach dispatch, not a refusal — that was the silent deny the spec removes). The
`Allow` branch is the place an allow rule takes effect (proceed silently past the old floor).

**`rule_deny_text`** (access.rs, next to `protected_refusal`):

```rust
/// (T03 row 1) The refusal for a rule `Deny` whose target is NOT under
/// the deny-list (a user deny on an ordinary dir): same "why" shape as
/// `protected_refusal_text`'s sentence — the denied write must still
/// explain rather than say "escapes the sandbox" — but names the RULE's
/// path (the thing the user wrote) as the reason.
pub(crate) fn rule_deny_text(
    tool: &str,
    rule: &crate::agent::policy::AccessRule,
    resolved: &Path,
) -> String {
    format!(
        "{tool}: {} is denied by a rule ({}) you configured — refusing. {PROTECTED_WRITE_ROUTE}",
        resolved.display(),
        rule.path,
    )
}
```

The doc must QUOTE the one-resolver rule from `policy.rs`'s module doc (as above) and state the new
rule/guard-driven contract: **the executor refuses a protected write ONLY when a USER deny rule matched (row 1);
with no rule matching, a protected write is the gate's Ask (dispatched after the answer) or a Trusted Space's
silent allowed write — never a refusal.**

**READ side:** the executors implement rules for reads too — `exec_read` (fs_tools.rs, `read`), `exec_find`,
`exec_grep`, `exec_ls` (search.rs + fs_tools.rs), each consulting `rule_for(_, Read, …)` with rows 1–2 (allow →
skip the read boundary; deny → refuse with `rule_deny_text`). Guard code for `find`/`grep`/`ls`'s defaulted `path`
(`"."`): the resolver resolves the path leniently; a `"."` resolves inside the cwd, which no rule names — matching
nothing (row 4). The tie to the gate's `find`-as-`Read` grouping is preserved: `RuleDirection::Read` covers the read
tools. (The read rule-enforcement is rows 1–2 only — there is NO read ASK: the gate's `is_guard_path` doc and the
read-not-ask pin make the direction split explicit.)

**`protected_refusal` sits in `access.rs` (owned); the call sites in `fs_tools.rs` + `search.rs` are owned.** The
`read`/`find`/`grep`/`ls` executors are the OTHER side of rows 1–2 (a deny rule must refuse a READ too).
Verify `exec_find`/`exec_grep`/`exec_ls` resolve the path BEFORE the rule check (`FsBackend::validate` then
`rule_for`).

### S4. `tools/types.rs` (OWNED) — the two `ToolCtx` fields

Added to the struct (with the `rules`/`home` docs from DD1, including the **`home: None` semantic — a `~` rule
matches NOTHING**: that field doc is what every direct-`ToolCtx` construction gets by passing `None`, and the S6
pin states the consequence); `derive(Clone)` is unchanged. The EOL field-list comment already carries the field
list — append the two. (*Recoverable from `stash@{0}` verbatim — see `## Recoverable work`.*)

### S5. `tools/sandbox.rs` (OWNED) — the non-widening pin + the `confined_ctx` fields

`Sandbox::create` and `rule_write_root` are NOT edited (DD2). **Its call site stays untouched too:**
`Sandbox::create(cwd) -> Result<Self, String>` keeps its `(cwd)` signature and `tools/exec/bash.rs:156` keeps its
existing call — `bash.rs` (the production file) is NOT in the owned set. An implementer must NOT "improve" this call
by threading `ctx.rules`/`ctx.home` into it — that is precisely the widening DD2 forbids, and it would edit an
unowned file. The `confined_ctx` test helper gains `rules: Vec::new(),` + `home: None,` (and its 4 spread literals — the two `loose` at ~1546/1719 and the two `ctx` at ~1755/2012 — all use `..confined_ctx(...)`, so they gain the fields for free; verify at execution). Then the pin (a unit test in the sandbox module):

```rust
/// (T03, spec: "rules never apply to `bash`") The Landlock subtraction
/// keeps using `boundary::protected_dirs()` — the four-dir GUARD-MEMBERSHIP
/// list (D2), which is BY CONSTRUCTION unable to see a user `allow` rule —
/// so a user `allow` rule for a protected dir can NEVER widen a confined
/// bash's write set. Pinned DIRECTLY at `protected_dirs()`: the list is a
/// plain four-path list, recomputed identically regardless of user rules.
#[test]
fn protected_dirs_ignore_user_rules_because_bash_never_applies_them() {
    // …pin `$HOME` to a scratch home with the four dirs (the policy.rs
    // `pin_home` pattern — copy is fine, the module already pins `$HOME`),
    // then:
    let before = crate::agent::boundary::protected_dirs();
    // A user `allow` rule naming one of the four (the exact exclusion a
    // rules-derived subtraction would honor)…
    std::fs::create_dir_all(home.path().join(".agents/skills")).unwrap();
    let user_allow = crate::agent::policy::AccessRule {
        path: "~/.agents/skills".to_string(), // a USER spelling, expanded at match
        direction: crate::agent::policy::RuleDirection::ReadWrite,
        decision: crate::agent::policy::RuleDecision::Allow,
    };
    let after = crate::agent::boundary::protected_dirs();
    assert_eq!(before, after, "user rules must not change the subtraction list");
    // …and NOT VACUOUSLY: the SAME allow rule applied to the RESOLVER
    // (`rule_for`) DOES change the write verdict — the path tools honor it,
    // `bash` does not. Build `default_rules() ++ [user_allow]` (the
    // concatenation contract) and assert the allow declares the write
    // allowed — that contrast is the load-bearing half (without it,
    // "unchanged" would also hold if protected_dirs() were never consulted
    // at all). With `default_rules()` EMPTY (D1) the concat is just the
    // user allow.
    let rules = vec![user_allow.clone()]; // = `default_rules() ++ user rules`
    assert_eq!(
        crate::agent::policy::rule_for(
            &rules,
            crate::agent::policy::RuleDirection::Write,
            &home.path().join(".agents/skills/anything"),
            Some(home.path()),
        ),
        Some(&user_allow),
        "on the PATH side the allow WINS — the contrast the subtraction pin needs"
    );
}
```

**The e2e half lives in `exec/tests/policy.rs` (the load-bearing executor-side pin):** a `ToolCtx` carrying a user
`allow` rule for one of the four dirs in `ctx.rules` (with a real `ctx.home`), a write target under that dir, and
`exec_bash` running confined — feeding `ctx.rules` into `Sandbox::create`'s CONSUMERS is impossible by design
(create takes only `cwd`), so the executable assertion is at `Sandbox` level: build
`Sandbox::create(&cwd_with_one_of_the_four_as_cwd)` — the cwd-inside-a-protected-dir case — and assert the write
set it produces for that root is READ-ONLY (`rule_write_root`'s first arm) EVEN THOUGH `ctx.rules` carries the
user allow. The fixture CANNOT feed user rules INTO `create` (no such parameter — thank DD2); the pin asserts the
observable consequence instead: confined `exec_bash` with the user allow in `ctx.rules` STILL cannot write the
protected dir. That is not a tautology: it is the ONLY assertion that would redden if T03 ever made `create`
rules-aware.

### S6. Tests — `policy_gate.rs` (gate seam, OWNED), `param_rejection.rs` (OWNED), `exec/tests/policy.rs` (executor seam, OWNED)

**The `policy_settings` helper extensions (policy_gate.rs, OWNED):**

- `policy_settings_json(reads, writes, shell) -> Value` — build the `config` object with `"filePolicy"` and an
  OPTIONAL `"rules"` key.
- `policy_settings_with_rules(reads, writes, shell, rules: &str) -> String` — same shape with a `"rules": […]`
  JSON array appended (or a full-`Value` variant).
- `answer_permission` gains `value: Option<String>`:

```rust
async fn answer_permission(pending: PendingPermissions, session: &str, option: &str, value: Option<String>) {
    …
    let _ = sender.send(PermissionOutcome::Selected {
        option_id: option.to_string(),
        value,
    });
    …
}
```

(Update the 2 call sites that use the 3-arg form: pass `None`.) The CLICK SHAPE of the guard answers is spelled
here so the loud pin cannot be implemented two ways: the allow-directory click is
`answer_permission(pending, "s1", "allow-directory", Some(<the emitted canonical path>))` — with the value taken
verbatim from the recorded `permission-request`'s `options[1]["path"]` (never fabricated) — and the boundary
clicks (`allow` / `trust-space`) keep `None`.

**The named acceptance pins (each a `#[test]` fn with THAT name — the vet will look for these exact names):**

| Pin | File | What it proves |
|---|---|---|
| `a_guard_allow_directory_runs_the_tool` | `policy_gate.rs` | **LOUD PIN.** End-to-end: scratch `$HOME` + `.pi/agent` existing (so the ancestor is canonical); scripted `write` into an agent-def dir; `writes: "allow"`; untrusted Space → guard ask → **click** `answer_permission(pending, "s1", "allow-directory", Some(<the emitted canonical path>))`, the `value` taken VERBATIM from the recorded request's `options[1]["path"]`. Asserts: the tool RESULT is the SUCCESS `Wrote …` (the write LANDED), and the click's `value` equals the emitted `options[1]["path"]`. **Must fail loudly if the predicate or the wiring is wrong**: an unextended predicate turns the click into `"permission denied"` (the boring `else` arm) — the test asserts the tool ran, so that regression reddens it. This pin CANNOT pass with `value: None` (send `value: None` in a SECOND variant and assert the tool still runs — the `value` only matters to T04's persist; the predicate must approve the id regardless of `value`, but the REAL value must be present in the emitted OPTION before the click). **REACHABILITY PRECONDITION (now trivially true under D1/D2 — verify it anyway):** `policy_verdict` must BE `Some(Decision::Ask)` for the write at defaults before the click — under the corrected sets (empty rule set, four-dir guard set) this is the DEFAULT posture, so the fixture does not need an override arrangement; assert it loudly first. |
| `a_guard_allow_directory_runs_the_tool_on_a_trusted_space` | `policy_gate.rs` | **The TRUSTED-Space VARIANT of the loud pin** — the fixtures support it (`ScriptedProvider`, `RestoreHome`, `SqliteTrustSource` all exist; the trust-init pattern is in `a_trusted_space_suppresses_the_prompt_the_policy_would_raise`: `db.upsert_space` + `db.set_space_trusted` + `loop_.trust = Some(SqliteTrustSource::new(db))`). Trust the Space FIRST, then the SAME protected write (same row-3 precondition — defaults, untrusted first to verify the ask WOULD fire, then trusted): NO `permission-request` is emitted at all (S2.1's trust check suppresses the guard ask), the write LANDS **with no click** (no `answer_permission` call — the turn settles with the write dispatched and the file present). This is the happy-path companion to `the_guard_ask_does_not_fire_on_a_trusted_space` and proves the allow-directory CLICK is not what makes the guard work on a trusted Space. |
| `a_rule_deny_refuses_on_a_trusted_space` | `policy_gate.rs` | **GATE-layer pin.** Trust the Space; scripted write into a dir with a USER `deny` rule (e.g. `~/.pi/agent/agents` deny); `writes: "allow"`. Asserts: verdict `Deny` (direct `policy_verdict` injection + end-to-end result `is_error` — the refusal reaches the model through `deny_tool_result`), the refusal contains `protected agent-definition directory` (the wording when the dir is one of the four) or `denied by a rule`, and NO `permission-request` was emitted (the whole point — row 1 is trust-IMMUNE, never a prompt). This pin owns the GATE's row-1 path; the EXECUTOR's refusal is a DIFFERENT site (`protected_refusal` in `tools/exec/tests/policy.rs`, pin 6a) and is NOT asserted here. |
| `the_guard_ask_does_not_fire_on_a_trusted_space` | `policy_gate.rs` | Trust the Space; scripted write into `~/.pi/agent/agents/…` in the SAME row-3 state as the loud pin (defaults — verify `policy_verdict == Ask` on the UNTRUSTED loop FIRST; that is what makes "the ask does not fire" load-bearing). On the trusted loop: verdict `Allow` (trust suppressed the ask — S2.1's trust check), NO `permission-request`, and the write lands. The load-bearing half is the absence of any `permission-request` when the same call WOULD ask untrusted. |
| `the_guard_prompt_end_to_end_carries_exactly_three_options_a_real_path_and_no_trust_space` | `policy_gate.rs` | Same e2e drive as the loud pin; inspect the recorded `permission-request` payload: `options` array — ids exactly `["allow","allow-directory","reject"]` (ORDER pinned), `options[1]["path"]` is a NON-EMPTY STRING (the real ancestor — the resolved target's deepest-existing-ancestor, spelled via `canonicalize_lenient` like S2.2 does, so the emitted path is the canonical form `rule_for` can match), NO element has `optionId == "trust-space"`. This is the end-to-end guard prompt shape. |
| `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny` | `policy_gate.rs` | **The headline churn pin** (replaces the round-1 "a protected write is refused under EVERY policy" claim at the GATE's default posture): a write into one of the four dirs at `writes: allow`, NO user rules → `policy_verdict == Some(Decision::Ask)` (end-to-end: a `permission-request` IS emitted, the prompt carries the guard list). This is the assertion that was FALSE at HEAD's round-2 build (0/16 reached it) and is the spec's single behavioural change. |
| `a_rule_naming_a_not_yet_existing_dir_matches_at_the_gate` | `policy_gate.rs` | `$HOME` with `.pi/agent` but NOT `.pi/agent/agents`; a USER `deny` rule `"~/.pi/agent/agents"` (not-yet-existing); scripted write into `~/.pi/agent/agents/new/SKILL.md`; `writes: "allow"`. Asserts: `policy_verdict` is `Deny` (the rule matched — the lenient canonicalizer), no prompt, result `is_error`. The gate-side mirror of T01's `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently`. |
| `defaults_still_refuse_agent_dir_writes_at_the_default_posture_with_unchanged_wording` — **RENAMED to `a_user_deny_rule_refuses_an_agent_dir_write_with_the_unchanged_protected_wording`** | `policy_gate.rs` | With `default_rules()` EMPTY there is no "defaults still refuse" state; the protected wording now fires for a USER `deny` rule (row 1). The GATE half of the churned pair: settings carry a user `deny` for `~/.pi/agent/agents`; write into it → verdict `Deny`, wording IDENTICAL (`protected agent-definition directory… PROTECTED_WRITE_ROUTE`), NO prompt (row 1 deny is trust-immune and never asks). Keep the symlink-raw fixture and the recreated-mid-session fixture shapes by moving their wording assertions onto the USER-deny row. |
| `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording` | `exec/tests/policy.rs` | **The EXECUTOR half of the churned pair.** Post-correction: a USER `deny` rule naming one of the four dirs is refused by THE EXECUTOR's own `protected_refusal` arm (in `exec_write`) AND at the gate — two refusal sites, two pins. This pin RE-USES the existing `a_recreated_protected_dir_is_refused_without_a_new_session` and `a_write_into_a_still_missing_protected_dir_is_refused` fixtures (the #92 session-snapshot shape, driving `exec_write` DIRECTLY on a `ToolCtx` carrying `rules = [user deny for the dir]` + the frozen `protected` + a real `home`), extended with the two new `ToolCtx` fields so the executor's `rule_for` consult runs: assert `is_error`, `protected agent-definition directory… PROTECTED_WRITE_ROUTE`, file absent. The gate half (row above) exercises `deny_tool_result`; THESE exercise `protected_refusal` — neither can cover the other's site. **The old test NAMES and fixtures change semantics**: `a_write_into_a_protected_dir_is_refused_under_every_policy` (exec/tests/policy.rs) had a NO-rule `ToolCtx` with `protected: vec![…]` and asserted refusal under all three postures — that whole premise is GONE: with no user rule, a protected write is dispatched (the gate's Ask or a Trusted Space's silence). That test is CONVERTED (keep the name? No — the name asserts the old false claim): re-name it `a_write_into_a_protected_dir_with_no_rule_is_not_refused` — it now asserts the write is NOT an error (the executor dispatches a no-rule protected write; the GATE is the ask's home), and the deny half moves to the user-deny variants above. |
| `a_rule_allow_makes_the_write_land` (executor) | `exec/tests/policy.rs` | `ToolCtx` with `rules = default_rules() ++ [user allow for the dir]` + a REAL `home` (so the `~` in the user-allow rule expands); write into `<home>/.pi/agent/agents/…` (an ABSOLUTE target — the executor resolves it) under `writes: Allow`; the write SUCCEEDS (the file lands). The executor half of row 2 — the S3 `Allow` branch. |
| `an_allow_rule_for_a_protected_dir_never_widens_a_sandboxed_bash` (sandbox) | `sandbox.rs` + mirrored in `exec/tests/policy.rs` | Unit pin (S5) + the e2e non-widening (S5's load-bearing half). |
| `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches` | `policy_gate.rs` (+ `exec/tests/policy.rs` seam) | **THE seam pin (round 2's `~`-residue fix):** raw argument `~/.pi/agent/agents/pwn/SKILL.md`; guard ask → assert the recorded `options[1]["path"]` contains NO literal `~` (it is the CANONICAL nearest-existing ancestor of the RESOLVED target) → feed that emitted path BACK as a rule: `rule_for([default_rules() ++ [that rule]], Write, &canonicalized_target, home)` is `Some` — the SAME ancestor, end-to-end. This is the pin that makes the `~`-residue bug visible: pre-fix, the persisted `~`-shaped ancestor matched NOTHING against the canonicalized target and the click that should stop the prompting silently didn't. |
| `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_matches_and_decides` | `exec/tests/policy.rs` | **The `home: None` consequence pin** (renamed from the round-2 `…_beats_the_default_deny`: with `default_rules()` EMPTY there is no default deny to beat at defaults — the second half's claim narrows to "matches and decides"): `rule_for([~-rule], Write, <target>, None)` is `None` (a `~` rule matches NOTHING, silently) and the SAME list with `Some(home)` returns the rule, deciding a write that would otherwise fall to the row-3 ask / row-4 posture. Direct-`ToolCtx` tests all pass `home: None` — this states exactly what that does. |
| `default_deny_still_refuses_on_a_trusted_space` — **REPLACED** | policy_gate.rs | The old pin asserted default rules refuse on a trusted Space — with `default_rules()` EMPTY that state does not exist. Replaced by `a_user_deny_rule_refuses_an_agent_dir_write_with_the_unchanged_protected_wording` (row 1 trust-IMMUNE on a trusted Space: a USER deny still refuses). |
| `a_read_of_an_agent_definition_file_is_not_an_ask` | `policy_gate.rs` | **The read-not-ask pin:** a `read` of `~/.pi/agent/agents/SKILL.md` with no matching rule → verdict `Allow`, NO prompt, the read runs. The default denies are gone (D1), and the default reads policy is `Allow`; only the WRITE direction can reach row 3's ask — the ask is Write-only by S2.1. |

**Rework the two protected-dir gate tests** (grounding §9.1): with `default_rules()` empty, a no-rule under-dir
write is the default ROW-3 ASK (never a deny). The two existing gate tests —
`a_gate_denial_of_a_protected_dir_uses_the_protected_wording` and
`a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session` — keep their fixtures and become the
**user-deny-row** tests (a user `deny` rule in settings produces the SAME wording, same no-prompt property, and
keeps the row-1 trust-immunity claim). Their "no user rules" forms are what `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny`
now pins instead.

**Which layer refuses/dispatches what, per situation (write into one of the four agent dirs) — the segmentation:**

| Situation | Gate | Executor |
|---|---|---|
| Defaults in force (no user rule), untrusted Space | **ROW-3 `Ask`** → guard prompt (`default_posture_agent_dir_write_is_an_ask_not_a_silent_deny`, the loud pin) | Dispatched after the click (the loud pin asserts the tool ran) |
| Defaults in force, TRUSTED Space | `Allow` — trust suppressed the ask (`the_guard_ask_does_not_fire_on_a_trusted_space`) | Dispatched silently (the write lands — the spec's "silent self-modification") |
| User `deny` rule (row 1) | Row-1 `Deny` verdict → `deny_tool_result` (protected wording) — `a_rule_deny_refuses_on_a_trusted_space` | Same rule consulted in `exec_write` → its own `protected_refusal`/`rule_deny_text` arm — `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording` |
| User `allow` rule (row 2) | Silent `Allow` — no prompt, no refusal | The S3 `Allow` branch skips the floor — `a_rule_allow_makes_the_write_land` |

**Init-order guard for the trust tests:** trust must be set BEFORE the first `bounded_prompt` (the loop's `trust` is
`pub` — the existing `a_trusted_space_suppresses_the_prompt…` pattern: build the loop, swap `loop_.trust`, then
prompt).

**`policy_gate.rs` ALSO keeps one Dev-4 pin:** a USER rule added to `settings.json` BETWEEN prompts is enforced at
the next prompt (`rules` re-concat) — cheap and it pins DD1's "per-turn effective" promise (mirror of
`a_settings_edit_between_prompts_changes_the_next_turns_gating` but for a rule).

**`param_rejection.rs`** (OWNED): verify at execution whether any `ToolCtx` literal churns there; the plan's census
says none of its helpers build one (it is owned for ownership-noise reasons). If none churn, record that in
`## Honest limits`.

---

## Files

**Owned — the ONLY files this task may modify (the ONE authoritative reconciled list; round-2's `## Files` claimed
ratifications the dispatch never granted — this list IS the dispatch's ratification, from the status file's
Decisions log, 2026-10-28):**

- `src-tauri/src/agent/policy.rs` — `default_rules()` returns EMPTY (D1); its doc rewritten; the `push_default`
  helper dropped (or kept private but unused — prefer deletion); **no changes to `rule_for`/`expand_rule_path`/
  `AccessRule`/`FilePolicy`/`decision_for`** (T01's resolver is untouched — the correction is that the default
  SOURCE is empty, not that the resolver changed).
- `src-tauri/src/agent/boundary.rs` — `protected_dirs()` reverts to the four-dir plain list (D2, `push_protected`
  restored); its doc + the sealing tests updated (see S6 `## Honest limits` churn); `an_empty_rule_set_matches_nothing_so_the_posture_select_decides`
  doc gains the "empty IS the default" sentence.
- `src-tauri/src/agent/harness/loop.rs` — fields, `new`, `handle_prompt` concat.
- `src-tauri/src/agent/harness/loop/gate.rs` — `policy_verdict` rules branch (rows 1–3), `gate_tool` guard arm + ancestor + predicate, `is_guard_path`.
- `src-tauri/src/agent/harness/loop/turn.rs` — the `gate_tool(tc, turn, guard)` call-site churn (S2.2). **RATIFIED for T03** (round-2's `## Files` claimed it was already ratified; the status-file Decisions log explicitly ratifies it now).
- `src-tauri/src/agent/harness/loop/tools.rs` — the production `ToolCtx` literal (`rules`/`home`).
- `src-tauri/src/agent/tools/exec/access.rs` — `rule_deny_text`, the rule-consult refactor of the executor refusal, the QUOTED one-resolver rule doc.
- `src-tauri/src/agent/tools/exec/fs_tools.rs` — `exec_write` / `exec_edit` / `exec_read` rule checks. **RATIFIED.**
- `src-tauri/src/agent/tools/exec/search.rs` — `exec_find` / `exec_grep` / `exec_ls` rule checks (the read side). **RATIFIED.**
- `src-tauri/src/agent/tools/exec/tests/policy.rs` — the executor pins + the `ToolCtx` literal fields (S6).
- `src-tauri/src/agent/tools/exec/tests/support.rs` — `ctx`/`ctx_policy` fields (ratified into T03's owned set — round-2 mislabeled it "ratified B1", which was T02's label; the correction stands: it is T03-owned).
- `src-tauri/src/agent/tools/types.rs` — the two `ToolCtx` fields.
- `src-tauri/src/agent/tools/sandbox.rs` — `confined_ctx` fields, the non-widening pin (S5).
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — the helper extensions + the gate pins (S6).
- `src-tauri/src/agent/harness/loop/tests/param_rejection.rs` — owned; verify whether its helpers churn; if not, record in `## Honest limits`.
- `src-tauri/src/agent/web/tools.rs`, `src-tauri/src/agent/web/extract/tests.rs`, `src-tauri/src/agent/tools/exec/tests/bash.rs`, `src-tauri/src/agent/tools/exec/tests/skills.rs` — the `ToolCtx` literal fields (ratified).
- `src-tauri/tests/skill_tools_boundary.rs` — the **2 missed `ToolCtx` literals**: `ctx` (line ~101, FULL literal — must name both fields) and the `let c = ToolCtx` at line ~580 (FULL literal). `ctx_roots` (~125) spreads from `ctx` and needs no edit. **RATIFIED via the Decisions log** ("the census omitted… 2 full literals").

**Read-only (not modified):** `src-tauri/src/agent/fs_backend.rs` (`canonicalize_lenient` — `pub(crate)`, call
only), `src-tauri/src/agent/permission.rs` (T02's — read-only for T03 EXCEPT the ONE ratified B2 parameter on
`native_permission_gate`; the Owns extension was already ratified in round 2 and survives), the frontend.

**NOT owned, NOT touched:** `src-tauri/src/agent/tools/exec/bash.rs` (the PRODUCTION `exec_bash` — `Sandbox::create(&ctx.cwd)`
at line 156 is its ONLY call site; DD2 says no signature change, no rule consult; ZERO edits — the orchestrator's
ratification covers it only "if a change is genuinely required", and none is: it is owned-but-unneeded, the T02
`commands/sessions.rs` pattern, and the plan records exactly that here). The 2 `ToolCtx` literals in
`exec/tests/bash.rs` are owned and DO gain the fields — the production file and the test file are separate.
`src-tauri/src/agent/session/mod.rs`, `src-tauri/src/config.rs` — T04/T06's.

---

## Steps

The `Steps:` checkboxes are internal sequencing for ONE commit with the file ownership above — land everything in
this order so the crate compiles at each boundary (a mid-plan `cargo check` failure is a normal, cheap signal, not
a green requirement):

- [ ] **1. `agent/policy.rs` + `agent/boundary.rs`** — the correction (D1/D2): `default_rules()` → EMPTY (delete
  `push_default`), `protected_dirs()` → the four-dir plain list (restore `push_protected`), doc rewrites. Run the
  boundary + policy unit tests to see the churn they expose (several T01 pins about the four default rules will
  redden — see S6's churn list — re-specify them per S6).
- [ ] **2. `tools/types.rs`** — add `pub rules: Vec<crate::agent::policy::AccessRule>` + `pub home: Option<std::path::PathBuf>` to `ToolCtx` (DD1 docs) — RECOVERABLE from `stash@{0}`.
- [ ] **3. `harness/loop.rs`** — add the three fields (`default_rules`, `rules_home`, `rules`); compute `rules_home`/`default_rules` in `new` (ONE `skills::home_dir()` read); init them; the per-turn concat in `handle_prompt` — RECOVERABLE from `stash@{0}` (re-apply, adjust the `default_rules` doc only).
- [ ] **4. `harness/loop/gate.rs`** — `policy_verdict` rules branch (rows 1–3): bind `resolved` ONCE (S2.1), consult `rule_for` + `is_guard_path` on it; `gate_tool(tc, turn, guard: Option<&Path>)` with the ancestor derived from the resolved value and the guard option list; the predicate gains `allow-directory`.
- [ ] **5. `harness/loop/turn.rs`** — the `gate_tool(tc, turn, None)` call-site churn (the boundary ask is `None`; the guard ask passes the RESOLVED target — pick ONE shape at Step 4 and keep it local to `gate.rs`+`turn.rs`).
- [ ] **6. `harness/loop/tools.rs`** — `ToolCtx` literal gains `rules: self.rules.clone()` + `home: self.rules_home.clone()` — RECOVERABLE from `stash@{0}`.
- [ ] **7. `agent/permission.rs`** — the ONE ratified B2 parameter (`native_permission_gate(…, options: Vec<Value>)` → `let options = options;` in the emit); its own tests pass `permission_options(true)` at the 2 call-site constructions.
- [ ] **8. `tools/exec/access.rs`** — `rule_deny_text` + docs (QUOTE the one-resolver rule); **`fs_tools.rs`** — `exec_write`/`exec_edit`/`exec_read` consult `rule_for` (S3 shape: the no-rule protected-write branch DISPATCHES); **`search.rs`** — `exec_find`/`exec_grep`/`exec_ls` consult it (Read direction, rows 1–2).
- [ ] **9. `tools/sandbox.rs`** — `confined_ctx` + any loose literals gain the fields; the non-widening pin (S5).
- [ ] **10. `tools/exec/tests/support.rs`** — `ctx`/`ctx_policy` gain `rules: Vec::new()` + `home: None`.
- [ ] **11. `tools/exec/tests/policy.rs`** — the executor pins (S6: the no-rule-dispatches conversion of `write_into_a_protected_dir_is_refused_under_every_policy`, `a_rule_allow_makes_the_write_land`, the non-widening mirror, the user-deny executor pins) + the `ToolCtx` literal field updates.
- [ ] **12. `harness/loop/tests/policy_gate.rs`** — helper extensions (`policy_settings` with rules, `answer_permission` `value`); rework the two protected-dir tests onto the user-deny row; `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny`; the named pins of S6 + the read-not-ask pin + the `~`-ancestor seam pin + the trusted-Space loud-pin variant (all with the row-3 reachability precondition asserted FIRST).
- [ ] **13. `harness/loop/tests/param_rejection.rs`** — verify churn; add fields to any literal (expected: none).
- [ ] **14. Residual literals** (web/tools.rs, web/extract/tests.rs, exec/tests/bash.rs, exec/tests/skills.rs, tests/skill_tools_boundary.rs — the **2** full literals at `ctx` and line ~580) — add the two fields.
- [ ] **15. Compile+verify:** `cargo check --all-targets` (compiles `fake_worker` + `tests/`); `cargo test --lib policy_gate`; `cargo test --lib param_rejection`; `cargo test --lib exec::tests::policy`; `cargo test --lib boundary`; `cargo test --lib agent::policy`; then `cargo test` (full — the integration rings `tests/harness_loop.rs` / `tests/worker_e2e.rs` compile here); `cargo clippy --all-targets -- -D warnings` (0); `cargo fmt --check`; `cargo check --target x86_64-pc-windows-gnu --all-targets`. The new/changed pins to run by name: `a_guard_allow_directory_runs_the_tool`, `a_guard_allow_directory_runs_the_tool_on_a_trusted_space`, `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny`, `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches`, `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_matches_and_decides`, `a_read_of_an_agent_definition_file_is_not_an_ask`, `protected_dirs_ignore_user_rules_because_bash_never_applies_them`.
- [ ] **16. Self-review the pins list against `done-when`** — every line, one `#[test]` each, named there. If any pin is missing or the tract changed, STOP and report to the orchestrator; do not weaken a pin.

---

## Recoverable work — `stash@{0}` (do NOT pop blindly)

`stash@{0}` ("T03 partial: ToolCtx rules/home plumbing (row-3 blocker)") is the blocked implementer's partial:
8 files, all mechanical, ALL SURVIVING the correction:

- `src-tauri/src/agent/harness/loop.rs` — the three fields + `new` bindings + init + `handle_prompt` concat (the
  `default_rules` doc says "the four Write/Deny floors" — that ONE doc line changes under D1; the code is otherwise
  exactly this plan's S1).
- `src-tauri/src/agent/tools/types.rs` — the two `ToolCtx` fields with the DD1 docs (S4, verbatim).
- `src-tauri/src/agent/harness/loop/tools.rs` — the production literal (`rules`/`home`, S2/Step 6, verbatim).
- `src-tauri/src/agent/tools/exec/tests/{support.rs,bash.rs}` + `src-tauri/src/agent/tools/sandbox.rs` +
  `src-tauri/src/agent/web/{tools.rs,extract/tests.rs}` — the mechanical `rules: Vec::new(), home: None,` literal
  churn (Steps 9–14).

**It does NOT contain** the correction (its `default_rules()` semantics are the pre-correction four deny floors) and it
predates the census correction (it has no `exec/tests/policy.rs`, no `exec/tests/skills.rs`, no
`tests/skill_tools_boundary.rs` edits). **The implementer should RE-APPLY the mechanical parts (git apply the diff or
re-do by hand), then continue with the corrected D1/D2 policy/boundary work and the census-missed files.** Do NOT
`git stash pop` — the stash applies cleanly onto the current HEAD only by luck (HEAD changed with the round-2
docs), and even then its policy.rs/boundary.rs assumptions are wrong. The plumbing RECOVERY is a judgement call the
implementer owns; the CORRECTION is not optional.

---

## Verification

From `src-tauri/`:

```
cargo test --lib policy_gate          # substring filter (harness::loop:: matches nothing — `loop` is a keyword)
cargo test --lib param_rejection
cargo test --lib exec::tests::policy
cargo test --lib boundary
cargo test --lib agent::policy
cargo check --all-targets             # BEFORE trusting fixtures — fake_worker is not rebuilt by --lib
cargo test                            # full suite (compiles tests/harness_loop.rs + tests/worker_e2e.rs)
cargo clippy --all-targets -- -D warnings   # 0 warnings
cargo fmt --check
cargo check --target x86_64-pc-windows-gnu --all-targets
```

`cargo build --all-targets` once at the end (or `cargo check --all-targets` + the test runs above) before declaring
done. The mingw leg proves the Windows path type-checks; `#[cfg(windows)]` behaviour only RUNS on CI.

## Acceptance criteria (each a named `#[test]` fn)

1. `a_guard_allow_directory_runs_the_tool` — the loud pin: protected write → guard ask (row-3, verified FIRST via
   `policy_verdict == Some(Decision::Ask)`) → click `answer_permission(pending, "s1", "allow-directory",
   Some(<the emitted canonical path>))` → the tool RUNS (result not an error, file landed); fails loudly if the
   predicate or the wiring is wrong. The click's `value` is the recorded request's `options[1]["path"]`, never
   fabricated.
2. `a_guard_allow_directory_runs_the_tool_on_a_trusted_space` — the TRUSTED-Space VARIANT: NO prompt is emitted
   at all (the ask is suppressed), the write LANDS without any click.
3. `a_rule_deny_refuses_on_a_trusted_space` — row 1 trust-IMMUNE on a trusted Space; no prompt. GATE-side layer
   through `deny_tool_result` + protected wording.
4. `the_guard_ask_does_not_fire_on_a_trusted_space` — trust suppresses the guard; no prompt; write runs.
5. `the_guard_prompt_end_to_end_carries_exactly_three_options_a_real_path_and_no_trust_space` — exactly allow /
   allow-directory / reject, a REAL (non-empty) canonical `path` on `allow-directory`, NO `trust-space`.
6. `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny` — **the headline churn pin**: at `writes: allow`,
   no user rules, a write into one of the four dirs is `Some(Decision::Ask)` (a `permission-request` IS emitted —
   the spec's single behavioural change).
6a. `a_user_deny_rule_refuses_an_agent_dir_write_with_the_unchanged_protected_wording` + 
    `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording` — the GATE half and the
    EXECUTOR half of the churned pair: a USER `deny` rule refuses with `protected agent-definition directory…
    PROTECTED_WRITE_ROUTE`, no prompt, file absent — asserted at EACH layer (`deny_tool_result` vs
    `protected_refusal`) because the executor never trusts the gate to have refused.
7. `an_allow_rule_for_a_protected_dir_never_widens_a_sandboxed_bash` — the sandbox non-widening pin (DD2):
   `protected_dirs()` unchanged by a user allow, the allow wins at `rule_for` (the contrast half), and confined
   `exec_bash` whose `ctx.rules` carries the user allow still cannot write the protected dir.
8. `a_rule_allow_makes_the_write_land` — executor row 2 (the S3 `Allow` branch): `ToolCtx` with
   `rules = default_rules() ++ [user allow for the dir]` + a real `home`; write into the dir SUCCEEDS.
9. `a_rule_deny_refuses_a_non_protected_dir_with_the_deny_wording` — the rule-deny sentence (S3 `rule_deny_text`).
10. `a_settings_rule_edit_between_prompts_changes_the_next_turns_gating` — per-turn concat (Deviation 4).
11. `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches` — **the end-to-end seam pin:** a `~`-spelled
    guarded write, guard ask → the emitted `options[1]["path"]` is the CANONICAL ancestor (no literal `~`), and
    `rule_for([defaults ++ that-rule], Write, &canonicalized_target, home)` returns `Some`.
12. `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_matches_and_decides` — **the `home: None`
    consequence pin:** `rule_for([~-rule], Write, <target>, None)` is `None` (silently), and the SAME list with
    `Some(home)` returns the rule (a write that would otherwise be the row-3 ask / row-4 posture is now decided by
    the rule).
13. `a_read_of_an_agent_definition_file_is_not_an_ask` — a `read` of a path under one of the four dirs with NO
    matching rule reports verdict `Allow` (row 4, default `reads: allow`) and the read RUNS with no prompt; the
    same scripted path via `write` is a row-3 ask — the direction split this pin exists to state.

## Out of scope

- **T04** — the relay persists the rule; T03 only makes `value` carry a real path (the `Selected { value: Some }`
  rides to the supervisor; nothing in T03 writes `settings.json`).
- **T07** — ADR 0083, the ADR 0030 amendment, `CONTEXT.md`, the features doc.
- **The trust-space removal from the guard prompt** — DONE in T02 (this plan only pins it end-to-end through the real loop).
- **Frontend** — nothing (the wire shape already lands this plan's `value`).
- **The spec's three pre-filled defaults** — T06's UI draft-prefill (D1: NOT code defaults).

## Honest limits

- **Per-turn effectiveness (recorded, not fixed):** an `allow-directory` answer takes effect at the NEXT prompt —
  the concat runs once per turn (Deviation 4, pinned). Five writes into a fresh dir in one turn prompt five times.
  Making it immediate breaks the one-read-per-turn design; rejected as disproportionate (spec's own limit).
- **A user `deny` rule on a NON-protected dir** refuses with the rule-deny sentence (S3) whose text deliberately
  borrows the "why" of the protected wording but names the RULE's path — the same sentence shape the spec keeps for
  row 1, recorded so the two refusal texts are known to differ only in the reason named.
- **The sandbox stays stricter than the tools under an allow rule** (DD2): confined `bash` cannot write a dir the
  write tools can, under an allow rule. That is the spec's chosen posture ("rules never apply to `bash`"); the one
  thing the pin guarantees is that an allow rule can never WIDEN bash, which is the load-bearing half. **And with
  `protected_dirs()` back to a plain list (D2), the sandbox is now also immune to the round-2 blocker itself**: the
  subtraction cannot empty out because a rules change happened, by construction.
- **The executor no longer refuses a no-rule protected write** (S3). This is deliberate: the GATE owns the ask
  (row 3 → `Ask` → the user answers → dispatch), and the executor's refusal arm is now the USER-DENY enforcement
  (row 1). A direct `exec_write` call with an empty rules list and a `protected` list naming the target therefore
  DISPATCHES — the old `write_into_a_protected_dir_is_refused_under_every_policy` premise is the exact behaviour
  the spec's single behavioural change removes. The executor's job after T03 is to agree with the gate's rule rows,
  never to second-guess its ask/allow.
- **`param_rejection.rs` churn** — if its helpers build no `ToolCtx` literal, no edit lands there (verified at
  execution; recorded so the owned-file list does not mislead the vet).
- **Gate/executor one-resolver contract** — both layers now call `rule_for` with the same concatenated list (DD1)
  and the same lenient canonicalizer (`fs_backend::canonicalize_lenient` on both sides). Quoted in `access.rs`'s doc.
- **Churn expected in T01-era pins (the spec predicted it)** — the default-deny pins redden at round 3
  (`protected_dirs_are_the_derived_default_deny_rule_paths`, the `rules.len() == 4` assertion inside it, and every
  "refused under EVERY policy" gate/executor pin) and are re-specified in S6. The rule pins that DON'T depend on the
  four defaults (all of `rule_for`'s, `an_exact_tie…`, `an_empty_rule_set_matches_nothing…`) survive UNCHANGED —
  the resolver's contract is untouched; only the default SOURCE is empty.

## Sources

- Spec: `docs/roadmap/permissions-section.md` — the precedence table, "Matching", "Enforcement", "The prompt",
  "Honest limits", "Pre-filled defaults" ("written only on first write"), "Step 3 is the only behavioural change".
- The ruling and ratification: `docs/roadmap/permissions-section-status.md` (2026-10-28 Blocker/RESOLVED entry; the
  Decisions log's D1/D2 ratification, the owned-set extension "agent/policy.rs and agent/boundary.rs … +
  loop/turn.rs, tools/exec/fs_tools.rs, tools/exec/search.rs … + src-tauri/tests/skill_tools_boundary.rs (the 2
  missed ToolCtx literals)", the two census errors, the stash ref).
- Grounding (current): `docs/roadmap/permissions-section-ground-gate-executor.md` (§1–§9: `policy_verdict` insertion
  point, the `gate_tool` corridor, the freeze matrix, the unconditional-`protected_refusal` doc, the Landlock
  add-only subtraction, the seam comment, the test inventory, the risk list, the "Who touches what" list incl.
  `bash.rs` as a NO-EDIT call site).
- T01: `docs/roadmap/permissions-section-task01-rule-model-resolver.md` (the resolver contract, the concat contract).
- T02: `docs/roadmap/permissions-section-task02-wire-shape-guard-prompt.md` (the seam comment, `permission_options`,
  the loud pin's hand-off requirement, the `Selected { value }` census).
- Tree (all verified at this task's grounding + round 3): `src-tauri/src/agent/harness/loop/{loop.rs,gate.rs,turn.rs,tools.rs}`
  + `loop/tests/{policy_gate.rs,param_rejection.rs,support.rs}`, `src-tauri/src/agent/tools/{types.rs,sandbox.rs}`,
  `src-tauri/src/agent/tools/exec/{access.rs,fs_tools.rs,search.rs,bash.rs}` + `exec/tests/{policy.rs,support.rs,bash.rs,skills.rs}`,
  `src-tauri/src/agent/{policy.rs,permission.rs,boundary.rs,fs_backend.rs}`, `src-tauri/tests/skill_tools_boundary.rs`,
  `stash@{0}` (recoverable partial, read-only).