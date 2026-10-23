#!/usr/bin/env bash
#
# Requires a `.sig` beside EVERY installer asset on a release, and prints the
# installer payload list it accepted. This is the release's signature-completeness
# gate (issue #41(d)).
#
# WHY THE CHECK HAD TO RUN IN THE OTHER DIRECTION. What AGENTS.md told the
# releaser to do was "count distinct `.platforms[].url` basenames in the shipped
# manifest and require a `.sig` for each". That check CANNOT fail:
# `compose-updater-manifest.sh` derives its platform keys FROM the `.sig` files it
# was handed, so an installer whose signature was never uploaded is missing from
# BOTH sides of that comparison at once. Its left side is a projection of its
# right side, so it passes exactly when it should fail — measured on this tree, a
# fixture holding a signed AppImage and deb plus an UNSIGNED rpm and `.exe` made
# the composer print "3 platform key(s)" and exit 0. Those two installs never
# learn an update exists, and nothing anywhere was red.
#
# So the question is asked of the RELEASE, which is the ground truth and the only
# input that can answer it: for every asset `X` on the release, `X.sig` must be
# there too. Per asset, never by counting (see the ratio note below). The manifest
# is never read — not for its key count, not for its URLs, not at all.
#
# THE RATIO IS NOT 1:1 — MATCH PER ASSET. `createUpdaterArtifacts: true` makes the
# installer itself the updater payload, so several manifest keys legitimately
# share one file: on the real v0.6.0 release FOUR signatures serve SIX platform
# keys (`windows-x86_64` and `-nsis` share the `.exe`; `linux-x86_64` and
# `-appimage` share the `.AppImage`). A check that compared a file count to a key
# count would report "2 sigs missing" on every healthy release — the phantom that
# nearly withheld v0.3.1, recorded in ADR 0052's first amendment. Reading the
# asset list per asset makes that comparison impossible to write by accident,
# which is why this script does not look at `latest.json`'s contents even though
# it is staring at the release that carries it.
#
# THE ALLOW-LIST IS A SKIP FILTER, NOT A REQUIRED SET. Three kinds of asset are
# legitimately not installers: every `*.sig` (it IS a signature — treating it as a
# payload would demand `X.sig.sig`), every `.dmg` (README: "a `.dmg` gets no
# `.sig` at all and is never an updater payload"), and `latest.json` itself (the
# manifest, not a payload). NONE of them may be DEMANDED: the gate runs while the
# release is still a DRAFT and before `Upload the updater manifest`, so on a normal
# run `latest.json` does not exist yet, and no `.dmg` exists at all until macOS
# packaging is enabled. The list is an allow-list of NON-payloads, so a future
# format whose bundler does not sign — or an added asset like a checksum file —
# fails loud and forces someone to add it deliberately. That bias is intended.
# (`.msi` needs no entry: tauri-cli signs `WindowsMsi`, and it is not in
# tauri.conf.json's `bundle.targets` anyway.)
#
# Usage:
#   check-release-signatures.sh --repo owner/name --tag vX.Y.Z
#
# stdout is the accepted installer payload names, ONE PER LINE, sorted with
# `LC_ALL=C` (byte order, so the mix of `-` and `_` in the asset names does not
# sort differently on the runner's en_US.UTF-8 collation than it does here, and the
# workflow's `--require-payload` argument list is reproducible). Every diagnostic
# goes to stderr. stdout is a machine-consumed contract: `release.yml` redirects it
# to a file and turns every line into a `--require-payload` flag on the composer,
# so the two gates share ONE allow-list instead of each keeping a copy.
#
# Exit codes: 0 every installer is signed; 1 something is unsigned, the release is
# not there, or the release carries no installers at all (a vacuous pass is the bug
# this file exists to kill, so it is refused rather than reported as success).

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: check-release-signatures.sh --repo owner/name --tag vX.Y.Z

Requires a <name>.sig asset beside every installer asset on a release, and prints
the installer payload names it accepted (one per line, on stdout) so the caller can
hand them to compose-updater-manifest.sh --require-payload.
USAGE
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

repo=""
tag=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    # Every value-taking flag guards BEFORE `shift 2`. Without the guard, a flag
    # passed as the last argument shifts past the end of argv and dies under
    # `set -e` with exit 1 and no message at all — the behaviour the manifest
    # composer's own flags have, and the reason this file copies check-versions.sh
    # rather than that one.
    --repo)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        usage
        fail "--repo requires a value (owner/name)"
      fi
      repo="$2"; shift 2
      ;;
    --tag)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        usage
        fail "--tag requires a value (the tag being released, e.g. v0.2.0)"
      fi
      tag="$2"; shift 2
      ;;
    *)
      usage
      fail "unknown flag: $1"
      ;;
  esac
done

# `--repo` is REQUIRED and never defaulted from the checkout. `release-notes.sh`
# makes the argument verbatim and it applies here word for word: an unaddressed
# `gh` call resolves the repository from the CHECKOUT, which on a fork or a
# renamed repository is not the repository being released — so the gate could
# certify a different repository's assets, or fail on a release that exists
# upstream.
if [[ -z "$repo" ]]; then
  usage
  fail "--repo is required (owner/name) — never defaulted, because on a fork or a renamed repository the current-directory remote is not the repository being released"
fi

if [[ ! "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  usage
  fail "--repo must be owner/name, got: $repo"
fi

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "--tag must be a v-prefixed version like v0.2.0, got: ${tag:-<empty>} (a tag name is text someone pushed; the release-notes script and the manifest composer reject the same shape for the same reason)"
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "gh is required to read the release's asset list (apt-get install gh / brew install gh)"
fi

# jq is what turns the asset list into two name sets, so a missing jq is checked
# up front rather than discovered mid-filter: "jq is required" is a message the
# person acting on it can use, and it stops the run before any API call is made.
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required to read the release's asset list (apt-get install jq / brew install jq)"
fi

# One call, and it names the repository. NO `--jq` on the `gh` call itself:
# `release-notes.sh` documents that trap (gh's `--jq` is an embedded gojq
# expression that accepts no `--arg`, so a fixture cannot parameterise it, and
# under `--paginate` it runs once per page). Here it is simply piped into real
# `jq`, which the harness can drive with a canned document.
#
# The measured response shape (gh 2.97.0, against the live v0.6.0 release):
# `{"assets":[{"name":…,"state":"uploaded"|"pending","size":…,"contentType":…,
# "downloadCount":…,"url":…},…]}`. Only `name` is read — see the `state` note
# below.
if ! assets_json="$(gh release view "$tag" --json assets --repo "$repo" 2>&1)"; then
  # Naming the tag is the point: "no release for v0.9.9" and "that release has no
  # installers" send the operator to completely different places, and a typo'd tag
  # must not read as a healthy empty release.
  fail "no release could be read for tag $tag in $repo — refusing to check signature completeness against a release that is not there: $assets_json"
fi

# --- the two name sets ------------------------------------------------------
#
# The SKIP set is `*.sig` (a signature is not an installer), `*.dmg` (never an
# updater payload, never signed) and `latest.json` (the manifest). The INSTALLER
# set is everything else. `state` is deliberately NOT consulted: gh reports
# `uploaded` / `pending` per asset (measured against v0.6.0), and filtering on
# `uploaded` would let a pending installer with a pending signature pass — a claim
# about an upload that has not finished, which is not a claim worth making. The
# presence of the NAME is what "a sig beside it" means.
#
# `[.assets[]?]` tolerates `assets` being absent or null so the anti-vacuity guard
# below sees one empty set rather than jq dying on a shape it recognises as "no
# installers".
installer_names="$(
  printf '%s\n' "$assets_json" | jq -r '
    def is_skip:
      (type == "string") and
      (endswith(".sig") or endswith(".dmg") or . == "latest.json");
    [ .assets[]? | .name | select(type == "string") ]
    | map(select(is_skip | not))
    | .[]
  '
)"
skipped_names="$(
  printf '%s\n' "$assets_json" | jq -r '
    def is_skip:
      (type == "string") and
      (endswith(".sig") or endswith(".dmg") or . == "latest.json");
    [ .assets[]? | .name | select(type == "string") ]
    | map(select(is_skip))
    | join(", ")
  '
)"
all_names="$(
  printf '%s\n' "$assets_json" | jq -r '[ .assets[]? | .name | select(type == "string") ] | .[]'
)"

# The arrays `set -u` can safely expand, and the lookup table for "is this name on
# the release?". Splitting on newlines is safe because a GitHub asset name cannot
# contain one (the upload path names a file).
installers=()
if [[ -n "$installer_names" ]]; then
  while IFS= read -r line; do
    installers+=("$line")
  done <<<"$installer_names"
fi
assets=()
if [[ -n "$all_names" ]]; then
  while IFS= read -r line; do
    assets+=("$line")
  done <<<"$all_names"
fi

has_asset() {
  local wanted="$1" entry
  (( ${#assets[@]} == 0 )) && return 1
  for entry in "${assets[@]}"; do
    [[ "$entry" == "$wanted" ]] && return 0
  done
  return 1
}

# --- the anti-vacuity gate --------------------------------------------------
#
# "Every installer on the release has a signature" is trivially true when the
# release has no installers, and that state is reachable: a build matrix that
# uploaded nothing, an asset list that came back empty for any reason, or a
# release someone created by hand. Measured, `{"assets":null}` and `{"assets":[]}`
# both yield an empty set through the filter above, so this guard is load-bearing
# rather than defensive — it is the reason the inverse check cannot itself pass
# vacuously, which is the exact class of bug this task exists to fix.
if [[ ${#installers[@]} -eq 0 ]]; then
  fail "release $tag in $repo carries no installer assets at all (only ${skipped_names:-nothing}) — refusing to report an empty release as fully signed"
fi

# --- the per-asset requirement ---------------------------------------------
#
# `X` present ⇒ `X.sig` present, checked one installer at a time. Every offender is
# collected and printed before exiting: a gate that stops at the first makes the
# operator rebuild-and-recheck once per missing signature, and the hole has to be
# visible whole.
missing=()
for installer in "${installers[@]}"; do
  if ! has_asset "$installer.sig"; then
    missing+=("$installer")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'error: %s of %s installer asset(s) on release %s have no signature beside them:\n' \
    "${#missing[@]}" "${#installers[@]}" "$tag" >&2
  for installer in "${missing[@]}"; do
    printf '  %s -> missing %s.sig\n' "$installer" "$installer" >&2
  done
  printf 'error: upload the missing signatures, or remove the installer from the release — do not compose a manifest over an incomplete sig set (the composer derives its platform keys from the .sig files it is handed, so it would emit a smaller manifest and exit 0)\n' >&2
  exit 1
fi

# stdout, and nothing else on it: this list is the composer's expectation list.
printf '%s\n' "${installers[@]}" | LC_ALL=C sort

printf 'every installer asset on %s is signed (%s installer(s): %s; skipped %s)\n' \
  "$tag" "${#installers[@]}" "$(IFS=', '; printf '%s' "${installers[*]}")" \
  "${skipped_names:-nothing at all}" >&2
