# backlog-79-122-124-28 — follow-ups

Staging artifact. The plan, this file and the status file are **deleted on ship** — fold the
durable content into `docs/features/` or an ADR before `finish` runs.

Each item carries a status: **open work** (someone should do it), **recorded, not open work**
(a deliberate limit, no action owed), **accepted** (a decision, not a gap).

## #122 — empty message content

- **Legacy transcripts still render the placeholder.** — `recorded, not open work`.
  The fix filters inbound, so the gateway's banner never reaches the transcript again; rows
  written BEFORE the fix still store it and still replay on Resume. No row migration was
  written, and ADR 0054 puts durable-row re-labelling on the wrong side of the wire.
  If it ever needs doing, it is a one-off transcript scrub, not a code path.
- **`TranscriptReplace` clamp + the JSON-parsing `clamp_empty_text_with_tool_calls` helper.** —
  `recorded, not open work`. Dropped in the round-2 belt trim on purpose: four filter seams for
  one upstream bug is four places to maintain, and the shipped set already covers every seam that
  a real provider can reach. Revisit only if a provider is observed writing a placeholder into a
  replaced transcript row.
- **No wire-contract test.** — `open work`. This repo has no provider wire-contract test, so the
  outbound half of #122 (omitting `content` for an empty-text assistant-with-tool-calls row) is
  pinned at the `request_body` unit level only. The natural home is a
  `src-tauri/tests/provider.rs` MockServer pin. Issue #124 names the same gap for the same class
  of defect ("this repo has no wire contract test").
- **A message that is EXACTLY the placeholder verbatim is dropped**, at every exact-match seam —
  including a user who types the banner, and a subagent whose whole output is the banner. —
  `accepted`. Documented in the plan's trade-off section; the alternative is a prefix-match that
  can catch legitimate prose.

## #124 — path-tool permission pattern maps

- **Per-tool modal copy.** The Agents modal renders the new note through its generic fallback
  (`unsupported matcher: pathPatternRules`) because `describeNote` in
  `src/components/AgentsDialog.tsx` only special-cases the bash reason. Adding a sentence needs
  `AgentsDialog.tsx` + the `AgentUnsupportedReason` union in `src/lib/tauri/types.ts` + a pin in
  `AgentsDialog.test.tsx`. — `open work`, cosmetic; the announcement is truthful as-is.
- **Enforce path patterns via the shared canonicaliser.** The issue's option 2 — `edit:`/`read:`/
  `write:` patterns could genuinely be judged, because `FsBackend::validate` /
  `canonicalize_lenient` already exist and there is no command text to parse. Needs a decision on
  the root set (ADR 0084 answers "the boundary root set", not workspace-relative) and must be
  consulted at row 4's tail or it can bypass the protected-dir guard. — `recorded, not open work`
  for this run: the owner chose announce-not-enforce. This is NOT the bash-matcher problem ADR
  0084 refuses; it deserves its own discuss/ADR.
- **`docs/features/permissions-model.md` now lags the code slightly.** Its "announced and
  UNENFORCEABLE" bullet names only the bash class; path tools announce too as of `3ce1319`. —
  `open work`, docs-only.

## #28 — MIT licence

- **The rpm proof is deferred, not skipped.** — `open work`, blocked on a real build. `rpmbuild`
  and `rpmlint` are absent on this machine, so three checks could not run: `rpm -qp --qf
  '%{LICENSE}'` prints `MIT`, `rpm -qlp` lists `/usr/share/licenses/archimedes/LICENSE`, and
  `rpmlint` is free of `no-license`/`invalid-license`. They must be run against the next release
  artifact.
- **CI cannot catch a wrong licence.** `release.yml`'s only rpm assertion counts `*.rpm` by glob,
  so a mistyped SPDX string or a swapped `files` src/dest pair ships silently. Giving it teeth
  means `apt-get install rpm rpmlint` plus a header check on the `workflow_dispatch` rehearsal
  leg. — `open work`.
- **The deb still ships no licence text.** The bundler emits no `License` control field and no
  `debian/copyright`. Out of #28's scope (the deb cannot see the problem, which is why only the
  rpm got a ticket). — `recorded, not open work`.
- **`../LICENSE` is now a rot-able packaging input** — renaming or deleting it breaks no local
  gate. Recorded as a consequence in ADR 0085. — `recorded, not open work`.
- **The copyright holder line is a human-veto point.** `Copyright (c) 2026 Daniel Cherubini` was
  derived from the git author identity because the repo carries no author metadata at all
  (`Cargo.toml` still has `authors = ["you"]`). If a legal entity holds the copyright, change
  that one line; the packaging wiring is unaffected. — `open work` (a human decision).

## #79 — Windows bash residuals

- **`start /B` file-lock is recorded, not explained.** The Windows tool description now names the
  symptom ("The process cannot access the file because it is being used by another process") with
  no mechanism claimed and no locking code invented. — `open work` for whoever can reproduce it on
  a real Windows box; this run deliberately did not guess.
- **`timeout /t` diagnostic is CI-only as behaviour.** The translator is pure and pinned on every
  platform, and the wiring is pinned host-side on Linux, but the `#[cfg(windows)]` e2e
  `bash_timeout_t_reports_a_no_console_input_diagnostic` only RUNS on CI's `windows-latest` leg. —
  `recorded, not open work`; it is the ceiling of this machine, not a missing test.
- **Two docs the child could not touch (out of its owned set).** — `open work`, docs-only:
  the research doc's §Gaps entry for the file-lock, and ADR 0060's prose, which still describe the
  pre-diagnostic state.
