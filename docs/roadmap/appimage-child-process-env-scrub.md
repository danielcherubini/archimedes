---
status: committed
done-when: In the shipped Linux AppImage, a Session's `bash` tool runs `node --version`, `npx tsc --version` and `git --version` with NOTHING on stderr and no `version 'OPENSSL_…' not found` failure; stdio MCP servers (`npx`/`uvx`) still start and a user's own MCP `env` entry still wins; after an update-and-restart the relaunched process references exactly ONE `/tmp/.mount_*` generation; a `.deb` install and a `cargo run` dev build behave byte-identically to today; and `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` (0 warnings), `cargo test` are green on ubuntu / windows / macos. (This plan touches no frontend file, so `pnpm test` / `pnpm build` are in the merge bar only because AGENTS.md's bar is unconditional — a red there is an unrelated breakage, not this change.)
---

# Scrub the AppImage's bundled paths out of every child process — Plan

**Goal:** Stop the AppImage's `AppRun`-injected `LD_LIBRARY_PATH` / `PATH` / `PYTHONHOME` / `GI_TYPELIB_PATH` / … from reaching child processes, which today kills `node` (`version 'OPENSSL_3.4.0' not found`) and degrades `git`/`rg`/`grep` (`libpcre2-8.so.0: no version information available`).

**Architecture:** One new pure module, `src-tauri/src/agent/hostenv.rs`, computes an `EnvPatch` (a set of `env` overrides + a set of `env_remove`s) from an inherited environment, an `APPDIR` and the current exe. It **strips path components that point inside an AppImage mount** rather than unsetting whole variables, so a legitimate pre-existing user value survives. It is gated so it is a total no-op outside an AppImage. Three follow-on tasks apply it at the six Linux spawn sites and stop the updater relaunch from stacking a second generation of mount paths.

**Tech Stack:** Rust 2021 (toolchain pinned by `src-tauri/rust-toolchain.toml` — `1.99.0`; do not float it, AGENTS.md), `std::process::Command` + `tokio::process::Command` (tokio's `env`/`env_remove` are one-line delegations to std — `tokio-1.53.1/src/process/mod.rs:444`/`:504` — so one patch serves both; note tokio's `Command` exposes **no** `get_envs`, so tests introspect via `as_std()`), `std::sync::OnceLock`, `std::os::unix::ffi::OsStrExt` (**Unix-only** — see the `cfg` rule below), Tauri 2.12.2 / `tauri-utils` 2.10.1 / `tauri-plugin-window-state` 2.4.0, all exact-pinned.

**Conventions for every task:** all Rust commands run from `src-tauri/` (that is where the pinned toolchain resolves — AGENTS.md). The merge bar is `cargo fmt --all -- --check` (this is what `.github/workflows/ci.yml:119` runs), `cargo clippy --all-targets -- -D warnings` (0 warnings), `cargo test`. CI runs the Rust bar on **ubuntu / windows / macos** (`ci.yml:16-24`, `:126`, `:129`), so every change must compile and pass on all three — and `--all-targets` means test code is linted too. Branch off `main` per `gitflow-branching`; squash-merge at the end. Per AGENTS.md, **write the failing test first and confirm it fails**, and this roadmap doc is **deleted on ship**.

**Evidence this plan stands on** — read `docs/research/appimage-child-process-env-leak.md` before starting; it carries every citation. Every claim below was re-verified against this tree, the vendored crates and a scratch binary during two reviewer passes; the executing agent must NOT re-litigate them. ⚠ marks a trap a naive reading falls into.

- **⚠ The variable is `LD_LIBRARY_PATH`, not `LD_LINKER_*`.** No `LD_LINKER_*` variable exists. It is not *unset* — it is set to ~20 entries that are 100% `/tmp/.mount_archim*` on an AppImage host, and the empty component it trails with means **the current directory**.
- **The env comes from the bundle, not from this repo.** Tauri ships `AppDir/AppRun.wrapped` (a compiled build of AppImageKit's deprecated `AppRun.c`, from release tag `apprun-old`) which `putenv`s `LD_LIBRARY_PATH=%s/usr/lib/:…:%s`, `PATH=%s/usr/bin/:…`, `PYTHONHOME=%s/usr/`, `PYTHONPATH`, `PERLLIB`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`, `QT_PLUGIN_PATH`, `GST_PLUGIN_SYSTEM_PATH[_1_0]`, `PYTHONDONTWRITEBYTECODE=1`; plus `AppDir/apprun-hooks/linuxdeploy-plugin-gtk.sh` (the only hook this bundle has) which exports `APPDIR`, `GI_TYPELIB_PATH`, `GIO_MODULE_DIR`, `GSETTINGS_SCHEMA_DIR`, `GTK_DATA_PREFIX`, `GTK_EXE_PREFIX`, `GTK_PATH`, `GTK_IM_MODULE_FILE`, `GDK_PIXBUF_MODULE_FILE`, `GTK_THEME`, `XDG_DATA_DIRS`. Both **prepend** to the inherited value (`…:%s`), so the original is recoverable by deleting only the mount entries — that is what makes strip-not-unset correct rather than heuristic.
- **Do not `env_clear()` anywhere.** std documents that removing `PATH` without a replacement makes `execvp` fall back to `confstr(_CS_PATH)` (`/usr/local/bin:/usr/bin`), **not** the parent's `PATH`. ⚠ Measured: with `PATH` removed a child still **exits 0** — so a dropped `PATH` is a *silent* regression, and `git --version` is NOT a test that catches it (see Task 2 test 3).
- **Do not scrub the main process's own env** (no startup `unsetenv`/`clearenv`). WebKitGTK `dlopen`s GdkPixbuf loaders and GIO modules, and `AppRun.c`'s `chdir("$APPDIR/usr")` is load-bearing because the GTK hook rewrites WebKit's `/usr` paths cwd-relative. Per-child env only.
- **Do not put the scrub in a `pre_exec` closure.** std materialises the child's `envp` array in the parent *before* `fork`, so `unsetenv` there is ineffective; it would also break the "two async-signal-safe syscalls, no allocation" invariant `sandbox.rs:697-703` documents as its own safety argument, and it would reach only `Sandboxed`-on-Linux bash.
- **Landlock neither causes nor mitigates this.** `sandbox.rs:695 install()` never touches env, and the sandbox grants `/usr`,`/bin`,`/lib`,`/lib64`, `/etc/ld.so.cache` and `READ_WRITE` + `PATH_BENEATH` on `/tmp`, so the mount stays reachable. The scrub composes with it; keep `install()` untouched.
- **⚠ Ordering rule at `mcp/stdio.rs`:** the scrub MUST be applied **before** `cmd.envs(&def.env)` (line 62). Verified end-to-end against a real `execve`: scrub-then-`envs` → the child sees the def's value; `envs`-then-scrub → the child sees the variable **absent** (the `env_remove` wins and the user's entry is discarded). The mechanism is "the removal wins", not "falls back to inherited".
- **`APPIMAGE` / `APPDIR` / `ARGV0` / `OWD` are deliberately NOT touched.** No search-path semantics that break a child, they are the documented AppImage contract, and a user's own packaging script run through the `bash` tool may legitimately read them. `PYTHONDONTWRITEBYTECODE=1` is likewise left alone (not a path).
- **`LD_PRELOAD` is deliberately NOT in the scrub list.** It is **space**-separated, so the one split-on-`:` rule cannot express it, and nothing in this bundle sets it (`AppDir/usr/optional/` does not exist, so there is no `checkrt` hook). Document this in the const's comment so a later reader does not "fix" the omission with a second separator rule.
- **`PYTHONHOME` IS in the list even though no upstream scrub list includes it** (AppImageKit's `run_external()` omits it). It is `$APPDIR/usr/` here and it breaks any system `python3` child outright. Say so in the comment.
- **Empty path components are DROPPED.** `AppRun.c`'s `%s…:%s` always leaves a trailing `:` when the prior value was empty, and `ld.so`/`PATH` read an empty entry as **the current directory** — a real defect (AppImageKit#391; the same idiom in electron-builder is CVE-2026-54672). Dropping empties is a security fix, not a semantic change to preserve.
- **⚠ `relaunch_app`'s stacking cannot be fixed by intercepting `app.restart()`** — it is `-> !` with no env hook (`tauri-2.12.2/src/app.rs:606` → `process.rs:74-89`), and `current_binary` returns `$APPIMAGE` on Linux (`process.rs:48-56`), so the relaunch re-enters `runtime → AppRun → AppRun.wrapped`, which prepends again. Task 4 owns the spawn instead.

**The spawn census (complete, re-derived twice).** Six Linux scrub sites: `exec.rs:367` (`sh`), `exec.rs:1004` (`fd`), `exec.rs:1194` (`rg`), `mcp/stdio.rs:57`, `worker/client.rs:237`, `interactive/sudo_exec.rs:70`. The seventh `Command::new` in `src-tauri/src` is `exec.rs:374`, the Windows `cmd /C` twin of the *same* `Command` object as `exec.rs:367` — one patch call covers both. `WorkerHandle::spawn`'s only production caller is `src/lib.rs:33` (the calls at `harness/dispatch.rs:420` and `harness/loop.rs:6592` are inside `#[cfg(test)]`, which starts at `:377` and `:2497`). There is no `fork`/`execvp`/`posix_spawn`/`CommandExt` anywhere else in `src/`. Task 4 adds an **eighth** spawn (the relaunch), which is deliberately outside the `hostenv` scrub-site count because it spawns the AppImage file, not a tool.

---

### Task 1: The `hostenv` module — a pure env scrubber, no call sites

**Context:** Every production spawn site in this repo inherits the process env implicitly — verified: `grep -rn "LD_LIBRARY_PATH\|APPDIR\|APPIMAGE\|env_remove\|env_clear" src-tauri/src` returns **0 hits**. Tasks 2–4 attach a scrub at each site and all share the one decision procedure this task builds. This task adds the module and its tests and **changes no behaviour**, so it is safe to land alone.

Two design constraints shape the API. **(1) Purity:** the helper takes the input environment, `APPDIR` and exe as *arguments* and returns a patch, so tests need no process-env mutation, no `test_support::env_lock()`, no `unsafe`, and run safely in parallel. **(2) Set-or-remove, not a `HashMap`:** `env_remove` is not representable as a map entry, and "the strip emptied this variable" is the interesting case — the variable may not have existed before the `AppRun` invented it, and `env(var, "")` is not equivalent to removing it.

**Files:**
- Create: `src-tauri/src/agent/hostenv.rs`
- Modify: `src-tauri/src/agent/mod.rs` — add `pub mod hostenv;` between `pub mod harness;` and `pub mod interactive;` (the list is alphabetical)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/agent/hostenv.rs` (the repo convention — cf. `exec.rs:1496`, `sandbox.rs:722`)

**What to implement:**

```rust
//! What a child process should inherit, minus the AppImage's own paths.

/// The explicit overrides one child `Command` needs (empty ⇒ apply nothing).
pub struct EnvPatch {
    set: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    remove: Vec<std::ffi::OsString>,
}

impl EnvPatch {
    /// True when nothing would change (the no-op case every non-AppImage host hits).
    pub fn is_empty(&self) -> bool;

    /// Apply the patch. Call this BEFORE the call site's own `env`/`envs`,
    /// so a caller's explicit variable still wins.
    pub fn apply(&self, cmd: &mut tokio::process::Command);
    pub fn apply_std(&self, cmd: &mut std::process::Command);
}

/// The cached patch for THIS process (`APPDIR` + `current_exe()` are
/// process-lifetime constants, so this is computed once). `is_empty()` when
/// we are not running from an AppImage.
///
/// ⚠ PRODUCTION-ONLY. Under `cargo test`, `current_exe()` is
/// `target/debug/deps/<hash>`, which is never under `$APPDIR`, so the gate
/// closes and this returns an EMPTY patch on every host — a test that
/// asserts against `for_child()` asserts nothing. Tests must call `scrub`
/// with a fabricated `appdir`/`exe` pair.
pub fn for_child() -> &'static EnvPatch;

/// Pure. Production callers go through `for_child()`; tests call this directly.
/// `inherited`: the env the child would inherit (prod: `std::env::vars_os()`).
/// `appdir`:    `std::env::var_os("APPDIR")`.
/// `exe`:       `std::env::current_exe()`.
/// The `appdir`/`exe` inputs are NOT trusted: an empty or root `appdir` must
/// gate the scrub OFF (see step 1).
pub fn scrub(
    inherited: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    appdir: Option<&std::path::Path>,
    exe: &std::path::Path,
) -> EnvPatch;

/// The variables the bundle's `AppRun` / GTK hook are known to taint. One rule
/// covers both colon-list values (`PATH`, `LD_LIBRARY_PATH`, …) and single-path
/// values (`PYTHONHOME`, `GIO_MODULE_DIR`, …): a single path is a one-component
/// list. Order is the order the patch reports; keep it stable.
const TAINTED_VARS: &[&str] = &[
    "PATH", "LD_LIBRARY_PATH",
    "PYTHONHOME", "PYTHONPATH", "PERLLIB",
    "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR", "GIO_MODULE_DIR", "GIO_EXTRA_MODULES",
    "GI_TYPELIB_PATH", "QT_PLUGIN_PATH",
    "GTK_DATA_PREFIX", "GTK_PATH", "GTK_EXE_PREFIX", "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR",
    "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_PATH",
    "GST_PLUGIN_SCANNER",
];
```

Algorithm for `scrub`, exactly:

1. **Gate — the false-positive AND data-loss defence.** Return the empty patch unless **all** of:
   - the target is Linux (`#[cfg(target_os = "linux")]`; on every other target `scrub` returns the empty patch unconditionally — mirror the `cfg` discipline already at `exec.rs:364-378`);
   - `appdir` is `Some(p)`, **and `p` is not empty**, **and `p` has at least one component**. ⚠ `std::env::var_os` returns `Some("")` for a set-but-empty variable, `Path::new("")` makes `Path::starts_with` return **`true` for every path**, and an empty mount root makes the byte-prefix rule in step 3 match **every absolute entry** — so `APPDIR=""` (a common "unset-ish" idiom, and exactly what a CI script exports) would strip `PATH` from every child and lose `~/.cargo/bin`, `~/.local/bin`, `/opt/nvim` **silently, exit code 0**. `APPDIR="/"` must be rejected by the same component-count rule.
   - `exe.starts_with(appdir)`. Both halves are required: a user's own shell may legitimately export `APPIMAGE`/`APPDIR`, and then their real `PATH` must not be touched.
   - Prefer a positive structural check in addition, `appdir.join("usr").is_dir()`, and comment it as a tiebreaker, never the sole test (it makes the gate fail *closed* on a weird layout, which is the safe direction).
2. **Mount roots.** Start with `{ appdir }`. Then, for every entry of every `TAINTED_VARS` variable present in `inherited`, walk `Path::new(entry).ancestors()` and if any ancestor's `file_name()` starts with `.mount_`, add that ancestor. The second half is what removes a **stale generation**: this host has `PATH` entries under *two* `.mount_archim*` dirs while `$APPDIR` names only one, and the older mount dir appears in no variable of its own. The `.mount_` shape is confined to candidate discovery and is never authoritative alone (`build_mount_point` in AppImage's `runtime.c` is an implementation detail, and its truncation length has already drifted between versions).
3. **Per variable in `TAINTED_VARS` that is present in `inherited`:** split the value on `:`; drop every component that is empty and every component that lies under a mount root (byte-prefix match: equal to the root, or starts with the root's bytes and the next byte is `/` — this handles both the `AppRun` trailing slash `/tmp/.mount_x/usr/lib/` and the GTK hook's **double-slash** `$APPDIR//usr/lib/girepository-1.0` form, and correctly *rejects* the sibling `.mount_archimgAAJCIx`); then:
   - **a. no component survived → `remove`** the variable (never `env(var, "")` — an empty `LD_LIBRARY_PATH` and an absent one are not the same to every consumer, and the variable may not have existed before the AppRun created it);
   - **b. components survived and the rejoined value differs from the input → `set`** it, components in the original relative order;
   - **c. components survived and the rejoined value is byte-identical to the input → neither `set` nor `remove`.** ⚠ This is what makes the patch *itself* idempotent, which is what Task 1's idempotency test asserts and what stops growth across the main → Worker → `bash` hops. Without it, `scrub` emits a `set` for every tainted variable on every host and `for_child().is_empty()` is never true even when nothing was wrong. Note `"/usr/lib:"` → `"/usr/lib"` **is** a change, so the trailing-colon case still emits `set`.
   - the variable is absent from `inherited` → leave it entirely alone (never invent one).
4. **Never `env_clear()`,** and never add or reorder variables that were not in `inherited`.

**The `cfg` / encoding rule (this is what keeps Windows CI compiling).** The byte split lives in ONE private helper, `#[cfg(unix)] fn split_colon_list(v: &std::ffi::OsStr) -> Vec<std::ffi::OsString>`, implemented with `std::os::unix::ffi::OsStrExt::as_bytes` + `OsString::from_vec` — **both safe on Unix, so the module needs no `unsafe` at all**. `use std::os::unix::ffi::OsStrExt;` must be inside that `#[cfg(unix)]` scope: at module top level it is a **compile error on `windows-latest`** before any other `cfg` can help. On non-Unix there is no helper and `scrub` returns the empty patch, so nothing needs a cross-platform path. Do **not** reach for `OsStr::as_encoded_bytes()` + `from_encoded_bytes_unchecked` — that route requires `unsafe`, and the `cfg(unix)` route does not.

`for_child()` caches into `static PATCH: std::sync::OnceLock<EnvPatch>`, feeding `scrub` from `std::env::var_os("APPDIR").as_deref()`, `std::env::current_exe()` (on error pass `Path::new("/")` so the gate closes — fail toward "do nothing"), and `std::env::vars_os()`. `apply` / `apply_std` loop over `remove` then `set`; the two sets are disjoint by construction, so the order between them is irrelevant — say that in a comment so a reader does not "fix" it.

**Do NOT:** add `LD_PRELOAD` / `PYTHONDONTWRITEBYTECODE` / `APPIMAGE` / `APPDIR` / `ARGV0` / `OWD` / `GTK_THEME` to `TAINTED_VARS` (reasons above); touch `sandbox.rs`; scrub the process env via `set_var`/`remove_var`/`clearenv`; add an allowlist mode; reconstruct a `PATH` from `/proc/<pid>/environ`; add a public `env_clear` escape hatch; add `unsafe`.

**Steps:**
- [ ] **Create the skeleton first** — `src-tauri/src/agent/hostenv.rs` with the types, the signatures above and `todo!()` bodies, plus `pub mod hostenv;` in `agent/mod.rs`. ⚠ Do NOT try to add tests before this exists: the tests live *inside* `hostenv.rs`, and `cargo test hostenv` against a non-existent module prints `running 0 tests` / `test result: ok` and **exits 0** — it looks like success, not failure.
- [ ] Run `cargo build`. Did it compile with `todo!()`s? If not, fix before continuing.
- [ ] **Now write the failing tests** in that file's `mod tests`. Each gets a doc comment stating the **claim** and why the alternative would pass vacuously. Required set:
  1. `outside_an_appimage_nothing_is_touched` — `appdir: None` → `is_empty()`.
  2. `a_foreign_exe_gates_the_scrub_off` — `APPDIR` **set and well-formed**, `exe` outside it (`/usr/bin/archimedes`) → `is_empty()`. The false-positive defence; a naive "is `APPIMAGE` set?" implementation passes test 1 and fails this.
  3. `an_empty_appdir_gates_the_scrub_off` — `appdir: Some(Path::new(""))`, exe `/usr/bin/archimedes` → `is_empty()`, **and** the same input with a tainted `PATH` produces **no** `remove` for `PATH`. ⚠ This is the data-loss test: `Path::new("").starts_with` semantics make every absolute entry match, so without the guard every tainted variable is emptied and `env_remove`d, and the child still exits 0.
  4. `a_root_appdir_gates_the_scrub_off` — `appdir: Some(Path::new("/"))` → `is_empty()`.
  5. `mount_entries_are_stripped_and_the_user_entries_survive_in_order` — `PATH = "<appdir>/usr/bin/:<appdir>/bin/:/home/u/.cargo/bin:/usr/bin"` → `set` to exactly `/home/u/.cargo/bin:/usr/bin`.
  6. `a_variable_the_runtime_invented_is_removed_not_emptied` — `LD_LIBRARY_PATH` whose every component is under the mount → `remove`, and assert the patch carries **no** `set` for it.
  7. `a_user_component_after_the_mount_entries_survives` — `LD_LIBRARY_PATH = "<appdir>/usr/lib/:/opt/vendor/lib"` → `set` to `/opt/vendor/lib`. The loss-freedom guarantee `env_remove` cannot give.
  8. `stale_generations_are_stripped_too` — `PATH` carries entries under **two** `.mount_archim*` dirs, `appdir` names only one; assert both are gone. Regression pin for the measured accumulation.
  9. `empty_components_are_dropped` — `"<appdir>/usr/lib/:/usr/lib:"` (the `AppRun` trailing colon) → exactly `/usr/lib`, and assert it IS in the `set` half (a change, per rule 3b).
  10. `a_variable_that_needs_no_change_is_not_in_the_patch_at_all` — `PATH=/usr/bin:/bin` → neither `set` nor `remove` mentions `PATH`. Pins rule 3c; without it `is_empty()` is never true and `for_child()` always reports work to do.
  11. `a_variable_absent_from_the_inherited_env_is_never_invented` — no `PYTHONHOME` in input → absent from the patch.
  12. `the_scrub_is_idempotent` — apply the first patch to a copy of `inherited`, feed that back to `scrub`, assert the second patch `is_empty()`. Depends on rule 3c.
  13. `the_tainted_var_list_covers_everything_the_bundle_exports` — hard-code, **as a literal in the test**, the names derived from the bundle: from `target/release/bundle/appimage/Archimedes.AppDir/AppRun.wrapped` (`strings … | grep -E '^[A-Z_]+=%s'`) and from `…/apprun-hooks/linuxdeploy-plugin-gtk.sh` (`grep -oE '^\s*export [A-Z_]+'`). Assert **every derived name is IN `TAINTED_VARS`** — a **superset** relation, NOT equality. ⚠ Equality fails by design: `TAINTED_VARS` deliberately also carries `GIO_EXTRA_MODULES`, `GDK_PIXBUF_MODULEDIR`, `GST_PLUGIN_PATH`, `GST_PLUGIN_SCANNER`, which nothing in this bundle exports (no `checkrt` hook — `AppDir/usr/optional` does not exist) and which are defence-in-depth against a future plugin set. Keep that sub-list as a second literal with a comment saying so. Harmless either way: `scrub` only ever touches names present in `inherited`. Pin a **sorted** comparison (mirror `sandbox.rs:924`/`:946`'s pinned-set approach — note `sandbox.rs:970` pins a *path*, not a set).
  14. `the_patch_actually_reaches_a_real_child` — `scrub` a synthetic `inherited` (`LD_LIBRARY_PATH = "<fake>/usr/lib/:/usr/lib"`) with a fabricated `appdir`/`exe` pair (the paths need not exist), then spawn `/bin/sh -c 'printf %s "$LD_LIBRARY_PATH"'` **by absolute path**, `env_clear()` the `Command` first, `apply` the patch, and assert stdout is exactly `/usr/lib`. ⚠ `env_clear`-then-`apply` is sound for the **`set`** half — which is all this test uses — but it would be vacuous for a `remove` assertion (removing after a clear is a no-op). This is the only test proving `apply` reaches `execve`.
- [ ] Run `cargo test hostenv` from `src-tauri/`. **Every one of the 14 must print `FAILED`** (a `todo!()` panic counts). ⚠ A `test result: ok`, or `running 0 tests`, means the filter matched nothing or the tests are inert — stop and fix that before proceeding. AGENTS.md requires *confirming the failure*.
- [ ] Implement `scrub`, `apply`, `apply_std`, `for_child` and the `#[cfg(unix)]` split helper.
- [ ] Run `cargo test hostenv` — all 14 green, none `ignored`.
- [ ] Run `cargo test` — nothing else regressed (nothing else can see this module yet; a failure here means a shared file changed).
- [ ] Run `cargo fmt --all`, then `cargo fmt --all -- --check`.
- [ ] Run `cargo clippy --all-targets -- -D warnings` — 0 warnings on **all three** platforms. ⚠ Two known landmines: (a) on macOS/Windows the `scrub` body is cfg'd out, so the module-level const trips `dead_code` (`warning: constant TAINTED_VARS is never used` is on by default and CI runs `-D warnings` on windows + macos) → annotate `#[cfg_attr(not(target_os = "linux"), allow(dead_code))]`; (b) the `cfg(not(unix))` `scrub` parameters trip `unused_variables` → name them `_inherited` etc. in that branch.
- [ ] Run `cargo build`.
- [ ] Commit: `feat(exec): the hostenv scrubber strips AppImage mount paths from a child's env`

**Acceptance criteria:**
- [ ] `scrub` reads no process env and touches no `Command` — proven by the signature.
- [ ] `APPDIR` unset, empty, `/`, or an exe outside it ⇒ empty patch. Verified by tests 1–4.
- [ ] A variable emptied by the strip is **removed**, never set to `""`.
- [ ] A variable needing no change appears in neither half of the patch (rule 3c).
- [ ] `PATH` is filtered, never dropped wholesale unless every component was a mount path.
- [ ] The module contains no `unsafe` and no top-level `use std::os::unix::…`.
- [ ] All 14 tests pass on Linux, macOS and Windows; clippy 0 warnings on all three.

---

### Task 2: Scrub the `bash` tool and the `fd` / `rg` fast paths

**Context:** `exec_bash` (`src-tauri/src/agent/tools/exec.rs:348`) is the highest-impact site — it is how the agent runs `node`, `npx tsc`, `git`, `cargo`, `pnpm`. Today it builds `tokio::process::Command::new("sh")` at `:367` and calls `cmd.spawn()` at `:415` with **no `.env*` call anywhere in the function**, so the child inherits `LD_LIBRARY_PATH` with the mount dirs at position 0. That is the exact mechanism behind the user-visible failure: `ld.so` resolves `libcrypto.so.3` by SONAME (a match), then fails the separate `DT_VERNEED` check because the bundled copy only defines `OPENSSL_3.0.0/3.0.3/3.0.8/3.0.9` — fatal, which is why the agent reports "Node is broken in this sandbox" and skips `tsc`. `git`'s warning is the non-fatal branch of the same mechanism (the bundled `libpcre2-8.so.0` has no `.gnu.version_d` at all). The `fd` (`:1004`) and `rg` (`:1194`) fast paths leak identically and additionally depend on `PATH` surviving, which is why Task 1 filters rather than removes it.

**Files:**
- Modify: `src-tauri/src/agent/tools/exec.rs` — three sites: apply in `exec_bash` before `cmd.spawn()` at `:415` (the `sandbox.install(&mut cmd)` call is at **`:404`**, inside the block starting `:403`; the "guard MUST outlive `spawn`" comment is at **`:391`**), and restructure the `fd` chain at `:1004-1014` and the `rg` chain at `:1194-1198`
- Test: inline `mod tests` in `src-tauri/src/agent/tools/exec.rs` (starts `:1496`; the `ctx`/`temp_cwd`/`execute_tool`/`text_of` helpers it already has are the ones to reuse)

**What to implement:**

1. **`exec_bash`.** Apply `crate::agent::hostenv::for_child()` to `cmd` **after** the `#[cfg(target_os = "linux")]` sandbox block (`:403-413`) and immediately before `let mut child = match cmd.spawn()` (`:415`). Place it after so the ordering is explicit and a future refactor that makes the sandbox env-aware cannot undo it — and say in a comment that the ordering is cosmetic (Landlock never touches env) and that the `Sandbox` guard's lifetime documented at `:391` is unchanged. Apply once, covering both the Unix `sh` branch (`:365-371`) and the Windows `cmd` branch (`:373-377`); the patch is empty on Windows, so behaviour there is byte-identical.
2. **The `fd` site (`:1004`).** It is currently a fluent chain ending `.output().await` with no named binding. Bind it: `let mut cmd = tokio::process::Command::new("fd"); cmd.args([...]); crate::agent::hostenv::for_child().apply(&mut cmd); let fd = cmd.output().await;`. Keep the existing `--` hardening comment verbatim and keep `--max-results` exactly as it is.
3. **The `rg` site (`:1194`).** Same restructure: bind, apply, keep `.args(&args)` and the `--` terminator, then `.output()`.
4. Add one sentence to `exec_bash`'s doc comment (it already documents the process-group and Landlock reasoning) recording that the child's env is scrubbed of AppImage paths, pointing at `docs/research/appimage-child-process-env-leak.md`.
5. **Note the known remaining gap in a comment at the `fd`/`rg` sites:** unlike `exec_bash` (which sets `current_dir` at `:379`), `exec_find` and `exec_grep` pass **no** `current_dir`, so those two children run with the *inherited* cwd — which under `AppRun.c`'s `chdir("$APPDIR/usr")` is **inside the mount**. The env half is fixed here; the cwd half is deliberately out of scope and must be named so it is not mistaken for done. (It is not a leak of *libs*, but it is why a relative path in a `find`/`grep` result could surprise.)

**Do NOT:** change `process_group(0)` (`:369`), `kill_on_drop(true)` (`:383`), `current_dir` (`:379`), the timeout logic, the `Sandbox` guard's binding, or `sandbox.rs`. Do not "fix" `--max-results` — verified real (`fd`'s `src/cli.rs` declares `max_results` with `hide_short_help = true`, which is why it is absent from `fd -h`); the fast path genuinely runs.

**Steps:**
- [ ] Write the failing tests first:
  1. `a_scrubbed_sh_child_sees_no_mount_path_but_keeps_the_user_path` — the deterministic unit-level proof, routed through **the same shell this tool uses**: `env_clear()` a `tokio::process::Command` on `/bin/sh`, apply a patch built by `hostenv::scrub` with a fabricated `appdir` + an exe under it and a synthetic `inherited` (`LD_LIBRARY_PATH = "<appdir>/usr/lib/:/usr/lib"`, `PATH = "<appdir>/bin:/opt/test-unique/bin"`), run `printf '%s|%s' "$LD_LIBRARY_PATH" "$PATH"`, and assert stdout is `/usr/lib|/opt/test-unique/bin`. State honestly in the doc comment that this proves `apply` + the shell's view, **not** that `exec_bash` calls it — test 3 covers the call site.
  2. `a_bash_child_on_an_appimage_host_sees_no_mount_paths` — the real integration test through the tool: `execute_tool(&ctx(&cwd), "bash", json!({"command": "printf '%s' \"$LD_LIBRARY_PATH:$PATH\""}))`, and on a **tainted** host (`std::env::var_os("APPDIR").is_some()` and `LD_LIBRARY_PATH` contains `.mount_`) assert the output contains no `.mount_`.
  3. `the_bash_tool_keeps_the_users_path_entries` — the CONTRAST, and it must be a test that **can fail**. Do NOT assert "`git --version` still runs": with `PATH` removed the child still exits 0 via `confstr(_CS_PATH)` (`/usr/local/bin:/usr/bin`), so that assertion cannot fail. Instead: create a temp dir, put a marker file in it, build a synthetic `inherited` whose `PATH` is `"<appdir>/bin:<that temp dir>"`, apply the patch to a `env_clear()`ed `/bin/sh` running `printf %s "$PATH"`, and assert the temp dir **survives** in the child's `PATH`. A site or rule that nukes `PATH` fails this loudly.
  4. `the_skip_is_a_failure_on_a_capable_host` — the skip-visibility reporter. ⚠ The `sandbox.rs:735-745` marker pattern is **insufficient as-is**: `eprintln!`/`println!` output from a *passing* test is captured by the harness, so `cargo test | grep -c SKIP-HOSTENV` returns **0 even when the test skipped** (verified), and `ci.yml:129` runs a bare `cargo test`. So: keep the greppable `SKIP-HOSTENV:` marker and the `static SKIPPED: AtomicUsize`, but make the reporter test **assert** rather than merely print — `panic!` when `SKIPPED > 0` **while the host is genuinely tainted** (taint detectable from the process env), and otherwise print the explicit `SKIP-HOSTENV: host is not an AppImage, the scrub is unobservable here` verdict line. Record in the doc comment: *"on an AppImage host `cargo test -- -- --nocapture` MUST print zero SKIP-HOSTENV markers, and on a non-AppImage host it MUST print the verdict."*
- [ ] Run `cargo test -- hostenv exec`. Did tests 1–4 fail? ⚠ A `running 0 tests` / `test result: ok` means the filter matched nothing — fix the filter, do not accept it. Investigate any test that passed early.
- [ ] Implement the three sites.
- [ ] Run `cargo test -- hostenv exec`, then `cargo test` in full (this is the suite that spawns real `sh`/`rg`/`fd` processes — a `PATH` regression surfaces here).
- [ ] Run `cargo fmt --all`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build`.
- [ ] Commit: `fix(exec): scrub the AppImage's bundled paths from bash, fd and rg`

**Acceptance criteria:**
- [ ] `exec_bash` applies the patch before `spawn()`, with the ordering-vs-Landlock comment and the `:391` guard-lifetime note intact.
- [ ] Both fast paths bind the `Command` and apply the patch; the `--` injection hardening is intact; `--max-results` untouched.
- [ ] The mount-relative cwd gap is named in a comment at the `fd`/`rg` sites.
- [ ] The skip reporter **fails** on a tainted host that skipped, and prints a verdict on a clean host.
- [ ] `cargo test`, clippy (0 warnings), `fmt --all -- --check`, `build` green on ubuntu / windows / macos.

---

### Task 3: Scrub the MCP stdio servers, the Worker self-spawn and the `sudo` runner

**Context:** Three more production spawn sites, each for a distinct reason. **(a) `src-tauri/src/agent/mcp/stdio.rs:57`** — the only env call in the whole crate is `cmd.envs(&def.env)` at **`:62`**, documented at `:59-61` as **ADDITIVE** over full inheritance. stdio MCP servers are overwhelmingly `npx`/`uvx`/`node`/`python`, i.e. exactly the frozen-interpreter shapes that `PYTHONHOME`, `PYTHONPATH` and a shadowed `libssl` kill; this is the most damaging site after `bash`. The scrub MUST land **before** `:62` or a user's explicit `env` entry is silently discarded (verified both orders against a real `execve`). **(b) `src-tauri/src/agent/worker/client.rs:237`** — the Agent runtime is a **self-exec of this same binary** (`<exe> --worker`, exe from `src/lib.rs:32` `std::env::current_exe()`), and inside an AppImage `current_exe()` resolves *through the mount* (`/proc/<pid>/exe` → `/tmp/.mount_archimgAAJCI/usr/bin/archimedes`). Scrubbing here means the Worker — the process that actually spawns the user's commands — starts clean, and generation N's garbage stops propagating down. **(c) `src-tauri/src/agent/interactive/sudo_exec.rs:70`** — a hijacked `LD_LIBRARY_PATH` reaching a **root** `git`/`apt`/`dnf` is a library-hijack surface, not merely a broken command; the highest-severity site. Note too that `sudo`'s own `env_reset`/`env_check` policy **refuses to run** on some `LD_*` variables, so scrubbing can turn a refusal into a success.

**Files:**
- Modify: `src-tauri/src/agent/mcp/stdio.rs` — between `:60` (`cmd.args(&def.args)`) and `:62` (`cmd.envs(&def.env)`)
- Modify: `src-tauri/src/agent/worker/client.rs` — after `cmd.arg("--worker")` (`:238`), before the `#[cfg(unix)]` `pre_exec` block at `:253-261` / `spawn()` at `:262`
- Modify: `src-tauri/src/agent/interactive/sudo_exec.rs` — after `cmd.args(rest)` (`:71`), before `spawn()` at `:100`
- Test: inline `mod tests` in `src-tauri/src/agent/mcp/stdio.rs` and `src-tauri/src/agent/worker/client.rs`

**What to implement:**

1. **A `build_command` seam at each of the three files**, because the assertion has to be made on a `Command` that was never spawned: `fn build_command(def: &StdioDef, cwd: &Path) -> tokio::process::Command` in `stdio.rs` (production `connect()` calls it and then adds the `Stdio`/`kill_on_drop` lines), and the equivalent small seam at the other two sites. ⚠ Do **not** annotate them `#[cfg_attr(test, allow(dead_code))]` — the lint fires in the **non-test** build, so that attribute has the wrong polarity and the warning survives; they are called by production `connect()`/`spawn()`, so no attribute is needed at all.
2. **`stdio.rs`.** `for_child().apply(&mut cmd)` inside the seam, **before** `envs(&def.env)`. Update the `ADDITIVE` comment (`:59-61`) to state both halves: the inherited env is first scrubbed of AppImage paths, and the def's `env` still wins over the scrub.
3. **`client.rs`.** Apply inside the seam. ⚠ **The one judgement call in the plan, deliberate:** the Worker runs the same ELF as the GUI process, so if it ever `dlopen`s a bundled library through a path only `LD_LIBRARY_PATH` resolves, scrubbing breaks it. It does not render and has no window, so the expectation is that it is fine. Name the risk and the escape hatch in the comment (delete this one call, leaving (a), (c) and Task 2 in place — pollution then stays inside the Worker and never reaches the user's commands). Field-tested in Task 4, not here.
4. **`sudo_exec.rs`.** Apply inside the seam, with the severity argument (elevated process + attacker-influenced loader path) and the `env_reset` side note.
5. Add one line to each site's existing rationale comment (all three already carry dense "why this line exists" comments) so the env decision sits next to the process-group and `kill_on_drop` decisions.
6. **Say plainly in each test's doc comment that a seam-built `Command` is not the command that spawns** — the `pre_exec` blocks stay at the call sites (`stdio.rs` has none; `client.rs:253-261` and `sudo_exec.rs:93-99` keep theirs). The seams prove the env/argv policy, not the end-to-end spawn.

**Do NOT:** move or reorder the `pre_exec` blocks, `kill_on_drop(true)`, the `Stdio::piped()` trio at **`sudo_exec.rs:77-79`** (the password travels that stdin pipe — reordering is a functional regression, not a style change), or `stderr(Stdio::null())` at `stdio.rs:66`. Do not add scrubbing to `src/open.rs` (it delegates to `tauri_plugin_opener` → `open-5.4.4` → `xdg-open`, outside this repo's `Command`s — name it a known remaining leak in the commit message).

**Steps:**
- [ ] Write the failing tests first. ⚠ `tokio::process::Command` has **no** `get_envs` / `get_args` / `get_program` — introspect with **`cmd.as_std().get_envs()`** and `cmd.as_std().get_args()`. Verified facts the tests rely on: `get_envs()` yields `None`-valued entries for `env_remove`s, is empty after `env_clear()`, and `get_args()` **excludes argv0** (so the Worker's is `["--worker"]`).
  1. `an_mcp_server_env_wins_over_the_scrub` — a `StdioDef` whose `env` sets `LD_LIBRARY_PATH` to a sentinel; assert `as_std().get_envs()` resolves that key to the **sentinel**, not a stripped value. ⚠ Build the expected value with `hostenv::scrub` and a **fabricated** `appdir`+exe pair — never `for_child()`, which is empty under `cargo test` because `current_exe()` is `target/debug/deps/…`. This is the ordering test: a scrub applied *after* `envs` fails it.
  2. `an_mcp_server_inherits_a_scrubbed_library_path` — same seam, `def.env` empty, fabricated taint; assert the entry is absent or mount-free, and that a non-mount entry survives.
  3. `the_worker_self_spawn_gets_a_scrubbed_command` — assert the seam's `Command` carries the patch's `remove`/`set` entries (via `as_std().get_envs()`, remembering removals appear as `None`), and that `get_args()` still starts with `--worker`.
  4. `the_sudo_runner_scrubs_before_elevating` — assert the patch is applied and that argv is unchanged (`sudo_argv.rs`'s existing tests must keep passing).
- [ ] Run `cargo test -- mcp worker sudo`. Did they fail (not "0 tests")? Investigate any that passed early.
- [ ] Implement the three seams and the three applies.
- [ ] Run `cargo test` — green, including `tests/worker_smoke.rs`, `tests/worker_stdin.rs`, `tests/worker_e2e.rs`, `tests/worker_stderr.rs` (these spawn the real Worker binary, so a Worker-scrub regression surfaces here) and the `src/bin/fake_mcp_stdio.rs` fixtures.
- [ ] Run `cargo fmt --all`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build`.
- [ ] Commit: `fix(agent): scrub the inherited env at the MCP, Worker and sudo spawn sites`

**Acceptance criteria:**
- [ ] A user's MCP `env` entry still overrides the scrub (test 1 proves the ordering).
- [ ] The Worker spawns with the patch applied, with the risk + escape-hatch comment in place.
- [ ] `sudo` is spawned with a mount-free `LD_LIBRARY_PATH`.
- [ ] Every test asserting against the patch uses `scrub` with fabricated inputs; **none** asserts against `for_child()`.
- [ ] All Worker and MCP integration tests pass on ubuntu / windows / macos.

---

### Task 4: Stop the updater relaunch stacking a second generation of mount paths

**Context:** `src-tauri/src/commands/update.rs:442` is `pub fn relaunch_app(app: AppHandle) { app.restart() }`. In `tauri` 2.12.2 that reaches `app.rs:606` → `crate::process::restart(&self.env())`, and `tauri-2.12.2/src/process.rs:74-89` is `Command::new(path).args(env.args_os.iter().skip(1)).spawn(); exit(0)` — **no `env_clear`, no `env_remove`**. Worse, `process.rs:48-56` makes `current_binary()` return `$APPIMAGE` on Linux, so the spawn target is **the `.appimage` file**, which re-enters `runtime → AppRun → AppRun.wrapped`, and the `AppRun` **prepends** its mount paths onto the env it already inherited. Net: **N restarts ⇒ N+1 stacked mount prefixes.** This machine is at generation 2 now — `APPDIR` names `.mount_archimgAAJCI` while `OWD` names the older `.mount_archimPfJcAP`, `/proc/mounts` lists two live FUSE mounts, and 10 of 25 `PATH` entries sit under the older one. Tasks 1–3 make that stacking harmless *to children*; this task stops the parent's env growing at all. It must stay a no-op for `.deb`/`.rpm`/dev builds.

**⚠ The teardown trap, which decides this task's shape.** Do not assume `cleanup_before_exit()` reproduces what `app.restart()` does. `relaunch_app` is a **blocking** command, so `tauri-macros-2.7.2/src/command/wrapper.rs:421-426` (`body_blocking`) runs it inline in the IPC handler, spawned by `crate::async_runtime::spawn` (`tauri-2.12.2/src/ipc/mod.rs:329`,`:375`) — **not** the main thread. So `AppHandle::restart()` takes the `else` branch (`app.rs:611-627`): it sets `manager.restart_on_exit` and requests exit, and the real restart happens in `App::run`'s `RuntimeRunEvent::Exit` arm (`app.rs:1448-1454`), which runs **`callback(...)` first and `cleanup_before_exit()` after**. And `cleanup_before_exit()` (`app.rs:1128-1140`) only clears the tray icons and the resource tables. Two teardown hooks therefore ride `RunEvent::Exit` and would be **silently skipped** by a naive own-spawn:

- `tauri-plugin-window-state` 2.4.0's `RunEvent::Exit` handler (`…/src/lib.rs:503`) → the window geometry save. The plugin is registered at `src/lib.rs:280`.
- **This app's own** `RunEvent::Exit` hook at `src/lib.rs:378-389` — `wm.reap_all()`, the graceful Worker close (+ grace + `kill`, driven by a fresh current-thread runtime because the Exit callback is not in a tokio context). Skipping it means Workers are killed instead of reaped on every AppImage update-restart.

**Files:**
- Modify: `src-tauri/src/commands/update.rs` — `relaunch_app` (`:442`) plus the two pure resolvers; add `use tauri::Manager;` (the file currently imports only `tauri::AppHandle` at `:34`, and `env()` is a `Manager` default method at `tauri-2.12.2/src/lib.rs:782`; `restart()` and `cleanup_before_exit()` are **inherent** methods via `shared_app_impl!` at `app.rs:1251` and need no import)
- Test: inline `mod tests` in `src-tauri/src/commands/update.rs` (starts `:447`)

**What to implement:**

1. A **pure, total** path/argv resolver:
   ```rust
   /// What to exec to restart into the current build, and with which args.
   /// `appimage`: `Manager::env().appimage` (Linux-only `Option<OsString>`).
   /// `exe`:      `std::env::current_exe()`.  `args`: `std::env::args_os()`.
   /// TOTAL — it runs on the relaunch path, where a panic is unrecoverable.
   pub(crate) fn restart_target(
       appimage: Option<&std::ffi::OsStr>,
       exe: &std::path::Path,
       args: &[std::ffi::OsString],
   ) -> (std::path::PathBuf, Vec<std::ffi::OsString>)
   ```
   Path: `appimage` when `Some` and non-empty, else `exe`. Args: `args.get(1..).map(<[_]>::to_vec).unwrap_or_default()` — ⚠ not `args[1..]`, which panics on an empty slice; `std::env::args_os()` always yields argv0 in production, but the resolver is pure and a test will pass `&[]`.
2. A **pure env decision that actually uses its arguments**:
   ```rust
   /// `Some(patch)` only when we are inside an AppImage (the same gate as
   /// `hostenv::scrub`) — `None` means "keep using `app.restart()`".
   pub(crate) fn relaunch_patch(
       inherited: Vec<(std::ffi::OsString, std::ffi::OsString)>,
       appdir: Option<&std::path::Path>,
       exe: &std::path::Path,
   ) -> hostenv::EnvPatch
   ```
   Implemented by calling `hostenv::scrub(inherited, appdir, exe)` **directly** — ⚠ it must NOT delegate to `hostenv::for_child()`, because `for_child()` reads the *process* env and `current_exe()`, so under `cargo test` it returns an empty patch unconditionally and the entire `Some` branch of this task would go untested. Production `relaunch_app` passes `std::env::vars_os()`, `var_os("APPDIR").as_deref()`, `current_exe()`; callers treat `patch.is_empty()` as "hand back to Tauri".
3. `relaunch_app`: compute both. If `relaunch_patch(...).is_empty()`, call `app.restart()` **unchanged** — the `.deb`/`.rpm`/dev path stays byte-identical and the doc comment's "Synchronous, and it does not return" stays true. Otherwise own the spawn **and reproduce the `RunEvent::Exit` teardown**, in this order:
   1. drive `reap_all()` exactly as `src/lib.rs:378-389` does — `handle.try_state::<Arc<WorkerManager>>()`, a fresh `tokio::runtime::Builder::new_current_thread().enable_all()`, `rt.block_on(wm.reap_all())`;
   2. `use tauri_plugin_window_state::AppHandleExt;` then `app.save_window_state(tauri_plugin_window_state::StateFlags::all())`, ignoring its `Result` with a comment (the process is exiting);
   3. `app.cleanup_before_exit()` (the resource-table/tray teardown `App::run` would have done *after* the callback, so it comes last of the three);
   4. `std::process::Command::new(path)`, `.args(args)`, `patch.apply_std(&mut cmd)`, `.spawn()`, then `std::process::exit(0)` regardless of the spawn result — mirroring `process.rs:74-89`.
   ⚠ **Log the spawn failure with the repo's own logger, NOT `log::error!`.** `log` is not a dependency of this crate (`Cargo.toml` has no `log`; `grep "log::" src/` → 0 hits) and `tauri` 2.12.2 does not re-export it, so `log::error!` is E0433 — and adding the dependency would break this task's own "`Cargo.lock` diff is empty" criterion. Use `crate::agent::debuglog::log(&format!(…))` (`src/agent/debuglog.rs:60`), the same call the sibling spawn site uses (`worker/client.rs:267`), or `eprintln!`.
4. **`cfg` handling:** `Env::appimage` and `Env::appdir` are `#[cfg(target_os = "linux")]` fields of a `#[non_exhaustive]` `#[derive(Debug, Clone)]` struct (`tauri-utils-2.10.1/src/lib.rs:270-282`). ⚠ There is no `app.cfg!` and no `Manager::cfg` — that is a parse error. Use a plain `#[cfg(target_os = "linux")]` block (or `if cfg!(target_os = "linux")` with **no receiver**) around the `env.appimage` read, and on non-Linux go straight to `app.restart()`. `#[non_exhaustive]` restricts construction/pattern-matching only, so field reads are fine; `app.env().appimage.as_deref()` on a temporary compiles. `Env` is managed during `build()` (`app.rs:2569-2570`), so `app.env()` cannot panic from a command.
5. Rewrite the doc comment. Keep the existing `-> !` / absent-`tauri-plugin-process` note, and add: why the AppImage path cannot use `app.restart()` (the target is `$APPIMAGE`, so re-entry re-prepends); that the new `AppRun` re-adds **its own single generation**, so applying the same mount-stripping patch yields exactly one generation rather than none; and that the three teardown steps above stand in for the `RunEvent::Exit` callback the owned spawn bypasses.

**Do NOT:** add a `shell:allow-*` capability or any ACL entry (this repo keeps the ACL clean — `update.rs:1-10` documents why); touch the download/install path (`:254`, `:359` — Windows exits inside `download_and_install`, correct and not env-related); change the updater endpoint, pubkey or manifest composition; float `tauri`; call `request_restart()` (`app.rs:633`) — it funnels into the same `process::restart`.

**Steps:**
- [ ] Write the failing tests:
  1. `restart_target_prefers_the_appimage_path` — `appimage: Some("…/archimedes.appimage")`, `exe: "/tmp/.mount_x/usr/bin/archimedes"` → path is the AppImage, and args are `args[1..]` (assert argv0 `/tmp/.mount_x/usr/bin/archimedes` is **dropped**).
  2. `restart_target_falls_back_to_the_exe_without_an_appimage` — `appimage: None` → path is `exe`.
  3. `an_empty_appimage_is_not_a_path` — `appimage: Some("")` → falls back to `exe`. Pin in the doc comment that this **deliberately differs** from Tauri, which would spawn `""`.
  4. `restart_target_tolerates_an_empty_arg_list` — `args: &[]` → empty args, **no panic**. Pins totality.
  5. `relaunch_hands_back_to_tauri_outside_an_appimage` — `appdir: None`, and `exe` outside `appdir`, and `appdir: Some("")` → `is_empty()` in all three. This is the guarantee that a `.deb` install's restart is byte-identical. ⚠ Fabricated `inherited` + a fabricated exe — never `for_child()`.
  6. `relaunch_strips_the_stale_generation` — synthetic `inherited` carrying **two** generations plus `appdir`/exe naming one → assert the patch removes/strips both generations, so the relaunched app starts at exactly one.
- [ ] Run `cargo test -- update` from `src-tauri/`. Did all 6 fail (not "0 tests")? Investigate any that passed early.
- [ ] Implement `restart_target`, `relaunch_patch` and the new `relaunch_app` (with the three teardown steps and `debuglog`, not `log`).
- [ ] Run `cargo test -- update`, then the full `cargo test`.
- [ ] Run `cargo fmt --all`, `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build`.
- [ ] **Field verification — the plan's one manual step, and it also discharges Task 3's Worker judgement call.** Build the AppImage, install it, then **update-and-restart through the real updater path** (so the relaunch is exercised), and in a Session run:
  - `bash` → `node --version` and `git --version` — versions on stdout, **nothing** on stderr.
  - `bash` → `printf '%s' "$LD_LIBRARY_PATH"` — no `.mount_` substring.
  - `bash` → `printf '%s' "$PATH" | tr ':' '\n' | grep -c '/tmp/.mount_'` — expect **`0`**.
  - **Single-generation check, on the relaunched parent:** `tr '\0' '\n' < /proc/<ppid>/environ | grep -o '/tmp/\.mount_[A-Za-z0-9]*' | sort -u | wc -l` — expect **`1`**. ⚠ Do NOT use `grep -c '.mount_'`: it counts **lines**, and a correctly-scrubbed parent still legitimately carries `APPDIR`, `APPIMAGE`, `OWD` plus one generation of tainted vars (≈15 lines, and 19 lines across only 2 dirs on this host today) — the naive form reads as failure even on success.
  - **Teardown check:** after the restart, confirm the window re-opened at its previous geometry (window-state save ran) and that no orphan `archimedes --worker` process survives (`pgrep -af -- '--worker'`) — `reap_all()` ran.
  - Open a Session with a stdio MCP server configured and confirm it reaches `ready`, then confirm the server's own env is mount-free (`cat /proc/<server-pid>/environ | tr '\0' '\n' | grep -c mount_` → 0).
  Record the outputs in the PR description. If the Worker misbehaves after Task 3's scrub (manifests as a Worker that will not start or an IPC frame that never lands — check the `ARCHIMEDES_DEBUG` log), remove the `client.rs` call only, record it in `docs/research/appimage-child-process-env-leak.md` as the confirmed constraint, and re-run this list.
- [ ] Commit: `fix(update): the AppImage relaunch stops stacking mount paths`

**Acceptance criteria:**
- [ ] Outside an AppImage (and for `APPDIR` unset/empty/`/`), `relaunch_app` calls `app.restart()` exactly as before.
- [ ] Inside an AppImage the relaunched process references exactly one mount generation.
- [ ] The owned path reproduces **all three** teardown steps — `reap_all()`, `save_window_state`, `cleanup_before_exit` — with a comment naming the `RunEvent::Exit` callback it bypasses, and the doc comment no longer claims `cleanup_before_exit()` is the whole teardown.
- [ ] No `log` dependency added; `git diff main -- src-tauri/Cargo.lock` is **empty**; no new capability/ACL entries.
- [ ] The field-verification checklist, including both `grep` counts and the orphan-Worker check, is recorded on the PR.

---

## Follow-ups this plan deliberately does not take

Record these so they are not re-discovered (two of them correct claims made in earlier drafts of this doc):

1. **The AppImage ships the test fixtures `fake_worker` and `fake_mcp_stdio` into `usr/bin/`** (linuxdeploy's binary scan of the build output), and the prepended `PATH` put them ahead of the user's binaries — a name-collision vector. Tasks 1–3 fix it *for children*; fixing it for the bundle means excluding `src/bin/*`.
2. **`exec_find`/`exec_grep` run with the mount as their cwd.** They pass no `current_dir`, and `AppRun.c` does `chdir("$APPDIR/usr")`, so `fd`/`rg` execute inside the mount. Task 2 fixes their env; the cwd half is separate. (Correction: `--max-results` **is** a real `fd` flag — `src/cli.rs` declares `max_results` with `hide_short_help = true`, which is why `fd -h` omits it. The fast path genuinely runs; there is no bug there.)
3. **`src/open.rs:213`** reaches `xdg-open` through `tauri_plugin_opener`/`open-5.4.4`, which inherits the poisoned env and is out of reach of this repo's `Command`s. The upstream attempt at part of it ([plugins-workspace PR#2103](https://github.com/tauri-apps/plugins-workspace/pull/2103)) is still unmerged at HEAD.
4. **File the upstream report.** The two-`.mount_*`-generations-in-one-variable mechanism is reproduced here and matched to `tauri-2.12.2/src/process.rs`, but **no public report of it exists**; the closest prior art is the nested-build-scripts `unset APPDIR APPIMAGE` idiom (Audacity CI) and the leaked-mount reports that never discuss the env.
