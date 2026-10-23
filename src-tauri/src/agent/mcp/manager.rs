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
    /// The credentials file (`mcp-auth.json`). Production: `oauth::auth_file_path()`.
    /// A field, not a call, so a test can drive the token paths against a temp
    /// file instead of the developer's stored tokens (issue #68 — the read that
    /// T4 left pointed at the real path).
    auth_file: PathBuf,
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
            auth_file: oauth::auth_file_path(),
        }
    }

    /// Point the credentials read/write at a specific file (the test seam —
    /// every token test injects a temp path so it never touches the developer's
    /// `mcp-auth.json`).
    #[cfg(test)]
    pub(crate) fn with_auth_file(mut self, auth_file: PathBuf) -> Self {
        self.auth_file = auth_file;
        self
    }

    /// A server's current state (`None` = no such server). For callers that must
    /// report WHY a server was unavailable, not just that it was.
    pub fn state_of(&self, name: &str) -> Option<&McpState> {
        self.servers.get(name).map(|entry| &entry.state)
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
                    usable_token_provider(name, &self.auth_file).await
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
        // Clone FIRST: `self.authenticate_with(…, &self.auth_file)` would borrow
        // `*self` mutably (the receiver) and immutably (the argument) at once.
        let auth_file = self.auth_file.clone();
        self.authenticate_with(name, cancel, &auth_file).await
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
///
/// A FREE function (not a method): `ensure_connected` calls it while `entry`
/// (a `self.servers` borrow) and `def` (an `entry.def` borrow) are live, so a
/// `&self` receiver would be a double borrow.
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
            // An OAuth server: the stored token for this server, if any
            // (refreshed first when expired — the same seam the manager uses;
            // `test_server` is a free function with no manager, so the real
            // credentials path is correct here).
            let get_token = match (server_name, &def.auth) {
                (Some(n), AuthSpec::OAuth { .. }) => {
                    usable_token_provider(n, &oauth::auth_file_path()).await
                }
                _ => None,
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

    /// A minimal auth server for the `refresh_token` grant: the well-known
    /// metadata (its own `/token`) + a token endpoint that answers per
    /// `succeeds` and RECORDS every form field it received (so a test can prove
    /// the `refresh_token` grant was used, and — with the request counter — that
    /// no request was made at all).
    ///
    /// The counter counts EVERY request to the auth server: a successful
    /// `oauth::refresh` makes TWO (the `discover` well-known GET, then the
    /// `/token` POST) — so it is only ever asserted at `0` (proof that nothing
    /// touched the network).
    async fn start_refresh_server(
        succeeds: bool,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        std::sync::Arc<std::sync::atomic::AtomicU32>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the listener binds");
        let addr = listener.local_addr().expect("the listener has an address");
        let base = format!("http://{addr}");
        let base_inner = base.clone();
        let recorded: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded_inner = recorded.clone();
        let counter: std::sync::Arc<std::sync::atomic::AtomicU32> =
            std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter_inner = counter.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let base = base_inner.clone();
                let recorded = recorded_inner.clone();
                let counter = counter_inner.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    // Read the whole request (headers + body — the form body
                    // follows the header block, so a single `read` is not
                    // enough).
                    let mut data = Vec::new();
                    let mut buf = [0u8; 8192];
                    loop {
                        let Ok(n) = stream.read(&mut buf).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        data.extend_from_slice(&buf[..n]);
                        if data.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let header_end = match data.windows(4).position(|w| w == b"\r\n\r\n") {
                        Some(p) => p,
                        None => return,
                    };
                    let headers = String::from_utf8_lossy(&data[..header_end + 4]).to_string();
                    let mut body = data[header_end + 4..].to_vec();
                    let content_length = headers
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    while body.len() < content_length {
                        let Ok(n) = stream.read(&mut buf).await else {
                            break;
                        };
                        if n == 0 {
                            break;
                        }
                        body.extend_from_slice(&buf[..n]);
                    }
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let path = headers
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string();
                    let (status, body) = if path.starts_with("/.well-known") {
                        (
                            "200 OK",
                            serde_json::json!({
                                "authorization_endpoint": format!("{base}/authorize"),
                                "token_endpoint": format!("{base}/token"),
                            })
                            .to_string(),
                        )
                    } else if path.starts_with("/token") {
                        // Record every decoded `k=v` form field.
                        let body_str = String::from_utf8_lossy(&body).to_string();
                        for pair in body_str.split('&') {
                            let mut kv = pair.splitn(2, '=');
                            let k = kv.next().unwrap_or_default();
                            let v = kv.next().unwrap_or_default();
                            recorded
                                .lock()
                                .unwrap()
                                .push(format!("{}={}", k, url_decode(v)));
                        }
                        if succeeds {
                            (
                                "200 OK",
                                serde_json::json!({
                                    "access_token": "refreshed-access-token",
                                    "refresh_token": "rotated-refresh",
                                    "expires_in": 3600,
                                })
                                .to_string(),
                            )
                        } else {
                            ("400 Bad Request", "{}".to_string())
                        }
                    } else {
                        ("404 Not Found", "{}".to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (base, recorded, counter, handle)
    }

    /// Percent-decode a form field (the `oauth.rs` mock's decoder).
    fn url_decode(s: &str) -> String {
        let bytes = s.as_bytes();
        let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                let hex = &s[i + 1..i + 3];
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).to_string()
    }

    /// An MCP-over-HTTP server that accepts a request only when its
    /// `Authorization` header carries `accepted` — everything else gets a `401`
    /// (which `HttpClient::send_request` maps to `needs-auth` because the def is
    /// OAuth). This is the "the stale token is dead, the fresh one works"
    /// scenario. Records every `Authorization` value it saw.
    async fn start_token_gated_server(
        accepted: &str,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the listener binds");
        let addr = listener.local_addr().expect("the listener has an address");
        let accepted = accepted.to_string();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_inner = seen.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let accepted = accepted.clone();
                let seen = seen_inner.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 8192];
                    let _ = stream.read(&mut buf).await;
                    let request = String::from_utf8_lossy(&buf).to_string();
                    let authorization = request
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("authorization:"))
                        .map(|l| l.trim().to_string())
                        .unwrap_or_default();
                    seen.lock().unwrap().push(authorization.clone());
                    // Accept ONLY a header carrying the expected token. (Assert
                    // with `contains` in the tests: the client sends an OAuth
                    // token with no `Bearer ` prefix today — out of scope here.)
                    let (status, body) = if authorization.contains(accepted.as_str()) {
                        (
                            "200 OK",
                            serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 1,
                                "result": {
                                    "protocolVersion": "2025-06-18",
                                    "capabilities": {},
                                    "serverInfo": { "name": "fake", "version": "0" },
                                },
                            })
                            .to_string(),
                        )
                    } else {
                        ("401 Unauthorized", "{}".to_string())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}/mcp"), seen, handle)
    }

    /// A stored-credentials file holding one entry (the refresh tests' setup).
    fn write_credentials(auth_file: &std::path::Path, entry: oauth::StoredAuth) {
        let mut map: std::collections::BTreeMap<String, oauth::StoredAuth> =
            std::collections::BTreeMap::new();
        map.insert("a".to_string(), entry);
        oauth::save_credentials(auth_file, &map).expect("writes the credentials");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_expired_token_is_refreshed_and_persisted_instead_of_needs_auth() {
        // Issue #68: an `mcp-auth.json` entry whose `expires_at` has passed is
        // refreshed + re-persisted on the next connect, instead of sending the
        // dead token and dropping the server into `NeedsAuth`.
        let (mcp_url, mcp_seen, mcp_server) =
            start_token_gated_server("refreshed-access-token").await;
        let (auth_base, auth_fields, _auth_counter, auth_server) = start_refresh_server(true).await;
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("mcp-auth.json");
        write_credentials(
            &auth_file,
            oauth::StoredAuth {
                client_id: "cid".into(),
                client_secret: Some("sec".into()),
                token: "stale-access-token".into(),
                refresh_token: Some("stale-refresh".into()),
                expires_at: Some(oauth::now_epoch_secs() - 10),
                auth_server_url: auth_base.clone(),
                scope: None,
            },
        );
        let (mut manager, _dir) = manager_with(
            &serde_json::json!({
                "mcpServers": { "a": {
                    "url": mcp_url,
                    "auth": { "clientId": "cid", "clientSecret": "sec" },
                } }
            })
            .to_string(),
            None,
        );
        manager = manager.with_auth_file(auth_file.clone());
        let cancel = CancellationToken::new();

        manager
            .connect("a", &cancel, Duration::from_secs(5))
            .await
            .expect("the expired token is refreshed and the connect succeeds");
        assert_eq!(manager.status_lines(), vec!["a: Connected"]);

        // The FRESH token was the one sent (never the stale one). Assert with
        // `contains` — the OAuth header framing is out of this task's scope.
        let seen = mcp_seen.lock().unwrap().join("\n");
        assert!(
            seen.contains("refreshed-access-token"),
            "the refreshed token is the one sent: {seen}"
        );
        assert!(
            !seen.contains("stale-access-token"),
            "the stale token must not be sent: {seen}"
        );

        // Exactly ONE `refresh_token` grant was used (the recorded vec is only
        // written by `/token`, so one occurrence = one grant — the auth-server
        // request counter is 2 here: the `discover` GET + this POST).
        let fields = auth_fields.lock().unwrap().clone();
        assert_eq!(
            fields
                .iter()
                .filter(|f| f.as_str() == "grant_type=refresh_token")
                .count(),
            1,
            "exactly one refresh_token grant: {fields:?}"
        );
        assert!(
            fields.contains(&"refresh_token=stale-refresh".to_string()),
            "the stored refresh token was exchanged: {fields:?}"
        );

        // The refresh was PERSISTED (the next session does not re-run the flow).
        let persisted = oauth::load_credentials(&auth_file);
        let stored = persisted.get("a").expect("the entry is still there");
        assert_eq!(stored.token, "refreshed-access-token");
        assert_eq!(stored.refresh_token.as_deref(), Some("rotated-refresh"));
        assert!(
            stored
                .expires_at
                .is_some_and(|at| at > oauth::now_epoch_secs()),
            "the new expiry is in the future: {:?}",
            stored.expires_at
        );

        mcp_server.abort();
        auth_server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failed_refresh_lands_in_needs_auth() {
        // A refresh that fails (the auth server rejects it) degrades to the
        // existing fallback: no token → a 401 → `NeedsAuth` → the `auth`
        // action. And a failed refresh WRITES NOTHING (a transient auth-server
        // outage must not destroy a possibly-reusable refresh token).
        let (mcp_url, _mcp_seen, mcp_server) =
            start_token_gated_server("refreshed-access-token").await;
        let (auth_base, auth_fields, _counter, auth_server) = start_refresh_server(false).await;
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("mcp-auth.json");
        write_credentials(
            &auth_file,
            oauth::StoredAuth {
                client_id: "cid".into(),
                client_secret: Some("sec".into()),
                token: "stale-access-token".into(),
                refresh_token: Some("stale-refresh".into()),
                expires_at: Some(oauth::now_epoch_secs() - 10),
                auth_server_url: auth_base.clone(),
                scope: None,
            },
        );
        let (mut manager, _dir) = manager_with(
            &serde_json::json!({
                "mcpServers": { "a": {
                    "url": mcp_url,
                    "auth": { "clientId": "cid", "clientSecret": "sec" },
                } }
            })
            .to_string(),
            None,
        );
        manager = manager.with_auth_file(auth_file.clone());
        let cancel = CancellationToken::new();

        let r = manager.connect("a", &cancel, Duration::from_secs(5)).await;
        assert!(r.is_err(), "a failed refresh → an error: {r:?}");
        let e = r.unwrap_err();
        assert!(
            e.contains("requires authentication"),
            "the existing needs-auth message: {e}"
        );
        assert_eq!(
            manager.status_lines(),
            vec!["a: NeedsAuth"],
            "a failed refresh still degrades to NeedsAuth"
        );

        // A refresh WAS attempted (no exact request count — `oauth::refresh`
        // makes two calls: the well-known `discover` + the `/token` POST).
        let fields = auth_fields.lock().unwrap().clone();
        assert!(
            fields.contains(&"grant_type=refresh_token".to_string()),
            "the refresh_token grant was attempted: {fields:?}"
        );
        assert!(
            fields.contains(&"refresh_token=stale-refresh".to_string()),
            "with the stored refresh token: {fields:?}"
        );

        // The credentials file is UNCHANGED (a failed refresh writes nothing).
        let kept = oauth::load_credentials(&auth_file);
        assert_eq!(
            kept.get("a").map(|s| s.token.as_str()),
            Some("stale-access-token"),
            "a failed refresh must not touch the stored entry"
        );

        mcp_server.abort();
        auth_server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_token_without_an_expiry_is_never_refreshed() {
        // PASSING BEFORE the implementation too, on purpose: it pins behaviour
        // that must NOT regress — an entry with `expires_at: None` is never
        // refreshed (no round trip, no downgrade of a working token). Do not
        // "fix" it into asserting a refresh.
        let (mcp_url, _mcp_seen, mcp_server) = start_token_gated_server("stale-access-token").await;
        let (auth_base, auth_fields, counter, auth_server) = start_refresh_server(true).await;
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("mcp-auth.json");
        write_credentials(
            &auth_file,
            oauth::StoredAuth {
                client_id: "cid".into(),
                client_secret: Some("sec".into()),
                token: "stale-access-token".into(),
                refresh_token: Some("stale-refresh".into()),
                expires_at: None,
                auth_server_url: auth_base.clone(),
                scope: None,
            },
        );
        let (mut manager, _dir) = manager_with(
            &serde_json::json!({
                "mcpServers": { "a": {
                    "url": mcp_url,
                    "auth": { "clientId": "cid", "clientSecret": "sec" },
                } }
            })
            .to_string(),
            None,
        );
        manager = manager.with_auth_file(auth_file.clone());
        let cancel = CancellationToken::new();

        manager
            .connect("a", &cancel, Duration::from_secs(5))
            .await
            .expect("the stored token works");
        assert_eq!(manager.status_lines(), vec!["a: Connected"]);
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "expires_at: None never spends a refresh round trip"
        );
        assert!(auth_fields.lock().unwrap().is_empty());

        mcp_server.abort();
        auth_server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_public_client_is_never_auto_refreshed_end_to_end() {
        // The ADR 0015 guard at the CALL SITE (`oauth.rs` covers the guard
        // inside `refresh` itself). PASSING BEFORE the implementation too, on
        // purpose — it pins that a public client (no `clientSecret`) makes ZERO
        // auth-server requests: the guard short-circuits before `discover`, so
        // the degradation lands on the interactive flow, never a token POST the
        // auth server would reject with `invalid_client`.
        let (mcp_url, _mcp_seen, mcp_server) =
            start_token_gated_server("refreshed-access-token").await;
        let (auth_base, _auth_fields, counter, auth_server) = start_refresh_server(true).await;
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("mcp-auth.json");
        write_credentials(
            &auth_file,
            oauth::StoredAuth {
                client_id: "cid".into(),
                client_secret: None,
                token: "stale-access-token".into(),
                refresh_token: Some("stale-refresh".into()),
                expires_at: Some(oauth::now_epoch_secs() - 10),
                auth_server_url: auth_base.clone(),
                scope: None,
            },
        );
        let (mut manager, _dir) = manager_with(
            // No `clientSecret` — the def and the stored entry tell the same
            // story (a pre-registered PUBLIC client).
            &serde_json::json!({
                "mcpServers": { "a": {
                    "url": mcp_url,
                    "auth": { "clientId": "cid" },
                } }
            })
            .to_string(),
            None,
        );
        manager = manager.with_auth_file(auth_file.clone());
        let cancel = CancellationToken::new();

        let r = manager.connect("a", &cancel, Duration::from_secs(5)).await;
        assert!(r.is_err(), "a public client's dead token → an error: {r:?}");
        assert_eq!(manager.status_lines(), vec!["a: NeedsAuth"]);
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "the ADR 0015 guard short-circuits before discover — zero auth-server calls"
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
