---
status: shipped-with
feature: issue-triage-backlog
updated: 2026-10-24
---

# issue-triage-backlog — follow-ups

Staged here because `finish` deletes the whole `docs/roadmap/issue-triage-backlog-*` family on ship.
Durable content was folded before deletion: the two stale-doc corrections (§3) were APPLIED directly to
the research docs in the ship commit, the open-work items are tracked on the issue tracker, and the two
things the tracker does NOT hold moved to durable homes — the §2 T7 residuals to
`docs/features/mcp-known-gaps.md` and the §4 process facts to AGENTS.md's Conventions. This file
is the record of what was deliberately NOT done and why — read it before re-deriving any of it.

## 1. Open work — has its own issue

| Item | Where | Status |
|---|---|---|
| Choose the project licence (SPDX) → `LICENSE`, `Cargo.toml`, `package.json`, `tauri.conf.json` `bundle.license`, and `bundle.rpm.files` to ship `/usr/share/licenses/archimedes/LICENSE` | #28 | `open work` — blocked on a HUMAN legal decision, not on code. The rpm ships an empty `License` tag until then; `rpmlint` reports error-severity `no-license`. |
| Narrow the web handlers to ONE param dialect (option b): drop the camelCase acceptance, fix the truncation notice + `details` key to say `response_id` | #82 | `open work` — the interim shipped with T9 (`a9b2347`): specs now advertise exactly what handlers read, so #78's checker has zero known false positives. The real fix wants a line in the ADR that owns the web tools. |
| Migrate the 21 `agent:` → `agentName:` call sites across 9 skills in `~/.agents` | `~/.agents` repo (separate) | `open work` — out of this repo's reach. #78's warning (`a9b2347`) makes each stale call visible on its first dispatch, which is the designed teaching mechanism, not a regression. |
| `agents.rs` ignores pi's richer agent frontmatter: `skills:`, `systemPromptMode:`, `inheritSkills`, `model_kwargs` — so even a correctly-dispatched `reviewer` never receives its skill | #78's own "Out of scope" section | `open work` — ADR 0020 lists tolerating unknown frontmatter as a deliberate consequence; honouring it is a decision that wants its own ADR. |
| `ask`'s nested `recommended` per-question key is read by the handler but unadvertised in `ask`'s nested `items.properties` | (small; fold into #82's area) | `recorded, not open work` — #78's checker is top-level-only, so it can never fire on a nested key. Cheap to advertise if the nested rule ever lands. |
| `sudo_exec` never consults `protected_dirs` (the asymmetry #33 documents) | #33 (stays open for its proposal 2) | `accepted` — ADR 0030's documented intent: the floor is a guard-rail, not a security boundary; `Shell = Sandboxed` closes it from the other side via `rule_root_around_protected`. T5 changed only the refusal TEXT and deliberately did not name `sudo_exec` in it. |

## 2. Accepted residuals inside shipped tasks

- **T8 / #79 — `timeout /t 20 /nobreak >nul` still fails** ("Input redirection is not supported"). Not
  quoting: it needs console input and Tool children get stdin forced to NULL + `CREATE_NO_WINDOW` — the
  deliberate policy. Mitigated in the description only. The issue says explicitly the quoting fix must
  not close it. `start /B prog.bat`'s "being used by another process" is likewise unexplained and
  explicitly NOT closed. `raw_arg`'s trailing-backslash edge is accepted (matching pnpm/Zed/VS Code).
- **T8 — Windows behaviour is CI-only.** The two `cmd.exe` tests compile locally under the gnu target
  (proved by planted type errors reddening `cargo check --target x86_64-pc-windows-gnu --all-targets`
  inside the `#[cfg(windows)]` regions) but cannot RUN here: no wine, and the msvc target needs
  `lib.exe`. Do not describe T8 as behaviourally verified locally.
- **T7 / #68 — recorded, not fixed:** `http.rs` sends the OAuth `Authorization` header with no `Bearer `
  prefix; mid-session token expiry is not handled (only the pre-connect check); stdio failures never
  reach `McpState::Error`; refresh-token ROTATION drops a rotated refresh token if the server returns
  one; and `authenticate_server` (the Settings path) has no manager entry, so authenticating from
  Settings while a live session holds that server in `NeedsAuth` leaves the session stuck until it
  reconnects. **All five now live in `docs/features/mcp-known-gaps.md`** (moved 2026-10-24, because this
  table and `task07`'s plan doc are both deleted on ship — that file is their only surviving home).
- **T6 / #81 — the scrub verdict cannot distinguish "gate closed" from "clean mount"** (both are the
  empty verdict); named in the empty-case wording. The updater relaunch (`commands/update.rs::
  relaunch_patch`) stays deliberately silent, with the reason in `for_child()`'s doc.
- **T12 / #34 — second-confirmation reaping was rejected** (invasive at a 30-min default). Recorded in
  ADR 0055's 2026-10-24 amendment. The `!in_flight` guard only DELAYS a frozen-clock reaping until
  `tool_execution_end` lifts it — measured, stated in the in-tool test's doc.
- **T10 — the fixture-side decode gap:** `bin/fake_worker.rs`'s `let Ok(msg) = decode_inbound(&l) else
  { continue }` silently DROPS an unreadable `start` line (production's pump at least `eprintln!`s it).
  A comment now names it; changing fixture decode behaviour was out of scope. Symptom if it bites:
  `manager::tests` failing with misleading values after a protocol change — and remember
  `cargo test --lib` does NOT rebuild `fake_worker`; run `cargo build --all-targets` first.
- **T2 / #10 — the frontend half of the under-count is still open; the Rust half is
  DONE.** `skills::is_mentionable_name` and `exec_read_skill` said "a Rust-doc-only
  change is owed" here, and that change landed in `c4cf167`: both Rust sites now say
  FOUR, matching the frontend's corrected paragraph. What remains is `manualOnlyTooltip`'s
  header, still reading "These TWO are the only places the rule is enforced for Skills";
  the correction therefore lives in `src/lib/skills.ts` and in `UNMENTIONABLE_ROW_REASON`
  (whose comment says so), and that relocation is the residue. Note what is and is not
  pinned, because it decides the size of the job: the two tooltip tests
  (`the_manual_only_tooltip_promises_no_$mention_a_name_cannot_carry` and
  `the_manual_only_tooltip_offers_the_$mention_and_says_the_refusal_is_live`) pin the
  FUNCTION's two rules — both timings, and no `$` glyph for an unmentionable name — and
  `task02`'s acceptance line asks for `manualOnlyTooltip` byte-unchanged, which is why
  the header was left alone in that wave. But the header is a doc COMMENT, and no test
  reads this file's source: editing `These TWO` to `These FOUR` was measured to redden
  nothing (24/24 green). So the residue is a comment edit, not a pin change — what it
  still owes is the judgement call about whether a pinned-function header may move, and
  keeping the count consistent with the two places that now state it.

## 3. Doc corrections — APPLIED in the ship commit (do not redo)

- `docs/research/appimage-child-process-env-leak.md` §"Gaps" item (b): `--max-results` IS a real `fd`
  flag (measured: `fd --max-results 10 -g a.txt -- <dir>` exits 0 with results), so the fd fast path
  does run. Struck.
- `docs/research/windows-child-console-window.md`: the "Related, deliberately filed separately"
  paragraph and the first "Follow-ups" bullet described the `cmd /C` quoting bug as open. Now read
  CLOSED by `70bffe1` (`raw_arg` + `/d /s /c` threaded through `childproc`, census invariant E). The
  follow-ups list legitimately KEEPS: `sudo_exec` on Windows, the missing Windows process-group kill,
  and the non-Linux relaunch.
- `docs/decisions/0036` carries two dated amendments (T2's dead-token reversal; T10's child-shape
  correction); `0055` one (T12's OBSERVED wording); `0060` one (T8's widened remit); `0052` three (the
  payload-shape correction predates this loop, T3's inverse gate was its second, and `774039d`'s
  refusal-cleanup correction its third). All append-only, `superseded-by:` empty — check those before
  writing any new ADR about the same ground.

## 4. Process facts worth keeping (the loop learned these the expensive way)

**Moved to AGENTS.md → Conventions → "Working in this repo" on 2026-10-24**, all of
them. They are repo properties rather than roadmap narration, so they belong where
every session reads them — and this file is deleted on ship, which is the other
reason. One copy of each fact lives there now; the `fake_worker` stale-binary
symptom additionally appears in §2's T10 bullet above, where it is a symptom of a
fixture gap rather than a process rule.
