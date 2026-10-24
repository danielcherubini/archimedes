---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 46
done-when: After an agent runs `mcp({action:"auth", server:X})` and it reports `authenticated`, the very next tool call against X is no longer rejected by the "the server is in a NeedsAuth state (use the `connect` / `auth` action)" guard; and the browser tab the OAuth redirect lands in renders the "you can close this tab" page instead of a browser protocol error.
---

# Task 4 — MCP OAuth: the callback answers as HTTP, and auth clears `NeedsAuth` (issue #46)

**Goal:** Two independent bugs in the MCP OAuth path: the local callback server writes a bare HTML body with no HTTP response framing, and `McpManager::authenticate` leaves the entry in `McpState::NeedsAuth` after a successful token exchange, so the server stays unusable for the rest of the session.

**Architecture:** Both fixes are inside `src-tauri/src/agent/mcp/`. Bug 1 is fixed in `callback.rs` by framing every response the callback server sends (success and rejection) as a real `HTTP/1.1` response. Bug 2 is fixed in `manager.rs` by making `authenticate` clear the connection **and** the state (the `close_all` shape), reached through one new private seam (`authenticate_with`) that takes the credentials-file path so the flow is testable without touching the user's real `mcp-auth.json`.

**Tech Stack:** Rust 2021, `tokio` (`tokio::net` raw sockets — no HTTP framework is added), `tokio_util::sync::CancellationToken`, existing in-module raw-HTTP test fakes.

---

## Parallelisation

**Verdict:** SERIAL — this is one task of the issue-triage backlog, and per the parent roadmap both files it touches (`src-tauri/src/agent/mcp/callback.rs`, `src-tauri/src/agent/mcp/manager.rs`) are Rust sources in `archimedes`, which is a **single compilation unit**: any concurrent `.rs` edit in the tree makes this task's `cargo test` / `cargo clippy` fail to compile, so scoped verification cannot hold next to a sibling. The parent doc already put T4 in the serial column ("Two Rust tasks never share a wave"); T7 runs later and needs this task landed in `manager.rs`.

Consequence for the executor: **run the FULL gate** (`cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/`; `pnpm test`, `pnpm build` from the repo root), not a scoped test run. A scoped `cargo test --lib <filter>` still compiles the whole crate here, so there is nothing to gain from scoping.

---

## Context — why this exists, and what was verified against the tree

Issue #46 reports two things an agent hits in one session: the browser tab opened for OAuth shows a protocol error, and after the `auth` action reports success the server is still dead.

### Bug 1 — `callback.rs` writes bytes, not a response

`CallbackServer::wait` (`src-tauri/src/agent/mcp/callback.rs`) accepts one connection, parses the request line, and on success does:

```rust
let html = "<!doctype html><meta charset=\"utf-8\"><title>Authenticated</title>\
           <body><h1>Success</h1><p>You can close this tab and return to Archimedes.</p></body>";
let _ = stream.write_all(html.as_bytes()).await;
```

There is no status line and no headers, so the browser reads a malformed HTTP response and shows its own protocol error instead of the landing page.

Verified facts the plan depends on:

- **Nothing in the test module observes the response today.** The helper `send_callback(port, path_and_query)` returns `std::io::Result<()>` and only *writes* the request; its two callers (`a_matching_state_returns_the_code`, `a_mismatched_state_is_an_error`) `await` it and then assert only on the `wait()` result. So a test that asserts the response bytes is genuinely new coverage, not a duplicate.
- **The rejection paths write nothing at all.** After the stream is accepted, four branches `return Err(...)` without writing a single byte: `"the callback request has no query"`, `"the callback has no \`code\`"`, `"the callback has no \`state\`"`, and `"the callback \`state\` does not match (a possible CSRF)"`. In each of them a browser tab is sitting on an open connection waiting for a reply; it gets a dropped socket instead. **Decision: these get headers too (a `400 Bad Request`).** They are the same user-visible defect (a browser protocol error during a real auth), the fix is the same one-line helper call, and the returned error strings stay byte-identical, so nothing downstream changes. The timeout and cancel branches are **not** touched — they return before `accept()` completes, so there is no stream to answer on.
- **The in-repo precedent for the exact response shape** already exists twice: `oauth.rs`'s `mock_oauth_server` builds `"HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}"`, and `http.rs`'s test helper `http_response(status, headers, body)` does the same. Mirror that shape; add no HTTP dependency to `Cargo.toml`.
- **The bug is observable in an existing test that swallows it:** `oauth.rs`'s `the_full_authorization_code_flow` drives the callback with `let _ = client.get(callback_url).send().await;` — a reqwest request that FAILS to parse today's headerless reply, and whose result is discarded. After the fix it succeeds. That test keeps passing either way; it is evidence, not a thing to change.
- **No `flush()` is needed** — `tokio::net::TcpStream` is unbuffered (the existing code does not flush, and `wait` drops the stream on return, which closes the connection and gives the client EOF).

### Bug 2 — `McpManager::authenticate` never clears `NeedsAuth`

In `src-tauri/src/agent/mcp/manager.rs`, `authenticate` ends with:

```rust
if let Some(entry) = self.servers.get_mut(name) {
    entry.client = None;
}
Ok(format!("{name}: authenticated"))
```

`entry.state` is left as it was. If the server reached `McpState::NeedsAuth` during a lazy connect, it stays there, and `ensure_connected` refuses to retry it:

```rust
if matches!(entry.state, McpState::NeedsAuth | McpState::Error { .. }) {
    return Err(format!(
        "the server is in a {state:?} state (use the `connect` / `auth` action)",
        state = entry.state
    ));
}
```

so the next `call_tool` / `list_tools` fails even though valid credentials are now on disk. The existing test `a_needs_auth_server_is_not_auto_retried` asserts that guard fires — this task must not break it; the guard is correct, it is `authenticate` failing to leave the state.

**Decision: option (a) — reset the state to `Disconnected` and let the next `ensure_connected` reconnect. Do NOT eagerly reconnect to `Connected`.** Reasons:

1. **Honesty of the reported state.** `authenticate` would have to duplicate `ensure_connected`'s entire connect arm (stdio vs HTTP, the `needs-auth` → `NeedsAuth` transition, the failure → `Error { text }` transition) to reconnect eagerly, and any failure there leaves it guessing what to report. `Disconnected` is the one thing it *knows* is true. `ensure_connected` from `Disconnected` already does the right thing: it calls `stored_token_provider(name)`, which reads the token `authenticate` just wrote, and lands on `Connected` — or on `NeedsAuth` / `Error { text }` honestly if the fresh token is rejected.
2. **It is the shape the file already establishes.** `close_all` sets all three fields together:
   ```rust
   entry.client = None;
   entry.state = McpState::Disconnected;
   entry.tools = None;
   ```
   Copy **all three**, not two. The `tools = None` line matters here too: `ensure_connected` does NOT clear `entry.tools` when it reconnects, and `list_tools` returns `entry.tools` when it is `Some`. Today, re-authenticating a server that was previously `Connected` drops its client but keeps the stale cached `tools/list` forever — the same class of stuck-after-auth bug, fixed by the same three lines.
3. **`authenticate_server` (the Settings-UI entry point, a free function in the same file) needs nothing.** It takes `(server_name, &ServerDef)` and has **no manager entry to update** — there is no per-session `McpManager` behind the Settings page, so state correctness there is not its business and there is nothing to clear. Its return string (`"{server_name}: authenticated"`) is asserted by the frontend mock in `src/components/settings/SettingsPage.test.tsx` and stays untouched. **Recorded, not fixed:** authenticating from Settings while a live session holds the same server in `NeedsAuth` still leaves that session stuck — closing it needs an IPC → session-manager handle plumbed into `commands/settings.rs::auth_mcp_server`, which is outside this task's files (and `manager.rs` is T7's next seam). Do not reach for it here.

### The one seam the manager test needs (and why nothing else will work)

Read `manager.rs`'s `mod tests` before writing the test: the fakes that exist are `manager_with(home_json, project_json)` (writes a temp `.pi/agent/mcp.json` and builds a real `McpManager`), `start_401_server()` (a raw-HTTP server that answers every request with `401`, which is what drives a real `NeedsAuth` in `a_needs_auth_server_is_not_auto_retried`), and the `target/debug/fake_mcp_stdio` binary. There is **no** OAuth mock in `manager.rs`, and `oauth.rs`'s `mock_oauth_server` is private to that module's `mod tests`.

`McpManager::authenticate` as written cannot be driven from a test at all: it hardcodes `production_open_browser` (which launches a real browser via `crate::open::open`) and writes to `oauth::auth_file_path()` (the **real** `dirs::data_dir()/archimedes/mcp-auth.json`). A test that called it would open a browser and clobber the developer's stored tokens. So:

- **Add one private seam**: `async fn authenticate_with(&mut self, name: &str, cancel: &CancellationToken, auth_file: &Path) -> Result<String, String>` holding the current body of `authenticate`, with `oauth::auth_file_path()` replaced by `auth_file` (both the `load_credentials` and the `save_credentials` call). `authenticate` becomes `self.authenticate_with(name, cancel, &oauth::auth_file_path()).await`. No public API changes; `tool.rs` (the `action: "auth"` caller) and `authenticate_server` are untouched.
- The test uses `grantType: "client_credentials"`, which is the **one OAuth grant that needs no browser and no callback server**: `oauth::authenticate`'s `client_credentials` arm never calls `open_browser` and never binds a `CallbackServer`. That is why `open_browser` does NOT need to become a parameter. Keep `oauth::auth_file_path()` public and unchanged.
- **Do not** add a seam to `stored_token_provider` / `ensure_connected` to redirect the token *read*. Proving "the reconnect picks up the fresh token" is out of this task's bar (the parent roadmap's T7 owns token expiry/refresh in `manager.rs` and will need that seam); the acceptance bar here is that the stuck state is cleared and the guard stops firing.

---

## Files

- Modify: `src-tauri/src/agent/mcp/callback.rs` (the response framing + two new tests + a response-reading test helper)
- Modify: `src-tauri/src/agent/mcp/manager.rs` (the `authenticate` / `authenticate_with` split + the state reset + one new test + a mock auth server)

No other file changes. Nothing in `src/` (frontend) changes — `McpSection.tsx`'s `needs-auth` check reads the **Test** action's error text, which this task does not alter. No `Cargo.toml` change (no new dependency; the framing is `format!`).

---

## What to implement

### 1. `callback.rs` — answer as HTTP

Add a module-level helper (next to `url_decode`) and use it for **every** byte the server writes to an accepted stream:

```rust
/// Write a minimal `HTTP/1.1` response (status line + `Content-Type` +
/// `Content-Length` + `Connection: close` + a blank line + the body). A
/// browser reading a bare body reports a protocol error, so the framing is
/// the whole point of the page existing.
async fn write_response(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // A failed write is not an error worth failing the auth flow for — the
    // user may have closed the tab the moment it redirected.
    let _ = stream.write_all(response.as_bytes()).await;
}

/// Answer a rejected callback with a `400` (the tab is waiting for a reply —
/// silence reads as a broken server) and hand the SAME error text back to the
/// caller so the surfaced message does not change.
async fn reject(stream: &mut tokio::net::TcpStream, reason: &str) -> String {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Not authorized</title>\
         <body><h1>Not authorized</h1><p>{reason}</p></body>"
    );
    write_response(stream, "400 Bad Request", &body).await;
    reason.to_string()
}
```

Then in `wait`:

- Replace the success write with `write_response(&mut stream, "200 OK", html).await;` — **keep the `html` string byte-for-byte as it is** (the `\`-continued literal is one line; its `.len()` is what goes in `Content-Length`, computed by the helper, never hardcoded).
- Replace each of the four post-accept `return Err("<msg>".to_string());` with `return Err(reject(&mut stream, "<msg>").await);` — `reject` returns the `String`, so it goes INSIDE `Err(…)`; writing `return reject(…).await;` does not typecheck. Keep the four messages **byte-identical**: `the callback request has no query`, ``the callback has no `code` ``, ``the callback has no `state` ``, ``the callback `state` does not match (a possible CSRF)``.
- Do **not** touch the timeout branch (`"the OAuth callback timed out"`), the cancel branch (`"cancelled"`), the accept-failure branch, or the pre-`accept()` signature — no stream exists yet in those.
- Update the doc comment on `wait` that says "the response is a \"success — you can close this tab\" page" to say the reply is a framed `HTTP/1.1 200` page and a rejection is a framed `400`.

Do not add `flush()`, do not parse the request further, do not add keep-alive, do not serve `/favicon.ico`, do not add an HTTP crate.

### 2. `manager.rs` — leave `NeedsAuth` on a successful auth

Split `authenticate` into a thin public wrapper over a private path-taking body:

```rust
pub async fn authenticate(&mut self, name: &str, cancel: &CancellationToken) -> Result<String, String> {
    self.authenticate_with(name, cancel, &oauth::auth_file_path()).await
}

/// The body of `authenticate` with the credentials path injected (the test
/// seam — a test writes a temp `mcp-auth.json`, never the developer's).
async fn authenticate_with(
    &mut self,
    name: &str,
    cancel: &CancellationToken,
    auth_file: &Path,
) -> Result<String, String> {
    /* the current body, verbatim, except the two `oauth::auth_file_path()`
       calls become `auth_file` */
}
```

`Path` is already imported in `manager.rs` (`use std::path::{Path, PathBuf};`). Keep the `"{name}: authenticated"` return string unchanged (`tool.rs` surfaces it verbatim to the model).

Change the tail of the flow from `entry.client = None` to the `close_all` shape:

```rust
// Authenticated: drop the connection AND the state so the next
// `ensure_connected` reconnects with the stored token (a `NeedsAuth` state
// is never auto-retried, so leaving it here would keep the server dead for
// the rest of the session), and drop the cached `tools/list` (the tool set
// can change with the identity — and `ensure_connected` does not clear it).
if let Some(entry) = self.servers.get_mut(name) {
    entry.client = None;
    entry.state = McpState::Disconnected;
    entry.tools = None;
}
```

Update `authenticate`'s doc comment: it currently claims "and reconnects", which was never true — say it drops the connection so the next use reconnects with the fresh token.

Leave `authenticate_server`, `test_server`, `close_all`, `ensure_connected`, `connect`, and the `NeedsAuth`/`Error` guard in `ensure_connected` exactly as they are.

---

## Steps

- [ ] **Write the failing callback test** in `src-tauri/src/agent/mcp/callback.rs`'s `mod tests`. Add a sibling helper next to the existing `send_callback` (leave `send_callback` alone — `a_matching_state_returns_the_code` and `a_mismatched_state_is_an_error` use it):

  ```rust
  /// Send a raw callback request AND read the whole reply (until EOF — the
  /// server answers with `Connection: close` and drops the stream). Nothing
  /// observed the response bytes before this helper existed.
  async fn callback_response(port: u16, path_and_query: &str) -> String {
      let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.expect("connects");
      let req = format!("GET {path_and_query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
      stream.write_all(req.as_bytes()).await.expect("sends");
      let mut buf = Vec::new();
      stream.read_to_end(&mut buf).await.expect("reads to EOF");
      String::from_utf8_lossy(&buf).to_string()
  }
  ```

  Do NOT add a `use tokio::io::…` inside the helper or the test module: `callback.rs` already imports `AsyncReadExt` + `AsyncWriteExt` at module level and `mod tests` does `use super::*;`, so both traits are already in scope (a second `use` of the same trait in the same module is an `E0252` "defined multiple times" error, not a warning).

  Then two tests, each binding a real `CallbackServer` and spawning `wait` exactly the way `a_matching_state_returns_the_code` does (50 ms sleep, then fire):

  - `the_success_page_is_a_well_formed_http_response` — send `/callback?code=the-code&state=the-state`, `await` the `wait` handle and keep asserting it returns `Ok(CallbackResult { code: "the-code" })` (the fix must not break the flow), then assert on the reply:
    - `response.starts_with("HTTP/1.1 200 OK\r\n")`
    - it contains `Content-Type: text/html; charset=utf-8` and `Connection: close`
    - split at the first `\r\n\r\n`; parse the `Content-Length:` header value and assert it **equals the byte length of the body after the separator** (self-consistency — do not hardcode the HTML length);
    - the body contains `You can close this tab`.
  - `a_rejected_callback_answers_http_400` — send `/callback` (no query), assert the `wait` result is `Err` and that its message still contains `no query`, and assert the reply `starts_with("HTTP/1.1 400 Bad Request\r\n")` and carries the same `Content-Type` / `Content-Length` / `Connection: close` headers (the same split-and-compare assertion is fine).

- [ ] **Run `cargo test --lib agent::mcp::callback`** from `src-tauri/`.
  - Both new tests must FAIL, and the success one must fail on the response assertions (`assertion failed: response.starts_with("HTTP/1.1 200 OK")`), **not** on a compile error or on the `wait()` result. `a_rejected_callback_answers_http_400` fails because the reply is empty (`read_to_end` returns 0 bytes). If they pass, stop — the helper is not reading what the server wrote.
- [ ] **Implement the `callback.rs` change** (`write_response`, `reject`, the five call sites, the doc touch).
- [ ] **Run `cargo test --lib agent::mcp::callback`** again — the two new tests AND all five pre-existing ones (`a_matching_state_returns_the_code`, `a_mismatched_state_is_an_error`, `a_timeout_is_an_error`, `a_cancel_is_an_error`, `url_decode_handles_percent_encoding`) pass.
- [ ] **Write the failing manager test** in `src-tauri/src/agent/mcp/manager.rs`'s `mod tests`. Add the OAuth-side fake first (mirroring `oauth.rs`'s private `mock_oauth_server` shape — route by the request path; `test_support::raw_json_server` serves ONE body for every path and therefore cannot be reused here):

  ```rust
  /// A minimal OAuth auth server for the `client_credentials` grant: the
  /// well-known metadata (pointing at its own `/token`) + a token endpoint.
  /// `client_credentials` is the one grant that needs NO browser and NO local
  /// callback, so this is all `oauth::authenticate` talks to.
  async fn start_auth_server() -> (String, tokio::task::JoinHandle<()>) { /* http://{addr} base */ }
  ```
  Routes: `/.well-known/oauth-authorization-server` → `200` JSON `{"authorization_endpoint":"http://127.0.0.1:<port>/authorize","token_endpoint":"http://127.0.0.1:<port>/token"}`; `/token` → `200` JSON `{"access_token":"mock-access-token","expires_in":3600}`; anything else → `404`. Build each reply with the same `HTTP/1.1 …\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}` framing the module's other fakes use.

  Then the test:

  ```rust
  #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
  async fn authenticating_clears_the_needs_auth_state() { … }
  ```

  Shape (each piece is a fake that already exists in this module — do not invent others):
  1. `let (mcp_url, mcp_server) = start_401_server().await;` and `let (auth_base, auth_server) = start_auth_server().await;`
  2. Build the manager with `manager_with(&serde_json::json!({ "mcpServers": { "a": { "url": mcp_url, "auth": { "grantType": "client_credentials", "clientId": "test-cid", "authorizationServerUrl": auth_base } } } }).to_string(), None)` — `classify_auth` accepts that object (`grantType: "client_credentials"` is one of the two valid grants) and yields `AuthSpec::OAuth`.
  3. Drive it to the stuck state the way `a_needs_auth_server_is_not_auto_retried` does: one `call_tool` → `assert_eq!(manager.status_lines(), vec!["a: NeedsAuth"]);`
  4. `let dir = tempfile::tempdir().expect("a temp dir"); let auth_file = dir.path().join("mcp-auth.json");` and `manager.authenticate_with("a", &cancel, &auth_file).await.expect("the client_credentials flow completes")` → assert it equals `"a: authenticated"`.
  5. `assert_eq!(manager.status_lines(), vec!["a: Disconnected"], "auth leaves the server reconnectable, not stuck in NeedsAuth");`
  6. Assert the token landed in the injected file: `assert_eq!(oauth::load_credentials(&auth_file).get("a").map(|s| s.token.as_str()), Some("mock-access-token"));`
  7. The guard assertion — a second `call_tool` (the 401 fake still answers `401` to everything, so this attempt fails):
     - `assert!(!e.contains("the server is in a"), "the not-auto-retried guard must not fire after auth: {e}");` — `"the server is in a …"` is the guard message's unique prefix, so this is the precise discriminator;
     - `assert!(e.contains("requires authentication"), "a real connect attempt was made: {e}");` — the fresh-attempt message (`"the server requires authentication (use the \`auth\` action)"`), proving the call got past the guard and actually tried to connect;
     - `assert_eq!(manager.status_lines(), vec!["a: NeedsAuth"], "a rejected reconnect re-marks NeedsAuth honestly");`
     These hold regardless of what is on the machine: the reconnect's `stored_token_provider` still reads the REAL `oauth::auth_file_path()` (see the caveat below), so it may or may not find a token — but `HttpClient::send_request` maps a 401 on an OAuth server to `"needs-auth"` whether or not an `Authorization` header was sent, so the branch and its message are the same either way. Do not "improve" this by asserting on which token was sent.
  8. `mcp_server.abort(); auth_server.abort();`

  The test mutates no environment variable and never touches `oauth::auth_file_path()` for WRITES — that is what the `auth_file` parameter buys, and it is why the test is safe to run on a developer machine with real stored tokens. **Honest caveat to state in the test's comment:** the *read* side is still the real path — `ensure_connected` calls `stored_token_provider(name)`, which calls `oauth::auth_file_path()` itself, so the token written to the temp file is what step 6 asserts on, not what step 7's reconnect sends. Redirecting that read needs a second seam and belongs to T7 (token expiry/refresh in `manager.rs`); the bar here is only "the stuck state is cleared and the guard stops firing", which step 7 proves.

  Import note: `mod tests` already has `use super::*;`, so `oauth`, `McpState`, `ServerDef`, `AuthSpec`, `Duration`, `CancellationToken` and `manager_with` are in scope. `HttpDef` / `StdioDef` come from the module's existing `use super::super::types::{HttpDef, StdioDef};` — do not add a duplicate `use`, and do not add a `use tokio::io::…` (the module's existing `use tokio::io::{AsyncReadExt, AsyncWriteExt};` inside `mod tests` already covers the mock server's socket reads).

- [ ] **Run `cargo test --lib agent::mcp::manager`** — `authenticating_clears_the_needs_auth_state` fails to compile (`no method authenticate_with`); after adding the seam but before the state reset it fails at step 5 with `left: ["a: NeedsAuth"], right: ["a: Disconnected"]`. If it passes before the reset, the test is not observing the state — stop and fix the test.
- [ ] **Implement the `manager.rs` change** (the split, the three-field reset, the doc touch).
- [ ] **Run `cargo test --lib agent::mcp::manager`** — the new test and every pre-existing one pass, above all `a_needs_auth_server_is_not_auto_retried` (the guard still fires when nothing cleared the state) and `close_all_disconnects`.
- [ ] **Run `cargo test`** from `src-tauri/` (full — this task runs serial, and `archimedes` is one compilation unit so nothing is gained by scoping). Baseline from the parent doc: 1355 passed / 0 failed / 4 ignored; expect +3.
- [ ] **Run `cargo clippy --all-targets`** — 0 warnings. Watch for `unused_async` on the helpers and for a needless-borrow lint on `&mut stream` at the `reject` / `write_response` call sites.
- [ ] **Run `cargo fmt --check`** — exit 0 (run `cargo fmt` if not).
- [ ] **Run `pnpm test` and `pnpm build`** from the repo root — no frontend file changes, but the gate is the gate (baseline 149 files / 3049 tests).
- [ ] **Commit** with exactly: `fix(mcp): the OAuth callback answers as HTTP, and auth clears NeedsAuth (#46)`

---

## Acceptance criteria

- [ ] `CallbackServer::wait` answers the browser with a framed response: the success page starts with `HTTP/1.1 200 OK\r\n` and carries `Content-Type: text/html; charset=utf-8`, a `Content-Length` equal to the body's byte length, `Connection: close`, and a blank line before the body. Proven by `the_success_page_is_a_well_formed_http_response`.
- [ ] The four post-accept rejection branches (no query / no `code` / no `state` / state mismatch) answer `HTTP/1.1 400 Bad Request` with the same header set, and their `Err` strings are byte-identical to before. Proven by `a_rejected_callback_answers_http_400` (the no-query branch) plus the unchanged assertions of the existing tests.
- [ ] `wait` still returns the same `Result<CallbackResult, String>` values as before for every branch (the framing is additive; `oauth.rs`'s `the_full_authorization_code_flow` still passes).
- [ ] After `authenticate` (or `authenticate_with`) returns `Ok`, the entry's `state` is `McpState::Disconnected`, `client` is `None` and `tools` is `None`; `status_lines()` reads `a: Disconnected`, never `a: NeedsAuth`. Proven by `authenticating_clears_the_needs_auth_state`.
- [ ] The next `ensure_connected` after a successful auth is NOT rejected by the "not auto-retried" guard: the error text no longer contains `"the server is in a"` and instead shows a real connect attempt. Proven by the same test.
- [ ] `a_needs_auth_server_is_not_auto_retried` still passes unchanged — the guard itself was not weakened.
- [ ] `McpManager::authenticate_server` is unchanged in behaviour and return string, and `commands/settings.rs::auth_mcp_server` plus `src/components/settings/SettingsPage.test.tsx` are untouched.
- [ ] No test writes to `oauth::auth_file_path()`; the new manager test injects a temp credentials path via `authenticate_with`.
- [ ] Gate green: `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` in `src-tauri/`; `pnpm test`, `pnpm build` at the root. No `Cargo.toml` / `Cargo.lock` / frontend diff.
