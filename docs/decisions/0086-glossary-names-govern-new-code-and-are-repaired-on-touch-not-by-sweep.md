---
status: accepted
date: 2026-10-30
superseded-by:
---

# Identifier and wire names follow the CONTEXT.md term — conformance is enforced on NEW code and repaired ON TOUCH, never by sweep, and this ADR does not resurrect the five deferred D5 renames

A name (an identifier, a wire string, or user-visible copy) **follows the `CONTEXT.md` term for the thing it names**, wherever a term exists — and conformance is judged by that term's `_Avoid_` list, which the glossary already treats as a binding naming rule rather than advice. It is **enforced on NEW code** — a new identifier, wire string, or copy that matches a term's `_Avoid_` list is a conformance defect in review — and **repaired ON TOUCH**: a file being changed for another reason may repair the banned names inside that file in the same commit. A **sweep is not** — no wholesale, single-purpose rename pass across the tree is authorised by this ADR, and the five renames the previous batch proposed stay exactly where `docs/roadmap/frontend-component-extraction-follow-ups.md` §6 left them.

**Why this ADR exists at all:** the glossary has carried `_Avoid_` lists with nothing behind them (`docs/reviews/2026-10-30-codebase-improvement.md` names this process gap, and its sibling finding about the un-termed `definition_permission` layer is the same vacuum seen from the other side). That is not a cosmetic gap — §6 records a whole rename batch that **died of the missing authority**, not of its cost, and the same vacuum is why new code keeps entering drift. This ADR supplies the authority for the *rule* while explicitly withholding it from the *sweep*.

## The number 0086 — checked, not assumed

`git log --all --diff-filter=A --name-only --format="" -- docs/decisions/ | grep -E "0086"` printed **nothing** (exit status non-zero, no output line), and `ls docs/decisions/` at execution time holds **76** files whose highest number is **0085** (`0085-the-projects-licence-is-mit-in-spdx-form-and-the-text-ships-in-the-rpm-by-map.md`, commit `82979ec`). So 0086 is free on every ref and on the working tree, and no gap is being filled — ADR 0084's rule, restated because it is the reason the probe has two halves rather than one: `ls docs/decisions | tail -1` sees only the working tree, while ADR numbers are append-only and a collision lives in the object database.

Stated at this length because **this repo has already shipped a duplicated ADR number**, and the duplicate is not an anecdote — it is the cause of death of the batch this ADR finally gives an authority record. §6 of the follow-ups file records that the rename batch cited *"backed by ADR 0066"*, that **ADR 0066 was a duplicated number**, and that **neither of the two files holding it named any of those symbols**. The number is therefore load-bearing in the exact way a citation is load-bearing: a batch was cancelled because its authority did not resolve.

## The decision

**Conformance: the name follows the term.** Where `CONTEXT.md` carries a term for the thing a name denotes, that name is the term, and the term's `_Avoid_` list is the prohibition list. The glossary's own standing is what this rests on: its Context-section reading of the `_Avoid_` lists is that they are **binding naming rules**, not preferences — which is precisely why they have needed no enforcement mechanism until now and precisely why they were ignored. A term's entry, not a reviewer's memory, is the authority; a name that matches no term is simply not this ADR's subject.

**Enforced on NEW code.** The rule binds what a change *adds*: a new identifier, a new wire string, or new user-visible copy that a governing term's `_Avoid_` list forbids is a conformance defect, and review should name it as one. This is the half the vacuum made unenforceable — the review's own evidence is that drift entered with a shipped feature days after the component that owned it, because no mechanism existed by which a contributor could learn the rule other than reading the whole glossary.

**Repaired ON TOUCH, never by sweep.** A file already being edited for another reason may repair the banned names it contains, in that commit, as part of that change. A **sweep across the tree is out of scope and out of mandate** — deliberately. A sweep is what re-opens the cost question §6 measured, and licensing one here would be exactly the move this ADR exists to refuse. The asymmetry is the point: touch-repair costs nothing extra (the file is already open, the tests already run) and cannot produce a wall of unrelated churn; a sweep is a standalone decision with a standalone blast radius, and it needs its own per-name justification.

**A rename is a per-name decision, and it carries its reference count in the commit message.** When a name is renamed under this ADR — one name, one decision — the commit message states the measured reference count for that symbol at rename time (§6's own convention: a count next to the name it measures, so the cost of the decision is legible in the object database rather than reconstructed later). And where the symbol is read as **source** by its tests, the rename moves those tests in the same commit — §6's rule for `Reasoning` and `TodoBoardPanel`, which are grep'd as source by their own tests, so a rename that leaves a source-grep test pointing at the old spelling ships a red suite. That requirement was §6's observation; it is this ADR's rule from here on.

**The guard applies to copy and to new identifiers — as a review rule, and with NO guard test promised.** The scan this ADR's sibling proposal sketched (a recursive walk over user-visible strings, classifying and failing with a named list, following the `src/lib/classNameConvention.test.ts` shape) is **a possible future mechanism, not a consequence of this decision**. It is explicitly out of the backlog, for the reason the review's own Decisions section gives: the exemption problem is a design task in its own right — the blessed exceptions are per-symbol (the **Agents** entry blesses four `Subagent*` names by name), and any string that *quotes* the glossary must be exempt — so a guard built as a rider to this ADR would need an exemption set nobody has designed. **This ADR does not authorise building it.** Read the sentence above — "a conformance defect in review" — as the whole enforcement this ADR licenses.

**This ADR supersedes nothing, and narrows nothing that existed.** Its `superseded-by:` field is empty and no host document gains a `*Partial:*` note, because there is no prior ruling to narrow: the D5 authority gap was a **vacuum**, not a decision. §6's record is that the citation did not resolve, not that some ADR said "no" — so nothing here overrides an earlier answer, and the previous batch's failure is not a precedent this ADR has to overturn, only an absence it fills.

## Non-goal — the five D5 renames are OUT, with their measured cost, and this ADR must not be read as resurrecting them

`docs/roadmap/frontend-component-extraction-follow-ups.md` §6 is the authority record for the five renames the frontend-extraction audit proposed, and **it stays the authority record**. This ADR does not revisit them, does not re-measure them, and does not un-defer any of them. The figures below are §6's measurements, quoted with attribution, not new ones.

| Deferred rename (§6) | Measured cost (§6: references / files) |
|---|---|
| `ChatStream` → `MessageList` (+ a `components/chat/` move) | 779 references across 74 files |
| `Reasoning` → `ReasoningBlock` | 295 / 24 |
| `MessageBubble` → `MessageRow` | 147 / 17 |
| `TodoBoardPanel` → `TodoBoard` | 71 / 8 |
| Retiring the bare `rail` | §6 records the rename; it carries no count for it |

The count convention is §6's: **references per name, across files** — a reference count is the cost of a rename, which is why §6 records it per name rather than as one total. §6 also measured the thing everyone assumed was the cost and found it was not: production carries `data-testid`s across many files, and the two files the audit worried most about carry one between them — *so testid churn was never the real cost and the reference count always was*. `Reasoning` and `TodoBoardPanel` carry the extra obligation named in the consequences above: they are read as source by tests.

**This ADR cannot be read as resurrecting those five renames, and any reader who takes it that way has read it backwards.** The rule this ADR states binds *new* code and *touched* files; §6's five names are neither. That misreading is the exact failure mode this ADR exists to prevent — a glossary-derived citation standing in for a decision that was never made — so the non-goal is stated in the ADR that grants the authority rather than left to the follow-up file that withheld it. And the glossary itself runs the other way, deliberately: `CONTEXT.md`'s **Agents** entry states that `SubagentDelegatingCard`, `SubagentTranscript`, `SubagentModals` and `usePendingSubagentRequests` keep their names today. The glossary blesses the *non-renames* by name and says nothing about the five; that silence is a choice, and this ADR does not change it.

## Consequences

- **The glossary becomes the naming authority, which makes an un-termed concept a defect.** A governing layer that lands with no term — the class this wave's naming finding documents — is now not merely a documentation gap but the reason a future name has nothing to conform to. Terms are added to `CONTEXT.md` when the concept lands, not later.
- **`_Avoid_` lists get teeth on new code and still none on old code.** The lists bind a name a change introduces; they do not license editing a name a change does not touch. A reviewer citing an `_Avoid_` entry against pre-existing code in an untouched file is citing this ADR wrongly.
- **A rename now has a shape.** One name, one commit, reference count in the message, tests that read the symbol as source moved in the same commit. A commit that renames two unrelated symbols has made two decisions and should say so twice or be two commits.
- **No copy guard, stated as out.** No test file is added by this decision and none is promised by it. If someone later designs the exemption set — per-symbol blessings plus a glossary-quoting exemption, each entry carrying its reason — that is a fresh proposal with its own ADR, not a follow-up this one owes.
- **Nothing in this ADR executes a rename.** It authorises the *rule*; the wave's executable renames (the wire-rename row, gated on this ADR's existence) are separate tasks, each carrying its own counts and each verifying before it starts that no persisted serde field changes spelling.
- **The `classNameConvention.test.ts` precedent is cited as a shape, not as a mandate.** That file's own doc-comment explains why a count never goes into prose when a test owns it, and this ADR obeys the same rule: the only counts here are §6's measurements, attributed to §6, and no test in this repo owns any of them.

## Honesty about what this ADR could not check

- **Nothing was executed to write this.** It is a docs-only artifact: no `cargo`, no `pnpm`, no script. Every claim above is read from source or quoted from a document — `CONTEXT.md`'s entries, §6 of the follow-ups file, the parent review's naming findings, and the naming finding's proposal text.
- **The reference counts are §6's, not re-measured.** They were measured against the tree at the commits the wave records, and they are quoted here attributed. They are also not this ADR's numbers to re-check: they are the cost of renames this ADR explicitly declines to authorise, and a re-measurement would read as an argument that the numbers had changed meaning.
- **"76 files / highest 0085" is a working-tree fact at execution time**, and the `git log --all` probe is the half that reaches beyond it. A branch created after this ADR was written cannot collide with it; a branch created before, and not visible to `--all` on the machine that probed, could. That is the residual the two-probe idiom shrinks but cannot eliminate.
- **This ADR cannot prove its own enforcement.** It states a review rule; no test observes whether reviewers follow it, and the guard that could is the mechanism this ADR declines to license. The honest summary is that conformance now has an authority it lacked, and still no automated enforcer — which is the state the decision chose, not an oversight in its execution.
