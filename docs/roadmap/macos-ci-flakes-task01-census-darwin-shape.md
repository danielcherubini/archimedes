---
status: committed
task: A1
wave: 1
issue: "#139"
area: temp-dir-census
parent: docs/roadmap/macos-ci-flakes-status.md
owned:
  - scripts/check-temp-dir-census.sh
  - scripts/check-temp-dir-census.test.sh
  - docs/features/issue-96-temp-dir-known-gaps.md
base: 60470d2
done-when: On Darwin (`ARCHIMEDES_CENSUS_UNAME_S=Darwin` injected in the fixture harness) a dot-free AND dash-free name like `betaenrollmentagent` is excluded and the run is clean (proven by the new `.test.sh` case 18d), the planted dotted daemon dirs are excluded with the count announced (cases 18/18b, `--self-test` Case 14), the planted dot-free/dash-full leaks (case 18b, `--self-test` Case 14) still exit 1 and are named, the self-test's invariant cases (18c no-dot, verbatim semantics, plus the new no-dash twin 18c(2)) stay green, case 19 proves the guard's teeth (an injected dash-free literal trips FAIL), all five `shape-mismatched` token pins (cases 18, 18b, `--self-test` Case 14 both halves, and the doc's shape-rule bullet at line 194) are updated in the same commit, §9a carries the two corrections with the issue-reported 3→5 movement explicitly attributed as NOT measured here, and both gate commands pass from the repo root with `bash -n` clean.
---

# Task A1 — Second Darwin exclusion shape (dash-free), re-pinned invariant, §9a corrected

**Goal:** Extend the Darwin-only temp-dir census exclusion from one shape — *the name contains a dot* — to two: add *the name contains no dash* — the negated-glob test `[[ "$1" != *-* ]]` — so a dot-free, dash-free system daemon dir like `betaenrollmentagent` stops reddening the `macos-latest` census step as an UNATTRIBUTED hard failure (issue #139). The new shape is provably disjoint from every Archimedes minter prefix — all **91 distinct minter prefixes** END in a dash (measured chain: **119 raw call forms → 93 unique raw rows → 91 distinct prefixes**, zero dash-free, zero dotted — see *Pre-flight*), while `betaenrollmentagent` has zero dashes — so a dash-free name cannot be one of ours, and the tolerance table (which this task must not widen) is untouched. The self-test re-pins the corresponding invariant: case 18c keeps the no-dot check verbatim in SEMANTICS and is re-expressed in the pipe-safe form (command substitution + final lone `[[ -n ]]` test — see §2a for why, and the verified SIGPIPE repro in *Pre-flight*), a new no-dash twin (18c(2)) asserts no minter call-form literal is dash-free, a new case 18d asserts the dash-free shape's positive behaviour (`betaenrollmentagent` excluded, run clean, count announced), and case 19 proves the guard's teeth against an injected dash-free literal in a synthetic corpus. §9a's two corrections ship in the same task, because the doc and the script change together (status file, `wave 1`).

**Grounding:** this plan is written against `docs/roadmap/macos-ci-flakes-ground-temp-dir-census.md` (grounded at `60470d2`), which carries the full end-to-end read of the exclusion (§1), the classification path (§2), the self-test structure and case idiom (§3), the 91-prefix invariant survey (§4 — re-measured here as the **119 → 93 → 91** chain, see *Pre-flight*), the ci.yml layout (§5), and the §9a corrections surface (§6). It is NOT restated here — the implementer follows the field plan and dips back into that report for narrative. Every executable number in this plan was re-measured against the tree at `60470d2` and both gate commands were run green (see *Pre-flight*). Cases are cited by name/id — 17, 18, 18b, 18c, 18c(2), 18d, 19, `--self-test` Case 14 — never by bare line number, because line numbers decay on the next commit.

## Pre-flight (measured at `60470d2`, clean tree, branch `feature/macos-ci-flakes`)

- `bash -n scripts/check-temp-dir-census.sh scripts/check-temp-dir-census.test.sh` → clean.
- `bash scripts/check-temp-dir-census.test.sh` → final lines `ok   no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)` / `all checks passed`.
- `bash scripts/check-temp-dir-census.sh --self-test` → final line `self-test: all cases behaved (the guard has teeth)`.
- **The minter call-form chain (corrected):** `grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests | wc -l` → **119** raw call forms; over the DE-DUPLICATED call forms `… | sort -u | wc -l` → **93** unique raw rows; over the extracted prefix column `… | sed -E 's/^[^"]*"//; s/"$//' | sort -u | wc -l` → **91** distinct prefixes. The 93→91 gap is exactly two raw rows whose prefixes already exist under another call form: the two `in_tmpfs` rows `in_tmpfs("files-cmd-test-", …)` and `in_tmpfs("test-support-guard-", …)` (both prefixes also appear as `in_env_temp` rows). Every one of the 91 ends in `-`; zero are dash-free (`grep -v -- '-'` on the 91 = empty) and zero contain a dot (`grep -c '\.'` = 0). `grep -c -- '-"'` on the RAW 119 prints **119**, not 93 — the 93/91 figures come only from the de-duplicated stages.
- **`boundary-` is NOT an `in_*` minter prefix:** `grep -rnE '(in_env_temp|in_tmpfs|in_dir)\(\s*"boundary'` → **0 hits**. The `boundary.rs` call is multi-line (`ScratchDir::in_env_temp(` … `"boundary-",` … at `boundary.rs:251-253`), invisible to the line-oriented call-form grep, so `boundary-` exists only as an attribution-table row (`scripts/check-temp-dir-census.sh` line 170). It is therefore NOT among the 91 and MUST be dropped from any "exactly-eight-chars-then-a-dash" example. (This is also an honest limit of the invariant greps — see *Unverified*.)
- **The `????????-*` falsifier, measured at the prefix level:** `grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -E '^[^-]{0,8}-'` → **77 hits** (77 of the 91 distinct prefixes have their first dash at offset ≤ 8). Exactly-eight-chars-then-a-dash (`grep -E '^[^-]{8}-'`): **4 prefixes** — `crashsel-`, `crashlog-test-`, `debuglog-test-`, `sessions-log-test-`. `crashsel-` is the genuine exact-8 example to keep.
- **The pipefail / `grep -q` fragility, reproduced (blocker 1):** under `set -euo pipefail`, a guard shaped `… | sort -u | grep -v -- '-' | grep -q .` returned **FALSE GREEN 5/5 trials** on a corpus of >64KB of genuinely dash-free literals — `grep -q .` exits 0 on the first dash-free line, its upstream `sort -u` dies on SIGPIPE (141), and pipefail marries that into the pipeline status, so the `if` sees a non-zero status and the FAIL branch never trips. The same corpus through the command-substitution form `if [[ -n "$( … | sort -u | grep -v -- '-' )" ]]` went **RED deterministically on every trial**. The injected-dash-free-prefix verification for the FINAL form is in *Field checks* item 5.
- Name audit for the two planted/daemon names: `betaenrollmentagent` → 0 dashes, 0 dots. `planted-darwin-leak-1a2b3c4d` → dashes, 0 dots.

## Shape proof — one shape picked on the evidence, from the tree

The turning point is a fact the all-dash premise makes counter-intuitive: **every one of the 91 distinct minter prefixes ENDS in a dash; zero are dash-free.** The dash is therefore a reliable marker of OUR names — and a dash-free name is reliably NOT ours. That inverts which predicate belongs in the exclusion:

| Candidate second shape | Excludes `betaenrollmentagent`? | Keeps 18b's planted name reported? | Matches any of the 91 minter prefixes? | Verdict |
|---|---|---|---|---|
| **dash-free** (`[[ "$1" != *-* ]]` — the name contains NO dash anywhere) | YES — zero dashes → excluded on Darwin | YES — `planted-darwin-leak-1a2b3c4d` contains dashes → the negated glob `!= *-*` is FALSE → not excluded | **No** — every minter prefix ends in `-` and therefore CONTAINS a dash; `[[ "$1" != *-* ]]` is false for a name with any dash → excluded by none of the 91. | **PLAN — picked.** This is the shape 18b actually allows: 18b's planted name has dashes, so no shape predicated on dash-presence breaks it — and `betaenrollmentagent` has none. |
| `????????-*` (exactly eight chars then a dash) | NO — `betaenrollmentagent` is 19 chars, dash at offset 10 = the pattern runs out of `?`s with the name not consumed → no match. | YES | **YES by direct measurement** — 77 of the 91 distinct prefixes have their first dash at offset ≤ 8; `crashsel-` is EXACTLY eight chars then a dash → the shape would silently exclude real Archimedes leaks → breaks constraint 2. | **REJECTED — this was my first pick, and the tree killed it.** The 77-hit grep is in *Field checks* as the counter-evidence. (`boundary-` is NOT in the 91 — attribution-table prefix only, multi-line call — and must not be cited here.) |
| `[a-z]*-*` (leading lowercase then a dash) | yes | NO — the planted name is leading-lowercase-then-dash → excluded → 18b reds | yes (all 91) | rejected (breaks 18b) |
| `*daemon*` / any name fragment | name list, not a shape — the rejected form (grounding §1a) | — | — | rejected |
| any-dot-free-name (`*`) | yes | NO — 18b's planted name is dot-free → excluded → 18b reds | yes, wholesale | rejected (the 18b trap) |

The non-matching proof, per candidate shape:
- **Dash-free (picked):** minter prefixes match `*.*`? no (dot count 0 — 18c's existing invariant). Match `[[ "$1" != *-* ]]`? no — every one of the 91 ends in `-`, so every one CONTAINS a dash, and the negated glob is false for a name with any dash. **A minter prefix is excluded by the dash-free shape iff it contains no dash — a statement true for exactly zero of the 91.** The union is the two independent shape functions OR'd in the script; 18b's planted `planted-darwin-leak-1a2b3c4d` contains dashes → matches NEITHER → stays reported with exit 1.
- **The structural reason (minor 7 — stronger than the enumeration):** the real safety is not the corpus, it is the **naming contract** in `src-tauri/src/test_support.rs:207` — *"A fresh dir directly inside `base`, named `{prefix}{tag}-{uuid}`"* — re-pinned by the test named in `test_support.rs:533` (`the_guard_names_the_dir_after_the_prefix_and_tag_it_is_given`). Every real Archimedes temp-dir name ends in `{tag}-{uuid}` with a NON-EMPTY `uuid`, so **a dash terminates every real name by construction** — a dash-free name is structurally impossible for `ScratchDir`, no matter what a future minter calls its prefix. The corpus check (18c(2)) remains the executable PIN; the naming contract is the cited REASON the pin's invariant is safe to hold. (`test_support.rs:211` is the same contract's `format!("{prefix}{tag}-{}", uuid)` implementation.)
- **The eight-chars-then-dash counter-example (`????????-*`), and why it must never be merged:** the tree does the rejecting, not the reviewer. `… | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -E '^[^-]{0,8}-'` → **77 hits** over the 91, including exactly-8-char stems `crashsel-` (and `crashlog-test-`, `debuglog-test-`, `sessions-log-test-`). `????????-*` matches `crashsel-*` verbatim — a real leak would be silently excluded the moment the shape lands, which is the exact "leak hiding behind a daemon's shape" failure the task forbids. The pattern record in the plan's rejected row points at this grep as the falsifier.

**Why the plan does not lean on `betaenrollmentagent` itself:** the predicate *dash-free* is true for it (zero dashes), so the new shape excludes it directly — but that is not the reason to build the shape. The reason is the disjointness: dash-free is a marker for "not an Archimedes minter" (91/91 end in a dash) AND "not one of our planted fixtures" (18b's has dashes). The daemon set is volatile; the shape is not.

**The plotting of the shape's breadth:** the dash-free predicate is NARROWER than "any dot-free name" by 18b's own light — `planted-darwin-leak-1a2b3c4d` is dot-free and must STAY reported (18b pins exit 1). It excludes exactly the dash-free subset of dot-free names, and the tree guarantees the minter set is entirely dash-full. That is the required shape.

## Files

- Modify: `scripts/check-temp-dir-census.sh`
- Modify: `scripts/check-temp-dir-census.test.sh`
- Modify: `docs/features/issue-96-temp-dir-known-gaps.md`

This is the entire owned set. `ci.yml` is NOT edited (the snapshot step already sits directly above `cargo test` — §5 of the grounding; option (b) is already implemented, the doc-correction surface is §6b). `scripts/check-temp-dir-census.sh` is invoked from exactly two places in ci.yml (the `lint-test-build` snapshot+verify steps and the `Prove …` step in the `scripts` job) and from no Makefile target — the field plan touches only the two scripts and the doc.

## Coupling map — the five `shape-mismatched` token pins (blockers 2 and 8)

Renaming the message token `dotted-name` → `shape-mismatched` reds **FIVE** fixture/doc pins, and this plan edits all five in the same commit (Step 3 in `Steps:`):

| # | Site (by case id, current line at `60470d2`) | Current pin |
|---|---|---|
| 1 | `.test.sh` case 18 (line ~446) | `excluded: 2 dotted-name dir(s)` |
| 2 | `.test.sh` case 18b (line ~462) | `excluded: 2 dotted-name dir(s)` |
| 3 | `check-temp-dir-census.sh` `--self-test` Case 14, dotted half (line ~1183) | `excluded: 1 dotted-name dir(s)` |
| 4 | `check-temp-dir-census.sh` `--self-test` Case 14, dot-free half (line ~1193) | `excluded: 1 dotted-name dir(s)` |
| 5 | `docs/features/issue-96-temp-dir-known-gaps.md` shape-rule bullet (line ~194) | `` `excluded: N dotted-name dir(s)` `` |

Case 17 is NOT a pin of the token — it asserts `assert_not_contains "excluded:"` on Linux (no exclusion at all); the counts in the four fixture pins DO NOT change (18 stays 2, 18b stays 2, Case 14 stays 1 — the dash-free shape adds no exclusions to those fixtures). No other file pins the token (`grep -rn 'dotted-name'` across the owned set + ci.yml hits only the five sites above plus the script's own comment at line 42, which Step 3 updates in the same edit).

## Field plan

### 1. `scripts/check-temp-dir-census.sh` — the second shape (dash-free)

**1a. The shape function — a second predicate, same documentation discipline.** Next to `dotted_name()` (the `*.*` shape), add:

```bash
# The SECOND shape: a name that contains NO dash anywhere. Why a shape and
# not a name list is the header's argument — this needs no widening as daemons
# arrive and go because it cannot match an Archimedes minter: every real
# ScratchDir name is `{prefix}{tag}-{uuid}` (test_support.rs) with a NON-EMPTY
# uuid, so a dash terminates every real name BY CONSTRUCTION — a dash-free name
# is structurally impossible for us to own. The corpus pin (`.test.sh` 18c(2))
# asserts the same in the tree, so a minter that broke it reddens a test instead
# of quietly becoming invisible. (This shape is Darwin-only, exactly like the
# dotted shape: see `exclusion_applies_here`.)
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
```

Closed form, verified against the tree: `betaenrollmentagent` → `!= *-*` true → excluded. `planted-darwin-leak-1a2b3c4d` → contains a dash → false → NOT excluded → case 18b stays green. Every minter prefix (`…-`) → contains a dash → false → never excluded (91/91, see *Shape proof*).

**1b. The OR in the split loop.** In `run_verify`, change the exclusion test from the single `dotted_name "$cand"` to the union, keeping the always-announced count:

```bash
      if dotted_name "$cand" || dash_free_name "$cand"; then
        excluded+=("$cand")
      else
        counted+="$cand"$'\n'
      fi
```

No user-dir arm is needed — the dash-free shape IS the broad arm; the two predicates together classify every daemon name in the §9a record (all dot-free names like `betaenrollmentagent`, all named daemon dirs) without any literal list.

**1c. Keep the announcement honest for BOTH shapes.** The note builder currently prints `dotted-name dir(s)` and the reason `no Archimedes minter name contains a dot (#96)`. This is the message token coupled across the five pins in the *Coupling map*. Both the label and the reason must cover the second shape:

```bash
  local excluded_note=""
  if (( ${#excluded[@]} > 0 )); then
    excluded_note="$(printf 'excluded: %s shape-mismatched dir(s) in %s — macOS system daemons share the per-user TMPDIR; no Archimedes minter name contains a dot or a dash (#96)\n' "${#excluded[@]}" "$base")"
  fi
```

Renaming the message token (`dotted-name` → `shape-mismatched`) is the ONLY cross-file contract this plan sharpens — which is exactly where the coupling shows: change the printf format and all five pins red, loudly. The reason string's old leading phrase `no Archimedes minter name contains a dot` is a PREFIX of the new reason, so case 18's reason assertion (which pins that exact phrase) stays green without an edit; only the token pins need the Step-3 edit. The Step-2 and Step-3 reds close each other within the same commitable unit (see *TDD order*).

**1d. READ-ONLY discipline preserved.** `self_rm`, the EXIT trap, and the "never delete what you did not create" comment stay exactly as they are. The field plan adds no `rm` and no `mkdir` outside the two script files.

### 2. `scripts/check-temp-dir-census.test.sh` — the re-pinned self-test

**2a. Case 18c: pipe-safe re-expression, verbatim semantics. Case 18c(2): the no-dash twin.** Keep the existing no-dot check's SEMANTICS — same output lines, same exit-status meaning: FAIL iff any minter call-form literal contains a dot — but re-express BOTH 18c and the new twin in the pipe-safe form: command substitution feeding a final LONE negated test, with **no `| grep -q .` anywhere**. Why: the harness runs `set -euo pipefail` (line ~28), and a `| grep -q .` at the tail of the extraction pipeline can silently green a dash-free tree — `grep -q .` exits 0 on the first match/EOF, the upstream `sort -u` gets a closed pipe (SIGPIPE/141), and pipefail marries that upstream failure into the pipeline status so the `if` never sees the true condition (reproduced: 5/5 false greens on a >64KB dash-free corpus; see *Pre-flight*). The two invariants are independent checks that must each report, so they stay TWO separate `if` blocks — do NOT merge them with `&&`.

Exact final form for 18c (no-dot, verbatim semantics):

```bash
# 18c. A DOTTED NAME THAT IS ALSO A KNOWN MINTER PREFIX would be an Archimedes
#      leak wearing a daemon's shape. It cannot exist today — verified against
#      this tree: no `in_env_temp`/`in_tmpfs`/`in_dir` prefix, and no historical
#      prefix on disk, contains a dot — but if a future minter broke that
#      invariant the exclusion WOULD hide it. So the invariant is asserted here,
#      which is what makes "the shape is safe" a checked claim instead of an
#      assumed one. (Re-expressed in the pipe-safe form: command substitution +
#      final lone `[[ -n ]]` negated test, no `| grep -q .` at the tail — under
#      the harness's `set -euo pipefail` a trailing `grep -q .` can SIGPIPE its
#      own upstream into a false green when a dotted literal IS present.)
if [[ -n "$(grep -rE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests 2>/dev/null)" ]]; then
  echo "FAIL no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)"
  grep -rnE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*\.' src-tauri/src src-tauri/tests | sed 's/^/       /'
  failures=$((failures + 1))
else
  echo "ok   no minter prefix contains a dot (the Darwin dotted-name exclusion depends on this)"
fi
```

Exact final form for the no-dash twin 18c(2), placed immediately after 18c's `ok` (own `failures=$((failures + 1))`, own `ok` branch — a `&&`-merged pair would swallow the no-dash result when the no-dot grep fails):

```bash
# 18c(2). A MINTER PREFIX WITH NO DASH would be an Archimedes leak wearing the
#      shape `betaenrollmentagent` wears. It cannot exist today — every one of
#      the 91 distinct `in_env_temp`/`in_tmpfs`/`in_dir` prefixes in this tree
#      ends in a dash — but if a future minter ever mints a dash-free prefix,
#      the second Darwin shape would hide it. So the invariant is asserted here,
#      the no-dash twin of the no-dot invariant above: a future dash-free
#      minter reddens this check instead of quietly becoming invisible behind
#      the dash-free shape. NOTE on the pattern: a literal `[^"-]*` character
#      class does NOT encode "dash-free" (a `[^"-]*` run still allows dashes
#      outside the run, and a `[^"]*[^-]` trailing class matches any name ending
#      in a non-dash). The check is therefore "are there any extracted prefixes
#      with no dash": `grep -v -- '-'` inside a command substitution, tested by
#      a final LONE `[[ -n ]]` — no `| grep -q .` at the tail (see 18c's note:
#      under `set -euo pipefail` a trailing `grep -q .` can SIGPIPE its own
#      upstream into a false green exactly when a dash-free prefix IS present).
if [[ -n "$(grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests 2>/dev/null | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -v -- '-')" ]]; then
  echo "FAIL a minter prefix is dash-free (the Darwin second shape depends on this)"
  grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' src-tauri/src src-tauri/tests | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -v -- '-' | sed 's/^/       /'
  failures=$((failures + 1))
else
  echo "ok   no minter prefix is dash-free (the Darwin second shape depends on this)"
fi
```

Both greps target only `src-tauri/src src-tauri/tests`, so neither matches its own harness source (which lives in `scripts/`).

**2b. Case 18d — the dash-free name is excluded and the run is clean (blocker 3: C1's missing proof).** C1 claims "a dot-free AND dash-free name like `betaenrollmentagent` is excluded and the run is clean" — but until now NO case planted such a name: 18's plants are dotted, 18b's and Case 14's contain dashes. Neither harness asserted the shape's positive behaviour. New case, placed after 18c(2) (same straight-line idiom as 18/18b, own fixture so the count is exact):

```bash
# 18d. THE POSITIVE HALF OF THE SECOND SHAPE: a DOT-FREE AND DASH-FREE name on
#      Darwin is EXCLUDED and the run is clean. The daemon of issue #139
#      (`betaenrollmentagent`) has zero dots AND zero dashes, so it reaches the
#      exclusion only through the new shape — `dotted_name` alone would leave it
#      strict and red. Before this case, neither harness planted a dash-free
#      name: 18's plants are dotted, 18b's and Case 14's contain dashes. C1
#      becomes a real assertion only here, where the count says EXACTLY which
#      set was excluded.
fixture darwin_dashfree
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" snapshot --state "$state" --base "$base"
assert_eq "Darwin snapshot exits 0" "0" "$status"
mkdir -p "$base/betaenrollmentagent"
run_check_env "ARCHIMEDES_CENSUS_UNAME_S=Darwin" verify --state "$state" --base "$base"
assert_eq "a dot-free AND dash-free name on DARWIN is excluded and the run is clean" "0" "$status"
assert_contains "the clean message still appears" "census clean" "$output"
# The count reflects EXACTLY the excluded set: one planted dash-free dir, one
# excluded — not zero (the exclusion must fire) and not "the failure was
# silently swallowed" (exit 0 + clean already rules that out).
assert_contains "the exclusion is announced with exactly the excluded set's count" "excluded: 1 shape-mismatched dir(s)" "$output"
assert_contains "and it says why (daemons share the per-user TMPDIR)" "system daemons share the per-user TMPDIR" "$output"
assert_contains "and it says why the shapes are safe (no minter name has a dot or a dash)" "no Archimedes minter name contains a dot or a dash" "$output"
assert_not_contains "and the excluded name is never listed as a failure" "betaenrollmentagent" "$output"
```

This is the assertion C1 needs: it pins exit 0, the clean message, the announced count (1 == the one dash-free plant), the reason, and that the name does not resurface as a failure (guard against a future "print the excluded names" regression that could be mistaken for attribution).

**2c. Case 19 — the guard's teeth, not a duplicate of 18c(2) (major 4).** The planned case 19 was a byte-identical twin of 18c(2)'s extraction pipeline over the same tree — two copies of one grep, so one match trips both and absence greens both: false confidence in "two sides" that are one side. **Chosen: repurpose 19, not drop it** — it becomes the test of the guard's BIOLOGY (blocker 1 made that the plan's load-bearing mechanism): a dash-free literal INJECTED into a SYNTHETIC corpus must trip the twin's FAIL branch. That is genuinely different from 18c(2) (which proves ABSENCE in the real tree); together they close the loop — 18c(2) says the tree has none, 19 says the check would catch one. It is also the permanent home of the injected-prefix verification, so a future refactor cannot silently reintroduce `| grep -q .`. Using the pipe-safe form and a throwaway tree under `$tmp_root` (cleaned by the EXIT trap):

```bash
# 19. THE GUARD'S TEETH — an injected dash-free literal must trip the twin's
#     FAIL branch. 18c(2) proves the REAL tree has no dash-free minter prefix;
#     this case proves the CHECK ITSELF would catch one: it greps a throwaway
#     synthetic tree that DOES contain a dash-free literal and asserts the FAIL
#     branch fires (same pipeline, same pipe-safe form — command substitution +
#     final LONE `[[ -n ]]`, no `| grep -q .`, which under `set -euo pipefail`
#     can SIGPIPE its own upstream into a false green). This case was formerly a
#     byte-identical copy of 18c(2); it now tests the pipeline's teeth instead
#     of the corpus twice.
synthetic="$tmp_root/synthetic-minter-tree"
mkdir -p "$synthetic/src" "$synthetic/tests"
printf 'ScratchDir::in_env_temp("syntheticdashfree", tag)\n' > "$synthetic/tests/synthetic.rs"
if [[ -n "$(grep -rhoE '(in_env_temp|in_tmpfs|in_dir)\(\s*"[^"]*"' "$synthetic/src" "$synthetic/tests" 2>/dev/null | sed -E 's/^[^"]*"//; s/"$//' | sort -u | grep -v -- '-')" ]]; then
  echo "ok   the dash-free check has teeth: an injected dash-free literal trips FAIL (case 19)"
else
  echo "FAIL the dash-free check did NOT catch an injected dash-free literal (case 19)"
  failures=$((failures + 1))
fi
```

The synthetic literal `syntheticdashfree` is genuinely dash-free (0 dashes, 0 dots), so `grep -v -- '-'` emits it and `[[ -n $(…) ]]` is true → `ok`. If a future refactor adds `| grep -q .` back (or otherwise breaks the pipeline), 19 reds under `set -euo pipefail` — this is the regression net blocker 1 demanded.

### 3. `docs/features/issue-96-temp-dir-known-gaps.md` — §9a corrected + the fifth token pin

**3a. Kill the stale option-(b) framing (grounding §6b-1).** §9a's clause:

> …or (b) snapshot the base immediately before `cargo test` rather than at job start, shrinking the window a daemon can write into.

becomes — record that option (b) is already implemented (the ci.yml step is literally named `Snapshot the temp dir before cargo test` and sits directly above the `cargo test` steps), so (a) is the ONLY live option, and there is no window left to shrink: ~100% of the exposure is the suite's own runtime, which the delta must straddle by design.

Proposed text:

> …The two honest options, if it starts costing rounds: (a) extend the Darwin
> exclusion to a second *shape*; or (b) snapshot the base immediately before
> `cargo test` rather than at job start. **(b) is already implemented** — the
> ci.yml step is literally `Snapshot the temp dir before cargo test` and sits
> directly above the `cargo test` steps — so there is no window left to shrink:
> ~100% of the exposure is the suite's own runtime, which the delta must
> straddle by design, and (a) is the only live option. This section is that
> task's owner; the shape and the re-pinned invariant live in
> `scripts/check-temp-dir-census.sh` / `.test.sh` (case 18c plus the no-dash
> twin and the teeth case).

**3b. Record the second occurrence — only what the repo can stand behind (major 6).** The tree's second recorded occurrence is `docs/research/windows-child-console-window.md` (the PR #140 writeup): the macOS job failed at step 17, the temp-dir census, on an unattributed `betaenrollmentagent` directory, while `cargo test` passed on that same run (1602 passed); the sibling macOS run of the identical SHA passed the same step. **The run/job ids `41188776833` / `124501049035` do NOT appear anywhere in this repo** — `git grep` finds zero hits — and **`excluded: 5` appears nowhere in the tree either** (the highest `excluded:` count in the tree is the fixtures' `2` in `.test.sh`). §9a's own `verified-by` discipline punishes recording an unmeasured minter/count as measured, so the second-occurrence record cites ONLY the in-tree writeup and attributes the count movement EXPLICITLY:

> The second recorded occurrence is the PR #140 writeup
> (`docs/research/windows-child-console-window.md`): the macOS job failed at
> step 17, the temp-dir census, on an unattributed `betaenrollmentagent`
> directory, while `cargo test` passed on that same run (1602 passed), and the
> sibling macOS run of the identical SHA passed the same step. The exclusion
> count moved between the first (§9a above) and this occurrence — 3 dotted-name
> dirs on the first run, 5 on this one — **as reported by issue #139; the 3→5
> figures are issue-provided and have not been re-measured in this repo** (the
> run ids are not present in the tree, no macOS and no run logs exist here, and
> `excluded: 5` appears in no artifact this doc can cite). A doc correction
> must not launder an issue's numbers into a measured record.

**3c. Owner + Darwin-only fix.** Replace:
- "**Needs an owner, not a drive-by entry.**" → "**Owner: roadmap task A1 — the shape change is the fix, not a future option.**"
- The "Do not fix this by widening the tolerance table" paragraph gains one sentence at its end: "The exclusion is Darwin-only: a dotted or dash-free dir on Linux is STILL a leak (`.test.sh` case 17). Do not weaken that."

**3d. The fifth token pin (line ~194).** The shape-rule bullet in section 9 pins the old token and the single-shape description; update it to match the shipped rule and the new reason:

> - The fix is a **Darwin-only shape rule**: a candidate whose name contains a dot,
>   or contains no dash, is not counted, and the count is always announced
>   (`excluded: N shape-mismatched dir(s) …`) so the exclusion is never silent.
>   It is a shape, not a name list — deliberately **not** `com.apple.*`, which
>   would need widening every time a daemon appears. It rests on an invariant
>   that is now **pinned by a test** (`.test.sh` cases 18c and 18c(2)): no
>   Archimedes minter prefix contains a dot, and none is dash-free. If someone
>   mints a dotted or dash-free prefix, a test reddens instead of the leak
>   becoming invisible.

**3e. Do NOT restate the §9a premise.** No new text claiming a repro, no new "what mints it" guess, no new line numbers.

### 4. TDD order and reds — every RED has an observable closing edit

| Step | Red (what actually breaks) | Green (the observable edit that closes it) |
|---|---|---|
| (a) seed new cases: 18c re-expressed (verbatim semantics), 18c(2) twin, 18d, 19 — no script change yet | **18d** reds: it expects `shape-mismatched` + the exclusion, neither exists yet (exit 1, `dotted-name` in output). 18c/18c(2)/19 run `ok` immediately (the tree is dash-full; the teeth check trips on the synthetic literal). | — |
| (b) token + reason: printf → `shape-mismatched`, reason → `…dot or a dash (#96)` | the FIVE pins red: 18, 18b, `--self-test` Case 14 (both halves), doc line 194 (out of sync). 18d still red. | — |
| (c) pin edits: update all five sites to `shape-mismatched` (counts UNCHANGED: 2/2/1/1) | — | 18, 18b, Case 14 green again (token matches). 18d still red (no exclusion yet). |
| (d) shape + OR: `dash_free_name` as `[[ "$1" != *-* ]]`, OR'd in the loop, comment + line-42 header updated | if the predicate is mis-spelled as a glob class (see *Field checks* 2), 18b and Case 14's dot-free half go red; if it never fires, 18d stays red | **18d green** — the whole gate is green for the first time |
| (e) §9a doc corrections + doc pin wording (3a–3d) | none (doc-only; the pin wording is already consistent after (c)) | doc consistent |
| (f) final validation | — | full gate (Step 6) |

Every red above is closed by a later observable edit within the same three-file commit; the final gate (Step 6) is reachable, and the fixture COUNT assertions (2/2/1/1) do not change anywhere (the dash-free shape adds no excluded dir to 18, 18b, or Case 14 — their plants are all dash-full).

## Field checks (run these first, before the code; they decide the shape, not the plan's prose)

1. **If the seed-step change uses any glob-class spelling of the dash-free predicate, prove case 18b breaks before merging.** Expected measurement: the negated-glob test `[[ "planted-darwin-leak-1a2b3c4d" != *-* ]]` → false (the name contains dashes), so 18b's planted name is NOT excluded; a character-class spelling (`*[!-]*`) is a tautology that would match it and red 18b. The functional form `[[ "$name" != *-* ]]` is the only spelling that keeps 18b green — the regression net catches any other.
2. **After Step (d), if case 18b's planted name is no longer reported (exit 1 with the name in output), the dash-free predicate is a glob class, not the `!= *-*` test.** Fix is to use the negated-glob form from 1a — do NOT widen 18b to accommodate the wrong predicate.
3. **The OR's exclusion counts.** 18 plant 2 dotted dirs → `excluded: 2`; 18b adds the dash-full planted name → still `excluded: 2`; 18d plants 1 dash-free dir → `excluded: 1`; Case 14's dotted half → `excluded: 1`. If any count assertion reds after (d), the loop's `else` arm has a player wrong. These are the counts the Step-(c) pin edits must NOT change.
4. **Verify the 77-prefix grep outputs `crashsel-`** (the exactly-eight-chars-then-dash counter-example to `????????-*`) and does NOT output `boundary-` (attribution-table-only, multi-line call): the query is in *Shape proof*. It exists only to prove WHY the dash-free shape, not `????????-*`, is the plan — it is not merged anywhere.
5. **Injected-dash-free-prefix proof (blocker 1, final form):** on this machine, against a throwaway synthetic tree containing a dash-free literal, the pipe-safe form must trip FAIL. Reproduced here verbatim (run 2026-11-01, `60470d2`):

```
$ bash -c 'set -euo pipefail
> if [[ -n "$( { printf "betaenrollmentagent\nbetaenrollmentagent2\n"; for i in $(seq 1 150000); do printf "db-sort-%06d-\n" "$i"; done; } | sed -E "s/^[^\"]*\"//; s/\"$//" | sort -u | grep -v -- "-" )" ]]; then echo "RED: FAIL branch tripped"; else echo "FALSE GREEN"; fi'
RED: FAIL branch tripped
```

   and the broken form (identical corpus, `| grep -q .` at the tail) returned the reviewer's false green on the large/coupled corpus: **5/5 trials FALSE GREEN on a >64KB genuinely-dash-free corpus** (mechanism: `grep -q .` exits 0 on the first dash-free line; the still-writing upstream `sort -u` dies on SIGPIPE 141; pipefail folds that into the pipeline status; the `if` takes the `else`). The fixed form went RED on the same corpus every trial. The verdict from THIS form is what case 19 pins permanently.

## Constraints and honest limits (re-stated from the task, as settled)

1. **Tolerance table NOT widened** — `harness-subagent-	1` is the only row, before AND after. The fix is shape, not row.
2. **Shape narrower than "any dot-free name"** — 18b keeps its exit-1 assertion with its planted dot-free, dash-FULL name; 18c(2) adds the tree-side guarantee; the distinct-prefix set (91, all dash-terminal, from the 119→93→91 chain) is the proof vehicle.
3. **Re-pinned invariant** — 18c keeps its no-dot semantics (re-expressed pipe-safe); the file gains the no-dash twin 18c(2), the positive case 18d, and the teeth case 19. The dash-free shape's growth surface is the predicate itself, and the cases verify both sides.
4. **Prohibitions** — no commit, no git state change, no build, no edit outside the 3-file owned set, and **no change to ci.yml** (the snapshot layout is already correct; the verify step's `ARCHIMEDES_TEST_CENSUS_BASE` handoff and the `if:` guard are untouched). The ONLY deliberate doc-side coupling is the message-token rename to `shape-mismatched` (five pins, all edited in the same commit as everything else).
5. **macOS NOT verifiable here** — the Darwin half is exercised ONLY via `ARCHIMEDES_CENSUS_UNAME_S` injection; acceptance is local proof (the self-test) plus the CI legs. This plan claims nothing about real macOS behaviour.

## Unverified (recorded honestly, no claim of proof)

- **The 3→5 exclusion-count movement and the run/job ids `41188776833` / `124501049035`** — issue #139-provided; neither the ids nor `excluded: 5` appear anywhere in this tree (`git grep` for all three → zero hits, verified during planning). §9a's rewritten second-occurrence record attributes them explicitly as issue-reported and NOT measured here (major 6).
- **The CI run/repro itself** — the first-run pair (`40875258489` / `123452317398`) is the doc's settled citation; the PR #140 macOS red is reproducible only as far as `docs/research/windows-child-console-window.md` states it; neither machine has macOS or GitHub log access.
- **The 27 ms snapshot→test window** — the ci.yml LAYOUT is verifiable (snapshot directly above `cargo test`); its timing is not, from any machine. §9a's corrected text says only what the layout proves.
- **The line-oriented invariant greps' blind spot** — both 18c and 18c(2) match only SINGLE-LINE call forms; a multi-line `in_env_temp(` (as `boundary.rs:251-253` already does) is invisible to them. This is the STATUS QUO (existing 18c cannot see `boundary-` either) — the plan's safety claim does not rest on the grep alone: the structural `{prefix}{tag}-{uuid}` naming contract (minor 7) is the reason, the grep is the pin.
- **Line numbers** — valid at `60470d2` only; all anchors are by case id and landmark text; the *Coupling map* lines are given as of `60470d2` for the implementer's first read, not as lasting anchors.
- **The shape's exact-machine behaviour** — `[[ "$1" != *-* ]]` under bash 3.2 (the macOS runner's `/bin/bash`) has not been run here; the negated-glob form is the POSIX-portable one, but the self-test's `--self-test` Case 14 exercises the Darwin path only via injection, which is the whole honest limit of this task.

## Parallelisation

**Verdict:** SERIAL — this plan is exactly one commitable unit (three files, one commit), so at task grain it contains no wave: ordered work is carried by the `Steps:` checkboxes, not by sibling tasks, and no parallel line is emitted. The six gates are nonetheless settled at this grain: this task owns `scripts/check-temp-dir-census.sh` + `scripts/check-temp-dir-census.test.sh` + `docs/features/issue-96-temp-dir-known-gaps.md` and nothing else; its sibling A2 owns `src-tauri/tests/worker_e2e.rs` (gate 1 disjoint), no symbol crosses the two (gate 2), no shared mutable artifact is touched by either (gate 3 — the field plan writes only inside `scripts/` and `docs/features/`, and the gate commands touch no lockfile; the census gate it exercises runs inside `scripts/` on this box), each is provable from the base alone (gate 4), neither mutates the whole tree (gate 5), wave width 2 ≤ 4 (gate 6). Wave-level parallelism (A1 ∥ A2 in per-task worktrees) is the orchestrator's call and is recorded in `docs/roadmap/macos-ci-flakes-status.md`.

**Steps:**

- [ ] **Seed the new cases without fixing the script** — in `scripts/check-temp-dir-census.test.sh`, re-express 18c in the pipe-safe form (exact text in §2a) and add 18c(2) (no-dash twin), 18d (dash-free Darwin case), and 19 (teeth test) exactly as quoted in §2, keeping 18c's semantics and messages byte-identical. Run `bash scripts/check-temp-dir-census.test.sh` — expect 18c, 18c(2), and 19 to report `ok` (the tree is already dash-full and the teeth check trips on its synthetic literal), **18d to report FAIL on each of its six assertions** (it expects the `shape-mismatched` token and an exclusion that do not exist yet — this is the TDD red that Step 4 closes), and the harness to end with `6 check(s) failed`. Do not proceed until 18d's assertions are the ONLY reds.
- [ ] **Change only the announcement token** — in `scripts/check-temp-dir-census.sh`'s `excluded_note` printf, rename `dotted-name dir(s)` → `shape-mismatched dir(s)` and the reason to `no Archimedes minter name contains a dot or a dash (#96)` (keep the rest of the sentence). Run both gate commands — expect the FIVE pins to red: cases 18 and 18b (`.test.sh`) and `--self-test` Case 14 (both halves) on `excluded: N dotted-name dir(s)`, plus the doc pin (not runnable, verified by inspection / `git grep 'dotted-name dir(s)'`). 18d still red. This red is the coupling map, and it proves the pre-existing assertions were carrying the token.
- [ ] **Update the five token pins** — in the same files: cases 18 and 18b (`.test.sh`), `--self-test` Case 14's two halves (`check-temp-dir-census.sh`), and the doc's shape-rule bullet (line ~194, wording from §3d). Counts stay EXACTLY 2/2/1/1 — the dash-free shape excludes nothing additional in those fixtures. Run both gate commands — expect 18/18b/Case 14 green again and **18d still red on all six assertions** (now only the shape itself is missing). Expected after this step: `6 check(s) failed`, all of them 18d.
- [ ] **Implement the two-shape exclusion** — add `dash_free_name()` next to `dotted_name()` as `[[ "$1" != *-* ]]` (with the rationale comment quoted in §1a), change the split loop to `if dotted_name "$cand" || dash_free_name "$cand"; then excluded+=("$cand"); else counted+=…; fi`, and update the header's "One filter DOES exist" comment (line ~42) and the exclusion-comment above the loop to describe both shapes. Run both gate commands — expect **18d GREEN for the first time** (exit 0, `excluded: 1 shape-mismatched dir(s)`, clean message, reason), everything else still green, `--self-test` final line `self-test: all cases behaved (the guard has teeth)`. If 18b's planted name is no longer reported, see *Field checks* item 2 (the predicate was mis-spelled as a glob class).
- [ ] **Correct the doc (§9a both items, owner/Darwin-only sentence, second occurrence with the honest 3→5 attribution, doc pin wording)** — in `docs/features/issue-96-temp-dir-known-gaps.md`: record option (b) as already implemented with the "only live option" sentence (§3a); record the SECOND `betaenrollmentagent` occurrence from the PR #140 writeup with the 3→5 movement attributed explicitly as issue-reported, NOT verified here (§3b — do NOT print `41188776833`/`124501049035` or `excluded: 5` as measured facts; they are issue-provided only and appear nowhere in the tree); replace "Needs an owner…" with the task-owner sentence and add the one-sentence Darwin-only caveat (§3c); apply the §3d wording to the line-~194 shape-rule bullet (this is pin #5, already token-consistent after Step 3). Do NOT touch any other section, do NOT re-derive the issue's claims.
- [ ] **Final validation (the full gate for this task)** — from the repo root, in order:
  `bash -n scripts/check-temp-dir-census.sh scripts/check-temp-dir-census.test.sh`, then
  `bash scripts/check-temp-dir-census.test.sh` → final lines `ok   no minter prefix contains a dot (…)`, `ok   no minter prefix is dash-free (…)`, `ok   the dash-free check has teeth: an injected dash-free literal trips FAIL (case 19)`, and `all checks passed` with **zero FAIL lines**;
  then `bash scripts/check-temp-dir-census.sh --self-test` → final line `self-test: all cases behaved (the guard has teeth)`. Also re-run the two invariant greps from §2a → both empty (the no-dash and no-dot invariants hold at the tree), and confirm `grep -rn 'dotted-name'` over the owned set returns exactly the case-18c FAIL/ok message lines (which keep the invariant's NAME "contains a dot" — those are not the token) plus the §9a historical quote (the issue's recorded line, quoted for provenance, not edited) — every other hit must be gone.
  Commit, message: `test(scripts): second Darwin exclusion shape — dash-free names (issue #139)`. Wave 1 executes A1 in its own worktree on branch `feature/macos-ci-flakes-task01` — commit there, never on the feature branch or `main`; if the orchestrator fans the files in itself, keep this message verbatim for it.

**Acceptance criteria:**

- [ ] **C1 — Darwin exclusion now two-shape, and C1 is actually proven.** Case 18d plants `betaenrollmentagent` (dot-free AND dash-free) and asserts `verify` exits 0, the clean message is present, the exclusion is announced with exactly the excluded set's count (`excluded: 1 shape-mismatched dir(s)`), and the name is not listed as a failure. Case 18b and the `--self-test` Case-14 dot-free half still exit 1 and name their dash-full planted leaks. The announcement reads `shape-mismatched`.
- [ ] **C2 — invariant re-pinned, both sides, teeth proven.** 18c's no-dot check keeps its semantics and messages (re-expressed pipe-safe) and is green; the no-dash twin 18c(2) is green against the 91 distinct prefixes (all dash-containing); case 19 proves an injected dash-free literal trips FAIL (the guard has teeth).
- [ ] **C3 — §9a corrected, both items, measured numbers only.** Option (b) is recorded as already implemented with (a) the only live option; the second occurrence is recorded from the PR #140 writeup with the 3→5 movement explicitly attributed to issue #139 and NOT verified here (no run ids, no `excluded: 5` laundered into a measured claim); "Needs an owner" and the conditional framing are gone; the Darwin-only caveat sentence is present.
- [ ] **C4 — constraints honoured.** The tolerance table still has exactly one row (`harness-subagent-	1`); the exclusion stays Darwin-only (case 17 still asserts a dotted dir on Linux is a leak); `dash_free_name` is the negated-glob test `[[ "$1" != *-* ]]` (NOT a glob class); all five token pins carry `shape-mismatched` with unchanged counts (2/2/1/1, doc `N`); no `| grep -q .` appears anywhere in the two scripts' new or changed checks; no file outside the owned set is touched; ci.yml is byte-identical to `60470d2`.
- [ ] **C5 — honest proof boundary.** Local green is the self-test's "all checks passed" plus the CI-leg runs of `bash scripts/check-temp-dir-census.test.sh` and `bash scripts/check-temp-dir-census.sh --self-test`; the 3→5 movement and the run ids are recorded as issue-provided, not local measurements; nothing in this task claims local verification of Darwin behaviour.

## References

- `docs/roadmap/macos-ci-flakes-ground-temp-dir-census.md` (the sole grounding source; do not restate it)
- `scripts/check-temp-dir-census.sh` (owned)
- `scripts/check-temp-dir-census.test.sh` (owned)
- `docs/features/issue-96-temp-dir-known-gaps.md` (owned — §9a and the line-~194 shape-rule bullet are the two doc edit surfaces)
- `src-tauri/src/test_support.rs` (consult only — the `{prefix}{tag}-{uuid}` naming contract at lines 207 and 533, cited in the safety argument)
- `docs/research/windows-child-console-window.md` (consult only — the PR #140 second-occurrence writeup, the one in-tree source §9a's second record may cite)
- `.github/workflows/ci.yml` (consult only — the snapshot step name and its placement above `cargo test`, the `scripts` job's double census invocation; read, never edited)