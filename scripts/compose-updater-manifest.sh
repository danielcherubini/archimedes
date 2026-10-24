#!/usr/bin/env bash
#
# Composes the ONE updater manifest (`latest.json`) from a release's `.sig`
# assets. ADR 0052: every build job on a tag wants to write this same asset, and
# tauri-action's merge is an unguarded read-modify-write, so the pipeline gives
# the write to exactly one trailing job — this script — and sets
# `uploadUpdaterJson: false` everywhere else.
#
# It is a script rather than YAML because each way it breaks (one platform
# instead of five, an empty signature, a `v`-prefixed version, a `pub_date` the
# client cannot parse) is silent in CI and fatal on the user's device.
#
# The manifest carries a key per INSTALLED FORM, not one per platform: the
# updater resolves `{os}-{arch}-{installer}` before `{os}-{arch}`, so
# `linux-x86_64-deb` must name the deb — a bare key alone would hand a deb
# install the AppImage, which downloads, verifies, and only then fails
# `install_deb`'s format check with "invalid updater binary format".
#
# Usage:
#   compose-updater-manifest.sh \
#     --sigs-dir DIR --version X.Y.Z --tag v0.2.0 --repo owner/name --out latest.json \
#     [--notes TEXT] [--arch darwin-arm64|darwin-x64] [--require-payload NAME]...

set -euo pipefail

# The payload-shape vocabulary (see the header of that file for why it is shared
# rather than duplicated). Resolved from THIS script's directory, not the caller's
# cwd: the composer is invoked as `bash scripts/compose-updater-manifest.sh` from
# the repo root by release.yml and from anywhere by its harness, and a cwd-relative
# source path would make the script's location an argument.
#
# Guarded, with a plain printf/exit rather than `fail`: `fail` is defined below and
# needs `$out_file`, which does not exist yet. A missing library is a broken
# checkout, and bash's own `No such file or directory` from the `source` would read
# like a bug in this script rather than a missing sibling; the message names the
# file so the operator can see which of the two is gone. The alternative — sourcing
# unconditionally and letting the first `$updater_payload_shape_hint` use die under
# `set -u` — would fail at the point a real asset is rejected, i.e. exactly when the
# message matters most.
shape_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/updater-payload-shapes.sh"
if [[ ! -f "$shape_lib" ]]; then
  printf 'error: %s is missing — it holds the updater payload shapes this composer matches against, so it cannot decide which signature claims which platform\n' "$shape_lib" >&2
  exit 1
fi
# shellcheck source=./updater-payload-shapes.sh
. "$shape_lib"

usage() {
  cat >&2 <<'USAGE'
usage: compose-updater-manifest.sh --sigs-dir DIR --version X.Y.Z --tag TAG \
                                   --repo owner/name --out FILE \
                                   [--notes TEXT] [--arch darwin-arm64|darwin-x64]
                                   [--require-payload PAYLOAD_NAME]...
USAGE
}

# Every exit-1 path funnels through here so a rejected manifest can never be
# left on disk for the next step to `gh release upload` — a partial `latest.json`
# published over a good one is worse than no manifest at all.
#
# THE TARGET IS THE INVOCATION'S `--out`, NOT THE `$out_file` VARIABLE. The parse
# loop fills `$out_file` only when it REACHES `--out`, and a refusal can fire before
# it does: `… --repo r/x --verison 0.2.0 --out latest.json` — a typo two flags short
# of the end — dies on `unknown argument: --verison` with `$out_file` still empty,
# and the old `[[ -n "$out_file" ]]` guard then skipped the cleanup, so the manifest
# the operator had just downloaded survived a refused run behind a clean exit 1. That
# is ADR 0052's stale-manifest hazard arriving through the door the harness never
# opened: every case there types `--out` FIRST, so the variable was always populated.
# Hence `$invocation_args` (below, captured before the loop consumes argv): when
# `$out_file` is empty, `fail()` looks for the `--out` the operator typed and removes
# THAT, so the promise holds for every refusal regardless of flag order.
#
# One knowingly-accepted widening: the scan reads the whole typed argv, so in
# `--notes --out path` — where the parser ate `--out` as `--notes`' VALUE and the
# refusal is `unknown argument: path` — `path` is treated as the designated manifest
# and removed. A literal `--out` token means the operator was naming a manifest path
# in every realistic invocation, and the only file this can ever reach is one that
# `gh release download <tag> -p latest.json` restores in one step.
fail() {
  printf 'error: %s\n' "$1" >&2
  local target="$out_file"
  if [[ -z "$target" ]]; then
    local previous="" argument
    for argument in ${invocation_args[@]+"${invocation_args[@]}"}; do
      if [[ "$previous" == "--out" ]]; then
        target="$argument"
        break
      fi
      if [[ "$argument" == --out=* ]]; then
        target="${argument#--out=}"
        break
      fi
      previous="$argument"
    done
  fi
  if [[ -n "$target" && -e "$target" ]]; then
    rm -f -- "$target"
  fi
  exit 1
}

# The invocation as typed, captured before the loop below shifts it away, for the
# argv scan in `fail()`. `${invocation_args[@]+…}` guards the empty case for the
# same reason AGENTS.md step 4 guards `require_args`: a bare `"${arr[@]}"` on an
# EMPTY array is an unbound-variable fault under `set -u` on bash 3.2 (macOS).
invocation_args=("$@")

sigs_dir=""
version=""
tag=""
repo=""
out_file=""
notes=""
arch=""
# The expectation list for `--require-payload` (repeatable; several flags of the
# same name is the normal call shape — release.yml passes one line per installer
# the completeness gate accepted).
required_payloads=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --sigs-dir) sigs_dir="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --out) out_file="${2:-}"; shift 2 ;;
    --notes) notes="${2:-}"; shift 2 ;;
    --arch) arch="${2:-}"; shift 2 ;;
    --require-payload)
      # The guarding idiom from check-versions.sh, checked BEFORE `shift 2`: a
      # value-less flag otherwise shifts past the end of argv and dies under
      # `set -e` with exit 1 and no message at all. (The composer's pre-existing
      # flags have exactly that behaviour and are deliberately left alone —
      # fixing them would re-pin existing cases for no issue-#41 benefit.)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        fail "--require-payload requires a payload asset name (e.g. Archimedes_0.2.0_amd64.deb)"
      fi
      # A claim about a NAME, not about bytes: `--require-payload NAME` asserts
      # that `$sigs_dir/NAME.sig` exists. It does NOT require NAME itself to be on
      # disk, and must not — on the real pipeline `--sigs-dir` holds SIGNATURES
      # ONLY (`gh release download --pattern '*.sig'`), so an installer-present
      # requirement could never be satisfied there. The rejected alternative —
      # scanning a directory for installer files that lack a `.sig` — would make
      # release.yml download ~300 MB of installers into the publish job to obtain
      # information `gh release view --json assets` already gives for free; that
      # is why there is no `--installers-dir` and why the release-side gate is a
      # separate script (scripts/check-release-signatures.sh).
      if [[ "$2" == *.sig ]]; then
        fail "--require-payload got a signature name ($2) — pass the payload name instead (pass ${2%.sig}): a `.sig` is never itself an updater payload, so requiring one would be a check for X.sig.sig that can never be satisfied"
      fi
      required_payloads+=("$2")
      shift 2
      ;;
    *)
      usage
      fail "unknown argument: $1"
      ;;
  esac
done

# Each required flag is named as the caller types it (`--out`, not the internal
# `--out-file`).
required_args=(
  "--sigs-dir|sigs_dir"
  "--version|version"
  "--tag|tag"
  "--repo|repo"
  "--out|out_file"
)
for pair in "${required_args[@]}"; do
  flag="${pair%%|*}"
  var="${pair##*|}"
  if [[ -z "${!var}" ]]; then
    usage
    fail "missing required argument $flag"
  fi
done

# jq is preinstalled on the ubuntu runners and present on dev machines, but a
# bare "jq: command not found" from inside the emit reads like a broken manifest
# rather than a missing tool.
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required to encode signatures into JSON (apt-get install jq / brew install jq)"
fi

# A `v`-prefixed version is legal JSON that no installed client ever matches:
# the plugin semver-compares `version` against the running app's, so "v0.2.0"
# parses, downloads, and then reports nothing. The tag carries the `v`; the
# version never does.
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "--version must be X.Y.Z with no leading v (got: $version)"
fi

if [[ -z "$tag" ]]; then
  fail "--tag must not be empty (the manifest URLs are pinned to it)"
fi

# Every URL is built from this. It is TAG-pinned rather than
# `/releases/latest/download/` so a manifest can never point at some later
# release's asset: the manifest and the payload it authorises ship together.
base_url="https://github.com/$repo/releases/download/$tag"

if [[ ! -d "$sigs_dir" ]]; then
  fail "--sigs-dir is not a directory: $sigs_dir"
fi

case "$arch" in
  "" | darwin-arm64 | darwin-x64) ;;
  # The flag values are rustup-target-flavoured SELECTORS; the manifest keys they
  # map to are the updater's own `{os}-{arch}` spelling (aarch64 / x86_64), which
  # is what a client looks up.
  darwin-aarch64 | darwin-x86_64) fail "--arch takes darwin-arm64 / darwin-x64 (the manifest key $arch is derived from it, not chosen)" ;;
  *) fail "--arch must be darwin-arm64 or darwin-x64 (got: $arch)" ;;
esac

shopt -s nullglob
sig_paths=("$sigs_dir"/*.sig)
shopt -u nullglob

# A manifest with no platform is the exact failure ADR 0052 exists to prevent,
# so an empty sigs dir is an error and never an empty-but-valid manifest.
if [[ ${#sig_paths[@]} -eq 0 ]]; then
  fail "no .sig files found in $sigs_dir — refusing to write a manifest with zero platforms"
fi

# --- the expectation list (issue #41(d), the secondary gate) ----------------
#
# WHY THIS EXISTS. The composer's keys are derived FROM the `.sig` files it was
# handed, so an installer whose signature was never uploaded is simply absent from
# the output — and the composition exits 0. Every completeness question put to the
# RESULT of that derivation is therefore answered by a projection of the result
# itself, which is why AGENTS.md's old "count the distinct manifest URL basenames
# and require a `.sig` for each" could never fail. The primary gate is
# `scripts/check-release-signatures.sh`, which asks the RELEASE (per asset: `X`
# present ⇒ `X.sig` present). This flag is the secondary one, and it exists for the
# path that never runs that script: a human re-composing `latest.json` by hand
# after rewriting the notes (AGENTS.md step 4), who downloads whatever `.sig`s come
# back and hands them over with no expectation list at all.
#
# It runs HERE — after the empty-directory refusal and before any pattern matching
# or key derivation — so an expected-but-absent signature fails before a single key
# is built. Every refusal routed through `fail()` removes the invocation's
# `--out`, this one included, and that is deliberate rather than incidental — see
# "WHY THIS REFUSAL DELETES A PRE-EXISTING `--out`" below, because the opposite
# reading ("the file on disk is
# the OLD correct manifest, so leave it") is attractive and wrong.
#
# WHY THIS REFUSAL DELETES A PRE-EXISTING `--out`. The documented manual flow
# (AGENTS.md step 4) is download-then-compose: `gh release download -p latest.json`
# and then re-compose over the downloaded file, so when this refusal fires there IS
# a real manifest sitting at `--out`, and leaving it untouched looks like the safe
# answer. Three reasons it is not:
#
#   1. The file's own contract. `fail()` exists so that "a rejected manifest can
#      never be left on disk for the next step to `gh release upload`". That is a
#      claim about every exit-1 path, and this bare `exit 1` skipped the cleanup
#      outright — unlike pre-write refusals like
#      `--sigs-dir is not a directory`, which DO delete. An operator cannot reason
#      about which refusals leave a file behind, and the next step cannot either.
#      (The other way was subtler and is fixed at the definition of `fail()` above:
#      cleanup keyed on the `$out_file` VARIABLE, which a typo typed before `--out`
#      left empty, so a reported refusal deleted nothing.)
#      (What still does not clean up is everything that never reaches `fail()`,
#      i.e. everything that reports no refusal: the missing-shape-library guard at
#      the top of the file; a legacy value-less flag at the very END of the line
#      (`… --out latest.json --notes`), whose `shift 2` runs past the end of argv
#      and dies as a shell fault — that pre-existing behaviour is deliberately left
#      alone, see the `--require-payload` guard below; and an `--out` path the OS
#      refuses at `mkdir -p` / the write. The library case is pinned by the composer
#      harness: a broken CHECKOUT is not a refused composition, and the tool that
#      never started has formed no opinion about this release and should not destroy
#      the operator's downloaded manifest.)
#   2. By this ADR's own ruling, "the previous version's manifest where the new
#      one belongs" is the HAZARD, not the safety net: ADR 0052 lists "the new
#      version is visible to clients with no manifest, OR WITH THE PREVIOUS
#      VERSION'S" as the bad window the publish order exists to close. So the
#      surviving file is not a fallback this script can rely on — it is the second
#      half of a documented failure mode, and it is what a `--clobber` re-upload
#      of an ignored exit code publishes.
#   3. Loudness beats reassurance. With the file gone, the very next thing the
#      operator types — `gh release upload vX.Y.Z latest.json --clobber` — fails
#      with "no such file or directory" and the ceremony stops at the right step.
#      With the file present, that upload SUCCEEDS, and the notes rewrite that was
#      supposed to be the point of the run silently does not land.
#
# Nothing is destroyed by the deletion either: the file being removed is, by
# construction, a copy of a PUBLISHED release asset, one
# `gh release download <tag> -p latest.json` away from being recovered.
#
# It only ever REFUSES. It never adds a key, never reorders one, and is opt-in:
# with no `--require-payload` the composer behaves exactly as it has always behaved.
if (( ${#required_payloads[@]} > 0 )); then
  missing_payloads=()
  for required_payload in "${required_payloads[@]}"; do
    if [[ ! -e "$sigs_dir/$required_payload.sig" ]]; then
      missing_payloads+=("$required_payload")
    fi
  done
  if (( ${#missing_payloads[@]} > 0 )); then
    # EVERY offender, in one run — the same rule the release-side gate follows.
    # Stopping at the first makes the operator fix one signature, re-run, and
    # discover the second, which is how a partially-uploaded sig set survives a
    # release ceremony.
    for missing_payload in "${missing_payloads[@]}"; do
      printf 'error: expected updater payload %s has no signature in %s (expected %s.sig) — refusing to compose a manifest that silently drops an installed platform\n' \
        "$missing_payload" "$sigs_dir" "$missing_payload" >&2
    done
    # `fail`, not a bare `exit 1`: the per-offender lines above say WHAT is missing,
    # and this says what happens to `--out`. Naming the cleanup in the message is
    # what makes the deletion discoverable to the person standing at the terminal
    # about to re-upload a manifest from an earlier run.
    fail "${#missing_payloads[@]} of ${#required_payloads[@]} expected updater payload(s) have no signature in $sigs_dir — nothing was composed, and any manifest already at $out_file has been REMOVED so it cannot be uploaded in place of the one this run refused to write"
  fi
fi

# --- pattern matching -------------------------------------------------------
#
# Asset names are matched by SUFFIX, never compared whole: they carry
# `productName`, the version, and per-bundler arch spellings (`x64` for nsis,
# `amd64` for deb/AppImage), so a hardcoded name would degrade to a silently
# absent platform the first time any of them changes. An unexpected name fails
# loudly here instead.
#
# One slot per discovered payload+signature pair. A second claim on a slot is a
# collision (two archs whose names are identical after all suffixes), and the
# loser would be dropped from the manifest in silence — so it is an error.
win_sig="" win_payload=""
win_exe_sig="" win_exe_payload=""
appimage_targz_sig="" appimage_targz_payload=""
appimage_bare_sig="" appimage_bare_payload=""
deb_sig="" deb_payload=""
rpm_sig="" rpm_payload=""
darwin_sig="" darwin_payload=""

claim() {
  local slot="$1" sig="$2"
  local current="${!slot}"
  if [[ -n "$current" ]]; then
    fail "two signatures claim the same platform (slot $slot: $current and $sig) — refusing to drop one"
  fi
  printf -v "$slot" '%s' "$sig"
}

# The operator-facing hint now comes from the SHARED shape file (see its header),
# so the list an operator is handed cannot drift from the list the release-side
# gate mirrors. The matcher arms below are the same shapes; the composer harness
# extracts both lists and asserts they agree, which is what keeps the `case` arms
# (which also assign slots, so they cannot move) honest against the vocabulary.
accepted_suffixes="$updater_payload_shape_hint"

for sig_path in "${sig_paths[@]}"; do
  sig_name="${sig_path##*/}"
  payload="${sig_name%.sig}"

  case "$payload" in
    # The nsis zip and the raw NSIS installer are BOTH Windows updater payloads,
    # and they are separate slots: tauri-plugin-updater's `extract()` (2.14.0,
    # updater.rs) only unzips when the downloaded bytes ARE a zip and otherwise
    # falls through to `extract_exe()` → `infer::app::is_exe` → a temp `.exe` →
    # `WindowsUpdaterType::nsis` → ShellExecuteW. So the installer a human
    # double-clicks installs perfectly well from the updater.
    #
    # The zip wins the plain `windows-x86_64` key (it unzips — and that matches
    # tauri-action's non-`preferNsis` default, so the bytes the updater prefers
    # are the bytes the release tooling considers primary); the `.exe` keeps
    # `windows-x86_64-nsis`, which names it truthfully: the file IS the NSIS
    # installer. When a release ships ONLY the `.exe` — which is what the real
    # v0.1.0 assets were (`Archimedes_0.1.0_x64-setup.exe{,.sig}`, no
    # `…_setup.nsis.zip`) — the `.exe` serves both keys, because a skipped
    # Windows slot is a Windows install frozen on the current version forever.
    # Each shape still goes through `claim()`, so two zips or two installers
    # collide rather than picking one, and the split is announced, never inferred
    # from the emitted JSON.
    *-setup.exe)
      claim win_exe_sig "$sig_name"; win_exe_payload="$payload"
      ;;
    *_x64-setup.nsis.zip)
      claim win_sig "$sig_name"; win_payload="$payload"
      ;;
    *_amd64.AppImage.tar.gz)
      claim appimage_targz_sig "$sig_name"; appimage_targz_payload="$payload"
      ;;
    *_amd64.AppImage)
      claim appimage_bare_sig "$sig_name"; appimage_bare_payload="$payload"
      ;;
    *_amd64.deb)
      claim deb_sig "$sig_name"; deb_payload="$payload"
      ;;
    # The Fedora rpm is its own installed form and therefore its own slot. Its
    # name comes from a DIFFERENT table than the deb's: `tauri-bundler`'s rpm
    # module builds `{product_name}-{version}-{release}.{arch}.rpm` (release
    # defaults to "1", arch from the Rust-style list — `x86_64`), so the real
    # asset is `Archimedes-0.1.2-1.x86_64.rpm`: DASH- and DOT-separated, never
    # the deb's underscore/`amd64`. The deb's `*_amd64.deb` therefore matches
    # nothing the rpm produces, and the dot spelling here is what makes the real
    # name claim its slot — an arm spelled only `*_x86_64.rpm` (the deb-shaped
    # guess) would reject every real rpm as "unrecognized signature". The
    # underscore spelling is accepted alongside it because the only assets that
    # can carry it are still x86_64 rpms, so neither pattern can produce a wrong
    # key; and because the two spellings are disjoint from the deb's, no deb can
    # reach this arm and no rpm can reach the deb arm above.
    #
    # `x86_64` is spelled literally on purpose: an `*.aarch64.rpm` (a cross build
    # nobody ships) has no updater key to land on, and guessing one would
    # publish a manifest entry no installed client can install — so it stays
    # unrecognized and fails loud.
    *.x86_64.rpm | *_x86_64.rpm)
      claim rpm_sig "$sig_name"; rpm_payload="$payload"
      ;;
    *.app.tar.gz)
      # The macOS payload name carries neither version nor arch (`Archimedes.app
      # .tar.gz`), so a universal-binary build with two archs would put two
      # different bytes under one name. The script refuses to guess which one
      # --arch means: without it, a darwin sig is unrecognized.
      if [[ -z "$arch" ]]; then
        fail "$sig_name is a darwin updater payload and needs --arch darwin-arm64 or darwin-x64 to say which key it belongs to — guessing would silently serve one Apple silicon build to every Mac"
      fi
      claim darwin_sig "$sig_name"; darwin_payload="$payload"
      ;;
    *)
      # Fail-loud, by name: an unrecognized .sig means a real platform would be
      # missing from the manifest, and a missing platform is invisible to CI and
      # permanent on the user's device. Nothing is excused by a wildcard any
      # more — the `.exe` that used to be skipped by an explicit arm is now
      # claimed by one, so EVERY accepted shape ends up in a key, and an
      # unexpected name still lands here with a message saying what IS accepted.
      fail "unrecognized signature: $sig_name (payload would be $payload)
       no updater platform key matches this asset name; accepted payload suffixes: $accepted_suffixes"
      ;;
  esac
done

# --- keys -------------------------------------------------------------------
#
# `used_sigs` backs the orphan check further down: a signature no key references
# means an installed platform nobody can update.
keys=()
payloads=()
sigfiles=()
used_sigs=()
superseded_sigs=()

add_key() {
  local key="$1" payload="$2" sig="$3"
  keys+=("$key")
  payloads+=("$payload")
  sigfiles+=("$sig")
  used_sigs+=("$sig")
}

references_sig() {
  local sig="$1" entry
  # The empty-array guard is explicit: `set -u` and an older bash treat a bare
  # "${arr[@]}" on an empty array as an unbound variable.
  (( ${#used_sigs[@]} == 0 )) && return 1
  for entry in "${used_sigs[@]}"; do
    [[ "$entry" == "$sig" ]] && return 0
  done
  return 1
}

superseded_sig() {
  local sig="$1" entry
  (( ${#superseded_sigs[@]} == 0 )) && return 1
  for entry in "${superseded_sigs[@]}"; do
    [[ "$entry" == "$sig" ]] && return 0
  done
  return 1
}

# Windows: BOTH shapes are payloads (see the two Windows arms above). The nsis
# zip takes the plain key when it exists — the updater unzips it, and that is
# what tauri-action publishes as primary without `preferNsis` — and the raw
# installer takes `-nsis`, which is exactly what it is. With no zip on disk the
# installer serves both keys, so a release that publishes only the `.exe` still
# reaches Windows clients instead of dropping the platform out of the manifest.
if [[ -n "$win_sig" && -n "$win_exe_sig" ]]; then
  add_key "windows-x86_64" "$win_payload" "$win_sig"
  add_key "windows-x86_64-nsis" "$win_exe_payload" "$win_exe_sig"
  printf 'windows: %s wins windows-x86_64 (the updater unzips it); %s keeps windows-x86_64-nsis (the raw NSIS installer)\n' \
    "$win_payload" "$win_exe_payload" >&2
elif [[ -n "$win_sig" ]]; then
  add_key "windows-x86_64-nsis" "$win_payload" "$win_sig"
  add_key "windows-x86_64" "$win_payload" "$win_sig"
elif [[ -n "$win_exe_sig" ]]; then
  add_key "windows-x86_64-nsis" "$win_exe_payload" "$win_exe_sig"
  add_key "windows-x86_64" "$win_exe_payload" "$win_exe_sig"
fi

# Linux: the bare `.AppImage` pair IS the payload that `createUpdaterArtifacts:
# true` produces — the plugin's `install_appimage` (2.14.0) accepts raw ELF bytes
# and writes them straight over `$APPIMAGE`, and it also accepts a gzipped
# AppImage when the bytes sniff as gzip. So a `…AppImage.tar.gz` pair, which only
# the deprecated `createUpdaterArtifacts: "v1Compatible"` ever emits, is accepted
# ahead of the bare one when both happen to exist (it is the more specific
# artifact); the bare `.AppImage` is the normal case, not a fallback. Both Linux
# AppImage keys name whichever pair was chosen — never one key per form, which
# would give a key the corresponding installer cannot install.
#
# The AppImage is required only when a Linux signature is on disk at all: a
# release carrying just Windows (or, later, macOS) assets is a legitimate
# composition, while a Linux set that has a deb but no AppImage is the loud
# failure below. A Linux build that produced NO recognizable Linux asset cannot
# get here silently anyway — its `.sig` matches no pattern and exits earlier as
# "unrecognized signature".
if [[ -n "$appimage_targz_sig$appimage_bare_sig$deb_sig$rpm_sig" ]]; then
  linux_payload=""
  linux_sig=""
  if [[ -n "$appimage_targz_sig" ]]; then
    linux_payload="$appimage_targz_payload"
    linux_sig="$appimage_targz_sig"
    if [[ -n "$appimage_bare_sig" ]]; then
      superseded_sigs+=("$appimage_bare_sig")
    fi
  elif [[ -n "$appimage_bare_sig" ]]; then
    linux_payload="$appimage_bare_payload"
    linux_sig="$appimage_bare_sig"
  else
    fail "no AppImage signature in $sigs_dir (expected *_amd64.AppImage.tar.gz.sig or *_amd64.AppImage.sig) — the AppImage IS the Linux updater payload, so without it a Linux install has nothing to update from"
  fi

  add_key "linux-x86_64" "$linux_payload" "$linux_sig"
  add_key "linux-x86_64-appimage" "$linux_payload" "$linux_sig"

  # The deb key is emitted only once the bare Linux key resolved: the bare key is
  # what a deb install falls back to, and a `-deb` key alongside an unresolvable
  # bare key is precisely the "deb install served the AppImage" bug.
  if [[ -n "$deb_sig" ]]; then
    add_key "linux-x86_64-deb" "$deb_payload" "$deb_sig"
  fi

  # The rpm key follows the SAME rule for the same reason, on the Fedora side:
  # `tauri-plugin-updater`'s `get_urls` (2.14.0) looks up `linux-x86_64-rpm`
  # before the bare `linux-x86_64`, and `install_rpm` shells `pkexec rpm -U`.
  # Without this key an rpm install resolves the bare key, i.e. the AppImage, and
  # fails `install_rpm`'s format check after downloading the whole payload — the
  # identical trap the deb comment above records, so the rpm never touches the
  # bare key's AppImage semantics either way.
  if [[ -n "$rpm_sig" ]]; then
    add_key "linux-x86_64-rpm" "$rpm_payload" "$rpm_sig"
  fi
fi

if [[ -n "$darwin_sig" ]]; then
  case "$arch" in
    darwin-arm64) darwin_key="darwin-aarch64" ;;
    darwin-x64) darwin_key="darwin-x86_64" ;;
  esac
  add_key "$darwin_key" "$darwin_payload" "$darwin_sig"
fi

# The orphan rule's allow-list is exactly ONE case: when the
# `…AppImage.tar.gz` pair is the payload, the bare `…AppImage.sig` covers the
# SAME AppImage in its non-tar form and is therefore superseded, not orphaned.
# That is all it needs to be now that the NSIS `.exe` claims a key of its own —
# every other `.sig` on disk is referenced by a key or the composition fails. An
# unreferenced signature means an installed platform nobody can update.
for sig_path in "${sig_paths[@]}"; do
  sig_name="${sig_path##*/}"
  if ! references_sig "$sig_name" && ! superseded_sig "$sig_name"; then
    fail "signature $sig_name is not referenced by any platform key — refusing to publish a manifest that ignores it"
  fi
done

if [[ ${#keys[@]} -eq 0 ]]; then
  fail "no platform keys could be derived from the signatures in $sigs_dir"
fi

# --- emit -------------------------------------------------------------------
#
# `jq --rawfile` per signature and nothing else: a `.sig` is base64 broken by an
# embedded newline, and any interpolation that leaves that newline raw inside a
# JSON string literal produces invalid JSON. `rtrimstr("\n")` drops exactly the
# single trailing newline the sig file ends with and keeps the embedded one.
pub_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Each referenced signature has to be readable at emit time: `jq --rawfile` on a
# directory or an unreadable file dies with jq's own exit code and a message
# about file I/O, which reads like a broken manifest rather than a missing asset.
for i in "${!keys[@]}"; do
  if [[ ! -f "$sigs_dir/${sigfiles[$i]}" || ! -r "$sigs_dir/${sigfiles[$i]}" ]]; then
    fail "signature file is not a readable regular file: $sigs_dir/${sigfiles[$i]}"
  fi
done

jq_args=(
  --arg version "$version"
  --arg notes "$notes"
  --arg pub_date "$pub_date"
)
entries=()
for i in "${!keys[@]}"; do
  jq_args+=(
    --arg "key_$i" "${keys[$i]}"
    --arg "url_$i" "$base_url/${payloads[$i]}"
    --rawfile "sig_$i" "$sigs_dir/${sigfiles[$i]}"
  )
  entries+=("(\$key_$i): {signature: (\$sig_$i | rtrimstr(\"\n\")), url: \$url_$i}")
done

manifest_filter="{version: \$version, notes: \$notes, pub_date: \$pub_date, platforms: {$(
  IFS=,
  printf '%s' "${entries[*]}"
)}}"

# `2>&1` is safe because a successful `jq -n` writes only the document: anything
# else on stderr means the encode failed, and the message belongs in the error.
if ! platforms_json="$(jq -n "${jq_args[@]}" "$manifest_filter" 2>&1)"; then
  fail "could not encode the manifest as JSON: $platforms_json"
fi

out_dir="${out_file%/*}"
if [[ "$out_dir" != "$out_file" ]]; then
  mkdir -p -- "$out_dir"
fi
printf '%s\n' "$platforms_json" >"$out_file"

# --- self-validation --------------------------------------------------------
#
# Re-reads the file that is about to become the release asset, because the
# composer's own bookkeeping passing is not evidence the emitted JSON is shaped
# the way `tauri-plugin-updater` reads it. Any failure removes the file, so
# there is nothing for a later step to upload.
if ! jq -e --arg base "$base_url/" '
  (.version | type == "string") and
  (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  (.notes | type == "string") and
  (.pub_date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
  ((.platforms | type == "object") and ((.platforms | length) >= 1)) and
  ([.platforms[] | (.signature | (type == "string") and (length > 0))] | all) and
  ([.platforms[] | (.url | (type == "string") and startswith($base))] | all)
' "$out_file" >/dev/null; then
  fail "the manifest just written failed self-validation: $out_file"
fi

printf 'composed %s: %s platform key(s), version %s, tag %s\n' \
  "$out_file" "${#keys[@]}" "$version" "$tag" >&2
exit 0
