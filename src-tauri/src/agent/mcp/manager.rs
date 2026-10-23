//! The MCP server manager (ADR 0018): one per `AgentLoop` (constructed with
//! the space `cwd`); `server → (def, state, client)`; lazy connect on first
//! use; `tools/list` cached per connection; `connect` / `status` / `auth` /
//! `close` actions; a failed connect is `Error { text }` / `NeedsAuth`
//! (never silently dropped).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::config::load_servers;
use super::http::{HttpClient, TokenProvider};
use super::oauth;
use super::stdio::StdioClient;
use super::types::{AuthSpec, McpState, ServerDef, ToolCallResult, ToolInfo};
use crate::config::load_settings;

/// A connected MCP server (a stdio or HTTP client — the unified interface
/// the manager routes `list_tools` / `call_tool` through).
enum Client {
    Stdio(StdioClient),
    Http(HttpClient),
}

impl Client {
    /// `tools/list` (the `timeout` is the stdio bound; an HTTP client uses
    /// its own `read_timeout` — the `timeout` is ignored).
    async fn list_tools(
        &mut self,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Vec<ToolInfo>, String> {
        match self {
            Client::Stdio(c) => c.list_tools(timeout, cancel).await,
            Client::Http(c) => c.list_tools(cancel).await,
        }
    }

    /// `tools/call` (the `timeout` is the stdio bound; an HTTP client uses
    /// its own `read_timeout` — the `timeout` is ignored).
    async fn call_tool(
        &mut self,
        name: &str,
        args: &Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<ToolCallResult, String> {
        match self {
            Client::Stdio(c) => c.call_tool(name, args, timeout, cancel).await,
            Client::Http(c) => c.call_tool(name, args, cancel).await,
        }
    }
}

/// A manager's per-server entry (the def + the connection state + the
/// connected client (if any) + the cached `tools/list`).
struct ServerEntry {
    def: ServerDef,
    state: McpState,
    client: Option<Client>,
    tools: Option<Vec<ToolInfo>>,
}

/// The MCP server manager (one per `AgentLoop`).
pub struct McpManager {
    servers: BTreeMap<String, ServerEntry>,
    project_cwd: PathBuf,
}

impl McpManager {
    /// Create a manager (load the servers from the config — Task 1's
    /// `load_servers`: global `~/.pi/agent/mcp.json` + the desktop
    /// `settings.json` `mcpServers` (ADR 0019 — `config_dir: None` =
    /// absent) + project `<cwd>/.pi/mcp.json`).
    pub fn new(home_dir: PathBuf, project_cwd: PathBuf, config_dir: Option<&Path>) -> Self {
        // (ADR 0019) The desktop layer: the `settings.json` `mcpServers`
        // (best-effort — a missing / corrupt file is the `load_settings`
        // defaults = an empty map). Merged at global precedence (project
        // > desktop > global).
        let desktop = config_dir.map(|d| load_settings(d).mcp_servers);
        let servers = load_servers(&home_dir, &project_cwd, desktop.as_ref())
            .into_iter()
            .map(|(name, def)| {
                (
                    name,
                    ServerEntry {
                        def,
                        state: McpState::Disconnected,
                        client: None,
                        tools: None,
                    },
                )
            })
            .collect();
        Self {
            servers,
            project_cwd,
        }
    }

    /// The server names (for the tests / the `status` action).
    pub fn server_names(&self) -> Vec<String> {
        self.servers.keys().cloned().collect()
    }

    /// The `mcp({})` / `action: "status"` output: `<name>: <state>[
    /// (<error>)]` per server, or `No MCP servers configured.` when empty.
    pub fn status_lines(&self) -> Vec<String> {
        if self.servers.is_empty() {
            return vec!["No MCP servers configured.".to_string()];
        }
        self.servers
            .iter()
            .map(|(name, entry)| match &entry.state {
                McpState::Error { text } => format!("{name}: error ({text})"),
                other => format!("{name}: {other:?}"),
            })
            .collect()
    }

    /// Lazy connect (the first `list_tools` / `call_tool` connects; a
    /// `NeedsAuth` / `Error` state is NOT auto-retried — an explicit
    /// `connect` / `auth` is required).
    async fn ensure_connected(
        &mut self,
        name: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(), String> {
        let entry = self
            .servers
            .get_mut(name)
            .ok_or_else(|| format!("unknown MCP server: {name}"))?;
        if entry.client.is_some() {
            return Ok(()); // already connected.
        }
        // A `NeedsAuth` / `Error` state is NOT auto-retried.
        if matches!(entry.state, McpState::NeedsAuth | McpState::Error { .. }) {
            return Err(format!(
                "the server is in a {state:?} state (use the `connect` / `auth` action)",
                state = entry.state
            ));
        }
        entry.state = McpState::Connecting;
        let client = match &entry.def {
            ServerDef::Stdio(def) => {
                Client::Stdio(StdioClient::connect(def, &self.project_cwd, timeout, cancel).await?)
            }
            ServerDef::Http(def) => {
                // An OAuth server: a `TokenProvider` (the stored token, if
                // any; `None` → a 401 → `NeedsAuth`).
                let get_token = if matches!(def.auth, AuthSpec::OAuth { .. }) {
                    stored_token_provider(name)
                } else {
                    None
                };
                match HttpClient::connect(def, timeout, cancel, get_token).await {
                    Ok(c) => Client::Http(c),
                    Err(e) if e == "needs-auth" => {
                        entry.state = McpState::NeedsAuth;
                        return Err("the server requires authentication (use the `auth` action)"
                            .to_string());
                    }
                    Err(e) => {
                        entry.state = McpState::Error { text: e.clone() };
                        return Err(e);
                    }
                }
            }
        };
        entry.client = Some(client);
        entry.state = McpState::Connected;
        Ok(())
    }

    /// `tools/list` (lazy connect; the result is cached per connection).
    pub async fn list_tools(
        &mut self,
        name: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<Vec<ToolInfo>, String> {
        self.ensure_connected(name, cancel, timeout).await?;
        let entry = self.servers.get_mut(name).expect("the server exists");
        if let Some(tools) = &entry.tools {
            return Ok(tools.clone());
        }
        let Some(client) = entry.client.as_mut() else {
            return Err("the server is not connected".to_string());
        };
        let tools = client.list_tools(timeout, cancel).await?;
        entry.tools = Some(tools.clone());
        Ok(tools)
    }

    /// `tools/call` (lazy connect).
    pub async fn call_tool(
        &mut self,
        name: &str,
        tool: &str,
        args: &Value,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<ToolCallResult, String> {
        self.ensure_connected(name, cancel, timeout).await?;
        let entry = self.servers.get_mut(name).expect("the server exists");
        let Some(client) = entry.client.as_mut() else {
            return Err("the server is not connected".to_string());
        };
        client.call_tool(tool, args, timeout, cancel).await
    }

    /// Eagerly connect a server (the `connect` action). An OAuth server in
    /// `NeedsAuth` is NOT authenticated here (the `auth` action is).
    pub async fn connect(
        &mut self,
        name: &str,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, String> {
        self.ensure_connected(name, cancel, timeout).await?;
        Ok(format!("{name}: connected"))
    }

    /// Run the interactive OAuth flow for a server (the `auth` action).
    /// Stores the resulting token in `mcp-auth.json` (so a subsequent
    /// `connect` / `call` uses it) and drops the connection so the NEXT use
    /// reconnects with the fresh token — no reconnect happens here.
    pub async fn authenticate(
        &mut self,
        name: &str,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        self.authenticate_with(name, cancel, &oauth::auth_file_path())
            .await
    }

    /// The body of `authenticate` with the credentials path injected (the test
    /// seam — a test writes a temp `mcp-auth.json`, never the developer's).
    async fn authenticate_with(
        &mut self,
        name: &str,
        cancel: &CancellationToken,
        auth_file: &Path,
    ) -> Result<String, String> {
        // Check it's an OAuth server + run the flow (the `def` borrow ends
        // at the block's end, so we can mutate `entry` after).
        {
            let entry = self
                .servers
                .get(name)
                .ok_or_else(|| format!("unknown MCP server: {name}"))?;
            let ServerDef::Http(def) = &entry.def else {
                return Err(format!("{name} is not an HTTP server (no OAuth)"));
            };
            if !matches!(def.auth, AuthSpec::OAuth { .. }) {
                return Err(format!("{name} is not an OAuth server"));
            }
            // The auth server URL (the config's `authorizationServerUrl`).
            let auth_server_url = match &def.auth {
                AuthSpec::OAuth {
                    authorization_server_url,
                    ..
                } => authorization_server_url.clone(),
                _ => None,
            };
            // The production `open_browser` (the platform default browser,
            // fire-and-forget; a failure is non-fatal — the URL is in the
            // result).
            let open_browser: Box<dyn Fn(&str) + Send + Sync> = Box::new(production_open_browser);
            let stored =
                oauth::authenticate(def, auth_server_url.as_deref(), cancel, &open_browser)
                    .await
                    .map_err(|e| format!("{name}: {e}"))?;
            // Store the credentials (so a subsequent `connect` / `call` uses
            // the token).
            let mut map = oauth::load_credentials(auth_file);
            map.insert(name.to_string(), stored);
            oauth::save_credentials(auth_file, &map)?;
        }
        // Authenticated: drop the connection AND the state so the next
        // `ensure_connected` reconnects with the stored token (a `NeedsAuth`
        // state is never auto-retried, so leaving it here would keep the
        // server dead for the rest of the session), and drop the cached
        // `tools/list` (the tool set can change with the identity — and
        // `ensure_connected` does not clear it).
        if let Some(entry) = self.servers.get_mut(name) {
            entry.client = None;
            entry.state = McpState::Disconnected;
            entry.tools = None;
        }
        Ok(format!("{name}: authenticated"))
    }

    /// Session teardown: kill the stdio children (dropping a `StdioClient`
    /// kills the child via `kill_on_drop`) + clear the state.
    pub fn close_all(&mut self) {
        for entry in self.servers.values_mut() {
            entry.client = None;
            entry.state = McpState::Disconnected;
            entry.tools = None;
        }
    }
}

/// A `TokenProvider` for a server's stored token (the `mcp-auth.json` entry,
/// if any; `None` → the request goes out unauthenticated → a 401 →
/// `NeedsAuth`).
fn stored_token_provider(server_name: &str) -> Option<TokenProvider> {
    let map = oauth::load_credentials(&oauth::auth_file_path());
    let stored = map.get(server_name)?;
    let token = stored.token.clone();
    Some(Box::new(move || Some(token.clone())))
}

/// A one-shot test of a server definition (the Settings page's Test
/// action, ADR 0019): build a FRESH client (bypassing the manager's
/// entries — the manager is per-session, the Settings page is not),
/// `tools/list` (bounded by `timeout`), drop the client (a stdio child is
/// `kill_on_drop`). `Ok` = the tool count; `Err` = the error text (a
/// `needs-auth` / a network failure) surfaced verbatim.
pub async fn test_server(
    server_name: Option<&str>,
    def: &ServerDef,
    project_cwd: &Path,
    timeout: Duration,
) -> Result<usize, String> {
    let cancel = CancellationToken::new();
    let tools = match def {
        ServerDef::Stdio(def) => {
            let mut client = StdioClient::connect(def, project_cwd, timeout, &cancel).await?;
            let tools = client.list_tools(timeout, &cancel).await?;
            drop(client); // kill the child.
            tools
        }
        ServerDef::Http(def) => {
            // An OAuth server: the stored token for this server, if any.
            let get_token = if matches!(def.auth, AuthSpec::OAuth { .. }) {
                server_name.and_then(stored_token_provider)
            } else {
                None
            };
            let mut client = HttpClient::connect(def, timeout, &cancel, get_token).await?;
            let tools = client.list_tools(&cancel).await?;
            drop(client);
            tools
        }
    };
    Ok(tools.len())
}

/// Run the interactive OAuth flow for a server from outside an agent session
/// (e.g. from the Settings UI). Stores the resulting token in `mcp-auth.json`.
pub async fn authenticate_server(server_name: &str, def: &ServerDef) -> Result<String, String> {
    let ServerDef::Http(http_def) = def else {
        return Err(format!("{server_name} is not an HTTP server (no OAuth)"));
    };
    if !matches!(http_def.auth, AuthSpec::OAuth { .. }) {
        return Err(format!("{server_name} is not an OAuth server"));
    }
    let auth_server_url = match &http_def.auth {
        AuthSpec::OAuth {
            authorization_server_url,
            ..
        } => authorization_server_url.clone(),
        _ => None,
    };
    let cancel = CancellationToken::new();
    let open_browser: Box<dyn Fn(&str) + Send + Sync> = Box::new(production_open_browser);
    let stored = oauth::authenticate(http_def, auth_server_url.as_deref(), &cancel, &open_browser)
        .await
        .map_err(|e| format!("{server_name}: {e}"))?;
    let mut map = oauth::load_credentials(&oauth::auth_file_path());
    map.insert(server_name.to_string(), stored);
    oauth::save_credentials(&oauth::auth_file_path(), &map)?;
    Ok(format!("{server_name}: authenticated"))
}

/// The production `open_browser` (the platform default browser, fire-and-forget;
/// a failure is non-fatal — the URL is in the result). `crate::open` is the ONE
/// External-open policy, so the per-OS `open`/`cmd /c start`/`xdg-open` block
/// that used to live here is gone: `tauri-plugin-opener` is the only place in
/// this repo that knows what each platform's opener is.
fn production_open_browser(url: &str) {
    let _ = crate::open::open(url, None);
}

#[cfg(test)]
mod tests {
    use super::super::types::{HttpDef, StdioDef};
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A temp `home_dir` + `project_cwd` with a `mcp.json` (a helper for the
    /// tests). Writes to the paths `load_servers` reads: `<home>/.pi/agent/
    /// mcp.json` (global) + `<project_cwd>/.pi/mcp.json` (project).
    fn manager_with(
        home_json: &str,
        project_json: Option<&str>,
    ) -> (McpManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let home_dir = dir.path().to_path_buf();
        let project_cwd = dir.path().to_path_buf();
        let global_path = home_dir.join(".pi/agent/mcp.json");
        std::fs::create_dir_all(global_path.parent().expect("a parent dir"))
            .expect("creates the dir");
        std::fs::write(&global_path, home_json).expect("writes the home mcp.json");
        if let Some(p) = project_json {
            let project_path = project_cwd.join(".pi/mcp.json");
            std::fs::create_dir_all(project_path.parent().expect("a parent dir"))
                .expect("creates the dir");
            std::fs::write(&project_path, p).expect("writes the project mcp.json");
        }
        (McpManager::new(home_dir, project_cwd, None), dir)
    }

    /// A `mcp.json` with a single stdio server (the fake binary).
    fn stdio_server_json(bin: &std::path::Path) -> String {
        serde_json::json!({
            "mcpServers": { "a": { "command": bin.display().to_string() } }
        })
        .to_string()
    }

    #[test]
    fn status_no_servers() {
        let (manager, _dir) = manager_with("", None);
        assert_eq!(manager.status_lines(), vec!["No MCP servers configured."]);
    }

    #[test]
    fn status_lists_the_servers_disconnected() {
        let (manager, _dir) = manager_with(
            r#"{ "mcpServers": { "a": { "url": "http://x" }, "b": { "command": "echo" } } }"#,
            None,
        );
        assert_eq!(
            manager.status_lines(),
            vec!["a: Disconnected", "b: Disconnected"]
        );
    }

    #[test]
    fn status_shows_the_error_state() {
        let (mut manager, _dir) = manager_with(
            r#"{ "mcpServers": { "a": { "url": "http://127.0.0.1:1/mcp" } } }"#,
            None,
        );
        // A connect to a dead port → an `Error` state.
        let cancel = CancellationToken::new();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = rt
            .block_on(manager.connect("a", &cancel, Duration::from_secs(2)))
            .expect_err("a dead port is an error");
        assert!(!result.is_empty(), "the error is non-empty: {result}");
        // The status is `error (...)`.
        let line = manager.status_lines()[0].clone();
        assert!(line.starts_with("a: error ("), "an error state: {line}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lazy_connect_then_reuse() {
        // A stdio server (the fake binary) — the first `call_tool` connects,
        // the second reuses (no reconnect).
        let bin = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_mcp_stdio"
        ));
        let (mut manager, _dir) = manager_with(&stdio_server_json(bin), None);
        assert_eq!(manager.server_names(), vec!["a"]);
        // The first `call_tool` connects (lazy).
        let cancel = CancellationToken::new();
        let r = manager
            .call_tool(
                "a",
                "echo",
                &serde_json::json!({ "text": "hi" }),
                &cancel,
                Duration::from_secs(5),
            )
            .await
            .expect("the first call connects + calls");
        assert_eq!(r.text, "hi");
        // The state is now `Connected`.
        assert_eq!(manager.status_lines(), vec!["a: Connected"]);
        // The second `call_tool` reuses (no reconnect) — it still works.
        let r = manager
            .call_tool(
                "a",
                "echo",
                &serde_json::json!({ "text": "again" }),
                &cancel,
                Duration::from_secs(5),
            )
            .await
            .expect("the second call reuses the connection");
        assert_eq!(r.text, "again");
        manager.close_all();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_server_a_stdio_server_reports_the_tool_count() {
        // (ADR 0019) The Settings page's Test action: a one-shot connect +
        // `tools/list` (the fake binary — three canned tools).
        let bin = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_mcp_stdio"
        ));
        let def = ServerDef::Stdio(StdioDef {
            command: bin.display().to_string(),
            args: vec![],
            env: std::collections::BTreeMap::new(),
            cwd: None,
        });
        let count = test_server(
            None,
            &def,
            std::path::Path::new("."),
            Duration::from_secs(5),
        )
        .await
        .expect("the fake server answers");
        assert_eq!(count, 3);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_server_a_dead_port_is_an_error() {
        let def = ServerDef::Http(HttpDef {
            url: "http://127.0.0.1:1/mcp".to_string(),
            headers: std::collections::BTreeMap::new(),
            auth: AuthSpec::None,
        });
        let result = test_server(
            None,
            &def,
            std::path::Path::new("."),
            Duration::from_secs(2),
        )
        .await;
        assert!(result.is_err(), "a dead port is an error");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn close_all_disconnects() {
        let bin = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_mcp_stdio"
        ));
        let (mut manager, _dir) = manager_with(&stdio_server_json(bin), None);
        let cancel = CancellationToken::new();
        manager
            .connect("a", &cancel, Duration::from_secs(5))
            .await
            .expect("connects");
        assert_eq!(manager.status_lines(), vec!["a: Connected"]);
        manager.close_all();
        // `close_all` → `Disconnected` (the client is dropped — the stdio
        // child is killed via `kill_on_drop`).
        assert_eq!(manager.status_lines(), vec!["a: Disconnected"]);
    }

    /// A raw-HTTP server that answers every request with a `401` (an OAuth
    /// server that requires a token — `None` → a 401 → `NeedsAuth`).
    async fn start_401_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the listener binds");
        let addr = listener.local_addr().expect("the listener has an address");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    // Drain the request (headers + a bit of the body — a 401
                    // doesn't care about the body).
                    let mut buf = [0u8; 8192];
                    let _ = stream.read(&mut buf).await;
                    let response =
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}/mcp"), handle)
    }

    /// A minimal OAuth auth server for the `client_credentials` grant: the
    /// well-known metadata (pointing at its own `/token`) + a token endpoint.
    /// `client_credentials` is the one grant that needs NO browser and NO local
    /// callback, so this is all `oauth::authenticate` talks to.
    async fn start_auth_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the listener binds");
        let addr = listener.local_addr().expect("the listener has an address");
        let base = format!("http://{addr}");
        let base_inner = base.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let base = base_inner.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 8192];
                    let _ = stream.read(&mut buf).await;
                    let request = String::from_utf8_lossy(&buf).to_string();
                    let path = request
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string();
                    // Route by the request path (the same shape as the
                    // `oauth.rs` mock).
                    let body = if path.starts_with("/.well-known") {
                        serde_json::json!({
                            "authorization_endpoint": format!("{base}/authorize"),
                            "token_endpoint": format!("{base}/token"),
                        })
                        .to_string()
                    } else if path.starts_with("/token") {
                        serde_json::json!({
                            "access_token": "mock-access-token",
                            "expires_in": 3600,
                        })
                        .to_string()
                    } else {
                        "{}".to_string()
                    };
                    let status = if path.starts_with("/.well-known") || path.starts_with("/token") {
                        "200 OK"
                    } else {
                        "404 Not Found"
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (base, handle)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn authenticating_clears_the_needs_auth_state() {
        // Issue #46: after the `auth` action reports `authenticated`, the
        // server must be reconnectable — a `NeedsAuth` state is never
        // auto-retried, so leaving it set keeps the server dead for the rest
        // of the session.
        //
        // Honest caveat: this test injects the credentials FILE path (so it
        // never writes the developer's real `mcp-auth.json`), but the READ
        // side is still the real path — `ensure_connected` calls
        // `stored_token_provider(name)`, which resolves `oauth::auth_file_path()`
        // itself. So step 6 asserts on what was WRITTEN, and step 7 asserts
        // only that the guard stopped firing: `HttpClient::send_request` maps
        // a 401 on an OAuth server to `needs-auth` whether or not an
        // `Authorization` header was sent, so the branch and its message are
        // the same either way. Redirecting that read is T7's seam.
        let (mcp_url, mcp_server) = start_401_server().await;
        let (auth_base, auth_server) = start_auth_server().await;
        let (mut manager, _dir) = manager_with(
            &serde_json::json!({
                "mcpServers": { "a": {
                    "url": mcp_url,
                    "auth": {
                        "grantType": "client_credentials",
                        "clientId": "test-cid",
                        "authorizationServerUrl": auth_base,
                    },
                } }
            })
            .to_string(),
            None,
        );
        let cancel = CancellationToken::new();

        // Drive the server into the stuck state (a 401 → `NeedsAuth`).
        let r = manager
            .call_tool(
                "a",
                "echo",
                &serde_json::json!({}),
                &cancel,
                Duration::from_secs(2),
            )
            .await;
        assert!(r.is_err(), "a 401 → an error: {r:?}");
        assert_eq!(manager.status_lines(), vec!["a: NeedsAuth"]);

        // Authenticate (the injected credentials path — never the real one).
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("mcp-auth.json");
        let result = manager
            .authenticate_with("a", &cancel, &auth_file)
            .await
            .expect("the client_credentials flow completes");
        assert_eq!(result, "a: authenticated");

        // The stuck state is gone: the entry is reconnectable, not `NeedsAuth`.
        assert_eq!(
            manager.status_lines(),
            vec!["a: Disconnected"],
            "auth leaves the server reconnectable, not stuck in NeedsAuth"
        );

        // The fresh token landed in the injected file.
        assert_eq!(
            oauth::load_credentials(&auth_file)
                .get("a")
                .map(|s| s.token.as_str()),
            Some("mock-access-token")
        );

        // The guard no longer fires: the 401 fake still answers `401` to
        // everything, so this attempt fails — but with a REAL connect attempt,
        // not the "not auto-retried" rejection.
        let r = manager
            .call_tool(
                "a",
                "echo",
                &serde_json::json!({}),
                &cancel,
                Duration::from_secs(2),
            )
            .await;
        let Err(e) = r else {
            panic!("the 401 server still rejects: {r:?}");
        };
        assert!(
            !e.contains("the server is in a"),
            "the not-auto-retried guard must not fire after auth: {e}"
        );
        assert!(
            e.contains("requires authentication"),
            "a real connect attempt was made: {e}"
        );
        assert_eq!(
            manager.status_lines(),
            vec!["a: NeedsAuth"],
            "a rejected reconnect re-marks NeedsAuth honestly"
        );

        mcp_server.abort();
        auth_server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_needs_auth_server_is_not_auto_retried() {
        // An OAuth server that answers with a 401 → `NeedsAuth`. A
        // subsequent `call_tool` is NOT auto-retried (an explicit `auth` is
        // required).
        let (url, server) = start_401_server().await;
        let (mut manager, _dir) = manager_with(
            &serde_json::json!({
                "mcpServers": { "a": { "url": url, "auth": "oauth" } }
            })
            .to_string(),
            None,
        );
        let cancel = CancellationToken::new();
        // The first `call_tool` tries to connect (a 401 → `NeedsAuth`).
        let r = manager
            .call_tool(
                "a",
                "echo",
                &serde_json::json!({}),
                &cancel,
                Duration::from_secs(2),
            )
            .await;
        assert!(r.is_err(), "a 401 → an error: {r:?}");
        assert_eq!(manager.status_lines(), vec!["a: NeedsAuth"]);
        // A subsequent `call_tool` is NOT auto-retried (a `NeedsAuth` state).
        let r = manager
            .call_tool(
                "a",
                "echo",
                &serde_json::json!({}),
                &cancel,
                Duration::from_secs(2),
            )
            .await;
        let Err(e) = r else {
            panic!("a `NeedsAuth` state is not auto-retried (should be an error)");
        };
        assert!(
            e.contains("NeedsAuth"),
            "a `NeedsAuth` state is not auto-retried: {e}"
        );
        server.abort();
    }
}
