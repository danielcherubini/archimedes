#!/usr/bin/env bash
#
# Every command in `src-tauri/src/lib.rs`'s `generate_handler!` block is a promise
# that the webview (or a Rust IPC test) can call it. Nothing in the build checks
# the other half of that promise — that SOMEBODY does call it. Two dead commands
# shipped anyway (Finding 8: `list_agent_definitions`, and the `partialArgs`
# emit arm that no reader ever read), which is the shape this guard exists to
# refuse: an IPC surface that rots because deletion is invisible from inside the
# crate that owns it.
#
# A guard that passes vacuously is the decoration this family exists to prevent.
#
# So the guard has three teeth, and each one is a hard `exit 1`:
#   1. BOTH `comm` directions. Registered-but-unconsumed fails (unless the name
#      is on the allowlist WITH a cited reason — an entry without a reason is
#      itself a refusal); consumed-but-unregistered fails, naming the wrapper's
#      file:line, because that call errors at runtime.
#   2. A VACUITY FLOOR. The registered list is a LIVE re-extraction of the
#      `generate_handler!` block (not a frozen constant — a legitimate 47th
#      command must never require a coordinated edit here) and the consumed list
#      is a live walk of `src/`. Live extraction is only honest if a walk that
#      matched NOTHING is impossible to mistake for green, so the floor asserts
#      the walk saw roughly what the tree holds. It is a BLIND-WALK tripwire and
#      NOT a count pin: adding or removing commands never reddens it; an
#      extraction that reads no file does.
#   3. A LOAD-BEARING NEGATIVE. The consumed set is built from LITERAL
#      `invoke("name")` call sites. If any `invoke(` call passes its command name
#      through a variable, this walk is structurally blind to it and would report
#      green while a real command looked dead — so a non-literal first argument
#      is a refusal, not a gap.
#
# Comment stripping is not decoration either: the repo measured the trap
# (`tauriBoundary.test.ts:24`'s doc-comment types `invoke("delete_session", …)` as
# prose, and `:105` documents the same class of trap) — an unstripped walk counts
# that mention as a consumer and reports 46 occurrences against 45 real call
# sites. A name that appears only in a comment is PROSE, so the walk strips
# comments first, mirroring the `stripJsComments` idiom the TS guards use
# (`src/components/chromeButton.test.ts:59`, `mutedCaption.test.ts:47`): block
# comments and whole-line `//` only, line numbers preserved.
#
# Usage: check-commands.sh [repo-root] [--self-test]   (root default: .)
#   repo-root    the checkout to read (its `src-tauri/src/lib.rs` and `src/`)
#   --self-test  plant fixtures under a throwaway root and prove THIS guard —
#                re-invoked, never a second implementation — can still fail

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [repo-root] [--self-test]" >&2
}

# The VACUITY FLOOR (teeth 2). These are what the walk measures on this tree
# TODAY — 46 registered commands, 45 distinct consumed names across 45 invoke
# occurrences, 373 `.ts`/`.tsx` files under `src/` — rounded DOWN to the point
# where the only thing that can trip them is a walk that read nothing. They are
# deliberately NOT the current counts: a legitimate registration added next
# month passes untouched, and a `sed` window that matched no block, a `find` with
# a dead pattern, or a stripping step that swallowed the whole tree all fail.
FLOOR_REGISTERED=45
FLOOR_CONSUMED_DISTINCT=45
FLOOR_CONSUMED_OCCURRENCES=45
FLOOR_FILES=100

# The allowlist — registered-but-unconsumed names that are PROVEN consumed
# somewhere the TS walk cannot see. Every entry is `name|reason` and an entry
# whose reason is empty is a refusal: an unexplained exemption is how a dead
# command hides. Entries must also name a REAL registered command (checked at
# run time) so a typo cannot park a name here forever.
#
# Format: exactly one `|`, reason on the right, no other `|` in the reason.
allowlist_entries=(
  'get_stalled_info|ADR 0025 pull-half amendment (docs/decisions/0025-*.md:44 — "the pushed event and the pulled stalled_info can no longer name different files for one crash") + live consumer src-tauri/tests/ipc.rs:518-528 (invoke_ok literal at ipc.rs:520, registered by that test harness at ipc.rs:166). Kept by decision: this is the pull half of ADR 0025, not an orphan.'
)

# --- extraction ---------------------------------------------------------------

# The registered command NAMES, one per line, from the `generate_handler!` block.
# The window is the block's own delimiters (the macro open, then the closing `])`
# at the builder-call indent) so the extraction reads the block and nothing else;
# a mobile-port handler split would show up here as a floor failure, which is the
# point (risk 6 in the plan: the window must be widened on purpose, never by
# accident).
extract_registered() {
  local root="$1"
  local lib="$root/src-tauri/src/lib.rs"
  if [[ ! -f "$lib" ]]; then
    printf 'error: no lib.rs to extract the handler block from: %s\n' "$lib" >&2
    return 1
  fi
  # The grep's exit status is NOT a verdict here (a zero-match grep under
  # `set -o pipefail` would kill the walk with an inverse-to-intent failure);
  # an extraction that found nothing must reach the VACUITY FLOOR, which is what
  # decides — loudly — that a blind walk happened.
  local block
  block="$(sed -n '/invoke_handler(tauri::generate_handler!\[/,/^        \])/p' "$lib")"
  if [[ -z "$block" ]]; then
    printf 'error: no generate_handler! block found in %s (the extraction window no longer matches the source)\n' "$lib" >&2
    return 1
  fi
  printf '%s\n' "$block" | grep -E '^[[:space:]]*commands::' |
    sed 's/^[[:space:]]*commands:://; s/[[:space:]]*,[[:space:]]*$//' |
    awk -F'::' '{print $NF}' |
    sort || true
}

# The comment-stripping filter (the `stripJsComments` idiom, line-preserving).
# Block comments are removed wherever they sit; a `//` run is removed only when it
# STARTS the line, because that is the exact idiom the TS guards use — stripping
# trailing `//` too would eat the `//` inside a string (`"https://…"`), which is
# the trade that idiom records. RESIDUAL LIMITATION, stated rather than hidden: a
# call-shaped mention written at the END of a live line (`foo(); // invoke("x")`)
# would still count as a consumer, i.e. it could keep a dead command looking alive.
# It cannot produce a FALSE red (the failure direction that would block an
# innocent PR), and the reverse direction plus the blind-spot check are unaffected.
# Newlines inside a removed block comment are kept so the line numbers the failure
# messages print are the ones in the editor.
strip_comments_awk() {
  cat <<'AWK'
BEGIN { inblock = 0 }
{
  line = $0
  out = ""
  i = 1
  n = length(line)
  while (i <= n) {
    if (inblock) {
      if (substr(line, i, 2) == "*/") { inblock = 0; i += 2 }
      else { i += 1 }
      continue
    }
    if (substr(line, i, 2) == "/*") { inblock = 1; i += 2; continue }
    if (substr(line, i, 2) == "//" && substr(line, 1, i - 1) ~ /^[ \t]*$/) { break }
    out = out substr(line, i, 1)
    i += 1
  }
  print out
}
AWK
}

# The stripping program, computed ONCE at load. It used to be a `local` inside
# one walk function and referenced from another — under `set -u` that is an
# "unbound variable" failure inside a subshell, which fires the EXIT trap and
# (in the first draft) deleted the walk's own temp files mid-run while still
# printing `ok`. A shared program is a global or nothing.
STRIP_PROGRAM="$(strip_comments_awk)"

# The non-literal-call detector, as an awk program (whole file in one record).
# WHY NOT `grep -P` ON A LINE: the command name may legally sit on the line AFTER
# `invoke(`, so the check must read across newlines — and the obvious way to do
# that (`tr '\n' ' '` then grep with `\(\s*(?!")`) is WRONG, because the regex
# engine backtracks its own `\s*` and re-matches the whitespace it was told to
# skip, so every multi-line literal call would be reported as a blind spot.
#
# WHY NO REGEX FOR THE IDENTIFIER EITHER: `(^|[^A-Za-z0-9_-])invoke` anchors inside
# a group, which POSIX leaves implementation-defined. Instead the program finds
# every `invoke` token and inspects the characters around it, which is exact:
#   - a preceding `[A-Za-z0-9_-]` means this is a LONGER identifier — prose like
#     `double-invoke (` (measured: src/store/sessions.test.ts:4314,
#     src/hooks/useAttentionAlert.test.ts:228, inside test-name STRINGS, so comment
#     stripping cannot remove them) is not a call. A preceding `.` IS accepted: a
#     `something.invoke(name)` wrapper is precisely the blind spot being hunted.
#     (A camelCase sibling like `mockedInvoke` cannot match anyway — the token is
#     case-sensitive, and `Invoke` ≠ `invoke`.)
#   - after the token, whitespace and an optional `<…>` generic are skipped (the
#     19 measured `invoke<T>("…")` sites); no `(` after that means it was a bare
#     mention (`import { invoke }`, `vi.mocked(invoke)`, `invoke: vi.fn()`) — not a call.
#   - at the `(`, the first NON-WHITESPACE character is the first argument. `"` is
#     a literal; a backtick is a template literal (tolerated per the plan);
#     anything else is a runtime-computed name this walk cannot see, and is
#     reported with the line the call opens on.
blind_invoke_program() {
  cat <<'AWK'
# Accumulate the (already comment-stripped) file, then scan the whole text at
# once in END. No `RS = "\0"` trickery: that is GNU-specific and these scripts
# run on developer macOS boxes too.
{ text = text $0 "\n" }
END {
  L = length(text)
  pos = 1
  while (pos <= L) {
    tail = substr(text, pos)
    if (!match(tail, /invoke/)) {
      break
    }
    abs = pos + RSTART - 1
    prev = ""
    if (abs > 1) {
      prev = substr(text, abs - 1, 1)
    }
    if (prev ~ /[A-Za-z0-9_-]/) {
      # part of a longer identifier (`double-invoke`, `mockedInvoke`, …)
      pos = abs + 6
      continue
    }
    j = abs + 6
    while (j <= L && substr(text, j, 1) ~ /[ \t\n\r]/) { j++ }
    if (substr(text, j, 1) == "<") {
      j++
      while (j <= L && substr(text, j, 1) != ">") { j++ }
      if (j > L) {
        break
      }
      j++
      while (j <= L && substr(text, j, 1) ~ /[ \t\n\r]/) { j++ }
    }
    if (substr(text, j, 1) != "(") {
      # a bare mention of the identifier, not a call site
      pos = abs + 6
      continue
    }
    j++
    while (j <= L && substr(text, j, 1) ~ /[ \t\n\r]/) { j++ }
    c = substr(text, j, 1)
    if (c != "\"" && c != "`") {
      line = 1
      for (k = 1; k < abs; k++) {
        if (substr(text, k, 1) == "\n") {
          line++
        }
      }
      snippet = substr(text, abs, 120)
      gsub(/\n/, " ", snippet)
      printf "%s\t%s\n", line, snippet
    }
    pos = j
  }
}
AWK
}

BLIND_INVOKE_PROGRAM="$(blind_invoke_program)"

# The LITERAL invoke-name extractor, as an awk program. It walks the SAME token
# shape as the detector above (identifier boundary, optional `<…>` generic, `(`,
# first non-whitespace character) and keeps the calls whose first argument opens
# with `"` — reading the name to its closing quote.
#
# WHY NOT A LINE-BASED `grep -o`: a call written as
#     invoke(
#       "get_stalled_info",
#     )
# is perfectly legal TypeScript and a line-based pattern never sees the name. The
# consequence of missing one is a FALSE "registered command with no consumer" red
# aimed at an innocent command, so the extractor reads across newlines exactly
# like the detector does. (Measured today: zero multi-line calls in `src/` — the
# 45 occurrences are all single-line — so this is soundness for the next edit, not
# a workaround for a present one.)
invoke_literal_program() {
  cat <<'AWK'
{ text = text $0 "\n" }
END {
  L = length(text)
  pos = 1
  while (pos <= L) {
    tail = substr(text, pos)
    if (!match(tail, /invoke/)) {
      break
    }
    abs = pos + RSTART - 1
    prev = ""
    if (abs > 1) {
      prev = substr(text, abs - 1, 1)
    }
    if (prev ~ /[A-Za-z0-9_-]/) {
      pos = abs + 6
      continue
    }
    j = abs + 6
    while (j <= L && substr(text, j, 1) ~ /[ \t\n\r]/) { j++ }
    if (substr(text, j, 1) == "<") {
      j++
      while (j <= L && substr(text, j, 1) != ">") { j++ }
      if (j > L) {
        break
      }
      j++
      while (j <= L && substr(text, j, 1) ~ /[ \t\n\r]/) { j++ }
    }
    if (substr(text, j, 1) != "(") {
      pos = abs + 6
      continue
    }
    j++
    while (j <= L && substr(text, j, 1) ~ /[ \t\n\r]/) { j++ }
    if (substr(text, j, 1) == "\"") {
      start = j + 1
      k = start
      while (k <= L && substr(text, k, 1) != "\"") {
        if (substr(text, k, 1) == "\\") {
          k++
        }
        k++
      }
      name = substr(text, start, k - start)
      if (name ~ /^[a-z][a-z0-9_]*$/) {
        line = 1
        for (m = 1; m < abs; m++) {
          if (substr(text, m, 1) == "\n") {
            line++
          }
        }
        printf "%s\t%s\n", line, name
      }
      pos = k + 1
      continue
    }
    pos = j
  }
}
AWK
}

INVOKE_LITERAL_PROGRAM="$(invoke_literal_program)"

# Every LITERAL invoke consumer in the TS tree, as `file<TAB>line<TAB>name`.
# Tests are INCLUDED on purpose: a test that pins a wire name as a literal is
# evidence the wrapper exists (the `tauriBoundary.test.ts` reason).
walk_ts_consumers() {
  local root="$1"
  local src="$root/src"
  local f hits hit lineno name
  while IFS= read -r -d '' f; do
    # The verdict comes from OUTPUT, never from a tool's exit status (under
    # `set -e` a no-match exit 1 is an inverse-to-intent step failure — the
    # lesson the census tests recorded).
    hits="$(awk "$STRIP_PROGRAM" "$f" | awk "$INVOKE_LITERAL_PROGRAM")"
    if [[ -z "$hits" ]]; then
      continue
    fi
    while IFS= read -r hit; do
      lineno="${hit%%$'\t'*}"
      name="${hit#*$'\t'}"
      printf '%s\t%s\t%s\n' "${f#"$root"/}" "$lineno" "$name"
    done <<<"$hits"
  done < <(find "$src" \( -name '*.ts' -o -name '*.tsx' \) -print0 | sort -z)
}

# The command names a Rust IPC test invokes (`invoke_ok` / `invoke_raw` first
# argument). The call is written across lines, so the scan joins each call to its
# first string literal. This is the consumer-evidence arm that makes a
# Rust-test-only command visible to the guard at all.
walk_rust_test_consumers() {
  local root="$1"
  local tests="$root/src-tauri/tests"
  if [[ ! -d "$tests" ]]; then
    return 0
  fi
  awk '
    # The helper DEFINITIONS (`async fn invoke_raw(`) are not call sites: skip
    # them so their bodies cannot donate a string literal to the consumer set.
    /^[ \t]*(pub[ \t]+)?(async[ \t]+)?fn[ \t]+invoke/ { next }
    /invoke(_ok|_raw)?\(/ { pending = 1; buf = "" }
    pending {
      buf = buf " " $0
      # The command name is the FIRST string literal after the call opens. A
      # `json!` seen first means the name is not a literal at all (a dynamic
      # Rust-side call) — drop it rather than grab a payload key as a name.
      if (match(buf, /"[a-z][a-z0-9_]*"/)) {
        name = substr(buf, RSTART + 1, RLENGTH - 2)
        if (name != "") { print name }
        pending = 0; buf = ""
      } else if (buf ~ /json!/) {
        pending = 0; buf = ""
      }
    }
  ' "$tests"/*.rs 2>/dev/null | sort -u || true
}

# --- the guard ----------------------------------------------------------------

fail() {
  printf 'error: %s\n' "$1" >&2
  if [[ $# -gt 1 ]]; then
    shift
    local line
    for line in "$@"; do
      printf '       %s\n' "$line" >&2
    done
  fi
  exit 1
}

run_guard() {
  local root="$1"

  local lib="$root/src-tauri/src/lib.rs"
  if [[ ! -f "$lib" ]]; then
    fail "no lib.rs at $lib (run this from the repo root, or pass the repo root)"
  fi
  if [[ ! -d "$root/src" ]]; then
    fail "no TypeScript source directory at $root/src"
  fi

  # --- extract both sides, then count what the walk actually saw ---------------
  # NOTE on `set -e`: a `local x="$(cmd)"` masks `cmd`'s exit status (the
  # declaration's own status is what the shell tests), and this script's contract
  # is that a failed derivation REDS rather than feeds an empty value into a
  # comparison. Every derivation is therefore declared first and assigned on its
  # own line, so an unexpected failure aborts here.
  # ONE temp dir, ONE EXIT trap. Re-arming the trap for every derived file was
  # the first draft's bug: a `set -u` failure inside any subshell runs the EXIT
  # trap, and a trap re-armed mid-run deletes files the rest of the run still
  # reads — a guard that reads a vanished file reports a blind walk (or, worse,
  # green) for reasons that have nothing to do with the tree.
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp_dir'" EXIT

  local registered_file consumed_file rusttest_file
  registered_file="$tmp_dir/registered"
  consumed_file="$tmp_dir/consumed"
  rusttest_file="$tmp_dir/rusttest"

  extract_registered "$root" >"$registered_file"
  walk_ts_consumers "$root" >"$consumed_file"
  walk_rust_test_consumers "$root" >"$rusttest_file"

  local file_count
  file_count="$(find "$root/src" \( -name '*.ts' -o -name '*.tsx' \) | wc -l | tr -d ' ')"

  # --- teeth 2: the VACUITY FLOOR (a blind walk must never look like green) ----
  # `wc -l <file` (stdin, not a path argument): a path argument makes coreutils
  # print the count PADDED to width 8, and `(( "      46" < 45 ))` is an arithmetic
  # syntax error — a floor that crashes instead of comparing is its own kind of
  # vacuous guard.
  local n_registered n_occurrences n_distinct
  n_registered="$(wc -l <"$registered_file" | tr -d ' ')"
  n_occurrences="$(wc -l <"$consumed_file" | tr -d ' ')"
  n_distinct="$(cut -f3 "$consumed_file" | sort -u | wc -l | tr -d ' ')"

  if ((n_registered < FLOOR_REGISTERED)); then
    fail "the handler-block extraction is BLIND: $n_registered registered command(s) extracted from $lib, floor is $FLOOR_REGISTERED. The walk read no block (a sed window that matched nothing reports zero, and zero looks like green)." "check the extraction window against the generate_handler! block in $lib"
  fi
  if ((n_distinct < FLOOR_CONSUMED_DISTINCT)); then
    fail "the invoke walk is BLIND: $n_distinct distinct consumed command name(s) in $root/src, floor is $FLOOR_CONSUMED_DISTINCT" "check the find pattern, the comment stripping, and the invoke literal pattern"
  fi
  if ((n_occurrences < FLOOR_CONSUMED_OCCURRENCES)); then
    fail "the invoke walk is BLIND: $n_occurrences invoke literal(s) in $root/src, floor is $FLOOR_CONSUMED_OCCURRENCES"
  fi
  if ((file_count < FLOOR_FILES)); then
    fail "the invoke walk visited almost no files: $file_count .ts/.tsx file(s) under $root/src, floor is $FLOOR_FILES" "a walk that visits nothing is the decoration this guard exists to prevent"
  fi

  # The allowlist must be about REAL commands: every allowlisted name must appear
  # in the EXTRACTED registered list (the census family's "a named reader must be
  # found by name" rule). Without this, `get_stalled_info` could be misspelled
  # here and the guard would keep waving through whatever the typo named.
  #
  # The `get_stalled_info` assertion is ALSO stated on its own, independent of the
  # allowlist's contents: it is the plan's "the walk read the file it claims to
  # care about" probe, and it must survive someone editing the allowlist entry
  # (if the name is gone from the block, the guard has stopped reading the block
  # it is supposed to read, and that is a red whatever the exemption list says).
  if ! grep -qxF 'get_stalled_info' "$registered_file"; then
    fail "the extracted handler-block list does not contain get_stalled_info" "either the extraction window no longer covers the whole generate_handler! block, or ADR 0025's pull-half command was deleted — and it is kept by decision, so both are reds"
  fi

  local entry name reason
  for entry in "${allowlist_entries[@]}"; do
    name="${entry%%|*}"
    reason="${entry#*|}"
    if [[ "$name" == "$entry" || -z "${reason//[[:space:]]/}" ]]; then
      fail "an allowlist entry must be 'name|reason' with a non-empty reason (an unexplained exemption is how a dead command hides): $entry"
    fi
    if ! grep -qxF "$name" "$registered_file"; then
      fail "allowlist entry names no registered command: $name" "the extracted generate_handler! block does not contain it, so this exemption excuses nothing and only hides a typo"
    fi
  done

  # --- teeth 3: the load-bearing negative (no non-literal invoke first argument)
  # A dynamic command name is invisible to a literal walk, and the guard would
  # then report a REAL command as dead (or a dead one as live) with total
  # confidence. Refuse instead.
  local blind_hits blind_file blind_line blind_snippet
  blind_hits="$tmp_dir/blind_hits"
  : >"$blind_hits"
  local f
  while IFS= read -r -d '' f; do
    # Strip comments first (a commented-out `invoke(variable)` is not a call),
    # then run the detector. The verdict is read from OUTPUT, never from the
    # program's exit status.
    local hits
    hits="$(awk "$STRIP_PROGRAM" "$f" | awk "$BLIND_INVOKE_PROGRAM")"
    if [[ -n "$hits" ]]; then
      local hit
      while IFS= read -r hit; do
        blind_line="${hit%%$'\t'*}"
        blind_snippet="${hit#*$'\t'}"
        printf '%s\t%s\t%s\n' "${f#"$root"/}" "$blind_line" "$blind_snippet" >>"$blind_hits"
      done <<<"$hits"
    fi
  done < <(find "$root/src" \( -name '*.ts' -o -name '*.tsx' \) -print0 | sort -z)

  if [[ -s "$blind_hits" ]]; then
    local lines=()
    while IFS= read -r line; do
      lines+=("$(printf '%s' "$line" | tr '\t' ':' | cut -c1-160)")
    done <"$blind_hits"
    fail "the guard is BLIND: invoke() call(s) whose command name is not a string literal — a runtime-computed name is invisible to this walk, so every verdict below would be unreliable" "${lines[@]}" "either pass a literal, or make the guard see the dynamic form (and update the allowlist with that reason)"
  fi

  # --- teeth 1a: registered but consumed by NOTHING ---------------------------
  local orphan_file
  orphan_file="$tmp_dir/orphans"
  comm -23 <(sort -u "$registered_file") <(cut -f3 "$consumed_file" | sort -u) >"$orphan_file" || true

  # A name the TS walk missed may still be consumed by a Rust IPC test — that is
  # a real consumer (tests/ipc.rs drives the app headless), so subtract the Rust
  # test evidence too before calling anything dead.
  local orphans=() line
  while IFS= read -r name; do
    if grep -qxF "$name" "$rusttest_file"; then
      continue
    fi
    if printf '%s\n' "${allowlist_entries[@]}" | grep -q "^${name}|"; then
      continue
    fi
    orphans+=("$name")
  done <"$orphan_file"

  if (( ${#orphans[@]} > 0 )); then
    fail "registered command(s) with NO consumer anywhere in src/ or src-tauri/tests/ — an IPC surface nobody calls is dead weight that rots (Finding 8 shipped exactly this)" "${orphans[@]}" "delete the command and its generate_handler! entry, or add it to allowlist_entries IN THIS FILE with a cited reason"
  fi

  # --- teeth 1b: consumed but never registered (the reverse direction) ---------
  # One `comm` in the other direction — the same walk, no extra machinery. This
  # direction has NO allowlist arm on purpose: a wrapper calling a name the
  # handler block does not register fails AT RUNTIME (Tauri answers
  # "command not found"), so there is no reason that can make it legal.
  local surprise_file surprises=()
  surprise_file="$tmp_dir/surprises"
  comm -13 <(sort -u "$registered_file") <(cut -f3 "$consumed_file" | sort -u) >"$surprise_file" || true
  local where
  while IFS= read -r name; do
    where="$(awk -F'\t' -v n="$name" '$3 == n {print $1 ":" $2; exit}' "$consumed_file")"
    surprises+=("$name (invoked at $where)")
  done <"$surprise_file"

  if (( ${#surprises[@]} > 0 )); then
    fail "invoked command(s) with NO generate_handler! entry — the call errors at runtime with 'command not found'" "${surprises[@]}" "register the command in $lib"
  fi

  printf 'ok   %s registered command(s), %s consumed name(s) across %s invoke literal(s) in %s file(s); both directions agree, %s allowlist exemption(s) cited\n' \
    "$n_registered" "$n_distinct" "$n_occurrences" "$file_count" "${#allowlist_entries[@]}"
}

# --- --self-test: the premise mode --------------------------------------------
#
# A GREEN GUARD PROVES NOTHING. This mode plants fixtures under a throwaway root
# and re-invokes THIS script against them (`self_run` below — never a second
# hand-rolled copy of the logic, which would test the copy instead of the guard),
# asserting the exit code each case needs — including the exit 1 the guard must
# produce for a planted violation, which is the whole point.
#
# The fixture root is built to PASS the vacuity floor (46 registrations, 45
# consumed names, 100 TS files) so every planted failure is provably the planted
# delta and not the fixture being too small to clear the floor. Case 0 asserts
# exactly that before any violation is planted.
self_test_failures=0
self_test_root=""
# Every path THIS `--self-test` invocation created, by exact name. The EXIT trap
# deletes these and nothing else — never a glob, never a pattern sweep.
self_test_created=()

self_mk() {
  local args=()
  if [[ "${1:-}" == "-p" ]]; then
    args+=("-p")
    shift
  fi
  local p
  for p in "$@"; do
    if (( ${#args[@]} > 0 )); then
      # `-p` creates PARENTS too, and every created path must land on the
      # cleanup list — a parent left behind is exactly the "leftover nobody
      # registered" state the discipline forbids, and it would leave the
      # self-test root un-rammable. Collect the ancestors that do not exist yet,
      # create the leaf with `-p`, then register each collected ancestor.
      local ancestors=() probe="$p"
      while true; do
        probe="$(dirname -- "$probe")"
        if [[ -e "$probe" ]]; then
          break
        fi
        ancestors+=("$probe")
      done
      mkdir -p -- "$p"
      self_test_created+=("$p")
      local a
      for a in "${ancestors[@]+"${ancestors[@]}"}"; do
        self_test_created+=("$a")
      done
    else
      mkdir -- "$p"
      self_test_created+=("$p")
    fi
  done
}

self_mkfile() {
  local p="$1"
  : >"$p"
  self_test_created+=("$p")
}

self_test_cleanup() {
  local p
  for p in "${self_test_created[@]+"${self_test_created[@]}"}"; do
    if [[ -e "$p" ]]; then
      rm -rf -- "$p"
    fi
  done
  if [[ -n "$self_test_root" && -e "$self_test_root" ]]; then
    if ! rmdir -- "$self_test_root" 2>/dev/null; then
      # NOT emptied: something lives there that this invocation did not register,
      # and deleting unregistered paths is the pattern sweep this discipline
      # forbids. A visible leftover is cheaper than a script that deletes what it
      # did not make.
      printf 'warning: the self-test root is not empty, so it was left in place (nothing unregistered is ever deleted): %s\n' "$self_test_root" >&2
    fi
  fi
  return 0
}

self_ok() { printf 'ok   %s\n' "$1"; }

self_fail() {
  printf 'FAIL %s\n' "$1" >&2
  if [[ $# -gt 1 ]]; then
    printf '       %s\n' "$2" >&2
  fi
  self_test_failures=$((self_test_failures + 1))
}

self_status=0
self_output=""
self_run() {
  local script="$1"
  shift
  self_status=0
  self_output="$("$script" "$@" 2>&1)" || self_status=$?
}

# A fixture tree big enough to clear the vacuity floor: 46 registrations
# (`cmd00`..`cmd44` plus the allowlisted `get_stalled_info`) and 100 TS files
# whose first 45 each invoke one `cmdNN` literally.
# Writes the fixture's lib.rs. The optional second argument is an EXTRA
# registration inserted INSIDE the block — appending after the block's closing
# `])` would plant a line the extraction window cannot see, and the case would
# then "pass" for the wrong reason (the first draft did exactly that, and the
# guard correctly reported green).
self_write_fixture_lib() {
  local lib="$1" extra="${2:-}"
  {
    printf '%s\n' '        .invoke_handler(tauri::generate_handler!['
    local i
    for i in $(seq -w 0 44); do
      printf '%s\n' "            commands::fixture::cmd$i,"
    done
    printf '%s\n' '            commands::sessions::get_stalled_info,'
    if [[ -n "$extra" ]]; then
      printf '%s\n' "$extra"
    fi
    printf '%s\n' '        ])'
  } >"$lib"
}

self_mk_fixture_root() {
  local root="$1"
  self_mk -p "$root/src-tauri/src" "$root/src-tauri/tests" "$root/src"
  local lib="$root/src-tauri/src/lib.rs"
  self_mkfile "$lib"
  self_write_fixture_lib "$lib"

  local n
  for n in $(seq -w 0 99); do
    local ts="$root/src/f$n.ts"
    self_mkfile "$ts"
    if [[ "10#$n" -le 44 ]]; then
      printf 'export const f%s = () => invoke("cmd%s", {});\n' "$n" "$n" >"$ts"
    else
      printf 'export const f%s = 1;\n' "$n" >"$ts"
    fi
  done

  # The Rust-test consumer evidence file (the arm that keeps a Rust-test-only
  # command visible to the guard).
  local ipc="$root/src-tauri/tests/ipc.rs"
  self_mkfile "$ipc"
  printf '%s\n' 'async fn t(webview: &W) {' '    invoke_ok(' '        &webview,' '        "get_stalled_info",' '        json!({}),' '    )' '    .await;' '}' >"$ipc"
}

run_self_test() {
  local script
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

  self_test_root="$(mktemp -d)"
  local root="$self_test_root/fixture"

  # Case 0: the PREMISE — a clean fixture that clears the floor must be green.
  # Without this case, every "it refused" below could be the fixture failing to
  # reach the checks at all (a floor trip, a missing file), which is the same
  # vacuity in reverse.
  self_mk_fixture_root "$root"
  self_run "$script" "$root"
  if [[ "$self_status" == "0" ]]; then
    self_ok "a clean fixture root passes (the fixture clears the vacuity floor, so the planted cases below are the delta)"
  else
    self_fail "a clean fixture root passes" "expected exit 0, got $self_status: $self_output"
  fi

  # Case 1: a registered command nobody consumes → exit 1, naming it. This is the
  # Finding 8 shape (`list_agent_definitions`): registered, documented, dead.
  self_write_fixture_lib "$root/src-tauri/src/lib.rs" '            commands::nothing::nope,'
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"nope"* ]]; then
    self_ok "a registered command with no consumer is REFUSED by name (exit 1)"
  else
    self_fail "a registered command with no consumer is REFUSED by name" "expected exit 1 naming nope, got exit $self_status: $self_output"
  fi
  # Un-plant by REGENERATING the fixture lib.rs, so no case inherits a mutated one.
  self_write_fixture_lib "$root/src-tauri/src/lib.rs"

  # Case 2: a consumed name with no registration → exit 1, naming file:line.
  local ghost="$root/src/ghost.ts"
  self_mkfile "$ghost"
  printf 'export const g = () => invoke("ghost_command", {});\n' >"$ghost"
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"ghost_command"* && "$self_output" == *"src/ghost.ts:"* ]]; then
    self_ok "an invoke() with no generate_handler! entry is REFUSED with file:line (exit 1)"
  else
    self_fail "an invoke() with no generate_handler! entry is REFUSED with file:line" "expected exit 1 naming ghost_command and src/ghost.ts, got exit $self_status: $self_output"
  fi
  self_rm "$ghost"

  # Case 3: the dynamic name — the guard must say it is BLIND, not wave it
  # through. Without this refusal the whole literal walk is a silent lie.
  local dyn="$root/src/dyn.ts"
  self_mkfile "$dyn"
  printf 'export const d = (name: string) => invoke(name, {});\n' >"$dyn"
  self_run "$script" "$root"
  if [[ "$self_status" == "1" && "$self_output" == *"not a string literal"* ]]; then
    self_ok "a non-literal invoke() first argument is REFUSED as a blind spot (exit 1)"
  else
    self_fail "a non-literal invoke() first argument is REFUSED as a blind spot" "expected exit 1 with the non-literal-message, got exit $self_status: $self_output"
  fi
  self_rm "$dyn"

  # Case 4: the blind walk itself. A handler block that reads as ONE name is the
  # symptom of an extraction window that matched nothing; green there would be
  # the decoration this family exists to prevent.
  local thin="$self_test_root/thin"
  self_mk -p "$thin/src-tauri/src" "$thin/src-tauri/tests" "$thin/src"
  local thin_lib="$thin/src-tauri/src/lib.rs"
  self_mkfile "$thin_lib"
  printf '%s\n' '        .invoke_handler(tauri::generate_handler![' '            commands::fixture::only,' '        ])' >"$thin_lib"
  local t
  for t in $(seq -w 0 99); do
    local ttf="$thin/src/t$t.ts"
    self_mkfile "$ttf"
    printf 'export const t%s = () => invoke("only", {});\n' "$t" >"$ttf"
  done
  printf '%s\n' 'async fn t(webview: &W) {' '    invoke_ok(' '        &webview,' '        "only",' '        json!({}),' '    )' '    .await;' '}' >"$thin/src-tauri/tests/ipc.rs"
  self_run "$script" "$thin"
  if [[ "$self_status" == "1" && "$self_output" == *"extraction is BLIND"* ]]; then
    self_ok "an extraction that found almost nothing is REFUSED as a blind walk (exit 1)"
  else
    self_fail "an extraction that found almost nothing is REFUSED as a blind walk" "expected exit 1 with the blind-walk message, got exit $self_status: $self_output"
  fi

  if ((self_test_failures > 0)); then
    printf '\nself-test: %s case(s) FAILED — the command-consumer guard cannot be trusted to fail\n' "$self_test_failures" >&2
    exit 1
  fi
  printf '\nself-test: all cases behaved (the guard has teeth)\n'
}

# Removes a path THIS invocation created, by that exact name (the census
# discipline: registered paths only, never a sweep).
self_rm() {
  local p
  for p in "$@"; do
    if [[ -e "$p" ]]; then
      rm -f -- "$p"
    fi
  done
}

# --- argument parsing ----------------------------------------------------------

repo_root=""
want_self_test=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --self-test)
      want_self_test=1
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

if ((want_self_test == 1)); then
  if [[ -n "$repo_root" ]]; then
    echo "error: --self-test takes no repo-root (it builds its own fixture root)" >&2
    usage
    exit 1
  fi
  trap self_test_cleanup EXIT
  run_self_test
  exit 0
fi

repo_root="${repo_root:-.}"

if [[ ! -d "$repo_root" ]]; then
  echo "error: repo root is not a directory: $repo_root" >&2
  usage
  exit 1
fi

run_guard "$repo_root"
