---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/63
done-when: A model / thinking / tools override pinned in the sidebar Agents modal is what a `subagent` dispatch runs IN EVERY Space (the same override for all of them — no Space can diverge, because there is no per-Space layer to diverge with); the modal shows the effective value AND the layer that supplied it for every definition the active Space can list; the Settings page has no Agents section at all; and the whole guarantee is pinned by a `resolve_launch` test per layer position, not by a UI test.
---

# Global Agent overrides (the sidebar Agents modal) — Plan

**Goal:** add a sidebar **Agents** modal that overrides an **Agent definition**'s model / thinking / tools app-globally — and delete Settings → **Agents**, so the modal is the ONE Agent surface.

**Architecture:** a flat `agentOverrides: { "<agentName>": { model?, thinking?, tools? } }` map in `settings.json` (ADR 0066), replacing ADR 0023's `subagentModels` map. `resolve_launch` grows one layer under the explicit `subagent` params, and the SAME function answers the new `list_agent_config` command, so the modal cannot display a config the dispatch will not run (ADR 0068). An override never speaks by being empty (ADR 0067). One editing surface, one global config: the modal is Space-independent for *editing* and Space-dependent only for *listing*, because `list_agent_config` runs discovery with the active Space's `cwd` — the Space decides which definitions you see, never which overrides apply.

**Tech stack:** Rust (Tauri commands, `src-tauri/`), React 19 + TypeScript + zustand + Radix (`src/`), vitest, cargo test.

**Read these before starting:** `docs/decisions/0066-*.md` (the store, why SQLite is ruled out, and what *Deferred: per-Space* leaves open), `0067-*.md` (empty-is-absent), `0068-*.md` (where "effective" is computed, and why the shadowing report belongs in the modal), `CONTEXT.md` entries **Agents**, **Agent definition**, **Subagent session**, **Shadowing**, and the glossary's **Worker process** note (the Worker has no DB and reads `settings.json` in-process).

---

## Parallelisation

**Verdict:** ONE wave of two (Tasks 1 + 3), then 2, 4 and 5 strictly serial.

- **Tasks 1 and 3 share a wave.** Their file sets are disjoint — 1 is the Rust crate (`config.rs`, `launch.rs`, `subagent.rs`), 3 is the frontend settings surface (`SettingsPage.tsx`, its test file, and the deleted section) — neither imports anything the other creates, and each verifies through its own root's command (`cargo test` vs `pnpm test`), so gate 3's shared-artifact argument does not apply either. Task 3 deliberately does NOT touch `AppSettings`, so it needs nothing Task 1 invents. (The old plan put a wire-types task in this slot and could not pair it with Task 1 for a real reason — hand-writing TypeScript interfaces against Serde names that did not exist yet meant **guessing the wire names**, the invented-interface failure the guide calls out. That hazard now lives in Task 4, which is why 4 is serial.)
- **Task 2 follows Task 1:** it calls the resolver function Task 1 creates (gate 2) and both verify through `cargo test` over one shared `target/`, with inline `#[cfg(test)]` modules in `launch.rs` that both edit (gate 3).
- **Task 4 follows both 1 and 3:** its types mirror Task 1's Serde names, and its `AppSettings` swap assumes Task 3 has already deleted the section that read the old field.
- **Task 5 follows Task 4:** it imports the wrapper and types Task 4 adds (gate 2) and owns `SettingsPage.test.tsx`'s orphan behaviour, which Task 3 vacated (gate 3 — one file).

Every task commits normally (no wave children — the wave-1 pair commits independently).

---

### Task 1: The override store and the resolver

**Parallel:** Task 3 — its work is the frontend settings surface and verifies with `pnpm test`; nothing in either task imports the other. Task 2 is NOT parallel to this one (it consumes this task's resolver).

**Context:**

Today an **Agent definition**'s model can be overridden only app-globally, by `settings.json`'s `subagentModels` map (ADR 0023), read at dispatch time inside the **Worker** (`launch.rs:58-63`). This task replaces that map with `agentOverrides` — a flat map keyed by agent name, whose value carries the whole trio — and inserts ONE layer into the launch resolution chain:

    explicit `subagent` param  >  override  >  frontmatter  >  parent defaults

Each layer supplies each of `model` / `thinking` / `tools` **independently** — an entry pinning only `model` lets the other two fall through. `model` keeps ADR 0023's **soft degrade** (a value whose bare key is not in the catalog is skipped, never a failed dispatch). Per ADR 0067 an override **never speaks by being empty**: a `tools` list that is empty, or that filters down to nothing, is indistinguishable from "this layer has no opinion" and falls through — so no override can give a **Subagent session** zero tools (only the explicit param stays verbatim).

The store lives in `settings.json` for the reason in ADR 0066: closing a Space tab runs `DELETE FROM spaces WHERE path = ?1` (`storage/db.rs:721-725`), so anything stored on that row is destroyed by a tab close; and the **Worker** already reads this file at this exact call site, so no `Start` envelope field is needed. Both halves of that argument are about *placement* and neither depends on the override being per-Space — which is why the same decision survives the cut.

**Retiring `subagentModels` is not optional and is not new work.** That map is the existing app-global per-agent model override, and it is edited today by the Settings section Task 3 deletes. Fold its values into `agent_overrides` on read, so an upgrading user keeps every model they pinned; retire the legacy key so it is read once and never written again.

**Do not change:** the explicit param's semantics (verbatim tools, strict model — the `child_tools` match in `subagent_flow.rs`), the `system_prompt` layering, or the `subagent` / `list_agents` strip.

**Read before editing** (the thinking interaction in item 5 depends on all three):
- `subagent_flow.rs` — the `let mut thinking = wire…` chain (`launch.thinking` > `level_suffix` > `frontmatter_thinking`) **and the validation block that immediately follows it**, which drops the level when the resolved model does not advertise it. Both halves matter.
- `launch.rs` — the current `model` / `tools` layering inside `resolve_launch`, and the `fake_model` test helper (note its `supports_thinking: false` / empty `thinking_levels`).
- `config.rs`'s `load_settings` — the `Ok(mut settings)` arm, where the blank-value normalisations already live and where the fold goes.

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/agent/harness/launch.rs`
- Modify: `src-tauri/src/agent/subagent.rs` (doc-comment on `LaunchConfig::thinking` only)
- Test: inline `#[cfg(test)] mod tests` in `config.rs` and `launch.rs`

**What to implement:**

1. In `config.rs`, add the value type. It needs `Default`:

        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        /// One agent's override. Field ABSENCE is the only meaning of
        /// "this override does not speak" (ADR 0067) — hence skip_serializing_if.
        pub struct AgentOverrideFields {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub model: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub thinking: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub tools: Option<Vec<String>>,
        }

   There is deliberately NO wrapper struct holding two maps. The store is one map, so `Settings` carries it directly:

        /// (ADR 0066) Agent overrides keyed by agent NAME (case-insensitive
        /// lookup, as ADR 0023). Serialized camelCase like every other key
        /// in this file: `agentOverrides: { "scout": { "model": … } }`.
        #[serde(default)]
        pub agent_overrides: HashMap<String, AgentOverrideFields>,

   **`#[serde(default)]` and NOT `skip_serializing_if` — check the file before believing any plan on this point, including this one.** `config.rs` carries NO `skip_serializing*` attribute anywhere today (grep it: 42 `#[serde(default…`, zero skips), and that is a real contract, not an oversight: `mcpServers`, `defaultThinkingLevels` and `subagentModels` all serialize an EMPTY map as `"key": {}`, and `AppSettings` declares each of them required, so the renderer can index them unconditionally. Adding `skip_serializing_if = "HashMap::is_empty"` here would make an empty override map VANISH from the document, hand the TypeScript side `undefined` for a field its type calls required, and make `AgentsDialog` throw on `settings.agentOverrides` for every user who has never pinned anything — the exact "an absent key where the renderer expects a value" class this plan flags twice elsewhere. `AgentOverrideFields`' own three `Option` fields DO use `skip_serializing_if`, and that is correct and needed: there, absence is the semantic (ADR 0067), and an absent `model` must not be written as `"model": null`.

2. Give the legacy field a **read-only** life. Replace its attribute on `Settings` (the field is at `config.rs:203`; the struct's own `#[derive]` + `#[serde(rename_all = "camelCase")]` are at `config.rs:124-125` and the hand-written `Default for Settings` at `config.rs:260`) with:

        #[serde(default, skip_serializing)]
        pub subagent_models: HashMap<String, String>,

   Keep the field `pub` (the crate reads it in `load_settings`) and keep it in the hand-written `Default` impl. `skip_serializing` is load-bearing: it is what makes the legacy key disappear from the file on the next save, permanently. **`skip_serializing`, not `skip_serializing_if = "HashMap::is_empty"`** — the two are equivalent for anything that reaches a save through `load_settings` (item 3 clears the map), but the unconditional form also survives a writer that builds a `Settings` literal by hand, which is the one path where a retired key could leak back onto the wire. A derived `Default` is safe on `AgentOverrideFields` because every field is an `Option` — unlike `FontSettings`, whose hand-written `Default` exists precisely because a derived one would produce `size_px: 0`.

3. In `load_settings` (the `Ok(mut settings)` arm, alongside the existing blank-value normalisations), fold the legacy map in and clear it:

        if settings.agent_overrides.is_empty() && !settings.subagent_models.is_empty() {
            settings.agent_overrides = settings
                .subagent_models
                .drain()
                .map(|(name, model)| (name, AgentOverrideFields { model: Some(model), thinking: None, tools: None }))
                .collect();
        }
        settings.subagent_models.clear();

   This lives in `load_settings` and NOT in the `get_settings` command, because the Worker reads settings directly (`launch.rs:59`) and the two processes must not see one file differently (ADR 0066). The fold happens on the read that precedes every save **for a file that parses** — the missing-file and corrupt/unreadable paths return `Settings::default()` and never run the fold, so a hand-edited legacy key inside an otherwise-corrupt file is dropped (pre-existing behaviour for every field, worth stating so the "always folded" claim isn't read as absolute). This is why dropping the legacy key from the TypeScript `AppSettings` in Task 4 loses nothing.

   **The fold is guarded by "the new map is empty", not merged.** A file carrying BOTH keys is a hand-edit, and the new key wins wholesale. Say so in the comment: merging per-agent would make the legacy key able to resurrect a value the user has already cleared in the modal.

4. In `launch.rs`, extract the per-field layering into a function the command in Task 2 can also call. Keep `resolve_launch`'s own signature byte-identical: exactly ONE production caller (`dispatch.rs:278`) and **18** tests in `launch.rs`, and no caller under `src-tauri/tests/` — so it is cheap to keep and expensive to change (grep `fn resolve_launch` to recount — it is 18 plus the definition):

        /// The override layer (ADR 0066: one global map, so one rung).
        /// `None` = no settings file at all — the `config_dir: None` case,
        /// which is a layer that cannot speak rather than an empty map.
        pub(crate) struct OverrideLayer<'a> {
            pub global: Option<&'a AgentOverrideFields>,
        }

        pub(crate) struct ResolvedLaunch {
            pub launch: LaunchConfig,
            /// Which layer supplied each field; "parent" when none did.
            pub model_source: OverrideSource,
            pub thinking_source: OverrideSource,
            pub tools_source: OverrideSource,
        }

        // `pub`, NOT `pub(crate)` — and this one is not stylistic, it is a compile
        // gate. Clippy's `private_interfaces` fires whenever a `pub` item's FIELD is
        // typed with a more-private type, and it fires TRANSITIVELY: making the DTO
        // `pub` while its `SourceFields` stays `pub(crate)` errors on `SourceFields`,
        // and keeping `SourceFields` pub while THIS enum stays `pub(crate)` errors on
        // the enum. So every type in the DTO's reach is `pub`: `OverrideSource`,
        // `OverrideFields`, `SourceFields`. CI runs `cargo clippy --all-targets
        // -- -D warnings`, so each one is a build failure, not a suggestion. Do not
        // "tidy" any of them back to pub(crate). (`mod launch` itself stays
        // pub(crate) — verified: a pub item in a pub(crate) module is fine, and
        // `harness/mod.rs:13` already declares it that way.)
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "lowercase")]
        pub enum OverrideSource { Override, File, Parent }

        pub(crate) fn resolve_agent_launch(
            explicit: &LaunchConfig,
            def: &AgentDefinition,
            layer: &OverrideLayer<'_>,
            catalog: &ModelCatalog,
        ) -> ResolvedLaunch

   And add the SELECTOR here, in this task — not in Task 2 — so there is one place that decides "which stored entry applies" from the first commit:

        // The named lifetime is REQUIRED, and `'_` does not substitute for it: with
        // TWO elided reference inputs (the settings AND `agent_name`) rustc cannot
        // tell which one the returned borrow comes from and refuses the signature
        // with E0106 ("missing lifetime specifier") — verified on the pinned 1.99
        // toolchain. Drop `agent_name` and `'_` would compile; keep both, name `'a`.
        pub fn override_layer<'a>(
            settings: Option<&'a Settings>,
            agent_name: &str,
        ) -> OverrideLayer<'a>
        // `global: None` unless settings is Some AND the case-insensitive scan finds
        // the name — so "no file", "no entry" and "entry present" stay three
        // distinguishable states a caller cannot collapse by accident.

   `resolve_launch` keeps its `(launch, agent_name, catalog, config_dir, space_cwd)` signature and becomes: build the settings in its own `let`, `override_layer(settings.as_ref(), name)`, `resolve_agent_launch(...)`, return `.launch`. **The one-statement form `override_layer(config_dir.map(load_settings).as_ref(), name)` is E0716** ("temporary value dropped while borrowed"): `map` yields an owned `Option<Settings>` temporary, `.as_ref()` borrows it, and the returned `OverrideLayer<'a>` still borrows it when the statement ends. Verified against the pinned toolchain. Two bindings, always:

            let settings = config_dir.map(load_settings);           // owns the Settings
            let layer = override_layer(settings.as_ref(), name);

        so the existing `config_dir: None` path (`dispatch.rs` and the 13 `build_ctx(…, None)` tests) goes THROUGH the selector instead of hand-rolling "no layer".

   The case-insensitive scan lives in the selector and nowhere else: it is ADR 0023's existing `.find(|(k, _)| k.eq_ignore_ascii_case(name))` moved out of the `model` arm, because it now has to find the entry ONCE for three fields.

   **Why the struct survives having one field.** It is tempting to pass `Option<&AgentOverrideFields>` and skip the wrapper. Do not: Task 2's command needs the same selector as the dispatch, and ADR 0066's *Deferred: per-Space* door is a second field on this exact struct plus one more `or_else` arm. A one-field struct that names a concept costs nothing and keeps the layer count in one place; a bare `Option` scatters it.

5. Per field, first layer that supplies wins. **Read this before touching the `model` chain: it is already the target shape and nothing is missing from it.** The `model` override arm EXISTS today (`launch.rs:58-63` reads `subagent_models` and `launch.rs:74-87` applies the soft check) — this task widens the value it reads (`Option<String>` → the entry's `.model`) and does not add an arm. What is genuinely new is that the SAME arm shape appears for `thinking` and for `tools`, which have no override arm at all today:
   - **model:** the override value gets the SAME soft check it already gets — `ModelRef::parse` to strip a `:<level>` suffix, then `resolve_composed_model(catalog, bare).is_some()`, keeping the VERBATIM string on success. Never degrade an explicit param. The only structural change is the `.and_then(|o| o.model.as_ref())` the wider value type forces.
   - **thinking:** write the override into `LaunchConfig::thinking` **only when `explicit.thinking` is `None`**. This needs no wire change: the dispatch chain is `launch.thinking` > the model key's `:<level>` suffix > `frontmatter_thinking`, so filling `thinking` from an override puts it above the suffix automatically and leaves the no-override case byte-identical. Update the `LaunchConfig::thinking` doc-comment in `subagent.rs` (that field, not `frontmatter_thinking` — the latter stays accurate); it currently says "holds the EXPLICIT param only", which becomes false.

        **Validate the candidate against the model the MODEL layer just resolved,
        and demote on failure.** The dispatch validates AFTER its own chain
        (`if !model.supports_thinking_level(level) { thinking = None }`), so an
        override pinning BOTH `model` and `thinking` where the new model does not
        advertise that level sends **no** thinking at all — while a resolver that
        simply reports `thinking: xhigh, source: override` makes the modal print a
        level the child will never use, which is exactly the ADR 0068 lie this
        feature exists to prevent.
        **Split WRITE from REPORT — only the OVERRIDE value may ever be written into
        `LaunchConfig::thinking`.** Writing the `file` value or the model key's
        `:<level>` suffix into that field promotes it to the TOP rung of the
        dispatch's chain and changes behaviour that exists today: it reddens the
        pre-existing `resolve_launch_frontmatter_thinking_migrates_to_its_own_field`
        (asserts `thinking == None` for a file with `thinking: low` against a `None`
        model) and contradicts the bullet below that `frontmatter_thinking` carries
        ONLY the frontmatter's own value.

        So: resolve the model first, then take the override's level only if the
        resolved model's `supports_thinking_level` accepts it (an explicit param,
        when present, is never filtered and outranks it). A demoted override value is
        neither written nor reported as effective — the dispatch drops it, so reporting
        it would be the very lie this rule prevents, and `source` must stay honest
        (never `override` for a dropped value). **Do NOT add a `suppressed_thinking`
        field to `ResolvedLaunch`** — nothing in Task 2's DTO would read it (an unread
        field is a `dead_code` error under CI's `-D warnings`), and the demotion is
        fully assertable without it: the test asserts `thinking == None` and
        `source != Override`. If a later round wants the modal to SHOW the dropped
        level, that is a DTO field plus a `ResolvedLaunch` field in the same commit
        that reads it. An empty `thinking_levels` set soft-passes, as in the dispatch
        (`catalog.rs`'s `supports_thinking_level_empty_set_soft_passes` pins it).
        **Fixture warning:** `launch.rs`'s `fake_model` sets `supports_thinking: false`
        with empty `thinking_levels`, so a careless fixture makes this rule untestable —
        add a helper model that DOES advertise levels (`supports_thinking: true`,
        `thinking_levels: ["low", "high"]`) and pin the demotion with it.
   - **tools:** apply the existing filter (drop unknown names, drop `subagent` / `list_agents`) to the override list, then `(!known.is_empty()).then_some(known)` — i.e. ADR 0067's empty-is-absent, identical to the frontmatter rule. Never filter an explicit `tools`. This is the guard: **no override can empty a child's tools, and none can grant `subagent` / `list_agents`.**
   - `frontmatter_thinking` continues to carry ONLY the frontmatter's own value.
   - `source` per field is `Override` / `File` / `Parent`, where `Parent` means "no layer below the explicit param spoke" — say that in the doc-comment, per ADR 0068. Three spellings, and no Space among them; the label space and the enum are the same list (ADR 0068 records why the fourth was dropped rather than silently losing it).

**Steps:**
- [ ] In `config.rs`, write the failing tests first: (a) `agentOverrides` round-trips in camelCase as a FLAT map (`agentOverrides.scout.model`, no `global`/`spaces` level); (b) an unset FIELD inside an entry is absent from the JSON, not `null` (ADR 0067), while an EMPTY map still serializes as `"agentOverrides": {}` — pin this, it is what keeps the required `AppSettings` field honest (item 1's note); (c) a pre-feature file with `subagentModels: { "scout": "tama/m-1" }` folds into `agent_overrides["scout"].model` through `load_settings`; (d) when `agentOverrides` is NON-empty the legacy key is IGNORED, not merged; (e) after `load_settings`, `subagent_models` is empty AND the serialized JSON contains no `"subagentModels"` key.
- [ ] **Expect TWO pre-existing tests to redden, and rewrite both — do not "fix" them by removing `skip_serializing`:**
      - `subagent_models_round_trips_in_camel_case` — rewrite to the new shape.
      - `settings_round_trip_with_the_new_fields` — it asserts the serialized JSON **contains** `"subagentModels"`, which `skip_serializing` can never satisfy again. Drop `"subagentModels"` from its expected-key array (it lives in the `for key in [...]` list), add `"agentOverrides"`, and add an explicit `assert!(!json.contains("subagentModels"))` so the guarantee is stated positively rather than inherited from the new test (e). **Expect a SECOND red in the same test:** it also *populates* `subagent_models:` in its `Settings { … }` literal and then round-trips with `assert_eq!(back, settings)` — a `skip_serializing` field cannot survive that, so `back.subagent_models` comes back empty and the equality reddens. Fix it by **removing the `subagent_models:` initializer** (and, if you keep a legacy-input case, assert the fold through `load_settings` on a JSON string instead of through a struct round-trip). Both reds are explained by the key array and the initializer; **neither is ever fixed by touching `skip_serializing`** — reverting it re-introduces the dead key on every save, which is the entire point of item 2. Two further pre-existing assertions read `assert!(settings.subagent_models.is_empty())` (`default_settings_are_dark_with_empty_layout` and `a_pre_feature_settings_json_parses_to_the_new_defaults`); both stay GREEN unchanged, because the field still exists — check that they did not silently become vacuous by being deleted.
- [ ] Run `cargo test --lib config` in `src-tauri/`.
  - Did the new tests fail to compile or fail? If a test passed before you implemented, stop and find out why — you are not testing what you think.
- [ ] Implement items 1-3.
- [ ] Run `cargo test --lib config` again — all green, including the pre-existing camelCase test (rewritten to the new shape; it must not be deleted).
- [ ] In `launch.rs`, write the failing resolver tests (reuse the existing `Ctx` / `build_ctx` / `fake_model` helpers at `launch.rs:153-215`, and the temp-dir `settings.json` pattern at `launch.rs:704-712`):
  - the override beats the frontmatter for all three fields at once, and the explicit param still beats the override for all three;
  - an entry pinning ONLY `model` leaves thinking/tools coming from the file (per-field independence);
  - `config_dir: None` (no settings at all) yields no layer — and an EMPTY `agentOverrides` map behaves the same (both are "the layer cannot speak");
  - an override-pinned model missing from the catalog degrades to the frontmatter and reports THAT layer's `source`;
  - `tools: Some(vec![])` in an override falls through (ADR 0067); `tools: Some(vec!["no-such-tool"])` also falls through; a valid narrowing wins;
  - `subagent` / `list_agents` in an override tools list are stripped (the recursion guard, now asserted at the override layer and not only the frontmatter's);
  - an override `thinking` the winning model does not advertise is NOT written into `thinking` and NOT reported effective (needs the levels-advertising fixture — `fake_model` advertises none);
  - the `file` rung and the model key's `:<level>` suffix are NEVER written into `thinking` — pin that the pre-existing `resolve_launch_frontmatter_thinking_migrates_to_its_own_field` stays green;
  - an override `thinking` that IS advertised wins over the model key's `:<level>` suffix (asserted through `resolve_agent_launch`'s `thinking` output; the dispatch-side chain is covered by existing `subagent_flow` tests);
  - the override key matches CASE-INSENSITIVELY and the stored key is not rewritten (the existing `resolve_launch_case_insensitive_override_key` moves to the new shape rather than being dropped);
  - `source` is `Parent` for every field when nothing speaks.
- [ ] Run `cargo test --lib launch` — expect red, then implement items 4-5, then re-run until green.
- [ ] Run `cargo test` (full crate) — the 18 existing `resolve_launch` tests and `commands/agents.rs` must still pass unchanged.
- [ ] Run `cargo clippy --all-targets -- -D warnings` — CI runs it with `-D warnings`, so a warning IS a failure (AGENTS.md says 0 warnings; CI says it harder).
- [ ] Run `cargo fmt` then `cargo fmt --all -- --check` (CI's exact spelling).
- [ ] Commit: `feat(agents): global Agent overrides in the launch chain`

**Acceptance criteria:**
- [ ] `settings.json` carries a flat `agentOverrides` map; `subagentModels` is read once and never written again.
- [ ] The chain resolves per field in the order `explicit > override > frontmatter > parent`, each layer independently.
- [ ] No override can empty a child's tools (ADR 0067), and none can grant `subagent` / `list_agents`.
- [ ] Every one of the 18 pre-existing `resolve_launch` tests still passes unmodified.
- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo fmt --all -- --check` are green.

---

### Task 2: The `list_agent_config` command

**Parallel:** none — imports Task 1's `resolve_agent_launch` / `ResolvedLaunch` (gate 2) and shares `lib.rs` + `launch.rs` tests with it.

**Context:**

The modal must show, per **Agent definition**, the *effective* `model` / `thinking` / `tools` **and which layer supplied each**. ADR 0068 decides this is computed in Rust by the same function the dispatch runs, never re-derived in TypeScript — a second implementation would report a config the next dispatch will not run.

The command calls `resolve_agent_launch` with an **empty** `LaunchConfig`, because `agentName` and the explicit params exist only inside a live `subagent` call and no modal can know them. So `source` names at most three layers, and `Parent` means "nothing below the explicit param spoke" — a dispatch that passes `model:` will still override what the row shows. That is honest, and ADR 0068 records the wording consequence.

The command takes the active Space's `cwd` for ONE reason: it decides which definitions get **listed** (Space-level plus user-level, or user-level alone). It does not decide which overrides apply — there is one global map, and a Space cannot change it.

This is a NEW command. Do **not** widen `list_agent_definitions_for_space`: its DTO deliberately excludes `path` / `system_prompt` / `tools` / `thinking` and filters unmentionable names, both pinned by existing tests in `commands/agents.rs` (`agent_definition_dto_mapping`, `agent_definition_dto_a_none_model_is_null_on_the_wire`, `an_unmentionable_name_is_hidden_from_the_picker_but_kept_elsewhere`), on the documented grounds that an oddly-named definition is still dispatchable by the model passing `agentName` verbatim. The new command needs `path`, `tools`, `thinking`, and must LIST unmentionable names. Widening it would unpin two contracts to serve a different surface.

**Shadowing (ADR 0065) IS in scope.** `main` carries `pub shadowed: Vec<crate::skills::Shadowed<AgentScope>>` on `AgentDefinition` (`src-tauri/src/agents.rs:70`, landed with PR #65) and `SkillsDialog.tsx` already renders the Skill half of the report. The old plan excluded the report on the grounds that the symbols were not on `main` — that is simply no longer true, and the correction is recorded in ADR 0068 rather than dropped. The report is a field discovery already puts on the definition this command is holding, so carrying it costs one `Serialize` on the DTO. Two doc-comments go stale here and are updated in this task: `agents.rs`'s on the field itself (the "**Computed, never rendered — and never crosses the wire**" paragraph, `agents.rs:64-69`) and `commands/agents.rs`'s on `list_agent_definitions` ("the Settings page's Subagents section", `commands/agents.rs:36-40`, whose "no active Space to pass as `cwd`" claim dies with the section).

**Files:**
- Modify: `src-tauri/src/commands/agents.rs`
- Modify: `src-tauri/src/agent/harness/launch.rs` (make `resolve_agent_launch`, `OverrideLayer`, `ResolvedLaunch`, `override_layer` `pub(crate)`-visible to this module if Task 1 left them narrower — the SHARED selector is created in Task 1 and is NOT re-implemented here)
- Modify: `src-tauri/src/agents.rs` (the `shadowed` doc-comment only — it is no longer true that nothing renders it)
- Modify: `src-tauri/src/lib.rs` (register the command beside `commands::agents::list_agent_definitions_for_space` in the `generate_handler!` list — grep for it, do not trust a line number)
- Test: inline `#[cfg(test)] mod tests` in `commands/agents.rs`

**What to implement:**

1. Add a DTO (wire-out only, `#[derive(Debug, Clone, PartialEq, Serialize)]` + `#[serde(rename_all = "camelCase")]`) — named `AgentConfigDto`:

        // Every field is `pub`, and every type it is TYPED with must be `pub` too —
        // `OverrideFields`, `SourceFields` and `OverrideSource` all. Clippy's
        // `private_interfaces` fires transitively down that graph (Task 1 item 4),
        // and CI runs `clippy --all-targets -- -D warnings`, so one crate-private
        // nested type is a build failure rather than a style note.
        pub name: String,
        pub description: String,
        /// `"space" | "user"` — the `AgentScope` Display form.
        pub scope: String,
        /// The DEFINITION FILE's path (the modal prints it; `AgentDefinitionDto`
        /// deliberately omits this one).
        pub path: String,
        pub file: OverrideFields,          // the frontmatter, verbatim
        pub override_: OverrideFields,     // the stored override for this name
        pub effective: OverrideFields,
        pub source: SourceFields,          // "override" | "file" | "parent"
        /// The definitions this name collision EXCLUDED (ADR 0065) — carried
        /// verbatim from `AgentDefinition::shadowed`, which is already a
        /// `Serialize`-deriving `Shadowed<AgentScope>` (camelCase, `{name, path,
        /// scope: "space"|"user"}`). REQUIRED on the wire, not `Option`: the Rust
        /// side always serializes the `Vec` (empty as `[]`), exactly like
        /// `SkillInfo::shadowed` (which `list_skills` serializes straight through —
        /// `Shadowed<T>` already crosses the wire), so TypeScript declares it
        /// required too.
        pub shadowed: Vec<crate::skills::Shadowed<AgentScope>>,

   with `OverrideFields { model: Option<String>, thinking: Option<String>, tools: Option<Vec<String>> }` and `SourceFields { model: OverrideSource, thinking: OverrideSource, tools: OverrideSource }`. Serialize `override_` under the wire name `override` (`#[serde(rename = "override")]`) so the TypeScript side reads `row.override`.

   Use `crate::skills::Shadowed<AgentScope>` DIRECTLY — it is generic, `#[serde(rename_all = "camelCase")]` and `Serialize`-derived, and `list_skills` already serializes it through `SkillInfo`, so this is not a new wire shape. Do NOT mint a mirror `ShadowedAgent` struct: `Shadowed<T>` exists precisely so `skills.rs` and `agents.rs` share one rule and one shape, and a second Rust-side copy of it is the Rust↔Rust twin this ADR exists to forbid. One consequence to plan for: `Shadowed<T>` derives `Debug, Clone, Serialize` only, so the `PartialEq` on `AgentConfigDto` above needs it too — **derive `PartialEq` on `Shadowed<T>` itself** (additive, both users benefit) rather than dropping `PartialEq` from the DTO or mirroring the struct.

2. **Use Task 1's `override_layer` selector — do not write a second one.** The command and the dispatch must agree on WHICH stored entry applies, and a second selector is how they drift. So the command calls `override_layer(Some(settings), &def.name)` (the `Some(...)` is not optional — passing `&settings` into an `Option<&Settings>` parameter is an E0308). Note that unlike the old per-Space design, this command needs no path argument at all: the map is global, so `space_cwd` has nothing to select on. **That absence is the design, and it is worth a line in the command's doc-comment** — it is the one place the code says out loud that no Space can change an override.
   - **On duplicate keys, do not "fix" HashMap order.** Two keys that ASCII-fold equal (`"Scout"` beside `scout`) make `.find` nondeterministic. That is pre-existing (today's `subagentModels` has the same property) and the UI is the thing that prevents it — Task 5 drops every case-fold twin on write. Characterize the behaviour in a test comment rather than silently sorting.

3. **Split the command into a pure core plus a thin wrapper.** This is not stylistic: `tauri::State<'r, T>` is a tuple newtype over `&'r T` with **no public constructor** — it is produced only by `StateManager::get`/`try_get`, i.e. only from a built `App`. So a `#[tokio::test]` in this file CANNOT call a `State`-taking command, and the plan's headline test (the ADR 0068 resolver pin) would be unwriteable here. Every existing test in `commands/agents.rs` works only because its commands take no `State`. Use the pattern the file already uses for exactly this reason — its `From<AgentDefinition> for AgentDefinitionDto` comment says "the mapping lives in a `From` impl (testable in isolation — the command body is a thin wrapper)":

        /// The pure core: everything the modal shows, from inputs the test owns.
        pub(crate) fn agent_config(
            settings: &Settings,
            defs: &[AgentDefinition],
            catalog: &ModelCatalog,
        ) -> Vec<AgentConfigDto>

        #[tauri::command]
        pub async fn list_agent_config(
            state: State<'_, Arc<SessionManager>>,
            cwd: Option<String>,
        ) -> Result<Vec<AgentConfigDto>, AgentsError>

   The wrapper is then `load_settings` + `effective_catalog` + `discover_agents` + one call to `agent_config` — nothing else, so there is no logic left untested.
   - `let settings = crate::config::load_settings(state.config_dir());`
   - `let catalog = state.effective_catalog(None).await;` (same accessor the `list_models` command uses). **Note for Task 5's hook comment:** unlike `list_skills` / `list_agent_definitions_for_space`, this is not a local disk walk — `effective_catalog` performs per-provider model discovery (a `GET /v1/models`), cached per provider. So this command can be network-bound, and it is called on every Space switch. Say so in the command's doc-comment; it is also why the hook's serve-`[]`-on-key-change rule matters more here than it does for skills.
   - `crate::agents::discover_agents(cwd.as_deref().map(Path::new))` — full set, NO mentionable-name filter, `shadowed` intact. `cwd: None` → user-level only, which is exactly what the deleted Settings section listed (`commands/agents.rs`'s own doc on `list_agent_definitions` documents the same rule); the modal with no Space open is the app-scope read.
   - For each definition: `resolve_agent_launch(&LaunchConfig::default(), def, &override_layer(Some(settings), &def.name), &catalog)`. Passing `&settings` into an `Option<&Settings>`-typed parameter is an E0308 — the `Some(...)` is not optional.
   - `override_` on the row holds the stored entry verbatim (not the resolver's output), so the modal can show "you pinned `tama/m-1`" beside "and the catalog can no longer resolve it, so this is what actually runs" — the stale case ADR 0023's soft degrade creates, and the one place the user can learn about it.
   - Sort deterministically by name (discovery already sorts — keep it).
   - Never fail on a bad file: discovery is total (the `discover_agents` contract), so the `Result` is for command-shape stability only. **The error type is `AgentsError`, not `String`** — `list_agent_definitions` returns `Result<_, AgentsError>`, and `AgentsError` has a hand-written `From<AgentsError> for tauri::ipc::InvokeError` that builds ADR 0063's `{kind, message}` envelope. A `String` error would drop this command off the ADR 0063 typed surface and off the frontend's `describeIpcError` rule-3 path.

4. `override_` and `effective` are DIFFERENT columns and neither is redundant: with ADR 0067's empty-is-absent rule and ADR 0023's soft degrade, a stored value legitimately has no effect, and the row has to be able to say both things at once.

**Steps:**
- [ ] Write the failing tests in `commands/agents.rs`, **against `agent_config` (the pure core)** — no `State`, no `async`, no runtime needed. That is what makes the pin below writeable at all. Use the file's existing `RestoreHome` + `env_lock` + `scratch()` pattern only for the tests that actually call `discover_agents` (HOME must be isolated because `user_roots()` reads the real `~/.agents/agents`); the pure-core tests build `AgentDefinition` / `ModelCatalog` fixtures directly and need none of that:
  - a space-level definition IS listed with `scope: "space"`, and a user-level one with `scope: "user"`;
  - **the ADR 0068 pin (the test that matters most) is the ONE pure-core test that needs the HOME world:** `resolve_launch` RE-DISCOVERS definitions from disk (`discover_agents(Some(space_cwd))`) rather than receiving them, so this test takes `RestoreHome` + `env_lock` + `scratch()`, writes `scout.md` into the scratch Space, calls `resolve_launch`, and then feeds **the definition it discovered** into `agent_config` — assert on the discovered value so the two sides can never be given different inputs. Compare `effective` + `source` from both; a new layer added to one and not the other must redden this;
  - an unmentionable name (`has space`) IS present here (unlike the `@`-mention picker);
  - **the `shadowed` report rides the winning row**: write `scout.md` in the scratch Space AND a different `scout.md` in the scratch HOME, and assert the Space row carries the user-level loser's `name` / `path` / `scope: "user"` — this is the collision the deleted Settings section structurally could NOT see, so this test is the feature's proof, not a bonus;
  - a definition with no collision serializes `shadowed: []`, not `null` and not an absent key (the `SkillInfo` precedent — the TypeScript side declares the field required, and says so in its own comment: "REQUIRED because the Rust DTO always serializes the `Vec` (empty as `[]`)");
  - `cwd: None` yields `scope: "user"` rows only, with `source` values drawn only from `override` / `file` / `parent`;
  - a stale pinned model reports the `source` of the layer that actually won, AND still shows the stale value in `override`;
  - an override `thinking` level the winning model does not advertise does NOT appear as `effective.thinking` with `source: "override"` (the Task 1 item 5 demotion) — use a fixture model that advertises levels, since `fake_model` advertises none;
  - `source` is never `space`, pinned by exhaustively matching the `OverrideSource` enum in one test — the compile error IS the pin if a fourth layer is ever added, which is the honest way to make "three layers" a fact rather than a comment.
- [ ] Run `cargo test --lib commands::agents` — expect red; implement; re-run to green.
- [ ] Register in `lib.rs` and run `cargo test` (full crate).
  - If the app-scope case returns nothing at all, check that `discover_agents(None)` is being reached rather than an empty-path root.
- [ ] Run `cargo clippy --all-targets -- -D warnings`, `cargo fmt`, `cargo fmt --all -- --check`.
- [ ] Commit: `feat(agents): resolve effective Agent config for the Agents modal`

**Acceptance criteria:**
- [ ] One command returns rows carrying `file` / `override` / `effective` / `source` / `path` / `scope` / `shadowed`, computed by the dispatch's own resolver.
- [ ] The command and `resolve_launch` agree on identical inputs — asserted by a test that calls both.
- [ ] The shadowing report CARRIES on the DTO (Task 5 renders it as text on the winning row, never as its own rows — ADR 0065).
- [ ] `list_agent_definitions` and `list_agent_definitions_for_space` are unchanged and their tests still pass.

---

### Task 3: REMOVE Settings → Agents

**Parallel:** Task 1 — disjoint file sets, no import either way, and each verifies from its own root (see *Parallelisation*).

**Context:**

The Settings section is **deleted**, not renamed. The sidebar **Agents** modal is the single Agent surface, and it edits the same global config from the Space rail. Two surfaces editing one global config is precisely the confusion this feature was asked to remove — and a checkbox per row saying "this is a per-Space override" was considered and rejected as a new confusion of its own. With no per-Space layer there is nothing left for the Settings section to own that the modal cannot do better: the modal additionally sees the active Space's definitions and the shadowing report.

This task deletes the surface **before** Task 4 changes the wire type. That order is deliberate and measured: with the section present, removing `AppSettings.subagentModels` reddens `tsc` in 9 files and leaves 23 errors still standing after the first wave of fixes; with the section deleted first it reddens in 8 and the residual is one file's remap block. Task 4 carries both measurements.

Deleting a surface also moves its guarantees — they do not disappear with it. Three things must survive the deletion:

- **The orphan row + remove button.** `SubagentSection.tsx`'s `orphanedSubagentModels` is ADR 0023's ONLY cleanup path ("no Rust-side cleanup — the Settings UI's remove button is the only cleanup path"). It moves to the modal in Task 5, and ADR 0023 is amended in this commit to name the new location (its decision still holds; only the affordance's address moves — which is why it is amended and not superseded).
- **The orphan behaviour tests.** `an_orphaned_override_renders_with_a_remove_button` and `a_case_variant_key_is_not_treated_as_an_orphan` in `SettingsPage.test.tsx` are PORTED to `AgentsDialog.test.tsx` — the file that will own the behaviour — not deleted. They go red here and green in Task 5, so land them with Task 5's commit or the suite is red in between; the steps below say exactly where.
- **The `list_agent_definitions` command stays.** It is registered in `lib.rs`, tested in Rust, and `SettingsPage.tsx` is its only frontend consumer — deleting the consumer does not retire a command another surface may want. Only the TypeScript wrapper is at risk, and it is NOT at risk: `src/lib/tauri.ts`'s `listAgentDefinitions()` is the one place a future surface would reach for. It becomes unreferenced from `src/` outside tests — acceptable, and `noUnusedLocals` cannot see an exported function, so it will not redden the build.

**Files:**
- Delete: `src/components/settings/SubagentSection.tsx` (150 lines)
- Modify: `src/components/settings/SettingsPage.tsx`
- Modify: `src/components/settings/SettingsPage.test.tsx`
- Modify: `docs/decisions/0023-subagent-model-overrides-in-settings.md` (the amendment — see item 6)
- Test: `src/components/settings/SettingsPage.test.tsx`

**What to implement:**

1. Delete `SubagentSection.tsx`. Its `foldAscii` helper is NOT deleted with it in spirit: Task 5 re-implements it in the shared editor module, and the comment explaining WHY a Unicode `toLowerCase()` is wrong (it folds non-ASCII pairs the backend's `eq_ignore_ascii_case` ignores — `SubagentSection.tsx:10-13` and the `a_non_ascii_case_variant_key_is_not_matched` test) must travel with it. Copy that comment into the new file, do not paraphrase it.
2. In `SettingsPage.tsx`, account for every hit — grep `subagent` and `Subagent` in the file and classify each one before touching it:
   - the `import SubagentSection` line and the `<SubagentSection …>` use inside `const subagentsSection = (…)`;
   - the `Section` union member `"subagents"`, the `section === "subagents"` comparison, `setSection("subagents")`, the `subagentsSection` variable, the `subagentsSection` render arm, and the `label="Subagents"` nav entry (which carries `icon={BotIcon}` — the icon moves to the sidebar button in Task 5, so remove the import only if nothing else in the file uses it; `BotIcon` is used by nothing else here, so it goes);
   - the module-level doc-comment listing the sections;
   - **NOT in bounds:** `subagentDeadBoundSecs` (a different feature's field), and anything naming a **Subagent session**. If a hit reads like a session, leave it.
3. The `agentDefs` state and its `listAgentDefinitions()` mount fetch GO WITH THE SECTION — nothing else in the file reads them (`agentDefs` is passed to the deleted section and nowhere else). So does the `useState<AgentDefinitionDto[] | null>` and, if it becomes unused, the `AgentDefinitionDto` / `listAgentDefinitions` imports (`noUnusedLocals` is on — an unused import is a build error, not a lint suggestion).
4. The provider-rename remap (`remappedSubagentModels`, inside the id-rename handler) stays — it protects `settings.subagentModels`, which still exists and still resolves at dispatch time, and ADR 0066 keeps that duty alive with ONE map to walk. It is re-pointed at `agentOverrides` in Task 4, in the same commit as the type swap. Do not delete it here: silently dropping the remap would orphan overrides on every Provider rename, which is the exact harm it exists to prevent. Rename the local to something honest (`remappedOverrides` with a `TEMPORARY: Task 4 re-points this at agentOverrides` marker) so the grep in Task 4 finds it.
5. `SettingsPage.test.tsx`: delete the `describe("SettingsPage (the Subagents section — ADR 0023)", …)` block — its 9 tests are section tests, and the two the modal inherits are ported per the Context. Then account for the rest:
   - `go()`'s section union parameter (`"Appearance" | "Providers" | "Subagents" | "MCP" | "Web search"`) and its `else if (section === "Subagents") return;` branch — drop the member; the 9 `go("Subagents")` calls all live inside the deleted block, so they go with it;
   - the ordered nav-label `toEqual([...])` list ("the Updates nav button is in the sidebar, after MCP") — drop `"Subagents"`;
   - the `baseSettings` fixture's `subagentModels: {}` line stays for now — the field still exists on `AppSettings` until Task 4;
   - **and drop the now-unused `listAgentDefinitions` from the file's `@/lib/tauri` import list.** This is not cosmetic: the mock and its `mockResolvedValueOnce` fixtures are the only things that referenced it, so leaving the import is a `TS6133` build error under `noUnusedLocals` (measured — it is one of the three Task-4-wave errors that are really this task's residue). Same for any `AgentDefinitionDto` type import the deleted block was the only reader of.
   - `renders_the_three_sections_and_the_back_button` does not name Subagents, so it is untouched.
6. **Amend ADR 0023 in this commit**, so the ADR is never false while the code is. Its consequence line reads "no Rust-side cleanup (the Settings UI's remove button is the only cleanup path)"; the removal of the section makes the parenthetical false, so the parenthetical names the sidebar **Agents** modal instead. Do NOT set `superseded-by` — the decision (overrides live in the desktop settings, not the agent files; soft degrade; orphans inert, no Rust-side cleanup) all still holds; only the location of the cleanup affordance moves, and `superseded-by` means "this decision was replaced", which would send a reader looking for a replacement decision that does not exist.

**Steps:**
- [ ] Run `pnpm test src/components/settings/SettingsPage.test.tsx` and note the baseline (all green).
- [ ] Port the two orphan tests FIRST, as a red pair in their future home: copy `an_orphaned_override_renders_with_a_remove_button` and `a_case_variant_key_is_not_treated_as_an_orphan` into `src/components/AgentsDialog.test.tsx` — a file this branch creates in Task 5. **Commit them with Task 5, not here** (Task 5 owns the component they drive); record here that they were ported by writing the deletion of the originals in this task's diff and saying in the commit message which two names moved and where they landed, so the pair is traceable across two commits. Do not silently drop them: an orphaned override with no remove button is ADR 0023's cleanup path going missing.
- [ ] Implement items 1-5.
- [ ] Run `pnpm test src/components/settings/SettingsPage.test.tsx` — green with the block gone (the section's 9 tests are deleted, and the ported 2 are Task 5's to make pass).
- [ ] Run `pnpm test` — the whole frontend suite green. Any failure naming `SubagentSection` is a dangling import, not a regression.
- [ ] **Verify no `Subagent session` surface moved.** `grep -rn "Subagents" src/` on `main` matches 321 lines of which 297 are `useSubagents` — the **Subagent session** store this task must NOT touch — and the remaining 24 are otherwise easy to bury. After this task the non-`useSubagents` hits must be zero in `src/components/settings/`. Separately confirm `SubagentDelegatingCard` / `SubagentTranscript` / `SubagentModals` / `usePendingSubagentRequests` are byte-identical (`git diff --stat` should not list them). And leave `harness/dispatch.rs`'s `"…still open in the Subagents panel."` user-facing string (plus its coupled assertion) alone — it names the **Subagent session** transcript panel, not this catalog.
- [ ] Amend ADR 0023 (item 6) in the same commit as the code that makes the old wording false.
- [ ] Commit: `feat(agents): remove Settings → Agents — the sidebar modal is the single Agent surface`

**Acceptance criteria:**
- [ ] Settings has no Agents/Subagents nav entry, no section, and no import; the nav list test reads without `"Subagents"`.
- [ ] No `Subagent session` surface changed — its tests pass unmodified.
- [ ] `list_agent_definitions` (Rust) is still registered and its tests still pass.
- [ ] ADR 0023 is amended and NOT superseded, naming the sidebar Agents modal as the cleanup path.
- [ ] The two orphan tests are accounted for: deleted here, ported in Task 5, and named in both commit messages.

---

### Task 4: The wire types and the `AppSettings.subagentModels` → `agentOverrides` swap

**Parallel:** none — Task 5 imports both the types and the wrapper this task adds (gate 2), the types must mirror Task 1's Serde names (so it follows Task 1, not its wave), and it assumes Task 3 has already deleted the section that reads the field being removed.

**Context:**

The renderer needs the new command's row shape and `settings.json`'s new override shape as TypeScript types, plus a one-line `invoke` wrapper. Two rules from the codebase apply:

- `src/lib/tauri.ts` is the single wire surface; every wrapper is a one-line `invoke<T>("command_name", { args })`.
- `src/lib/tauri.test.ts` exists **specifically** to pin the wire contract — its header comment explains that hook tests mock the wrapper, so only this file can catch a renamed command or a re-typed argument key. It must be extended, or a drift passes every test on both sides and fails only at runtime in the app.

`AppSettings.subagentModels` is REMOVED here. That is safe because Task 1 folds the legacy key inside `load_settings` on every read, so the backend never emits it and never needs to receive it.

**The blast radius, measured — not guessed.** Verified by running the pinned `tsc` against the real `src/` tree (each wave a fresh run, not arithmetic):

| Situation | Wave 1 | After fixing wave 1 |
|---|---|---|
| Property removed, nothing else touched (**the old plan's 35 / 9 files reproduces exactly**) | **35 errors / 9 files** | — |
| Section kept ALIVE with the old plan's `TEMPORARY(shim)` edits (its order) | **30 errors / 9 files** | **23 errors / 3 files** — still 16 in `SettingsPage.test.tsx`, 6 in the shimmed `SubagentSection.tsx` |
| Task 3's deletion landed first (**this plan's order**) | **17 errors / 8 files** | **7 errors / 1 file**, all inside `SettingsPage.tsx`'s remap block |

So the old plan's number is true and worth keeping — and what Task 3's deletion buys is that the *residual* stops being a component edit and becomes one file's remap block. Of Task 4's 17: **12 name `subagentModels`** — the typed fixtures (`SettingsPage.test.tsx` ×3 — `baseSettings`, the Provider-rename fixture, and its `saved.subagentModels` assertion — plus `lib/settings.test.ts` ×2, and one each in `store/settings.test.ts`, `ChatStream.test.tsx`, `MessageBubble.codeblock.test.tsx`, `WebSearchSection.test.tsx`, `useAttentionAlert.test.ts`) and the Provider-rename remap block in `SettingsPage.tsx` (2 direct + 2 `unknown` inference cascades). **The other 3 belong to Task 3, not here** — an unused `listAgentDefinitions` import in each of the two settings files plus the `agentDefs` binding its fetch fed. They showed up in my measurement because I emulated Task 3 with the imports left in place; done properly (Task 3 item 5) they never reach Task 4, and if they DO show up here that means Task 3 left them behind — fix Task 3's commit, do not absorb them silently.

**Keep the two-wave warning, because the mechanism is real and it still bites:** the first run does not show everything. Fixing a fixture literal changes what an inference site resolves to, and emptying a block can make an import unused (`TS6133`, which `noUnusedLocals` makes a build error, not a lint) — measured above: 17 → 7, and in the other order 30 → 23. Budget for a second run and a third; never read the first run's count as the total.

**And keep the invisible-fixtures warning.** Two of the settings fixtures live inside hoisted `vi.mock` factories — `src/App.test.tsx`'s and `src/components/SpacesList.test.tsx`'s `getSettings` mocks — where the object literal is untyped, so **`tsc` cannot see them at all** (confirmed: neither file appears in either `tsc` run above, and both contain a `subagentModels` line). They surface later as `undefined` at runtime, and Task 5 is where they would hurt. Add `agentOverrides` to both by hand in this task and say in the commit message that it is done on trust.

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/tauri.test.ts`
- Modify (the typed fixtures `tsc` reports — `subagentModels` → `agentOverrides`): `src/components/settings/SettingsPage.test.tsx`, `src/lib/settings.test.ts`, `src/store/settings.test.ts`, `src/components/settings/WebSearchSection.test.tsx`, `src/hooks/useAttentionAlert.test.ts`, `src/components/MessageBubble.codeblock.test.tsx`, `src/components/ChatStream.test.tsx`
- Modify (the invisible fixtures): `src/App.test.tsx`, `src/components/SpacesList.test.tsx`
- Modify: `src/components/settings/SettingsPage.tsx` (the Provider-rename remap re-pointed at `agentOverrides`)
- Test: `src/lib/tauri.test.ts`

**What to implement:**

1. Add the types next to the existing `AgentDefinitionDto` (`tauri.ts:611`):

        /** One agent's override (ADR 0066: `settings.json`'s `agentOverrides[<name>]`). An ABSENT field means "this override does not speak" (ADR 0067) — never send `null` to mean inherit. */
        export interface AgentOverride {
          model?: string;
          thinking?: string;
          tools?: string[];
        }

        /** `settings.json`'s `agentOverrides` (ADR 0066): agent name → override. One global map — there is NO per-Space map, and keys are matched case-insensitively by the backend. */
        export type AgentOverrides = Record<string, AgentOverride>;

        /** Which layer supplied a field. `parent` = nothing below the explicit `subagent` param spoke (ADR 0068) — a dispatch that passes the param still overrides it. */
        export type OverrideSource = "override" | "file" | "parent";

        export interface AgentOverrideFields {
          model: string | null;
          thinking: string | null;
          tools: string[] | null;
        }

        export interface AgentOverrideSources {
          model: OverrideSource;
          thinking: OverrideSource;
          tools: OverrideSource;
        }

        /** One row of `list_agent_config` (camelCase over IPC — the Rust `AgentConfigDto`). */
        export interface AgentConfigDto {
          name: string;
          description: string;
          scope: "space" | "user";
          /** The DEFINITION FILE's path. */
          path: string;
          file: AgentOverrideFields;
          override: AgentOverrideFields;
          effective: AgentOverrideFields;
          source: AgentOverrideSources;
          /** The entries this name EXCLUDED by shadowing (ADR 0065) — a REPORT
           *  rendered on this row, never a row of its own. REQUIRED, not optional:
           *  the Rust DTO always serializes the Vec (empty as `[]`), exactly like
           *  `SkillInfo.shadowed`, and `SkillsDialog`'s `?? []` tolerance is a
           *  defence for old rows, not a licence to omit it here. */
          shadowed: ShadowedAgent[];
        }

   `ShadowedAgent` is a new two-line interface beside the existing `ShadowedSkill` (`tauri.ts:630`) with the same three fields. Rust ships ONE generic shape for both (`Shadowed<T>`), so this is a NAME duplicate and not a shape duplicate: the TypeScript side names its wire types per surface (`SkillInfo`, `AgentDefinitionDto`), and reusing `ShadowedSkill` on an Agent row would make the file's own doc-comment ("One Skill excluded by shadowing") a lie. Two lines of structural duplicate is the cheaper lie.

2. In `AppSettings`, replace the `subagentModels: Record<string, string>` line (the `(ADR 0023)` doc-comment above it marks it) with:

        /** (ADR 0066) Global Agent overrides: agent name → override. Replaces `subagentModels`, whose legacy values the backend folds in on read. */
        agentOverrides: AgentOverrides;

   Required, not optional — and that is now backed by the store, not by hope: Task 1 deliberately gives `agent_overrides` `#[serde(default)]` WITHOUT `skip_serializing_if`, matching every other map field in `config.rs`, so the backend answers `"agentOverrides": {}` rather than omitting the key (see Task 1 item 1's note — that is the decision that makes a required TypeScript field safe). **The consequence for the fixtures:** every typed `AppSettings` fixture must gain `agentOverrides: {}` — that is the fixture half of the 17-error list above (seven files, ten errors, because `SettingsPage.test.tsx` carries three). `SettingsPage.tsx` also needs `AgentOverrides` in its `@/lib/tauri` import block once item 4 re-points the remap, or `tsc` reports `Cannot find name 'AgentOverrides'`.

3. Add the wrapper next to `listAgentDefinitions` / `listAgentDefinitionsForSpace` (`tauri.ts:861` / `tauri.ts:910` — same region):

        /** The effective Agent config for the Space's definitions — the sidebar Agents modal's data source (ADR 0068). `cwd: null` = app-scope (user-level definitions only; the override map is global and unaffected). */
        export async function listAgentConfig(
          cwd: string | null,
        ): Promise<AgentConfigDto[]> {
          return invoke<AgentConfigDto[]>("list_agent_config", {
            cwd: cwd ?? null,
          });
        }

   The argument key is `cwd`, matching the Rust parameter name exactly — and matching `listAgentDefinitionsForSpace`, which already invokes `list_agent_definitions_for_space` with `{ cwd: spacePath ?? null }`. `listSkills` shows the other half of the rule: its Rust parameter is `space_path` and the key is `spacePath`, because Tauri camelCases multi-word parameters. `cwd` is one word, so it stays `cwd`.

4. Re-point the Provider-rename remap at the new map: keep `remapModelRef` and `remapModelRefs`, and replace the `remappedSubagentModels` block with a pass over `agentOverrides` remapping each entry's `.model`. Keys are agent names, not model refs — do not touch them (the existing comment already says so). **Widen `remapModelRef` or handle the mismatch:** its signature is `(key: string | null, …)` but `AgentOverride.model` is `string | undefined`, so a straight walk will not type-check — widen the parameter to `string | null | undefined` (and its return to match), or map with `override.model === undefined ? undefined : remapModelRef(override.model, …) ?? override.model`. Drop the `TEMPORARY` marker Task 3 left when you land this.

**Steps:**
- [ ] In `src/lib/tauri.test.ts`, write the failing test first (follow the existing `invoke: vi.fn()` mock and the `listSpaceFiles`-style assertions):
      `listAgentConfig("/p/space")` calls `invoke` with `"list_agent_config"` and `{ cwd: "/p/space" }`;
      `listAgentConfig(null)` calls it with `{ cwd: null }` (NOT an omitted key — Tauri maps a missing `Option` the same way, but the explicit `null` is what the neighbouring wrappers do and what the pin exists to guarantee).
- [ ] Run `pnpm test src/lib/tauri.test.ts`.
  - Did it fail because the export or the command name is missing? If it passed already, stop — the module exports something you did not expect.
- [ ] Implement items 1-3 in `src/lib/tauri.ts`.
- [ ] Run `pnpm test src/lib/tauri.test.ts` — green.
- [ ] Run `pnpm build` (this is the type-check). Fix every error it reports, then run it AGAIN — the second wave is expected (see the Context) and is not a sign you broke something. `tsc` must end clean; acceptance requires a green build, so nothing may be "fixed later".
- [ ] **Expect one BEHAVIOURAL test rewrite, not a fixture swap** — the remap re-point changes what `save_settings` receives, and this test asserts the payload by name (verified red with the swap in place): `a_name_commit_reidentifies_the_provider_and_remaps_the_model_refs`, whose `expect(saved.subagentModels).toEqual({ scout: "another-name/m1" })` becomes `expect(saved.agentOverrides).toEqual({ scout: { model: "another-name/m1" } })`. That is the ONLY behaviour-bearing `subagentModels` assertion surviving Task 3 — the other three the old plan listed (`selecting_file_value_deletes_the_subagent_models_entry`, `an_orphaned_override_renders_with_a_remove_button`, `saving_drops_case_variant_twin_keys`) all lived in the deleted describe block, which is a second reason the delete-first order is cheaper. NEVER "fix" the surviving one by reverting `skip_serializing` in Task 1 or by re-adding the removed field.
- [ ] Add `agentOverrides` to the two `vi.mock` fixtures by hand (`App.test.tsx`, `SpacesList.test.tsx`) — untyped literals `tsc` cannot see.
- [ ] Run `pnpm test` — the whole frontend suite green.
- [ ] Commit: `feat(agents): wire types for global Agent overrides`

**Acceptance criteria:**
- [ ] `subagentModels` is gone from `AppSettings`; `agentOverrides` is present and required.
- [ ] `tauri.test.ts` pins the command name and the `cwd` argument key for both the Space and the app-scope call.
- [ ] `pnpm test` green; `pnpm build` green.
- [ ] No `TEMPORARY` marker from Task 3 survives: `grep -rn "TEMPORARY" src/components/settings/` prints nothing.
- [ ] The two `vi.mock`-fixture files had `agentOverrides` added **by hand and on trust**: their literals are untyped inside hoisted `vi.mock` factories, so `tsc` cannot catch the missing key, and nothing in this task's scope READS the key — `pnpm test` stays green without it. This is a correctness requirement for Task 5, not a gate here; do not claim this task verifies it.

---

### Task 5: The sidebar Agents modal, its shared editor, and the mount

**Parallel:** none — it modifies `SpacesList.tsx` / `SpacesList.test.tsx`, imports Task 4's types and wrapper (gate 2), and owns the orphan behaviour Task 3 freed.

**Context:**

One surface, mounted from the Space rail beside **Skills**. The modal lists the **Agent definitions** the ACTIVE Space can see — project-level rows plus the global ones — because `list_agent_config(cwd)` runs discovery with that `cwd`, and `cwd: None` returns user-level only (the documented `list_agent_definitions_for_space` rule, and exactly what the deleted Settings section listed). So the Space decides only **which definitions get LISTED**; the override map it edits is global and identical from every Space. That is what "one editing surface" means concretely, and it is why the modal needs no Space selector.

Per row: name, description, the `user`-scope cue on the global rows, then the three fields each labelled with the layer that supplied them — `override` / `file` / `Inherits parent`. Editing writes `agentOverrides[name]`.

Two honesty rules, both from decisions already made:
- ADR 0068: `source: "parent"` means "nothing below the explicit `subagent` param spoke". Label it `Inherits parent` and do NOT imply the child will certainly inherit — a dispatch that passes `model:` overrides the row.
- ADR 0067: with nothing ticked the tools row reads `Inherits parent tools` and writes NO key. An empty picker that reads "no tools" would be a lie users act on.

And one inherited duty: **the orphan rows and their remove button move here from Settings** — Task 3 deleted the only other place they existed, and ADR 0023's amended consequence names THIS modal as the cleanup path. Plus one new surface: the **shadowing report**, rendered as plain text on the winning row (never as its own row — ADR 0065: disclosed, not listed; a row's click would name a definition that resolves to the winner's file).

**Files:**
- Create: `src/lib/agentOverrides.ts` + `src/lib/agentOverrides.test.ts` (the shared editor: `foldAscii` + the set/delete-field helpers + the orphan selector — BOTH the modal and any future surface use it, so the write rules cannot drift)
- Create: `src/hooks/useAgentCatalog.ts` + `src/hooks/useAgentCatalog.test.ts`
- Create: `src/components/AgentsDialog.tsx` + `src/components/AgentsDialog.test.tsx`
- Modify: `src/components/SpacesList.tsx`
- Modify: `src/components/SpacesList.test.tsx`
- Test: `src/hooks/useAgentCatalog.test.ts`, `src/components/AgentsDialog.test.tsx`, `src/components/SpacesList.test.tsx`

**What to implement:**

1. `src/lib/agentOverrides.ts` — the shared editor, so the modal is the only surface today but not the only rule-set:

        /** Set one field on one agent's override, immutably. Drops every ASCII case-fold twin of the key (the backend's case-insensitive `.find` otherwise picks between twins in nondeterministic HashMap order — see `SubagentSection.tsx`'s deleted comment, copied here). */
        export function withOverride(
          map: AgentOverrides,
          name: string,
          field: keyof AgentOverride,
          value: string | string[] | undefined,
        ): AgentOverrides
        // `value === undefined` (or an empty array) DELETES the field; an entry left
        // with no fields is DELETED with it — ADR 0067, absence is the only meaning
        // of "this override does not speak". Never emit `null` for a field.

        /** The stored entries matching no discovered definition (ADR 0023's orphans).
         *  Gated by the caller on "the definitions have actually loaded": treating
         *  "not loaded yet" as "nothing discovered" would flash every override as a
         *  stale orphan with a live remove button. */
        export function orphanedOverrides(
          map: AgentOverrides,
          defs: readonly { name: string }[],
        ): string[]

   `foldAscii` lives HERE (ASCII-only — mirrors `eq_ignore_ascii_case`; a Unicode `toLowerCase()` would fold non-ASCII pairs the backend ignores, which is what `a_non_ascii_case_variant_key_is_not_matched` existed to pin).

2. `useAgentCatalog(spacePath: string | null): AgentConfigDto[]` — a deliberate copy of `src/hooks/useSkillCatalog.ts`; read it first, because its cache rules are load-bearing and documented in its own comments: a module-level `Map<string, Promise<T[]>>` keyed by `spacePath ?? "__global__"` so two components mounted in the same commit share ONE in-flight fetch; rows tracked TOGETHER with the key they were fetched for, so a Space switch serves `[]` immediately rather than the previous Space's rows; the LEFT key evicted on a key change so a file edited on disk is picked up when you come back; and a failed fetch that must NOT stay cached (delete only if this promise is still the cached entry). Copy all four behaviours. Export a test-only `clearAgentCatalogCache()` exactly as `useSkillCatalog` exports `clearSkillCatalogCache()`. **Do not copy `useSkillCatalog`'s comment verbatim:** it says discovery is a local disk walk with no loading state, and that is FALSE here — `list_agent_config` calls `effective_catalog`, which does per-provider model discovery (a `GET /v1/models`, cached per provider), so this fetch can be network-bound and slower. The serve-`[]`-on-key-change rule matters MORE here; say so in the hook's doc-comment.

3. `AgentsDialog` props — PROP-DRIVEN like `SkillsDialog` (no fetching inside; the fetch lives in the hook, so the dialog tests need no IPC mock):

        {
          rows: AgentConfigDto[];
          /** True while NO Space is open. This changes the COPY only — the override
           *  map is GLOBAL, so nothing is disabled: with no Space the rows are the
           *  user-level set, exactly what the deleted Settings section offered.
           *  (In the old per-Space plan this flag disabled every control, because
           *  there was no layer to write to without a Space. There is always one now.) */
          noSpaceOpen: boolean;
          settings: AppSettings | null;
          models: ModelDto[];
          tools: string[];
          onPatch: (next: AgentOverrides) => void;
          onClose: () => void;
        }

   - A search `Input` filtering by case-insensitive name substring (the `SkillsDialog` policy, stated in its own comment as name-only for v1).
   - Model control: the shared `ModelPicker` with `items` built by `modelItemsFromCatalog(...)`, fed the composed keys `provider + "/" + id` for every `ModelDto` (the exact call the deleted `SubagentSection` made in its `items` spread), plus an `{ value: "", name: "Inherits" }` item (**not** "leading" — `ModelPickerDialog` re-sorts items alphabetically by name and discards caller order (its own `.sort()`), so this row lands wherever "Inherits" sorts; the existing placeholder precedent was an `items` entry too), and the `staleOverride` rule for a pinned model no longer in the catalog (offer it as its own DISABLED item — Radix otherwise shows the placeholder and misrepresents the saved state).
   - Thinking control: a `Select` whose options are the union of `thinkingLevels` across `models`, deduped in first-seen order (`SettingsPage.tsx`'s `thinkingLevelUnion` memo — copy it, do not import it from the page), plus the stale-value rule applied to THIS ROW's `effective.thinking` when it is not in the union (the per-row analogue of `SettingsPage`'s `storedLevelOutsideUnion`), plus the `Inherits` item.
   - Tools control: the checkbox cluster shape from the "Enabled tools" cluster in `GeneralSection.tsx` (`input type="checkbox"` + an `aria-label` naming the tool — note the deleted section's cluster used `Enable tool ${name}` and the modal's is "tick this override", so pick the wording that says which, and keep it stable for the tests), one per name in `tools`, with the `Inherits` state being "no key written".
   - Writing: build immutably through `withOverride(settings.agentOverrides, row.name, field, value)` — never hand-assemble the spread in the component, because the case-fold-twin drop and the empty-entry deletion are the two things a hand-rolled spread gets wrong.
   - Orphans: `orphanedOverrides(settings.agentOverrides, rows)` renders at the bottom as muted text with a trash `Button` (`aria-label="Remove … override"`) — the exact shape the deleted `SubagentSection` used, and ADR 0023's only cleanup path. Gated on the rows having loaded (the helper's comment).
   - **Shadowing (ADR 0065):** `row.shadowed` renders as muted plain text UNDER its own winning row — each loser's name and path, with the cause clause naming the WINNER's scope rather than the loser's (the rule `SkillsDialog`'s `shadowGroups` comment earns: two roots per level and two user roots mean a `user` loser can lose to a `user` winner, so a clause keyed on the loser is false in shipped configurations). Filter the report by the SAME search needle the rows use, so the block can never contradict the list above it. NEVER a `Button`, never `role="row"`, never clickable: a row for a loser is a control that names a definition resolving to the winner's file. (The Skills dialog groups its report at the dialog's foot; this one sits under the row, because the Agent row already carries the winner's identity and the fact is per-name — the DISCLOSURE rule is what carries over, not the layout.)
   - `noSpaceOpen` → every row carries the copy `No Space open — showing your global Agent definitions`; the controls stay ENABLED (the override is global). Do not invent a disabled state that implies the settings are read-only; they are not.

4. Mount in `src/components/SpacesList.tsx`, mirroring the existing `Skills` affordance exactly. Read that file's own comments before editing — two of its boundaries are load-bearing and commented in place:
   - The dialogs render **outside** the content region. That region gets `visibility: hidden` while the pane is collapsed, and `visibility` INHERITS into `fixed` descendants — a dialog mounted inside it opens invisibly. The file's comment at the close of that region says exactly this about `SkillsDialog`; the Agents dialog has the same requirement.
   - The collapsed rail carries the commands as icons (`railActions`), because the buttons are inside the hidden region. Dropping `Agents` from `railActions` would give it a command that vanishes when the pane collapses — the defect that comment says the rail exists to prevent.

   Implementation:
   - `const [agentsOpen, setAgentsOpen] = useState(false);` beside `skillsOpen`; `const agentRows = useAgentCatalog(activeSpacePath);` beside `const skills = useSkillCatalog(activeSpacePath);`.
   - `const settings = useSettings((s) => s.settings);` — `useSettings` is already read by non-Settings components (`MessageBubble`, `SessionConfigSelect`, `ChatStream`), so this is not new plumbing, though `SpacesList.tsx` does not read it today.
   - `models`: `listModels()` once on mount into state (the `SettingsPage.tsx` pattern — `useState<ModelDto[]>([])` + `.catch(() => {})`); `tools`: `listTools()` once on mount, same pattern. Do not add a second cache.
   - A write helper — **read-modify-write, never composed from the store**: `const fresh = await getSettings(); const next = { ...fresh, agentOverrides };` then `saveSettings(next)`, and on success `useSettings.getState().setSettings(next)`. On failure, `console.error` and re-fetch with `getSettings()` into the store — the file must not drift from the UI. **This is the one new write path in the feature.** The re-read is load-bearing, not paranoia: the store's copy is seeded at boot and by the Settings page, but the Rust side writes `settings.json` on its own (`agent/session/mod.rs:1678` persists a remembered thinking level via `load_settings` + mutate + `write_settings`), so a modal opened at an arbitrary moment can be holding a stale document, and composing from the store would silently clobber a concurrent change. Every Rust writer does load-mutate-write; this must match. Say so in a comment.
   - Button: a fourth `<button type="button">` after the Skills button, `BotIcon` (moving here from the deleted Settings nav entry) + `<span className="flex-1 text-left">Agents</span>`, same classes (`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-ui-base hover:bg-surface-hover`). No `Kbd` (Skills has none).
   - `railActions`: a fourth entry `{ id: "agents", label: "Agents", icon: <BotIcon className="size-4" />, onClick: () => setAgentsOpen(true) }` after `skills`. **This deliberately widens an existing pin:** `SpacesList.test.tsx`'s `offers the pane's three commands as icons while collapsed (not Settings)` asserts the rail `toHaveLength(3)` and iterates `["Open Space", "New Session", "Skills"]` — update it to 4 with `Agents` appended, **rename the test too** (leaving "three" in the name after the change is a lie in the suite), and say in the commit message that this is an intentional widening, NOT a broken feature. (Deleting the rail entry to go green is the exact defect the `railActions` comment exists to prevent.) `SessionRail.test.tsx` derives its count from `actions.length` and is unaffected — leave it. Separately, the collapse-bleed test iterating `["Open Space", "New Session", "Skills", "Sessions", "Archived"]` is `if (node)`-guarded so nothing breaks, but **add `Agents`** — that test is what proves the new button does not bleed into the 40px sliver.
   - Render OUTSIDE the content region, beside the `skillsOpen` block, guarded `{agentsOpen && settings && (<AgentsDialog … />)}`, passing `noSpaceOpen={activeSpacePath === null}`. The `settings &&` guard is why the button stays clickable but the dialog waits: with `settings === null` there is nothing correct to edit.

**Steps:**
- [ ] Write `useAgentCatalog.test.ts` first — port the cases from `useSkillCatalog.test.ts` (one fetch for two components mounted in the same commit; a key change serves `[]` immediately; the left key is evicted so a re-visit re-fetches; a failed fetch degrades to `[]` and is retried). Mock the `listAgentConfig` wrapper, matching that file's style.
- [ ] Run `pnpm test src/hooks/useAgentCatalog.test.ts` — red (no module).
- [ ] Implement `useAgentCatalog.ts`; re-run to green.
- [ ] Write `agentOverrides.test.ts` (or cover it through the dialog — but the case-fold drop and the delete-the-empty-entry rule are each worth a direct test, since both were pinned by tests in the deleted Settings file).
- [ ] Write `AgentsDialog.test.tsx` (prop-driven, no IPC mock — follow `SkillsDialog.test.tsx`'s local `skill(overrides)` / `shadow(overrides)` factory pattern; build a `row(overrides): AgentConfigDto` factory rather than expanding literals by hand):
      `user`-scope rows carry the global cue, `space`-scope rows do not;
      each field prints its source label (`override` / `file` / `Inherits parent`);
      picking a model calls `onPatch` with `{ [name]: { model } }`, leaving every other entry untouched;
      picking `Inherits` DELETES the key (assert the key is ABSENT — not `null`, not `undefined`-valued-in-JSON);
      clearing the last field removes the agent entry entirely;
      unticking every tool renders `Inherits parent tools` and writes NO tools key;
      a pinned model missing from `models` renders as a disabled item, not as the placeholder;
      **the orphan block (ported from `SettingsPage.test.tsx`):** `an_orphaned_override_renders_with_a_remove_button` — an `agentOverrides` entry matching no row renders muted with a working remove button that saves the map without it — and `a_case_variant_key_is_not_treated_as_an_orphan` — `"Ghost"` beside a discovered `ghost` is NOT an orphan;
      an ASCII-case twin key (`"Scout"` beside `scout`) is dropped on write, and a NON-ASCII variant is NOT folded (the pair the deleted file pinned);
      **the shadowing report:** a row with `shadowed` renders the loser's name and path as text and NO additional button or row carries the loser's name (`queryByRole("button", { name: <loser> })` is null) — ADR 0065's "disclosed, not listed" pinned as an absence assertion;
      `noSpaceOpen` still allows editing and states that the rows are the global set.
- [ ] Run `pnpm test src/components/AgentsDialog.test.tsx` — red, then implement, then green.
- [ ] Write the failing tests in `SpacesList.test.tsx` (follow that file's existing mount helpers and its `listSkills` mock; add mocks for `list_agent_config`, `list_models`, `list_tools`, `save_settings` — AND seed the settings store: `SpacesList.tsx` does not read `useSettings` today and `SpacesList.test.tsx` never populates it (only `main.tsx`'s boot path does), so with the `settings &&` gate the dialog renders in NO test, and the failure reads as "the button is broken" rather than "the store is empty". Add `useSettings.getState().setSettings(fixture)` in `beforeEach` (the pattern `ChatStream.test.tsx` already uses) — and add `agentOverrides: {}` to this file's existing `getSettings` mock fixture if Task 4 did not: its literal is untyped inside a hoisted `vi.mock` factory, so `tsc` cannot catch the missing key and `AgentsDialog` would throw reading `settings.agentOverrides`):
      an `Agents` button exists, and clicking it opens the dialog — **assert with `screen.getByRole("dialog")`, never a text query**: the pane now holds BOTH a button labelled `Agents` and a `DialogTitle` reading `Agents`, so `findByText("Agents")` matches two nodes (this exact hazard is documented for `Skills` in that file);
      the collapsed rail's `Agents` icon also opens it — render collapsed and click the icon;
      **structural** render-site pin, not a `visibility` one: assert the dialog node is NOT a descendant of the pane's container. Do NOT write this as a jsdom `visibility` test — `SkillsDialog`/`AgentsDialog` render through `DialogPortal`, which moves content to `document.body`, so the node is never a DOM descendant of the hidden region in ANY configuration and a `painted()`-style ancestor walk cannot distinguish the two render sites (it would pass even with the bug present). Say in the test comment that the `visibility` argument is structural, and that the Portal is why jsdom cannot demonstrate it behaviourally;
      picking a model in the open dialog calls `save_settings` with `agentOverrides` holding `{ [name]: { model } }` and every other settings field preserved — and the mocked `getSettings` is called again before the save (the read-modify-write).
- [ ] Run `pnpm test src/components/SpacesList.test.tsx` — red, then implement, then green.
- [ ] Run `pnpm test` and `pnpm build`.
- [ ] Manual check if a dev build is available: `pnpm tauri dev`, open a Space, click Agents, pin a model, then open a DIFFERENT Space and confirm the same override shows on the shared definition. That is the only end-to-end proof of the one property this round swapped per-Space to get — the map is global, so a Space cannot hold a different answer. If no dev build, say so in the PR body rather than claiming it.
- [ ] Commit: `feat(agents): the sidebar Agents modal as the single Agent surface`

**Acceptance criteria:**
- [ ] `Agents` opens the modal from both the expanded buttons and the collapsed rail, and the modal renders while the pane is collapsed (not swallowed by the content region's `visibility: hidden`).
- [ ] Every field shows its value AND its source layer; editing touches only `agentOverrides`.
- [ ] "Clear" means the key is ABSENT everywhere (no `null` on the wire) — ADR 0067.
- [ ] The orphan rows and their remove button work here — ADR 0023's amended cleanup path.
- [ ] The shadowing report renders as text on the winning row and never as its own row — ADR 0065.
- [ ] An edit persists `agentOverrides` through `save_settings` and leaves every other settings field byte-identical.
- [ ] `CONTEXT.md` describes `agentOverrides` and the modal, not `subagentModels` and the Settings section.

---

## Final verification (AGENTS.md — all must be green)

From the repo root: `pnpm test`, `pnpm build`.
From `src-tauri/`: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check` — CI's exact spellings.

## Docs sweep (after Task 5 — the change makes these stale)

`grep -rn "subagentModels" src-tauri/src src --include=*.rs --include=*.ts --include=*.tsx` (excluding tests) — known-stale after this change: `harness/loop.rs` ("reads the `subagentModels` override"), `worker/manager/mod.rs` ("already folded into `launch.model`"), the `harness/launch.rs` header comment, `commands/agents.rs`'s module doc ("the Settings page's Subagents section — ADR 0023" — Task 2 already touched this file, so fix it there and note the second pass here), `ModelPickerDialog.tsx`'s note naming `subagentModels`, and the **CONTEXT.md Worker process entry** (it names the "Subagent model override" map as one of the three things the Worker reads from `settings.json`). **Leave alone:** `harness/dispatch.rs`'s `"…still open in the Subagents panel."` user-facing string (and its coupled assertion) — it names the **Subagent session** transcript panel, not this catalog.

Then `CONTEXT.md`: rewrite the **Subagent model override** entry as **Agent override** (the flat `agentOverrides`, three fields, absence = inherit, global), fold its `_Avoid_` list into the **Agents** entry so one concept holds one entry, and update the **Worker process** entry's list of what the Worker reads from the store file.

## Out of scope

- Per-Space overrides — ADR 0066's *Deferred: per-Space* records the shape it would take and the door it walks back through (a `spaces` sibling + a second load-time fold on the machinery Task 1 writes). Nothing here blocks it.
- A repo-committed project layer (`<space>/.archimedes/agents.json`) — ADR 0066 records it as the eventual MCP-shaped layer; adding it later is a new layer in `resolve_agent_launch`, not a re-shape.
- Zero tools from any override (ADR 0067), overriding a system prompt, and any per-Session override.
- The composer's `@`-mention picker and Skills — untouched. Widening `list_agent_definitions_for_space` is explicitly ruled out (Task 2).
