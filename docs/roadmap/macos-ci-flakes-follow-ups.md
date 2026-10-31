---
status: staging
feature: macos-ci-flakes
updated: 2026-10-31
---

# macos-ci-flakes — follow-ups

**This file is deleted on ship** (`finish` removes the whole `docs/roadmap/macos-ci-flakes-*` family). Its
durable items are already folded — #139's into `docs/features/issue-96-temp-dir-known-gaps.md` (by task A1) and
#138's into the comments in `src-tauri/tests/worker_e2e.rs` (by task A2); see the fold list at the bottom for what
each item resolves to. Statuses: `open work` / `recorded, not open work` / `accepted`.

## 1. `crash_path_on_crash_fires_and_rows_stay_intact`'s post-crash read stays un-polled — `accepted`

**What.** `src-tauri/tests/worker_e2e.rs` still has one direct transcript read that does not poll: the read taken
after the child is SIGKILLed. It asserts presence and role, never a row count.

**Why it is safe, and why that is not a guess.** The pre-crash inline poller already confirmed the user row was
visible through `h.db` *before* the kill, which means the system row (seq 0) was already committed and visible on
the parent's connection; with the writer dead, no in-flight write can land behind it. So it cannot flake by the
#138 mechanism. The reviewer verified this against the code, not against the argument.

**Residual risk.** If a future change makes that test write rows *after* the kill, or makes the kill happen
earlier, the reasoning lapses and the read becomes racy. The guard test added by A2
(`direct_native_transcript_reads_are_capped_at_three_sites`) does **not** catch that — it counts direct call
sites, and this one is already counted as legal. So the lapse would be silent.

**Fold destination.** The reasoning already lives in the file as a comment next to the read; nothing further to
fold. Do not " tidy up" this read into `wait_for_rows` — it would convert a dead-writer read into a 30 s
timeout path for no benefit.

## 2. The Darwin census exclusion now recognises two shapes; the third is still unbounded — `recorded, not open work`

**What.** A1 added `dash_free_name()` beside `dotted_name()`, so on Darwin an external dir is excluded if its
name has a dot **or** has no dash. A name that has a dash and no dot is still a hard failure — which is what
keeps every Archimedes minter (all dash-terminated) reported, and what self-test case 18b pins.

**Why we did not go further.** The two shapes are each justified by a property our own names provably lack
(no dot: 91/91 prefixes; no dash: same 91, plus the structural `{prefix}{tag}-{uuid}` contract). A third shape
would have to be justified the same way and none is currently known. The `betaenrollmentagent` class is now
covered; a future daemon with a dash in its name is not, and would red CI *correctly* — that red is the guard
working, and the fix is a third measured shape, not a tolerance row.

**Fold destination.** `docs/features/issue-96-temp-dir-known-gaps.md` §9/§9a — **done by A1**, including the
"do not widen the tolerance table" prohibition and the Darwin-only caveat.

## 3. Whether the `macos-latest` legs actually went quiet — `open work`, closes only on CI

**What.** Neither flake reproduces locally: #139 needs a macOS daemon to create a dot-free dir in the per-user
`TMPDIR`, and #138 is a cross-process SQLite visibility race that passed in the sibling job of the same SHA. Both
fixes are proven locally only by injected-Darwin self-tests (A1) and a green Linux run (A2).

**What is NOT claimed anywhere in the shipped code or docs.** That macOS behaviour is verified from a Linux
machine. It is not, and per `AGENTS.md` it cannot be.

**Next check.** After the PR merges, watch two or three `macos-latest` runs for: the census step's
`excluded: N shape-mismatched dir(s)` line appearing with `betaenrollmentagent` among them, and
`subagent_dispatch_end_to_end_real_workers` staying green. If either re-reds, the fix is incomplete, not the test
flaky. Nothing to fold — this is a verification task with a date, not a fact.

## 4. `check-temp-dir-census.test.sh` case 13 churns on this machine — `accepted` (environmental)

**What.** Case 13 (`--self-test leaves the real census base unchanged`) intermittently reddens on this Linux box
because `/tmp` changes underneath it while nothing is running (observed 686→683, 697→694). Present at baseline
`60470d2`, before this branch; passed 3/3 and green on the wave gate.

**Why it is accepted.** The assertion is correct — the census base must not change — and a churning shared `/tmp`
legitimately violates it. CI's `/tmp` does not churn. "Fixing" this by loosening the assertion would weaken a real
guard to accommodate one developer's machine.

**If it ever bites CI,** the honest fix is to point the base at a dedicated temp root for the census, not to widen
the tolerance. Record it then; do not pre-emptively change it. Nothing to fold.

## 5. A roadmap plan that quotes insertable Rust must itself be clippy- and fmt-clean — `recorded, not open work`

**What.** A2's plan quoted a guard snippet "verbatim" that produced 6 × `clippy::doc_lazy_continuation` warnings
(a prose paragraph following a `/// 1./2./3.` doc list) and failed `cargo fmt --check` on a
`concat!(env!(…), …)` block. CI runs `clippy --all-targets -- -D warnings`, so implementing the plan *exactly as
written* would have reddened CI on formatting. The implementer fixed both with tool-suggested formatting only, no
semantic change.

**Why the vet missed it.** A reviewer reading a Rust snippet cannot see a lint. The only check that catches it is
compiling it, which is forbidden in a read-only plan vet.

**Fold destination.** This is a fact about how *this skill suite* plans, not about Archimedes' behaviour, so it
belongs to the skills rather than to `docs/features/` — and it is already recorded in full in the status file's
"Findings the children raised" section. If the roadmap/specify skills are ever revised, this is the change to
make: a plan that embeds Rust should carry a "this snippet passes `cargo fmt --check` and `clippy -D warnings`"
line, produced by actually running them in a scratch copy.

## 6. `git check-ignore` lies for tracked paths — `recorded, not open work`

**What.** A1's implementer reported "docs/roadmap/ is NOT gitignored" because `git check-ignore <path>` exited 1.
It does: for a path already in the index, plain `git check-ignore` reports nothing. `git check-ignore --no-index`
correctly prints `.gitignore:31:docs/roadmap/`. The directory **is** ignored; roadmap files enter git only via
`git add -f`, which is what this run and every prior roadmap run did.

**Why it matters beyond this run.** The same false conclusion would make a future session believe
`docs/roadmap/` deletions are recoverable from git, or that `AGENTS.md`'s "never `rm -rf docs/roadmap/`" warning is
stale. It is not stale: the untracked files in there are unrecoverable, exactly as warned.

**Fold destination.** `AGENTS.md` already carries the rule and the measurement; no change needed. If a future
session re-derives this, the command to trust is the `--no-index` form.

## 7. The issue's unmeasured figures now sit in a force-added plan file — `accepted`

**What.** Issue #139's run ids (`41188776833`, `124501049035`) and its `excluded: 5` count appear in
`docs/roadmap/macos-ci-flakes-task01-census-darwin-shape.md`, which is gitignored but was force-added so the plan
would be recorded. Outside `docs/roadmap/` there are zero hits for those strings, and the durable §9a text
attributes the 3→5 movement to the issue explicitly as *not measured here*.

**Why accepted.** A plan is a working document; the vet's requirement was that the **doc** not launder issue
numbers into measured facts, and it does not. The plan is deleted on ship, so the residue is temporary by design.

## 8. The `docs/features/` front-matter does not parse as YAML — `recorded, not open work`

**What.** Two independent agents, working on two different files in the review round, both reported that this doc's
front-matter fails a strict YAML parse: the `verified-by:` value is a multi-line block that is missing its `|` or `>`
block-scalar indicator, so PyYAML raises a `ParserError`. Both confirmed it fails **identically before their edit** —
it is pre-existing, not introduced by this branch, and this branch left it as it found it.

**Why it is not open work here.** Nothing in the repo parses these fields programmatically today: the fields are read
by humans and by agents, and the one test that reads `docs/features/`
(`src/lib/subagentSheetLayout.test.ts`) does not parse front-matter. Fixing it is a one-character change that would
touch the front-matter of an unknown number of sibling docs, which is a different slice from two macOS flakes.

**When it becomes real work:** the moment anything starts reading `status:` / `last-verified:` / `verified-by:` with a
YAML parser — a docs linter, a staleness bot, a generated index. At that point every doc with a multi-line
`verified-by` needs the block indicator, and it should be done as one sweep across `docs/features/`, not per-visit.

## 9. The read-discipline guard covers one file — `recorded, not open work`

**What.** `direct_native_transcript_reads_are_capped_at_three_sites` enforces "row-count reads must poll" inside
`src-tauri/tests/worker_e2e.rs` only. It reads that one path, and `wait_for_rows` is a private helper of it.

**What the review settled, so nobody re-opens it.** The reviewer read the three same-class reads elsewhere —
`src-tauri/tests/ipc.rs` (two sites) and `src-tauri/tests/session_native.rs` (one) — and found each one synchronises
on an **in-process** writer and asserts **presence, not a count**. None can flake by #138's mechanism (cross-process
writer + exact-count assert). **They are legal and are not latent #138s — do not open an issue to "fix the remaining
sites".** The orchestrator raised that exact framing in the review brief and the reviewer killed it with the code.

**The residual, and why it is not worth doing now.** A future *row-count* read added to `ipc.rs` or
`session_native.rs` would be unguarded. Sharing the helper and its guard across those files means promoting a private
test helper to a shared module for a failure mode that does not currently exist in those files. The honest trade is to
leave it: if a count-read flake ever appears in one of them, that is the moment to share the helper, and the guard
comes with it.

## 10. `--self-test` Case 13 has no dash-free Linux arm — `accepted`

**What.** Case 17b (`.test.sh`) pins that the dash-free shape is Darwin-only, and it runs in the `scripts` job. The
script's own `--self-test` Case 13 — which CI invokes on the macOS runner too — plants only a **dotted** dir, so the
Darwin leg's own self-test pins the Darwin-scoping of the dotted shape only.

**Why accepted.** Case 17b covers it on the Linux harness, so this is belt-and-braces, not a hole; and Case 14's
dashed negative arm already pins "the exclusion is a shape, not a wildcard" for the OR'd pair. The A1 implementer
recommended the extra arm (~6 lines, Case 13 already has the Linux scaffold) and correctly did not do it, because
`scripts/check-temp-dir-census.sh` was outside its owned file set. Do it next time Case 13 is touched, not as a
standalone change.

## Fold list — what must survive the deletion of this directory

| Item | Durable home | State |
|---|---|---|
| Two exclusion shapes; the tolerance-table prohibition; §9a's corrections; Darwin-only caveat | `docs/features/issue-96-temp-dir-known-gaps.md` §9/§9a | **folded by A1** |
| Cross-process transcript-read mechanism, and the rule that row-count reads poll | already in `src-tauri/tests/worker_e2e.rs` comments (both the converted sibling's and A2's) | **folded by A2** |
| Items 1, 4, 6, 7 above | reasoning already in code comments / `AGENTS.md` | no fold needed |
| Items 2, 3, 5 | verification task (§3), and a skills-level lesson (§5) | §3 is open work on CI; §5 belongs to the skills |
| Item 4 (ADR 0078 still said one shape) | `docs/decisions/0078-…md`, amended in place per ADR 0023's nested-note convention | **folded by the review loop** |
| Items 8, 9, 10 | pre-existing quirk / settled non-issue / deferred belt-and-braces | no fold needed — recorded here and re-derivable |
