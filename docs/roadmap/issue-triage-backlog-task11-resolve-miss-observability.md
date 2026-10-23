---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 47
done-when: A `subagent({ agentName: "reviewr" })` call still dispatches and still succeeds, but its `subagent-session-started` payload carries `"nameResolution": "unmatched"` and both the directory row under the `subagent` card and the child's transcript sheet say so in one quiet line ("no matching Agent") — while a MATCHED name and an OMITTED name render exactly what they render today, and the tool result's `is_error` is untouched.
---

# Task 11 — A resolve miss is observable on `subagent-session-started` (issue #47, carried on #78)

**Goal:** Make "a correctly-spelled key carrying a name that matches no Agent definition" visible. `resolve_launch` already returns the launch VERBATIM on a miss (ADR 0020's deliberate config-less dispatch — it stays); the defect is that it says nothing about the miss, so the UI prints a confident agent label for a child that loaded no persona, no tool allowlist and no model.

**Architecture:** One new `pub` tri-state enum — `AgentNameResolution { NoName, Matched, Unmatched }`, serde `snake_case` — declared next to `LaunchConfig` in `agent/subagent.rs`. `harness::launch::resolve_launch` returns `(LaunchConfig, AgentNameResolution)`; the resolution then rides the dispatch as ONE extra parameter on `SubagentDispatcher::dispatch` / `SubagentSessionManager::dispatch_native`, one new field on the `Outbound::SubagentDispatch` frame and on `SubagentDispatchWire`, and one new key (`nameResolution`) on the `subagent-session-started` payload. The frontend mirrors it as an OPTIONAL field on the payload and on `SubagentEntry`, and renders a single `MutedCaption` marker in exactly one state (`"unmatched"`) in the two surfaces that name a child.

**Tech Stack:** Rust 2021 (pinned toolchain), serde externally-tagged struct variants + `#[serde(rename_all)]`, the stdio JSONL Worker protocol (ADR 0025, unversioned), the Supervisor-side `subagent_flow` emit, React 19 + Zustand + Vitest, the `cn()`/tailwind-merge stack.

---

## Parallelisation

**Verdict:** SERIAL — one task of the issue-triage backlog, and every Rust file it touches belongs to `archimedes_lib`, which is **one compilation unit**: the parent roadmap measured (planted-error experiment, `docs/roadmap/issue-triage-backlog-status.md` §"Why the waves collapsed to serial") that any sibling's half-finished `.rs` edit makes an unrelated scoped `cargo test` fail to compile, which destroys gate 4. The parent's table lists T11 in the serial column, and it shares `worker/protocol.rs` + `worker/manager/subagent_flow.rs` with **T10 (which lands BEFORE it)** and `worker/manager/tests/mod.rs` + `src/bin/fake_worker.rs` with T10/T12.

Consequence for the executor: **run the FULL gate**, not a scoped run — a scoped `cargo test --lib <filter>` compiles the whole crate here anyway, so scoping buys nothing.

---

## Context — why this exists, and what was verified against the tree

All line numbers were read at `d2cb1fa` and are **pre-T10**. T10 (#9, `StartMode::FreshChild`) lands first and edits `worker/protocol.rs` + `worker/manager/subagent_flow.rs`; re-anchor on the symbols named below, not on the numbers.

### The hole, verified

1. `src-tauri/src/agent/harness/dispatch.rs:271-275` — `agent_name = params.get("agentName").and_then(Value::as_str).unwrap_or_default()`, so a **known** key carrying any string arrives as that string.
2. `src-tauri/src/agent/harness/launch.rs:293-323` — `resolve_launch` has THREE exits and two of them are indistinguishable to its caller:
   - `:300-303` `let name = agent_name.trim(); if name.is_empty() { return launch.clone(); }` — **no name given** (config-less dispatch, deliberate);
   - `:304-309` `discover_agents(Some(space_cwd)).into_iter().find(|d| d.name.eq_ignore_ascii_case(name))` … `else { return launch.clone(); }` — **a name given that matches NOTHING**: the same bytes, the same `LaunchConfig`, and the same silence;
   - `:322` `resolve_agent_launch(launch, &def, &layer, catalog).launch` — the matched path.
   The function's own doc (`:283-286`) states the collapse as the design: "`agentName` empty / no match → the `launch` is returned VERBATIM (the label-only, config-less behavior — never an error)". **The behaviour is correct and stays.** What is missing is the report.
3. `src-tauri/src/agent/worker/manager/subagent_flow.rs:630-641` (step 6) — the `subagent-session-started` emit sends `"agentName": wire.agent_name` **regardless**, plus the child's resolved `model` / `thinkingLevel` / `enabledTools`. So the payload is internally contradictory on a miss: a confident agent label next to a config that is just the parent's, because nothing resolved.
4. The frontend makes that contradiction permanent and pretty: `src/App.tsx:209-218` copies `p.agentName` into `useSubagents`; `src/components/SubagentDelegatingCard.tsx:222-228` renders `storeEntry?.agentName` in the directory row (line 1) with the `|| "subagent"` fallback, and `src/components/SubagentDetailHost.tsx:76` and `:97` put the SAME string in the sheet's `aria-label` and its header. `"reviewr"` in, `"reviewr"` out, rendered as a confident agent name.
5. T9's `unknown_param_warning` (planned, `docs/roadmap/issue-triage-backlog-task09-unknown-param-warning.md`) is **blind to this**: it fires on keys absent from the spec's `properties`. `agentName` IS in `properties` (`tool_specs.rs:225-235`), so `subagent({ agentName: "reviewr" })` produces no warning anywhere. Confirmed by reading T9's rule 1-4 and the spec.

### Why the child is genuinely mis-labelled, not merely unlabeled

On a miss the child gets: `launch` verbatim → `wire.launch` verbatim → `subagent_flow.rs:515-541` resolves the model from `wire.model_key` (the PARENT's composed key), `:573-583` the child tool set from `wire.launch.tools` (`None` → the parent's minus the guard), `:598-600` `build_child_system_message(launch.system_prompt /* None */, has_todo_tool)`. So no persona, no allowlist, no model — exactly the "config-less" case ADR 0020 intends, wearing a name that promises the opposite. ADR 0020's own consequence line (`docs/decisions/0020-native-subagent-agent-definitions.md:23`) is explicit that the BEHAVIOUR is intended: "an UNKNOWN or omitted `agentName` is still a no-op for behavior (label-only, config-less, never an error)". This task changes the OBSERVABILITY, not that sentence.

### The chosen shape: a tri-state enum + one extra parameter + one wire field

```rust
// src-tauri/src/agent/subagent.rs, next to LaunchConfig
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentNameResolution {
    NoName,    // wire "no_name"   — omitted/blank: config-less dispatch was DELIBERATE
    Matched,   // wire "matched"   — a definition was found (case-insensitively)
    Unmatched, // wire "unmatched" — a name was given and matched NOTHING
}
```

Why a **tri-state and not a bool**: "no name" and "a typo" produce identical configs and identical child behaviour, but they are opposite debuggability stories — one is ADR 0020's designed path, the other is the trap #47 is about. A `bool` cannot tell the UI to stay quiet in the first case, and a UI that flags config-less dispatch as a problem is a new bug.

Why it lives in `agent/subagent.rs`: that is where `LaunchConfig` lives (`:35`) and every consumer already imports from there (`harness/launch.rs:24`, `harness/dispatch.rs:17-19`, `worker/protocol.rs` by full path, `worker/dispatch.rs:20`, `src/bin/fake_worker.rs:84`). It is already `pub` + `Serialize`/`Deserialize`, and `agent/mod.rs:44` re-exports the module's dispatch vocabulary.

**Rejected — a field on `LaunchConfig`.** Three reasons, all measured: (a) `LaunchConfig` is the *config* the child runs with, and the resolution is metadata about how it was chosen — `resolve_agent_launch`'s `ResolvedLaunch` (`launch.rs:43-59`) is the type that carries "how", and it belongs to the MODAL seam (see the ADR 0068 note below); (b) `LaunchConfig` has five **complete** literals with no `..Default::default()` (`src/bin/fake_worker.rs:487` — T12's file, `harness/launch.rs:269`, `interactive/mod.rs:135`, `tests/harness_dispatch_native.rs:172-179` ×2) that would all break for a field that is not a config; (c) it would put a UI-report field on a struct that is also persisted through the `Start` envelope's `launch`.

**Rejected — re-resolving inside `subagent_flow.rs`.** The flow could call `discover_agents` again on `wire.parent_cwd` and answer the question itself. That is a SECOND discovery pass and a SECOND name selector, and ADR 0066/0068's whole argument (`launch.rs:86-92`, `commands/agents.rs:225-232`) is that two selectors is how the dispatch and the report drift. The answer already exists at `launch.rs:304`; carry it.

**Rejected — extending T9's `unknown_param_warning` to name values.** T9's function is `Option<String>` of `(specs, tc)` — a pure function of the ADVERTISED SHAPE, and that purity is what makes it impossible to disagree with the prompt (T9's doc, rule 1). A value-level check needs the Agent catalog, i.e. a second source of truth inside the checker. Recorded below, not done here.

### ADR 0068's shared seam is NOT touched — checked

`resolve_agent_launch` (`launch.rs:144-277`) and `ResolvedLaunch` keep their EXACT signatures and fields. Its only two callers are `resolve_launch` (`:322`) and `commands::agents::agent_config` (`commands/agents.rs:245`, the Agents modal). The modal goes through `resolve_agent_launch`, never `resolve_launch`, and it resolves a definition it already HAS (`defs.iter().map(...)`, `:241-245`) — so the modal can never have a name miss, only a field miss, which its `source` column already reports. `override_layer` (`:99-109`) is untouched. The parity test `agent_config_and_the_dispatch_resolve_the_same_row` (`commands/agents.rs:930-985`) keeps comparing the same three fields; it only gains a `Matched` assertion (§7).

### The override question — decided, not defaulted

The brief asks whether an AGENT OVERRIDE naming a nonexistent agent is the same miss, and whether it is already visible. Verified answers:

- **There is no per-Space override layer.** `OverrideLayer` (`launch.rs:33-39`) has ONE field, `global`, and its doc names ADR 0066's per-Space door as DEFERRED ("a second field on this struct plus one more `or_else`"). So the question is only ever about the single global `agentOverrides` map.
- **An override keyed by an undiscovered agent name is already visible, with its own cleanup path.** `src/lib/agentOverrides.ts:104-113` `orphanedOverrides` lists exactly those keys, and `src/components/AgentsDialog.tsx:382-400` renders each as a muted row reading **"No longer discovered (stale override)"** with a remove button (ADR 0023's only cleanup path). Pinned by `AgentsDialog.test.tsx:493-510` (`an_orphaned_override_renders_with_a_remove_button`) and `agentOverrides.test.ts:122-125`. **Do not duplicate it.**
- **Such an override can never reach a child at all.** `override_layer` is consulted at `launch.rs:320-322`, which is AFTER the `else { return launch.clone() }` at `:307-309` — no definition, no override read. An orphan override is inert by construction, so there is no miss to report at dispatch time.
- The OTHER override miss (an entry whose `model` the catalog cannot resolve, or whose `tools` name a nonexistent tool) is a different seam and is already handled: soft-degrade (ADR 0023/0067) with the modal's `source` column naming the layer that actually won (`commands/agents.rs:255-262`, pinned at `:907-921`). Recorded-not-fixed below for the one half that IS silent (dropped tool NAMES).

### The T10 seam — build on it, do not re-litigate it

Read `docs/roadmap/issue-triage-backlog-task10-child-start-signal.md` before starting. Its plan states (final section, "T11's seam") that `subagent_flow.rs`'s `json!` block is deliberately left **byte-identical** so that this task's diff is one clean insertion, and that the child envelope becomes `StartMode::FreshChild`. Therefore:

- The child envelope you will find says `StartMode::FreshChild`. **Leave it.** Your change is the tri-state on the wire — orthogonal to the start mode, and the two fields answer different questions (what the child starts WITH vs whether its NAME resolved).
- T10 also adds `FreshChild` to `protocol.rs`'s `StartMode`. You add a field to `protocol.rs`'s `Outbound::SubagentDispatch` and two tests to its `mod tests`. Different types, same file, serial order — reformat nothing you did not add.
- **Do NOT read `env.mode` for the marker.** T10's notes point at it as an available seam; it is not the right one. `mode` says "this is a child", which is already true of every row in this UI, and it says nothing about the name.
- `src/bin/fake_worker.rs` is T12's file and T10's plan forbids touching it. **This task must touch it anyway** (one line, §1) because it constructs the `Outbound::SubagentDispatch` variant as a complete struct-variant literal at `:481-495`, so a new field is a compile error there. It is a forced mechanical edit, not a semantic collision. **Say so in the commit body** so T12's planner expects the line.

---

## Files

Rust (production):
- Modify `src-tauri/src/agent/subagent.rs` — the new `AgentNameResolution` enum; `dispatch_native`'s new parameter + the wire construction (`:166-176`); two doc comments.
- Modify `src-tauri/src/agent/mod.rs` — add `AgentNameResolution` to the `pub use subagent::{…}` line (`:44`).
- Modify `src-tauri/src/agent/harness/launch.rs` — `resolve_launch`'s return type + its three exits + the module/function doc comments.
- Modify `src-tauri/src/agent/harness/dispatch.rs` — the trait's `dispatch` parameter, `InProcessDispatcher` + `MockDispatcher` impls, the call site and its ADR 0020 comment (`:275-284`).
- Modify `src-tauri/src/agent/worker/dispatch.rs` — `IpcDispatcher::dispatch`'s parameter + the `Outbound::SubagentDispatch` send (`:69-79`).
- Modify `src-tauri/src/agent/worker/protocol.rs` — the `Outbound::SubagentDispatch` variant field, `SubagentDispatchWire`'s field, the two doc comments.
- Modify `src-tauri/src/agent/worker/client.rs` — the `Outbound::SubagentDispatch → WorkerInboundEvent::SubagentDispatch(SubagentDispatchWire)` mapping (`:780-797`).
- Modify `src-tauri/src/agent/worker/manager/subagent_flow.rs` — the `"nameResolution"` key in the step-6 `json!` + its comment.
- Modify `src-tauri/src/bin/fake_worker.rs` — ONE line: the new field in the canned `Outbound::SubagentDispatch` (forced; T12 owns the file otherwise).

Frontend (production):
- Modify `src/lib/tauri/types.ts` — the `AgentNameResolution` type + `SubagentSessionStartedPayload.nameResolution?`.
- Modify `src/lib/tauri.ts` — re-export the new type name from the barrel.
- Modify `src/store/subagents.ts` — `SubagentEntry.nameResolution?`.
- Modify `src/App.tsx` — forward `nameResolution: p.nameResolution` in the `listenSubagentSessionStarted` handler (`:209-218`).
- Modify `src/components/SubagentDelegatingCard.tsx` — the row field + the marker in line 1.
- Modify `src/components/SubagentDetailHost.tsx` — the marker in the sheet header.

Tests:
- `src-tauri/src/agent/harness/launch.rs` (`mod tests`) — 1 new test + assertions in 3 existing + the mechanical `resolve_launch(` call-site update across **29** sites.
- `src-tauri/src/agent/worker/protocol.rs` (`mod tests`) — 2 new tests + the `Outbound::SubagentDispatch` literal at `:684-693`.
- `src-tauri/src/agent/worker/dispatch.rs` (`mod tests`) — the destructuring pattern + one assertion.
- `src-tauri/src/agent/worker/manager/tests/mod.rs` — 1 new test + the two `SubagentDispatchWire` literals (`:349`, `:1798`) + one assertion in the existing lifecycle test.
- `src-tauri/src/agent/harness/loop/tests/subagents.rs` — 1 new test + one assertion in an existing test + the four test `impl SubagentDispatcher` signatures.
- `src-tauri/src/agent/subagent.rs` (`mod tests`), `src-tauri/tests/harness_dispatch_native.rs`, `src-tauri/src/commands/agents.rs` (`mod tests`) — mechanical call-site updates (+ one new assertion in `agents.rs`).
- `src/lib/ipc/events.test.ts` — **NOT touched, deliberately** (see the correction in §Frontend tests: it pins event NAMES, not payload shapes).
- `src/lib/tauriBarrel.test.ts` — the pinned `TAURI_PUBLIC_API` list gains the new type name (type-only list; the runtime list must NOT gain it).
- `src/test/fixtures/subagents.ts` + `src/test/fixtures.test.ts` — the optional-key drop list.
- `src/store/subagents.test.ts`, `src/App.test.tsx`, `src/components/SubagentDelegatingCard.test.tsx`, `src/components/SubagentDetailHost.test.tsx` — the new frontend cases.

Do NOT touch: `src-tauri/src/agent/worker/protocol.rs`'s `StartMode` (T10's), `src-tauri/src/agent/harness/tool_specs.rs` (T8/T9's), `src-tauri/src/agent/harness/loop/turn.rs` (T9's), `src/lib/agentOverrides.ts` / `src/components/AgentsDialog.tsx` (the orphan override is already visible), `Cargo.toml`, any lockfile, any ADR (this task makes the UI honest about a decision ADR 0020 already documents — it decides nothing new), `src/lib/toolOutput.ts`, `src/lib/subagentActivity.ts`.

---

## What to implement

### 1. `agent/subagent.rs` — the tri-state, and the parameter

Add after `LaunchConfig` closes (`:61`), above the `SubagentSessionManager` doc:

```rust
/// (issue #47) Whether a `subagent` call's `agentName` resolved against the
/// discovered Agent definitions — the REPORT that `resolve_launch`'s
/// never-an-error contract left unsaid.
///
/// The three states are NOT two. `resolve_launch` returns the SAME verbatim
/// `LaunchConfig` for `NoName` and `Unmatched` (ADR 0020: "an UNKNOWN or
/// omitted `agentName` is still a no-op for behavior — label-only, config-less,
/// never an error"), and the child's config is identical in both, so the
/// distinction is invisible downstream unless the resolver says it. It matters
/// because the two cases are opposite stories for whoever is debugging:
/// `NoName` is the designed config-less dispatch, `Unmatched` is a typo in a
/// correctly-spelled key that leaves a child running the PARENT's model, the
/// PARENT's tools and no persona while the UI prints a confident agent label.
/// A `bool` would collapse them and force the UI to flag the deliberate case.
///
/// The wire spelling is the contract (`#[serde(rename_all = "snake_case")]` →
/// `no_name` / `matched` / `unmatched`), pinned by
/// `protocol::tests::the_agent_name_resolution_serialises_in_snake_case`; the
/// frontend mirrors it as `AgentNameResolution` in `src/lib/tauri/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentNameResolution {
    /// No `agentName` was passed (or it was blank after `trim()`) — the
    /// config-less dispatch ADR 0020 intends. NOT a miss; the UI stays silent.
    NoName,
    /// A definition matched (`discover_agents` + `eq_ignore_ascii_case`, so a
    /// different case is a MATCH, not a miss).
    Matched,
    /// A name was given and matched NO discovered definition. The launch is
    /// still returned verbatim and the child still runs — but with no persona,
    /// no tool allowlist and no model from the name it was given.
    Unmatched,
}
```

`dispatch_native` (`:135-148`): insert `name_resolution: AgentNameResolution,` **immediately after** `agent_name: String,` and set `name_resolution,` in the `SubagentDispatchWire` literal (`:166-176`). Its doc gains one sentence: the resolution the loop's `resolve_launch` computed rides the wire so the `subagent-session-started` payload can name the miss.

`agent/mod.rs:45` (the `pub use subagent::{…}` line): `pub use subagent::{AgentNameResolution, LaunchConfig, SubagentMetrics, SubagentOutcome, SubagentSessionManager};`

**Every `dispatch_native` call site gains the argument** (the parameter list is positional, so each is a one-line edit): `harness/dispatch.rs:77` (the `InProcessDispatcher` forward), `subagent.rs:502` and `subagent.rs:769` (the file's own tests), `tests/harness_dispatch_native.rs:127` (the shared `dispatch` helper — pass the value through or hard-code `Matched`, the fixture names `"tester"` and asserts nothing about the resolution) and `tests/harness_dispatch_native.rs:327`.

### 2. `harness/launch.rs` — the resolver reports

Change the signature (`:293-299`) to return `(LaunchConfig, AgentNameResolution)` and the three exits to:

```rust
    let name = agent_name.trim();
    if name.is_empty() {
        // Deliberate config-less dispatch — NOT a miss. Pinned by
        // `resolve_launch_with_an_empty_agent_name_short_circuits`.
        return (launch.clone(), AgentNameResolution::NoName);
    }
    let Some(def) = crate::agents::discover_agents(Some(space_cwd))
        .into_iter()
        .find(|d| d.name.eq_ignore_ascii_case(name))
    else {
        // (issue #47) The verbatim return is ADR 0020's and stays; what was
        // missing was that this exit was BYTE-IDENTICAL to the one above, so
        // nothing downstream could tell a typo from a deliberate nameless call.
        return (launch.clone(), AgentNameResolution::Unmatched);
    };
    …
    (
        resolve_agent_launch(launch, &def, &layer, catalog).launch,
        AgentNameResolution::Matched,
    )
```

Add `AgentNameResolution` to the file's `use crate::agent::subagent::LaunchConfig;` (line 24). Rewrite the doc block at `:283-292`: keep the never-an-error sentence, keep the "DELEGATING to the shared `resolve_agent_launch`" sentence, DELETE the now-false claim "The signature is deliberately unchanged", and replace it with: the return gained the resolution because a miss must be reportable on the wire, and `resolve_agent_launch` — the seam ADR 0068 shares with the Agents modal — is deliberately NOT part of that report (the modal resolves a definition it already has, so it can never have a name miss). Update the module doc's line 11 similarly.

### 3. `harness/dispatch.rs` — the trait, and the call site

- Trait `dispatch` (`:34-46`): add `name_resolution: crate::agent::subagent::AgentNameResolution,` after `agent_name: String,`. Its doc says it mirrors `dispatch_native` VERBATIM — both change together, keep that sentence true.
- `InProcessDispatcher::dispatch` (`:63-86`): same parameter, pass it through to `dispatch_native`.
- `MockDispatcher::dispatch` (`:135-149`): `_name_resolution: AgentNameResolution,`.
- The production call site: `:275-284` becomes

```rust
    // ADR 0020: resolve `agentName` against the discovered Agent definitions
    // (layered — explicit params win; no match / empty = config-less, never an
    // error). (issue #47) The resolution is NOT a control-flow decision — it
    // changes nothing here — it is the payload the UI reads: `Unmatched` is a
    // name that matched no definition, i.e. a child running the parent's config
    // under a label no one wrote down.
    let (launch, name_resolution) = crate::agent::harness::launch::resolve_launch(
        &launch,
        &agent_name,
        parent.catalog,
        parent.config_dir,
        parent.space_cwd,
    );
```

  and `dispatcher.dispatch(…)` (`:285-294`) passes `name_resolution` after `agent_name`.
- The three in-file test call sites (`:486`, `:611`, `:650`) gain the argument (`AgentNameResolution::Matched` for the first — it names `"tester"` through a real `InProcessDispatcher`; `Matched` or `NoName` for the two `MockDispatcher` ones, which drop it — pick `NoName`, the honest value for a nameless test call).

### 4. `worker/dispatch.rs` + `worker/protocol.rs` + `worker/client.rs` — the frame

`IpcDispatcher::dispatch` (`:48-60`): the new parameter after `_agent_name`, and `name_resolution,` in the `Outbound::SubagentDispatch { … }` send (`:69-79`).

`protocol.rs` — the `Outbound::SubagentDispatch` variant (`:160-169`): `agent_name: String,` then

```rust
        /// (issue #47) `resolve_launch`'s report on `agent_name` (computed
        /// Worker-side, in the loop's `harness::dispatch`), so the Supervisor's
        /// `subagent-session-started` payload can distinguish "no name given"
        /// from "name given, matched" from "name given, NO match".
        ///
        /// Deliberately NOT `#[serde(default)]`, unlike the `subagent-result`
        /// fields above. Every default for this field is a LIE: `NoName` would
        /// silence the marker for a child that was named and missed, which is
        /// the exact defect the field exists to fix, and the other two would
        /// accuse a genuinely nameless dispatch. A missing field is therefore a
        /// hard `ProtoError::Json` (this `type` is in `decode_outbound`'s
        /// explicit allow-list) — the loud direction — and it cannot occur in
        /// production: the Worker is a self-exec of the SAME binary
        /// (`WorkerHandle::spawn(std::env::current_exe())` + `--worker`), so
        /// Supervisor and Worker are always one build. Pinned by
        /// `an_old_shape_subagent_dispatch_line_without_name_resolution_is_a_decode_error`.
        name_resolution: crate::agent::subagent::AgentNameResolution,
```

`SubagentDispatchWire` (`:291-299`): the same field, `pub name_resolution: crate::agent::subagent::AgentNameResolution,` after `pub agent_name`, with a one-line doc ("the `subagent-session-started` payload's `nameResolution`, verbatim — the flow does not re-derive it"). **Do NOT add `#[serde(default)]` here either** (same argument).

`client.rs:780-797`: add `name_resolution,` to both the destructuring pattern and the `SubagentDispatchWire { … }`.

`src/bin/fake_worker.rs:481-495`: add `name_resolution: archimedes_lib::agent::subagent::AgentNameResolution::Matched,` after `agent_name: "tester".to_string(),` (the fixture names an agent, so `Matched` is the truthful canned value; the manager-level tests then override the leg they want by building their own wire). Import it in the file's existing `use archimedes_lib::agent::subagent::LaunchConfig;` line (`:84`).

### 5. `worker/manager/subagent_flow.rs` — the emit

Inside the step-6 `json!` (pre-T10 `:630-641`), after `"agentName": wire.agent_name,` add exactly one line:

```rust
                // (issue #47) The tri-state, verbatim off the wire — NOT
                // re-derived here (a second `discover_agents` on
                // `wire.parent_cwd` would be a second name selector, and two
                // selectors is how the dispatch and the report drift).
                "nameResolution": wire.name_resolution,
```

Update the step-6 comment (`:625-629`) to name the new key. Nothing else in the file changes — the child's model/thinking/tools resolution and the `StartEnv` (which T10 made `StartMode::FreshChild`) are untouched.

### 6. The frontend: type → store → two render sites

`src/lib/tauri/types.ts`, immediately before `SubagentSessionStartedPayload` (`:388`):

```ts
/**
 * The Rust `AgentNameResolution` (`src-tauri/src/agent/subagent.rs`) over the
 * wire — whether a `subagent` call's `agentName` matched a discovered Agent
 * definition. `resolve_launch` returns the SAME verbatim launch for `no_name`
 * and `unmatched` (ADR 0020: an unknown or omitted name is a config-less
 * dispatch, never an error), so this is the ONLY thing that separates the
 * deliberate case from the typo, and the surfaces that print a child's name
 * render the marker in exactly one of the three states.
 *
 * Serialised by serde `#[serde(rename_all = "snake_case")]`, so `no_name` is
 * the one two-word value (unlike `SubagentFailureReason`, whose four values are
 * single words and so coincide in every case).
 */
export type AgentNameResolution = "no_name" | "matched" | "unmatched";
```

and inside `SubagentSessionStartedPayload` (`:388-395`), after `agentName: string;`:

```ts
  /**
   * (issue #47) Whether `agentName` resolved. OPTIONAL for the same reason
   * `SubagentClosedPayload.reason` is: a payload from a backend that predates
   * the field omits it, and the UI then renders exactly what it rendered
   * before. `undefined` and `"matched"` and `"no_name"` all render NOTHING
   * extra — only `"unmatched"` says anything, because only it means "this
   * child loaded no persona, no tool allowlist and no model from the name it
   * was given". NON-BLOCKING by design: the child still runs and its output is
   * real (the same reasoning ADR 0055 applies to a failed child's metrics).
   */
  nameResolution?: AgentNameResolution;
```

`src/lib/tauri.ts`: add `AgentNameResolution,` to the `export type { … } from "./tauri/types";` block (next to `SubagentMetrics`, `:77-80`).

`src/store/subagents.ts`: after `agentName: string;` (`:46`) add

```ts
  /**
   * (issue #47) The `subagent-session-started` payload's `nameResolution`.
   * OPTIONAL and copied verbatim: an older backend omits it, and `"no_name"` /
   * `"matched"` are the states the directory row and the sheet must NOT mark.
   * Never derived here, and never from the tool-result envelope (a `progress`
   * / `result` frame's `agent` field is the model's own claim about a name, not
   * the resolver's answer about one).
   */
  nameResolution?: AgentNameResolution;
```

Add `AgentNameResolution` to the file's existing `import type { SubagentFailureReason, SubagentMetrics } from "../lib/tauri";` (lines 2-5). **Do NOT add it to that file's `export type { … }` re-export block (lines 7-10)** — the two names there are re-exported because consumers already reached for them through the store, and a third would create a second import path for a type whose one owner is `lib/tauri` (ADR 0074's barrel rule). Anyone who needs it imports it from `@/lib/tauri`.

`src/App.tsx:209-218`: add `nameResolution: p.nameResolution,` after `agentName: p.agentName,`. (`exactOptionalPropertyTypes` is OFF in `tsconfig.json`, so assigning a possibly-`undefined` optional is legal — verified.)

Two other readers of `SubagentEntry.agentName` exist and are **inert** to an added optional field — read them so you do not "helpfully" widen them: `AskQuestionCard.tsx:229-231` (the `ask` card's "X is asking…" line, a selector for one string) and `useChildGates.ts:35` (`ChildGate.agentName`, the gate chip — see *Recorded*). Neither enumerates the entry's keys, and `useChildGates.test.ts`'s two `toStrictEqual` assertions (`:85`, `:117`) compare the constructed `ChildGate`, not the entry.

`src/components/SubagentDelegatingCard.tsx`:
- Import `MutedCaption` (`import { MutedCaption } from "./MutedCaption";`).
- In the row builder, next to the existing `const reason = storeEntry?.reason;`, add `const nameResolution = storeEntry?.nameResolution;` and put `nameResolution,` in the returned row object (next to `reason`). **Do NOT touch the `agentCandidate` / `agentName` fallback chain at `:222-228`** — the marker is ADDITIVE; the name itself stays whatever the chain says.
- In line 1 of the row (`:446-459`), after the `{row.task && …}` fragment, add:

```tsx
                    {/* (issue #47) The resolve miss — ONE quiet caption, and
                        ONLY for `unmatched`. A name that matched no definition
                        still dispatches (ADR 0020), so this must not read as a
                        failure: the row keeps its name, its status icon, its
                        metadata line and its click handler, and the child's
                        real output still renders. `no_name` / `matched` /
                        absent render nothing here at all. */}
                    {row.nameResolution === "unmatched" && (
                      <MutedCaption
                        className="shrink-0 text-warning"
                        title={`No Agent definition named "${row.agentName}" — this child loaded no persona, no tool allowlist and no model override, and ran the parent's config instead.`}
                      >
                        no matching Agent
                      </MutedCaption>
                    )}
```

  Measured through the real `mergeUiClasses`: `cn("text-ui-xs text-foreground-subtlest", "shrink-0 text-warning")` → `text-ui-xs shrink-0 text-warning` — the colour override wins the `text-color` group and the size survives (it is a registered group in `components/lib/utils.ts`), which is exactly `MutedCaption`'s documented `cn` contract. `text-warning` is already in `paletteCompleteness.test.ts`'s `TEXT_TOKENS` and already graded on `bg-panel` at ≥4.5, so that scanner stays green untouched.
- **Update `DIRECTORY_ROW_WALL`'s doc comment (`:62-66`) in the same edit.** It enumerates the row's inks — "`text-foreground`, `text-foreground-subtle`, `text-foreground-subtlest`, `text-destructive`, `text-success`, and the activity line's own `colorClass`" — and the new caption adds `text-warning`, which would make it an under-count. Add the token to the list (this repo already records an under-count as a debt worth avoiding — see the backlog doc's T2 deviation entry). Nothing else in that wall comment changes: the caption is a `<span>` that spells its own ink, so the `Button` base's ink still never reaches it, and `shrink-0` is the geometry `MutedCaption` documents for a flex-row caption.
- The marker is a `span.text-ui-xs`, NOT a `div.font-mono.text-ui-xs`, which is load-bearing for the existing D3 helper `metadataLine()` (`SubagentDelegatingCard.test.tsx:584-590`) — it asserts `document.querySelectorAll("div.font-mono.text-ui-xs")` has length 1. Do not give the caption `font-mono` or make it a `div`.
- **Keep `aria-label={`Open ${row.agentName} transcript`}` (`:440`) EXACTLY as it is.** The caption is rendered INSIDE the `<Button>`, so a reader might expect it to join the button's accessible name and break the assertions that match that label verbatim — `SubagentDelegatingCard.test.tsx:385`, `:392`, `:681`. It does not: `aria-label` wins over the content-derived name in the accname algorithm that `dom-accessibility-api` (behind `getByRole({ name })`) implements, so the explicit label stays the whole name. That precedence is WHY the label must not be edited — it is the only thing keeping those three green — and test 13's third assertion ("click-to-open survives") is what proves it. The nine `Open … transcript` lookups in `TodoBoardPanel.test.tsx` (`:259`, `:410`, `:413`, `:511`, `:532`, `:595`, `:645`, `:667`, `:723`) belong to `TodoBoardPanel.tsx:278-281`, a `div[role=button]` that spells its OWN `aria-label` and never renders this component — inert, listed only so nobody edits that label "for consistency".

`src/components/SubagentDetailHost.tsx`: after the status chip (`:98-105`) inside the header row, add the same conditional on `selected.nameResolution === "unmatched"` with the same text and `className="shrink-0 text-warning"` (import `MutedCaption`). **Do NOT change the dialog's `aria-label` (`:76`)** — `SubagentDetailHost.test.tsx` looks the dialog up as `{ name: /transcript/ }`.

### 7. `commands/agents.rs` — one new assertion, no logic change

`agent_config_and_the_dispatch_resolve_the_same_row` (`:930-937`): `let (dispatch, name_resolution) = crate::agent::harness::launch::resolve_launch(…);` and after the existing three field comparisons inside the loop add

```rust
            // (issue #47) The parity cases are all MATCHED cases — the fixture
            // writes `scout.md` into the scratch Space for every one of them,
            // so if any of them ever resolves to `Unmatched` the three
            // comparisons above are comparing a config-less launch against the
            // modal's row and proving nothing.
            assert_eq!(
                name_resolution,
                crate::agent::subagent::AgentNameResolution::Matched,
                "both sides were handed a Space that defines `scout`: {settings_body}"
            );
```

---

## Tests

### Rust — write these FIRST (they are the RED)

**`harness/launch.rs`'s `mod tests`.** 29 existing `resolve_launch(` call sites need the mechanical update: `let resolved = resolve_launch(…)` → `let (resolved, _) = resolve_launch(…)` (that form keeps every existing field assertion byte-identical), and the two `assert_eq!(resolve_launch(…), launch, "…")` forms (`:414-424`, `:458-468`) become tuple comparisons with the resolution named — which is where the miss/no-miss pin actually lands. One site takes the binding instead of `_`: `resolve_launch_with_an_empty_agent_name_short_circuits` (`:1869-1881`) is the file's empty-name pin, so it becomes `let (resolved, resolution) = …` plus `assert_eq!(resolution, AgentNameResolution::NoName, "an empty name is the DELIBERATE config-less case, never a miss");` while keeping its existing `assert_eq!(resolved, launch)` and its whole doc block (including the paragraph explaining why delegation is pinned elsewhere) untouched.

1. `resolve_launch_unknown_agent_name_returns_the_launch_verbatim` (`:435`) — **keep the name** (it is ADR 0020's pin), and make its assertion
   `assert_eq!(resolve_launch(&launch, "nope", …), (launch, AgentNameResolution::Unmatched), "an unknown agentName returns the launch verbatim AND reports the miss");`
   plus a second, separate assertion that the returned config is byte-equal to the input (keep the original `assert_eq!` on `.0`) so the ADR 0020 half stays pinned even if the tuple shape changes.
2. `resolve_launch_no_agent_name_returns_the_launch_verbatim` (`:406`) — same shape with `AgentNameResolution::NoName`, and its doc gains: *the tri-state is the point of this test — an empty `agentName` is NOT a miss (config-less dispatch is deliberate), and `NoName` is what keeps the UI silent for it.*
3. `resolve_launch_case_insensitive_match` (`:477`) — destructure and add `assert_eq!(resolution, AgentNameResolution::Matched, "a different case is a MATCH (eq_ignore_ascii_case), never a miss");`. This is the case-insensitivity pin the brief asks for; it needs NO new test because the config assertions already prove the definition applied.
4. **NEW** `resolve_launch_a_blank_name_is_no_name_and_a_padded_name_is_a_match` — with the same scratch-`HOME` isolation the neighbours use (`crate::test_support::env_lock()` + the in-file `RestoreHome` drop guard + `unsafe { std::env::set_var("HOME", empty_home) }`, the `env_lock` held across both cases):
   - `resolve_launch(&launch, "   ", …)` → `(launch, NoName)` — a whitespace-only name hits the same `trim()` short-circuit, so it is NOT a miss;
   - `resolve_launch(&launch, "  scout  ", …)` over a Space holding `scout.md` → `(resolved_with_the_frontmatter, Matched)` — the trim must not turn a real name into a miss.
   Both are cheap, both are the edges the brief names, and neither duplicates test 3 (which pins CASE, not whitespace).

**`worker/protocol.rs`'s `mod tests`** — next to `the_failure_reason_serialises_in_snake_case` (`:588`):

5. **NEW** `the_agent_name_resolution_serialises_in_snake_case` — `serde_json::to_value` of each variant equals `json!("no_name")` / `json!("matched")` / `json!("unmatched")`. `no_name` is the only two-word value in the whole subagent vocabulary, so it is the one a "consistency" rename would break; the frontend mirrors these three bytes.
6. **NEW** `an_old_shape_subagent_dispatch_line_without_name_resolution_is_a_decode_error` — build the frame the way the existing round-trip `cases` vec does (`:684-693`, `Outbound::SubagentDispatch { id: "sub1", parent_session_id: "s1", parent_cwd: "/tmp/space", parent_enabled_tools: vec!["bash"], agent_name: "tester", name_resolution: AgentNameResolution::Matched, launch: LaunchConfig::default(), task: "do the thing", model_key: "fake/m1" }`), `encode_outbound` it, then `let old = line.replace("\"nameResolution\":\"matched\",", "");` and assert `decode_outbound(&old).is_err()`. Also assert the NEW line still decodes (`decode_outbound(&line)` is `Ok` and its `name_resolution` field reads back `Matched`) — the pair is what proves the error is the MISSING field and not a broken encoder. Its doc carries the WHY (see §4): the permissive `Unknown` fallback does NOT apply to a `type` in the explicit allow-list, every possible default for this field is a lie about whether a persona loaded, and the self-exec pairing makes the mix unreachable — so loud-and-impossible beats silently-wrong. This is the trap-pin against someone "tidying" the tolerance in later, mirroring T10's `an_unknown_start_mode_is_a_decode_error_never_a_silent_main_prompt`.

**`worker/dispatch.rs`'s `mod tests`** — `dispatch_emits_the_frame_and_registers_the_waiter` (`:156-200`): add `name_resolution,` to the `Outbound::SubagentDispatch { … }` pattern (it is a COMPLETE pattern — leaving it out is E0027) and assert `assert_eq!(name_resolution, AgentNameResolution::Matched, "the resolver's report rides the frame verbatim");` (the call passes `Matched`). The second test (`:238`) uses `{ id, .. }` and needs only the argument.

**`worker/manager/tests/mod.rs`** — both `SubagentDispatchWire` literals (`:349` in `dispatch_child_task_with_id`, `:1798` in the liveness teardown test) gain `name_resolution: AgentNameResolution::Matched,`, and `AgentNameResolution` goes into the file's existing `use crate::agent::subagent::{LaunchConfig, SubagentFailureReason, SubagentOutcome};` (line 10). Same for `loop/tests/subagents.rs:16` and `worker/dispatch.rs`'s test module. `protocol.rs`'s production code names the type by FULL path (`crate::agent::subagent::LaunchConfig` at `:167` / `:297`) — follow that, no new import at the module top; its `mod tests` already imports from `crate::agent::subagent` at `:400`, so add the name there. Then:

7. `the_subagent_ui_lifecycle_events_fire_on_the_parent_sink` (`:1895`) — after `assert_eq!(started["agentName"], "tester");` add
   `assert_eq!(started["nameResolution"], "matched", "the tri-state rides the payload");`
8. **NEW** `the_started_payload_names_a_resolve_miss_and_pins_its_full_key_set` — drive TWO dispatches through the real flow, each on its OWN parent session (`"n1"` and `"n2"`, each with its own `register_sink` + `attach(test_env(…))`), each dispatching a wire built INLINE from `dispatch_child_task_with_id`'s body (copy those nine field assignments — the literal holds eight today; **do not change the helpers' signatures**, ten call sites across `dispatch_child_task` and `dispatch_child_task_with_id` depend on them) with a DISTINCT `id` (`"miss-1"` / `"miss-2"`, because the fixture's `subagent-result` and any `subagent-cancel` route by DISPATCH id and a shared id would attribute one drive's outcome to the other) and one field differing per case: `name_resolution: AgentNameResolution::Unmatched` and `name_resolution: AgentNameResolution::NoName`. For each parent's collected sink events assert:
   - `started["nameResolution"] == "unmatched"` / `== "no_name"` — the wire spelling, from the REAL emit;
   - `started["agentName"]` is still `"tester"` (the marker is additive — the label never disappears);
   - the payload's key set is EXACTLY the eight keys `sessionId, parentSessionId, agentName, nameResolution, task, model, thinkingLevel, enabledTools` (a `BTreeSet` of `as_object().keys()` compared with `assert_eq!`). **This is the byte-for-byte payload pin** — see the correction in §Frontend tests for why it lives here and not in `events.test.ts`. `thinkingLevel` is always present (`json!` writes the key even when the value is `null`, and `serde_json`'s default `Map` is a `BTreeMap` with no `skip_serializing_if` anywhere in this literal), so the count is stable at 8;
   - the drive still reaches `subagent-closed` with `status` `"completed"` — the miss is NON-BLOCKING, which is the acceptance criterion in the one place that can prove it without a model (use the existing bounded poll-for-`subagent-closed` loop from `the_subagent_ui_lifecycle_events_fire_on_the_parent_sink`, `:1905-1922`, rather than a bare sleep).

**`harness/loop/tests/subagents.rs`** — the four test `impl SubagentDispatcher`s (`:582`, `:715`, `:765`, `:1020`) gain `_name_resolution: AgentNameResolution,` after `_agent_name` (add the type to the file's `use crate::agent::subagent::{LaunchConfig, SubagentOutcome, SubagentSessionManager};` line at `:16`).

9. `a_native_subagent_with_a_matching_agent_name_runs_the_frontmatter_config` (`:369`) — after its `thinkingLevel` assertion add `assert_eq!(started.1["nameResolution"], "matched", "a discovered definition reports MATCHED end to end");`. Its neighbour `…_suffix_model_key_uses_the_suffix_thinking` (`:125`) also carries `agentName: "scout"` and a real definition, so it gains nothing (one matched-leg end-to-end pin is enough; do not duplicate).
10. **NEW** `a_subagent_named_after_no_definition_still_runs_and_says_so`, built on that same fixture shape (`ScriptedProvider` + `make_subagent_manager` + `build_loop_with_dispatcher` with `InProcessDispatcher`, `SPAWN_MS` bounds) but with `arguments: json!({ "task": "recon the auth code", "agentName": "reviewr" })` and **no agent file written at all**:
    - the `subagent` `tool_execution_end` for `t1` still has `is_error == false` and `result["content"][0]["text"] == "canned answer"` — **the miss never fails the dispatch** (the same non-blocking doctrine as T9's warning and ADR 0055's metrics);
    - the parent turn settles (`agent_settled`);
    - the `RecordingSink`'s `subagent-session-started` payload has `started.1["nameResolution"] == "unmatched"` and `started.1["agentName"] == "reviewr"`.
    This is the issue's exact scenario (`"reviewr"`) in CI terms, through the REAL `resolve_launch` → `dispatch_native` → `subagent_flow` path. Follow the neighbour's `HOME` note (`:362-368`): no `env_lock()` needed, the space-level root is scanned first and the mutators' scratch homes hold no agent files — but if you add a `HOME` assertion, take the lock first.

### Frontend tests

**Correction the brief should have carried, verified before writing this plan:** `src/lib/ipc/events.test.ts` pins EVENT NAMES and nothing else — its three assertions are the constant values, the `Object.values` SET of names, and the `INTERACTIVE_EVENTS` discriminants. It does not touch payload shapes, so **adding `nameResolution` requires no change there**, and `subagent-session-started` is already in its lists (`:54`, `:70`) and stays. Grepping the tree found NO frontend test pinning `SubagentSessionStartedPayload`'s key set (`fixtures.test.ts` pins that shape for `AppSettings` and `SessionInfo` only), which is why the real payload pin goes in Rust (test 8) where the emitter lives. Leave `events.test.ts` untouched and say so in the commit body — do not add a payload assertion to a file whose header documents that it pins names.

What DOES need updating is `src/lib/tauriBarrel.test.ts`: `TAURI_PUBLIC_API` (`:181-285`) is a pinned literal compared with sorted `toEqual`, so `"AgentNameResolution"` must be added to it (alphabetically, next to `"AgentConfigDto"`/`"AgentDefinitionDto"`). It goes in the TYPE list ONLY — `TAURI_RUNTIME_API` (`:287-345`) is compared against `Object.keys(await import("./tauri"))` and a type vanishes at runtime, so adding it there is a false failure.

11. `src/store/subagents.test.ts` — **NEW** `it("carries `nameResolution` through `addSession`, and leaves it absent when the payload omits it")`: `addSession({ …A1, nameResolution: "unmatched" })` → `entries.sub1.nameResolution === "unmatched"`; then `addSession(A1)` for a fresh id → `expect("nameResolution" in entries.sub2).toBe(false)` (the store spreads the caller's object, so an omitted field must not become an `undefined`-valued key — that is what keeps `toEqual` comparisons downstream honest).
12. `src/test/fixtures/subagents.ts` — add `"nameResolution"` to the `for (const optional of […])` drop list (`:37`) so a fixture never carries an `undefined`-valued key, mirroring the file's stated reason. `src/test/fixtures.test.ts`'s existing assertions (`:305-308`) name only `endedAt`/`metrics`/`reason`, so they stay green untouched; **add** one line `expect("nameResolution" in entry).toBe(false);` to that same test so the new key is covered by the guard that exists for exactly this.
13. `src/components/SubagentDelegatingCard.test.tsx` — **NEW two cases**, using the file's own `entry()` helper and the `addSession` seeding pattern:
    - `renders the resolve-miss caption for an unmatched name, and everything else unchanged`: seed `entry({ sessionId: "sub1", agentName: "reviewr", nameResolution: "unmatched" })`, render with `rawInput={{ task: "review the diff", agent: "reviewr" }}`; assert `screen.getByText("no matching Agent")` exists, `screen.getByText("reviewr")` STILL exists (the marker is additive — the name is never replaced), `screen.getByRole("button", { name: "Open reviewr transcript" })` still exists (click-to-open survives), and the row's status glyph is unchanged (the child is `running`, not failed).
    - `renders NOTHING extra for a matched name, a config-less dispatch, or an older payload`: three `render`s in one test — `nameResolution: "matched"`, `nameResolution: "no_name"`, and the field absent (an entry built without it) — each asserting `screen.queryByText("no matching Agent")` is `null`. This is the "nothing extra for matched/no-name" criterion, including the older-backend case.
    The existing `falls back to 'subagent' when agent name is empty string or absent` (`:469`) must stay green untouched — it seeds no `nameResolution`, so it is exactly the "absent" arm of the test above.
14. `src/components/SubagentDetailHost.test.tsx` — **NEW** `shows the resolve-miss marker in the sheet header for an unmatched name, and nothing for a matched one`: `addSession({ …entry, nameResolution: "unmatched" })` + `select("sub1")` → `screen.getByText("no matching Agent")` is inside the dialog (`dialog.contains(…)`), and the header still shows `screen.getByText("reviewer")` and the `running` chip; then the same with `"matched"` → `queryByText("no matching Agent")` is `null`. Keep the dialog lookup as `{ name: /transcript/ }` (the `aria-label` is unchanged).
15. `src/App.test.tsx` — **NEW** describe `"App (the \`subagent-session-started\` listener)"` with one test mirroring the `subagent-closed` pattern at `:1057-1063`: render `<App />`, take `vi.mocked(listenSubagentSessionStarted).mock.calls` LAST callback (the file never clears mocks — the existing comment at `:1038` documents that), `act(() => onStarted({ sessionId: "sub1", parentSessionId: "main1", agentName: "reviewr", task: "t", nameResolution: "unmatched" }))`, then assert `useSubagents.getState().entries["sub1"].nameResolution === "unmatched"` — the wiring is the one thing no component test can see (they seed the store directly). Two mechanical prerequisites: add `listenSubagentSessionStarted,` to the file's `import { … } from "./lib/tauri";` block (`:4-11` — the mock factory at `:121` already provides the `vi.fn()`, and `listenSubagentClosed` is imported there today as the precedent), and clear `useSubagents` in `beforeEach`/`afterEach` the way the neighbouring describe's `clearStore` does (`:1015-1029`).

### Mutation probes (run them; report what reddened)

- Delete the `Unmatched` exit in `resolve_launch` (return `NoName` there) → tests 1, 8, 10 must redden; if 10 stays green the end-to-end path never reached the resolver.
- Drop the `"nameResolution"` line from the `json!` → tests 7, 8, 10 redden; test 8's key-set assertion is the one that names the missing key.
- Render the marker for `row.nameResolution !== "matched"` instead of `=== "unmatched"` → test 13's second case reddens (that is the "flagging the deliberate case" bug the tri-state exists to prevent).
- Change the serde rename to `camelCase` → test 5 reddens, and so does every Rust payload assertion.

---

## Steps

- [ ] Read, in this order: `src-tauri/src/agent/harness/launch.rs:1-30` + `:85-160` + `:255-330`; `src-tauri/src/agent/harness/dispatch.rs:28-200` + `:240-300` + `:480-500` + `:600-660`; `src-tauri/src/agent/subagent.rs:30-70` + `:120-180` + `:490-520` + `:760-790`; `src-tauri/src/agent/worker/protocol.rs:155-200` + `:285-300` + `:340-395` + `:555-600` + `:670-700`; `src-tauri/src/agent/worker/dispatch.rs:44-90` + `:155-255`; `src-tauri/src/agent/worker/client.rs:770-800`; `src-tauri/src/agent/worker/manager/subagent_flow.rs:475-650`; `src-tauri/src/agent/worker/manager/tests/mod.rs:340-370` + `:1785-1815` + `:1885-1945`; `src-tauri/src/agent/harness/loop/tests/subagents.rs:115-230` + `:355-470` + `:575-600` + `:710-780` + `:1015-1040`; `src-tauri/src/bin/fake_worker.rs:79-90` + `:455-500`; `src-tauri/src/commands/agents.rs:215-265` + `:925-985`; then the frontend: `src/lib/tauri/types.ts:365-450`, `src/lib/tauri.ts:52-116`, `src/lib/tauriBarrel.test.ts:180-345`, `src/store/subagents.ts`, `src/App.tsx:203-222`, `src/components/SubagentDelegatingCard.tsx:200-250` + `:425-470`, `src/components/SubagentDetailHost.tsx:70-110`, `src/components/MutedCaption.tsx`, `src/test/fixtures/subagents.ts`, and `docs/roadmap/issue-triage-backlog-task10-child-start-signal.md` (the T10 seam). **Trust the tree over this plan where they disagree, and say so in the report.**
- [ ] Confirm T10 has landed: `grep -n "FreshChild" src-tauri/src/agent/worker/protocol.rs` is non-empty and `subagent_flow.rs`'s child envelope says `StartMode::FreshChild`. If it has NOT, STOP — this task is sequenced after it and the `protocol.rs` edit will collide.
- [ ] RED first: write Rust tests 1-6 and 7-10 (the `manager/tests/mod.rs` and `loop/tests/subagents.rs` ones). Run `cargo test --lib agent::harness::launch` then `cargo test --lib agent::worker` from `src-tauri/`.
  - Expect a COMPILE failure (`no variant, constant, or function named AgentNameResolution` / E0308 mismatched types on the tuple). That is the RED, and it is an honest one — say so in the commit body rather than implying an assertion failure. If it compiles and passes, you wrote a test that cannot fail — stop and look.
- [ ] Implement §1 (`subagent.rs` + `agent/mod.rs`) and §2 (`launch.rs`, including the 29 test call sites). Run `cargo test --lib agent::harness::launch` → tests 1-4 green.
- [ ] Implement §3 (the trait + both impls + the call site) and the mechanical signature update in the four test `impl`s in `loop/tests/subagents.rs`, plus §4 (the frame, `client.rs`, `fake_worker.rs`) and §5 (the emit). Run `cargo test --lib agent::worker` → tests 5-8 green; `cargo build --all-targets` to catch every remaining call site.
- [ ] Implement §6 (frontend) and §7 (`commands/agents.rs`'s assertion). Run `cargo test --lib commands::agents` → green.
- [ ] Add the frontend tests (11-15) and the two pinned-list updates (`tauriBarrel.test.ts`, `fixtures/subagents.ts`). From the repo root: `pnpm test src/store/subagents.test.ts src/components/SubagentDelegatingCard.test.tsx src/components/SubagentDetailHost.test.tsx src/test/fixtures.test.ts src/lib/tauriBarrel.test.ts src/App.test.tsx` → green.
  - If `tauriBarrel.test.ts` reddens on the runtime list, you put `AgentNameResolution` in `TAURI_RUNTIME_API` — it is a type and must not be there.
- [ ] Rust test 10 (`a_subagent_named_after_no_definition_still_runs_and_says_so`) is the one that can show a real assertion RED before the fix if you revert only the `json!` line — use it as the issue-reproduced evidence in the commit body.
- [ ] Survey the existing `subagent-session-started` assertions that must stay green WITHOUT edit: `src/agent/subagent.rs:595-604`, `src/agent/harness/loop/tests/subagents.rs:212-226` and `:334-347` and `:436-460`, `src/agent/worker/manager/tests/mod.rs:1927-1945`, `tests/harness_dispatch_native.rs:210-230` and `:385-400` and `:492-505`, `tests/harness_subagent_dispatch.rs:328-360`, `tests/worker_e2e.rs:1144-1180`, `tests/ipc.rs:833-845`. Every one of them reads a named key, none enumerates the key set — so an added key is inert to all of them. If one reddens, you changed an EXISTING key's value or spelling, not added one: revert that.
- [ ] Fix the doc comments named in §1-§5 (the `launch.rs` module doc line 11, `resolve_launch`'s doc block — including deleting "The signature is deliberately unchanged" — `dispatch.rs`'s ADR 0020 comment, `subagent_flow.rs`'s step-6 comment, `dispatch_native`'s doc, `protocol.rs`'s variant doc). `cargo fmt` after the doc edits (a doc-comment rewrap is the commonest fmt red on a task like this).
- [ ] `cargo fmt --all -- --check` from `src-tauri/`.
- [ ] `cargo clippy --all-targets -- -D warnings` from `src-tauri/` → **0 warnings**. Watch for: `too_many_arguments` if you add the parameter to a signature that lost its existing `#[allow(clippy::too_many_arguments)]` (the trait, `InProcessDispatcher`, `MockDispatcher`, `dispatch_native` and the four test impls ALL already carry it — keep every one), and `unused_imports` if a `LaunchConfig`-only import can be merged rather than duplicated.
- [ ] FULL gate. From `src-tauri/`: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`; from the repo root: `pnpm test`, `pnpm build`.
  - **Re-measure the baseline at YOUR starting HEAD before you start** (`cargo test 2>&1 | tail` + `pnpm test 2>&1 | tail`) — the parent doc's Gate section is stale by one task (it still records 1369 while T7 has landed as `d2cb1fa`). The brief's figure is **Rust 1381 / 0 failed / 4 ignored** post-T7, and T8/T9/T10 land before this task and each adds tests (T9 +7, T10 +6). Your own delta is **+5 Rust** (launch.rs 1, protocol.rs 2, `manager/tests/mod.rs` 1, `loop/tests/subagents.rs` 1) and **+5 FE** (store 1, card 2, sheet 1, App 1). Land on +5 exactly: +4 means one of your tests never registered, +6 means you added one this plan did not ask for.
  - FE file count stays **149** (no new test file). The FE test floor recorded by the parent is **3051 / 149**; expect **3056 / 149** plus whatever T2-style additions landed after it — record the absolute numbers in the commit body.
  - `pnpm build` (`tsc && vite build`) must exit 0 — `tsc` is the gate that catches the `verbatimModuleSyntax` type-import rules in `store/subagents.ts` (use `import type`, and keep the `export type { … }` block's shape).
- [ ] Commit with message:

      feat(subagent): a name that matches no Agent definition is visible on the wire and in the sheet (#47)

  Body must state: the tri-state and why it is three and not two (an omitted name is ADR 0020's designed config-less dispatch, a typo is the bug — a bool would flag the designed case); the launch still returns verbatim and the child still runs (ADR 0020 untouched, `is_error` untouched, nothing blocks); `resolve_agent_launch` / `ResolvedLaunch` / the Agents modal are deliberately NOT part of the report; the override case was checked and is already visible as the Agents modal's "No longer discovered (stale override)" row, and an orphan override can never reach a child anyway; `events.test.ts` needed no change because it pins names and not payloads, so the payload's key set is pinned Rust-side at the emitter; and the one forced line in `src/bin/fake_worker.rs` (a complete struct-variant literal cannot survive a new field) — flagged for T12.

---

## Acceptance criteria

- [ ] `resolve_launch` returns `(LaunchConfig, AgentNameResolution)` and its three exits report `NoName` (empty or whitespace-only `agentName`), `Matched` (including a different-case name — `resolve_launch_case_insensitive_match` asserts it) and `Unmatched` (a name matching no definition). The two miss/no-name exits still return the launch VERBATIM, byte-equal to the input, and every one of the 29 pre-existing assertions in `launch.rs`'s `mod tests` still holds.
- [ ] `resolve_agent_launch`, `ResolvedLaunch`, `OverrideLayer`, `override_layer` and `commands::agents::agent_config` are unchanged in signature and behaviour (ADR 0068's shared seam intact); `agent_config_and_the_dispatch_resolve_the_same_row` is green and now also pins that its parity cases resolve to `Matched`.
- [ ] `subagent-session-started` carries `nameResolution` with the exact values `no_name` / `matched` / `unmatched` (pinned at the type in `protocol.rs`, at the real emit in `manager/tests/mod.rs`, and end-to-end in `loop/tests/subagents.rs`), and its payload key set is EXACTLY the eight keys — every pre-existing assertion on the other seven keys stayed green unedited.
- [ ] The Outbound frame carries the field with **no** `#[serde(default)]`, and an old-shape frame is a decode ERROR (test 6) — no silent default can ever claim a config-less dispatch was a typo or vice versa.
- [ ] A `subagent({ agentName: "reviewr" })` call with no matching definition **still dispatches and still succeeds**: `is_error == false`, `content[0].text` is the child's captured output, the parent turn settles, and the child reaches `subagent-closed` `status: "completed"` (tests 8 and 10). Nothing about the miss blocks or fails anything.
- [ ] The directory row (`SubagentDelegatingCard`) and the transcript sheet (`SubagentDetailHost`) each render one muted `text-warning` caption reading `no matching Agent` **only** for `"unmatched"`, and nothing extra for `"matched"`, `"no_name"` or an absent field (older backend). The child's name, status icon, metadata line, activity line and click handler are unchanged in every case, and `aria-label="Open <name> transcript"` / the dialog's `… — transcript` label are byte-identical.
- [ ] `src/lib/ipc/events.test.ts` is untouched and still green; `src/lib/tauriBarrel.test.ts`'s `TAURI_PUBLIC_API` gained `AgentNameResolution` and `TAURI_RUNTIME_API` did NOT.
- [ ] The per-Space/settings-override question is answered in the commit body, not in code: one global map, an orphan override is already rendered as "No longer discovered (stale override)" with ADR 0023's remove button, and `override_layer` is only consulted AFTER a definition matched so an orphan can never produce a child. No duplicate marker.
- [ ] Gate green: `cargo test` = your re-measured baseline **+5**, 0 failed, 4 ignored; `cargo clippy --all-targets -- -D warnings` 0 warnings; `cargo fmt --all -- --check` clean; `pnpm test` = baseline **+5** tests / 149 files; `pnpm build` exit 0. Absolute numbers recorded in the commit body.

---

## Recorded, not fixed here

- **The parent model is never told about a miss in its tool result.** T9's `unknown_param_warning` fires on unknown KEYS and stays that way on purpose: it is a pure function of `(advertised_specs, tc)` — the same value `model_request` sends as `tools[]` and `build_main_prompt` renders into `<tools>` — and a VALUE-level check needs the Agent catalog, i.e. a second source of truth inside the checker, which is the drift T9's whole design exists to avoid. The honest place for it is a second message assembled in `harness/dispatch.rs::dispatch_subagent` (where the resolution is already in scope) and appended to the `ToolResult` the way T9 appends its block. That is a decision about what the model reads, so it is a task of its own, not an insertion into this one.
- **An override whose `tools` list names a nonexistent TOOL is silently narrowed.** `resolve_agent_launch`'s `narrow` (`launch.rs:216-230`) drops unknown names and treats an emptied list as absent (ADR 0067), and the modal reports WHICH LAYER won but not which names were dropped. Fixing it means a `dropped_*` field on `ResolvedLaunch` — ADR 0068's struct, the modal's contract, and a decision about what the modal should say. Different seam (tool names, not agent names); out of scope.
- **No marker on the `↳ <agentName>` gate chip** (`InlineGateRow.tsx:92-97`, fed by `useChildGates.ts:35` `ChildGate.agentName`). It is the third surface that prints a child's name, and it is deliberately left alone: a gate is the moment the user must ACT, and `ChildGate` carries no resolution field — threading one means widening the hook's `childGatesOf` signature and its `toStrictEqual` pins in `useChildGates.test.ts` (`:85`, `:117`). Two surfaces is where the label is read as a claim about identity; a chip is a pointer to a row that already says it.
- **The miss is not persisted.** `subagent-session-started` is a live frame and a child's transcript is never re-hydrated into the panel (`store/subagents.ts`'s retention cap + `list_sessions`' `is_subagent = 0` filter), so after a reload the marker is gone with the entry. That is the pre-existing lifetime of every field on this payload (`model`, `thinkingLevel`, `metrics`), not a new hole; making it durable would mean a column on the child's `sessions` row and an ADR.
- **`nameResolution` cannot disagree with the config it describes.** The field travels from the one place that answered the question; nothing re-derives it. If a future layer (ADR 0066's deferred per-Space override) changes which definition wins, `resolve_launch`'s `Matched` still means "a definition was found", which is the only claim the marker makes.
