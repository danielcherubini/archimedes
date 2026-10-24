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
#
# It SEEDS `$dir/out/latest.json` with a valid previous-release manifest first (see
# seed_previous_manifest below for why), which means:
#   * every `path_exists "$out_file"` → `no` in this file is now a claim that a
#     file which WAS there got removed, not a claim about an empty directory;
#   * a successful composition is still asserted against the manifest THIS run
#     wrote, because the composer writes with `>` and the seed is gone — and if a
#     mutation ever skipped the write while still exiting 0, the key-set assertions
#     would read the 0.1.9 seed and go red rather than describing a stale manifest
#     as a fresh one.
run_compose() {
  local dir="$1"
  shift
  seed_previous_manifest "$dir/out/latest.json"
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

# Pins that a retired message stays retired: a deleted policy must not come back
# as a reassuring log line, so its old wording is asserted ABSENT.
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

# seed_previous_manifest PATH — puts a VALID, complete, PREVIOUS-release manifest
# at the composer's `--out` path before the run.
#
# WHY EVERY "no manifest survives" ASSERTION NEEDS THIS. Each of them reads
# `path_exists "$out_file"` and expects `no`, and `run_compose` writes into a fresh
# directory, so before this helper the file could only appear if the run itself
# created one. For a refusal that happens AFTER the emit (the zero-byte-signature
# case, which writes, re-reads, rejects and deletes) the assertion is therefore real.
# For every refusal that happens BEFORE the emit — a bad `--version`, an
# unrecognized `.sig`, a collision, the whole `--require-payload` block — the
# assertion was satisfied by an empty directory and could not go red for any reason:
# deleting `fail()`'s `rm -f` left all of them green, which is the difference
# between pinning a policy and describing an empty room.
#
# It also models the flow the operator is actually in. AGENTS.md step 4 is
# download-then-compose: `gh release download -p latest.json` and then re-compose
# over the downloaded file, so a real invocation of this script very often has a
# real previous manifest sitting at `--out`. What that file must do when the run
# refuses — be REMOVED, so the next `gh release upload --clobber` cannot publish the
# old manifest in place of the one that was refused — is the behaviour pinned below,
# and it is a claim about a file that exists.
seed_previous_manifest() {
  local path="$1"
  mkdir -p -- "${path%/*}"
  jq -cn \
    --arg version "0.1.9" \
    --arg url "https://github.com/$repo/releases/download/v0.1.9/Archimedes_0.1.9_amd64.AppImage" \
    '{version: $version, notes: "the PREVIOUS release notes, downloaded by the step 4 flow",
      pub_date: "2020-01-01T00:00:00Z",
      platforms: {"linux-x86_64": {signature: "cHJldmlvdXNzaWduYXR1cmU=", url: $url}}}' \
    >"$path"
}

# previous_manifest_state PATH — `absent`, `intact-previous`, or `rewritten`.
# Three states, because the two failure modes this pins are different: a refusal
# that leaves the downloaded 0.1.9 manifest sitting there (`intact-previous`, the
# bug the bare `exit 1` had), and a refusal that leaves a NEWER but rejected
# document on disk (`rewritten`, the bug a missing post-emit cleanup would have).
# A path-only check reports both as "the file is there" and reports the correct
# `absent` identically to neither, so it cannot pin the policy.
previous_manifest_state() {
  local path="$1"
  [[ -e "$path" ]] || { printf 'absent\n'; return; }
  jq -e --arg url "https://github.com/$repo/releases/download/v0.1.9/Archimedes_0.1.9_amd64.AppImage" '
    .version == "0.1.9" and (.notes | test("PREVIOUS")) and
    (.platforms | keys) == ["linux-x86_64"] and
    (.platforms["linux-x86_64"].url == $url)
  ' "$path" >/dev/null 2>&1 && printf 'intact-previous\n' || printf 'rewritten\n'
}

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
# 6b. The raw NSIS installer's `.exe` IS a Windows updater payload.
#     tauri-plugin-updater's `extract()` only unzips when the bytes ARE a zip and
#     otherwise falls through to `extract_exe()` → `WindowsUpdaterType::nsis` →
#     ShellExecuteW, so the installer a human double-clicks is installable by the
#     updater itself. The REAL v0.1.0 release proved the need: its assets were
#     `Archimedes_0.1.0_x64-setup.exe{,.sig}` and NO `…_setup.nsis.zip(.sig)`, so
#     the old skip arm published a three-key manifest and Windows clients were
#     silently frozen on 0.1.0 forever. Hence the `.exe` now CLAIMS the Windows
#     slot instead of being set aside.
# ---------------------------------------------------------------------------
win_exe_sig="Archimedes_0.2.0_x64-setup.exe.sig"
win_exe_payload="Archimedes_0.2.0_x64-setup.exe"

# (a) exe-only: no zip anywhere in the release.
dir="$tmp_root/nsis-exe-only"
make_sigs_dir "$dir/sigs" "$win_exe_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "the raw NSIS .exe.sig composes instead of being skipped" "0" "$status"
assert_manifest_eq "the .exe-only set emits all five keys" \
  '.platforms | keys | sort | join(" ")' "$five_keys"
assert_manifest_eq "windows-x86_64 serves the .exe installer when there is no zip" \
  ".platforms[\"windows-x86_64\"].url" "$base_url/$win_exe_payload"
assert_manifest_eq "windows-x86_64-nsis serves the .exe installer when there is no zip" \
  ".platforms[\"windows-x86_64-nsis\"].url" "$base_url/$win_exe_payload"
assert_manifest_eq "the .exe URL really is the setup.exe asset" \
  '[.platforms | to_entries[] | select(.key | startswith("windows")) | .value.url | endswith("-setup.exe")] | all' "true"
assert_manifest_eq "the .exe signature is carried, not dropped" \
  "[.platforms[\"windows-x86_64\",\"windows-x86_64-nsis\"] | .signature | length > 0] | all" "true"
# The retired policy must not survive as a log line: a skip message here would
# tell the operator Windows was left out while the manifest says otherwise.
assert_not_contains "the retired skip line is gone" "skip: $win_exe_sig" "$output"
assert_not_contains "the retired skipped-signature summary is gone" "signature(s) skipped" "$output"

# (a2) The Windows-only release that used to fail: an `.exe`-only release has no
#      Linux sigs, so the OLD code emitted ZERO keys and exited 1 ("no platform
#      keys could be derived"). It is now an ordinary composition.
dir="$tmp_root/nsis-exe-only-windows-only"
make_sigs_dir "$dir/sigs" "$win_exe_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "a Windows-only .exe release exits 0 instead of failing on zero keys" "0" "$status"
assert_manifest_eq "the Windows-only .exe set emits exactly the two windows keys" \
  '.platforms | keys | sort | join(" ")' "windows-x86_64 windows-x86_64-nsis"
assert_manifest_eq "the Windows-only .exe manifest points at the installer" \
  ".platforms[\"windows-x86_64\"].url" "$base_url/$win_exe_payload"

# (a3) The REAL v0.1.0 asset names (recorded under Task 8), as a fixture:
#      exe + AppImage + deb, no tar.gz, no nsis zip. This is the exact set that
#      shipped the three-key manifest.
dir="$tmp_root/real-v0.1.0-assets"
make_sigs_dir "$dir/sigs" \
  "Archimedes_0.1.0_x64-setup.exe.sig" \
  "Archimedes_0.1.0_amd64.AppImage.sig" \
  "Archimedes_0.1.0_amd64.deb.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "the real v0.1.0 asset set composes" "0" "$status"
assert_manifest_eq "the real v0.1.0 asset set emits all five keys" \
  '.platforms | keys | sort | join(" ")' "$five_keys"
assert_manifest_eq "the real v0.1.0 windows key names the setup.exe" \
  ".platforms[\"windows-x86_64\"].url" "https://github.com/$repo/releases/download/$tag/Archimedes_0.1.0_x64-setup.exe"

# (b) zip AND exe: five keys, the zip wins the plain key (updater unzips it;
#     matches tauri-action's non-preferNsis default), the exe keeps `-nsis`, and
#     the split is announced rather than inferred from the JSON.
dir="$tmp_root/nsis-zip-and-exe"
make_sigs_dir "$dir/sigs" "$win_sig" "$win_exe_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "zip + exe composes instead of colliding" "0" "$status"
assert_manifest_eq "zip + exe emits all five keys" \
  '.platforms | keys | sort | join(" ")' "$five_keys"
assert_manifest_eq "the nsis zip wins the plain windows-x86_64 key" \
  ".platforms[\"windows-x86_64\"].url" "$base_url/$win_payload"
assert_manifest_eq "the raw installer keeps the windows-x86_64-nsis key" \
  ".platforms[\"windows-x86_64-nsis\"].url" "$base_url/$win_exe_payload"
assert_contains "the winner is announced, naming the zip as the plain-key payload" \
  "wins windows-x86_64" "$output"
assert_contains "the winner line names the nsis zip" "$win_payload" "$output"
assert_contains "the winner line names the raw installer" "$win_exe_payload" "$output"

# ---------------------------------------------------------------------------
# 6c. Claiming the .exe is not tolerance for everything: a `.sig` matching NO
#     known pattern still fails loud next to it, and it must still be reported as
#     an unrecognized ASSET rather than as an orphan.
# ---------------------------------------------------------------------------
dir="$tmp_root/installer-sig-plus-unknown"
make_sigs_dir "$dir/sigs" "$win_sig" "$win_exe_sig" "weird.txt.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an unknown .sig alongside the installer .sig still exits 1"
assert_contains "the unknown signature is still the one named" "weird.txt.sig" "$output"
assert_contains "the failure still calls it an unrecognized signature" "unrecognized signature" "$output"
assert_eq "no manifest survives the unknown signature" "no" "$(path_exists "$out_file")"

dir="$tmp_root/installer-exe-only-plus-unknown"
make_sigs_dir "$dir/sigs" "$win_exe_sig" "weird.txt.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an unknown .sig alongside an exe-only Windows set exits 1"
assert_contains "the unknown signature is named, not the installer" "weird.txt.sig" "$output"
assert_eq "no manifest survives that failure" "no" "$(path_exists "$out_file")"

# Two raw installers for one Windows slot is still a collision: claiming the
# `.exe` shape must not turn into "last one wins".
dir="$tmp_root/two-installers"
make_sigs_dir "$dir/sigs" "Archimedes_0.2.0_x64-setup.exe.sig" "Archimedes_0.2.0_x86-setup.exe.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "two installer .sigs collide instead of picking one"
assert_contains "the collision names both installers" "setup.exe.sig" "$output"

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
# 8a. FLAG ORDER: the cleanup promise is about the INVOCATION, not about how far
#     the parser got.
#
#     Every other case here goes through `run_compose`, which puts `--out` FIRST —
#     so `out_file` is already populated by the time any refusal fires, and the
#     cleanup works. This case types `--out` LAST with a typo BEFORE it
#     (`--verison`, the reviewer's measured repro), and that order used to defeat
#     the policy completely: the argv loop hits the unknown flag, `out_file` is
#     still "", `fail()`'s `[[ -n "$out_file" ]]` guard is false, and the refusal
#     leaves the seeded 0.1.9 manifest on disk with a clean exit 1. That is the
#     exact hazard ADR 0052's amendment names — a stale manifest at the path the
#     upload step reads — arriving through the door nobody tested, and it is what
#     `gh release upload --clobber` publishes when the exit code is ignored.
#
#     So `fail()` must locate `--out` in the argv it was invoked with rather than
#     trusting a variable the parser may not have reached. The two assertions that
#     must go RED before the fix are the state assertion and the survival one; the
#     exit code and the message were already correct, which is precisely why this
#     survived review once.
# ---------------------------------------------------------------------------
dir="$tmp_root/argv-typo-with-out-last"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
seed_previous_manifest "$out_file"
status=0
output="$("$compose_script" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" \
  --repo "$repo" --verison "$version" --out "$out_file" 2>&1)" || status=$?
assert_fails "a mistyped flag before --out still exits 1"
assert_contains "and still names the flag that is wrong" "unknown argument: --verison" "$output"
assert_eq "the seeded manifest does NOT survive a typo typed before --out" \
  "no" "$(path_exists "$out_file")"
assert_eq "and it is GONE rather than intact-previous (the stale file the upload step would clobber onto the release)" \
  "absent" "$(previous_manifest_state "$out_file")"

#     The `--out=FILE` arm of that scan, pinned. This composer has NO `--out=`
#     parse arm, so the glued spelling is itself refused as an unknown argument —
#     that refusal is the FIRST assertion, not something the case papers over: the
#     tool does not accept this spelling and does not pretend to. What the arm is
#     for is the cleanup, and it is the only thing that can serve it here, because
#     the refusal fires before the loop assigns anything, so `$out_file` is empty
#     and the designated path exists ONLY inside the typed argv. Deleting the arm
#     leaves the seeded manifest on disk and reddens the state assertion below
#     (measured: `intact-previous`) — which is what makes a defensive branch
#     tested rather than dead. No separate exit-code assertion: were the parser
#     ever to grow an `--out=` arm, the run would SUCCEED and rewrite the path,
#     and the state assertion would read `rewritten` and go red on that too.
seed_previous_manifest "$out_file"
status=0
output="$("$compose_script" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" \
  --repo "$repo" --out="$out_file" 2>&1)" || status=$?
assert_contains "the glued --out=FILE spelling is refused as an unknown argument" \
  "unknown argument: --out=" "$output"
assert_eq "and the seeded manifest at that glued path is still removed by the scan" \
  "absent" "$(previous_manifest_state "$out_file")"

# The same order trap on the SECOND gate's flag, so the fix is not pinned only to
# the `unknown argument` arm: `--require-payload` refuses deep in the run, and with
# `--out` typed last the parser had reached `--out` by then. Green before the fix
# and after it — it is here to say the ORDER-INDEPENDENT promise covers the
# refusal paths too, so a future `fail()` that reads only `$out_file` and forgets
# the argv scan stays green only while this pair of paths is intact.
dir="$tmp_root/require-payload-with-out-last"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig"
out_file="$dir/out/latest.json"
seed_previous_manifest "$out_file"
status=0
output="$("$compose_script" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" \
  --repo "$repo" --require-payload "$deb_payload" --out "$out_file" 2>&1)" || status=$?
assert_fails "--require-payload with --out typed last exits 1"
assert_eq "and the seeded manifest is removed on that path too" \
  "absent" "$(previous_manifest_state "$out_file")"

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
# The post-emit half of the cleanup policy, stated as a state: this failure happens
# AFTER the composer has written, so the file at `--out` is a NEWER document than the
# seeded one and the only correct answer is that it was deleted. `rewritten` here
# means "a rejected manifest was left on disk for the upload step" — the exact thing
# `fail()` exists to prevent — and it is a different red state from the
# `intact-previous` one case 16 pins, so the two together cover both halves of the
# policy rather than asserting the same sentence twice.
assert_eq "and what was written before the rejection is gone too, not left as a rewritten manifest" \
  "absent" "$(previous_manifest_state "$out_file")"

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

# ---------------------------------------------------------------------------
# 10. The Fedora rpm payload is its own installed form. `tauri-bundler`'s rpm
#     module names it `{product_name}-{version}-{release}.{arch}.rpm` with the
#     release defaulting to `1` and the arch from the Rust-style table
#     (`x86_64`), so the name is DASH-separated and never the deb's
#     underscore/`amd64` spelling — hence a pattern of its own. It claims a
#     distinct slot and lands on `linux-x86_64-rpm`, because the plugin's
#     `get_urls` searches `{os}-{arch}-{installer}` BEFORE the bare key: a Fedora
#     install with no `-rpm` key falls through to the AppImage and dies in
#     `install_rpm`'s format check after downloading in full. The fixture here is
#     a realistic release minus the deb — rpm is the only package format on disk.
# ---------------------------------------------------------------------------
rpm_sig="Archimedes-0.2.0-1.x86_64.rpm.sig"
rpm_payload="Archimedes-0.2.0-1.x86_64.rpm"

dir="$tmp_root/rpm-key"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$rpm_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "the rpm fixture composes instead of failing as unrecognized" "0" "$status"
assert_manifest_eq "the rpm fixture emits the rpm key alongside the AppImage keys" \
  '.platforms | keys | sort | join(" ")' \
  "linux-x86_64 linux-x86_64-appimage linux-x86_64-rpm windows-x86_64 windows-x86_64-nsis"
assert_manifest_eq "linux-x86_64-rpm serves the rpm" \
  ".platforms[\"linux-x86_64-rpm\"].url" "$base_url/$rpm_payload"
assert_manifest_eq "linux-x86_64-rpm carries a non-empty signature" \
  ".platforms[\"linux-x86_64-rpm\"].signature | length > 0" "true"
# The rpm must not become the bare key's payload: the bare key is what an
# AppImage install resolves, and it keeps the tar.gz pair it has always kept.
assert_manifest_eq "the bare linux key still serves the AppImage tar.gz next to an rpm" \
  ".platforms[\"linux-x86_64\"].url" "$base_url/$appimage_targz_payload"
assert_manifest_eq "the appimage key still serves the AppImage tar.gz next to an rpm" \
  ".platforms[\"linux-x86_64-appimage\"].url" "$base_url/$appimage_targz_payload"

# ---------------------------------------------------------------------------
# 11. The full fixture — every shipped shape at once (nsis-less Windows `.exe`,
#     AppImage bare + tar.gz, deb, rpm): SIX keys, and each installer key still
#     names its own format. One key per installed form is the whole point of the
#     composer, so the comparison is against the whole sorted key set.
# ---------------------------------------------------------------------------
six_keys='linux-x86_64 linux-x86_64-appimage linux-x86_64-deb linux-x86_64-rpm windows-x86_64 windows-x86_64-nsis'

dir="$tmp_root/full-set-with-rpm"
make_sigs_dir "$dir/sigs" \
  "$win_exe_sig" "$appimage_targz_sig" "$appimage_bare_sig" "$deb_sig" "$rpm_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" --notes "Archimedes $tag"
assert_eq "the full five-plus-rpm fixture exits 0" "0" "$status"
assert_manifest_eq "the full fixture with an rpm emits all six platform keys" \
  '.platforms | keys | sort | join(" ")' "$six_keys"
jq -e . "$out_file" >/dev/null 2>&1 && echo "ok   case 11 manifest parses with jq" || {
  echo "FAIL case 11 manifest parses with jq"
  failures=$((failures + 1))
}
assert_manifest_eq "the bare linux key is still the AppImage in a six-key manifest" \
  ".platforms[\"linux-x86_64\"].url" "$base_url/$appimage_targz_payload"
assert_manifest_eq "the deb key is still the deb in a six-key manifest" \
  ".platforms[\"linux-x86_64-deb\"].url" "$base_url/$deb_payload"
assert_manifest_eq "the rpm key is the rpm in a six-key manifest" \
  ".platforms[\"linux-x86_64-rpm\"].url" "$base_url/$rpm_payload"
assert_manifest_eq "both Windows keys still serve the raw installer here" \
  "[.platforms[\"windows-x86_64\",\"windows-x86_64-nsis\"] | .url | endswith(\"-setup.exe\")] | all" "true"
assert_manifest_eq "no key is served the rpm by accident" \
  "[.platforms | to_entries[] | select(.key != \"linux-x86_64-rpm\") | .value.url | endswith(\".rpm\")] | any" "false"

# ---------------------------------------------------------------------------
# 12. rpm and deb coexist: neither key moves, and neither format's pattern
#     swallows the other's asset (the deb's `*_amd64` and the rpm's `*_x86_64`
#     spellings are different strings, so a `*_amd64.deb` can never claim the
#     rpm slot or vice versa).
# ---------------------------------------------------------------------------
dir="$tmp_root/rpm-and-deb"
make_sigs_dir "$dir/sigs" "$appimage_bare_sig" "$deb_sig" "$rpm_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "an rpm and a deb in one release compose together" "0" "$status"
assert_manifest_eq "the rpm + deb set emits the four Linux keys and nothing else" \
  '.platforms | keys | sort | join(" ")' \
  "linux-x86_64 linux-x86_64-appimage linux-x86_64-deb linux-x86_64-rpm"
assert_manifest_eq "the deb key is untouched by the rpm's presence" \
  ".platforms[\"linux-x86_64-deb\"].url" "$base_url/$deb_payload"
assert_manifest_eq "the rpm key is untouched by the deb's presence" \
  ".platforms[\"linux-x86_64-rpm\"].url" "$base_url/$rpm_payload"
assert_manifest_eq "the bare key next to rpm + deb is still the bare .AppImage" \
  ".platforms[\"linux-x86_64\"].url" "$base_url/$appimage_bare_payload"
assert_manifest_eq "the deb and rpm keys carry distinct payloads" \
  "[.platforms[\"linux-x86_64-deb\",\"linux-x86_64-rpm\"] | .url] | unique | length" "2"

# ---------------------------------------------------------------------------
# 13. Two rpm signatures is a collision, not "last one wins" — the same rule the
#     AppImage, deb and Windows slots enforce, because the loser would vanish
#     from the manifest in silence.
# ---------------------------------------------------------------------------
dir="$tmp_root/two-rpms"
make_sigs_dir "$dir/sigs" \
  "Archimedes-0.2.0-1.x86_64.rpm.sig" "Archimedes_0.2.0_x86_64.rpm.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "two rpm .sigs collide instead of picking one"
assert_contains "the rpm collision names both files" ".rpm.sig" "$output"
assert_contains "the rpm collision says the platform is claimed twice" "same platform" "$output"
assert_eq "no manifest survives the rpm collision" "no" "$(path_exists "$out_file")"

# ---------------------------------------------------------------------------
# 14. An rpm for an arch the pipeline does not build fails loud rather than
#     becoming a key the client cannot reach: `aarch64` is the rpm's own arch
#     spelling but there is no `linux-aarch64` (or Fedora-arm) updater key to
#     put it on, so guessing would publish a manifest entry nobody can install.
# ---------------------------------------------------------------------------
dir="$tmp_root/rpm-unknown-arch"
make_sigs_dir "$dir/sigs" "$appimage_bare_sig" "$rpm_sig" "Archimedes-0.2.0-1.aarch64.rpm.sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "an *.aarch64.rpm.sig exits 1"
assert_contains "the unknown-arch rpm is named" "Archimedes-0.2.0-1.aarch64.rpm.sig" "$output"
assert_contains "the unknown-arch rpm is called an unrecognized signature" "unrecognized signature" "$output"
assert_eq "no manifest survives the unknown-arch rpm" "no" "$(path_exists "$out_file")"
# The accepted-suffix list an operator is handed must mention the rpm shape, or a
# real rpm failure reads as "this format was never considered".
assert_contains "the accepted-suffix list names the rpm pattern" "*_x86_64.rpm" "$output"

# ---------------------------------------------------------------------------
# 15. An rpm signature with no AppImage payload behind the Linux keys fails like
#     the deb does (case 5): the `-rpm` key is emitted only once the bare Linux
#     key resolved, so an rpm set with no AppImage exits 1 naming the AppImage
#     and leaves no manifest. Emitting `linux-x86_64-rpm` over an unresolvable
#     bare key is the same trap in Fedora clothing — and a partial
#     `latest.json` uploaded over a good one strands every other installed form.
# ---------------------------------------------------------------------------
dir="$tmp_root/rpm-without-appimage"
make_sigs_dir "$dir/sigs" "$win_sig" "$rpm_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_fails "a Linux set with an rpm sig and no AppImage sig exits 1"
assert_contains "that failure names the AppImage as the missing payload" "AppImage" "$output"
assert_eq "no manifest survives the orphaned rpm signature" "no" "$(path_exists "$out_file")"

# ---------------------------------------------------------------------------
# 16. `--require-payload` — the composer-side half of issue #41(d).
#
# The PRIMARY gate is `scripts/check-release-signatures.sh`, which asks the
# RELEASE whether every installer has its `.sig`. This flag is the SECONDARY one,
# defence-in-depth for the path that never runs the release check: AGENTS.md step
# 4, a human re-composing `latest.json` by hand after rewriting the notes. That
# path downloads `*.sig` into a directory and hands the composer whatever came
# back, so without an expectation list the composer shrinks the manifest and
# **exits 0** — the silent omission this task exists to end (reproduced below, in
# sub-case (c), on the exact input the pre-change composer accepted).
#
# SEMANTICS: a claim about a NAME, not about bytes. `--require-payload NAME`
# asserts that `$sigs_dir/NAME.sig` exists. It does NOT require `NAME` itself to
# be on disk, and must not: on the real pipeline `--sigs-dir` holds SIGNATURES
# ONLY (`gh release download --pattern '*.sig'`). Hence there is no
# "--installers-dir" — scanning for installer files that lack a `.sig` would make
# release.yml download ~300 MB of installers into the publish job to obtain
# information `gh release view --json assets` already gives for free.
#
# The flag is OPT-IN: every case above calls the composer without it and must keep
# passing unchanged, because the flag only ever REFUSES — it never adds a key.
# ---------------------------------------------------------------------------

# (a) The flag is satisfied: both named payloads have their sigs on disk, so the
#     composition is exactly what it was without the flag. The assertion that
#     matters here is the KEY SET — the flag adds nothing to any manifest.
dir="$tmp_root/require-payload-satisfied"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" \
  --require-payload "$deb_payload" --require-payload "$appimage_bare_payload"
assert_eq "--require-payload for payloads whose sigs are present exits 0" "0" "$status"
assert_manifest_eq "the flag adds no key to a five-key manifest" \
  '.platforms | keys | sort | join(" ")' "$five_keys"

# (b) The expected-but-unsigned target: the deb signature is missing from a set
#     that would otherwise compose perfectly. Pre-implementation this case ALREADY
#     exits 1, because `--require-payload` is an unknown argument — so
#     `assert_fails` is not the assertion under test. The assertions that must go
#     RED first are the two that name the payload and the missing signature (an
#     unknown-argument message names the FLAG, not the payload), plus the
#     no-manifest-survives one below.
dir="$tmp_root/require-payload-unsigned-deb"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" \
  --require-payload "$deb_payload"
assert_fails "an expected payload with no signature in --sigs-dir exits 1"
assert_contains "the failure names the payload that was expected" "$deb_payload" "$output"
assert_contains "the failure names the signature file it looked for" "expected $deb_sig" "$output"
assert_contains "the failure names the directory it looked in" "$dir/sigs" "$output"
assert_eq "no manifest survives an expected-but-unsigned target" "no" "$(path_exists "$out_file")"
# THE ASSERTION WITH A REAL RED STATE. `out_file` was seeded with a valid 0.1.9
# manifest before this run (run_compose does it for every case), so the line above
# says a file that WAS there was REMOVED, and this one says the removal took the
# previous document with it rather than leaving it half-written. This is the
# download-then-compose shape of AGENTS.md step 4, where the file at `--out` is the
# manifest an operator downloaded moments ago — and the refusal used to leave it
# there with a bare `exit 1`, so `gh release upload --clobber` would have published
# the OLD manifest in place of the one this run refused to write, exit code ignored.
# Deleting `fail()`'s `rm -f` reddens both lines; it reddened neither before the
# seeding existed.
assert_eq "the downloaded previous manifest is GONE, not left in place to be re-uploaded" \
  "absent" "$(previous_manifest_state "$out_file")"
assert_contains "the refusal says the cleanup happened, so the operator at the terminal is not surprised by a missing file" \
  "has been REMOVED" "$output"

# (c) THE #41(d) REGRESSION ITSELF, composer side: four payloads expected, two of
#     their signatures never uploaded. Both offenders are reported in ONE run, so
#     the operator sees the whole hole instead of discovering the second missing
#     sig after fixing the first.
dir="$tmp_root/require-payload-two-missing"
make_sigs_dir "$dir/sigs" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" \
  --require-payload "$deb_payload" \
  --require-payload "$appimage_bare_payload" \
  --require-payload "$rpm_payload" \
  --require-payload "$win_exe_payload"
assert_fails "two expected payloads with no signatures exit 1"
assert_contains "the missing rpm signature is named by payload" "$rpm_payload" "$output"
assert_contains "the rpm's expected signature file is named" "expected $rpm_sig" "$output"
assert_contains "the missing Windows installer signature is named by payload" "$win_exe_payload" "$output"
assert_contains "the Windows installer's expected signature file is named" "expected $win_exe_sig" "$output"
assert_eq "no manifest survives the two missing signatures" "no" "$(path_exists "$out_file")"

# (d) A `.sig` handed to a flag that takes a PAYLOAD name is refused rather than
#     quietly becoming a check for `X.sig.sig` — which can never exist, so the
#     flag would become a permanent failure, or worse a no-op if the check were
#     written the other way round.
dir="$tmp_root/require-payload-sig-name"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" \
  --require-payload "$deb_sig"
assert_fails "--require-payload with a .sig name exits 1"
assert_contains "the failure says to pass the payload name" "pass the payload name" "$output"
assert_eq "no manifest survives a mistyped flag value" "no" "$(path_exists "$out_file")"

# (e) The missing-value guard. The composer's PRE-EXISTING flags (`--notes`,
#     `--arch`, …) shift past the end of argv when given no value and die under
#     `set -e` with exit 1 and no message; that behaviour is deliberately left
#     alone here — fixing it would re-pin existing cases for no #41(d) benefit.
#     The NEW flag gets the guarding idiom from check-versions.sh, and this case
#     is what pins that it has one.
dir="$tmp_root/require-payload-no-value"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" \
  --require-payload
assert_fails "--require-payload with no value exits 1"
assert_contains "and it says which flag needs a value" "requires a payload asset name" "$output"

# (f) Opt-in, stated explicitly as a regression pin: a set that composes without
#     the flag still composes with exit 0 when the flag is simply not passed. This
#     case is green before AND after the implementation — it exists to catch
#     someone making the expectation list mandatory, which would break every
#     manual invocation.
dir="$tmp_root/require-payload-absent"
make_sigs_dir "$dir/sigs" "$win_sig" "$appimage_bare_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo"
assert_eq "composing with no --require-payload at all still exits 0" "0" "$status"
assert_manifest_eq "and the key set is the plain five keys" \
  '.platforms | keys | sort | join(" ")' "$five_keys"

# (g) The check runs BEFORE any key is derived, so an expected-but-absent
#     signature fails on a set that the composer would otherwise have refused for
#     a different reason too — and the EXPECTATION failure is the one reported.
#     Ordering matters: after derivation the failure would land next to `--out`
#     having been written, and `fail()`'s cleanup is the only thing standing
#     between a partial manifest and the upload step.
dir="$tmp_root/require-payload-before-derivation"
make_sigs_dir "$dir/sigs" "$win_sig" "$deb_sig"
out_file="$dir/out/latest.json"
run_compose "$dir" --sigs-dir "$dir/sigs" --version "$version" --tag "$tag" --repo "$repo" \
  --require-payload "$appimage_bare_payload"
assert_fails "an expected payload with no signature beats the AppImage rule it would otherwise hit"
assert_contains "the expectation failure is what is reported" "expected $appimage_bare_sig" "$output"
assert_eq "nothing is written on that path" "no" "$(path_exists "$out_file")"

# ---------------------------------------------------------------------------
# 17. THE SHARED VOCABULARY — the composer's matcher arms and the payload-shape
#     file must name the SAME set of shapes.
#
# `scripts/updater-payload-shapes.sh` is the single definition of "which asset
# names are updater payloads", sourced by this composer (for the operator-facing
# hint) and by `scripts/check-release-signatures.sh` (for the mirror check: a
# `X.sig` on the release demands `X` on the release, for every shape here). The
# matcher itself stays here, because its arms do more than match — each assigns a
# platform slot and carries per-format reasoning that cannot live in a shared
# file. That is precisely the drift a sourced file cannot prevent on its own:
# someone can add an arm to this `case` without adding it to the shape file, and
# the release-side gate then silently stops requiring the payload for THAT shape's
# orphaned signature, re-opening the 404 hole for one platform and nothing else.
#
# So both lists are EXTRACTED FROM THE SOURCE TEXT and compared as sets. The
# extraction is deliberately dumb — the text between the `case` header and its
# `esac`, comment lines dropped, patterns split on `|`, sorted — because a clever
# extractor would need to know the answer to check the answer.
#
# This is the pin that makes the shared file sufficient rather than merely
# better-than-a-comment. Without it the two lists could agree today and diverge in
# the commit that matters.
# ---------------------------------------------------------------------------
shape_lib="$test_dir/updater-payload-shapes.sh"
if [[ ! -f "$shape_lib" ]]; then
  echo "FATAL: $shape_lib does not exist — the payload shapes are one definition in one file." >&2
  exit 1
fi

# matcher_patterns FILE HEADER — the pattern list of the first `case` whose header
# line contains HEADER, up to the first line that is exactly `esac`.
matcher_patterns() {
  awk -v hdr="$2" 'index($0, hdr){inside=1} inside{print} inside && /^[[:space:]]*esac[[:space:]]*$/{exit}' "$1" \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | grep -v '^#' \
    | grep -E '^\*.*\)' \
    | sed 's/).*//' \
    | tr '|' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/)$//' \
    | grep -v '^\*\?$' \
    | LC_ALL=C sort -u
}

composer_patterns="$(matcher_patterns "$compose_script" 'case "$payload" in')"
shape_patterns="$(matcher_patterns "$shape_lib" 'case "$1" in')"

assert_eq "the composer's matcher arms and the shared shape file name the SAME payload shapes" \
  "$composer_patterns" "$shape_patterns"
# The extraction is load-bearing, not vacuous: two empty strings "agree". Pinning
# the count of shapes the matcher has (eight) means a refactor that makes the
# extractor blind — a renamed variable, a reindented `esac` — fails HERE rather
# than turning the comparison above into a tautology.
assert_eq "the extractor really sees the composer's eight matcher arms" "8" \
  "$(printf '%s\n' "$composer_patterns" | grep -c .)"
assert_eq "and the shared file's eight arms" "8" \
  "$(printf '%s\n' "$shape_patterns" | grep -c .)"

# The hint an operator is handed on an unrecognized signature must mention every
# shape the matcher accepts, or a rejected-but-valid asset gives no clue what the
# matcher wanted. This is the string the release-side gate shares, so it is asserted
# from the sourced variable rather than from a literal copy.
# shellcheck source=./updater-payload-shapes.sh
. "$shape_lib"
for pattern in $shape_patterns; do
  assert_contains "the accepted-suffix hint mentions $pattern" "$pattern" "$updater_payload_shape_hint"
done

# Both scripts SOURCE that file, so a checkout missing it must be a named missing
# file rather than bash's `No such file or directory` from inside a `source`, and —
# in the composer's case — rather than a `$updater_payload_shape_hint` unbound under
# `set -u` at the moment a real asset is being rejected. The test runs a COPY of the
# composer from a directory with no sibling library, because the real one must keep
# its sibling (and because deleting a file from the working tree to test a guard is
# not a thing a harness should do to the tree it is run from).
lonely_dir="$tmp_root/composer-without-its-library"
mkdir -p "$lonely_dir"
cp "$compose_script" "$lonely_dir/compose-updater-manifest.sh"
mkdir -p "$lonely_dir/sigs"
printf '%s\n' "$sig_text" >"$lonely_dir/sigs/$deb_sig"
lonely_out="$lonely_dir/out/latest.json"
lonely_status=0
lonely_output="$("$lonely_dir/compose-updater-manifest.sh" --sigs-dir "$lonely_dir/sigs" \
  --version "$version" --tag "$tag" --repo "$repo" --out "$lonely_out" 2>&1)" \
  || lonely_status=$?
assert_eq "the composer refuses to run with no shape library beside it" "1" "$lonely_status"
assert_contains "and names the library that is missing" "updater-payload-shapes.sh" "$lonely_output"
assert_contains "instead of a bare bash source error" "is missing" "$lonely_output"
# The cleanup policy, stated by its ABSENCE here: `fail()` removes `--out` because a
# REFUSED composition must not leave a manifest for the upload step. A missing
# library is not a refusal — the tool could not start, it read no arguments, matched
# no asset and formed no opinion about this release — so the operator's downloaded
# manifest is left exactly where it was. Destroying a good file on the strength of a
# broken checkout is the worse failure, and this pins that the guard does not do it.
seed_previous_manifest "$lonely_out"
lonely_status=0
"$lonely_dir/compose-updater-manifest.sh" --sigs-dir "$lonely_dir/sigs" \
  --version "$version" --tag "$tag" --repo "$repo" --out "$lonely_out" >/dev/null 2>&1 \
  || lonely_status=$?
assert_eq "a broken checkout leaves the downloaded manifest alone (cleanup is for refusals, not for a tool that never started)" \
  "intact-previous" "$(previous_manifest_state "$lonely_out")"

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
