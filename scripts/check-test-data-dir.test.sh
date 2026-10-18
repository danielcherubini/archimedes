#!/usr/bin/env bash
# Tests for scripts/check-test-data-dir.sh.
#
# That script is the leak guard for crash-log-hardening Task 7: the panic hook
# is handed its directory (Task 1), so a test panic must never reach the user's
# data dir again — and the census invariant (Task 2) is a SOURCE-level claim
# about one file, blind to a resolver reached from elsewhere and blind to what
# the suite actually does at runtime. This check is the runtime half: run the
# suite with its data dir redirected, then require zero `crash-*.log` there.
#
# The fixtures here are the shapes that check has to survive: the macOS data dir
# nests `archimedes` under `<HOME>/Library/Application Support`, so a check that
# globbed only its argument's own level would be vacuously green there, and
# `supervisor.log` legitimately shares the directory (`debuglog.rs`), so a check
# that matched every `*log` would be permanently red.
#
# Plain bash, not vitest: these are shell scripts, and green is the same bar
# `bash scripts/check-test-data-dir.test.sh` has to clear in CI.
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check_script="$test_dir/check-test-data-dir.sh"

# Fail loudly rather than letting every case die with 126: a missing script
# under test is a different bug from a wrong exit code, and it is the first
# thing a TDD run needs to be told.
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

assert_eq() {
  local what="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected: $expected"
    echo "       actual:   $actual"
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

# 1. The leak itself: one crash log in the redirected dir. The PATH has to be in
#    the output — an operator reading a failed CI step needs to know which file
#    re-opened the leak, and "some crash log exists somewhere" is not it.
root="$tmp_root/leaked"
mkdir -p "$root"
: >"$root/crash-123-worker-9.log"
run_check "$root"
assert_nonzero "a crash log in the dir is a failure" "$status"
assert_contains "the failure names the crash log" "crash-123-worker-9.log" "$output"

# 2. The legitimate neighbours of the SAME directory: `supervisor.log` and its
#    `.old` rotation are written by `debuglog.rs` into the data dir on purpose,
#    so matching them would make this guard permanently red — and a permanently
#    red guard is a guard nobody reads.
root="$tmp_root/legitimate-files"
mkdir -p "$root"
: >"$root/supervisor.log"
: >"$root/supervisor.log.old"
: >"$root/archimedes.db"
run_check "$root"
assert_eq "supervisor.log and the db are not crash logs" "0" "$status"

# 3. A directory that does not exist is "nothing ran", not a failure: the check
#    runs after a test step that may have produced no directory at all, and a
#    missing dir must not be reported as a leak.
run_check "$tmp_root/never-created"
assert_eq "a non-existent dir exits 0 (nothing ran)" "0" "$status"

# 4. THE MACOS SHAPE — the case that makes the recursion load-bearing. On macOS
#    `dirs::data_dir()` is `<HOME>/Library/Application Support`, so the app's
#    directory is `<redirected HOME>/Library/Application Support/archimedes`,
#    i.e. the crash log sits THREE levels under the redirected root. A check that
#    globbed only its argument would scan an empty level and pass having looked
#    at nothing — the vacuity this repo records at `agent/tools/exec.rs:1780-1791`.
root="$tmp_root/macos-nested"
mkdir -p "$root/Library/Application Support/archimedes"
: >"$root/Library/Application Support/archimedes/crash-1-worker-2.log"
run_check "$root"
assert_nonzero "a crash log nested under archimedes/ is found (the macOS shape)" "$status"
assert_contains "the nested finding prints its full path" "archimedes/crash-1-worker-2.log" "$output"

# 5. A name that only LOOKS like a crash log: the writer's contract is
#    `crash-<ts>-<tag>-<pid>.log`, so a `.txt` of that stem belongs to something
#    else entirely and must not fail the build.
root="$tmp_root/lookalike-name"
mkdir -p "$root"
: >"$root/crash-notes.txt"
run_check "$root"
assert_eq "a non-.log crash-named file is not a crash log" "0" "$status"

# 6. An empty directory that DOES exist (the redirected dir was created by the
#    run but nothing leaked) — the shape the green CI step actually sees on
#    Linux, where `XDG_DATA_HOME` is the dir itself rather than its parent.
root="$tmp_root/empty-dir"
mkdir -p "$root"
run_check "$root"
assert_eq "an existing empty dir exits 0" "0" "$status"

# 7. No argument at all: the check is about ONE directory the caller redirected,
#    and defaulting it to `.` would silently scan the checkout and answer a
#    question nobody asked. So the usage is an error, not a guess.
run_check
assert_nonzero "no directory argument is a usage error" "$status"
assert_contains "the usage error names the flag-less form" "usage" "$output"

# 8. An EMPTY argument — the CI call site is `"$ARCHIMEDES_TEST_DATA_DIR"`, so a
#    lost `env:` on that step arrives here as one empty string, and treating it
#    as "a dir that does not exist, so nothing ran" would exit 0 on the exact
#    misconfiguration that makes the whole check vacuous.
run_check ""
assert_nonzero "an empty dir argument is a usage error, not 'nothing ran'" "$status"
assert_contains "the empty-argument error says what it needs" "usage" "$output"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
