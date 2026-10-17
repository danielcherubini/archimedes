#!/usr/bin/env bash
# Tests for scripts/release-notes.sh.
#
# Why this script has tests while the "curate the prose" part of release notes
# obviously does not: the parts that can fail SILENTLY are the ones worth
# testing, and this pipeline has two of them, both verified against the live API
# before this file was written.
#
#   1. `POST /releases/generate-notes` does NOT validate `tag_name`. Asking for
#      `v9.9.9` — a tag that has never existed in this repository — answers 200
#      with a confident "## What's Changed" list for the most recent real
#      release. A typo, or a tag deleted between the push and the step, is
#      therefore indistinguishable from success: the release page gets notes
#      that describe the WRONG set of changes, which is worse than an empty
#      page, because an empty page is obviously broken. The tag check exists for
#      exactly this, and case 2 pins that the endpoint is never even called.
#   2. An empty 200 is possible (no PRs between two tags, e.g. a re-tag). Empty
#      notes are what this whole change exists to fix, so "generated nothing"
#      is a failure, not a success with an empty file.
#
# `gh` is replaced by a shim on PATH (below), so these tests make NO network
# calls and are deterministic on any machine with jq. The shim also records
# every invocation, which is how a case asserts "the API was not called" or
# "previous_tag_name was/was not sent" — behaviours a real call cannot show
# reproducibly.
#
# Plain bash, not vitest: same convention as check-versions.test.sh and
# compose-updater-manifest.test.sh, and the same CI bar.
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
notes_script="$test_dir/release-notes.sh"

if [[ ! -f "$notes_script" ]]; then
  echo "FATAL: $notes_script does not exist — implement it before running these tests." >&2
  exit 1
fi

# jq only, NOT gh: `gh` is replaced by a fixture shim below, so requiring the
# real binary would stop these tests running on a machine that has nothing to
# test against. jq is genuinely used — by the shim's `--jq` emulation and by the
# script's own filter.
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required to run these tests." >&2
  exit 1
fi

failures=0
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

# ---------------------------------------------------------------------------
# The `gh` shim.
#
# Fixture inputs (set per case, exported so the shim sees them):
#   FAKE_RELEASE_EXISTS   true|false — does `gh release view` succeed?
#   FAKE_RELEASE_LIST     a JSON array, the answer to `gh release list`
#   FAKE_NOTES_BODY       what generate-notes returns as .body
#   FAKE_API_STATUS       empty = 200; otherwise the shim exits non-zero and
#                         prints GitHub's error envelope (the 400 shape)
#   FAKE_API_LOG          file every shim invocation appends one line to
# ---------------------------------------------------------------------------
fake_bin="$tmp_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

log="${FAKE_API_LOG:-/dev/null}"
printf '%s\n' "$*" >>"$log"

case "${1:-}" in
  release)
    case "${2:-}" in
      view)
        # The script asks for the release that owns this tag. The shim's answer
        # is driven purely by FAKE_RELEASE_EXISTS; argv is logged above so a
        # case can assert what was asked for.
        if [[ "${FAKE_RELEASE_EXISTS:-true}" == "true" ]]; then
          printf '%s\n' "${FAKE_RELEASE_TAG:-v0.2.0}"
        else
          echo "gh: Not Found (HTTP 404)" >&2
          exit 1
        fi
        ;;
      list)
        # Real `gh release list --jq EXPR` filters the JSON; the shim must too, or
        # the raw array leaks into the caller's `previous` and every assertion
        # about WHICH tag was chosen passes for the wrong reason.
        prev=""
        for ((i = 1; i < $#; i++)); do
          [[ "${!i}" == "--jq" ]] && prev=$((i + 1))
        done
        if [[ -n "$prev" ]]; then
          printf '%s\n' "${FAKE_RELEASE_LIST:-[]}" | jq -r "${@:prev}"
        else
          printf '%s\n' "${FAKE_RELEASE_LIST:-[]}"
        fi
        ;;
      *)
        echo "fake gh: unhandled subcommand: $*" >&2
        exit 70
        ;;
    esac
    ;;
  api)
    if [[ -n "${FAKE_API_STATUS:-}" ]]; then
      printf '{"message":"Invalid previous_tag parameter","documentation_url":"https://docs.github.com/rest","status":"400"}\n' >&2
      echo "gh: Invalid previous_tag parameter (HTTP 400)" >&2
      exit 1
    fi
    # Emulate `--jq .body`, which prints the DECODED string (raw markdown, then
    # one trailing newline) rather than a JSON-quoted scalar. Getting this wrong
    # in the shim would test the script against a shape it never sees.
    printf '%s\n' "${FAKE_NOTES_BODY:-}"
    ;;
  *)
    echo "fake gh: unhandled command: $*" >&2
    exit 70
    ;;
esac
SHIM
chmod +x "$fake_bin/gh"

# Real-ish generated body: the endpoint's actual shape (a header, `* … by @user
# in URL` bullets, a bold Full Changelog line, blank lines between). Deliberately
# carries a dash, an em dash, backticks and a `(` so a quoting bug in the script
# is visible rather than merely ugly.
generated_body='## What'"'"'s Changed
* feat(web): web_search, fetch_content & `get_search_content` by @danielcherubini in https://github.com/o/r/pull/23
* fix(ui): tool cards never open themselves — the auto-open was racing mount by @danielcherubini in https://github.com/o/r/pull/24
* perf(release): cache the Rust tree (563–715 cold crates/run) by @danielcherubini in https://github.com/o/r/pull/16


**Full Changelog**: https://github.com/o/r/compare/v0.1.1...v0.2.0'

# run_notes DIR ARGS... — runs the script with the shim on PATH.
#
# stdout and stderr are captured SEPARATELY, because for this script that split
# IS the contract: stdout carries the one-line summary another step feeds to
# the composer's `--notes`, so it must be exactly one line and nothing else;
# every diagnostic belongs on stderr. Merging them, the way the composer's
# harness does, would make a chatty script look correct. `|| status=$?` keeps
# `set -e` from aborting on the exits asserted below.
run_notes() {
  local dir="$1"
  shift
  export PATH="$fake_bin:$PATH"
  export FAKE_API_LOG="$dir/api.log"
  : >"$FAKE_API_LOG"
  local stdout_file="$dir/.stdout" stderr_file="$dir/.stderr"
  status=0
  (cd "$dir" && "$notes_script" "$@" >"$stdout_file" 2>"$stderr_file") || status=$?
  stdout="$(cat "$stdout_file")"
  stderr="$(cat "$stderr_file")"
  output="$(cat "$stdout_file" "$stderr_file")"
}

api_calls() { grep -c '^api ' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null || true; }

api_calls() { grep -c '^api ' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null || true; }

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

assert_fails() {
  local what="$1"
  if [[ "$status" == "1" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected exit 1, got: $status"
    echo "       output: $output"
    failures=$((failures + 1))
  fi
}

assert_passes() {
  local what="$1"
  if [[ "$status" == "0" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what"
    echo "       expected exit 0, got: $status"
    echo "       output: $output"
    failures=$((failures + 1))
  fi
}

path_exists() { [[ -e "$1" ]] && printf 'yes\n' || printf 'no\n'; }

# ---------------------------------------------------------------------------
# 1. Happy path: explicit --previous, real-shaped body.
#
# Two outputs, and the split is the contract: the MARKDOWN body goes to a file
# (it is what `gh release edit --notes-file` reads), while the ONE-LINE summary
# goes to stdout (it is what the composer's `--notes` receives, and it must be
# short because the in-app "update available" panel renders it as a single
# whitespace-preserved paragraph — a 40-line markdown body there is unreadable).
# ---------------------------------------------------------------------------
dir="$tmp_root/current"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[]'
run_notes "$dir" --repo o/r --tag v0.2.0 --previous v0.1.1 --out out/notes.md
assert_passes "generation succeeds on the happy path"
body_file="$dir/out/notes.md"
assert_eq "the notes body file was written" "yes" "$(path_exists "$body_file")"
# Byte-exact, not "contains": the em dash, the `–` en dash and the trailing
# newline are the cases an `echo "$body"` or a heredoc quietly rewrites.
if [[ -f "$body_file" ]]; then
  assert_eq "the body file holds the generated markdown byte for byte" \
    "$generated_body" "$(cat "$body_file")"
else
  echo "FAIL the body file holds the generated markdown byte for byte (file missing)"
  failures=$((failures + 1))
fi
assert_contains "the explicit --previous tag is sent to the endpoint" "previous_tag_name=v0.1.1" "$(cat "$dir/api.log")"
assert_contains "the tag whose notes are wanted is sent" "tag_name=v0.2.0" "$(cat "$dir/api.log")"
# stdout alone, from here down — it is the composer's `--notes` argument.
assert_contains "the summary names the version" "v0.2.0" "$stdout"
assert_contains "the summary counts the three generated changes" "3 changes" "$stdout"
assert_contains "the summary points at the release page" "https://github.com/o/r/releases/tag/v0.2.0" "$stdout"
assert_eq "stdout is the summary ALONE (one line — the panel cannot render a wall)" \
  "1" "$(printf '%s\n' "$stdout" | grep -c .)"
assert_not_contains "the markdown body never leaks onto stdout" "What's Changed" "$stdout"
assert_not_contains "diagnostics never leak onto stdout either" "generated" "$stdout"

# ---------------------------------------------------------------------------
# 2. THE TRAP: a tag with no release behind it. The endpoint answers 200 with
#    confident notes for the most recent REAL release, so the only safe shape is
#    "check the release exists, and never call the endpoint when it does not".
#    A case that only asserts exit 1 would still pass on a script that called the
#    API first and then checked — hence the call-count assertion.
# ---------------------------------------------------------------------------
dir="$tmp_root/missing-tag"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=false
export FAKE_NOTES_BODY="$generated_body"
run_notes "$dir" --repo o/r --tag v9.9.9 --previous v0.1.1 --out out/notes.md
assert_fails "a tag with no release behind it exits 1"
assert_contains "the failure names the tag so a typo is obvious" "v9.9.9" "$output"
assert_eq "the endpoint was NEVER called for a tag that does not exist" "0" "$(api_calls)"
assert_eq "no notes file survives" "no" "$(path_exists "$dir/out/notes.md")"

# ---------------------------------------------------------------------------
# 3. An empty generated body is a FAILURE, not an empty release page.
# ---------------------------------------------------------------------------
dir="$tmp_root/empty-body"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY=''
export FAKE_RELEASE_LIST='[]'
run_notes "$dir" --repo o/r --tag v0.2.0 --previous v0.1.1 --out out/notes.md
assert_fails "an empty generated body exits 1 rather than publishing blank notes"
assert_contains "the failure says notes came back empty" "empty" "$output"
assert_eq "no empty notes file is left for a later step to upload" "no" "$(path_exists "$dir/out/notes.md")"

# ---------------------------------------------------------------------------
# 4. Whitespace-only is empty. `test -s` alone would wave it through, and the
#    result on the release page is identical to a blank body.
# ---------------------------------------------------------------------------
dir="$tmp_root/whitespace-body"
mkdir -p "$dir"
export FAKE_NOTES_BODY='

'
run_notes "$dir" --repo o/r --tag v0.2.0 --previous v0.1.1 --out out/notes.md
assert_fails "a whitespace-only body exits 1"
assert_eq "no whitespace-only notes file is left behind" "no" "$(path_exists "$dir/out/notes.md")"

# ---------------------------------------------------------------------------
# 5. The endpoint's own error must not degrade into empty notes.
# ---------------------------------------------------------------------------
dir="$tmp_root/api-error"
mkdir -p "$dir"
export FAKE_NOTES_BODY="$generated_body"
export FAKE_API_STATUS=400
run_notes "$dir" --repo o/r --tag v0.2.0 --previous v0.1.1 --out out/notes.md
assert_fails "a failed generate-notes call exits 1"
assert_contains "GitHub's error is surfaced, not swallowed" "Invalid previous_tag parameter" "$output"
assert_eq "no notes file survives an API error" "no" "$(path_exists "$dir/out/notes.md")"
unset FAKE_API_STATUS

# ---------------------------------------------------------------------------
# 6. Auto-resolving the comparison base.
#
# The workflow knows only the tag it is releasing, so "notes since the last
# release" has to be derived. What is pinned: the base is the nearest published
# release BELOW this tag by VERSION, and drafts, prereleases and the release
# itself are never candidates. (Not "the newest release" — case 6b.)
# ---------------------------------------------------------------------------
dir="$tmp_root/auto-previous"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
# Deliberately out of order, and it holds everything that must never be chosen:
# a draft (possibly the release being published, which has no notes to compare
# against), a prerelease (its changes land in the final anyway), and the release
# itself (comparing a release with itself generates an empty body, which case 3
# then fails loudly on).
export FAKE_RELEASE_LIST='[
  {"tagName":"v0.2.0","isDraft":false,"isPrerelease":false},
  {"tagName":"v0.3.0-rc.1","isDraft":false,"isPrerelease":true},
  {"tagName":"v0.1.1","isDraft":false,"isPrerelease":false},
  {"tagName":"v0.1.5-wip","isDraft":true,"isPrerelease":false}
]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "generation succeeds without an explicit --previous"
assert_contains "the nearest published release below the tag is chosen" "previous_tag_name=v0.1.1" "$(cat "$dir/api.log")"
assert_not_contains "a prerelease is never used as the comparison base" "previous_tag_name=v0.3.0-rc.1" "$(cat "$dir/api.log")"
assert_not_contains "a draft is never used as the comparison base" "previous_tag_name=v0.1.5-wip" "$(cat "$dir/api.log")"
assert_not_contains "the release is never compared with itself" "previous_tag_name=v0.2.0" "$(cat "$dir/api.log")"

# ---------------------------------------------------------------------------
# 6b. The backport: a patch released from an OLDER line, after a newer release
#     already exists. `v0.2.1` is released after `v0.3.0`, so "the newest
#     release" is v0.3.0 — and comparing v0.2.1 against v0.3.0 asks GitHub for
#     the changes between a patch and a LATER version, which is a set that does
#     not mean what a release page says it means. Ordering by version, not by
#     recency, is the whole fix, so this case is what stops someone "simplifying"
#     the filter back to the newest entry.
# ---------------------------------------------------------------------------
dir="$tmp_root/backport"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[
  {"tagName":"v0.3.0","isDraft":false,"isPrerelease":false},
  {"tagName":"v0.2.0","isDraft":false,"isPrerelease":false},
  {"tagName":"v0.1.1","isDraft":false,"isPrerelease":false}
]'
run_notes "$dir" --repo o/r --tag v0.2.1 --out out/notes.md
assert_passes "a backport patch release generates notes"
assert_contains "a backport compares against its own line" "previous_tag_name=v0.2.0" "$(cat "$dir/api.log")"
assert_not_contains "a backport is never compared against a LATER release" "previous_tag_name=v0.3.0" "$(cat "$dir/api.log")"

# ---------------------------------------------------------------------------
# 7. The FIRST release ever: there is nothing to compare against, so the script
#    must omit `previous_tag_name` and let the endpoint describe everything.
#    Sending an empty or invented value here is how the first release of a repo
#    ends up with no notes at all.
# ---------------------------------------------------------------------------
dir="$tmp_root/first-release"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[
  {"tagName":"v0.1.0","isDraft":false,"isPrerelease":false,"createdAt":"2026-10-15T16:04:39Z"}
]'
run_notes "$dir" --repo o/r --tag v0.1.0 --out out/notes.md
assert_passes "the first release generates notes"
assert_eq "the endpoint is called exactly once" "1" "$(api_calls)"
assert_not_contains "no previous_tag_name is sent when there is no previous release" "previous_tag_name" "$(cat "$dir/api.log")"
assert_contains "the first release's summary counts its changes" "3 changes" "$stdout"

# ---------------------------------------------------------------------------
# 8. A comparison base whose tag is not `vX.Y.Z` is never SENT.
#
# This repository's tag convention is not a law: an older published release could
# legitimately sit on `2024.5.1` or `v1.0`. The endpoint REJECTS such a value as
# a base with a 400, which would fail a release whose only crime was the shape of
# someone else's tag. So unparseable candidates are filtered out and the nearest
# usable one wins; when none is usable, the base is omitted and GitHub describes
# everything — a broad set of notes beats a red pipeline, and the omission is
# announced on stderr rather than passing silently.
# ---------------------------------------------------------------------------
dir="$tmp_root/odd-previous"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[
  {"tagName":"2024.5.1","isDraft":false,"isPrerelease":false},
  {"tagName":"v0.1.1","isDraft":false,"isPrerelease":false}
]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "a non-vX.Y.Z tag in the release list does not fail the release"
assert_not_contains "a non-vX.Y.Z tag is never sent as the comparison base" "previous_tag_name=2024.5.1" "$(cat "$dir/api.log")"
assert_contains "the nearest usable base is chosen instead" "previous_tag_name=v0.1.1" "$(cat "$dir/api.log")"
assert_eq "notes are still written" "yes" "$(path_exists "$dir/out/notes.md")"

# And when EVERY candidate is unparseable, that is stated, not swallowed: the
# resulting notes describe far more than this release, and a reader of the
# release page is entitled to know which case they are looking at.
dir="$tmp_root/only-odd-previous"
mkdir -p "$dir"
export FAKE_RELEASE_LIST='[
  {"tagName":"2024.5.1","isDraft":false,"isPrerelease":false}
]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "a release list of unparseable tags still produces notes"
assert_not_contains "no unparseable base reaches the endpoint" "previous_tag_name" "$(cat "$dir/api.log")"
assert_contains "the missing base is announced" "no comparison base found" "$stderr"

# ---------------------------------------------------------------------------
# 9. A missing jq is a hard error, not a silently-widened comparison.
#
# The base-derivation filter runs inside a pipeline whose failures are swallowed
# so that "no base found" can degrade gracefully to "describe everything". That
# is right for an EMPTY result and wrong for a MISSING jq: the same `// empty`
# path would produce notes describing every release ever made, formatted to look
# like a normal release's notes. So jq is required up front, like gh.
# ---------------------------------------------------------------------------
dir="$tmp_root/no-jq"
mkdir -p "$dir"
export FAKE_API_LOG="$dir/api.log"
: >"$FAKE_API_LOG"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[{"tagName":"v0.1.1","isDraft":false,"isPrerelease":false}]'
# PATH rebuilt from the system directories with jq excluded, rather than narrowed
# to the shim alone — the script's shebang needs `bash`, and a 127 from the
# interpreter would "pass" an assertion about jq for the wrong reason. The shim
# still supplies gh, so gh's check passes and the jq check is what stops it.
nojq_bin="$dir/bin"
mkdir -p "$nojq_bin"
for system_bin in /usr/bin /bin; do
  [[ -d "$system_bin" ]] || continue
  for entry in "$system_bin"/*; do
    name="${entry##*/}"
    [[ "$name" == "jq" ]] && continue
    [[ -e "$nojq_bin/$name" ]] || ln -s "$entry" "$nojq_bin/$name" 2>/dev/null || true
  done
done
ln -sf "$fake_bin/gh" "$nojq_bin/gh"
if [[ -e "$nojq_bin/jq" ]] || ! [[ -x "$nojq_bin/bash" ]]; then
  echo "FATAL: could not build a jq-free PATH — the missing-jq case cannot run here." >&2
  exit 1
fi
status=0
(
  cd "$dir"
  PATH="$nojq_bin" "$notes_script" --repo o/r --tag v0.2.0 --out out/notes.md \
    >"$dir/.stdout" 2>"$dir/.stderr"
) && status=0 || status=$?
stdout="$(cat "$dir/.stdout")"
stderr="$(cat "$dir/.stderr")"
output="$stdout$stderr"
assert_fails "a missing jq exits 1 instead of generating over-broad notes"
assert_contains "the failure names jq" "jq" "$output"
assert_eq "the endpoint is never called without jq" "0" "$(api_calls)"
assert_eq "no notes file is written" "no" "$(path_exists "$dir/out/notes.md")"
assert_eq "nothing is printed on stdout" "" "$stdout"

# ---------------------------------------------------------------------------
# 10. Argument validation. A missing repo would produce a request against the
#    current-directory remote, which on a fork or a renamed repo is not the repo
#    being released — so these are errors, never defaults.
# ---------------------------------------------------------------------------
dir="$tmp_root/args"
mkdir -p "$dir"
export FAKE_RELEASE_LIST='[]'
export FAKE_NOTES_BODY="$generated_body"

run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md --unknown-flag
assert_fails "an unknown flag exits 1"
assert_contains "the unknown flag is named" "unknown-flag" "$output"

run_notes "$dir" --repo o/r --out out/notes.md
assert_fails "a missing --tag exits 1"
assert_contains "the missing tag is reported as usage, not as an API error" "usage" "$output"
assert_eq "nothing is called when the arguments are wrong" "0" "$(api_calls)"

run_notes "$dir" --tag v0.2.0 --out out/notes.md
assert_fails "a missing --repo exits 1"
assert_eq "nothing is called when the repo is missing" "0" "$(api_calls)"

run_notes "$dir" --repo o/r --tag 0.2.0 --out out/notes.md
assert_fails "a --tag without the v prefix exits 1"
assert_contains "the bare version is named in the failure" "0.2.0" "$output"
assert_eq "a bare version never reaches the endpoint" "0" "$(api_calls)"

run_notes "$dir" --repo o/r --tag v0.2.0
assert_fails "a missing --out exits 1"
assert_eq "nothing is called without an output path" "0" "$(api_calls)"

# ---------------------------------------------------------------------------
# 9. The summary counts CHANGELOG bullets and nothing else. The header, the
#    blank lines and the bold `**Full Changelog**` line are not changes; a count
#    that includes them overstates every release, and this line is the only
#    thing the in-app update panel shows a user.
# ---------------------------------------------------------------------------
dir="$tmp_root/two-changes"
mkdir -p "$dir"
export FAKE_NOTES_BODY='## What'"'"'s Changed
* fix(a): one by @u in https://github.com/o/r/pull/1
* fix(b): two by @u in https://github.com/o/r/pull/2


**Full Changelog**: https://github.com/o/r/compare/v0.1.0...v0.2.0'
export FAKE_RELEASE_LIST='[]'
run_notes "$dir" --repo o/r --tag v0.2.0 --previous v0.1.0 --out out/notes.md
assert_passes "a two-change release generates"
assert_contains "exactly the two bullets are counted" "2 changes" "$stdout"
assert_not_contains "the Full Changelog line is not counted as a change" "3 changes" "$stdout"

# ---------------------------------------------------------------------------
# 11. A tag name is attacker-visible input the moment someone pushes
#     `v1.0.0; curl evil` — release.yml states the same rule about its own steps.
#     The strongest guard is not careful quoting but a strict format check that
#     rejects anything outside `vX.Y.Z` before it reaches any command, so this
#     asserts BOTH halves: nothing executes, and it is refused rather than
#     sanitized.
# ---------------------------------------------------------------------------
dir="$tmp_root/hostile-tag"
mkdir -p "$dir"
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[]'
export FAKE_RELEASE_EXISTS=true
run_notes "$dir" --repo o/r --tag 'v1.0.0; touch pwned' --previous v0.1.0 --out out/notes.md
assert_fails "a tag carrying a shell metacharacter exits 1"
assert_eq "a hostile tag never reaches the endpoint" "0" "$(api_calls)"
assert_eq "a hostile tag executes nothing" "no" "$(path_exists "$dir/pwned")"
assert_eq "no notes file is written for a rejected tag" "no" "$(path_exists "$dir/out/notes.md")"

# The comparison base is the same class of input — it comes from a listing that
# any tag push can add to — so it is validated the same way.
run_notes "$dir" --repo o/r --tag v0.2.0 --previous 'v0.1.1$(touch pwned2)' --out out/notes.md
assert_fails "a --previous carrying a shell metacharacter exits 1"
assert_eq "a hostile --previous never reaches the endpoint" "0" "$(api_calls)"
assert_eq "a hostile --previous executes nothing" "no" "$(path_exists "$dir/pwned2")"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
