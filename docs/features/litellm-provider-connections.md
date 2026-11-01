---
status: live
last-verified: 2026-11-01
verified-by: every claim below read against this tree at `8bac7ed0` (the branch head and the run's final gate) and against the roadmap family `docs/roadmap/litellm-connection-suite-{interface,status}.md` BEFORE they are deleted on ship — this file is the durable copy of that family's rulings. Commit hashes cited are the ten WAVE commits of `feature/litellm-connection-suite` — the squash-mergeable commits, not per-issue hashes (AGENTS.md's squash-orphan trap). Not executed for this record: no `cargo`, no `pnpm`, no script.
---

# LiteLLM provider connections (credential store, OAuth/OIDC/ADC, key helpers, headers, discovery, budget)

The branch `feature/litellm-connection-suite` (issues #125–#133) shipped dynamic-credential support for
LiteLLM-proxy-backed providers: a credential store, key-helper `!command` execution, custom headers with
`$VAR` expansion, an insecure-HTTP gate, OAuth 2.1 PKCE + DCR, CLI SSO, direct OIDC, Google ADC, a discovery
fallback ladder, per-model wire derivation, and budget/quota polling. This file is the **durable** record: it
survives the ship that deletes the `docs/roadmap/litellm-connection-suite-*` family, which was untracked and
unrecoverable. If you are touching any of this, read it before concluding that a carrier, a precedence, or a
gate is safe to change — several of the rules below are exactly the ones a well-meaning future change would
break.

The four architectural rulings R1–R9 that do not live in ADR 0026 are recorded here (§2–§5). **ADR 0026's
amendments are NOT restated** — discovery ladder, per-model wire, base-URL normalization, and the two vendor
quirks are the property of `docs/decisions/0026-litellm-api-mode.md` (amended 2026-11-01 twice); read that ADR
for them. What is here is everything the ADR does not own.

## 1. What shipped — one line per capability, with its wave commit

All ten are the squash-mergeable wave commits of this branch (one per wave, in order; the branch is linear
`5ab3adc5..8bac7ed0`):

| Wave | Commit | Shipped |
|---|---|---|
| 1 (T1, #125) | `3868641d` | Credential store (`provider_auth/store.rs` — `provider-auth.json`, 0600-at-creation, stage-then-rename), the resolution dispatcher (`resolve_bearer` / `resolve_bearer_at`, `provider_auth/mod.rs:88/:112`), the Supervisor refresh loop (`SupervisorRefresher`), `auth_mode` on `ProviderConfig`, `refresh_live_credentials` (`session/mod.rs:2229` — the sibling of `refresh_live_models`, which stays byte-identical) |
| 2 (T2a, #129) | `f7ddc878` | Key-helper `!command` execution (`provider_auth/key_helper.rs` — no shell, 7-step ordered contract), `$VAR`/`${VAR}` expansion (`provider_auth/headers.rs`), the insecure-HTTP gate, custom headers on the DISCOVERY wire + `refresh_model_metadata` header parity, `execute_helpers` threading through `resolve` |
| 3 (T2b, #129) | `eb81b107` | **R1 delivered** — custom headers on the COMPLETION wire: `build_client`'s `custom_headers` param, `build_provider_with_headers` (`provider/mod.rs:109`), `provider_headers_for`, `with_custom_headers` on all three wires, both construction sites (`default_build_loop`, `set_model`) |
| 4 (T3a, #130) | `42f96b3e` | Discovery fallback ladder (`/model/info` → `/v1/models` → `/v1/model/info` → `/health` gate + per-id probe) + conservative multi-deployment grouping (`reduce_litellm_route`, `derive_wire_for_route` — `catalog.rs:1004/:1035`) |
| 5 (T3b, #131) | `af8d8643` | Per-model wire derivation at the resolve seam, base-URL normalization helper (strip applied, **append deliberately not** — §3), the two vendor quirks (GPT-5.5+ `reasoning_effort`-with-tools suppression; Anthropic prompt caching) |
| 6 (T4, #128) | `823d7ed3` | Google ADC (`provider_auth/gcloud.rs`) — discovery (env file only), `authorized_user`-only validation, native exchange, 50-minute in-memory cache, **never written to disk** |
| 7 (T5, #126) | `3123d673` | OAuth 2.1 PKCE + RFC 7591 DCR (`provider_auth/litellm_oauth.rs`), CLI SSO device flow + pasted token (`provider_auth/cli_sso.rs`), the callback fix (constant-time `state` + additive `bind_with`, `mcp/callback.rs:58/:196`), **R8 fixed here** (§2), the login command surface |
| 8 (T6, #127) | `7ebd3497` | Direct OIDC (`provider_auth/oidc.rs`) — IdP discovery **without gateway headers**, claims validation (iss/aud/azp/exp/nonce/sub), `sub`-consistency-on-refresh, the additive `ProviderCredential::Oidc` variant, three additive `SettingsError` variants |
| 9 (T7, #132) | `314ab2bf` | Budget/quota polling (`provider_auth/budget.rs`) — `/key/info`, `/v2/user/info`, `/team/info`, `DenialMemory`, `classify_status`, `run_budget_tick` (a BODY the loop calls; no new `tokio::time::interval`), the `ProviderBudgetDto*` DTO + `get_provider_budget` (`commands/settings.rs:519`) |
| 10 (T8, #126/#127/#132 UI) | `8bac7ed0` | The settings UI — `ProviderAuthSection.tsx` (auth-mode select, Sign-in, device-flow panel, team-choice panel, paste-token, headers/`allowInsecureHttp`/`oidc` editors) + the SettingsPage spend/budget line; **the six command wrappers that make `check-commands.sh` green** |

Final gate at `8bac7ed0`: `cargo test` 2079 / 0 failed / 30 binaries · clippy 0 · fmt clean · `pnpm test`
166 files / 3413 passed | 1 skipped · `pnpm build` green · **all ten `scripts` CI jobs PASS**, including
`check-commands.sh` (52 registered / 51 consumed / 1 cited pre-existing exemption). (The roadmap status file's
Gate section records an earlier baseline at `5ab3adc5`: 1785 passed / 24 binaries — do not read those as the
post-run numbers.)

## 2. The auth dispatcher's precedence rules — the ones a future contributor will otherwise break

`resolve_bearer` (`provider_auth/mod.rs`) is the single place a `ProviderConfig` row becomes an effective
bearer. Its dispatch order is **fixed** (interface §4 — earlier arms must not be reordered; each arm's comment
says so). The three rules:

- **An explicit `auth_mode` BEATS an inferred `!`-key prefix (R8, `mod.rs:172`).** The `!`-key helper arm's
  guard is `provider.auth_mode == "api_key" && provider.api_key.starts_with('!')` — narrowed, by T5 at
  `3123d673`, from the `_`-guard T2a had landed in T1's placeholder slot. Why the narrowing is load-bearing,
  and what the `_`-guard did wrong: a `_`-guard matches ANY `auth_mode`, so a row carrying BOTH a
  `!`-prefixed `api_key` AND `authMode: "oauth"` silently took the key-helper arm and **ignored its stored
  OAuth token**. The R8 fix keeps the interface's documented precedence (explicit mode beats inferred prefix)
  WITHOUT reordering the match (the arm stays in T1's landed slot). Pinned by
  `a_row_with_a_bang_key_and_oauth_mode_serves_the_stored_token` and its helper-side twin, both in
  `tests/provider_oauth_flow.rs` (confirmed RED before the change). T6 at `7ebd3497` re-pinned the same
  precedence for `authMode: "oidc"` and must not re-widen the guard. **Owned consequence:** a row with an
  UNRECOGNISED auth mode + a `!`-key now serves the static key instead of running the helper — the permissive
  boundary's own rule (validate at use); absent `authMode` is unaffected (serde defaults it to `"api_key"`).

- **Arm 1 (ADC) is an EARLY RETURN above the match, because an in-match arm cannot fall through and would
  silently kill the other arms.** `gcloud_token_auth_enabled(provider)` gates an `if let` that RETURNS on a
  token and otherwise falls through to the match (`provider_auth/mod.rs`, the block above
  `match provider.auth_mode.as_str()`). Interface §4's slot order says ADC is asked FIRST, not that it is the
  only thing asked: a row with both `useGcloudTokenAuth` and a `!`-key keeps its helper when the ADC file is
  absent. Written as an early return because a `match` arm has no fall-through — an in-match arm would have
  silently killed the key-helper and stored-oauth arms for a row carrying both. (The plan's
  `if got.is_some()` fall-through is unrepresentable in a `match`; the loop's own measured reasoning.)

- **A helper/refresh failure DEGRADES to the static key — never blanks, never `Err`.** The dispatcher's
  contract is `Option<String>`, where `None` means "use the row's static `api_key` as-is" (`provider_auth/mod.rs:88`'s
  doc-comment: a failed fetch is not an answer, so it must not overwrite a good cached credential — mirroring
  `ProviderDiscovery`'s `succeeded` discipline). The key-helper arm degrades on `Err` with a `debuglog` line
  (never an `Err` at the boundary); the ADC flow degrades on any failure the same way; internal refresh arms
  serve the stored token when the refresh fails. **Do not "fix" this to propagate an `Err`** — blanking a
  working key breaks a live conversation, and an `Err` would make the Worker face an unresolvable bearer where
  the static key is the agreed fallback.

## 3. R9 — the per-wire base-URL append is deliberately NOT applied. Do not "fix" it.

`normalize_wire_base_url(base_url, api)` (`provider/anthropic.rs:102`, re-exported at
`provider/mod.rs:22`) has TWO halves: a **strip** (for Messages, remove a trailing `/v1`) and an **append**
(`{root}/v1` for Completions/Responses). T3b at `af8d8643` applied the strip at both construction sites
(`build_provider` and `build_provider_with_headers` — `provider/mod.rs:46/:121`) and deliberately left the
append implemented-and-unit-tested but **unapplied**. That is R9's ruling (interface §10), on the record so
nobody re-litigates it:

- `ProviderConfig.base_url`'s own doc is *"Normalized base URL (…/v1)"* (`config.rs:37`) — the Settings
  convention is that configured bases ALREADY end in `/v1`. Appending `/v1` yields `/v1/v1`.
- The completion client appends `/chat/completions` to the base verbatim (`openai.rs:716`); the responses
  client appends `/responses` verbatim (`responses.rs:704`). For a `/v1`-terminated base they already hit the
  right path; the append would only ever move them wrong.
- The strip IS load-bearing (the Messages client appends `/v1/messages`, so a `/v1` base must be stripped to
  avoid `/v1/v1/messages`) — that is the half that is applied.
- Applying the append would move the paths `tests/provider_headers.rs` (T2b) and `tests/worker_e2e.rs` mount
  against a bare-root `server.uri()`, breaking the byte-identity invariant T3b's own acceptance ranks above
  the spec line.

Consequently: `normalize_wire_base_url`'s append branch (`api != AnthropicMessages`) is exercised **only by
its own unit tests**, never by `build_provider`. That is intentional, not dead code to remove — it documents
the rule and keeps the helper total. **The single most likely well-meaning future regression is someone
"fixing" this by wiring the append in at the construction sites.** If a future provider genuinely needs
`{root}/v1` completion paths, that is a new ruling with its own fixture migrations — not a silent application
of the existing branch. (ADR 0026's amendment records the same for its own `normalize` discussion; the R9
ruling here is the decision.)

## 4. The FastAPI snake_case trap — a general rule for ANY future LiteLLM endpoint

LiteLLM is a Python FastAPI proxy, so its inbound wire keys are snake_case (`login_id` / `poll_secret` /
`max_budget` / `contract_version`). A `#[serde(rename_all = "camelCase")]` on an **inbound parse type**
parses the wiremock fixture (if the mock is also snake_case) and silently yields `None` facts — or 400s —
against a real proxy. This was hit **independently by two waves**:

- **T5 at `3123d673`:** the plan's `rename_all = "camelCase"` on `DeviceSession`/`CliAuthMetadata`
  contradicted its own §11 primary sources (a Python FastAPI proxy emits `login_id`/`poll_secret`/
  `contract_version`, snake_case) — camelCase would parse the mock and 400 against a real proxy. camelCase
  kept for **our IPC DTOs only**, both pinned.
- **T7 at `314ab2bf`:** the plan's `camelCase` on `KeyInfoResponse` etc. again — the landed code
  (`budget.rs:218`, on the `KeyInfoResponse` struct) documents it: `max_budget` would only match a
  `maxBudget` key, silently producing `None` facts for a perfectly readable endpoint.

**The rule:** inbound LiteLLM parse types carry the field names as the wire spells them (snake_case), with
`#[serde(alias = "camelCase")]` aliases where the proxy might camelCase; `rename_all = "camelCase"` belongs
on OUR outbound IPC DTOs only (e.g. `commands::settings::ProviderBudgetDto`). Any future LiteLLM endpoint
inherits this rule from the two `budget.rs` / `cli_sso.rs` precedents.

## 5. The `ProviderCredential` extension point — what adding a variant costs

`ProviderCredential` (`provider_auth/store.rs`, `#[serde(tag = "type")]`) is T1's deliberate **compile-error
extension point**: the `match` in `refresh::refresh_credential` is EXHAUSTIVE by design, so adding a variant
is a compile error, not a silent no-op — that is T4/T5/T6's extension seam (T6 added `Oidc` this way). The
cost is real and reaches OUTSIDE the adding task's file set (measured at `7ebd3497`'s changelog entry):

- **~4 irrefutable-`let` bindings** redden: `refresh.rs`'s `let ProviderCredential::OAuth(next) = &refreshed
  else { … }` (a panic-arm, `refresh.rs:1274`) plus 2 in `tests/provider_oauth_flow.rs` (`:329`, `:1153`) —
  the two T5 test fixtures the adding task does not own;
- **~10 `ProviderConfig` literals** across files the adding task may not own (T6 had to touch T5's test file
  to stay green).

So a future variant is mechanical but touches sibling files — plan for it. Also note the T1-landed units: the
`OAuthCredential.expires_at` is epoch **MILLISECONDS** (unlike `mcp::oauth::StoredAuth`'s SECONDS — do not
"unify" them; a silent unit swap across the two stores is the kind of bug that reads as a green suite), and
the store lives in the **DATA** dir (`dirs::data_dir()/archimedes/provider-auth.json`, `store.rs:152`'s
`auth_file_path` — beside `mcp-auth.json`, ADR 0018; R3's ruling), never a literal `~/.archimedes`.

Budget polling deliberately added **no** third `ProviderCredential` variant (polling state ≠ credential), so
nothing reddened at T7 — a useful data point on the boundary.

## 6. The gate — and the wave gate that missed the sixth command

A wave is **not** green on AGENTS.md's five commands alone. CI's `scripts` job
(`.github/workflows/ci.yml` ~:380-447) runs ten shell checks, including `check-versions.sh`,
**`check-commands.sh`** (every `generate_handler!` entry has a real `invoke("…")` consumer),
`check-temp-dir-census.sh --self-test`, `check-test-data-dir.test.sh`, plus the `*.test.sh` premise suites
(`check-versions.test.sh`, `check-temp-dir-census.test.sh`, `check-commands.sh --self-test`,
`compose-updater-manifest.test.sh`, `check-release-signatures.test.sh`, `release-notes.test.sh`).

Honest record of this run: **`check-commands.sh` stayed RED for five waves** (T5 `3123d673` through T7
`314ab2bf`) because the wave gate omitted the `scripts` job — six registered IPC commands
(`provider_login_oauth`, `provider_login_oidc`, `provider_login_sso_poll`, `provider_login_sso_choose_team`,
`provider_login_paste_token`, `get_provider_budget`) had no consumer until the frontend half (T8) landed.
The gate itself was CORRECT (the Rust half shipped in waves 5–7, the frontend half in wave 10). It was fixed
at `8bac7ed0` by **consuming** the six commands — 52 registered / 51 consumed / 1 cited pre-existing
exemption — script unedited.

**The fix is a consumer, never an `allowlist_entries` exemption** (`scripts/check-commands.sh:71`). An
exemption permanently hides the dead-IPC surface the guard exists to catch — the exact "Finding 8" failure
mode (two IPC commands shipped with nobody calling them, because nothing in the build asked whether the half
of a `generate_handler!` entry that matters — that someone invokes it — holds). The allowlist's own contract
(`check-commands.sh:64-71`) requires a cited reason; a reason-less empty entry is a refusal.

**Root cause, named:** AGENTS.md's own **Build & Testing** table omits the `scripts` job — its five rows
(`pnpm test`, `pnpm build`, `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check`) are the exact
five the wave gate used. **Recommended one-line addition to that table's "What" column** (do it in a touch;
this doc does not edit AGENTS.md): a row for `bash scripts/check-commands.sh` (or the whole ten-check
`scripts` job) with "repo root". The condition "a wave is not green without it" was re-learned at the cost of
five red waves; the table should not make the next reader re-learn it.

## 7. Load-timed flake family — four named members, re-run before investigating

All four are green in isolation and green on re-run, in files the failing wave had not touched. **Re-run
once before investigating; do not edit them to pass.**

1. `mcp::http::tests::http_bearer_prefix_on_the_wire_for_a_static_header_spec` (`mcp/http.rs:1196`) —
   connection-refused on its mock; hit at T1's first integrated run; file byte-untouched by T1.
2. `mcp::http::tests::http_sse_response_round_trip` (`mcp/http.rs:553`) — connection-refused flake hit at
   T3b's first run (file untouched by T3b); passed in isolation + rerun — the THIRD named member of the
   "mock/server not ready" family.
3. `worker_e2e`'s real-worker dispatch tests (e.g. `subagent_dispatch_end_to_end_real_workers`,
   `tests/worker_e2e.rs:1099`) — a real-worker spawn that settles before its output rendezvous, surfacing
   as `"the subagent settled with no output"`. **AGENTS.md documents this one with five prior observations
   and two OSes — match on the TEST NAME, never the line number** (`:1287` and `:1314` were both observed;
   the assertion's line moves with the file). Cite `gh run view <id>`-style run IDs, never the head SHAs —
   four of the five observations are unreachable from `main` (squash-orphan trap).
4. The macOS temp-dir census guard (the `check-temp-dir-census`-wrapped `cargo test` step) — usually a
   **consequence** of #3, not a second bug: a killed-or-abandoned real-worker spawn leaves its temp dir
   behind, so a red guard on a run that also failed the `worker_e2e` test is one incident, not two. Read the
   pair together before going looking for a new leak (AGENTS.md names the same mechanism; two of the five
   `worker_e2e` observations also tripped the guard in the same job).

The status file's Gate section calls the first three "members of the same 'mock/server not ready' family
plus the documented real-worker one" — the family predates this feature and none of its members was touched
by it.

## 8. What is deliberately NOT restated here

- **ADR 0026's amendments** (discovery ladder + grouping; per-model wire derivation + base-URL normalization
  + the two vendor quirks) — read `docs/decisions/0026-litellm-api-mode.md` (amended 2026-11-01 twice), which
  owns them and is edited by BOTH T3a and T3b across serial waves.
- **The interface-contract file-shape details** (module layout, store wire format, `refresh_live_credentials`
  signature, refresh-loop start path, the `tauri::async_runtime` singleton for production) — the roadmap's
  Decisions log is the record; the durable claims here are the ones a future contributor will otherwise
  break (precedence, R9, snake_case, the extension point cost, the gate).
- **Per-wave test counts and plan-bug play-by-plays** — the roadmap status file's Changelog holds them; they
  are not durable rules.

## Honest limits

- The roadmap family was consumed as the authority for the rulings (R1–R9, the precedence, the gate finding)
  and every claim it makes that this file repeats was RE-READ against the tree at `8bac7ed0` — the
  `mod.rs` precedence (`:172`-era guard), the `config.rs:37` doc, the `set_model` re-lookup
  (`loop.rs:661`), the snake_case structs (`budget.rs`, `cli_sso.rs`), the `let … else` binding sites, the
  `check-commands.sh` allowlist contract, and the CI `scripts` job. Where tree and record disagreed the tree
  won; no discrepancy was found.
- The gate numbers are `8bac7ed0`'s, re-measured by the run (final row of the status file); the `5ab3adc5`
  baseline is quoted as historical.
- Nothing here was executed for this record: no `cargo`, no `pnpm`, no shell script ran. Test names and
  line numbers are read as source, not run.