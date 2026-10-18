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
#     [--notes TEXT] [--arch darwin-arm64|darwin-x64]

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: compose-updater-manifest.sh --sigs-dir DIR --version X.Y.Z --tag TAG \
                                   --repo owner/name --out FILE \
                                   [--notes TEXT] [--arch darwin-arm64|darwin-x64]
USAGE
}

# Every exit-1 path funnels through here so a rejected manifest can never be
# left on disk for the next step to `gh release upload` — a partial `latest.json`
# published over a good one is worse than no manifest at all.
fail() {
  printf 'error: %s\n' "$1" >&2
  if [[ -n "$out_file" && -e "$out_file" ]]; then
    rm -f -- "$out_file"
  fi
  exit 1
}

sigs_dir=""
version=""
tag=""
repo=""
out_file=""
notes=""
arch=""

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

accepted_suffixes='*_x64-setup.nsis.zip, *_setup.exe (the raw NSIS installer), *_amd64.AppImage, *_amd64.AppImage.tar.gz, *_amd64.deb, *_x86_64.rpm, *.app.tar.gz (the last one needs --arch)'

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
