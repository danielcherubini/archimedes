#!/usr/bin/env bash
# Tests for scripts/release-notes.sh.
#
# Why this script has tests while the "curate the prose" part of release notes
# obviously does not: the parts that can fail SILENTLY are the ones worth
# testing, and this pipeline has a run of them, each verified against the live
# API or against a local paged server before this file was written.
#
#   1. `POST /releases/generate-notes` does NOT validate `tag_name`. Asking for
#      `v9.9.9` — a tag that has never existed in this repository — answers 200
#      with a confident "## What's Changed" list for the most recent real
#      release. A typo, or a tag deleted between the push and the step, is
#      therefore indistinguishable from success: the release page gets notes
#      that describe the WRONG set of changes, which is worse than an empty
#      page, because an empty page is obviously broken. The two existence checks
#      (release object, then git ref) exist for exactly this, and case 2 pins
#      that the generator is never even called.
#   2. An empty 200 is possible (no PRs between two tags, e.g. a re-tag). Empty
#      notes are what this whole change exists to fix, so "generated nothing"
#      is a failure, not a success with an empty file.
#   3. A comparison base that is merely ABSENT and a lookup that FAILED look the
#      same if the error is swallowed — and the second case silently describes
#      every release the repository has ever had while exiting 0.
#   4. A newest-first listing window hides the predecessor of a backport patch,
#      and `--paginate --jq` aggregates PER PAGE, so the obvious fix picks the
#      wrong base too.
#   5. A `gh` call that names no repository resolves it from the CHECKOUT, which
#      on a fork or a renamed repo is not the repository being released.
#
# `gh` is replaced by a shim on PATH (below), so these tests make NO network
# calls and are deterministic on any machine with jq. The shim also records
# every invocation, which is how a case asserts "the generator was not called",
# "the listing addressed this repository", or "previous_tag_name was/was not
# sent" — behaviours a real call cannot show reproducibly.
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
# It answers four things the script asks of the API, and the repository-facing
# ones are served from the SAME fixture so a case only has to describe the
# repository once:
#
#   gh release view TAG --json tagName --repo R    → FAKE_RELEASE_EXISTS
#   GET repos/R/git/ref/tags/TAG                   → FAKE_RELEASE_REF_EXISTS
#   GET repos/R/releases (--paginate)              → FAKE_RELEASE_LIST /
#                                                    FAKE_RELEASE_PAGES
#   POST repos/R/releases/generate-notes           → FAKE_NOTES_BODY /
#                                                    FAKE_API_STATUS
#
# Fixture inputs (set per case, exported so the shim sees them):
#   FAKE_RELEASE_EXISTS      true|false — does `gh release view` succeed?
#   FAKE_RELEASE_REF_EXISTS  true|false — does the git tag ref exist?
#   FAKE_RELEASE_LIST        a JSON array of releases in the shape
#                            `GET /repos/{repo}/releases` actually returns
#                            (`tag_name`/`draft`/`prerelease`), served as the
#                            single page. NOT gh's `--json` camelCase: the
#                            listing this script makes is a raw API call, and a
#                            fixture in gh's camelCase shape would make every
#                            field the filter reads come back null — which is
#                            exactly how a wrong-field-name bug hides.
#   FAKE_RELEASE_PAGES       a JSON array OF pages, for the multi-page cases;
#                            overrides FAKE_RELEASE_LIST.
#   FAKE_RELEASE_PAGE_MODE   merged (the default) — one concatenated array, which
#                            is what `gh api --paginate` with no `--jq` really
#                            prints; separate — one JSON array PER PAGE, the shape
#                            `gh api --paginate --jq FILTER` really prints, replayed
#                            here without a filter so the script's aggregation is
#                            exercised against a per-page stream directly. The
#                            aggregation must not care which it gets; the
#                            pagination section asserts both shapes.
#   FAKE_RELEASE_LIST_STATUS non-empty — the listing request fails with that HTTP
#                            status, for the "the lookup broke" cases.
#   FAKE_RELEASE_LIST_RAW    text served by the listing at exit 0, bypassing every
#                            jq in the shim. This is the only way to hand the
#                            script a response that is not valid JSON: routed
#                            through the normal fixture path, the shim's own jq
#                            would reject it and fail the REQUEST, so the case
#                            would duplicate the HTTP-status one and the script's
#                            filter-error branch would never execute.
#   FAKE_REQUIRE_REPO        true — `gh release view` REFUSES to run without an
#                            explicit `--repo`. This is the fork simulation: real
#                            gh resolves the repository from the checkout when no
#                            repository is named, and on a fork or a renamed repo
#                            that checkout is the wrong repository, so an
#                            unaddressed call must not be served a convenient
#                            answer by the harness.
#   FAKE_NOTES_BODY          what generate-notes returns as .body
#   FAKE_API_STATUS          empty = 200; otherwise the shim exits non-zero and
#                            prints GitHub's error envelope (the 400 shape)
#   FAKE_API_LOG             file every shim invocation appends one line to
# ---------------------------------------------------------------------------
fake_bin="$tmp_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

log="${FAKE_API_LOG:-/dev/null}"
printf '%s\n' "$*" >>"$log"

# --- flag normalisation, BEFORE dispatch -----------------------------------
# Real `gh` accepts `--repo`/`-R` anywhere in argv, before the subcommand as
# well as after it. A shim that dispatches on $1/$2 would crash on
# `gh --repo o/r release view …` and every case would then be failing because of
# the shim's parsing rather than the script's — so pull the repository flag out
# wherever it sits and dispatch on what is left. The value is remembered, because
# a case needs to be able to ask "did this call address a repository at all?".
repo_flag=""
argv=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo | -R) repo_flag="${2:-}"; shift 2 ;;
    --repo=* | -R=*) repo_flag="${1#*=}"; shift ;;
    *) argv+=("$1"); shift ;;
  esac
done
set -- ${argv[@]+"${argv[@]}"}

case "${1:-}" in
  release)
    case "${2:-}" in
      view)
        # The script asks for the release that owns this tag. The shim's answer
        # is driven purely by FAKE_RELEASE_EXISTS; argv is logged above so a
        # case can assert what was asked for.
        if [[ "${FAKE_REQUIRE_REPO:-false}" == "true" && -z "$repo_flag" ]]; then
          # The fork case. Unaddressed, gh would ask the CURRENT DIRECTORY's
          # remote, which is not the repository being released — so the harness
          # refuses to guess rather than quietly agreeing.
          echo "gh: could not resolve a repository — the caller must name one" >&2
          exit 1
        fi
        if [[ "${FAKE_RELEASE_EXISTS:-true}" == "true" ]]; then
          printf '%s\n' "${FAKE_RELEASE_TAG:-v0.2.0}"
        else
          echo "gh: Not Found (HTTP 404)" >&2
          exit 1
        fi
        ;;
      *)
        # `gh release list` is GONE from the script on purpose: `--limit` is a
        # newest-first window and cannot express "all" (`--limit -1` and
        # `--limit 0` both exit 1), so it can hide the predecessor. Answering it
        # here would let a regression back to it pass the harness quietly.
        echo "fake gh: unhandled subcommand: $*" >&2
        exit 70
        ;;
    esac
    ;;
  api)
    shift
    method=GET
    path=""
    paginate=""
    jq_expr=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -X | --method) method="${2:-}"; shift 2 ;;
        --paginate) paginate=1; shift ;;
        --slurp | -s) shift ;;
        --jq | -q) jq_expr="${2:-}"; shift 2 ;;
        -f | --raw-field | -F | --field | -H | --header | --input | --hostname | --cache | --preview | -p | -t | --template)
          shift 2 ;;
        -i | --include | --silent | --verbose | --allow-escape-sequences) shift ;;
        -*) shift ;;
        *) [[ -z "$path" ]] && path="$1"; shift ;;
      esac
    done
    path="${path%%\?*}"

    if [[ "$path" == */generate-notes ]]; then
      # The verb is checked, not ignored: the generator is a POST, and answering a
      # GET with a body would hide a script that had drifted onto the wrong method.
      if [[ "$method" != "POST" ]]; then
        echo "fake gh: $path wants POST, got $method" >&2
        exit 70
      fi
      if [[ -n "${FAKE_API_STATUS:-}" ]]; then
        printf '{"message":"Invalid previous_tag parameter","documentation_url":"https://docs.github.com/rest","status":"400"}\n' >&2
        echo "gh: Invalid previous_tag parameter (HTTP 400)" >&2
        exit 1
      fi
      # Emulate `--jq .body`, which prints the DECODED string (raw markdown, then
      # one trailing newline) rather than a JSON-quoted scalar. Getting this wrong
      # in the shim would test the script against a shape it never sees.
      printf '%s\n' "${FAKE_NOTES_BODY:-}"

    elif [[ "$path" =~ ^repos/[^/]+/[^/]+/releases$ ]]; then
      # The release listing. A real `gh api --paginate` walks GitHub's Link
      # headers; walking them is the shim's business, not the script's, so the
      # fixture supplies the PAGES and the shim decides the stream shape. What the
      # shapes are was measured against api.github.com AND against a local
      # two-page server:
      #
      #   --paginate, no --jq          → ONE array holding every page's items,
      #                                  concatenated in page order
      #   --paginate --slurp           → ONE array of per-page arrays
      #   --paginate --jq FILTER       → FILTER RUNS PER PAGE, so a bracketed
      #                                  filter prints one array PER PAGE
      #   no --paginate                → the single page, untouched
      #
      # The first and third are what the real CLI does; the `separate` mode below
      # is the third row's shape REPLAYED without a filter, so the script's
      # aggregation can be exercised against a per-page stream it would not
      # otherwise be handed. That is deliberate: the aggregation is built to be
      # shape-independent, and an assertion only proves that if both shapes are
      # fed to it.
      if [[ -n "${FAKE_RELEASE_LIST_STATUS:-}" ]]; then
        printf '{"message":"Server Error","documentation_url":"https://docs.github.com/rest","status":"%s"}\n' \
          "$FAKE_RELEASE_LIST_STATUS" >&2
        printf 'gh: Server Error (HTTP %s)\n' "$FAKE_RELEASE_LIST_STATUS" >&2
        exit 1
      fi
      pages="${FAKE_RELEASE_PAGES:-}"
      if [[ -z "$pages" ]]; then
        # `FAKE_RELEASE_LIST_RAW` bypasses every jq in this branch on purpose. The
        # listing is a real HTTP response and GitHub can answer 200 with something
        # that is not the documented JSON at all (a proxy page, a gateway's HTML).
        # Building that fixture through the normal path is impossible — the shim's
        # own jq would choke on it, exit non-zero, and the script's REQUEST-failure
        # branch would fire instead of its FILTER-error branch, so the case would
        # duplicate the HTTP-status one and leave the filter untested. Text out the
        # door, exit status 0, and jq is the script's problem.
        if [[ -n "${FAKE_RELEASE_LIST_RAW:-}" ]]; then
          printf '%s\n' "$FAKE_RELEASE_LIST_RAW"
          exit 0
        fi
        pages="[$(printf '%s' "${FAKE_RELEASE_LIST:-[]}")]"
      fi
      if [[ -n "$jq_expr" ]]; then
        # Faithful to `--paginate --jq`: the filter is applied once per page and
        # each page's result is printed as its own JSON value.
        printf '%s\n' "$pages" | jq -c '.[]' | while IFS= read -r page; do
          printf '%s\n' "$page" | jq -c "$jq_expr"
        done
      elif [[ -n "$paginate" && "${FAKE_RELEASE_PAGE_MODE:-merged}" == "separate" ]]; then
        printf '%s\n' "$pages" | jq -c '.[]'
      elif [[ -n "$paginate" ]]; then
        printf '%s\n' "$pages" | jq -c 'add // []'
      else
        printf '%s\n' "$pages" | jq -c '.[0] // []'
      fi

    elif [[ "$path" =~ ^repos/[^/]+/[^/]+/git/ref/tags/ ]]; then
      # The git ref behind the tag. Measured against the live API: an existing
      # tag answers 200, a nonexistent one answers 404 and `gh api` exits 1.
      if [[ "${FAKE_RELEASE_REF_EXISTS:-true}" == "true" ]]; then
        printf '{"ref":"refs/tags/%s","object":{"type":"tag","sha":"0000000"}}\n' \
          "${path##*/git/ref/tags/}"
      else
        printf '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#get-a-reference","status":"404"}\n' >&2
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
      fi

    else
      echo "fake gh: unhandled api path: $path" >&2
      exit 70
    fi
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

# Counts calls to the notes GENERATOR endpoint, and only that one.
#
# It used to count every `gh api` line, which was honest while the script's only
# API call was the generator. The release listing and the git-ref check now go
# through `gh api` too, so a bare `^api ` count would answer "was the endpoint
# reached?" with "was anything called at all?" — and the assertions that pin the
# script's whole reason for existing ("the endpoint was NEVER called for a tag
# that does not exist", "the endpoint is called exactly once") would pass on a
# run that only listed releases. Narrowing the pattern keeps those assertions
# testing the thing they were written to test.
#
# The generator's path also CONTAINS `/releases`, so the listing counter below
# has to exclude it rather than just match on it. Log lines hold raw argv, which
# is why none of these anchor on the leading `api`: `--repo` may legally sit
# before the subcommand, and a case that pinned the flag's position would be
# testing word order rather than reachability.
api_calls() { grep -c 'generate-notes' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null || true; }

# The release LISTING (`GET repos/<owner>/<name>/releases`), the way finding 1 is
# caught. With a pattern it counts only listing calls whose path is addressed to
# the repository a case NAMES, so an unaddressed listing — which real gh would
# resolve from the checkout — cannot be counted as if it had asked the right
# repository. With no pattern it counts every listing call, which is how "asked
# SOME repository" and "asked the RIGHT one" are told apart.
listing_calls() {
  local pattern="${1:-}"
  grep 'releases' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null |
    grep -v 'generate-notes' |
    { [[ -n "$pattern" ]] && grep -- "$pattern" || cat; } |
    grep -c . || true
}

# The git-ref check (`GET repos/<owner>/<name>/git/ref/tags/<tag>`).
ref_calls() { grep -c 'git/ref/tags/' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null || true; }

# The release-OBJECT existence check (`gh release view`). It is not an `api`
# invocation, so it needs its own counter to prove the ref check does not replace
# it and vice versa.
release_view_calls() { grep -c 'release view' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null || true; }

# The listing CALL, as logged — for the assertions that are about the shape of
# that one call (does it paginate? does it pass a per-page `--jq`?) rather than
# about how many calls happened. `grep -v generate-notes` is required, not
# tidiness: the generator's own path contains `/releases`.
listing_command() {
  grep 'releases' "${FAKE_API_LOG:-/dev/null}" 2>/dev/null |
    grep -v 'generate-notes' | head -1
}

# "yes" when the first line matching $2 comes before the first line matching $3.
# Ordering assertions in one place, because WHICH guard runs first is a decision
# with a reason behind it and a reason is worth a line of output.
called_before() {
  local log="$1" first="$2" second="$3" a b
  a="$(grep -n -- "$first" "$log" | head -1 | cut -d: -f1)"
  b="$(grep -n -- "$second" "$log" | head -1 | cut -d: -f1)"
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]] && printf 'yes\n' || printf 'no\n'
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
  {"tag_name":"v0.2.0","draft":false,"prerelease":false},
  {"tag_name":"v0.3.0-rc.1","draft":false,"prerelease":true},
  {"tag_name":"v0.1.1","draft":false,"prerelease":false},
  {"tag_name":"v0.1.5-wip","draft":true,"prerelease":false}
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
  {"tag_name":"v0.3.0","draft":false,"prerelease":false},
  {"tag_name":"v0.2.0","draft":false,"prerelease":false},
  {"tag_name":"v0.1.1","draft":false,"prerelease":false}
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
  {"tag_name":"v0.1.0","draft":false,"prerelease":false,"created_at":"2026-10-15T16:04:39Z"}
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
  {"tag_name":"2024.5.1","draft":false,"prerelease":false},
  {"tag_name":"v0.1.1","draft":false,"prerelease":false}
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
  {"tag_name":"2024.5.1","draft":false,"prerelease":false}
]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "a release list of unparseable tags still produces notes"
assert_not_contains "no unparseable base reaches the endpoint" "previous_tag_name" "$(cat "$dir/api.log")"
assert_contains "the missing base is announced" "no comparison base found" "$stderr"

# ---------------------------------------------------------------------------
# 9. A missing jq is a hard error, announced as SUCH, before anything is called.
#
# The base-derivation filter is jq, so without it there is no comparison base.
# This case used to be the only defence against a specific silent failure: the
# filter ran in a pipeline whose errors were swallowed, so a MISSING jq and a
# legitimately EMPTY listing were indistinguishable and the first produced notes
# about every release the repository has ever had. The listing now fails loudly
# (section 14), which closes that hole structurally — so these assertions moved
# from "it does not widen the notes" to "the run stops at the jq check": naming jq,
# not blaming the release list, and calling NOTHING on the way out. Without those,
# deleting the up-front check would still exit 1 (with a message blaming the
# listing) and this section would keep passing while testing nothing.
# ---------------------------------------------------------------------------
dir="$tmp_root/no-jq"
mkdir -p "$dir"
export FAKE_API_LOG="$dir/api.log"
: >"$FAKE_API_LOG"
export FAKE_RELEASE_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[{"tag_name":"v0.1.1","draft":false,"prerelease":false}]'
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
assert_not_contains "the failure does not blame the release list instead" \
  "could not list" "$stderr"
# The discriminating pair. Removing the up-front check still exits 1 today, but
# only after `gh` has been asked twice and the message blames the listing — so
# "nothing was called" plus "jq is named" together prove the run stopped at the
# check rather than limping into the listing and failing there.
assert_eq "the endpoint is never called without jq" "0" "$(api_calls)"
assert_eq "and NOTHING else is called either — the check precedes every lookup" "0" \
  "$(ref_calls)"
assert_eq "not even the release-object check runs" "0" "$(release_view_calls)"
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
# 11. The summary counts CHANGELOG bullets and nothing else. The header, the
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
# 12. A tag name is attacker-visible input the moment someone pushes
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

# ---------------------------------------------------------------------------
# 13. EVERY `gh` call must name the repository (finding: `--repo` was only
#     honoured by the generator call).
#
# `gh release view` and `gh release list` resolve the repository from the
# CHECKOUT when none is named, while the generator call was given `$repo`. On a
# fork, or after a rename, the checkout's remote is not the repository being
# released, so the existence guard can reject a release that exists upstream —
# blocking a release that should ship — or derive a comparison base from the
# wrong repository's tags. The script's own `--repo` error text already says the
# value is never defaulted for exactly this reason; these cases make the CALLS
# honour what the error text claims.
#
# FAKE_REQUIRE_REPO makes the shim refuse any call that does not name one, which
# is the fork: real gh would quietly ask the wrong repository, and a harness that
# answered anyway would hide the bug.
# ---------------------------------------------------------------------------
dir="$tmp_root/repo-addressed"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_RELEASE_REF_EXISTS=true
export FAKE_RELEASE_LIST_STATUS=''
export FAKE_REQUIRE_REPO=true
export FAKE_RELEASE_PAGE_MODE=merged
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[{"tag_name":"v0.1.1","draft":false,"prerelease":false}]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "generation works on a repository whose checkout remote is not the release repo"
assert_eq "the endpoint is still called exactly once there" "1" "$(api_calls)"
assert_contains "the existence check names the repository explicitly" "--repo o/r" \
  "$(grep 'release view' "$dir/api.log")"
assert_eq "the listing addresses the named repository" "1" \
  "$(listing_calls 'repos/o/r/releases')"
assert_eq "exactly one listing call happens, so no other repository was asked" "1" \
  "$(listing_calls)"
unset FAKE_REQUIRE_REPO

# The harness's own robustness, asserted rather than assumed: the shim dispatches
# on the subcommand, so a `--repo` placed BEFORE it must not be mistaken for one.
# Real gh accepts the flag in either position, so if the shim only worked with the
# script's chosen placement then a future edit moving the flag would fail every
# case for a reason that has nothing to do with the script. One call per position,
# both addressed, both answered.
"$fake_bin/gh" --repo o/r release view v0.2.0 --json tagName >"$dir/pre.log" 2>&1
assert_eq "--repo BEFORE the subcommand is understood by the harness" "v0.2.0" "$(cat "$dir/pre.log")"
"$fake_bin/gh" release view v0.2.0 --json tagName --repo o/r >"$dir/post.log" 2>&1
assert_eq "--repo AFTER the subcommand is understood too" "v0.2.0" "$(cat "$dir/post.log")"

# ---------------------------------------------------------------------------
# 14. A listing that FAILS is not a repository with no previous release
#     (finding: a transient gh failure exited 0 with notes describing everything).
#
# The base lookup used to end in `2>/dev/null || true`, so a 502, a 403 or an
# exhausted rate limit produced `previous=""` — indistinguishable from a genuine
# first release — and the script exited 0 with notes covering every change since
# the beginning. `release.yml` marks this step `continue-on-error: true` and
# falls back to the placeholder, so exit 1 IS the loud, correctly-handled path:
# returning 0 does not merely hide the error, it defeats the workflow's own
# backstop. And the old `note: no comparison base found` line was actively wrong
# here — it told the reader this was a first release.
# ---------------------------------------------------------------------------
dir="$tmp_root/listing-fails"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_RELEASE_REF_EXISTS=true
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[{"tag_name":"v0.1.1","draft":false,"prerelease":false}]'
export FAKE_RELEASE_LIST_STATUS=502
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_fails "a failed release listing exits 1 instead of describing everything"
assert_contains "gh's own reason is quoted, not swallowed" "502" "$stderr"
assert_contains "the failure says which step broke" "could not list" "$stderr"
assert_not_contains "a broken lookup is never reported as a first release" \
  "no comparison base found" "$stderr"
assert_eq "the endpoint is never called when the base is unknown" "0" "$(api_calls)"
assert_eq "no notes file survives an unknown comparison base" "no" "$(path_exists "$dir/out/notes.md")"
unset FAKE_RELEASE_LIST_STATUS

# The other side of the same line: a repository that genuinely HAS no candidate
# must still succeed at exit 0. Without this pair, "fail on lookup errors" is one
# `exit 1` away from breaking every first release.
dir="$tmp_root/listing-empty-ok"
mkdir -p "$dir"
export FAKE_RELEASE_LIST='[]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "a listing that answers with nothing usable still generates notes"
assert_contains "the empty case is announced as the empty case" "no comparison base found" "$stderr"
assert_not_contains "the empty case is not dressed up as an error" "could not list" "$stderr"
assert_eq "stdout is still exactly the summary" "1" "$(printf '%s\n' "$stdout" | grep -c .)"

# A filter that ERRORS on the listing (rather than the request failing) belongs to
# the same class: it says nothing about what the repository actually contains.
dir="$tmp_root/listing-filter-error"
mkdir -p "$dir"
# The listing must ANSWER (exit 0) and hand back garbage. If the harness itself
# rejects the malformed fixture it exits non-zero, the script's REQUEST-failure
# branch fires, and this case silently duplicates the 502 above while the script's
# own filter-error branch stays unexecuted. `FAKE_RELEASE_LIST_RAW` is what makes
# that possible: text out the door, success status, and jq is the script's problem.
export FAKE_RELEASE_LIST_RAW='this is not JSON'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_fails "unparseable listing output exits 1 rather than guessing"
assert_contains "the filter error is named as a filter error" \
  "could not read the release list" "$stderr"
# The discriminating pair, and the reason this case exists separately: a request
# that FAILED says `could not list`. Same symptom, same exit code, different cause
# — and if this assertion ever starts passing on `could not list`, the case has
# quietly become a duplicate of the one above and is testing nothing new.
assert_not_contains "the failure is NOT reported as a request failure" \
  "could not list" "$stderr"
assert_eq "the endpoint is never called on a filter error" "0" "$(api_calls)"
assert_eq "no notes file survives a filter error" "no" "$(path_exists "$dir/out/notes.md")"
unset FAKE_RELEASE_LIST_RAW
export FAKE_RELEASE_LIST='[{"tag_name":"v0.1.1","draft":false,"prerelease":false}]'

# ---------------------------------------------------------------------------
# 15. THE PREDECESSOR BELOW THE WINDOW (finding: `--limit 30` hides it).
#
# `gh release list --limit 30` returns the 30 NEWEST releases. A backport patch
# whose predecessor is older than that — a maintenance line with a long stream of
# newer releases above it — finds no candidate, silently degrades, and publishes
# notes describing every change since the beginning. `--limit -1` and `--limit 0`
# are both rejected by gh (`invalid limit`, exit 1; verified), so there is no
# "everything" keyword — though a large finite limit does page (`--limit 100000`
# returns all 206 releases of cli/cli), so the honest reason to paginate is that a
# magic ceiling is a number someone has to maintain and can get wrong, not that the
# flag cannot be pushed.
#
# The fixture is built so BOTH wrong answers are visible, and it must be read
# with the two shapes of `gh api --paginate` in mind, both measured:
#
#   --paginate  (no --jq)   → ONE array, every page's items concatenated
#   --paginate --jq FILTER  → FILTER RUNS PER PAGE: one result printed per page
#
# Tag v0.2.5. Page 1 is 29 releases ABOVE it plus v0.1.5; page 2 holds the true
# predecessor v0.2.4, plus v0.1.4 and v0.2.0. So:
#   - a 30-entry window sees v0.1.5 and picks it (wrong base, sent happily);
#   - a per-page aggregation prints one max per page — v0.1.5 then v0.2.4 — two
#     lines, which is not a version and so must never reach the endpoint;
#   - only an aggregation ACROSS pages yields v0.2.4.
# ---------------------------------------------------------------------------
# Page 1 is built as 29 releases ABOVE v0.2.5 plus v0.1.5, so it is exactly the
# newest-30 window: `--limit 30` sees those 30 and nothing else, and the greatest
# one below v0.2.5 inside it is v0.1.5. Built with jq rather than string surgery,
# because a fixture whose page size is wrong tests nothing.
page1="$(jq -cn '
  [ range(30; 1; -1) | {tag_name: "v0.9.\(.)", draft: false, prerelease: false} ]
  + [{tag_name: "v0.1.5", draft: false, prerelease: false}]')"
page2='[{"tag_name":"v0.2.4","draft":false,"prerelease":false},{"tag_name":"v0.1.4","draft":false,"prerelease":false},{"tag_name":"v0.2.0","draft":false,"prerelease":false}]'
dir="$tmp_root/deep-predecessor"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_RELEASE_REF_EXISTS=true
export FAKE_REQUIRE_REPO=false
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_PAGES="[$page1,$page2]"
unset FAKE_RELEASE_LIST
# The page shape this fixture is served in is the real one: `--paginate` with no
# `--jq` merges the pages into one array.
export FAKE_RELEASE_PAGE_MODE=merged
run_notes "$dir" --repo o/r --tag v0.2.5 --out out/notes.md
assert_passes "a release whose predecessor sits below the newest-30 window generates"
assert_contains "the true predecessor on page 2 is the comparison base" \
  "previous_tag_name=v0.2.4" "$(cat "$dir/api.log")"
assert_not_contains "the newer-window decoy is never the base" \
  "previous_tag_name=v0.1.5" "$(cat "$dir/api.log")"
assert_not_contains "no window-truncated guess reaches the endpoint" \
  "previous_tag_name=v0.9." "$(cat "$dir/api.log")"
assert_eq "the listing was needed and made" "1" "$(listing_calls 'repos/o/r/releases')"
assert_eq "the listing was the only thing asked for before the endpoint" "1" "$(listing_calls)"
assert_contains "the listing walks every page" "--paginate" "$(listing_command)"
# The degradation, named rather than inferred. A per-page aggregation puts TWO
# tags on two lines here, which the shape guard below the filter then throws away
# — so the run would quietly announce "no comparison base" and describe the whole
# history. Neither note belongs on this fixture: a base EXISTS, two pages down.
assert_not_contains "the derived base is not thrown away as malformed" \
  "dropping the derived comparison base" "$stderr"
assert_not_contains "this repository is not treated as having no comparison base" \
  "no comparison base found" "$stderr"
# A per-page `--jq` on the SAME fixture yields two maxima (v0.1.5, then v0.2.4);
# refusing that construction is what keeps the single-value contract intact.
assert_eq "the listing filters NOTHING per page (--jq would run once per page)" \
  "no" "$(listing_command | grep -c -- '--jq' | awk '{print ($1 > 0) ? "yes" : "no"}')"

# The measured page shape, pinned against the shim so the reason this fixture
# exists does not depend on anyone re-running gh by hand: a bracketed filter under
# `--paginate` yields one array PER PAGE (so a downstream `max_by` computes the
# max per page), while the same two pages with NO `--jq` arrive as ONE merged
# array. Two pages in: two values out with `--jq`, one without.
"$fake_bin/gh" api "repos/o/r/releases" --paginate --jq '[.[] | {tag_name}]' \
  >"$dir/shape-jq.log" 2>&1
assert_eq "--paginate --jq emits one result PER PAGE, not one merged array" \
  "2" "$(grep -c . "$dir/shape-jq.log")"
"$fake_bin/gh" api "repos/o/r/releases" --paginate >"$dir/shape-raw.log" 2>&1
assert_eq "--paginate with no --jq emits ONE merged array instead" \
  "1" "$(jq -s 'length' <"$dir/shape-raw.log")"
assert_eq "…and that one array holds BOTH pages' releases" \
  "33" "$(jq 'length' <"$dir/shape-raw.log")"

# The aggregation is slurp-and-flatten, so it does not CARE which shape it is
# handed. `mode=separate` WITHOUT `--jq` is not something real gh prints (real gh
# merges when there is no filter) — it is the per-page array stream that
# `--paginate --jq '[…]'` produces, replayed here without the filter so the
# aggregation can be exercised against it directly. Serving the identical fixture
# that way must still find v0.2.4: that is what turns "we dodged the measured trap"
# into "the answer does not depend on the page shape", and it is the assertion that
# would catch someone dropping the `-s`.
export FAKE_RELEASE_PAGE_MODE=separate
run_notes "$dir" --repo o/r --tag v0.2.5 --out out/second-shape.md
assert_passes "the same releases served as a per-page STREAM still generate"
assert_contains "and the base is the same tag as under the merged shape" \
  "previous_tag_name=v0.2.4" "$(cat "$dir/api.log")"
export FAKE_RELEASE_PAGE_MODE=merged

unset FAKE_RELEASE_PAGES

# ---------------------------------------------------------------------------
# 16. The release OBJECT is not the git REF (finding: the guard checked one, the
#     header promised the other).
#
# `gh release view` proves a release OBJECT exists. It says nothing about the tag
# being there — and a deleted tag is one of the two cases the file's header names
# as the reason this script exists at all ("a tag deleted between the push and the
# step"). Notes generated for a release whose tag is gone describe a comparison
# range GitHub cannot resolve, so the ref is checked too.
#
# ORDER, deliberately: release object FIRST, then ref. A typo'd tag fails the
# first check and gets the message the script was written to give ("no release
# exists for v9.9.9"); the ref check is then only ever reached for a tag that DOES
# have a release, which is the narrower, stranger case — an orphaned release — so
# each message means exactly one thing. Both run before the listing and before the
# endpoint: deriving a comparison base for a release that will not be described is
# wasted calls, and calling the endpoint first is the bug this whole file exists
# to prevent.
# ---------------------------------------------------------------------------
dir="$tmp_root/ref-missing"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_RELEASE_REF_EXISTS=false
export FAKE_NOTES_BODY="$generated_body"
export FAKE_RELEASE_LIST='[{"tag_name":"v0.1.1","draft":false,"prerelease":false}]'
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_fails "a release whose git tag is gone exits 1"
assert_contains "the failure says the TAG is missing, not the release" "tag" "$stderr"
assert_contains "the failure names the tag it looked for" "v0.2.0" "$stderr"
assert_eq "the endpoint is never called when the tag is gone" "0" "$(api_calls)"
assert_eq "no notes file is written for a tag that does not exist" "no" "$(path_exists "$dir/out/notes.md")"
assert_eq "the ref was actually asked about" "1" "$(ref_calls)"
assert_eq "the release-object guard still runs (the ref check ADDS to it)" "1" "$(release_view_calls)"
assert_eq "stdout stays empty on this failure" "" "$stdout"

# Ordering, as decided above: the release-object check runs before the ref check,
# and the ref check runs before anything is listed or generated.
assert_eq "the release-object guard runs before the ref guard" "yes" \
  "$(called_before "$dir/api.log" 'release view' 'git/ref/tags/')"
# Stronger than an ordering check, and the true shape: with the ref missing there
# is NO listing at all, so nothing is derived for a tag that will not be described.
# An ordering assertion here would compare against a call that never happens.
assert_eq "nothing is listed once the ref guard has refused" "0" "$(listing_calls)"
export FAKE_RELEASE_REF_EXISTS=true

# And a healthy tag still passes both guards — otherwise "check the ref too" is
# just a new way to fail every release.
dir="$tmp_root/ref-present"
mkdir -p "$dir"
run_notes "$dir" --repo o/r --tag v0.2.0 --out out/notes.md
assert_passes "a release with its tag behind it passes both guards"
assert_eq "the ref check addressed the named repository" "1" \
  "$(grep -c "repos/o/r/git/ref/tags/v0.2.0" "$dir/api.log")"
# The other half of the ordering decision, measurable here because the healthy
# path reaches both: the ref guard is settled BEFORE any base is derived.
assert_eq "both guards run before the listing" "yes" \
  "$(called_before "$dir/api.log" 'git/ref/tags/' 'releases')"
assert_eq "the endpoint is called once on the healthy path" "1" "$(api_calls)"
assert_eq "stdout is still exactly one line with two guards in place" "1" \
  "$(printf '%s\n' "$stdout" | grep -c .)"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
