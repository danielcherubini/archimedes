---
status: planned
task: "task01 (A1, #104): test-only pin — a write into a protected directory's own parent stays allowed"
base: 2b6bd26
parallel: none
owning-wave: A1
---

# A1 — Pin that a write into a protected directory's own PARENT stays allowed (#104)

**Issue:** https://github.com/danielcherubini/archimedes/issues/104
**Grounding:** `docs/roadmap/agent-permission-and-pins-ground-policy-exec.md` (written at `2b6bd26`, the current HEAD). This plan implements the orchestrator's task text from that report; it does not re-derive the tree.

**TEST-ONLY.** No production behaviour change is intended or permitted. Nothing here edits `access.rs`, `gate.rs`, or production `policy.rs`; a change to any of them discovered while measuring is **out of scope** and goes in the follow-up note (## Follow-up note), never into this task's diff.

## Files (the only files this task edits)

- `src-tauri/src/agent/tools/exec/tests/policy.rs` — modify: **two** new `#[tokio::test]` async tests, inserted immediately after `a_write_into_a_still_missing_protected_dir_is_refused`'s closing brace (before the `bash_ignores_the_file_boundary` doc comment), reusing that test's fixture shape minus the recreation.
- `src-tauri/src/agent/boundary.rs` — **not touched.** The grounding report (§3a, §7) shows no boundary-level pin is required: `policy.rs` already owns the LOCAL `RestoreHome` guard (`policy.rs:806`) that these fixtures need, and the premise assertions below snapshot `protected_dirs()` directly as the templates do. If the before-measurement contradicts the expected three-red baseline, STOP and hand back to the wave owner instead of widening the owned set.

## The mutation under test (ADR 0081's ancestor-peel — two observable variants)

`src-tauri/src/agent/tools/exec/access.rs::protected_refusal_text` contains the compare-under-test (verbatim):

```rust
let hit = protected
    .iter()
    .find(|dir| resolved.starts_with(crate::agent::fs_backend::canonicalize_lenient(dir)))?;
```

The re-applied trailing components are compared as plain strings, and at this seam that only ever errs toward a FALSE POSITIVE — an over-refusal. The ancestor-peel mutation makes that over-refusal real by comparing at the **canonical ancestor** and dropping the trailing components. It can be applied at two seams, which redden different sites:

- **Variant A — the shared primitive** (`src-tauri/src/agent/fs_backend.rs::canonicalize_lenient`): change `Ok(peel) => reapply(peel.canon, &peel.trailing)` to `Ok(peel) => peel.canon`. The `protected_dirs()` SNAPSHOT itself then carries peeled entries → every premise that spells the full trailing shape reddens (ADR 0081's recorded three: the two session-snapshot tests in `exec/tests/policy.rs` + `boundary::tests::protected_dirs_keep_a_missing_dir`).
- **Variant B — the compare only** (`protected_refusal_text`'s predicate): compare the entry's canonical ANCESTOR, ignoring the trailing re-applied components. The snapshot is untouched, so **all existing premises stay green — this is the mutation that survives the entire suite** and the one #104's falsifier must catch.

## Design decision — two tests, one property each (and why one test cannot do both)

The task text demands BOTH properties hold: (a) a legitimate parent write stays allowed in the case the issue describes, and (b) the pin goes red under the ancestor-peel mutation. The grounding's §5 trap: a **no-rule** parent-write fixture never reaches `protected_refusal_text` at all — a no-rule protected write dispatches by design (`write_rule_refusal` `_ => None`), so test (a) passes **vacuously** under Variant B and is decorative on its own. Making the compare run needs a user `deny` rule matching the parent — but a matching deny rule makes the write a **refusal on BOTH trees** (correct code refuses with the *rule-deny* sentence via `write_rule_refusal`'s `or_else(|| Some(rule_deny_text(...)))`; the mutated compare refuses with the *protected-guard* sentence), so a deny-rule fixture **cannot** assert `!is_error`. The grounding's §5 conclusion — "the test asserting `!is_error` goes RED" — is wrong for the deny-rule shape: correct code already refuses, so `!is_error` would fail on the GREEN tree. The discriminator under the deny rule is the **SENTENCE**, exactly as the file's own session-snapshot tests already state ("makes the WORDING the discriminating assertion rather than `is_error`").

Hence two tests, sharing one fixture skeleton (the session-snapshot shape minus the recreation):

- **Test 1 = property (a), the ADR-literal case.** No rules. `writes: Allow`. Target `$HOME/.pi/agent/allowed.md` with the protected entry `…/.pi/agent/agents` present on the snapshot but missing on disk. Asserts `!is_error` and that the file lands. This is ADR 0081's missing pin, verbatim.
- **Test 2 = property (b), the falsifier that is actually RED.** A user `deny` rule on the parent (`~/.pi/agent`), same target, same missing entry. Correct code: the deny rule insists, but the guard-membership compare must **not** match a parent file → the refusal is the **rule-deny** sentence. The mutated (Variant B) compare peels the entry to `…/.pi/agent`, which DOES prefix-match the target → the refusal becomes the **protected-guard** sentence. The wording assertion is the reddening site.

## Which assertion reddens under the mutation, and why

- **Test 2's wording assertion reddens under Variant B** — *the falsifier's own red.* Correct code, entry kept whole: `…/.pi/agent/allowed.md`.starts_with(`…/.pi/agent/agents`) is false → `protected_refusal_text` returns `None` → `write_rule_refusal` falls through to `rule_deny_text` ("is denied by the access rule `~/.pi/agent` …"). Mutated, entry peeled: `…/.pi/agent/allowed.md`.starts_with(`…/.pi/agent`) is **true** → the guard-membership sentence ("… is a protected agent-definition directory … refused in every policy") replaces the rule-deny sentence. Both wording assertions fail → **red**. (`r.is_error` is true on both trees, so it is not the discriminator — Test 2 asserts the refusal is the rule-deny one, and `!target.exists()`.)
- **Both tests' PREMISE assertion reddens under Variant A** — which is what makes the mutation count **five red, not four**. Variant A peels the snapshot entries, so `protected.contains(&home_canon.join(".pi/agent/agents"))` fails in both new tests exactly as in the two session-snapshot tests. 3 existing premise-red tests + Test 1's premise + Test 2's premise = **5**. (The 3→5 arithmetic is the issue's expectation transcribed from ADR 0081's attributed counts — **measure it; do not copy it**; see the measurement protocol.)

## The two tests (full text to add to `policy.rs`)

**Test 1** (place first):

```rust
/// (issue #104) ADR 0081's missing pin, concretely: with `writes: Allow`, a
/// target that is the PARENT of a protected entry — `$HOME/.pi/agent/allowed.md`
/// while `$HOME/.pi/agent/agents` is missing — must not be refused, and the
/// file must land. An ancestor-peel mutation of the compare would
/// prefix-match `…/.pi/agent` against this target and refuse it — the
/// over-refusal #104 exists to pin. `!r.is_error` below is the assertion that
/// EXPRESSES the property; what keeps THIS half non-vacuous is its premise
/// (the entry really is on the snapshot with its full trailing spelling),
/// which reddens under the snapshot-peel variant of the mutation. `writes:
/// Allow` is essential — under `Sandboxed` the target leaves the `cwd` and
/// dies at the boundary check, which would defeat the fixture (ADR 0081
/// prescribes it for exactly this reason).
///
/// NO rules by design: `default_rules()` is empty and a no-rule protected write
/// DISPATCHES (the gate owns the row-3 ask), so this half pins the literal
/// case the issue describes. The falsifier half that reddens ON the
/// over-refusal (the vector that needs a rule to reach the compare) is the
/// sibling fixture `a_parent_deny_rule_does_not_move_the_guard_onto_the_parent_file`.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_write_into_a_protected_dirs_parent_stays_allowed() {
    use crate::agent::policy::{AccessPolicy, FilePolicy};

    let home = temp_cwd("parent-home");
    let lock = crate::test_support::env_lock();
    let original = std::env::var_os("HOME");
    let restore = RestoreHome(original);
    // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span.
    unsafe { std::env::set_var("HOME", home.path()) };

    // `.pi/agent` EXISTS and `.pi/agent/agents` does NOT — the peel lands on
    // `.pi/agent`, so the frozen entry is canonical-with-one-trailing on every
    // platform (spelled through `canonicalize()` because macOS `temp_dir()`
    // is under `/var` → `/private/var`).
    std::fs::create_dir_all(home.path().join(".pi/agent")).unwrap();
    let home_canon = home.path().canonicalize().unwrap();
    let agents = home_canon.join(".pi/agent/agents");

    let protected = crate::agent::boundary::protected_dirs();
    assert!(
        protected.contains(&agents),
        "the snapshot must carry the not-yet-existing dir — that is the premise: {protected:?}"
    );

    let cwd = temp_cwd("parent-cwd");
    let c = ToolCtx {
        protected,
        // NO rules (`default_rules()` is EMPTY — the concatenation contract
        // has nothing appended). A rule here is deliberately absent: the
        // mutation-observable sibling test carries the `deny`, this half pins
        // the issue's literal case.
        rules: Vec::new(),
        home: Some(home_canon.clone()),
        file_policy: FilePolicy {
            writes: AccessPolicy::Allow,
            ..FilePolicy::default()
        },
        ..ctx(&cwd)
    };
    let target = home_canon.join(".pi/agent/allowed.md");
    let r = execute_tool(&c, "write", &json!({ "path": target, "content": "ALLOWED" })).await;

    assert!(
        !r.is_error,
        "a write into a protected dir's own PARENT must stay allowed: {}",
        text_of(&r)
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap_or_default(),
        "ALLOWED",
        "the file must land next to the protected entry"
    );

    drop((restore, lock));
}
```

**Test 2** (place second):

```rust
/// (issue #104 + ADR 0081) THE FALSIFIER's red half: the assertion that makes
/// the ancestor-peel mutation observable. A USER `deny` rule spelling the
/// PARENT (`~/.pi/agent`) forces `write_rule_refusal` row 1 to reach
/// `protected_refusal` — and therefore to RUN the lenient compare that is the
/// mutation under test. The deny itself refuses on BOTH trees, so the
/// discriminator is the SENTENCE: correct code keeps the entry
/// `…/.pi/agent/agents` whole, which does NOT prefix-match
/// `…/.pi/agent/allowed.md`, so the target is OUTSIDE the guard-membership
/// list and the refusal is the RULE-DENY sentence. Under the ancestor-peel the
/// entry collapses to `…/.pi/agent`, which DOES prefix-match the parent file,
/// and the refusal becomes the PROTECTED-GUARD sentence — the wording
/// assertions below redden. Without the rule there is no row-1 path and the
/// compare never runs (a no-rule protected write dispatches by design), which
/// is why the issue's literal half lives in
/// `a_write_into_a_protected_dirs_parent_stays_allowed`.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_parent_deny_rule_does_not_move_the_guard_onto_the_parent_file() {
    use crate::agent::policy::{AccessPolicy, FilePolicy};

    let home = temp_cwd("parent-rule-home");
    let lock = crate::test_support::env_lock();
    let original = std::env::var_os("HOME");
    let restore = RestoreHome(original);
    // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span.
    unsafe { std::env::set_var("HOME", home.path()) };

    std::fs::create_dir_all(home.path().join(".pi/agent")).unwrap();
    let home_canon = home.path().canonicalize().unwrap();
    let agents = home_canon.join(".pi/agent/agents");

    let protected = crate::agent::boundary::protected_dirs();
    assert!(
        protected.contains(&agents),
        "the snapshot must carry the not-yet-existing dir — that is the premise: {protected:?}"
    );

    let cwd = temp_cwd("parent-rule-cwd");
    let deny = AccessRule {
        path: "~/.pi/agent".to_string(),
        direction: RuleDirection::Write,
        decision: RuleDecision::Deny,
    };
    let c = ToolCtx {
        protected,
        rules: crate::agent::policy::default_rules()
            .into_iter()
            .chain(std::iter::once(deny))
            .collect(),
        home: Some(home_canon.clone()),
        file_policy: FilePolicy {
            writes: AccessPolicy::Allow,
            ..FilePolicy::default()
        },
        ..ctx(&cwd)
    };
    let target = home_canon.join(".pi/agent/allowed.md");
    // Premise (b): the target is OUTSIDE the guard-membership entry — the
    // exact relationship the compare under test must respect (a parent write,
    // not a write under the entry). THIS is the boundary the mutation breaks.
    assert!(
        !target.starts_with(&agents),
        "premise: the parent file must not sit under the entry itself"
    );
    let r = execute_tool(&c, "write", &json!({ "path": target, "content": "ALLOWED" })).await;

    assert!(
        r.is_error,
        "the user deny on the parent dir is a real denial — refusing: {}",
        text_of(&r)
    );
    let text = text_of(&r).to_string();
    assert!(
        text.contains("denied by the access rule"),
        "the parent FILE is outside the guard-membership list, so the refusal \
         must be the RULE-DENY sentence, not the protected-guard sentence: {text}"
    );
    assert!(
        !text.contains("protected agent-definition directory"),
        "the guard-membership compare must NOT fire for the parent file — an \
         ancestor-peel compare matches `…/.pi/agent` here and answers with the \
         protected sentence; THIS assertion reddens under that mutation: {text}"
    );
    assert!(
        !target.exists(),
        "the refusal must be honoured — nothing lands"
    );

    drop((restore, lock));
}
```

Both tests need no new imports: `AccessRule / RuleDirection / RuleDecision` (policy.rs top), `AccessPolicy / FilePolicy` (in-body `use`), `RestoreHome`, `temp_cwd`, `ctx`, `text_of`, `json!`, `execute_tool` all already resolve from the existing module imports.

Notes for the implementer:

- Both tests are **green on the clean tree by design** (they pin correct behaviour) — the TDD "fails first" evidence for a pin is the mutation-red demonstrated in Step 4, which is also the issue's evidence requirement. If either test is red on the clean tree, STOP and hand back (that would be a file bug or a widened owned-set problem, not a test to "fix").
- Do not weaken the premise assertions to make the mutation-red land only in the wording: the premise spelling is what pins the snapshot shape (issues #92/#104's regression surface). Both the premises and the wording may redden; each red family corresponds to one mutation variant.
- The `#[allow(clippy::await_holding_lock)]` on both is required (the env lock is held across `execute_tool(...).await`) — AGENTS.md: clippy must stay at 0 warnings.
- Census compliance: every scratch dir is minted through `temp_cwd(tag)` → `support.rs`'s `ScratchDir::in_env_temp("exec-", tag)` (the sole `exec-*` minter the ADR 0078 attribution table points at). No new `in_env_temp` call site, no new prefix.

## Verification commands (from `src-tauri/` — AGENTS.md facts)

- Scoped run for this module: `cargo test --lib agent::tools::exec::tests::policy`
- Single test: append `-- <exact fn name>` after a `--`, e.g. `cargo test --lib agent::tools::exec::tests::policy -- a_write_into_a_protected_dirs_parent_stays_allowed`
- The mutation measurement additionally needs `cargo test --lib agent::boundary::tests` and `cargo test --lib agent::harness::loop::tests::policy_gate` (the three module scopes where the reds live).
- AGENTS.md's fixture rule: **`cargo test --lib` does not rebuild `fake_worker`** (`src-tauri/src/bin/fake_worker.rs`); when a fixture "looks like it is lying", run `cargo build --all-targets` first. It cannot affect `exec/tests/policy.rs`, but it is the repo's stated first move when a Rust fixture misbehaves.
- `archimedes` is **ONE compilation unit** — a syntax error anywhere breaks even this scoped run; the new tests must compile together with the whole crate.
- Lint gate (reflects CI): `cargo clippy --all-targets` = 0 warnings; `cargo fmt --check` clean.

## Mutation measurement protocol (predictions are NOT measurements — record the REAL numbers)

The task text's "5 red vs 4" and ADR 0081's "3 red" are **attributed** counts (the ADR ran no `cargo`). Measure at your own HEAD, both before and after adding the two tests. The temporary mutation edits below are **measurement scaffolding only** — revert them before committing; the final diff touches only `policy.rs`.

1. **Variant A** (`fs_backend.rs::canonicalize_lenient`: `Ok(peel) => peel.canon`, dropping the reapply). Run the three module scopes. Expected before the pin: **3** red — `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`, `a_write_into_a_still_missing_protected_dir_is_refused`, `boundary::tests::protected_dirs_keep_a_missing_dir` — all failing on their premise assertion with a non-empty WRONG list.
2. **Variant B** (`access.rs::protected_refusal_text`'s predicate comparing only the peeled ancestor). Run the three module scopes. Expected before the pin: **0** red — this is the mutation #104 says "survives the entire existing suite".
3. Add the two tests on the clean tree and re-run both variants:
   - Variant A: both new tests' premises redden → **5 total** (3 + 2), matching the issue's "five red, not four".
   - Variant B: **1 red** — `a_parent_deny_rule_does_not_move_the_guard_onto_the_parent_file` on its wording assertion. Test 1 stays green (no-rule dispatch, vacuously immune by design — its role is the literal pin).
4. Revert both mutation edits; run `cargo test --lib agent::tools::exec::tests::policy` — all green.

Report the **measured** before/after numbers (which may differ from the predictions; the grounding reasoned from assertion texts, it did not run cargo). If Variant B does not redden the new fixture (e.g. the build differs from the grounding's tracing), do not weaken anything to force it — record the finding and hand back.

## Steps

- [ ] **1.** Write Test 1 (`a_write_into_a_protected_dirs_parent_stays_allowed`) in `policy.rs` after `a_write_into_a_still_missing_protected_dir_is_refused`. Run `cargo test --lib agent::tools::exec::tests::policy -- a_write_into_a_protected_dirs_parent_stays_allowed` — must be GREEN on the clean tree.
- [ ] **2.** Write Test 2 (`a_parent_deny_rule_does_not_move_the_guard_onto_the_parent_file`) directly after it. Run the same scoped command with its name — must be GREEN on the clean tree.
- [ ] **3.** Baseline measurement: apply Variant A, run the three module scopes, record the real before-count (predict 3); revert. Apply Variant B, run them, record (predict 0); revert.
- [ ] **4.** After-pin measurement: apply Variant A → record (predict 5, issue's "five red, not four"); apply Variant B → confirm the new fixture reddens on its wording assertion (predict 1 red) while Test 1 stays green; revert.
- [ ] **5.** Clean-tree gate for this module: `cargo test --lib agent::tools::exec::tests::policy` all green; `cargo test --lib agent::boundary::tests` and `cargo test --lib agent::harness::loop::tests::policy_gate` untouched-green (must not have regressed); `cargo fmt --check`, `cargo clippy --all-targets` (0 warnings). If a fixture looks like it is lying, `cargo build --all-targets` first.
- [ ] **6.** Commit (`.md` plan file is committed by the orchestrator; the implementer commits the `policy.rs` change) with a message that states the **measured** mutation delta — e.g. "the pin makes the ancestor-peel mutation redden 5 tests where it reddened 3 (measured at this HEAD; Variant B, the compare-only peel, reddens exactly the new wording fixture)" — so a future reader can re-run the falsifier without re-deriving the numbers.

## Acceptance criteria

1. `a_write_into_a_protected_dirs_parent_stays_allowed` exists in `policy.rs`, is `#[tokio::test]`, `writes: Allow`, target `$HOME/.pi/agent/allowed.md` while `…/.pi/agent/agents` is missing, asserts `!is_error` and that the file lands — green on the clean tree.
2. `a_parent_deny_rule_does_not_move_the_guard_onto_the_parent_file` exists beside it with the `~/.pi/agent` deny, asserting the rule-deny sentence and the ABSENCE of the protected-guard sentence, and asserting nothing landed — green on the clean tree.
3. The commit message states the MEASURED mutation-before/after counts (Variant A and B), not the copied 3→5.
4. The final diff touches only `policy.rs`; `boundary.rs`, `access.rs`, `gate.rs`, `fs_backend.rs` are byte-identical to `2b6bd26`.
5. `cargo test --lib agent::tools::exec::tests::policy` green; `cargo clippy --all-targets` 0 warnings.

## Parallelisation

Serial — this is a single roadmap task with one owned file set, so parallelisation is trivially satisfied.

## Follow-up note (out-of-scope findings land here, not in the diff)

- The grounding report's §5 proposed shape for the deny-rule fixture (assert `!is_error` so the mutation "refuses → red") is **wrong** and is deliberately not implemented: a matching deny rule refuses on the correct tree too (the rule-deny sentence, via `write_rule_refusal`'s `or_else(|| Some(rule_deny_text(...)))`), so `is_error` cannot discriminate — the sentence does. The plan above implements the row-1-forcing mechanism the task text names, with the corrected discriminator.
- If measurement shows a production change is genuinely required for either acceptance criterion to hold (it should not be), that is out of scope for this test-only task: record it here for the wave owner / a follow-up task.
- Nothing else was found that needs a production edit: the existing three premise-red tests remain the Variant-A falsifiers, and Variant B has exactly one new victim after this task.