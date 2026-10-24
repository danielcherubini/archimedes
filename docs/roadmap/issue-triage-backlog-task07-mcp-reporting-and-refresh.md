---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 68
done-when: `mcp({ tool: "X" })` for a tool that lives on a `NeedsAuth` / errored server returns a FAILED tool result naming that server and its state (the UI shows a failure, not a normal "Tool not found" result); and an `mcp-auth.json` entry whose `expires_at` has passed is silently refreshed and re-persisted on the next connect instead of sending the dead token and dropping the server into `NeedsAuth`.
---

# Task 7 — MCP: a skipped server fails the call; expired tokens refresh (issue #68)

**Goal:** Two defects in `src-tauri/src/agent/mcp/`. (1) `all_tools` silently drops every server whose `list_tools` fails, so a bare `mcp({tool})` / `describe` / `search` against a `NeedsAuth` server reports a **successful** "Tool not found" — the model and the UI both read it as "this tool does not exist". (2) `stored_token_provider` hands out the stored access token with no `expires_at` check and `oauth::refresh` has zero production callers, so the first expiry forces the user through the full interactive browser flow again.

**Architecture:** Item 1 is fixed entirely in `tool.rs`: `all_tools` returns what it collected **plus the servers it skipped and why** (the `list_tools` `Err` text at the call site + one new read-only manager accessor for the state), and the three branches that currently answer `ok("…not found…")` append a `Skipped servers: …` note and return `fail(...)` when anything was skipped. Item 2 is fixed by moving the token read behind one new **async** free function in `manager.rs` (`usable_token_provider`) that checks expiry, calls `oauth::refresh`, persists the result, and only then builds the sync `TokenProvider` closure; the expiry predicate + margin live on `StoredAuth` in `oauth.rs`. `http.rs` and the manager's state machine are untouched — a failed refresh degrades to "no token → 401 → `NeedsAuth`", which is the fallback the code already implements.

**Tech Stack:** Rust 2021 (toolchain pinned 1.99.0 in `src-tauri/rust-toolchain.toml`), `tokio` + `tokio_util::sync::CancellationToken`, `reqwest` (already a dependency), the existing in-module raw-HTTP test fakes (`start_401_server`, `start_auth_server`, `http_server`), `tempfile`. **No new dependency, no frontend change.**

---

## Parallelisation

**Verdict:** SERIAL — one task cannot be a wave, and per the parent roadmap (`docs/roadmap/issue-triage-backlog-status.md`) every Rust task on this branch is serial anyway: `archimedes` is **one compilation unit**, so a sibling's half-finished `.rs` edit makes this task's `cargo test` / `cargo clippy` fail to compile and destroys the RED/GREEN signal. T7 additionally depends on T4 (`c71bb7b`) being landed in `manager.rs` — it is (the `authenticate_with` seam and the `start_auth_server` test fake both exist at HEAD).

Consequence for the executor: **run the FULL gate**, not a scoped run. `cargo test --lib agent::mcp` still compiles the whole crate here, so scoping buys nothing. This task runs alone.

---

## Context — why this exists, and what was verified against the tree

Issue #68 lands **after** #46 (T4, commit `c71bb7b`), whose own text says "Land #46 first, so `auth` actually clears `NeedsAuth`". That precondition is met. **Do not re-fix #46**: `authenticate` already clears the state (`client = None`, `state = Disconnected`, `tools = None`) and `callback.rs` already frames its replies. Nothing in this task touches `callback.rs`.

### Item 1 — verified shape of the bug

`src-tauri/src/agent/mcp/tool.rs`:

- `ok(text)` sets `is_error: false`; `fail(text)` sets `is_error: true` (lines 19–35).
- `all_tools` (line 51) loops `manager.server_names()` and does `if let Ok(tools) = manager.list_tools(&name, cancel, TIMEOUT).await` — the `Err` is **discarded**, so a `NeedsAuth` / `Error` server contributes nothing and nothing records that it was skipped.
- Three call sites turn that silence into a **successful** result:
  - `search` → `return ok(format!("No tools matching \"{q}\""))` (line 173)
  - `describe` → `return ok(format!("Tool not found: {name}"))` (line 182)
  - bare `tool` (no `server` param) → `return ok(format!("Tool not found: {t}"))` (line 234)
- The `server`-param branch (line ~195) and the `call_tool` path already `fail(e)` with the manager's real error (`"the server is in a NeedsAuth state (use the `connect` / `auth` action)"` — that is what `ensure_connected` formats), so the two paths disagree today. **Those paths are already honest — leave them alone.**
- Nothing outside `tool.rs` asserts on `"Tool not found"` / `"No tools matching"` (grep over `src/`, `src-tauri/src`, `src-tauri/tests`): the only matches are the three lines above and `tool.rs`'s own `search_no_match`. So changing the failure shape breaks no frontend test and no integration test.

### Item 2 — verified shape of the bug

- `manager.rs::stored_token_provider` (line 312) is a **free function** (not a method) — deliberately: `ensure_connected` calls it while `entry = self.servers.get_mut(name)` and `def = &entry.def` are borrowed, so a `&self` / `&mut self` method there would be a double-borrow error. **The new async function must be a free function for the same reason.** It has exactly two callers: `ensure_connected` (line 155) and `test_server` (line 342). It reads `oauth::auth_file_path()` — the **real** file — which is the gap T4 explicitly recorded in `manager.rs`'s own test comment: *"Redirecting that read is T7's seam."* This task owns closing it.
- `oauth::StoredAuth` (`oauth.rs` line 43) carries `refresh_token: Option<String>` and `expires_at: Option<i64>` ("Unix epoch seconds … `None` = unknown / no expiry"), filled from `expires_in` by `parse_token_response` (line ~216, which computes `now_secs` inline with `SystemTime`).
- `oauth::refresh(stored, &reqwest::Client) -> Option<StoredAuth>` (line 320) implements the `refresh_token` grant and has **zero production callers** (only `refresh_a_public_client_is_never_auto_refreshed` and `refresh_without_a_refresh_token_is_none`). Its order of checks matters: (1) no `refresh_token` → `None`, (2) **no `client_secret` → `None` (the ADR 0015 guard)**, and only then (3) `discover()` + the token POST. So the guard short-circuits **before any network call** — a fact one of the new tests asserts.
- The ADR 0015 guard is real policy, recorded in `docs/decisions/0018-native-harness-mcp-tool.md`: "a pre-registered PUBLIC client (config `clientId`, no `clientSecret`) is NEVER auto-refreshed (the auth server rejects the refresh grant with `invalid_client`); it degrades to a fresh interactive flow." The design below preserves it **by delegating to `oauth::refresh` and never growing a second refresh path**, and the degradation lands exactly where the ADR wants: no token → 401 → `NeedsAuth` → the `auth` action (the interactive flow).
- `http.rs::TokenProvider = Box<dyn Fn() -> Option<String> + Send + Sync>` — **sync**, called per request (`send_request` and `send_notification` each do `self.get_token.as_ref().and_then(|f| f())`). A refresh is async and needs an HTTP client, so it cannot happen inside the closure. Hence: refresh **before** the closure is built.

### Two things this task deliberately does NOT fix (record them, do not "improve" them)

1. **`http.rs` sends the OAuth token with no `Bearer ` prefix.** For `AuthSpec::Bearer` the client builds `Some(format!("Bearer {t}"))`, but for `AuthSpec::OAuth` the header is the provider's return value verbatim (`req.header("Authorization", a)`), and `parse_token_response` stores the raw `access_token`. So OAuth requests go out as `Authorization: eyJ…` — which a spec-strict auth server rejects. That is a **third bug**, not #68, and fixing it changes what real servers accept. The new tests therefore assert the recorded header *contains* the expected token, never that it *equals* it, so this task neither enshrines nor silently "fixes" the framing.
2. **Mid-session expiry.** `ensure_connected` only runs when `entry.client` is `None`, so the provider closure built at connect time returns the same token for the life of the connection; a 401 mid-session returns `Err("needs-auth")` to the caller but leaves `state == Connected`. #68 asks for the **stored-token** check ("before using a stored token, check `expires_at`") — the connect-time read — which is what fixes "I reopened the app and must redo the browser flow". Fixing mid-session expiry means a 401→refresh→retry inside `http.rs`, i.e. changing the transport's error contract. Out of scope.
3. Bonus, for the same follow-ups list: a **stdio** connect failure propagates with `?` in `ensure_connected` and never sets `Error { text }`, so such a server sits in `McpState::Connecting` forever and `status` never shows why. Item 1's skip note handles the user-visible symptom by falling back to the error text; changing the state machine is out of scope.

---

## Files

- Modify: `src-tauri/src/agent/mcp/tool.rs` (`all_tools` → collected + skipped; the three `ok(…not found…)` sites; two new pure helpers; `McpState` import; module doc; tests)
- Modify: `src-tauri/src/agent/mcp/manager.rs` (`McpManager.auth_file` field + `with_auth_file` test seam; `McpState`-aware `state_of` accessor; `usable_token_provider` replacing `stored_token_provider`; the `test_server` token read; `authenticate` reads the field; tests)
- Modify: `src-tauri/src/agent/mcp/oauth.rs` (`TOKEN_EXPIRY_MARGIN_SECS`, `pub fn now_epoch_secs()` + its use in `parse_token_response`, `StoredAuth::is_expired`; `refresh`'s doc comment; one new test)

No other file changes. **Do not touch:** `http.rs` (no `Bearer` prefix, no mid-session refresh), `callback.rs` (T4's), `types.rs`, `config.rs`, `rpc.rs`, `stdio.rs`, `commands/settings.rs`, `agent/harness/tool_specs.rs` (**T8 owns that file next** — do not add an auth hint to the `mcp` tool description here), `Cargo.toml` / `Cargo.lock`, or anything under `src/` (frontend).

---

## What to implement

### 1. `oauth.rs` — the expiry policy on the type that owns it

Add next to `StoredAuth` (the `expires_at` field's doc comment already says `None` = unknown / no expiry):

```rust
/// A stored token counts as EXPIRED this many seconds before its `expires_at`:
/// the skew between this clock and the auth server's, plus the request in
/// flight. `tool.rs`'s per-request bound is 60 s, so a token that dies inside
/// that window is expired for our purposes.
pub const TOKEN_EXPIRY_MARGIN_SECS: i64 = 60;

/// The current wall-clock time in Unix epoch seconds (the same reading
/// `parse_token_response` uses to turn `expires_in` into `expires_at` — one
/// clock for both sides of the comparison).
pub fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
```

- **Replace** the inline `let now_secs = std::time::SystemTime::now()…` block in `parse_token_response` with `let now_secs = now_epoch_secs();` — behaviour-identical, one clock.
- Add the predicate as an inherent method (so the policy sits with the field it reads):

```rust
impl StoredAuth {
    /// Is this token expired, or expiring inside `TOKEN_EXPIRY_MARGIN_SECS`
    /// (a token expiring in 5 seconds IS expired — the request has to survive
    /// the round trip)? `expires_at: None` means the auth server never told us
    /// an expiry: treat it as NEVER expiring. Refreshing on a guess would cost
    /// a round trip per request and — for a public client, which the ADR 0015
    /// guard refuses to refresh — would downgrade a working token to a browser
    /// flow.
    pub fn is_expired(&self, now: i64) -> bool {
        self.expires_at
            .is_some_and(|at| at.saturating_sub(TOKEN_EXPIRY_MARGIN_SECS) <= now)
    }
}
```

  The `saturating_sub` guards a wildly negative `expires_at`. The boundary is inclusive: `expires_at == now + 60` counts as expired.
- Update `refresh`'s doc comment: it promises "the caller degrades to a fresh interactive flow" — name the caller (`manager::usable_token_provider`) and say where the degradation lands (no token → a 401 → `NeedsAuth` → the `auth` action). Do **not** change `refresh`'s body.

### 2. `manager.rs` — one async seam that returns a usable token

Add the credentials path as manager state (so a test can point it at a temp file — the seam T4 recorded):

```rust
pub struct McpManager {
    servers: BTreeMap<String, ServerEntry>,
    project_cwd: PathBuf,
    /// The credentials file (`mcp-auth.json`). Production: `oauth::auth_file_path()`.
    /// A field, not a call, so a test can drive the token paths against a temp
    /// file instead of the developer's stored tokens (issue #68 — the read that
    /// T4 left pointed at the real path).
    auth_file: PathBuf,
}
```

- `new` initialises it: `auth_file: oauth::auth_file_path(),`. `new`'s signature does **not** change (its callers are `agent/harness/loop.rs:295` and the test helpers — none change).
- Add the test seam. `#[cfg(test)]` is enough (every consumer is an in-crate unit test; no `src-tauri/tests/` target needs it):

```rust
#[cfg(test)]
pub(crate) fn with_auth_file(mut self, auth_file: PathBuf) -> Self {
    self.auth_file = auth_file;
    self
}
```

- `authenticate` now delegates to the field (clone FIRST — `self.authenticate_with(…, &self.auth_file)` is a double-borrow of `*self`):

```rust
pub async fn authenticate(&mut self, name: &str, cancel: &CancellationToken) -> Result<String, String> {
    let auth_file = self.auth_file.clone();
    self.authenticate_with(name, cancel, &auth_file).await
}
```

  **Leave `authenticate_with`'s signature and body alone.** T4's committed test `authenticating_clears_the_needs_auth_state` calls it with its own injected path; it keeps compiling and passing unchanged, and its in-test caveat stays accurate for it. The new tests below are what close the gap T4 recorded — do **not** rewrite that test or its assertions.

- Add the read-only state accessor (Item 1 needs the *state*, and `status_lines()` is a positional presentation list that would have to be re-parsed):

```rust
/// A server's current state (`None` = no such server). For callers that must
/// report WHY a server was unavailable, not just that it was.
pub fn state_of(&self, name: &str) -> Option<&McpState> {
    self.servers.get(name).map(|entry| &entry.state)
}
```

- Replace `stored_token_provider` with the async version and **delete `stored_token_provider`** (its two callers both move; leaving it is a `dead_code` warning, and it is the code that never checked expiry):

```rust
/// The stored token for a server, **refreshed first when it is expired**
/// (issue #68). A refresh is async and needs an HTTP client, and the
/// `TokenProvider` seam is a sync closure called per request — so the refresh
/// happens HERE, before the closure is built, and the closure captures the
/// token that survived.
///
/// `None` = nothing usable (no stored entry, or an expired token whose refresh
/// failed or is forbidden by the ADR 0015 public-client guard). The request
/// then goes out unauthenticated and the server's 401 marks the entry
/// `NeedsAuth` — the honest fallback, and the same path a missing token already
/// takes.
async fn usable_token_provider(server_name: &str, auth_file: &Path) -> Option<TokenProvider> {
    let mut map = oauth::load_credentials(auth_file);
    let stored = map.get(server_name).cloned()?;
    let token = if stored.is_expired(oauth::now_epoch_secs()) {
        eprintln!("mcp: {server_name}'s stored token is expired — trying the refresh_token grant");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .ok()?;
        // The ADR 0015 guard lives INSIDE `oauth::refresh` (a client with no
        // secret returns `None` before it touches the network) — this call site
        // must not grow its own copy of that decision.
        let refreshed = oauth::refresh(&stored, &client).await?;
        let token = refreshed.token.clone();
        map.insert(server_name.to_string(), refreshed);
        // A failed WRITE must not throw away a token we just earned: use it for
        // this connection and let the next attempt retry the write.
        if let Err(e) = oauth::save_credentials(auth_file, &map) {
            eprintln!("mcp: persisting the refreshed token for {server_name} failed: {e}");
        }
        token
    } else {
        stored.token
    };
    Some(Box::new(move || Some(token.clone())))
}
```

  Notes the implementer must not improvise around:
  - It stays a **free function** (see the borrow note in Context) and takes the path as a parameter, exactly like `stored_token_provider` did.
  - `eprintln!` is this crate's convention for a diagnostic with no channel (see `commands/files/mod.rs:99-103`); keep the `mcp: ` prefix.
  - A **failed refresh leaves the credentials file untouched** (no entry is removed, the stale token stays). A transient auth-server outage must not destroy a possibly-reusable refresh token.
  - Persist exactly what `oauth::refresh` returned. Do not "improve" rotation by carrying the old `refresh_token` over when the response omits one — record that as a follow-up instead.
  - `Duration` and `Path` are already imported in `manager.rs`; `reqwest` is a full-path crate reference (no new `use`, no `Cargo.toml` change).

- `ensure_connected`'s HTTP arm — one line changes:

```rust
let get_token = if matches!(def.auth, AuthSpec::OAuth { .. }) {
    usable_token_provider(name, &self.auth_file).await
} else {
    None
};
```

  `&self.auth_file` is a **disjoint field borrow** (`entry` borrows `self.servers`), which is exactly why the next arm already does `StdioClient::connect(def, &self.project_cwd, …)`; no clone is needed. Do not restructure the arm, do not add a state transition, do not touch the `needs-auth` → `NeedsAuth` mapping.

- `test_server`'s HTTP arm gets the same treatment (the Settings **Test** action reads a stored token too, so it has the same no-expiry-check defect — **declared in scope**, it is four lines and otherwise that button keeps forcing a needless re-auth):

```rust
let get_token = match (server_name, &def.auth) {
    (Some(n), AuthSpec::OAuth { .. }) => usable_token_provider(n, &oauth::auth_file_path()).await,
    _ => None,
};
```

  (`test_server` is a free function with no manager, so the real path is correct there. Its two tests pass `server_name: None` and are unaffected; the `needs-auth` error text still reaches `src/components/settings/McpSection.tsx:114` unchanged.)

### 3. `tool.rs` — a skipped server makes the answer a failure

Import the state type: `use super::types::{McpState, ToolCallResult};`.

Replace `all_tools` with a version that reports what it dropped, and add the two pure helpers:

```rust
/// What `collect_tools` gathered: the `(server, tool)` pairs that answered,
/// plus the servers that contributed NOTHING and the reason to show the model
/// (`(name, reason)`).
struct Collected {
    tools: Vec<(String, super::types::ToolInfo)>,
    skipped: Vec<(String, String)>,
}

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

`collect_tools` (rename `all_tools`; keep it the ONLY place that walks the servers — its three callers become `let all = collect_tools(manager, cancel).await;` and iterate `all.tools.iter()` where they today iterate `all.iter()`):

```rust
async fn collect_tools(manager: &mut McpManager, cancel: &CancellationToken) -> Collected {
    let mut out = Collected { tools: Vec::new(), skipped: Vec::new() };
    for name in manager.server_names() {
        let outcome = manager.list_tools(&name, cancel, TIMEOUT).await;
        // NOTE: bind the `Result` FIRST. In `let Err(e) = manager.list_tools(…).await else { … }`
        // the scrutinee's mutable borrow of `manager` is still live INSIDE the
        // `else` block, so reading `manager.state_of(&name)` there is a borrow error.
        match outcome {
            Ok(tools) => out.tools.extend(tools.into_iter().map(|t| (name.clone(), t))),
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

Update `all_tools`' doc comment (it currently claims a skipped server's "tools are simply absent" — that silence was the bug). Note, and do not "fix": a server that IS `Connected` but whose `tools/list` transport fails also lands in `skipped`, with reason `not usable (Connected): <error>`. That is accurate (it genuinely contributed no tools, and the error explains it) — leave the `other` arm as the catch-all rather than special-casing `Connected`.

The three branches become (exact strings — the tests pin them):

| Branch | Before | After |
|---|---|---|
| `search`, no results | `ok(format!("No tools matching \"{q}\""))` | `fail(format!("No tools matching \"{q}\"{}", skipped_note(&all.skipped)))` |
| `describe`, no match | `ok(format!("Tool not found: {name}"))` | `fail(format!("Tool not found: {name}{}", skipped_note(&all.skipped)))` |
| bare `tool`, no match | `ok(format!("Tool not found: {t}"))` | `fail(format!("Tool not found: {t}{}", skipped_note(&all.skipped)))` |

`skipped_note` returns `""` when nothing was skipped, so the all-servers-healthy case keeps its exact current wording **and stays a success** — which is what "Report a plain 'not found' only when every server connected" requires.

Update the module doc + the `mcp_tool` doc comment: state that a `search` / `describe` / name-resolution miss that happened while at least one server was unavailable is a **failure naming the skipped servers**, and that the `server`-param path is unchanged (it already surfaces the real error).

**Declared scope decisions** (do not silently widen, and do not undo these):

- **`search` is in scope.** The task text asked for a decision. It is the same helper, the same blindness, and the same wrong conclusion for the model ("no such tool exists"), and the fix is the shared suffix. Accepted trade-off: a search that genuinely matched nothing *while an unrelated server is skipped* now fails too. That is the honest reading — the answer was computed over a partial server set — and the message still carries the accurate `No tools matching "…"` prefix.
- **The `server`-param branch and the `call_tool` path stay exactly as they are** (they already `fail` with the real error, which is the inconsistency #68 cites).
- **A successful call is never downgraded.** With a `server` param, or when the name resolves on a reachable server, the skipped set is irrelevant and the result is untouched — one dead OAuth server must not break a call to a healthy one. There is a test for this.
- For `search` with a `server` filter, the note lists **every** skipped server, not just the filtered one (it is a diagnostic, not a filter result).

---

## Steps

- [ ] **`oauth.rs` — write the failing pure test first**, in `oauth.rs`'s `mod tests` (next to the other pure helper tests):

  ```rust
  #[test]
  fn the_expiry_margin_decides_when_a_token_must_be_refreshed() { … }
  ```
  Build a `StoredAuth` (the struct's fields are all `pub`; the module's tests already construct it literally) with `expires_at` and assert `is_expired(now)` for: `Some(now - 10)` → `true` (already dead); `Some(now + 5)` → `true` (**the "expiring in 5 seconds is expired" case**); `Some(now + TOKEN_EXPIRY_MARGIN_SECS)` → `true` (the inclusive boundary); `Some(now + 3600)` → `false`; `None` → `false` (never expires — never refresh).

- [ ] **Run `cargo test --lib agent::mcp::oauth`** from `src-tauri/`.
  - It must fail with `no method named is_expired found for StoredAuth` / `cannot find function now_epoch_secs`. If it compiles and passes, you added the test to the wrong module — stop.
- [ ] **Implement §1** (the const, `now_epoch_secs`, `is_expired`, the `parse_token_response` swap, `refresh`'s doc comment).
- [ ] **Run `cargo test --lib agent::mcp::oauth`** — the new test plus every pre-existing one (`the_full_authorization_code_flow`, `the_client_credentials_flow`, the two `refresh_*` guard tests, the storage round-trip) pass.
- [ ] **`manager.rs` — add the fake auth server for the refresh tests**, alongside T4's `start_401_server` / `start_auth_server` (route by request path, same raw-HTTP framing; `test_support::raw_json_server` serves ONE body for every path and cannot be reused):

  ```rust
  /// A minimal auth server for the `refresh_token` grant: the well-known
  /// metadata (its own `/token`) + a token endpoint that answers per `succeeds`
  /// and RECORDS every form field it received (so a test can prove the
  /// `refresh_token` grant was used, and — with the request counter — that no
  /// request was made at all).
  async fn start_refresh_server(
      succeeds: bool,
  ) -> (
      String,                                        // the base URL
      std::sync::Arc<std::sync::Mutex<Vec<String>>>, // recorded form fields, `k=v`
      std::sync::Arc<std::sync::atomic::AtomicU32>,  // request count
      tokio::task::JoinHandle<()>,
  )
  ```
  Routes: `/.well-known/oauth-authorization-server` → `200` `{"authorization_endpoint":"{base}/authorize","token_endpoint":"{base}/token"}`; `/token` → on `succeeds` `200` `{"access_token":"refreshed-access-token","refresh_token":"rotated-refresh","expires_in":3600}`, else `400` `{}`; anything else → `404`. Parse the form body exactly the way `start_auth_server` reads its request line, push each decoded `k=v` into the recorded vec, and increment the counter once per accepted request. **The counter counts EVERY request to the auth server** — a successful `oauth::refresh` makes TWO (the `discover` well-known GET, then the `/token` POST) — so it is only ever asserted at `0` (proof that nothing touched the network).

- [ ] **Add the token-gated MCP fake** in the same `mod tests`:

  ```rust
  /// An MCP-over-HTTP server that accepts a request only when its
  /// `Authorization` header carries `accepted` — everything else gets a `401`
  /// (which `HttpClient::send_request` maps to `needs-auth` because the def is
  /// OAuth). This is the "the stale token is dead, the fresh one works"
  /// scenario. Records every `Authorization` value it saw.
  async fn start_token_gated_server(
      accepted: &str,
  ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>, tokio::task::JoinHandle<()>)
  ```
  Answer an accepted request with a canned JSON-RPC `initialize` result
  (`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"0"}}}`) — `send_request` reads `result` without checking `id`, and `manager.connect` needs nothing beyond the handshake. **Assert the header with `contains`, not equality** (the client sends the OAuth token with no `Bearer ` prefix today — see "not in scope" — and this task must not encode that as intended).

- [ ] **Write the four manager tests** (all `#[tokio::test(flavor = "multi_thread", worker_threads = 4)]`). Common setup: `let dir = tempfile::tempdir()…`, `let auth_file = dir.path().join("mcp-auth.json")`, write the entry with `oauth::save_credentials(&auth_file, &map)` where `map: BTreeMap<String, oauth::StoredAuth>` holds `"a"`, and build the manager with `manager_with(&json!({ "mcpServers": { "a": { "url": mcp_url, "auth": { "clientId": "cid", "clientSecret": "sec" } } } }).to_string(), None).with_auth_file(auth_file.clone())`. (`classify_auth` accepts that object — any known OAuth field counts — so no `grantType` is needed; refresh does not consult the grant type.) **Every one of these must call `with_auth_file`, or it reads the developer's real `mcp-auth.json`.**

  1. `an_expired_token_is_refreshed_and_persisted_instead_of_needs_auth` — entry `{ client_id: "cid", client_secret: Some("sec"), token: "stale-access-token", refresh_token: Some("stale-refresh"), expires_at: Some(oauth::now_epoch_secs() - 10), auth_server_url: <refresh base>, scope: None }`; `start_token_gated_server("refreshed-access-token")` for the MCP URL.
     - `manager.connect("a", &cancel, Duration::from_secs(5)).await.expect("the expired token is refreshed and the connect succeeds")` → assert it equals `"a: connected"`.
     - `assert_eq!(manager.status_lines(), vec!["a: Connected"], "a refresh, not a NeedsAuth transition")`.
     - The recorded `Authorization` headers contain `"refreshed-access-token"` and contain **no** `"stale-access-token"`.
     - The recorded auth-server fields contain `"grant_type=refresh_token"` and `"refresh_token=stale-refresh"`.
     - **The refresh was persisted**: `oauth::load_credentials(&auth_file).get("a")` has `token == "refreshed-access-token"`, `refresh_token == Some("rotated-refresh")`, and `expires_at` `Some(at)` with `at > oauth::now_epoch_secs()`.
     - `abort()` both handles.
  2. `a_failed_refresh_lands_in_needs_auth` — same entry, `start_refresh_server(false)`, MCP = `start_token_gated_server("refreshed-access-token")` (so the stale token and no-token both 401).
     - `connect` is `Err`, the text contains `"requires authentication"`.
     - `assert_eq!(manager.status_lines(), vec!["a: NeedsAuth"], "a failed refresh still degrades to NeedsAuth")`.
     - The auth server recorded `grant_type=refresh_token` and `refresh_token=stale-refresh` (a refresh WAS attempted). Do **not** assert an exact request count here — `oauth::refresh` makes two requests to the auth server (the well-known `discover` + the `/token` POST).
     - The credentials file is **unchanged** (`token` is still `"stale-access-token"`) — a failed refresh writes nothing.
  3. `a_token_without_an_expiry_is_never_refreshed` — entry with `expires_at: None`, `refresh_token: Some("stale-refresh")`; MCP = `start_token_gated_server("stale-access-token")`; `start_refresh_server(true)` for the auth base.
     - `connect` succeeds, `status_lines() == ["a: Connected"]`.
     - `assert_eq!(counter, 0, "expires_at: None never spends a refresh round trip")` and the recorded fields are empty.
  4. `a_public_client_is_never_auto_refreshed_end_to_end` — the ADR 0015 guard at the CALL SITE (`oauth.rs` already covers the guard inside `refresh`): entry with `client_secret: None`, `expires_at: Some(oauth::now_epoch_secs() - 10)`, `refresh_token: Some("stale-refresh")`, `auth_server_url: <refresh base>`, and a config def of `auth: { "clientId": "cid" }` (no `clientSecret` — keep the def and the stored entry telling the same story); MCP = `start_token_gated_server("refreshed-access-token")`; `start_refresh_server(true)` so a refresh WOULD have succeeded if attempted.
     - `connect` is `Err` and `status_lines() == ["a: NeedsAuth"]`.
     - **The auth server's request counter is `0`** — the guard short-circuits before `discover`, so a public client never talks to the token endpoint and lands on the interactive flow instead.

- [ ] **Run `cargo test --lib agent::mcp::manager`** — the four new tests must FAIL **before** the `manager.rs` implementation, and for the right reason: 1 fails at `connect` (the stale token is sent → `401` → `Err`, `status_lines() == ["a: NeedsAuth"]`), 2 fails on the `grant_type=refresh_token` recording (nothing attempted a refresh), 3 and 4 **pass already** (they pin behaviour that must not regress — say so in their comments so nobody "fixes" them). If test 1 passes early, it is not observing the token — stop.
- [ ] **Implement §2** (the field + `with_auth_file` + `state_of` + `usable_token_provider`, delete `stored_token_provider`, rewire `ensure_connected` / `test_server` / `authenticate`).
- [ ] **Run `cargo test --lib agent::mcp::manager`** — the four new tests pass, and so does every pre-existing one, above all `a_needs_auth_server_is_not_auto_retried` (the guard is untouched), `authenticating_clears_the_needs_auth_state` (T4's — **do not edit it**), `status_shows_the_error_state` and `test_server_a_dead_port_is_an_error` (both use `http://127.0.0.1:1/mcp`, the loopback-refusal precedent this task's fakes reuse).
- [ ] **`tool.rs` — write the failing tests.** Reuse the module's existing helpers verbatim: `manager_with(&serde_json::json!({ … }))` (a bare string def → the `target/debug/fake_mcp_stdio` binary; an object def → used as-is), `cancel()`, `text(&r)`. Add the credentials-path hygiene fix inside `manager_with` — `McpManager::new` MOVES `home`, so compute the path first:

  ```rust
  let auth_file = home.join("mcp-auth.json");
  (
      McpManager::new(home, project, None).with_auth_file(auth_file),
      dir,
  )
  ```

  so no `tool.rs` test can ever read the developer's real `mcp-auth.json`. A **skipped** server is `{"dead": { "url": "http://127.0.0.1:1/mcp" }}` (a NON-OAuth url → no token logic → the connect fails instantly → `Error` state; the same dead-port trick as `status_shows_the_error_state`).

  - `the_skip_reason_names_the_state_and_the_action` — a pure test of `skip_reason`: `&McpState::NeedsAuth` → `"NeedsAuth — use the auth action"`; `&McpState::Error { text: "boom".into() }` → `"error: boom"`; `&McpState::Connecting` → contains `"not usable"` **and** the passed-in error text (the stdio case).
  - `the_skipped_note_matches_the_issue_example` — a pure test pinning the issue's exact string:
    `assert_eq!(format!("Tool not found: X{}", skipped_note(&[("atlassian".to_string(), skip_reason(&McpState::NeedsAuth, "ignored"))])), "Tool not found: X. Skipped servers: atlassian (NeedsAuth — use the auth action)");` and `assert_eq!(skipped_note(&[]), "")`.
  - `a_skipped_server_fails_the_bare_call_and_names_it` — servers `{"ok": "fake", "dead": {…dead url…}}`; `mcp_tool(&mut m, &json!({"tool": "nope"}), &cancel())` → `assert!(r.is_error, "a partial server set is not a successful 'not found'")`; the text contains `"Tool not found: nope"`, `"Skipped servers:"` and `"dead"`.
  - `describe_fails_and_names_a_skipped_server` — same servers, `{"describe": "nope"}` → `is_error`, names `dead`.
  - `search_fails_and_names_a_skipped_server` — same servers, `{"search": "zzz"}` → `is_error`, text contains `No tools matching "zzz"` and names `dead`.
  - `a_plain_not_found_is_still_a_success_when_every_server_answered` — servers `{"a": "fake"}` only; `{"tool": "nope"}` → `assert!(!r.is_error)` and `assert_eq!(text(&r), "Tool not found: nope")` (pins the unchanged wording AND that the happy path stays a success).
  - `a_call_on_a_healthy_server_is_not_broken_by_a_skipped_one` — servers `{"ok": "fake", "dead": {…}}`; `{"tool": "echo", "args": {"text": "hi"}}` → `!is_error`, text `"hi"` (the rule must not over-apply).
  - Keep `search_no_match` and `describe_shows_the_schema` untouched (all-servers-healthy paths).

- [ ] **Run `cargo test --lib agent::mcp::tool`** — the three branch tests fail with `assert!(r.is_error)` (today they return `ok`), the two pure-helper tests fail to compile (`cannot find function skip_reason`). If a branch test passes early, it is not creating a genuinely skipped server — stop.
- [ ] **Implement §3** (`Collected`, `skip_reason`, `skipped_note`, `collect_tools`, the three `fail(...)` sites, the doc comments, the `McpState` import).
- [ ] **Run `cargo test --lib agent::mcp::tool`** — all pass.
- [ ] **Run `cargo test`** from `src-tauri/` (full — this task is serial and the crate is one compilation unit). Baseline at `c71bb7b`: **1363 passed / 0 failed / 4 ignored**. This plan adds **12** tests (7 in `tool.rs`, 1 in `oauth.rs`, 4 in `manager.rs`) → expect **1375 / 0 / 4**. If the number differs, count your own tests; never edit an assertion to hit a number.
- [ ] **Run `cargo clippy --all-targets -- -D warnings`** — 0 warnings. Watch for: `dead_code` if `stored_token_provider` was left behind; a needless-borrow / `redundant_clone` lint on the `auth_file.clone()` in `authenticate` (it is required — a `&self` arg against a `&mut self` receiver — so keep it and silence the lint only if clippy actually objects, with a comment, not an `#[allow]` reflex); `clippy::type_complexity` on the new fake's 4-tuple (if it fires, return a small named `struct` rather than adding `#[allow]`).
- [ ] **Run `cargo fmt --all -- --check`** — exit 0 (run `cargo fmt` if not).
- [ ] **Run `pnpm test` and `pnpm build`** from the repo root — no frontend file changes; baseline 3051 tests / 149 files, build exit 0.
- [ ] **Commit** with exactly: `fix(mcp): a skipped server fails the call instead of reporting 'not found', and expired tokens refresh (#68)`

---

## Acceptance criteria

- [ ] `mcp({ tool: "X" })` with no `server` param, when no reachable server has `X` **and** at least one server was skipped, returns `is_error: true` with text `Tool not found: X. Skipped servers: <name> (<state note>)` — the `NeedsAuth` note is byte-exactly `NeedsAuth — use the auth action`. Proven by `a_skipped_server_fails_the_bare_call_and_names_it` + `the_skipped_note_matches_the_issue_example`.
- [ ] `describe` behaves identically (`describe_fails_and_names_a_skipped_server`), and `search` fails with `No tools matching "q"` + the same suffix (`search_fails_and_names_a_skipped_server`) — `search`'s inclusion is a declared decision, not scope creep.
- [ ] When **every** server answered, the wording is byte-identical to today's and the result stays a **success** (`a_plain_not_found_is_still_a_success_when_every_server_answered`).
- [ ] A successful call is never downgraded by an unrelated skipped server (`a_call_on_a_healthy_server_is_not_broken_by_a_skipped_one`); the `server`-param branch and `call_tool` are untouched (`git diff` shows no change to those branches).
- [ ] A stored token with `expires_at` in the past (or inside the 60 s margin) triggers exactly one `refresh_token` grant, the refreshed token is the one sent, and the refreshed entry is **written back** to the credentials file; the server ends up `Connected`, never `NeedsAuth`. Proven by `an_expired_token_is_refreshed_and_persisted_instead_of_needs_auth`.
- [ ] A failed refresh writes nothing and lands the server in `NeedsAuth` with the existing `requires authentication` message (`a_failed_refresh_lands_in_needs_auth`); `expires_at: None` never triggers a refresh call (`a_token_without_an_expiry_is_never_refreshed`).
- [ ] **ADR 0015 holds**: a stored entry with no `client_secret` makes **zero** auth-server requests and degrades to `NeedsAuth` (→ the interactive `auth` action) — `a_public_client_is_never_auto_refreshed_end_to_end`, plus the untouched `oauth::refresh` guard tests.
- [ ] `McpManager::new`'s signature is unchanged and `agent/harness/loop.rs` is untouched; no test reads or writes `oauth::auth_file_path()` (every token test uses `with_auth_file`; `tool.rs`'s `manager_with` points the field at its temp dir).
- [ ] T4's work is intact: `callback.rs` is not in the diff, `authenticate_with`'s signature is unchanged, and `authenticating_clears_the_needs_auth_state` passes **unmodified**.
- [ ] Gate green: `cargo test` (1375 / 0 / 4 expected), `cargo clippy --all-targets -- -D warnings` (0), `cargo fmt --all -- --check`, `pnpm test` (3051 / 149), `pnpm build`. No `Cargo.toml` / `Cargo.lock` / `src/` / `tool_specs.rs` diff.

## Recorded while planning — hand these to the follow-ups doc (do not fix here)

1. `http.rs` sends an OAuth access token with **no `Bearer ` prefix** (`AuthSpec::Bearer` frames it; the OAuth provider's value goes out raw). Spec-strict auth servers reject that, so MCP OAuth may be broken against real providers for a reason unrelated to #68.
2. **Mid-session expiry**: the provider closure is frozen at connect time and a mid-session 401 leaves `state == Connected` (only `ensure_connected` maps `needs-auth` → `NeedsAuth`). Needs a 401→refresh→retry inside `http.rs`.
3. A **stdio** connect failure propagates with `?` and never sets `Error { text }`, so that server sits in `Connecting` and `status` never reports why (item 1's `skip_reason` fallback covers the symptom).
4. Refresh-token **rotation**: an entry refreshed by a server that omits `refresh_token` in the response loses its refresh token on persist.
5. `authenticate_server` (the Settings path) still uses `oauth::auth_file_path()` directly and has no manager entry to correct — the session-vs-Settings gap T4 recorded.
