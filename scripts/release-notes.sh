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
# nothing looks wrong. The two existence checks below (a release object for the
# tag, and the git ref behind it) are the whole reason this is a testable script
# rather than YAML (see scripts/release-notes.test.sh).
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

# jq is required, and it is checked here rather than discovered mid-run. The
# comparison base is selected by a jq filter, so without it there is no base and
# no honest notes.
#
# This check used to carry a stronger reason: the filter ran in a pipeline whose
# errors were swallowed, so a MISSING jq and a legitimately EMPTY listing were
# indistinguishable at the point of use, and the first produced notes about every
# release the repository has ever had. The listing now fails loudly when it fails
# (see below), which closes that hole structurally — so what this check buys today
# is an accurate early message ("jq is required") instead of one that blames the
# release list for a missing binary. It stays because that message is the one a
# person acting on it can use, and because it stops the run before any call is
# made at all.
if ! command -v jq >/dev/null 2>&1; then
  fail "jq is required to generate release notes (it selects the comparison base; without it the notes could describe every release rather than this one)"
fi

# --- the checks the endpoint will not do for us -----------------------------
#
# Two guards, in this order, and the order is a decision:
#
#   1. does a RELEASE OBJECT exist for this tag? `gh release view` knows;
#      `generate-notes` does not ask (see the header).
#   2. does the GIT REF behind the tag still exist? `gh api …/git/ref/tags/…`
#      knows; a release object keeps existing when its tag is deleted.
#
# The object goes first because that is the COMMON failure — a typo'd tag — and it
# deserves the message this script was written to give. The ref check is then only
# ever reached for a tag that DOES have a release, which is the narrow and strange
# case (an orphaned release whose tag was deleted after creation, one of the two
# cases this file's header names as motivation), so each error means exactly one
# thing instead of guessing which of the two is missing.
#
# Both run before the listing below and before any generator call: deriving a
# comparison base for a release that will not be described is wasted API calls,
# and calling the generator first is the exact bug this script exists to prevent.
#
# Every `gh` call names the repository — `--repo` for the subcommands, which
# otherwise resolve it from the CHECKOUT, and the owner/name inside the API path
# for `gh api`. A fork or a renamed repository is why: there the current-directory
# remote is not the repository being released, so an unaddressed lookup can reject
# a release that exists upstream or read a comparison base from the wrong repo's
# tags. `--repo` is required by this script for the same reason; it would be a
# contradiction to demand it of the caller and then not use it.
if ! gh release view "$tag" --json tagName --repo "$repo" >/dev/null 2>&1; then
  fail "no release exists for tag $tag in $repo — refusing to generate notes, because GitHub's generator answers anyway, with the most recent REAL release's changes, for a tag that does not exist"
fi

# The release object is not the tag. `gh release view` passing says nothing about
# the ref, and the deleted-tag case is a stated motivation for this script, so the
# claim is checked rather than assumed. Measured against the live API: an existing
# tag answers 200, a missing one answers 404 and `gh api` exits 1.
if ! gh api "repos/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
  fail "the git tag $tag does not exist in $repo, although a release object for it does — refusing to generate notes for a tag that is not there (the release was created and the tag deleted afterwards, or the ref was never pushed)"
fi

# --- the comparison base ----------------------------------------------------
#
# "Notes since the last release" is what a release page means, and the workflow
# knows only the tag it is releasing, so the base has to be derived when the
# caller did not name one. Four traps in the obvious one-liner, each pinned by a
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
#   - A lookup that FAILS is not a repository with no previous release. Swallowing
#     the error (the `2>/dev/null || true` this replaced) makes a 502, a 403 or an
#     exhausted rate limit indistinguishable from a genuine first release, and the
#     script then exits 0 with notes describing every change since the beginning.
#     `release.yml` runs this step with `continue-on-error: true` and falls back to
#     the placeholder, so exit 1 is the loud, correctly-handled path — returning 0
#     here does not degrade gracefully, it switches off the workflow's own
#     backstop. Fail, and quote gh's reason.
#
# Tags whose shape is not `vX.Y.Z` are filtered out here rather than passed on:
# an old release could legitimately sit on `2024.5.1`, the endpoint REJECTS that
# as a comparison base with a 400, and a release must not fail because of the
# shape of someone else's tag.
#
# WHY `gh api … --paginate` AND NOT `gh release list --limit N`. `--limit` is a
# newest-first window, and "the nearest predecessor" is not guaranteed to be inside
# any fixed window: a maintenance line can accumulate more than N newer releases
# above the tag it is patching, at which point the predecessor is simply not in the
# answer and the notes silently widen to the whole history. `--limit -1` and
# `--limit 0` are both rejected with `invalid limit` and exit 1 (verified against gh
# 2.97.0), so there is no "everything" keyword — but be honest about the rest: a
# large finite limit DOES fetch past the first page (`--limit 100000` returns all
# 206 releases of cli/cli), so the flag could be pushed to work. `--paginate` is
# still the right call, for two reasons that are not about capability: a magic
# number is a ceiling someone has to maintain and can get wrong, and `--paginate`
# has no ceiling to be wrong about. It also keeps every call in this script the same
# shape — a `gh api` path carrying the owner/name — which is what makes the
# repository addressing above auditable in one grep.
#
# NO `--jq` on that call, deliberately. `gh api --paginate --jq FILTER` runs the
# filter ONCE PER PAGE and prints each page's result, so a bracketed filter emits
# one array PER PAGE (measured: two pages in, two arrays out) and the aggregation
# below would take a maximum per page instead of one overall — the wrong-base bug
# this section exists to prevent, wearing the fix's clothes. The field names differ
# too: the raw endpoint answers `tag_name`/`draft`/`prerelease`, and reading
# gh's `--json` camelCase names off the raw response yields `null` for all three,
# which every filter below then rejects — an empty base, silently. So the pages are
# taken as they come and aggregated by real `jq`, with `-s` and an explicit
# flatten so ONE merged array, a stream of per-page arrays, or a stream of single
# objects all aggregate to the same single answer.
#
# The cost of not filtering server-side is bandwidth: each release arrives with
# its body and assets (45 KB for this repository's three releases, ~7 MB for a
# repository with 205). That is a fetch a release runs once, and it is cheaper
# than a wrong comparison base — which is the failure this script exists to
# prevent. If it ever matters, the safe filter is the UNBRACKETED
# `--jq '.[] | {tag_name, draft, prerelease}'`: it streams one object per release,
# which `-s` still collects into one array. The bracketed form is the one that
# breaks, because it wraps each PAGE.
if [[ -z "$previous" ]]; then
  if ! listing="$(gh api "repos/$repo/releases" --paginate 2>&1)"; then
    fail "could not list the releases of $repo, so the comparison base is unknown — refusing to generate notes that would silently describe every release the repository has ever had: $listing"
  fi
  if ! previous="$(
    printf '%s\n' "$listing" | jq -s -r --arg tag "$tag" '
      # `-s` FIRST, then one level of flatten: the pages have to be merged before
      # anything is compared, because `max_by` over a per-page stream takes a
      # maximum PER PAGE. Slurping also makes the aggregation independent of how
      # many top-level values arrive, so one merged array, a stream of per-page
      # arrays, or a stream of single objects all give the same answer.
      [ .[] | if type == "array" then .[] else . end ]
      | map(select(type == "object" and ((.tag_name | type) == "string")))
      | ($tag | sub("^v"; "") | split(".") | map(tonumber)) as $current
      | map(select(.draft == false and .prerelease == false and .tag_name != $tag))
      | map(select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")))
      | map(. + {v: (.tag_name | sub("^v"; "") | split(".") | map(tonumber))})
      | map(select(.v < $current))
      | max_by(.v)
      | .tag_name // empty
    ' 2>&1
  )"; then
    # `2>&1` is how gh's/jq's own reason ends up quoted in the message, and it is
    # safe only because BOTH are silent on stderr when they succeed (measured). If
    # that ever changes, a warning would be glued onto the base — and the shape
    # check below is what catches it before the value reaches a command line.
    fail "could not read the release list of $repo, so the comparison base is unknown — refusing to guess it: $previous"
  fi
  # The filter above already guarantees this shape, and the check would be dead
  # if the filter were the only thing that ever ran. It stays because the value is
  # about to be interpolated onto a command line, and because a future edit to that
  # jq expression is exactly the kind of change that would quietly widen it — a
  # per-page aggregation, for instance, would put TWO tags on two lines here.
  if [[ -n "$previous" && ! "$previous" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'note: dropping the derived comparison base %s — not a vX.Y.Z tag\n' "$previous" >&2
    previous=""
  fi
  # Say so when there is no base at all, having ESTABLISHED that the listing
  # answered rather than failed. For a first release that is expected; for a
  # repository with five releases on it means every candidate was excluded, and the
  # resulting notes describe far more than this release — a person reading the
  # release page deserves to be told which of the two happened.
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
