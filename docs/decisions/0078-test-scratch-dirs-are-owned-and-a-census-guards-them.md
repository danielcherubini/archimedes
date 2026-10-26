---
status: accepted
date: 2026-10-26
superseded-by:
---

# Test scratch dirs are owned, and a directory census guards them

Every Rust test that needed a throwaway directory created one with
`std::env::temp_dir().join(format!("<prefix>-{}", Uuid::new_v4()))` and removed it
with a trailing `remove_dir_all`. That shape leaks on every path except the happy
one — a failing assertion returns before the cleanup line, and ~120 of the sites
had no cleanup at all. The suite was leaving **431 new directories per run**. On a
machine whose temp dir is a size-capped tmpfs shared across projects, that exhausts
the entry quota and every later temp allocation fails — `Db::open`, `tempfile`,
`git clone` — so the symptom showed up as unrelated failures in whichever project
hit the ceiling first.

We decided two things, and the second is the one that matters:

1. **A test's scratch directory is owned by a scope-bound guard** —
   `test_support::ScratchDir`, Drop-owning, three named constructors (`in_dir`,
   `in_env_temp`, `in_tmpfs`) that take the base as an argument and never guess.
2. **Nothing in the code proves the first thing holds.** A post-run census —
   `scripts/check-temp-dir-census.sh`, bracketing the suite's `cargo test` steps in
   the same CI job — measures the **directory delta of the whole temp dir** and
   fails the build on any new directory.

Point 2 exists because point 1 is unenforceable by review. A future test can always
mint a directory the old way, and no test, lint or type can see it: the leak is the
absence of a drop, in a different function, on a path nobody runs. Eight commits
were needed to clear the existing sites and none of them was caught by a check that
already existed.

## The census measures a delta, not a list of known prefixes

An allow-list over the prefixes the suite is known to mint would be precise, cheap
and **blind to the exact bug it exists to catch**: a new leaky test invents a new
prefix, so the guard passes forever. The delta asks no question about prefixes and
so catches anything the suite creates. Prefixes survive only as an *attribution*
table in the failure message, and an unrecognised name is reported as
`<UNATTRIBUTED: … it is NEW, which is exactly what this guard is for>` — the useful
answer, not a shrug.

Three properties make the delta trustworthy rather than decorative, and each closes
a way the guard could have been silently always-green:

- **It counts directories only.** Two `tmp.*` *files* per run come from `mktemp`
  inside a confined-shell Landlock test that exists to prove a confined command can
  still do ordinary things. No guard can own a confined child's file, so counting
  entries would fail forever on two files nobody can fix — and a permanently-red
  guard is ignored within a week.
- **It proves it can fail, on every push, without running cargo.** `--self-test`
  drives the *same* snapshot/verify comparison against a throwaway base and requires
  a planted directory to be reported. A green guard demonstrates nothing; this is the
  deliverable that makes the other two worth having.
- **It refuses to compare when it cannot answer.** The base is canonicalised with
  `cd && pwd -P`, because `find` does not follow a symlinked start point and exits
  *zero* — macOS's `/tmp → /private/tmp` would census nothing and pass. And
  `snapshot`/`verify` hard-error when they resolve different directories, which is
  this repo's own hazard: the development shell exports a `TMPDIR` that is not
  `/tmp`, so a guard reading the wrong base passes having checked nothing.

## Considered Options

- **OS retention policy (`systemd-tmpfiles`).** Rejected and recorded so nobody
  redoes the afternoon: its dry run proposed deleting **151 live source files**
  inside scratch git clones sitting in the temp dir. Cleaning by age and pattern is
  unsafe on a directory other programs are actively using.
- **Pinning `TMPDIR` via cargo `[env]`, or pointing it at a disk.** Both are the
  environment-variable fix the issue's own body forbids. The `[env]` pin changes
  `temp_dir()` on macOS and is untestable from Linux; a disk-backed temp dir breaks
  the fixtures that require unsorted `readdir`, which only a tmpfs reliably gives.
- **A prefix allow-list.** Above.
- **Fixing the frontend's leak too.** Out of scope, falsified rather than skipped —
  see `docs/features/issue-96-temp-dir-known-gaps.md`.
- **Review discipline plus a note in `AGENTS.md`.** This is what the repo had, with
  a `TDD` convention and a reviewing agent, and it produced 431 leaks per run. The
  guard is cheap; the failure mode it prevents is not.

## Consequences

- A test that needs a temp directory uses `ScratchDir`. Manual
  `remove_dir_all`/`remove_file` pairs in test bodies are the pattern being
  removed, not a style choice — see the gap doc for the two spellings of Rust's
  drop order that make a hand-written cleanup wrong more often than right.
- `AGENTS.md`'s guidance to pin `TMPDIR=/tmp` for Rust test runs is a workaround for
  a hostile local environment, not the fix, and stays documented as such.
- The census is a **backstop**, not the guard. `Drop` never runs under `SIGKILL` or
  Ctrl-C, so an interrupted suite still leaks; the in-process `ScratchDir` catches
  the ordinary case and the census catches what escapes it. Neither alone is
  sufficient, and the pairing is the design.
- Windows is **not** covered — the script refuses rather than guesses. That is the
  platform where this bug is worst, and the gap is written into the CI step itself.
  Details in the gap doc.
- macOS's census is **noisy rather than wrong**: its per-user `TMPDIR` is shared with
  system daemons, which write into it during a suite run, so the delta there sees
  directories nothing in this repo created. Linux's `/tmp` on a fresh runner is
  quiescent and stays fully strict. macOS therefore excludes dotted names — a shape,
  not a name list, and always announced — resting on the fact that no minter prefix
  here contains a dot, which a test now pins. See the gap doc.
