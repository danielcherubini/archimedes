# Grounding — task #118: the `mcp` proxy tool's prefixed-name resolution

Branch: `feature/agent-permission-and-pins` (HEAD `2b6bd26`, working tree clean at read time).
Read against the current tree, 2026.
Area: `agent/mcp` — the native `mcp` proxy tool (`src-tauri/src/agent/mcp/tool.rs`).

> All non-test paths are relative to `src-tauri/`. Tests paths are quoted
> VERBATIM from the tree; line numbers are for navigation, not guaranteed
> across edits.

## 1. `tool.rs` — the whole control flow of `mcp_tool` (each `── section ──` in order)

Entry: `pub async fn mcp_tool(manager: &mut McpManager, args: &Value, cancel: &CancellationToken) -> ToolResult` (`tool.rs:262`).

First the param reads (`tool.rs:264-287`):
```rust
    let tool = args.get("tool").and_then(Value::as_str).map(str::to_string);
    let args_param = args.get("args").cloned();
    let search = args
        .get("search")
        .and_then(Value::as_str)
        .map(str::to_string);
    let describe = args
        .get("describe")
        .and_then(Value::as_str)
        .map(str::to_string);
    let connect = args
        .get("connect")
        .and_then(Value::as_str)
        .map(str::to_string);
    let server = args
        .get("server")
        .and_then(Value::as_str)
        .map(str::to_string);
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::to_string);
```

Then the dispatch, section by section, quoted with the exact matching expressions:

### ── status (no tool/search/describe/connect/server, or action: "status") ── (`tool.rs:290-299`)
```rust
    // ── status (no tool/search/describe/connect/server, or action: "status") ──
    if tool.is_none()
        && search.is_none()
        && describe.is_none()
        && connect.is_none()
        && server.is_none()
        && action.as_deref().map(|a| a == "status").unwrap_or(true)
    {
        return ok(manager.status_lines().join("\n"));
    }
```

### ── connect ── (`tool.rs:301-307`)
```rust
    // ── connect ──
    if let Some(name) = &connect {
        return match manager.connect(name, cancel, TIMEOUT).await {
            Ok(outcome) => ok(outcome),
            Err(e) => fail(e),
        };
    }
```

### ── action: "auth" + server (the interactive OAuth flow) ── (`tool.rs:309-317`)
```rust
    // ── action: "auth" + server (the interactive OAuth flow) ──
    if action.as_deref() == Some("auth") {
        let Some(name) = &server else {
            return fail("the `auth` action requires a `server` param".to_string());
        };
        return match manager.authenticate(name, cancel).await {
            Ok(outcome) => ok(outcome),
            Err(e) => fail(e),
        };
    }
```

### ── unknown action ── (`tool.rs:320-325`)
```rust
    // ── unknown action ──
    if let Some(a) = &action {
        if a != "status" {
            return fail(format!("Unknown action: {a} (valid: status, auth)"));
        }
    }
```

### ── the `server` scope must name a server the manager HOLDS ── (`tool.rs:327-344`)
```rust
    // ── the `server` scope must name a server the manager HOLDS ──
    //
    // Every path below takes `server` as its SCOPE, so the scope is validated
    // ONCE here: a name the manager does not hold means the scope named
    // NOTHING, and an answer computed over it is not an answer (issue #68's
    // bug class — the model must not read an empty scope as "it doesn't
    // exist"). A held server that is merely unreachable passes here and
    // is reported as a SKIP by `collect_tools`, which is the existing,
    // different rule. Note the asymmetry the guard's doc spells out: an entry
    // `classify_server` DROPPED (`disabled: true`, legacy `sse`, malformed)
    // never reached the manager and so lands on the unknown side. (`connect` /
    // `action: "auth"` returned above; they act ON a server rather than scoping
    // a lookup, and the manager already fails them naming the unknown name.)
    if let Some(name) = &server {
        if let Some(r) = unknown_server_scope(manager, name) {
            return r;
        }
    }
```

### ── search ── (`tool.rs:346-381`)
```rust
    // ── search ──
    if let Some(q) = &search {
        let all = collect_tools(manager, cancel).await;
        let q_lower = q.to_lowercase();
        let results: Vec<String> = all
            .tools
            .iter()
            .filter(|(s, t)| {
                in_scope(server.as_deref(), s)
                    && (t.name.to_lowercase().contains(&q_lower)
                        || t.description
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&q_lower))
            })
            .map(|(s, t)| {
                format!(
                    "[{s}] {} — {}",
                    t.name,
                    t.description.as_deref().unwrap_or("(no description)")
                )
            })
            .collect();
        if results.is_empty() {
            // A search computed over a PARTIAL server set is not an answer:
            // it fails and names what was skipped (issue #68) — but only the
            // skips INSIDE the set the call scoped to (a `server` param narrows
            // both the tools and the partiality check).
            return miss_result(
                format!("No tools matching \"{q}\""),
                &scoped_skipped(&all.skipped, server.as_deref()),
            );
        }
        return ok(results.join("\n"));
    }
```

### ── describe ── (`tool.rs:383-412`)
```rust
    // ── describe ──
    if let Some(name) = &describe {
        let all = collect_tools(manager, cancel).await;
        // The `server` scope filters the LOOKUP, not just the failure wording:
        // a describe scoped to a server that does not serve the name is a MISS
        // scoped to that server, never another server's tool. (A describe of a
        // name a DIFFERENT server owns is a miss here too — the caller excluded
        // that server — and the miss keeps the plain `Tool not found:` bytes
        // the scoped rule already promised.)
        let Some((s, t)) = all
            .tools
            .iter()
            .find(|(s, ti)| ti.name == name.as_str() && in_scope(server.as_deref(), s.as_str()))
        else {
            // Nothing matched in scope AND the scoped set was partial → a
            // FAILED result naming the skipped servers (issue #68); a skip
            // OUTSIDE the named `server` does not bear on this call.
            return miss_result(
                format!("Tool not found: {name}"),
                &scoped_skipped(&all.skipped, server.as_deref()),
            );
        };
        let schema =
            serde_json::to_string_pretty(&t.input_schema).unwrap_or_else(|_| "{}".to_string());
        return ok(format!(
            "{name} ({s})\n{}\n\nSchema:\n{}",
            t.description.as_deref().unwrap_or(""),
            schema
        ));
    }
```
This is the **describe lookup** the task plan needs: exact raw-name equality
`ti.name == name.as_str()` AND `in_scope(...)` — a second, `server`-PREFIXED
lookup form will have to sit next to this predicate (see §9: nothing exists today).

### ── list server (server param only, no tool) ── (`tool.rs:414-439`)
```rust
    // ── list server (server param only, no tool) ──
    if let Some(name) = &server {
        if tool.is_none() {
            return match manager.list_tools(name, cancel, TIMEOUT).await {
                Ok(tools) => {
                    let lines: Vec<String> = tools
                        .iter()
                        .map(|t| {
                            format!(
                                "{}: {}",
                                t.name,
                                t.description.as_deref().unwrap_or("(no description)")
                            )
                        })
                        .collect();
                    let joined = lines.join("\n");
                    ok(if joined.is_empty() {
                        "(no tools)".to_string()
                    } else {
                        joined
                    })
                }
                Err(e) => fail(e),
            };
        }
    }
```

### ── call tool ── (`tool.rs:441-494`), including the `matches` computation and the ambiguity rule
```rust
    // ── call tool ──
    if let Some(t) = &tool {
        // Resolve the server (an explicit `server`, or an exact raw-name
        // match across servers; a tie → the `server` param is required).
        let (server_name, raw_tool) = match &server {
            Some(s) => (s.clone(), t.clone()),
            None => {
                let all = collect_tools(manager, cancel).await;
                let matches: Vec<String> = all
                    .tools
                    .iter()
                    .filter(|(_, ti)| ti.name == t.as_str())
                    .map(|(s, _)| s.clone())
                    .collect();
                if matches.is_empty() {
                    // Nothing matched AND something was skipped → a FAILED
                    // result naming the skipped servers (issue #68); with every
                    // server reachable the wording is unchanged and stays a
                    // success. This branch only runs UNscoped (a named `server`
                    // resolves above without collecting), so the filter is a
                    // no-op here — applied to keep the rule stated in one
                    // shape: partiality is judged over the scoped set.
                    return miss_result(
                        format!("Tool not found: {t}"),
                        &scoped_skipped(&all.skipped, server.as_deref()),
                    );
                }
                if matches.len() == 1 {
                    (matches[0].clone(), t.clone())
                } else {
                    return fail(format!(
                        "Tool '{t}' is ambiguous (servers: {}); use the `server` param",
                        matches.join(", ")
                    ));
                }
            }
        };
        // Parse `args` (a JSON string → parse; an object → as-is; absent →
        // `{}`). A JSON-string parse failure is a tool error.
        let tool_args = match &args_param {
            Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
                Ok(v) => v,
                Err(e) => return fail(format!("Invalid JSON in args: {e}")),
            },
            Some(v) => v.clone(),
            None => Value::Object(Default::default()),
        };
        return map_call_outcome(
            manager
                .call_tool(&server_name, &raw_tool, &tool_args, cancel, TIMEOUT)
                .await,
        );
    }
```
Key facts for #118:
- The **ambiguity rule** is purely count-based on the raw-name (`ti.name == t.as_str()`) match set: `matches.is_empty()` → the miss path (§ below); `matches.len() == 1` → the sole owner; `matches.len() > 1` → the `ambiguous` failure. A prefixed form that has already resolved the server MUST NOT fall into the `> 1` arm — the count is over *servers* that own the tool, and a prefix maps to ONE server; the planner must place the prefixed resolution ahead of (or as a winner inside) this `match`.
- A **miss on the bare call path is `miss_result`** (a *success* when every server answered — issue #68's partial-set rule, §2), NOT a failure. #118's "a miss must be an error" applies to the *prefixed* lookups and must not invert this bytes-pinned bare behavior (§2, §6).
- The call dispatches `manager.call_tool(&server_name, &raw_tool, …)` — `server_name` is the resolved server, `raw_tool` the (today unprefixed) tool name. A prefixed call will strip the prefix and pass the raw name here.

### ── fallback (the status default was already handled above) ── (`tool.rs:495-496`)
```rust
    // ── fallback (the status default was already handled above) ──
    fail("Unknown action (valid: status, auth)".to_string())
```

### The two `format!("Tool not found: {…}")` sites
1. describe-miss (`tool.rs:401`): `format!("Tool not found: {name}")` — reached when `all.tools.iter().find(|(s, ti)| ti.name == name.as_str() && in_scope(...))` is `None`.
2. call-tool miss (`tool.rs:464`): `format!("Tool not found: {t}")` — reached when `matches.is_empty()` on the bare/call path.

Both are fed into `miss_result(…, &scoped_skipped(&all.skipped, server.as_deref()))`. #118's "a miss names the likely correct tool plus the server list" will have to extend these strings or choose a distinct prefixed-miss message; note `miss_result` (success on an all-healthy set) vs the issue-#68 skips carefully — §2.

## 2. Helpers a new resolver must compose with

All quoted verbatim (`tool.rs`; line refs for navigation):

### `ok` / `fail` (`tool.rs:38-56`)
```rust
/// A successful single-text-block `ToolResult`.
fn ok(text: String) -> ToolResult {
    ToolResult {
        content: vec![ContentBlock::Text { text }],
        details: None,
        is_error: false,
    }
}

/// A failed single-text-block `ToolResult`.
fn fail(text: String) -> ToolResult {
    ToolResult {
        content: vec![ContentBlock::Text { text }],
        details: None,
        is_error: true,
    }
}
```

### `map_call_outcome` (`tool.rs:59-67`)
```rust
/// Map a `tools/call` outcome to a `ToolResult`: a `ToolCallResult` with
/// `is_error` → a FAILED `ToolResult` with the text (the `isError` mapping);
/// a transport error → a failed `ToolResult` with the error text.
fn map_call_outcome(outcome: Result<ToolCallResult, String>) -> ToolResult {
    match outcome {
        Ok(r) if r.is_error => fail(r.text),
        Ok(r) => ok(r.text),
        Err(e) => fail(e),
    }
}
```

### `skip_reason` (`tool.rs:80-88`)
```rust
/// Why a server was skipped — the STATE when the state explains it (the issue's
/// ask: `atlassian (NeedsAuth — use the auth action)`), else the transport
/// error, because a failed STDIO connect never leaves `Error` (it propagates
/// with `?` and the entry stays `Connecting`), so the state alone would say
/// nothing useful.
fn skip_reason(state: &McpState, err: &str) -> String {
    match state {
        McpState::NeedsAuth => "NeedsAuth — use the auth action".to_string(),
        McpState::Error { text } => format!("error: {text}"),
        other => format!("not usable ({other:?}): {err}"),
    }
}
```

### `skipped_note` (`tool.rs:90-104`)
```rust
/// The `Skipped servers: …` suffix (`""` when nothing was skipped) — appended
/// to a message that has no trailing period, so the result reads
/// `Tool not found: X. Skipped servers: atlassian (NeedsAuth — use the auth action)`.
fn skipped_note(skipped: &[(String, String)]) -> String {
    if skipped.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = skipped
        .iter()
        .map(|(name, reason)| format!("{name} ({reason})"))
        .collect();
    format!(". Skipped servers: {}", parts.join(", "))
}
```

### `miss_result` — the EXACT partial-set rule #118 must not break (`tool.rs:107-118`)
```rust
/// The "nothing matched" answer: a SUCCESS with the plain `message` when every
/// server answered (the wording is byte-identical to before this rule existed),
/// a FAILURE with the same message + the `Skipped servers: …` note when the
/// answer was computed over a PARTIAL server set (issue #68 — "I searched
/// everywhere and it isn't there" is a lie when a server was skipped).
fn miss_result(message: String, skipped: &[(String, String)]) -> ToolResult {
    if skipped.is_empty() {
        ok(message)
    } else {
        fail(format!("{message}{}", skipped_note(skipped)))
    }
}
```
**The rule, precisely:** `miss_result` is SUCCESS (`ok`) iff the *scoped* skipped set is empty; FAILURE (`fail`) with `message + skipped_note` iff non-empty. The scoping happens at the CALL SITE, not here — every miss pathway passes `&scoped_skipped(&all.skipped, server.as_deref())`, so:
- unscoped + every server answered → `Tool not found: nope`, success (pinned bytes);
- unscoped + some server skipped → `Tool not found: nope. Skipped servers: …`, failure;
- `server: "ok"` (answering) + `dead` sibling → skip set empties to `[]` → plain success bytes, *even though the connection set was partial* — the partiality is judged over the SCOPED set only;
- `server: "dead"` (the skipped one) → `Skipped servers: dead …`, failure.

#118's "a prefixed-name miss is an error" is an *additional* rule for names that carry a plausible prefix, and it must neither invert the all-healthy success bytes of the raw-name paths (pinned by `a_plain_not_found_is_still_a_success_when_every_server_answered`) nor bypass the scoped-partiality judgment for skip-free-but-partial sets. The planner should, at minimum, gate this on "the name contained a prefix-shaped separator" so bare raw-name misses keep today's exact bytes.

### `collect_tools` (`tool.rs:121-149`)
```rust
/// The `mcp` tool's `search` / `describe` / call-tool tool source: lazily
/// connect every server (the `tools/list` is cached per connection) and
/// collect `(server, tool)` pairs. A server that can't connect (`NeedsAuth` /
/// `Error` — not auto-retried) contributes nothing, and IS reported: the
/// caller must not answer "no such tool" when the answer was computed over a
/// partial server set (issue #68).
async fn collect_tools(manager: &mut McpManager, cancel: &CancellationToken) -> Collected {
    let mut out = Collected {
        tools: Vec::new(),
        skipped: Vec::new(),
    };
    for name in manager.server_names() {
        let outcome = manager.list_tools(&name, cancel, TIMEOUT).await;
        // NOTE: bind the `Result` first — in a `let … else` the scrutinee's
        // mutable borrow of `manager` is still live inside the `else` block, so
        // reading `manager.state_of(&name)` there is a borrow error.
        match outcome {
            Ok(tools) => out
                .tools
                .extend(tools.into_iter().map(|t| (name.clone(), t))),
            Err(err) => {
                let reason = match manager.state_of(&name) {
                    Some(state) => skip_reason(state, &err),
                    // An unknown name (it was just in `server_names()`) — defensive.
                    None => format!("not usable: {err}"),
                };
                out.skipped.push((name, reason));
            }
        }
    }
    out
}
```

### `scoped_skipped` (`tool.rs:152-168`)
```rust
/// The servers the call actually scoped to: the `server` param names ONE, so a
/// skip of any OTHER server is not this call's business; unscoped, every server
/// is in scope and the whole skipped list stands (issue #68 — the partiality is
/// judged over the set the call scoped to, not over every declared server).
fn scoped_skipped(skipped: &[(String, String)], server: Option<&str>) -> Vec<(String, String)> {
    match server {
        None => skipped.to_vec(),
        Some(srv) => skipped
            .iter()
            .filter(|(name, _)| name == srv)
            .cloned()
            .collect(),
    }
}
```

### `in_scope` (`tool.rs:171-179`)
```rust
fn in_scope(server: Option<&str>, server_name: &str) -> bool {
    server.is_none_or(|srv| srv == server_name)
}
```

### `unknown_server_scope` (`tool.rs:209-237`) — signature and message
```rust
fn unknown_server_scope(manager: &McpManager, server: &str) -> Option<ToolResult> {
    let configured = manager.server_names();
    if configured.iter().any(|name| name == server) {
        return None;
    }
    let known = if configured.is_empty() {
        "no MCP servers are configured".to_string()
    } else {
        format!("configured servers: {}", configured.join(", "))
    };
    // The REQUIREMENT clause says "a server this session holds" and names the
    // reasons an entry can be missing from that set, ...
    Some(fail(format!(
        "Unknown MCP server: {server} ({known}) — the `server` param must name a server this session holds, and an entry the config marks `disabled` (or a legacy `sse` / malformed entry) is not held"
    )))
}
```
(A long doc comment above it — abbreviated here, present in full at `tool.rs:181-208` — explains the held-vs-configured distinction; the message matters more than the doc: `unknown_server_scope` is the "server list" wording precedent a #118 FAILED result can reuse.)

### `Collected` — the struct (verbatim, `tool.rs:69-77`)
```rust
/// What `collect_tools` gathered: the `(server, tool)` pairs that answered,
/// plus the servers that contributed NOTHING and the reason to show the model
/// (`(name, reason)`).
struct Collected {
    tools: Vec<(String, super::types::ToolInfo)>,
    skipped: Vec<(String, String)>,
}
```
A longest-prefix resolver pulling `mcp__server__tool` needs the server-tool pair shape of `Collected::tools` AND the *known-server enumeration* — the first is here, the second comes from `manager.server_names()` (§3; `unknown_server_scope` shows the pattern of calling it directly).

## 3. How server names are obtained; can names contain `_` / `-`?

**The manager API:** `McpManager` exposes exactly the functions the proxy tool uses:
- `pub fn server_names(&self) -> Vec<String>` (`manager.rs:130-132`): `self.servers.keys().cloned().collect()` — the manager's own server map. This is what `collect_tools` walks and `unknown_server_scope` reads; a prefix resolver enumerates known servers the same way. (Order: the manager's map is a `HashMap` — see `McpManager::new` — so `server_names()` order is NOT sorted; `unknown_server_scope`'s `configured.join(", ")` is therefore order-stable only in tests with few servers. The `BTreeMap` ordering seen in `config.rs` does not survive into the manager.)
- `pub fn state_of(&self, name: &str) -> Option<&McpState>` (`manager.rs:125-127`) — used by `collect_tools` for skip reasons.
- `pub async fn list_tools(&mut self, name: &str, cancel, timeout) -> Result<Vec<ToolInfo>, String>` (`manager.rs:205-221`) — lazy connect + cached `tools/list` per connection.
- `pub async fn call_tool(&mut self, name: &str, tool: &str, args: &Value, …) -> Result<ToolCallResult, String>` (`manager.rs:225-238`).
- `pub fn status_lines()`, `connect()`, `authenticate()` — the other dispatch arms.

**What the manager HOLDS:** `McpManager::new` is fed by `config::load_servers` (`config.rs:39-55`), which merges three layers — global `~/.pi/agent/mcp.json`, the desktop `settings.json` `mcpServers` (ADR 0019), project `<cwd>/.pi/mcp.json` — and keeps only entries `types::classify_server` accepts. Server NAMES are raw JSON object keys; keys are any JSON strings. Evidence on `_` / `-`:

- **Hyphens in names are ordinary.** Unicode `-`, ASCII `-`: nothing in `config.rs`, `manager.rs`, or `types.rs` splits, filters, or validates names on `-`. Tests use hyphens as plain names: `"no-such-server"` (a *never-configured* name in the unknown-scope tests), `"switched-off"` (a `disabled: true` name), `"dead2"` — all reach the manager's lookup/failure strings untouched. The `mcp` spec's `server` param description itself uses `sse` (three letters). A hyphen-bearing server name (`my-server`) can never be mistaken for a prefix-joined tool name by a parser that only splits on `_`, and vice-versa.
- **Underscores in names are unregulated.** Nothing in the config load path filters or normalizes `_`. The task's example form `mcp__server__tool` / `server_tool` is therefore open to WRONG interpretation when a real server is named e.g. `foo_bar` or a real tool is named `get_item` — the planner must decide the split rule (the dispatch says: longest-prefix match against KNOWN server names, NEVER first-underscore split). `bin/fake_mcp_stdio.rs` tool names in the canned set are `echo` / `hang` / `err` (no underscores); the `--tools=<csv>` seam accepts any name (tests use `only_here`).
- **Name-shape guardrails that DO exist:** `config::server_infos` (the `#`-mention picker, `config.rs:110-160`) filters names through `crate::skills::is_mentionable_name` — but that is a *picker-only* surface (a name like `has space` / `x" onload="y` is dropped there while `load_servers` still holds and connects it, pinned by `load_servers_keeps_unmentionable_names_for_the_session_layer`). It does not restrict `_`/`-` for the session layer, and has no bearing on the `mcp` tool.
- **Tools named with separators:** `ToolInfo.name` comes from the server's `tools/list` JSON (`types.rs:99-107`, `pub name: String`); there is no validation that tool names avoid `_` either.

So: a resolver enumerating `manager.server_names()` can match prefixes that contain `-` safely, but must match prefixes containing `_` LONGEST-FIRST against the known list (that is exactly the #118 requirement) — e.g. with servers `github` and `github_enterprise`, `github_enterprise_get_issue` must resolve to server `github_enterprise`, not `github` + tool `enterprise_get_issue`.

## 4. The `search` and `server` listing formats (the bytes tests pin)

**`search` line format** (`tool.rs:373-379`):
```rust
                format!(
                    "[{s}] {} — {}",
                    t.name,
                    t.description.as_deref().unwrap_or("(no description)")
                )
```
→ `[{server}] {name} — {desc}`; no-description tools render `(no description)`. Pinned by `search_finds_the_tool`: `assert_eq!(text(&r), "[a] echo — echo its text argument");`.

**`server` list format** (`tool.rs:421-432`):
```rust
                        .map(|t| {
                            format!(
                                "{}: {}",
                                t.name,
                                t.description.as_deref().unwrap_or("(no description)")
                            )
                        })
```
→ `{name}: {desc}` (tool name FIRST, no server — the server is the caller). Pinned by `server_lists_its_tools` (three lines `echo: echo its text argument`, `hang: never answers`, `err: always errors`). Empty server → the literal `(no tools)`.

**`describe` success shape** (`tool.rs:408-411`): `"{name} ({s})\n{}\n\nSchema:\n{}"` → `{name} ({server})`, a blank line, the description, blank line, `Schema:` + pretty JSON. Pinned by `describe_shows_the_schema` (`t.contains("echo (a)")`).

**#118 implication:** "(b) listings show the callable prefixed form" means the planner must decide which bytes change:
- `search` output could become `[{server}] {server}_{name} — {desc}` (or keep the bracket form and ADD the callable form) — but `search_finds_the_tool` currently pins the EXACT string `[a] echo — echo its text argument`, so any change to that line reddens it, and the report's contract says the planner must state which tests pin the old bytes.
- `server` listing output (`{name}: {desc}`) has no server prefix today; a `server_`-prefixed callable form is a new announcement.
- `describe`'s `{name} ({s})` header also names the server.

Tests that pin these exact bytes: `search_finds_the_tool`, `search_no_match` (`No tools matching "zzz"`), `describe_shows_the_schema`, `server_lists_its_tools`, `a_plain_not_found_is_still_a_success_when_every_server_answered` (`Tool not found: nope`), `the_skipped_note_matches_the_issue_example` (`Tool not found: X. Skipped servers: atlassian (NeedsAuth — use the auth action)`), `a_describe_scoped_to_a_server_that_lacks_the_tool_is_a_scoped_miss` (`Tool not found: echo`), and the three `Skipped servers:` tests (§6). #118's "(b)" implies updating the pinned expectations for the listing tests (a conscious, declared byte change — or a "callable form appended" that keeps the old prefix as a prefix — the planner must pick and name the tests it edits).

## 5. The tool's own description in `harness/tool_specs.rs` + the tests pinning the prose

**The `mcp` ToolSpec** (`tool_specs.rs:283-327`), quoted verbatim:
```rust
        ToolSpec {
            name: "mcp".into(),
            description: [
                "Gateway to MCP (Model Context Protocol) servers. Use this tool to discover and call tools from connected MCP servers.",
                "",
                "Workflow:",
                "1. Search: mcp({ search: 'keyword' }) — find available tools",
                "2. Describe: mcp({ describe: 'tool_name' }) — see full parameters",
                "3. Call: mcp({ tool: 'tool_name', args: { ... } }) — execute the tool",
                "",
                "Other actions:",
                "  Status:  mcp({}) or mcp({ action: 'status' }) — list all servers and their connection status",
                "  List:    mcp({ server: 'name' }) — list all tools on a specific server",
                "  Connect: mcp({ connect: 'name' }) — eagerly connect to a server",
                "  Auth:    mcp({ action: 'auth', server: 'name' }) — run the interactive OAuth flow",
                "",
                "Use 'server' to disambiguate when two servers export a tool with the same name.",
            ]
            .join("\n"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tool": { "type": "string", "description": "Tool name to call" },
                    "args": { "description": "Tool arguments (a JSON string or an object)" },
                    "search": { "type": "string", "description": "Search tools by name/description keyword" },
                    "describe": { "type": "string", "description": "Tool name to show full parameter schema for" },
                    "connect": { "type": "string", "description": "Server name to eagerly connect" },
                    "server": { "type": "string", "description": "Scopes the call to one server (search, describe, that server's tool list, or a tool call), and it must name a server this session holds — an entry the config marks disabled (or a legacy sse / malformed one) is not held, so a name outside that set fails rather than answering 'not found'" },
                    "action": { "type": "string", "description": "Action string ('status' or 'auth')" }
                }
            }),
        },
```

**What the description teaches about names:** the workflow lines use bare `'tool_name'` and the disambiguation line says "Use 'server' to disambiguate when two servers export a tool with the same name." There is NO mention of a server-prefixed or `mcp__`-style name anywhere in the spec. #118's acceptance ("the listing must make the callable name unmistakable, and the description is where the model learns the workflow") implies the workflow lines 1–3 (which teach naming) and/or the `tool`/`describe`/`search` param descriptions should name the prefixed form — and the plan must track the tests that pin the CURRENT prose.

**Tests pinning the mcp spec prose:**
- `the_mcp_server_param_prose_tells_the_model_what_the_scope_actually_does` (`tool_specs.rs:1145-1212`, helper `mcp_server_param_description()` at `tool_specs.rs:1145-1156` reads the `server` param description out of `tool_specs()`). Pins SUBSTRINGS, not bytes: must contain `"describe"`, `"search"`, `"this session holds"`, `"fails"`; must NOT contain `"must name a configured"` / `"actually configured"` (lowercased); must NOT contain `". "` (one sentence). A #118 edit to the `server` description must preserve those claims, or the test is updated deliberately (this test is about scope semantics; a prefix-naming sentence may live in the workflow lines instead, which no test pins — verified: no test asserts on the workflow/description lines beyond this one and the census tests in §below).
- Census/pin tests that DO cover the mcp spec's PARAM KEYS (not prose): `tool_specs_advertise_exactly_the_executor_param_keys` (mcp's advertised properties = executor keys, from `exec_param_keys()`), `the_suite_tool_specs_advertise_every_key_their_handlers_read` (via `suite_param_keys()`, whose mcp row is exactly `["tool", "args", "search", "describe", "connect", "server", "action"]` — any NEW top-level param for prefixed resolution must be added to BOTH sides or not added at all), and `every_tool_spec_is_in_the_param_key_table` (mcp is in `LOOP_INTERNAL_TOOLS` and exempted). A #118 change that only *interprets existing* `tool`/`describe` names (no new param) touches none of these; a change adding a param (e.g. `name`) reddens `suite_param_keys` and the suite-keys test. The dispatch's requirement (a) is "resolve in both `tool:` and `describe:`" — i.e. existing params, so no census change needed for the resolution itself; but if the FAILED result should suggest a *call/describe* prefix "spelling" in the prose, the workflow lines are untested ground (free to edit, `tool_specs.rs:289-299`), while the `server` param description is substring-pinned.

## 6. ALL existing tests in `tool.rs`'s test module, by what they pin

Test module: `tool.rs:511-1285`. All `#[tokio::test(flavor = "multi_thread", worker_threads = 4)]` unless noted. Decorations and doc comments are quoted where they carry intent; full bodies were read from the tree.

**Fixture builders (quoted in §note below):** `fake_bin()`, `manager_with()`, `cancel()`, `text(r)`, `dead_server()`, `narrow_server()`.

### Status / basics
- `status_no_servers` — `mcp_tool({})` with empty config → success, `"No MCP servers configured."`.
- `status_lists_the_servers` — one fake server → `"a: Disconnected"`.
- `connect_action` — `{ "connect": "a" }` → `"a: connected"`.

### Search / describe / list / call happy paths
- `search_finds_the_tool` — pins the exact search line `[a] echo — echo its text argument`.
- `search_no_match` — pins the exact miss bytes `No tools matching "zzz"` (SUCCESS; all-healthy).
- `describe_shows_the_schema` — `describe: "echo"` → contains `echo (a)`, `"type": "object"`, `"text"`.
- `server_lists_its_tools` — pins the `server`-list shape: contains `echo: echo its text argument`, `hang: never answers`, `err: always errors`.
- `call_tool_with_an_object_args` — `{ "tool": "echo", "args": { "text": "hi" } }` → success `hi`.
- `call_tool_with_a_json_string_args` — `args` as a JSON string → `hi`.
- `call_tool_with_an_invalid_json_string_args_is_an_error` — `args: "not json"` → error containing `Invalid JSON in args`.
- `an_ambiguous_tool_name_requires_the_server_param` — TWO servers both serving `echo`; bare `{ "tool": "echo" }` → error containing `ambiguous` and naming `a` and `b`; then `{ "tool": "echo", "server": "a", "args": {...} }` → success `x`. **Quoted verbatim below (§7a)** — the fixture a prefixed-name test reuses.

### The is_error mapping precedent
- `the_is_error_mapping_is_a_failed_tool_result` (plain `#[test]`) — **quoted verbatim below (§7b)** — the precedent that "a miss is a failed ToolResult" maps onto `fail(...)`/`is_error: true`.

### auth / action
- `the_auth_action_on_a_non_oauth_server_is_an_error` — `{ "action": "auth", "server": "a" }` on a stdio server → error containing `OAuth`.
- `an_unknown_action_is_an_error` — `{ "action": "bogus" }` → error containing `Unknown action`.

### issue-#68 family: skipped servers FAIL the call
- `the_skip_reason_names_the_state_and_the_action` (`#[test]`, unit) — `skip_reason` bytes: `NeedsAuth — use the auth action`, `error: boom`, and the `Connecting`+transport-error fallback `not usable (Connecting): child exited`.
- `the_skipped_note_matches_the_issue_example` (`#[test]`, unit) — pins the issue's exact sentence `Tool not found: X. Skipped servers: atlassian (NeedsAuth — use the auth action)` and `skipped_note(&[]) == ""`.
- `a_skipped_server_fails_the_bare_call_and_names_it` — `{ "ok": "fake", "dead": dead_server() }`, bare `{ "tool": "nope" }` → is_error, contains `Tool not found: nope`, `Skipped servers:`, `dead`.
- `describe_fails_and_names_a_skipped_server` — `{ "describe": "nope" }` over partial set → is_error, `Tool not found: nope`, `dead`.
- `search_fails_and_names_a_skipped_server` — `{ "search": "zzz" }` over partial set → is_error, `No tools matching "zzz"`, `dead`.
- `a_plain_not_found_is_still_a_success_when_every_server_answered` — ALL-healthy bare miss → NOT error, EXACT bytes `Tool not found: nope`. **This is the bytes #118 must not invert.**
- `a_search_scoped_to_an_answering_server_is_not_poisoned_by_a_dead_sibling` — `{ "search": "zzz", "server": "ok" }` with `ok` healthy + `dead` → SUCCESS, exact `No tools matching "zzz"`.
- `a_describe_scoped_to_an_answering_server_is_not_poisoned_by_a_dead_sibling` — `{ "describe": "nope", "server": "ok" }` → SUCCESS, exact `Tool not found: nope`.
- `a_search_scoped_to_the_skipped_server_still_fails_and_names_it` — `{ "search": "zzz", "server": "dead" }` → is_error, contains `No tools matching "zzz"` and `Skipped servers: dead`; asserts `!t.contains("ok (")` — only the scoped skip is named.
- `an_unscoped_search_still_reports_every_skipped_server` — TWO dead siblings → both named (`dead`, `dead2`), `ok` not named.
- `a_call_on_a_healthy_server_is_not_broken_by_a_skipped_one` — successful `echo` call (bare and `"server": "ok"`) succeeds despite `dead`.

### the `server` param scopes the ANSWER
- `a_describe_scoped_to_a_server_that_lacks_the_tool_is_a_scoped_miss` — `narrow_server()` (healthy, `--tools=only_here`) + `ok`; `{ "describe": "echo", "server": "narrow" }` → SUCCESS, exact `Tool not found: echo`, `!t.contains("Schema")`; unscoped still finds `echo (ok)`.
- `a_describe_scoped_to_the_server_that_serves_the_tool_is_unchanged` — `{ "describe": "echo", "server": "ok" }` → contains `echo (ok)` + `"text"`.
- `a_search_scoped_to_a_never_configured_server_fails_naming_it` — `{ "search": "echo", "server": "no-such-server" }` → is_error, contains `no-such-server`, `!t.contains("No tools matching")`.
- `a_describe_scoped_to_a_never_configured_server_fails_naming_it` — same for describe: is_error, contains `no-such-server`, `!t.contains("Tool not found")`.
- `an_unknown_server_scope_names_the_servers_that_do_exist` — `{ "search": "echo", "server": "typo" }` → is_error, contains `Unknown MCP server: typo`, `ok`, `narrow`.
- `a_configured_but_unreachable_server_is_never_reported_as_unknown` — `{ "describe": "nope", "server": "dead" }` → is_error but `!t.contains("Unknown MCP server")`, contains `Skipped servers: dead`.
- `every_scoped_path_rejects_a_never_configured_server` — loop over `{ "server": "ghost" }` and `{ "tool": "echo", "server": "ghost", ... }` → both error with `Unknown MCP server: ghost` + `ok`; then `{ "server": "ok" }` → success containing `echo:`; `{ "server": "dead" }` → is_error (manager's OWN error text), `!t.contains("Unknown MCP server")`.
- `an_unknown_server_scope_on_an_empty_config_says_so` — empty config + any server → contains `Unknown MCP server: anything` and `no MCP servers are configured`.
- `a_disabled_server_is_unknown_to_the_manager_and_says_why` — `"switched-off": { "command": fake_bin(), "disabled": true }` → is_error, `Unknown MCP server: switched-off`, contains `ok`, `servers: ok` (the `configured servers:` wording), `disabled`.

### #7a — fixture builders, quoted verbatim (the ones a new prefixed-name test reuses)
```rust
    /// The `fake_mcp_stdio` test-double binary (built by `cargo test` — the
    /// `CARGO_MANIFEST_DIR`/`target/debug` path).
    fn fake_bin() -> String {
        std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_mcp_stdio"
        ))
        .display()
        .to_string()
    }

    /// A temp `McpManager` over a temp config (the servers point at the fake
    /// stdio binary — `target/debug/fake_mcp_stdio`).
    fn manager_with(servers_json: &Value) -> (McpManager, tempfile::TempDir) {
        let bin = fake_bin();
        let dir = tempfile::tempdir().expect("a temp dir");
        let home = dir.path().to_path_buf();
        let project = dir.path().to_path_buf();
        let global = home.join(".pi/agent/mcp.json");
        std::fs::create_dir_all(global.parent().expect("a parent")).expect("creates the dir");
        let mut mcp = serde_json::Map::new();
        for (name, def) in servers_json.as_object().expect("an object").iter() {
            // A bare string def → the fake stdio binary (a `command` server);
            // an object def → used as-is.
            let def = if def.is_string() {
                serde_json::json!({ "command": bin })
            } else {
                def.clone()
            };
            mcp.insert(name.clone(), def);
        }
        std::fs::write(
            &global,
            serde_json::json!({ "mcpServers": mcp }).to_string(),
        )
        .expect("writes the mcp.json");
        // Compute the credentials path BEFORE `McpManager::new` MOVES `home`,
        // and inject it — no test here can ever read the developer's real
        // `mcp-auth.json` (issue #68).
        let auth_file = home.join("mcp-auth.json");
        let manager = McpManager::new(home, project, None).with_auth_file(auth_file);
        (manager, dir)
    }
```
```rust
    fn cancel() -> CancellationToken {
        CancellationToken::new()
    }

    fn text(r: &ToolResult) -> String {
        match &r.content[0] {
            ContentBlock::Text { text } => text.clone(),
            _ => panic!("an unexpected non-text content block"),
        }
    }
```
```rust
    /// A `{"dead": {…}}` def pointing at a dead port: NON-OAuth, so no token
    /// logic, so the connect fails instantly and the entry lands in `Error`
    /// (the same loopback-refusal trick as `status_shows_the_error_state`).
    fn dead_server() -> Value {
        serde_json::json!({ "url": "http://127.0.0.1:1/mcp" })
    }

    /// A HEALTHY server that does NOT serve `echo`: the fake binary with its
    /// advertised tool set narrowed to one other tool. The fixture the scoping
    /// tests need — with two healthy servers serving the SAME set, "the scoped
    /// server has no such tool" and "no server has it" are indistinguishable, so
    /// a test could not tell a correctly-scoped miss from an unscoped one.
    fn narrow_server() -> Value {
        serde_json::json!({
            "command": fake_bin(),
            "args": ["--tools=only_here"],
        })
    }
```

### #7b — `an_ambiguous_tool_name_requires_the_server_param`, verbatim
```rust
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_ambiguous_tool_name_requires_the_server_param() {
        // Two servers (both the fake binary) — both have an `echo` tool.
        let (mut manager, _dir) = manager_with(&serde_json::json!({ "a": "fake", "b": "fake" }));
        let r = mcp_tool(
            &mut manager,
            &serde_json::json!({ "tool": "echo" }),
            &cancel(),
        )
        .await;
        assert!(r.is_error, "an ambiguous tool name is an error");
        let t = text(&r);
        assert!(t.contains("ambiguous"), "{t}");
        assert!(
            t.contains("a") && t.contains("b"),
            "the candidates are named: {t}"
        );
        // With the `server` param, the ambiguity is resolved.
        let r = mcp_tool(
            &mut manager,
            &serde_json::json!({ "tool": "echo", "server": "a", "args": { "text": "x" } }),
            &cancel(),
        )
        .await;
        assert!(!r.is_error);
        assert_eq!(text(&r), "x");
        manager.close_all();
    }
```
A prefixed-name test can rebuild this with `"server": "a"` spelled as `a_echo` / `mcp__a__echo` in `tool` (and `describe`), and assert the ambiguity does NOT fire.

## 7. `the_is_error_mapping_is_a_failed_tool_result` — verbatim
```rust
    #[test]
    fn the_is_error_mapping_is_a_failed_tool_result() {
        // A `ToolCallResult` with `is_error: true` → a failed `ToolResult`
        // with the text.
        let r = map_call_outcome(Ok(ToolCallResult {
            text: "tool failed".to_string(),
            is_error: true,
            non_text_count: 0,
        }));
        assert!(r.is_error);
        assert_eq!(text(&r), "tool failed");
        // A successful `ToolCallResult` → a successful `ToolResult`.
        let r = map_call_outcome(Ok(ToolCallResult {
            text: "ok".to_string(),
            is_error: false,
            non_text_count: 0,
        }));
        assert!(!r.is_error);
        assert_eq!(text(&r), "ok");
        // A transport error → a failed `ToolResult` with the error text.
        let r = map_call_outcome(Err("boom".to_string()));
        assert!(r.is_error);
        assert_eq!(text(&r), "boom");
    }
```
This is the precedent #118's "a miss is a failed ToolResult" should be written against: the wiring `ToolCallResult.is_error → ToolResult { is_error: true }` is already proven, and `ToolResult.is_error` serializes as `isError` (wire, `tools/types.rs:40-58`). A prefixed-name miss doesn't go through `map_call_outcome` (there is no call), so it uses `fail(...)` like every other rejection path (`unknown_server_scope`, the `ambiguous` arm) — and should be asserted by `r.is_error` + `text(&r)` contains the suggestion, mirroring the unknown-scope tests' style.

## 8. `docs/features/mcp-known-gaps.md` — current structure (house format for a #118 note)

73 lines at HEAD. Front-matter and headings today (verbatim):
```markdown
---
status: live
last-verified: 2026-10-24
verified-by: read against this tree at `774039d` (`agent/mcp/{http,oauth,manager,tool}.rs`, `commands/settings.rs`) — every gap below re-confirmed still open, not copied from the plan
---

# MCP — known gaps

Accepted, unfixed defects in the MCP client. They live here because the roadmap
family that recorded them (`docs/roadmap/issue-triage-backlog-*`) is deleted on
ship, and the issue tracker holds only the parts of it that were filed. This is
the surviving home for the rest — read it before concluding that a token, a
state or an option is handled.

## The five `NeedsAuth` / OAuth residuals (#68, shipped by T7 as `d2cb1fa`)

… five bolded-`**`-opening bullets, each `- **Title.** text` …

## Two pointers the same loop recorded, so they are not re-derived

Not MCP defects — they moved here only because this file survives the ship that
deletes the roadmap family which recorded them.

**The web tools still owe option (b) of #82** (`open work`): …
**And `ask`'s nested `recommended` is read by the handler but unadvertised** …
```
House format for a #118 entry: a new `## `-level section (or, if it counts as an accepted unfixed defect, a bullet under the pattern of the existing ones) with the same lead-in style — `**Title.** text` bullets; the file's convention is issue-tagged headings plus a `last-verified`/`verified-by` front-matter that is updated when a gap is re-confirmed (this report's read is against the CURRENT tree, so #118's note should NOT copy the stale `774039d` stamp — the planner may update `verified-by`/`last-verified` as part of the note). Note the file currently contains NO prefix-resolution gap; `#118` is not mentioned there.

## 9. Does ANY prefix handling exist today? (grep, do not assume)

Grepped `tool.rs`:
```
prefix|strip_prefix|split(|split_once|mcp__|rfind
```
Result: **one hit — a trailing doc comment fragment**:
- `tool.rs:777`-area comment `// prefix and naming what was skipped.` (inside a test docstring, wraps the word "prefix" incidentally).

There is NO `strip_prefix`, NO `split`/`split_once`/`rfind` anywhere in `tool.rs`, and NO `mcp__` literal in `src/` (`grep -rn "mcp__" src/` → zero hits). A repo-wide `grep` for split-on-separator patterns in `agent/mcp/` finds only `callback.rs:223`'s `response.split_once("\r\n\r\n")` (HTTP header parsing — unrelated). **Conclusion: today the only name resolution is (i) exact raw-name equality in `describe`'s `.find(...)` and the call path's `.filter(...)`, and (ii) an explicit `server` param. Zero prefix handling; #118's resolver is greenfield, and no existing behavior splits on `_`.** No guidance exists in the code for which separator (`_` vs `mcp__…__`) the callable form should use.

## 10. Scoped test commands + the fixture-binary note

From `AGENTS.md` (repo conventions):
- Rust tests live in `src-tauri/` (`AGENTS.md:19`): `cargo test` runs from `src-tauri/`.
- **`src-tauri/` scoped invocation for this module:**
  ```
  cd src-tauri
  cargo test agent::mcp::tool            # the module's tests (module path `crate::agent::mcp::tool`)
  cargo test --lib agent::mcp::tool      # same, lib only (the tool tests are lib tests)
  ```
  `ag::` prefix is not used; the module path is `crate::agent::mcp::tool` (`agent/mcp/tool.rs`, re-exported `mcp_tool` at `agent/mcp/mod.rs`). The `describe`/`search`/`call` tests are in that module; the harness-level admission and its tests live elsewhere:
  - `src/agent/harness/loop/tools.rs:178` dispatches `"mcp"` → `mcp_tool(&mut self.mcp, &tc.arguments, turn)` under a turn-token `tokio::select!` race.
  - `src/agent/harness/loop/tests/turn_lifecycle.rs::an_mcp_tool_call_round_trips_into_the_transcript` and `a_stop_mid_mcp_call_cancels` are the live-loop tests using the fake binary (test-scoped via `crate::test_support::ScratchDir`).
  - The tool-spec prose test: `src/agent/harness/tool_specs.rs` (run with e.g. `cargo test --lib the_mcp_server_param_prose_tells_the_model_what_the_scope_actually_does`, or the whole `agent::harness::tool_specs` module).
- **The fixture-binary note (verbatim from `AGENTS.md:363-365`), repointed at `fake_mcp_stdio`:**
  > "**`cargo test --lib` does not rebuild `fake_worker`.** A stale `bin/fake_worker.rs` binary surfaces as `manager::tests` failing with misleading values after a protocol change; run `cargo build --all-targets` first when a fixture looks like it is lying."
  The analogous fixture here is `src-tauri/src/bin/fake_mcp_stdio.rs` (the only MCP test binary; `src/bin/` = `{fake_mcp_stdio.rs, fake_worker.rs}`). `manager_with`/`fake_bin` point at `target/debug/fake_mcp_stdio` built from `CARGO_MANIFEST_DIR` — `cargo test --lib` compiles lib tests but, like `fake_worker`, the bin is only rebuilt when `--all-targets` covers it. If #118 changes the fake fixture (e.g. to add a `_`-named tool for prefix tests), the plan must include `cargo build --all-targets` (or rely on `cargo test`'s default bin build) before the affected tests, and mention the stale-binary diagnostic. (`Cargo.toml` has no `[[bin]]` table visible in the head; `default-run = "archimedes"` and auto-discovery find binaries in `src/bin/`.)
- Windows-proof note (`AGENTS.md:367`): `cargo check --target x86_64-pc-windows-gnu --all-targets` is the only local Windows proof; clippy gate is `cargo clippy --all-targets` at 0 warnings — both should be in the plan's verification column since `tool.rs` is compiled for all targets.

## Risks / edge cases the planner must decide (evidence above)

1. **Longest-prefix vs first-`_`-split:** server names may legally contain `_` and `-` (§3). The resolver MUST enumerate `manager.server_names()` and match longest-first; a naive `splitn(2, '_')` misreads server `github_enterprise` / tool `get_issue`.
2. **Overlap with #68 (the one rule #118 must not break):** `miss_result`'s partial-set rule (§2) makes "miss" a *success* on an all-healthy set. #118's "a miss is an error" applies to prefix-shaped names; the planner must keep identical bytes for raw-name misses (`Tool not found: nope` is pinned by `a_plain_not_found_is_still_a_success_when_every_server_answered`, and a SUCCESS case exists for a scoped miss, `a_describe_scoped_to_an_answering_server_is_not_poisoned_by_a_dead_sibling`). Gating on the presence of a separator is the cleanest non-breaking gate.
3. **Ambiguity-rule interplay:** the call path's `matches.len() == 1` / `> 1` counts SERVERS owning the raw name. A prefix that resolved to one server must bypass the bare-name match entirely — and a prefix that matches NO server but whose raw name IS served by one (e.g. `mcp__misspeled__echo`... no) — concretely: `github_echo` when the server is named `github` and `echo` exists, wants `github`; the resolver should try prefix→server-tool BEFORE the raw-name match, else `github_echo` could be misread as a raw tool named `github_echo` (again longest-prefix against known names decides).
4. **`server` param + prefix both present:** today `Some(s) => (s.clone(), t.clone())` bypasses collection entirely; a prefixed `tool` WITH a `server` param must decide precedence (prefix wins / param wins / mismatch error). No current test covers this.
5. **Listing bytes are pinned:** `[a] echo — echo its text argument` (search), `echo: echo its text argument` (server list), `echo (a)` (describe header) — #118's "(b) listings show the callable prefixed form" reddens `search_finds_the_tool` and `server_lists_its_tools` (and maybe `describe_shows_the_schema`); the planner names which tests get updated expectations and in which direction (append callable form vs replace).
6. **Spec prose:** the workflow lines (`tool_specs.rs:289-299`) are untested prose (free to edit) but the `server` param description is substring-pinned by `the_mcp_server_param_prose_tells_the_model_what_the_scope_actually_does` (must keep `describe`/`search`/`this session holds`/`fails`, one sentence, no `configured` phrasing). Adding a top-level param for prefixes reddens `suite_param_keys()`'s mcp row and `the_suite_tool_specs_advertise_every_key_their_handlers_read` — but #118 needs no new param, only interpretation of `tool`/`describe`.
7. **`Skipped servers:` on a prefixed miss:** the FAILED result #118 wants ("name the likely correct tool + the server list") must compose with `skipped_note`/`scoped_skipped` without double-suffixing or contradicting the issue-#68 note.

## Sources
- `src-tauri/src/agent/mcp/tool.rs` (dispatch `:262-496`; helpers `:38-237`; tests `:511-1285`)
- `src-tauri/src/agent/mcp/manager.rs` (`server_names`: `:130-132`; `state_of`: `:125-127`; `list_tools`: `:205-221`; `call_tool`: `:225-238`)
- `src-tauri/src/agent/mcp/config.rs` (`load_servers`: `:39-55`; `server_infos`/mention filter: `:110-160`)
- `src-tauri/src/agent/mcp/types.rs` (`ServerDef` `:73`, `McpState` `:87`, `ToolInfo` `:99-107`, `ToolCallResult` `:109-116`, `classify_server` `:278`)
- `src-tauri/src/agent/harness/tool_specs.rs` (mcp spec `:283-327`; `suite_param_keys` mcp row `:635-646`; prose test `:1159-1212`)
- `src-tauri/src/agent/harness/loop/tools.rs:178`; `src-tauri/src/agent/harness/loop/tests/turn_lifecycle.rs:1462,1531`
- `src-tauri/src/agent/tools/types.rs:42-58` (`ToolResult`, `isError` wire name)
- `src-tauri/src/bin/fake_mcp_stdio.rs`
- `docs/features/mcp-known-gaps.md`
- `AGENTS.md:19, 355-367` (test commands, one-compilation-unit, stale-fixture-binary and `--all-targets`, Windows proof)