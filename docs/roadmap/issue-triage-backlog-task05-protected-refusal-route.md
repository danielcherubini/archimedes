---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 33
done-when: A `write`/`edit` into `~/.agents/skills` (or any `boundary::protected_dirs()` entry) comes back with the SAME refusal sentence it always had, now followed by the reason and the sanctioned route — "Write the file under your session directory instead and ask the user to move it into place (the `ask` tool)." — and no elevated or shell route (`sudo_exec`, `bash`) is named anywhere in it; the gate-level denial of the same write ends with the identical string; the whole gate is green (Rust 1360 / 0 failed / 4 ignored, clippy 0 warnings, fmt clean, FE 3051 tests / 149 files, `pnpm build` 0).
---

# Task 5 — The protected-dir refusal names the sanctioned route (issue #33)

**Goal:** One format string changes. The refusal that a write into a user-level agent-definition directory gets today says the write is refused in every policy and suggests NOTHING; it must keep that refusal sentence byte-for-byte and gain two sentences after it — why the floor exists, and the one route the guard-rail was designed to have: write it somewhere else and ask the human to move it.

**Architecture:** `protected_refusal_text` in `src-tauri/src/agent/tools/exec/access.rs` is the ONE producer of this sentence; it is called by both layers that can refuse a protected write — the executors (`exec/fs_tools.rs`: `exec_write` / `exec_edit`, via `protected_refusal`) and the harness policy gate (`agent/harness/loop/gate.rs::deny_tool_result`) — so editing the one string moves both call sites at once and cannot desynchronise them. The new reason + route text is lifted into a single `pub(crate) const PROTECTED_WRITE_ROUTE` in the same module, so the two test families (executor-side and gate-side) assert against the SAME value instead of two literals that can drift, and so the "names no elevated tool" claim can be linted on the const rather than on a message that interpolates a filesystem path. Three files change, exactly the three the parent roadmap's T5 seam column names.

**Tech Stack:** Rust 2021, `std::fmt` only. No new dependency, no new module, no signature change to `protected_refusal_text`.

---

## Parallelisation

**Verdict:** SERIAL — this is one task of the issue-triage backlog, and the parent doc already puts T5 in the serial column. The reason is the compile unit, not the file list: `archimedes` (`src-tauri/Cargo.toml`, lib name `archimedes_lib`) is ONE compilation unit, so `cargo test` / `cargo clippy` compile the whole crate no matter how narrowly the test filter is scoped. A sibling task mid-edit on any other `.rs` file turns this task's RED/GREEN signal into a compile error that belongs to neither task. The parent doc measured this with a planted-syntax-error experiment and collapsed the original 5-wave plan to serial for exactly this reason — **do not "re-parallelise" it.**

Consequence for the executor: **run the FULL gate**, not a scoped run — `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/`, and `pnpm test`, `pnpm build` from the repo root. There is nothing to gain from scoping (`cargo test --lib <filter>` still builds the crate), and the gate is the only thing standing between this commit and a regression in the two families of wording tests.

---

## Context — why this exists, and what was verified against the tree

Issue #33: an agent editing a global skill (`write` into `~/.agents/skills/release/SKILL.md`, session policy at the shipped default `reads/writes/shell = allow`) got:

```
write: /home/daniel/.agents/skills/release/SKILL.md is a protected agent-definition
directory (/home/daniel/.agents/skills) — writing there is refused in every policy
```

That sentence is true, is a deliberate guard-rail, and is asserted by tests — but it suggests no route. In the SAME turn, `bash` → `cat > ~/.agents/skills/…` lands (ADR 0030 records `Shell = Allow` being unrestricted as intended), and `sudo_exec` writes there after a human confirm. So the model read "refused in every policy" next to two paths that work, inferred the guard was an obstacle, and volunteered `sudo_exec` to the user for a markdown file. The reporter agrees with the floor and asks only that the message point at the right answer: **write it to a staging path and ask the human to move it.**

### Verified against the tree (trust this, not the issue text)

- **The seam is one format string.** `protected_refusal_text(protected: &[PathBuf], tool: &str, resolved: &Path) -> Option<String>` in `src-tauri/src/agent/tools/exec/access.rs` ends in a single `format!` whose literal is currently:
  `"{tool}: {} is a protected agent-definition directory ({}) — writing there is refused in every policy"`.
  Its doc comment states the load-bearing constraint: the function is split out of `protected_refusal` so the GATE refuses a protected write in EXACTLY the executor's words, because two copies of that sentence would drift and a gate-level deny reading differently from the executor-level one is indistinguishable from a bug. **Read that doc comment before editing.** Everything below keeps that property: one string, both call sites.
- **Both call sites, confirmed.** Executor side: `exec_write` and `exec_edit` in `src-tauri/src/agent/tools/exec/fs_tools.rs` each call `protected_refusal(ctx, "write"|"edit", &resolved)` immediately after `backend.validate(...)` and `return ToolResult::fail(msg, None)` — the message goes to the model verbatim, no prefix added. Gate side: `deny_tool_result` in `src-tauri/src/agent/harness/loop/gate.rs` calls `protected_refusal_text(&self.protected, &tc.name, path)` for a `PolicyDirection::Write` DENY and, on `Some(msg)`, uses it as the tool-result text INSTEAD of the boundary's `"escapes the session sandbox"` wording. `protected_refusal` (access.rs) is a one-line delegate to `protected_refusal_text`. Re-export seam: `pub(crate) use access::protected_refusal_text;` in `src-tauri/src/agent/tools/exec.rs`.
- **The floor itself is correct and untouched by this task.** `boundary::protected_dirs()` (`src-tauri/src/agent/boundary.rs`) is the four user-level dirs (`~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents`), canonicalized, missing dirs dropped; `docs/decisions/0030-file-access-policy.md` §"The write floor" calls it a *"guard-rail, not a security boundary"*, refused "as a deny, never a prompt, never widened by Trust". The canonical-comparison machinery in `protected_refusal_text` (entries canonicalized at compare time, argument through `canonicalize_lenient`) is a real macOS/Windows bypass fix — **do not touch the comparison logic, the `resolved`/`hit` interpolation order, or which entry the message names** (the message must keep naming the caller's ORIGINAL entry spelling; `a_raw_protected_entry_still_refuses_a_canonical_path_under_it` pins that).
- **`sudo_exec` really does not consult the deny-list.** `src-tauri/src/agent/interactive/sudo_exec.rs` and `src-tauri/src/agent/interactive/sudo_argv.rs` contain ZERO occurrences of `protected`. That is ADR 0030's intent (a human-confirmed elevated write is outside the file-access policy) and is NOT a bug this task fixes — see *Out of scope*.
- **The refusal text is produced nowhere else.** Searching `src-tauri/src` and `src-tauri/tests` for `protected agent-definition` / `refused in every policy`, the ONLY producer is that one `format!`. Everything else is a test or prose (ADR 0030, `boundary.rs` / `access.rs` doc comments, and the unrelated Settings copy in `src/components/settings/GeneralSection.tsx`).
- **The const needs NO new re-export — and adding one would RED the lint bar.** `access` is declared `pub mod access;` in `src-tauri/src/agent/tools/exec.rs`, and the chain up is `pub mod exec;` (`tools.rs`) → `pub mod tools;` (`agent/mod.rs`) → `pub mod agent;` (`lib.rs`). So a `pub(crate) const` in `access.rs` is already reachable crate-wide by its full path, `crate::agent::tools::exec::access::PROTECTED_WRITE_ROUTE`, from BOTH test files. The trap to avoid: a bare `pub(crate) use access::PROTECTED_WRITE_ROUTE;` in `exec.rs` is an **unused import in the non-test build** (its only consumers are `#[cfg(test)]` modules) and `unused_imports` fires — measured on this host with a standalone `rustc --edition 2021` reproduction: an ungated `pub(crate) use` of a const used only by test code warns, and even a `#[cfg(test)]`-gated one warns in the test build when nothing in that build consumes it. `cargo clippy --all-targets` must be **0 warnings**, so do not add that re-export. (The existing `pub(crate) use access::protected_refusal_text;` is fine because non-test code — `gate.rs` — consumes it.) A `#[cfg(test)] #[allow(unused_imports)] pub(crate) use …` form (the pattern `exec.rs` already uses for the `bash` / `fs_tools` / `search` / `skills` test re-exports) would also work, but it is unnecessary indirection here: **use the full path in the tests and leave `exec.rs` untouched.**

### Every test that observes this wording (by its assertion)

Wording is asserted by substring everywhere — no test does a full-string equality on the refusal, so appending a sentence cannot break any of them. Still, each is listed so the executor can confirm rather than discover:

| Test | File | Current assertion |
|---|---|---|
| `write_into_a_protected_dir_is_refused_under_every_policy` | `src-tauri/src/agent/tools/exec/tests/policy.rs` | `assert!(text.contains("protected"), "{policy_writes:?}: {text}")` — runs for all three `AccessPolicy` tiers |
| `a_raw_protected_entry_still_refuses_a_canonical_path_under_it` | `src-tauri/src/agent/tools/exec/tests/policy.rs` | `assert!(text.contains("protected"), "{text}")` + `text.contains(&protected.to_string_lossy()…)` ("the refusal must name the entry as the caller spelled it") |
| `a_raw_argument_still_refuses_against_canonical_protected_entries` (`#[cfg(unix)]`) | `src-tauri/src/agent/tools/exec/tests/policy.rs` | `refusal.contains("protected agent-definition directory")` and `again.contains("protected agent-definition directory")` — the direct `protected_refusal_text` seam |
| `a_gate_denial_of_a_protected_dir_uses_the_protected_wording` | `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` | `text.contains("protected agent-definition directory")` with message `"the refusal names the real reason, got {text:?}"` — **the GATE-side wording pin; this is the one the issue text missed ("local to `exec.rs`" is wrong)** |
| `a_symlinked_home_yields_canonical_roots_and_still_denies_writes` | `src-tauri/tests/skill_tools_boundary.rs` | `text_of(&r).contains("protected")`, message `"the refusal must name the reason"` — integration-level, executor path |

Non-tests that mention the phrase in prose only (no edit needed, no failure risk): `docs/decisions/0030-file-access-policy.md` §The write floor, the `boundary::protected_dirs` doc comment, and the long `protected_refusal_text` doc comment (it quotes `"refused in EVERY policy"` while explaining the canonicalization — still true after this change).

Frontend: `src/components/settings/SettingsPage.test.tsx`'s `the_file_access_rows_state_the_honest_default` asserts `rowOf("Writes").textContent` contains `"agent-definition"`, sourced from `src/components/settings/GeneralSection.tsx`. That is Settings copy, not the tool refusal — **do not touch it**; it is listed only so a green `pnpm test` is not mistaken for a coincidence.

---

## The wording decision (read this before typing the string)

The issue proposes:

> `…refused in every policy — write it to a staging path and ask the user to move it (or, if they approve an elevated write, sudo_exec).`

**Rejected as written.** The refusal text is the text the model reads at the exact moment of decision, and the complaint this task exists to fix is that the model reached for `sudo_exec` too readily. Putting the string `sudo_exec` in the refusal names an elevated, password-backed, human-confirm tool inside a message about a markdown file — it advertises a tool the model may not otherwise have considered, and the parenthetical supplies the justification ("if they approve") the model can pre-empt by simply asking. The refusal would then be doing the opposite of what the issue asks for, in the one place that shapes behaviour. `bash` is the same trap one level down: at `Shell = Allow` it lands in one command, so naming any shell route is naming the bypass.

**Chosen wording** (the existing refusal sentence is kept byte-identical and terminated with a full stop; the reason and the route are APPENDED as new sentences — minimal diff, and every existing substring assertion keeps passing):

```
{tool}: {resolved} is a protected agent-definition directory ({hit}) — writing there is refused in every policy. This is by design: these directories are the agent's own instructions. Write the file under your session directory instead and ask the user to move it into place (the `ask` tool).
```

Verified by compiling and running this exact `format!` + const pair with `rustc --edition 2021` on this host; the program printed:

```
write: /home/x/.agents/skills/release/SKILL.md is a protected agent-definition directory (/home/x/.agents/skills) — writing there is refused in every policy. This is by design: these directories are the agent's own instructions. Write the file under your session directory instead and ask the user to move it into place (the `ask` tool).
```

and `rustfmt --edition 2021` left that file unchanged (rustfmt does not wrap string literals; the pre-existing literal is already 111 columns).

Why each piece:

- **`This is by design: these directories are the agent's own instructions.`** — the reframe the issue is actually about. "in every policy" reads as *an obstacle that happens to be strong*; naming the reason (a model that rewrites `SKILL.md` rewrites itself in every future session — ADR 0030's own words) makes it read as a guard-rail with an intentional shape, which is what stops the "route around it" inference. It also gives the model something to reason with instead of a bare prohibition.
- **The route is staging + a human, and nothing else.** `Write the file under your session directory instead and ask the user to move it into place` is the route the reporter says "works, and NOTHING SUGGESTS IT". It is the only route that cannot be self-served: it terminates in a human action, so there is no version of it the model can complete alone.
- **`(the `ask` tool`)`** — the sanctioned prompt-the-human mechanism exists and is advertised (`ask` in `src-tauri/src/agent/harness/tool_specs.rs`), so naming it turns advice into an action the model can take this turn. Naming a route that REQUIRES a human reply carries no amplification risk — the failure mode of `sudo_exec` was that the model could satisfy it by asking a leading question and taking the yes; `ask` with a staging path hands the decision to the human with the file already prepared, which is the posture we want.
- **No signature change.** The message does not interpolate the session `cwd`: `protected_refusal_text` does not receive it, and threading it in would change the signature and both call sites plus the test call shapes, for a path the model already has in its context (the `<cwd>` section built in `src-tauri/src/agent/harness/prompt.rs`). "your session directory" is the phrase; the model resolves it.
- **One honesty trap avoided.** Do NOT write "only a human can write here" / "nothing else can write here". At `Shell = Allow` a shell redirect lands there, and ADR 0030 says so out loud; a model that disproves the message in one command stops trusting the rest of it. The refusal's scope is exactly what `{tool}` says — this tool refuses — plus the reason and the route.

**The trade-off, stated honestly.** Not naming `sudo_exec` means a genuinely legitimate elevated write (a user who *wants* a system-level file placed, and would have approved it) gets no signpost from this message, and the model has to be told by the human instead. That is the accepted cost: `sudo_exec` is discoverable from its own tool spec whenever the human asks for it, whereas the refusal is read in the moment of temptation over a skill file. The asymmetry is deliberate — this task is about which route is *suggested*, not which routes *exist*. The routes the message must never suggest (`sudo_exec`, the shell) are pinned by the negative assertion on the const in *What to implement*, so the decision survives future rewording.

---

## Out of scope (do not design, do not implement)

- **Proposal 2 — a human-gated confirmation prompt for writes into `protected_dirs`.** It contradicts ADR 0030's "as a deny, never a prompt, never widened by Trust" and would need its own ADR. Recorded here as explicitly out of scope; no code, no test, no half-implementation (no `Ask` branch, no new `Decision` variant, no policy key).
- **Making the floor policy-dependent, or narrowing the four dirs.** The floor stays a deny in every policy.
- **Teaching `sudo_exec` or `bash` about `protected_dirs`.** ADR 0030 documents the asymmetry as intended; ADR-level changes are not this task.
- **Any change to the canonicalization logic** in `protected_refusal_text` (entry canonicalization, `canonicalize_lenient`, or which entry the message displays).
- **Settings copy** (`GeneralSection.tsx`) and ADR 0030's text.

---

## Files

- Modify: `src-tauri/src/agent/tools/exec/access.rs` — the `format!` in `protected_refusal_text`, one new `pub(crate) const PROTECTED_WRITE_ROUTE`, one doc-comment paragraph.
- Modify (tests): `src-tauri/src/agent/tools/exec/tests/policy.rs` — route + no-elevated-route assertions in `write_into_a_protected_dir_is_refused_under_every_policy`; route assertion in `a_raw_argument_still_refuses_against_canonical_protected_entries`.
- Modify (tests): `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — the gate-side twin of the same assertion in `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`.
- Do NOT touch: `src-tauri/src/agent/tools/exec.rs` (no re-export — see the verified fact above), `exec/fs_tools.rs`, `harness/loop/gate.rs`, `boundary.rs`, `interactive/sudo_exec.rs`, `tools/sandbox.rs`, `harness/tool_specs.rs`, `src/components/**`, `docs/decisions/0030-file-access-policy.md`, `docs/roadmap/issue-triage-backlog-status.md` (the orchestrator owns the status doc and the changelog line).

---

## What to implement

### 1. `src-tauri/src/agent/tools/exec/access.rs` — the const, the string, the doc note

**ALL of the new wording lives in one `pub(crate) const`** — both new sentences, not just the imperative. This is what makes the negative assertions in items 2 and 3 airtight and platform-proof (see the note under item 2): the refusal then equals *the pre-existing sentence* + `" "` + *the const*, so a test can pin `ends_with(CONST)` and lint the const, without ever pattern-matching over an interpolated path.

Add at module level (above `protected_refusal`), with a doc comment that carries the decision so the next reader does not "helpfully" add `sudo_exec` back:

```rust
/// The reason + the route the protected-write refusal appends after the
/// refusal sentence: this is by design, and the sanctioned way to get the
/// file there is to stage it in the session and let the HUMAN move it into
/// place. Deliberately the ONLY route the refusal names — `sudo_exec` and the
/// shell can both reach these dirs and both are documented as intended
/// (ADR 0030: a guard-rail, not a security boundary), but the refusal is read
/// at the moment of decision, and naming an elevated route there is what sent
/// the reporting agent reaching for one over a markdown file (issue #33).
/// Pinned negative by `write_into_a_protected_dir_is_refused_under_every_policy`
/// and by the gate's `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`.
pub(crate) const PROTECTED_WRITE_ROUTE: &str = "This is by design: these directories are the agent's own instructions. Write the file under your session directory instead and ask the user to move it into place (the `ask` tool).";
```

Then change ONLY the tail of the existing `format!` — the `{tool}` / `{}` / `({})` parts, their order, and the sentence through `…in every policy` stay exactly as they are (only the trailing `— writing there is refused in every policy` gains a `.` and the appended const):

```rust
Some(format!(
    "{tool}: {} is a protected agent-definition directory ({}) — writing there is refused in every policy. {PROTECTED_WRITE_ROUTE}",
    resolved.display(),
    hit.display()
))
```

Notes:
- `{PROTECTED_WRITE_ROUTE}` (inline named-arg capture of a const) compiles under edition 2021 — verified on this host by compiling the exact const + `format!` pair above with `rustc --edition 2021`. If the executor's toolchain ever disagrees, `… in every policy. {}", …, PROTECTED_WRITE_ROUTE` is the equivalent fallback. Do not restructure anything else to work around it.
- The literal line is long (~127 columns). `rustfmt` does not wrap string literals and the pre-existing literal is already 111 columns, so `cargo fmt --check` stays clean — verified with `rustfmt --edition 2021` on a standalone file containing exactly this const + `format!`. Run the check and confirm; do not hand-wrap the literal (an implicit `concat!` of two string pieces would also change what `ends_with` sees).
- Add ONE short paragraph to the `protected_refusal_text` doc comment (after the existing "why this function is split out" prose, before the `# The comparison is CANONICAL on both sides` heading): that the refusal carries a reason + a suggested route, that they live in `PROTECTED_WRITE_ROUTE` so both test families assert the same value, and that the gate gets them for free because it calls this function — which is the whole reason the split exists. Do not rewrite or shorten the existing canonicalization prose.

### 2. `src-tauri/src/agent/tools/exec/tests/policy.rs` — executor-side assertions

The const is reached by its full path — no re-export is needed (see the verified fact above), and adding one would fail the 0-warning bar. The file's existing import of `protected_refusal_text` is `#[cfg(unix)]`-gated because only the unix-only test uses it; leave that alone and add an ungated import for the const at the top of the file:

```rust
use crate::agent::tools::exec::access::PROTECTED_WRITE_ROUTE;
```

In `write_into_a_protected_dir_is_refused_under_every_policy`, right after the existing `assert!(text.contains("protected"), …)` inside the policy-tier loop, add the route pin and the negative pin:

```rust
// (issue #33) The refusal must not just refuse — it must append the ONE
// route that ends in a human, and that route must not name an elevated or
// shell path. Pinned against the const, not a literal, so the executor side
// and the gate side cannot drift apart.
assert!(
    text.ends_with(PROTECTED_WRITE_ROUTE),
    "{policy_writes:?}: the refusal must end with the sanctioned route: {text}"
);
assert!(
    !PROTECTED_WRITE_ROUTE.contains("sudo")
        && !PROTECTED_WRITE_ROUTE.contains("bash")
        && !PROTECTED_WRITE_ROUTE.contains("shell"),
    "the refusal must not suggest an elevated or shell route: {PROTECTED_WRITE_ROUTE}"
);
```

**Why the negative pin lints the CONST and not `text`.** The refusal interpolates the resolved path and the protected entry, so a `!text.contains("bash")` assertion would be reading the *test fixture's* path spelling as if it were the message — and it is not platform-proof: a CI runner whose temp dir contains a username like `bashir` or `sudo_admin` would redden the test with nothing wrong in the code. Linting the const is exactly the claim being made ("the route we suggest names no elevated tool"), is true or false independent of the machine, and cannot be satisfied by accident. The positive pin uses `ends_with`, not `contains`, for the same reason: it proves the sentence arrived in the executor's own words at the end of the refusal, and it is likewise unaffected by what the path looks like. In `a_raw_argument_still_refuses_against_canonical_protected_entries` (unix-only), after the first `refusal.contains("protected agent-definition directory")` assertion, add:

```rust
assert!(
    refusal.ends_with(PROTECTED_WRITE_ROUTE),
    "the gate-seam wording must carry the route too: {refusal}"
);
```

### 3. `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — the gate-side twin

In `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`, immediately after the existing `text.contains("protected agent-definition directory")` assertion, add:

```rust
// (issue #33) The route is part of the sentence the two layers must agree
// on: a gate denial that refused without pointing anywhere is exactly the
// drift this shared text exists to prevent. Asserted against the SAME const
// the executor-side test uses, by its full path (no re-export).
assert!(
    text.ends_with(crate::agent::tools::exec::access::PROTECTED_WRITE_ROUTE),
    "the gate's refusal must end with the sanctioned route, got {text:?}"
);
```

One negative pin (the const lint) is enough and it lives in the executor test — repeating `!CONST.contains("sudo")` in a second file would be a tautology that tests the const twice rather than testing the gate. What the gate side needs to prove is the *agreement* claim, and `ends_with` on the shared const is exactly that.

Do not change the earlier assertions in that test (`"a protected write is a Deny, never a prompt"`, `!target.exists()`) — they pin the floor and are the reason this test still proves the security posture is untouched.

`ends_with` is safe on the gate side: `deny_tool_result` puts the const-bearing message into the `ToolResult` text verbatim (nothing is appended after it), and the gate path is only taken for a `PolicyDirection::Write` DENY, where the deny-list sentence wins over `escapes the session sandbox` — which is what the pre-existing `contains("protected agent-definition directory")` assertion already proves.

**No new `#[test]` functions.** Every assertion above goes into an existing test, so the Rust test count stays exactly where the baseline says it is.

---

## Steps

- [ ] Read the doc comment of `protected_refusal_text` in `src-tauri/src/agent/tools/exec/access.rs`, and `deny_tool_result` in `src-tauri/src/agent/harness/loop/gate.rs`, so the one-string constraint is understood before editing.
- [ ] RED, part 1 — add `PROTECTED_WRITE_ROUTE` (item 1, first bullet ONLY — do not touch the `format!` yet) and the assertions (items 2 and 3). The const must exist first or the test module will not compile, which is a RED that proves nothing.
  - Expected side effect at this stage: the non-test build may warn `constant PROTECTED_WRITE_ROUTE is never used` (`dead_code`), because nothing in non-test code reads it until the `format!` changes. That is fine — this stage runs `cargo test` only. Do NOT add an `#[allow(dead_code)]` to silence it; the next step removes it by using the const in the `format!`.
- [ ] `cd src-tauri && cargo test --lib policy`
  - Expected: RED with the assertion message `"the refusal must end with the sanctioned route"` from `write_into_a_protected_dir_is_refused_under_every_policy`. If it passes, the assertion is vacuous — stop and fix it. If it fails to compile, the const's path/name is wrong — fix that, not the assertion.
- [ ] `cd src-tauri && cargo test --lib a_gate_denial_of_a_protected_dir_uses_the_protected_wording` → RED with `"the gate's refusal must end with the sanctioned route"`. Both families must be RED before the wording changes, or the gate-side assertion is not actually observing the shared string.
- [ ] GREEN — apply the `format!` change and the doc paragraph (item 1, remaining bullets).
- [ ] `cd src-tauri && cargo test --lib policy` → GREEN, including all three policy-tier-loop iterations and the unix-only canonicalization tests.
- [ ] `cd src-tauri && cargo test --lib a_gate_denial_of_a_protected_dir_uses_the_protected_wording` → GREEN.
- [ ] `cd src-tauri && cargo test --test skill_tools_boundary` → GREEN (the integration-level `contains("protected")` pin).
- [ ] Full gate, in order:
  - `cd src-tauri && cargo test` → **1360 passed, 0 failed, 4 ignored** (measured at this HEAD; the parent doc's Gate section still shows the older 1355/3049 from before T2/T3 — use these numbers). No new test was added, so 1360 must not move.
  - `cd src-tauri && cargo clippy --all-targets` → **0 warnings** (AGENTS.md bar). This is where an accidentally-added re-export shows up as `unused_imports` — if it fires, DELETE the re-export and use the full path, do not silence it with `#[allow]`.
  - `cd src-tauri && cargo fmt --check` → exit 0. If it complains, it is about your own new lines — run `cargo fmt` and re-read the diff to be sure it touched only your files.
  - `pnpm test` (repo root) → **3051 tests / 149 files passed**. This task touches no frontend file; a frontend failure means a sibling's edit is in the tree — stop and report, do not fix it here.
  - `pnpm build` (repo root) → exit 0.
- [ ] Sanity-read the final message: re-read the `format!` and the const side by side and write out what the model will see. It must read as ONE refusal sentence (unchanged through `…in every policy.`) plus the reason sentence plus the route sentence; the route must name no elevated or shell tool; and the refusal must still name the protected entry as the caller spelled it (`hit.display()`, not the canonicalized form).
- [ ] Commit ONLY the three files above:
  `git add src-tauri/src/agent/tools/exec/access.rs src-tauri/src/agent/tools/exec/tests/policy.rs src-tauri/src/agent/harness/loop/tests/policy_gate.rs && git commit -m "fix(tools): the protected-dir refusal names the sanctioned route (#33)"`
  - Do not stage `docs/roadmap/issue-triage-backlog-status.md` — the orchestrator marks T5 `done` and writes the Changelog line.

---

## Acceptance criteria

- [ ] `protected_refusal_text`'s refusal still begins with the existing sentence, unmodified through `…refused in every policy`, and still interpolates `{tool}`, the resolved path, and the ORIGINAL entry spelling in that order.
- [ ] The refusal now ends with the staging + ask-the-user route, sourced from `pub(crate) const PROTECTED_WRITE_ROUTE` in `exec/access.rs` and asserted from that const (by its full path) on BOTH sides — no new re-export in `exec.rs`, which stays byte-unchanged.
- [ ] The suggested route names **no** elevated or shell path: `PROTECTED_WRITE_ROUTE` contains none of `sudo`, `bash`, `shell`, asserted by the negative pin in `write_into_a_protected_dir_is_refused_under_every_policy`. (The pin lints the const, not the rendered message, because the message interpolates a filesystem path — a fixture username could otherwise satisfy or break it on some machine and the assertion would be measuring the wrong thing.)
- [ ] Executor-side and gate-side tests assert the SAME constant, so the two layers cannot word the refusal differently; the gate still produces the deny-list sentence (not `escapes the session sandbox`) for a protected write, and still never prompts (`"a protected write is a Deny, never a prompt"` stays green).
- [ ] Nothing about the floor changed: `protected_dirs()` is still the four user-level dirs; `write_into_a_protected_dir_is_refused_under_every_policy` still refuses at `Sandboxed`, `Ask` AND `Allow` with the file byte-untouched; `a_symlinked_home_yields_canonical_roots_and_still_denies_writes` still refuses through the symlinked `$HOME`; `interactive/sudo_exec.rs` is unmodified.
- [ ] `src-tauri/src/agent/tools/exec/access.rs`'s doc comment records WHY no elevated route is named (with the issue number), so the decision is not silently reversed later.
- [ ] Full gate green: `cargo test` = 1360 passed / 0 failed / 4 ignored (count unchanged — no new test), `cargo clippy --all-targets` = 0 warnings, `cargo fmt --check` = exit 0, `pnpm test` = 3051 tests / 149 files, `pnpm build` = exit 0.
- [ ] Exactly one commit, message `fix(tools): the protected-dir refusal names the sanctioned route (#33)`, containing only the three files listed under *Files*.
