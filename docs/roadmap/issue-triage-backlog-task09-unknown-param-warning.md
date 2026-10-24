---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 78
done-when: A `subagent({ agent: "reviewer", task: … })` call still dispatches and still succeeds, but its tool result now carries a second text block — `⚠ unknown param(s) for \`subagent\`: \`agent\` (did you mean \`agentName\`?) — ignored.` — that the model reads on the very next turn; the check runs for EVERY advertised tool before any subagent is spawned; the main prompt's subagent rule sends the model to `agentName` and warns that a `systemPrompt` replaces a definition's prompt; and the `subagent` spec finally advertises the `thinking` param it has honoured for months.
---

# Task 9 — The `subagent` param contract: unknown params announce themselves (issue #78)

**Goal:** Make a silently-dropped tool parameter loud. A model that passes `agent:` where the spec advertises `agentName` gets a non-blocking warning in the tool result naming both the bad key and the good one, and the two prompt surfaces that taught the wrong habit are corrected.

**Architecture:** One pure function — `unknown_param_warning(specs, tc) -> Option<String>` in `harness/tool_specs.rs`, the file that already owns the advertised shapes — called from `run_tool_batch` in `harness/loop/turn.rs` **before** the concurrent subagent `join_all`, and delivered by appending a `ContentBlock::Text` to the `ToolResult` the batch already puts on the wire and in the transcript. No provider change, no wire change, no `is_error` change, no new event, no new dependency. Alongside it: the `SUBAGENT_GUIDANCE` constant and the `subagent` spec description are rewritten to ADR 0020's doctrine, and `thinking` is added to the `subagent` spec's `properties` — the checker would otherwise flag a parameter the executor reads today.

**Tech Stack:** Rust 1.99.0 (pinned, `src-tauri/rust-toolchain.toml`), `serde_json::Map`/`Value` (default `BTreeMap` ordering — no `preserve_order` feature anywhere in `src-tauri/Cargo.toml`, verified in `Cargo.lock`: `serde_json 1.0.151` depends on `itoa`/`memchr`/`serde_core`/`zmij`, no `indexmap`), the existing `AgentLoop::advertised_specs()` as the single source of truth, React 19 + Vitest for one frontend pin in `src/lib/toolOutput.test.ts`.

---

## Parallelisation

**Verdict:** SERIAL — one task of the issue-triage backlog, and the parent already fixes it to the serial column (`docs/roadmap/issue-triage-backlog-status.md`: "T9 — needs T8 landed in `tool_specs.rs`"). The reason is measured, not assumed: `archimedes` is **one compilation unit**, so any sibling's half-finished `.rs` edit makes this task's `cargo test` fail to compile (planted-error experiment, same doc §"Why the waves collapsed to serial"), which destroys gate 4.

Consequence for the executor: **run the FULL gate**, not a scoped run — a scoped `cargo test --lib <filter>` compiles the whole crate here anyway, so scoping buys nothing. **T8 must be landed first**: it converts the `bash` description into a `BASH_DESCRIPTION` const pair in the same `tool_specs.rs` this task edits; do not touch what T8 wrote.

---

## Files

- Modify: `src-tauri/src/agent/harness/tool_specs.rs` (the new `unknown_param_warning` + `suggest` helpers, the `subagent` description, the `thinking` property, 6 new tests in `mod tests`)
- Modify: `src-tauri/src/agent/harness/loop/turn.rs` (the call site in `run_tool_batch`: compute before the `join_all`, append after the dispatch)
- Modify: `src-tauri/src/agent/harness/prompt.rs` (`SUBAGENT_GUIDANCE` at line 17 + one literal in `the_subagent_guidance_mentions_list_agents`)
- Modify: `src-tauri/src/agent/harness/loop/tests/subagents.rs` (one end-to-end test)
- Modify: `src/lib/toolOutput.test.ts` (one test pinning the joined multi-block render)

No file is created. No `Cargo.toml`, no lockfile, no ADR, no CI workflow, no `src/lib/toolOutput.ts` (the frontend already joins — verified below), no `docs/decisions/*` (this task makes the code agree with ADR 0020, it does not decide anything new).

---

## Context — why this exists, and what was verified against the tree

The trigger is live on the user's own machine: `~/.agents/skills` tells the model to write `subagent({ agent: "…" })`. Measured today: **25 `agent: "…"` call sites across 10 skill files** (`check-pr` ×3, `discuss` ×1, `finish` ×2, `greptile` ×1, `implement` ×2, `research/SKILL.md` ×4, `research/strategies/strategy-code-research.md` ×4, `review` ×5, `specify` ×1, `write-skills` ×2 — the issue's "15 across 10" and the task brief's "21 across 9" are both stale; the count moved, the shape did not). **Zero** of them say `agentName`. So every skill-driven delegation has been silently running a config-less child.

### Verified starting facts (all re-measured at `695d9ed`; the issue's line numbers were measured at `a6e3f02`)

- `src-tauri/src/agent/harness/dispatch.rs:271` — `params.get("agentName").and_then(Value::as_str).unwrap_or_default()` → `""` for an unknown key. `launch.rs:300-302` (`resolve_launch`: `let name = agent_name.trim(); if name.is_empty() { return launch.clone(); }`) and `launch.rs:306-308` (no matching definition → the same `return launch.clone()`) mean the launch is returned **verbatim**: the child runs with the parent's model, the parent's tool set and no persona, and `dispatch.rs:320-324` turns its output into a plain **success** `ToolResult`. Nothing on the wire distinguishes `agent: "reviewer"` from no name at all. Confirmed.
- **Placement is load-bearing and the issue is right about it.** `loop/turn.rs:347-430` `run_tool_batch` dispatches every `is_enabled_subagent_call` in a `futures_util::future::join_all` at **`turn.rs:371`** (the futures are built at 357-370), ahead of the sequential `for (idx, tc) in tool_calls.iter().enumerate()` loop at **`turn.rs:377`** that finally calls `dispatch_tool`. A check inside `dispatch_tool` (`loop/tools.rs:61`) fires only after the wasted child exists. Verified.
- `dispatch_tool`'s `other => … "unknown tool: {other}"` arm is at `loop/tools.rs:174-180` and returns `is_error: true` — so an unknown **tool** is already handled, and rule (a) below must not double-report it.
- `AgentLoop::advertised_specs()` is at `harness/loop.rs:926`; `model_request` (`loop.rs:907`, `tools: Self::advertised_tool_specs(&self.enabled_tools, self.subagent.is_none())`) and `advertised_specs` (→ the same private fn at `loop.rs:938`) return the **same value**, and `worker/core.rs:361` renders `loop_.advertised_specs()` into `build_main_prompt`, whose `<tools>` body is `- {name}: {description}` (`prompt.rs:54-63`). One value, one process: ADR 0017's byte-identity holds, so a checker reading `advertised_specs()` cannot disagree with what the model was told. **There is no second table to drift.**
- `ToolSpec { name, description, parameters: Value }` — `provider/types.rs:151-156`. `ToolCall { id, name, arguments: Value }` — `provider/types.rs:160-167`. `ContentBlock::Text { text }` / `ToolResult { content: Vec<ContentBlock>, details, is_error }` (serialized `isError`) — `tools/types.rs:11-48`.
- **Delivery is free.** `turn.rs:405-419` serializes the whole `ToolResult` into `tool_execution_end`, then pushes `MessageContent::Blocks(result.content.clone())` onto the transcript and persists it. All three provider wires carry **every** block: `MessageContent::to_wire` (`provider/types.rs:96-121`, OpenAI parts array), `anthropic_tool_result_content` (`anthropic.rs:527-534`, a block array inside `tool_result`), `responses_content_wire` (`responses.rs:481-487`, `function_call_output.output`). No provider edit is needed.
- **The frontend claim holds — it is NOT a first-block-only renderer.** `src/lib/toolOutput.ts:435-448` (`normalizeToolOutput`) walks the WHOLE `content[]` array, collects every `{type:"text"}` item into `parts` and returns `parts.join("\n")`; it reaches the `details` fallback only when the joined text is empty. `ToolCallCard.tsx:71-74` feeds it the raw result. `failureText` (`toolOutput.ts:599-617`) takes the first non-empty text but runs only for `status === "failed"`, and this result is not failed. `summarizeSubagentDetails`/`subagentActivityFor` read `details`, never `content`. So the appended block appears in the expanded card body, on a new line after the child's output. **Finding (cosmetic, accepted):** the collapsed header (`summarizeToolCall`) reads the tool INPUT, so the warning is only visible once the card is expanded — the model sees it either way.
- **Malformed JSON needs no special case:** `provider/openai.rs:370-381` `parse_arguments` collapses empty AND unparseable argument text to `{}` (with an `eprintln!`), shared by all three providers (`anthropic.rs:430`, `openai.rs:343`, `responses.rs:18`). No keys ⇒ no warning. Confirmed.
- `thinking` is a real, functional, unadvertised param: `interactive/mod.rs:144-147` (`dispatch_params` reads `params.get("thinking")` into `LaunchConfig::thinking`), consumed in `worker/manager/subagent_flow.rs:553-562` as the **top rung** (`launch.thinking` > the model key's `:<level>` suffix > `frontmatter_thinking`, then validated against `model.thinking_levels`). The `subagent` spec (`tool_specs.rs:225-235`) advertises `task`/`agentName`/`model`/`systemPrompt`/`tools` and NOT `thinking`. Confirmed — shipping the checker without step 4 would flag a legal param on the first dispatch that uses it.
- The `subagent` description is the single literal at `tool_specs.rs:224`; `prompt.rs:17` is the only `SUBAGENT_GUIDANCE` definition. Grepped repo-wide (Rust `src`+`tests`, `src/`, `scripts/`, `docs/decisions/`): **no other file, test or frontend mirror quotes either string**, except `prompt.rs`'s own tests (below).
- `~/.agents/agents/reviewer.md` does carry `skills:`, `systemPromptMode:`, `inheritSkills:`, `model_kwargs:`, `options:`, `subtask:` and `agents.rs`'s `parse_agent_file` (`agents.rs:271-395`) reads ONLY `name`/`description`/`model`/`thinking`/`tools` + the body. Out of scope (see *Recorded*).
- `src/lib/skills.ts:744` already tells the model `Dispatch a subagent with agentName "NAME"` in the composer's `@agent` block — the new guidance agrees with it; no frontend change is needed for consistency.

### Corrections to the issue's claims (verified; do not implement the issue's version)

1. **`dispatch_subagent` is a real alias and the issue's rule (a) would miss it.** `dispatch.rs:176-192`: `effective_tool_name("dispatch_subagent") == "subagent"` and `is_subagent_call` accepts both; `loop/tools.rs:80-83` routes both to `dispatch_subagent`. So `dispatch_subagent` is NOT an unknown tool — `dispatch_tool`'s `unknown tool:` arm never sees it — yet it has no spec of its own, so a spec lookup on `tc.name` alone would skip the check for exactly the tool this task is about. **Look the spec up by `effective_tool_name(&tc.name)`** (already `pub(crate)`), and report the spec's own name in the message.
2. **Only ONE prompt test literal must move, not three.** The issue names `the_subagent_guidance_mentions_list_agents` (its literal is at `prompt.rs:546`) *and* "the full-order assertions at `prompt.rs:425` and `prompt.rs:521`". Verified: those two lines are exactly the interpolations — `main_prompt_full_shape`'s golden `<rules>` block embeds `- {SUBAGENT_GUIDANCE}` at `prompt.rs:425` (the test fn starts at `prompt.rs:378`) and `main_prompt_rules_conditional`'s "all 4 lines in the exact order" assertion embeds it at `prompt.rs:521` (test fn at `prompt.rs:471`). Both are `format!`/raw-string **interpolations of the constant**, so they follow the new text with no edit at all. And the absence assertion at `prompt.rs:491` (`!prompt.contains("Delegate independent subtasks")`) stays correct **because the replacement keeps that leading clause** — see the note in step 2. `main_prompt_omitted_sections` (`prompt.rs:553`) asserts only the two pi lines, which are untouched.
3. **`tool_specs.rs`'s existing key-table tests need no change.** `exec_param_keys()` (test module, `tool_specs.rs:341`) lists 12 tools and both `every_tool_spec_is_in_the_param_key_table` and `tool_specs_advertise_exactly_the_executor_param_keys` skip `LOOP_INTERNAL_TOOLS = [ask, sudo_exec, manage_todo_list, subagent, list_agents, mcp]` — `subagent` is in that list, so adding `thinking` to its properties touches neither test.
4. **No existing test counts a `subagent` result's blocks.** Grepped: every `result["content"][0]["text"]` assertion in `loop/tests/*` and `tests/*` is on a `bash`/`read`/policy-denied/cancelled result (`policy_gate.rs:203,329,704`, `turn_lifecycle.rs:1521,1613`, `compaction_overflow.rs:610,764`, `subagents.rs:193,547`, `interactive/mod.rs:1185`), and `tests/harness_subagent_dispatch.rs:224-245` JOINS all blocks. Appending a second block therefore breaks nothing — **provided we append (never prepend)**, which keeps `content[0]` the child's own output.

### Decisions already taken by the issue — do not re-litigate

- `agentName` stays canonical. **No `agent` alias** in the executor: the warning is the teaching mechanism, and it treats `agent` like any future misspelling. Accepted cost: until the skill files migrate, each skill-driven dispatch spawns one wasted config-less child, then corrects next turn.
- The warning is **non-blocking**: `is_error` stays `false` — the tool ran and its output is real; flipping it would fail an otherwise-good long delegation over a typo.
- The check is **generic to all advertised tools**, not subagent-only.
- The trailing `— ignored.` is required, not decorative: it is what lets the model infer the child it just spawned had no persona.

---

## Design

### 1. `unknown_param_warning` — `src-tauri/src/agent/harness/tool_specs.rs`

Change the file's second line from `use serde_json::json;` to `use serde_json::{json, Map, Value};` and add `use crate::agent::harness::provider::ToolCall;` next to the existing `ToolSpec` import (line 3). Then add, after `tool_specs()` closes (after line 332) and ABOVE `#[cfg(test)] mod tests`:

```rust
/// (issue #78) The warning for a tool call that passes a key the model was
/// never told about, or `None` when there is nothing to say.
///
/// WHY IT LIVES HERE: this file owns the advertised shapes, so the known-key
/// set and the shape the model was shown stay in one place. Callers MUST pass
/// `AgentLoop::advertised_specs()` (`loop.rs:926`) — the SAME value
/// `model_request` sends as `tools[]` and `build_main_prompt` renders into
/// `<tools>` (ADR 0017's byte-identity) — so a check can never disagree with
/// the prompt and there is no second table to drift.
///
/// The rule, in order:
/// 1. No spec for the (alias-normalized) name → NO check. An unknown tool is
///    already a hard error in `dispatch_tool`'s `unknown tool:` arm
///    (`loop/tools.rs:174-180`), and a tool the session disabled is not in
///    `advertised_specs()` either — the model was never told it existed.
/// 2. `parameters.properties` absent or not an object → NO check.
///    Load-bearing: `list_agents` / `list_skills` are a bare
///    `{"type":"object"}`, so inferring "nothing is allowed" there would flag
///    EVERY key on EVERY call.
/// 3. Every TOP-LEVEL argument key absent from `properties` is reported.
///    `required` is irrelevant — only `properties` defines legality — and
///    nested keys are never inspected (an `ask` question's `recommended` is
///    legal, unadvertised and nested, so it stays untouched).
/// 4. At most one suggestion, drawn from the `properties` keys ONLY, by
///    case-insensitive containment in either direction — so `agent` →
///    `agentName`. Never suggested from anything but the advertised shape.
///
/// TOP-LEVEL ONLY, and it never mutates: a pure function of `(specs, tc)`
/// returning display text, so it is safe to call before a dispatch has
/// decided anything. Malformed JSON needs no branch — `parse_arguments`
/// (`provider/openai.rs:370-381`) already collapses unparseable arguments to
/// `{}`, and a non-object payload simply has no keys.
pub(crate) fn unknown_param_warning(specs: &[ToolSpec], tc: &ToolCall) -> Option<String> {
    // The `dispatch_subagent` alias resolves to the `subagent` spec — the
    // same `effective_tool_name` `is_tool_enabled` gates on, so the alias is
    // checked against the shape the model was actually shown and the message
    // names the canonical tool, not the alias it guessed at.
    let spec = specs.iter().find(|s| {
        s.name == crate::agent::harness::dispatch::effective_tool_name(&tc.name)
    })?;
    let properties = spec.parameters.get("properties")?.as_object()?;
    let args = tc.arguments.as_object()?;
    let mut items: Vec<String> = args
        .keys()
        .filter(|key| !properties.contains_key(key.as_str()))
        .map(|key| match suggest(key, properties) {
            Some(hit) => format!("`{key}` (did you mean `{hit}`?)"),
            None => format!("`{key}`"),
        })
        .collect();
    if items.is_empty() {
        return None;
    }
    // `serde_json`'s default `Map` is a `BTreeMap` (`Cargo.toml` never enables
    // `preserve_order`; `Cargo.lock`'s `serde_json 1.0.151` pulls no
    // `indexmap`), so `args.keys()` — and `properties.keys()` — iterate in
    // sorted order already. The message is therefore deterministic with no
    // extra sort, which is what lets a test pin it byte-for-byte.
    items.sort();
    Some(format!(
        "⚠ unknown param(s) for `{}`: {} — ignored.",
        spec.name,
        items.join(", ")
    ))
}

/// The ONE suggested name for `key`: the first advertised property that shares
/// a case-insensitive substring with it in either direction — so `agent` →
/// `agentName` (the advertised name contains the typed one) and a hypothetical
/// `name` → `agentName` too. Searching the advertised keys ONLY is the point:
/// a suggestion the model cannot legally send is worse than none.
/// Deliberately separator-blind: `agent_name` gets NO suggestion (the `_`
/// survives `to_lowercase`, so neither string contains the other) — it is still
/// REPORTED, which is the half that matters; normalizing separators would
/// suggest across unrelated names and buys nothing the report does not already
/// say.
fn suggest(key: &str, properties: &Map<String, Value>) -> Option<String> {
    let lower = key.to_lowercase();
    properties
        .keys()
        .find(|name| {
            let l = name.to_lowercase();
            l.contains(&lower) || lower.contains(&l)
        })
        .cloned()
}
```

`items.sort()` is redundant-but-intentional (it makes the determinism local rather than a dependency on serde_json's map type); keep it and its comment. Note `⚠` is U+26A0 with NO variation selector and the dash is an em dash `—` — the exact bytes are pinned by a test below.

### 2. The call site — `src-tauri/src/agent/harness/loop/turn.rs`

Two edits inside `run_tool_batch` (`turn.rs:347`), nothing else in the file.

**(a) Compute the warnings BEFORE the concurrent dispatch.** Immediately after `let mut turn_tool_results = Vec::new();` (line 352) and BEFORE `let mut subagent_results: HashMap<usize, ToolResult> = if turn.is_cancelled() {` (line 353), insert:

```rust
// (issue #78) The unknown-param check runs HERE, before the `join_all`
// below, and NOT inside `dispatch_tool`: a `subagent` call is dispatched
// CONCURRENTLY ahead of the sequential loop, so a check that ran inside the
// dispatch would announce itself only after the wasted config-less child
// already exists. One `advertised_specs()` per batch — the SAME value
// `model_request` sends as `tools[]` and the prompt renders into `<tools>`,
// so the checker cannot flag a key the model was told to send.
let specs = self.advertised_specs();
let warnings: Vec<Option<String>> = tool_calls
    .iter()
    .map(|tc| crate::agent::harness::tool_specs::unknown_param_warning(&specs, tc))
    .collect();
```

Indexing `warnings` by the SAME `idx` the batch already uses (`tool_calls.iter().enumerate()`) is deliberate — no `HashMap`, no id lookup, and the order is the model's own call order.

**(b) Append the block after the dispatch, before serialization.** The sequential loop's `let result = if … { … };` initializer ends at line 404 (`            };`). Insert directly after it and before `let result_value = serde_json::to_value(&result).unwrap_or(Value::Null);` (line 405):

```rust
// The warning travels with the result it describes: appended LAST, so
// `content[0]` stays the tool's own output (every existing assertion and
// the UI's child-output render are untouched), and `is_error` stays
// whatever the tool decided — a typo must not fail a good long delegation.
// One push covers all three consumers below: the `tool_execution_end`
// payload, the transcript `tool` message (`result.content.clone()`) and the
// persisted row. On a cancelled turn the result is the synthetic
// `"cancelled"` block and the extra line is harmless truth, so no branch.
if let Some(Some(warning)) = warnings.get(idx) {
    result.content.push(ContentBlock::Text {
        text: warning.clone(),
    });
}
```

`ContentBlock` is already imported in this file (`turn.rs:15`). The `result` binding at line 378 must become mutable for the push: change `let result = if crate::…is_subagent_call(&tc.name) {` to `let mut result = if …` (the same binding, one keyword — no other line in the initializer moves).

Nothing else changes: `turn.rs:405-419` (`serde_json::to_value(&result)` → `tool_execution_end` → `MessageContent::Blocks(result.content.clone())` → `persist_transcript_message`) and `self.note_context()` at 421 are already block-agnostic.

### 3. `SUBAGENT_GUIDANCE` — `src-tauri/src/agent/harness/prompt.rs:17`

Replace the constant's value with exactly:

```rust
const SUBAGENT_GUIDANCE: &str = "Delegate independent subtasks with subagent — pass a discovered agent's name in `agentName` (`list_agents`) and put your constraints in the task text; do NOT pass a `systemPrompt` alongside `agentName`, it replaces the agent's own prompt";
```

- The clause ordering IS the fix: the definition becomes the default route and hand-shaping is what now needs justifying. The old sentence preached ADR 0017's superseded "shape it with systemPrompt **or** use a discovered agent" doctrine; ADR 0020 replaced it and the string never followed.
- **Keep the leading clause `Delegate independent subtasks with subagent` verbatim.** `prompt.rs:491`'s absence assertion (`!prompt.contains("Delegate independent subtasks")`, the "SUBAGENT_GUIDANCE must be absent without the tool" half of `main_prompt_rules_conditional`) depends on it. Add a one-line comment above the constant saying so, so nobody rewords the opening and silently weakens that test.
- No trailing period (the current constant has none and every other `<rules>` line has none).
- Move exactly one test literal, in `the_subagent_guidance_mentions_list_agents` (`prompt.rs:533`): replace the assertion at line 546 with the two clauses that matter, and update the test's `// 2b —` comment to name #78:

```rust
assert!(
    prompt.contains("`agentName` (`list_agents`)"),
    "SUBAGENT_GUIDANCE must make `agentName` the route and name `list_agents`: {prompt}"
);
assert!(
    prompt.contains("do NOT pass a `systemPrompt` alongside `agentName`"),
    "SUBAGENT_GUIDANCE must forbid the replacing-systemPrompt habit ADR 0020 superseded: {prompt}"
);
```

Keep the test's name (it still pins the `list_agents` mention). Do not touch `main_prompt_full_shape`, `main_prompt_rules_conditional`'s order assertions, or `main_prompt_omitted_sections` — they interpolate the constant or assert only the untouched pi lines.

### 4. The `subagent` spec — `src-tauri/src/agent/harness/tool_specs.rs:222-236`

**(a) The description** (line 224) becomes exactly (one line — `build_main_prompt` renders `- {name}: {description}` into `<tools>`, so NO newlines):

```rust
description: "Delegate tasks to subagents. `task` is required. `agentName` names a discovered Agent definition (`list_agents`): its system-prompt body, model, thinking and tools apply, layered under any explicit params. Prefer `agentName` and put extra constraints in `task` — an explicit `systemPrompt` REPLACES the definition's body, it does not extend it. Omit `agentName` for a config-less dispatch (parent model, all tools, no system prompt).".into(),
```

Drop `Model override is rarely needed` — with `agentName` stated as the preferred route it is redundant, and `model` stays legitimately useful ("use scout but with the fast model", ADR 0020's considered-options case).

**(b) The properties** (225-235) gain `thinking`, keeping `required: ["task"]` untouched:

```rust
parameters: json!({
    "type": "object",
    "properties": {
        "task": { "type": "string" },
        "agentName": { "type": "string" },
        "model": { "type": "string" },
        "thinking": { "type": "string" },
        "systemPrompt": { "type": "string" },
        "tools": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["task"]
}),
```

`thinking` is read by `interactive/mod.rs:144-147` into `LaunchConfig::thinking` and is the TOP rung in `subagent_flow.rs:553-562` — fully functional, never advertised. Without this line the checker added in step 1 flags a legal param on the first dispatch that uses it and destroys the warning's credibility immediately.

---

## Tests

Five in `tool_specs.rs`'s `mod tests` (pure, no fixture), one there for the spec shape, one async in `loop/tests/subagents.rs`, one in `src/lib/toolOutput.test.ts`.

### `src-tauri/src/agent/harness/tool_specs.rs` — `mod tests`

`use super::*;` (test module, line 339) already pulls the parent's new `ToolCall` / `Map` / `Value` imports into `mod tests`, so nothing must be removed there — `use serde_json::Value;` at line 336 coexists with the glob (glob-vs-explicit is legal, not E0252). If you prefer to name it, adding `use crate::agent::harness::provider::ToolCall;` to the test module is equally fine. A local helper keeps the cases terse:

```rust
fn call(name: &str, args: Value) -> ToolCall {
    ToolCall { id: "t1".into(), name: name.into(), arguments: args }
}
```

1. `an_unknown_param_is_reported_with_a_suggestion` — `unknown_param_warning(&tool_specs(), &call("subagent", json!({ "task": "t", "agent": "reviewer" })))` equals exactly
   `"⚠ unknown param(s) for `subagent`: `agent` (did you mean `agentName`?) — ignored."`
   (`assert_eq!` on the whole string — it is the wire text the model reads; a drift in the em dash, the `⚠`, the `(s)` or the trailing `ignored` is a regression).
2. `an_unknown_param_without_a_close_match_is_still_reported` — key `agent_name` on `subagent` → `Some` containing `` `subagent` `` and `` `agent_name` ``, and NOT containing `did you mean`. `agent_name` is the realistic second misspelling AND it pins the separator-blind decision in `suggest` (the `_` survives `to_lowercase`, so neither `agent_name` nor `agentName` contains the other — reported, no suggestion). Repeat the assertion inside the same test with key `zzzz` (a key with no substring relation at all) so the "no suggestion" path is not passing by accident.
3. `a_spec_with_no_properties_is_never_checked` — `list_agents` (bare `{"type":"object"}`) with `json!({"anything": 1})` → `None`. Add the mirror half: `list_skills` too, and a synthetic `ToolSpec { parameters: json!({"type": "object", "properties": "not-an-object"}), … }` → `None` (the "not an object" branch is otherwise untested).
4. `an_unknown_tool_name_is_never_checked` — `call("no_such_tool", json!({"whatever": 1}))` → `None` (the `unknown tool:` arm owns it).
5. `a_well_formed_call_produces_no_warning` — `json!({"task": "t", "agentName": "scout", "thinking": "high", "model": "m", "systemPrompt": "s", "tools": ["read"]})` → `None`; and the ALIAS half, which is what makes the `effective_tool_name` lookup non-vacuous: `call("dispatch_subagent", json!({"task": "t", "agent": "x"}))` → `Some` naming `subagent`, `agent` and `agentName`.
6. `the_subagent_spec_advertises_every_param_the_executor_reads` — pin the advertised set by EXACT equality (the strongest form; it catches a dropped `thinking` and an unadvertised addition alike). `BTreeSet` is already imported in this module (`tool_specs.rs:337`) and `json!` / `Value` / `ToolSpec` arrive through `use super::*;`:
   ```rust
   let spec = tool_specs().into_iter().find(|s| s.name == "subagent").expect("subagent");
   let advertised: BTreeSet<String> = spec.parameters["properties"].as_object().expect("properties")
       .keys().cloned().collect();
   assert_eq!(advertised, ["agentName", "model", "systemPrompt", "task", "thinking", "tools"]
       .into_iter().map(String::from).collect::<BTreeSet<String>>());
   ```
   Its doc comment names where each key is consumed (`interactive/mod.rs::dispatch_params` for `task`/`systemPrompt`/`model`/`thinking`/`tools`, `dispatch.rs:270-274` for `agentName`) so a future reader who adds a sixth key to `dispatch_params` knows this test is the one that will go RED.

### `src-tauri/src/agent/harness/loop/tests/subagents.rs` — one async test

`a_mis_named_subagent_param_still_dispatches_and_announces_itself`, built on the existing `subagent_wait_a_resolving_completed_outcome_completes_the_tool` fixture (`subagents.rs:484-549`, doc comment 478-482, the `content[0]` assertion at 546-548): a `ScriptedProvider` whose first turn emits `ToolCall { id: "t1", name: "subagent", arguments: json!({ "task": "the task", "agent": "reviewer" }) }` + `Done(ToolCalls)` and whose second turn settles; a `MockDispatcher` with a pre-resolved `Completed { output: "the answer", .. }` on the queue; `build_loop_with_dispatcher(...)` with `subagent: Some(...)`; then `loop_.handle_prompt(&text_prompt("go")).await`.

Assertions on the `tool_execution_end` for `t1` (wait with `SETTLE_MS`, the module's own bound):

- `assert!(!is_error, "a mis-named param must not fail an otherwise-successful dispatch")` — the non-blocking decision, pinned.
- `result["content"][0]["text"] == "the answer"` — the child's output is still the FIRST block (the append, never prepend, rule).
- `result["content"][1]["text"]` contains `` `agent` ``, contains `agentName`, contains `— ignored.` and starts with `⚠ unknown param(s) for \`subagent\``.
- `loop_.messages` (the field is private to `r#loop` at `loop.rs:209`, and `loop::tests::subagents` is a descendant module, so it reads — `compaction_overflow.rs:37` WRITES it from the same grandchild module) holds a `ChatRole::Tool` message whose `MessageContent::Blocks` has `len() == 2` — the warning travels into the transcript the model is re-sent, not just the UI event. That assertion needs `MessageContent` and `ChatRole` added to the file's existing `use crate::agent::harness::provider::{…}` line and `ContentBlock` from `crate::agent::tools` (this module does not import them today).

Use `MockDispatcher`, NOT the `fake_worker` `WorkerManager`: the point is the loop's own delivery, and the mock keeps the test off the process-spawn timing path (`support.rs`'s `SPAWN_MS` note).

### `src/lib/toolOutput.test.ts` — one test

Inside `describe("normalizeToolOutput (the subagent progress envelope)")`:

```ts
it("joins every content text item (the unknown-param warning rides alongside the output)", () => {
  const out = normalizeToolOutput(
    {
      content: [
        { type: "text", text: "the child's answer" },
        { type: "text", text: "⚠ unknown param(s) for `subagent`: `agent` (did you mean `agentName`?) — ignored." },
      ],
      details: runningDetails,
    },
    false,
    "subagent",
  );
  expect(out).toBe(
    "the child's answer\n⚠ unknown param(s) for `subagent`: `agent` (did you mean `agentName`?) — ignored.",
  );
});
```

This pins the frontend half of the delivery contract (`toolOutput.ts:435-448`) so a later "simplification" to `content[0]` cannot silently swallow the warning. No change to `toolOutput.ts` itself.

---

## Steps

- [ ] Read, in this order: `src-tauri/src/agent/harness/tool_specs.rs` (whole file — T8's `BASH_DESCRIPTION` pair if it has landed, the `subagent` spec at 222-236, and `mod tests`' `exec_param_keys` / `LOOP_INTERNAL_TOOLS`), `src-tauri/src/agent/harness/loop/turn.rs` (347-423), `src-tauri/src/agent/harness/loop/tools.rs` (61-182), `src-tauri/src/agent/harness/dispatch.rs` (170-300), `src-tauri/src/agent/harness/launch.rs` (255-320), `src-tauri/src/agent/harness/prompt.rs` (1-80 and the whole `mod tests`), `src-tauri/src/agent/harness/loop.rs` (900-965), `src-tauri/src/agent/interactive/mod.rs` (120-162), `src-tauri/src/agent/worker/manager/subagent_flow.rs` (490-565), `src-tauri/src/agent/harness/loop/tests/subagents.rs` (483-549), `src/lib/toolOutput.ts` (412-470).
- [ ] RED first: add tests 1-6 to `tool_specs.rs`'s `mod tests` and the async test to `loop/tests/subagents.rs`. Run `cargo test --lib agent::harness::tool_specs` from `src-tauri/`.
  - Expect a COMPILE failure (`cannot find function unknown_param_warning`). That is the RED. If it compiles and passes, stop and find out why.
- [ ] Implement step 1 (`unknown_param_warning` + `suggest` + the two imports) in `tool_specs.rs`. Re-run the same command → tests 1-4 green; **tests 5 and 6 stay RED until step 4** (both use the `thinking` key, which step 4 advertises — the expected intermediate state, not a broken lookup).
- [ ] Implement step 4 (the `subagent` description + the `thinking` property) in `tool_specs.rs`, in the same file. Re-run → tests 5 and 6 green.
- [ ] Implement step 2 (the two `turn.rs` edits) → the async test green. Then run `cargo test --lib agent::harness::loop` and `cargo test --lib agent::harness::dispatch`: the batch/cancel/order tests (`subagent_calls_in_one_message_run_in_parallel`, `…results_are_appended_in_original_order…`, `…mixed_with_a_non_subagent_tool_runs_both_in_order`, `…a_completed_result_survives_a_mid_batch_stop`, `policy_gate`, `turn_lifecycle`) must all stay green. Surveyed every scripted `arguments:` payload in `loop/tests/*` and `tests/*` — all 47 of them use only advertised top-level keys (`{"task": …}`, `{"path": …}`, `{"command": …, "timeout_ms": …}`, `{"operation": "read"}`, `{"name": "nope"}`, `{"tool": "echo", "args": …}`, `{"questions": […]}`), so NO existing test gains a warning block, and because we append, none of their `content[0]` assertions can move. If one does, the lookup is wrong: fix the function, not the test.
- [ ] Implement step 3 (`prompt.rs` constant + the one literal + the keep-the-clause comment). Run `cargo test --lib agent::harness::prompt` → all green, including `main_prompt_full_shape` and `main_prompt_rules_conditional` (they interpolate the constant, so they follow automatically; if one fails, the constant's leading clause was reworded).
- [ ] Add the `toolOutput.test.ts` case. Run `pnpm test src/lib/toolOutput.test.ts` from the repo root → green (it should pass immediately: this is a PIN, not a fix; if it fails, re-read `toolOutput.ts:435-448` before touching the component).
- [ ] Full gate, from `src-tauri/`: `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`; then from the repo root `pnpm test`, `pnpm build`.
  - Expected delta over whatever the tree measured when this task started: **+7 Rust** (6 in `tool_specs.rs`, 1 in `subagents.rs`), **0 removed**, 4 ignored unchanged; **+1 FE** (3052 tests / 149 files). The parent's floor — Rust **1369 / 0 failed / 4 ignored**, FE **3051 / 149**, clippy 0, fmt clean, build exit 0 — must not regress in any column. Record the absolute numbers in the commit body (T7/T8 land before this task and move the absolute figure).
- [ ] Commit:
  `feat(harness): unknown params announce themselves, and the subagent guidance points at agentName (#78)`

---

## Acceptance criteria

- A `subagent` call carrying `agent` instead of `agentName` **still dispatches and still succeeds** (`is_error == false`, `content[0]` is the child's output), and its result carries a second text block byte-equal to ``⚠ unknown param(s) for `subagent`: `agent` (did you mean `agentName`?) — ignored.``, in both the `tool_execution_end` payload and the persisted transcript `tool` message.
- The check runs for **every advertised tool**, from `run_tool_batch`, **before** the `join_all` at `turn.rs:371` — provable from the diff: the `warnings` vec is computed above the `subagent_results` initializer.
- A tool with no spec, a spec with no `properties` (`list_agents`, `list_skills`), a non-object `properties`, and a well-formed call all produce **no** warning; the `dispatch_subagent` alias is checked against the `subagent` spec and names `subagent` in its message.
- `SUBAGENT_GUIDANCE` makes `agentName` the default route, names `list_agents`, and forbids a `systemPrompt` alongside `agentName`; the constant still opens with `Delegate independent subtasks with subagent`; no prompt test other than `the_subagent_guidance_mentions_list_agents` was edited.
- The `subagent` spec advertises exactly `{task, agentName, model, systemPrompt, thinking, tools}` (pinned by exact set equality) and its description says `agentName` is preferred and an explicit `systemPrompt` REPLACES the definition's body, with `Model override is rarely needed` gone.
- Gate green with the delta above: `cargo test` / `cargo clippy --all-targets -- -D warnings` at 0 / `cargo fmt --all -- --check` clean in `src-tauri/`; `pnpm test` and `pnpm build` green at the root.

---

## Recorded, not fixed here

- **Three web tools read keys the checker will call unknown — the same credibility problem as `thinking`, in a tool this task is not about.** Measured: `web_search` reads `proxy` (`agent/web/tools.rs:86-90`), which is fully functional (it overrides the session proxy) and is not in the spec; plus the camelCase aliases `numResults` (`:53-55`), `recencyFilter` (`:65-67`), `domainFilter` (`:72-74`). `fetch_content` reads `maxChars` (`:191-193`); `get_search_content` reads `responseId` (`:291-293`) and `findText` (`:322-324`) — and `fetch_content`'s OWN truncation note tells the model to call `get_search_content with responseId …` (`web/tools.rs:251`, pinned by its test at `:680`), so the tool provokes the exact call the checker would flag. Fixing it means widening three specs, growing `exec_param_keys`, and deciding whether the camelCase aliases should exist at all — a design decision this task must not smuggle in. **Hand to the orchestrator as its own task** (the parent's task table is the place); the one-line-per-spec shape is known and the pinning tests already exist.
- **The `subagent` check does not know about `~/.agents` frontmatter it cannot see.** `agents.rs::parse_agent_file` reads only `name`/`description`/`model`/`thinking`/`tools` + body, so `~/.agents/agents/reviewer.md`'s `skills:`, `systemPromptMode:`, `inheritSkills:`, `model_kwargs:`, `options:` and `subtask:` are all ignored — even a correctly-dispatched `reviewer` never receives its skill. The parent already logged this (Decisions log, 2026-10-23): it wants its own ADR. Out of scope, and NOT what this task's checker touches (it fires on unknown KEYS of a TOOL CALL, never on frontmatter).
- **The 25 skill call sites stay `agent:`.** The migration lives in a separate repo (`~/.agents`); until it lands, every skill-driven dispatch spawns one wasted config-less child and then corrects on the next turn. That is the designed cost, and the warning is the signal that the migration is still owed.
- **The warning is invisible in the collapsed card.** `summarizeToolCall` (`toolOutput.ts:33-137`) renders the tool INPUT in the header, so the appended block appears only in the expanded body (`normalizeToolOutput`, joined with `\n`). Accepted: the model's copy of the warning is the transcript, not the card.
- **A cancelled turn's synthetic result can carry the warning too** (no branch was added). Truthful, harmless, and cheaper than a predicate that would misfire on the real-result-after-late-cancel path.
- **`docs/research/` and the ADRs were left alone.** This task moves a prompt string and two spec strings to agree with ADR 0020, which already decided the doctrine; no ADR is superseded and none is owed.
