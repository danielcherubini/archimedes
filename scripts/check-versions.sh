#!/usr/bin/env bash
#
# The app's version is written in three places — package.json,
# src-tauri/Cargo.toml, src-tauri/tauri.conf.json — and no build step ties them
# together, so a bump that misses one is invisible until a shipped bundle
# announces the old number. This check makes that PR fail instead.
#
# On a tag push there is a fourth version, and the three files agreeing with
# each other says nothing about it: tag `v0.1.1` over files that all say `0.1.0`
# publishes an updater manifest whose `version` every installed client rejects
# via `requireSignedVersion` — the device is told an update exists, downloads it,
# and refuses to install it, on every future check. `--tag` folds the tag into
# the same agreement.
#
# Usage: check-versions.sh [repo-root] [--tag vX.Y.Z]   (root default: .)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [repo-root] [--tag vX.Y.Z]" >&2
}

tag=""
repo_root=""

# `--tag` is an OPTION, not a second positional: the CI call site is
# `check-versions.sh --tag "$GITHUB_REF_NAME"` run from the repo root, so the
# root keeps its default and the flag has to be recognisable in either order.
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --tag)
      # A `--tag` with nothing after it must not degrade into "no tag was
      # requested" — the release job would pass while checking nothing.
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --tag requires a value (the git tag, e.g. v0.1.1)" >&2
        usage
        exit 1
      fi
      tag="$2"
      shift 2
      ;;
    --tag=*)
      tag="${1#--tag=}"
      if [[ -z "$tag" ]]; then
        echo "error: --tag requires a value (the git tag, e.g. v0.1.1)" >&2
        usage
        exit 1
      fi
      shift
      ;;
    -*)
      echo "error: unknown argument: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$repo_root" ]]; then
        echo "error: unexpected argument: $1" >&2
        usage
        exit 1
      fi
      repo_root="$1"
      shift
      ;;
  esac
done

repo_root="${repo_root:-.}"

if [[ ! -d "$repo_root" ]]; then
  echo "error: repo root is not a directory: $repo_root" >&2
  usage
  exit 1
fi

# jq is preinstalled on the ubuntu runners and present on dev machines, but a
# bare "jq: command not found" from inside a command substitution reads like a
# broken manifest rather than a missing tool.
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to read the JSON version fields (install it: apt-get install jq / brew install jq)" >&2
  exit 1
fi

pkg_file="package.json"
cargo_file="src-tauri/Cargo.toml"
conf_file="src-tauri/tauri.conf.json"

# Reads the version out of one file, in that file's own notation. A missing file
# or an empty extraction is reported as itself and returns 1 — a half-written
# manifest and a version disagreement need different fixes, so they must not
# collapse into the same message.
read_version() {
  local rel="$1"
  local abs="$repo_root/$rel"

  if [[ ! -f "$abs" ]]; then
    echo "error: version file is missing: $rel" >&2
    return 1
  fi

  local value
  if [[ "$rel" == "$cargo_file" ]]; then
    # Line-anchored, so the package's own `version` is the only thing that can
    # match — dependency versions are written `name = "…"`, never at line start.
    value="$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$abs" | head -n1 || true)"
  else
    # `jq -r` prints the string "null" for an absent key, and exit 0 doing it —
    # `// empty` keeps that literal out of the comparison, and a non-object or
    # unparseable file surfaces as "no version" rather than a bogus match.
    value="$(jq -r '.version // empty' "$abs" 2>/dev/null || true)"
  fi

  if [[ -z "$value" ]]; then
    echo "error: no version found in $rel" >&2
    return 1
  fi

  printf '%s\n' "$value"
}

if ! pkg_version="$(read_version "$pkg_file")"; then exit 1; fi
if ! cargo_version="$(read_version "$cargo_file")"; then exit 1; fi
if ! conf_version="$(read_version "$conf_file")"; then exit 1; fi

if [[ "$pkg_version" == "$cargo_version" && "$cargo_version" == "$conf_version" ]]; then
  agreed_version="$pkg_version"

  # The tag is the version the release ANNOUNCES; the files are the version the
  # bundle carries. Both are asserted here, in this order, so a `v`-less tag is
  # reported as the bad argument it is rather than as a version disagreement.
  if [[ -n "$tag" ]]; then
    if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
      echo "error: --tag must be v followed by X.Y.Z (got: $tag)" >&2
      exit 1
    fi
    tag_version="${BASH_REMATCH[1]}"
    if [[ "$tag_version" != "$agreed_version" ]]; then
      # Both values, explicitly: on a failed release the operator's only question
      # is which side to fix — the tag, or the three files.
      {
        echo "error: the tag does not match the app's version"
        printf '  tag %s: %s\n' "$tag" "$tag_version"
        printf '  version files: %s\n' "$agreed_version"
        echo "  a tag that outruns the files publishes an update every client rejects (requireSignedVersion), so nothing installed would ever take it"
      } >&2
      exit 1
    fi
  fi

  printf 'versions match: %s\n' "$agreed_version"
  exit 0
fi

{
  echo "error: the three version fields disagree"
  printf '  %s: %s\n' "$pkg_file" "$pkg_version"
  printf '  %s: %s\n' "$cargo_file" "$cargo_version"
  printf '  %s: %s\n' "$conf_file" "$conf_version"
} >&2
exit 1
