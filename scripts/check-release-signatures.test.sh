#!/usr/bin/env bash
# Tests for scripts/check-release-signatures.sh.
#
# WHY THIS SCRIPT HAS TESTS AT ALL. The check it replaces was a sentence in
# AGENTS.md — "count distinct `.platforms[].url` basenames in the shipped
# manifest and require a `.sig` for each" — and that sentence was VACUOUS:
# `compose-updater-manifest.sh` derives its platform keys FROM the `.sig` files
# it was handed, so a signature that was never uploaded removes the target from
# BOTH sides of that comparison at once. It passed exactly when it should have
# failed (issue #41(d)). The replacement asks the question of the RELEASE — every
# installer asset on the release must have a `<name>.sig` beside it — and a
# question asked of a live GitHub release cannot be tested without a fixture, so
# this file is the whole proof that the gate works.
#
# Four failure modes the fixtures exist to kill, each with a case below:
#
#   1. The allow-list. A `.dmg` is never an updater payload and has no `.sig`,
#      and `latest.json` IS the manifest, so demanding a signature for either
#      fails every real release. Case 4 pins it.
#   2. Counting instead of pairing. The ratio of sigs to manifest keys is NOT
#      1:1 — four signatures legitimately serve six keys, because
#      `createUpdaterArtifacts: true` makes the installer itself the payload and
#      `windows-x86_64`/`-nsis` share one `.exe`. Reading that as "2 sigs
#      missing" nearly withheld v0.3.1 (ADR 0052's first amendment records it),
#      so NOTHING here may compare a file count to a key count: case 6 pins the
#      healthy 4-installer/6-key shape as HEALTHY, and case 15 pins the pairing
#      — equal counts, wrong pairing — as a failure.
#   3. Vacuity in the new direction too. A release with no installers at all
#      would satisfy "every installer has a sig" by having nothing to check, so
#      the empty asset list is a failure in itself (case 5).
#   4. PAIRING CHECKED ONE WAY ONLY. The allow-list skips every `*.sig` as a
#      PAYLOAD, which is not the same as ignoring it: a `X.sig` sitting on the
#      release with no `X` beside it makes the composer emit a platform key whose
#      URL is not on the release — a 404 every client on that platform downloads,
#      at exit 0. Case 16 pins the mirror direction; case 17 pins its WIDTH (all
#      eight bundler shapes, not just the two convenient ones) and the shared
#      source of truth that keeps it as wide as the composer's matcher.
#
# `gh` is replaced by a shim on PATH (below): no network, deterministic, and the
# shim records every invocation so a case can assert what was ASKED — `--repo`
# reaching `gh` is fork safety, not decoration (case 9). The shim answers
# `gh release view --json assets` and NOTHING else: `gh release download` and
# `gh api` exit 70, so an implementation that reaches for the manifest's
# CONTENTS fails loudly instead of being served a convenient answer. That refusal
# is what keeps the check from ever re-learning to read the manifest it is
# supposed to be independent of.
#
# Plain bash, not vitest: same convention as check-versions.test.sh,
# compose-updater-manifest.test.sh and release-notes.test.sh, and the same CI bar
# (the `scripts` job of .github/workflows/ci.yml runs this file).
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check_script="$test_dir/check-release-signatures.sh"

# Fail loudly rather than letting every case die with 126: a missing script
# under test is a different bug from a wrong exit code, and it is the first thing
# a TDD run needs to be told.
if [[ ! -f "$check_script" ]]; then
  echo "FATAL: $check_script does not exist — implement it before running these tests." >&2
  exit 1
fi

# The integration pin (case 13) reads the workflow this gate has to sit inside,
# and it reads it as TEXT. If the file is missing the pin cannot run at all, so
# it is a harness-level FATAL rather than one failed assertion: a silently
# skipped ordering check is the exact drift this case exists to catch.
workflow_file="$test_dir/../.github/workflows/release.yml"
if [[ ! -f "$workflow_file" ]]; then
  echo "FATAL: $workflow_file does not exist — the step-ordering pin cannot run." >&2
  exit 1
fi

# jq only, NOT gh: `gh` is replaced by the fixture shim below, so requiring the
# real binary would stop these tests running on a machine with nothing to test
# against. jq is genuinely used — by the fixture builder and by the script.
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
# It answers ONE thing: `gh release view TAG --json assets --repo R`, printing the
# document held in FAKE_ASSETS_JSON. Everything else exits 70 with a message, so
# a script that drifts onto `gh release download` (to read latest.json's
# contents) or `gh api` is caught rather than flattered.
#
# Fixture inputs (exported per case):
#   FAKE_ASSETS_JSON     the document `gh release view --json assets` prints.
#                        Measured shape against the live v0.6.0 release with gh
#                        2.97.0: {"assets":[{"name":…,"state":"uploaded"|"pending",
#                        "size":…,"contentType":…,"downloadCount":…,"url":…},…]}.
#                        The fixtures below carry `name` and `state` only, which
#                        is all the script is allowed to read.
#   FAKE_ASSETS_RAW      set (even to empty) → the view prints THAT verbatim and
#                        nothing else, ignoring FAKE_ASSETS_JSON. It exists for the
#                        one input shape a JSON-building helper cannot express: a
#                        `gh` that exits 0 and prints something which is not an
#                        asset list at all — a proxy's HTML error page, gh's own
#                        secondary-rate-limit notice, or an empty body. Case 18 pins
#                        what the gate makes of all three.
#   FAKE_RELEASE_EXISTS  false → the view exits 1 with gh's own "not found" text,
#                        for the typo'd-tag case.
#   FAKE_REQUIRE_REPO    true → the view REFUSES to run without an explicit
#                        `--repo`. That is the fork simulation: real gh resolves
#                        the repository from the CHECKOUT when none is named, and
#                        on a fork or a renamed repo that checkout is not the
#                        repository being released — so the harness refuses to
#                        guess rather than quietly agreeing.
#   FAKE_API_LOG         file every shim invocation appends one argv line to.
# ---------------------------------------------------------------------------
fake_bin="$tmp_root/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/gh" <<'SHIM'
#!/usr/bin/env bash
set -uo pipefail

log="${FAKE_API_LOG:-/dev/null}"
printf '%s\n' "$*" >>"$log"

# --- flag normalisation, BEFORE dispatch ------------------------------------
# Real `gh` accepts `--repo`/`-R` anywhere in argv, before the subcommand as well
# as after it. A shim that dispatched on $1/$2 would crash on
# `gh --repo o/r release view …`, and every case would then be failing because of
# the shim's parsing rather than the script's. Pull the repository flag out
# wherever it sits and dispatch on what is left.
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
        if [[ "${FAKE_REQUIRE_REPO:-false}" == "true" && -z "$repo_flag" ]]; then
          echo "gh: could not resolve a repository — the caller must name one" >&2
          exit 1
        fi
        # FAKE_ASSETS_RAW takes precedence over everything below: it is the ONE way
        # to make `gh` exit 0 and print something that is not JSON, which no
        # document-building helper can express. It stands in for the three shapes
        # measured against the real world — a proxy's HTML error page, gh's own
        # secondary-rate-limit notice, and an empty body — all of which arrive with
        # a zero exit, and all of which the gate must refuse rather than parse.
        # Set-ness, not `-n`: an EMPTY value is itself one of the shapes, so the
        # variable being set at all is what switches modes.
        if [[ -n "${FAKE_ASSETS_RAW+set}" ]]; then
          printf '%s\n' "$FAKE_ASSETS_RAW"
          exit 0
        fi
        if [[ "${FAKE_RELEASE_EXISTS:-true}" != "true" ]]; then
          printf 'gh: Not Found (HTTP 404)\n' >&2
          echo "release not found" >&2
          exit 1
        fi
        # The default document is built on its own line rather than inside
        # `${VAR:-{…}}`: bash eats the braces and the quotes of a JSON default
        # written inline there, and the shim would then print invalid JSON.
        doc="${FAKE_ASSETS_JSON-}"
        if [[ -z "$doc" ]]; then
          doc='{"assets":[]}'
        fi
        printf '%s\n' "$doc"
        ;;
      *)
        # `gh release download` is refused on purpose: the manifest's CONTENTS are
        # not this check's input (that comparison is the vacuity being retired),
        # and answering it would let a regression back to it pass quietly.
        echo "fake gh: unhandled subcommand: $*" >&2
        exit 70
        ;;
    esac
    ;;
  *)
    echo "fake gh: unhandled command: $*" >&2
    exit 70
    ;;
esac
SHIM
chmod +x "$fake_bin/gh"

# make_assets NAME... — a release-shaped fixture, written as the list of asset
# names it is. `state` is "uploaded" for every entry because no case here is
# about upload state (case 10 writes its own document for that); carrying the
# field at all is what makes the fixtures shaped like the real API rather than
# like a bare string list.
make_assets() {
  jq -cn --args '{assets: ($ARGS.positional | map({name: ., state: "uploaded"}))}' -- "$@"
}

repo="o/r"
tag="v0.2.0"

# The healthy release's payload names, in the shapes the bundlers really produce
# (dash/dot spelling for the rpm, underscore/`amd64` for the deb and AppImage,
# `x64-setup.exe` for NSIS — see the composer's pattern arms for why).
rpm="Archimedes-0.2.0-1.x86_64.rpm"
appimage="Archimedes_0.2.0_amd64.AppImage"
deb="Archimedes_0.2.0_amd64.deb"
exe="Archimedes_0.2.0_x64-setup.exe"

# The four installers of a healthy Linux+Windows release, in the order the script
# prints them: `LC_ALL=C sort`, which is byte order (`-` sorts before `_`, which
# is NOT what the runner's en_US.UTF-8 collation does), and is the order the
# workflow feeds back to the composer as `--require-payload` arguments.
expected_healthy_stdout="$(
  printf '%s\n' "$rpm" "$appimage" "$deb" "$exe" | LC_ALL=C sort
)"

# run_check DIR ARGS... — runs the script with the shim on PATH.
#
# stdout and stderr are captured SEPARATELY because for this script that split IS
# the contract: stdout is the machine-consumed installer-payload list that
# release.yml redirects into a file and feeds to the composer, so it must hold
# nothing but those names; every diagnostic belongs on stderr. Merging them the
# way the composer's harness does would let a chatty script pass as if it were a
# pipe. `|| status=$?` keeps `set -e` from aborting on the exits asserted below.
run_check() {
  local dir="$1"
  shift
  export PATH="$fake_bin:$PATH"
  export FAKE_API_LOG="$dir/gh.log"
  : >"$FAKE_API_LOG"
  local stdout_file="$dir/.stdout" stderr_file="$dir/.stderr"
  status=0
  (cd "$dir" && "$check_script" "$@" >"$stdout_file" 2>"$stderr_file") || status=$?
  stdout="$(cat "$stdout_file")"
  stderr="$(cat "$stderr_file")"
  output="$(cat "$stdout_file" "$stderr_file")"
}

# How many times the shim was asked anything at all — the argument-validation and
# missing-binary cases must call NOTHING.
gh_calls() { grep -c . "${FAKE_API_LOG:-/dev/null}" 2>/dev/null || true; }

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

# ---------------------------------------------------------------------------
# 1. The real healthy shape, measured against v0.6.0: four installers, four
#    signatures, `latest.json`. Exit 0, and stdout is EXACTLY the four installer
#    names — nothing else, in the script's `LC_ALL=C` sort order. The comparison
#    is byte-exact rather than "contains" because release.yml redirects this
#    stdout into a file and turns every line into a `--require-payload` flag: a
#    diagnostic that leaked onto stdout would become an argument the composer
#    rejects, and a reordered list would make the workflow's argument order
#    depend on the runner's locale.
# ---------------------------------------------------------------------------
dir="$tmp_root/healthy"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=true
export FAKE_REQUIRE_REPO=false
export FAKE_ASSETS_JSON="$(make_assets \
  "$rpm" "$rpm.sig" "$appimage" "$appimage.sig" "$deb" "$deb.sig" "$exe" "$exe.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "a release where every installer has its .sig exits 0"
assert_eq "stdout is exactly the signed installer payload list, one per line" \
  "$expected_healthy_stdout" "$stdout"
assert_eq "stdout is four lines and nothing else" "4" "$(printf '%s\n' "$stdout" | grep -c .)"

# ---------------------------------------------------------------------------
# 2. The hole this script exists for: a built-but-unsigned installer. The deb is
#    on the release, its `.deb.sig` never was. The composer would emit a
#    shrunken manifest and exit 0; this gate exits 1 naming BOTH the installer
#    and the signature that is missing, so the operator knows which file to
#    upload rather than which platform went missing.
# ---------------------------------------------------------------------------
dir="$tmp_root/unsigned-deb"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$rpm" "$rpm.sig" "$appimage" "$appimage.sig" "$deb" "$exe" "$exe.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "an installer with no .sig beside it exits 1"
assert_contains "the failure names the unsigned installer" "$deb" "$output"
assert_contains "the failure names the signature that is missing" "$deb.sig" "$output"
assert_eq "nothing is printed on stdout — an incomplete release has no payload list" \
  "" "$stdout"

# ---------------------------------------------------------------------------
# 3. THE #41(d) REGRESSION, release side: the rpm and the Windows installer are
#    both built and neither is signed — the exact fixture that made the pre-
#    change composer print "3 platform key(s)" and exit 0. Both offenders are
#    reported in ONE run: a gate that stops at the first forces a rebuild-and-
#    recheck loop, and the operator has to be able to see the whole hole.
# ---------------------------------------------------------------------------
dir="$tmp_root/unsigned-rpm-and-exe"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$rpm" "$appimage" "$appimage.sig" "$deb" "$deb.sig" "$exe" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "two unsigned installers exit 1"
assert_contains "the unsigned rpm is named" "$rpm" "$output"
assert_contains "the rpm's missing signature is named" "$rpm.sig" "$output"
assert_contains "the unsigned Windows installer is named" "$exe" "$output"
assert_contains "the Windows installer's missing signature is named" "$exe.sig" "$output"
# The needle carries the COUNT AND THE NOUN, because the bare "2" this assertion
# used to pass could never go red: every message on this path contains the tag
# `v0.2.0`, so "2" is a substring of the output no matter what the script counts.
# A mutation that reported one offender where two exist, or that dropped the count
# line entirely, was invisible. "2 of 4" is the shape of the actual sentence
# (`error: 2 of 4 installer asset(s) …`), and case 3b below pins the sibling
# sentence against a ONE-offender fixture, so the count is shown to move with the
# input rather than being a constant of the fixture.
assert_contains "the failure counts the offenders (2 of the 4 installers)" "2 of 4 installer" "$output"

# ---------------------------------------------------------------------------
# 3b. THE SAME SENTENCE WITH ONE OFFENDER. Case 3's needle ("2 of 4 installer")
#     is only meaningful if the two numbers are the script's, not the fixture's
#     vocabulary, so this case is case 3 with the rpm's signature restored: one
#     unsigned installer out of four. Together the two cases pin that the count
#     MOVES with the input — a hard-coded "2 of 4", or a count taken from the
#     installer list rather than the offender list, cannot satisfy both.
# ---------------------------------------------------------------------------
dir="$tmp_root/one-offender"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$rpm" "$rpm.sig" "$appimage" "$appimage.sig" "$deb" "$deb.sig" "$exe" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "one unsigned installer exits 1"
assert_contains "the failure counts ONE offender out of the four installers" "1 of 4 installer" "$output"
assert_not_contains "and does not claim two offenders when there is one" "2 of 4 installer" "$output"
assert_contains "the lone offender is the Windows installer" "$exe -> missing $exe.sig" "$output"

# ---------------------------------------------------------------------------
# 4. THE ALLOW-LIST. A `.dmg` is never an updater payload and carries no `.sig`
#    at all (README: "a `.dmg` gets no `.sig` at all and is never an updater
#    payload"), and `latest.json` is the manifest rather than a payload. Without
#    the skip list the gate fails on every macOS release. The `.sig` entries are
#    skipped too — they are signatures, not installers, so treating them as
#    payloads would demand `X.sig.sig`.
# ---------------------------------------------------------------------------
dir="$tmp_root/macos-shape"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "Archimedes.app.tar.gz" "Archimedes.app.tar.gz.sig" \
  "Archimedes_0.2.0_amd64.dmg" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "a release with an unsigned .dmg and the manifest is complete"
assert_not_contains "the .dmg is never reported as an installer" "Archimedes_0.2.0_amd64.dmg" "$stdout"
assert_not_contains "the manifest itself is never reported as an installer" "latest.json" "$stdout"
assert_eq "stdout holds the one real updater payload" "Archimedes.app.tar.gz" "$stdout"

# ---------------------------------------------------------------------------
# 5. THE ANTI-VACUITY GATE. A release whose only asset is `latest.json` has zero
#    installers, so "every installer has a signature" is satisfied by having
#    nothing to check — the same class of bug this whole task exists to fix, one
#    level up. An empty (or absent) asset list is a FAILURE, not a pass.
# ---------------------------------------------------------------------------
dir="$tmp_root/manifest-only"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "a release carrying nothing but latest.json exits 1"
assert_contains "the failure says there are no installer assets at all" "no installer assets" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

# `{"assets":null}` and `{"assets":[]}` are the same state through the script's
# `[.assets[]?]`, and they are the shapes a release whose assets never uploaded
# actually has. Pinned because the guard is load-bearing, not defensive: without
# it the loop below passes vacuously on all three.
for empty_doc in '{"assets":[]}' '{"assets":null}' '{}'; do
  dir="$tmp_root/empty-assets"
  mkdir -p "$dir"
  export FAKE_ASSETS_JSON="$empty_doc"
  run_check "$dir" --repo "$repo" --tag "$tag"
  assert_fails "an asset document with no installers in it ($empty_doc) exits 1"
done

# ---------------------------------------------------------------------------
# 6. THE ANTI-RATIO CASE. Four installers, four signatures, and a `latest.json`
#    carrying SIX platform keys — the real v0.6.0 shape, because
#    `windows-x86_64`/`-nsis` share one `.exe` and `linux-x86_64`/`-appimage`
#    share one `.AppImage`. This is the direct falsification of the "4 sigs,
#    6 keys ⇒ 2 sigs missing" phantom that nearly withheld v0.3.1: the check never
#    reads the manifest, so the key count cannot move its verdict.
#
#    The six-key document below is DECORATION — the shim serves asset NAMES only
#    and refuses every command that could read a file's contents (exit 70), which
#    is exactly why a manifest-reading implementation goes RED here rather than
#    green. What is being pinned is that 4 installers next to a 6-key manifest is
#    HEALTHY, and that the only thing the script is allowed to look at is the
#    asset list.
# ---------------------------------------------------------------------------
six_key_manifest='{
  "version": "0.2.0",
  "platforms": {
    "linux-x86_64":          {"url": "…/Archimedes_0.2.0_amd64.AppImage"},
    "linux-x86_64-appimage": {"url": "…/Archimedes_0.2.0_amd64.AppImage"},
    "linux-x86_64-deb":      {"url": "…/Archimedes_0.2.0_amd64.deb"},
    "linux-x86_64-rpm":      {"url": "…/Archimedes-0.2.0-1.x86_64.rpm"},
    "windows-x86_64":        {"url": "…/Archimedes_0.2.0_x64-setup.exe"},
    "windows-x86_64-nsis":   {"url": "…/Archimedes_0.2.0_x64-setup.exe"}
  }
}'
dir="$tmp_root/six-keys-four-sigs"
mkdir -p "$dir"
# The manifest asset carries a contentType and a size, as the real API reports —
# the six-key document above is what such an asset WOULD hold, recorded here so
# the reader can see the 6-vs-4 shape the check must be blind to.
export FAKE_ASSETS_JSON="$(jq -cn --argjson keys "$six_key_manifest" \
  --arg rpm "$rpm" --arg appimage "$appimage" --arg deb "$deb" --arg exe "$exe" '
  {assets: (
      [{name: $rpm, state: "uploaded"}, {name: "\($rpm).sig", state: "uploaded"},
       {name: $appimage, state: "uploaded"}, {name: "\($appimage).sig", state: "uploaded"},
       {name: $deb, state: "uploaded"}, {name: "\($deb).sig", state: "uploaded"},
       {name: $exe, state: "uploaded"}, {name: "\($exe).sig", state: "uploaded"},
       {name: "latest.json", state: "uploaded", contentType: "application/json",
        size: 1024, platform_key_count: ($keys.platforms | length)}
     ])}')"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "four installers beside a SIX-key manifest is healthy, not '2 sigs missing'"
assert_eq "the same four installers are printed" "$expected_healthy_stdout" "$stdout"
assert_eq "the number of manifest keys is not consulted" "6" \
  "$(printf '%s' "$FAKE_ASSETS_JSON" | jq '.assets[] | select(.name == "latest.json") | .platform_key_count')"

# ---------------------------------------------------------------------------
# 7. No signature is ever treated as an installer: nothing on stdout ends in
#    `.sig`, so no path in the script can demand `X.sig.sig`.
# ---------------------------------------------------------------------------
dir="$tmp_root/sigs-are-not-installers"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$rpm" "$rpm.sig" "$appimage" "$appimage.sig" "$deb" "$deb.sig" "$exe" "$exe.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "the fixture with all four signatures passes"
assert_eq "no stdout line ends in .sig — a signature is never an installer" "0" \
  "$(printf '%s\n' "$stdout" | grep -c '\.sig$')"
assert_eq "and the failure path never demands one either" "0" \
  "$(printf '%s\n' "$output" | grep -c '\.sig\.sig')"

# ---------------------------------------------------------------------------
# 8. A tag with no release behind it. The distinction matters: "the release does
#    not exist" and "the release has no installers" send the operator to
#    completely different places, and a typo'd tag must not read as a healthy
#    empty release (which is what a `|| echo ""` would produce).
# ---------------------------------------------------------------------------
dir="$tmp_root/missing-release"
mkdir -p "$dir"
export FAKE_RELEASE_EXISTS=false
export FAKE_ASSETS_JSON="$(make_assets "$deb" "$deb.sig")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "a tag with no release behind it exits 1"
assert_contains "the failure names the tag so a typo is obvious" "$tag" "$output"
assert_contains "gh's own reason is quoted rather than swallowed" "release not found" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"
export FAKE_RELEASE_EXISTS=true

# ---------------------------------------------------------------------------
# 9. `--repo` reaches `gh` (fork safety). An unaddressed `gh` call resolves the
#    repository from the CHECKOUT, which on a fork or a renamed repository is not
#    the repository being released — the same argument release-notes.sh makes,
#    verbatim. Asserted twice: once as the argv the shim recorded, once by making
#    the shim REFUSE an unaddressed call so a regression to checkout-resolution
#    cannot be served a convenient answer.
# ---------------------------------------------------------------------------
dir="$tmp_root/repo-addressed"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets "$deb" "$deb.sig")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_contains "the release view names the repository explicitly" "--repo $repo" "$(cat "$dir/gh.log")"
export FAKE_REQUIRE_REPO=true
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "the check works where the checkout remote is not the release repository"
assert_eq "the release was viewed exactly once" "1" "$(gh_calls)"
unset FAKE_REQUIRE_REPO

# The harness's own robustness: real gh accepts `--repo` on either side of the
# subcommand, so the shim dispatches on what is LEFT after pulling it out.
# Otherwise a future edit moving the flag would fail every case for a reason that
# has nothing to do with the script. With no fixture document set, the shim serves
# its empty default, so the answer is a parseable zero-asset document either way.
unset FAKE_ASSETS_JSON
"$fake_bin/gh" --repo "$repo" release view "$tag" --json assets >"$dir/pre.log" 2>&1
assert_eq "--repo BEFORE the subcommand is understood by the harness" \
  "0" "$(jq -r '.assets | length' "$dir/pre.log")"
"$fake_bin/gh" release view "$tag" --json assets --repo "$repo" >"$dir/post.log" 2>&1
assert_eq "--repo AFTER the subcommand is understood too" \
  "0" "$(jq -r '.assets | length' "$dir/post.log")"
export FAKE_ASSETS_JSON="$(make_assets "$deb" "$deb.sig")"

# ---------------------------------------------------------------------------
# 10. `state` is NOT consulted. gh exposes `uploaded` / `pending` per asset
#     (measured against v0.6.0), and filtering on `uploaded` would let a pending
#     installer with a pending signature through — a claim about an upload that
#     has not finished, which is not a claim worth making. Presence of the NAME
#     is what "a sig beside it" means.
# ---------------------------------------------------------------------------
dir="$tmp_root/pending-asset"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(jq -cn --arg deb "$deb" \
  '{assets: [{name: $deb, state: "pending"}, {name: "latest.json", state: "uploaded"}]}')"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "a pending installer with no signature still exits 1"
assert_contains "the pending installer is named, not skipped as in-flight" "$deb" "$output"

# ---------------------------------------------------------------------------
# 11. Argument validation. Both flags are required and neither is defaulted from
#     the checkout or from the current directory; the tag shape is the same regex
#     release-notes.sh applies, with the same reasoning (a tag name is text
#     someone pushed, and the strongest guard is refusing the shape rather than
#     quoting it).
# ---------------------------------------------------------------------------
dir="$tmp_root/args"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets "$deb" "$deb.sig")"

run_check "$dir" --repo "$repo"
assert_fails "a missing --tag exits 1"
assert_contains "the missing flag is named" "--tag" "$output"
assert_eq "nothing is called when the arguments are wrong" "0" "$(gh_calls)"

run_check "$dir" --tag "$tag"
assert_fails "a missing --repo exits 1"
assert_contains "the missing repository flag is named" "--repo" "$output"
assert_eq "nothing is called when the repo is missing" "0" "$(gh_calls)"

run_check "$dir" --repo "$repo" --tag 0.2.0
assert_fails "a --tag without the v prefix exits 1"
assert_contains "the bare version is named in the failure" "0.2.0" "$output"
assert_eq "a bare version never reaches gh" "0" "$(gh_calls)"

run_check "$dir" --repo "$repo" --tag 'v0.2.0; curl evil'
assert_fails "a tag carrying a shell metacharacter exits 1"
assert_eq "a hostile tag never reaches gh" "0" "$(gh_calls)"

run_check "$dir" --repo "$repo" --tag "$tag" --require-sigs
assert_fails "an unknown flag exits 1"
assert_contains "the unknown flag is named" "--require-sigs" "$output"

# A value-taking flag with no value must say so, not die silently: `shift 2` past
# the end of argv under `set -e` exits 1 with no message at all, which is the
# behaviour the composer's existing flags have and this script deliberately does
# not copy.
run_check "$dir" --repo "$repo" --tag
assert_fails "--tag as the final argument with no value exits 1"
assert_contains "and it says which flag needs a value" "--tag" "$output"
run_check "$dir" --tag "$tag" --repo
assert_fails "--repo as the final argument with no value exits 1"
assert_contains "and it says which flag needs a value (repo)" "--repo requires a value" "$output"

# ---------------------------------------------------------------------------
# 12. A missing `gh` or `jq` is a hard error naming the tool, before anything is
#     attempted. PATH is rebuilt from the system directories minus the tool under
#     test — narrowing it to the shim alone would leave the shebang unable to find
#     `bash`, and a 127 from the interpreter would "pass" an assertion about jq
#     for the wrong reason.
# ---------------------------------------------------------------------------
system_bins=()
for system_bin in /usr/bin /bin; do
  [[ -d "$system_bin" ]] && system_bins+=("$system_bin")
done
if [[ ${#system_bins[@]} -eq 0 ]]; then
  echo "FATAL: no system bin directory found — the missing-binary cases cannot run here." >&2
  exit 1
fi

no_gh_bin="$tmp_root/bin-no-gh"
mkdir -p "$no_gh_bin"
for system_bin in "${system_bins[@]}"; do
  for entry in "$system_bin"/*; do
    name="${entry##*/}"
    [[ "$name" == "gh" ]] && continue
    [[ -e "$no_gh_bin/$name" ]] || ln -s "$entry" "$no_gh_bin/$name" 2>/dev/null || true
  done
done

no_jq_bin="$tmp_root/bin-no-jq"
mkdir -p "$no_jq_bin"
for system_bin in "${system_bins[@]}"; do
  for entry in "$system_bin"/*; do
    name="${entry##*/}"
    [[ "$name" == "jq" ]] && continue
    [[ -e "$no_jq_bin/$name" ]] || ln -s "$entry" "$no_jq_bin/$name" 2>/dev/null || true
  done
done
# gh is present for the jq case (so the jq check is what stops the run) and absent
# for the gh case (so gh's check is what stops it).
ln -sf "$fake_bin/gh" "$no_jq_bin/gh"

dir="$tmp_root/missing-binaries"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets "$deb" "$deb.sig")"

if [[ -e "$no_gh_bin/gh" ]] || ! [[ -x "$no_gh_bin/bash" ]] || ! [[ -x "$no_gh_bin/jq" ]]; then
  echo "FATAL: could not build a gh-free PATH — the missing-gh case cannot run here." >&2
  exit 1
fi
status=0
(cd "$dir" && PATH="$no_gh_bin" "$check_script" --repo "$repo" --tag "$tag" \
  >"$dir/.stdout" 2>"$dir/.stderr") && status=0 || status=$?
stdout="$(cat "$dir/.stdout")"
stderr="$(cat "$dir/.stderr")"
output="$stdout$stderr"
assert_fails "a missing gh exits 1"
assert_contains "the failure names gh" "gh is required" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

if [[ -e "$no_jq_bin/jq" ]] || ! [[ -x "$no_jq_bin/bash" ]] || ! [[ -x "$no_jq_bin/gh" ]]; then
  echo "FATAL: could not build a jq-free PATH — the missing-jq case cannot run here." >&2
  exit 1
fi
status=0
(cd "$dir" && PATH="$no_jq_bin" "$check_script" --repo "$repo" --tag "$tag" \
  >"$dir/.stdout" 2>"$dir/.stderr") && status=0 || status=$?
stdout="$(cat "$dir/.stdout")"
stderr="$(cat "$dir/.stderr")"
output="$stdout$stderr"
assert_fails "a missing jq exits 1"
assert_contains "the failure names jq" "jq is required" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

# ---------------------------------------------------------------------------
# 13. INTEGRATION PIN — the wiring, not the script.
#
# A gate that silently moves BELOW the thing it gates restores the vacuity with
# nothing red anywhere: compose `latest.json` first and the manifest's own URLs
# are again a projection of the signatures, so the ordering is the design and not
# a preference. Same for the composer's `--require-payload` flags — a compose step
# that quietly drops them leaves the manual path unprotected. The `scripts` job is
# the only place in the repo that can see either drift, so it reads the YAML as
# text: `grep -n` on the two step names and an integer comparison, no YAML parser.
# ---------------------------------------------------------------------------
completeness_line="$(grep -n 'name: Check every installer asset is signed' "$workflow_file" | head -1 | cut -d: -f1 || true)"
compose_line="$(grep -n 'name: Compose latest.json' "$workflow_file" | head -1 | cut -d: -f1 || true)"
assert_eq "the completeness step exists in release.yml" "yes" \
  "$([[ -n "$completeness_line" ]] && printf 'yes\n' || printf 'no\n')"
assert_eq "the compose step exists in release.yml" "yes" \
  "$([[ -n "$compose_line" ]] && printf 'yes\n' || printf 'no\n')"
if [[ -n "$completeness_line" && -n "$compose_line" ]]; then
  assert_eq "the completeness gate runs BEFORE the manifest is composed" "yes" \
    "$( ((completeness_line < compose_line)) && printf 'yes\n' || printf 'no\n')"
  # The compose step's body: from its own `- name:` line up to the next one.
  compose_body="$(awk -v start="$compose_line" '
    NR < start { next }
    NR > start && /- name: / { exit }
    { print }
  ' "$workflow_file")"
  assert_contains "the compose step passes --require-payload to the composer" \
    "--require-payload" "$compose_body"
  assert_contains "the compose step reads the gate's stdout file" \
    "expected-payloads.txt" "$compose_body"
  # MENTIONED IS NOT PASSED. The two assertions above are satisfied by the
  # accumulator alone: `require_args+=(--require-payload "$payload")` builds the
  # array and never expands it, the composer then runs with NO expectation flags at
  # all, and the manual-path protection this wiring exists to provide is gone with
  # nothing red anywhere. Deleting the expansion from the composer invocation while
  # keeping the accumulator was measured to leave every assertion in this file
  # green, so what is pinned here is the EXPANSION TOKEN itself, spelled exactly as
  # the step writes it (`${require_args[@]+"${require_args[@]}"}`, the `set -u`
  # idiom for an optionally-empty array).
  assert_contains "the compose step EXPANDS the accumulator into the composer's argv (a built array nobody expands is a dropped flag)" \
    '${require_args[@]+"${require_args[@]}"}' "$compose_body"
  # The token pin reads the step's RAW body, so a commented-out expansion —
  # `# ${require_args[@]+"${require_args[@]}"}`, which is what "we'll re-enable it
  # later" looks like in YAML — would still contain the token and still pass. This
  # second assertion reads the SAME body with shell comments stripped, so the token
  # has to survive as LIVE CODE. (A threshold count of `require_args` mentions was
  # the other candidate and was rejected as fragile: the `require_args=()`
  # declaration is a third mention, so any threshold green today is one refactor
  # away from green while the flag is dropped. The token, live, is the fact.)
  compose_body_code="$(printf '%s\n' "$compose_body" | sed 's/^[[:space:]]*//; s/#.*$//')"
  assert_contains "the expansion is LIVE code, not a commented-out line" \
    '${require_args[@]+"${require_args[@]}"}' "$compose_body_code"
fi

# The ci.yml wiring, same reasoning: a harness nothing runs is a harness nobody
# keeps green.
ci_file="$test_dir/../.github/workflows/ci.yml"
if [[ ! -f "$ci_file" ]]; then
  echo "FATAL: $ci_file does not exist — the ci wiring pin cannot run." >&2
  exit 1
fi
assert_eq "this harness is wired into ci.yml's scripts job" "1" \
  "$(grep -c 'check-release-signatures.test.sh' "$ci_file")"

# ---------------------------------------------------------------------------
# 14. Installers and their signatures and NO `latest.json` at all — the state the
#     gate actually sees on a normal run, because it executes while the release is
#     still a draft and BEFORE the `Upload the updater manifest` step. This is the
#     pin that keeps the allow-list a SKIP filter rather than a REQUIRED set: an
#     implementation that demanded `latest.json` (or a `.dmg`) to be present would
#     fail every release at the point it exists to protect.
# ---------------------------------------------------------------------------
dir="$tmp_root/no-manifest-yet"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$rpm" "$rpm.sig" "$appimage" "$appimage.sig" "$deb" "$deb.sig" "$exe" "$exe.sig")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "a draft release with no latest.json asset yet passes"
assert_eq "the payload list is unchanged by the manifest's absence" \
  "$expected_healthy_stdout" "$stdout"

# ---------------------------------------------------------------------------
# 15. THE PAIRING CASE — what kills a counting implementation.
#
# Two installers, two signatures: the COUNTS are equal, so any check that
# compares "how many installers" to "how many sigs" calls this release healthy.
# The PAIRING is wrong — the deb is unsigned and the rpm's signature is orphaned
# (its installer is not on the release at all). Only per-asset matching, `X`
# present ⇒ `X.sig` present, sees it. This is the one case that distinguishes
# "every installer has a signature" from "as many signatures as installers", and
# it is the shape a partially-failed upload actually leaves behind.
# ---------------------------------------------------------------------------
dir="$tmp_root/equal-counts-wrong-pairing"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$appimage" "$appimage.sig" "$deb" "Archimedes-0.2.0-1.x86_64.rpm.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "equal installer and signature counts with the wrong pairing exits 1"
assert_contains "the unsigned deb is named" "$deb" "$output"
assert_contains "the deb's missing signature is named" "$deb.sig" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

# ---------------------------------------------------------------------------
# 16. THE MIRROR DIRECTION — `X.sig` present ⇒ `X` present.
#
# The allow-list skips every `*.sig` as a PAYLOAD, and for a long time that also
# meant the pairing ran one way only: an installer implies its signature, but a
# signature implied nothing. A signature whose payload is absent is not a healthy
# release with a spare file on it — no bundler writes a `.sig` without the bytes it
# signs, so the payload was deleted or a re-tag left the signature behind. The
# consequence is the OPPOSITE of the shrunk-manifest case 15 describes: the
# composer derives a key from that orphan and publishes a URL for a file that is
# not on the release. Measured on this tree, assets `$appimage`, `$appimage.sig`,
# `$exe.sig` (no `$exe`) made the gate exit 0 and the composer emit FOUR keys, two
# of them pointing at `…/download/v0.2.0/…-setup.exe` — a 404 every Windows client
# downloads, at exit 0, on a release this gate certified. The reachable flow is
# AGENTS.md step 4 with `--clobber`: `latest.json` is cacheable, so a stale `.sig`
# can outlive the installer it signs.
# ---------------------------------------------------------------------------
dir="$tmp_root/orphan-sig-404"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$appimage" "$appimage.sig" "$exe.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "a signature with no installer payload beside it exits 1"
assert_contains "the orphaned signature is named" "$exe.sig" "$output"
assert_contains "the payload it implies is named" "$exe" "$output"
assert_contains "the failure says what the orphan would have caused" "404" "$output"
assert_eq "nothing is printed on stdout — a release with an orphan is not a composeable one" \
  "" "$stdout"

# Both directions at once: the forward offender and the backward offender are
# reported in ONE run, so the operator sees the whole hole rather than fixing one
# side, re-running, and finding the other.
dir="$tmp_root/orphan-and-unsigned-together"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$deb" "$appimage" "$appimage.sig" "Archimedes-0.2.0-1.x86_64.rpm.sig")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "an unsigned installer and an orphaned signature together exit 1"
assert_contains "the unsigned installer side is reported" "$deb -> missing $deb.sig" "$output"
assert_contains "the orphaned signature side is reported" \
  "Archimedes-0.2.0-1.x86_64.rpm.sig -> missing $rpm" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

# Precedence, stated rather than left to chance: a release carrying ONLY orphaned
# signatures has no installers, so the anti-vacuity gate answers it first, with its
# own message. Both refusals are exit 1 and both are true of the release; pinning
# which one speaks keeps the anti-vacuity guard from being silently displaced by the
# newer check (it is the guard case 5 declares load-bearing).
dir="$tmp_root/orphans-only"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets "$deb.sig" "$exe.sig")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "a release of nothing but orphaned signatures exits 1"
assert_contains "and the anti-vacuity gate is the one that answers" "no installer assets" "$output"

# ---------------------------------------------------------------------------
# 17. THE MIRROR'S WIDTH, and the shared source of truth that gives it.
#
# Case 16 uses the `.exe` because it is the shape that makes the 404 vivid. The
# mirror is worth nothing if it covers only the shapes someone thought of while
# writing it: it must fire for EVERY payload shape the composer would build a key
# from, because every such key is a URL a client will download. The eight shapes are
# enumerated here FROM THE SHARED SHAPE FILE, one fixture each — an orphan of that
# shape, beside a perfectly healthy deb pair so the anti-vacuity gate is satisfied
# and the mirror is the only thing that can fail. The companion assertion in
# compose-updater-manifest.test.sh (case 17) is what forces this file's list and the
# composer's matcher arms to stay the same set.
# ---------------------------------------------------------------------------
shape_lib="$test_dir/updater-payload-shapes.sh"
if [[ ! -f "$shape_lib" ]]; then
  echo "FATAL: $shape_lib does not exist — the payload shapes are one definition in one file, and neither gate can be tested without it." >&2
  exit 1
fi
# shellcheck source=./updater-payload-shapes.sh
. "$shape_lib"

# One orphan per shape, in the naming style that shape really ships in.
for orphan_payload in \
  "Archimedes_0.2.0_x64-setup.nsis.zip" \
  "$exe" \
  "Archimedes_0.2.0_amd64.AppImage.tar.gz" \
  "$appimage" \
  "Other_0.2.0_amd64.deb" \
  "$rpm" \
  "Archimedes_0.2.0_x86_64.rpm" \
  "Archimedes.app.tar.gz"
do
  # The fixture is only meaningful if the shape file really claims this name —
  # otherwise the loop below would be pinning nothing and reading as a pass.
  assert_eq "the shared shape file claims $orphan_payload as an updater payload shape" "yes" \
    "$(is_updater_payload_shape "$orphan_payload" && printf 'yes\n' || printf 'no\n')"
  dir="$tmp_root/orphan-width"
  mkdir -p "$dir"
  export FAKE_ASSETS_JSON="$(make_assets \
    "$deb" "$deb.sig" "${orphan_payload}.sig" "latest.json")"
  run_check "$dir" --repo "$repo" --tag "$tag"
  assert_fails "an orphaned ${orphan_payload}.sig exits 1 (the mirror covers that shape)"
  assert_contains "the orphaned ${orphan_payload}.sig names its missing payload" \
    "${orphan_payload}.sig -> missing $orphan_payload" "$output"
done

# The mirror is scoped to those shapes on purpose, and the scope is pinned in both
# directions. (a) A `.dmg`'s signature does NOT demand a `.dmg`: the composer
# refuses any `.sig` whose payload is not a payload shape, so an orphaned
# `X.dmg.sig` cannot produce a key and therefore cannot produce a 404 — demanding
# the `.dmg` would fail the healthy macOS shape this gate must bless (case 4).
dir="$tmp_root/orphan-dmg-sig-is-out-of-scope"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$deb" "$deb.sig" "Archimedes_0.2.0_amd64.dmg.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_passes "an orphaned .dmg.sig does not fail the mirror (the composer would never key it)"

# (b) A name the shape file does NOT claim is not a payload. Asserting this here is
# what stops the shared list from being widened by accretion (a `.zip`, a
# `.tar.xz`, a `.json`) without anyone deciding that the composer keys it. Note
# `Archimedes_0.2.0_aarch64.AppImage`: the arm is `*_amd64.AppImage`, so a cross
# build has no updater key to land on and must stay out of the mirror's way rather
# than be guessed at — the same rule the composer applies to an `*.aarch64.rpm`.
for not_a_payload in "Archimedes_0.2.0_amd64.dmg" "latest.json" "SHA256SUMS" \
  "Archimedes_0.2.0_amd64.deb.sig" "Archimedes_0.2.0_aarch64.AppImage"
do
  assert_eq "the shared shape file does NOT claim $not_a_payload" "no" \
    "$(is_updater_payload_shape "$not_a_payload" && printf 'yes\n' || printf 'no\n')"
done

# ---------------------------------------------------------------------------
# 18. A `gh` that exits 0 and prints something which is NOT the asset list.
#
# The three shapes this is measured against — a proxy's HTML error page, gh's own
# "You have exceeded a secondary rate limit" notice, and an empty body — all arrive
# with a zero exit, and the script captures `2>&1`, so a warning beside a usable
# document lands in the same variable too. Before the guard, the next `jq` died with
# `jq: parse error: Invalid numeric literal at line 1, column 16` and exit 5: a code
# this script's header does not document, and a message that tells the operator
# nothing about the tag, the repository, or the rate limit — and a rate limit is the
# single most likely reason this gate fails on a re-tag run. The failure direction
# that must never happen is the quiet one: an unparsed document yields EMPTY name
# sets, and empty name sets are one step from the vacuous pass case 5 exists to
# refuse, so a `|| echo ""` here would turn a broken read into a certified release.
# ---------------------------------------------------------------------------
dir="$tmp_root/non-json-response"
mkdir -p "$dir"
unset FAKE_ASSETS_JSON
for broken_response in \
  '<html><body>502 Bad Gateway</body></html>' \
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' \
  ''
do
  export FAKE_ASSETS_RAW="$broken_response"
  run_check "$dir" --repo "$repo" --tag "$tag"
  assert_fails "a non-JSON gh response ('${broken_response:0:24}…') exits 1, not 5"
  assert_contains "the failure says gh did not return an asset list" \
    "not a release asset list" "$output"
  assert_contains "the failure names the tag so the operator knows which release was being read" \
    "$tag" "$output"
  assert_contains "the failure names the repository" "$repo" "$output"
  assert_contains "the failure quotes what gh actually printed" \
    "${broken_response:0:24}" "$output"
  assert_eq "nothing is printed on stdout" "" "$stdout"
done
unset FAKE_ASSETS_RAW

# The shapes that ARE a document, and must still be read by the name filters rather
# than rejected by the guard: `null` (what `gh --json` prints for an all-null
# object), `{}`, and `{"assets":null}`. All three belong to the anti-vacuity gate,
# with ITS message about there being no installers — the guard's job is only to stop
# a response that cannot be a response at all, so pinning the boundary from both
# sides is what keeps it from being widened into a thing that swallows real releases.
for empty_but_json in 'null' '{}' '{"assets":[]}'; do
  dir="$tmp_root/json-but-empty"
  mkdir -p "$dir"
  export FAKE_ASSETS_JSON="$empty_but_json"
  run_check "$dir" --repo "$repo" --tag "$tag"
  assert_fails "the JSON document $empty_but_json still reaches the anti-vacuity gate"
  assert_contains "and it is the no-installers message that fires, not a parse refusal" \
    "no installer assets" "$output"
  assert_not_contains "the response was not called unparseable" "not a release asset list" "$output"
done

# ---------------------------------------------------------------------------
# 19. EXACT name matching — the one comparison in this script, pinned in BOTH
#     directions of the pairing.
#
# `has_asset` compares a name WHOLE. A looser match (a suffix glob, a substring
# test) keeps every case above green, because in those fixtures no asset name
# contains another — and then the check stops being a pairing at all: `X` present ⇒
# `X.sig` present becomes "some asset whose name contains X.sig exists", which an
# unrelated asset can satisfy. The reviewer's fixture is the forward direction: the
# deb, plus `X` + `X.deb.sig` where `X` merely ENDS in the deb's name.
# ---------------------------------------------------------------------------
dir="$tmp_root/exact-match-installer"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$deb" "X$deb" "X$deb.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "an installer whose only look-alike signature is prefixed exits 1"
assert_contains "the bare deb is named as unsigned" "$deb -> missing $deb.sig" "$output"
# Exactly ONE offender of the two installers: the prefixed asset really does have
# its own signature, so a matcher that had gone loose reports ZERO offenders (its
# glob matches `X$deb.sig` for the bare deb as well) rather than one.
assert_contains "and it is the only offender of the two installers" "1 of 2 installer" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

# The mirror direction, same trap: a signature whose name merely CONTAINS the
# payload's name is not that payload's signature.
dir="$tmp_root/exact-match-signature"
mkdir -p "$dir"
export FAKE_ASSETS_JSON="$(make_assets \
  "$deb" "prefix$deb.sig" "latest.json")"
run_check "$dir" --repo "$repo" --tag "$tag"
assert_fails "an installer whose only look-alike signature is prefixed exits 1 (mirror direction)"
# Asserted as a PAIR, because `$deb.sig` alone is a substring of `prefix$deb.sig`
# and would be satisfied by the wrong file being named.
assert_contains "the deb's own signature name is what is reported missing" \
  "$deb -> missing $deb.sig" "$output"
assert_eq "nothing is printed on stdout" "" "$stdout"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
