//! Integration tests for the T5 interactive-login surface (issue #126): the
//! PKCE DCR flow, the legacy CLI SSO device flow, the pasted-token fallback,
//! the refresh arms, and the two structural lints (the constant-time callback
//! `state` check, the `generate_handler!` registration).
//!
//! Hermeticity: every exchange hits a `wiremock` server, never a real IdP; no
//! test launches a real browser (the opener seam is injected); every store
//! write goes to a `ScratchDir` path (ADR 0078 — dash prefix, no dot), so the
//! real `dirs::data_dir()/archimedes/provider-auth.json` is never touched.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use archimedes_lib::agent::provider_auth::cli_sso::{self, PollOutcome};
use archimedes_lib::agent::provider_auth::litellm_oauth;
use archimedes_lib::agent::provider_auth::store::{self, OAuthCredential, ProviderCredential};
use archimedes_lib::agent::provider_auth::{refresh, resolve_bearer_at, ProviderLoginStep as Step};
use archimedes_lib::config::ProviderConfig;
use archimedes_lib::test_support::ScratchDir;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{body_json, body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── the shared fixtures ───────────────────────────────────────────────────

/// A scratch dir for ONE test, OWNED (ADR 0078 — dash prefix, no dot).
fn scratch(tag: &str) -> ScratchDir {
    ScratchDir::in_env_temp("litellm-pkce-", tag)
}

/// A `ProviderConfig` on the given auth mode with the given static `api_key`.
fn provider(id: &str, auth_mode: &str, api_key: &str) -> ProviderConfig {
    ProviderConfig {
        id: id.to_string(),
        name: format!("Provider {id}"),
        base_url: "https://gw.example/v1".to_string(),
        api_key: api_key.to_string(),
        api: "litellm".to_string(),
        key_url: None,
        auth_mode: auth_mode.to_string(),
        // (issue #129) The mechanical additive grow: T2a's `ProviderConfig`
        // gained `headers` + `allow_insecure_http`; these fixtures use neither.
        headers: None,
        allow_insecure_http: false,
        // (issue #128) The mechanical additive grow: T4's `ProviderConfig`
        // gained `use_gcloud_token_auth`; these fixtures never use the ADC flow.
        use_gcloud_token_auth: false,
        // (issue #127) The mechanical additive grow: no OIDC login on this fixture.
        oidc: None,
    }
}

/// A stored OAuth credential on the given flow (the shape T5's login writes).
fn stored(id: &str, flow: &str) -> OAuthCredential {
    OAuthCredential {
        flow: flow.to_string(),
        access_token: format!("bearer-{id}"),
        refresh_token: Some(format!("refresh-{id}")),
        expires_at: Some(store::now_epoch_millis() + 3_600_000),
        base_url: "https://gw.example".to_string(),
        client_id: Some(format!("client-{id}")),
        token_endpoint: Some("https://auth.example/token".to_string()),
        resource: Some("https://gw.example".to_string()),
    }
}

/// What the simulated browser did: the URLs it was handed (so a test can assert
/// what a real browser WOULD have opened) + the tasks it spawned (so the test
/// joins every one of them before it ends — ADR 0078's census discipline).
#[derive(Default)]
struct Browser {
    urls: Mutex<Vec<String>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// The opener seam a test injects INSTEAD of a browser (NO real browser is ever
/// launched). It does what a browser does, on the test's own runtime: GET the
/// authorize URL, read the mock's `302` `Location`, and GET that (the loopback
/// callback) — which is what completes the flow.
///
/// Two properties the seam must respect, both taken from `mcp::oauth`'s own
/// `open_browser` test seam:
/// - it SPAWNS and does NOT join. The seam is called from INSIDE the flow, whose
///   task then waits for the callback — joining here would deadlock the flow
///   against its own browser (the first draft of this helper did exactly that,
///   and hung the suite);
/// - it reads the `Location` itself instead of letting reqwest follow the
///   redirect (MCP's comment: a following reqwest against the mock's
///   `Connection: close` is flaky).
fn fake_browser(browser: Arc<Browser>) -> impl Fn(&str) + Send + Sync {
    move |url: &str| {
        browser.urls.lock().unwrap().push(url.to_string());
        let url = url.to_string();
        let handle = tokio::spawn(async move {
            // redirect(NONE): the two legs are explicit, so the mock's 302
            // emission is actually exercised (a following client would hide it).
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("a client for the simulated browser");
            let Ok(resp) = client.get(&url).send().await else {
                return;
            };
            let Some(location) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
            else {
                return;
            };
            // The callback leg: this GET is what the real browser's redirect
            // would be, and the flow's `wait` is its server.
            let _ = client.get(location).send().await;
        });
        browser.tasks.lock().unwrap().push(handle);
    }
}

/// The opener seam for a test that never expects a launch (a fallback leg).
fn no_browser() -> Box<dyn Fn(&str) + Send + Sync> {
    Box::new(|_url: &str| {})
}

/// Wait for every simulated-browser task and return the URLs it was handed
/// (joining the tasks is the census discipline; the URLs are the assertion).
async fn opened(browser: &Arc<Browser>) -> Vec<String> {
    let tasks: Vec<_> = browser.tasks.lock().unwrap().drain(..).collect();
    for task in tasks {
        let _ = task.await;
    }
    browser.urls.lock().unwrap().clone()
}

/// The discovery document a mock proxy serves, pinned to the mock's own origin
/// (the RFC 8414 §3.3 identity check compares it against the fetched base).
fn discovery_doc(server_uri: &str) -> serde_json::Value {
    serde_json::json!({
        "contract_version": 1,
        "issuer": server_uri,
        "authorization_endpoint": format!("{server_uri}/authorize"),
        "token_endpoint": format!("{server_uri}/token"),
        "registration_endpoint": format!("{server_uri}/register"),
        "revocation_endpoint": format!("{server_uri}/revoke"),
        "resource": server_uri,
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"]
    })
}

// ── ruling R8: an explicit auth mode beats an inferred `!` prefix ─────────

#[tokio::test]
async fn a_row_with_a_bang_key_and_oauth_mode_serves_the_stored_token() {
    // Ruling R8 (interface §10). Before the fix, arm 3's
    // `_ if provider.api_key.starts_with('!')` guard sat ABOVE the
    // `"oauth" | "oidc"` arm and a `_`-guard matches ANY `auth_mode`, so a row
    // carrying BOTH a `!`-prefixed `api_key` AND `authMode: "oauth"` took the
    // key-helper arm and silently ignored its stored OAuth token.
    //
    // The fix narrows arm 3's guard to the `api_key` auth mode, so the explicit
    // auth mode wins (the interface §4 documented precedence: an explicit auth
    // mode beats an inferred `!` prefix). The helper is NEVER spawned here — the
    // `!` string names a program that does not exist, so had the helper arm been
    // taken the answer would be `None` (a failed helper degrades), never the
    // stored token.
    let dir = scratch("r8");
    let auth_file = dir.path().join("provider-auth.json");
    store::store_credential(
        &auth_file,
        "gw",
        ProviderCredential::OAuth(stored("gw", "litellm_cli_pkce")),
    )
    .expect("the store is seeded");

    let client = reqwest::Client::new();
    let bearer = resolve_bearer_at(
        &provider("gw", "oauth", "!/nonexistent/key/helper --print-token"),
        &auth_file,
        dir.path(),
        &client,
        true,
    )
    .await;
    assert_eq!(
        bearer.as_deref(),
        Some("bearer-gw"),
        "authMode: \"oauth\" beats the inferred `!` prefix — the STORED token is served"
    );
}

#[tokio::test]
async fn a_bang_key_with_the_default_api_key_mode_still_runs_the_helper() {
    // R8's other half: narrowing the guard must not break the helper for the
    // mode it was built for. `auth_mode: "api_key"` (the serde default) with a
    // `!`-key still takes the helper arm — the stored credential for the SAME id
    // is ignored, because an `api_key` row serves its key, not the store.
    let dir = scratch("r8-helper");
    let auth_file = dir.path().join("provider-auth.json");
    store::store_credential(
        &auth_file,
        "gw",
        ProviderCredential::OAuth(stored("gw", "litellm_cli_pkce")),
    )
    .expect("the store is seeded (but an api_key row must not read it)");

    let client = reqwest::Client::new();
    let bearer = resolve_bearer_at(
        &provider("gw", "api_key", "!/nonexistent/key/helper"),
        &auth_file,
        dir.path(),
        &client,
        true,
    )
    .await;
    assert_eq!(
        bearer, None,
        "the helper arm was taken (a failed helper degrades to `None` — the stored \
         token was NOT consulted, so an api_key row keeps its documented behaviour)"
    );
}

// ── the PKCE DCR flow, end to end ─────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pkce_flow_completes_end_to_end_against_a_mock_proxy() {
    // The acceptance criterion "full end-to-end authentication via system
    // browser", in its measurable form (plan §7): discovery → DCR → browser
    // (simulated) → callback → code exchange → a stored credential. NO real
    // browser and NO real IdP are involved.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/litellm-cli-auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery_doc(&base)))
        .expect(1)
        .named("discovery")
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/register"))
        .and(body_string_contains(
            r#""token_endpoint_auth_method":"none""#,
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "client_id": "archimedes-client",
            "client_name": "archimedes"
        })))
        .expect(1)
        .named("registration (public client)")
        .mount(&server)
        .await;
    // The authorize endpoint answers the 302 the simulated browser follows to
    // the loopback callback — carrying the state + a code back verbatim is the
    // IdP's job, so the mock echoes the `state` and `redirect_uri` it was given.
    Mock::given(method("GET"))
        .and(path("/authorize"))
        .respond_with(|req: &wiremock::Request| {
            let query = req.url.query().unwrap_or_default().to_string();
            let state = query
                .split('&')
                .find_map(|pair| pair.strip_prefix("state="))
                .unwrap_or_default()
                .to_string();
            let redirect = query
                .split('&')
                .find_map(|pair| pair.strip_prefix("redirect_uri="))
                .unwrap_or_default()
                .to_string();
            let target = percent_decode(&format!("{redirect}?code=the-auth-code&state={state}"));
            ResponseTemplate::new(302).insert_header("Location", target)
        })
        .expect(1)
        .named("authorize")
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains("code_verifier="))
        .and(body_string_contains("client_id=archimedes-client"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "pkce-access-token",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "pkce-refresh-token",
            "user_id": "u-1",
            "team_id": "team-1"
        })))
        .expect(1)
        .named("code exchange")
        .mount(&server)
        .await;

    let dir = scratch("pkce-e2e");
    let auth_file = dir.path().join("provider-auth.json");
    let browser = Arc::new(Browser::default());
    // The expiry is computed INSIDE the flow, so the assertion brackets the call
    // (sampling `now` only afterwards would race a token minted a millisecond
    // earlier and fail the lower bound).
    let before = store::now_epoch_millis();
    let step = litellm_oauth::login(
        "gw",
        &base,
        &auth_file,
        &fake_browser(browser.clone()),
        &CancellationToken::new(),
    )
    .await
    .expect("the flow completes against the mock");
    assert_eq!(
        step,
        Step::Authenticated,
        "the stored credential is the answer"
    );

    // The stored credential (interface §3's shape, T5's flow label).
    let loaded = store::load(&auth_file);
    // An IRREFUTABLE `let` (the enum has one variant today — T1's precedent):
    // adding T6's `Oidc` turns this into a compile error, which is the extension
    // point behaving rather than a warning.
    // (issue #127) This was an irrefutable `let` while the enum had one variant;
    // T6's additive `Oidc` variant made it refutable, and the panic arm is the
    // checklist item that error demanded — an `oauth` credential resolving into
    // another variant is a bug, not a path.
    let ProviderCredential::OAuth(cred) = &loaded.providers["gw"] else {
        panic!(
            "an oauth row resolved to a non-oauth credential: {:?}",
            loaded.providers["gw"]
        );
    };
    assert_eq!(cred.flow, "litellm_cli_pkce");
    assert_eq!(cred.access_token, "pkce-access-token");
    assert_eq!(cred.refresh_token.as_deref(), Some("pkce-refresh-token"));
    assert_eq!(cred.client_id.as_deref(), Some("archimedes-client"));
    assert_eq!(
        cred.token_endpoint.as_deref(),
        Some(&format!("{base}/token")[..])
    );
    assert_eq!(cred.resource.as_deref(), Some(base.as_str()));
    // `expires_in: 3600` SECONDS became MILLISECONDS (interface §3's unit rule).
    let expires_at = cred.expires_at.expect("an advertised expiry");
    let after = store::now_epoch_millis();
    assert!(
        expires_at >= before + 3_600_000 && expires_at <= after + 3_600_000,
        "`expires_at` is (the flow's `now`) + 3600 SECONDS expressed in MILLIS \
         (before={before}, after={after}, at={expires_at}) — a SECONDS mixup lands \
         at +3.6s and fails the lower bound"
    );

    let urls = opened(&browser).await;
    // The `code_verifier` NEVER left the process: the only place it could be
    // persisted is the store, and the stored entry has no field that could hold
    // it — assert the raw bytes are absent from the FILE, not merely absent from
    // the parsed struct.
    let raw = std::fs::read_to_string(&auth_file).expect("the store file");
    let authorize = urls[0].clone();
    let verifier = authorize
        .split('&')
        .find_map(|p| {
            p.starts_with("code_challenge=")
                .then(|| percent_decode(p.trim_start_matches("code_challenge=")))
                .map(|challenge| format!("&code_verifier={}", url_encode(&challenge)))
        })
        .unwrap_or_default();
    // (the challenge itself is a hash, so it is safe on disk; the VERIFIER is
    // what must never appear — assert neither the challenge nor any verifier
    // shape was persisted.)
    let _ = verifier;
    let challenge = authorize
        .split('&')
        .find_map(|p| p.strip_prefix("code_challenge="))
        .unwrap_or_default()
        .to_string();
    assert!(
        !raw.contains(&percent_decode(&challenge)),
        "the PKCE challenge (and therefore the verifier it derives from) never \
         reaches the credential file"
    );
    assert!(
        !raw.contains("code_verifier"),
        "no verifier field is ever stored"
    );

    // And the row now SERVES the stored token (the resolve arm + R8's order).
    let bearer = resolve_bearer_at(
        &provider("gw", "oauth", ""),
        &auth_file,
        dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(bearer.as_deref(), Some("pkce-access-token"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authorize_url_carries_the_resource_and_s256_challenge() {
    // The URL the browser was handed is the whole contract: without `resource`
    // (RFC 8707) the same authorize takes LiteLLM's MCP path and the minted
    // token is rejected on `/v1/*`; without S256 the PKCE leg is `plain`.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/litellm-cli-auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery_doc(&base)))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/register"))
        .respond_with(
            ResponseTemplate::new(201).set_body_json(serde_json::json!({"client_id": "cid"})),
        )
        .mount(&server)
        .await;
    // A CANCELLED flow: the browser is handed the URL before the wait begins,
    // and an already-cancelled token ends the wait deterministically (the
    // cancel is the only ready branch in the handler's `select!`).
    let cancel = CancellationToken::new();
    let dir = scratch("authorize-url");
    cancel.cancel();
    let err = litellm_oauth::login(
        "gw",
        &base,
        &dir.path().join("provider-auth.json"),
        &no_browser(),
        &cancel,
    )
    .await
    .expect_err("a cancelled flow never authenticates");
    assert!(err.contains("cancelled"), "the cancel surfaces: {err}");

    // The deterministic leg: re-run the flow through the seam (the fake browser
    // records the URL it was handed).
    let cancel = CancellationToken::new();
    let browser = Arc::new(Browser::default());
    Mock::given(method("GET"))
        .and(path("/authorize"))
        .respond_with(|req: &wiremock::Request| {
            let query = req.url.query().unwrap_or_default().to_string();
            let state = query
                .split('&')
                .find_map(|p| p.strip_prefix("state="))
                .unwrap_or_default()
                .to_string();
            let redirect = query
                .split('&')
                .find_map(|p| p.strip_prefix("redirect_uri="))
                .unwrap_or_default()
                .to_string();
            ResponseTemplate::new(302).insert_header(
                "Location",
                percent_decode(&format!("{redirect}?code=c&state={state}")),
            )
        })
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "a", "expires_in": 60, "refresh_token": "r"
        })))
        .mount(&server)
        .await;
    let step = litellm_oauth::login(
        "gw",
        &base,
        &dir.path().join("provider-auth.json"),
        &fake_browser(browser.clone()),
        &cancel,
    )
    .await
    .expect("the flow completes");
    assert_eq!(step, Step::Authenticated);
    let urls = opened(&browser).await;
    assert_eq!(urls.len(), 1, "exactly one browser launch");
    let url = &urls[0];
    assert!(url.starts_with(&format!("{base}/authorize?")), "{url}");
    for expected in [
        "response_type=code",
        "client_id=cid",
        "code_challenge_method=S256",
        // The RFC 8707 resource, percent-encoded (the mock's own origin).
        &format!("resource={}", url_encode(&base)),
    ] {
        assert!(
            url.contains(expected),
            "the authorize URL carries {expected}: {url}"
        );
    }
    // The redirect URI is the LOOPBACK `/callback` shape (not the bare host MCP
    // uses) — LiteLLM's native-client contract registers the path explicitly.
    let redirect = url
        .split('&')
        .find_map(|p| p.strip_prefix("redirect_uri="))
        .expect("a redirect_uri");
    let redirect = percent_decode(redirect);
    assert!(
        redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/callback"),
        "the loopback redirect URI is 127.0.0.1:<ephemeral>/callback: {redirect}"
    );
    // The state is a NON-EMPTY opaque value (the CSRF guard the callback checks
    // in constant time).
    let state = url
        .split('&')
        .find_map(|p| p.strip_prefix("state="))
        .expect("a state");
    assert!(!state.is_empty(), "the CSRF state is present");
}

// ── the degradation chain ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discovery_404_falls_back_to_the_device_flow() {
    // "Fallback … works seamlessly when DCR is unavailable": a proxy that
    // predates the CLI-auth contract 404s on discovery and the flow degrades to
    // the LEGACY device tier, surfacing the user code + the verification link.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/litellm-cli-auth"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    mount_device_start(&server, &device_start_body()).await;

    let dir = scratch("discovery-404");
    let step = litellm_oauth::login(
        "gw",
        &base,
        &dir.path().join("provider-auth.json"),
        &no_browser(),
        &CancellationToken::new(),
    )
    .await
    .expect("the fallback is a SUCCESS path, not an error");
    assert_eq!(
        step,
        Step::DevicePending {
            login_id: "cli-abc123".to_string(),
            poll_secret: "poll-secret-xyz".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            verification_url: format!("{base}/sso/key/generate?source=litellm-cli&key=cli-abc123"),
        },
        "the device step carries the code the user reads and the link they open"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dcr_404_falls_back_to_the_device_flow() {
    // Discovery served (the proxy advertises the contract) but registration is
    // absent — the documented "discovery without DCR" shape.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/litellm-cli-auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery_doc(&base)))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/register"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    mount_device_start(&server, &device_start_body()).await;

    let dir = scratch("dcr-404");
    let step = litellm_oauth::login(
        "gw",
        &base,
        &dir.path().join("provider-auth.json"),
        &no_browser(),
        &CancellationToken::new(),
    )
    .await
    .expect("a missing DCR endpoint degrades");
    assert!(
        matches!(step, Step::DevicePending { .. }),
        "the device tier takes over: {step:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_broken_dcr_endpoint_is_surfaced_not_silently_downgraded() {
    // The boundary of the degradation rule: 404/405 means "this proxy has no
    // DCR" (fall back); a 500 means "the proxy's DCR is broken" — silently
    // dropping the user to a legacy tier would hide a real misconfiguration.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/litellm-cli-auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery_doc(&base)))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/register"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;

    let dir = scratch("dcr-500");
    let err = litellm_oauth::login(
        "gw",
        &base,
        &dir.path().join("provider-auth.json"),
        &no_browser(),
        &CancellationToken::new(),
    )
    .await
    .expect_err("a 500 on registration is an error");
    assert!(err.contains("500"), "the status is carried: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_invalid_discovery_document_is_surfaced_never_downgraded() {
    // The other half of the rule: a 200 with a document the contract forbids
    // (contract_version 2) is a MISCONFIGURED proxy, not an old one. Only a 404
    // means "this proxy predates the contract".
    let server = MockServer::start().await;
    let base = server.uri();
    let mut doc = discovery_doc(&base);
    doc["contract_version"] = serde_json::json!(2);
    Mock::given(method("GET"))
        .and(path("/.well-known/litellm-cli-auth"))
        .respond_with(ResponseTemplate::new(200).set_body_json(doc))
        .expect(1)
        .mount(&server)
        .await;

    let dir = scratch("bad-discovery");
    let err = litellm_oauth::login(
        "gw",
        &base,
        &dir.path().join("provider-auth.json"),
        &no_browser(),
        &CancellationToken::new(),
    )
    .await
    .expect_err("an invalid document is an error");
    assert!(
        err.contains("contract_version"),
        "the violated check is named: {err}"
    );
}

// ── the legacy device flow ────────────────────────────────────────────────

fn device_start_body() -> serde_json::Value {
    // The verified `POST /sso/cli/start` payload (§11a — `ui_sso.py`).
    serde_json::json!({
        "login_id": "cli-abc123",
        "poll_secret": "poll-secret-xyz",
        "user_code": "ABCD-EFGH",
        "expires_in": 600
    })
}

async fn mount_device_start(server: &MockServer, body: &serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/sso/cli/start"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
        .expect(1)
        .named("device start")
        .mount(server)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_flow_starts_and_returns_the_user_code_and_verification_link() {
    let server = MockServer::start().await;
    let base = server.uri();
    mount_device_start(&server, &device_start_body()).await;

    let session = cli_sso::start_device_flow(&base, &reqwest::Client::new())
        .await
        .expect("the start succeeds");
    assert_eq!(session.login_id, "cli-abc123");
    assert_eq!(session.poll_secret, "poll-secret-xyz");
    assert_eq!(session.user_code, "ABCD-EFGH", "the code the user reads");
    assert_eq!(session.expires_in, Some(600));
    // The link the issue's acceptance criterion names, verbatim.
    assert_eq!(
        cli_sso::verification_url(&base, &session.login_id),
        format!("{base}/sso/key/generate?source=litellm-cli&key=cli-abc123")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_flow_poll_returns_ready_and_stores_the_token() {
    // One poll tick hits the endpoint WITH the poll-secret header, and a `ready`
    // answer stores `flow: "litellm_cli_sso"` through T1's atomic 0600 path.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/sso/cli/poll/cli-abc123"))
        .and(header("x-litellm-cli-poll-secret", "poll-secret-xyz"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "ready",
            "key": "device-flow-jwt",
            "user_id": "u-1",
            "team_id": "team-1"
        })))
        .expect(1)
        .named("poll with the secret header")
        .mount(&server)
        .await;

    let session = cli_sso::DeviceSession {
        login_id: "cli-abc123".to_string(),
        poll_secret: "poll-secret-xyz".to_string(),
        user_code: "ABCD-EFGH".to_string(),
        expires_in: Some(600),
        verification_uri_complete: None,
    };
    let outcome = cli_sso::poll_once(&base, &session, None, &reqwest::Client::new())
        .await
        .expect("the tick succeeds");
    assert!(
        matches!(outcome, PollOutcome::Ready { .. }),
        "the verified final shape is Ready: {outcome:?}"
    );
    // The header presence is asserted on the RECORDED request (the matcher above
    // would have 404'd without it, but the recorded bytes are the direct proof).
    let recorded = server.received_requests().await.expect("recorded");
    let poll = recorded
        .iter()
        .find(|r| r.url.path().starts_with("/sso/cli/poll/"))
        .expect("the poll request");
    assert_eq!(
        poll.headers
            .get("x-litellm-cli-poll-secret")
            .and_then(|v| v.to_str().ok()),
        Some("poll-secret-xyz"),
        "the tick carries the poll secret (the proxy 403s without it)"
    );

    let dir = scratch("device-ready");
    let auth_file = dir.path().join("provider-auth.json");
    let cred = cli_sso::store_device_token(&auth_file, "gw", &base, &outcome).expect("stores");
    assert_eq!(cred.flow, "litellm_cli_sso");
    assert_eq!(cred.access_token, "device-flow-jwt");
    assert_eq!(
        cred.refresh_token, None,
        "the device-flow JWT has NO refresh token (§11b) — the reason refresh is a no-op"
    );
    // The store file is the T1 document, camelCase, with the flow label.
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&auth_file).expect("the store")).unwrap();
    assert_eq!(raw["providers"]["gw"]["flow"], "litellm_cli_sso");
    assert_eq!(raw["providers"]["gw"]["accessToken"], "device-flow-jwt");

    // And the row serves it (the resolve arm treats `flow` as data, not a
    // match arm — the plan §4d invariant).
    let bearer = resolve_bearer_at(
        &provider("gw", "oauth", ""),
        &auth_file,
        dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(bearer.as_deref(), Some("device-flow-jwt"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_flow_poll_asks_for_team_selection_without_a_key() {
    // The VERIFIED team-pick shape (§11b): `status: ready` +
    // `requires_team_selection: true` + `teams`/`team_details`, and NO `key`.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/sso/cli/poll/cli-abc123"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "ready",
            "requires_team_selection": true,
            "user_id": "u-1",
            "teams": ["team-a", "team-b"],
            "team_details": [
                {"team_id": "team-a", "team_alias": "Alpha"},
                {"team_id": "team-b", "team_alias": "Beta"}
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let session = cli_sso::DeviceSession {
        login_id: "cli-abc123".to_string(),
        poll_secret: "poll-secret-xyz".to_string(),
        user_code: "ABCD-EFGH".to_string(),
        expires_in: None,
        verification_uri_complete: None,
    };
    let outcome = cli_sso::poll_once(&base, &session, None, &reqwest::Client::new())
        .await
        .expect("the tick succeeds");
    let PollOutcome::NeedsTeam(teams) = outcome else {
        panic!("a team-pick ask must not be Ready/Pending: {outcome:?}");
    };
    assert_eq!(teams.len(), 2, "both teams are offered to the user");
    assert_eq!(
        teams[0].team_alias, "Alpha",
        "team_details carries the alias"
    );

    // Nothing is stored for a team-pick ask (there is no key to store) — the
    // store file stays ABSENT, not empty-but-written.
    let dir = scratch("team-ask");
    let auth_file = dir.path().join("provider-auth.json");
    let err = cli_sso::store_device_token(&auth_file, "gw", &base, &PollOutcome::NeedsTeam(teams))
        .expect_err("there is nothing to store yet");
    assert!(err.contains("not ready"), "the error says so: {err}");
    assert!(!auth_file.exists(), "no store file was created");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_flow_repoll_with_team_id_returns_the_jwt() {
    // The VERIFIED team-selection wire (§11b/c): the choice is a SECOND GET of
    // the SAME poll endpoint with `?team_id=` — there is no team-choice POST for
    // a desktop client.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/sso/cli/poll/cli-abc123"))
        .and(wiremock::matchers::query_param("team_id", "team-b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "ready",
            "key": "jwt-for-team-b",
            "user_id": "u-1",
            "team_id": "team-b"
        })))
        .expect(1)
        .named("the team-choice re-poll")
        .mount(&server)
        .await;

    let session = cli_sso::DeviceSession {
        login_id: "cli-abc123".to_string(),
        poll_secret: "poll-secret-xyz".to_string(),
        user_code: "ABCD-EFGH".to_string(),
        expires_in: None,
        verification_uri_complete: None,
    };
    let outcome = cli_sso::choose_team(&base, &session, "team-b", &reqwest::Client::new())
        .await
        .expect("the re-poll answers with the credential");
    match outcome {
        PollOutcome::Ready { token, team_id, .. } => {
            assert_eq!(token, "jwt-for-team-b");
            assert_eq!(team_id.as_deref(), Some("team-b"));
        }
        other => panic!("the team choice must land on Ready: {other:?}"),
    }
    // `wiremock`'s `expect(1)` on the `?team_id=` matcher IS the proof the
    // choice travelled as a query param (an unmatched request would 404 and the
    // expect would fail).
    let requests = server.received_requests().await.expect("recorded");
    let poll = requests
        .iter()
        .find(|r| r.url.path().starts_with("/sso/cli/poll/"))
        .expect("one poll request was recorded");
    assert_eq!(poll.method, "GET", "the choice is a GET, never a POST");
    assert!(poll
        .url
        .query()
        .unwrap_or_default()
        .contains("team_id=team-b"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_flow_poll_400_surfaces_the_expired_session_error() {
    // The proxy's 400 = the session is gone/expired. This is TERMINAL: the
    // message must say "restart", because a caller that retried a 400 forever
    // would poll a dead session past its TTL (the bounded-polling rule).
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("GET"))
        .and(path("/sso/cli/poll/cli-abc123"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "detail": "CLI SSO session not found"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let session = cli_sso::DeviceSession {
        login_id: "cli-abc123".to_string(),
        poll_secret: "poll-secret-xyz".to_string(),
        user_code: "ABCD-EFGH".to_string(),
        expires_in: None,
        verification_uri_complete: None,
    };
    let err = cli_sso::poll_once(&base, &session, None, &reqwest::Client::new())
        .await
        .expect_err("an expired session is an error");
    assert!(
        err.contains("expired") && err.contains("restart"),
        "the error names the condition AND the only recovery: {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_flow_expiry_is_derived_from_the_jwt_exp_claim_or_the_24h_fallback() {
    // PINS OUR ASSUMPTION, not the proxy's contract (§11's kept-honest item):
    // the ready body carries NO lifetime field, so we decode the JWT's `exp`
    // WITHOUT verifying the signature and fall back to 24 h. Driven through the
    // REAL poll path so the derivation is the one the flow uses, not a helper
    // called in isolation.
    let server = MockServer::start().await;
    let base = server.uri();
    // {"exp": 1800000000} as an unsigned-decodable JWT (fake signature).
    let payload = {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":1800000000}"#)
    };
    let jwt = format!("eyJhbGciOiJIUzI1NiJ9.{payload}.not-a-real-signature");
    Mock::given(method("GET"))
        .and(path("/sso/cli/poll/cli-exp"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "ready", "key": jwt, "user_id": "u"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/sso/cli/poll/cli-noexp"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "ready", "key": "this-is-not-a-jwt", "user_id": "u"
        })))
        .mount(&server)
        .await;

    async fn tick(base: &str, login_id: &str) -> Result<PollOutcome, String> {
        let session = cli_sso::DeviceSession {
            login_id: login_id.to_string(),
            poll_secret: "s".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            expires_in: None,
            verification_uri_complete: None,
        };
        cli_sso::poll_once(base, &session, None, &reqwest::Client::new()).await
    }

    let before = store::now_epoch_millis();
    let PollOutcome::Ready { expires_at_ms, .. } = tick(&base, "cli-exp").await.expect("ready")
    else {
        panic!("the mock answers Ready");
    };
    assert_eq!(
        expires_at_ms,
        Some(1_800_000_000_000),
        "the JWT's `exp` (epoch SECONDS) is the credential's expiry, in MILLIS"
    );

    let PollOutcome::Ready { expires_at_ms, .. } = tick(&base, "cli-noexp").await.expect("ready")
    else {
        panic!("the mock answers Ready");
    };
    let after = store::now_epoch_millis();
    let expected = cli_sso::LEGACY_TOKEN_DEFAULT_TTL_HOURS as i64 * 3_600_000;
    assert!(
        expires_at_ms.unwrap() >= before + expected && expires_at_ms.unwrap() <= after + expected,
        "an unparseable JWT falls back to now + {LEGACY}h in MILLIS",
        LEGACY = cli_sso::LEGACY_TOKEN_DEFAULT_TTL_HOURS,
    );
}

// ── the pasted-token fallback ─────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pasted_token_stores_without_minting() {
    // `mint = false` touches NO network at all: the mock server has NOTHING
    // mounted, so any request the code made would 404 — and the mint must not
    // even be attempted (the user asked for no virtual key).
    let server = MockServer::start().await;
    let dir = scratch("paste-bare");
    let auth_file = dir.path().join("provider-auth.json");
    let cred = cli_sso::store_pasted(
        &server.uri(),
        "gw",
        "sk-pasted-token",
        false,
        &auth_file,
        &reqwest::Client::new(),
    )
    .await
    .expect("the paste stores");
    assert_eq!(cred.flow, "pasted_token");
    assert_eq!(
        cred.access_token, "sk-pasted-token",
        "the token is stored verbatim"
    );
    assert_eq!(
        cred.refresh_token, None,
        "a pasted token has nothing to rotate"
    );
    assert_eq!(
        cred.expires_at, None,
        "no invented lifetime (T1's None = never expires)"
    );
    assert_eq!(
        server.received_requests().await.expect("recorded").len(),
        0,
        "no mint was attempted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pasted_token_with_virtual_key_minting_uses_the_minted_key() {
    // The VERIFIED mint wire (§11d): `POST {base}/key/generate` with
    // `Authorization: Bearer <pasted>` (the endpoint is `user_api_key_auth`-gated
    // — without the bearer it 401s) and an EMPTY `{}` body.
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("POST"))
        .and(path("/key/generate"))
        .and(header("authorization", "Bearer sk-pasted-token"))
        .and(body_json(serde_json::json!({})))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "key": "sk-minted-virtual-key",
            "user_id": "u-1"
        })))
        .expect(1)
        .named("the mint (bearer + empty body)")
        .mount(&server)
        .await;

    let dir = scratch("paste-mint");
    let auth_file = dir.path().join("provider-auth.json");
    let cred = cli_sso::store_pasted(
        &base,
        "gw",
        "sk-pasted-token",
        true,
        &auth_file,
        &reqwest::Client::new(),
    )
    .await
    .expect("the mint succeeds");
    assert_eq!(
        cred.access_token, "sk-minted-virtual-key",
        "the MINTED key is stored, not the pasted one"
    );
    assert_eq!(
        cred.flow, "pasted_token",
        "the flow label is the paste tier"
    );
    // The pasted token is NOT what the store serves, and the minted key is.
    let bearer = resolve_bearer_at(
        &provider("gw", "oauth", ""),
        &auth_file,
        dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(bearer.as_deref(), Some("sk-minted-virtual-key"));
    // A minted key with no `expires` is long-lived → no expiry (never invented).
    assert_eq!(cred.expires_at, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pasted_token_minting_404_keeps_the_pasted_token() {
    // The degradation rule: a mint failure (404 here, 401 next) must NEVER fail
    // the paste — pi's "using SSO token directly" fallback.
    for status in [404u16, 401] {
        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("POST"))
            .and(path("/key/generate"))
            .respond_with(ResponseTemplate::new(status))
            .expect(1)
            .mount(&server)
            .await;
        let dir = scratch(&format!("paste-mint-{status}"));
        let auth_file = dir.path().join("provider-auth.json");
        let cred = cli_sso::store_pasted(
            &base,
            "gw",
            "sk-pasted-token",
            true,
            &auth_file,
            &reqwest::Client::new(),
        )
        .await
        .unwrap_or_else(|e| panic!("a {status} mint failure degrades, it never fails: {e}"));
        assert_eq!(
            cred.access_token, "sk-pasted-token",
            "the pasted token stands when the mint fails ({status})"
        );
        assert_eq!(cred.flow, "pasted_token");
    }
}

// ── the refresh arms ──────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_pkce_exchanges_the_refresh_token_and_rotates_it() {
    // The acceptance criterion "token refresh automatically executed in
    // background before expiry", at the dispatcher arm T1's Supervisor loop
    // calls: the refresh grant is FORM-encoded with `client_id` + `resource` and
    // NO client secret (ADR 0015's MCP guard is deliberately NOT applied — the
    // opposite is correct for this public client), and the rotated pair REPLACES
    // the stored one (a used refresh token is refused with `invalid_grant`).
    let server = MockServer::start().await;
    let base = server.uri();
    Mock::given(method("POST"))
        .and(path("/token"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=old-rotating-token"))
        .and(body_string_contains("client_id=archimedes-client"))
        .and(body_string_contains(format!(
            "resource={}",
            url_encode(&base)
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "rotated-access",
            "token_type": "Bearer",
            "expires_in": 7200,
            "refresh_token": "new-rotating-token"
        })))
        .expect(1)
        .named("the refresh grant")
        .mount(&server)
        .await;

    let cred = ProviderCredential::OAuth(OAuthCredential {
        flow: "litellm_cli_pkce".to_string(),
        access_token: "stale-access".to_string(),
        refresh_token: Some("old-rotating-token".to_string()),
        expires_at: Some(store::now_epoch_millis()),
        base_url: base.clone(),
        client_id: Some("archimedes-client".to_string()),
        token_endpoint: Some(format!("{base}/token")),
        resource: Some(base.clone()),
    });
    let before = store::now_epoch_millis();
    let refreshed = refresh(&cred, &reqwest::Client::new())
        .await
        .expect("the arm performs the rotation");
    let after = store::now_epoch_millis();

    // (issue #127) An irrefutable `let` until T6's additive `Oidc` variant made it
    // refutable — the compile error IS the extension point, and this panic arm is
    // the fix it asked for (a `litellm_cli_pkce` credential rotating into another
    // variant is a bug, never a branch to serve).
    let ProviderCredential::OAuth(next) = &refreshed else {
        panic!("an oauth credential refreshed into a non-oauth variant: {refreshed:?}");
    };
    assert_eq!(next.access_token, "rotated-access");
    assert_eq!(
        next.refresh_token.as_deref(),
        Some("new-rotating-token"),
        "the ROTATED refresh token replaces the stored one (LiteLLM refuses a used one)"
    );
    let expires_at = next.expires_at.expect("`expires_in` became `expires_at`");
    assert!(
        expires_at >= before + 7_200_000 && expires_at <= after + 7_200_000,
        "the new expiry is now + 7200 SECONDS in MILLIS (before={before}, at={expires_at})"
    );
    // The identity fields survive (the arm rebuilds from the stored credential).
    assert_eq!(next.flow, "litellm_cli_pkce");
    assert_eq!(next.client_id.as_deref(), Some("archimedes-client"));
    assert_eq!(
        next.token_endpoint.as_deref(),
        Some(&format!("{base}/token")[..])
    );
    assert_eq!(next.resource.as_deref(), Some(base.as_str()));

    // NO client secret was sent (a public client has none — the delta from MCP's
    // `client_secret_basic` body).
    let recorded = server
        .received_requests()
        .await
        .expect("recorded")
        .into_iter()
        .find(|r| r.url.path() == "/token")
        .expect("the token request");
    let body = String::from_utf8_lossy(&recorded.body).to_string();
    assert!(
        !body.contains("client_secret"),
        "a public client sends no secret: {body}"
    );
    let auth_header = recorded
        .headers
        .get("authorization")
        .map(|v| v.to_str().unwrap_or_default().to_string())
        .unwrap_or_default();
    assert!(
        auth_header.is_empty(),
        "no Basic auth header either: {auth_header}"
    );
}

#[tokio::test]
async fn pasted_token_and_cli_sso_refresh_are_noops() {
    // The DELIBERATE no-op pin (plan §4e): a device-flow JWT and a pasted/minted
    // key are static bearers with NO refresh token, so their arms return the
    // credential BYTE-IDENTICAL. This test is what makes the no-op a decision
    // rather than an omission — if either flow ever advertises a refresh
    // mechanism, this pin fails at the store level.
    let client = reqwest::Client::new();
    for flow in ["litellm_cli_sso", "pasted_token"] {
        let cred = ProviderCredential::OAuth(stored("gw", flow));
        let got = refresh(&cred, &client)
            .await
            .unwrap_or_else(|e| panic!("a {flow} refresh is a no-op, never an error: {e}"));
        assert_eq!(
            got, cred,
            "the WHOLE credential (token, refresh token, expiry, flow) is unchanged for {flow}"
        );
    }
}

// ── the structural lints ──────────────────────────────────────────────────

/// Read a source file relative to the crate root (the census-lint precedent:
/// vacuity-guarded — an unreadable file PANICS rather than passing silently).
fn crate_source(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {relative:?}: {e}"))
}

#[test]
fn callback_state_check_is_constant_time_lint() {
    // The load-bearing STRUCTURAL pin (plan §5a): `cargo test` cannot observe
    // timing, so what is pinned is the SHAPE of the comparison — the callback's
    // production region must route the `state` guard through `constant_time_eq`
    // and must NOT contain a `String !=` comparison that a revert would
    // reintroduce. Behavior is pinned by `callback.rs`'s own tests (equal /
    // first-byte / last-byte / length-mismatch, plus MCP's matching/mismatched
    // state tests staying green). NO test here claims to measure timing.
    let source = crate_source("src/agent/mcp/callback.rs");
    // Vacuity guard: the region we lint exists at all.
    let wait_start = source
        .find("pub async fn wait(")
        .expect("the wait handler exists");
    let wait_end = source[wait_start..]
        .find("\n}\n")
        .map(|i| wait_start + i)
        .expect("the wait handler closes");
    let wait_region = &source[wait_start..wait_end];
    let wait_code: String = wait_region
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        wait_code.contains("constant_time_eq(state.as_bytes(), expected_state.as_bytes())"),
        "the `state` guard goes through the constant-time helper:\n{wait_code}"
    );
    // The revert detectors: any of these texts in the handler means the guard is
    // back to a short-circuiting comparison.
    for forbidden in [
        "state != expected_state",
        "!= expected_state",
        "state.as_str() !=",
        "expected_state !=",
        "state == expected_state",
    ] {
        assert!(
            !wait_code.contains(forbidden),
            "the callback must not compare `state` with `{forbidden}`: a `String !=` \
             comparison short-circuits on the first differing byte",
        );
    }
    // And the helper itself has no early exit inside its byte loop. The lint
    // runs over the CODE ONLY — comment lines are stripped first, or the helper's
    // own doc comment (which NAMES the forbidden constructs to explain why they
    // are absent) would trip every detector.
    let helper_start = source
        .find("pub(crate) fn constant_time_eq(")
        .expect("the ONE constant-time helper exists (ruling R4)");
    let helper_end = source[helper_start..]
        .find("\n}\n")
        .map(|i| helper_start + i)
        .expect("the helper closes");
    let helper: String = source[helper_start..helper_end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in [
        "?;",
        "return true",
        "break",
        "continue",
        ".position(",
        ".iter().any(",
    ] {
        assert!(
            !helper.contains(forbidden),
            "the helper must not contain `{forbidden}` — an early exit on a byte \
             mismatch is exactly the timing leak this exists to avoid:\n{helper}"
        );
    }
    // `pub(crate)`, per R4 — T6's `oidc.rs` IMPORTS this rather than writing a
    // second implementation of a security primitive.
    assert!(
        helper.contains("pub(crate) fn constant_time_eq"),
        "R4 needs the helper reachable crate-wide"
    );
}

#[test]
fn login_commands_are_registered_in_generate_handler() {
    // The command surface T8 renders is worthless if the commands are not on the
    // invoke whitelist. The `window_state_plugin_is_registered…` precedent: read
    // `lib.rs` and assert each entry is present (vacuity-guarded by the read).
    let source = crate_source("src/lib.rs");
    for command in [
        "commands::settings::provider_login_oauth",
        "commands::settings::provider_login_sso_poll",
        "commands::settings::provider_login_sso_choose_team",
        "commands::settings::provider_login_paste_token",
    ] {
        assert!(
            source.contains(command),
            "`{command}` is missing from `generate_handler!` (T8's invoke would fail at runtime)"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn store_writes_land_in_the_scratch_path_never_the_real_dir() {
    // The R3 belt-and-braces pin: every T5 flow takes `store_path`, and the REAL
    // data-dir `provider-auth.json` (the one `store::auth_file_path()` resolves)
    // is untouched by a test. We do not ASSERT the real file's absence (a
    // developer running the suite legitimately HAS credentials there) — we
    // assert the write went to the injected path AND that the injected path is
    // not the production one, which is the property that actually matters.
    let real = store::auth_file_path();
    let dir = scratch("store-path");
    let auth_file = dir.path().join("provider-auth.json");
    assert_ne!(
        auth_file, real,
        "the premise: an injected scratch path is NOT the production store"
    );
    // The production path's SHAPE is the ruling (R3): the DATA dir, `archimedes`,
    // beside `mcp-auth.json` — never `config_dir`.
    assert_eq!(
        real.file_name().and_then(|s| s.to_str()),
        Some("provider-auth.json"),
        "the store is `provider-auth.json`"
    );
    assert_eq!(
        real.parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str()),
        Some("archimedes"),
        "it sits in `<data_dir>/archimedes` (the DATA dir, beside `mcp-auth.json`) — \
         never `config_dir` (ruling R3)"
    );

    // Every write path lands in the scratch dir.
    cli_sso::store_pasted(
        "http://127.0.0.1:1",
        "gw",
        "sk-x",
        false,
        &auth_file,
        &reqwest::Client::new(),
    )
    .await
    .expect("the paste stores");
    assert!(auth_file.exists(), "the scratch store was written");
    let written: Vec<PathBuf> = walk(dir.path())
        .into_iter()
        .filter(|p| p.file_name().and_then(|s| s.to_str()) == Some("provider-auth.json"))
        .collect();
    assert_eq!(
        written,
        vec![auth_file.clone()],
        "exactly the injected file"
    );
    // And the file is the T1 store's own 0600 atomic write (mode asserted where
    // the platform reports it).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&auth_file)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the token file is 0600 at creation (T1's atomic store)"
        );
    }
}

/// A tiny recursive listing (the census helper — no walkdir dependency).
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// Percent-encode a query value (RFC 3986 unreserved set) — the test-side twin
/// of the flow's encoder, for building matcher strings.
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A minimal percent-DECODE (the mock echoes percent-encoded values back into a
/// `Location` header that must be a plain URL).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
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
