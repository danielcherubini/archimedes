---
status: live
last-verified: 2026-10-31
verified-by: read against this tree at `29d9563` (the post-merge HEAD) — every claim re-confirmed at HEAD; the Gate 1 figures are kept as what was measured at `377ea86`, not silently rewritten (see the two-gate note below and *Corrections on re-derivation* at the end)
---

# improvement-correctness-seams — close-out record

This doc is the **surviving home** for the facts the `docs/roadmap/improvement-correctness-seams-*`
family recorded, because that family is deleted on ship and squash-merge orphans the per-commit hashes
the roadmap cites. It records: the gates, the false findings that survived an audit, the open
`needs-auth` work, and the unblock recipe.

> **This doc carries TWO gates.** Gate 1 is the branch's final gate at `377ea86`, the last branch
> commit before `origin/main` was merged in. Gate 2 is the post-merge gate at `29d9563` — the tree
> that will actually be squash-merged. Gate 1's numbers are not stale: they are the record of what was
> measured at `377ea86`. They are simply no longer HEAD's numbers. The re-derivation that produced
> Gate 2 also caught figures that were WRONG at every commit — grep artifacts and names that do not
> exist in the tree. Those are corrected in place; the full split (superseded vs wrong) is
> *Corrections on re-derivation* at the end of this doc.

---

## Gate 1 — the final gate at `377ea86` (pre-merge branch tip, `main` untouched at the time)

| layer | result |
|---|---|
| rust (src-tauri) | **1,761 passed / 0 failed / 4 ignored** — baseline `e8e3ad7` was 1,757; +4 = 3 drift guards + 1 isolation test (re-checked per-commit at Gate 2: `9c27c2b` +53/−50 attrs = the 3 mapper drift guards, `3268d76` +1 = the gate-cluster isolation test, `377ea86` +70/−70 = pure move) |
| rust clippy | **0 warnings** (`--all-targets`) |
| rust fmt | clean |
| mingw check | `cargo check --target x86_64-pc-windows-gnu --all-targets` — clean (compile-shape only, no wine, no Windows behaviour claimed) |
| frontend (repo root) | `pnpm test` — **157 files / 3,300 passed + 1 skipped** ; `pnpm build` — clean |
| versions | `bash scripts/check-versions.sh` — **versions match: 0.9.1** (re-confirmed at Gate 2 in a `377ea86` worktree: the script prints `0.9.1` there) |
| commands | `bash scripts/check-commands.sh` — 46 registered, 45 consumed names, both directions agree (re-run at `29d9563`: unchanged) |

**Branch scale at Gate 1** (vs the branch base `3a2779d`): 59 commits (51 non-merge + 8 task-branch
merges), **104 code files — 53 Rust / 51 TS**,
plus 6 docs — **ADR 0063 amended, ADR 0080 amended, ADR 0086 new**, `docs/features/permissions-model.md`
amended, `docs/features/transcript-diff-channel.md` new, `docs/reviews/2026-10-30-codebase-improvement.md`
new (the 20-finding audit this branch implements) — and `CONTEXT.md`, `scripts/check-commands.sh` (new CI
guard), `.github/workflows/ci.yml`, `package.json` + `pnpm-lock.yaml` (the dead `plugin-opener` npm dep).
115 files in total. The "zero TS" line that appeared in earlier drafts described
task12b's diff ALONE and was never true of the branch — F20-ts (task14b) and F14-copy/F18/F19 (tasks
05/07/07b/09) are frontend work.

---

## Gate 2 — the final gate at `29d9563` (post-merge: `origin/main` = `c1873c4`, 0.9.2, two-stage titling #136)

The merge `29d9563` took `origin/main` (`c1873c4`, "chore(release): bump version to 0.9.2") into the
branch tip `2eeba39`. One conflicted file, `storage/db.rs`, five regions, all the same collision:
main's #136 appended a 10th `sessions` column (`title_stage`) to the four inline SELECT copies that
task12 had collapsed into `SESSION_COLUMNS` + `session_row_from`; the resolution keeps the branch's
shape and carries `title_stage` through it. Main's new migration gate is expressed as a `gate()` call
— the 9th call site in `db.rs` (task12 shipped 8). Every number below was measured at `29d9563`.

| layer | result |
|---|---|
| rust (src-tauri) | **1,783 passed / 0 failed / 4 ignored** — Gate 1's 1,761 + 22 from main (16 in `session/naming.rs`, 2 in `provider/transport.rs`, 4 in `storage/db.rs`); all 22 test names verified present at HEAD, main's 4 db tests landing inside task12's `storage/db/tests/` (that dir went 54 → 58 test attrs). The 4 ignores are the same manual/live-network pins — main added no `#[ignore]` |
| rust clippy | **0 warnings** (`--all-targets`) |
| rust fmt | clean |
| mingw check | `cargo check --target x86_64-pc-windows-gnu --all-targets` — clean (compile-shape only, no wine, no Windows behaviour claimed) |
| frontend (repo root) | `pnpm test` — **157 files / 3,318 passed + 1 skipped** — Gate 1's 3,301 total + 18, all from main and all inside existing files (`MessageList.scroll.test.tsx` +19/−1, `AskQuestionCard.test.tsx` +2/−2; main added no test FILE, so the file count holds at 157); `pnpm build` — clean |
| versions | `bash scripts/check-versions.sh` — **versions match: 0.9.2** |
| commands | `bash scripts/check-commands.sh` — 46 registered, 45 consumed names, both directions agree, 1 allowlist exemption cited |

**Branch scale at Gate 2** (vs `origin/main`, i.e. `git rev-list --count HEAD --not origin/main` and
`git diff --name-only origin/main...HEAD`): **61 commits — 52 non-merge + 9 merges** (the 8 task-branch
merges plus the `origin/main` merge itself), **116 files — 53 Rust / 51 TS** (the code split is
UNCHANGED: main's other changed files — `transport.rs`, `MessageList.tsx`, `AskQuestionCard*`,
`test/setup.tsx` — are absent from the branch-vs-main three-dot diff because the branch never touched
them, and the two files both sides changed, `storage/db.rs` and `session/naming.rs`, were already
counted branch files), plus **7 docs** — Gate 1's 6 plus this close-out record (added at `2eeba39`) — and the same
`CONTEXT.md`, `scripts/check-commands.sh`, `.github/workflows/ci.yml`, `package.json` +
`pnpm-lock.yaml`. Gate 1's 59/115 stays true as Gate 1's measurement of the pre-merge branch.

---

## What ships (22 task rows; 59 commits at Gate 1, 61 at Gate 2)

The plan's dependency graph schedules all 16 original tasks across **Waves 1–11**. The orchestrator's
wave numbers in the status file are **execution order, not plan order**, and diverge from it in two ways:
six extra task rows were split out mid-run (`task07b`, `task08b`, `task10b`, `task12b`, `task14b`,
`task14c` — 16 planned rows became 22), and
`task11` + `task12` — planned at Waves 6–7 — were actually executed LAST, because an orchestrator audit at
Wave 11 found they had been planned and vetted but never implemented. Do not read the status file's wave
numbers as the plan's schedule.

The SHAs below are **branch-local and become unreachable the moment this branch is squash-merged** — that
is this repo's convention, not an oversight (AGENTS.md: "the squash-merge convention silently orphans the
commit hashes the docs cite"). They are here to make the PR reviewable NOW. After merge, the durable
record is **this doc + the PR diff**, so cite the **PR number**, not these hashes.

| area | commit | scope |
|---|---|---|
| **F1-F5, F8-F11, F14-copy, F15/F16, F18, F19** (tasks 01–07b + 09) | `b7c71cf` `3e4f288` `fe2111d` `94c3923` `ea3b350` `db4f4ca` `9d8687c` `667abf0` + task09's merge `93b6901` (its 9 commits `4040e30`…`ee9eaad`) | provider in-stream error arm, `StalledInfo` removal + dead npm dep, ADR 0086 glossary conformance, last-active one-rule, reduced-motion hook swap, child-completion latch + latched-pid group kills, `CompactionReason` TS union, details-registry pin + dead TS fields, muted-caption census guard + the 5 glossary copy fixes |
| **F4-rust + F5-rust** (task08) | `c6e2ecc` | `CompactionReason` (wire-byte-identical), `details` fixtures, `tool_result_response_value` pin, stale comment fix |
| **F6** (task08b) | `03fdca8` | `PermissionContext` + `TurnControl` + `PolicedTool` — the permission cluster and the turn latch become types |
| **F13** (task10) | `65d901e` | SessionState registry merge + registrar alias deletion (architectural boundary only) |
| **F7a** (task10b) | `f1f5b0e` | two pump tests (first out, last in — flake-proof) |
| **F8-rust** (task13) | `55aa4db` | dead IPC cleanup + command-consumer guard |
| **F10** (task16) | `cccae82` | shared root-discovery extraction |
| **F20-rust** (task14) | `587aef6` `7de5b08` `9a6d7c3` `f5846db` `adc3240` `ff1e86d` | hand-built envelope (no serde derive — ADR 0063): HistoryError → six history commands → Attention/Clipboard enums → external_open → update commands → ADR 0063 amend |
| **F20-rust cont.** (task14c) | `421e019` `8682049` `1c787de` `eb3c9df` `ca21149` | the phantom/`String` retypes split out at the file ceiling |
| **F20-ts** (task14b) | `dfd4b2f` `f453395` `a6ec37c` `7f64315` | TS wrappers + `types.ts` migrated to envelope, needs-auth red parked |
| **F14-wire** (task15) | `4cbd721` `9d43dbd` | glossary wire renames — family A `list_agent_config`→`list_agent_definition_reports`, `AgentConfigDto`→`AgentDefinitionReportDto`, `listAgentConfig`→`listAgentDefinitionReports`; family B `list_space_files`→`list_space_listing`, `FileListDto`→`ListingDto` (the names an earlier draft of this row cited — `list_agent_sessions`, `AgentSessionDto`, `mcp_server_spec`, `mcp_server_instance` — do not exist in the tree; see *Corrections*) |
| **F7b** (task11) | `94244ce` `556d49d` `6c937fa` `e8e3ad7` | `mcp/http.rs` 4 contract tests (cancel arms, `response_to_result` branches, Bearer on wire, **exact request bytes** — the 4th written by orchestrator after child cut off) |
| **F12** (task12, HALF 1) | `6472923` `80b1d4d` `bd55aa1` `9c27c2b` `3268d76` | `gate()` transaction factory (8 gates), 3 `const` SELECT + 3 mappers + 7 call sites, drift guards (arity tie + typed gets + independent golden list), migration cluster consolidated with `preexisting_db` |
| **F17** (task12b, HALF 2) | `377ea86` | `launch.rs` + `sandbox.rs` inline tests → sibling `tests/` dirs (child-module shape, `super::*` still reaches privates), coverage gate machinery moved intact |

---

## False findings that survived an audit (recorded verbatim so they are not re-filed)

### Finding 18 — "QueueRow lacks reduced-motion branch" (2026-10-30)
**Premise FALSE at HEAD.** `QueueRow.tsx` ALREADY has:
- the reduced-motion static branch (`if (reducedMotion) return <div data-testid="queue-row">`)
- the same-tick `forget` effect
- TWO tests pinning both (`QueueRow.test.tsx:396` "reduced motion sends the trash straight to forget", `:407` "reduced motion renders a plain div")

(The audit read those pins at `:324`/`:335`, which was true at its own baseline `3cf6c42`; `ea3b350`
inserted the subscribing stub and a third test above them, shifting both — their bodies are
byte-identical to the `3cf6c42` text, verified by diff at `29d9563`.)

The behaviour shipped in `1654a3f` with QueueRow itself. What the tree DOES show, and what task05 became about:
- (a) QueueRow's local 10-line `prefersReducedMotion()` does NOT subscribe to changes, so a mid-session OS toggle needs a remount — the hook does subscribe.
- (b) that local copy makes the hook's own doc FALSE — it reads "Moved verbatim out of `QueuedSummaryContent.tsx`, which was its **only other copy**", and QueueRow is a second copy.

Task05 = delete the copy, import the hook, gain the subscription, and the doc becomes true with zero doc edits. The plan keeps `QueueRow.test.tsx:396`/`:407` (the audit's `:324`/`:335`) UNMODIFIED as the guard.

### Finding 7b — "`agent/mcp/http.rs` has 0 tests and is the largest genuinely-untested production file" (2026-10-30)
**FALSE.** The file carried **5 passing** `#[tokio::test(flavor = "multi_thread", worker_threads = 4)]` tests against a local `127.0.0.1:0` listener at the audit's own baseline `01dafc8`, byte-for-byte (verified). The claim survived because `grep -c 'test]'` returns 0 on this file — the attribute shape is `#[tokio::test(...)]`, so the correct count is `grep -c 'tokio::test'` (5). Task11 added the 4 genuinely-open tests (cancel arms, `response_to_result` branches, Bearer on wire, request bytes); it did NOT re-test the round-trips, the 401 branch, the session-id resend, the slow-SSE bound, or manager-level token re-attach, all of which were already covered. (Re-counted at `29d9563`: `grep -c 'tokio::test'` = 9 = the 5 pre-existing + task11's 4; the merge did not touch `http.rs`.)

### Third false finding — task13 row destroyed by string surgery (2026-10-31)
A **table-row insert ended without a trailing newline**, fusing the task12b insert with the following task13 row into one 1,114-char line. My first audit only looked for missing names, so the fusion hid as one bloated row (15 cells instead of 7). The row audit must check **CELL COUNT per row**, not just that every name appears. Split back into two 7-cell rows and re-verified all 22 rows = 7 cells. (Re-checked at `29d9563`: all 22 task rows still 7 cells; the task12b row sits at status-file line 158 and the task13 row at 159.)

---

## The open `needs-auth` work (the ONLY unfixed defect from this run)

The `needs-auth` error kind is **absent from the Rust envelope** (0 hits in `src/agent/errors.rs`, `src/commands/settings.rs`, `src/lib/errors.ts`). It is:

- **Blocked candidate**: `src/lib/errors.ts:159` — *"and the blocked candidate (`"needs_auth"`) joins this union ONLY when the Rust envelope grows it"* — the union it names is `McpTestErrorKind` (`:164`)
- **Parked test**: `src/components/settings/McpSection.test.tsx:153` — `it.skip("a reworded needs-auth sentence still shows the badge (the envelope-contract red-first)")`
- **Component still text-matches**: `src/components/settings/McpSection.tsx:114` — `result.error.includes("needs-auth")`
- **SettingsError::McpTestFailed** is the live path: `manager.rs:504` `test_server` returns `"needs-auth"` verbatim, which bubbles through `SettingsError::McpTestFailed` → `mcp_test_failed` → `result.error.includes("needs-auth")` (all re-verified at `29d9563`)

### Unblock recipe (what must change, and ONLY that)

Re-verified against the tree at `29d9563`. The first draft of this recipe named machinery that does
not exist: there is **no `AgentError` type and no `ErrorCode` impl** in `agent/errors.rs` (the file is
one enum per family — `SessionError`, `SettingsError`, … — each with a hand-written `pub fn kind()`),
and `src/lib/errors.ts` has **no `ErrorCode` union** (it exports per-family `*ErrorKind` unions). It
also "discovered" a variant that was already there: **`SettingsError::McpAuthFailed` exists**
(`agent/errors.rs:534`, kind `mcp_auth_failed` at `:558`), is already used by `auth_mcp_server`
(`commands/settings.rs:157`), and is already mirrored in TS (`SettingsErrorKind`, `errors.ts:144`).
The tree's own recipe is the comment block at `McpSection.test.tsx:136–152`, and it agrees with this:

1. `src-tauri/src/commands/settings.rs` — in `test_mcp_server`, match `test_server`'s raw `"needs-auth"`
   marker BEFORE the blanket `.map_err(SettingsError::McpTestFailed)` wrap and map it to the EXISTING
   `SettingsError::McpAuthFailed`. No new variant; the wire kind `mcp_auth_failed` already exists both sides.
2. `src/lib/errors.ts` — give `McpTestErrorKind` (`:164`) the machine discriminator the badge switches
   on and retire the blocked-candidate comment at `:159`.
3. `src/components/settings/McpSection.tsx` — branch on `kind` (the parked design) instead of the
   sentence match at `:114`.
4. Remove the `it.skip` at `McpSection.test.tsx:153` — the test is the acceptance check (its mock and
   expectation are written for the kind-branching design, so it is the unblock's arbiter as written).

**No new `SettingsError` variant.** The red flow already exists and is pinned by the parked test.
The old closing claim — "nothing else in the tree references `needs-auth`" — was **false as
written**: the marker `"needs-auth"` occurs 31 times across 9 files — it is PRODUCED at
`agent/mcp/http.rs:181` (the 401 arm), CONSUMED at `agent/mcp/manager.rs:187` (the manager's own
needs-auth state, a different concept with its own tests), and pinned as prose at
`ipcError.test.ts:65–76` among others. `needs_auth` (underscore) occurs 8 times across 4 files: the
two blocked-candidate comments above plus five Rust test NAMES about the manager's auth state, none of
which is the IPC kind. What is true is narrower: nothing OUTSIDE the four files in the recipe changes
when the kind lands — the manager's auth-state machine and the sentence-pins are unaffected.

---

## Other notable non-deliveries from the original plan (accepted, tracked)

| item | status | evidence at HEAD |
|---|---|---|
| `AgentLoop::new()` arg count — finding 6's "collapses the 22-arg constructor materially" did NOT happen (22 args stand; task08b moved FIELDS, not parameters: `AgentLoop` went 44 fields → 35) | accepted — task08b scope was the permission cluster / turn latch types, not the constructor | `loop.rs:1` allow (its comment says "22 args — kept"), `loop/tests/support.rs:2` allows, `new()` (`loop.rs:550`) has 22 parameters. (The earlier "`TurnContext::new()`, 24 params" wording was a grep artifact — see *Corrections*.) |
| `discover_in_roots` still duplicated (`agents.rs` + `skills.rs`) | accepted — task16 extracted shared roots but DID NOT unify the callers | `grep -c 'fn discover_in_roots'` = 2 (both verbatim), `agents.rs:121` + `skills.rs:115` |
| `prompt.rs` keeps its own `.git` walk (3 `join(".git")`) | accepted — task16's `roots.rs` is for future unification; prompt not retouched | `src/roots.rs` has 4 `join(".git")`, `src/agent/harness/prompt.rs` has 3 |

---

## What dies with the branch (intentionally)

- All **56** `docs/roadmap/improvement-correctness-seams-*.md` files — 16 grounding reports, 17 plan-vet
  reports (16 per-task + the vet-record), 22 task plans, 1 status file. Re-counted at `29d9563`: 56.
  The directory is gitignored (`.gitignore`), so these are
  unrecoverable once deleted: no `git checkout`, no stash, no dangling blob. That is why this doc exists,
  and why deletion must use explicit `${FEATURE_NAME}`-prefixed pathspecs with the match list printed
  first (AGENTS.md: never `rm -rf docs/roadmap/` — unrelated files there ARE tracked; **three** now, not
  the two AGENTS.md still says: `litellm-connection-suite.md` arrived from main at `820c4ce`).
- The 51 non-merge commits' individual SHAs (squash-merge orphans them — see the note atop *What ships*).

---

## Who verified what (so the next reader doesn't re-do it)

| claim | verified by | how |
|---|---|---|
| `needs-auth` absent in Rust | orchestrator | `grep -rc 'needs_auth' src-tauri/src/agent/errors.rs src-tauri/src/commands/settings.rs src/lib/errors.ts` → 0, 0, 1 (TS doc) — re-run at `29d9563`, same |
| parked skip intact | orchestrator | `grep -n 'it.skip.*needs-auth' src/components/settings/McpSection.test.tsx` → line 153 — re-run at `29d9563`, same |
| component text-match | orchestrator | `grep -n 'needs-auth' src/components/settings/McpSection.tsx` → line 114 — re-run at `29d9563`, same |
| envelope `code: "needs_auth"` comment | orchestrator | `grep -n 'blocked candidate.*needs_auth' src/lib/errors.ts` → line 159 — re-run at `29d9563`, same |
| F18 premise false | orchestrator | read `QueueRow.tsx` + `QueueRow.test.tsx:324,335` (at the audit baseline `3cf6c42`; `:396,407` since `ea3b350`) + `1654a3f` |
| F7b premise false | orchestrator | `grep -c 'tokio::test' src-tauri/src/agent/mcp/http.rs` = 5; ran all 5 (9 at HEAD, +4 from task11) |
| task13 row destroyed | orchestrator | one 1,114-char line held 2 rows; split by inserting newline. All 22 rows = 7 cells, re-checked at `29d9563` |
| sandbox coverage gate vacuous | orchestrator | `cargo test` captures stdout → `grep -c SKIP-SANDBOX` always 0; `--nocapture` on this host shows `PARTIAL — 1 skipped` (tty context); CI must assert on `SANDBOX-COVERAGE: ENFORCED` with `--nocapture`, never on skip-count — REPRODUCED at `29d9563` (captured run: 0 markers; `--nocapture`: `SANDBOX-COVERAGE: PARTIAL — 1 … SKIPPED`, Landlock ABI 10) |

---

## Corrections on re-derivation at `29d9563` (2026-10-31)

A reviewer caught the version number. Re-deriving EVERY number split the findings into two piles.

**SUPERSEDED by the merge `29d9563` (true at `377ea86`, kept as Gate 1 history):**

| figure | Gate 1 (`377ea86`) | Gate 2 (`29d9563`) |
|---|---|---|
| versions | 0.9.1 | **0.9.2** |
| rust tests | 1,761 / 0 / 4 | **1,783 / 0 / 4** (+22 from main: naming 16, transport 2, db 4) |
| frontend tests | 157 files / 3,300 + 1 skipped | 157 files / **3,318** + 1 skipped (+18, all `MessageList.scroll.test.tsx`) |
| branch scale | 59 commits (51+8), 115 files, 6 docs | **61 commits (52+9), 116 files, 7 docs** (code split 53 Rust / 51 TS unchanged) |
| gate heading + `verified-by` SHA | "Final gate at `377ea86`" | now a PRE-merge record; Gate 2 at `29d9563` added |
| tracked `docs/roadmap/` files | 2 | **3** (`litellm-connection-suite.md` arrived from main at `820c4ce`) |
| "`main` untouched" | true | main moved `3a2779d` → `c1873c4`; the branch merged it |

**WRONG at every commit (grep artifacts / names that do not exist — corrected in place above, not
superseded):**

1. **`TurnContext::new()` "24 `:`-separated params"** — no `TurnContext` type exists (the types are
   `TurnControl`, which has no `new()`, and `PermissionContext`). The constructor is
   **`AgentLoop::new()` (`loop.rs:550`) with 22 parameters** — the finding itself, the code comment,
   and the status file all say 22. The 24 was a `grep ':'` that also counted the two doc-comment
   lines INSIDE the signature that contain a colon.
2. **`QueueRow.test.tsx:324`/`:335`** — cited as HEAD lines, but `ea3b350` (a branch commit, i.e.
   BEFORE this doc's own HEAD) shifted them to **`:396`/`:407`**; 324/335 was only true at the audit
   baseline `3cf6c42`. Bodies byte-identical across the shift (verified by diff).
3. **task15's rename list** — `list_agent_sessions`, `AgentSessionDto`, `mcp_server_spec`,
   `mcp_server_instance` do not exist anywhere in the tree. The landed renames are
   `list_agent_definition_reports`, `AgentDefinitionReportDto`, `listAgentDefinitionReports`,
   `list_space_listing`, `ListingDto` (quoted from `4cbd721` / `9d43dbd`).
4. **`StepRegistry`** in the tasks-01–09 scope cell — no such symbol exists in the tree or in any
   roadmap file; the same cell also listed "SessionState registrar" (task10) and "error envelope"
   (task14), which belong to OTHER rows. The cell now lists what those eight SHAs actually did.
5. **The tasks-01–09 row claimed F19/F14-copy but listed none of task09's commits** — task09 is 9
   commits merged at `93b6901`, now named in the row.
6. **The `c6e2ecc` row was labelled "F6 (task08b)"** — `c6e2ecc` is task08 (F4-rust/F5-rust);
   task08b/F6 is `03fdca8`. The row is split in two.
7. **"nothing else in the tree references `needs-auth`"** — false: 31 hits across 9 files (see the
   needs-auth section).
8. **The unblock recipe's `AgentError` + `ErrorCode` impl + TS `ErrorCode` union** — none of those
   exist; and "no new `SettingsError` variant" was right for the wrong reason: `McpAuthFailed` already
   exists and is already wired.
9. **Impossible dates**: this doc's `last-verified` claimed **2026-11-01** and the task13-row incident
   claimed 2026-11-01 — both AFTER every commit in the tree (the last commit predates them; the status
   file's mtime is 2026-10-31). Corrected to 2026-10-31. Finding 7b was dated 2026-10-29 — the audit
   that contains it is dated 2026-10-30.
10. **The F7b map row's "`db/tests` shape"** — task11 owns `mcp/http.rs` only; the `db/tests` shape is
    task12's.

**UNCHANGED AND STILL TRUE (re-measured, not copied):** clippy 0 warnings, fmt clean, mingw check
clean, `check-commands.sh` 46/45 both directions agree; 56 roadmap files (16+17+22+1); all 22 status
rows 7 cells; `discover_in_roots` = 2 verbatim; `roots.rs` 4 / `prompt.rs` 3 `join(".git")`; the allow
counts 1 (`loop.rs`) + 2 (`loop/tests/support.rs`); the `needs_auth` greps 0/0/1; the skip at `:153`;
the text-match at `:114`; the blocked-candidate comment at `:159`; `manager.rs:504` `test_server`;
`grep -c 'test]'` = 0 on `http.rs`; every SHA cited in this doc resolves and is an ancestor of
`29d9563`.

---

## Next reader: what to do before concluding something is "done"

1. **Read this doc** — the roadmap family is deleted and its hashes are orphans.
2. **Check the three `needs-auth` conditions** above — if all three flip, the block is lifted.
3. **Don't trust a grep of `test]`** — count `tokio::test` for this module.
4. **Don't trust `grep -c SKIP-SANDBOX` on captured output** — it's vacuous.
5. **Cite squash SHAs, not per-issue hashes** — the merge commits are the implementable boundary
   (8 task-branch merges at Gate 1, 9 including the `origin/main` merge at Gate 2); the per-issue
   hashes the plans cite are unreachable from `main`.

---

## Task → finding map (what to read if a specific area misbehaves)

Cite the **PR number** for any of this after merge; the per-commit SHAs above are orphaned by the squash.

| finding | task | area | landed in |
|---|---|---|---|
| F1 provider in-stream errors | task01 | `provider/types.rs`, completions + Responses wires | `b7c71cf`, preceded by `3cf6c42` (the audit report itself) |
| F2 dead `StalledInfo`, stale ordering prose | task02 | TS interface + barrel + lockfile | task02 |
| F3 glossary conformance policy | task03 | **ADR 0086**, `CONTEXT.md` | task03 |
| F8-F11 muted-caption pair, copy | task04, 07, 07b, 09 | `MutedCaption.tsx` + census guard, Settings rows | tasks 04/07/07b/09 |
| F18 reduced motion | task05 | `QueueRow.tsx` → `usePrefersReducedMotion` | task05 |
| F6 permission cluster + turn latch | task08b | `PermissionContext`, `TurnControl`, `PolicedTool` | task08b |
| F13 per-session registries | task10 | `SessionState` owns them; registrar alias deleted | task10 |
| F7a pump coverage | task10b | worker pump tests (first-out, last-in) | task10b |
| F7b MCP HTTP contract | task11 | `agent/mcp/http.rs` — **4 new tests, 5 pre-existing** | task11 |
| F8-rust dead IPC + guard | task13 | 4 dead things deleted, `scripts/check-commands.sh` + CI steps | task13 |
| F10 root discovery | task16 | `src/roots.rs` | task16 |
| F20 error envelope | task14, 14c, 14b | `agent/errors.rs` (hand-built, no derive) → TS mirror | tasks 14/14c/14b |
| F14-wire glossary renames | task15 | `list_agent_definition_reports`, `AgentDefinitionReportDto`, `list_space_listing`/`ListingDto` | task15 |
| F12 storage shape | task12 | `storage/db.rs` + `storage/db/tests/` | task12 |
| F17 test-tree moves | task12b | `harness/launch/tests/`, `tools/sandbox/tests/` | task12b |
