---
status: accepted
date: 2026-11-01
superseded-by:
---

# Per-provider request headers are resolved at provider CONSTRUCTION time, never carried on `Model` / `ModelCatalog`

Custom headers — the `$VAR`/`${VAR}`-expanded `ProviderConfig.headers` map — reach the wire only as
**`build_provider_with_headers` (`agent/harness/provider/mod.rs:109`) at the moment a provider is
constructed**, resolved from `settings.json` through the constructor's already-available config dir. They are
**never** a carried field on `Model` or `ModelCatalog`. Every session start (`default_build_loop`,
`worker/core.rs:246`) and every mid-session model switch (`AgentLoop::set_model`, `harness/loop.rs:661`)
re-resolves the header map from disk rather than inheriting a spawn-time snapshot. This is R1 of the
LiteLLM-connection-suite run (interface contract §10; branch `feature/litellm-connection-suite`, landed at
`f7ddc878` + `eb81b107`, the run's first halves needed this decision before they could ship a completion
wire).

**Why it is an ADR now:** it is the one architectural decision of that run that outlives the feature and is
not discovery/wire-related — the credential store, OAuth/OIDC/ADC, budget, and the discovery work are all
recorded against their own artifacts (`docs/features/litellm-provider-connections.md`, ADR 0026), but the
carrier question is a data-shape rule any future per-provider setting will inherit. The source record (the
roadmap family, untracked and deleted on ship) is gone; this is now the durable home of R1's precedent,
reasoning, and measured alternatives.

## The decision

1. **Custom headers are resolved at provider-construction time.** Both production construction sites call
   `build_provider_with_headers`, which looks the row's expanded header map up through
   `provider_headers_for(dir, &model)`; the map is a parameter, never a `Model` field and never a
   `ModelCatalog` field. The completion wire therefore gets headers from the same settings row the discovery
   spine reads (the map is produced once, at the resolve spine — the "expanded map" T2a's `apply_custom_headers`
   computed — and the construction sites re-derive it from the config dir).
2. **A mid-session model switch re-resolves — it never inherits a spawn-time snapshot.** `AgentLoop` already
   stored `config_dir: Option<PathBuf>` (`harness/loop.rs:446` — field + constructor; `worker/core.rs` passes
   `Some(env.config_dir)` to the loop), which is what makes this cheap: `set_model` re-reads
   `settings.json` through the already-stored dir (`loop.rs:661`) and rebuilds with the CURRENT map — `None`
   dir → `None` headers → byte-identical to the old `build_provider(&model)`. So a header edit between spawn
   and a model switch is picked up; `config_dir: None` stays byte-identical to pre-feature behavior.
3. **Bearer tokens are NOT part of this.** Dynamic credentials still ride on `Model.api_key` (substituted at
   `EffectiveCatalog::resolve`, interface §1) and are refreshed Supervisor-side via
   `refresh_live_credentials` (`session/mod.rs:2229`). Only the STATIC custom header map takes the
   construction-time path. Expansions still happen inside the Worker for that map (same process
   environment), and the construction-time resolution explicitly does NOT re-run the async
   `validate_base_url` gate (it belongs to the discovery spine; `set_model` is sync) — `provider_headers_for`
   is deliberately `pub(crate)`.

## Considered Options

- **A field on `Model`.** Rejected. **Measured 72 `Model {` literal sites across 20+ files**, most outside
  any single task's set. It would also break the Worker protocol: the Worker already receives a snapshot
  (`StartEnv.model` / `Inbound::Config`), and a carried field would either add a wire field or a
  re-resolution the Worker cannot do (it has no per-turn settings read).
- **A field on `ModelCatalog`.** Rejected. **Measured 37 outer-exhaustive `ModelCatalog {` literals**
  (re-counted by symbol with a brace-matched parser after the first count of ~80 occurrences proved
  understated; **20 sit inside the changing task's own files — 18 in `session/mod.rs`, 2 in
  `catalog.rs`** — and **17 in unowned files**). The catalog is the discovery cache; carrying per-provider
  header state on it would break every provider-modal test that constructs a catalog literal (the modal
  tests build `ModelCatalog { … }` exhaustively, so a new field is a compile error across the suite — which
  is exactly why the 37-literal census was load-bearing: the catalog carrier is not "a few touch-ups", it is
  a suite-wide exhaustive-construction break).
- **A per-session push à la `refresh_live_credentials` (push the header map to live sessions on settings
  save).** Rejected — wrong shape for three reasons: headers are not a `Model` field, so there is nothing to
  push to; the wireless settings flow (save writes the file, nothing pushes for `base_url`/`api_key` either —
  `docs/features/model-selection.md`'s known-consequence #4) would have to grow a whole push channel; and it
  cannot reach the **resolve-before-spawn** discovery path (headers must be on the wire when `/model/info` is
  read by `discover_models`, before any session exists to push to).
- **The `ProviderFactory` seam alone (a config-dir-closing factory, no loop change).** Considered and
  REJECTED for the `set_model` path specifically — a factory closing over the config dir does NOT reach
  `set_model` for free, because the loop had no dir to close over until the `config_dir` field was already
  there. In the end `set_model` re-resolves via the already-stored `config_dir` (no new field, no factory
  hand-off); the factory seam remains for the `default_build_loop` path. This is the mechanism that made the
  cheap landing possible and is recorded so nobody "simplifies" it back into a carried snapshot.

## Consequences

- **Both construction sites re-resolve, so a mid-session model switch re-reads the settings row.** Pinned by
  `set_model_reapplies_custom_headers_after_a_switch` (`harness/loop/tests/provider_switch.rs:167`), which
  is **mutation-checked**: reverting `set_model` to a plain `build_provider(&model)` (dropping the
  re-resolution) fails the test on the SECOND turn — the first turn proves the initial provider was built
  with headers, the second proves the switch re-resolved rather than inheriting or dropping them. It is also
  trustworthy against a stale snapshot by construction: the assert runs with a template whose expansion
  happens INSIDE the second turn's re-lookup.
- **A header edit between spawn and switch is picked up; a header edit after the switch is not pushed to a
  running session.** This is the same boundary as ADR 0026's "live sessions keep their wire" — the wire and
  the headers are both bound to the provider instance at construction, and neither is pushed mid-session by
  `refresh_live_models` (which copies only the window/thinking fields — plus the `refresh_live_credentials`
  sibling for the bearer). The Settings Refresh affordance reaches live sessions via
  `refresh_live_models`' `force_refresh` arm, and that push deliberately preserves the session's own
  `base_url`/`api_key`; for the same reason a header re-read needs a model switch or a new session. Enlarging
  the refresh gate to carry changed headers is the recorded follow-up, not this ADR's behavior.
- **`config_dir: None` (bare loop constructions in tests) is byte-identical to pre-feature
  `build_provider`** (`provider/mod.rs:56`'s comment records the same for the normalize half) — the `None`
  branch is the old body verbatim. This is what keeps the modal/catalog tests and `build_loop_with_db`
  fixtures green without a headers parameter everywhere.
- **`build_client` is the single client-construction seam for all three wires** — the `custom_headers` param
  append happens once, in stable order (`transport.rs`), and every wire client's `with_custom_headers` path
  routes through it; openai's `with_custom_headers` uses a private `AtomicBool` latch to forbid a literal
  rebuild. A future wire inherits headers by calling through the seam, not by re-implementing it.
- **The discovery spine and the construction sites share ONE expanded map source** (`headers::expand_map`),
  so a header typed in Settings is byte-identical on discovery, completion, and budget polls — the 
  `refresh_model_metadata` parity requirement that T2a wired is the direct consequence (the map is derived
  once per settings row load, not re-derived per wire).

## Honesty about what this ADR could not check

- **The census figures are the run's measurements, quoted with attribution** — the interface contract's §10
  recorded the first `Model`/`ModelCatalog` counts at the planning round; the 37-`ModelCatalog`-literal
  number is the status file's brace-matched re-count at `eb81b107` time (the interface's own "80
  occurrences / six exhaustive literals in unowned files" framing is noted there as understating the
  outermost-exhaustive count). A grep today yields different absolute numbers (the tree moved through 10
  waves) — the load-bearing fact is the ORDER of magnitude and that 17 of the 37 sat in unowned files, which
  is why the carrier was rejected WITHOUT re-measuring at each wave.
- **No test measured in this ADR was executed to write it.** The mutation-check claim ("fails on the second
  turn") is the changelog's recorded observation of the run's own test runs at `eb81b107`, and the test is
  read as source here, not run.
- **This ADR does not restate ADR 0026's amendments** (discovery ladder / per-model wire / normalization /
  quirks) — those are discovery-and-wire concerns owned by that ADR's two dated blocks. The cross-reference
  to its "live sessions keep their wire" boundary is a pointer, not a re-derivation.
- **Windows headers were never behaviourally verified** — the `#[cfg(windows)]` code in the store type-checks
  locally and runs only on CI's windows leg (AGENTS.md's rule); no Windows runtime observation exists for the
  header path either, and none is claimed.