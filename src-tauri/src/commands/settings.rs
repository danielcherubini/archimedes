//! The Settings IPC surface: the `#[tauri::command]` wrappers over the
//! `crate::config` service (the `settings.json` model + I/O live there —
//! this module is the IPC layer only) + the two wire DTOs (`ModelDto`,
//! `KnownProviderDto`).

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::agent::harness::{tool_specs, Model};
use crate::agent::{SessionManager, SettingsError};
use crate::config::{load_settings, write_settings, KnownProvider, Settings, KNOWN_PROVIDERS};

/// Read the settings. Always succeeds (see `load_settings`); the `Result`
/// is kept for command-shape stability but is never `Err`.
#[tauri::command]
pub async fn get_settings(
    state: State<'_, Arc<SessionManager>>,
) -> Result<Settings, SettingsError> {
    Ok(load_settings(state.config_dir()))
}

/// Persist the settings (overwrites the file).
#[tauri::command]
pub async fn save_settings(
    state: State<'_, Arc<SessionManager>>,
    settings: Settings,
) -> Result<(), SettingsError> {
    write_settings(state.config_dir(), &settings).map_err(SettingsError::SaveFailed)
}

/// The effective catalog's models (the frontend's Default-model select +
/// the provider rows' discovery status).
/// `force_refresh` = a provider id whose discovery cache entry is bypassed
/// (the settings page's refresh affordance); `None` = cached.
#[tauri::command]
pub async fn list_models(
    state: State<'_, Arc<SessionManager>>,
    force_refresh: Option<String>,
) -> Result<Vec<ModelDto>, SettingsError> {
    // (issue #129) `execute_helpers = false`: the BOOT seed never spawns a
    // `!command` key helper; every interactive caller passes `true`.
    let catalog = state
        .effective_catalog(force_refresh.as_deref(), false)
        .await;
    // (#85) A refresh must reach LIVE sessions, not just new ones: the context
    // window is copied into each session's `AgentLoop` at spawn, so without this
    // a corrected window is invisible to every running session (and, since that
    // same window is the compaction threshold's input, the session silently
    // over-compacts). Scoped to the refreshed provider — a plain cached read
    // (`force_refresh: None`, the settings page's initial load) pushes nothing.
    if let Some(provider_id) = force_refresh.as_deref() {
        let refreshed: Vec<crate::agent::harness::catalog::Model> = catalog
            .models
            .iter()
            .filter(|m| m.provider == provider_id)
            .cloned()
            .collect();
        state.refresh_live_models(&refreshed).await;
    }
    Ok(catalog.models.iter().map(ModelDto::from).collect())
}

/// The camelCase wire shape (the `Model` struct itself is NOT renamed —
/// `capabilities_json` embeds composed keys, not `Model`, so a DTO here
/// is the safe choice over renaming the struct). Wire-out-only by design
/// (no `Deserialize` — the command only returns it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub id: String,
    pub provider: String,
    pub context_window: u32,
    pub supports_thinking: bool,
    pub thinking_levels: Vec<String>,
}

impl From<&Model> for ModelDto {
    fn from(m: &Model) -> Self {
        Self {
            id: m.id.clone(),
            provider: m.provider.clone(),
            context_window: m.context_window,
            supports_thinking: m.supports_thinking,
            thinking_levels: m.thinking_levels.clone(),
        }
    }
}

/// The native harness's tool names, sorted (the Settings page's
/// enabled-tools checkbox list). STATELESS (no `tauri::State` param — the
/// command needs no state: `tool_specs()` is a free function).
#[tauri::command]
pub async fn list_tools() -> Result<Vec<String>, SettingsError> {
    let mut names: Vec<String> = tool_specs().iter().map(|t| t.name.clone()).collect();
    names.sort(); // deterministic UI order
    Ok(names)
}

/// The camelCase wire shape (the `KnownProvider` itself is NOT renamed —
/// a DTO, the `ModelDto` pattern). Wire-out-only by design (no
/// `Deserialize` — the command only returns it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownProviderDto {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api: String,
    pub key_url: String,
}

impl From<&KnownProvider> for KnownProviderDto {
    fn from(k: &KnownProvider) -> Self {
        Self {
            id: k.id.into(),
            name: k.name.into(),
            base_url: k.base_url.into(),
            api: k.api.as_str().into(),
            key_url: k.key_url.into(),
        }
    }
}

/// The known-providers catalog (the Settings' picker's data source —
/// ADR 0024). STATELESS (no `tauri::State` param — the `list_tools`
/// pattern: the command needs no state).
#[tauri::command]
pub async fn list_known_providers() -> Result<Vec<KnownProviderDto>, SettingsError> {
    Ok(KNOWN_PROVIDERS.iter().map(KnownProviderDto::from).collect())
}

/// Test ONE MCP server definition (the Settings page's Test action, ADR
/// 0019): a one-shot bounded connect + `tools/list`. `Ok` = the tool
/// count; `Err` = the error text (surfaced verbatim in the row — a
/// `needs-auth` / a network failure). The entry is the `settings.json`
/// `mcpServers` entry VERBATIM (pi's shape — classified, not re-shaped).
#[tauri::command]
pub async fn test_mcp_server(name: Option<String>, entry: Value) -> Result<u32, SettingsError> {
    let def = crate::agent::mcp::types::classify_server(&entry).ok_or_else(|| {
        SettingsError::InvalidMcpServer("need a `url` or a `command`".to_string())
    })?;
    let timeout = std::time::Duration::from_secs(10);
    crate::agent::mcp::manager::test_server(name.as_deref(), &def, Path::new("."), timeout)
        .await
        .map(|n| n as u32)
        .map_err(SettingsError::McpTestFailed)
}

/// Run interactive OAuth authentication for an MCP server (Settings UI).
#[tauri::command]
pub async fn auth_mcp_server(name: String, entry: Value) -> Result<String, SettingsError> {
    let def = crate::agent::mcp::types::classify_server(&entry).ok_or_else(|| {
        SettingsError::InvalidMcpServer("need a `url` or a `command`".to_string())
    })?;
    crate::agent::mcp::manager::authenticate_server(&name, &def)
        .await
        .map_err(SettingsError::McpAuthFailed)
}

/// Test ONE Search provider: one canned query, reporting the hit count or the
/// error. Mirrors `test_mcp_server` — a 10 s bound, the error text
/// surfaced VERBATIM (it is the actionable one: a 401, a 429, a SearXNG
/// instance without `json` in `enabled_formats`).
#[tauri::command]
pub async fn test_search_provider(
    provider: String,
    settings: serde_json::Value,
) -> Result<usize, SettingsError> {
    use crate::agent::web::config::{WebConfig, SEARCH_PROVIDERS};
    use crate::config::WebSettings;

    if !SEARCH_PROVIDERS.contains(&provider.as_str()) {
        return Err(SettingsError::UnknownSearchProvider(
            provider,
            SEARCH_PROVIDERS.join(", "),
        ));
    }

    let web_settings: WebSettings = if let Some(web_val) = settings.get("web") {
        serde_json::from_value(web_val.clone()).unwrap_or_default()
    } else {
        serde_json::from_value(settings.clone()).unwrap_or_default()
    };

    let web_config = WebConfig::from_web_settings(Some(&web_settings));

    let providers = crate::agent::web::providers::registry::all_providers();
    let target = providers
        .iter()
        .find(|p| p.id() == provider)
        .ok_or_else(|| {
            SettingsError::UnknownSearchProvider(provider.clone(), SEARCH_PROVIDERS.join(", "))
        })?;

    if !target.is_available(&web_config) {
        return Err(SettingsError::SearchNotConfigured(provider));
    }

    let timeout = std::time::Duration::from_secs(10);
    let cancel = tokio_util::sync::CancellationToken::new();
    let opts = crate::agent::web::providers::types::SearchOpts {
        provider: Some(provider.clone()),
        ..Default::default()
    };

    let outcome = tokio::time::timeout(
        timeout,
        crate::agent::web::providers::registry::execute_search(
            &["archimedes".to_string()],
            &opts,
            &web_config,
            &cancel,
        ),
    )
    .await
    .map_err(|_| SettingsError::SearchTimeout(provider))?
    .map_err(SettingsError::SearchFailed)?;

    Ok(outcome.results.len())
}

/// (ADR 0030 Task 5) Whether a `Sandboxed` `bash` can actually be confined
/// here: Linux + a kernel that enforces Landlock. Everywhere else `false`
/// (the sandbox module is not even compiled), and the tier FAILS CLOSED — so
/// Settings must grey the option out and say why rather than offer a choice
/// that only produces errors. STATELESS (the `list_tools` pattern).
#[tauri::command]
pub async fn shell_sandbox_available() -> Result<bool, SettingsError> {
    Ok(crate::agent::tools::shell_sandbox_available())
}

// ── the interactive provider login (issue #126, T5) ───────────────────────
//
// The Rust command surface for LiteLLM's three-tier interactive login. The flow
// LOGIC lives in `agent/provider_auth::{litellm_oauth, cli_sso}` (these commands
// are thin wrappers — the `auth_mcp_server` pattern: call the flow, map `Err` →
// `SettingsError::Other`, return the DTO), and the wire DTOs are declared THERE
// and re-exported HERE, so the type the flow produces and the type T8 renders are
// ONE type (the deviation from the plan's "declare the DTO in this module" is
// recorded in the commit message — a DTO declared in the IPC layer would force
// the flow module to depend on the IPC layer).
//
// STATELESS (no `tauri::State` — the `list_tools` pattern): the provider row's
// `baseUrl` comes from the renderer and the store path resolves inside via
// `provider_auth::store::auth_file_path()` (ruling R3: the platform DATA dir,
// beside `mcp-auth.json`). The flow functions take the path as a parameter, so
// the tests drive them against a scratch dir and nothing here can reach the real
// store from a test.

/// The login's wire steps, re-exported as this module's wire surface (the
/// `ModelDto` pattern: camelCase, Serialize-only). T8's TypeScript mirrors THIS.
pub use crate::agent::provider_auth::{ProviderLoginStep, TeamDto};

/// Run LiteLLM's PKCE DCR login (falling back to the CLI SSO device flow when
/// discovery or dynamic client registration is unavailable).
///
/// BLOCKS until the browser callback completes (up to 10 minutes) — the
/// `auth_mcp_server` shape, which T8's "signing in…" badge pattern already
/// assumes. Returns `Authenticated`, or the `DevicePending` step whose code the
/// UI shows while it polls [`provider_login_sso_poll`].
#[tauri::command]
pub async fn provider_login_oauth(
    provider_id: String,
    base_url: String,
) -> Result<ProviderLoginStep, SettingsError> {
    let cancel = tokio_util::sync::CancellationToken::new();
    // The ADR 0051 opener seam — `crate::open` is the ONE opener policy and it is
    // callable from Rust (the MCP OAuth flow's `production_open_browser`
    // precedent). NO opener plugin is added to Rust for this.
    let open_browser: Box<dyn Fn(&str) + Send + Sync> = Box::new(|url| {
        let _ = crate::open::open(url, None);
    });
    crate::agent::provider_auth::litellm_oauth::login(
        &provider_id,
        &base_url,
        &crate::agent::provider_auth::store::auth_file_path(),
        &open_browser,
        &cancel,
    )
    .await
    .map_err(SettingsError::Other)
}

/// One device-flow poll TICK (the legacy CLI SSO tier): `GET
/// {base}/sso/cli/poll/{login_id}` with the `x-litellm-cli-poll-secret` header.
///
/// ONE tick, deliberately — the 2 s cadence (`cli_sso::SSO_POLL_INTERVAL`) is
/// driven by T8's timer so the user code stays on screen and the invoke never
/// blocks (plan §4f). `team_id` is the SECOND poll that IS the team-selection
/// round-trip (the proxy reads the choice as a `?team_id=` query param on this
/// SAME endpoint — verified against LiteLLM's source; there is no team-choice
/// POST for a desktop client): pass `None` for a plain tick, or the chosen id
/// after a `ChooseTeam` step (or use [`provider_login_sso_choose_team`], which is
/// the same request with the id required).
///
/// An expired/unknown session (`400`) or a rejected secret (`403`) is TERMINAL:
/// the error text says to restart the login, and the UI must stop polling.
///
/// `provider_id` is required (DEVIATION from the plan's §4f signature, which
/// omitted it): the store is keyed by PROVIDER id (`resolve_bearer` looks the row
/// up by `provider.id`), so a credential stored under the device `login_id` could
/// never be served. The UI has the id in hand — it started the login for a row.
#[tauri::command]
pub async fn provider_login_sso_poll(
    provider_id: String,
    login_id: String,
    poll_secret: String,
    base_url: String,
    team_id: Option<String>,
) -> Result<ProviderLoginStep, SettingsError> {
    let client = crate::agent::provider_auth::cli_sso::poll_client();
    let session = crate::agent::provider_auth::cli_sso::DeviceSession {
        login_id: login_id.clone(),
        poll_secret: poll_secret.clone(),
        user_code: String::new(),
        expires_in: None,
        verification_uri_complete: None,
    };
    let outcome = crate::agent::provider_auth::cli_sso::poll_once(
        &base_url,
        &session,
        team_id.as_deref(),
        &client,
    )
    .await
    .map_err(SettingsError::Other)?;
    device_step_from_outcome(&base_url, &provider_id, &login_id, &poll_secret, outcome)
}

/// The interactive team choice (a `TeamDto` from the last `ChooseTeam` step):
/// ONE re-poll with `?team_id=<id>` — the verified wire.
#[tauri::command]
pub async fn provider_login_sso_choose_team(
    provider_id: String,
    login_id: String,
    poll_secret: String,
    base_url: String,
    team_id: String,
) -> Result<ProviderLoginStep, SettingsError> {
    let client = crate::agent::provider_auth::cli_sso::poll_client();
    let session = crate::agent::provider_auth::cli_sso::DeviceSession {
        login_id: login_id.clone(),
        poll_secret: poll_secret.clone(),
        user_code: String::new(),
        expires_in: None,
        verification_uri_complete: None,
    };
    let outcome =
        crate::agent::provider_auth::cli_sso::choose_team(&base_url, &session, &team_id, &client)
            .await
            .map_err(SettingsError::Other)?;
    device_step_from_outcome(&base_url, &provider_id, &login_id, &poll_secret, outcome)
}

/// Paste a token from `{base}/sso/key/generate`. With `mint_virtual_key`, FIRST
/// `POST {base}/key/generate` with `Authorization: Bearer <token>` and an EMPTY
/// `{}` body (the verified mint wire) and store the minted key; ANY mint failure
/// degrades to storing the pasted token (a virtual-key generation failure must
/// never fail the paste).
#[tauri::command]
pub async fn provider_login_paste_token(
    provider_id: String,
    base_url: String,
    token: String,
    mint_virtual_key: bool,
) -> Result<ProviderLoginStep, SettingsError> {
    let client = crate::agent::provider_auth::cli_sso::poll_client();
    crate::agent::provider_auth::cli_sso::store_pasted(
        &base_url,
        &provider_id,
        &token,
        mint_virtual_key,
        &crate::agent::provider_auth::store::auth_file_path(),
        &client,
    )
    .await
    .map(|_| ProviderLoginStep::Authenticated)
    .map_err(SettingsError::Other)
}

/// Turn one device-flow poll outcome into the step T8 renders, storing the
/// credential when the flow is ready. The `poll_secret` is re-carried on the
/// interactive steps so the UI can round-trip it (it is a bearer for the poll
/// endpoint and it dies with the session — the same trust level as an MCP server
/// entry holding its headers).
fn device_step_from_outcome(
    base_url: &str,
    provider_id: &str,
    login_id: &str,
    poll_secret: &str,
    outcome: crate::agent::provider_auth::cli_sso::PollOutcome,
) -> Result<ProviderLoginStep, SettingsError> {
    use crate::agent::provider_auth::cli_sso::PollOutcome;
    match outcome {
        PollOutcome::Ready { .. } => {
            crate::agent::provider_auth::cli_sso::store_device_token(
                &crate::agent::provider_auth::store::auth_file_path(),
                provider_id,
                base_url,
                &outcome,
            )
            .map_err(SettingsError::Other)?;
            Ok(ProviderLoginStep::Authenticated)
        }
        PollOutcome::NeedsTeam(teams) => Ok(ProviderLoginStep::ChooseTeam {
            login_id: login_id.to_string(),
            poll_secret: poll_secret.to_string(),
            teams: teams
                .into_iter()
                .map(|t| TeamDto {
                    team_id: t.team_id,
                    team_alias: t.team_alias,
                })
                .collect(),
        }),
        // Still waiting on the browser leg: the step re-carries the code + link
        // so a renderer can keep them on screen (the UI holds the state; the
        // command stays stateless). `userCode` is EMPTY here on purpose — the
        // proxy never echoes the code back on a poll (it is issued by `start`
        // only, §11a), so the renderer keeps the one it was given rather than
        // blanking it with a fabricated value.
        PollOutcome::Pending => Ok(ProviderLoginStep::DevicePending {
            login_id: login_id.to_string(),
            poll_secret: poll_secret.to_string(),
            user_code: String::new(),
            verification_url: crate::agent::provider_auth::cli_sso::verification_url(
                base_url, login_id,
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    // ── the interactive-login wire DTOs (issue #126) ───────────────────────

    #[test]
    fn provider_login_step_serializes_camelcase_with_a_status_tag() {
        // T8 renders each variant off the `status` tag, so the tag name and the
        // camelCase field names ARE the contract. Serialize-only (the command
        // never receives this).
        let json = |step: &ProviderLoginStep| serde_json::to_value(step).expect("serializes");

        let auth = json(&ProviderLoginStep::Authenticated);
        assert_eq!(
            auth["status"], "authenticated",
            "the unit tag is camelCased"
        );
        assert_eq!(
            auth.as_object().expect("an object").len(),
            1,
            "a unit variant carries only its tag: {auth}"
        );

        let pending = json(&ProviderLoginStep::DevicePending {
            login_id: "cli-abc".into(),
            poll_secret: "secret".into(),
            user_code: "ABCD-EFGH".into(),
            verification_url: "https://gw/sso/key/generate?source=litellm-cli&key=cli-abc".into(),
        });
        assert_eq!(pending["status"], "devicePending", "the tag is camelCase");
        assert_eq!(pending["loginId"], "cli-abc");
        assert_eq!(pending["pollSecret"], "secret");
        assert_eq!(pending["userCode"], "ABCD-EFGH", "the code the user reads");
        assert_eq!(
            pending["verificationUrl"],
            "https://gw/sso/key/generate?source=litellm-cli&key=cli-abc"
        );

        let choose = json(&ProviderLoginStep::ChooseTeam {
            login_id: "cli-abc".into(),
            poll_secret: "secret".into(),
            teams: vec![TeamDto {
                team_id: "team-a".into(),
                team_alias: "Alpha".into(),
            }],
        });
        assert_eq!(choose["status"], "chooseTeam");
        assert_eq!(choose["loginId"], "cli-abc");
        assert_eq!(choose["teams"][0]["teamId"], "team-a");
        assert_eq!(choose["teams"][0]["teamAlias"], "Alpha");
    }

    #[test]
    fn team_dto_serializes_camelcase() {
        let json = serde_json::to_value(TeamDto {
            team_id: "t".into(),
            team_alias: "Alias".into(),
        })
        .expect("serializes");
        assert_eq!(json["teamId"], "t");
        assert_eq!(json["teamAlias"], "Alias");
        // Exactly two keys — a stray field would be a wire change T8 must opt into.
        assert_eq!(json.as_object().expect("an object").len(), 2);
    }

    #[tokio::test]
    async fn list_tools_returns_a_sorted_list_of_the_native_harness_tools() {
        // The command is stateless (no `tauri::State` param — it cannot be
        // constructed in a unit test, and it needs no state: `tool_specs()`
        // is a free function), so it is called directly.
        let names = list_tools().await.expect("the tool specs build");
        // Sorted (deterministic UI order).
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        // The built-in harness tools.
        for name in ["bash", "read", "edit", "write", "subagent"] {
            assert!(
                names.iter().any(|n| n == name),
                "missing {name} in {names:?}"
            );
        }
    }

    #[tokio::test]
    async fn list_known_providers_returns_the_20_templates() {
        // The command is stateless (no `tauri::State` param — the `list_tools`
        // pattern), so it is called directly.
        let providers = list_known_providers()
            .await
            .expect("the catalog is built-in");
        assert_eq!(
            providers.len(),
            20,
            "the ZCode builtin catalog has 20 templates"
        );
        // Every `api` is a harness wire API (ADR 0024).
        for p in &providers {
            assert!(
                matches!(
                    p.api.as_str(),
                    "openai-completions" | "anthropic-messages" | "openai-responses"
                ),
                "unknown wire api {:?} for {:?}",
                p.api,
                p.id
            );
            assert!(
                p.base_url.starts_with("https://"),
                "a builtin template is https: {:?}",
                p.base_url
            );
            assert!(
                !p.key_url.is_empty(),
                "every template has a key URL: {:?}",
                p.id
            );
        }
        // The `id`s are unique.
        let mut ids: Vec<&str> = providers.iter().map(|p| p.id.as_str()).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate provider id in {ids:?}");
    }

    #[tokio::test]
    async fn list_known_providers_templates_match_the_zcode_catalog() {
        // Spot-checks: the ZCode catalog's values (base URLs / key URLs /
        // wire apis VERBATIM from `templateRules`).
        let providers = list_known_providers().await.unwrap();
        let by_id: HashMap<String, &KnownProviderDto> =
            providers.iter().map(|p| (p.id.clone(), p)).collect();
        let anthropic = &by_id["anthropic"];
        assert_eq!(anthropic.base_url, "https://api.anthropic.com/v1");
        assert_eq!(anthropic.api, "anthropic-messages");
        let openai = &by_id["openai"];
        assert_eq!(openai.api, "openai-responses");
        let zai = &by_id["zai"];
        assert_eq!(zai.base_url, "https://api.z.ai/api/anthropic");
        let deepseek = &by_id["deepseek"];
        assert_eq!(deepseek.base_url, "https://api.deepseek.com/anthropic");
        let alibaba_intl = &by_id["alibaba-intl"];
        assert_eq!(
            alibaba_intl.base_url,
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        );
        assert_eq!(alibaba_intl.api, "openai-completions");
    }

    #[test]
    fn test_mcp_server_an_invalid_entry_is_an_error() {
        // (ADR 0019) The Test action on a malformed entry (neither a `url`
        // nor a `command`) is an error, not a connect attempt.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = rt
            .block_on(test_mcp_server(
                None,
                serde_json::json!({ "headers": { "a": "b" } }),
            ))
            .expect_err("a malformed entry is an error");
        assert!(
            result.to_string().contains("invalid"),
            "the error names the problem: {result}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_mcp_server_a_valid_stdio_entry_reports_the_tool_count() {
        // (ADR 0019) A valid stdio entry (the fake binary — three canned
        // tools) round-trips the count through the command.
        let bin = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_mcp_stdio"
        ));
        let count = test_mcp_server(
            None,
            serde_json::json!({ "command": bin.display().to_string() }),
        )
        .await
        .expect("the fake server answers");
        assert_eq!(count, 3);
    }

    /// (ADR 0030 Task 5) The Settings grey-out's source: on Linux it is the
    /// kernel probe's answer (the SAME signal `exec_bash` fails closed on —
    /// a UI that offered a tier the executor refuses would be a lie, and
    /// hiding a working one equally wrong); off Linux it is `false`
    /// unconditionally, because the sandbox is not compiled in there.
    #[tokio::test]
    async fn shell_sandbox_available_mirrors_the_kernel_probe() {
        let available = shell_sandbox_available().await.expect("stateless");
        #[cfg(target_os = "linux")]
        assert_eq!(
            available,
            crate::agent::tools::sandbox::landlock_available(),
            "on Linux the command reports the kernel's Landlock support"
        );
        #[cfg(not(target_os = "linux"))]
        assert!(!available, "off Linux there is no sandbox to offer");
    }

    #[test]
    fn list_models_dto_mapping() {
        // The `Model` struct itself is NOT `#[serde(rename_all)]` (it is
        // embedded in composed `capabilities_json` keys), so the
        // `list_models` command returns the explicit camelCase `ModelDto`
        // projection — the serialized output must carry `contextWindow`
        // (NOT `context_window`).
        let model = crate::agent::harness::Model {
            id: "m/1".into(),
            provider: "tama".into(),
            base_url: "https://tama.wizards.town/v1".into(),
            api_key: "k".into(),
            context_window: 99999,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: true,
            thinking_levels: vec!["low".to_string()],
            api: Some("openai-completions".into()),
        };
        let dto = ModelDto::from(&model);
        let v = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["id"], "m/1");
        assert_eq!(v["provider"], "tama");
        assert_eq!(v["contextWindow"], 99999);
        assert_eq!(v["supportsThinking"], true);
        assert_eq!(v["thinkingLevels"], serde_json::json!(["low"]));
        // NOT snake_case on the wire.
        assert!(v.get("context_window").is_none());
    }

    #[tokio::test]
    async fn test_search_provider_unknown_provider_names_valid_set() {
        let err = test_search_provider("unknown_engine".into(), serde_json::json!({}))
            .await
            .expect_err("unknown provider must fail");
        assert!(
            err.to_string()
                .contains("Valid providers: brave, tavily, perplexity, searxng, duckduckgo"),
            "error should list valid providers: {err}"
        );
    }

    /// `PERPLEXITY_API_KEY` restore guard (the `test_support` `ENV_LOCK`
    /// pattern — copy of the private `RestoreEnv` in `agent/web/config.rs`'s
    /// test module; the restore happens even when an assertion panics).
    struct RestoreEnv(&'static str, Option<std::ffi::OsString>);
    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            match self.1.take() {
                // SAFETY: the `ENV_LOCK` is still held at drop time (this
                // guard is declared after the `_lock` guard and outlives it
                // in reverse); no other thread mutates the env concurrently.
                Some(v) => unsafe { std::env::set_var(self.0, v) },
                None => unsafe { std::env::remove_var(self.0) },
            }
        }
    }

    /// Unset `key` for the rest of the test, returning the guard that puts
    /// the previous value back. Caller must hold `env_lock()`.
    fn remove_env(key: &'static str) -> RestoreEnv {
        let prev = std::env::var_os(key);
        // SAFETY: `ENV_LOCK` is held by caller.
        unsafe { std::env::remove_var(key) };
        RestoreEnv(key, prev)
    }

    // The `ENV_LOCK` (`std::sync::Mutex`) is held across this test's `await`
    // point INTENTIONALLY: `test_search_provider` reads
    // `PERPLEXITY_API_KEY` through `WebConfig::from_web_settings`
    // (`agent/web/config.rs:60`), so the env must stay cleared for the whole
    // call — and a sibling test's read of that var mid-mutation would see
    // the wrong value (the `test_support` `ENV_LOCK` pattern).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn test_search_provider_unconfigured_provider_is_err() {
        // Temporarily clear any env vars that could configure perplexity —
        // UNDER the env lock, because this is an unlocked-writer race against
        // the `agent::web::config` tests, which read and write the same
        // `PERPLEXITY_API_KEY` while holding it.
        let _lock = crate::test_support::env_lock();
        let _restore = remove_env("PERPLEXITY_API_KEY");
        let result = test_search_provider(
            "perplexity".into(),
            serde_json::json!({
                "web": {
                    "perplexityApiKey": ""
                }
            }),
        )
        .await;
        let err = result.expect_err("unconfigured provider must fail");
        assert_eq!(
            err.to_string(),
            "Search provider 'perplexity' is not configured with an API key or URL"
        );
    }
}
