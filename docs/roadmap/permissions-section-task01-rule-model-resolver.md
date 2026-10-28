---
task: T01
feature: permissions-section
status: planned
target: docs/roadmap/permissions-section-task01-rule-model-resolver.md
grounding: docs/roadmap/permissions-section-ground-policy-core.md
spec: docs/roadmap/permissions-section.md (status: approved)
---

# T01 — Rule model + longest-prefix resolver; `protected_dirs()` becomes the default rule set

## `## Parallelisation` verdict

**SERIAL — one commitable unit, no sub-task decomposition, no `**Parallel:**` lines.** `archimedes` is ONE
compilation unit, so this task cannot share a wave with any other Rust task; and the steps below are
sequenced with **S1 as a single atomic commit** (the `FilePolicy` type flip — see the Blocker RESOLVED:
there is no green intermediate state once a collection goes on `FilePolicy`) and then **additive,
independently compiling steps** (resolver, derivation, tests) — a plan that ends on a non-compiling commit
is unusable here, and the atomic-step shape is what guarantees a green tree at every checkpoint.

---

## Why this task exists (sixth-gate check, one paragraph)

The spec's rules layer is entirely unimplemented (grounding §7: zero `AccessRule` occurrences, no
longest-prefix matching anywhere, `FilePolicy` still three fields). T01 delivers the vocabulary and the ONE
resolver so that the gate and the executor (T03) cannot disagree — the ADR 0029/0030 one-canonicalizer rule —
and converts the hardcoded write deny-list into the default rule set, without changing a single behaviour
that exists today (every consumer of `protected_dirs() -> Vec<PathBuf>` keeps its signature and its output).

---

## ⚠ Blocker (RESOLVED by orchestrator)

`rules: Vec<AccessRule>` removes `Copy` from `FilePolicy`. **The orchestrator re-measured the blast radius
from the tree at HEAD, in a scratch crate and against the real gate, and it is 19 edit sites across 11
files.** Measured breakdown (every non-`..` struct literal of `FilePolicy` and every move out of a
reference, file by file — **17 full struct literals (14 under `src/`, 3 under `tests/`) + 2 Copy-move sites
= 19 edits**):

| # | File | Site kind | Edit |
|---|------|-----------|------------|
| 1 | `src-tauri/src/agent/harness/loop/tools.rs:104` | `ToolCtx` literal — **Copy MOVE** `file_policy: self.file_policy,` | `self.file_policy.clone()` |
| 2 | `src-tauri/src/agent/harness/loop.rs:609` | **Copy MOVE OUT OF A BORROW** — `self.file_policy = settings.as_ref().map(\|s\| s.file_policy).unwrap_or_default();` | `…\|s\| s.file_policy.clone()…` |
| 3 | `src-tauri/src/agent/policy.rs:315` | inline test literal (OWNED SET — S1's own site) | `rules: Vec::new(),` |
| 4 | `src-tauri/src/config.rs:965` | literal in `file_policy_defaults_to_allow_in_every_direction` | `rules: Vec::new(),` |
| 5 | `src-tauri/src/config.rs:996` | literal in `file_policy_serializes_under_the_camel_case_file_policy_key` | `rules: Vec::new(),` |
| 6 | `src-tauri/src/config.rs:1407` | literal in `settings_round_trip_with_the_new_fields` | `rules: Vec::new(),` |
| 7 | `src-tauri/src/config.rs:1472` | literal in `file_policy_round_trips_through_the_settings_file` | `rules: Vec::new(),` |
| 8 | `src-tauri/src/agent/web/tools.rs:482` | production `ToolCtx` literal in `test_ctx()` | `rules: Vec::new(),` |
| 9 | `src-tauri/src/agent/web/extract/tests.rs:18` | `ToolCtx` literal | `rules: Vec::new(),` |
| 10 | `src-tauri/src/agent/tools/exec/tests/support.rs:37` | `ctx()` `ToolCtx` literal | `rules: Vec::new(),` |
| 11 | `src-tauri/src/agent/tools/exec/tests/bash.rs:264` | `FilePolicy` literal (via `ctx_policy`) | `rules: Vec::new(),` |
| 12 | `src-tauri/src/agent/tools/exec/tests/bash.rs:311` | `FilePolicy` literal (via `ctx_policy`) | `rules: Vec::new(),` |
| 13 | `src-tauri/src/agent/tools/sandbox.rs:897` | `confined_ctx` helper literal | `rules: Vec::new(),` |
| 14 | `src-tauri/src/agent/tools/sandbox.rs:1546` | `loose` `ToolCtx` literal in `a_confined_command_cannot_read_outside_the_allow_list` | `rules: Vec::new(),` |
| 15 | `src-tauri/src/agent/tools/sandbox.rs:1718` | `loose` `ToolCtx` literal in `a_confined_command_cannot_write_to_the_controlling_terminal` | `rules: Vec::new(),` |
| 16 | `src-tauri/src/agent/tools/sandbox.rs:1753` | `loose` `ToolCtx` literal in `the_same_command_writes_freely_when_the_sandbox_is_off` | `rules: Vec::new(),` |
| 17 | `src-tauri/tests/skill_tools_boundary.rs:128` | `ctx_roots` `ToolCtx` literal (integration ring) | `rules: Vec::new(),` |
| 18 | `src-tauri/tests/skill_tools_boundary.rs:582` | `ToolCtx` literal in `a_symlinked_home_yields_canonical_roots_and_still_denies_writes` (integration ring) | `rules: Vec::new(),` |
| 19 | `src-tauri/tests/worker_e2e.rs:744` | `Some(FilePolicy { … })` literal in `permission_round_trip_real_worker` (integration ring) | `rules: Vec::new(),` |

That is **2 Copy-move sites + 17 full struct literals (14 under `src/`, 3 under `tests/`)**. In addition:
**7 spread literals using `..FilePolicy::default()` survive untouched** — all seven in
`src-tauri/src/agent/tools/exec/tests/policy.rs` (lines 29/31, 94/96, 141/143, 208/210, 277/279, 471/473,
546/548 — seven total, the previous round's count of six missed the first one at line 29) — no edit needed,
they inherit `rules: vec![]` from the spread. Also untouched: the four
`file_policy: FilePolicy::default()` constructions (loop.rs:367, bash.rs:355, bash.rs:515,
skill_tools_boundary.rs:109), `gate.rs`'s field reads (`self.file_policy.reads/writes/shell` — flattened
field reads that do not move), and `exec/tests/support.rs:51` (`file_policy: policy` — a plain move of a
local, not a copy of a `&self` field). Anchors are at HEAD; a line may drift by one or two.

### The two-phase ordering is VOID — measured refutations (orchestrator, scratch crate + real gate)

**There is NO green intermediate state, in any representation that puts a collection on `FilePolicy`. The
blast radius is a property of the language, not of the design.** Both halves of the previous round's
two-phase ordering fail; there is no "phase 1 then phase 2":

- **Phase-1-as-written (insert `rules: Vec::new(),` into the 17 literals while the field does not yet
  exist) is not a compile** — a Rust struct literal cannot name a field that does not exist:
  `error[E0560]: struct FilePolicy has no field named rules`. The old claim that these edits are
  "no-ops today" and that "the tree compiles and is clippy-clean at the end of phase 1" is FALSE.
- **Phase-1-as-rewritten (convert the 17 literals to `..FilePolicy::default()` first, which DOES compile
  today) is clippy-red** — `clippy::useless_struct_update`: "struct update has no effect, all the fields
  in the struct have already been specified". That is red at this repo's `cargo clippy --all-targets`
  **0-warning** gate.
- **The `clone()` whole (pre-land `.clone()` while `Copy` is alive) is clippy-red too** —
  `clippy::clone_on_copy`. (This was already recorded last round; it completes the impossibility: every
  representation — literal insert, spread conversion, clone-on-Copy — is either non-compiling or
  clippy-red until the `rules` field exists AND `Copy` is gone, which must happen together.)

### The resolution (orchestrator decision, ratified)

**Option (b) is granted: T01's Owns set is extended to the 10 blast-radius files.** They are now in scope
for this task — the `## Files:` list names all 12 owned files. **Step S1 is therefore a SINGLE ATOMIC
STEP** (see `## Steps:`): add the field, drop `Copy`, and fix all 19 sites in one commit — any subset of
that set leaves the crate non-compiling or clippy-red. T01's edits to the four files shared with T03/T04
(`config.rs`, `harness/loop.rs`, `tools/sandbox.rs`, `exec/tests/bash.rs`) are the mechanical
`rules: Vec::new(),` / `.clone()` insertions and NOTHING else; the cross-wave overlap is harmless because
disjointness is only required within a wave, and T01/T03/T04 are sequential waves. (All 19 edits are
behavior-identical: empty `rules` serial-in/out is the wire-identical today-state, verified by the
unchanged config.rs `contains` pins and the `skip_serializing_if` serde shape.)

---

## Files:

(`## Files:` = the owned set — option (b) GRANTED, so this is now the full 12-file set; a plan whose
edits land outside this set breaks the wave)

- `src-tauri/src/agent/policy.rs` — the rule types, the `FilePolicy.rules` field + `Copy` removal, the
  resolver, `default_rules()`; including its inline `mod tests` (lines 104–343 at HEAD; literal #3 of the
  Blocker table lives here at line 315).
- `src-tauri/src/agent/boundary.rs` — including its inline `mod tests` (lines 218–662 at HEAD); the
  `protected_dirs()` derivation, `push_protected` deletion.
- `src-tauri/src/agent/harness/loop/tools.rs` — S1: `file_policy: self.file_policy,` → `self.file_policy.clone(),`
  at line 104 (Copy-move site #1). This file is the SAME file as `tools.rs` in `harness/loop`; NO changes
  beyond the one line.
- `src-tauri/src/agent/harness/loop.rs` — S1: `settings.as_ref().map(|s| s.file_policy).unwrap_or_default()`
  → `…s.file_policy.clone()…` at line 609 (Copy-move site #2). The `FilePolicy::default()` construction at
  line 367 is untouched. Nothing else in this file changes.
- `src-tauri/src/config.rs` — S1: `rules: Vec::new(),` inserted in the literals at lines 965, 996, 1407,
  1472 (sites #4–7 in the Blocker table). ONLY those four mechanical insertions — no config logic, no
  settings read/write path changes (T04's).
- `src-tauri/src/agent/web/tools.rs` — S1: literal #8 (`test_ctx()` at line 482). Only that line.
- `src-tauri/src/agent/web/extract/tests.rs` — S1: literal #9 (line 18). Only that line.
- `src-tauri/src/agent/tools/exec/tests/support.rs` — S1: literal #10 (line 37). Line 51
  (`file_policy: policy`, a plain move of a local) is untouched.
- `src-tauri/src/agent/tools/exec/tests/bash.rs` — S1: literals #11 (line 264) and #12 (line 311). The two
  `FilePolicy::default()` constructions (lines 355, 515) are untouched — those are `Default`-filled and need
  no edit.
- `src-tauri/src/agent/tools/sandbox.rs` — S1: literals #13 (line 897, `confined_ctx`), #14 (line 1546),
  #15 (line 1718), #16 (line 1753). ONLY the four `rules: Vec::new(),` insertions — no Landlock logic, no
  postures (T03's).
- `src-tauri/tests/skill_tools_boundary.rs` — S1: literals #17 (line 128) and #18 (line 582). Line 109's
  `FilePolicy::default()` construction is untouched.
- `src-tauri/tests/worker_e2e.rs` — S1: literal #19 (line 744, `Some(FilePolicy { … })`). Nothing else.

NOT owned and deliberately untouched (so the wave stays disjoint): `gate.rs` (T03 — field reads
`self.file_policy.reads/writes/shell` stay legal and need no edit), `types.rs` (T03's `ToolCtx` field
declaration — the field type itself does not change, only the literal CONSTRUCTION sites, which are all
owned above), `tools/exec/access.rs` (T03 — `protected_refusal_text` wording untouched), and the seven
spread literals in `exec/tests/policy.rs` (already `..FilePolicy::default()`-shaped — they inherit
`rules: vec![]` and survive untouched; that file also contains `file_policy: FilePolicy { … }` full
literals at 141/208/277/471/546 which are NOT touched because they are spread literals).

---

## Design (what lands, and the decisions made)

### Where `canonicalize_lenient` is reached from — precisely

It is `pub(crate) fn canonicalize_lenient(path: &Path) -> PathBuf` in `src-tauri/src/agent/fs_backend.rs` and
is **not** re-exported from `agent/mod.rs` (the spec's "already `pub`" claim is wrong; grounding §3). Reach it
exactly as the three existing call sites do — the full crate path `crate::agent::fs_backend::canonicalize_lenient`
— from both `policy.rs` and `boundary.rs` (both are inside the crate, so `pub(crate)` suffices).

### Types (`policy.rs`, all `pub`, serde-shaped after `AccessPolicy`)

```rust
/// One direction a rule can govern. `ReadWrite` covers both `Read` and
/// `Write` — the wire value a rule written for "this directory" carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleDirection {
    Read,
    Write,
    ReadWrite,
}

impl RuleDirection {
    /// Whether a rule with this direction applies to a call of `direction`.
    pub fn covers(self, direction: RuleDirection) -> bool {
        matches!(self, RuleDirection::ReadWrite) || self == direction
    }
}

/// What a matching rule does: allow (proceed silently) or deny (a
/// tool-result error). THERE IS NO `ask` VALUE — asking is what happens
/// when NO rule matches (the self-modification guard), never a decision a
/// rule can carry; a `deny` stays a `deny`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleDecision {
    Allow,
    Deny,
}

/// A user-level EXCEPTION to the posture: `{path, direction, decision}`.
/// `path` supports a leading `~`. Stored as the user wrote it — a leading
/// `~` is expanded to the home dir at MATCH time, never at parse time, so
/// the rule still holds if the home path spelling changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRule {
    pub path: String,
    pub direction: RuleDirection,
    pub decision: RuleDecision,
}
```

`FilePolicy` gains the field and **loses `Copy`** (a `Vec` cannot be `Copy`). The 19-site cost of losing
`Copy` (17 full struct literals + 2 Copy-move sites, across 11 files) is measured in the Blocker and the
resolution is recorded there — **one atomic step lands the field, the derive change, and all 19 edits
together** (any subset leaves the crate non-compiling or clippy-red; there is no green intermediate state
— the blast radius is a property of the language, not of the design):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilePolicy {
    pub reads: AccessPolicy,
    pub writes: AccessPolicy,
    /// `bash`. … (existing comment unchanged)
    pub shell: AccessPolicy,
    /// User rules (`path` may lead with `~`). Serde-defaulted: an old
    /// `settings.json` without the key still parses; an EMPTY list is not
    /// serialized, so the three-direction wire shape is byte-identical to
    /// today (keeps `file_policy_serializes_its_three_directions_in_camel_case`
    /// and the config.rs `contains` pins passing unchanged).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<AccessRule>,
}
```

### The resolver (`policy.rs`, `pub`, beside `decision_for` — the ONE-canonicalizer rule)

```rust
pub fn rule_for<'a>(
    rules: &'a [AccessRule],
    direction: RuleDirection,
    path: &Path,
    home: Option<&Path>,
) -> Option<&'a AccessRule>
```

- **Longest canonical prefix wins, NOT first-match** — the issue #92 failure mode in the rules layer: a broad
  rule (`~`) must not silently swallow a specific one (`~/.pi/agent/agents`). Order-independent for the
  broad/specific case; the UI needs no rule ordering.
- **FILTER, THEN RANK, THEN TIE-BREAK — the exact algorithm (finding 2).** A pair comparison by
  `(component_count, list_index)` alone is wrong: `/tmp` and `/tmpfoo` are both 2 components, and a rule
  that is NOT a prefix of the target wins a same-count tie by list order — silently defeating longest-prefix
  (the exact silent-failure class the spec cites issue #92 for). The resolver must therefore:
  1. **FILTER** to rules that are genuine component-prefixes of the lenient-canonicalized target. Use
     `Path::starts_with` — it compares **component-wise and is `/tmpfoo`-safe by construction**; a string
     `starts_with` has the `/tmpfoo` bug and must not be used. `candidate.starts_with(&canon)` on already
     canonicalized paths is the same containment the existing deny-list uses (`access.rs:173`,
     `fs_backend.rs:168`).
  2. **RANK** the survivors by canonical component count descending (longest prefix wins).
  3. **TIE-BREAK** exact-count ties by list index — **last rule in the list wins** (see the exact-tie
     contract below; this is pinned by `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`).
     With step 1 in place, a same-count tie can only occur between rules that are both genuine prefixes of
     the target with the same component count — i.e. identical canonical paths (sibling paths can NEVER
     tie because the non-prefix sibling is filtered out at step 1).
  Implement as a single fold over `rules` (or `filter` then `fold`) keeping the running best by
  `(prefix_len_desc, index_asc)` — a `max_by_key((component_count, index))` after filtering is fine, but
  the filter MUST come first and MUST be component-based; do not rely on list-order to exclude non-prefix
  siblings.
- **Both sides through `crate::agent::fs_backend::canonicalize_lenient`** — the rule path (after `~`
  expansion) and the CALL path. A rule naming a not-yet-existing directory matches (ADR 0081's leniency is
  load-bearing); a strict `canonicalize()` would fail and match nothing.
- **`home: Option<&Path>`** is the ONLY ambient input, passed as an argument so the resolver is a pure
  function of its inputs like `decision_for` ("does NO I/O and reads no state" — the `$HOME` read is the
  caller's job, so tests need no env pinning). `None` leaves a leading `~` unexpanded; the rule then matches
  nothing — mirroring `protected_dirs()` returning empty when `$HOME` cannot be resolved.
- **Exact canonical tie → the LAST rule in the list wins.** This is a decision the spec does not state, and it
  is load-bearing: user rules are concatenated AFTER `default_rules()` (T03's handoff contract), so the
  allow-directory action (`"the relay appends one `allow` rule"`, spec §The prompt) writes an allow rule whose
  path is an EXACT tie with the default deny — if the default won the tie, allow-directory would silently
  no-op for the most important case. Last-wins is also what a rules-list editor means. Pinned by name below.
- Deterministic tie order as specified above — no custom `Ord`.

Private helper for the `~` expansion (leading literal `~` component only; `~user` and embedded `~` pass
through — an on-disk dir named `~` stays addressable):

```rust
fn expand_rule_path(path: &Path, home: Option<&Path>) -> PathBuf
```

### The default rule set (`policy.rs`) and the `protected_dirs()` derivation (`boundary.rs`)

```rust
/// The DEFAULT rule set (the boundary floor): the four user-level discovery
/// dirs as `Write`/`Deny` — exactly today's deny-list, derived from the SAME
/// sources of truth (`skills::user_roots`, `agents::user_roots`) so there is
/// no second copy of the four dirs to drift. Order preserved (skills two
/// first, then agents two) — the pinned output order.
///
/// CONCATENATION CONTRACT (finding 4): every consumer that puts rules in
/// front of `rule_for` MUST emit `default_rules()` FIRST and user-written
/// rules SECOND. T01's exact-tie rule (last rule wins) depends on this
/// ordering: the Supervisor's "always allow this directory" action appends
/// one `allow` rule AFTER the defaults so it beats a default `deny` on an
/// exact path tie. If a consumer ever concatenates the other way round,
/// the allow-directory action silently no-ops against the default deny.
/// T03/T04 MUST NOT invert this order. (There is no UI-ordering dependency
/// — the only load-bearing order is defaults-then-user.)
///
/// HONEST LIMIT (finding 5): when the home dir cannot be resolved
/// (`skills::user_roots()` / `agents::user_roots()` both return `Vec::new()`
/// when `home_dir()` yields `None`), this function returns an EMPTY list —
/// no rules at all. Under an empty rule set `rule_for` concludes "no match"
/// → the posture select (an ask under the guard), whereas today an empty
/// `protected_dirs()` means "deny nothing". This is a recorded, accepted
/// edge: a no-home process cannot write the four user dirs anyway (it has
/// no home to write into), so the practical exposure is nil; the behaviour
/// is NOT changed (see `default_rules_is_empty_when_the_home_dir_cannot_be_resolved`).
pub fn default_rules() -> Vec<AccessRule>

/// private: shape one user_roots result into Write/Deny rules
fn push_default<T>(out: &mut Vec<AccessRule>, roots: Vec<(PathBuf, T)>)
```

`protected_dirs()` keeps its exact signature and its exact output, but stops being a hardcoded deny-list:

```rust
pub fn protected_dirs() -> Vec<PathBuf> {
    crate::agent::policy::default_rules()
        .iter()
        .filter(|r| r.decision == crate::agent::policy::RuleDecision::Deny)
        .map(|r| {
            let raw = std::path::Path::new(r.path.as_str());
            crate::agent::fs_backend::canonicalize_lenient(raw)
        })
        .collect()
}
```
(`default_rules()`' paths are already ABSOLUTE — `user_roots()` joins `crate::skills::home_dir()` — so no `~`
expansion is needed or done here; the rules' stored spelling is only `~`-relative for USER-written rules.)
`r.path.as_str()` (`&str`) is used rather than `&r.path` (`&String`) because `Path::new` already derefs
coercion fine either way, but the `&str` form is the unambiguous compilable spelling the reviewer asked to
be quoted — it is NOT a `~` single-component trap, because `user_roots()`' paths are absolute; the `~`
expansion only ever applies to user-written rule paths at match time.

- **Preserved, byte-for-byte:** the four dirs, the skills-first order, the keep-a-missing-dir leniency, and
  the raw-return residue — the three literal four-dir tests
  (`protected_dirs_are_the_four_user_level_dirs`, `protected_dirs_keep_a_missing_dir`,
  `protected_dirs_keeps_an_unresolvable_entry_raw`) pass UNCHANGED. (`default_rules()` derives its paths from
  `user_roots()`, so the raw/residue cases behave exactly as today's `push_protected` fed them.)
- **PIN THE DERIVATION AGAINST THE LITERAL LIST, not just against `default_rules()` (finding 3):** the new
  boundary test asserts `protected_dirs()` equals the LITERAL four-dir list under `pin_home` (and that its
  entries are exactly the four pinned trailing components, in order) *and* separately that
  `protected_dirs()` equals the `default_rules()`-derived map. A self-referential
  `protected_dirs() == default_rules().filter(Deny).map(lenient)` comparison alone would pass a derivation
  that drifted to an empty or wrong rule set — the literal pin keeps the derivation honest.
- `push_protected<T>` (boundary.rs private, line 125) becomes dead and is **deleted** (a dead private fn trips
  `dead_code` under `clippy --all-targets` = 0 warnings). Its leniency rationale doc moves into the new
  `protected_dirs` / `default_rules` docs.
- `push_roots`, `canon`, `unrestricted_floor`, `read_roots`, `write_roots`, `executor_roots` untouched.
- **`protected_refusal_text` keeps its wording for the deny case** — untouched (it lives in
  `tools/exec/access.rs`, T03's set; T01 neither edits it nor changes the paths it consumes).

### Deliberately NOT changed

- **`decision_for` signature is NOT extended.** It has exactly one production caller (`gate.rs::policy_verdict`,
  in T03's set). The spec asks for the resolver as a pure function BESIDE `decision_for` — a sibling, not a
  new parameter. T03 wires the precedence rows (1–4) by calling `rule_for` alongside `decision_for`; keeping
  `decision_for` untouched keeps T01 compile-atomic in its own set and hands T03 the whole precedence wiring
  in one place. (Had we extended it, the caller-outside-the-owned-set handoff would be: T03 must pass
  `&self.file_policy.rules` and a home into the new argument — that handoff is unnecessary now.)

---

## Steps: (serial checkboxes — one wave; S1 is a single ATOMIC step, everything after it is additive and
compiles independently; see the Blocker RESOLVED for why there is no smaller green step)

- [ ] **S1 — ATOMIC: add the `rules` field, drop `Copy` from `FilePolicy`, and fix all 19 sites in ONE commit.**
  This step MUST land as one unit — adding the field, dropping the derive, and editing the 19 sites
  (17 full struct literals + 2 Copy-move sites, Blocker table) cannot be split any finer: every subset of
  it leaves the crate non-compiling (a literal naming `rules` before the field exists →
  `error[E0560]: struct FilePolicy has no field named rules`; the field without `Copy` removed → the two
  Copy-move sites stop compiling) or clippy-red (the clippy-legal subset is zero — see the Blocker's two
  measured refutations). The 19 edits are mechanical and behavior-identical.
  - `policy.rs`: add `use std::path::{Path, PathBuf};` (policy.rs currently imports only `serde`); add
    `RuleDirection`, `RuleDecision`, `AccessRule` and the `FilePolicy.rules` field exactly as quoted in
    Design; remove `Copy` from `FilePolicy`'s derive list.
  - `policy.rs:315` (Blocker literal #3, owned): insert `rules: Vec::new(),` into the
    `file_policy_serializes_its_three_directions_in_camel_case` literal.
  - Flipped Copy-move site #1 — `harness/loop/tools.rs:104`: `file_policy: self.file_policy,` →
    `self.file_policy.clone(),` (existing clones of the other `&self` fields sit right above it; one more
    joins them).
  - Flipped Copy-move site #2 — `harness/loop.rs:609`:
    `settings.as_ref().map(|s| s.file_policy).unwrap_or_default()` →
    `settings.as_ref().map(|s| s.file_policy.clone()).unwrap_or_default()`.
  - The 16 remaining literals: `config.rs` (965, 996, 1407, 1472 — sites #4–7), `web/tools.rs:482` (#8),
    `web/extract/tests.rs:18` (#9), `exec/tests/support.rs:37` (#10), `exec/tests/bash.rs` (264, 311 —
    #11, #12), `sandbox.rs` (897, 1546, 1718, 1753 — #13–#16), `tests/skill_tools_boundary.rs` (128, 582 —
    #17, #18), `tests/worker_e2e.rs:744` (#19) — each gets exactly `rules: Vec::new(),` and NOTHING else
    (all other fields already present; these files carry no other change — they are shared with T03/T04's
    sequential waves, and the mechanical-inserts-only limit is the reason that overlap is harmless).
  - Update the module doc's "vocabulary ONLY" sentence: this module now also carries the rules vocabulary and
    the ONE rules resolver (`rule_for`) — the ADR 0029/0030 one-canonicalizer rule ("the gates read these
    values"). The existing doc says "It decides nothing and enforces nothing" — that stays TRUE for the
    posture selects; the rules resolver is the single decision point the spec adds. Keep the doc consistent.
  - New tests, same test module, prose names:
    - `an_access_rule_serializes_its_three_fields_in_camel_case_and_lowercase` — exact JSON
      `{"path":"~/.pi/agent","direction":"read","decision":"deny"}` round-trips; `"readWrite"` is the
      `ReadWrite` wire value.
    - `there_is_no_ask_decision_value` — `serde_json::from_str::<RuleDecision>("\"ask\"")` errors; the enum
      is exactly `"allow" | "deny"` (the spec's central rule, pinned as a compile-time-adjacent wire pin).
    - `file_policy_without_a_rules_key_parses_with_rules_empty` — `{"reads":"allow","writes":"allow"}` →
      `rules.is_empty()`; `{}` → `FilePolicy::default()` with rules empty (the existing
      `a_pre_feature_settings_json_parses_to_the_new_defaults` config pin keeps passing untouched).
    - `an_empty_rules_list_stays_out_of_the_wire_format` — `to_string(FilePolicy::default())` is exactly
      `{"reads":"allow","writes":"allow","shell":"allow"}` (no `"rules"` key).
    - `a_populated_rules_list_serializes_inside_the_file_policy_object` — exact JSON
      `{"reads":"allow","writes":"allow","shell":"allow","rules":[{"path":"~/.pi/agent","direction":"read","decision":"deny"}]}`.
  - Verify: `cargo test --lib policy::tests` (all existing 9 + these 5 green), `cargo clippy --all-targets`
    (the two `.clone()` forms cannot trip `clone_on_copy` — by this commit `FilePolicy` is no longer
    `Copy`).

- [ ] **S2 — `policy.rs`: the resolver.**
  - Add private `expand_rule_path` and `pub fn rule_for<'a>(…) -> Option<&'a AccessRule>` exactly as quoted
    in Design (body: lenient-canonicalize the call path once; for each rule whose `direction.covers` the
    call, expand `~` via `home`, lenient-canonicalize, **keep only when the target is a genuine
    COMPONENT-PREFIX of the canonical rule path — `target.starts_with(&canon)`, the `/tmpfoo`-safe form**;
    then pick the surviving rule with the longest prefix, breaking exact ties by LAST index).
  - New tests (all use `crate::test_support::ScratchDir::in_env_temp("policy-rules-", tag)` as the passed
    `home` — NO `$HOME` env pinning needed, `rule_for` reads no env; assertions compare the RETURNED rule
    against the fixture rules by value, so no canonical-path expectations and no platform drift). Rule paths
    use the raw user spelling (`"~/.pi/agent/agents"`), which is exactly what a `settings.json` holds:
    - `the_longest_canonical_prefix_wins_over_first_match_regardless_of_rule_order` — **spec pin 1.** Rules
      `[ { "~", ReadWrite, Allow }, { "~/.pi/agent/agents", Write, Deny } ]` in BROAD-THEN-SPECIFIC order;
      call path `home/.pi/agent/agents/SKILL.md` (no `.pi/agent/agents` dir created) → returns the Deny
      rule. Then the REVERSED list `[specific, broad]` → still the Deny rule. A first-match implementation
      returns the broad Allow in the first list — this is the pair that reddens it. (See Acceptance for what
      this pin does and does NOT prove about canonicalization.)
    - `a_non_prefix_sibling_path_with_the_same_component_count_never_beats_a_genuine_prefix` — **pin 2,
      the `/tmpfoo` class.** A missed `mktemp`-style scratch root `home/.tmpfoo/skills` is 2 components,
      the target is 2 components and is NOT under it, and a WRONG `(component_count, index)` first-match
      would pick the sibling by list order. Assert: rules
      `[ { "~/.pi/agents", Write, Deny }, { "~/.pi/agent", Write, Deny } ]` — each 2 components — with the
      sibling FIRST, call path `home/.pi/agent/SKILL.md` → the `~/.pi/agent` rule wins REGARDLESS of list
      order (swap the list, same result). This is the sibling-paths regression the previous
      `max_by_key((component_count, index))` design would silently fail. (The sibling is not a
      component-prefix of the target → filtered at step 1.)
    - `a_tilde_rule_and_a_slash_rule_tie_at_one_component_and_last_wins` — **pin 3.** Both
      `~` and `/` canonicalize (under `pin_home`) to 1 component; the call path `home/.pi/agent/agents/SKILL.md`
      is under BOTH. (Neither is "more specific" — the 1-component tie is exactly the surface the spec's own
      pre-filled defaults expose.) Assert: a `/`-only rule set matches it (the `/` prefix), a `~`-only rule set
      matches it, and `[ { "/", Write, Deny }, { "~", Write, Allow } ]` → the tie is broken by list index
      (LAST wins, here the `~` Allow). A strict-`canonicalize()` of the rule paths still matches here (both
      exist under `pin_home`) — the leniency half is pinned separately by
      `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently`.
    - `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently` — **spec pin 2.** One rule
      `{ "~/.pi/agent/agents", Write, Deny }`, `home` exists, `home/.pi/agent/agents` NOT created → call
      path `home/.pi/agent/agents/new/SKILL.md` → Some(Deny). A strict `canonicalize()` on the rule path
      fails and matches nothing, which is exactly the ADR 0081 leniency this pins.
    - `no_matching_rule_returns_none_the_ask_is_the_absence_of_a_match` — no match → `None`, in two shapes
      that mirror the spec's rows 3/4: rules that name an unrelated directory (call path has no
      `.pi/agent` ancestor under a `{ "~/.pi/agent", Write, Deny }` rule) → `None` (the ask row); and a rule
      set with NO rule for the direction at all → `None` (the posture-select fall-through row).
    - `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` — THE concat-order pin
      (finding 4). Rules `[ { "~/.pi/agent/agents", Write, Deny }, { "~/.pi/agent/agents", Write, Allow } ]`
      (default-deny then the allow-directory append) → Some(Allow); REVERSED → Some(Deny). Without this pin,
      "always allow this directory" could silently no-op against the default deny. THE SEAM IS NAMED HERE: a
      consumer that concatenates user rules before `default_rules()` inverts the contract — see the doc
      comment contract on `default_rules()` above and the Handoff section below.
    - `a_read_rule_does_not_cover_a_write_and_read_write_covers_both` — **direction-coverage pin, both ways
      independently (finding 6).** A `Read`-only rule returns `None` for a `Write` call; a `Write`-only rule
      returns `None` for a `Read` call (the two directions asserted INDEPENDENTLY, not one direction pair);
      `ReadWrite` covers both, each asserted against the other direction too.
    - `a_tilde_rule_expands_to_the_passed_home_dir` — rule `"~"` ReadWrite/Allow matches
      `home/anything/deep.txt` via the passed `home`; the same rule with `home: None` matches nothing
      (the no-`$HOME` mirror of `protected_dirs()` returning empty).
  - Verify: `cargo test --lib policy::tests`.

- [ ] **S3 — `policy.rs`: `default_rules()`; `boundary.rs`: the derivation + seam tests.**
  - `policy.rs`: add `pub fn default_rules() -> Vec<AccessRule>` and private `push_default`, exactly as
    quoted (derives from `crate::skills::user_roots()` then `crate::agents::user_roots()`, both `pub`, both
    already consumed by `boundary.rs`). Keep the doc's leniency/order rationale AND the concatenation
    contract AND the no-home honest limit (all in the quoted doc comment).
  - `boundary.rs`: rewrite `protected_dirs()` to the derivation in Design (`Path::new(r.path.as_str())`);
    DELETE `push_protected` (dead); fold its leniency doc into `protected_dirs`'s doc; add `RuleDecision` to
    the existing `use crate::agent::policy::{…}` import (currently `use crate::agent::policy::AccessPolicy;`).
  - New boundary tests (use the existing `pin_home` helper — it pins `$HOME` and creates the four dirs; and
    `pin_empty_home` / the `RestoreHome`-with-remove pattern for the no-home case):
    - `protected_dirs_are_the_derived_default_deny_rule_paths` — **satisfies finding 3:** under `pin_home`,
      `default_rules()` has exactly 4 rules, each `direction == Write, decision == Deny`, and
      `protected_dirs()` equals the LITERAL four-dir canonical list
      (`[".agents/skills", ".pi/agent/skills", ".agents/agents", ".pi/agent/agents"]` joined to the pinned
      home, canonicalized) AND separately equals
      `default_rules().filter(Deny).map(canonicalize_lenient)` — the derivation is pinned against the
      ground truth, not just against itself. A derivation that drifts to an empty or wrong rule set reddens
      the literal half of this pin.
    - `default_rules_is_empty_when_the_home_dir_cannot_be_resolved` — **finding 5's named pin.** Hold
      `crate::test_support::env_lock()`, remove BOTH `HOME` and `USERPROFILE` (a `remove_var` for each; the
      `RestoreHome` guard with `None` restores), call `default_rules()` and assert `.is_empty()` — the
      honest-limit behaviour, pinned so a future change that "fixes" it into a silent fallback default is a
      deliberate, visible decision. Note: `protected_dirs()`'s no-home case is already covered by the
      unchanged `protected_dirs_keeps_an_unresolvable_entry_raw` residue test; this pin nails the rules side
      of the same edge.
  - The three existing literal four-dir tests and `protected_dirs_never_include_a_space_level_dir` must pass
    UNCHANGED — that is the requirement that drives the derivation shape (skills-first order, lenient-keep,
    raw-return residue).
  - Verify: `cargo test --lib policy::tests` and `cargo test --lib boundary::tests` (or
    `cargo test --lib 'policy::tests|boundary::tests'`).

- [ ] **S4 — full unit + gate (the 19 S1 edits are in, by construction):**
  - `cargo test` (full suite, from `src-tauri/`) — the executor deny-list, gate and sandbox consumers of
    `protected_dirs` must stay green: `tools::exec::tests::policy`, `harness::loop::tests::policy_gate`,
    `--test skill_tools_boundary -- a_symlinked_home`, `--test worker_e2e -- permission_round_trip_real_worker`
    (worker_e2e is where Blocker site #19 lives), `tools::sandbox` (Landlock tests skip loudly without a
    kernel; the `TMPDIR=/tmp mktemp` hazard from the grounding applies if a developer's `$HOME` is under
    `/tmp`).
  - `cargo clippy --all-targets` — 0 warnings (dead `push_protected` would redden this — it is deleted; and
    the two `clone()` forms at S1 must not trip `clone_on_copy` — they cannot, because by then `FilePolicy`
    is no longer `Copy`).
  - `cargo fmt --check`.
  - `cargo check --target x86_64-pc-windows-gnu --all-targets` — first Rust wave of this run; the
    `#[cfg(windows)]` path (`the_ask_floor_contains_the_temp_dirs_drive_root`, the Windows arm of
    `unrestricted_floor`) type-checks here and only RUNS on CI. Treat this run as that leg's baseline.
  - `cargo test --lib` does NOT rebuild `fake_worker` — irrelevant here (no wire change in T01); do not run a
    `fake_worker` build.

---

## Acceptance

Measurable; pins name the `#[test]` fns, not a count. Both spec-required pins are present:

1. **Rule precedence by longest prefix** — `the_longest_canonical_prefix_wins_over_first_match_regardless_of_rule_order`
   (policy.rs `mod tests`): the broad `~` allow listed FIRST, the specific `~/.pi/agent/agents` deny second,
   must yield the deny; reversed must yield the same deny. **What this pin actually proves (finding 6):** it
   reddens a first-match implementation; and because the call path is NOT created, it also reddens a greedy
   STRICT-`canonicalize()` implementation (which fails on the missing rule path and matches nothing) — i.e.
   it pins "lenient canonicalization participates in the longest-prefix compare", not merely "the call side
   is lenient". What it does NOT prove on its own: the filter-before-rank sibling fix, the `~`-vs-`/` tie,
   or strict-vs-lenient canonicalization in isolation — those are pinned separately by
   `a_non_prefix_sibling_path_with_the_same_component_count_never_beats_a_genuine_prefix`,
   `a_tilde_rule_and_a_slash_rule_tie_at_one_component_and_last_wins`, and
   `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently` respectively.
2. **A rule naming a not-yet-existing directory matches leniently** —
   `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently` (policy.rs `mod tests`): the
   `.pi/agent/agents` dir is never created and the rule still matches its write target.
3. **Sibling-path and tie-surface pins** — `a_non_prefix_sibling_path_with_the_same_component_count_never_beats_a_genuine_prefix`
   (the `/tmpfoo` class, filter-before-rank) and
   `a_tilde_rule_and_a_slash_rule_tie_at_one_component_and_last_wins` (the `~` vs `/` tie
   surface in the spec's own pre-filled defaults).
4. **Direction coverage, both ways independently** — `a_read_rule_does_not_cover_a_write_and_read_write_covers_both`.
5. **Exact-tie contract + concat order** — `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`
   pins last-rule-wins; the ordering it depends on is named in `default_rules()`'s doc comment (the seam,
   finding 4) and in the Handoff contract — so T03/T04 cannot silently invert it.
6. **Old `settings.json` parses with `rules` absent** — `file_policy_without_a_rules_key_parses_with_rules_empty`
   + `an_empty_rules_list_stays_out_of_the_wire_format` (serialization is byte-identical to today when rules
   are empty), and the untouched config.rs pin `a_pre_feature_settings_json_parses_to_the_new_defaults` stays
   green; `there_is_no_ask_decision_value` pins the central rule.
7. **`protected_dirs()` is the derived default rule set, pinned against the LITERAL list** —
   `protected_dirs_are_the_derived_default_deny_rule_paths` (boundary.rs `mod tests`) asserts BOTH the
   literal four-dir list AND the `default_rules()` derivation; the three literal four-dir pins
   (`protected_dirs_are_the_four_user_level_dirs`, `protected_dirs_keep_a_missing_dir`,
   `protected_dirs_keeps_an_unresolvable_entry_raw`) pass UNCHANGED — output preserved byte-for-byte.
8. **No-home honest limit pinned** — `default_rules_is_empty_when_the_home_dir_cannot_be_resolved`
   (finding 5): behaviour unchanged, recorded, and named so a future "fix" is a visible decision.
9. **Gate**: `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` from `src-tauri/`,
   plus the mingw `cargo check` leg — all green, with S1's 19 edits landed (they are S1 itself).

---

## Risks / honest limits (recorded, not hidden)

- **Compile ripple across 11 files is the ONE atomic S1 commit** — the Blocker RESOLVED, above: 19 sites
  (17 full literals + 2 Copy-move sites); S1 must land as a single commit (field + derive + all 19 edits),
  and the rest of the steps are additive. The old two-phase ordering is VOID — there is no green
  intermediate state in any representation that puts a collection on `FilePolicy` (see the Blocker's two
  measured refutations).
- **Exact-tie semantics are a T01 decision the spec does not state** — last-rule-wins, chosen because
  allow-directory appends user rules after the defaults and must win an exact tie, and because list editors
  read "later row wins". Pinned by `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`.
  T03 MUST append user rules after `default_rules()` (handoff below) or this contract silently inverts.
- **Sibling-path silent failure would not have been caught by the spec's pair** — the `/tmpfoo` class
  (same component count, non-prefix sibling) is exactly what the reviewed `max_by_key((component_count, index))`
  design got wrong, and it is now structurally impossible (filter-before-rank) and pinned by name.
- **Empty-home regression is recorded, not fixed** — `default_rules()` is empty when the home dir cannot be
  resolved, and a no-home `rule_for` concludes "no match" (an ask under the guard) rather than today's
  nothing-to-deny. Honest limit in the doc comment + named pin (finding 5); behaviour deliberately unchanged.
- **Raw-return residue, inherited, not introduced** — a rule whose path cannot resolve at all (a `~` with
  `home: None`, a relative ghost `$HOME`) matches nothing, exactly the residue pinned for `protected_dirs` in
  `protected_dirs_keeps_an_unresolvable_entry_raw`. Documented in `rule_for`'s doc; not fixable without a
  new resolve primitive, and out of scope.
- **Per-call cost** — `rule_for` re-expands and re-lenient-canonicalizes every rule path on every call
  (defaults 4 + a user handful; `canonicalize_lenient` does the small stat-peel). Correct-enough for a gate
  that runs once per tool call; if it ever matters, T03 can pre-canonicalize the frozen per-session rule set.
  Not done here — the frozen set is T03's (freeze-once in `AgentLoop::new` is its seam).
- **`rules` is agent-writable policy** — pre-existing (`filePolicy` already lives in `settings.json`), the
  spec records it, not T01's to fix.
- **No behavior change today** — the four dirs stay write-denied in every policy exactly as before; the ask
  (row 3) and all enforcement wiring are T03.

---

## Handoff to T03 (contract, not edits)

- `rule_for` is the ONE resolver; the gate (`policy_verdict`/`deny_tool_result`) and the executor
  (`protected_refusal`, `protected_refusal_text`) must both call it with the same frozen rule set — the ADR
  0029/0030 one-canonicalizer rule. `decision_for` is untouched and needs no new parameter.
- **Concatenate rules as `default_rules()` THEN user rules — the exact-tie contract depends on it** (finding
  4). T03 wires the precedence rows (1–4) by calling `rule_for` alongside `decision_for`, with the
  defaults-first concat; T04's `allow-directory` append lands AFTER the defaults for the same reason. The
  seam is named in `default_rules()`'s doc comment, so both tasks read the contract where the code lives.
- `protected_dirs()` still returns the four paths; its consumers (deny wording, `ToolCtx.protected`, Landlock
  in `Sandbox::create`) are unchanged by T01; T03 decides what rules mean for the Landlock subtraction (the
  spec's `bash` exclusion).
- Freeze the rule set once per session next to `protected` in `AgentLoop::new` (the grounding-flagged seam —
  loop.rs's Blocker site is in `handle_prompt`'s per-turn refresh, so the frozen-vs-refreshed split is
  already visible there), so the lenient not-yet-existing-dir match cannot silently unguarantee mid-session.
- The gate's `policed_direction` Read members are `read/find/grep/ls`; T03 maps them to `RuleDirection::Read`
  and `write/edit` to `RuleDirection::Write`.

---

## Out of scope (deliberately left for later tasks)

- **T02** — `PermissionOutcome::Selected { option_id, value: Option<String> }`, per-prompt guard option lists
  (drop `trust-space`), the approve predicate, and the `permission.rs` / `worker/*` / `fake_worker` /
  `commands/sessions.rs` edits. T01 neither adds the `value` shape nor touches any prompt code.
- **T03** — enforcement of precedence rows 1–4 at the gate and in the executor, the rules-vs-posture order,
  the trusted-Space deny pin, frozen-per-session rule set, `deny_tool_result` / `protected_refusal_text`
  / `ToolCtx` / `sandbox.rs` wiring. T01 only provides the resolver and the default rule set.
- **T04** — the Supervisor relay persisting `allow-directory` as exactly one rule, the settings round-trip
  (already covered: `rules` parses/serializes — the persist WRITE path is T04), and the nearest-existing-
  ancestor computation.
- **T05 / T06** — frontend wire types and the Settings → Permissions UI (including the spec's pre-filled
  defaults `~` rw allow / `/` read allow / `~/.pi/agent` read deny, which are **settings-written** rules, a
  different thing from T01's in-code `default_rules()` floor; nothing T01 writes into settings).
- **`settings.json`-write protection, bash policing, trust semantics** — the spec's honest limits; no T01
  action.
- **The S1 atomicity** — the type flip is one commit by construction (the Blocker REsolution records the
  orchestrator's grant of option (b), the Owns extension to all 12 files, and the language-level reason
  no smaller green step exists); S1's 19 edits land together and nothing in the steps depends on an
  external owner.