#!/usr/bin/env bash
# Tests for scripts/check-temp-dir-census.sh.
#
# That script is the LOCK on #96: a green `cargo test` must leave zero new
# directories in the temp dir the suite actually writes into, and the guard is
# the only thing standing between this branch's 0-dirs state and the next person
# who writes `temp_dir().join(..)` without a `ScratchDir`.
#
# A green guard proves nothing on its own, so these fixtures are the shapes that
# decide whether the guard CAN fail:
#   - a new directory must be reported by name (case 1 — the teeth),
#   - a new regular FILE must NOT be (case 2 — `sandbox.rs`'s confined
#     `TMPDIR=/tmp mktemp` leaves two per run and no guard can own them, so a
#     guard that counts entries is permanently red and therefore unread),
#   - the tolerated prefix must never be able to mask a strict leak (case 7),
#   - a broken guard must exit 2, not 0 (cases 8–10: "a failed search is not an
#     empty one", lifted from check-test-data-dir.sh),
#   - and the verdict must come from grep's OUTPUT, never its exit status
#     (cases 14–15), because `grep -Fxv -f` exits 1 on the CLEAN case and 0 on
#     the LEAK case — the exact inverse of what `set -e` assumes, so a bare
#     `grep` as the step's status reddens a clean run and greens a leak.
#
# Every fixture uses `--base "$tmp_root/…"` so no case touches the machine's real
# temp dir — except case 13, which runs `--self-test` and asserts it leaves the
# real base's entry count unchanged.
#
# Plain bash, not vitest: same bar as the other scripts/*.test.sh in CI.
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check_script="$test_dir/check-temp-dir-census.sh"

# Fail loudly rather than letting every case die with 126: a missing script
# under test is a different bug from a wrong exit code, and it is the first
# thing a TDD run needs to be told. THIS is the RED of #96 task 09.
if [[ ! -f "$check_script" ]]; then
  echo "FATAL: $check_script does not exist — implement it before running these tests." >&2
  exit 1
fi

failures=0

# One temp root for the whole run, removed on EXIT. Deliberately a plain
# variable and not a list appended to inside a function: `roots+=("$(mktemp -d)")`
# records into the command substitution's subshell only, so the trap would clean
# nothing and leave a directory behind per case.
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

# Runs the script under test, capturing exit status and merged output. The
# `|| status=$?` is what keeps `set -e` from aborting the driver on the exits
# this test is asserting.
run_check() {
  status=0
  output="$("$check_script" "$@" 2>&1)" || status=$?
}

# The same, with a controlled environment (the platform-refusal case needs an
# UNSET `TMPDIR` plus an injected `uname`, and nothing else about the call).
run_check_env() {
  local env_spec="$1"
  shift
  status=0
  # shellcheck disable=SC2086
  output="$(env $env_spec "$check_script" "$@" 2>&1)" || status=$?
}

assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    echo "       output:   $output"
    failures=$((failures + 1))
  fi
}

assert_nonzero() {
  local what="$1" actual="$2"
  if [[ "$actual" != "0" ]]; then
    echo "ok   $what (exit $actual)"
  else
    echo "FAIL $what"
    echo "       expected a non-zero exit"
    echo "       actual:   0"
    echo "       output:   $output"
    failures=$((failures + 1))
  fi
}

assert_contains() {
  local what="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected to contain: $needle"
    echo "       actual output:       $haystack"
    failures=$((failures + 1))
  fi
}

assert_not_contains() {
  local what="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected NOT to contain: $needle"
    echo "       actual output:           $haystack"
    failures=$((failures + 1))
  fi
}

# Every case that needs a census gets its own fixture base + state file OUTSIDE
# that base (T1: `mktemp -d` with no `-p` writes into `$TMPDIR`, which IS the
# census base, so the guard's own bookkeeping would be reported as its own leak).
fixture() {
  local name="$1"
  base="$tmp_root/$name-base"
  state="$tmp_root/$name-state.txt"
  mkdir -p "$base"
}

count_entries() {
  find "$1" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
# 1. THE TEETH: a new directory in the base is a failure, and the message names
#    it. The direct analogue of check-test-data-dir.test.sh's case 1 ("the PATH
#    has to be in the output") — a failure that does not say which directory is
#    a failure nobody can act on.
fixture teeth
run_check snapshot --state "$state" --base "$base"
assert_eq "snapshot of a clean base exits 0" "0" "$status"
mkdir -p "$base/leaked-run-0000aa"
run_check verify --state "$state" --base "$base"
assert_nonzero "a new directory in the base is a failure" "$status"
assert_contains "the failure names the leaked directory" "leaked-run-0000aa" "$output"

# 2. A new regular FILE is NOT a failure. Two `tmp.*` files per run come from
#    `TMPDIR=/tmp mktemp` inside `sandbox.rs`'s confined Landlock positive
#    control — a confined child's file, unguardable, and redirecting it would
#    change what that test pins. A guard that counted entries would therefore be
#    permanently red, and a permanently red guard is a guard nobody reads.
fixture files
run_check snapshot --state "$state" --base "$base"
: >"$base/tmp.AAAAAA"
: >"$base/tmp.BBBBBB"
run_check verify --state "$state" --base "$base"
assert_eq "two new regular files are not a leak (-type d only)" "0" "$status"

# 3. ATTRIBUTION, both directions of the superset trap. `harness-loop-*` is a
#    superset of task 03's `harness-loop-test-*` family; under longest-prefix-
#    wins the two attribute to DIFFERENT files with no `! -name` exclusion. A
#    table sorted as-typed or shortest-first fails one of these two assertions,
#    and a wrong attribution sends the reader to the wrong file.
fixture attribution
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/harness-loop-test-1f2e3a4b"
run_check verify --state "$state" --base "$base"
assert_contains "harness-loop-test-* blames the loop test support file" \
  "src-tauri/src/agent/harness/loop/tests/support.rs" "$output"

fixture attribution2
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/harness-loop-99887766"
run_check verify --state "$state" --base "$base"
assert_contains "harness-loop-* (no -test-) blames the integration test" \
  "src-tauri/tests/harness_loop.rs" "$output"

# 4. An UNKNOWN prefix is the case the whole design exists for: a delta is never
#    blind to a prefix nobody has thought of, and it must be reported as NEW
#    rather than blamed on a guessed file. Asserting the output names NO file for
#    it is what makes "an allow-list is blind to new prefixes" executable.
fixture unknown
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/mystery-new-thing-01a2b3c4"
run_check verify --state "$state" --base "$base"
assert_nonzero "an unknown prefix fails the census" "$status"
assert_contains "an unknown prefix is marked UNATTRIBUTED" "UNATTRIBUTED" "$output"
assert_contains "and the message says NEW is the point" "it is NEW" "$output"
assert_not_contains "and no file is blamed for it" "src-tauri/src/agent/harness/loop/tests/support.rs" "$output"

# 5. TOLERATED WITHIN BUDGET: `harness-subagent-` leaks ~1 dir per 4 runs
#    (D19b: `drop(task)` detaches a loop task holding an `Arc<Db>` that
#    re-creates the SQLite file after the guard unlinks it). A strict-zero guard
#    flakes ~1 run in 4, so ONE within budget exits 0 — and says so.
fixture tolerated
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/harness-subagent-db-a1b2c3d4"
run_check verify --state "$state" --base "$base"
assert_eq "one tolerated dir within budget exits 0" "0" "$status"
assert_contains "and the tolerated line is printed" "tolerated" "$output"

# 6. TOLERATED OVER BUDGET (two): the budget is COUNTED, not advisory, or the
#    tolerance silently becomes "any number of this prefix is fine".
fixture overbudget
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/harness-subagent-db-a1b2c3d4" "$base/harness-subagent-db-99887766"
run_check verify --state "$state" --base "$base"
assert_nonzero "two tolerated dirs are over budget" "$status"
assert_contains "the over-budget line states the count against the budget" "OVER BUDGET" "$output"
assert_contains "and the tolerated names are printed" "harness-subagent-db-99887766" "$output"

# 7. A TOLERATED LEAK CANNOT MASK A STRICT ONE: the strict count is computed
#    from names that match NO tolerance entry, independently of the tolerated
#    count. Without this, planting one tolerated dir would be a way to hide any
#    real leak.
fixture mask
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/harness-subagent-db-a1b2c3d4" "$base/planted-leak-strict"
run_check verify --state "$state" --base "$base"
assert_nonzero "a tolerated leak does not mask a strict one" "$status"
assert_contains "the strict name is reported" "planted-leak-strict" "$output"
assert_contains "and the message says the tolerated one was not counted" "were not counted" "$output"
assert_not_contains "the tolerated dir is not itself listed as a failure" "harness-subagent-db-a1b2c3d4" "$output"

# 8. A MISSING STATE FILE exits 2, and must NOT print the clean message.
#    "A failed search is not an empty one" (check-test-data-dir.sh) — and this is
#    the shape a lost `--state` on the CI step delivers.
run_check verify --state "$tmp_root/never-written.txt" --base "$tmp_root"
assert_eq "a missing state file exits 2, not 0" "2" "$status"
assert_not_contains "and it is not reported as clean" "census clean" "$output"

# 9. BASE DRIFT exits 2 (constraint 3, executable). `snapshot` and `verify` each
#    resolve the base INDEPENDENTLY and compare, because a `verify` that trusted
#    the state file's copy would paper over exactly the mistake this box is set
#    up to make (ambient `TMPDIR=/home/daniel/.cache/tmp` while the suite ran
#    with `TMPDIR=/tmp`). Both paths must be named.
fixture drift
run_check snapshot --state "$state" --base "$base"
# Both bases must EXIST: a base that does not exist is a different exit-2
# reason, and this case is specifically about DRIFT between two walkable bases.
mkdir -p "$tmp_root/drift-other-base"
run_check verify --state "$state" --base "$tmp_root/drift-other-base"
assert_eq "a snapshot/verify base mismatch exits 2" "2" "$status"
assert_contains "naming the snapshot's base" "drift-base" "$output"
assert_contains "and the verify base" "drift-other-base" "$output"
assert_not_contains "and never as clean" "census clean" "$output"

# 9b. The same drift arriving through the ENVIRONMENT rather than a flag — the
#     exact CI mistake (`TMPDIR=/tmp` forgotten on the verify call).
fixture drift_env
run_check snapshot --state "$state" --base "$base"
mkdir -p "$tmp_root/drift-env-base"
run_check_env "TMPDIR=$tmp_root/drift-env-base" verify --state "$state"
assert_eq "forgetting TMPDIR between snapshot and verify exits 2" "2" "$status"
assert_contains "and it names the drifted base" "drift-env-base" "$output"

# 10. STATE FILE INSIDE THE CENSUS BASE exits 2 (T1). `mktemp -d` writes into
#     `$TMPDIR`, which IS the base, so a state file there is the guard reporting
#     its own bookkeeping as a leak — on every run, on every machine.
fixture state_in_base
run_check snapshot --state "$base/state.txt" --base "$base"
assert_eq "a state file inside the base is refused (T1)" "2" "$status"
assert_contains "and the refusal names the state path" "state.txt" "$output"

# 10b. The same refusal reached through a SYMLINKED SPELLING of the base. The
#      refusal compares the CANONICALISED candidate against the canonicalised
#      base; a literal prefix match on the candidate would let
#      `<link-to-base>/state.txt` through, and the guard would then report its
#      own state file as the suite's leak.
link="$tmp_root/state-link"
ln -s "$base" "$link"
run_check snapshot --state "$link/state.txt" --base "$base"
assert_eq "a state file inside the base via a symlinked spelling is refused too" "2" "$status"

# 10c. And the OTHER direction of the same canonicalisation, which a
#      over-tightened "fix" would break: `$base/../state.txt` resolves OUTSIDE the
#      base, so it must be ACCEPTED. Refusing it would reject the legitimate
#      sibling-directory call site (`--state ~/.cache/x.txt` spelled through a `..`)
#      and leave no way to run the guard at all.
run_check snapshot --state "$base/../outside-state.txt" --base "$base"
assert_eq "a state path that resolves OUTSIDE the base via .. is accepted" "0" "$status"

# 10d. Inside reached through `..` (`$base/sub/../state.txt` resolves to
#      `$base/state.txt`): refused, for the same reason as 10b.
mkdir -p "$base/sub"
run_check snapshot --state "$base/sub/../state.txt" --base "$base"
assert_eq "a state path that resolves INSIDE the base via .. is refused" "2" "$status"

# 11. USAGE ERRORS (the check-versions.sh flag-parsing contract): a lost value,
#     no command, an unknown flag, and a repeated command must all be errors —
#     never a silent "nothing was asked for".
fixture usage
run_check snapshot --state
assert_nonzero "--state with no value after it is a usage error" "$status"
assert_contains "and it says usage" "usage" "$output"
run_check snapshot --state=
assert_nonzero "--state= with an empty value is a usage error" "$status"
run_check --base "$base"
assert_nonzero "no command at all is a usage error" "$status"
assert_contains "and it prints usage" "usage" "$output"
run_check snapshot --state "$state" --nope
assert_nonzero "an unknown flag is a usage error" "$status"
run_check snapshot snapshot --state "$state" --base "$base"
assert_nonzero "a repeated command is a usage error" "$status"
run_check nonsense --state "$state" --base "$base"
assert_nonzero "an unknown command is a usage error" "$status"

# 11b. A BASE THAT IS NOT A DIRECTORY exits 2 — reporting "clean" for a base that
#      cannot be walked is the vacuous green this guard exists to avoid.
run_check snapshot --state "$tmp_root/nonexistent-base-state.txt" --base "$tmp_root/never-created"
assert_eq "a base that is not a directory exits 2" "2" "$status"

# 11c. `base` prints the resolved census base and NOTHING else (CI hands that
#      value to the Rust premise test instead of hardcoding a second literal).
mkdir -p "$tmp_root/base-printed"
run_check base --base "$tmp_root/base-printed"
assert_eq "base prints exactly the canonicalised path" "0" "$status"
assert_eq "base prints the resolved base and nothing else" "$tmp_root/base-printed" "$output"
run_check_env "TMPDIR=$tmp_root/base-printed" base
assert_eq "base honours TMPDIR the way Rust's temp_dir() does" "$tmp_root/base-printed" "$output"
run_check base --state "$tmp_root/should-not-be-created.txt"
assert_nonzero "base takes no --state" "$status"
run_check base --base "$tmp_root/base-never-created"
assert_eq "base refuses a base that does not exist (exit 2)" "2" "$status"

# 12. READ-ONLY: the census modes create NOTHING. The executable form of "the
#     script never sweeps, never touches anything it did not make" (D2 — #96
#     explicitly rejects the `systemd-tmpfiles` mistake).
fixture readonly
before_count="$(count_entries "$base")"
mkdir -p "$base/pre-existing-dir" "$base/pre-existing-dir/nested"
before_count="$(count_entries "$base")"
run_check snapshot --state "$state" --base "$base"
run_check verify --state "$state" --base "$base"
after_count="$(count_entries "$base")"
assert_eq "snapshot + verify create nothing in the base" "$before_count" "$after_count"
assert_eq "and the census of a clean base is green" "0" "$status"

# 13. `--self-test` exits 0 on a correct script AND leaves the REAL census base's
#     entry count unchanged (it must plant only in a throwaway base outside it).
real_base="$("$check_script" base)"
real_before="$(count_entries "$real_base")"
run_check --self-test
assert_eq "--self-test exits 0 on a correct script" "0" "$status"
assert_contains "--self-test reports its cases" "ok" "$output"
real_after="$(count_entries "$real_base")"
assert_eq "--self-test leaves the real census base unchanged" "$real_before" "$real_after"

# 14/15. THE VERDICT IS grep's OUTPUT, NEVER ITS EXIT CODE. `grep -Fxv -f` exits
#      1 when the two lists are IDENTICAL (the clean case) and 0 when something
#      is new (the leak case) — the inverse of what `set -e` assumes. A script
#      that lets the bare `grep` be the step's status therefore reddens a clean
#      run and greens a leak. Case 14 is the fresh-runner CI shape AND this
#      branch's own acceptance run (empty before, empty after); case 15 is the
#      leak against an empty base.
fixture grep_empty_both
run_check snapshot --state "$state" --base "$base"
run_check verify --state "$state" --base "$base"
assert_eq "empty before + empty after exits 0 (the clean shape)" "0" "$status"
assert_contains "and prints the clean message" "census clean" "$output"

fixture grep_empty_before
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/planted-one-11111111" "$base/planted-two-22222222"
run_check verify --state "$state" --base "$base"
assert_eq "empty before + non-empty after exits 1" "1" "$status"
assert_contains "naming the first entry" "planted-one-11111111" "$output"
assert_contains "and the second" "planted-two-22222222" "$output"

# 15b. THE GREP PATH WITH A NON-EMPTY BEFORE-LIST. Cases 1–12 all snapshot a base
#      that is empty or nearly so; on a fresh CI runner `/tmp` genuinely is empty,
#      but on a developer's Linux box it holds thousands of entries and the
#      `grep -Fxv -f` delta is what actually runs. A delta made blind must therefore
#      be caught with a NON-EMPTY before-list too, and only the NEW name may be
#      reported (a pre-existing one listed as a leak would be a false positive the
#      moment anyone ran this locally).
fixture grep_nonempty
mkdir -p "$base/pre-existing-dir" "$base/another-old-dir"
run_check snapshot --state "$state" --base "$base"
mkdir -p "$base/only-new-one-12345678"
run_check verify --state "$state" --base "$base"
assert_eq "non-empty before + one new dir exits 1" "1" "$status"
assert_contains "naming the new one" "only-new-one-12345678" "$output"
assert_not_contains "and NOT the pre-existing ones" "pre-existing-dir" "$output"
run_check snapshot --state "$state" --base "$base"
run_check verify --state "$state" --base "$base"
assert_eq "identical non-empty lists exit 0 (grep exits 1 there)" "0" "$status"

# 16. THE PLATFORM REFUSAL IS A TESTED PATH, not a designed one. The script
#     resolves the base the way Rust does and REFUSES any platform it cannot
#     resolve — a guessed base is a census that passes having looked at nothing.
#     `uname` is injected here so the refusal is asserted rather than assumed;
#     the message must name the reason, so a user on an unsupported box reads
#     "this platform is not supported because X" instead of a mystery exit code.
run_check_env "TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=MINGW64_NT-10.0-19041" snapshot --state "$tmp_root/refused-state.txt"
assert_eq "an unrecognised platform is refused with exit 2" "2" "$status"
assert_contains "and the refusal names the platform it refused" "MINGW64_NT-10.0-19041" "$output"
assert_contains "and says it is not supported" "not supported" "$output"

run_check_env "TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=Linux" base
assert_eq "Linux with no TMPDIR resolves to /tmp (Rust's fallback)" "/tmp" "$output"

# ---------------------------------------------------------------------------
# 17. THE DOTTED-NAME EXCLUSION IS DARWIN-SCOPED, AND THE SCOPING IS PROVEN
#     FROM THE LINUX SIDE.
#
#     On macOS the per-user `TMPDIR` (`/var/folders/…/T`) is NOT quiescent: while
#     a ~90s suite runs, system daemons (`com.apple.Maps.mapssyncd`,
#     `com.apple.AuthenticationServices.*`, `com.apple.RemoteManagementAgent`, …)
#     create directories in it. CI run 40347693926's macos-latest leg reddened on
#     19 of them and ZERO of ours — the premise test passed and the snapshot
#     resolved the right base, so the guard was counting the correct directory and
#     the suite leaked nothing there. Ubuntu's `/tmp` on a fresh runner IS
#     quiescent (that leg snapshotted 13 dirs and verified clean), so Linux keeps
#     the fully strict whole-temp-dir delta.
#
#     The exclusion is a SHAPE (`*.*` — the name contains a dot) and NOT a name
#     list; see the WHY block in `check-temp-dir-census.sh`. Every Archimedes
#     minter prefix is dot-free, so a dotted name cannot be one of ours.
#
#     THIS CASE IS THE SCOPING PROOF: on Linux a planted DOTTED directory must
#     still be reported. If the exclusion is ever widened past Darwin (a dropped
#     platform gate, a `case` that matches everything), Linux — the leg that
#     carries the real coverage — silently loses its strictness, and this is the
#     only assertion that notices.
fixture linux_dotted
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Linux" snapshot --state "$state" --base "$base"
assert_eq "Linux snapshot exits 0" "0" "$status"
mkdir -p "$base/com.apple.Maps.mapssyncd"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Linux" verify --state "$state" --base "$base"
assert_eq "on LINUX a dotted directory is still a leak (the exclusion is Darwin-only)" "1" "$status"
assert_contains "and it is named" "com.apple.Maps.mapssyncd" "$output"
assert_not_contains "and nothing is reported as excluded on Linux" "excluded:" "$output"

# 17b. THE SAME SCOPING PROOF FOR THE SECOND SHAPE. Case 17 pins that the DOTTED
#      exclusion is Darwin-only; nothing pinned the DASH-FREE exclusion the same
#      way — every Linux-injected plant in both harnesses was dotted
#      (`com.apple.Maps.mapssyncd` here and in `--self-test` Case 13), so a
#      refactor that moved `dash_free_name` outside the Darwin gate
#      (`exclusion_applies_here`) would have gone unnoticed on the Linux leg,
#      which is the leg that carries the real coverage. That is precisely the
#      regression this branch's own fix is vulnerable to: the shape that saves
#      `macos-latest` must not leak onto Linux, where a dash-free directory IS a
#      leak (a real Archimedes name always carries a dash, so nothing of ours is
#      sacrificed by keeping it strict there).
#
#      The plant is deliberately dash-free AND dot-free — `planteddashfreeleak`
#      — so the SECOND shape is the only thing that could exclude it. A dotted
#      plant here would pass under a `dotted_name`-only Linux regression and the
#      case would test the wrong shape. This is case 18d's plant, run on Linux:
#      18d proves Darwin excludes it, 17b proves Linux must not.
fixture linux_dashfree
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Linux" snapshot --state "$state" --base "$base"
assert_eq "Linux snapshot exits 0" "0" "$status"
mkdir -p "$base/planteddashfreeleak"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Linux" verify --state "$state" --base "$base"
assert_eq "on LINUX a dash-free directory is still a leak (the second shape is Darwin-only too) (case 17b)" "1" "$status"
assert_contains "and it is named" "planteddashfreeleak" "$output"
assert_not_contains "and nothing is reported as excluded on Linux" "excluded:" "$output"

# 18. THE DARWIN HALF, BOTH DIRECTIONS. A bug that excludes EVERYTHING must fail
#     here, which is why the dot-free half shares a fixture with the dotted half:
#     a dotted-only fixture stays green under a `*` rule instead of `*.*`.
fixture darwin_dotted
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" snapshot --state "$state" --base "$base"
assert_eq "Darwin snapshot exits 0" "0" "$status"
mkdir -p "$base/com.apple.Maps.mapssyncd" "$base/com.apple.SafariShared.SafariConfigurationSubscriber"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "on DARWIN daemon dirs are excluded and the run is clean" "0" "$status"
assert_contains "the clean message still appears" "census clean" "$output"
# The exclusion must be VISIBLE, never silent — a silent exclusion is the
# vacuous-green failure mode this guard exists to prevent, so the count and the
# reason are asserted, not just the exit code.
assert_contains "the exclusion is announced with its count" "excluded: 2 shape-mismatched dir(s)" "$output"
# The BASE is asserted by its own component, not in full: `--base` is
# canonicalised, so on macOS `$tmp_root` spells as `/private/var/…` here. The
# component plus the dash after it is the part that is spelling-independent.
assert_contains "and it names the base it excluded from" "$(basename "$base") — macOS" "$output"
assert_contains "and it says why (daemons share the per-user TMPDIR)" "system daemons share the per-user TMPDIR" "$output"
assert_contains "and it says why the shape is safe (no minter name has a dot)" "no Archimedes minter name contains a dot" "$output"

# 18b. THE OTHER HALF, SAME FIXTURE: a DOT-FREE leak on Darwin is still reported,
#      with the exclusion still announced. `*` instead of `*.*` passes 18 and dies
#      here.
mkdir -p "$base/planted-darwin-leak-1a2b3c4d"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "a dot-free directory on DARWIN is still a leak" "1" "$status"
assert_contains "and it is named" "planted-darwin-leak-1a2b3c4d" "$output"
assert_not_contains "the excluded daemon dir is not itself listed as a failure" "com.apple.Maps.mapssyncd" "$output"
assert_contains "and the exclusion is STILL announced on the failing path" "excluded: 2 shape-mismatched dir(s)" "$output"

# 18c. A DOTTED NAME THAT IS ALSO A KNOWN MINTER PREFIX would be an Archimedes
#      leak wearing a daemon's shape. It cannot exist today — verified against
#      this tree: no `in_env_temp`/`in_tmpfs`/`in_dir` prefix, and no historical
#      prefix on disk, contains a dot — but if a future minter broke that
#      invariant the exclusion WOULD hide it. So the invariant is asserted here,
#      which is what makes "the shape is safe" a checked claim instead of an
#      assumed one. (Re-expressed in the pipe-safe form: command substitution +
#      final lone `[[ -n ]]` negated test, no `| grep -q .` at the tail — under
#      the harness's `set -euo pipefail` a trailing `grep -q .` can SIGPIPE its
#      own upstream into a false green when a dotted literal IS present.)
if [[ -n "$(grep -rE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests 2>/dev/null)" ]]; then
  echo "FAIL no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)"
  grep -rnE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests | sed 's/^/       /'
  failures=$((failures + 1))
else
  echo "ok   no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)"
fi

# 18c(2). A MINTER PREFIX WITH NO DASH would be an Archimedes leak wearing the
#      shape `betaenrollmentagent` wears. It cannot exist today — every one of
#      the 91 distinct `in_env_temp`/`in_tmpfs`/`in_dir` prefixes in this tree
#      ends in a dash — but if a future minter ever mints a dash-free prefix,
#      the second Darwin shape would hide it. So the invariant is asserted here,
#      the no-dash twin of the no-dot invariant above: a future dash-free
#      minter reddens this check instead of quietly becoming invisible behind
#      the dash-free shape. NOTE on the pattern: a literal `[^"-]*` character
#      class does NOT encode "dash-free" (a `[^"-]*` run still allows dashes
#      outside the run, and a `[^"]*[^-]` trailing class matches any name ending
#      in a non-dash). The check is therefore "are there any extracted prefixes
#      with no dash": `grep -v -- '-'` inside a command substitution, tested by
#      a final LONE `[[ -n ]]` — no `| grep -q .` at the tail (see 18c's note:
#      under `set -euo pipefail` a trailing `grep -q .` can SIGPIPE its own
#      upstream into a false green exactly when a dash-free prefix IS present).
if [[ -n "$(grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests 2>/dev/null | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -v -- '-')" ]]; then
  echo "FAIL a minter prefix is dash-free (the Darwin second shape depends on this)"
  grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -v -- '-' | sed 's/^/       /'
  failures=$((failures + 1))
else
  echo "ok   no minter prefix is dash-free (the Darwin second shape depends on this)"
fi

# 18d. THE POSITIVE HALF OF THE SECOND SHAPE: a DOT-FREE AND DASH-FREE name on
#      Darwin is EXCLUDED and the run is clean. The daemon of issue #139
#      (`betaenrollmentagent`) has zero dots AND zero dashes, so it reaches the
#      exclusion only through the new shape — `dotted_name` alone would leave it
#      strict and red. Before this case, neither harness planted a dash-free
#      name: 18's plants are dotted, 18b's and Case 14's contain dashes. C1
#      becomes a real assertion only here, where the count says EXACTLY which
#      set was excluded.
fixture darwin_dashfree
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" snapshot --state "$state" --base "$base"
assert_eq "Darwin snapshot exits 0" "0" "$status"
mkdir -p "$base/betaenrollmentagent"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "a dot-free AND dash-free name on DARWIN is excluded and the run is clean" "0" "$status"
assert_contains "the clean message still appears" "census clean" "$output"
# The count reflects EXACTLY the excluded set: one planted dash-free dir, one
# excluded — not zero (the exclusion must fire) and not "the failure was
# silently swallowed" (exit 0 + clean already rules that out).
assert_contains "the exclusion is announced with exactly the excluded set's count" "excluded: 1 shape-mismatched dir(s)" "$output"
assert_contains "and it says why (daemons share the per-user TMPDIR)" "system daemons share the per-user TMPDIR" "$output"
assert_contains "and it says why the shapes are safe (no minter name has a dot or a dash)" "no Archimedes minter name contains a dot or a dash" "$output"
assert_not_contains "and the excluded name is never listed as a failure" "betaenrollmentagent" "$output"

# 19. THE GUARD'S TEETH — an injected dash-free literal must trip the twin's
#     FAIL branch. 18c(2) proves the REAL tree has no dash-free minter prefix;
#     this case proves the CHECK ITSELF would catch one: it greps a throwaway
#     synthetic tree that DOES contain a dash-free literal and asserts the FAIL
#     branch fires (same pipeline, same pipe-safe form — command substitution +
#     final LONE `[[ -n ]]`, no `| grep -q .`, which under `set -euo pipefail`
#     can SIGPIPE its own upstream into a false green). This case was formerly a
#     byte-identical copy of 18c(2); it now tests the pipeline's teeth instead
#     of the corpus twice.
synthetic="$tmp_root/synthetic-minter-tree"
mkdir -p "$synthetic/src" "$synthetic/tests"
printf 'ScratchDir::in_env_temp("syntheticdashfree", tag)\n' > "$synthetic/tests/synthetic.rs"
if [[ -n "$(grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' "$synthetic/src" "$synthetic/tests" 2>/dev/null | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -v -- '-')" ]]; then
  echo "ok   the dash-free check has teeth: an injected dash-free literal trips FAIL (case 19)"
else
  echo "FAIL the dash-free check did NOT catch an injected dash-free literal (case 19)"
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
