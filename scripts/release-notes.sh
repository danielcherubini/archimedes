#!/usr/bin/env bash
#
# Generates this release's notes from GitHub's own generator and writes them to a
# file, so a shipped release describes its changes instead of showing the
# placeholder it was created with.
#
# WHY THIS EXISTS. `release.yml` creates the draft with `--notes "Archimedes
# $TAG"` — a non-empty placeholder, chosen so a release page was never blank —
# and nothing has ever replaced it. Every installed release therefore reads
# exactly that one line, on the release page AND in Settings → Updates (the
# in-app panel renders the `notes` field of `latest.json`, which
# `tauri-plugin-updater` exposes as `update.body`). The repo has GitHub's
# automatic generation available and uses none of it. This script closes that
# gap in one place, so the workflow step and a human at a terminal cannot
# drift apart.
#
# WHY A SCRIPT AND NOT TWO `gh` LINES IN YAML. Because the failure mode of the
# obvious version is silent and specific: `POST /releases/generate-notes` does
# NOT validate `tag_name`. Asked for `v9.9.9` — a tag that has never existed in
# this repository — it answers 200 with a confident, correctly formatted
# "## What's Changed" list describing the most recent REAL release. So a typo,
# or a tag deleted between the push and the step, does not fail; it publishes
# notes about the wrong changes, which is worse than an empty page because
# nothing looks wrong. The existence check below is the whole reason this is a
# testable script rather than YAML (see scripts/release-notes.test.sh).
#
# The CURATION of those notes is deliberately out of scope here: this produces
# the generated draft, and a person rewrites it into human-facing prose. What
# this script guarantees is that the draft is real, non-empty, and about the
# right tag.
#
# Usage:
#   release-notes.sh --repo owner/name --tag vX.Y.Z [--previous vX.Y.Z] --out FILE
#
# stdout is exactly ONE line — a short summary (`vX.Y.Z — N changes: URL`). It is
# machine-consumed: the updater manifest wants a one-liner, because the in-app
# "update available" panel renders it as a single paragraph, so the markdown body
# must never be what reaches it. Every diagnostic goes to stderr.
#
# Exit codes: 0 wrote a usable body; 1 refused or generated nothing usable.
# A failure removes any partial output file, so there is nothing for a later
# step to upload — the same rule the manifest composer follows.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: release-notes.sh --repo owner/name --tag vX.Y.Z [--previous vX.Y.Z] --out FILE
USAGE
}

fail() {
  printf 'error: %s\n' "$1" >&2
  if [[ -n "$out_file" && -e "$out_file" ]]; then
    rm -f -- "$out_file"
  fi
  exit 1
}

repo=""
tag=""
previous=""
out_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --previous) previous="${2:-}"; shift 2 ;;
    --out) out_file="${2:-}"; shift 2 ;;
    *)
      usage
      fail "unknown flag: $1"
      ;;
  esac
done

if [[ -z "$out_file" ]]; then
  usage
  fail "--out is required (the file the generated markdown body is written to)"
fi

if [[ -z "$repo" ]]; then
  usage
  fail "--repo is required (owner/name) — never defaulted, because on a fork or a renamed repository the current-directory remote is not the repository being released"
fi

# `owner/name` and nothing else. This value goes into an API path, and gh also
# accepts `HOST/OWNER/REPO`; widening it later is a decision, not an accident.
if [[ ! "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  usage
  fail "--repo must be owner/name, got: $repo"
fi

# A tag name is text someone pushed — `release.yml` says the same thing about its
# own steps ("attacker-visible input the moment someone pushes `v1.0.0; curl
# evil`"). The values are only ever passed as single argv words, and this check
# means a hostile or malformed tag is REFUSED rather than merely quoted, so the
# rule survives someone later rebuilding a command line out of strings.
if [[ -z "$tag" ]]; then
  usage
  fail "--tag is required (the tag being released, e.g. v0.2.0)"
fi
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "--tag must be a v-prefixed version like v0.2.0, got: $tag (the manifest composer rejects the same shape for the same reason: the tag's v and the manifest's bare version are not interchangeable)"
fi
if [[ -n "$previous" && ! "$previous" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "--previous must be a v-prefixed version like v0.1.1, got: $previous"
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "gh is required to generate release notes"
fi

# jq is required, and the reason is the same failure this script exists to
# prevent. The comparison-base filter below runs inside a pipeline whose errors
# are swallowed so that "no eligible previous release" degrades into "describe
# everything" — correct for an EMPTY answer, dangerous for a MISSING jq, because
# the two are indistinguishable at that point and the second produces notes about
# every release the repository has ever had, formatted exactly like a normal
# release's notes. Fail here instead of guessing there.
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required to generate release notes (it selects the comparison base; without it the notes could describe every release rather than this one)"
fi

# --- the check the endpoint will not do for us ------------------------------
#
# `gh release view` is what knows whether a release exists for this tag;
# `generate-notes` does not ask (see the header). So this runs BEFORE any API
# call — the tests assert the endpoint is never reached for a tag with no
# release behind it, because calling it first is what produces confident notes
# about the wrong release.
if ! gh release view "$tag" --json tagName >/dev/null 2>&1; then
  fail "no release exists for tag $tag — refusing to generate notes, because GitHub's generator answers anyway, with the most recent REAL release's changes, for a tag that does not exist"
fi

# --- the comparison base ----------------------------------------------------
#
# "Notes since the last release" is what a release page means, and the workflow
# knows only the tag it is releasing, so the base has to be derived when the
# caller did not name one. Three traps in the obvious one-liner, each pinned by a
# test case:
#
#   - `gh … --jq` is an embedded gojq expression and accepts NO `--arg`, so the
#     tag cannot be a parameter there — that form is not merely untestable, it is
#     invalid (`unknown command "tag"`). The listing is piped to real `jq`.
#   - "newest release" is not "the release before this one". A patch cut from an
#     older line — v0.2.1 released after v0.3.0 exists — would be compared
#     AGAINST A LATER release, and any ordering by DATE gives that answer. The
#     base is chosen by VERSION: the greatest tag strictly below this one.
#   - DRAFTs and PRERELEASEs are never a base. The draft can be the very release
#     whose notes are being written (a release compared with itself generates
#     nothing), and a prerelease's changes are already counted in its final.
#
# Tags whose shape is not `vX.Y.Z` are filtered out here rather than passed on:
# an old release could legitimately sit on `2024.5.1`, the endpoint REJECTS that
# as a comparison base with a 400, and a release must not fail because of the
# shape of someone else's tag. 30 entries is gh's default and far more than "the
# nearest predecessor" needs.
if [[ -z "$previous" ]]; then
  previous="$(
    gh release list --limit 30 --json tagName,isDraft,isPrerelease \
      | jq -r --arg tag "$tag" '
          ($tag | sub("^v"; "") | split(".") | map(tonumber)) as $current
          | map(select(.isDraft == false and .isPrerelease == false and .tagName != $tag))
          | map(select(.tagName | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")))
          | map(. + {v: (.tagName | sub("^v"; "") | split(".") | map(tonumber))})
          | map(select(.v < $current))
          | max_by(.v)
          | .tagName // empty
        ' 2>/dev/null || true
  )"
  # The filter above already guarantees this shape, and the check would be dead
  # if the filter were the only thing that ever ran. It stays because the value
  # is about to be interpolated onto a command line, and because a future edit to
  # that jq expression is exactly the kind of change that would quietly widen it.
  if [[ -n "$previous" && ! "$previous" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'note: dropping the derived comparison base %s — not a vX.Y.Z tag\n' "$previous" >&2
    previous=""
  fi
  # Say so when there is no base at all. For a first release that is expected;
  # for a repository with five releases on it means every candidate was excluded,
  # and the resulting notes describe far more than this release — a person
  # reading the release page deserves to be told which of the two happened.
  if [[ -z "$previous" ]]; then
    printf 'note: no comparison base found — the notes describe every change since the beginning\n' >&2
  fi
fi

# An empty or invented base is how a FIRST release ends up with no notes: the
# endpoint rejects `previous_tag_name=` as invalid, so the flag is simply omitted
# and GitHub describes everything since the beginning.
api_args=(
  -X POST
  "repos/$repo/releases/generate-notes"
  -f "tag_name=$tag"
)
if [[ -n "$previous" ]]; then
  api_args+=(-f "previous_tag_name=$previous")
fi

# `--jq .body` because the generator returns {name, body} and only the body is
# wanted; `name` duplicates the title the release already carries.
if ! body="$(gh api "${api_args[@]}" --jq .body 2>&1)"; then
  fail "could not generate release notes for $tag: $body"
fi

# "Generated nothing" is a failure, not a success with an empty file: an empty
# notes body on a published release is the exact state this script exists to
# end, and it is reachable — two tags with no merged PR between them (a re-tag,
# or a hotfix cut at the same commit) produce a 200 with no bullets.
if [[ -z "${body//[[:space:]]/}" ]]; then
  fail "the generator returned empty notes for $tag${previous:+ against $previous} — nothing was written, so the release keeps whatever notes it already has"
fi

out_dir="${out_file%/*}"
if [[ "$out_dir" != "$out_file" ]]; then
  mkdir -p -- "$out_dir"
fi
# `printf '%s\n'`, not `echo`: the body is generated text that may begin with a
# dash, and `echo` would read that as its own flag.
printf '%s\n' "$body" >"$out_file"

# --- the one-line summary ---------------------------------------------------
#
# Counts the changelog BULLETS, because the generated body also carries a header
# and a bold `**Full Changelog**` line, and counting those would overstate every
# release in the one sentence the in-app panel shows. The bullet shape is
# GitHub's own (`* …`); a custom `.github/release.yml` changes categories, not
# the bullet character, so this stays honest — and a count of 0 is still a real
# body, so it is reported rather than treated as an error.
change_count="$(printf '%s\n' "$body" | grep -c '^\* ' || true)"

# stdout, and nothing else on it. No word of the body appears here: the value is
# fed to the manifest composer's `--notes`, which renders in a settings panel.
printf '%s — %s changes: https://github.com/%s/releases/tag/%s\n' \
  "$tag" "$change_count" "$repo" "$tag"

printf 'wrote %s for %s (%s changes)%s\n' \
  "$out_file" "$tag" "$change_count" "${previous:+, compared with $previous}" >&2
