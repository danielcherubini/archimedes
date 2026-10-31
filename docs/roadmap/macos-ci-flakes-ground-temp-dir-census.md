---
status: grounding-report
area: temp-dir-census
issue: "#139"
branch: feature/macos-ci-flakes
grounded-at: 60470d23b4408ec124672afa5865e1195099052c
grounded-on: 2026-10-31
---

# Grounding report — temp-dir census area (issue #139)

Grounded read-only at `60470d2` (branch `feature/macos-ci-flakes`, clean tree; branch
base == `main` tip). All line numbers are as of that HEAD. Quotes are verbatim from the
tree. This report grounds the AREA; it does not propose a fix, rank options, or emit
tasks — the planner owns that.

Files examined (all paths repo-root-relative):

| File | Size / lines |
|---|---|
| `scripts/check-temp-dir-census.sh` | 58 471 bytes, 1230 lines |
| `scripts/check-temp-dir-census.test.sh` | 25 484 bytes, 486 lines |
| `docs/features/issue-96-temp-dir-known-gaps.md` | 281 lines |
| `.github/workflows/ci.yml` | 25 635 bytes, ~449 lines |
| `src-tauri/src/test_support.rs` (premise test, lines 385–480) | consulted |

---

## 1. The Darwin dotted-name exclusion, end to end

### 1a. The WHY block above the exclusion (lines 237–282)

Verbatim, lines 237–282 (`scripts/check-temp-dir-census.sh`):

```bash
# THE DOTTED-NAME EXCLUSION — DARWIN ONLY, A SHAPE, AND NEVER SILENT.
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
```

### 1b. The platform gate — `exclusion_applies_here` (lines 284–290)

```bash
exclusion_applies_here() {
  case "$(host_uname_s)" in
    Darwin) return 0 ;;
    *) return 1 ;;
  esac
}
```

### 1c. The exclusion shape — `dotted_name` (lines 292–297)

```bash
# The shape: a name containing a dot. Not `com.apple.*` (see above).
dotted_name() {
  case "$1" in
    *.*) return 0 ;;
    *) return 1 ;;
  esac
}
```

**This is the whole "is it a dotted name" decision.** `case "$1" in *.*)` is a
nomatch-of-the-Kleene-star test — `betaenrollmentagent` (no dot) hits the `*)` arm
→ `return 1` → NOT excluded. There is no mention of `betaenrollmentagent` or any
other literal name anywhere in the script.

### 1d. How `host_uname_s` decides (lines 300–314)

```bash
# `uname -s`, injectable. NOT a convenience for the tests alone: the platform
# refusal below is a path that must be TESTABLE, because a refusal nobody can
# exercise is a refusal nobody has seen fire. Overridable by
# ARCHIMEDES_CENSUS_UNAME_S; in production nothing sets it.
host_uname_s() {
  printf '%s\n' "${ARCHIMEDES_CENSUS_UNAME_S:-$(uname -s)}"
}
```

So on a real macOS runner, `exclusion_applies_here` returns 0 iff real `uname -s`
prints `Darwin`. On every CI run the Darwin half is exercised ONLY via the injected
variable (`.test.sh` cases 17/18/18b and the six `--self-test` cases), never by a
real Darwin `uname` on this machine (§8 below).

### 1e. Where the exclusion is applied and where the count message comes from (lines 672–698, inside `run_verify`)

```bash
  # THE DOTTED-NAME EXCLUSION (Darwin only — see the block above `exclusion_applies_here`
  # for why this is a SHAPE and not the rejected allow-list, and why Linux stays
  # strict). Applied to the DELTA, BEFORE classification, so an excluded name can
  # reach neither the strict list nor a tolerance count, and can never mask a
  # dot-free leak.
  local -a excluded=()
  if exclusion_applies_here && [[ -n "$new" ]]; then
    local counted="" cand
    while IFS= read -r cand; do
      [[ -z "$cand" ]] && continue
      if dotted_name "$cand"; then
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
    excluded_note="$(printf 'excluded: %s dotted-name dir(s) in %s — macOS system daemons share the per-user TMPDIR; no Archimedes minter name contains a dot (#96)\n' "${#excluded[@]}" "$base")"
  fi
```

Mechanics, in order:
1. `run_verify` computes the delta `new="$(new_names "$before" "$after")"` at line 670.
2. Lines 678–689 split the delta into `excluded` (dotted, Darwin only) vs `counted`;
   `new` is replaced by `counted`, so an excluded name reaches NEITHER the strict
   list NOR a tolerance count.
3. Lines 695–698 build the single `excluded_note` string; the count is printed from
   `${#excluded[@]}` and the base `${base}` (canonicalised base, since `base` came
   from `resolve_base_or_die`). This is the ONLY source of the `excluded: N
   dotted-name dir(s) in …` message.
4. The note is emitted at exactly two points in `run_verify`:
   - **Failing path**, line 783 — printed FIRST, before the headline:
     `[[ -n "$excluded_note" ]] && printf '%s\n' "$excluded_note"` then the
     `error: the Rust test suite left …` headline (1f), all to stderr, then `exit 1`
     at line 794.
   - **Clean path**, line 811: `[[ -n "$excluded_note" ]] && printf '%s\n' "$excluded_note"`
     just before `printf 'census clean: no new directories in %s\n' "$base"` (line 813).

### 1f. The failure headline (lines 776–794, inside `run_verify`)

```bash
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
```

---

## 2. The attribution path

### 2a. The minter-prefix table — `attribution_table()` (lines 113–176)

The trailing comment trap lines 108–125 say: `harness-subagent-` is "the ONE
tolerated prefix; see the tolerance table", and to NEVER add an `archimedes-`
catch-all (a "shared family"). Verbatim table (lines 127–176):

```bash
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
```

### 2b. `unattributed_note()` (lines 230–234)

```bash
# The UNATTRIBUTED line. A name that matches no row is not a gap to guess at — it
# is NEW, and NEW is precisely what this guard is for.
unattributed_note() {
  printf '%s\n' '<UNATTRIBUTED: no known minter matches this prefix — it is NEW, which is exactly what this guard is for>'
}
```

### 2c. The tolerance table (lines 213–228) — the single row

```bash
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
# ...TRIAGE bullets (see above, verbatim in the file at lines 239-275)...
tolerance_table() {
  # prefix <TAB> budget
  cat <<'TABLE'
harness-subagent-	1
TABLE
}
```

The TRIAGE comment (lines 239–275) contains: "NEVER add a tolerance to make a red
go away"; "A `harness-subagent-*` red at OVER BUDGET: raise the budget only with a
re-measured rate recorded in the commit message"; and the `sessions-log-test-*`
empty-vs-contains-a-file distinction (see §6b for how the planner's constraint is
restated in `docs/roadmap/macos-ci-flakes-status.md`).

### 2d. How prefix lookup works — longest-prefix-wins, not first-match

`attribute()` (lines 414–427):

```bash
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
```

`tolerance_budget()` (lines 429–446) is the same scan over `tolerance_table`
(widest matching row wins; returns empty when no row matches — `best=""` plus the
final `printf '%s\n' "$best"` … which, under `set -e` + command substitution,
returns exit 0 with an EMPTY string — that empty string is the "no row" signal).
`tolerance_prefix()` (lines 831–845) is the same scan returning the widest matching
**prefix**.

**How a name reaches UNATTRIBUTED vs tolerated — the exact gate** (`run_verify`,
lines 737–761):

```bash
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
```

The only way out of `strict` is a NON-EMPTY budget from `tolerance_budget` plus an
in-budget Pass-1 count. `betaenrollmentagent` matches no row → `budget=""` →
`strict+=("$name")` → hard-fail; then `attribute()` finds no prefix → the line ends
`← <UNATTRIBUTED: …>`. This is exactly the two-line §9a quote. Confirmed: **an
unattributed name hard-fails regardless of any budget** — tolerance is only ever
looked up by prefix row.

---

## 3. The self-test structure

### 3a. The harness shape (`.test.sh` lines 53–134)

```bash
run_check() {
  status=0
  output="$("$check_script" "$@" 2>&1)" || status=$?
}

# The same, with a controlled environment (the platform-refusal case needs an
# UNSET `TMPDIR` plus an injected `uname`, and nothing else about the call).
run_check_env() {
  local env_spec="$1"
  shift
  status=0
  # shellcheck disable=SC2086
  output="$(env $env_spec "$check_script" "$@" 2>&1)" || status=$?
}
```

Assertion helpers: `assert_eq` (68), `assert_nonzero` (81), `assert_contains` (94),
`assert_not_contains` (106), `fixture()` (121, creates `$base` + `$state` under one
throwaway `tmp_root`). Each case is: `fixture <name>`, `run_check snapshot
--state "$state" --base "$base"`, plant `mkdir -p "$base/…"`, `run_check verify
…`, then asserts. The fixture-bases are all OUTSIDE the real temp dir (T1) — only
`.test.sh` case 13 touches the real base, and it asserts the real base's entry
count is unchanged across `--self-test`.

### 3b. The Darwin-related cases (lines 402–477) — verbatim

Case 17 (lines 402–430) — the Linux side, proving the exclusion is Darwin-only:

```bash
fixture linux_dotted
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Linux" snapshot --state "$state" --base "$base"
assert_eq "Linux snapshot exits 0" "0" "$status"
mkdir -p "$base/com.apple.Maps.mapssyncd"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Linux" verify --state "$state" --base "$base"
assert_eq "on LINUX a dotted directory is still a leak (the exclusion is Darwin-only)" "1" "$status"
assert_contains "and it is named" "com.apple.Maps.mapssyncd" "$output"
assert_not_contains "and nothing is reported as excluded on Linux" "excluded:" "$output"
```

Case 18 (lines 433–452) — Darwin, dotted dirs excluded, count announced:

```bash
fixture darwin_dotted
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" snapshot --state "$state" --base "$base"
assert_eq "Darwin snapshot exits 0" "0" "$status"
mkdir -p "$base/com.apple.Maps.mapssyncd" "$base/com.apple.SafariShared.SafariConfigurationSubscriber"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "on DARWIN daemon dirs are excluded and the run is clean" "0" "$status"
assert_contains "the clean message still appears" "census clean" "$output"
# The exclusion must be VISIBLE, never silent — a silent exclusion is the
# vacuous-green failure mode this guard exists to prevent, so the count and the
# reason are asserted, not just the exit code.
assert_contains "the exclusion is announced with its count" "excluded: 2 dotted-name dir(s)" "$output"
# The BASE is asserted by its own component, not in full: `--base` is
# canonicalised, so on macOS `$tmp_root` spells as `/private/var/…` here. The
# component plus the dash after it is the part that is spelling-independent.
assert_contains "and it names the base it excluded from" "$(basename "$base") — macOS" "$output"
assert_contains "and it says why (daemons share the per-user TMPDIR)" "system daemons share the per-user TMPDIR" "$output"
assert_contains "and it says why the shape is safe (no minter name has a dot)" "no Archimedes minter name contains a dot" "$output"
```

Case 18b (lines 454–462) — dot-free leak on Darwin is STILL reported:

```bash
# 18b. THE OTHER HALF, SAME FIXTURE: a DOT-FREE leak on Darwin is still reported,
#      with the exclusion still announced. `*` instead of `*.*` passes 18 and dies
#      here.
mkdir -p "$base/planted-darwin-leak-1a2b3c4d"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "a dot-free directory on DARWIN is still a leak" "1" "$status"
assert_contains "and it is named" "planted-darwin-leak-1a2b3c4d" "$output"
assert_not_contains "the excluded daemon dir is not itself listed as a failure" "com.apple.Maps.mapssyncd" "$output"
assert_contains "and the exclusion is STILL announced on the failing path" "excluded: 2 dotted-name dir(s)" "$output"
```

**18b is the case that proves the premise of #139 from inside the tree**: a planted
**dot-free** directory on Darwin is *expected* to fail exit 1 today. A second,
dot-free exclusion shape (option (a)) is exactly what 18b currently forbids — so
the planner's new shape must be narrower than "any dot-free name" while 18b's
planted name (`planted-darwin-leak-1a2b3c4d`) must presumably still be reported.
Note this planted name is dot-free and would be caught by any of the §4 shapes
that ignore a leading run of lowercase letters; a shape must therefore have a
defining property `planted-darwin-leak-1a2b3c4d` does not exhibit.

Case 18c (lines 464–477) — the pinned invariant, verbatim:

```bash
# 18c. A DOTTED NAME THAT IS ALSO A KNOWN MINTER PREFIX would be an Archimedes
#      leak wearing a daemon's shape. It cannot exist today — verified against
#      this tree: no `in_env_temp`/`in_tmpfs`/`in_dir` prefix, and no historical
#      prefix on disk, contains a dot — but if a future minter broke that
#      invariant the exclusion WOULD hide it. So the invariant is asserted here,
#      which is what makes "the shape is safe" a checked claim instead of an
#      assumed one.
if grep -rqE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests 2>/dev/null; then
  echo "FAIL no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)"
  grep -rnE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests | sed 's/^/       /'
  failures=$((failures + 1))
else
  echo "ok   no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)"
fi

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "all checks passed"
```

Line numbers: comment 464–470, `grep -rqE` at **471**, FAIL branch 472–474 (echo at
472, listing grep at 473, `failures=$((failures + 1))` at 474), ok branch 475–477.

### 3c. There is NO case 18a or 18d

The numbered cases run 1, 2, 3, 3b, 4 … 13 (in `--self-test`; 14/15 exist only in
`.test.sh` looking at grep behaviour), and in `.test.sh`: 16, 17, 18, **18b, 18c**.
18a/18d do not exist. Case **18** itself would be "18a" if it had a letter. The
"neighbouring cases" are: 17 (Linux dotted), 18 (Darwin dotted clean), 18b (Darwin
dot-free leak), 18c (no-dot invariant).

### 3d. How a NEW case is added — the exact idiom

Every `.test.sh` case is a straight-line sequence inside the single top-level
script. New case example, synthesized strictly from the existing idiom (this is
NOT a proposal — it is the shape of the harness):

```bash
fixture my_new_shape
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" snapshot --state "$state" --base "$base"
mkdir -p "$base/betaenrollmentagent"        # or whatever the shape implies
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "the new shape is excluded on Darwin" "0" "$status"
assert_contains "and the exclusion is announced with its count" "excluded: 1 dotted-name dir(s)" "$output"
```

The `--self-test` equivalent uses `self_mk` + `self_run` + `self_ok`/`self_fail` and
is a numbered `# Case N:` block inside `run_self_test` (cases 13–15 at lines
1100–1216 are the Darwin/platform cases). There is no per-case isolation mechanism —
no functions per case, no `subtest`; both harnesses simply run assertions in order
and tally `failures`/`self_test_failures`.

---

## 4. The invariant that constrains any new exclusion shape

### 4a. All minter call forms in the tree — 94 unique prefixes, every one dot-free

`grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests`
(de-duplicated) yields exactly these 94 prefixes (all end with `-`; none contains a
dot):

```
archimedes-agents-  archimedes-canonical-  archimedes-childproc-kill-test-
archimedes-cmd-agents-  archimedes-native-mig-  archimedes-prompt-
archimedes-skills-  archimedes-spaces-bk-  archimedes-spaces-mig-
archimedes-storage-test-  archimedes-sudo-drop-test-  archimedes-sudo-group-test-
archimedes-sudo-normal-test-  archimedes-trusted-t-  boundary-
crashlog-test-  crashsel-  db-archived-test-  db-caps-test-
db-cluster-fixture-  db-context-test-  db-cost-test-  db-message-mapper-
db-migration-test-  db-page-test-  db-recencycover-test-  db-recencyorder-test-
db-recency-test-  db-reopentest-test-  db-reordernope-test-  db-reorderps-test-
db-reorderses-test-  db-reordersp-test-  db-riput-test-  db-sessbottom-test-
db-session-mapper-  db-sessretouch-test-  db-sortfresh-test-  db-sortidle-test-
db-sortlist-test-  db-sortonce-test-  db-sortsess-test-  db-sortspace-test-
db-sortsub-test-  db-sorttie-test-  db-spacebackfill-test-  db-spacebottom-test-
db-spacelist-test-  db-space-mapper-  db-spaceretouch-test-  db-spacebackfill-test-  (sic; count below)
db-subagent-test-  db-title-mig-test-  db-title-stage-test-  db-title-test-
db-todos-backfill-  db-todos-test-  db-trusted-test-  debuglog-test-
exec-  files-cmd-test-  fsb-  fs-backend-  harness-agent-def-e2e-cfg-
harness-compact-test-  harness-launch-test-  harness-list-agents-home-
harness-loop-  harness-loop-test-  harness-resolve-launch-home-
harness-resolve-launch-settings-  harness-store-  harness-store-test-
harness-subagent-  harness-trust-test-  history-recency-test-  history-reorder-test-
history-todos-test-  ipc-test-  mcp-  mcp-loop-stop-  mcp-loop-test-
perm-gate-  persist-test-  policy-rules-  refresh-  router-todos-
session-cfg-  session-native-  sessions-log-test-  test-support-guard-
worker-e2e-  worker-stdin-
```

(`find -type d` was not run; the set above is the `in_env_temp`/`in_tmpfs`/`in_dir`
call forms in `src-tauri/src` and `src-tauri/tests`, which is exactly the surface
case 18c checks. Count note: my dedup listing shows 92 rows including one
duplicate entry for `db-spacebackfill-test-` (present twice in the tree) — the
distinct set is 91 prefixes, all ending in `-`, none containing a dot. The
`harness-*-launch-*`/`history-*`/`db-*` families above sit BELOW the attribution
table's documented granularity — attribution does NOT need every call form because
longest-prefix-wins maps whole families to one file.)

Minters found outside the call-form grep (so not guaranteed covered by 18c's
literal grep): `archimedes-spaces-mig-` (no `in_*` form) and `harness-launch-test-`
(grep form present at least once). Also note 18c's verified claim "every historical
prefix on disk is dot-free" is about THIS box's temp dir, not reproducible from the
tree.

Wait — correction for precision: the earlier src listing includes
`in_tmpfs("files-cmd-test-", "test-support-guard-", "…")` — i.e. **3 of the 94
hits are `in_tmpfs`**, 91 are `in_env_temp`; **there is no `in_dir` call in the
tree at all** (the 18c grep's third alternative is currently dead). None of this
changes the invariant: every string-literal prefix in the tree is dot-free.

### 4b. The assertion that pins a dot is impossible — case 18c (quoted in §3b)

The only executable pin is `scripts/check-temp-dir-census.test.sh:471`:

```bash
if grep -rqE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests 2>/dev/null; then
```

A future minter whose literal contains a dot reddens `.test.sh` (it is run in
`scripts` CI job and locally). This is the "re-pin the no-dot invariant test to
cover the new shape too" hook §9a's option (a) already names.

### 4c. Constraints a new exclusion shape inherits (from the script's own text)

- "DO NOT MATCH `com.apple.*`. That is a NAME LIST" (line 268).
- "NEVER ADD AN `archimedes-` CATCH-ALL" (line 99) — a `archimedes-*` prefix row in
  the attribution table would blame the wrong file for a shared family, but note
  this trap concerns the ATTRIBUTION table, not the exclusion; §9a's option (a) is
  an exclusion shape and does not touch the attribution table.
- The exclusion must stay Darwin-only (case 17 reddens if the gate is dropped) and
  must stay NEVER SILENT (cases 18/18b assert `excluded: N …` on both paths).
- The follow-up candidate shapes in §4a risk colliding with planted fixtures:
  `planted-darwin-leak-1a2b3c4d`, `-leak-1` etc. (§3b 18b), which 18b requires to be
  REPORTED. The §9a option-(a) shape's defining property must not be a prefix
  property our own planted / minter names satisfy.

---

## 5. The ci.yml snapshot/verify steps

All in the single `lint-test-build` job (the comment at lines 129–137: "three steps
that only work TOGETHER and in this order: prove-it-can-fail, snapshot, verify").
Step names and line numbers:

| Line | Step | `if:` | runs |
|---|---|---|---|
| 159–162 | `Prove the temp-dir census guard can fail` | `runner.os != 'windows'` | `bash scripts/check-temp-dir-census.sh --self-test` |
| 187–194 | `Snapshot the temp dir before cargo test` (`id: census_snapshot`) | `runner.os != 'windows'`, `working-directory: src-tauri` | `bash ../scripts/check-temp-dir-census.sh snapshot --state "$RUNNER_TEMP/archimedes-temp-census.txt"` then `echo "ARCHIMEDES_TEST_CENSUS_BASE=$(bash ../scripts/check-temp-dir-census.sh base)" >> "$GITHUB_ENV"` |
| 240 | `cargo test` (linux) | `runner.os == 'linux'` | `cargo test` |
| 254 | `cargo test (data dir redirected via HOME)` (macos) | `runner.os == 'macos'` | `cargo test` |
| 265 | `cargo test (no data-dir redirect exists on Windows)` | `runner.os == 'windows'` | `cargo test` |
| 338–342 | `Check the test suite left no temp directories` | `steps.census_snapshot.outcome == 'success' && !cancelled()` | `bash ../scripts/check-temp-dir-census.sh verify --state "$RUNNER_TEMP/archimedes-temp-census.txt"` |

**The ordering claim: TRUE as written.** In the YAML, `Snapshot the temp dir before
cargo test` (187) sits directly above the three mutually-exclusive `cargo test`
steps (240/254/265), and `Check the test suite left no temp directories` (338) sits
directly below them (the check-test-data-dir.sh step at 289 is between, for
crashes, but does not touch `/tmp`). So the layout really is
`prove → snapshot → (cargo test) → verify` with NO intervening step between
snapshot and `cargo test` on the macOS leg. (I cannot verify the ~27 ms timing —
no CI run exists for this branch; the layout is the checkable part. §9a's own fix
text claims the snapshot sits "immediately before `cargo test` rather than at job
start" — see §6.)

Also load-bearing in the comment above the snapshot (lines 165–186): `$GITHUB_ENV`
writes from the snapshot step reach `test_support::…` because that step ran BEFORE
`cargo test`; the verify step deliberately does NOT consume
`ARCHIMEDES_TEST_CENSUS_BASE` (it re-resolves the base and compares against the
state file's first line — base-drift check); the state file lives in `$RUNNER_TEMP`
outside the base (T1). Script's own bar: "CI must never pass `--base`"
(lines 27–30), and `make check` deliberately does NOT run the census (lines
47–50).

The `scripts` job (ubuntu) runs the census scripts twice more (lines 407–411):
`Test the temp-dir census check` → `bash scripts/check-temp-dir-census.test.sh`,
then `Prove the temp-dir census guard can fail` → `bash
scripts/check-temp-dir-census.sh --self-test`.

**No other file calls the script.** `grep -rn 'check-temp-dir-census'` over the
repo (excluding the two scripts and `.git`) hits only:
- `.github/workflows/ci.yml` (the steps above),
- `docs/decisions/0078-test-scratch-dirs-are-owned-and-a-census-guards-them.md`,
- `docs/features/issue-96-temp-dir-known-gaps.md` (gap 2's text),
- `src-tauri/src/test_support.rs` (the premise test's doc comments and the
  `ARCHIMEDES_TEST_CENSUS_BASE` read),
- `docs/roadmap/macos-ci-flakes-status.md` (the A1 task text).

`Makefile` has no census targets. The premise test
`the_census_base_is_the_temp_dir_the_suite_actually_uses` (`src-tauri/src/
test_support.rs:434–461`) runs inside `cargo test` and takes its active arm only
when the snapshot step wrote `ARCHIMEDES_TEST_CENSUS_BASE` into `$GITHUB_ENV`; the
`else` arm (line 434–437) is "unset means a local run" and returns immediately.

---

## 6. §9a as written — and which sentences are now false

File `docs/features/issue-96-temp-dir-known-gaps.md`. Front-matter (lines 1–13)
carries `status: live`, `last-verified: 2026-10-29`, and a `verified-by` citing
`00676d5`, PR #99's first run, and: "**Section 9a added 2026-10-29** from `main`'s
CI run `40875258489` (job `123452317398`, log read) plus four measurements on this
tree at `6f501ab`, all four re-run at `02a6de9` and unchanged (grep for the
minter, the tolerance table's single row, the dot-free name against the Darwin
shape rule, the unattributed-vs-tolerated code path) and the `.test.sh` case-18c
citation. **Not verified:** what actually mints `betaenrollmentagent` — no source
for it was found, and the section says so rather than guessing."

§9a in full, lines 206–246 (verbatim):

```markdown
### 9a. A dot-free macOS name defeats the shape rule — `betaenrollmentagent`

**Live on `main`, unfixed, and it will red a macOS job again.** Observed on
`main`'s own history at `2f5f896` (PR #121): CI run `40875258489`, job
`123452317398`, `macos-latest` failed the census step with

> `error: the Rust test suite left 1 new directories …` / `betaenrollmentagent ← <UNATTRIBUTED: no known minter matches this prefix …>`

and the sibling `macos-latest` job of a later SHA ran the same step green. So it
is **intermittent on `main`**, not introduced by any branch, and it is **not** one
of the two `AGENTS.md` frontend flakers.

Measured on this tree, all four claims checked rather than inferred:

- `grep -ri betaenrollment src-tauri/src src-tauri/tests src scripts` → **empty**.
  This repo does not mint it, so the `UNATTRIBUTED` line is correct: the guard is
  doing its job by refusing to guess a minter.
- It is **not** in the tolerance table, which holds exactly one row
  (`harness-subagent-	1`).
- **It contains no dot**, so section 9's Darwin shape rule **cannot exclude it**.
  That rule's safety rests on "no Archimedes minter prefix contains a dot" — an
  invariant that keeps the exclusion from hiding our own leaks. It says nothing
  about a *system* name that happens to be dot-free, and this is one. The shape
  rule is therefore narrower than "excludes macOS noise": it excludes reverse-DNS
  shaped noise.
- An unattributed name **hard-fails regardless of budget** — tolerance is looked up
  by prefix row, and a name with no row never reaches the tolerated path.

**What it is, is not established here.** The name reads like an Apple beta-program
enrollment agent, and it appeared in the same per-user `TMPDIR` that produced 19
`com.apple.*` dirs in the first macOS run, but nothing in this repo mints it and I
did not find a source for it — do not record a minter you have not read.

**Do not fix this by widening the tolerance table.** Section 3's rule is that
tolerances are earned by measurement of *our* leak, and a row here would let a real
`betaenrollmentagent*` leak hide behind a system daemon forever — the exact failure
the allow-list argument in the script's header refuses. The two honest options, if
it starts costing rounds: (a) extend the Darwin exclusion to a second *shape* that
still cannot match an Archimedes prefix, and re-pin the no-dot invariant test
(`.test.sh` case 18c) to cover the new shape too; or (b) snapshot the base
immediately before `cargo test` rather than at job start, shrinking the window a
daemon can write into. (a) trades guard precision for green CI and needs a reviewer;
(b) costs nothing in precision. **Needs an owner, not a drive-by entry.**
```

### 6a. The section's citations (all current as of HEAD)

- `run 40875258489` / `job 123452317398` / `macos-latest` — claimed in the
  front-matter and §9a.
- SHA `2f5f896`, "PR #121" — claimed in §9a line 207.
- SHAs `00676d5`, `6f501ab`, `02a6de9` — front-matter measurements.
- Script commit history (`git log --oneline -- scripts/check-temp-dir-census*`):
  `26d519a docs: fix commit citations…`, `02a6de9 docs(temp-dir): record
  betaenrollmentagent…`, `1f0ae9b docs: record what PR #99's first CI run actually
  found (#96)`, `5e02276 ci: exclude dotted directory names from the census on
  macOS only (#96)`, `7471728 ci: fail the build when the test suite leaks a temp
  dir (#96 task 09)`.

**These SHAs are NOT in this repo's history** (shallow/grafted origin — `git log`
on this branch cannot see them; `git cat-file` fails and a lightweight tag search
returns nothing relevant). They are opaque citations the planner must treat as
unverifiable from this checkout.

### 6b. Which §9a sentences are now FALSE at HEAD — the doc correction surface

1. **"(b) snapshot the base immediately before `cargo test` rather than at job
   start" is described as an option; it is already implemented.** The ci.yml
   snapshot step is named `Snapshot the temp dir before cargo test`, sits directly
   before the `cargo test` steps (line 187 vs 240/254), and the comment at vi
   explains the ordering carries the `$GITHUB_ENV` handoff. So option (b) is gone —
   §9a's own claim "it will red a macOS job again" stands, but only option (a)
   remains live. The mechanism that did NOT fix it is the ~27 ms window: a run
   whose snapshot is 27 ms before the suite is still not proof; §5 documents the
   layout, the 27 ms CI timing is unverifiable here.
2. **"`main`'s own history at `2f5f896` (PR #121)"** — the doc's only SECOND
   recorded occurrence of `betaenrollmentagent` in the tree is
   `docs/research/windows-child-console-window.md:144` (the PR #140 writeup):
   "the macOS job failed at step 17, the temp-dir census, on an unattributed
   `betaenrollmentagent` directory, while `cargo test` passed on that same run
   (1602 passed)". The status file's A1 task (see §6c) instructs adding this
   second occurrence to §9a. (I can only see the two occurrences in-tree: §9a
   itself and the PR #140 writeup.)
3. **"Needs an owner, not a drive-by entry"** — the owner now exists: this
   roadmap (`docs/roadmap/macos-ci-flakes-status.md`, task A1, status `todo`).
   §9a's "if it starts costing rounds" conditional is also superseded — the PR
   #140 macOS red is a second round, so the option list is live, not hypothetical.
4. Front-matter "last-verified: 2026-10-29" + "verified-by" measurements — recorded
   as of `02a6de9`; still accurate at HEAD (I re-ran the four measurements against
   `60470d2`, all unchanged: `betaenrollment` grep empty in src scripts + tests +
   docs excluding the two occurrence docs; tolerance table one row; name is
   dot-free; unattributed hard-fails — §2d).

Sentences that remain TRUE: "Live on `main`, unfixed"; the 19 daemon dirs; the
four measured claims (all re-confirmed); "What it is, is not established here";
**"Do not fix this by widening the tolerance table."** — the prohibition, verbatim,
lines 240–245, and restated as the A1 constraint in the status file:

>The two honest options, if it starts costing rounds: (a) extend the Darwin
>exclusion to a second *shape* that still cannot match an Archimedes prefix, and
>re-pin the no-dot invariant test (`.test.sh` case 18c) to cover the new shape
>too; or (b) snapshot the base immediately before `cargo test` rather than at job
>start, shrinking the window a daemon can write into. (a) trades guard precision
>for green CI and needs a reviewer; (b) costs nothing in precision. **Needs an
>owner, not a drive-by entry.**

### 6c. The roadmap's own framing (already inside the branch)

`docs/roadmap/macos-ci-flakes-status.md` — A1 task (line 110):

>Extend the Darwin temp-dir exclusion to a second shape that cannot match an
>Archimedes minter prefix, re-pin the self-test's no-dot invariant case (18c) to
>cover it, and correct §9a (option (b) is already implemented; add the second
>`betaenrollmentagent` occurrence) — #139

and the constraint (lines 113–115):

>**Constraint on A1 that outranks any plan's preference:** do **not** widen the
>tolerance table. §9a states the rule verbatim — tolerances are earned by
>measurement of *our* leak, and a `betaenrollmentagent*` row would let a real leak
>hide behind a system daemon forever. The fix is the exclusion *shape*, not a
>tolerance row.

The status file also records the gate baseline at `60470d2` (census self-test "all
checks passed"; `cargo test` 1652 passed / 0 failed / 1 ignored) and "Neither flake
reproduces locally."

---

## 7. How to run the local proof

- Census self-test: `bash scripts/check-temp-dir-census.sh --self-test` (the `--self-test` mode of the census script itself; expected final line `self-test: all cases behaved (the guard has teeth)`). Case 18c lives in the OTHER harness:
- Harness over the script: `bash scripts/check-temp-dir-census.test.sh` (expected final lines `ok   no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)` / `all checks passed`).
- Syntax gate: `bash -n scripts/check-temp-dir-census.sh scripts/check-temp-dir-census.test.sh` (the script header says CI enforces `bash -n` plus `--self-test` in the `scripts` job).
- Manual bracket: `bash scripts/check-temp-dir-census.sh snapshot --state ~/.cache/census.txt` before, `bash scripts/check-temp-dir-census.sh verify --state ~/.cache/census.txt` after — CI uses `$RUNNER_TEMP/archimedes-temp-census.txt` and a `--base`-less call (the header warns "**CI must never pass** `--base`": fixtures only).
- The `scripts` CI job runs both `.test.sh` and `--self-test` (ci.yml 407–411); the `lint-test-build` job runs `--self-test` before its snapshot (ci.yml 159–162). Nothing else in the repo or `Makefile` invokes the census script. The Rust premise test `the_census_base_is_the_temp_dir_the_suite_actually_uses` runs inside `cargo test` but takes its inert arm without `$GITHUB_ENV`.

---

## 8. What I could NOT verify from this machine

- **Real macOS daemon behaviour**: `betaenrollmentagent`'s existence, creator,
  timing, or shape in a real `/var/folders/…/T` — no macOS is available here; the
  Darwin half is only ever exercised via `ARCHIMEDES_CENSUS_UNAME_S` injection.
- **The CI run itself**: run ids `40875258489` (job `123452317398`) and the
  "sibling macOS job same SHA green" claim; the PR #140 red cited in
  `docs/research/windows-child-console-window.md:144`; the ~27 ms snapshot→test
  gap; the "19 daemons" run `40347693926`. Requires GitHub access.
- **The SHAs the docs cite** (`2f5f896`, `00676d5`, `6f501ab`, `02a6de9`): not
  reachable in this checkout (grafted/shallow; origin import history).
- **The box's historical `/tmp` pile** ("every historical prefix on disk is
  dot-free") — the current machine's temp dirs were not enumerated (read-only
  mandate), and it is a different machine from the one that measured the pile.

Everything else above was verified directly against the tree at `60470d2`.

---

## Verdict on the issue's claim (verify/refute against the tree)

**CONFIRMED, with one precise nuance.** Every element checks out:

1. The Darwin exclusion is a dot shape (`case "$1" in *.*)`, line 294) — a name
   with no dot is never excluded, on any platform. So a dot-free daemon name
   reaches classification as strict.
2. `betaenrollmentagent` matches no attribution row (the table has 45 rows, longest-
   prefix-wins), so it prints `← <UNATTRIBUTED: …>` (§2b) and hard-fails exit 1
   (§2d, line 749: `if [[ -z "$budget" ]]; then strict+=("$name")`).
3. Option (b) — snapshot immediately before `cargo test` — is already implemented
   in ci.yml (§5): the `Snapshot the temp dir before cargo test` step is directly
   above the `cargo test` steps. So option (a), a second exclusion shape that
   cannot match an Archimedes prefix, is the only live option (§6b); §9a still
   lists (b) as an option and "Needs an owner" — both now false.
4. The invariant the new shape must satisfy is real and pinned: 91 distinct
   minter prefixes in the tree, all ending `-`, none containing a dot (§4a); case
   18c asserts it via `grep -qE` at `.test.sh:471` (§3b/4b). No dot-free prefix
   is possible under the A1 constraint (the new shape must be provably unmatchable
   by the §4a set), and case 18b already demands dot-free **planted** names stay
   reported, so any option-(a) shape must be narrower than "any dot-free name".

The **nuance**: §9a describes option (b) as "snapshot the base immediately before
`cargo test` rather than at job start, shrinking the window a daemon can write
into" — implemented, but in a different feature branch (`main`, on the PR-#99-era
code), and the local tree's snapshot step carries the ADDITIONAL `$GITHUB_ENV`
handoff burden (§5) that (b)-as-written never mentions. If the planner inherits
"option (b) is already implemented" from the status file, that means the next
index-8 snapshot still maintains the ordering, not that the window is gone.
