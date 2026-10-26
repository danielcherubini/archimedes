---
status: live
last-verified: 2026-10-26
verified-by: read against this tree at `7471728`, plus measurements taken on this box (temp-dir
  counts, `--self-test`, three sabotages of the census script, `wine --version`) — every gap below
  re-confirmed still open, not copied from the plans that recorded them
---

# Temp-dir hygiene — known gaps

Read this before concluding that a scratch directory, a temp-dir leak, or a
Windows drop-order question is handled. The nine-task run that closed
[#96](https://github.com/danielcherubini/archimedes/issues/96) left the suite
leaking **0 directories** per run (from 431) and added a CI census to keep it
there — see `docs/decisions/0078-test-scratch-dirs-are-owned-and-a-census-guards-them.md`.
What follows is what that run deliberately did **not** fix, and the handful of
mechanisms that can make a fix here look successful while doing nothing.

## 1. Drop order has two opposite spellings — the easiest way to break this "fix" silently

`ScratchDir` cleans up in `Drop`. Where you put it therefore decides whether the
directory is removed after the handles inside it close, and **the rule is
inverted between two syntactic forms**:

- **locals and destructured tuples** drop in **reverse** declaration order → the
  guard goes **first**.
- **struct fields** drop in **declaration** order → the guard goes **last**.

One spelling applied everywhere is wrong half the time. In `tests/harness_store.rs`
the tuple is destructured (`let (dir, db) = …` → guard first); in `E2e`, `TestDirs`
and `Harness` the guard is a trailing **field**. Getting it backwards is **invisible
on Linux** — POSIX unlinks happily while a handle is open — and fails on Windows,
where removing a directory containing an open file is refused and `Drop`'s `let _ =`
swallows the error. The ordering is enforced by reading; no test here can see it.

Two related traps, both found during the run rather than theorised:

- **Canonicalising into the guard's own name consumes it.** `let dir =
  dir.canonicalize().unwrap();` shadows the guard with a `PathBuf`, so its `Drop`
  never runs, the leak survives and **every test stays green**. `agent/fs_backend.rs`
  did exactly this. Bind the canonicalised path to a separate name and return the
  guard alongside it. Proven by sabotage: the shadowing form kept all tests passing
  while the census went non-zero.
- **A guard dropped at the end of a statement makes a test pass for the wrong
  reason.** `let root = temp_cwd("x").to_path_buf();` removes the directory before
  the next line runs — so a test asserting the catalog is empty passes because the
  root was **deleted**, not because the catalog was empty. A vacuous green.

## 2. Windows is the riskiest platform and has no census

`scripts/check-temp-dir-census.sh` **refuses** any platform it cannot resolve, so
the CI bracket is gated `runner.os != 'windows'`. Rust resolves the Windows temp dir
with `GetTempPath2W` over `TMP`/`TEMP` — not `TMPDIR` — and the MSYS↔Win32 path
translation was not verifiable from the Linux box that wrote the script.

This matters because **Windows is where a wrong drop order leaks permanently**
(gap 1), while Linux hides the same mistake. Windows' only remaining leak guards are
the `childproc` census invariant and the `--all-targets` compile gate. Closing this
needs a Windows `resolve_base` arm (`cygpath -u "$TMP"`) and running
`bash scripts/check-temp-dir-census.sh --self-test` on a Windows runner, watching it
report a planted leak.

Related, and worth correcting where it is written: `AGENTS.md` says *"there is no
wine here"*. **This box has wine 11.0 (Staging) at `/usr/bin/wine`**, and the
`x86_64-pc-windows-gnu` target is installed. So a local Windows run is
**not-yet-performed, not impossible** — no suite run under wine has been done or
shown to work here, so do not treat wine as a verified Windows proof either. The
sentence in `AGENTS.md` is a factual error about the machine, not a convention.

## 3. One prefix is tolerated because it is genuinely nondeterministic

`harness-subagent-` may leave **1** directory per run. Cause: the builder in
`tests/harness_subagent_dispatch.rs` ends with `drop(task)`, which **detaches** the
`loop_.run()` task rather than killing it. That task holds an `Arc<Db>` whose SQLite
file lives inside the guarded directory, so after the guard unlinks the file the task
can re-create it and the `rmdir` fails, leaving an **empty** directory.

Measured at 1 directory in ~4 runs (0.125/run over 8 scoped runs) against 2/run
before the guard. The real fix is aborting and awaiting the loop task, which changes
what those two tests pin, so it was recorded instead. **A strict-zero guard on this
prefix flakes about one run in four.** Raise the budget only with a re-measured rate
in the commit message; there is deliberately no `--tolerate` flag, so widening is
always a diff a reviewer sees.

`sessions-log-test-` has the **same mechanism** — `debuglog::log` takes no env lock
and `append_to` opens with `create_dir_all`, so a late writer can re-create the
directory after the guard removes it — but measured **0 in 16 sibling-inclusive runs
plus both whole-suite brackets**, so it was refused a tolerance. Tolerances are
earned by measurement, not granted by mechanism, and a tolerance granted on a
mechanism would silently absorb a real future leak of the same name. If it ever
reds: **1 empty directory** is the race; **a directory containing a file** is a real
leak, keep it red and fix the test.

The residual this whole section describes is worth stating plainly: converting a
cleanup to a guard changes the hazard from *leaks on every run* to *possibly leaks
on a failing run*, because a failing assertion skips the reap that used to precede
the manual removal. It does not eliminate the hazard.

## 4. Two `tmp.*` files per run cannot be owned by anything

`agent/tools/sandbox.rs`'s Landlock positive control runs `TMPDIR=/tmp mktemp` inside
a **confined shell**, to prove a confined command can still do ordinary things. Those
two files are the residue. No `ScratchDir` can own a confined child's file, and
redirecting `mktemp` would change what that control pins — so the census counts
`-type d` only. Verified by running just `agent::tools::sandbox`: exactly +2 files,
0 directories.

**Consequence: the census measures directories, and `104 entries` is not the same
claim as `102 directories`.** Any future measurement here must say which.

## 5. The frontend's leak is real, unfixed, and not reachable from config

`pnpm test` leaves ~1 directory per run in the temp dir. This was investigated and
**the premise of the proposed fix was falsified**: `cacheDir` does not control these
artifacts.

- Vitest **hardcodes** its project temp dir — `join(tmpdir(), nanoid())` — producing
  exactly the observed 21-character names. There is **no `tmpDir` key** in its config
  surface.
- The files inside are written by the `forks` pool, which is the default.
- The unbounded part is the **directory count** (many are emptied shells — files
  gone, wrapper directories left), which is what exhausts an entry quota.

Deliberately not done: switching `pool` (e.g. to `vmThreads`) would stop the copies
but change test-isolation semantics — a behaviour change nobody asked for. Left as an
upstream-Vitest follow-up. **The CI census brackets `cargo test` only and must stay
that way**: widening it to cover `pnpm test` would redden the Rust gate for a reason
that is not Rust's.

## 6. The census is a floor, not a proof

It looks at depth 1 of the temp dir. Anything nested is invisible to it:
`agent/crashlog.rs` nests a bare-UUID directory **one level below** its guarded
directory, and every guarded directory contains a `t.db` / `archimedes.db` /
`supervisor.log`. The guard owns the whole subtree, but no criterion here can detect
a failure to remove those nested paths. A green census means "nothing new at depth
1", not "nothing left behind".

## 7. The historical pile is still there, on purpose

This box holds ~25,600 directories in `/tmp` and ~2,160 in `$TMPDIR`, the great
majority minted by runs before this fix. **Nothing sweeps them.** Deleting by age and
pattern is exactly the `systemd-tmpfiles` mistake #96 rejected — its dry run proposed
deleting 151 live source files inside scratch git clones sitting in the temp dir.
The delta-based census is immune to the pile, so there is no automated reason to
clean it. If you clean it, do it by exact name, and know that scratch git clones and
other programs' live files live in the same directory.

## 8. Counting mints: three grep shapes that lie

Every number in this area was wrong at least once through one of these. Measure the
**delta**, and if you must grep, grep the **call form**.

- **A helper's definition counts as a call.** `grep -c 'temp_dir()'` returns 6 for a
  file with a 4-call helper: the `fn temp_dir()` line plus its own inner
  `std::env::temp_dir()`. Grep `= temp_dir();`. Same trap on `scratch()` (24 calls,
  25 hits) and `temp_root()`.
- **A call site is not a mint.** `commands/agents.rs` has 16 `scratch()` call sites
  and mints **22** per run, because one test loops a 4-case table minting twice
  inside. `agent/launch.rs` mints 68, not the 38 a site count implies.
- **A test-name filter is not a module filter.** `--lib agents` matches 63 tests
  across several modules; `agents::tests` is a substring of `commands::agents::tests`;
  `agent::normalize::tests` matches **0 tests and reports success** (that file names
  its modules `normalize_tests` / `compute_display_rows_tests`); and anything under
  `pub mod r#loop` needs the `r#loop` spelling. A filter matching nothing exits 0.
  Use `cargo test … -- --list` for counts, never `grep -c '#[test]'` — that misses
  `#[tokio::test(start_paused = true)]`.

## 9. The macOS census leg is unverified

The census runs on the macOS CI leg and is expected to work — the runner sets a
per-user `TMPDIR`, Rust honours `TMPDIR` first, and the `/var → /private/var` spelling
difference is absorbed by canonicalisation on both sides. But it was written on Linux
and never run on macOS. `test_support::the_census_base_is_the_temp_dir_the_suite_actually_uses`
is what converts that from expectation into CI-observed fact on the first push; if
that test fails on macOS, the census is not measuring what the suite writes, and the
bracket should be gated off until `resolve_base`'s `getconf DARWIN_USER_TEMP_DIR`
spelling is confirmed.
