---
status: live
last-verified: 2026-10-29
verified-by: read against this tree at `2b6bd26` (`agent/mcp/tool.rs`, `agent/harness/tool_specs.rs`) — every gap below re-confirmed still open, not copied from the plan
---

# MCP — known gaps

Accepted, unfixed defects in the MCP client. They live here because the roadmap
family that recorded them (`docs/roadmap/issue-triage-backlog-*`) is deleted on
ship, and the issue tracker holds only the parts of it that were filed. This is
the surviving home for the rest — read it before concluding that a token, a
state or an option is handled.

## The five `NeedsAuth` / OAuth residuals (#68, shipped by T7 as `d2cb1fa`)

T7 fixed the two reported symptoms — a skipped server now FAILS a bare `mcp`
call instead of reporting `Tool not found`, and an expired stored token is now
refreshed and persisted before it is sent (`manager::usable_token_provider`).
These five were recorded while planning and deliberately left open; four are at
the bottom of the deleted `task07` plan doc, the fifth is T4's session-vs-Settings
gap that its own plan named.

- **The OAuth access token goes out with no `Bearer ` prefix.** `http.rs` frames
  `Bearer {t}` for the STATIC `AuthSpec::Bearer` header only
  (`http.rs:86`); an OAuth token from the provider closure is handed to
  `Authorization` verbatim (`http.rs:157`, `:281`). Spec-strict auth servers
  reject that, so MCP OAuth may fail against a real provider for a reason
  unrelated to #68.
- **Mid-session token expiry is not handled.** The provider closure is built once
  at connect time and captures one token string
  (`manager.rs:355-368`), and only `ensure_connected` maps a 401 → `NeedsAuth`
  (`manager.rs:183`, `http.rs:177-181`). A token that expires mid-session leaves
  the entry `Connected` and every later call failing — the fix wants a
  401→refresh→retry inside `http.rs`.
- **A stdio connect failure never reaches `McpState::Error`.** `ServerDef::Stdio`
  propagates with `?` (`manager.rs:171`) past the `Error { text }` arm that only
  the HTTP branch has, so the entry sits in `Connecting` and `status` never
  reports why the server is dead. `tool.rs`'s `skip_reason` fallback covers the
  symptom, not the cause.
- **Refresh-token ROTATION drops the rotated token.** `parse_token_response`
  takes `refresh_token` from the response and nothing else (`oauth.rs:273-276`),
  so a server that rotates the refresh token but omits it from the refresh
  response replaces the stored one with `None` — and `oauth::refresh` returns
  `None` at once without one (`oauth.rs:396`), ending auto-refresh for that
  server permanently.
- **Authenticating from Settings does not unstick a live session.**
  `authenticate_server` (`manager.rs:536`, reached from
  `commands/settings.rs::auth_mcp_server`) writes `mcp-auth.json` and returns —
  it has no manager entry to correct, because it runs outside any session's
  `McpManager`. A live session holding that server in `NeedsAuth` stays stuck
  until it reconnects: `ensure_connected` never auto-retries `NeedsAuth`
  (`manager.rs:161-166`). The `mcp` tool's own `auth` action does clear the state
  (`authenticate_with` drops client + state, `manager.rs:314-318`), so the gap is
  specific to the Settings door, not to authenticating.

## The `server_tool` name forms, and what the precedence shadows (#118, T3)

`mcp({ tool: … })` and `mcp({ describe: … })` now accept the callable prefixed
spelling: `<server>_<tool>` (the form `search` and the single-`server` listing
print) and the `mcp__<server>__<tool>` alias. Both resolve against the server
names the manager
HOLDS by LONGEST prefix — never a split on the first `_` — so with a `github` and
a `github_enterprise` server, `github_enterprise_get_issue` is server
`github_enterprise`'s `get_issue`. Whatever the tier resolves to, the RAW tool
name is what reaches the server: the prefix is a spelling this proxy understands
and is never forwarded. The rules that decide an awkward name:

- **A prefix naming a known server WINS over a literal raw name.** `github_echo`
  is server `github`'s `echo` even if some other server serves a tool literally
  called `github_echo`. A `server` param forces the RAW reading — the name is
  passed through untouched — and a name carrying no `_` is never a prefix
  candidate at all, which is what keeps every raw-name behavior below intact.
- **A prefixed miss FAILS even when every server answered** (#118). This is
  layered onto the #68 partial-set rule, not a replacement of it: a raw name's
  miss keeps its exact bytes (`Tool not found: nope`, a SUCCESS on an all-healthy
  set), and a prefixed miss composes the same `Skipped servers:` note, scoped to
  the server the prefix named.
- **A resolved prefix never reaches the ambiguity rule.** The tie arm counts the
  servers owning a RAW name; a prefix has already picked its server by
  construction.

**The residual limitation the precedence leaves:** a tool literally named
`X_<something>` on a server that is NOT `X` is SHADOWED whenever `X` is also a
known server — `{ "tool": "github_echo" }` cannot reach server `linear`'s
tool of that literal name, because the prefix reading wins. The escape hatch is
the raw reading: `mcp({ tool: "echo", server: "linear" })` (and, for the literal
name, `mcp({ tool: "github_echo", server: "linear" })` — a `server` param means
the name is raw). `search` still lists the shadowed tool under its own
`[linear] linear_github_echo` line, so it is findable, merely not callable by
that spelling. Accepted: the alternative — preferring a literal raw name over a
known-server prefix — would make the callable form `search` prints unreliable,
which is the whole point of the change.

## Two pointers the same loop recorded, so they are not re-derived

Not MCP defects — they moved here only because this file survives the ship that
deletes the roadmap family which recorded them.

**The web tools still owe option (b) of #82** (`open work`): narrow the handlers
to ONE param dialect (drop the camelCase acceptance) and fix the truncation notice
+ `details` key to say `response_id`. The interim shipped with T9 (`a9b2347`) — the
specs advertise exactly what the handlers read, so #78's unknown-param checker has
zero known false positives (an unknown top-level param is REJECTED, not warned, since
[ADR 0079](../decisions/0079-an-unknown-top-level-tool-parameter-rejects-the-call.md)) —
and the real fix wants a line in the ADR that owns the
web tools, which is why it was not folded into T9. **And `ask`'s nested
`recommended` is read by the handler but unadvertised** in `ask`'s nested
`items.properties` (small; fold into #82's area): #78's checker is top-level-only,
so it can never fire on a nested key and this stays invisible until the nested rule
lands — cheap to advertise when it does.
