#!/usr/bin/env bash
#
# Fail if a test run left a crash log in the data directory.
#
# This is the runtime half of the crash-log-hardening guard. The other half is a
# SOURCE-level census invariant (`agent/childproc.rs`, Task 2): it forbids
# `dirs::data_dir()` in `crashlog.rs`'s production region. A census cannot see a
# resolver reached from somewhere else, and it cannot see what the suite
# actually DOES — so this script answers the observable question instead: after a
# run, is there a `crash-*.log` in the directory the run was pointed at?
#
# **The caller must redirect the data dir, and the check is meaningless
# otherwise.** Pointing `cargo test` at a throwaway directory (Linux:
# `XDG_DATA_HOME`, macOS: `HOME`) is the premise of the question, not a detail.
# A CI runner's real data dir was never written to, so asking "is it empty?"
# there returns "yes" while checking nothing at all — a green step guarding
# nothing. This repo has been bitten by exactly that shape and recorded it at
# `src-tauri/src/agent/tools/exec.rs:1780-1791`: the first version of the stdin
# test passed with `closed_stdin` DELETED, because CI's fd 0 was already
# `/dev/null`, so the condition it claimed to catch was already true. A
# redirected `ARCHIMEDES_TEST_DATA_DIR` plus
# `test_support::the_ci_data_dir_redirect_took_effect` (which fails the run when
# the redirect did NOT take effect) is what keeps this check honest: the Rust
# test proves the premise, this script asserts the conclusion.
#
# LINUX + macOS ONLY. `dirs` 6.0.0 resolves the Windows data dir with
# `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` (`dirs-sys-0.5.0/src/lib.rs:150-178`;
# `dirs-6.0.0/src/win.rs:10`), which IGNORES `%APPDATA%` — a Windows redirect
# would change nothing, and this script would exit 0 for exactly the wrong
# reason. Windows is therefore guarded by the census alone (a recorded gap; the
# CI step that calls this is gated off there).
#
# The search is RECURSIVE, and that is load-bearing: on macOS `data_dir()` is
# `<HOME>/Library/Application Support`, so the app's directory nests
# `archimedes` three levels under the redirected root. A non-recursive check
# there scans an empty level and passes having looked at nothing.
#
# Only `crash-*.log` is matched. `supervisor.log` / `supervisor.log.old`
# (`debuglog.rs`) and the database are written into the SAME directory on
# purpose — matching them would make this guard permanently red, and a
# permanently red guard is a guard nobody reads.
#
# Usage: check-test-data-dir.sh <dir>

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <dir>" >&2
}

# One directory, no default. Defaulting to `.` would scan the checkout and
# answer a question nobody asked; and an EMPTY argument is precisely what a lost
# `env:` on the CI step delivers, so treating "" as "a dir that does not exist,
# so nothing ran" would exit 0 on the exact misconfiguration that makes this
# check vacuous.
if [[ $# -ne 1 || -z "$1" ]]; then
  if [[ $# -eq 1 ]]; then
    echo "error: the data dir argument is empty — the redirect is the premise of this check, so an empty value cannot be answered" >&2
  else
    echo "error: exactly one argument is required (the redirected data dir)" >&2
  fi
  usage
  exit 1
fi

dir="$1"

# A directory that does not exist means nothing ran there — not a leak.
if [[ ! -e "$dir" ]]; then
  echo "no crash logs: the directory does not exist, so nothing ran there ($dir)"
  exit 0
fi

# Exists but is not a directory: reporting "no crash logs" here would be the
# vacuous green this script exists to avoid, so it is an error.
if [[ ! -d "$dir" ]]; then
  echo "error: not a directory: $dir" >&2
  usage
  exit 1
fi

# `-print0` because the macOS path this guard is written for contains a SPACE
# (`Application Support`), and an unquoted word-split loop would truncate every
# finding at it. The listing goes through a temp file rather than a process
# substitution so `find`'s OWN exit status is visible: a `find` that dies (a
# permissions error partway down) would otherwise leave the loop with nothing to
# read and the script would report green on a check that never completed.
listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT
find_status=0
find "$dir" -type f -name 'crash-*.log' -print0 >"$listing" || find_status=$?
if [[ "$find_status" -ne 0 ]]; then
  echo "error: could not search $dir for crash logs (find exited $find_status) — a failed search is not an empty one" >&2
  exit 1
fi

found=0
while IFS= read -r -d '' hit; do
  printf '%s\n' "$hit"
  found=1
done <"$listing"


if [[ "$found" -ne 0 ]]; then
  echo "error: the test suite wrote crash logs into the data directory it was given" >&2
  echo "  a test panic reached a live crash-log hook — the hook must be handed a directory the tests own (crash-log-hardening Task 1), and \`dirs::data_dir()\` must stay out of \`crashlog.rs\`'s production region (Task 2's census)" >&2
  exit 1
fi

echo "no crash logs under $dir"
exit 0
