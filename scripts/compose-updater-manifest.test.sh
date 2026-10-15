#!/usr/bin/env bash
# Tests for scripts/compose-updater-manifest.sh.
#
# A malformed updater manifest is indistinguishable, to the user, from "no
# update available": one platform instead of five, an empty `signature`, a
# `v`-prefixed `version`, a non-RFC3339 `pub_date` — all parse fine, download
# fine, and fail on the device. That is why the composer is a script under
# scripts/ with tests here rather than a heredoc in release.yml: a heredoc
# cannot be run against a fixture set, so every one of those shapes would ship
# untested and first appear as a broken install.
#
# The fixtures below are the CLI's real asset names (per ADR 0052 they are
# matched by PATTERN, so a productName/version change must keep passing) with
# FAKE signature contents. One fixture carries an embedded newline mid-base64
# because that is the true shape of a `.sig`, and it is the case a heredoc
# mangles into invalid JSON.
#
# Plain bash, not vitest: these are shell scripts, and green is the same bar
# `bash scripts/compose-updater-manifest.test.sh` has to clear in CI.
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_script="$test_dir/compose-updater-manifest.sh"

# Fail loudly rather than letting every case die with 126: a missing script
# under test is a different bug from a wrong exit code, and it is the first
# thing a TDD run needs to be told.
if [[ ! -f "$compose_script" ]]; then
  echo "FATAL: $compose_script does not exist — implement it before running these tests." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required to run these tests." >&2
  exit 1
fi

failures=0

# One temp root for the whole run, removed on EXIT (the Task 1 harness shape —
# a plain variable, because appending to an array inside a command substitution
# records into the subshell and the trap would clean nothing).
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

# Arbitrary bytes for a signature, except where a case says otherwise.
sig_text="ZmFrZXNpZ25hdHVyZWZvcmV4YW1wbGU="

# make_sigs_dir DIR NAME... — a fixture sig directory holding one file per NAME.
make_sigs_dir() {
  local dir="$1"
  shift
  mkdir -p "$dir"
  local name
  for name in "$@"; do
    printf '%s\n' "$sig_text" >"$dir/$name"
  done
}

# Runs the composer, capturing exit status and merged output, with the
# `|| status=$?` that keeps `set -e` from aborting the driver on the exits this
# test asserts. Every invocation writes into its own directory, so a case that
# asserts "no --out file survived" is not polluted by an earlier case's file.
run_compose() {
  local dir="$1"
  shift
  status=0
  output="$("$compose_script" --out "$dir/out/latest.json" "$@" 2>&1)" || status=$?
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

# jq against the emitted manifest. `|| status=$?` again: an assertion about a
# missing key must be reported as a failed assertion, not abort the run.
manifest_value() {
  local filter="$1"
  status=0
  local value
  value="$(jq -r "$filter" "$out_file" 2>&1)" || status=$?
  if [[ "$status" != "0" ]]; then
    printf 'jq-failed: %s\n' "$value"
  else
    printf '%s\n' "$value"
  fi
}

assert_manifest_eq() {
  local what="$1" filter="$2" expected="$3"
  local actual
  actual="$(manifest_value "$filter")"
  assert_eq "$what" "$expected" "$actual"
}

# Case 5 asserts the file does NOT survive; the other cases need it to.
path_exists() { [[ -e "$1" ]] && printf 'yes\n' || printf 'no\n'; }

tag="v0.2.0"
version="0.2.0"
repo="danielcherubini/archimedes-desktop"
base_url="https://github.com/$repo/releases/download/$tag"
five_keys='linux-x86_64 linux-x86_64-appimage linux-x86_64-deb windows-x86_64 windows-x86_64-nsis'

win_sig="Archimedes_0.2.0_x64-setup.nsis.zip.sig"
appimage_targz_sig="Archimedes_0.2.0_amd64.AppImage.tar.gz.sig"
appimage_bare_sig="Archimedes_0.2.0_amd64.AppImage.sig"
deb_sig="Archimedes_0.2.0_amd64.deb.sig"
win_payload="Archimedes_0.2.0_x64-setup.nsis.zip"
appimage_targz_payload="Archimedes_0.2.0_amd64.AppImage.tar.gz"
appimage_bare_payload="Archimedes_0.2.0_amd64.AppImage"
deb_payload="Archimedes_0.2.0_amd64.deb"

# ---------------------------------------------------------------------------
# 1. The Windows + Linux fixture set composes exactly the five keys ADR 0052
#    calls for. A missing or extra key is the failure the single writer exists
#    to prevent, so the comparison is against the whole sorted key set.
# ---------------------------------------------------------------------------
dir="$tmp_root/full-set"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" --notes "Archimedes $tag"
assert_eq "the full fixture set exits 0" "0" "$status"
assert_manifest_eq "the full fixture set emits all five platform keys" \
  '.platforms | keys | sort | join(" ")' "$five_keys"
jq -e . "$out_file" >/dev/null 2>&1 && echo "ok   case 1 manifest parses with jq" || {
  echo "FAIL case 1 manifest parses with jq"
  failures=$((failures + 1))
}

# ---------------------------------------------------------------------------
# 2. URL cross-check. Each key must name the payload the installer on that
#    device can actually consume: the AppImage keys point at the tar.gz the
#    plugin's Linux installer unzips, the deb key at the deb, both Windows keys
#    at the nsis zip (the .exe is not an updater payload). A deb install served
#    the AppImage downloads in full, verifies, and then fails
#    `invalid updater binary format` on the device.
# ---------------------------------------------------------------------------
assert_manifest_eq "linux-x86_64 serves the AppImage tar.gz" \
  ".platforms[\"linux-x86_64\"].url" "$base_url/$appimage_targz_payload"
assert_manifest_eq "linux-x86_64-appimage serves the AppImage tar.gz" \
  ".platforms[\"linux-x86_64-appimage\"].url" "$base_url/$appimage_targz_payload"
assert_manifest_eq "linux-x86_64-deb serves the deb" \
  ".platforms[\"linux-x86_64-deb\"].url" "$base_url/$deb_payload"
assert_manifest_eq "windows-x86_64 serves the nsis zip" \
  ".platforms[\"windows-x86_64\"].url" "$base_url/$win_payload"
assert_manifest_eq "windows-x86_64-nsis serves the nsis zip" \
  ".platforms[\"windows-x86_64-nsis\"].url" "$base_url/$win_payload"

# ---------------------------------------------------------------------------
# 3. Newline-in-signature round-trip. A real `.sig` is base64 broken by a
#    newline; that newline has to survive into the JSON string (only the single
#    TRAILING newline is trimmed). Heredoc-style interpolation emits a raw
#    newline inside a JSON string literal here, which is invalid JSON, and
#    `jq --rawfile` is the only thing in the toolchain that gets it right.
# ---------------------------------------------------------------------------
dir="$tmp_root/newline-signature"
mkdir -p "$dir/sigs"
printf 'dGVzdA==\ndW5pcg==\n' >"$dir/sigs/$win_sig"
printf '%s\n' "$sig_text" >"$dir/sigs/$appimage_bare_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "a signature with an embedded newline exits 0" "0" "$status"
assert_eq "the manifest is still valid JSON" "yes" "$(jq -e . "$out_file" >/dev/null 2>&1 && echo yes || echo no)"
assert_manifest_eq "the embedded newline survives into the signature" \
  ".platforms[\"windows-x86_64\"].signature | test(\"^dGVzdA==\\\\ndW5pcg==\$\")" "true"
# 8 base64 chars + the embedded newline + 8 = 17: the mid-file newline is kept,
# the one trailing newline the fixture file ends with is what got trimmed.
assert_manifest_eq "only the trailing newline is trimmed" \
  ".platforms[\"windows-x86_64\"].signature | length" "17"
assert_manifest_eq "a single-line signature keeps its bytes" \
  ".platforms[\"linux-x86_64\"].signature" "$sig_text"

# ---------------------------------------------------------------------------
# 4. No tar.gz pair at all: the bare `.AppImage` pair is the fallback payload,
#    and both Linux AppImage keys name it.
# ---------------------------------------------------------------------------
dir="$tmp_root/bare-appimage-only"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "the bare .AppImage pair alone exits 0" "0" "$status"
assert_manifest_eq "the bare .AppImage set emits all five keys" \
  '.platforms | keys | sort | join(" ")' "$five_keys"
assert_manifest_eq "bare linux-x86_64 falls back to the bare .AppImage" \
  ".platforms[\"linux-x86_64\"].url" "$base_url/$appimage_bare_payload"
assert_manifest_eq "linux-x86_64-appimage falls back to the bare .AppImage" \
  ".platforms[\"linux-x86_64-appimage\"].url" "$base_url/$appimage_bare_payload"

# ---------------------------------------------------------------------------
# 5. No AppImage sig of either form, a deb sig present: exit 1 naming the
#    AppImage, and no manifest left behind. The deb key is withheld with it —
#    emitting `linux-x86_64-deb` without a resolvable bare `linux-x86_64` is
#    exactly how a deb install ends up being served the AppImage. A partial
#    `latest.json` uploaded to the release would point installed clients at a
#    manifest with no Linux payload at all, so the file must not survive.
# ---------------------------------------------------------------------------
dir="$tmp_root/no-appimage-sig"
make_sigs_dir "$dir/sigs" "$win_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "a Linux set with no AppImage sig exits 1"
assert_contains "that failure names the AppImage" "AppImage" "$output"
assert_eq "no manifest survives the failure" "no" "$(path_exists "$out_file")"

# ---------------------------------------------------------------------------
# 6. A `.sig` no pattern claims exits 1 and names the file. An unrecognized
#    signature means a real platform is absent from the manifest, and a silently
#    absent platform is invisible to CI and permanent on the user's device.
# ---------------------------------------------------------------------------
dir="$tmp_root/unrecognized-sig"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig" "weird.txt.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an unrecognized .sig exits 1"
assert_contains "the unrecognized signature is named" "weird.txt.sig" "$output"
# Named as an unrecognized-ASSET problem, not as an orphaned-signature problem:
# the pattern check fires while deriving keys, so the operator is told the name
# does not map to any updater platform rather than being sent to look for a key
# that was never a candidate. (The orphan rule below is the second net, not the
# first — a fixture can reach it only after derivation, and this one must not.)
assert_contains "the failure calls it an unrecognized signature" "unrecognized signature" "$output"

# ---------------------------------------------------------------------------
# 6b. The NSIS installer's own `.exe` signature. A Windows build ships the
#     `…_x64-setup.exe` installer NEXT TO the `…_x64-setup.nsis.zip` the updater
#     actually installs from, so `…_x64-setup.exe.sig` arrives in the sigs dir on
#     every real Windows run. It has no manifest slot — the updater would try to
#     unzip an `.exe` — so it is skipped DELIBERATELY and LOUDLY (a visible
#     `skip:` line, exit still 0) rather than killed on, and rather than swallowed
#     in silence. The five keys are unchanged by it: skipping is not emitting.
# ---------------------------------------------------------------------------
win_exe_sig="Archimedes_0.1.0_x64-setup.exe.sig"

dir="$tmp_root/nsis-installer-sig"
make_sigs_dir "$dir/sigs" "$win_sig" "$win_exe_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "the raw NSIS .exe.sig exits 0 instead of stranding the release" "0" "$status"
assert_contains "the skipped installer signature is named" "$win_exe_sig" "$output"
assert_contains "the skip is announced as a skip, not silence" \
  "skip: $win_exe_sig (installer signature, not a manifest payload)" "$output"
assert_manifest_eq "the installer signature adds no platform key" \
  '.platforms | keys | sort | join(" ")' "$five_keys"
assert_manifest_eq "no key points at the .exe installer payload" \
  '[.platforms[].url | endswith(".exe")] | any' "false"

# A skipped installer signature must also not trip the ORPHAN rule on its own:
# a Windows-only release (no Linux sigs at all) is a legitimate composition.
dir="$tmp_root/nsis-installer-sig-windows-only"
make_sigs_dir "$dir/sigs" "$win_sig" "$win_exe_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "a Windows-only set with the installer .sig exits 0" "0" "$status"
assert_manifest_eq "the Windows-only set emits exactly the two nsis keys" \
  '.platforms | keys | sort | join(" ")' "windows-x86_64 windows-x86_64-nsis"

# ---------------------------------------------------------------------------
# 6c. The deliberate skip is scoped to the installer shape. A `.sig` matching NO
#     known pattern still fails loud, and the skip must not mask it by running
#     first: the skip is a narrow allow-list, not a general tolerance.
# ---------------------------------------------------------------------------
dir="$tmp_root/installer-sig-plus-unknown"
make_sigs_dir "$dir/sigs" "$win_sig" "$win_exe_sig" "weird.txt.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an unknown .sig alongside the installer .sig still exits 1"
assert_contains "the unknown signature is still the one named" "weird.txt.sig" "$output"
assert_eq "no manifest survives the unknown signature" "no" "$(path_exists "$out_file")"

# ---------------------------------------------------------------------------
# 7. The darwin payload name carries neither version nor arch, so two archs
#    would collide on one key: the composer refuses to guess and needs --arch.
#    The flag values are rustup-target-flavoured selectors that MAP to the
#    updater's own `{os}-{arch}` key spelling (aarch64, not arm64).
# ---------------------------------------------------------------------------
darwin_sig="Archimedes.app.tar.gz.sig"
darwin_payload="Archimedes.app.tar.gz"

dir="$tmp_root/darwin-without-arch"
make_sigs_dir "$dir/sigs" "$darwin_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an *.app.tar.gz.sig without --arch exits 1"

dir="$tmp_root/darwin-arm64"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig" "$darwin_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" --arch darwin-arm64
assert_eq "--arch darwin-arm64 exits 0" "0" "$status"
assert_manifest_eq "--arch darwin-arm64 emits the darwin-aarch64 key" \
  '.platforms | has("darwin-aarch64")' "true"
assert_manifest_eq "darwin-aarch64 serves the .app.tar.gz payload" \
  ".platforms[\"darwin-aarch64\"].url" "$base_url/$darwin_payload"
assert_manifest_eq "the Windows/Linux keys still compose alongside darwin" \
  '.platforms | keys | sort | join(" ")' "darwin-aarch64 $five_keys"

dir="$tmp_root/darwin-x64"
make_sigs_dir "$dir/sigs" "$darwin_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" --arch darwin-x64
assert_eq "--arch darwin-x64 exits 0" "0" "$status"
assert_manifest_eq "--arch darwin-x64 emits the darwin-x86_64 key" \
  '.platforms | has("darwin-x86_64")' "true"

# ---------------------------------------------------------------------------
# 8. Argument validation. A `v`-prefixed version is legal-looking JSON that no
#    installed client ever matches (the plugin semver-compares it), and an empty
#    sigs dir is the zero-platform manifest ADR 0052 exists to prevent.
# ---------------------------------------------------------------------------
dir="$tmp_root/version-with-v"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "v0.2.0" --tag "$tag" --repo "$repo"
assert_fails "--version with a leading v exits 1"
# Named as an argument problem, not as a self-validation problem: the composer
# rejects the shape before it can reach the emit, so a caller sees which flag to
# fix rather than "the manifest I never asked for is invalid".
assert_contains "the v-prefixed version names the --version flag" "--version" "$output"
assert_eq "no manifest survives the bad version" "no" "$(path_exists "$out_file")"

dir="$tmp_root/empty-sigs-dir"
make_sigs_dir "$dir/sigs"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an empty --sigs-dir exits 1"
assert_contains "the empty sigs dir says why" "zero platforms" "$output"

dir="$tmp_root/missing-sigs-dir"
mkdir -p "$dir"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/nope" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "a --sigs-dir that does not exist exits 1"
assert_contains "the missing sigs dir names the path" "$dir/nope" "$output"

# ---------------------------------------------------------------------------
# 8b. A zero-byte `.sig` is the emptiest version of the same trap: it encodes
#     into JSON as `""`, parses perfectly, and the client discovers the problem
#     only when minisign has nothing to verify. The composer writes, re-reads,
#     rejects, and DELETES — the assertion that the file is gone is what pins
#     the deletion, because the failure here happens after the write.
# ---------------------------------------------------------------------------
dir="$tmp_root/empty-signature"
mkdir -p "$dir/sigs"
: >"$dir/sigs/$appimage_bare_sig"
printf '%s\n' "$sig_text" >"$dir/sigs/$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "a zero-byte signature exits 1"
assert_eq "no manifest survives an empty signature" "no" "$(path_exists "$out_file")"

# ---------------------------------------------------------------------------
# 9. The three shapes the composer self-validates, asserted here independently
#    so a regression in the composer's own validation cannot make them pass by
#    refusing to emit anything at all.
# ---------------------------------------------------------------------------
dir="$tmp_root/manifest-shape"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" --notes "Archimedes $tag"
assert_eq "the shape fixture exits 0" "0" "$status"
assert_manifest_eq "pub_date is RFC3339 UTC with no offset" \
  ".pub_date | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\$\")" "true"
assert_manifest_eq "version carries no v prefix" ".version | test(\"^[0-9]+\\\\.[0-9]+\\\\.[0-9]+$\")" "true"
assert_manifest_eq "no signature is empty" "[.platforms[].signature | length > 0] | all" "true"
assert_manifest_eq "every url is pinned to the tag, never /releases/latest/" \
  "[.platforms[].url | startswith(\"$base_url/\")] | all" "true"
assert_manifest_eq "at least one platform is present" ".platforms | length >= 1" "true"
assert_manifest_eq "the notes are passed through" ".notes" "Archimedes $tag"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
