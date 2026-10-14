#!/usr/bin/env bash
# Tests for scripts/check-versions.sh.
#
# The version lives in three files (package.json, src-tauri/Cargo.toml,
# src-tauri/tauri.conf.json) and nothing in the build ties them together, so a
# bump that misses one ships a stale value in silence. The fixtures here are the
# minimal shape check-versions.sh reads — a real Cargo.toml or tauri.conf.json
# would only add coupling to fields the check ignores.
#
# Plain bash, not vitest: these are shell scripts, and green is the same bar
# `bash scripts/check-versions.test.sh` has to clear in CI.
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check_script="$test_dir/check-versions.sh"
repo_root="$(cd "$test_dir/.." && pwd)"

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

# A fixture tree per case, so "missing tauri.conf.json" is a fixture shape
# rather than a mutation of a shared one.
make_fixture() {
  local root="$1" pkg_version="$2" cargo_version="$3" conf_version="$4"
  mkdir -p "$root/src-tauri"
  printf '{ "name": "fixture", "version": "%s" }\n' "$pkg_version" >"$root/package.json"
  printf '[package]\nname = "fixture"\nversion = "%s"\n' "$cargo_version" >"$root/src-tauri/Cargo.toml"
  printf '{ "productName": "fixture", "version": "%s" }\n' "$conf_version" >"$root/src-tauri/tauri.conf.json"
}

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

# 1. All three agree -> success, and the agreed version is reported.
root="$tmp_root/all-match"
make_fixture "$root" "1.2.3" "1.2.3" "1.2.3"
run_check "$root"
assert_eq "matching versions exit 0" "0" "$status"
assert_contains "matching versions report the version" "versions match: 1.2.3" "$output"

# 2. package.json is the odd one out — and its value has to be visible, since
#    naming the disagreeing file is the whole point of the failure message.
root="$tmp_root/package-json-drifts"
make_fixture "$root" "9.9.9" "1.2.3" "1.2.3"
run_check "$root"
assert_eq "package.json mismatch exits 1" "1" "$status"
assert_contains "package.json mismatch names its value" "9.9.9" "$output"

# 3. tauri.conf.json drifts — the file the release skill's version table does
#    not know about, so the case this check exists for.
root="$tmp_root/tauri-conf-drifts"
make_fixture "$root" "1.2.3" "1.2.3" "0.1.0"
run_check "$root"
assert_eq "tauri.conf.json mismatch exits 1" "1" "$status"
assert_contains "tauri.conf.json mismatch names the file" "src-tauri/tauri.conf.json" "$output"

# 4. tauri.conf.json absent entirely — a missing file must be reported as
#    itself, not as a mismatch against an empty string.
root="$tmp_root/tauri-conf-missing"
make_fixture "$root" "1.2.3" "1.2.3" "1.2.3"
rm "$root/src-tauri/tauri.conf.json"
run_check "$root"
assert_eq "missing tauri.conf.json exits 1" "1" "$status"
assert_contains "missing tauri.conf.json names the file" "src-tauri/tauri.conf.json" "$output"

# 5. The real tree — the assertion CI actually depends on. The repo root comes
#    from this script's own location, so the case holds from any CWD (the
#    no-argument default the ci.yml step relies on is exercised there).
run_check "$repo_root"
assert_eq "the real tree's three versions agree" "0" "$status"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
