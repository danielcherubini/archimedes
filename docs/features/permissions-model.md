---
status: live
last-verified: 2026-10-28
verified-by: read against this tree on `feature/permissions-section` (working tree, T03/T04 not yet committed) — `agent/policy.rs` (`rule_for`, `default_rules`, `FilePolicy`), `agent/boundary.rs` (`protected_dirs`, `push_protected`), `agent/harness/loop.rs` + `loop/gate.rs` (the four rows, `is_guard_path`, `guard_target`, `gate_tool`), `agent/permission.rs` (`permission_options`), `agent/tools/exec/access.rs` (`write_rule_refusal`, `read_rule_refusal`, `protected_refusal_text`), `agent/tools/sandbox.rs` (the Landlock subtraction), `agent/session/mod.rs` + `config.rs` (the relay, `load_mutate_write`, `write_settings_atomic`, `append_rule`), `components/settings/PermissionsSection.tsx` — every claim re-read against the tree, not copied from the plan. Doc gate run here: `npx vitest run src/lib/subagentSheetLayout.test.ts` (this page is NOT in that test's `PROSE` list, so it cannot break it); `pnpm test` + `pnpm build` and the cargo legs are the wave-close gate, run by the orchestrator, and are NOT claimed by this stamp.
---

# Permissions model — posture and rules; the self-modification guard is an ask

Two kinds of setting decide what a **Session** may touch on your disk. The first is the one that has existed since [ADR 0030](../decisions/0030-file-access-policy.md): a **posture** per direction. The second is new: a list of **rules**. The thing that changed most is neither of them — it is what happens when neither has an opinion about a write into the agent's own instruction directories. It used to be a silent refusal. It is now a question. See [ADR 0083](../decisions/0083-the-self-modification-guard-is-an-ask-when-no-rule-matches.md).

## The model

- **Posture** — `reads` / `writes` / `shell`, each `Sandboxed` / `Ask me` / `Don't ask me`, **defaulting to `Don't ask me` (`Allow`)**. Unchanged in meaning and in values. `Sandboxed` refuses a file tool and confines `bash`; `Ask` prompts unless the **Space** is trusted; `Allow` is silent and unlogged.
- **Rules** — a list of `{path, direction, decision}` exceptions, `decision ∈ {allow, deny}`. **USER rules only.** `direction` is required, because "`/` has read" is direction-specific, and `path` may lead with `~` (expanded at MATCH time, never at write time, so a rule survives a home-path change).

**There is no `ask` decision value.** Asking is not a setting; it is what happens when no rule matches and the guard applies. That is what keeps the vocabulary honest: a `deny` stays a `deny`.

Both live in `settings.json` under the existing `filePolicy` key (`FilePolicy { reads, writes, shell, rules }`). `rules` is serde-defaulted, so an old `settings.json` with no `rules` key parses to the new empty default, and an EMPTY list is not serialized at all — the three-direction wire shape is byte-identical for every existing install.

The four user-level agent-definition directories — `~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents` — are a **guard-membership set, not a rule set**. They are not rules, they are not defaults, and nothing in `settings.json` can add or remove them. See `## Matching`.

## Precedence

For a path-param tool, in this order:

| # | Condition | Outcome | Trust-immune |
|---|---|---|---|
| 1 | A **user** rule matches, `decision: deny` | tool-result error — never a prompt | **Yes** |
| 2 | A user rule matches, `decision: allow` | proceed silently, posture not consulted | n/a |
| 3 | No rule matches **and** the target is under an agent-definition dir | **ASK** — the **Self-modification guard** | No — it is an ask, so Trust suppresses it |
| 4 | No rule matches | the posture select, as today | as today |

**Row 3 is the only behavioural change.** Rows 1, 2 and 4 are additive: nothing changes until you add a rule, and the posture stays open.

**At the shipped defaults there are no rules at all**, so row 1 cannot fire, and an untrusted **Space** gets the guard ask while **a Trusted Space proceeds silently**. That silent proceed is the deliberate consequence of the change, and the reason the trust copy below was rewritten.

Row 3 is **Write-only**: reading `~/.pi/agent/agents/SKILL.md` is not an ask at any posture — a read with no matching rule falls to row 4, which under the default `reads: Allow` proceeds silently. A `deny` rule refuses a read exactly as it refuses a write, because row 1 is about the access, not the direction; there is simply no read-side ask anywhere.

## Matching

**Longest canonical prefix wins — never first-match.** Granting `~` read/write while denying `~/.pi/agent/agents` must not let the broad rule swallow the specific one; under first-match the guard would silently stop working, which is issue #92's failure mode relocated into the rules layer. The resolver filters to genuine **component** prefixes (`/tmp` is not a prefix of `/tmpfoo` — a string compare would say it is), ranks by canonical component count, and breaks exact ties by list position.

**Both sides go through the lenient canonicalizer** — ADR 0081's `canonicalize_lenient` ([ADR 0081](../decisions/0081-a-lenient-deny-list-entry-needs-a-lenient-compare-one-half-alone-is-a-silent-no-op.md), reference rather than restated here). A rule may name a directory that does not exist yet and still match it; a strict compare on either side would silently match nothing.

**An exact tie goes to the LAST rule**, and the runtime list is assembled by a **concatenation contract**: `default_rules()` FIRST, then the per-turn user rules, appended — assembled **once per turn**, beside the per-turn `filePolicy` re-read. **At the shipped defaults `default_rules()` is EMPTY.** The three values in `## The default rules` below are USER rules you write through the Settings button, never code, so the contract's load-bearing content is the ORDER alone: an appended user rule beats a matching earlier one on an exact tie, including any pre-filled default you set. The rule the guard's "always allow this directory" writes is appended at the END of the file's user rules for exactly that reason.

State the tension honestly: **the UI needs no rule ordering, but the resolver and the persisted file both carry an order contract** — the exact tie is the one place order matters, and with an empty default foundation that contract is now between your own rules.

**`protected_dirs()` remains the plain four-dir list.** It is the guard-membership set for row 3 AND the list the OS sandbox subtracts for confined `bash`. It is NOT derived from `default_rules()` — which carries nothing — and no user rule ever reaches it. That separation is what makes row 3 reachable at all, and it is what stops a rule from widening the shell.

## Scope — the five path tools, never bash

Rules apply to the file tools: `read` / `write` / `edit` / `grep` / `glob` — and **rules never apply to `bash`**. The principle, which is the one you can act on: **`bash` runs with your own user's OS permissions — if the user cannot write a path, neither can the shell; that is a user-level concern, not an app policy.** Parsing a shell command for redirect targets was considered and rejected: base64, heredocs and interpreted scripts make it bypassable in a dozen ways while looking like enforcement. The Settings panel prints the same thing, because a rules panel that implies otherwise is a panel that lies:

> These rules apply to the file tools (`read`, `write`, `edit`, `grep`, `glob`). **`bash` runs with your own user's OS permissions — it is not covered here.** To stop the agent reaching something with `bash`, remove your user's access to it.

One naming note against the tool list above, stated rather than smoothed: the tree's policed set is `read` / `find` / `grep` / `ls` / `write` / `edit` — **there is no `glob` tool**; `find` IS the glob tool (its `pattern` takes a glob). The shipped Settings copy repeats the spec's list and so names a tool that does not exist; the honest content is unchanged, and the copy is a one-line fix.

**The Landlock subtraction stays on `protected_dirs()`'s plain four-dir list**, so a user `allow` rule can NEVER widen confined `bash`: Landlock rules are add-only, and the only thing that keeps a `Sandboxed` command out of your instruction directories is that those directories are subtracted from its write roots. A confined command therefore stays **stricter than the path tools do under the same `allow` rule** — that is the chosen posture, and it rests on ADR 0081's guard-rail honesty rather than restating it.

## When an "always allow" takes effect

The policy AND the rules are re-read from `settings.json` **once per turn**, not per tool call — ADR 0030 Deviation 4, pinned by tests. So an `allow-directory` answer takes effect at the **next prompt**, not mid-turn: a model writing five files into a fresh directory prompts **five times** the first time. Making it immediate means breaking the one-read-per-turn design, in which every tool call inside a turn agrees; that was rejected as disproportionate for a one-time cost per directory. Expect the five prompts once per new directory, then silence.

## The default rules

| Rule | Effect at the default posture |
|---|---|
| `~` read/write `allow` | **nothing** — the executor floor is already `["/"]`. It documents how open the default is |
| `/` read `allow` | **nothing** — same reason |
| `~/.pi/agent` read `deny` | **the one genuinely new restriction** — it covers `~/.pi/agent/auth.json`, which today sits outside the **Boundary** and is refused only under `reads: Sandboxed` |

**These are USER rules, not code defaults.** They are absent until you add them, so at the shipped defaults the rules list is empty and `default_rules()` contributes nothing (see `## Matching`).

**The "Add default rule" button, and why there is no automatic seeding.** The design called for these three to be "written only on first write", so an existing install never silently gains a restriction. No first-write mechanism exists anywhere in the settings path — no save history, no version marker, and the missing-file branch is not surfaced to the UI — and the wire cannot distinguish an empty rule list from an absent one. So Settings ships an explicit **"Add default rule"** button that **pre-fills the dialog draft and writes nothing until you save it**. No automatic write is possible, which means no install ever silently gains the one real restriction; the button plus the panel copy naming all three defaults is the honest substitute, and the `deny` row is labelled in the UI as a default you can delete so it never reads as hidden behaviour. The offer re-appears whenever the list is empty.

## Honest limits

**(a) `settings.json` is not agent-writable-proof.** It is not in `protected_dirs` and it already holds `filePolicy`, so agent-writable policy is pre-existing rather than introduced here. A model that can write that file could grant itself anything with the path tools — but it could already do that with `bash`, which no rule covers. Recorded, not fixed; protecting `settings.json` is a separate decision.

**(b) The `settings.json` concurrency limit.** This is a **distinct limit from (a)** — the two are not the same claim and must not be read as one: (a) is a security claim about who can write the file, this is a reliability claim about writers colliding — and `settings.json` has **six-plus independent whole-document writers and no shared lock**. The relay's own write is now **atomic** (a temp file in the config dir plus a rename, with the existing file's mode preserved on unix so the write does not silently tighten `settings.json` from 0644 to 0600), and its read-modify-write window is **narrowed** to one function call that re-reads immediately before the overwrite. Narrowed, **not closed**. The concrete lost update: you click "Always allow this directory", the relay appends the rule, and a Settings-page **Save** composed from a document snapshot taken *before* that click then overwrites the whole file and **silently drops the rule** — and because the relay's write is best-effort-logged and already returned, the loss surfaces to no one. The recorded follow-up is a settings-write lock or a save-version/merge at the store boundary. Practical mitigation today: don't leave a Settings dialog open in another window while answering a permission prompt.

**(c) Trust suppresses the guard.** A Trusted **Space** permits silent self-modification, and at the shipped defaults that silent proceed is the ORDINARY state — there is no default-deny rule whose deletion had to happen first, because the four dirs are a membership set. Mitigations: `trust-space` is gone from the guard's own prompt (the one-click self-protection disable is closed), and the trust copy says what trust now buys. If you want a Trusted Space to still be asked, add a `deny` rule for those paths — a rule `deny` is trust-immune.

**(d) `home: None`.** With no resolvable home directory, a `~`-named rule expands against nothing and therefore **matches nothing** — a silent no-op, never a wider reading. And the default rule set is empty, which is its state at all times by design, so the footprint is the same as an empty protected list: the posture select decides everything. Recorded, not fixed. (On unix `home_dir()` falls back to the passwd database, so a genuinely unresolvable home is practically unreachable; the reachable consequence is the empty rule set.)

**(e) Per-turn effectiveness**, as above: five prompts on first use of a directory.

## Trust and the guard

The trust toggle's copy is the corrected one:

> New Spaces start trusted (skip permission prompts). A trusted Space's agent can also write its own instruction directories without asking — deny those paths with a rule above if you want that to still prompt.

Deliberate trust — from Space settings — silences the guard. **At the shipped defaults a Trusted Space proceeds silently**, and that IS the promise the copy makes: there was no default-deny rule whose removal this depended on. The guard's own prompt carries **no `trust-space`** option, so a recurring prompt can no longer be ended with one click on the very protection it exists to provide; trust is something you configure, not something you reach by reflex.

Trust never widens a `deny`. That sentence survived the whole change intact, and it is the reason (c) above has a fix.

## Where it lives in Settings

**Settings → Permissions** holds it all, because prompts belong where prompts are explained:

- the three **posture** rows (`Reads` / `Writes` / `Shell`), moved out of General with their Linux-without-Landlock handling intact;
- the **Trust new Spaces by default** toggle, moved out of General for the same reason, carrying the copy above;
- the **rules list** — one row per rule (path, direction, decision, edit, remove) with an add/edit dialog of three fields and no Test action, plus the empty-state copy naming all three defaults and the **"Add default rule"** button;
- the **scope copy** the `bash` decision requires, as a row rather than a footnote.

## Cross-references

- [ADR 0030](../decisions/0030-file-access-policy.md) — the posture model, the **Boundary**, and Deviation 4 (the per-turn read); its 2026-10-28 amendment narrows the "refused in every policy" claim this page describes.
- [ADR 0083](../decisions/0083-the-self-modification-guard-is-an-ask-when-no-rule-matches.md) — the guard ask, the guard-membership set, the `trust-space` removal, the `bash` principle, and the run's recorded deviations.
- [ADR 0081](../decisions/0081-a-lenient-deny-list-entry-needs-a-lenient-compare-one-half-alone-is-a-silent-no-op.md) — the lenient canonicalizer and why a failed compare is a silent no-op. Reference, not restated.
- [ADR 0025](../decisions/0025-sessions-in-worker-processes.md) — why the Supervisor's relay and not the gate persists a rule: the Worker has no `config_dir`.
- `CONTEXT.md` terms: **Self-modification guard**, **Beyond-boundary policy**, **Permission prompt**, **Trusted Space**, **Boundary**.

ADR 0081 recorded, measured empty, that *"`docs/features/` has no page for the protected directories at all"*. This page is that page. The probe it armed — `grep -rn -iE "protected|deny-list|guard-rail" docs/features/ docs/css-theme-tokens.md` — now hits this file, which is the gap closing rather than a regression.
