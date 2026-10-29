# Task 03 — `mcp` proxy tool: server-prefixed tool names (`<server>_<tool>`) (#118)

Grounding: `docs/roadmap/agent-permission-and-pins-ground-mcp.md` (HEAD `2b6bd26`). This plan implements the orchestrator's decisions verbatim; it does not re-open them.

Goal: the native `mcp` proxy tool accepts the server-prefixed name forms (`<server>_<tool>` and `mcp__<server>__<tool>`), `search` prints the callable prefixed form so the model never has to invent a spelling, a wrong prefix fails with a hint naming the likely correct tool, and raw-name calls plus the `server` disambiguation are byte-for-byte unchanged.

## Files (the only files this task edits)

- `src-tauri/src/agent/mcp/tool.rs` — modify: `resolve_prefixed` / `is_prefix_shaped` / `suggest_prefixed` / `prefixed_miss` helpers, the `call tool` and `describe` arms, the `search` line + filter, and the new tests.
- `src-tauri/src/agent/mcp/manager.rs`, `config.rs`, `types.rs` — **not touched**. The resolver enumerates the held names the existing way: `McpManager::server_names()` (`manager.rs:130-132`), the same call `unknown_server_scope` already makes.
- `src-tauri/src/agent/harness/tool_specs.rs` — modify: the `mcp` tool's **workflow lines only** (keep the `server` param description byte-identical — see Step 5).
- `docs/features/mcp-known-gaps.md` — modify: record the decision + residual limitation in the house format (Step 6).

## Decisions to implement (from the orchestrator — not re-openable)

1. Canonical display form is `<server>_<tool>`; **both** `<server>_<tool>` and `mcp__<server>__<tool>` are accepted on input.
2. Resolution matches against **known server names by longest-prefix match — never a split on the first `_`** (server and tool names may each contain `_` / `-`; `github_enterprise_get_issue` → server `github_enterprise`, tool `get_issue`).
3. The existing ambiguity rule (a raw-name tie requires `server`) stays as is.
4. #118's "a prefixed-name miss is an error" is **layered onto** #68's partial-set rule, not a replacement: `miss_result` keeps its exact semantics for raw names; the new prefixed-miss failure additionally composes the `Skipped servers:` note.

## Design (resolver shape, for the implementer — no re-derivation needed)

**Precedence (both `tool` and `describe`, and only when no `server` param is present — with a `server` param the name is raw, exactly as today):**

1. **Prefix tier** — if the name is prefix-shaped (`name.contains('_')` — the separator gate) and `resolve_prefixed(name, &manager.server_names())` returns `Some((s, tool))`, the prefix wins by construction (`github_echo` means server `github`'s `echo`, even if a literal `github_echo` raw tool exists elsewhere — the decided precedence). Commit only when the pair `(s, tool)` is present in the collected `all.tools`; if `s` is a known server but does not serve `tool`, return a **prefixed miss**: `fail(Tool not found: {name} — server '{s}' does not serve '{tool}'{suggestion})` with the skip note scoped to `Some(s)` (`scoped_skipped(&all.skipped, Some(s))`). A resolved prefix yields exactly the pair `(s, tool)`, and that pair is what the **dispatch** uses: the call passes the **RAW `tool` name** — `manager.call_tool(&s, &tool, …)` receives `echo`, never the prefixed string `a_echo` (Step 3), and `describe`'s schema lookup matches the raw `tool` against `all.tools`. This raw forwarding is precisely what #118's acceptance means by "resolve to the same tool as the raw name"; it is also the only way the Step 1 assertions can hold — `bin/fake_mcp_stdio.rs`'s `tools/call` arm matches the literal names `echo` / `hang` / `err` and echoes the caller's `text` argument back, so a call carrying `a_echo` falls to its `_` arm and replies `unknown tool` (`text == "x"` could never hold).
2. **Raw tier** — the existing exact raw-name filter, unchanged bytes: `matches.is_empty()` → `miss_result` (a **success** when every in-scope server answered — pinned by `a_plain_not_found_is_still_a_success_when_every_server_answered`); `matches.len() == 1` → the sole owner; `> 1` → the `ambiguous` failure.
3. **Miss tier** — after the raw filter finds nothing: if the name is *not* prefix-shaped → `miss_result(...)` (unchanged, success on an all-healthy set); if it *is* prefix-shaped → **`prefixed_miss`** — a FAILED `ToolResult` even when every server answered, naming the likely correct spelling when a served tool is a `_`-suffix of the name, else the known servers.

The separator gate (`contains('_')` / the `mcp__` marker) is what keeps the raw-name #68 bytes intact: `nope` and `echo` never enter the prefix tiers. Raw `_`-bearing tool names that match no known server prefix (e.g. `get_item` with servers `a`/`github`) fall to the raw tier and work exactly as before.

**Ambiguity-rule trap (must not be bypassed):** the `matches.len() > 1` arm is reached only from the raw tier, which only prefix-shaped-failures and non-`_` names reach — a resolved prefix names ONE server by construction and never enters it. Step 1's prefixed-call test (two servers both serving `echo`) pins that a prefixed call succeeds without producing `ambiguous`.

**Helper signatures** (module-level, above `mcp_tool`, unit-testable pure functions):

```rust
/// True when `name` could be a prefixed spelling at all (carries `_`, or the
/// `mcp__` marker). The #68-boundary gate: non-prefix-shaped misses keep the
/// old `miss_result` success bytes. (`mcp__…` names always contain `_`.)
fn is_prefix_shaped(name: &str) -> bool;

/// Longest-prefix decomposition against KNOWN server names, accepting both
/// `<server>_<tool>` and (after stripping the `mcp__` marker)
/// `mcp__<server>__<tool>` (the latter joins with `__`). Never splits on the
/// first `_`. Returns `Some((server, raw_tool))` only when the tool part is
/// non-empty and the server is a longest known prefix.
fn resolve_prefixed<'a>(name: &'a str, known: &[String]) -> Option<(&'a str, &'a str)>;

/// The likely-correct prefixed spelling when the prefix named no known server:
/// for `atlassian_getJiraIssue` over a server serving `getJiraIssue` →
/// `Some("github_getJiraIssue")` (the LONGEST served-tool `_`-suffix wins);
/// `None` when no served tool is a suffix. `_echo`-style empty prefixes never
/// suggest.
fn suggest_prefixed(name: &str, tools: &[(String, super::types::ToolInfo)]) -> Option<String>;

/// The #118 failed-miss shape, with #68 layered on: ALWAYS a failure
/// (`fail(...)`), plus the `Skipped servers: …` note when the scoped skipped
/// set is non-empty (reuses `skipped_note`, so the note's bytes stay the ones
/// `the_skipped_note_matches_the_issue_example` pins). The base message has no
/// trailing period so the note appends cleanly.
fn prefixed_miss(message: String, skipped: &[(String, String)]) -> ToolResult;
```

Suggested miss wording (implementer may refine, keeping the pinned substrings — see Step 1 tests): `Tool not found: {name} — no MCP server is named '{prefix-part}'; did you mean {likely}?` when `suggest_prefixed` matches, else `Tool not found: {name} — no MCP server is named '{prefix-part}' (servers: {joined})` modeled on `unknown_server_scope`'s candidate-list wording. Only the test-pinned substrings are contract.

**Search integration:** the `search` line becomes the callable form `[{s}] {s}_{t.name} — {desc}` (one pinned expectation updates: `search_finds_the_tool` → `[a] a_echo — echo its text argument`), and the search filter additionally matches the prefixed spelling (`{s}_{t.name}` lowercased contains the query) so a model copying `a_echo` out of a listing can `search` it back. `search`'s miss bytes (`No tools matching "…"` + the #68 note) are unchanged. The `server`-list path (`{name}: {desc}`) and the `describe` success header (`{name} ({s})`, showing the name **as given** — `a_echo (a)` for the prefixed form) stay as they are; raw `describe: "echo"` still answers `echo (a)`.

## Steps (serial — one change at a time, TDD)

### Step 1 — RED: write the new tests in `tool.rs`

Add to the `tests` module (reusing `manager_with`, `fake_bin`, `narrow_server`, `text`; no fixture changes — `fake_mcp_stdio`'s canned set and `--tools=` seam already cover every name this task needs). These assertions are truthful so long as the dispatch forwards the RAW tool name — `fake_mcp_stdio`'s `tools/call` matches only the literal names `echo` / `hang` / `err` (everything else errors `unknown tool`), so a prefixed call must arrive there as `echo` for `text == "x"` to hold (see Design §1):

- `a_prefixed_tool_name_calls_the_servers_tool` — `{ "a": "fake", "b": "fake" }` (both serve `echo`): `{ "tool": "a_echo", "args": { "text": "x" } }` → `!is_error`, `text == "x"`, and the result does **not** contain `ambiguous` (the two-server setup pins that a resolved prefix skips the raw ambiguity arm); then the alias form `{ "tool": "mcp__a__echo", "args": { "text": "y" } }` → `"y"`.
- `a_prefixed_describe_shows_the_schema` — `{ "a": "fake" }`: `{ "describe": "a_echo" }` → `!is_error`, text contains `a_echo (a)`, `"type": "object"`, `"text"`.
- `a_server_name_containing_an_underscore_resolves_by_longest_prefix` — `{ "github": narrow_server(), "github_enterprise": "fake" }` (`narrow_server` serves only `only_here`): `{ "tool": "github_enterprise_echo", "args": { "text": "x" } }` → `!is_error`, `text == "x"`. A first-`_` split would resolve `github` + `enterprise_echo`, whose pair is absent → a prefixed-miss failure; success therefore pins longest-prefix matching.
- `a_wrong_prefix_is_a_failed_miss_naming_the_likely_tool` — `{ "a": "fake" }`: `{ "tool": "atlassian_echo" }` → `is_error` (all-healthy but STILL a failure — the #118 layering), text contains `atlassian_echo` and `a_echo`; the same for `{ "describe": "atlassian_echo" }` → `is_error`, contains `a_echo`.
- Optionally 1–2 plain `#[test]` unit tests for `resolve_prefixed` (empty-remainder rejection like `a_`, `mcp__` stripping, no-`_` name → `None`) — recommended, keeps the pure core cheaply pinned.

Check: `cd src-tauri && cargo test --lib agent::mcp::tool` → RED. **Stub the three helpers first so this red is an ASSERTIONS-red, not a compile error** — the resolver functions do not exist yet, so the tests above (and the two recommended `resolve_prefixed` unit tests) would not compile otherwise. Add the module-level stubs before running: `is_prefix_shaped(name) -> name.contains('_')`, `resolve_prefixed(..) -> None`, `suggest_prefixed(..) -> None` (plus a vacuous `prefixed_miss(message, skipped) -> miss_result(message, skipped)` if a test touches it). Against the stubs: the call-side test takes the non-prefix raw path and FAILS the assertion `text == "x"` (`a_echo`/`mcp__a__echo` reach the fixture as-is and get `unknown tool` — the honest red), the describe test FAILS on `a_echo (a)`, and the wrong-prefix test FAILS on `is_error` (a stub miss is a success) — all runtime assertion failures, proving the atomic red is assertion-level and Step 2's green is real.

### Step 2 — GREEN (pure core): implement the four helpers

Add `is_prefix_shaped`, `resolve_prefixed`, `suggest_prefixed`, `prefixed_miss` as module-level functions above `mcp_tool` with the signatures above. `resolve_prefixed` strips an optional leading `mcp__`, then longest-prefix-matches each known server name with a `{server}_` prefix and (for the `mcp__` form) strips one further leading `_` from the tool; ties cannot occur (distinct names of equal length cannot prefix each other) so a strict longest-wins comparison suffices. All four reuse only existing pieces (`skipped_note`, `fail`) — no manager changes.

Check: the resolver unit tests go green; `cargo test --lib agent::mcp::tool` still shows the four integration tests red (not yet wired).

### Step 3 — GREEN: wire the `call tool` arm

In `if let Some(t) = &tool` (`tool.rs:441-494`): leave the `Some(s) => (s.clone(), t.clone())` arm **byte-identical** (a `server` param forces the raw reading — the `server` disambiguation, `an_ambiguous_tool_name_requires_the_server_param`'s second half, and every scoped test keep their behavior). In the `None` arm, after `collect_tools`, insert the prefix tier (see Design) **before** the raw filter; the raw filter, `miss_result`, and the `ambiguous` arm stay byte-for-byte on the non-prefix path.

Check: `a_prefixed_tool_name_calls_the_servers_tool` and the underscore test go green. Confirm the #68 boundary tests still pass individually: `a_plain_not_found_is_still_a_success_when_every_server_answered`, `a_skipped_server_fails_the_bare_call_and_names_it`, `the_is_error_mapping_is_a_failed_tool_result`, `an_ambiguous_tool_name_requires_the_server_param`, `a_call_on_a_healthy_server_is_not_broken_by_a_skipped_one`.

### Step 4 — GREEN: wire `describe` and `search`

- `describe` arm (`tool.rs:383-412`): when `server.is_none()` and `resolve_prefixed` yields a pair present in `all.tools`, answer the describe success with the name **as given** (header `{name} ({s})`, e.g. `a_echo (a)`) over the existing schema bytes; when the prefix is known but the pair is absent → `prefixed_miss` (skips scoped to `Some(s)`); when prefix-shaped-but-unresolvable → `prefixed_miss` with the suggestion. When a `server` param is present, or the name is not prefix-shaped, the existing `.find(...)` + `miss_result` path is untouched.
- `search` arm (`tool.rs:346-381`): print the callable form and match the prefixed spelling (see Design; both additions are inside the existing `format!`/filter closures, no new params). The filter change is purely additive: it matches the query against `{s}_{t.name}` lowercased **in addition to** the existing raw-name and description checks, which are byte-untouched — the raw-name check still matches `t.name == "echo"` against a query `echo`, so `echo` still finds the tool `echo` (now printed `[a] a_echo — …`) exactly as before. `in_scope(server.as_deref(), s)` still gates every match, unchanged. Note: this addition extends the filter's match set only for `_`-bearing queries, and **no existing test pins the filter's match set for `_`-queries** — the pinned expectations (`search_finds_the_tool`'s single result line, `search_no_match`) use `echo`/`zzz`, so only `search_finds_the_tool`'s printed form changes.

Check: the prefixed-describe test and `a_wrong_prefix_…` go green (both call and describe halves). Update `search_finds_the_tool`'s pinned expectation to `[a] a_echo — echo its text argument`; confirm `search_no_match` (`No tools matching "zzz"`), `server_lists_its_tools`, `describe_shows_the_schema`, and the three `search`/`describe` #68 + scoped tests keep their exact bytes.

### Step 5 — GREEN: teach the form in `tool_specs.rs`

Edit **only** the `mcp` ToolSpec's workflow + disambiguation lines (`tool_specs.rs:286-299` — untested prose) to teach the callable form: `'server_tool'` (the spelling `search` prints) as the name for `describe`/`tool`, naming `mcp__server__tool` as the accepted alias, and that a wrong prefix fails naming the likely tool. **Leave the `server` param description byte-identical — punctuation and all.** `the_mcp_server_param_prose_tells_the_model_what_the_scope_actually_does` pins the substrings `describe`, `search`, `this session holds`, `fails`; asserts the sentence contains no `". "` (it must stay ONE sentence — adding, removing, or reordering any punctuation that creates or destroys a `". "` reddens it); and asserts none of the banned `must name a configured` / `actually configured` phrasings. Scope semantics don't change, so no edit is needed there — do not touch that line at all. The param descriptions that ARE safe (unpinned — no test reads them): `tool` (`"Tool name to call"`) and `describe` (`"Tool name to show full parameter schema for"`) — optionally extend those with `(server_tool accepted)`; also unpinned and untouched here: `search`, `connect`, `action` (and `args` — leave it; no new params). No new top-level param is introduced, so `suite_param_keys()`'s mcp row, `the_suite_tool_specs_advertise_every_key_their_handlers_read`, and `every_tool_spec_is_in_the_param_key_table` are untouched.

Check: `cargo test --lib the_mcp_server_param_prose_tells_the_model_what_the_scope_actually_does` (and the whole `agent::harness::tool_specs` module) green.

### Step 6 — record the decision + full gate

Append to `docs/features/mcp-known-gaps.md` a new `## `-level section in the house format (`**Title.** text` bolded-opening bullets, issue-tagged heading — e.g. a `## … (#118, …)` heading like the file's `## The five NeedsAuth / OAuth residuals (#68, shipped by T7 as d2cb1fa)`), recording: the accepted `<server>_<tool>` / `mcp__server__tool` name forms and longest-prefix resolution (#118); the precedence (prefix-with-known-server wins over a literal raw name; a `server` param forces the raw reading; only `_`-shaped names are prefix candidates); the #68 layering (prefixed misses are FAILED even when every server answered; raw misses keep their success bytes); and the **residual accepted limitation** the precedence leaves: a raw tool literally named `X_<tool>` on a server *other than* `X` is shadowed when `X` is a known server — reachable via `mcp({ tool: "<tool>", server: "X" })`. Then update the front matter to this run's date and HEAD **in the file's exact stamp shape** — replace the two front-matter lines
`last-verified: 2026-10-24` and
`verified-by: read against this tree at \`774039d\` (agent/mcp/{http,oauth,manager,tool}.rs, commands/settings.rs) — every gap below re-confirmed still open, not copied from the plan`
with
`last-verified: <this run's date>` and
`verified-by: read against this tree at \`2b6bd26\` (agent/mcp/tool.rs, agent/harness/tool_specs.rs) — every gap below re-confirmed still open, not copied from the plan` —
i.e. update the patch-prefix parenthetical to `agent/mcp/tool.rs, agent/harness/tool_specs.rs` and the rest of the sentence verbatim, never copying the stale `774039d` stamp (do not add a `(#118)` tag to the front matter or invent a different sentence).

**Verification (all from `src-tauri/`):**
```
cargo test --lib agent::mcp::tool
cargo test --lib agent::harness::tool_specs
cargo build --all-targets        # fixture-binary hygiene (AGENTS.md) — no fixture change expected
cargo clippy --all-targets       # must stay at 0 warnings
cargo check --target x86_64-pc-windows-gnu --all-targets   # Windows proof, toolchain permitting
```

## Acceptance (issue #118) → step map

1. `mcp({ tool: "<server>_<tool>" })` and `mcp({ describe: "<server>_<tool>" })` resolve to the same tool as the raw name → Steps 3–4, tests 1–2.
2. A name with the WRONG prefix returns an error naming the likely correct tool → Steps 2–4, test 4 (`is_error` + `a_echo` suggestion).
3. Existing raw-name calls and the `server` disambiguation behave as before → the unchanged arms in Steps 3–4, kept green by `a_plain_not_found_is_still_a_success_when_every_server_answered`, `an_ambiguous_tool_name_requires_the_server_param`, the scoped-#68 family, `describe_shows_the_schema`, `server_lists_its_tools`, and `search_no_match`.
4. Unit tests in `tool.rs` cover: a prefixed call, a prefixed describe, a server name containing an underscore, and a miss with suggestions → the four tests of Step 1 (with the ambiguous-rule non-bypass pinned inside test 1).

## Risks / notes

- **#68's partial-set rule is not inverted**: the raw `Tool not found: nope` success bytes stay pinned by `a_plain_not_found_is_still_a_success_when_every_server_answered`; the new failure applies only to `_`-shaped names, gated at `is_prefix_shaped`. `prefixed_miss` composes `skipped_note` so `the_skipped_note_matches_the_issue_example`'s bytes hold.
- **Ambiguity rule not bypassed**: the `ambiguous` arm is reachable only from the raw tier; a resolved prefix never reaches it (pinned by test 1's two-server setup).
- **`server` param + prefixed `tool`**: the param wins; the name is passed through raw — the decided precedence (no current test covers the combination; do not add one past this scope).
- **`manager.server_names()`** is the only manager API used (already exists; `manager.rs` untouched). Server-name order is a `HashMap` order — do not assert a sorted list; tests use single- or two-key fixtures.
- `fake_mcp_stdio` needs no change: default tools cover `echo`,`hang`,`err`; `--tools=` covers `_`-bearing tool names.