# Grounding report — AR EA: durable docs (ADRs · CONTEXT.md · docs/features)

Research for the planning agent on `docs/roadmap/permissions-section.md` (area: durable docs —
ADR 0083, an appended `Amendment` to ADR 0030, `CONTEXT.md` term updates, a new `docs/features/`
page). All facts read from the working tree at current HEAD (`feature/permissions-section`,
`a17ba4b chore(release): bump version to 0.8.0`), read-only. No builds, no tests, no git-state
changes were made.

---

## 1. ADR conventions in `docs/decisions/`

**Highest-numbered ADRs present.** The directory contains **73 ADR files**, numbered 0006–0082.
The four highest currently in the tree, by filename:

- `0080-a-pipe-held-exit-0-bash-run-is-a-completion-latched-before-the-kill.md`
- `0081-a-lenient-deny-list-entry-needs-a-lenient-compare-one-half-alone-is-a-silent-no-op.md`
- `0082-the-sessions-money-is-the-providers-per-call-figure-read-from-the-response-body.md`

**0083 is genuinely free.** `git ls-files docs/decisions/ | grep 0083` → nothing; `ls docs/decisions/`
parses `0080 … 0082` as the tail, no `0083-*.md`; `git log --all --diff-filter=A --name-only --format="" -- docs/decisions/ | grep 0083` → no output (confirmed by exit code 1 — no `0083` has ever been added on any branch, so the number is not merely absent from the working tree). Note the numbering caveat ADR 0081 itself records: the natural `/008` grep pattern is a known trap (`0008-inline-attachment-persistence.md` matches it) — the check above was done per-number, not by the `/008` pattern. ADR 0064 states the rule: **ADR numbers are append-only and gaps are not filled; nothing is renumbered.**

**Front-matter / heading shape (template — recent ADR 0082, verbatim).** File
`docs/decisions/0082-the-sessions-money-is-the-providers-per-call-figure-read-from-the-response-body.md`:

```markdown
---
status: accepted
date: 2026-10-27
superseded-by:
---

# The session's money is the PROVIDER'S per-call figure, read from the response BODY — and an unknown price renders as nothing, never `$0.00`

```

ADR 0079 has the identical shape (`status: accepted`, `date: 2026-10-27`, `superseded-by:` empty),
confirming it as the house template: the `date` key appears in **all 73** ADR files and the
`superseded-by:` key (empty) appears in all 73 as well.

**Status field.** Yes — every one of the 73 uses exactly one value: `status: accepted`. No other
status value exists in the directory (`grep -h '^status:'` across the directory → 73 lines, all
`status: accepted`). An ADR does not change its status when amended: the amendment idiom repeatedly
asserts *"This ADR is NOT superseded and its `status` is unchanged"* (quoted verbatim in section 2).

**Amendment machinery.** Many ADRs carry appended `## Amendment (⟨date⟩) — ⟨title⟩` sections —
0030 has one, 0016 has two, 0040 has two, 0043 has one, 0045 has one, 0046 has one, 0052 has
three, 0060 has one, 0082 has three. The single dated form is *almost* universal; one variant
exists — `## Amendment (same change, before it shipped)` in 0062. Amendments stack (0082 has three,
each overtaking one clause of the one before) and the file is append-only: **a merged ADR is never
edited in place** — this is stated in 0081 as *"0030 is merged to `main` hence append-only (0033
states the convention: 'Stated here rather than in 0031 because that ADR is merged, hence
append-only.')"*.

---

## 2. ADR 0016's "Amendment" idiom — verbatim

The spec's *"appended `Amendment` in ADR 0016's idiom"* refers to the appended-amendment shape
that ADR 0016 (`docs/decisions/0016-session-archive-first-delete.md` — Session archive-first
delete, `status: accepted`, `date: 2026-10-01`) demonstrates with two amendments. Full verbatim
heading of the first amendment, immediately following the original body's final Consequences
bullet:

```markdown
## Amendment (2026-10-20) — Archive reaches a live Session and stops it on the way in; the Pause consequence is corrected

**AMENDED 2026-10-20 — the reach of Archive, and one Consequences bullet that stopped being true two days after this ADR was written.** What stands unchanged: delete stays two deliberate steps from a transcript — **only** the Archived section offers it, behind a confirm — Archive stays hide-not-destroy (the `sessions` row and its transcript survive, the session stays openable and resumable), and the flag stays **sticky**. This ADR is NOT superseded and its `status` is unchanged; the Consequences bullet about live rows is deliberately left standing above as written, and corrected here rather than edited, because it is the record of what was true when the decision was taken.
```

The second amendment's heading, for the pattern (a later amendment can overtake a clause of an
earlier amendment; the same *"leaving the original standing"* discipline applies, per 0082's
third amendment which quotes 0016's convention verbatim):

```markdown
## Amendment (2026-10-21) — the Archived section is Space-scoped, and Settings → Detached sessions becomes the second door to Delete
```

The structural signature of 0016's idiom, as used here and in 0052/0046/0082:

1. `## Amendment (⟨ISO date⟩) — ⟨one-line title of what changed⟩` — no date-less form.
2. Opening paragraph begins **`AMENDED ⟨date⟩ — ⟨scope sentence, naming exactly what moved.`**
3. A *"What stands unchanged: …"* clause inventories the parts of the decision that survive
   (usually ending with **`This ADR is NOT superseded and its `status` is unchanged`**).
4. The stale sentence is **deliberately left standing above as written, and corrected here rather
   than edited**, with the reason *"it is the record of what was true when the decision was taken"*
   — 0082 states the same convention in its own words: *"an amendment records what was believed
   when the decision was taken rather than silently rewriting it."*
5. `**What changed.**` — the correction, with named commits/artifacts where they exist (0016 names
   `874a7b7`; 0046 names `405be65`; 0082 names `ffab12d`). The spec's follow-up says the 0030
   amendment must record why `deny` keeps trust-immunity while the ask does not, the `trust-space`
   removal, the bash exclusion principle, and that `protected_dirs()` becomes default rules keeping
   ADR 0081's leniency — the *"What stands unchanged / What changed"* pair is exactly where those
   belong.

0016 **is** the ADR that demonstrates the amendment idiom (it is not about something else): its two
amendments correct a Consequences bullet and the stated reach of the decision respectively. The
files that actually use the appended-in-place `## Amendment` heading are 0016, 0025, 0027, 0030,
0040, 0042, 0043, 0045, 0046, 0052, 0060, 0062, 0082, plus the 0082/0046/0030 amendments already
quoted. (0027 and 0023 use inline **Amended …** paragraphs inside the body rather than appended
`## Amendment` headings.)

---

## 3. ADR 0030 — the narrowed claims and its tree status

**The "refused in EVERY policy" claim the spec narrows — verbatim.** From
`docs/decisions/0030-file-access-policy.md`, "The write floor" section (ADR 0030, 2026-10-07):

> Writes accept anywhere on the machine at `Ask`/`Allow`, **except** the four user-level dirs — `~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents` (`boundary::protected_dirs`) — which are refused in **every** policy, as a deny, never a prompt, never widened by Trust (`protected_refusal_text`, consulted before the boundary so the refusal states the true reason). **This is a guard-rail, not a security boundary**: `shell = Allow` (the default) writes those files with `bash` in one command, and Landlock cannot express "anywhere except these dirs" because it is allow-list-only, so at `Sandboxed` they are simply absent from the allow-list.

Also relevant, the precedence sentence under "The truth table" (quoted by the spec's *"a `Deny` is NOT a prompt"* family and by CONTEXT.md's **Trusted Space** entry):

> **Precedence: Trust suppresses prompts but never widens a deny.** … A denied access therefore never reaches the UI in any configuration — a `Deny` is a tool-result error (`deny_tool_result`), worded identically to the executor's own rejection so the model's recovery behavior cannot depend on which layer said no.

**"Deviation 4" (one-read-per-turn) — verbatim**, from 0030's appended Amendment
(`## Amendment (2026-10-27) — the Deviation numbering is defined here — Deviation 2, Deviation 3 and Deviation 4`):

> **Deviation 4 — per-turn, in-process freshness.** The file-access policy (and the web config) is re-read from `settings.json` **once per turn**, not per tool call: one read per turn, so every tool call in a turn agrees and a mid-turn hand-edit is observed at the NEXT prompt — a settings edit affects an **already-running** session at its next prompt, **with no restart and no relaunch**. It is the same in-process read `launch.rs` already does per dispatch. **Cited by:** `harness/loop.rs` (the `file_policy` field doc, the `AgentLoop::new` construction comment, and the top of `handle_prompt`), `harness/loop/tests/policy_gate.rs` (`a_settings_edit_between_prompts_changes_the_next_turns_gating`), `tests/worker_e2e.rs` (the `start_env_with_file_policy` builder doc).

Deviation 3 (the write deny-list) is the same amendment's definition of the claim in section 3
above and is the one the spec's ADR 0083 narrows:

> **Deviation 3 — the write DENY-LIST.** A resolved path under one of the four user-level agent-definition discovery dirs — `~/.agents/skills`, `~/.pi/agent/skills`, `~/.agents/agents`, `~/.pi/agent/agents` (`boundary::protected_dirs()`) — is refused in **EVERY** policy: a deny, never a prompt, never widened by Trust. It is consulted **before** the boundary so the refusal states the true reason, and it is a guard-rail, not a security boundary.

**Tree status of 0030.** ADR 0030 is `status: accepted`, `date: 2026-10-07`, `superseded-by:`
empty in its front matter. It is **merged and append-only**: `git log --oneline` on the file shows
its writes landed at `b3b74a4` (`feat: file-access policy — per-direction reads/writes/shell
(ADR 0030)`) and its amendment at `6dc8833`; `git branch -a --contains 6dc8833` lists `main`
(`remotes/origin/HEAD -> origin/main`, `remotes/origin/main`) alongside the current branch —
i.e. both commits are on `main`, so narrowing must be an appended amendment (0016's idiom, section
2) plus a successor ADR (0083), never an edit. The 0081 amendment record also states this: *"0030
is merged and append-only"* and *"0030 is merged to `main` hence append-only"*. No ADR in the tree
currently supersedes 0030. (Note: 0030's own amendment was authored on this same branch
`feature/permissions-section`, which also contains `main` — the amendment commit `6dc8833` is on
`main`, so the merged/append-only conclusion holds regardless of branch.)

---

## 4. ADR 0046's stale bullet — verbatim and current state

**The bullet (verbatim),** from `docs/decisions/0046-input-tokens-is-cache-inclusive-at-the-parser-seam.md`, the final Consequences bullet ("The dormant cache-token UI seam stays dormant"):

> - **The dormant cache-token UI seam stays dormant.** `CostUpdatePayload.cacheReadTokens` /
>   `cacheWriteTokens` (`src/store/interactive.ts`) have no native emitter at all (`cost_update`
>   was self-emitted by the removed pi extension suite; only `todos_update` is pushed), and
>   `SubagentDelegatingCard` renders `cost`, never the cache counts. They are left in place and
>   named for a separate dead-code audit — feeding them would be plumbing that arrives nowhere.

(Three of the four lines quoted; the two remaining — `_Avoid:`-style none — are the `- **The dormant…` intro and the final sentence. The parenthetical *"only `todos_update` is pushed"* is the clause the spec calls stale.)

**Is it still stale in the tree today? Yes — still stale.** The file's appended amendment
(`## Amendment (2026-10-27) — `cost_update` now has a native emitter; the dormant cache-token seam stays dormant for a second reason`) records the falsification: the clause *"is false as of `405be65`"* — *"`cost_update` now has a native Rust emitter (`emit_cost_update`), called from the `ProviderEvent::Usage` arm of the turn loop (`loop/turn.rs`) — so `todos_update` is no longer the only pushed event"* — while the other half (cache-token fields still have no emitter; `SubagentDelegatingCard` renders `cost`) remains true and "now load-bearing for a different reason" (the `applyCost` sum). Verified in the working tree: `git cat-file -t 405be65` → `commit`, `git show -s 405be65` → `405be65 feat(harness): emit the provider's per-call cost as cost_update (#87, T09)` (reachable, on `main` via the cost branch's close-out `6dc8833`); the amendment's "still true" claims about `CostUpdatePayload.cacheReadTokens` / `cacheWriteTokens` and `SubagentDelegatingCard` were not contradicted by anything in the tree; and `git diff HEAD` on the 0046 file prints nothing — the bullet is still stale **as written** (it is "deliberately left standing above as written, and corrected here rather than edited"). ADR 0046 is also merged/append-only (its amendment is on `main` at `6dc8833`). Per the spec this is an unrelated separate follow-up — the facts above are the state, not the work.

---

## 5. `CONTEXT.md` — the three named entries and the entry format

**Entry format.** The file is `# Archimedes Desktop` / `## Language` / then a series of term
entries, each shaped:

```markdown
**⟨Term in bold, Pascal-case or Title case, with a colon**:
One-to-few-paragraph plain-text definition; related terms are referenced in **bold**; decisions are
cited inline in the text as `(ADR 00NN)` or `ADR 00NN` (or "ADR 0025 + ADR 0030", "ADR 0010, as
amended by ADR 0030"); corrections are recorded as trailing _Generalized … / 2026-10-02: …_
italic blocks (final italic segment starting `_Generalized` or a date); some entries edit-in-place
whilst noting the edit (e.g. **Session cost** "corrected … at `c801445`", "amended 2026-10-20").
_Avoid_: ⟨comma-separated list of banned synonyms, each parenthetically glossed where needed⟩
```

Entries are separated by a single blank line; term + colon on its own line, body paragraph(s)
under it, `_Avoid_:`-line closing the entry. Empty front matter is not present — the file starts
with the H1. New terms must follow this shape (bold term line with colon → body → `_Avoid_`), and
should cite ADRs inline in the established style.

**The three entries the spec names — verbatim:**

**Permission prompt:**

> **Permission prompt**:
> The Client's UI response to the native harness's in-process **permission gate** (the `permission-request` event before a tool call the **Beyond-boundary policy** sends to `Ask` — ADR 0010/0030) — the user approves or denies the tool call. Its title names the thing being reached for (`permission_title`: `read ../../.ssh/config`, `grep SECRET in /tmp`, `bash rm -rf …`). A `Deny` is NOT a prompt — it is a tool-result error that never reaches the UI.
> _Avoid_: Approval dialog, consent prompt, confirm

(The spec calls out the *"A `Deny` is NOT a prompt"* sentence — verbatim above — which must stay
true after the change and needs the guard's ask named alongside it.)

**Boundary:**

> **Boundary**:
> The set of directories a **Session** treats as "in bounds", computed once per session by `agent::boundary` — `read_roots(cwd)` (the canonical `cwd` FIRST, then the user- and space-level **Skill** / **Agent definition** discovery roots) for the read direction, and `write_roots(cwd)` (the canonical `cwd` ONLY) for writes. A SET and not the `cwd` alone because `space_roots` walks up to the repository root, so a repo-level `.agents/skills` is outside a package `cwd` yet must be readable; the asymmetric seed is deliberate — reads are granted the agent dirs (ADR 0029's whole point), writes never are. `roots[0]` is the relative-path join base. Containment is "under ANY root", decided by the canonicalize-then-check in `FsBackend` (shared by gate and executor so they cannot resolve `..` or a symlink differently); an EMPTY root set fails closed, and the unrestricted floor is an explicit `/` root (`boundary::UNRESTRICTED`). Orthogonal to **Trusted Space**, which decides whether a prompt is shown, not what is in bounds.
> _Avoid_: Sandbox root (the pre-ADR-0030 single `cwd`), allowlist, whitelist, cwd (one root of the set, not the set)

**Beyond-boundary policy:**

> **Beyond-boundary policy**:
> The user's per-direction choice — `FilePolicy { reads, writes, shell }` in `settings.json` (wire key `filePolicy`), each an `AccessPolicy` of `Sandboxed` / `Ask` / `Allow`, **defaulting to `Allow`** — that decides what happens to a file access landing OUTSIDE the **Boundary** (inside it every policy allows). Resolved by the one pure function `decision_for` into `Allow` / `Ask` / `Deny` / `Confine`: `Sandboxed` REFUSES a path-param tool and CONFINES `bash` (a Landlock ruleset, Linux-only, fail-closed — refusing commands would disable the shell), `Ask` prompts unless the Space is **Trusted**, `Allow` is silent and unlogged. `bash` has no path to judge, so it is always beyond. **Trust suppresses prompts but never widens a deny.** Reads are gated by the Boundary; the EXECUTOR is unrestricted at `Ask`/`Allow` (`boundary::executor_roots`), and writes are refused only in the four user-level agent dirs (`boundary::protected_dirs`) — in every policy, a guard-rail and not a security boundary (ADR 0030).
> _Avoid_: Sandbox mode, permission level, access control (too generic), strict/normal/permissive (the UI words are `Sandboxed` / `Ask me` / `Don't ask me`)

**Adjacent entries the spec's work will touch (helpful for placement, quoted or summarized):** the
**Trusted Space** entry (verbatim above in section 3's context — it already carries the precedence
sentence and *"(ADR 0010, as amended by ADR 0030)"*), and the **Lenient deny-list entry** entry,
which ADR 0081 flags as over-claiming by one clause — its sentence *"so a Session that recreates
`~/.pi/agent/agents` is refused writing into it immediately, with no restart — **unless nothing on
its path resolves**"* is the ordinary claim (an appendix records 0081's suggested scoping). The
terms **Permission gate** (gate-side prompt-holding entry) and **Subagent session** also reference
the **Permission prompt** by bolded name. There is **no entry named "Guard", "Rule", "AccessRule"
or "protected directory"** — a new term for the guard is genuinely new vocabulary.

---

## 6. `docs/features/` conventions

**What exists there (11 files):**

- `dracula-palette.md`
- `image-attachments.md`
- `issue-96-temp-dir-known-gaps.md`
- `manual-list-order.md`
- `mcp-known-gaps.md`
- `model-selection.md`
- `subagent-sessions.md`
- `thinking-display.md`
- `tool-call-output.md`
- `tool-card-zcode-style.md`
- `window-state-render-webviews.md`

**Representative heading/front-matter shape (template — `docs/features/model-selection.md`, verbatim):**

```markdown
---
status: live
last-verified: 2026-10-19
verified-by: PR #2 (squash-merged to main as 4598028) — pnpm test (240) + pnpm build; cargo test (full suite) + cargo clippy (0 warnings) + cargo fmt; Greptile + CI green. Re-verified 2026-10-19 at PR #56 (Reasoning-line visibility): every path/claim below re-read against the tree — the harness module, `list_sessions`' synthesized `config_options`, and the Side pane as the controls' home — and the stale session-header / `config_options: None` / `agent/session.rs` wording corrected.
---

# Model + thinking-level selection

The desktop lets the user select a **live** session's model and thinking level over the `configOptions` mechanism — the options are SYNTHESIZED in-process by the desktop's native harness (ADR 0011 / 0022: the desktop IS the harness — there is no external agent to advertise them). The controls themselves live in the **Side pane** (the **session config block**), not in the transcript header.

## How it works
```

**Front-matter field conventions.** Nine of the eleven pages carry `status: live` +
`last-verified: ⟨date⟩` + `verified-by: ⟨commit/PR + what was re-measured⟩` — the two oldest
(`tool-call-output.md`, `tool-card-zcode-style.md`) have **no front matter at all**, starting
directly with `# ⟨Title⟩`/`Shipped 2026-07-09 (PR #5).` The `verified-by` value generally includes
the commit or PR and the gate that was run, and pages that record gaps state *"every gap below
re-confirmed still open, not copied from the plan"* (`mcp-known-gaps.md`, `issue-96-temp-dir-known-gaps.md`).
Section headings vary: `## How it works`, `## The token map`, `## Behavior`, or none. The style is
first-person-repo (the desktop/harness terms bolded, ADRs cited inline as `ADR 00NN`). A permissions
page should follow the nine-file front-matter shape (`status: live`, `last-verified`, `verified-by`
with what was measured) and should carry the spec's honesty requirements (bash-scope, per-turn
limit) in the same *"disclosed, not papered over"* register the gap pages use.

**The one test that reads this directory** — `src/lib/subagentSheetLayout.test.ts` (vitest). It does
**not** glob the directory; it has a single hardcoded listing in a constant:

```ts
const PROSE = [
  "docs/features/subagent-sessions.md",
];
```

What it asserts about that file, exactly:

- In the fourth test (`"nothing outside the layout module names the dodge's offset or cap WITHOUT its breakpoint variant"`), it iterates `[...SOURCES, ...PROSE]` and reads each file with `readFileSync(file, "utf8")` — **the read deliberately has no tolerance for a missing file** (the file's own comment: *"the read below deliberately has no tolerance for a missing file, because silently skipping one would let a doc escape the scan"* — so deleting or renaming `subagent-sessions.md` breaks the test). For every non-module file in the list it walks lines and fails on any line that contains a bare literal dodge-offset (`right-[<literal>px]`) or dodge-cap (`max-w-[calc(100vw-<literal>…)]`) **without** a `<…>]:` variant prefix; interpolated values like `…-[${X}px]` are not matched and are fine. The third test's comment-scan (`UTILITY = /[a-z-]+-\[[0-9A-Za-z]+(px|vw|rem)\]/`) iterates **only** `SOURCES` (the `.ts`/`.tsx` files), **not** `PROSE` — so prose files are *not* scanned for arbitrary-value utilities in comments.
- The fix the test documents for prose: *"Prose in these files now describes the utilities in words and leaves the bracketed form to the expressions that apply them."* (Tailwind v4 scans `.md` for class-like tokens too — that is why the PROSE scan exists.)
- What this means for a **new** page: a new `docs/features/permissions-model.md` is **not listed** in `PROSE` and so is **not read by the test at all** — adding one cannot break `subagentSheetLayout.test.ts` unless (a) it is added to `PROSE` (only needed if it discusses the sheet's 480px dodge geometry — it should not), or (b) someone names it `subagent-sessions.md`. The one practical constraint: **do not quote bracketed Tailwind arbitrary-value classes without their variant prefix** in any prose that *is* listed (i.e. `subagent-sessions.md`), and keep new files' prose consistent with the house rule anyway since Tailwind scans `.md`.

---

## 7. Is there already a permissions feature page? What ADR 0081 already recorded

**No permissions feature page exists.** Grepping `docs/features/` for `protected`, `deny-list`,
`guard-rail`, `filePolicy`, `file policy`, `access policy` finds nothing about the permissions
model; the only "permission"-shaped hits are `subagent-sessions.md`'s routing prose about the
in-process **permission gate** / `Permission prompt` / `pending_permissions` maps (the gate's
prompt plumbing, not the policy). ADR 0081's own measured statement, verbatim (Consequences):

> - **`docs/features/` has no page for the protected directories at all.** Measured empty, armed. So there is **no feature doc to correct** — but that is not an all-clear: beyond 0030's one paragraph, this ADR is now the only durable description of the deny-list, and a user-facing page is a real gap.

The same ADR gives the armed probe wording the new page must not collide with: *"no page in
`docs/features/` mentions the protected dirs, the deny-list, or the guard-rail wording at all
(`grep -rn -iE "protected|deny-list|guard-rail" docs/features/ docs/css-theme-tokens.md` → empty;
the same command shape over `docs/decisions/` returns four files at the base commit, so the empty
result is armed and real)"* — so once a permissions page lands, that probe is expected to change.

**Where the protected-dirs gap was already recorded (ADR 0081) — the leniency sentence to
reference rather than restate.** The spec says the new page must carry *"the guard-rail honesty"*
and that the protected-dirs gap was already recorded in ADR 0081, so the page should reference it.
Two quotable 0081 sentences:

The decision line:

> (1) `boundary::protected_dirs()` builds its entries through `push_protected` → `fs_backend::canonicalize_lenient`, so a directory that does not exist yet is **KEPT** as its canonical nearest-existing ancestor plus the re-applied trailing components, instead of being dropped;

and the mechanism sentence:

> **Both sides of the compare go through leniency…** (the page should reference rather than restate): ADR 0081's exact phrasing for the guard-rail/leniency fact the spec reuses —

> Keeping an entry that the comparison refuses to compare is a **silent no-op** — the entry sits on the list, matches nothing, and the harness reports a protection it does not have.

(The full ADR 0081 verbatim opening is quoted in section 8-style context where the lenient
canonicalizer's central claim appears: *"A write deny-list entry whose directory had not been
created yet was silently absent from the list … We decided two things, in one commit (`fc7b635`,
issue #92)…"* — the page may cite `boundary::protected_dirs()` + `canonicalize_lenient` +
`push_protected` names without re-explaining them, pointing at ADR 0081.)

---

## 8. Cross-linking conventions

**Between ADRs and to `docs/features/`:**

- **ADR → ADR:** no relative-path Markdown links exist between ADR files — ADRs live in one
  directory and are cited **inline by number**, in prose, as `(ADR 00NN)` / `ADR 00NN` (e.g. 0030's
  body: *"which are refused in **every** policy"… "(`boundary::protected_dirs`)"… "ADR 0029"*, and the
  pervasive `(ADR 0042, amended 2026-10-13)` / `ADR 0030 Deviation 4` forms). 0081's Consequences
  records the citation sites as file-path lists with the instruction *"re-derive them by grepping
  `Deviation [0-9]`"* — numbers are cited by number, never by permalink.
- **ADR → `docs/features/`:** **backticked relative paths, not Markdown links.** Quoted examples
  from the ADRs:
  - ADR 0041: *"follow-up recorded in `docs/features/subagent-sessions.md`, not something this closes."*
  - ADR 0055: *"`docs/features/subagent-sessions.md`, and the clock comment in `subagent_flow.rs`"*
  - ADR 0075: *"and recorded in `docs/features/manual-list-order.md` rather than left implicit"*
  - ADR 0078: *"see `docs/features/issue-96-temp-dir-known-gaps.md`."*
  - ADR 0082's follow-up table row: *"`docs/features/subagent-sessions.md`, the 'The wire metrics
    shape is unchanged…' sentence"*
- **`docs/features/` → ADR:** the reverse direction **does** use relative Markdown links:
  `docs/features/image-attachments.md`: *"see [ADR 0008](../decisions/0008-inline-attachment-persistence.md)"*,
  and `docs/features/mcp-known-gaps.md`: *"[ADR 0079](../decisions/0079-an-unknown-top-level-tool-parameter-rejects-the-call.md))"*.
- **`CONTEXT.md` citations:** the glossary cites ADRs inline by number (never paths), and ADRs cite
  glossary **entries** by their bolded term name with the file named in backticks — 0016:
  *"`CONTEXT.md`'s "Archived session" entry says exactly that."*; 0080: *"The same `CONTEXT.md`
  entry says…"*; 0081: *"`CONTEXT.md`'s **Lenient deny-list entry** entry"* (0081 adds the
  house-doctrine note *"`CONTEXT.md` is not edited by this ADR: reading it is free, editing it is
  not"* — i.e. glossary edits are owned by whoever owns the glossary task, and ADRs state that fact
  rather than editing).
- **Repo-wide convention for sweepable claims:** when a document's claim is load-bearing it is
  quoted with a **grep-able probe** (ADR 0081's armed sweeps), and the roadmap family
  (`docs/roadmap/`) is gitignored and deleted on ship, so durable claims get their durable copy in
  the ADR/feature page — the new page should follow the same *"state the probe that armed this"*
  discipline where it asserts tree-wide facts (e.g. the bash-exclusion claim, the per-turn limit).

**The derivative fact for the new ADR 0083:** 0083 will most naturally (a) cite 0030, 0010, 0029,
0081 by number inline; (b) name the new feature page as `` `docs/features/permissions-model.md` ``
in backticks (matching the ADR→features convention above); (c) name `CONTEXT.md` terms by their
bolded entry names (matching 0081); and (d) — per the spec's own follow-up row — narrow 0030 by an
appended `## Amendment (⟨date⟩)` in 0016's idiom (section 2) plus its own successor body with the
`superseded-by:`/`status` handling 0052/0081 use (*"This ADR is NOT superseded and its `status` is
unchanged"* does not apply to a new ADR; 0083 itself decides what it supersedes or narrows).

---

## Summary of state facts (for the planner)

- **0083 free**; highest committed ADR is **0082**; all 73 ADRs are `status: accepted` with
  `date:` and empty `superseded-by:`; the front-matter template is exactly the 4-line block in
  section 1.
- **Amendment idiom**: appended `## Amendment (⟨ISO date⟩) — ⟨title⟩` + `**AMENDED ⟨date⟩ — …**`
  opening + *"What stands unchanged … NOT superseded, `status` unchanged"* + *"deliberately left
  standing above as written"* — demonstrated by 0016's two amendments (quoted verbatim, section 2).
- **0030's narrowed sentence** (write floor) and **Deviation 3/4** definitions quoted verbatim
  (section 3); 0030 is merged (on `main`) and append-only.
- **0046's stale bullet** quoted verbatim; still stale in the tree (its own amendment documents the
  falsification at `405be65`; the original text stands unedited); separate follow-up.
- **CONTEXT.md** entries and format quoted verbatim (section 5); no existing term for the guard.
- **`docs/features/`** — 11 pages, 9 with `status: live`/`last-verified`/`verified-by` front
  matter, 2 without; the only test reading the directory is `subagentSheetLayout.test.ts`, which
  reads exactly one hardcoded file (`docs/features/subagent-sessions.md`) and fails on bare
  dodge-offset/cap bracketed classes in it (sections 6).
- **No permissions feature page exists**; ADR 0081 already recorded the gap and the leniency
  (section 7); cross-linking is inline-by-number for ADRs, backticked relative paths ADR→features,
  relative `../decisions/…` Markdown links features→ADR (section 8).

Facts verified with `git ls-files`, `git log --all --diff-filter=A`, `git cat-file`, `git branch
-a --contains`, `grep`/`sed` over the working tree; no `file:line` citations given per instruction.