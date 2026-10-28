# Grounding report — Rust policy core (`policy.rs`, `boundary.rs`, `canonicalize_lenient`)

Companion to `docs/roadmap/permissions-section.md` (status: approved). Everything below is
quoted verbatim from the tree at HEAD as of this writing. No design, no recommendations — what
exists today, so a planner never re-reads these files.

Files covered: `src-tauri/src/agent/policy.rs` (343 lines), `src-tauri/src/agent/boundary.rs`
(662 lines), `src-tauri/src/agent/fs_backend.rs` (`canonicalize_lenient` only),
plus every call site of `protected_dirs()` and `decision_for` in the crate.

---

## 1. `src-tauri/src/agent/policy.rs` — structural detail

Module doc (first lines): *"The file-access policy vocabulary (ADR 0030): what the user chose for
each DIRECTION of file access — reads, writes, `bash`."* The doc continues: *"This module is the
vocabulary ONLY. It decides nothing and enforces nothing"* — the gates read these values. It lives
in `agent` because it is domain vocabulary, and **`config` imports it — one of the two sanctioned
`agent` imports in that leaf module (the other is `harness::WireApi`).**

All three types are `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ...)]`.
**No `deny_unknown_fields` anywhere in this file (or in `boundary.rs`).**

### `AccessPolicy` (verbatim)

```rust
/// What happens to a file access that goes BEYOND the boundary. Inside the
/// boundary everything is allowed in every policy — this enum only decides
/// the beyond-boundary case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccessPolicy {
    /// Reject it (a tool-result error, never a prompt).
    Sandboxed,
    /// Prompt the user.
    Ask,
    /// Allow it silently. THE derived default — see `FilePolicy`.
    #[default]
    Allow,
}
```

### `FilePolicy` (verbatim)

```rust
/// The three per-direction policies (the settings' three selects).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilePolicy {
    pub reads: AccessPolicy,
    pub writes: AccessPolicy,
    /// `bash`. Defaults to `Allow` like the others — so this field alone
    /// removes the ADR 0010 untrusted-Space prompt for `bash` unless the
    /// user sets it back to `Ask`. That is the intended product posture
    /// (pi gates nothing), not a bug to "fix" back to `Ask`.
    pub shell: AccessPolicy,
}
```

Serde attributes, precisely:
- `#[serde(rename_all = "lowercase")]` on `AccessPolicy` (wire values `"sandboxed" | "ask" | "allow"`).
- `#[serde(rename_all = "camelCase", default)]` on `FilePolicy` — **container-level** `#[serde(default)]`,
  so a **partial** `filePolicy` object parses with omitted directions at `Allow` (pinned by the test
  `a_partial_file_policy_defaults_the_missing_directions_to_allow`). There is NO field-level
  `#[serde(default)]` on either of the three fields.
- `#[default]` is attached to the `AccessPolicy::Allow` variant; `FilePolicy`'s `Default` impl is the
  derive (all three fields `AccessPolicy::Allow`).
- **No `deny_unknown_fields`.**

### `Decision` (verbatim, doc comment trimmed to the four-variant list)

```rust
/// What the GATE does with one tool call (the return of
/// [`decision_for`]) — the four outcomes of the ADR 0030 policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Run the tool as-is.
    Allow,
    /// Prompt via the existing `gate_tool`.
    Ask,
    /// Reject with a tool-result error; never a prompt.
    Deny,
    /// Run, but inside the OS sandbox (Task 5). Produced ONLY for `bash`.
    Confine,
}
```

Note: **no `Serialize`/`Deserialize`** on `Decision` (the only non-serde type in the file).

### `decision_for` (verbatim signature + per-arm behaviour)

```rust
pub fn decision_for(policy: AccessPolicy, beyond: bool, trusted: bool, is_shell: bool) -> Decision {
    // Inside the boundary every policy allows — the policy decides ONLY
    // the beyond-boundary case.
    if !beyond {
        return Decision::Allow;
    }
    match policy {
        // The derived default: silent.
        AccessPolicy::Allow => Decision::Allow,
        // A prompt, unless Trust suppresses it. Trust is checked HERE and
        // nowhere else: it is a suppressor of prompts, never a widener.
        AccessPolicy::Ask => {
            if trusted {
                Decision::Allow
            } else {
                Decision::Ask
            }
        }
        // `bash` is CONFINED, not refused (Task 5's Landlock sandbox); a
        // path tool has nothing to confine, so it is refused. `trusted`
        // is deliberately unread in this arm — Deny is never widened.
        AccessPolicy::Sandboxed if is_shell => Decision::Confine,
        AccessPolicy::Sandboxed => Decision::Deny,
    }
}
```

Return mapping, case by case (all with `beyond = false` → `Allow` regardless of policy/trusted/is_shell):
- `Allow` + beyond → `Allow` (always).
- `Ask` + beyond + `trusted` → `Allow`; `Ask` + beyond + not trusted → `Ask`.
- `Sandboxed` + beyond + `is_shell = true` → `Confine`; `Sandboxed` + beyond + path tool → `Deny`
  (the `trusted` argument is never read in the `Sandboxed` arms).

The doc comment (verbatim key sentences): *"**Trust suppresses prompts but never widens a deny** —
`Sandboxed` ignores `trusted` entirely"*; *"`bash` has no path to judge, so the caller passes
`beyond = true` UNCONDITIONALLY"*; *"A path-param tool therefore NEVER yields
[`Decision::Confine`]"*.

### Inline `mod tests` (exact line range + every `#[test]` fn)

The only `#[cfg(test)]` block in the file starts at line **105** (`#[cfg(test)]` at 104, `mod tests {`
at 105) and runs to the end of the file at **343**. Nine `#[test]` fns in it, exact names:

1. `the_truth_table_maps_every_policy_beyond_trust_combination`
2. `trust_suppresses_ask_but_never_widens_sandboxed_deny`
3. `sandboxed_shell_confines_instead_of_denying`
4. `path_tools_never_confine`
5. `access_policy_default_is_allow_not_sandboxed`
6. `file_policy_default_allows_every_direction`
7. `access_policy_wire_values_are_lowercase`
8. `file_policy_serializes_its_three_directions_in_camel_case`
9. `a_partial_file_policy_defaults_the_missing_directions_to_allow`

The module opens `use super::*; use AccessPolicy::*;` and defines one const helper, `const PATH_TOOL: bool = false;` (not a test). Test 1 is a `for`-loop truth-table with **one labelled `assert_eq!` per row**; the comment: *"The full 3 × 2 × 2 = 12-case truth table, asserted CASE BY CASE … so a failure names the row that broke rather than a row index."*

---

## 2. `src-tauri/src/agent/boundary.rs` — structural detail

Module doc: *"The ONE place a session's root sets are computed (ADR 0030)."* Two consumers, one
source of truth: the GATE and the EXECUTOR (`FsBackend`) — *"The check itself is NOT reimplemented
here — it is ADR 0029's canonicalize-then-check logic in `FsBackend`; this module only decides WHICH
roots go into it."*

### `protected_dirs()` — full body quoted verbatim (signature + all pre-`pub fn` doc lines)

```rust
/// The write DENY-LIST (ADR 0030, Deviation 3): the four user-level
/// discovery dirs — `~/.agents/skills`, `~/.pi/agent/skills`,
/// `~/.agents/agents`, `~/.pi/agent/agents`. A write whose resolved path
/// is under one of these is refused in EVERY policy (a deny, never a
/// prompt, never widened by Trust): a model that can rewrite
/// `~/.agents/skills/*/SKILL.md` rewrites its own instructions for every
/// future session.
///
/// Entries are canonicalized LENIENTLY (see `push_protected`), which
/// REPLACES the sentence this task reversed — *"Canonicalized; a missing dir
/// is dropped."* (issue #92). A missing dir is now KEPT as its canonical
/// nearest-existing ancestor plus the components that lead to it, because
/// this list is frozen for the Session's life (`AgentLoop::new`) and a
/// dropped entry silently unprotects the agent's own instructions until
/// restart. The READ roots keep the opposite, strict rule on purpose —
/// leniency there would widen what is readable; see `read_roots` and
/// `a_nonexistent_root_is_dropped`.
///
/// The leniency is only half the protection: the comparison that consumes
/// these entries must canonicalize its ENTRY side leniently too, or a
/// still-missing entry matches nothing and this becomes a silent no-op — see
/// `crate::agent::tools::exec::protected_refusal_text` and
/// `a_write_into_a_still_missing_protected_dir_is_refused`.
pub fn protected_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    push_protected(&mut out, crate::skills::user_roots());
    push_protected(&mut out, crate::agents::user_roots());
    out
}
```

The four dirs are hardcoded implicitly in the two feeders it calls:
- `crate::skills::user_roots()` — `pub fn user_roots() -> Vec<(PathBuf, SkillScope)>` (in `src/skills.rs`,
  line 276): `home_dir().join(".agents/skills")` first (tagged `SkillScope::User`), then
  `home_dir().join(".pi/agent/skills")`.
- `crate::agents::user_roots()` — `pub fn user_roots() -> Vec<(PathBuf, AgentScope)>` (in `src/agents.rs`,
  line 255): `home_dir().join(".agents/agents")` first, then `home_dir().join(".pi/agent/agents")`.
- Both use `crate::skills::home_dir()` (`pub(crate)`, in `src/skills.rs`): `$HOME`, else `USERPROFILE`
  (Windows), else `std::env::home_dir()`; none → empty vec, so `protected_dirs()` returns empty.

Private helpers in this module (not `pub`): `unrestricted_floor() -> Vec<PathBuf>` (unix `["/"]`,
Windows one entry per mounted drive root, `C:`–`Z:` probing with `metadata` then canonicalizing,
drives `A:`/`B:` skipped, **not cached on purpose**), `canon(p: &Path) -> Option<PathBuf>`
(`p.canonicalize().ok()`), `push_roots<T>(out, roots: Vec<(PathBuf, T)>)` (strict: drops missing dirs,
dedups), `push_protected<T>(out, roots)` (lenient: `let c = crate::agent::fs_backend::canonicalize_lenient(&path);` then dedups).

### The roots / floor function signatures (verbatim)

```rust
pub fn read_roots(cwd: &Path) -> Vec<PathBuf> {
```

`read_roots`: canonical `cwd` FIRST (empty vec if the cwd cannot be canonicalized — fail closed, the
`FsBackend` treats an empty root set as an error), then appends `skills::user_roots()`,
`agents::user_roots()`, `skills::space_roots(&base)`, `agents::space_roots(&base)` — strict
canonicalization (`push_roots`), missing dirs dropped. Doc: *"`roots[0]` is always the canonical
`cwd` — the relative-path join base."*

```rust
pub fn write_roots(cwd: &Path) -> Vec<PathBuf> {
    canon(cwd).map(|c| vec![c]).unwrap_or_default()
}
```
(write boundary = the canonical `cwd` ONLY; space-level dirs stay writable, user-level dirs are
`protected_dirs`'s job).

```rust
pub fn executor_roots(cwd: &Path, boundary: &[PathBuf], policy: AccessPolicy) -> Vec<PathBuf> {
```
`Sandboxed` → `boundary.to_vec()`; `Ask` | `Allow` → `[canon(cwd) or raw cwd, unrestricted_floor()…]`
(the widening). Doc: *"ONLY this arm widens — the `Sandboxed` arm hands back the caller's real boundary
untouched."*

```rust
pub const UNRESTRICTED: &str = "/";
```
Doc: *"The root-entry meaning 'no containment' on UNIX"* — kept because it names the concept the ADR
text and `fs_backend` docs use; the floor for `Ask`/`Allow` is `unrestricted_floor()`, "the unix half"
of which is this const (Windows needs per-drive roots — a lone `/` on Windows resolves to only the
current drive, which CI proved wrong).

### Inline tests — every `#[test]` / `async fn` name + which assert the four-dir list literally

The `#[cfg(test)] mod tests` runs from line **218** to the end at **662**. Helpers in it: `struct Tmp`
(wraps `crate::test_support::ScratchDir::in_env_temp("boundary-", tag)`), `struct RestoreHome`
(fixed `Drop` restores `$HOME`; a copy of the private one in `loop.rs`'s test module), `fn pin_home(tag)`
— creates the four dirs under a pinned temp `$HOME` and **returns a 3-tuple `(env_lock_guard, RestoreHome, Tmp)`**; `fn pin_empty_home(tag)` — pinned temp `$HOME` with no dirs. Both use
`crate::test_support::env_lock()`.

The ten tests, exact names (nine `#[test]` + one `#[cfg(windows)] #[test]`):

1. `read_roots_puts_the_canonical_cwd_first_and_includes_the_user_dirs`
2. `read_roots_includes_a_repo_root_skill_dir_outside_the_cwd`
3. `a_nonexistent_root_is_dropped`
4. `write_roots_is_only_the_canonical_cwd`
5. `protected_dirs_are_the_four_user_level_dirs`
6. `protected_dirs_never_include_a_space_level_dir`
7. `protected_dirs_keep_a_missing_dir`
8. `protected_dirs_keeps_an_unresolvable_entry_raw`
9. `executor_roots_uses_the_boundary_only_when_sandboxed`
10. `the_unrestricted_root_contains_every_absolute_path`
11. `the_ask_floor_contains_the_temp_dirs_drive_root` — `#[cfg(windows)]`

**Literal four-dir assertions:** the four-dir list is spelled out literally in the array
`[".agents/skills", ".pi/agent/skills", ".agents/agents", ".pi/agent/agents"]` inside three tests:
**`protected_dirs_are_the_four_user_level_dirs`** (asserts `dirs == want` canonically — *this is the
test that pins the list literally, in exact order*), **`protected_dirs_keep_a_missing_dir`** (same
array, expectations spelled through `canonicalize()` — on macOS `/var` → `/private/var`), and
**`protected_dirs_keeps_an_unresolvable_entry_raw`** (same array joined to a relative ghost `$HOME`,
plus the recorded residue: a raw entry does NOT refuse a canonical target, asserted via
`protected_refusal_text(&protected, "write", &canonical_target) == None`). The same dir list (two of
the four, skills write side) is also created by `pin_home`, and both `read_roots` tests assert the
four user dirs are in the read boundary (`read_roots_puts_the_canonical_cwd_first_and_includes_the_user_dirs`).
Test 6 asserts the deny-list never contains a space-level dir; test 8's own doc comment runs the
module's longest (the "Residue D3 names" argument about the raw-return path).

---

## 3. `canonicalize_lenient` in `src-tauri/src/agent/fs_backend.rs`

Exact signature and visibility (line 278):

```rust
pub(crate) fn canonicalize_lenient(path: &Path) -> PathBuf {
    match peel_to_existing(path) {
        Ok(peel) if peel.trailing.is_empty() => peel.canon,
        Ok(peel) => reapply(peel.canon, &peel.trailing),
        Err(_) => path.to_path_buf(),
    }
}
```

- **Visibility: `pub(crate)`** — NOT `pub`. The spec's "already `pub`" claim (`permissions-section.md`
  §Matching) describes the module-level reach: it is crate-visible, not library-public.
- **Not re-exported anywhere.** `src-tauri/src/agent/mod.rs` line 32 re-exports only
  `pub use fs_backend::{FsBackend, FsError};` — `canonicalize_lenient` is reached exclusively via the
  full path `crate::agent::fs_backend::canonicalize_lenient` at its three call sites (see §4).
- Backed by the one implementation of the peel rules: `fn peel_to_existing(path: &Path) -> Result<Peel, FsError>` (private, line 235) + `fn reapply(base: PathBuf, trailing: &[std::ffi::OsString]) -> PathBuf` (private, line 194) + `struct Peel` (private, line 184). Its doc says it is *"THE ONE implementation of the peel rules (the shape [`FsBackend::resolve`] …)"* — `FsBackend::resolve` (line 108) is the same peel.
- **Documented leniency behaviour, one sentence:** a path is canonicalized when it exists, otherwise to its deepest existing ancestor with the remaining components re-appended (idempotent on already-canonical input), and a path with no resolvable ancestor at all comes back unchanged (verbatim: *"A path that cannot be resolved at all (no existing ancestor, or a `..` under a missing parent) comes back UNCHANGED: the caller then compares the raw spelling, which is the best available answer for a caller that cannot fail"*).
- `FsBackend::validate` is `pub fn` (line 83); `FsBackend::resolve` is `pub(crate) fn` (line 108).

---

## 4. Who calls what — every call site

### `decision_for` (signature change ripples into exactly one production caller)

**Only one non-test call site in the whole crate:** `src-tauri/src/agent/harness/loop/gate.rs`, inside
`pub(super) fn policy_verdict(&self, tc: &ToolCall) -> Option<Decision>` (line 70; `decision_for` at
line 96). It is the gate's single verdict maker: computes `dir = policed_direction(&tc.name)?`, then
`(policy, beyond)` per direction (`Shell` → `(self.file_policy.shell, true)` unconditionally; `Read`/`Write`
→ looks up `tc.arguments["path"]` — missing path returns `Some(Decision::Allow)` — then
`direction_policy(dir)` and `beyond = self.beyond_error(dir, Path::new(raw)).is_some()`), then
`trusted` from `self.trust` (a `StaticTrustSource`-style trait object) checked against `self.space_cwd`,
then `Some(decision_for(policy, beyond, trusted, dir == PolicyDirection::Shell))`.

Supporting facts for the ripple:
- `POLICIED_TOOLS: &[(&str, PolicyDirection)]` (line 17): `("bash", Shell), ("read", Read),
  ("find", Read), ("grep", Read), ("ls", Read), ("write", Write), ("edit", Write)` — the scope list a
  rules layer filters on (rules cannot reach `bash`, and the five path tools are exactly this list's
  Read/Write members) lives HERE, not in `policy.rs`.
- `grep` / `glob` are gated as **`PolicyDirection::Read`** at the gate today.
- The gate's other consumer of the protected list: `pub(super) fn deny_tool_result(&self, tc: &ToolCall) -> ToolResult` (line 154) — the deny-list is checked BEFORE the boundary (*"the refusal is true in every policy, so its wording must win over 'escapes the sandbox'"*), gated to writes only (`(dir == Some(PolicyDirection::Write)).then(|| protected_refusal_text(&self.protected, &tc.name, path)).flatten()`), else falls back to `escape_text`.
- Test call sites of `decision_for`: only the inline tests in `policy.rs` (names listed in §1) plus doc references in `src/agent/harness/loop/tests/policy_gate.rs` (no direct calls there — it exercises the gate end-to-end).

### `protected_dirs()` — every call site (7 production + test-only)

Production:
1. **`src-tauri/src/agent/harness/loop.rs` → `AgentLoop::new(...)`** (line 325: `let protected = crate::agent::boundary::protected_dirs();`). Stored as the `protected: Vec<PathBuf>` field (declared line 261, doc: *"(ADR 0030) The write DENY-LIST (`boundary::protected_dirs()` — the ...) frozen for the Session's life ... `AgentLoop::new`")*. **Computed once, then frozen** — the currently load-bearing "freeze once per session" property the status file flags as needing to extend to the default rule set, and the reason the NOT-yet-created-dir leniency matters (a recreated `~/.pi/agent/agents` mid-session must still be refused).
2. **`src-tauri/src/agent/harness/loop/tools.rs` → `AgentLoop::dispatch_tool`** (`pub(super) async fn`): builds the `ToolCtx` for `execute_tool` — the match arm's literal `protected: self.protected.clone(),` (line 99) — i.e. the frozen field cloned per tool call into `ToolCtx`. (Not a direct `protected_dirs()` call; the direct call is only in `AgentLoop::new`, whose field this clones.)
3. **`src-tauri/src/agent/tools/sandbox.rs` → `Sandbox::create(cwd: &Path) -> Result<Self, String>`** (`pub fn`, line 484): `let protected: Vec<PathBuf> = crate::agent::boundary::protected_dirs();` (line 541) — the confined-`bash` Landlock consumer; passed into `sandbox.rule_write_root(&dir, &protected, true)` per write root, then the temp dirs. `rule_write_root` (private, line 567) tests `root == p || root.starts_with(p)`, then canonical-vs-entry `starts_with`, then `p.starts_with(&canonical)` (an entry INSIDE the root) → recurse via `rule_root_around_protected` (private, line 595). **This is the third consumer the spec's "gate and executor" framing does not mention** (flagged in the status file as a T03 decision: rules never apply to `bash`, so what does the default rule set mean for the Landlock subtraction?).
4. **`src-tauri/src/agent/tools/exec/access.rs`** — not a direct call: `pub(crate) fn protected_refusal(ctx: &ToolCtx, tool: &str, resolved: &Path) -> Option<String>` (line 51) and its split-out `pub(crate) fn protected_refusal_text(protected: &[PathBuf], tool: &str, resolved: &Path) -> Option<String>` (line 160) consume the `ctx.protected` / passed slices — and `protected_refusal_text` is the **gate's wording twin**: *"split out so the GATE (`loop.rs`) refuses a protected write in EXACTLY the executor's words"*. Its body carries the two lenient comparisons (`canonicalize_lenient` on the resolved target, then a `find` doing `resolved.starts_with(canonicalize_lenient(dir))`). It is re-exported at `src-tauri/src/agent/tools/exec.rs` line 17: `pub(crate) use access::protected_refusal_text;` — the gate imports it via that. (The spec's "protected_refusal_text keeps its wording" asks live in this function.)
5. **`src-tauri/src/agent/tools/types.rs`** — `ToolCtx` field `pub protected: Vec<PathBuf>` (struct at line 76; doc comment at line 111 names `boundary::protected_dirs()` as the deny-list, "frozen").
6. **`tests/skill_tools_boundary.rs` → `a_symlinked_home_yields_canonical_roots_and_still_denies_writes`** (integration test, line 574: `let protected = boundary::protected_dirs();`) — asserts the canonical skill dir is protected and a write addressed through the symlinked spelling is still refused.

Test-only call sites: line 450 and line 537 of `src-tauri/src/agent/tools/exec/tests/policy.rs` (in `a_recreated_protected_dir_is_refused_without_a_new_session` and `a_write_into_a_still_missing_protected_dir_is_refused`), and three places in `src-tauri/src/agent/tools/sandbox.rs`'s inline tests (`a_session_cwd_inside_a_protected_dir_cannot_write_there` line 2140 — asserts `skills.starts_with(p)` for the *pinned-home* dir; `a_write_root_containing_a_protected_dir_stays_writable_around_it` line 2207 — `assert!(!crate::agent::boundary::protected_dirs().is_empty())`). Because every call site besides these tests reads `$HOME`, all such tests pin `HOME` under a scratch dir and hold `crate::test_support::env_lock()`.

Also note: `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` (line 60's doc: *"`AgentLoop::new`'s `read_roots` / `protected_dirs` see an [empty scratch home]"*) and `src/agent/harness/loop/tests/param_rejection.rs` reach `protected_dirs` indirectly through `AgentLoop::new`; `src/agent/tools/exec/tests/support.rs` and `src/agent/tools/exec/tests/bash.rs` build `ToolCtx { protected: Vec::new(), ... }` by hand.

---

## 5. Conventions this area follows

- **Prose-sentence test names** — every test in `policy.rs`, `boundary.rs`, `fs_backend.rs`,
  `tools/exec/tests/policy.rs`, `harness/loop/tests/policy_gate.rs`, `harness/loop.gate.rs`'s module
  and `tests/skill_tools_boundary.rs` uses full-sentence (lowercase prose) names. Three verbatim examples:
  - `protected_dirs_keep_a_missing_dir`
  - `the_truth_table_maps_every_policy_beyond_trust_combination`
  - `a_write_into_a_still_missing_protected_dir_is_refused`
  (others seen: `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`,
  `the_unrestricted_root_contains_every_absolute_path`.)
- **Serde defaults are pinned in tests in three layers**:
  - `policy.rs`'s own tests pin the wire format and the defaults (`access_policy_wire_values_are_lowercase`,
    `file_policy_serializes_its_three_directions_in_camel_case` — the JSON string `r#"{"reads":"sandboxed","writes":"ask","shell":"allow"}"#` is asserted literally — and `a_partial_file_policy_defaults_the_missing_directions_to_allow` — `r#"{ "reads": "ask" }"#` parses with the rest `Allow`, and `{}` parses to `FilePolicy::default()`).
  - `src-tauri/src/config.rs` pins the settings layer: `file_policy_defaults_to_allow_in_every_direction`
    (a pre-feature file with **no `filePolicy` key** parses to all-`Allow`; empty `"filePolicy": {}` too;
    the wire key `filePolicy` camelCase pinned in `file_policy_serializes_under_the_camel_case_file_policy_key`),
    and `a_pre_feature_settings_json_parses_to_the_new_defaults` (the `config.rs:686` test the spec names:
    *"an old `settings.json` parses to the new defaults"*).
  - The three fields of `FilePolicy` carry **no per-field** `#[serde(default)]`, so adding `rules: Vec<AccessRule>`
    with a field-level default compiles cleanly against the container-level `default` (the container
    attribute calls `Default::default()` for every omitted field).
- **`pub` vs `pub(crate)` for cross-module helpers:** this area uses `pub` for anything consumed
  across module boundaries *by both gate and executor layers* — `AccessPolicy`, `FilePolicy`,
  `decision_for`, `read_roots`, `write_roots`, `protected_dirs`, `executor_roots`, `UNRESTRICTED` are
  all `pub`; the module-internal mechanics are private (`unrestricted_floor`, `canon`, `push_roots`,
  `push_protected`, `peel_to_existing`, `reapply`); `canonicalize_lenient`, `home_dir`,
  `protected_refusal`, `protected_refusal_text` are **`pub(crate)`**; the gate equivalents that other
  crates must not reach (`policy_verdict`, `deny_tool_result`, `policed_direction`) are `pub(super)`.
  `boundary` and `policy` are both declared `pub mod` in `src/agent/mod.rs` (lines 5 and 20) and are
  reached from `config`, `sandbox.rs`, `loop.rs`, `access.rs` via full paths
  (`crate::agent::boundary::…`, `crate::agent::policy::…`) — **no re-exports** of these two modules'
  items at `crate::agent` level (only `FsBackend`/`FsError` are re-exported).
- **`$HOME` sensitivity:** every consumer of `protected_dirs`/`read_roots`/`write_roots` reads `$HOME`,
  so tests pin `HOME` under a scratch dir via `crate::test_support::env_lock()` and a `RestoreHome`
  drop guard, binding all three tuple elements to non-underscore names so the guard outlives the test's
  body (a `_`-prefixed binding drops immediately — the doc in `pin_home` says so explicitly).
- **The test-module rule:** `sandbox.rs`'s `confined_ctx` (line 891) is *"HERMETIC — single-root
  boundary and an empty deny-list, NEVER the `$HOME`-reading boundary helpers (the `exec.rs`
  test-module rule)"*.

---

## 6. Exact commands to test just this area

From `src-tauri/` (single crate; lib name `archimedes_lib`, bin name `archimedes`):

```bash
# The two modules' inline tests:
cargo test --lib policy::tests
cargo test --lib boundary::tests
# or both at once:
cargo test --lib 'policy::tests|boundary::tests'

# The executor-side deny-list tests that consume protected_dirs:
cargo test --lib tools::exec::tests::policy
# The gate-side end-to-end policy tests (incl. protected wording + trusted-space pins):
cargo test --lib harness::loop::tests::policy_gate
# The integration suite that drives read_roots/protected_dirs through real tools:
cargo test --test skill_tools_boundary -- a_symlinked_home
# The Landlock (confined bash) consumers of protected_dirs — Linux-only runtime:
cargo test --lib tools::sandbox

# Whole-suite discipline the spec names (gate-level verification):
cargo test --lib
cargo clippy --all-targets
cargo fmt --check
```

Free-runner caveats that hold for this area (recorded in the spec's Verification section, confirmed
in the tree): `cargo test --lib` does NOT rebuild `fake_worker` (a separate `cargo check`/
`cargo build --bin fake_worker` if the wire changes); `#[cfg(windows)]` behaviour (the
`the_ask_floor_contains_the_temp_dirs_drive_root` test and the Windows arm of `unrestricted_floor`)
type-checks locally and only RUNS on CI; `sandbox.rs`'s confined tests `require_sandbox!()` (skip
loudly on a kernel without Landlock), and two of them (`a_confined_command_works_normally_inside_the_boundary`,
`a_confined_shell_can_still_do_ordinary_things`) run `TMPDIR=/tmp mktemp` — they redden if a
developer's `$HOME` is itself under `/tmp` with the lenient protected entries (ADR 0081, the
`/tmp`-under-`$HOME` hazard — check `$HOME` before re-diagnosing Landlock).
Also: tests in this crate are free-running (no target-dir isolation observed for these modules).
No command was compiled or run during this grounding; the filters above are derived from the module
paths (`policy::tests`, `boundary::tests`, `tools::exec::tests::policy`, `harness::loop::tests::policy_gate`,
`tools::sandbox`, `--test skill_tools_boundary`).

---

## 7. Anything already implemented that the spec asks for

**Nothing in code.** Grep results across `src-tauri/src/`:

- **`AccessRule`** — zero occurrences in `src/` (and no `AccessRule` in `docs/` except
  `docs/roadmap/permissions-section.md` itself, the approved spec, and its grounding sibling
  `permissions-section-ground-frontend-prompt.md`). The spec's `rules: Vec<AccessRule>` does not exist;
  `FilePolicy` has exactly the three fields quoted in §1.
- **`rules` as a policy field** — `FilePolicy` has no rules and no `deny_unknown_fields`, so a
  `settings.json` carrying `"rules": [...]` parses today with the key silently dropped (serde default
  behavior on unknown fields) — the type under the key does not exist. The only `rules` identifiers in
  `src/agent/` are the prompt builder's `<rules>` system-prompt block (`harness/prompt.rs`, static
  `Vec<&str>` of guidance strings — unrelated) and Landlock ruleset machinery (`sandbox.rs`'s
  `rule_write_root`, `rule_root_around_protected`, `add_path`, `ruleset_abi_version` — unrelated: they
  are OS-sandbox calls, not policy rules).
- **`longest`** — the only hits in `src/agent/` are *"the longest run of UNEXPLAINED SILENCE"*
  (worker-manager tests / subagent_flow docs) — no longest-prefix matching exists anywhere.
- **`prefix`-style rule matching in `policy.rs`/`boundary.rs`** — none; the only path-prefix logic in
  the area is `FsBackend`'s containment `starts_with` checks (fs_backend.rs) and the deny-list
  `starts_with` in `access.rs`'s `protected_refusal_text`, neither of which is a rules resolver.
- **The `decision` vocabulary of the spec** — `Decision` exists but its variants are
  `Allow / Ask / Deny / Confine`; there is **no `ask` rule value** (spec: *"There is no `ask` decision
  value"* — consistent) but equally there are no rules to carry `deny` either. `PermissionOutcome::Selected`
  is still `{ option_id }` with **no `value` field** (`option_id: "allow"` at
  `src/agent/permission.rs` line 160 — the one glove-box-shaped `Selected` construction; the spec's
  `Selected { option_id, value: Option<String> }` is NOT implemented).
- **Guard-prompt changes** — not implemented: `native_permission_gate` still emits *"always three
  options"* including `trust-space` (`src/agent/permission.rs` lines 187–193, with the exact comment
  the spec quotes: *"always three options, since a prompt only ever appears for an untrusted Space, so
  `trust-space` is always actionable"*), and the `trust-space` write still lives in the Supervisor relay.
- **`protected_dirs()` as a default rule set** — not implemented. The function is still a hardcoded
  deny-list consumed as such by the gate (`deny_tool_result` before the boundary), the executor
  (`protected_refusal`), the Landlock ruleset (`Sandbox::create`), and the freeze-once
  `AgentLoop::new` snapshot. Its leniency per ADR 0081, which the spec says must become load-bearing
  for rules, is already implemented (documented in §2/§3: entries kept when missing; the consuming
  compare canonicalizes both sides leniently; the raw-return residue is pinned by
  `protected_dirs_keeps_an_unresolvable_entry_raw`).

**Docs mention it — separately:** the spec itself (`docs/roadmap/permissions-section.md`) designs the
rules layer, and `docs/roadmap/permissions-section-ground-frontend-prompt.md` already records
*"`rules` / `AccessRule` on `FilePolicy` (type, store, or Settings UI) — `FilePolicy` is [not yet
implemented]"*. `docs/roadmap/permissions-section-status.md` (mode: autonomous, updated
2026-10-28) breaks the work into T01 (policy-core: *"Rule model + longest-prefix resolver;
`protected_dirs()` becomes the default rule set"*, owning `src-tauri/src/agent/policy.rs` and
`src-tauri/src/agent/boundary.rs`) … T03 (gate + executor precedence, owning
`harness/loop.rs`, `tools/exec/access.rs`, `tools/exec/tests/policy.rs`, `tools/types.rs`,
`tools/sandbox.rs`, `harness/loop/tests/param_rejection.rs`), and already records the two grounding
facts this report independently confirms: `tools/sandbox.rs` is a **third** consumer of
`protected_dirs()` the spec's two-layer framing misses, and `AgentLoop::new` freezes `protected` once
per session so the default rule set must be frozen the same way or gate and executor disagree
mid-session. ADRs 0030 (`docs/decisions/0030-file-access-policy.md`, Deviation 3 = the deny-list) and
0081 (`docs/decisions/0081-…-lenient-compare-…`) document today's behaviour, not the rules layer. No
ADR 0083 exists. In short: **all rule machinery — type, resolver, default rule set, guard prompt,
`allow-directory` persistence — is unimplemented; the only implemented half is the lenient
canonicalizer the matching must reuse.**