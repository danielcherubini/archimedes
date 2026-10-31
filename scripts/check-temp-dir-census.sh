#!/usr/bin/env bash
#
# Fail if the Rust test suite left a NEW directory in the temp dir it writes into.
#
# This is the lock on #96. The eight commits before this one got a full green
# `TMPDIR=/tmp cargo test` down from 431 leftover directories per run to zero;
# nothing enforces that. The same nine commits of regression are available to the
# next person who writes `std::env::temp_dir().join(..)` and forgets the
# `ScratchDir` guard, and a leak that outlives a test is not a style problem — it
# is the disk-full, inode-exhausted, `/tmp` full of 26 000 entries state that
# made #96 a bug report instead of a tidy-up.
#
# WHY A WHOLE-TEMP-DIR DIRECTORY DELTA AND NOT A PREFIX ALLOW-LIST (the decision
# that shapes every line below, recorded here because `docs/roadmap/` is
# gitignored and the next reader must not have to find it):
#
#   An allow-list — census only the ~79 known prefixes and require each to delta
#   0 — is STRUCTURALLY BLIND TO THE EXACT BUG IT EXISTS TO CATCH. Every leak
#   this branch fixed was a *known* prefix; the bug that re-opens #96 is a NEW
#   test minting a NEW prefix, and a name the list does not contain is a name the
#   list never looks at. Such a guard passes forever, on every leak, for the one
#   class of regression it was written for. It would also need `! -name`
#   exclusions for the superset globs (`harness-loop-*` ⊃ `harness-loop-test-*`),
#   a strict `skill-esc-*`, a second `db-*` glob — and every one of those is a
#   filter that can silently match 0 and report success, which is this issue's
#   most-repeated failure mode (D7).
#
#   A whole-temp-dir delta asks one question — *what exists now that did not
#   exist before?* — and it cannot be blind to a prefix nobody has thought of
#   yet, because it never asks about prefixes. The asymmetry decides it: the
#   allow-list fails as SILENT PERMANENT GREEN; the delta fails as a VISIBLE
#   FALSE POSITIVE (a foreign process writing into the temp dir mid-bracket),
#   which is exactly what the "print the offending names + attribution" failure
#   message is for — a name that attributes to no file in the table is
#   recognisable as foreign in one read. A guard that occasionally cries wolf and
#   tells you who it blamed is a working guard; a guard that cannot see the wolf
#   is not a guard.
#
# Prefixes therefore survive ONLY as the ATTRIBUTION table below (so a red sends
# you to the right file), never as the filter.
#
# Two filters DO exist — the Darwin-only shape exclusion further down — and
# they are NOT the shape this section rejects. Read `exclusion_applies_here` for
# why a SHAPE (the name contains a dot, OR the name contains no dash) has none of
# the allow-list's blindness and needs no widening as daemons come and go.
#
# USAGE
#   check-temp-dir-census.sh snapshot --state FILE [--base DIR]
#   check-temp-dir-census.sh verify   --state FILE [--base DIR]
#   check-temp-dir-census.sh base [--base DIR]
#   check-temp-dir-census.sh --self-test
#
# `--base` exists for `check-temp-dir-census.test.sh`'s fixtures and for nothing
# else. **CI must never pass it**: the whole point is that the script resolves the
# base the way Rust's `temp_dir()` does, and a `--base` in the CI call is how this
# guard becomes vacuous by pointing somewhere else.
#
# READ-ONLY. `snapshot` and `verify` mutate NOTHING — no `rm`, no `rmdir`, no
# `touch`, not even of a stale state file. This box holds ~26k `/tmp` entries
# including thousands of historical `archimedes-*` directories from before the
# fix, and a delta is immune to them; a guard that swept by pattern would be the
# `systemd-tmpfiles` mistake #96 explicitly rejects (its dry run proposed
# deleting 151 live source files inside scratch git clones). `--self-test` is the
# ONLY mode that writes, and it removes only the exact paths it created in that
# same invocation, by name, via an EXIT trap — never by glob, never by pattern.
# Deleting a directory you created microseconds ago by its exact name is not a
# sweep.
#
# NOT IN THE MAKEFILE, DELIBERATELY: `make check` is the documented merge bar and
# runs `cargo test` from the repo root; a census there needs a snapshot of its own
# and is a separate decision. This is a CI gate plus a script you can run by hand:
#   bash scripts/check-temp-dir-census.sh snapshot --state ~/.cache/census.txt
#   (cd src-tauri && TMPDIR=/tmp cargo test)
#   bash scripts/check-temp-dir-census.sh verify   --state ~/.cache/census.txt
#
# BAR ENFORCED IN CI: `bash -n` on this file plus `check-temp-dir-census.test.sh`
# and `--self-test`, all in the `scripts` job. There is no shellcheck step here
# and none should be added — nothing in this repo runs shellcheck (the only
# traces are `# shellcheck source=` directives in two other scripts), so write for
# it anyway: everything quoted, no word-splitting of names.

set -euo pipefail

usage() {
  {
    echo "usage: $(basename "$0") snapshot --state FILE [--base DIR]"
    echo "       $(basename "$0") verify   --state FILE [--base DIR]"
    echo "       $(basename "$0") base [--base DIR]"
    echo "       $(basename "$0") --self-test"
  } >&2
}

# ---------------------------------------------------------------------------
# ATTRIBUTION TABLE — prefix -> the file that mints it. NOT A FILTER: nothing
# here decides what gets counted, only who a reported name blames. Matched
# LONGEST-PREFIX-FIRST, which dissolves the superset traps that a glob-based
# census has to work around: `harness-loop-*` is a superset of task 03's
# `harness-loop-test-*` family (1931 vs 1711 dirs on disk here) and `mcp-*` is a
# superset of `mcp-loop-*` (1174 vs 20), and longest-wins attributes each to its
# own file with NO `! -name` exclusion — so do not add one.
#
# Derived by grepping the CALL FORM `in_env_temp("`, never the bare helper name
# (which counts its own definition — the trap that bit this issue twice).
#
# Traps recorded here because each one is a wrong-file bug:
#   * NEVER ADD AN `archimedes-` CATCH-ALL. `archimedes-*` is a shared family
#     (agents.rs, skills.rs, commands/agents.rs, tests/storage.rs, sandbox.rs); a
#     guess would send a reader to a file that never minted the name. An
#     unattributed name prints the UNATTRIBUTED line instead.
#   * `skill-esc-*` must stay strict-as-attributed: `find /tmp -maxdepth 1 -type d
#     -name '*skill-esc*'` returns 82 hits and ALL of them are
#     `exec-skill-esc-root-*`, minted in exec/tests/skills.rs through `temp_cwd`
#     (prefix `exec-`). A `skill-esc-*` row would blame the wrong file.
#   * `db-` is the SHORT form on purpose: `db-*-test-*` misses
#     `db-todos-backfill-*`; the short row covers all 31 `db-*` prefixes.
#   * `mcp-loop-` must outrank `mcp-` (longest-wins does this automatically; a
#     hand-edited table that matched first-typed would blame mcp/config.rs for a
#     turn_lifecycle.rs leak). The 567+567 `mcp-home-*`/`mcp-project-*` dirs on
#     disk are HISTORICAL — task 08 consolidated them into `mcp-`, and grepping
#     the tree for those two strings now returns nothing.
#   * `files-cmd-test-` only lands in the census base when `ScratchDir::in_tmpfs`
#     falls through `/dev/shm` to `temp_dir()`. `archimedes-sandbox-*` lands in
#     `/dev/shm` (`sandbox.rs::test_base()`), i.e. OUTSIDE the census base by
#     design (D9) — those fixtures must stay out of the sandbox write allow-list
#     or ~13 confinement tests pass vacuously. That is correct, not a hole.
#   * `harness-subagent-` is the ONE tolerated prefix; see the tolerance table.
attribution_table() {
  # prefix <TAB> owner
  cat <<'TABLE'
exec-skill-esc-	src-tauri/src/agent/tools/exec/tests/skills.rs
exec-	src-tauri/src/agent/tools/exec/tests/support.rs
harness-subagent-	src-tauri/tests/harness_subagent_dispatch.rs
harness-loop-test-	src-tauri/src/agent/harness/loop/tests/support.rs
harness-loop-	src-tauri/tests/harness_loop.rs
harness-store-test-	src-tauri/src/agent/harness/store.rs
harness-store-	src-tauri/tests/harness_store.rs
harness-compact-test-	src-tauri/src/agent/harness/compact.rs
harness-trust-test-	src-tauri/src/agent/harness/trust.rs
harness-agent-def-e2e-cfg-	src-tauri/src/agent/harness/loop/tests/subagents.rs
harness-list-agents-home-	src-tauri/src/agent/harness/loop/tests/tools_enabled.rs
harness-resolve-launch-home-	src-tauri/src/agent/harness/launch.rs
archimedes-prompt-	src-tauri/src/agent/harness/prompt.rs
mcp-loop-	src-tauri/src/agent/harness/loop/tests/turn_lifecycle.rs
mcp-	src-tauri/src/agent/mcp/config.rs
db-	src-tauri/src/storage/db.rs
archimedes-cmd-agents-	src-tauri/src/commands/agents.rs
archimedes-agents-	src-tauri/src/agents.rs
archimedes-skills-	src-tauri/src/skills.rs
archimedes-sudo-	src-tauri/src/agent/interactive/sudo_exec.rs
archimedes-canonical-	src-tauri/tests/storage.rs
archimedes-native-mig-	src-tauri/tests/storage.rs
archimedes-spaces-	src-tauri/tests/storage.rs
archimedes-storage-test-	src-tauri/tests/storage.rs
archimedes-trusted-	src-tauri/tests/storage.rs
archimedes-sandbox-	src-tauri/src/agent/tools/sandbox.rs
sessions-log-test-	src-tauri/src/commands/sessions.rs
history-	src-tauri/src/commands/history.rs
files-cmd-test-	src-tauri/src/commands/files/tests/support.rs
test-support-guard-	src-tauri/src/test_support.rs
session-cfg-	src-tauri/src/agent/session/mod.rs
refresh-	src-tauri/src/agent/session/mod.rs
router-todos-	src-tauri/src/agent/session/router.rs
crashsel-	src-tauri/src/agent/session/router.rs
crashlog-test-	src-tauri/src/agent/crashlog.rs
debuglog-test-	src-tauri/src/agent/debuglog.rs
perm-gate-	src-tauri/src/agent/permission.rs
persist-test-	src-tauri/src/agent/persist.rs
fsb-	src-tauri/src/agent/fs_backend.rs
fs-backend-	src-tauri/tests/fs_backend.rs
boundary-	src-tauri/src/agent/boundary.rs
session-native-	src-tauri/tests/session_native.rs
worker-e2e-	src-tauri/tests/worker_e2e.rs
worker-stdin-	src-tauri/tests/worker_stdin.rs
ipc-test-	src-tauri/tests/ipc.rs
TABLE
}

# ---------------------------------------------------------------------------
# TOLERANCE TABLE — prefix <TAB> budget. One entry, MEASURED. There is
# deliberately NO `--tolerate` FLAG: the table lives in the file, so widening it
# is always a diff a reviewer sees. A flag would let a CI edit silently delete
# this guard's teeth.
#
#   harness-subagent-  1
#
# It leaks ~1 dir per 4 runs (0.125/run, measured over 8 scoped runs) because
# `src-tauri/tests/harness_subagent_dispatch.rs`'s `build_harness` does
# `drop(task)`, which DETACHES a loop task holding an `Arc<Db>` pointing into the
# guarded dir; the task re-creates the SQLite file after the guard unlinks it, the
# `rmdir` fails, and an EMPTY dir remains (#96 D19b). A strict-zero guard therefore
# flakes ~1 run in 4. The mechanism cannot be fixed here: aborting or awaiting the
# loop task changes what those tests pin, which D19b recorded and this task must
# not undo.
#
# `sessions-log-test-` has the SAME mechanism (a lock-free `debuglog::log` racing
# `append_to`'s `create_dir_all`) and is deliberately NOT tolerated: it measured 0
# in 16 sibling-inclusive runs plus both whole-suite brackets. A tolerance is
# EARNED BY MEASUREMENT, NOT GRANTED BY MECHANISM, and a tolerance granted on a
# mechanism would silently absorb a REAL future leak of the same prefix. If it
# ever fires twice, add the row then — the failure message already names
# `src-tauri/src/commands/sessions.rs` and this mechanism, so that response costs
# one read. Do not add it "to be safe".
#
# TRIAGE — WHAT A RED MEANS, AND THE ONLY SANCTIONED WAY TO WIDEN A TOLERANCE.
# (A guard dies by whoever hits the flake quietly raising a threshold at 2am, so
# this lives next to the table, not in a doc nobody opens. The `verify` CI step's
# own comment repeats the last two bullets, because the person staring at a red is
# reading CI output, not a plan.)
#   * A red naming ANY prefix not in this table is the leak this guard exists
#     for. Fix the test: give its fixture a `ScratchDir` (any of the eight commits
#     on this branch shows the pattern). NEVER add a tolerance to make a red go
#     away.
#   * A `harness-subagent-*` red at OVER BUDGET: raise the budget only with a
#     re-measured rate recorded in the commit message (the current 1 comes from
#     0.125/run measured over 8 scoped runs). There is no flag for this on
#     purpose — widening is always a diff a reviewer sees.
#   * A `sessions-log-test-*` red: decide WHICH of two things you are looking at
#     before touching anything. 1 dir and EMPTY -> the known degenerate case; add
#     the row with the measurement (count, runs, command) in the commit message.
#     Contains a file (`.db`, `supervisor.log`, anything) -> that is NOT the race,
#     it is a real leak; keep it red and fix the test. The two are indistinguishable
#     by name, which is exactly why the tolerance was not pre-granted.
tolerance_table() {
  # prefix <TAB> budget
  cat <<'TABLE'
harness-subagent-	1
TABLE
}

# The UNATTRIBUTED line. A name that matches no row is not a gap to guess at — it
# is NEW, and NEW is precisely what this guard is for.
unattributed_note() {
  printf '%s\n' '<UNATTRIBUTED: no known minter matches this prefix — it is NEW, which is exactly what this guard is for>'
}

# ---------------------------------------------------------------------------
# THE SHAPE EXCLUSION — DARWIN ONLY, TWO SHAPES, AND NEVER SILENT.
#
# WHY IT EXISTS. macOS gives every user a private temp dir
# (`confstr(_CS_DARWIN_USER_TEMP_DIR)` → `/var/folders/nn/…/T`) that is NOT
# quiescent: while a ~90s suite runs, system daemons create directories in it. CI
# run 40347693926's `macos-latest` leg reddened on 19 of them —
# `com.apple.Maps.mapssyncd`, `com.apple.AuthenticationServices.*`,
# `com.apple.RemoteManagementAgent`, `com.apple.SafariShared.*` — and NOT ONE of
# them was ours. The premise test
# (`the_census_base_is_the_temp_dir_the_suite_actually_uses`) passed on macOS and
# the snapshot resolved `/private/var/folders/…/T`, so the guard was counting the
# RIGHT directory and the suite leaked ZERO dirs there. That is the whole-temp-dir
# delta behaving exactly as the header predicts: a VISIBLE FALSE POSITIVE from a
# foreign process, with the offending names printed for attribution.
#
# WHY THIS IS NOT THE ALLOW-LIST THE HEADER REJECTS. The header rejects a PREFIX
# ALLOW-LIST because "a new leaky test mints a new prefix the list does not
# contain, so the guard passes forever". That argument is about NAMES. What lives
# here is a SHAPE: *do not count a candidate whose name contains a dot*. It needs
# no widening as daemons arrive and go (they all reverse-DNS-name, so they all
# have dots), and it cannot hide a new Archimedes prefix, because — verified
# against this tree — **no Archimedes minter prefix contains a dot**: every
# `in_env_temp`/`in_tmpfs`/`in_dir` prefix, every prefix in the attribution table,
# and every historical prefix on disk is dot-free. A dotted name therefore cannot
# be one of ours, and the guard stays blind to nothing it could ever own. `check-temp-dir-census.test.sh`
# case 18c asserts that invariant in the tree, so a minter that broke it reddens a
# test rather than quietly becoming invisible.
#
# THE SECOND SHAPE, ADDED FOR ISSUE #139. The dotted shape is narrower than
# "excludes macOS noise": a system daemon that happens to be DOT-FREE
# (`betaenrollmentagent`) slips through it and hard-fails the macOS leg. The
# second shape is its mirror — *do not count a candidate whose name contains no
# dash* — and the same argument covers it: it needs no name list, and it cannot
# hide one of ours, because every real `ScratchDir` name is `{prefix}{tag}-{uuid}`
# with a non-empty uuid, so a dash terminates every name we can ever mint BY
# CONSTRUCTION, and every minter prefix in this tree ends in a dash. Case 18c(2)
# pins that corpus invariant, case 19 proves the pin has teeth, and case 18d
# proves the shape fires. The two shapes are OR'd and each rests on its own
# pinned invariant — neither is a wildcard, and neither is the rejected `*`.
#
# DO NOT MATCH `com.apple.*`. That is a NAME LIST — the exact rejected shape,
# needing a diff every time Apple ships a new daemon, and silently blind to any
# non-Apple dot-named neighbour.
#
# DARWIN ONLY, AND THAT IS WHY THE COVERAGE COST IS SMALL. Linux (and every future
# platform) keeps the FULLY STRICT whole-temp-dir delta: Ubuntu's `/tmp` on a fresh
# runner is quiescent — that leg snapshotted 13 dirs and verified clean — so it
# loses nothing by staying strict, and it is the leg that carries the real
# coverage. The relaxation is confined to the one platform where the temp dir is
# demonstrably shared with processes we cannot own. `check-temp-dir-census.test.sh`
# case 17 plants a DOTTED dir on the LINUX platform and requires exit 1: the
# scoping is PROVEN, not assumed, so a future edit that drops the platform gate
# reddens Linux instead of quietly disarming it.
#
# NEVER SILENT. `verify` prints the count and the reason whenever it excludes
# anything, on the clean path AND the failing path. A silent exclusion is the
# vacuous-green failure mode this entire task exists to prevent: it would turn
# "nothing leaked" into "nothing I chose to look at leaked" with no artifact to
# argue with.
exclusion_applies_here() {
  case "$(host_uname_s)" in
    Darwin) return 0 ;;
    *) return 1 ;;
  esac
}

# The shape: a name containing a dot. Not `com.apple.*` (see above).
dotted_name() {
  case "$1" in
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}

# The SECOND shape: a name that contains NO dash anywhere. Why a shape and
# not a name list is the header's argument — this needs no widening as daemons
# arrive and go because it cannot match an Archimedes minter: every real
# ScratchDir name is `{prefix}{tag}-{uuid}` (the naming contract on
# `ScratchDir::in_dir`, re-pinned by the test
# `the_guard_names_the_dir_after_the_prefix_and_tag_it_is_given`) with a
# NON-EMPTY uuid, so a dash terminates every real name BY CONSTRUCTION — a
# dash-free name is structurally impossible for us to own. The corpus pin
# (`.test.sh` 18c(2)) asserts the same in the tree, so a minter that broke it
# reddens a test instead of quietly becoming invisible. (This shape is
# Darwin-only, exactly like the dotted shape: see `exclusion_applies_here`.)
dash_free_name() {
  # The negated-glob test, NOT a character class. `*[!-]*` matches any name
  # with at least one non-dash character (i.e. everything — a tautology), and
  # `*[!-]` still matches any name ENDING in a non-dash, which would swallow
  # the planted `planted-darwin-leak-1a2b3c4d` (it ends in `d`) and break
  # `.test.sh` case 18b. The property we need is "the name contains NO dash
  # anywhere", which is exactly `[[ "$1" != *-* ]]`. Every Archimedes minter
  # prefix ends in a dash, so a dash-free name cannot be one of ours (case
  # 18c(2) pins that in the tree).
  [[ "$1" != *-* ]]
}

# ---------------------------------------------------------------------------
# `uname -s`, injectable. NOT a convenience for the tests alone: the platform
# refusal below is a path that must be TESTABLE, because a refusal nobody can
# exercise is a refusal nobody has seen fire. Overridable by
# ARCHIMEDES_CENSUS_UNAME_S; in production nothing sets it.
host_uname_s() {
  printf '%s\n' "${ARCHIMEDES_CENSUS_UNAME_S:-$(uname -s)}"
}

# Resolve the census base THE WAY RUST'S `temp_dir()` DOES — `$TMPDIR` if set,
# else the platform default (`confstr(_CS_DARWIN_USER_TEMP_DIR)` on Apple, `/tmp`
# elsewhere; `library/std/src/sys/paths/unix.rs`). This is the single most likely
# way this guard could be silently useless: a guard reading a hardcoded `/tmp`
# while the suite writes into `$TMPDIR` counts an empty directory and passes
# forever. Anything unrecognised REFUSES rather than falling through to `/tmp` —
# a base we guessed is a census that passes having looked at nothing.
resolve_base() {
  if [[ -n "${TMPDIR:-}" ]]; then
    printf '%s\n' "$TMPDIR"
    return 0
  fi
  case "$(host_uname_s)" in
    Linux) printf '%s\n' /tmp ;;
    Darwin) getconf DARWIN_USER_TEMP_DIR ;;
    *) return 1 ;;
  esac
}

refuse_platform() {
  {
    echo "error: this platform is not supported by the temp-dir census: uname -s is '$(host_uname_s)' and \$TMPDIR is unset, so there is no census base this script can resolve"
    echo "  refusing rather than guessing /tmp: a guard that scans a directory the suite does not write to reads as coverage while checking nothing (#96 task 09)"
    echo "  on Windows specifically: Rust resolves the temp dir with GetTempPath2W over TMP/TEMP (library/std/src/sys/paths/windows.rs), NOT TMPDIR, and the MSYS<->Win32 path translation is unverified here — the follow-up that closes this gap is a Windows resolve_base arm (\`cygpath -u \"\$TMP\"\`) plus running \`--self-test\` on a Windows runner"
  } >&2
}

# Canonicalise with `cd … && pwd -P`. Load-bearing (trap T2): GNU `find` does NOT
# follow a symlinked START POINT under the default `-P`, so `find symdir -mindepth
# 1 -maxdepth 1 -type d` prints NOTHING and exits 0 for a symlink to a directory
# that has subdirectories. A symlinked `TMPDIR` (macOS `/tmp -> /private/tmp` is
# the canonical case) would therefore produce an empty census that exits 0 — the
# vacuous green this whole task exists to avoid, arriving through a mechanism
# nobody would think to look for. A failed `cd` is a hard error, never a fallback.
canonicalise_dir() {
  local dir="$1"
  local resolved
  if ! resolved="$(cd "$dir" 2>/dev/null && pwd -P)"; then
    return 1
  fi
  printf '%s\n' "$resolved"
}

# The census: NAMES at depth 1 of the base, not paths, so the delta is
# spelling-independent (`/private/var` vs `/var` on macOS cannot break it).
#
# `-type d` IS LOAD-BEARING, and it is not a rounding decision. Two `tmp.*`
# REGULAR FILES per run are minted by `TMPDIR=/tmp mktemp` inside `sandbox.rs`'s
# confined-shell Landlock positive control
# (`a_confined_command_works_normally_inside_the_boundary`,
# `a_confined_shell_can_still_do_ordinary_things` — the only two such sites in
# `src-tauri/`). No guard can own a CONFINED child's file, and `mktemp -p` or
# redirecting `TMPDIR` there would change what that positive control pins. A
# guard that counted *entries* would therefore fail forever on two files nobody
# can fix — and a permanently red guard is a guard nobody reads, which is
# `check-test-data-dir.sh`'s own stated reason for matching only `crash-*.log`.
# Re-confirmed on disk: 14 `tmp.*` files newer than the task-08 commit, ZERO
# directories. DO NOT "SIMPLIFY" `-type d` AWAY.
#
# Known limit, stated: `-type d` under the default `-P` does not see a SYMLINK to
# a directory at depth 1. No suite minter creates one at that depth (`fsb-`'s and
# `exec-`'s symlinks live INSIDE guarded dirs).
census() {
  local base="$1"
  local listing status=0
  listing="$( cd "$base" && find . -mindepth 1 -maxdepth 1 -type d )" || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "error: could not census $base (find exited $status) — a failed census is not an empty one" >&2
    return 2
  fi
  [[ -z "$listing" ]] && return 0
  printf '%s\n' "$listing" | sed 's|^\./||' | LC_ALL=C sort
}

# The delta. NOT `comm`: `comm` needs both inputs sorted in the SAME order and its
# "input is not in sorted order" complaint is a warning, not an exit — measured
# during planning, `LC_ALL=C sort` and `LC_ALL=en_US.UTF-8 sort` disagree on
# `B`/`a`/`b`, and a mixed-order input still reported the planted dir while other
# content silently mis-diffed at exit 0. `grep -Fxv -f` is order-insensitive.
#
# **THE VERDICT IS THE OUTPUT, NEVER grep's EXIT CODE.** `grep -Fxv -f` exits 1
# when there is NO difference (the CLEAN case) and 0 when there IS one (the LEAK
# case) — the exact inverse of the convention `set -e` assumes. So the status is
# captured and discarded (`|| true`) and the branch tests the STRING. A bare
# `grep` whose status becomes the step's status reddens a clean run and greens a
# leak; do not "simplify" the `|| true` away and do not branch on `$?`.
new_names() {
  local before="$1" after="$2"
  if [[ -z "$before" ]]; then
    # Empty before-list: everything in `after` is new (the fresh-runner CI shape,
    # where the base starts empty).
    [[ -n "$after" ]] && printf '%s\n' "$after"
    return 0
  fi
  if [[ -z "$after" ]]; then
    return 0
  fi
  local out
  out="$(grep -Fxv -f <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true)"
  [[ -n "$out" ]] && printf '%s\n' "$out"
  return 0
}

# Longest-prefix attribution. Deliberately a max-length scan rather than a
# first-match-over-a-sorted-table: it cannot be broken by a hand-edited table that
# is not sorted, which is the shape a future "quick fix" arrives in.
attribute() {
  local name="$1"
  local prefix owner _rest best_len=0 best=""
  while IFS=$'\t' read -r prefix owner _rest; do
    [[ -z "$prefix" ]] && continue
    case "$prefix" in '#'*) continue ;; esac
    if [[ "$name" == "$prefix"* ]] && (( ${#prefix} > best_len )); then
      best_len=${#prefix}
      best="$owner"
    fi
  done < <(attribution_table)
  printf '%s\n' "$best"
}

# The budget for a name, or empty if no tolerance row matches it.
tolerance_budget() {
  local name="$1"
  local prefix budget _rest best_len=0 best=""
  while IFS=$'\t' read -r prefix budget _rest; do
    [[ -z "$prefix" ]] && continue
    case "$prefix" in '#'*) continue ;; esac
    if [[ "$name" == "$prefix"* ]] && (( ${#prefix} > best_len )); then
      best_len=${#prefix}
      best="$budget"
    fi
  done < <(tolerance_table)
  printf '%s\n' "$best"
}

# --- flag parsing (the check-versions.sh contract: `--flag value` AND
# `--flag=value`, `-h|--help`, every error to stderr as `error: …` + usage) ------
command_name=""
state_file=""
base_override=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --self-test | snapshot | verify | base)
      # `--self-test` is accepted in the command slot: the interface is exactly
      # one command, and this one happens to be spelled as a flag.
      if [[ -n "$command_name" ]]; then
        echo "error: unexpected argument: $1 (exactly one command is allowed)" >&2
        usage
        exit 2
      fi
      command_name="$1"
      shift
      ;;
    --state)
      # A `--state` whose value got lost must NOT degrade into "no state was
      # asked for" — that is how the CI step would check nothing and pass.
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --state requires a value (a path OUTSIDE the census base — see T1)" >&2
        usage
        exit 2
      fi
      state_file="$2"
      shift 2
      ;;
    --state=*)
      state_file="${1#--state=}"
      if [[ -z "$state_file" ]]; then
        echo "error: --state requires a value (a path OUTSIDE the census base — see T1)" >&2
        usage
        exit 2
      fi
      shift
      ;;
    --base)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --base requires a value (fixture bases only — CI must never pass it)" >&2
        usage
        exit 2
      fi
      base_override="$2"
      shift 2
      ;;
    --base=*)
      base_override="${1#--base=}"
      if [[ -z "$base_override" ]]; then
        echo "error: --base requires a value (fixture bases only — CI must never pass it)" >&2
        usage
        exit 2
      fi
      shift
      ;;
    -*)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
    *)
      echo "error: unknown command: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$command_name" ]]; then
  echo "error: a command is required (snapshot | verify | base | --self-test)" >&2
  usage
  exit 2
fi

# Resolve the census base, refuse if we cannot, then canonicalise (T2).
#
# `snapshot` and `verify` each call this INDEPENDENTLY and never read the base
# back from the state file as their own answer: a `verify` that trusted the state
# file's copy could not detect the one mistake this box is built to make — the
# suite run with `TMPDIR=/tmp` and the `verify` called with this shell's ambient
# `TMPDIR=/home/daniel/.cache/tmp` (#96 D13's hostile environment). The state file
# records what the snapshot resolved, and `verify` compares against it (exit 2).
resolve_base_or_die() {
  local raw
  if [[ -n "$base_override" ]]; then
    raw="$base_override"
  elif ! raw="$(resolve_base)"; then
    refuse_platform
    exit 2
  fi
  if [[ ! -d "$raw" ]]; then
    echo "error: the census base is not a directory: $raw" >&2
    echo "  reporting 'clean' for a base that cannot be walked is the vacuous green this guard exists to avoid" >&2
    exit 2
  fi
  local canonical
  if ! canonical="$(canonicalise_dir "$raw")"; then
    echo "error: could not canonicalise the census base: $raw (cd failed) — refusing to census a path we cannot resolve" >&2
    exit 2
  fi
  printf '%s\n' "$canonical"
}

# T1: the state file must NEVER live inside the census base. `mktemp`/`mktemp -d`
# with no `-p` writes into `$TMPDIR`, which IS the base — measured during
# planning: snapshot -> `mktemp -d` -> the after-census reports `tmp.E0VhjLtyyh` as
# a LEAK. The guard's own bookkeeping would be its own false positive, on every
# run, on every machine whose TMPDIR is writable (always). Hence `--state` is
# required with no default, and a state path under the base is refused.
#
# The CANDIDATE is canonicalised before the comparison, not matched literally: a
# candidate like `$base/../state` — or a symlinked spelling of the base — slips
# past a prefix match on the raw string, and the guard would then report its own
# state file as the suite's leak.
refuse_state_inside_base() {
  local state="$1" base="$2"
  local state_dir
  state_dir="$(dirname "$state")"
  local state_dir_canonical
  if ! state_dir_canonical="$(canonicalise_dir "$state_dir")"; then
    echo "error: the --state directory does not exist or is not walkable: $state_dir" >&2
    echo "  put it somewhere outside the census base, e.g. \$HOME/.cache/ (CI uses \$RUNNER_TEMP)" >&2
    exit 2
  fi
  case "$state_dir_canonical" in
    "$base" | "$base"/*)
      {
        echo "error: the --state path is inside the census base: $state (base $base)"
        echo "  that is T1: the state file would be counted as a new directory and reported as the suite's own leak, on every run" >&2
        echo "  put it outside the base — \$HOME/.cache/ locally, \$RUNNER_TEMP in CI (never a bare \`mktemp\`, which writes into \$TMPDIR)" >&2
      } >&2
      exit 2
      ;;
  esac
}

require_state() {
  if [[ -z "$state_file" ]]; then
    echo "error: --state FILE is required for $command_name (there is no default: a default lands in \$TMPDIR, which is the census base — T1)" >&2
    usage
    exit 2
  fi
}

# --- the modes ----------------------------------------------------------------

run_base() {
  if [[ -n "$state_file" ]]; then
    echo "error: base takes no --state (it writes nothing)" >&2
    usage
    exit 2
  fi
  # Resolved BEFORE the printf, and its status checked: `printf '%s\n' "$(…)"`
  # would run the resolver in a subshell whose `exit 2` the printf happily
  # swallows, so a base that cannot be resolved would print its own error message
  # and exit 0.
  local resolved
  resolved="$(resolve_base_or_die)"
  printf '%s\n' "$resolved"
}

run_snapshot() {
  require_state
  local base
  base="$(resolve_base_or_die)"
  refuse_state_inside_base "$state_file" "$base"
  local names
  names="$(census "$base")"
  # Line 1 is the resolved base, so `verify` can prove the two calls agreed
  # WITHOUT either of them trusting the other's resolution.
  {
    printf '%s\n' "$base"
    [[ -n "$names" ]] && printf '%s\n' "$names"
  } >"$state_file"
  local count=0
  [[ -n "$names" ]] && count="$(printf '%s\n' "$names" | wc -l | tr -d ' ')"
  printf 'census snapshot: %s directories in %s\n' "$count" "$base"
}

run_verify() {
  require_state
  local base
  base="$(resolve_base_or_die)"

  # "A FAILED SEARCH IS NOT AN EMPTY ONE" (lifted from check-test-data-dir.sh):
  # a missing state file means the bracket never happened, which needs a different
  # fix from a leak — so exit 2, never the clean message, never 0.
  if [[ ! -r "$state_file" ]]; then
    echo "error: the census state file is missing or unreadable: $state_file" >&2
    echo "  the snapshot step never wrote it (or the two steps disagree about where it lives) — this run is UNCHECKED, not clean" >&2
    exit 2
  fi

  local snapshot_base
  snapshot_base="$(sed -n '1p' "$state_file")"
  if [[ -z "$snapshot_base" ]]; then
    echo "error: the census state file has no base line: $state_file" >&2
    exit 2
  fi

  # Constraint 3, executable: BOTH sides resolve, and a mismatch is a red — not a
  # papered-over difference. This is the mistake this box is configured to make
  # (ambient TMPDIR=/home/daniel/.cache/tmp), and forgetting `TMPDIR=/tmp` on the
  # `verify` call would otherwise census an unrelated directory and pass.
  if [[ "$snapshot_base" != "$base" ]]; then
    {
      echo "error: the census base changed between snapshot and verify — refusing to answer"
      printf '  snapshot base: %s\n' "$snapshot_base"
      printf '  verify base:   %s\n' "$base"
      echo "  the two calls resolved DIFFERENT directories (a \$TMPDIR that differs between them), so a delta here would compare one directory against another and pass having checked nothing (#96 task 09, constraint 3)"
      echo "  fix: pin TMPDIR identically on the snapshot, the test run, and the verify — in CI the bracket relies on the runner's own TMPDIR on both sides"
    } >&2
    exit 2
  fi

  local after
  after="$(census "$base")"
  local before
  before="$(tail -n +2 "$state_file")"

  local new
  new="$(new_names "$before" "$after")"

  # THE SHAPE EXCLUSION (Darwin only — see the block above `exclusion_applies_here`
  # for why this is a SHAPE and not the rejected allow-list, and why Linux stays
  # strict). TWO shapes, OR'd: a name that contains a dot (`dotted_name`, the
  # reverse-DNS daemons), or a name that contains NO dash (`dash_free_name`, the
  # dot-free daemon of issue #139 — `betaenrollmentagent`). Applied to the DELTA,
  # BEFORE classification, so an excluded name can reach neither the strict list
  # nor a tolerance count, and can never mask a name shaped like ours — every
  # Archimedes name carries a dash (`{prefix}{tag}-{uuid}`), so neither shape can
  # swallow one.
  local -a excluded=()
  if exclusion_applies_here && [[ -n "$new" ]]; then
    local counted="" cand
    while IFS= read -r cand; do
      [[ -z "$cand" ]] && continue
      if dotted_name "$cand" || dash_free_name "$cand"; then
        excluded+=("$cand")
      else
        counted+="$cand"$'\n'
      fi
    done <<<"$new"
    new="$counted"
  fi

  # The exclusion is ANNOUNCED whenever it fires — on the clean path and the
  # failing path alike. Only the COUNT is printed, never the names: a name that
  # was excluded must not reappear where a reader could mistake it for a failure,
  # and the count is what tells them the guard looked and set something aside.
  local excluded_note=""
  if (( ${#excluded[@]} > 0 )); then
    excluded_note="$(printf 'excluded: %s shape-mismatched dir(s) in %s — macOS system daemons share the per-user TMPDIR; no Archimedes minter name contains a dot or a dash (#96)\n' "${#excluded[@]}" "$base")"
  fi

  # Classify: the STRICT count comes from names matching NO tolerance row,
  # computed INDEPENDENTLY of the tolerated count, so a tolerated leak can never
  # mask a strict one. Over budget, the tolerated names fold into the strict list.
  #
  # PARALLEL INDEXED ARRAYS, not `local -A`: macOS still ships bash 3.2 at
  # `/bin/bash` (Apple will not move past the GPLv2 shell) and that is what
  # Actions' `shell: bash` reaches for on the macOS leg, while associative arrays
  # are bash 4+. A `local -A` here would kill the very gate on that leg.
  local -a strict=()
  local -a tolerated=()
  local -a tol_prefix=()
  local -a tol_count=()
  local -a tol_budget=()
  local prefix name budget row_prefix row_budget _rest idx i cand

  # Pass 1: per tolerance row, how many new names it matched. Each name belongs to
  # exactly one row (longest-prefix-wins via `tolerance_prefix`), so the counts
  # cannot double-count a name that two rows both match.
  while IFS=$'\t' read -r row_prefix row_budget _rest; do
    [[ -z "$row_prefix" ]] && continue
    idx=0
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      [[ "$(tolerance_prefix "$name")" == "$row_prefix" ]] && idx=$((idx + 1))
    done <<<"$new"
    if (( idx > 0 )); then
      tol_prefix+=("$row_prefix")
      tol_count+=("$idx")
      tol_budget+=("$row_budget")
    fi
  done < <(tolerance_table)

  # Pass 2: strict vs tolerated, with an over-budget row folded into strict.
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    budget="$(tolerance_budget "$name")"
    if [[ -z "$budget" ]]; then
      strict+=("$name")
      continue
    fi
    prefix="$(tolerance_prefix "$name")"
    i="$(tol_index_of "$prefix")"
    if (( i >= 0 && tol_count[i] > tol_budget[i] )); then
      strict+=("$name")
    else
      tolerated+=("$name")
    fi
  done <<<"$new"

  local over_note=""
  if (( ${#tol_prefix[@]} > 0 )); then
    for i in "${!tol_prefix[@]}"; do
      if (( tol_count[i] > tol_budget[i] )); then
        over_note+="  OVER BUDGET (${tol_count[i]} > ${tol_budget[i]}) for prefix ${tol_prefix[i]}* — counted against this failure"$'\n'
      fi
    done
  fi

  # What the tolerated names were, spelled out from the TABLE rather than
  # hardcoded, so a second row added later cannot make this message lie.
  local tolerated_summary=""
  if (( ${#tol_prefix[@]} > 0 )); then
    for i in "${!tol_prefix[@]}"; do
      if (( tol_count[i] <= tol_budget[i] )); then
        [[ -n "$tolerated_summary" ]] && tolerated_summary+=", "
        tolerated_summary+="${tol_prefix[i]}* (budget ${tol_budget[i]}, #96 D19b)"
      fi
    done
  fi

  if (( ${#strict[@]} > 0 )); then
    {
      # The exclusion is printed FIRST, above the failure: a reader triaging a red
      # must be able to see what the guard set aside, or the count in the headline
      # is unauditable. It goes to stderr with the rest of the report so the two
      # cannot interleave into each other in a CI log.
      [[ -n "$excluded_note" ]] && printf '%s\n' "$excluded_note"
      printf 'error: the Rust test suite left %s new directories in %s — #96'"'"'s leak is back\n' "${#strict[@]}" "$base"
      local n owner
      for n in "${strict[@]}"; do
        owner="$(attribute "$n")"
        if [[ -n "$owner" ]]; then
          printf '  %s  ← %s\n' "$n" "$owner"
        else
          printf '  %s  ← %s\n' "$n" "$(unattributed_note)"
        fi
      done
      [[ -n "$over_note" ]] && printf '%s' "$over_note"
      echo "  fix: the test that mints it must hold a test_support::ScratchDir — guard FIRST in a body, LAST in a struct (D19's two opposite spellings). See #96 tasks 01-08."
      if (( ${#tolerated[@]} > 0 )); then
        printf '  note: %s tolerated dir(s) matching %s were not counted against this failure.\n' "${#tolerated[@]}" "$tolerated_summary"
      fi
      echo "  triage: a prefix NOT in the tolerance table is a real leak — fix the test, never widen the table. A harness-subagent-* OVER BUDGET may be raised only with a re-measured rate in the commit message. A sessions-log-test-* dir that CONTAINS A FILE is a real leak, not the D19b race; empty is the race."
    } >&2
    exit 1
  fi

  if (( ${#tolerated[@]} > 0 )); then
    printf 'tolerated: %s new dir(s) matching %s\n' "${#tolerated[@]}" "$tolerated_summary"
    local t
    for t in "${tolerated[@]}"; do
      printf '  %s  ← %s\n' "$t" "$(attribute "$t")"
    done
  fi

  # Clean verdict, but the exclusion is still announced — "clean" plus "and here
  # is what I declined to count" is an auditable statement; a bare "clean" after
  # silently dropping 19 candidates is the vacuous green this task exists to kill.
  [[ -n "$excluded_note" ]] && printf '%s\n' "$excluded_note"

  printf 'census clean: no new directories in %s\n' "$base"
}

# Index of a prefix in `run_verify`'s parallel `tol_*` arrays, or -1. A function
# (reading the CALLER's locals through bash's dynamic scope) rather than
# `${arr[$prefix]}`, for the same bash-3.2 reason as above.
tol_index_of() {
  local want="$1" i
  # Guarded for bash 3.2 + `set -u`: expanding `"${!arr[@]}"` on an EMPTY array is
  # an unbound-variable error there (bash 4.4+ made it legal).
  (( ${#tol_prefix[@]} == 0 )) && { printf '%s\n' "-1"; return 0; }
  for i in "${!tol_prefix[@]}"; do
    if [[ "${tol_prefix[i]}" == "$want" ]]; then
      printf '%s\n' "$i"
      return 0
    fi
  done
  printf '%s\n' "-1"
}

# The tolerance row's prefix for a name (longest match), so the report can name
# `harness-subagent-*` rather than only a count.
tolerance_prefix() {
  local name="$1"
  local prefix budget _rest best_len=0 best=""
  while IFS=$'\t' read -r prefix budget _rest; do
    [[ -z "$prefix" ]] && continue
    if [[ "$name" == "$prefix"* ]] && (( ${#prefix} > best_len )); then
      best_len=${#prefix}
      best="$prefix"
    fi
  done < <(tolerance_table)
  printf '%s\n' "$best"
}

# --- --self-test: the premise mode (the point of this task) --------------------
#
# A GREEN GUARD PROVES NOTHING, so this mode proves the guard can fail, cheaply,
# with no cargo and no suite, in the `scripts` job on every push. It drives the
# SAME snapshot/verify comparison path (by re-invoking this script with `--base`),
# NOT a hand-rolled second implementation — a self-test with its own copy of the
# delta logic tests the copy, not the guard.
#
# A self-test that cannot fail is the same decoration as the guard it tests, so
# every case below asserts the exit code it needs, including the case where the
# guard would report 0 for a planted leak — which is the regression this mode
# exists to catch.
self_test_failures=0
self_test_root=""
# Every path THIS `--self-test` invocation created, by exact name. The EXIT trap
# deletes these and nothing else — never a glob, never a pattern, never a `find`
# whose result it then unlinks. That distinction is the whole of how a script that
# is otherwise strictly read-only (D2) is allowed to delete anything at all: a
# directory you created microseconds ago, by the name you gave it, is not a sweep.
self_test_created=()

self_mk() {
  # `self_mk -p dir…` — create AND register. Every fixture goes through here so the
  # cleanup list cannot drift out of sync with what the cases plant.
  local args=()
  if [[ "${1:-}" == "-p" ]]; then
    args+=("-p")
    shift
  fi
  local p
  for p in "$@"; do
    mkdir "${args[@]+"${args[@]}"}" -- "$p"
    self_test_created+=("$p")
  done
}

self_mkfile() {
  local p="$1"
  : >"$p"
  self_test_created+=("$p")
}

# Removes a path THIS invocation created, by that exact name, because a case needs
# the census to see it gone (the "verdict does not latch" and "one tolerated, not
# two" cases). Registered paths only — the same rule the EXIT trap enforces.
self_rm() {
  local p
  for p in "$@"; do
    rm -rf -- "$p"
  done
}

self_test_cleanup() {
  local p
  for p in "${self_test_created[@]+"${self_test_created[@]}"}"; do
    [[ -e "$p" ]] && rm -rf -- "$p"
  done
  if [[ -n "$self_test_root" ]]; then
    if rmdir -- "$self_test_root" 2>/dev/null; then
      return 0
    fi
    # NOT emptied: something exists in the root that this invocation did not
    # register, and deleting unregistered paths is precisely the pattern-sweep D2
    # forbids. Say so and leave it — a visible leftover is cheaper than a guard
    # that deletes what it did not make.
    printf 'warning: the self-test root is not empty, so it was left in place (nothing unregistered is ever deleted): %s\n' "$self_test_root" >&2
  fi
  return 0
}

self_ok() { printf 'ok   %s\n' "$1"; }
self_fail() {
  printf 'FAIL %s\n' "$1" >&2
  [[ $# -gt 1 ]] && printf '       %s\n' "$2" >&2
  self_test_failures=$((self_test_failures + 1))
}

# Runs the script under test (this file, re-invoked) and reports whether the exit
# code matched. `status` and `output` are set for the assertions.
self_run() {
  local script="$1"
  shift
  self_status=0
  self_output="$("$script" "$@" 2>&1)" || self_status=$?
}

run_self_test() {
  local script
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  # Step 0: the REAL base must resolve — both because the refusal path must not be
  # skipped here, and because the last case below asserts this machine's base is
  # walkable, proving the fixture logic is attached to a directory that exists.
  local real_base
  if ! real_base="$(resolve_base_or_die)"; then
    exit 2
  fi

  # A throwaway base OUTSIDE the census base. `mktemp -d` with NO `-p` writes into
  # `$TMPDIR` — i.e. into the census base — so the template is absolute (T1).
  local root_parent="${RUNNER_TEMP:-${XDG_CACHE_HOME:-$HOME/.cache}}"
  mkdir -p "$root_parent"
  self_test_root="$(mktemp -d "$root_parent/archimedes-census-self-test.XXXXXX")"
  trap 'self_test_cleanup' EXIT

  local root_canonical
  root_canonical="$(canonicalise_dir "$self_test_root")"
  case "$root_canonical" in
    "$real_base" | "$real_base"/*)
      {
        echo "error: the self-test root would live inside the census base: $root_canonical (base $real_base)" >&2
        echo "  a hostile TMPDIR (e.g. \$HOME/.cache) would put the self-test's own fixtures inside the thing it measures" >&2
      } >&2
      exit 2
      ;;
  esac

  local fixture_base="$root_canonical/base"
  local fixture_state="$root_canonical/state.txt"
  self_mk -p "$fixture_base"
  # The state file is written by the CHILD invocation, at a name this one chose,
  # inside this root — registered up front (the trap's `-e` test skips it if it was
  # never written) so the root is empty at cleanup and the "nothing unregistered is
  # ever deleted" rule below never has to fire.
  self_test_created+=("$fixture_state")

  # Case 1: the fresh-runner shape — empty base, empty state, nothing planted —
  # must exit 0. THIS is the case whose handling the previous revision of the plan
  # mis-stated: `grep -Fxv -f` exits 1 on identical (here, empty) inputs, so a
  # verdict taken from grep's status fails this clean run.
  self_run "$script" snapshot --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" ]]; then
    self_ok "snapshot of an empty base exits 0"
  else
    self_fail "snapshot of an empty base exits 0" "exit $self_status: $self_output"
  fi
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" && "$self_output" == *"census clean"* ]]; then
    self_ok "empty before + empty after exits 0 (the grep-status trap case)"
  else
    self_fail "empty before + empty after exits 0 (the grep-status trap case)" "exit $self_status: $self_output"
  fi

  # Case 2: TEETH. A planted directory must be reported, exit 1, by name. This is
  # the case that turns `--self-test` from a smoke test into the premise proof.
  self_mk -p "$fixture_base/planted-leak-1"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "1" && "$self_output" == *"planted-leak-1"* ]]; then
    self_ok "a planted directory is reported (exit 1, named)"
  else
    self_fail "a planted directory is reported (exit 1, named)" "exit $self_status: $self_output"
  fi

  # Case 3: an unknown prefix is UNATTRIBUTED, not blamed on a guessed file.
  if [[ "$self_output" == *"UNATTRIBUTED"* ]]; then
    self_ok "an unknown prefix is marked UNATTRIBUTED (an allow-list would be blind to it)"
  else
    self_fail "an unknown prefix is marked UNATTRIBUTED" "$self_output"
  fi

  # Case 3b: THE GREP PATH ITSELF, with a NON-EMPTY before-list. Cases 1-8 snapshot
  # an EMPTY base, which the empty-`before` shortcut answers directly — so a delta
  # made blind (a `grep -Fxv -f` that always answers "nothing is new") would pass
  # every one of them. On a fresh CI runner the base really is empty, so that
  # shortcut IS the CI path; on a developer's Linux box `/tmp` holds thousands of
  # entries and the grep is what runs. Both halves need a case, or a regression in
  # one half is invisible. A pre-existing dir plus a planted one must report ONLY
  # the planted one.
  self_mk -p "$fixture_base/pre-existing-dir"
  self_run "$script" snapshot --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" ]]; then
    self_ok "snapshot of a NON-EMPTY base exits 0"
  else
    self_fail "snapshot of a NON-EMPTY base exits 0" "exit $self_status: $self_output"
  fi
  self_mk -p "$fixture_base/planted-after-existing-1"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "1" && "$self_output" == *"planted-after-existing-1"* && "$self_output" != *"pre-existing-dir"* ]]; then
    self_ok "non-empty before + a new dir reports ONLY the new one (the grep delta has teeth)"
  else
    self_fail "non-empty before + a new dir reports only the new one" "exit $self_status: $self_output"
  fi
  # And the same pair again AFTER re-snapshotting: identical NON-EMPTY lists, where
  # `grep -Fxv -f` exits 1 (no difference) — the clean case, which a verdict taken
  # from grep's STATUS would call a failure. (Re-snapshotting is what makes the two
  # lists identical; without it the planted dir is still new and exit 1 is correct.)
  self_run "$script" snapshot --state "$fixture_state" --base "$fixture_base"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" && "$self_output" == *"census clean"* ]]; then
    self_ok "identical NON-EMPTY lists exit 0 (grep exits 1 here; the verdict is the output)"
  else
    self_fail "identical non-empty lists exit 0" "exit $self_status: $self_output"
  fi
  self_rm "$fixture_base/planted-after-existing-1"

  # Case 4: the verdict tracks reality and does not latch.
  self_rm "$fixture_base/planted-leak-1"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" ]]; then
    self_ok "removing the planted dir returns the verdict to 0 (no latching)"
  else
    self_fail "removing the planted dir returns the verdict to 0" "exit $self_status: $self_output"
  fi

  # Case 5: ONE tolerated dir within budget must NOT flip the verdict (a
  # strict-zero guard flakes ~1 run in 4 on D19b's detached-task race).
  self_mk -p "$fixture_base/harness-subagent-db-selftest-1"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" && "$self_output" == *"tolerated"* ]]; then
    self_ok "one tolerated dir within budget exits 0 and says so"
  else
    self_fail "one tolerated dir within budget exits 0" "exit $self_status: $self_output"
  fi

  # Case 6: a SECOND one is over budget and MUST fail — a tolerance that is not
  # counted is not a budget, it is an exemption.
  self_mk -p "$fixture_base/harness-subagent-db-selftest-2"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" != "0" && "$self_output" == *"OVER BUDGET"* ]]; then
    self_ok "two tolerated dirs are over budget and fail"
  else
    self_fail "two tolerated dirs are over budget and fail" "exit $self_status: $self_output"
  fi

  # Case 7: A TOLERATED LEAK CANNOT MASK A STRICT ONE. With both present the
  # verdict is 1 and only the strict name is listed as a failure. The tolerated
  # fixture is brought back WITHIN BUDGET first (case 6 left two, and over-budget
  # names legitimately fold into the failure list — a different assertion).
  self_rm "$fixture_base/harness-subagent-db-selftest-2"
  self_mk -p "$fixture_base/planted-leak-2"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "1" && "$self_output" == *"planted-leak-2"* && "$self_output" == *"were not counted"* ]]; then
    self_ok "a tolerated leak does not mask a strict one (only the strict name is a failure)"
  else
    self_fail "a tolerated leak does not mask a strict one" "exit $self_status: $self_output"
  fi
  if [[ "$self_output" == *"harness-subagent-db-selftest-1"* ]]; then
    self_fail "the tolerated name is not listed among the strict failures" "$self_output"
  else
    self_ok "the tolerated name is not listed among the strict failures"
  fi

  # Case 8: A PLANTED REGULAR FILE MUST NOT FAIL — the `-type d` rule. A
  # regression here means someone made the guard permanently red over
  # `sandbox.rs`'s two confined `TMPDIR=/tmp mktemp` files, which no guard can own.
  # The case-7 fixtures go first, by exact name, so the ONLY new entry is the file.
  self_rm "$fixture_base/harness-subagent-db-selftest-1" "$fixture_base/planted-leak-2"
  self_mkfile "$fixture_base/tmp.SELFTESTFILE"
  self_run "$script" verify --state "$fixture_state" --base "$fixture_base"
  if [[ "$self_status" == "0" ]]; then
    self_ok "a planted regular FILE is not a leak (-type d only, sandbox.rs's mktemp residue)"
  else
    self_fail "a planted regular FILE is not a leak (-type d only)" "exit $self_status: $self_output"
  fi

  # Case 9: the state file inside the fixture base is REFUSED (T1) — otherwise the
  # guard reports its own bookkeeping as the suite's leak, forever.
  self_run "$script" snapshot --state "$fixture_base/state-inside.txt" --base "$fixture_base"
  if [[ "$self_status" == "2" ]]; then
    self_ok "a state file inside the census base is refused (exit 2, T1)"
  else
    self_fail "a state file inside the census base is refused" "exit $self_status: $self_output"
  fi

  # Case 10: a missing state file is exit 2, never the clean message — "a failed
  # search is not an empty one".
  self_run "$script" verify --state "$root_canonical/no-such-state.txt" --base "$fixture_base"
  if [[ "$self_status" == "2" && "$self_output" != *"census clean"* ]]; then
    self_ok "a missing state file exits 2 and is not reported as clean"
  else
    self_fail "a missing state file exits 2" "exit $self_status: $self_output"
  fi

  # Case 11: base drift between the two calls is exit 2 naming both — the
  # mistake-detection that keeps `TMPDIR` drift from making the census vacuous.
  self_mk -p "$root_canonical/other-base"
  self_run "$script" verify --state "$fixture_state" --base "$root_canonical/other-base"
  if [[ "$self_status" == "2" && "$self_output" == *"other-base"* && "$self_output" == *"base"* ]]; then
    self_ok "a snapshot/verify base mismatch exits 2 and names both paths"
  else
    self_fail "a snapshot/verify base mismatch exits 2" "exit $self_status: $self_output"
  fi

  # Case 12: THE PLATFORM REFUSAL IS A TESTED PATH. The fixture cases all pass
  # `--base`, so they never exercise `resolve_base`'s refusal; without this case
  # the refusal is designed but unseen. Re-invoked with an injected `uname` and an
  # unset TMPDIR, the script must refuse with exit 2 AND name the reason, so a
  # user on an unsupported box reads "this platform is not supported because X"
  # rather than a mystery exit code.
  self_status=0
  self_output="$(env TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=MINGW64_NT-self-test "$script" snapshot --state "$root_canonical/refused.txt" 2>&1)" || self_status=$?
  if [[ "$self_status" == "2" && "$self_output" == *"not supported"* && "$self_output" == *"MINGW64_NT-self-test"* ]]; then
    self_ok "an unrecognised platform is refused (exit 2) and prints the reason"
  else
    self_fail "an unrecognised platform is refused and prints the reason" "exit $self_status: $self_output"
  fi

  # Case 13: THE DOTTED-NAME EXCLUSION IS DARWIN-ONLY — PROVEN FROM THE LINUX
  # SIDE. macOS's per-user TMPDIR is shared with system daemons that mint dotted
  # (`com.apple.*`) directories mid-suite; Linux's `/tmp` on a fresh runner is
  # quiescent, so Linux keeps the FULLY STRICT whole-temp-dir delta and a dotted
  # candidate there is still a leak. This case is what stops the exclusion from
  # ever being widened past Darwin unnoticed: drop the platform gate and THIS
  # goes red. (Re-invoked with an injected `uname` + `--base`, the same injection
  # case 12 uses for the refusal.)
  self_mk -p "$root_canonical/linux-strict-base"
  self_status=0
  self_output="$(env TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=Linux "$script" snapshot --state "$root_canonical/linux-strict.txt" --base "$root_canonical/linux-strict-base" 2>&1)" || self_status=$?
  self_test_created+=("$root_canonical/linux-strict.txt")
  if [[ "$self_status" == "0" ]]; then
    self_mk -p "$root_canonical/linux-strict-base/com.apple.Maps.mapssyncd"
    self_status=0
    self_output="$(env TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=Linux "$script" verify --state "$root_canonical/linux-strict.txt" --base "$root_canonical/linux-strict-base" 2>&1)" || self_status=$?
    if [[ "$self_status" == "1" && "$self_output" == *"com.apple.Maps.mapssyncd"* && "$self_output" != *"excluded:"* ]]; then
      self_ok "on LINUX a dotted directory is still reported (the exclusion is Darwin-only)"
    else
      self_fail "on LINUX a dotted directory is still reported" "exit $self_status: $self_output"
    fi
  else
    self_fail "on LINUX a dotted directory is still reported (snapshot step failed)" "exit $self_status: $self_output"
  fi

  # Case 14: THE DARWIN HALF, BOTH DIRECTIONS. A planted dotted dir is excluded
  # AND the exclusion is ANNOUNCED (a silent exclusion is the vacuous green this
  # whole task exists to prevent); a planted DOT-FREE dir is still reported. Both
  # halves are asserted against the SAME base, so a bug that excludes everything
  # — `*` where `*.*` belongs — fails the dot-free half, and a bug that excludes
  # nothing fails the dotted half.
  self_mk -p "$root_canonical/darwin-base"
  self_status=0
  self_output="$(env TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=Darwin "$script" snapshot --state "$root_canonical/darwin-state.txt" --base "$root_canonical/darwin-base" 2>&1)" || self_status=$?
  self_test_created+=("$root_canonical/darwin-state.txt")
  if [[ "$self_status" != "0" ]]; then
    self_fail "darwin fixture snapshot exits 0" "exit $self_status: $self_output"
  else
    self_mk -p "$root_canonical/darwin-base/com.apple.Maps.mapssyncd"
    self_status=0
    self_output="$(env TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=Darwin "$script" verify --state "$root_canonical/darwin-state.txt" --base "$root_canonical/darwin-base" 2>&1)" || self_status=$?
    if [[ "$self_status" == "0" && "$self_output" == *"census clean"* && "$self_output" == *"excluded: 1 shape-mismatched dir(s)"* ]]; then
      self_ok "on DARWIN a dotted daemon dir is excluded, and the exclusion is PRINTED"
    else
      self_fail "on DARWIN a dotted daemon dir is excluded and the exclusion is printed" "exit $self_status: $self_output"
    fi

    # The other half, same base: the dot-free leak survives the exclusion.
    self_mk -p "$root_canonical/darwin-base/planted-darwin-leak-1"
    self_status=0
    self_output="$(env TMPDIR= ARCHIMEDES_CENSUS_UNAME_S=Darwin "$script" verify --state "$root_canonical/darwin-state.txt" --base "$root_canonical/darwin-base" 2>&1)" || self_status=$?
    if [[ "$self_status" == "1" && "$self_output" == *"planted-darwin-leak-1"* && "$self_output" == *"excluded: 1 shape-mismatched dir(s)"* ]]; then
      self_ok "on DARWIN a dot-free directory is still reported (the exclusion is a shape, not a wildcard)"
    else
      self_fail "on DARWIN a dot-free directory is still reported" "exit $self_status: $self_output"
    fi
  fi

  # Case 15: the REAL base is resolvable and walkable — step 1's logic is attached
  # to a directory that exists on this machine/OS. Read-only: nothing is planted
  # here, and the entry count is asserted unchanged by the .test.sh harness.
  local real_count=0
  if real_listing="$(census "$real_base")"; then
    [[ -n "$real_listing" ]] && real_count="$(printf '%s\n' "$real_listing" | wc -l | tr -d ' ')"
    printf 'ok   the real census base is walkable: %s (%s directories at depth 1)\n' "$real_base" "$real_count"
  else
    self_fail "the real census base is walkable" "could not census $real_base"
  fi

  if (( self_test_failures > 0 )); then
    printf '\nself-test: %s case(s) FAILED — the census guard cannot be trusted to fail\n' "$self_test_failures" >&2
    exit 1
  fi
  printf '\nself-test: all cases behaved (the guard has teeth)\n'
}

case "$command_name" in
  snapshot) run_snapshot ;;
  verify) run_verify ;;
  base) run_base ;;
  --self-test)
    if [[ -n "$state_file" || -n "$base_override" ]]; then
      echo "error: --self-test takes no --state or --base (it builds its own fixture base outside the census base)" >&2
      usage
      exit 2
    fi
    run_self_test
    ;;
esac
