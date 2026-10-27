---
status: accepted
date: 2026-10-27
superseded-by:
---

# An unknown top-level tool parameter rejects the call — and the pre-dispatch verdict is what makes rejecting free

A tool call that passes a key the model was never shown used to be **answered as a success**: the tool ran, and the sentence naming the misspelled key rode along as a second text block inside that success. We decided it **REJECTS** the call instead — no dispatch, no permission prompt, and the sentence becomes the whole tool result with `is_error: true` (`unknown_param_error` in `harness/tool_specs.rs`, consumed by `run_tool_batch` in `harness/loop/turn.rs` as `unknown_param_result`). This lands as a **narrowing of issue #78**, not a reversal of it: every rule #78 chose about *how* the check works survives byte-for-byte, and exactly one of its rulings falls — the `subagent` exemption.

**Narrows issue #78 PARTIALLY — one clause, and be exact about which one.** (The idiom is ADR 0034's, and the reason for the qualifier is ADR 0030's: **"No `superseded-by` — a narrowing that keeps the original's decisions intact"**.)

**Why:** "warn and succeed" reports success for a call that did something else, and here the something-else is not cosmetic — a silently-dropped parameter **changes behaviour**, because the executors read their keys with defaults that answer a typo by doing the conservative thing and then reporting it as the requested thing. Measured in the tree:

- `exec_edit` reads exactly `.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false)` (`tools/exec/fs_tools.rs`), so a camelCase `replaceAll: true` is invisible to it. The edit runs **first-occurrence-only**, reports `Edited <path>` with `"occurrences": 1`, and leaves the file in a state the caller did not ask for. That is pinned as a characterization test on purpose: `edit_ignores_a_misspelled_replace_all_and_understates_the_write` (`tools/exec/tests/fs_tools.rs`), whose stated reason for existing is that the central check "cannot be deleted later on the theory that the executors would catch it — they would not."
- `exec_read` reads `.get("offset").and_then(|v| v.as_u64()).unwrap_or(1)`, so a typo'd `offset` (or `limit`) **silently reads from line 1** and reports success. **Recorded honestly: this half is reasoned from the code, not pinned** — `edit` has the characterization test above and **no equivalent exists for the read side**. Whether to add one is a follow-up, not a claim of this ADR.

`is_error` is on the wire as `isError` (`tools/types.rs`) and is what renders the tool card, so a warning inside a success is not a footnote — it is a false report to the model, to the UI and to the persisted transcript, all three of which read the same `result.content`.

## What survives of #78, and what falls

**Unchanged, by measurement and not by assertion** — the doc comment carrying rules 1–4 and the closing "TOP-LEVEL ONLY, and it never mutates" sentence is **byte-identical** between `f0c2aca` (pre-change) and this commit; only the `fn` line differs:

- **Top-level only** (rule 3): nested keys are never inspected, so `ask`'s nested `recommended` stays legal, unadvertised and untouched — and `docs/features/mcp-known-gaps.md`'s statement that "#78's checker is top-level-only, so it can never fire on a nested key" remains true after this ADR.
- **Generic**: one central checker over `advertised_specs()` — the SAME value `model_request` sends as `tools[]` and the prompt renders into `<tools>` (ADR 0017's byte-identity). **No `deny_unknown_fields`, no per-executor key validation, no second table to drift.**
- **Never mutates**: "a pure function of `(specs, tc)` returning display text, so it is safe to call before a dispatch has decided anything." That purity is precisely what makes a pre-dispatch call legal at all.
- **Rules 1 and 2** (no spec for the alias-normalised name → no check; `parameters.properties` absent or not an object → no check) are untouched, and both exemption tests still assert `None`, byte-unchanged.
- **`suggest()`** and its deliberately separator-blind behaviour (`agent_name` gets NO suggestion and is still reported) are untouched — the suggestion is the half the model needs in order to retry.
- The alias **`dispatch_subagent`** still resolves to the `subagent` spec via `effective_tool_name`, so it is checked against the shape the model was actually shown and the message names the canonical tool.

**Falls — exactly one thing:** #78's ruling that a mis-named `subagent` parameter must not fail the call, pinned at the time by `a_mis_named_subagent_param_still_dispatches_and_announces_itself`.

**Why that clause falls, in #78's own terms.** #78's verdict ran **after** the child existed, so the only remedy it could reach was "dispatch anyway and announce" — failing the call would have destroyed an expensive, already-**completed** delegation over a typo. #93 moved the *same verdict* to a **pre-dispatch** rejection, so there is no completed delegation left to be lenient about. That argument is the rewritten test's own premise-change comment (`loop/tests/subagents.rs`, `a_mis_named_subagent_param_is_rejected_and_never_dispatches_a_child`): "there is no completed delegation left to destroy, and #78's subagent exemption has no remaining justification". And the assertion was **not quietly nudged**: the test was renamed, its doc comment rewritten as the premise change, and its child-output assertions **deleted** — there is no child output any more, the rejection IS the result — rather than inverted. `2291d37` proves the new assertion can fail by mutation: deleting the rejection arm and neutering the futures' `.filter()` reddens it, with the pre-change payload, and `turn.rs` was then restored byte-identical.

**The convention's one step we could not take, recorded so nobody looks for it.** 0033's mechanism is a `*Partial: see ADR 00NN*` note appended **to the narrowed ADR** (0030 states its own narrowing "here rather than in 0031 because that ADR is merged, hence append-only"). **#78 has no ADR** — its ruling lives only in code comments and test names, and nothing in `docs/decisions/` mentions the parameter check at all. There is therefore **no host to append to**, and this ADR carries the whole narrowing statement itself, pointed at an **issue number and a test name** instead of an ADR number. If a #78 ADR is ever written, the narrowing note belongs there too, mirrored.

**This ADR does NOT narrow ADR 0020.** A reader who finds "(issue #78, ADR 0020)" at `harness/prompt.rs:17` and `:543` may assume the parameter check and the agent-definition ADR are the same decision. They are not: 0020 decides agent-definition discovery and that `agentName` is the default route; it says nothing about unknown parameters. Those two `prompt.rs` sites describe the `agentName` guidance and are untouched by this change.

## The mechanism: pre-dispatch, once per batch, gating TWO places

`run_tool_batch` computes the verdict **once per batch over the whole batch**, before the `join_all`, from one `advertised_specs()`. It has **two consumers, and naming only the first is the trap**:

1. the dispatch loop's **rejection arm**, and
2. the **subagent futures' `.filter()`**.

The second is load-bearing in a way the first is not: those futures are built and awaited **before** the per-`tc` loop runs, so a rejection living only in the loop **would have already spawned the child it then refuses to report**. Without the `.filter()` gate, "rejecting costs nothing" is false for **exactly the one tool whose exemption was removed** — which is the whole reason #78's exemption became void. Pinned by `a_rejected_subagent_call_never_creates_a_child`, whose proof is structural: `MockDispatcher::dispatch()` pops one queue entry per child, so a still-full queue after the turn means no child was ever spawned.

Two properties the code comments mark as load-bearing, which a well-meaning refactor will otherwise break:

- **The `.filter()`'s `idx` is the call's ORIGINAL index and must not be renumbered.** It comes from the `.enumerate()` *before* the filter, and the dispatch loop keys `subagent_results.remove(&idx)` on the same original index. Re-enumerating after the filter — "tidying" it into a 0-based position among the survivors — silently mis-keys every child result in any batch that mixes rejected and accepted `subagent` calls.
- **Cancellation is deliberately NOT consulted in the `.filter()`** — the whole batch already sits behind `if turn.is_cancelled()`.

## Three ordering rules are now load-bearing

1. **Cancellation beats rejection, on BOTH arms** (the `subagent` match and the sequential chain). A call that never ran because the user stopped the turn must not be told to "fix the key and retry". Pinned by `a_cancelled_turn_reports_cancelled_and_not_a_rejection` (sequential arm, end-to-end) and `a_cancelled_subagent_call_reports_cancelled_and_not_a_rejection` (`subagent` arm, `run_tool_batch` driven directly on an already-cancelled token). **The pin's own honesty note, recorded because a future reader will otherwise "simplify" it:** `content[0] == "cancelled"` is green on **both** sides of the change — at the pre-change base `f0c2aca` there was no rejection arm for it to beat, which is structural, not a harness gap. The discriminating evidence is the **PAIR** with `content.len() == 1`, which was RED at that base because the append block reached the synthetic `cancelled` result. Deleting either assertion deletes half the ordering evidence.
2. **A rejected call never reaches the permission gate.** The rejection arm precedes the `policy_verdict` / `gate_tool` match: no prompt for a call that will not run. Pinned by `a_rejected_call_never_reaches_the_permission_gate`, and that test is **non-vacuous for a specific reason** worth repeating: its `path` is a **legal-shaped** string pointing **outside** the boundary with `writes: "ask"`, because a typo'd `path` would make `policy_verdict` answer `Allow` for the missing-path reason and the test would pass for entirely the wrong reason.
3. **The rejection arm precedes the `dispatch_tool` fallback.** `dispatch_tool`'s own `subagent` / `dispatch_subagent` alias arm routes straight to `dispatch_subagent`, and that fallback is a **LIVE path**, not a hypothetical: `is_subagent_call` accepts the alias, while `is_enabled_subagent_call` — the futures' filter — additionally requires `enabled_tools`. A rejection placed **after** the fallback would dispatch the very child it rejects.

## The censuses are the invariant that keeps #82's legal aliases from becoming rejections

As a **warning**, an unadvertised-but-legal key was a cosmetic nuisance. As a **rejection** it breaks that tool's **EVERY** call. That is a change of kind, not of degree, and it is guarded by four censuses:

1. `tool_specs_advertise_exactly_the_executor_param_keys` — the 12 `exec_param_keys()` tools;
2. `the_web_tool_specs_advertise_every_key_the_handlers_read` — the 3 web tools, including **every camelCase alias and `proxy`** (#82's interim: advertised == accepted);
3. `the_suite_tool_specs_advertise_every_key_their_handlers_read` — **new in #93**: the five loop-internal tools `exec_param_keys()` omits;
4. `every_loop_internal_tool_is_covered_by_a_param_key_census` — **new in #93**, the census-of-censuses: it closes the union of the two tables so a sixth loop-internal tool cannot escape both.

#82 settled that both spellings are advertised, and #82's aliases are precisely what a missing census would now reject — census 2's own failure message says the camelCase alias stays advertised *because the handler honours it*. `docs/features/mcp-known-gaps.md` records "#78's unknown-param checker has zero known false positives"; this ADR is what raises the price of losing that. **Censuses 1 and 2 were required to stay green UNMODIFIED** (`51b5d7a` verifies they did) — a census edited to accommodate the change is not a safety net.

**Four of five, not five.** `ask`, `sudo_exec`, `manage_todo_list` and `mcp` had **no guard of any kind** before #93 — by-hand agreement between a spec and a handler is not a guard, and that is what turned a cosmetic gap into a tool-breaking one. The fifth suite tool, **`subagent`, already had** `the_subagent_spec_advertises_every_param_the_executor_reads`, an exact-set census of its six keys that predates this work (present at `f0c2aca`). So `subagent` — the very tool whose exemption was removed — is the **best**-guarded of the five, which is worth stating precisely because it is counter-intuitive, and because "the suite tools had no census" is false as written. The consequence is an **intentional duplication**: `subagent` is now exact-set censused twice (`the_subagent_spec_advertises_every_param_the_executor_reads` and the `subagent` row of `suite_param_keys()`), with identical key sets. Not a defect — do not "consolidate" them and silently drop one.

## What refutes this

> If a real provider is observed sending a harmless extra top-level key on an otherwise-valid call, the check is too strict and the exemption needs widening.

That is stated as a **live obligation, not a discharged one**: nothing in this tree observes live provider traffic, and this app speaks three wires, so "no provider does this" is not a claim anyone here is entitled to make. And the remedy is **not** what "widen the exemption list" suggests — measured here, **there is no exemption list in the code at all**. What exists are **four structural exemptions**, inherited unchanged from #78, none of them a per-key list:

1. no spec for the alias-normalised name (rule 1) — `an_unknown_tool_name_is_never_checked`;
2. `parameters.properties` absent **or not an object** (rule 2) — `a_spec_with_no_properties_is_never_checked`, which pins **both** the bare `{"type":"object"}` case (`list_agents` / `list_skills` are bare in the tree) **and** a non-object `properties`;
3. `tc.arguments` not an object (the `as_object()?` early return) — a JSON array, string or number payload simply has no keys;
4. malformed JSON, collapsed upstream (see the limit below).

So the falsifier's remedy is **a NEW mechanism** — designing a per-tool or global key allow-list — not adding a name to an existing one. A responder deserves to know which of those two jobs they are being handed.

## The model-facing sentence is a pinned contract with exactly one home

    unknown param(s) for `subagent`: `agent` (did you mean `agentName`?) — the call was rejected, fix the key and retry.

The whole sentence is pinned byte-for-byte by **`an_unknown_param_is_reported_with_a_suggestion`** (`tool_specs.rs`), and that test is its **single home**. Three things about it:

- the `(s)`, the backticks, the em dash and the closing `fix the key and retry.` are **all** part of the contract, because **the model learns the habit from this sentence** — a drift is a regression, not a reword;
- **both** keys sit inside the one literal (the unknown `` `agent` `` and the suggested `` `agentName` ``), so a `suggest()` that stopped firing **reddens** the test instead of quietly degrading the message;
- `param_rejection.rs` asserts `starts_with` / `contains` **only, deliberately**, so the wording has exactly one byte-exact home. Preserve that split; do not "strengthen" the loop tests into a second literal pin.

Two halves of the old sentence are **history, not current text**: the `⚠ ` prefix marked a warning riding inside a **success**, and `— ignored.` became a lie once the call was rejected. The function's own former name, `unknown_param_warning`, is likewise historical — it no longer exists in the tree.

## The known limit: malformed JSON reaches the executor

`parse_arguments` (`provider/openai.rs`) collapses empty and unparseable arguments to `{}` and logs `harness: malformed tool-call arguments — using {}`, so such a call **has no keys to reject** and still reaches the executor. Pinned by `parse_arguments_handles_empty_and_malformed`. This is a **limit, not a defect, and it is unchanged by this work**. Two things about its scope that are easy to understate: it lives in `openai.rs` but is imported and used by **all three** parsers (`openai.rs`, `anthropic.rs`, and `responses.rs` at two sites), so the limit is **wire-universal**, not OpenAI-specific. And its second face: `unknown_param_error` runs on the **parsed** value, so a call whose JSON was valid but produced a non-object also has nothing to reject (exemption 3 above).

## Considered Options

- **Keep the warning, add `is_error: true` alongside the tool's own output**: rejected — that is the false report with a second flag on it. The tool DID run and DID produce output the caller did not ask for; a success card that also errors teaches the model nothing about which half to trust.
- **Make the executors validate their own params (`deny_unknown_fields`, a typed arg layer)**: rejected — there is no typed arg layer to attach it to, and it would create a **second** table of legal keys to drift from the advertised shapes, which is the defect class the single central checker exists to avoid. `edit_ignores_a_misspelled_replace_all_and_understates_the_write` exists precisely to keep this option from being re-justified later on the theory that the executors would catch it.
- **Leave `subagent` exempt (the narrowest possible change)**: rejected — the exemption's only premise was the wasted completed delegation, and the pre-dispatch placement removes that premise. Keeping the exemption would preserve a ruling whose reason no longer exists, on the one tool that is best guarded against exactly the false positive the exemption was protecting against.
- **Move the check inside `dispatch_tool`** (where every other per-call decision lives): rejected — the subagent futures are awaited before the dispatch loop, so a check there prevents nothing for `subagent`; it would announce waste it had already paid for. This is the same reason #78 ran it early; #93 is what made running it early *save* something.
- **Supersede #78 outright**: rejected — see the convention above. Every rule #78 chose about how the check works survives; a `superseded-by` would erase the record of which decisions were re-affirmed, which is the part a future reader needs.

## Consequences

- **A typo is now a round trip.** The model gets `is_error: true` naming the key and the key it should have sent, and retries. That is one extra provider call per typo, paid by the session, in exchange for not silently doing the wrong thing — the trade this ADR exists to make explicit.
- **Every advertised spec is now load-bearing in a way it was not.** An unadvertised-but-legal key stops being a cosmetic gap and becomes a broken tool, which is why the four censuses above are the real safety net and why 1 and 2 had to survive unmodified. Adding a key to a handler means adding it to the matching census in the same commit.
- **`subagent` is censused twice on purpose** (`the_subagent_spec_advertises_every_param_the_executor_reads` and the `subagent` row of `suite_param_keys()`). Leave the duplication.
- **The `read` half of the argument is reasoned, not pinned.** A characterization test for `exec_read`'s typo'd `offset`/`limit` silently reading from line 1 does not exist; adding one is open work, and until it does, that claim rests on reading `.unwrap_or(1)`.
- **Malformed-JSON calls still reach the executor**, wire-universally, and this ADR does not change that.
- **The prose sweep is owned by a follow-up, NOT by this task.** ADR 0079 records the inventory; it does not execute the sweep. The scheduling reason is durable and worth keeping: this ADR runs **no `cargo` and no `pnpm` at all**, which is what lets it share a wave with a Rust task on the same crate (`archimedes` is ONE compilation unit, so two Rust tasks can never share a wave). Editing the Rust sites would put `cargo` into it and collapse exactly that. The measured inventory, at this commit:

  | File | Site | Actually stale? |
  | --- | --- | --- |
  | `src/lib/toolOutput.test.ts` | test name + doc + fixture `"⚠ … — ignored."` (2 occurrences) | **Yes — prose/fixture only; its assertion passes** (`normalizeToolOutput` still joins `content[]` text items; the retired sentence is synthetic input, not a pin on the new contract). Status: `recorded, not open work`, and it now matters *more* because the fixture depicts a message shape that no longer exists |
  | `tool_specs.rs` | test name `a_well_formed_call_produces_no_warning` | Yes — "no warning" is now "no rejection". **The rename is safe**: the name is referenced nowhere outside its own `fn` line (measured across `*.rs`, `*.ts`, `*.md`; no test-name census and no `stringify!` names it — the crate's two `stringify!` uses are in `exec/tests/bash.rs` and `sandbox.rs`, for other items) |
  | `tool_specs.rs` | local bindings `let warning =` — 2 in `an_unknown_param_without_a_close_match_is_still_reported`, 1 in `a_well_formed_call_produces_no_warning` | Cosmetic |
  | `tool_specs.rs` | `a_spec_with_no_properties_is_never_checked`'s doc "turn the warning into noise" | Yes |
  | `tool_specs.rs` | `the_web_tool_specs_advertise_every_key_the_handlers_read`'s doc "would be **warned on** every web call" | Yes — now "would be **rejected on**", and the stakes are far higher |
  | `agent/web/tools.rs` | `RESPONSE_ID_PARAM` doc: "#78's unknown-param checker CANNOT help, because by design it only looks at `properties`" | **No — still true** (rule 3 unchanged). The stakes changed, not the truth |
  | `agent/web/tools.rs` | "so the #78 checker does not flag a call the handler would honour" | **No — still true**; worth a stakes upgrade, not a correction |
  | `agent/web/tools.rs` | truncation-note test comment "invisible to the #78 checker (which reads `properties` only)" | **No — still true** |
  | `agent/harness/prompt.rs` (2 sites) | "(issue #78, ADR 0020)" | **Not stale at all** — they are the `agentName`-is-the-default-route guidance, untouched by #93. **Not sweep work** |
  | `agent/harness/loop/turn.rs` | anything outside the block #93 rewrote | **Nothing exists there** — grepping the whole file for `warn` / `ignored` / `#78` / `⚠` returns exactly one hit, the `// REJECTED, not warned` comment inside the rewritten arm. **Not sweep work** |
  | `docs/features/mcp-known-gaps.md` | "zero known false positives"; "#78's checker is top-level-only, so it can never fire on a nested key" | **No — both still true**, and both survive this ADR (the nested-`recommended` gap is unchanged because the check stays top-level) |

  Net: **the sweep is 2 files** (`src/lib/toolOutput.test.ts`, the `tool_specs.rs` test prose), not the four an earlier note implied, plus one optional cross-reference — adding a pointer to this ADR from `docs/features/mcp-known-gaps.md`, which is the durable place a reader already looks for the checker's guarantees. That last item is `docs/features/`, not `docs/decisions/`, so it is deliberately outside this ADR's own change. **This Consequences entry is the durable copy of that inventory**: the roadmap follow-ups file that also carries it is deleted on ship.
