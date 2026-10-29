# Grounding Report — policy-exec: protected-dir guard + executor policy tests (#104)

**Scope:** `boundary::protected_dirs()` and the executor-side policy tests, for planning task **A1 / #104** — the test pinning that a write into a protected directory's own PARENT still succeeds (the falsifier ADR 0081 names).
**Branch:** `feature/agent-permission-and-pins` @ `2b6bd26` ("Permissions: the agent's own dirs become an ask, plus a rule model (#119)").
**Grep/verification bases are quoted below; every signature is verbatim from the tree at this commit.** No source file was touched; this report is the only write target.

---

## 1. `src-tauri/src/agent/boundary.rs` — `protected_dirs()` and friends

### 1a. The four dirs (exact strings)

The four user-level discovery dirs, quoted verbatim from `protected_dirs`'s doc:

> the four user-level discovery dirs — `~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents`

They are fed to `protected_dirs()` by two feeders, in this order (skills first, then agents):

- `crate::skills::user_roots()` → `home_dir().join(".agents/skills")`, `home_dir().join(".pi/agent/skills")` (`src-tauri/src/skills.rs:276-284`)
- `crate::agents::user_roots()` → `home_dir().join(".agents/agents")`, `home_dir().join(".pi/agent/agents")` (`src-tauri/src/agents.rs:255-263`)

So the final list order is: `~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents`.

### 1b. How HOME is read

`skills::home_dir()` (`src-tauri/src/skills.rs:286-290`), the chain `protected_dirs()` (via both `user_roots`) goes through:

```rust
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(std::env::home_dir)
}
```

Important consequence for any new fixture: **`protected_dirs()` reads the `HOME` env var at call time.** That is the entire reason the HOME-pinning mechanism in §3 exists — a test that calls `protected_dirs()` (as the two session-snapshot template tests do) MUST pin `$HOME` first, or it snapshots the developer's real `~/.agents/*`. On unix `home_dir()` falls back to the passwd database when `HOME` is unset (measured in ADR 0081), so "unset HOME" is NOT a usable way to empty the list.

### 1c. `protected_dirs()` in full (verbatim)

```rust
pub fn protected_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    push_protected(&mut out, crate::skills::user_roots());
    push_protected(&mut out, crate::agents::user_roots());
    out
}
```

### 1d. Canonicalisation + missing-dir behaviour + `push_protected`'s lenient keep-raw rule

`push_protected` (verbatim body):

```rust
fn push_protected<T>(out: &mut Vec<PathBuf>, roots: Vec<(PathBuf, T)>) {
    for (path, _scope) in roots {
        let c = crate::agent::fs_backend::canonicalize_lenient(&path);
        if !out.contains(&c) {
            out.push(c);
        }
    }
}
```

The lenient canonicaliser (`src-tauri/src/agent/fs_backend.rs`) — the ONE peel implementation, also used by `FsBackend::resolve`:

```rust
pub(crate) fn canonicalize_lenient(path: &Path) -> PathBuf {
    match peel_to_existing(path) {
        Ok(peel) if peel.trailing.is_empty() => peel.canon,
        Ok(peel) => reapply(peel.canon, &peel.trailing),
        Err(_) => path.to_path_buf(),
    }
}
```

(`peel_to_existing` canonicalizes the DEEPEST EXISTING ANCESTOR, re-appends the trailing components; `Err` → the path comes back RAW. Leniency keeps a missing dir: `push_protected`'s doc — *"a missing dir is KEPT as its canonical nearest-existing ancestor plus the components that lead to it"* — pinned by `protected_dirs_keep_a_missing_dir`; the fully-unresolvable case comes back raw, pinned by `protected_dirs_keeps_an_unresolvable_entry_raw`.)

**Why lenient (the D3/issue-#92 rationale, in its own words):** the list is *"frozen for the Session's life (`AgentLoop::new`)"* and *"a dropped entry silently unprotects the agent's own instructions until restart"*; the leniency *"only ever DENIES more"*.

Note the **read roots keep the opposite (strict) rule** (`push_roots` / `canon` drop missing dirs) — deliberate, separately documented.

### 1e. Where the guard is consumed

`protected_dirs()`'s doc names its three consumers:
1. the gate's row-3 membership (`is_guard_path`) in `harness/loop/gate.rs`;
2. the executor's guard/deny wording (`protected_refusal_text`);
3. the Landlock subtraction in `agent/tools/sandbox.rs`.

The sandbox consumer is why the list stays a plain four-path list never derived from the rule set (a rule change must not be able to silently empty the Landlock subtraction and widen the shell).

---

## 2. `src-tauri/src/agent/tools/exec/tests/policy.rs` — fixture/helper shape

### 2a. Where the two session-snapshot tests live

Both are `#[tokio::test]` async fns in `exec/tests/policy.rs`, defined AFTER a local `RestoreHome` guard (declared at policy.rs line ~806) and after `a_rule_allow_makes_the_write_land`:

- `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording` — starts at `policy.rs:837`
- `a_write_into_a_still_missing_protected_dir_is_refused` — starts at `policy.rs:946`

Both carry `#[allow(clippy::await_holding_lock)]` above the `#[tokio::test]` because they hold the env mutex across an `.await` (the `execute_tool` call).

### 2b. The near-verbatim template to clone (minus the recreation)

**`a_write_into_a_still_missing_protected_dir_is_refused`** is the closer template (the new test reuses its shape minus nothing — same home, same `.pi/agent` anchor, same missing `.pi/agent/agents`, same frozen-snapshot `protected`, same ToolCtx construction; only the target, the rule, and the refused/did-not-land assertions change). Its full body, verbatim:

```rust
/// (issue #92 + T03 row 1) THE FALSIFIER for the second half of the #92 fix —
/// the test that makes `access.rs`'s entry-side leniency load-bearing.
///
/// Same fixture as
/// [`a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`]
/// MINUS the recreation: the snapshot is built while `$HOME/.pi/agent/agents` is
/// missing and the dir is NEVER created, so at COMPARE TIME the entry is still
/// missing. With change (1) alone (entries kept, comparison untouched) the entry
/// sits on the list and a strict `canonicalize()` on it fails, so it matches
/// NOTHING: the deny falls through to the generic rule-deny sentence and the file
/// lands — the exact silent no-op D3 was corrected for. So: the session-snapshot
/// tests pin change (1); THIS test pins change (2). A run where only change (1)
/// landed reddens exactly this one test.
///
/// (T03) The refusal needs a USER `deny` rule — a no-rule protected write now
/// dispatches (the gate owns its row-3 ask) — which is what makes the WORDING the
/// discriminating assertion rather than `is_error`: the deny exists either way,
/// and only the entry-side leniency decides WHICH sentence it gets.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_write_into_a_still_missing_protected_dir_is_refused() {
    use crate::agent::policy::{AccessPolicy, FilePolicy};

    let home = temp_cwd("still-missing-home");
    let lock = crate::test_support::env_lock();
    let original = std::env::var_os("HOME");
    let restore = RestoreHome(original);
    // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span.
    unsafe { std::env::set_var("HOME", home.path()) };

    std::fs::create_dir_all(home.path().join(".pi/agent")).unwrap();
    let agents = home.path().join(".pi/agent/agents");

    let protected = crate::agent::boundary::protected_dirs();
    assert!(
        protected.contains(&home.path().canonicalize().unwrap().join(".pi/agent/agents")),
        "the snapshot must carry the not-yet-existing dir — that is the premise: {protected:?}"
    );

    let cwd = temp_cwd("still-missing-cwd");
    let deny = AccessRule {
        path: "~/.pi/agent/agents".to_string(),
        direction: RuleDirection::Write,
        decision: RuleDecision::Deny,
    };
    let c = ToolCtx {
        protected,
        rules: crate::agent::policy::default_rules()
            .into_iter()
            .chain(std::iter::once(deny))
            .collect(),
        home: Some(home.path().canonicalize().unwrap()),
        file_policy: FilePolicy {
            writes: AccessPolicy::Allow,
            ..FilePolicy::default()
        },
        ..ctx(&cwd)
    };
    let target = agents.join("SKILL.md");
    let r = execute_tool(&c, "write", &json!({ "path": target, "content": "PWNED" })).await;

    assert!(
        r.is_error,
        "a write into a protected dir that is STILL missing must be refused: {}",
        text_of(&r)
    );
    let text = text_of(&r).to_string();
    assert!(
        text.contains("protected agent-definition directory"),
        "the still-missing entry must still MATCH (the entry-side lenient \
         compare): a strict `canonicalize()` there answers the deny with the \
         generic rule-deny sentence and lets the write land: {text}"
    );
    assert!(
        text.ends_with(PROTECTED_WRITE_ROUTE),
        "the refusal must end with the sanctioned route: {text}"
    );
    assert!(
        !agents.exists(),
        "nothing was created, so the peel's not-yet-exists premise held"
    );

    drop((restore, lock));
}
```

The recreated variant (`policy.rs:837`) is this same shape but additionally does `std::fs::create_dir_all(&agents).unwrap();` between the snapshot (step 1) and the premise check (step 2), with the premise check placed BEFORE the recreation; its did-not-land assertion is `assert!(!target.exists(), …)` instead of `!agents.exists()`.

### 2c. How the fixture pins HOME

Both session-snapshot tests do it inline (NOT via `boundary.rs`'s `pin_home` helper — that one is private to `boundary.rs`'s test module):

```rust
let home = temp_cwd("still-missing-home");
let lock = crate::test_support::env_lock();
let original = std::env::var_os("HOME");
let restore = RestoreHome(original);
unsafe { std::env::set_var("HOME", home.path()) };
```

then `.pi/agent` is created (`std::fs::create_dir_all(home.path().join(".pi/agent")).unwrap();`) while `.pi/agent/agents` is deliberately NOT created, then `let protected = crate::agent::boundary::protected_dirs();` snapshots the list. At the end: `drop((restore, lock));`.

### 2d. How the scratch tree is built

Via `temp_cwd(tag)` → `crate::test_support::ScratchDir::in_env_temp("exec-", tag)` (see §3b for the census implications). `home`, `cwd`, and the target all come from `ScratchDir`s whose `Drop` removes them; `create_dir_all` builds `.pi/agent` as the peel ANCHOR so the frozen entry is "canonical-nearest-existing-ancestor + one trailing component" (`.pi/agent/agents`) on every platform, not a raw peel — and the premise assertion is spelled through `canonicalize()` because macOS `temp_dir()` is under `/var` → `/private/var`.

### 2e. How the tool ctx / `protected` list are constructed

`ToolCtx` comes from the module's hermetic helper `ctx(&cwd)` (`tests/support.rs:23-60`), struct-updated:

```rust
let c = ToolCtx {
    protected,
    rules: crate::agent::policy::default_rules()
        .into_iter()
        .chain(std::iter::once(deny))
        .collect(),
    home: Some(home.path().canonicalize().unwrap()),
    file_policy: FilePolicy {
        writes: AccessPolicy::Allow,
        ..FilePolicy::default()
    },
    ..ctx(&cwd)
};
```

The precedent from `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`'s doc comment: **the USER `deny` rule is needed because `default_rules()` is EMPTY — a no-rule protected write now DISPATCHES (the gate owns its row-3 ask), so the refusal asserted there needs the rule.** For the NEW test (a success), the cleanest shape is likely `writes: Allow` and NO rule at all — but see §5 on whether a `deny` rule is actually needed to make the mutation observable.

### 2f. The `#[tokio::test]` attribute and this module's `#[test]`-only tests

- All executor-tool tests that call `execute_tool(...).await` are `#[tokio::test] async fn`.
- Two `#[test]` sync tests exist in the same file (`a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_matches_and_decides`; and `a_raw_argument_still_refuses_against_canonical_protected_entries`, `#[cfg(unix)]`) — they call `protected_refusal_text` directly, not `execute_tool`.
- `policy.rs`'s imports: `use super::support::*;` (so `temp_cwd`, `ctx`, `ctx_policy`, `text_of`, `can_confine` all come from `tests/support.rs`), plus `crate::agent::tools::exec::access::PROTECTED_WRITE_ROUTE`, `crate::agent::tools::exec::execute_tool`, `#[cfg(unix)] use crate::agent::tools::exec::protected_refusal_text;`, `crate::agent::tools::types::ToolCtx`, and `crate::agent::policy::{AccessRule, RuleDecision, RuleDirection}`.
- `tests/mod.rs` declares `mod policy;` (plus `bash`, `bash_hostenv`, `fs_tools`, `search`, `skills` and `pub(crate) mod support;`); `support.rs` is NOT a `#[cfg(test)]`-only file — `temp_cwd`, `ctx`, `ctx_policy`, `text_of`, `can_confine` are `pub(crate)`.

### 2g. Every helper the template calls, and where it lives

| Helper | Location | Notes |
|---|---|---|
| `temp_cwd(tag)` | `exec/tests/support.rs:16-19` | `ScratchDir::in_env_temp("exec-", tag)` — sole `exec-*` minter; `ScratchDir` is NOT `Clone` (`to_path_buf()` is the escape hatch). |
| `ctx(&cwd)` | `exec/tests/support.rs:25-60` | Hermetic ToolCtx: `boundary = vec![cwd]`, `protected = Vec::new()`, `rules = Vec::new()`, `home = None`, `reads/writes = Sandboxed`, `shell = Allow`. Doc: *"this must NEVER derive them from the `$HOME`-reading boundary helpers"*. |
| `ctx_policy(&cwd, FilePolicy)` | `exec/tests/support.rs:62-66` | `ToolCtx { file_policy: policy, ..ctx(cwd) }`. |
| `text_of(&ToolResult)` | `exec/tests/support.rs:79-85` | First text block's text. |
| `crate::test_support::env_lock()` | `src-tauri/src/test_support.rs` | `ENV_LOCK` mutex (poison-tolerant). |
| `RestoreHome` | LOCAL to `exec/tests/policy.rs` (`.path: 806-812`) | A local copy of boundary.rs's guard; policy.rs's own doc says *"`exec/tests` had no `RestoreHome` before #92 and these are its only `$HOME` readers"*. |
| `crate::agent::boundary::protected_dirs()` | production | Called directly by the template (reads `$HOME` — hence the pin). |
| `execute_tool` | `agent/tools/exec.rs:43` | `pub async fn execute_tool(ctx: &ToolCtx, tool: &str, params: &Value) -> ToolResult`. |
| `json!` | `serde_json` | `use serde_json::json;` at top of policy.rs. |
| `default_rules()` | `crate::agent::policy` | Returns `Vec::new()` (EMPTY by design, round-3 correction). |
| `AccessRule` / `RuleDecision` / `RuleDirection` | `crate::agent::policy` | Imported at policy.rs top. |
| `PROTECTED_WRITE_ROUTE` | `exec/access.rs` | `pub(crate) const` — the sanctioned route sentence. |
| `AccessPolicy` / `FilePolicy` | `crate::agent::policy` | `use`d inside each test body. |
| `ScratchDir` / `in_env_temp` | `src-tauri/src/test_support.rs` (NOT `#[cfg(test)]`-gated) | Owned, `Drop`-removed. |

---

## 3. HOME-pinning mechanism, census, and ownership rules a NEW test must satisfy

### 3a. The `RestoreHome` / `env_lock` / mutex pattern

- `test_support.rs`: `pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());` and `pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()>` (poison-tolerant).
- Each test acquires the lock FIRST, saves `std::env::var_os("HOME")`, `set_var`s HOME to its scratch home, and at the end explicitly `drop((restore, lock))` (Rust 1.99 semantics — the guard restores on drop; `RestoreHome::drop` re-`set_var`s the original or `remove_var`s it).
- **Why it is needed:** `protected_dirs()` (via `skills::home_dir`) reads `$HOME` at call time; the parallel test harness runs module tests concurrently, so a HOME read mid-mutation by another test would see the wrong value.
- **The binding rule:** hold the lock AND the restore guard AND the home `ScratchDir` in NON-underscore bindings so they live to the end of the test — `boundary.rs`'s `pin_home` doc: *"a name starting with `_` is dropped immediately, which would release the lock and skip the restore"*.
- **The clippy rule:** async tests that hold the lock across `.await` need `#[allow(clippy::await_holding_lock)]` (both template tests have it).
- **The standing hazard:** the unlocked `$HOME` readers named in ADR 0081's Consequences — *"the thing that would break them is a new unlocked reader that joins onto `$HOME` and writes."*
- `boundary.rs`'s test module keeps its OWN `pin_home`/`pin_empty_home`/`RestoreHome`/`Tmp` copies (private to that module); `policy_gate.rs` keeps its own `RestoreHome` + `pin_guard_home` helper. policy.rs's copy is local (line ~806). A NEW policy.rs test should reuse the LOCAL `RestoreHome` + inline pattern from §2c, not import anyone else's.

### 3b. The census / scratch-dir ownership rule (ADR 0078)

- **Rule:** every scratch dir must be an owned, `Drop`-removed `ScratchDir` — never a bare `temp_dir().join(..)` PathBuf. `test_support::ScratchDir` (in `src-tauri/src/test_support.rs`, not `#[cfg(test)]`-gated, so `tests/*.rs` integration files can reach it as `archimedes_lib::test_support::ScratchDir`).
- **The census lives in the shell script `scripts/check-temp-dir-census.sh`** — a pre/post suite directory delta over the whole temp dir (snapshot/verify), with an ATTRIBUTION TABLE mapping prefixes to owning files. Relevant rows:
  - `exec-skill-esc-` → `src-tauri/src/agent/tools/exec/tests/skills.rs`
  - `exec-` → `src-tauri/src/agent/tools/exec/tests/support.rs`
- **Concrete requirement for the new test:** mint any scratch dir through `support.rs`'s `temp_cwd(tag)` (prefix `exec-`), NOT a new prefix in `policy.rs` — support.rs is the sole `exec-*` minter and the attribution table points `exec-*` at it (*"so it owns 99 dirs per run"*). A NEW prefix would print the census's UNATTRIBUTED line (or falsely blame support.rs) and is precisely the leak-regression class #96 exists to catch. No new `in_env_temp` call site in `policy.rs` itself.
- **ADR 0078:** *"A test's scratch directory is owned by a scope-bound guard"* + a post-run census bracketing the suite's `cargo test` steps; the census measures a delta, not a prefix list.

---

## 4. The exact production compare under test

### 4a. `protected_refusal_text` — `src-tauri/src/agent/tools/exec/access.rs`

Verbatim function body:

```rust
pub(crate) fn protected_refusal_text(
    protected: &[PathBuf],
    tool: &str,
    resolved: &Path,
) -> Option<String> {
    let resolved = crate::agent::fs_backend::canonicalize_lenient(resolved);
    // BOTH sides lenient (issue #92): the entry may name a dir that does not
    // exist yet, and a strict `canonicalize()` on it fails — which under
    // `is_ok_and` matched NOTHING, silently no-opping the deny-list for
    // exactly the entry `protected_dirs()` now keeps. `hit` stays the
    // CALLER's entry so the message names the directory as registered.
    let hit = protected
        .iter()
        .find(|dir| resolved.starts_with(crate::agent::fs_backend::canonicalize_lenient(dir)))?;
    Some(format!(
        "{tool}: {} is a protected agent-definition directory ({}) — writing there is refused in every policy. {PROTECTED_WRITE_ROUTE}",
        resolved.display(),
        hit.display()
    ))
}
```

The doc comment atop it states the two-sided-lenient design: the compared path comes canonical from the executor callers; the ENTRY side is lenient-canonicalized because a strict `canonicalize()` on a missing dir fails and "a failed compare is a silent non-match". It also names the recorded residue — a fully-unresolvable entry stays raw and cannot prefix-match a canonical path (macOS `/var`→`/private/var`, Windows verbatim) — and the re-appended-components-are-compared-as-strings slop: *"At THIS seam that only ever errs toward a FALSE POSITIVE — an over-refusal"*.

**The line an ancestor-peel mutation would edit:** the `find(|dir| resolved.starts_with(canonicalize_lenient(dir)))` predicate in that function — e.g. changing it to compare against only the peeled canonical ancestor and dropping the trailing re-applied components (or canonicalizing the entries strictly so missing ones vanish). That single line (access.rs, inside `protected_refusal_text`) is the compare-under-test.

### 4b. Every other protected-membership compare on the executor path

- `access.rs::protected_refusal(ctx, tool, resolved)` — thin wrapper: `protected_refusal_text(&ctx.protected, tool, resolved)`.
- `access.rs::write_rule_refusal(ctx, tool, resolved)` — calls `rule_for(...)` then, on a `Deny`: `protected_refusal(ctx, tool, resolved).or_else(|| Some(rule_deny_text(tool, rule, resolved)))`. So the protected sentence is reached only when a rule has decided `Deny`.
- `fs_tools.rs::exec_write` (line 89) and `exec_edit` — call `write_rule_refusal(ctx, "write"/"edit", &resolved)` right after `backend.validate`, BEFORE `backend.write`.
- The GATE mirror (`harness/loop/gate.rs`): `is_guard_path` does `self.protected.iter().any(|root| resolved.starts_with(root))` (row-3 membership, both sides already canonical), and `deny_tool_result` calls `protected_refusal_text(&self.protected, &tc.name, path)` for a rule-`Deny` verdict. The gate re-derives via `canonicalize_lenient` (`guard_target`). ADR 0081's rule: the executor refuses in every mode ("straight after `validate` and with no test of `ctx.file_policy.writes`" — note that claim is the PRE-round-3 wording; the CURRENT code consults `write_rule_refusal` which dispatches no-rule writes), the gate only on a `Deny` verdict.

---

## 5. Would a parent-write test actually exercise the ancestor-peel mutation?

**Yes — with one precise caveat about the rule.** Conditions analysis, tracing each gate on the executor path for a write to `$HOME/.pi/agent/allowed.md`:

1. **The executor's own write_roots check (would it refuse first?).** No. `write_backend(ctx)` builds roots via `boundary::executor_roots(&ctx.cwd, &[cwd], Allow)` = `[cwd, unrestricted_floor()]`; under `writes: Allow` the floor `/` admits ANY absolute path, including `$HOME/.pi/agent/allowed.md`. `validate` also re-checks trailing components (the dangling-symlink probe) — `allowed.md` doesn't exist, so the peel path runs, but it resolves cleanly (`$HOME/.pi/agent` exists) and passes. A `Sandboxed`-policy variant would FAIL at this seam (target outside cwd) — which is exactly why ADR 0081 prescribes `writes: Allow`.
2. **`write_rule_refusal` — the `writes: Allow` widening / a deny rule?** This is the caveat. The compare-under-test lives inside `protected_refusal_text`, which is reached ONLY when a rule has already decided `Deny` (row 1). With NO rules (empty list — the hermetic `ctx` default), `rule_for(&[], …)` = `None`, `write_rule_refusal` returns `None`, and the write dispatches **regardless of what `protected_refusal_text` would have said** — so a no-rule fixture would NOT exercise the mutation at all (it would pass green under the ancestor-peel, vacuously, because the compare never runs). **To make the mutation observable, the fixture must include a matching rule that decides `Deny` while the target is OUTSIDE the guard set** — e.g. a `~/.pi/agent` `deny` rule (the ADR's own wording for the ~-rule) or an absolute `.pi/agent` deny: then `write_rule_refusal` MUST reach `protected_refusal`, whose membership compare is the mutated line. If the mutation peels entries to the ancestor, `$HOME/.pi/agent/agents`-as-`$HOME/.pi/agent` DOES prefix-match `$HOME/.pi/agent/allowed.md` and the refusal fires → the test asserting `!is_error` goes RED. Without such a rule the compare never runs and the test cannot redden. (If the planner instead wrote the test to assert only the "no rule → dispatch" path, it would be a duplicate of `a_write_into_a_protected_dir_with_no_rule_is_not_refused`'s shape and would NOT pin the over-refusal.)
3. **Trust gate?** `execute_tool` has NO trust concept (trust lives in `AgentLoop::space_trusted`, gate-side only; it only shapes row-3, and this fixture relies on row 1 — a deny rule — which is trust-immune). No trust interference on the executor path.
4. **The Landlock/bash path?** Not involved — `execute_tool("write", …)` goes through `fs_tools::exec_write`, not the shell sandbox.
5. **`$HOME/.pi/agent` MUST exist** (so the peel lands at `.pi/agent` and the parent-write's resolved path starts with the actual directory being written into, and on macOS/Windows the canonical spelling matches the entry's canonical ancestor). If `.pi/agent` is absent, the entry peel falls deeper (to `$HOME`) — then the compare could match `$HOME/.pi/...`-shaped parents too broadly and the assertion semantics change; keep the ADR's fixture: create `.pi/agent`, leave `.pi/agent/agents` missing.

**Net:** YES, the fixture as ADR 0081 prescribes (target `$HOME/.pi/agent/allowed.md`, `.pi/agent` present, `.pi/agent/agents` missing) exercises the ancestor-peel mutation — **provided a user `deny` rule is present (or added) so `protected_refusal_text`'s compare actually runs**. The empty-rules shape would be a vacuous green.

(The mutation is observable as: under ancestor-peel, `[`$HOME/.pi/agent`]` (ancestor form of the entry, IS under the parent) → `find` hits → refusal → `r.is_error == true` → the test's `assert!(!r.is_error, …)` fails. Under the CORRECT current code the entry retains `.pi/agent/agents` as a trailing component, which does NOT prefix-match `…/allowed.md`, so `find` misses, no refusal, write lands, test green.)

---

## 6. Commands to run ONLY this task's tests

From `src-tauri/` (the AGENTS.md table: `cargo test` runs in `src-tauri/`):

```
cargo test --lib agent::tools::exec::tests::policy
```

(Unit-test module path; `--lib` scopes to the lib crate tests, `agent::tools::exec::tests::policy` filters to the module. To run a single test: append `-- <exact fn name>` after a `--`, e.g. `cargo test --lib agent::tools::exec::tests::policy -- a_write_into_a_still_missing_protected_dir_is_refused`.)

Alternatively (equivalently targeted, by the test name only):

```
cargo test --lib -- a_write_into_a_still_missing_protected_dir_is_refused
```

Note: the tests also depend on the crate's OTHER modules compiling (archimedes is ONE compilation unit), so a syntax error anywhere breaks this scope; and `policy_gate.rs` (gate-side) is NOT in the `exec::tests` module — a full-mutation re-measure would additionally want `cargo test --lib agent::harness::loop::tests::policy_gate` and `cargo test --lib agent::boundary::tests` (see §8).

**The AGENTS.md fake_worker note (verbatim):**

> **`cargo test --lib` does not rebuild `fake_worker`.** A stale `bin/fake_worker.rs` binary surfaces as `manager::tests` failing with misleading values after a protocol change; run `cargo build --all-targets` first when a fixture looks like it is lying.

`bin/fake_worker.rs` exists at `src-tauri/src/bin/fake_worker.rs` (the `WorkerFactory` fixture used by `tests/harness_dispatch_native.rs` etc.). It cannot affect `exec/tests/policy.rs` specifically, but the note is the repo's stated first move when a Rust fixture "looks like it is lying":

```
cargo build --all-targets
```

(Also from AGENTS.md: `cargo clippy --all-targets` must be 0 warnings; clippy lives in CI. And the memory/attention: new `#[tokio::test]` tests that hold the env lock across `.await` need `#[allow(clippy::await_holding_lock)]`.)

---

## 7. Already-implemented? (no-op check)

**No parent-write test exists anywhere.** Greps run (all from repo root):

- `grep -rn "allowed.md|\.pi/agent/allowed|parent.*stays|stays.*allowed" src-tauri/src src-tauri/tests AGENTS.md` → **empty** (the only `allowed.md`-adjacent hit anywhere is the ADR 0081 prose naming the missing pin).
- `grep -rn 'join(".pi/agent")|join(".agents")' src-tauri/src src-tauri/tests` → the same four hits ADR 0081 records: three `create_dir_all` peel-ANCHOR calls (policy.rs:474 — in `a_tilde_rule_with_home_none_matches_nothing_and_with_a_real_home_matches_and_decides`'s `home.path().join(".pi/agent")`; policy.rs:852 & 956 — the two session-snapshot fixtures' `home.path().join(".pi/agent")`), plus policy.rs:299 — `a_rule_allow_makes_the_write_land`'s `create_dir_all(cwd.join(".pi/agent"))` — and `worker/core.rs:362`'s unrelated data path. **None of them writes into the parent and asserts success.**
- `grep -rn "a_write_into_a_protected_dir_s_parent|protected dir's own parent|a_write.*parent.*protected"` → nothing in source; only the ADR/status prose.
- `skills.rs`'s `a_childs_first_cost_frame_under_the_parents_delivery_id_creates_and_writes_the_childs_row` is a session-cost test, unrelated.

So the task is **not a no-op**; nothing pins the parent-write success. (Caveat: `docs/roadmap/` is gitignored planning docs — the task-prose itself (status file §"A1") confirms it is still `todo`.)

---

## 8. The three-red baseline — which tests, and why (reasoning, NOT measurement)

ADR 0081 records (attributed to **T06's implementer**, from `fc7b635`'s commit message; **the ADR itself ran no `cargo`** — status-prose A1 repeats: *"re-measure it at this HEAD, do not copy it"*): the ancestor-peel mutation (entries kept but peeled to the canonical ancestor, re-applied trailing components dropped) reddens **three** tests, all dying **on their premise assertion with a non-empty WRONG list**.

From reading the assertions, the three tests whose PREMISE pins the full trailing-component spelling of a not-yet-existing entry are exactly the ones that carry `protected.contains(&home_canon.join(".pi/agent/agents"))` **or** the whole-list `assert_eq!(protected, want)` on the re-applied spelling:

1. **`a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`** (`exec/tests/policy.rs:837`) — premise at ~line 866: `protected.contains(&home.path().canonicalize().unwrap().join(".pi/agent/agents"))`. Under peel, the entry becomes `…/.pi/agent` → `contains` false → premise assertion PANICS (red). ADR 0081 names this signature explicitly as one of the three.
2. **`a_write_into_a_still_missing_protected_dir_is_refused`** (`exec/tests/policy.rs:946`) — same premise at line ~961: `protected.contains(&home…join(".pi/agent/agents"))`. Under peel → premise false → red. (The second of the executor session-snapshot pair — the "still missing" one.)
3. **`protected_dirs_keep_a_missing_dir`** (`boundary.rs:454`) — asserts the WHOLE list equals `[home_canon.join(".agents/skills"), home_canon.join(".pi/agent/skills"), home_canon.join(".agents/agents"), home_canon.join(".pi/agent/agents")]` (the `want` built with the full four re-applied spellings via `home_canon.join(d)`). Under peel every entry loses a trailing component → `assert_eq!` fails.

**Why NOT the other suspicious candidates (reasoning):**
- `protected_dirs_keeps_an_unresolvable_entry_raw` (boundary.rs:526): its fixture uses a RELATIVE ghost `$HOME` that exists nowhere → every entry comes back RAW; peel-to-ancestor has nothing to peel to, so the four raw spellings are unchanged → stays green under the ancestor-peel.
- `protected_dirs_are_the_four_user_level_dirs` (boundary.rs:399) and `protected_dirs_are_the_plain_four_dir_guard_membership_list` (boundary.rs:590): their fixtures CREATE all four dirs (via `pin_home`), so entries canonicalize fully with no trailing components — peel is indistinguishable from correct → green.
- `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session` (`policy_gate.rs:777`): its PREMISE is the write's `is_error` and the WORDING (the gate's fixture plants `AgentLoop::new`'s snapshot via the loop itself, with no `protected.contains(.pi/agent/agents)` assertion — verified: no such contains in policy_gate.rs). Under peel the gate's `deny_tool_result` would actually refuse with the protected WARNING (its `is_guard_path` membership check with the peeled entry DOES match `…/.pi/agent/agents/…` → wording is the protected sentence, and `is_error` already true). Since `policy_gate.rs`'s two session-snapshot tests (executor+gate) were both written to catch only the DROP mutation, the gate one stays green under peel — consistent with ADR 0081 counting three, via a different mechanism than ADR 0081's "which other two" language. (ADR 0081 says the two recreated tests pin change (1); the ancestor-peel is caught by "the premise's specificity" — i.e. exactly the `contains`/`assert_eq!` premises above.)
- `tests/skill_tools_boundary.rs` (~line 590): asserts `protected.contains(&real…/.agents/skills canonical)`, but the fixture CREATES the skill dir to be fully canonical — green.

**So the expected reddening set, by signature:** the two executor session-snapshot tests (`a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`, `a_write_into_a_still_missing_protected_dir_is_refused`) + `boundary::protected_dirs_keep_a_missing_dir` = **three**, all premise-red with a non-empty wrong list — matching ADR 0081's "three tests redden and they die on a premise assertion with a non-empty wrong list". **Flagged as reasoning from the assertion texts, not a measurement — re-measure at this HEAD.** The new parent-write test adds a fourth/fifth red (it is the one that reddens on the actual over-refusal via its `!is_error` assertion, per §5), making the falsifier count five, not four — issue #104's stated commit-message requirement.

---

## 9. Planner checksums / key file paths

- `src-tauri/src/agent/boundary.rs` — `protected_dirs()` (line ~264), `push_protected`, `canon`, `push_roots`, `executor_roots`, `UNRESTRICTED`, its `#[cfg(test)] mod tests`.
- `src-tauri/src/agent/fs_backend.rs` — `canonicalize_lenient`, `peel_to_existing`, `reapply`, `FsBackend::resolve`/`check_under_roots`, `write` (creates parent dirs via `create_dir_all`).
- `src-tauri/src/agent/tools/exec/access.rs` — `protected_refusal_text`, `protected_refusal`, `write_rule_refusal`, `read_rule_refusal`, `rule_deny_text`, `PROTECTED_WRITE_ROUTE`, `read_backend`/`write_backend`.
- `src-tauri/src/agent/tools/exec/fs_tools.rs` — `exec_write`/`exec_edit` (the refusal call site, line 89/161 region).
- `src-tauri/src/agent/tools/exec/tests/policy.rs` — the two session-snapshot tests (837, 946), local `RestoreHome` (806).
- `src-tauri/src/agent/tools/exec/tests/support.rs` — `temp_cwd`, `ctx`, `ctx_policy`, `text_of`, `can_confine`.
- `src-tauri/src/agent/tools/exec.rs` — `mod tests`, `pub async fn execute_tool` (line 43), `pub(crate) use access::protected_refusal_text`.
- `src-tauri/src/agent/policy.rs` — `rule_for` (line 223), `default_rules()` (empty), `expand_rule_path` (167).
- `src-tauri/src/agent/harness/loop/gate.rs` — `is_guard_path`, `rule_or_guard_verdict`, `guard_target`, `deny_tool_result`-side `protected_refusal_text`.
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — `pin_guard_home` (line ~166), gate session-snapshot test (777).
- `src-tauri/src/test_support.rs` — `ENV_LOCK`, `env_lock()`, `ScratchDir`/`in_env_temp`, `filesystem_root`.
- `scripts/check-temp-dir-census.sh` — the census + attribution table (`exec-` → `exec/tests/support.rs`).
- `docs/decisions/0081-…` — the ADR (T06's mutation counts; the missing-pin prose at line ~193).
- `docs/roadmap/agent-permission-and-pins-status.md` — A1 task prose (source text the planner received).

## 10. Risks / notes for the planner

1. **The no-rule vacuity trap (§5):** a parent-write test built like the tier tests (`writes: Allow`, no rules) never reaches `protected_refusal_text` and cannot redden under the mutation. The mutation-observable shape needs a user `deny` rule whose path expands to the PARENT (`~/.pi/agent` absolute or tilde-spelled with `home: Some(...)`) while the tool target stays the parent file.
2. **`#[allow(clippy::await_holding_lock)]`** will be required for the new `#[tokio::test]` (holds `env_lock` across `execute_tool(...).await`), matching both templates.
3. **Census compliance:** mint all scratch dirs via support.rs's `temp_cwd` (`exec-` prefix) — no new `in_env_temp` call site; keep `RestoreHome` the LOCAL policy.rs copy.
4. **The commit-message requirement from #104:** the mutation delta must be stated as five red, not four (three premise-red + the new test's `!is_error` red), re-measured at this HEAD rather than copied (ADR 0081 ran no cargo).
5. **Do not weaken the existing premise assertions** (ADR 0081's Consequences: *"a refactor can re-open #92 without touching either test's name"*; edit the still-missing test only toward more specificity, never less).
6. **The `writes: Allow` widening is essential** — a `Sandboxed` test of `$HOME/.pi/agent/allowed.md` dies at the boundary (`validate`), which would defeat the fixture (the ADR prescribes `writes: Allow` for exactly this reason).
7. **macOS/Windows spelling:** the target should be built as `home.path().join(".pi/agent/allowed.md")` and passed ABSOLUTE to the tool (or spelled through the canonical home) so the resolved path is canonical-both-sides against the lenient entry; do not assert on raw temp spelling (the `/var → /private/var` and `\\?\C:\` stories in the templates).