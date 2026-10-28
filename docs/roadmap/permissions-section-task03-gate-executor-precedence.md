---
status: planned
done-when: "The precedence table of `docs/roadmap/permissions-section.md` is enforced in `policy_verdict` (rows 1–3) and in the write executors (rows 1–2) through ONE resolver, `rule_for`, with the concatenation contract (`default_rules()` FIRST, user rules SECOND — never inverted); the WRITE TARGET IS RESOLVED ONCE — the executor's `FsBackend::resolve` under the `write_backend(ctx)` roots is the binding resolution, the gate's guard arm derives the ancestor from the SAME resolved value through `fs_backend::canonicalize_lenient` (ADR 0081's lenient canonicalizer, NOT strict `canonicalize` — loaded for not-yet-created dirs), and the emitted guard `path` is CANONICAL so a persisted rule is something `rule_for` can match (pinned by `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches`; an absent/empty `path` is handled the way the sibling helpers default it — a `find`/`grep`/`ls` absent path is the `cwd` (`"."` in `exec_find`/`exec_grep`/`exec_ls`), a `write`/`edit` absent path is the existing early-`Allow` arm — and never reaches a guard ask); the guard ask reuses the `Decision::Ask` → `gate_tool` corridor and emits `permission_options(false)` with the REAL nearest-existing-ancestor path replacing the `""` placeholder, `gate_tool`'s approve predicate accepts `allow-directory`, and the loud pin `a_guard_allow_directory_runs_the_tool` lands (protected write → guard ask → `answer_permission(session, \"allow-directory\", value: Some(<the emitted canonical path>))` → the tool RUNS, failing loudly if the predicate or wiring is wrong) together with its trusted-Space variant (same drive on a trusted Space: no prompt, write lands); a rule `deny` refuses on a TRUSTED Space; the guard ask does NOT fire on a trusted Space; the guard prompt end-to-end carries exactly allow / allow-directory / reject with a real non-empty canonical `path` and NO `trust-space`; a READ of an agent-definition file is NOT an ask at any posture (the default denies are Write-only and `decision_for` never asks under default `Allow` — pinned); rules are frozen `default_rules() ++ per-turn user rules` with the concat made ONCE per turn (the per-turn `rules` field holds `Vec::new()` until the first `handle_prompt`, at which point the concat first runs); a `~`-named rule with `ToolCtx.home = None` matches NOTHING while the same rule with a real home matches and beats the default deny (pinned — the `ToolCtx.home` doc states `None` means exactly that); the sandbox's Landlock subtraction continues to use `boundary::protected_dirs()` (default-deny only — a user `allow` rule can NEVER widen confined `bash`, pinned load-bearing: `protected_dirs()` is unchanged by a user allow AND a confined `exec_bash` whose `ctx.rules` carries the user allow still cannot write the protected dir; `Sandbox::create` KEEPS its `(cwd) -> Result<Self, String>` signature — `tools/exec/bash.rs:156` is its ONLY call site and is NOT owned, so it needs zero edits); defaults still refuse agent-dir writes at the default posture with the UNCHANGED `protected agent-definition directory`/`PROTECTED_WRITE_ROUTE` wording (the GATE refuses via `deny_tool_result`, the EXECUTOR via its own `protected_refusal` — two pins, one per layer, so neither can cover for the other); gate and executor consult the SAME resolver (one canonicalizer — ADR 0029/0030; quoted and honoured); the crate compiles (`cargo build --all-targets` — `fake_worker` and `tests/` included), `cargo test`, clippy `--all-targets` 0 warnings, fmt clean, mingw `cargo check --target x86_64-pc-windows-gnu --all-targets` clean."
parent: docs/roadmap/permissions-section.md
---

# Plan — T03: enforce precedence rows 1–4 at the gate and in the executor; wire the guard ASK; land the loud pin

**Goal:** Make rows 1–3 of the spec's precedence table real code: rule `deny` and rule `allow` in the gate verdict AND
the write executors (via `rule_for`, shared), and the no-rule + under-an-agent-dir case become an ASK through the
existing `Decision::Ask` → `gate_tool` corridor, emitting the guard option list with a real resolved path (`value`)
and accepting `allow-directory` in the approve predicate. Row 4 (no rule → posture select) is today's `decision_for`
fall-through and stays. Then add the load-bearing pins: the loud pin
`a_guard_allow_directory_runs_the_tool` (with its CLICK spelled — `answer_permission(session, "allow-directory",
value: Some(<the emitted canonical path>))` — plus the trusted-Space variant), rule-deny-on-a-trusted-Space,
guard-prompt end-to-end shape, gate-side
not-yet-existing-dir match, the defaults-still-refuse-wording pin (GATE half + EXECUTOR half, item 2), the
`~`-ancestor-rule_for-match seam pin (item 1), the `home: None` consequence pin (item 3), the read-not-ask pin
(item 5), and the sandbox non-widening pin (load-bearing, item 4).

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
`boundary::protected_dirs()` (the default-deny view) — rules never reach it, and `Sandbox::create` keeps its
`(cwd) -> Result<Self, String>` signature (its only call site, `tools/exec/bash.rs:156`, needs ZERO edits).

**Tech Stack:** Rust 2021, serde, `serde_json`, `tokio`. ONE compilation unit (`archimedes`).

---

## Parallelisation

**VERDICT: SERIAL.** T03 is a consumed-mode plan and one commitable unit. There is no `**Parallel:**` line: the
scoped work here (verdict wiring, executor wiring, guard wiring, sandbox decision) shares one compilation unit and
one set of files; the internal sequencing is the `Steps:` checkboxes. If a task inside this plan cannot be completed
in one commit, STOP and report — do not split it.

---

## The two design decisions and why

### DD1 — What the gate and executor evaluate against (the freeze matrix)

**Decision: freeze `default_rules()` at `AgentLoop::new`; concatenate `defaults ++ user rules` ONCE per turn in
`handle_prompt`; carry the concatenated list + the home on `ToolCtx` per call.**

The freeze matrix (grounding §3): `read_boundary`/`protected` freeze at `AgentLoop::new`; `file_policy` (with the
user `rules`) re-reads per turn; `ToolCtx` has neither `home` nor `rules`; `rule_for` needs both. Option (A) — freeze
the default half and per-turn concat — matches the task brief's "default rule set frozen per session" and the spec's
"effective next turn" promise (per-turn rule edits land next turn, exactly like `reads`/`writes`/`shell` under
Deviation 4, which the spec names as the mechanism for allow-directory). Option (B) — derive `default_rules()` per
verdict — re-canonicalizes four paths and re-reads `$HOME` on every policed call and contradicts "frozen per
session". **(A) is the cheap correct-enough fix**: one concat per turn, no new `$HOME` reads after `new`, and a user
rule edit lands next turn with no restart. The cheaper still — carrying only `file_policy` and re-deriving the
default half in `rule_for` per call — is REJECTED: it repeats the `$HOME` canonicalization on every `policy_verdict`
and every write, and it silently un-freezes a layer the brief freezes.

The concat is done ONCE per turn (next to the existing `file_policy` re-read in `handle_prompt`), not per call:
the gate and the executor then see the SAME list for the whole turn, which is what "every tool call in a turn must
agree" (Deviation 4, pinned) demands — a mid-turn concat would give the first call in a batch a different list than
the last. The concat ORDER is the load-bearing contract:
`self.default_rules.clone() ++ self.file_policy.rules.clone()` — defaults FIRST, user SECOND. Pinned in BOTH orders
by T01's own test (`an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`); the executor will
see it as one new gate-level test asserting the ORDER of the `AgentLoop::rules` field (defaults then user), and the
round-trip `allow-directory` equivalent through the REAL loop (the next-turn rule beats the default deny).

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

**Every `ToolCtx { … }` literal in the tree, and who owns each** (the construction-site census, final):

| Site | File | Churn kind (owned by whom) |
|---|---|---|
| `dispatch_tool` production build | `harness/loop/tools.rs` — **OWNED (T03)** | add `rules: self.rules.clone(),` + `home: self.rules_home.clone(),` |
| `ctx` + `ctx_policy` helpers | `tools/exec/tests/support.rs` — **ratified B1 (2026-10-28)** | gains `rules: Vec::new(),` + `home: None,` |
| `confined_ctx` helper + 2 loose-spread literals | `tools/sandbox.rs` — **OWNED (T03)** | `rules: Vec::new(),` + `home: None,` |
| `test_ctx` ×2 | `agent/web/tools.rs`, `agent/web/extract/tests.rs` — **ratified B1 (2026-10-28)** | gains the two fields |
| 2 full literals | `tools/exec/tests/bash.rs` — **ratified B1 (2026-10-28)** | gains the two fields |
| full literal ×1 + spread-site (`ToolCtx { … }` with `..`) | `tools/exec/tests/skills.rs` — **ratified B1 (2026-10-28)** | gains the two fields |
| literals (no `..`) in the 6 `exec/tests/policy.rs` tests + the inline `exec/tests/policy.rs` `c` builds | `tools/exec/tests/policy.rs` — **OWNED (T03)** | each `ToolCtx { … }` literal that names `protected`/`file_policy` gains `rules: …` + `home: …` (the default `…`-free literals must name both fields) |

The `…\..ctx(&cwd)` spread sites (support.rs `ctx_policy`, sandbox `confined_ctx`, skills.rs) get the fields for free
if they spread from `ctx`; the FULL literals (bash.rs, web) must name them. The rule: missing either field on a full
literal is a compile-error (the field count of `ToolCtx` changes), and missing it on a spread site is NOT — so the
spread sites need no edit unless they override `..ctx(&cwd)`.

### DD2 — `sandbox.rs`, the third consumer (rules must never apply to `bash`)

**Decision: the Landlock subtraction keeps using `boundary::protected_dirs()` — the DEFAULT-deny view, which is
BY CONSTRUCTION unable to see a user `allow` rule — and `Sandbox::create` CHANGES NOT AT ALL (no signature change,
zero edit to the sandbox module's `create`/`rule_write_root`, no new field, no new param).**

Why this is the correct subtraction source, stated precisely:

- Landlock is ADD-ONLY: a `PATH_BENEATH` rule grants its rights on the fd's path AND everything beneath it, and the
  ruleset is the UNION of the rules — "there is no narrower rule that takes a right back from an ancestor"
  (sandbox.rs module doc, verbatim). The subtraction (rule the write root read+execute, every sibling read-write,
  the protected subtree never read-write) is the ONLY way the four agent dirs stay unwritable inside a confined `bash`.
- If the subtraction source were "whatever the tools see" (i.e. the freeze matrix's concatenated list, or a rules-
  derived `protected_dirs()`), then a user `allow` rule for a protected dir would DROP that dir from the subtraction
  list, and the confined shell's write set would SILENTLY WIDEN to include it (the write root, or its sibling chain,
  gets `READ_WRITE`). That is exactly the spec's prohibition — *"rules never apply to `bash`"* — inverted: an
  allow-rule on the path tools would become a bash widening on the user's filesystem.
- There is NO way for a user rule to reach `boundary::protected_dirs()`: it derives ONLY from
  `policy::default_rules()` (the four frozen `Write`/`Deny` defaults) — the user `rules` half is never an input to it
  (verified: `protected_dirs` filters `default_rules()` and calls nothing that reads `file_policy`). Keeping the
  subtraction on `protected_dirs()` means an allow rule can NEVER widen bash, by construction, not by enforcement.
- The cost: a confined command stays STRICTER than the path tools under an allow-rule (the shell cannot write a dir
  the tools can). That is the spec's chosen posture — the "guard-rail" and its honest limit, recorded in
  `## Out of scope` — and it is what "bash runs with your own user's OS permissions" means in practice (the app
  policy simply does not extend to the shell).

The pin lives in TWO halves (see S5; both are load-bearing, neither is a tautology):

1. the sandbox module's unit test computes `boundary::protected_dirs()` with a user-rule present (an `allow` rule
   naming one of the four, under a pinned `$HOME`) and proves it is IDENTICAL to the no-user-rule result — PLUS
   the contrast half: the SAME allow rule applied to `rule_for` (as `default_rules() ++ [user_allow]`) WINS over
   the default deny, proving "unchanged" is not vacuous (the rule genuinely changes the PATH tools, so an
   unchanged subtraction is the bash exclusion doing its job, not a dead assertion);
2. the end-to-end pin in `exec/tests/policy.rs`: an `allow` rule for a protected dir makes the WRITE TOOL succeed
   while a CONFINED `exec_bash` carrying that rule in `ctx.rules` still cannot write the dir. `Sandbox::create`
   takes ONLY `cwd` (there is no rules parameter to thread), so the observable write-refusal inside the shell is
   the executable half this pin asserts. See `Steps:`.

---

## Context: what this task is, and what it is not

Wire facts this plan builds on (grounded verbatim at `4395bed`; verify volumes on the tree, do not trust memory):

- **`policy_verdict` (gate.rs)** is the single insertion point for rows 1–3: after `beyond` is known for a
  `Read`/`Write` call, BEFORE `decision_for`. Today it computes `(policy, beyond)` and hands straight to
  `decision_for`. The rules branch applies ONLY to `Read`/`Write` calls with a usable `path`; `Shell` and the no-path
  case skip it entirely (row 4 unchanged for `bash`; rules never apply to `bash`).
- **The `Decision::Ask` corridor** (turn.rs `run_tool_batch`): `Some(Decision::Ask) => if self.gate_tool(tc, turn).await { dispatch_tool } else { "permission denied" }`. Row 3 returns `Decision::Ask`, so the corridor runs unchanged.
- **`gate_tool` (gate.rs)** calls `native_permission_gate(session_id, request_id=tc.id, title=permission_title(&tc.name, &tc.arguments), sink, pending_permissions, trust, space_cwd, turn)` and approves `Selected { option_id } if option_id == "allow" || option_id == "trust-space"`. T02's seam comment names the T03 contract: the guard ask reaches `gate_tool` only when the verdict sends a protected write to `Ask`, the prompt offers `permission_options(false)`, and `allow-directory` must become an allow id HERE. The loud pin is `a_guard_allow_directory_runs_the_tool`.
- **`native_permission_gate`** hardcodes `permission_options(true)` and takes NO path argument. The guard prompt needs `permission_options(false)` with the REAL ancestor path in `allow-directory`'s `path`. The gate call site (`gate_tool`) computes the ancestor and passes it in.
- **`permission_options(false)`** (T02) emits `allow` "Allow once" / `allow-directory` "Always allow this directory" with `"path": ""` PLACEHOLDER / `reject` "Block". The `""` is T03's to replace. `trust-space` is deliberately ABSENT (the spec's rationale is load-bearing and must not reappear).
- **The executor's unconditional refusal** (access.rs doc, verbatim): *"The DENY-LIST is not one of the things the policy moves: both executors call [`protected_refusal`] unconditionally … so a protected write is refused by the EXECUTOR in every mode — `writes: Allow` included."* That is row-3's executor-side blocker: an allow rule cannot take effect unless the executor consults rules BEFORE/A-INSTEAD-AT the `protected_refusal` call.
- **The one-resolver rule** (policy.rs module doc, verbatim — QUOTE IT in `access.rs`'s new doc): *"per ADR 0029/0030's one-canonicalizer rule the gate and the executor must both go through [`rule_for`], never a second matcher."*
- **The reader direction mapping** (the `find` vs `glob` note): the gate's `POLICIED_TOOLS` has `find` (no `glob`; `find` is the glob/search tool) in the `Read` group. `grep`, `ls` Read; `write`, `edit` Write; `bash` Shell.
- **`ToolCtx`** is Clone, has `cwd`, `cancel`, `skill_roots`, `boundary`, `file_policy`, `protected`, `web`, `render_requester` — NO `home`, NO `rules`.
- **`AgentLoop`** has NO stored home; `dirs::home_dir()` is read in `McpManager::new` then discarded. The crate's canonical home chain for the discovery dirs is `crate::skills::home_dir()` (`HOME` → `USERPROFILE` → `std::env::home_dir()`, `pub(crate)`), which is what `default_rules()`/`protected_dirs()` go through. T03 needs a `rules_home` field from it.
- **`AgentLoop::new`** already computes `read_boundary` and `protected` once; `handle_prompt` re-reads `file_policy` once per turn; `dispatch_tool` builds one `ToolCtx` per call with `..`-free literal fields.
- **The row-3-only edge:** the four default dirs are today covered by DEFAULT `Write`/`Deny` rules — so `rule_for` returns `Some(Deny)` for them at the gate and executor, which maps to row 1, NOT row 3. Row 3's "no rule + under an agent dir" fires ONLY when a path is under a dir that `rule_for` does not match and that ALSO sits under an agent-definition dir — practically: when a USER `allow` rule has overridden a default deny (breaking the default's match), or a future/hand-added agent dir outside the four defaults. The "under an agent dir" membership set is the four default dirs' canonical roots — the same four the `protected` list carries (see `Steps:` for a fifth case: a rule naming a not-yet-existing dir matching at the gate).
- **What T03 does NOT do:** T04 owns the relay that persists a rule (this plan only makes `value` carry a real path); T07 owns ADR 0083 / docs. No `session/mod.rs`, no `config.rs`, no frontend.

---

## What to implement

### S1. `AgentLoop` gains the frozen default rules + per-turn concatenated list + home (`harness/loop.rs` — OWNED)

**Fields** (next to `protected` / `file_policy`'s docs, same doc voice):

```rust
/// (T03) The DEFAULT rule set (`policy::default_rules()` — the four
/// Write/Deny floors), computed ONCE at construction exactly like
/// `protected` (same `$HOME` read: `skills::home_dir()`), frozen for the
/// session's life. The USER half lives in `file_policy.rules` (per-turn by
/// Deviation 4); the two halves are concatenated per turn into `rules`.
default_rules: Vec<crate::agent::policy::AccessRule>,
/// (T03) The home `rule_for` expands a leading `~` against — the SAME
/// value `default_rules()`/`protected_dirs()` go through, captured in `new`
/// so no per-call `$HOME` read happens. `None` = no home: a `~` rule
/// matches NOTHING (silently — `rule_for`'s `expand_rule_path` expands
/// nothing against `None`; the CONSEQUENCE is pinned by
/// `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_beats_the_default_deny`).
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
`default_rules` and `rules` hold the values above (`rules: Vec::new()` — the pre-first-turn value, see the field
doc), `rules_home` holds the `skills::home_dir()` result.

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
- **The `~` residue hazard (this task's critical fix):** `canonicalize_lenient` on a `~`-spelled raw sees a
  parent that does not exist, so it returns the RAW `~/.pi/agent/…` form (the canonicalizer's documented fallback
  for an
  unresolvable path). A PER-TURN user rule `~/.pi/agent/agents` matches fine against the `~`-shaped raw — but a
  guard ancestor derived from the raw would persist a `~`-shaped rule that T04's relay later persists and
  `rule_for` can NEVER match against the executor's canonicalized targets. **Consequence: the ancestor used for
  the guard prompt is derived from the RESOLVED value, not from `raw`** (S2.2) — and the resolution itself must
  happen BEFORE the executor's `validate` sees anything: the executor's `FsBackend::resolve` (and
  `canonicalize_lenient`) have NO home input, so a literal `~` target stays `~`-shaped through both the executor
  AND a home-less canonicalize — which is exactly why the fixture drives a NON-`~` raw argument (an absolute path
  under the pinned `$HOME`) OR a per-turn `~`-matching user rule, and the end-to-end pin
  `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches` proves the
  resolved (canonical) spelling is what `rule_for` subsequently MATCHES. (The `~` in a USER RULE is expanded by
  `rule_for` against `rules_home` — that is the `~` spelling that is load-bearing, and it is a RULE path, not a
  raw target.)

```rust
// (T03 rows 1–3) For a path-param tool, a RULE may decide before
// the posture does. `rule_for` is the ONE resolver (ADR 0029/0030's
// one-canonicalizer rule: the gate and the executor consult the SAME
// function, never a second matcher). Rows:
// 1. a `Deny` rule → a Deny (tool-result error, trust-immune);
// 2. an `Allow` rule → proceed silently (the posture is not reached);
// 3. NO rule AND the target is under an agent-definition dir → ASK
//    (`Decision::Ask` → `gate_tool`) — unless TRUST suppresses it
//    (a trusted Space silences the ask, row 3 is an ask);
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
    // dir. `guard_roots` is the frozen `protected` list (the four default
    // dirs) — the same four the defaults deny; a write here with the default
    // rules in force matches a DEFAULT deny (row 1), so this arm fires only
    // when a user rule overrode the default, or when the target sits under a
    // dir in `guard_roots` that the default rules do NOT name. `resolved`,
    // not `raw` — a `~`-spelled target can never reach the ancestry compare
    // in a form the canonicalized roots cannot see.
    //
    // WRITE-ONLY: a READ of an agent-definition file is NOT an ask at any
    // posture (the default denies are Write-only and `decision_for` only
    // asks under an `Ask` posture — a read falls to row 4 and the posture
    // select, silently under default `reads: Allow`; see `is_guard_path`'s
    // doc + the read-not-ask pin). Restricting THIS arm to `Write` is how
    // that contract is enforced in code.
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
and the gate's Read verdict stays `decision_for`'s (row 4). Add `is_guard_path` as a `pub(super)` helper (see
S2.3). The "trusted Space suppresses the guard ask" is then
pinned in one place (the trust check above) and the end-to-end trusted test asserts no prompt.

**S2.2 `gate_tool`** — the guard-ask arm. `gate_tool` must know WHICH kind of ask it is answering. Today the
only path is the boundary ask (posture `Ask`, beyond). The guard ask carries the resolved target. Add ONE parameter
to `gate_tool(tc, turn)` → `gate_tool(tc, turn, guard: Option<&Path>)` (verify the call site in turn.rs — it is in
T03's set):

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
  change: extend `native_permission_gate` with ONE `options: Vec<Value>` parameter (replacing its internal
  hardcoded `permission_options(true)`) and compute the option list at the CALLER:
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
missing/empty raw) and never has a guard ancestor computed — the old "empty is possible only when raw is empty"
sentence was wrong (an empty raw does NOT get past `rule_for`'s own resolution as a plain empty string; the
early-`Allow` arm is what keeps it out of the guard entirely) and is gone. `guard_ancestor`'s `&Path` is the
already-`resolved` value S2.1 produced; `gate_tool`'s `guard: Option<&Path>` param is passed that resolved value
from the corridor (turn.rs), NOT re-fetched from `tc.arguments`.

**S2.3 `is_guard_path`** — the row-3 membership helper:

```rust
/// (T03 row 3) Whether a `Read`/`Write` call's path is inside an
/// agent-definition dir — the four DEFAULT dirs (the frozen `protected`
/// list). The check is the SAME compare the gate's own deny-list wording
/// uses (`protected_refusal_text`'s canonicalize-lenient-both-sides
/// starts_with) so gate and executor cannot disagree about "under an agent
/// dir". The input is the ALREADY-RESOLVED path (S2.1).
fn is_guard_path(&self, dir: PolicyDirection, resolved: &Path) -> bool {
    // The default deny rules are WRITE-only and `decision_for` only asks
    // under an `Ask` posture — a READ of an agent-definition file is NOT
    // an ask at ANY posture (rule rows 1–2 still rule it first; with no
    // matching rule a read falls to row 4 and the posture select, which
    // under the default `Allow` proceeds silently). The membership set is
    // direction-agnostic (one set, the four dirs) on purpose: the spec's
    // row 3 is about the path being under an agent-definition dir, not
    // about the direction — and the DRAWING distinction (writes ask, reads
    // do not) comes from the WRITE-side branch in S2.1, not from this
    // helper.
    self.protected.iter().any(|root| resolved.starts_with(root))
}
```

The resolved input is canonical (S2.1), each `root` is canonical (`protected_dirs()`), so the compare is canonical
on both sides — no second canonicalizer and no raw-vs-canonical miss. The doc says plainly: **a read of an
agent-definition file is not an ask** (pinned by the read-not-ask pin, S6), and the WRITE-side branch in S2.1 is
the only producer of the row-3 ask. Keep it direction-agnostic (one membership set, the four dirs) for the spec
reason above.

**S2.4 `deny_tool_result`** — NO change required for the DEFAULT rules: a default `Deny` on a protected write is now
produced by `policy_verdict`'s row-1 arm, and the ROUTE through `decision_for`'s `Sandboxed`/`Deny` arm is
unchanged. `deny_tool_result`'s protected-wording branch (`protected_refusal_text(&self.protected, …)`) keeps
working for `Decision::Deny` results — including a USER `deny` rule (row 1) which for a protected dir names the
dir with the SAME sentence (the spec: *"a denied write must still explain why"*). A user `deny` rule on a
NON-protected dir gets the `escape_text` branch (the boundary escape sentence) — see `## Honest limits`.

### S3. The executor: `access.rs` + `fs_tools.rs` (OWNED — the executors consult `rule_for` too)

**The unconditional refusal becomes rule-consulting.** Today:

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
// the SAME `&resolved` the deny-list check below reads — the executor's
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
            // falls under the deny-list half (the default four, or a user
            // deny naming one of them); otherwise the boundary-escape
            // wording (`new_deny_text` below) — the DENY is real either
            // way, only the SENTENCE differs.
            if let Some(msg) = protected_refusal(ctx, tool, &resolved) {
                return ToolResult::fail(msg, None);
            }
            // A user `Deny` rule for a NON-protected dir — refused with
            // the same "protected" sentence shape the spec keeps for row 1
            // ("a denied write must still explain why" — `PROTECTED_WRITE_ROUTE`
            // stays the sanctioned route; see S3's `rule_deny_text`).
            return ToolResult::fail(rule_deny_text(tool, rule, &resolved), None);
        }
        crate::agent::policy::RuleDecision::Allow => {
            // Row 2: proceed silently — SKIP the deny-list floor entirely
            // for this write (the user rule overrides the default deny;
            // this is the ONLY place the unconditional refusal yields).
        }
    }
} else {
    // No rule: the deny-list floor STILL holds (the unconditional refusal,
    // unchanged wording) — "defaults still refuse agent-dir writes".
    if let Some(msg) = protected_refusal(ctx, tool, &resolved) {
        return ToolResult::fail(msg, None);
    }
}
```

The `else` keeps the EXACT `protected_refusal` call the tests pin (the `PROTECTED_WRITE_ROUTE` sentence, byte for
byte — `write_into_a_protected_dir_is_refused_under_every_policy` rests on it). The `Allow` branch is the ONLY
place the refusal yields — precisely the value an allow rule exists to create.

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

The doc must QUOTE the one-resolver rule from `policy.rs`'s module doc (the plan's `Context` names it; the executor
module doc already carries the deny-list rationale — ADD the rule-consult line to both `protected_refusal`'s and
`rule_deny_text`'s docs).

**READ side:** the executors implement rules for reads too — `exec_read` (fs_tools.rs, `read`), `exec_find`,
`exec_grep`, `exec_ls` (search.rs + fs_tools.rs), each consulting `rule_for(_, Read, …)` with rows 1–2 (allow →
skip the read boundary; deny → refuse). Guard code for `find`/`grep`/`ls`'s defaulted `path` (`"."`): the resolver
resolves the path leniently; a `"."` resolves inside the cwd, which no rule names — matching nothing (row 4). The
tie to the gate's `find`-as-`Read` grouping is preserved: `RuleDirection::Read` covers the read tools. (The read
rule-enforcement is rows 1–2 only — there is NO read ASK: the gate's `is_guard_path` doc and the read-not-ask pin
make the direction split explicit, so an implementer cannot infer "reads ask too" from a read rule landing in the
executors.)

**`protected_refusal` sits in `access.rs` (owned); the call sites in `fs_tools.rs` + `search.rs` are owned.** The
`read`/`find`/`grep`/`ls` executors are the OTHER side of rows 1–2 (a deny rule must refuse a READ too — the
executor side must not let an allowed write read back a denied dir). Verify `exec_find`/`exec_grep`/`exec_ls`
resolve the path BEFORE the rule check (`FsBackend::validate` then `rule_for`).

### S4. `tools/types.rs` (OWNED) — the two `ToolCtx` fields

Added to the struct (with the `rules`/`home` docs from DD1, including the **`home: None` semantic — a `~` rule
matches NOTHING**: that field doc is what every direct-`ToolCtx` construction gets by passing `None`, and the S6
pin states the consequence); `derive(Clone)` is unchanged. The EOL comment already
carries the field list — append the two.

### S5. `tools/sandbox.rs` (OWNED) — the non-widening pin + the `confined_ctx` fields

`Sandbox::create` and `rule_write_root` are NOT edited (DD2). **Its call site stays untouched too:**
`Sandbox::create(cwd) -> Result<Self, String>` keeps its `(cwd)` signature and `tools/exec/bash.rs:156` keeps its
existing call — `bash.rs` is NOT in the owned set, and DD2's design (create reading only `cwd` + the
`protected_dirs()` view into `rule_write_root`) means NO signature change is needed there. An implementer must NOT
"improve" this call by threading `ctx.rules`/`ctx.home` into it — that is precisely the widening DD2 forbids, and it
would edit an unowned file. The `confined_ctx` test helper gains
`rules: Vec::new(),` + `home: None,` (and the two loose-spread literals in the module's tests likewise — check the
two `let loose = ToolCtx {` sites: they spread from `ctx`/`confined_ctx`? Verify at execution; if they are full
literals they name the fields). Then the pin (a unit test in the sandbox module):

```rust
/// (T03, spec: "rules never apply to `bash`") The Landlock subtraction
/// keeps using `boundary::protected_dirs()` — the DEFAULT-DENY view — so
/// a user `allow` rule for a protected dir can NEVER widen a confined
/// bash's write set. Pinned DIRECTLY at `protected_dirs()`: the list is
/// rule-shaped (defaults only) and recomputed identically regardless of
/// user rules.
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
    // …and NOT VACUOUSLY: the same allow rule applied to the RESOLVER
    // (`rule_for`) DOES change the write verdict — the path tools honor it,
    // `bash` does not. Build `default_rules() ++ [user_allow]` (the
    // concatenation contract) and assert the allow BEATS the default deny —
    // that contrast is the load-bearing half (without it, "unchanged" would
    // also hold if protected_dirs() were never consulted at all).
    let mut rules = crate::agent::policy::default_rules();
    rules.push(user_allow.clone());
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
user allow. The nearest achievable form the fixtures support is this: `Sandbox::create(protected_root_as_cwd)` and
`Sandbox::create(space_cwd)` where a protected dir hangs under it, both with the user-allow rule PRESENT in the
`ToolCtx` driving the test, asserting the resulting write set equals the no-rule result (idempotent create over the
same `protected_dirs()` — the landlock write set can only be read via a confined run, which is what the e2e
`exec_bash` mirror asserts). The fixture CANNOT feed user rules INTO `create` (no such parameter — thank DD2); the
pin asserts the observable consequence instead: confined `exec_bash` with the user allow in `ctx.rules` STILL
cannot write the protected dir. That is not a tautology: it is the ONLY assertion that would redden if T03 ever
made `create` rules-aware.

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

**The named acceptance pins (each a `#[test] fn` with THAT name — the vet will look for these exact names):**

| Pin | File | What it proves |
|---|---|---|
| `a_guard_allow_directory_runs_the_tool` | `policy_gate.rs` | **LOUD PIN.** End-to-end: scratch `$HOME` + `.pi/agent` existing (so the ancestor is canonical); scripted `write` into an agent-def dir; `writes: "allow"`; untrusted Space → guard ask → **click** `answer_permission(pending, "s1", "allow-directory", Some(<the emitted canonical path>))`, the `value` taken VERBATIM from the recorded request's `options[1]["path"]`. Asserts: the tool RESULT is the SUCCESS `Wrote …` (the write LANDED — nothing about the outcome is an error), and the click's `value` equals the emitted `options[1]["path"]`. **Must fail loudly if the predicate or the wiring is wrong**: an unextended predicate turns the click into `"permission denied"` (the boring `else` arm) — the test asserts the tool ran, so that regression reddens it. This pin CANNOT pass with `value: None` (send `value: None` in a SECOND variant and assert the tool still runs — the `value` only matters to T04's persist; the predicate must approve the id regardless of `value`, but the REAL value must be present in the emitted OPTION before the click). **REACHABILITY PRECONDITION (verify at execution, before trusting the fixture):** the write must land in a ROW-3 state — `rule_for` returns `None` AND `is_guard_path` is `true` — otherwise the fixture trivially passes as a row-1 deny or row-2 allow and the click never fires. Per `## Honest limits` / grounding §9.1, with the four DEFAULT denies in the concat a protected-dir write is row 1 and an exact-tie user allow makes it row 2 — so the row-3 state requires the membership/override arrangement to be resolved AT EXECUTION (read `policy_verdict` FIRST and fail loudly if it is not `Some(Decision::Ask)`), and the plan's `## Honest limits` already records the reachability truth honestly. |
| `a_guard_allow_directory_runs_the_tool_on_a_trusted_space` | `policy_gate.rs` | **The TRUSTED-Space VARIANT of the loud pin** — the fixtures support it (`ScriptedProvider`, `RestoreHome`, `SqliteTrustSource` all exist; the trust-init pattern is below). Trust the Space FIRST (`db.upsert_space` + `db.set_space_trusted` + `loop_.trust = Some(SqliteTrustSource::new(db))`), then the SAME protected write (same row-3 precondition as the loud pin, verified first): NO `permission-request` is emitted at all (S2.1's trust check suppresses the guard ask), the write LANDS **with no click** (no `answer_permission` call — the turn settles with the write dispatched and the file present). This is the happy-path companion to `the_guard_ask_does_not_fire_on_a_trusted_space` and proves the allow-directory CLICK is not what makes the guard work on a trusted Space. |
| `a_rule_deny_refuses_on_a_trusted_space` | `policy_gate.rs` | **GATE-layer pin.** Trust the Space (`Db` + `SqliteTrustSource` as `a_trusted_space_suppresses_the_prompt…` does); scripted write into a dir with a USER `deny` rule (e.g. `~/.pi/agent/agents` deny); `writes: "allow"`. Asserts: verdict `Deny` (direct `policy_verdict` injection + end-to-end result `is_error` — the refusal reaches the model through `deny_tool_result`), the refusal contains `protected agent-definition directory` (the default-deny wording when the dir is one of the four) or `denied by a rule`, and NO `permission-request` was emitted (the whole point — row 1 is trust-IMMUNE, never a prompt). This pin owns the GATE's row-1 path; the EXECUTOR's refusal is a DIFFERENT site (`protected_refusal` in `tools/exec/tests/policy.rs`, pin 6a) and is NOT asserted here — a reader cannot conclude one pin covers both layers. |
| `the_guard_ask_does_not_fire_on_a_trusted_space` | `policy_gate.rs` | Trust the Space; scripted write into `~/.pi/agent/agents/…` in the SAME row-3 state as the loud pin (same reachability precondition: verify `policy_verdict == Ask` on the untrusted loop BEFORE setting trust — that is what makes "the ask does not fire" load-bearing; if the fixture cannot reach a row-3 state with the allow, fall back to the SAME write under a plain user allow → row 2, and the pin's claim narrows to "trusted: no ask, write lands"). On the trusted loop: verdict `Allow` (trust suppressed the ask — S2.1's trust check), NO `permission-request`, and the write lands (row 2/3 + trust: proceed silently). The load-bearing half is the absence of any `permission-request` when the same call WOULD ask untrusted. |
| `the_guard_prompt_end_to_end_carries_exactly_three_options_a_real_path_and_no_trust_space` | `policy_gate.rs` | Same e2e drive as the loud pin; inspect the recorded `permission-request` payload: `options` array — ids exactly `["allow","allow-directory","reject"]` (ORDER pinned), `options[1]["path"]` is a NON-EMPTY STRING (the real ancestor — the resolved target's deepest-existing-ancestor, spelled via `canonicalize_lenient` on the fixture like S2.2 does, so the emitted path is the canonical form `rule_for` can match), NO element has `optionId == "trust-space"`. This is the end-to-end guard prompt shape. |
| `a_rule_naming_a_not_yet_existing_dir_matches_at_the_gate` | `policy_gate.rs` | `$HOME` with `.pi/agent` but NOT `.pi/agent/agents`; a USER `deny` rule `"~/.pi/agent/agents"` (not-yet-existing); scripted write into `~/.pi/agent/agents/new/SKILL.md`; `writes: "allow"`. Asserts: `policy_verdict` is `Deny` (the rule matched — the lenient canonicalizer), no prompt, result `is_error`. This is the gate-side mirror of `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently` (T01 pinned the resolver; this pins the RESOLVER THROUGH THE GATE). |
| `defaults_still_refuse_agent_dir_writes_at_the_default_posture_with_unchanged_wording` | `policy_gate.rs` | No user rules (empty `"rules"` or absent); `writes: "allow"`; scripted write into `~/.pi/agent/agents/…`. **The GATE half of the converted tests** (`a_gate_denial_of_a_protected_dir_uses_the_protected_wording`, `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session`) — with the DEFAULT rule set in force, the write is a **row-1 rule deny** (not an Ask — the defaults deny it), the wording is IDENTICAL (`protected agent-definition directory… PROTECTED_WRITE_ROUTE`), and NO prompt fires: asserted through `policy_verdict` + `deny_tool_result` (the gate's refusal site). Keep the symlink-raw fixture and the recreated-mid-session fixture AS-IS in force-with-rules, asserting both the wording and the absence of a prompt (the row-1 deny is trust-immune and never prompts). |
| `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording` | `exec/tests/policy.rs` | **The EXECUTOR half of the converted tests** — the reviewer's trace, written down: post-T03, a protected write with the defaults in force gets a `Decision::Deny` at the GATE **AND** the executor's own refusal arm (`protected_refusal` in `exec_write`) — the executor never trusts the gate to have refused, and the two refusals must not be conflated into one pin. This pin RE-USES the existing `a_recreated_protected_dir_is_refused_without_a_new_session` and `a_write_into_a_still_missing_protected_dir_is_refused` — keep those test NAMES and fixtures (the #92 session-snapshot shape, driving `exec_write` DIRECTLY on a `ToolCtx` carrying `rules = default_rules()` + the frozen `protected` + a real `home`), and extend each `ToolCtx` literal with the two new fields so the executor's `rule_for` consult is exercised: assert `is_error`, `protected agent-definition directory… PROTECTED_WRITE_ROUTE`, file absent. The gate half (row above) exercises `deny_tool_result`; THESE exercise `protected_refusal` — neither can cover the other's site. |
| `a_rule_allow_makes_the_write_land` (executor) | `exec/tests/policy.rs` | `ToolCtx` with `rules = default_rules() ++ [user allow for the dir]` + a REAL `home` (so the `~` in the user-allow rule expands); write into `<home>/.pi/agent/agents/…` (an ABSOLUTE target — the executor resolves it) under `writes: Allow`; the write SUCCEEDS (the file lands). This is the executor half of row 2 — the S3 `Allow` branch. |
| `an_allow_rule_for_a_protected_dir_never_widens_a_sandboxed_bash` (sandbox) | `sandbox.rs` + mirrored in `exec/tests/policy.rs` | Unit pin (S5) + the e2e non-widening (S5's load-bearing half): the sandbox module's `protected_dirs_ignore_user_rules_because_bash_never_applies_them` pins `protected_dirs()` UNCHANGED by a user allow PLUS the contrast — the SAME allow rule WINS at `rule_for` (the path tools honor it, `bash` does not). The e2e half, mirrored in `exec/tests/policy.rs`, drives confined `exec_bash` with the user allow in `ctx.rules` + a real `ctx.home` and asserts the protected dir stays WRITE-REFUSED inside the shell (the write set is unchanged because `Sandbox::create(cwd)` reads ONLY `cwd` + `protected_dirs()` — there is no parameter to thread rules through, which is DD2's point; the observable consequence is the load-bearing assertion). |
| `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches` | `policy_gate.rs` (+ `exec/tests/policy.rs` seam) | **THE seam pin (the `~`-residue fix):** raw argument `~/.pi/agent/agents/pwn/SKILL.md`; guard ask → assert the recorded `options[1]["path"]` contains NO literal `~` (it is the CANONICAL nearest-existing ancestor of the RESOLVED target) → feed that emitted path BACK as a rule: `rule_for([default_rules() ++ [that rule]], Write, &canonicalized_target, home)` is `Some` — the SAME ancestor, end-to-end. This is the pin that makes the `~`-residue bug visible: pre-fix, the persisted `~`-shaped ancestor matched NOTHING against the canonicalized target and the click that should stop the prompting silently didn't. |
| `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_beats_the_default_deny` | `exec/tests/policy.rs` | **The `home: None` consequence pin:** `rule_for([~-rule], Write, <target>, None)` is `None` (a `~` rule matches NOTHING, silently) and the SAME list with `Some(home)` returns the user allow BEATING the default deny. Direct-`ToolCtx` tests all pass `home: None` — this states exactly what that does. |
| `default_deny_still_refuses_on_a_trusted_space` | policy_gate.rs | Trust + default rules + write into the four → `Deny` (row 1 trust-IMMUNE), no prompt, the refusal flows through `deny_tool_result`. Covers the grounded "deny stays trust-immune — pinned ON A TRUSTED SPACE" requirement. |
| `a_read_of_an_agent_definition_file_is_not_an_ask` | `policy_gate.rs` | **The read-not-ask pin:** a `read` of `~/.pi/agent/agents/SKILL.md` with no matching rule → verdict `Allow`, NO prompt, the read runs. The default denies are `Write`-only and `decision_for` never asks under default `Allow`; only the WRITE direction can reach row 3's ask. |

**Rework the two protected-dir gate tests** (grounding §9.1): with rules present, a no-rule + under-dir write is an
Ask ONLY when no default denies it; with the defaults in force it is a row-1 deny. The two existing tests keep their
fixtures and wording assertions (see `defaults_still_refuse…` above); drop/replace their "Deny, never a prompt"
expectations where those cease to hold (the row-1 default deny still refuses with no prompt, so the assertions
mostly shrink to re-asserting the wording + adding the rules-presence comment — the `is_error` + wording + no-prompt
triple SURVIVES in the row-1 shape).

**Which layer refuses what, per posture (write into one of the four agent dirs) — the segmentation this
task's denial pins must not blur:**

| Situation | Gate | Executor |
|---|---|---|
| Defaults in force (no user rule) | Row-1 `Deny` verdict → `deny_tool_result` (protected wording) — the GATE half pin (`defaults_still_refuse…`) | Its OWN `protected_refusal` arm in `exec_write` — the EXECUTOR half pin (`a_recreated_protected_dir_is_refused_by_the_executor…`). Both fire; the executor never trusts the gate to have refused |
| User `deny` rule (row 1) | Row-1 `Deny` verdict → `deny_tool_result` (protected wording if under the four, else `rule_deny_text`) — `a_rule_deny_refuses_on_a_trusted_space` | Same rule consulted in `exec_write` → `deny_tool_result`-styling refusal (the executor's own `protected_refusal`/`rule_deny_text`) |
| User `allow` rule overriding a default (row 2) | Silent `Allow` — no prompt, no refusal | The S3 `Allow` branch skips the deny-list floor — `a_rule_allow_makes_the_write_land` |
| User `allow` + under-dir + untrusted (row 3) | `Ask` → guard prompt | Dispatched only after the click (the loud pin) |

The reviewer's trace (`Decision::Deny` at the gate for the default four AND an executor refusal arm producing its
own wording) is the top row, written down so a reader cannot conclude one pin covers both layers.

**Init-order guard for the trust tests:** trust must be set BEFORE the first `bounded_prompt` (the loop's `trust` is
`pub` — the existing `a_trusted_space_suppresses_the_prompt…` pattern: build the loop, swap `loop_.trust`, then
prompt).

**`policy_gate.rs` ALSO keeps one Dev-4 pin:** a USER rule added to `settings.json` BETWEEN prompts is enforced at
the next prompt (`rules` re-concat) — cheap and it pins DD1's "per-turn effective" promise (mirror of
`a_settings_edit_between_prompts_changes_the_next_turns_gating` but for a rule).

**`param_rejection.rs`** (OWNED): the module's `policy_settings` local re-implementation must gain the `"rules"`
key ONLY if a test needs it (check: no rule test is planned there — leave it, and note the module is owned because
the `ToolCtx`-build churn may reach it if any of its helpers build a literal). Verify at execution; if none of its
literals churn, record that in `## Honest limits`.

---

## Files

**Owned — the ONLY files this task may modify:**

- `src-tauri/src/agent/harness/loop.rs` — fields, `new`, `handle_prompt` concat.
- `src-tauri/src/agent/harness/loop/gate.rs` — `policy_verdict` rules branch, `gate_tool` guard arm + ancestor + predicate, `is_guard_path`.
- `src-tauri/src/agent/tools/exec/access.rs` — `rule_deny_text`, the rule-consult in the executors' helpers, docs (QUOTE the one-resolver rule).
- `src-tauri/src/agent/tools/exec/fs_tools.rs` — `exec_write` / `exec_edit` / `exec_read` rule checks.
- `src-tauri/src/agent/tools/exec/search.rs` — `exec_find` / `exec_grep` / `exec_ls` rule checks (the read side).
- `src-tauri/src/agent/tools/exec/tests/policy.rs` — the executor pins + the `ToolCtx` literal fields (S6).
- `src-tauri/src/agent/tools/types.rs` — the two `ToolCtx` fields.
- `src-tauri/src/agent/tools/sandbox.rs` — `confined_ctx` fields, the non-widening pin (S5).
- `src-tauri/src/agent/harness/loop/turn.rs` — the `gate_tool(tc, turn, guard)` call-site churn (S2.2).
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — the helper extensions + the gate pins (S6).
- `src-tauri/src/agent/harness/loop/tests/param_rejection.rs` — owned; verify whether its helpers churn; if not, record in `## Honest limits`.

**(Cross-check against the grounding's Owns list:** the brief names `loop.rs`, `loop/gate.rs`, `exec/access.rs`,
`exec/tests/policy.rs`, `tools/types.rs`, `tools/sandbox.rs`, `loop/tests/param_rejection.rs`, `loop/tests/policy_gate.rs`.
This plan ADDs `loop/turn.rs` (the `gate_tool` call site — ONE line, the `guard` argument; it is the execution
corridor the guard arm must thread), `exec/fs_tools.rs`, and `exec/search.rs` (the executor rule checks — they are
inside the exec-area the grounding owns), `harness/loop/tools.rs` (the production `ToolCtx` build site) — all
RATIFIED into the owned set per the dispatch; the ratified B1/B2 literals (`exec/tests/{support,bash,skills}.rs`,
`web/tools.rs`, `web/extract/tests.rs`, `agent/permission.rs` ONE `options` parameter) are churn-only edits.)

**Read-only (not modified):** `src-tauri/src/agent/policy.rs` (T01's resolver — CALL ONLY), `src-tauri/src/agent/boundary.rs` (`protected_dirs` — the sandbox subtraction source; no edit), `src-tauri/src/agent/permission.rs` (`native_permission_gate`'s ONE `options` parameter — ratified B2; prompt content stays T02's; everything else read-only), `src-tauri/src/agent/fs_backend.rs` (`canonicalize_lenient` — `pub(crate)`, call only).

**`## Blocker`s the orchestrator must rule on (BOTH ALREADY RATIFIED — see `docs/roadmap/permissions-section-status.md`, 2026-10-28 wave-3 entry; listed here so the implementer knows the boundary):**

- **B1 — `exec/tests/support.rs` (ratified).** `ctx`/`ctx_policy` build literal `ToolCtx` values; adding
  `rules`/`home` to `ToolCtx` forces 2 field initializers there, plus the full-literal constructions in
  `agent/web/tools.rs`, `agent/web/extract/tests.rs`, `tools/exec/tests/{bash.rs,skills.rs}` — ALL ratified into
  T03's owned set (ToolCtx construction churn only; each site is a mechanical `rules: Vec::new(), home: None,`
  insertion). The rejected alternatives stand (no `#[non_exhaustive]`, no `rules_ctx` wrapper).
- **B2 — `agent/permission.rs`'s `native_permission_gate` (ratified for ONE parameter)** (`options: Vec<Value>`,
  replacing the hardcoded `permission_options(true)`); the `permission.rs` edit is one signature line + one
  `let options = options;` + its own tests passing `permission_options(true)` at the 2 call-site constructions;
  prompt content stays T02's. The rejected alternative — computing the guard options inside `gate_tool` and passing
  the ancestor into `native_permission_gate` as an extra arg — duplicates
  the gate function's shape for one call path; the cleaner cut is the options parameter (T02 built
  `permission_options`; T03 is its first DISTINCT caller). The `permission.rs` edit is one signature line + one
  `let options = options;` and its `permission.rs` tests stay green; the Owns extension is already ratified (B2).

---

## Steps

The `Steps:` checkboxes are internal sequencing for ONE commit with the file ownership above — land everything in
this order so the crate compiles at each boundary (a mid-plan `cargo check` failure is a normal, cheap signal, not
a green requirement):

- [ ] **1. `tools/types.rs`** — add `pub rules: Vec<crate::agent::policy::AccessRule>` + `pub home: Option<std::path::PathBuf>` to `ToolCtx` (DD1 docs).
- [ ] **2. `harness/loop.rs`** — add the three fields (`default_rules`, `rules_home`, `rules`); compute `rules_home`/`default_rules` in `new` (ONE `skills::home_dir()` read); init them; add the per-turn concat in `handle_prompt`.
- [ ] **3. `harness/loop/gate.rs`** — `policy_verdict` rules branch (rows 1–3): bind `resolved` ONCE (S2.1), consult `rule_for` + `is_guard_path` on it; `gate_tool(tc, turn, guard: Option<&Path>)` with the ancestor computation derived from the resolved value and the guard option list; the predicate gains `allow-directory`.
- [ ] **4. `harness/loop/turn.rs`** — update the `gate_tool(tc, turn)` call site to `gate_tool(tc, turn, None)` (the boundary ask is `None`; the guard ask passes the RESOLVED target — the S2.1 `resolved` value, never a re-fetch of `tc.arguments` — but see Step 3's shape: if the guard arm is chosen inside `gate_tool` via `tc` + a `guard`-decision in `policy_verdict`, the call site passes `None` for boundary and the guard value rides in — pick ONE shape at Step 3 and keep it local to `gate.rs`+`turn.rs`).
- [ ] **5. `harness/loop/tools.rs`** — `ToolCtx` literal gains `rules: self.rules.clone()` + `home: self.rules_home.clone()`. **`tools.rs` is OWNED.** (Add it to the plan's Owns list — it is the production `ToolCtx` build site inside `harness/loop`, and the T01 status file already counts it as a Copy-move site.)
- [ ] **6. `agent/permission.rs`** — ONE parameter: `native_permission_gate(…, options: Vec<Value>)` → `let options = options;` in the emit. (RATIFIED B2 — no further ratification needed; prompt content stays T02's.) Its own tests update the 2 call-site constructions with `permission_options(true)`.
- [ ] **7. `tools/exec/access.rs`** — `rule_deny_text` + docs (QUOTE the one-resolver rule). **`fs_tools.rs`** — `exec_write`/`exec_edit`/`exec_read` consult `rule_for` (S3 shape); **`search.rs`** — `exec_find`/`exec_grep`/`exec_ls` consult it (Read direction).
- [ ] **8. `tools/sandbox.rs`** — `confined_ctx` + any loose literals gain the fields; the non-widening pin (S5).
- [ ] **9. `tools/exec/tests/support.rs`** — `ctx`/`ctx_policy` gain `rules: Vec::new()` + `home: None` (ratified B1).
- [ ] **10. `tools/exec/tests/policy.rs`** — the executor pins (S6 `a_rule_allow_makes_the_write_land`, the non-widening mirror, the reads-side deny pin) + the `ToolCtx` literal field updates.
- [ ] **11. `harness/loop/tests/policy_gate.rs`** — helper extensions (`policy_settings` with rules, `answer_permission` `value`); rework the two protected-dir tests; the named pins of S6 + the read-not-ask pin + the `~`-ancestor seam pin + the trusted-Space loud-pin variant (all with the row-3 reachability precondition asserted FIRST).
- [ ] **12. `harness/loop/tests/param_rejection.rs`** — verify churn; add fields to any literal.
- [ ] **13. Residual literals** (web/tools.rs, web/extract/tests.rs, exec/tests/bash.rs, exec/tests/skills.rs) — add the two fields (ratified B1).
- [ ] **14. Compile+verify:** `cargo check --all-targets` (compiles `fake_worker` + `tests/`); `cargo test --lib policy_gate`; `cargo test --lib param_rejection`; `cargo test --lib exec::tests::policy`; then `cargo test` (full — the integration rings `tests/harness_loop.rs` / `tests/worker_e2e.rs` construct `Selected` and only compile here); `cargo clippy --all-targets -- -D warnings` (0); `cargo fmt --check`; `cargo check --target x86_64-pc-windows-gnu --all-targets`. The new pins to run by name: `a_guard_allow_directory_runs_the_tool`, `a_guard_allow_directory_runs_the_tool_on_a_trusted_space`, `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches`, `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_beats_the_default_deny`, `a_read_of_an_agent_definition_file_is_not_an_ask`, `protected_dirs_ignore_user_rules_because_bash_never_applies_them`.
- [ ] **15. Self-review the pins list against `done-when`** — every line, one `#[test]` each, named there
  (including the REVISE additions: `a_guard_allow_directory_runs_the_tool_on_a_trusted_space`,
  `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`,
  `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches`,
  `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_beats_the_default_deny`,
  `a_read_of_an_agent_definition_file_is_not_an_ask`, and the sandbox module's
  `protected_dirs_ignore_user_rules_because_bash_never_applies_them`). If any pin is missing or the tract
  changed, STOP and report to the orchestrator; do not weaken a pin.

---

## Verification

From `src-tauri/`:

```
cargo test --lib policy_gate          # substring filter (harness::loop:: matches nothing — `loop` is a keyword)
cargo test --lib param_rejection
cargo test --lib exec::tests::policy
cargo check --all-targets             # BEFORE trusting fixtures — fake_worker is not rebuilt by --lib
cargo test                            # full suite (compiles tests/harness_loop.rs + tests/worker_e2e.rs)
cargo clippy --all-targets -- -D warnings   # 0 warnings
cargo fmt --check
cargo check --target x86_64-pc-windows-gnu --all-targets
```

`cargo build --all-targets` once at the end (or `cargo check --all-targets` + the test runs above) before declaring
done. The mingw leg proves the Windows path type-checks; `#[cfg(windows)]` behaviour only RUNS on CI.

## Acceptance criteria (each a named `#[test]` fn)

1. `a_guard_allow_directory_runs_the_tool` — the loud pin: protected write → guard ask (row-3 state, verified
   FIRST via `policy_verdict == Some(Decision::Ask)`) → click
   `answer_permission(pending, "s1", "allow-directory", Some(<the emitted canonical path>))` → the tool RUNS
   (result not an error, file landed); fails loudly if the predicate or the wiring is wrong (an unextended
   predicate turns the click into `"permission denied"`). The click's `value` is the recorded request's
   `options[1]["path"]`, never fabricated.
2. `a_guard_allow_directory_runs_the_tool_on_a_trusted_space` — the TRUSTED-Space VARIANT of the loud pin: the
   fixtures support it (`ScriptedProvider`, `RestoreHome`, `SqliteTrustSource` all exist — see the trust-init
   pattern below). Trust the Space (`loop_.trust = SqliteTrustSource` + `set_space_trusted`), then the SAME
   protected write: NO prompt is emitted at all (the ask is suppressed), the write LANDS without any click
   (`answer_permission` is never called / no `permission-request` recorded).
3. `a_rule_deny_refuses_on_a_trusted_space` — row 1 trust-IMMUNE on a trusted Space; no prompt. **GATE-side
   layer:** the gate refuses (verdict `Deny` + the gate's `deny_tool_result` wording). The executor-side denial
   is a SEPARATE pin (6a) — this one owns the GATE's row-1 path through `deny_tool_result` and the protected
   wording.
4. `the_guard_ask_does_not_fire_on_a_trusted_space` — trust suppresses the guard; no prompt; write runs.
5. `the_guard_prompt_end_to_end_carries_exactly_three_options_a_real_path_and_no_trust_space` — exactly allow /
   allow-directory / reject, a REAL (non-empty) canonical `path` on `allow-directory`, NO `trust-space`.
6. `defaults_still_refuse_agent_dir_writes_at_the_default_posture_with_unchanged_wording` — default rule set:
   agent-dir write refused with the UNCHANGED `protected agent-definition directory… PROTECTED_WRITE_ROUTE`
   wording, no prompt (row-1 deny). **The GATE's refusal** (via `policy_verdict` row 1 + `deny_tool_result`).
6a. `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording` — the EXECUTOR's own half:
   the existing `a_recreated_protected_dir_is_refused_without_a_new_session` + `a_write_into_a_still_missing_protected_dir_is_refused`
   keep their NAMES and fixtures (a `ToolCtx` with real `home`, `rules = default_rules()`, frozen `protected`,
   driving `exec_write` directly), extended with the two new `ToolCtx` fields so the executor's `rule_for`
   consult runs: refused by the executor's OWN `protected_refusal` (`PROTECTED_WRITE_ROUTE`, `is_error`, file
   absent). **Layer split (why two pins):** with rules wired into both layers, the GATE pin (6)
   answers a row-1 verdict before dispatch; the EXECUTOR pin (6a) answers a direct executor call that never went
   through the gate. Each exercises a DIFFERENT refusal site (`deny_tool_result` vs `protected_refusal`); the
   reviewer's trace shows a gate `Decision::Deny` plus an executor refuse — write that down: post-T03 a
   protected write with defaults in force gets a `Deny` verdict AND the executor's own refusal arm both fire
   (the executor never trusts the gate to have refused), and neither pin can cover the other's site.
7. `an_allow_rule_for_a_protected_dir_never_widens_a_sandboxed_bash` — the sandbox non-widening pin (DD2):
   `protected_dirs()` unchanged by a user allow, the allow wins at `rule_for` (the contrast half), and confined
   `exec_bash` whose `ctx.rules` carries the user allow still cannot write the protected dir
   (`Sandbox::create` takes only `cwd`, so the observable consequence is the load-bearing assertion).
8. `default_deny_still_refuses_on_a_trusted_space` — default rules on a TRUSTED Space: `Deny`, no prompt
   (trust-immune deny pinned on a trusted Space).
9. `a_rule_allow_makes_the_write_land` — executor row 2 (the S3 `Allow` branch): `ToolCtx` with
   `rules = default_rules() ++ [user allow for the dir]` + a real `home`; write into the dir SUCCEEDS.
10. `a_rule_deny_refuses_a_non_protected_dir_with_the_deny_wording` — the user-deney sentence (S3
    `rule_deny_text`), not the escape wording.
11. `a_settings_rule_edit_between_prompts_changes_the_next_turns_gating` — per-turn concat (Deviation 4).
12. `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches` — **the end-to-end seam pin (the
    `~`-residue fix):** a `~`-spelled guarded write (raw argument `~/.pi/agent/agents/pwn/SKILL.md`), guard ask →
    the emitted `options[1]["path"]` is the CANONICAL ancestor (no literal `~` in it), and
    `rule_for([defaults ++ that-rule], Write, &canonicalized_target, home)` returns `Some` — i.e. the ancestor
    the guard prompts with is exactly a rule `rule_for` subsequently MATCHES. Without this pin the `~`-residue
    bug (silent no-match after an `allow-directory` click) is invisible.
13. `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_beats_the_default_deny` — **the
    `home: None` consequence pin:** `rule_for([~-rule], Write, <target>, None)` is `None`
    (the `~` expands against nothing — matches NOTHING, silently), and the SAME rule list with
    `Some(home)` returns the user allow against the default deny. Direct-`ToolCtx` tests pass `home: None`
    (S4's doc) — this pins what that does.
14. `a_read_of_an_agent_definition_file_is_not_an_ask` — a `read` of a path under one of the four dirs with
    NO matching rule reports verdict `Allow` (row 4, default `reads: allow`; `writes` posture is irrelevant to
    a read) and the read RUNS with no prompt — the default denies are Write-only and `decision_for` never asks
    under default `Allow` (the read-not-ask pin). The same scripted path via `write` is a row-1/row-3 event —
    the direction split this pin exists to state.

## Out of scope

- **T04** — the relay persists the rule; T03 only makes `value` carry a real path (the `Selected { value: Some }`
  rides to the supervisor; nothing in T03 writes `settings.json`).
- **T07** — ADR 0083, the ADR 0030 amendment, `CONTEXT.md`, the features doc.
- **The trust-space removal from the guard prompt** — DONE in T02 (this plan only pins it end-to-end through the real loop).
- **Frontend** — nothing (the wire shape already lands this plan's `value`).

## Honest limits

- **Per-turn effectiveness (recorded, not fixed):** an `allow-directory` answer takes effect at the NEXT prompt —
  the concat runs once per turn (Deviation 4, pinned). Five writes into a fresh dir in one turn prompt five times.
  Making it immediate breaks the one-read-per-turn design; rejected as disproportionate (spec's own limit).
- **A user `deny` rule on a NON-protected dir** refuses with the rule-deny sentence (S3) whose text deliberately
  borrows the "why" of the protected wording but names the RULE's path — the same sentence shape the spec keeps for
  row 1, recorded so the two refusal texts are known to differ only in the reason named.
- **The sandbox stays stricter than the tools under an allow rule** (DD2): confined `bash` cannot write a dir the
  write tools can, under an allow rule. That is the spec's chosen posture ("rules never apply to `bash`"); the one
  thing the pin guarantees is that an allow rule can never WIDEN bash, which is the load-bearing half.
- **Row 3's practical reach** (grounding §9.1; stated precisely, since the loud pin's reachability depends on it):
  with the four DEFAULT denies always in the concat, a write under any of the four dirs MATCHES a default deny →
  row 1. A user `allow` at an exact-tie path (same canonical dir) WINS by `rule_for`'s last-rule tie-break →
  row 2 (silent, no ask). The row-3 ask — `rule_for` returns `None` while `is_guard_path` is `true` — is
  therefore reachable only for a WRITE whose resolved target sits under an agent-definition dir WITHOUT matching
  any rule's prefix: e.g. a path under a dir in `guard_roots` whose covering default deny was itself shadowed by
  a user rule such that the target falls out of EVERY rule's canonical prefix, or a member of the membership set
  the user ruled at a non-overlapping path. The precedence table is still implemented in full (rows 1–4 wherever
  reachable); the loud pin's fixture MUST reach that state (assert `policy_verdict == Ask` first), and this
  limit is why the pin's REACHABILITY PRECONDITION is spelled out rather than assumed — a reviewer or
  implementer who finds the row-3 state unreachable for the four dirs should report it, not weaken the pin.
- **`read` of an agent-definition dir is NOT an ask at any posture** — the default deny rules are
  `Write`-only (`default_rules()`'s `push_default` emits `RuleDirection::Write` for all four floors
  inherited from the T01 resolver) and `decision_for` only ever asks under an `Ask` posture. So a `read`
  of `~/.pi/agent/…` with no matching rule falls to row 4 and the posture select: under the shipped
  default `reads: Allow` it proceeds SILENTLY. Recorded (not changed — a read tightening would be a NEW
  restriction) and pinned by `a_read_of_an_agent_definition_file_is_not_an_ask`. `is_guard_path` is
  direction-agnostic (one membership set, the four dirs) but the ONLY producer of the row-3 ask is the
  WRITE-side branch of S2.1 — the documents say this plainly so no implementer reads reads as guarded.
- **`ToolCtx.home = None` makes `~` rules silent no-ops** — every direct-`ToolCtx` construction in the
  fixtures (support.rs `ctx`/`ctx_policy`, sandbox `confined_ctx`, exec/policy literals) passes `None`;
  `rule_for` then expands a `~`-named rule against nothing and it matches NOTHING (pinned by
  `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_beats_the_default_deny`). Only
  `harness/loop/tools.rs`'s production build carries `Some(self.rules_home)`; a fixture that must
  exercise the user `~`-allow half constructs the rule with an ABSOLUTE path or passes a real
  `Some(home)` — never relies on `None` to match.
- **`param_rejection.rs` churn** — if its helpers build no `ToolCtx` literal, no edit lands there (verified at
  execution; recorded so the owned-file list does not mislead the vet).
- **Gate/executor one-resolver contract** — both layers now call `rule_for` with the same concatenated list (DD1)
  and the same lenient canonicalizer (`fs_backend::canonicalize_lenient` on both sides — the one ADR-0081 primitive,
  matching how `protected_refusal_text` already compares both sides leniently). Quoted in `access.rs`'s doc.

## Sources

- Spec: `docs/roadmap/permissions-section.md` — the precedence table, "Matching", "Enforcement", "The prompt",
  "Honest limits".
- Grounding (current): `docs/roadmap/permissions-section-ground-gate-executor.md` (§1–§9: `policy_verdict` insertion
  point, the `gate_tool` corridor, the freeze matrix, `protected_refusal`'s unconditionality, the Landlock
  add-only subtraction, the seam comment, the test inventory, the risk list).
- T01: `docs/roadmap/permissions-section-task01-rule-model-resolver.md` (the resolver contract, the concat contract).
- T02: `docs/roadmap/permissions-section-task02-wire-shape-guard-prompt.md` (the seam comment, `permission_options`,
  the loud pin's hand-off requirement, the `Selected { value }` census).
- Tree (all verified at this task's grounding): `src-tauri/src/agent/harness/loop/{loop.rs,gate.rs,turn.rs,tools.rs}`
  + `loop/tests/{policy_gate.rs,param_rejection.rs,support.rs}`, `src-tauri/src/agent/tools/{types.rs,sandbox.rs}`,
  `src-tauri/src/agent/tools/exec/{access.rs,fs_tools.rs,search.rs}` + `exec/tests/{policy.rs,support.rs}`,
  `src-tauri/src/agent/{policy.rs,permission.rs,boundary.rs,fs_backend.rs}`.
