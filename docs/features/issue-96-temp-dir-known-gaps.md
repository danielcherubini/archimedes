---
status: live
last-verified: 2026-10-29
verified-by: sections 1–10 re-read against this tree at `00676d5` plus **the first CI run of PR #99**
  (real ubuntu/macOS/windows legs, logs read in full), plus measurements on this box (temp-dir counts,
  `--self-test`, five sabotages of the census script, drop-order probes, `wine --version`). Gaps 9
  and 10 are what that CI run *found*; the rest were re-confirmed still open rather than copied.
  **Section 9a added 2026-10-29** from `main`'s CI run `40875258489` (job `123452317398`, log read)
  plus four measurements on this tree at `6f501ab`, all four re-run at `02a6de9` and unchanged (grep for the minter, the tolerance table's single
  row, the dot-free name against the Darwin shape rule, the unattributed-vs-tolerated code path) and
  the `.test.sh` case-18c citation. **Not verified:** what actually mints `betaenrollmentagent` — no
  source for it was found, and the section says so rather than guessing.
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

## 9. macOS's census is now known-working, and known-noisy

The first CI run (PR #99) settled most of what this gap used to speculate about, so
it is rewritten rather than left as a prediction:

- **Base resolution works.** The snapshot resolved
  `/private/var/folders/…/T`, `TMPDIR` was honoured, the `/var → /private/var`
  spelling was absorbed by canonicalisation on both sides, and
  `test_support::the_census_base_is_the_temp_dir_the_suite_actually_uses` **passed on
  both non-Windows legs**. The `$GITHUB_ENV` handoff works too — the variable is
  present in the `cargo test` step's env, so the premise test takes its active arm,
  not the inert "unset means a local run" one. Do not gate the macOS leg off; it was
  proven on its first run.
- **But macOS's per-user `TMPDIR` is not quiescent.** That first run reddened on
  **19 directories, all `com.apple.*` system daemons, zero Archimedes minters** —
  `mapssyncd`, `privatecloudcomputed`, the `remotemanagement` subscribers and so on,
  written by the OS during a ~90s suite. Linux does not have this problem: Ubuntu's
  fresh-runner `/tmp` snapshotted 13 directories and verified clean.
- The fix is a **Darwin-only shape rule**: a candidate whose name contains a dot,
  or contains no dash, is not counted, and the count is always announced
  (`excluded: N shape-mismatched dir(s) …`) so the exclusion is never silent. It is
  a shape, not a name list — deliberately **not** `com.apple.*`, which would need
  widening every time a daemon appears. It rests on an invariant that is now
  **pinned by a test** (`.test.sh` cases 18c and 18c(2)): no Archimedes minter
  prefix contains a dot, and none is dash-free. If someone mints a dotted or
  dash-free prefix, a test reddens instead of the leak becoming invisible.
- **The remaining macOS unknown**: the exclusion is exercised in CI only by
  injected-platform cases (`ARCHIMEDES_CENSUS_UNAME_S`), never by a real Darwin
  `uname -s` on this box, because no macOS is available locally. The `getconf
  DARWIN_USER_TEMP_DIR` spelling in `resolve_base` is now corroborated by the
  snapshot's own output, but the `TMPDIR`-unset path that reaches it has not run.

### 9a. A dot-free macOS name defeats the shape rule — `betaenrollmentagent`

**Live on `main`, unfixed, and it will red a macOS job again.** Observed on
`main`'s own history at `2f5f896` (PR #121): CI run `40875258489`, job
`123452317398`, `macos-latest` failed the census step with

> `error: the Rust test suite left 1 new directories …` / `betaenrollmentagent ← <UNATTRIBUTED: no known minter matches this prefix …>`

and the sibling `macos-latest` job of a later SHA ran the same step green. So it
is **intermittent on `main`**, not introduced by any branch, and it is **not** one
of the two `AGENTS.md` frontend flakers.

Measured on this tree, all four claims checked rather than inferred:

- `grep -ri betaenrollment src-tauri/src src-tauri/tests src scripts` → **empty**.
  This repo does not mint it, so the `UNATTRIBUTED` line is correct: the guard is
  doing its job by refusing to guess a minter.
- It is **not** in the tolerance table, which holds exactly one row
  (`harness-subagent-	1`).
- **It contains no dot**, so section 9's Darwin shape rule **cannot exclude it**.
  That rule's safety rests on "no Archimedes minter prefix contains a dot" — an
  invariant that keeps the exclusion from hiding our own leaks. It says nothing
  about a *system* name that happens to be dot-free, and this is one. The shape
  rule is therefore narrower than "excludes macOS noise": it excludes reverse-DNS
  shaped noise.
- An unattributed name **hard-fails regardless of budget** — tolerance is looked up
  by prefix row, and a name with no row never reaches the tolerated path.

**What it is, is not established here.** The name reads like an Apple beta-program
enrollment agent, and it appeared in the same per-user `TMPDIR` that produced 19
`com.apple.*` dirs in the first macOS run, but nothing in this repo mints it and I
did not find a source for it — do not record a minter you have not read.

**Do not fix this by widening the tolerance table.** Section 3's rule is that
tolerances are earned by measurement of *our* leak, and a row here would let a real
`betaenrollmentagent*` leak hide behind a system daemon forever — the exact failure
the allow-list argument in the script's header refuses. The two honest options, if
it starts costing rounds: (a) extend the Darwin exclusion to a second *shape* that
still cannot match an Archimedes prefix, and re-pin the no-dot invariant test
(`.test.sh` case 18c) to cover the new shape too; or (b) snapshot the base
immediately before `cargo test` rather than at job start, shrinking the window a
daemon can write into. **(b) is already implemented** — the ci.yml step is literally
`Snapshot the temp dir before cargo test` and sits directly above the `cargo test`
steps — so there is no window left to shrink: ~100% of the exposure is the suite's
own runtime, which the delta must straddle by design, and **(a) is the only live
option**. (a) trades guard precision for green CI and needs a reviewer; (b) costs
nothing in precision because it is already in place. The exclusion is Darwin-only: a
dotted or dash-free dir on Linux is STILL a leak (`.test.sh` case 17). Do not weaken
that. **Owner: roadmap task A1 — the shape change is the fix, not a future option.**
The shape and the re-pinned invariant live in `scripts/check-temp-dir-census.sh` /
`.test.sh` (case 18c plus the no-dash twin 18c(2), the positive case 18d, and the
teeth case 19).

The second recorded occurrence is the PR #140 writeup
(`docs/research/windows-child-console-window.md`): the macOS job failed at step 17,
the temp-dir census, on an unattributed `betaenrollmentagent` directory, while
`cargo test` passed on that same run (1602 passed), and the sibling macOS run of the
identical SHA passed the same step. The exclusion count moved between the first
(§9a above) and this occurrence — 3 dotted-name dirs on the first run, 5 on this one
— **as reported by issue #139; the 3→5 figures are issue-provided and have not been
re-measured in this repo** (the run ids are not present in the tree, no macOS and no
run logs exist here, and `excluded: 5` appears in no artifact this doc can cite). A
doc correction must not launder an issue's numbers into a measured record.

## 10. `ScratchDir::drop` cannot tell you it failed — and on Windows nothing else can either

`ScratchDir::drop` is `let _ = std::fs::remove_dir_all(&self.path);`. On Linux a
failed removal is rare; on Windows it is the *expected* consequence of a wrong drop
order (removing a directory containing an open handle is refused), and the `let _ =`
swallows it. So the in-process guard is **silent about the exact failure Windows is
most likely to hit**, and the census — the thing that would catch it — is gated off
on Windows (gap 2). Nothing currently detects a Windows leak.

This is not theoretical. PR #99's first Windows run failed
`tests/storage.rs::a_panicking_assertion_still_removes_the_temp_db_scratch`, which is
one of the few places that asserts the removal *happened* and so is the only Windows
evidence of the leak class. The cause was the D19 trap in gap 1: the test bound
`let (_db, _path, _dir) = (db, path, dir);`, and **tuple-pattern bindings drop in
reverse order**, so the guard went *first* and the removal ran while the SQLite
handle was open. Linux passed it anyway. The fix binds a tuple **value**
(`let _fixture = (db, path, dir);`), which drops left-to-right.

Two things worth keeping from that:

- **A test that passes on Linux is not evidence about drop order.** Every guard
  placement in this codebase is verified by reading, and the panic-path tests are the
  only executable part of that — which is why they bind tuple *values* and say so in
  comments. `tests/harness_store.rs` got it right first time and documents why;
  `tests/storage.rs` did not and cost a CI round-trip.
- A plausible improvement is to make `Drop` **report** rather than swallow (write a
  note somewhere the census can see, or `eprintln!`). It was deliberately not done
  here: `Drop` cannot fail, panicking in `Drop` during an unwind aborts, and printing
  from a guard would spam the harness output for a case Linux does not care about.
  If someone picks it up, the constraint is that it must not turn a passing test into
  a failing one on the platform where removals legitimately race.

