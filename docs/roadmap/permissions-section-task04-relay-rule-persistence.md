---
status: committed
done-when: "The Supervisor relay persists an `allow-directory` answer as EXACTLY ONE `allow` rule: `respond_permission`'s `Selected { option_id: \"allow-directory\", value: Some(path) }` appends exactly one `AccessRule` (path = `value` verbatim, direction = `ReadWrite`, decision = `Allow`) to `settings.json`'s `rules` key — which holds ONLY user rules (defaults are runtime-only, T01) — appended at the END of the pre-existing user rules (the FILE-side half of the ordering contract); the RUNTIME half of that contract (defaults FIRST, user rules SECOND, so the appended allow beats a default `deny` on an exact tie) is T03's concat site's half, whose tie is pinned by T01's `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` in `agent/policy.rs` (the LOUD cross-task dependency); a repeat click on the same directory writes NOTHING (dedupe by path+direction+decision); a blank/absent `value` persists NOTHING (the `""` placeholder T03 replaces); the append + a pre-existing identical rule round-trip through the REAL `settings.json` file (write → load → write → load) with `rules` absent in the old file still loading to an empty list; `write_settings_atomic` preserves the existing file's mode on unix (DECISION (a) — no silent 0644→0600 tightening; pinned `#[cfg(unix)]`); and the `trust-space` persistence arm is byte-for-byte untouched (its `if let (Some(db), Some(cwd))` body + doc unchanged; only the outer pattern's `..` was replaced by the now-read `value` — no `db` touch, no `cwd` touch). `commands/sessions.rs` is UNTOUCHED (pure pass-through — verified in the tree). Gate: `cargo test` (full), `clippy --all-targets` 0 warnings, `fmt --check` clean, mingw `cargo check --target x86_64-pc-windows-gnu --all-targets` clean."
parent: docs/roadmap/permissions-section.md
---

# Plan — T04: the Supervisor relay persists an `allow-directory` answer as exactly ONE rule; settings round-trip

**Goal:** When the user answers a guard prompt with **"Always allow this directory"**, the Supervisor's `respond_permission` relay appends exactly one `allow` rule to `settings.json` — the persistence half of the ADR 0025 split, mirroring the `trust-space` arm.
**Architecture:** A `"allow-directory"` branch inside the relay's existing `Selected { option_id, .. }` block — the `..` becomes an explicit `value` field (it is now READ; see Step 2a) — written as a **private method on `SessionManager`** (`persist_allow_directory_rule(&self, value: Option<&str>)`) so the trust-space arm stays byte-identical and the write is unit-testable with zero fixtures; a dedupe/validation decision; a **re-read-and-mutate-first, no dead-field writes, whole-document overwrite last, narrow-write-window** `config.rs` fix; and an atomic temp-file+rename in a new `write_settings_atomic` — all inside the owned file set.
**Tech Stack:** Rust 2021, serde, `std::fs`, `tempfile` (a DEV dependency today — the `## Blocker` Cargo.toml move is a T04 prerequisite), tokio.

---

## Parallelisation

**Verdict:** SERIAL — this is a single task (consumed-mode plan). `trust-space` is untouched, `commands/sessions.rs` is untouched, and `db.rs` is untouched (see `## Blocker` and `## Owned file set`). The run's parallelism is between tasks, in the waves `roadmap` owns.

---

## Context

### What lands here / what does not

- **Persistence only.** The rule's *enforcement* is the gate half, owned **entirely by T03** — this plan never reads `rule_for`, never touches the gate, never calls `default_rules()` at runtime (it only *appends* at the END of the file's user rules — the runtime "defaults first, user second" concat is T03's site + T01's exact-tie pin; see the LOUD box in Step 2a).
- **The write is factually required to live in the relay.** The Worker has **no `config_dir`**; the `SessionManager` does (field `config_dir: PathBuf`, set by `SessionManager::new`; queries at `session/mod.rs:516` `pub fn config_dir(&self)`). This is the same reason `trust-space`'s persistence lives here — the spec line "The rule write follows ADR 0025's ownership" is load-bearing and the relay is the ONLY site with `config_dir`. Confirmed: `agent/worker/core.rs`'s `PermissionResponse` handler performs the `trust-space` live flip only (no persistence); the relay performs the `db` persistence only.

### What the relay will do (the load-bearing part, codified once)

```rust
// inside the `Selected { option_id, value }` destructure (Step 2a), immediately after the trust-space arm:
if option_id == "allow-directory" {
    self.persist_allow_directory_rule(value.as_deref());
}
```

The `value` comes from the restructured destructure (one brace + a `let` — see Steps). The trust-space arm is **verbatim**: it keeps its `if let (Some(db), Some(cwd)) = (&self.driver.db, cwd)` body and its doc (the outer pattern merely loses its `..` — the `value` field is now read, see Step 2a). The `allow-directory` arm is a **separate `if`** under the same `if let` — no `else`, so neither arm's body touches the other's.

## Decisions (all pinned — see the acceptance tests)

| Decision | Choice | Why / pinned by |
|---|---|---|
| Direction | `ReadWrite` | "Always allow this directory" means the writes that prompted; a `Write` rule would NOT cover `grep`/`glob`/`read` into the same dir (the guards also fire for those — a `read` into an agent dir at `reads: Ask` should not re-prompt). `ReadWrite`'s `covers` is all-direction by construction. Wire value is `"readWrite"` (`RuleDirection` `#[serde(rename_all = "camelCase")]` — T01). Note: `ReadWrite` also GRANTS reads — a user who meant "let it write" gets read access into that dir too, and that is intended (one click answers all five path tools). |
| Dedupe | **Exact-identity dedupe by `(path, direction, decision)`** — a repeat click on the same directory writes NOTHING | The spec says "one rule per click", but a second click appending a second identical rule is a **silent behaviour change**: it would double the Settings UI row and re-order the file for no semantic effect (`rule_for` is order-independent except the defaults boundary). Dedupe is the honest reading of "exactly one rule per click". Since a rule is `Eq` (`AccessRule` derives `PartialEq, Eq`), `append_rule` dedupes on EXACT equality — a later rule that differs in ANY field (e.g. a hand-added `Deny` for the same path) is a NEW rule and appends. Pinned by test 3 (a second identical click is idempotent) + test 4 (a later `Deny` rule for the same path is NOT swallowed — appends). Comment the dedupe ON the function |
| Blank/absent `value` | **Persist NOTHING** — a `value` that is `None` or that is a string whose `trim()` is empty is a no-op | The grounding proves the gate emits `path: ""` today (T03's placeholder): persisting `AccessRule { path: "", … }` writes a garbage rule that matches nothing yet pollutes the file + the Settings list + the round-trip. T03 is the caller that replaces the `""`; T04 must not hard-depend on T03. Decision: absent AND blank both refuse; blank uses `.trim().is_empty()`. (A path that trims to a REAL path is persisted with its ORIGINAL spelling, not the trim — the spelling is load-bearing for user rules.) Pinned by test 4 |
| Subagent (child) path | **Covered by construction — and it must be `cwd`-independent** | The grounding verifies there is NO separate subagent branch in `respond_permission`: children ride the same `handle_for(session_id)` via the `drives` map fallback. But `cwd` is read from `self.live` and is `None` for children. The rule write must therefore use ONLY `outcome.value` — never `cwd` — and it does (the persist arm never touches `cwd`). Same for `db` — the persist arm never touches `self.driver` at all. The method doc (2b) STATES the child-safety guarantee in checkable terms — no `self.live`, no `self.driver`, no `db` access — so a future edit that introduces one is visibly breaking against the doc (the accepted test-free pin; see Test 7's note). Pinned by Test 7's construction-only argument + the doc |
| Round-trip pins | (a) `rules` absent in an old file loads to an EMPTY list; (b) a persisted rule survives write → load → write → load | (a) `FilePolicy` already serde-defaults `rules` (T01) and the empty list is `skip_serializing_if`'d (T01) — the file stays three-direction until the first rule append; (b) tested through the REAL `settings.json` file — never through a serde value alone. Pinned by tests 5 (round-trip), 9 and 10 (the new helpers round-trip the file) |
| `trust-space` untouched | The trust-space ARM is NOT edited — body and doc not one token changed | It has no `value`, and a regression in it would be a regression in the whole space-mgmt flow. The outer pattern loses its `..` (the now-read `value` field, Step 2a) — that touches the SHARED destructure only, not the arm. Pinned by test 8 (exact `db.set_space_trusted(cwd, true)` invocation, exact one-time) — the arm's load-bearing invocation is `db.set_space_trusted(&cwd.display().to_string(), true)` |

**Spelling-before-dedupe**: dedupe compares the PERSISTED string (`value` verbatim). `~/.pi/agent/agents` and `/home/u/.pi/agent/agents` are different rules (different user-visible rows) even though they canonicalize to the same dir — matching canonicalizes at match time, NOT at write time (T01's `AccessRule.path` doc). The dedupe equals-on-exact-rule equality, which is exactly T01's "an exact tie" semantics. State it in the function doc; the config round-trip test uses ONE spelling.

## Hazard: `settings.json` has no locking and no atomic write — and there are now SIX+ writers

### What T04 does about it — DECIDED (and recorded)

Two concrete changes, both inside `config.rs` (in owned fileset) + one recorded limitation with a follow-up:

1. **New `pub fn write_settings_atomic(config_dir: &Path, settings: &Settings) -> Result<(), String>`** — an atomic-write sibling of `write_settings`:
   - `tempfile::NamedTempFile::new_in(parent)` → `serde_json::to_string_pretty` → `write_all` → `as_file().sync_all()` → `persist(path)`.
   - **`tempfile` is currently a DEV dependency (`src-tauri/Cargo.toml:97`) — this production use REQUIRES the one-line Cargo.toml move in `## Blocker` (Path A).** Do not proceed on the basis that it "is already a regular dependency": verification shows every in-crate production-file use of `tempfile` sits inside `#[cfg(test)]` modules. The atomic half is otherwise a *free* hardening, purely within `config.rs` once the move lands.
   - **Decision (recorded)**: `write_settings` KEEPS its whole-document-overwrite behavior — it is the shared entry point for the Settings page and the IPC `save_settings` command, and those must keep the exact wire roll of `to_string_pretty` (byte pins in `config.rs`). The relay uses `write_settings_atomic` (T04's relay only calls `write_settings_atomic`; it never calls `write_settings`); `set_config_option` KEEPS its current `write_settings` path — migrating it to the atomic write / `load_mutate_write` is the recorded follow-up, not this task.
   - **Fallback**: if `persist` fails for any environment-specific reason (the crate's documented copy+remove fallback can still error on exotics), the temp is cleaned automatically by drop and the error is returned (`Err`). Do NOT add a non-atomic fallback: a partial `fs::write` after a failed persist is exactly the torn-write this exists to prevent. A relay write failure is logged (mirroring `set_config_option`:1744's `eprintln!`) and does NOT fail the answer.
   - This fixes the "torn file destroys settings.json" class: the file is now never half-written from this path. **It does NOT serialize racing writers** (documented honestly below). One deliberate cost: the atomic write performs a full-document `serde_json::to_string_pretty` + `sync_all` per call — irrelevant for a user click, and NOT treated as a bottleneck.

2. **New `pub fn load_mutate_write<F: FnOnce(&mut Settings)>(config_dir: &Path, f: F) -> Result<(), String>`** — the race-bounded read-modify-write helper:
   - `let mut settings = load_settings(config_dir);` → `f.apply(&mut settings)` → `write_settings_atomic(config_dir, &settings)`.
   - The relay calls `load_mutate_write(&self.config_dir, |s| append_rule(&mut s.file_policy.rules, rule))`. Config-change writers CAN adopt it too (they go through `load_settings` + `write_settings` today — `set_config_option` at `session/mod.rs:1740-1745`) — but that is a **behavioral** change for other writers and is therefore **out of scope for T04** (T04 only adds the helper + wires the relay's append through it; `set_config_option` keeps its current path untouched). A second writer landing after T04 must NOT keep doing `load_settings`-mutate-`write_settings` with a stale read; the helper's doc names it. The helper is the load-bearing race-narrowing seam; adopting it in `set_config_option` is a recorded follow-up, not this task.
   - The purpose is *not* to be a lock (there is no lock). It is to **narrow — not close — the window** between the read and the overwrite from "arbitrary" (a fresh `load_settings` at the START of a long UI-triggered save) to "one function call"; the residual lost-update sequence is recorded in the limitation block below.

### The honest limit (what we record — NEW, not a repeat)

The spec's "Honest limits" records "settings.json is not agent-writable-proof" — that is a *security* claim. T04's limitation is about **concurrency**, and says something new:

> **`settings.json` is written by six+ independent writers with no shared lock. T04 shrinks the torn-write class (atomic persist) and NARROWS the relay's read-modify-write window (re-read immediately before the overwrite) — it does NOT close the window.** No lock is added anywhere in T04: the helper is a narrower read-modify-write, not a mutex, and nothing serializes the Rust writers against the Settings page's whole-document save. **The residual lost-update sequence, concrete:** (1) user sees the Permissions prompt → clicks "Always allow this directory"; (2) the relay's `load_mutate_write` reads `settings.json` (no rule yet), mutates in memory, and calls `write_settings_atomic` — the rule is written; (3) a MOMENT LATER the Settings page user clicks Save, and `save_settings` writes a whole document composed from a STALE `useSettingsDocument` store snapshot taken BEFORE the relay's write (the store only refreshes when the Settings page loads); (4) the whole-document overwrite replaces the file with a document that has no rule → **the user's "always allow" silently evaporates, and because the relay's write failure path is best-effort-logged, the loss is silent — no error surfaces to the user, and afterwards the file simply lacks the rule.** `useSettingsDocument`'s Agents-modal queue serializes only the frontend's own modal writes (`useAgentOverridesWrites`) — it never serializes against the Rust writers. **This is recorded and NOT fully fixed in T04.**

**Follow-up recorded on the limitation** (the orchestrator targets it): a settings-write `RwLock` or a save-version/merge at the `useSettingsDocument` boundary. T07 (docs/ADRs) MUST record this — it is the "settings.json concurrency limit T04 chose". The limitation block in this plan is the artifact that carries the failure sequence.

### Why no whole-document overwrite is safe

`write_settings_atomic` STILL overwrites the whole document. That is not "safe" — it is exactly why the failure sequence above exists (a whole-document overwrite from ANY writer can clobber another writer's change). Atomicity protects the FILE, not the writers. T04 does not pretend this is solved; it (a) fixes the torn-write class, (b) narrows the relay's window, (c) records the residual race + follow-up. The spec's "Honest limits" already admits settings.json is not agent-writable-proof; T04's limitation is the concurrency dimension, named explicitly with the failure sequence.

## Owned file set (and what stays out)

| Owned | Used for |
|---|---|
| `src-tauri/src/agent/session/mod.rs` | the relay persist arm + its private `persist_allow_directory_rule` method (tested in `session_tests`) |
| `src-tauri/src/config.rs` | `load_mutate_write`, `write_settings_atomic`, the `append_rule` free fn (only used here) + their tests |

NOT owned (explicitly):
- `src-tauri/src/commands/sessions.rs` — pure by-value pass-through, **untouched** (verified: lines 122–140, `outcome` moved verbatim).
- `src-tauri/src/storage/db.rs` — **untouched**: `set_space_trusted` is the SQLite trust flag; the rule store is `settings.json` via `config.rs` (grounding §5: "Rules are NOT persisted in SQLite anywhere"). The relay never touches `self.driver` for the rule write.
- `src-tauri/src/agent/policy.rs`, `agent/boundary.rs`, `agent/permission.rs` — read-only (types + contract pins).
- `src-tauri/Cargo.toml` — **NEEDS a one-line move (`tempfile` → `[dependencies]`) that is OUTSIDE this set — see `## Blocker` (Path A, to be ratified by the orchestrator).** The task's own file set remains the three files; without the ratification the atomic write cannot compile.
- `src-tauri/src/agent/worker/core.rs` etc. — NOT touched.

## Steps (serial; each step leaves the tree compiling + scoped-tests green)

### Step 1 — config.rs: the atomic write + the read-modify-write helper + `append_rule`

**1a. `pub fn write_settings_atomic(config_dir: &Path, settings: &Settings) -> Result<(), String>`** — after `write_settings` (keep `write_settings` untouched):

```rust
/// Persist the settings ATOMICALLY (temp-file + rename). The relay's
/// whole-document overwrites (the permissions append) use this so a torn
/// write can never destroy the file — the rename is atomic-on-POSIX and
/// atomic-in-practice on Windows NTFS (`tempfile` 3.27.0's `persist` uses
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, so it succeeds when the
/// destination exists; the crate's documented copy+remove fallback covers
/// cross-volume/dir edge cases). Deliberately NOT the shared entry point:
/// the Settings page (`save_settings`) keeps `write_settings`, whose exact
/// serialized bytes are pinned.
pub fn write_settings_atomic(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(config_dir);
    let mut tmp = tempfile::NamedTempFile::new_in(config_dir)
        .map_err(|e| format!("settings: temp create failed: {e}"))?;
    use std::io::Write;
    tmp.write_all(
        serde_json::to_string_pretty(settings)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    // Mode preservation (DECIDED): `NamedTempFile` creates the temp with
    // mode 0o600 (`file/imp/unix.rs`: `unwrap_or(0o600)`) and the rename
    // takes the TEMP's mode — without this the atomic write would silently
    // tighten settings.json from its configured mode (typically 0644) to
    // 0600 on unix. That silent mode change is exactly the unrequested
    // behaviour change this repo's rules forbid. Preserve the existing
    // file's mode on the temp before persisting.
    #[cfg(unix)]
    {
        if let Ok(md) = std::fs::metadata(&path) {
            let _ = std::fs::set_permissions(tmp.as_file(), md.permissions());
        }
    }
    tmp.persist(&path).map_err(|e| e.to_string())?;
    Ok(())
}
```

`NamedTempFile::new_in(parent)` requires a non-empty parent — `settings_path`'s parent is `config_dir`, guaranteed present. **`tempfile` is a DEV dependency today (`src-tauri/Cargo.toml:97`, under `[dev-dependencies]`) — this production-code use REQUIRES the Cargo.toml move in `## Blocker` (Path A).** With the move ratified, `tempfile` compiles in both `cargo build` and `cargo test` modes (it is already in the lockfile and built for every test run). If the orchestrator refuses the move, use the std-only fallback in the Blocker (Path B) — do NOT ship a plain non-atomic `fs::write` here. `tempfile::NamedTempFile::persist` replaces the destination atomically on POSIX; on Windows it uses `MoveFileExW` (`MOVEFILE_REPLACE_EXISTING`) with a documented copy+remove fallback for cross-volume/dir edge cases — either way the file is never left torn. Put the `use std::io::Write;` INSIDE the function (in-scope) to avoid a file-level import churn.

**Settled record — mode, verified against `tempfile` 3.27.0 at the source**: `persist` on Windows sets `FILE_ATTRIBUTE_NORMAL` then uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, so it succeeds when the destination exists — the old "Windows persist fails on existing dest" worry is UNFOUNDED and is NOT recorded as a risk. The REAL risk is the mode: `NamedTempFile` creates with mode `0o600` (`file/imp/unix.rs`: `unwrap_or(0o600)`), and a rename takes the TEMP's mode, so the atomic write permanently changes `settings.json`'s mode from its existing one (typically 0644) to 0600 on unix. **DECISION (a)** — preserve the existing file's mode on the temp before persisting (the `#[cfg(unix)]` block above). This is pinned on unix only (Windows has no mode concept — the pin MUST be `#[cfg(unix)]`; on Windows the block is not compiled and there is nothing to pin) by new test `write_settings_atomic_preserves_the_existing_files_mode_on_unix` (1e). The mode is observable on the unix platform the tests run on, so the pin is test-assertible, not just documented. No pre-existing test pins the mode, so nothing existing breaks; this pin is the new guarantee.

**1b. `pub fn load_mutate_write<F: FnOnce(&mut Settings)>(config_dir: &Path, f: F) -> Result<(), String>`** — the re-read-mutate-atomic-write single call:

```rust
/// The relay's settings-write shape: load FRESH, mutate in place, atomic
/// overwrite. The fresh `load_settings` is load-bearing — writing a
/// document built from a STALE read can silently clobber another writer's
/// field (the settings.json concurrency limit, recorded in the T04 plan).
/// The window is ONE function call, not "arbitrary" — this is what the
/// relay's append uses.
pub fn load_mutate_write<F: FnOnce(&mut Settings)>(config_dir: &Path, f: F) -> Result<(), String> {
    let mut settings = load_settings(config_dir);
    f(&mut settings);
    write_settings_atomic(config_dir, &settings)
}
```

(`load_settings` returns a `Settings`; the mutate is by `&mut`; the write is atomic. The relay's append is the ONLY production caller of `load_mutate_write` in T04 — `set_config_option` keeps its current `load_settings`-mutate-`write_settings` path; migrating it is a recorded follow-up, NOT this task. Both are in-crate Rust writers of the same file.)

**1c. `pub(crate) fn append_rule(rules: &mut Vec<AccessRule>, rule: AccessRule)`** — the dedupe:

```rust
/// Append exactly one rule, unless an IDENTICAL one is already present
/// (dedupe by path+direction+decision — a second "always allow this
/// directory" click is idempotent, not a duplicate row). A user rule that
/// differs in ANY field is a new rule and appends.
pub(crate) fn append_rule(rules: &mut Vec<AccessRule>, rule: AccessRule) {
    if !rules.contains(&rule) {
        rules.push(rule);
    }
}
```

`AccessRule: Eq` (T01). `Vec::contains` is `O(n)` — fine for the rule-list sizes here; comment it. (No need for `PartialEq`-based ordering — `rule_for` is order-independent except the defaults boundary.)

**1d. Tests in `config.rs`'s `mod tests`** (name them per the repo's naming): `write_settings_atomic_writes_the_same_bytes_as_write_settings`, `load_mutate_write_reads_fresh_mutates_and_persists_atomically`. The first writes the same `Settings` through both paths to `tempfile::tempdir()` and byte-compares; the second seeds a file, calls `load_mutate_write` with a mutate, and asserts the file changed + re-loads.

**1e. The mode pin — new test in `config.rs`'s `mod tests`** (the mode decision in 1a, pinned):

```rust
#[cfg(unix)]
#[test]
fn write_settings_atomic_preserves_the_existing_files_mode_on_unix() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();   // the repo's existing mod-tests pattern
    let path = settings_path(dir.path());
    let mut s = Settings::default();
    write_settings(dir.path(), &s).unwrap();           // 0644 (umask)
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
        .unwrap();                                      // a deliberately configured mode
    write_settings_atomic(dir.path(), &s).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640,
        "the atomic write must NOT tighten a deliberately configured mode to the temp's 0600"
    );
}
```

`#[cfg(unix)]` is REQUIRED: Windows has no mode concept, so the pin exists only on the unix platform the tests run on (the `#[cfg(unix)]` block in `write_settings_atomic` is the production twin). `settings_path` (config.rs:382) is parent-module-private — the child `mod tests` module sees ancestor-module privates, so the test reaches it directly without any visibility change; `use super::*` already provides it (`tempfile::tempdir()` is the existing mod-tests pattern, e.g. line 739).

### Step 2 — session/mod.rs: the relay persist arm

**2a. Destructure `value` out — the `..` is gone** (`session/mod.rs:1976-1984` region, the `if let permission::PermissionOutcome::Selected { option_id, .. } = &outcome`). The pattern becomes an explicit `Selected { option_id, value }` — no `..` — because `value` is now READ; binding it from `&outcome` requires the `..`-free form. Change to:

```rust
if let permission::PermissionOutcome::Selected { option_id, value } = &outcome {
    // (Task 1) The `trust-space` outcome persists the `spaces` write
    // (the Supervisor owns the `spaces` table — the existing
    // `set_space_trusted` `Db` method). The Worker's `StaticTrustSource`
    // flip (Task 2's `PermissionResponse` handler) is the live-lookup
    // half; this is the persistence half.
    if option_id == "trust-space" {
        if let (Some(db), Some(cwd)) = (&self.driver.db, cwd) {
            let _ = db.set_space_trusted(&cwd.display().to_string(), true);
        }
    }
    // (Task 4) The `allow-directory` outcome persists ONE `allow` rule —
    // the rules store is `settings.json` (the Settings page owns it, and
    // the Worker has no `config_dir` — the ADR 0025 ownership split:
    // the gate asks, the relay persists). `value` is the option's `path`
    // echoed verbatim by the frontend; a BLANK path (the T03 placeholder)
    // persists NOTHING. `cwd` is deliberately NOT read — children ride
    // this same relay via `handle_for`'s `drives` fallback and have no
    // `live` entry.
    if option_id == "allow-directory" {
        self.persist_allow_directory_rule(value.as_deref());
    }
}
```

`value` binds as `&Option<String>` — the pattern is on `&outcome` (`&PermissionOutcome`), and under match ergonomics the field `value: Option<String>` in a `&PermissionOutcome` binds as `&Option<String>` (NOT `Option<&String>`). Calling `self.persist_allow_directory_rule(value.as_deref())` is still correct: `&Option<String>` auto-derefs for `as_deref` (`Option::<String>::as_deref` takes `&self`), which yields `Option<&str>`. Drop the T02 "value is READ nowhere yet" comment; the new comment explains the read.

> **CROSS-TASK DEPENDENCY — LOUD. T04's correctness depends on T03's concat order.** The RUNTIME half of the "an allow beats a default `deny` on an exact tie" ordering contract is NOT in this plan and is NOT in the file — it lives at T03's concat site, `harness/loop.rs`'s `handle_prompt`: `default_rules()` FIRST, `file_policy.rules` SECOND (`self.default_rules.clone() ++ self.file_policy.rules.clone()`; the order is pinned in BOTH directions by T01's resolver test, and T03 adds its own order assertion on the `AgentLoop::rules` field). T04's `persist_allow_directory_rule` can only append the allow at the END of the file's `rules` list (the file-side half — see Test 1's seed assertion and its ordering note); the LIST the gate actually resolves is assembled at T03's site. **If T03 flips the concat (user rules BEFORE the defaults), an "always allow this directory" answer silently NO-OPS at the gate** — the appended allow is still last in the file, but it is no longer last in the resolved list, so the default `deny` wins the exact tie. The cliff is pinned by T01's `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` in `agent/policy.rs` (its inverted-concat branch reddens if the order flips). A reader of T03's plan MUST NOT be able to miss this: T04's write site pins the FILE side (append at the END of the user rules), T03's concat site pins the RUNTIME side (defaults first), T01's resolver test pins the TIE itself. All three halves must land — T04 alone writes a rule that never wins.

**2b. The private method** (`impl SessionManager` — put it right after `respond_permission`):

```rust
/// (Task 4) Persist an `allow-directory` answer as EXACTLY ONE `allow`
/// rule in `settings.json` (the rule store — ADR 0025: the Worker has no
/// `config_dir`, so the Supervisor relays the write, exactly as the
/// `trust-space` db write does; the gate itself never persists).
///
/// Directives, all pinned by `session_tests`:
/// - `ReadWrite` so the rule governs both the write that prompted AND the
///   reads/greps into the same dir (one "always allow" answers all five
///   path tools, per the spec).
/// - Appended at the END of the file's `rules` list (which holds ONLY
///   user rules) — the RUNTIME concat, `default_rules()` FIRST then the
///   user rules, is what makes an appended allow beat a default `deny`
///   on an exact tie (T03's concat half; T01 pins the tie:
///   `an_exact_tie_goes_to_the_last_rule_...` — see the LOUD box).
/// - A repeat click on the same directory writes nothing (dedupe by
///   path+direction+decision — see `config::append_rule`).
/// - A `None` or ALL-WHITESPACE path writes nothing (the gate's `""`
///   placeholder until T03 computes the real nearest-existing ancestor).
/// - `cwd` / the `Db` are NOT touched: the child path (the `drives`
///   fallback) has no `live` entry, so the path from `value` is the only
///   input — and it is enough. **Child-safety guarantee (checkable): this
///   method reads NO `self.live`, NO `self.driver` and NO `db` — `config_dir`
///   is a plain non-Option field, so it cannot drift; any future edit that
///   introduces one of those reads into this method is VISIBLY breaking
///   against this doc (the accepted construction-only pin).**
/// - Best-effort: a write failure is logged and does NOT fail the answer
///   (the `trust-space` arm's `let _ =` discipline).
fn persist_allow_directory_rule(&self, value: Option<&str>) {
    let Some(raw) = value else { return };
    if raw.trim().is_empty() {
        return;
    }
    let rule = AccessRule {
        path: raw.to_string(),
        direction: RuleDirection::ReadWrite,
        decision: RuleDecision::Allow,
    };
    if let Err(e) = crate::config::load_mutate_write(&self.config_dir, |s| {
        crate::config::append_rule(&mut s.file_policy.rules, rule.clone())
    }) {
        eprintln!("allow-directory: rule save failed: {e}");
    }
}
```

`AccessRule`, `RuleDirection`, `RuleDecision` need imports in `session/mod.rs`: add `use crate::agent::policy::{AccessRule, RuleDecision, RuleDirection};` (the file already does `use crate::config::{load_settings, write_settings};` at `session/mod.rs:16` — the method uses the full `crate::config::` paths so NO `config` alias import is needed). The `config` additions (`load_mutate_write`, `append_rule`) live under the owned fileset.

Note: `value` binds as `&Option<String>` from the `&outcome` pattern (match ergonomics — see 2a); `persist_allow_directory_rule(value.as_deref())` binds `Option<&str>` cleanly. Do NOT call `.trim()` and then persist the trimmed string — persist the ORIGINAL spelling (the `~`/absolute spelling is load-bearing, and the UI row shows the raw path).

### Step 3 — session_tests (the relay's pins)

Fixtures (already in `session_tests`): `temp_config_dir()`, `open_db`, `build_worker_manager`, `start_native_session`, `write_settings_json` (copy-untouched), `TestSink`. `load_settings`/`write_settings`/`load_mutate_write`/`append_rule` are reachable from `config.rs` (`use super::*` + `crate::config`).

The tests call the private method DIRECTLY (`manager.persist_allow_directory_rule(Some(path))`) — no `respond_permission` round-trip needed (`respond_permission` requires a live Worker handle and a `PendingPermissions` entry; the fixture `start_native_session` DOES start a fake Worker, so the `Ok(())` path is real, but driving the full relay is unnecessary ceremony for the persistence pins — the method IS the persistence arm; the arm's wiring (the `if` in `respond_permission`) is a 3-line difference covered by the code review + the compile). Verify the call works: `respond_permission` obtains `wm`, `cwd`, `handle_for` — none of which the method needs. Note: `persist_allow_directory_rule` is private, `start_native_session` is a method on `SessionManager`, so tests live in `session_tests` and call `manager.persist_allow_directory_rule(...)` directly (privates are visible in the same module's tests).

```rust
mod session_tests {
    // imports…
    use crate::agent::policy::{AccessRule, RuleDecision, RuleDirection};
    use crate::config::{append_rule, load_mutate_write, load_settings, write_settings_atomic};
```

**Test 1** — `an_allow_directory_answer_appends_exactly_one_rule_after_the_existing_user_rules` (the FILE side of the ordering contract):
```rust
#[tokio::test]
async fn an_allow_directory_answer_appends_exactly_one_rule_after_the_existing_user_rules() {
    use RuleDecision::{Allow, Deny};
    use RuleDirection::{ReadWrite, Write};

    let dir = temp_config_dir();
    // Seed a REAL pre-existing user rule: the `rules` key in settings.json
    // holds ONLY user rules — `default_rules()` is runtime-only
    // (T01 builds it in `agent/policy.rs`; it is never serialized). So the
    // file-side half of the ordering contract is: the new allow lands AFTER
    // whatever user rules already exist. THE `rules[..defaults.len()]` style
    // assertion is WRONG here — the file has no defaults in it (see the
    // ordering note under Test 1's doc).
    write_settings_json(&dir, serde_json::json!({
        "filePolicy": {
            "reads": "allow", "writes": "allow", "shell": "allow",
            "rules": [{ "path": "/Users/u/older", "direction": "write", "decision": "deny" }]
        }
    }));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(Some("/Users/u/skills"));

    // The seeded deny is NOT touched, and the new allow sits AFTER it.
    let rules = load_settings(dir.path()).file_policy.rules;
    assert_eq!(rules.len(), 2, "exactly ONE rule appended to the pre-existing user rules");
    assert_eq!(
        rules[0],
        AccessRule { path: "/Users/u/older".to_string(), direction: Write, decision: Deny },
        "the pre-existing user rule is untouched and still FIRST"
    );
    assert_eq!(
        rules[1],
        AccessRule { path: "/Users/u/skills".to_string(), direction: ReadWrite, decision: Allow },
        "the new allow lands at the END of the user rules — the file-side half of the CONCATENATION CONTRACT"
    );
    // Appended (the dedupe of test 3 must not have swallowed it — the
    // seeded deny is a DIFFERENT rule, and the appended allow is NEW).
    let _ = manager.close_session(&info.session_id).await;
}
```

**Ordering note (why Test 1 does NOT compare against `default_rules()`)**: `default_rules()` is runtime-only — it is built in `agent::policy::default_rules()` and NEVER serialized, so `settings.json`'s `rules` key contains ONLY user rules and can NEVER equal `default_rules()` (`rules.len() == defaults.len() + 1` and `rules[..defaults.len()] == defaults[..]` are FALSE on every machine — the defaults are not in the file). T04's file-side half of the ordering contract is therefore the assertion above: **exactly one rule appended, at the END of the pre-existing user rules**. The RUNTIME half — defaults first, then user rules, so that an appended allow wins the exact tie — lives at T03's concat site (`harness/loop.rs`'s `handle_prompt` — `self.default_rules.clone() ++ self.file_policy.rules.clone()`, CONCATENATION CONTRACT pinned in BOTH orders) and the tie itself is pinned by T01's `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` in `agent/policy.rs`. See the loud cross-task dependency box further down.

**Test 2** — `a_blank_or_absent_value_persists_nothing`:
```rust
#[tokio::test]
async fn a_blank_or_absent_value_persists_nothing() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(None);      // absent
    manager.persist_allow_directory_rule(Some(""));  // the T03 "" placeholder
    manager.persist_allow_directory_rule(Some("   ")); // all-whitespace

    let settings = load_settings(dir.path());
    assert!(settings.file_policy.rules.is_empty(), "a blank path persists nothing");
    let _ = manager.close_session(&info.session_id).await;
}
```

**Test 3** — `a_second_click_on_the_same_directory_is_idempotent`:
```rust
#[tokio::test]
async fn a_second_click_on_the_same_directory_is_idempotent() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(Some("/Users/u/skills"));
    manager.persist_allow_directory_rule(Some("/Users/u/skills"));

    let settings = load_settings(dir.path());
    assert_eq!(
        settings
            .file_policy
            .rules
            .iter()
            .filter(|r| r.direction == RuleDirection::ReadWrite && r.decision == RuleDecision::Allow)
            .count(),
        1,
        "a repeat click must NOT append a duplicate rule"
    );
    let _ = manager.close_session(&info.session_id).await;
}
```

**Test 4** — `a_differing_rule_for_the_same_path_still_appends` (the dedupe is by FULL identity):
```rust
#[tokio::test]
async fn a_differing_rule_for_the_same_path_still_appends() {
    use crate::agent::policy::{RuleDecision, RuleDirection};
    let dir = temp_config_dir();
    // Seed a hand-written `Deny` rule for the SAME path (the Settings
    // panel's "Add default rule" could have put it there, or a previous
    // deny the user wrote) — the allow-directory append must COEXIST,
    // because dedupe is exact-identity, never a path-key.
    write_settings_json(&dir, serde_json::json!({
        "filePolicy": {
            "reads": "allow", "writes": "allow", "shell": "allow",
            "rules": [{ "path": "/Users/u/skills", "direction": "write", "decision": "deny" }]
        }
    }));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, info) = start_native_session(&dir, &sink).await;

    manager.persist_allow_directory_rule(Some("/Users/u/skills"));

    let rules = load_settings(dir.path()).file_policy.rules;
    assert_eq!(rules.len(), 2, "a differing rule is NOT deduped away");
    assert!(rules.iter().any(|r| r.direction == RuleDirection::Write && r.decision == RuleDecision::Deny));
    assert!(rules.iter().any(|r| r.direction == RuleDirection::ReadWrite && r.decision == RuleDecision::Allow));
    let _ = manager.close_session(&info.session_id).await;
}
```
Note the seeded wire spellings: `"direction":"write"` (RuleDirection::Write is lowercase-serialized, T01) and `"decision":"deny"`.

**Test 5** — `the_persisted_rule_survives_a_settings_round_trip` (write → load → write → load, through `load_mutate_write` + `write_settings` on the REAL file):
```rust
fn a_persisted_rule_survives_a_settings_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let rule = AccessRule {
        path: "/Users/u/skills".to_string(),
        direction: RuleDirection::ReadWrite,
        decision: RuleDecision::Allow,
    };
    let mut s = Settings::default();
    s.file_policy.rules.push(rule.clone());
    write_settings(dir.path(), &s).unwrap();
    let loaded = load_settings(dir.path());
    assert_eq!(loaded.file_policy.rules, vec![rule.clone()]);
    // a second write from the loaded doc
    write_settings(dir.path(), &loaded).unwrap();
    let again = load_settings(dir.path());
    assert_eq!(again.file_policy, loaded.file_policy);
}
```

(Place 5 in `config::tests` — it is a config.rs round-trip — or in `session_tests`; the plan puts it in `config::tests` because it exercises `write_settings`/`load_settings`/serde, not the relay. The relay's "survives" is really test 1 + this.)

**Test 6** — the no-write-on-no-session pin (the `Ok(false)` arm — NOT the persist method; `respond_permission` itself):
```rust
#[tokio::test]
async fn a_missing_worker_routes_the_answer_to_nowhere_and_writes_no_rule() {
    use crate::agent::permission::PermissionOutcome;
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    // NO session is started — `handle_for` misses → `Ok(false)` and the
    // `Ok(())` arm (where the persistence lives) is never reached.
    let hit = manager
        .respond_permission(
            "no-such-session",
            "req-1",
            PermissionOutcome::Selected {
                option_id: "allow-directory".to_string(),
                value: Some("/Users/u/skills".to_string()),
            },
        )
        .await
        .expect("the miss is Ok(false), not Err");
    assert!(!hit, "a missing worker is a no-op");
    assert!(
        load_settings(dir.path()).file_policy.rules.is_empty(),
        "no session → no write"
    );
}
```
This pins the `respond_permission` arm's placement: the persistence branch lives inside the `Ok(())` send-success arm, so a `handle_for` miss resolves `Ok(false)` and writes nothing.

**Test 7** — the child path uses `value` only — a `respond_permission` through the relay with a child-shaped outcome (no `live` entry, no `db`) still persists. The pin is construction-only (the reviewer-accepted form): **`persist_allow_directory_rule` is `cwd`- and `db`-free by construction** (its body has no reference to `self.live` / `self.driver`) — and that construction is now CHECKABLE via the method doc's explicit child-safety guarantee (2b: "reads NO `self.live`, NO `self.driver` and NO `db`"), so a future edit that introduces one of those reads is visibly breaking against the doc. Driving a real child-shaped `respond_permission` is deliberately NOT attempted: `start_native_session` is the only way to get a real `handle_for` hit in the fixtures, and it always carries a main-session `live` entry with a `cwd` — a `SessionManager::new(dir)` + manual `attach_db(None)` + no live entry would MISS `handle_for` and return `Ok(false)`, which is the `Ok(false)` pin (Test 6), not the child. State the child case EXPLICITLY: `cwd` is `None` for children, and the persist arm never reads it — the `value` is the only input, and it is enough.

**Test 8** — `the_trust_space_persistence_arm_is_unchanged` — the strongest proof the arm is untouched: assert that a `trust-space` answer still flips the `spaces` row AND the rules list is untouched. The relay's `set_space_trusted` is an UPDATE (a missing row is a no-op), so the test must SEED the row first (`upsert_space` INSERTs) and assert via `space_trusted` (a read of the flag — the live twin of the persistence half):
```rust
#[tokio::test]
async fn the_trust_space_persistence_arm_is_unchanged() {
    let dir = temp_config_dir();
    write_settings_json(&dir, serde_json::json!({}));
    let (tx, _rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
    // The build_worker_manager triple exposes the `db`; the manager is the
    // SAME one `start_native_session` drives (the fixture precedent at
    // lines 2720-2730: `build_worker_manager` then `start_native_session`).
    let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);
    let info = manager
        .start_session(dir.path().to_path_buf(), &sink)
        .await
        .expect("the native session started");

    let cwd = info.cwd.clone();   // SessionInfo.cwd is a PathBuf
    // `set_space_trusted` is an UPDATE — seed the row (INSERT) first.
    db.upsert_space(&cwd.display().to_string(), false).unwrap();
    // Then answer via the relay's OWN arm (`trust-space` → the db write).
    manager.respond_permission(&info.session_id, "req-1",
        crate::agent::permission::PermissionOutcome::Selected {
            option_id: "trust-space".to_string(),
            value: None,
        }).await.expect("the answer relays");

    assert_eq!(
        db.space_trusted(&cwd).unwrap(),
        true,
        "the trust-space arm still flips the `spaces` row"
    );
    assert!(load_settings(dir.path()).file_policy.rules.is_empty(), "trust-space writes NO rule");
    let _ = manager.close_session(&info.session_id).await;
}
```
`start_session` is a method on `SessionManager` (`session/mod.rs:1386`, the same one `start_native_session` wraps) — it drives the same real fake-worker `handle_for` path `respond_permission` needs. The assertion is on the FLAG (read back via `space_trusted`), not on `set_space_trusted`'s return — a `set_space_trusted(..., false)` presence proof would flip the flag back and would test the wrong thing; the pin is "the arm ran and persisted", and `space_trusted == true` is exactly that.

### Step 4 — the full gate

From `src-tauri/`:

```bash
cargo test                       # full suite (the ONLY truth; `--lib` never compiles the tests/ tree)
cargo clippy --all-targets       # 0 warnings
cargo fmt --check
cargo check --target x86_64-pc-windows-gnu --all-targets
```

Scoped runs DURING the steps (each `--no-run` first to compile-prove; drop for runs — note `harness::loop::` filters match nothing, `loop` is a keyword):

```bash
cargo test --lib -- session_tests --no-run
cargo test --lib -- config::tests --no-run
```

The config tests live in `config.rs`'s inline `mod tests` (filter `config::tests`). The relay tests live in `session_tests` (filter `session_tests`). Run the FULL `cargo test` at the end — the failing-ring guarantee is the full suite, not the scoped filters.

## Verification matrix

| # | Pin | Owned host | Name |
|---|---|---|---|
| 1 | exactly one rule appended, at the END of the pre-existing user rules (the FILE-side half of the ordering contract) | `session_tests` | `an_allow_directory_answer_appends_exactly_one_rule_after_the_existing_user_rules` |
| 2 | the LOUD cross-task dependency — the RUNTIME concat order (defaults first → an appended allow wins the exact tie) is T03's concat site's half, pinned by T01 | `harness/loop.rs` concat (T03) + `agent/policy.rs` (T01) | T01's `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` (see the LOUD box in Step 2a) |
| 3 | a second identical click writes nothing (dedupe — appended at the END of the user rules, then deduped on repeat) | `session_tests` | `a_second_click_on_the_same_directory_is_idempotent` |
| 4 | blank/absent `value` persists nothing | `session_tests` | `a_blank_or_absent_value_persists_nothing` |
| 5 | the rule survives a settings round-trip (real file) | `config::tests` | `a_persisted_rule_survives_a_settings_round_trip` |
| 6 | an old settings.json without `rules` loads with an empty list | `config::tests` | `a_pre_feature_settings_json_parses_to_the_new_defaults` (already passes — this task adds the `rules` leg assertion) |
| 7 | `trust-space` unchanged | `session_tests` | `the_trust_space_persistence_arm_is_unchanged` |
| 8 | the persist method is `value`-only (child-safe) | code + comment | (no separate test — see Step 3 test 7) |
| 9 | `write_settings_atomic` writes the same bytes | `config::tests` | `write_settings_atomic_writes_the_same_bytes_as_write_settings` |
| 10 | `load_mutate_write` reads fresh, mutates, persists | `config::tests` | `load_mutate_write_reads_fresh_mutates_and_persists_atomically` |

`default_rules()` is runtime-only (never serialized — T01 builds it in `agent/policy.rs`), which is exactly why Test 1 seeds a pre-existing USER rule and asserts the append lands AFTER it: the file holds only user rules, so `rules[..defaults.len()] == defaults` can never hold on any machine. The runtime "defaults first, then user" order is T03's concat half (the LOUD box in Step 2a) and the tie itself is T01's pinned exact-tie test.

## Commands

```bash
cd /home/daniel/Coding/AI/archimedes-desktop/src-tauri
# helpers
cargo build --all-targets        # before trusting fake_worker fixtures (the fixture bin recompiles here)
# scoped (compile-proof during steps)
cargo test --lib -- session_tests --no-run
cargo test --lib -- config::tests --no-run
# gate (from src-tauri/)
cargo test
cargo clippy --all-targets
cargo fmt --check
cargo check --target x86_64-pc-windows-gnu --all-targets
```

Note `loop` is a Rust keyword — `harness::loop::` filters match nothing; use `policy_gate` / `session_tests` / `config::tests` substrings.

## Out of scope

- **T03** (the gate half): enforcement of rows 1–4 + replacing `permission_options(false)`'s `""` placeholder with the real nearest-existing-ancestor path. T04's wire contract is the spec's; the blank-value pin (test 2) is the seam that stays honest until T03 lands.
- **T07** (docs/ADRs): must record the settings.json concurrency limit T04 chose (the limitation block above — NOT the spec's agent-writable claim), **and the `tempfile` dependency move (if ratified) — a manifest change is a recorded deviation T07 should not re-derive.**
- **Follow-up (not this task):** adopt `load_mutate_write` in `set_config_option` (`session/mod.rs:1740-1745`) — the remembered-thinking-level write stays on the old `load_settings`-mutate-`write_settings` path here; migrating it is a behavior-neutral but separate change.

## Blocker (to the orchestrator — verify, don't not-fix)

1. **`tempfile` is a dev-dependency in `src-tauri/Cargo.toml:97` — a production-code use REQUIRES a manifest change.** The atomic-write fix needs `NamedTempFile` in PRODUCTION `config.rs` code. Verification: every in-crate production-file use of `tempfile` (`commands/spaces.rs:127`, `agent/mcp/manager.rs:587`, `agent/mcp/oauth.rs`, `agent/mcp/tool.rs`, `agent/web/config.rs`, `agent/normalize.rs`, `config.rs` itself at the `tempfile::tempdir()` utils) is inside a `#[cfg(test)]` module or test helper — the crate has NO production `tempfile` use today. Since `tempfile` is listed under `[dev-dependencies]`, `use tempfile` from `src/config.rs` production code is a compile error in `cargo build` (dev-deps are stripped from the stage-2 dependency graph).
   - **Path A (chosen):** move `tempfile = "3"` from `[dev-dependencies]` to `[dependencies]` in `src-tauri/Cargo.toml` — a one-line manifest edit, OUTSIDE this owned set. The orchestrator ratifies it (it cannot wait for T07; it is a T04 prerequisite). The version is already pinned in the lockfile; a dependency move changes no resolved version, so `cargo build --locked` does not re-resolve.
   - **Path B (fallback if A is refused):** drop `tempfile` and implement std-only atomic replace in `config.rs`: `NamedTempFile`-equivalents do not exist in `std`, so Path B is a hand-rolled temp (a unique name in `config_dir`) + `fs::rename` with Windows `MOVEFILE_REPLACE_EXISTING`-equivalent semantics via `std::os` if available — strictly WORSE (re-implements what `tempfile` gives, with the rename-atomicity caveat the crate already documents). Do NOT ship Path C (plain `fs::write`): it is the torn-write class this exists to prevent, and the plan's whole concurrency story collapses without it.

## Notes for the reviewer

- `commands/sessions.rs` is untouched (verified pass-through at lines 122–140). `db.rs` is untouched (the rule store is settings.json, not SQLite — grounding §5). The ONLY production changes are the three `config.rs` additions + the `session/mod.rs` relay arm + the private method.
- `write_settings` keeps its exact serialization — the byte pins (`file_policy_serializes_under_the_camel_case_file_policy_key`, `file_policy_round_trips_through_the_settings_file`) stay green; `write_settings_atomic` is a separate entry so the pins don't move.
- The `..` pattern is now a full destructure — the trust-space arm's `let _ =` error tolerance is preserved (`let _ = db.set_space_trusted(...)`).
- Clippy: `write_settings_atomic`'s `use std::io::Write;` inside the fn avoids `unused_imports` at file scope; the `for` over `rules` uses `iter()` (no index). `load_mutate_write`'s generic bound is minimal (`FnOnce`).
- Windows: `tempfile::NamedTempFile::persist` succeeds when the destination exists (`MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`, settled — see 1a); the crate's copy+remove fallback covers cross-volume/dir edge cases. The only T04-specific Windows note is negative: there is NO mode concept on Windows, which is why the mode-preservation block and its pin are `#[cfg(unix)]` (they do not compile on the mingw check target).

## Acceptance criteria (the named `#[test]`s — no counts)

1. `an_allow_directory_answer_appends_exactly_one_rule_after_the_existing_user_rules` — append EXACTLY ONE rule; nothing else in the document changes (the seeded pre-existing user rule is untouched and FIRST, the new allow is the LAST rule — the file-side half of the ordering contract; the three directions unchanged).
2. The contract: the RUNTIME concat order (defaults first, then user rules, so the appended allow wins the exact tie) belongs to T03's concat site (`harness/loop.rs`'s `handle_prompt`), NOT to this file's `rules` key — the tie itself is pinned by T01's `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` (inverted-concat branch reddens). See the LOUD cross-task dependency box in Step 2a — T04's correctness depends on T03's concat order.
3. `a_second_click_on_the_same_directory_is_idempotent` — exactly one identical rule despite two clicks.
4. `a_blank_or_absent_value_persists_nothing` — `None`, `""`, `"   "` all leave `rules` empty.
5. `a_persisted_rule_survives_a_settings_round_trip` — write → load → write → load through the REAL file; `FilePolicy.rules` round-trips exactly; an old file WITHOUT `rules` loads with an empty list (asserted by the existing pre-feature pin + this test's `write_settings`-then-`load_settings`).
6. `the_trust_space_persistence_arm_is_unchanged` — a trust-space answer still flips the `spaces` row (`space_trusted == true` after seeding with `upsert_space`) and leaves `rules` empty.
7. `config::tests::write_settings_atomic_writes_the_same_bytes_as_write_settings` + `config::tests::load_mutate_write_reads_fresh_mutates_and_persists_atomically` — the two new helpers are pinned.
8. `config::tests::write_settings_atomic_preserves_the_existing_files_mode_on_unix` — `#[cfg(unix)]`: a deliberately configured mode (0o640) survives the atomic write (the 0600 temp-mode tightening, DECISION (a) — not compiled on the Windows check target, which has no mode concept).

Nothing else. `cargo test` (full) green, clippy 0, fmt clean, mingw check clean.