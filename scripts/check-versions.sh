#!/usr/bin/env bash
#
# The app's version is written in three places — package.json,
# src-tauri/Cargo.toml, src-tauri/tauri.conf.json — and no build step ties them
# together, so a bump that misses one is invisible until a shipped bundle
# announces the old number. This check makes that PR fail instead.
#
# Usage: check-versions.sh [repo-root]   (default: .)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [repo-root]" >&2
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

repo_root="${1:-.}"

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
  printf 'versions match: %s\n' "$pkg_version"
  exit 0
fi

{
  echo "error: the three version fields disagree"
  printf '  %s: %s\n' "$pkg_file" "$pkg_version"
  printf '  %s: %s\n' "$cargo_file" "$cargo_version"
  printf '  %s: %s\n' "$conf_file" "$conf_version"
} >&2
exit 1
