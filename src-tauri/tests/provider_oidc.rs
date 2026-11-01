//! Integration tests for the T6 direct OIDC PKCE login (issue #127): the
//! header-hygiene guarantee, the `redirect_ports` cascade, the full login, the
//! `sub`-consistency refresh guard, the resolve arm, the store variant, and the
//! structural lints (the R4 single constant-time compare, the command
//! registration).
//!
//! Hermeticity: every IdP is a `wiremock` server (self-minted, unverifiable
//! `id_token`s — which is the design, the proxy checks signatures), never a real
//! IdP; no test launches a browser (the opener seam is injected); every store
//! write goes to a `ScratchDir` path (ADR 0078 — dash prefix, no dot), so the real
//! `dirs::data_dir()/archimedes/provider-auth.json` is never touched.

use std::path::Path;
use std::sync::{Arc, Mutex};

use archimedes_lib::agent::provider_auth::store::{self, OidcCredential, ProviderCredential};
use archimedes_lib::agent::provider_auth::{self as provider_auth, oidc};
use archimedes_lib::agent::provider_auth::{refresh, resolve_bearer_at};
use archimedes_lib::config::{OidcConfig, ProviderConfig};
use archimedes_lib::test_support::ScratchDir;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// A scratch dir for ONE test, OWNED (ADR 0078 — dash prefix, no dot).
fn scratch(tag: &str) -> ScratchDir {
    ScratchDir::in_env_temp("provider-oidc-", tag)
}

/// A `ProviderConfig` row (the mechanical fixture every provider test file
/// carries, grown with the fields this suite added).
fn provider(id: &str, auth_mode: &str, api_key: &str) -> ProviderConfig {
    ProviderConfig {
        id: id.to_string(),
        name: format!("Provider {id}"),
        base_url: "https://gw.example/v1".to_string(),
        api_key: api_key.to_string(),
        api: "litellm".to_string(),
        key_url: None,
        auth_mode: auth_mode.to_string(),
        headers: None,
        allow_insecure_http: false,
        use_gcloud_token_auth: false,
        oidc: None,
    }
}

/// A stored OIDC credential (the shape the login command writes).
fn stored_oidc(id: &str, sub: &str, token_endpoint: Option<String>) -> OidcCredential {
    OidcCredential {
        flow: "oidc".to_string(),
        id_token: format!("id-{id}"),
        access_token: Some(format!("access-{id}")),
        refresh_token: Some(format!("refresh-{id}")),
        expires_at: Some(store::now_epoch_millis() + 3_600_000),
        sub: sub.to_string(),
        issuer: "https://idp.example".to_string(),
        client_id: Some("archimedes".to_string()),
        token_endpoint,
        scope: Some("openid".to_string()),
    }
}

/// Mint an `id_token` (unverifiable by design — the proxy validates signatures).
fn id_token(claims: serde_json::Value) -> String {
    oidc::build_test_id_token(&claims)
}

// ── the simulated browser (NO real browser is ever launched) ──────────────

/// What the simulated browser did: the URLs it was handed + the tasks it spawned
/// (every one awaited before the test ends — ADR 0078's census discipline).
#[derive(Default)]
struct Browser {
    urls: Mutex<Vec<String>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// Percent-encode a callback-URL value (a local copy: a test does not reach into
/// a private helper of the flow module).
fn enc(s: &str) -> String {
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

/// The opener seam INSTEAD of a browser: parse `redirect_uri` + `state` out of the
/// authorize URL and GET the loopback callback with a `code` — the `mcp::oauth` /
/// `litellm_oauth` 302-free pattern (no `/authorize` endpoint is needed and no
/// redirect is followed, so there is no redirect-following flake).
///
/// SPAWN-DON'T-FOLLOW (the rule the sibling flows state verbatim): this closure
/// runs INSIDE the flow, whose task then waits for the callback this leg triggers —
/// joining here would deadlock the login against its own browser (T5 hit exactly
/// that). The handles are recorded so the test joins them at its tail.
fn fake_browser(browser: Arc<Browser>) -> impl Fn(&str) + Send + Sync {
    move |url: &str| {
        browser.urls.lock().unwrap().push(url.to_string());
        let url = url.to_string();
        let handle = tokio::spawn(async move {
            let Ok(parsed) = url::Url::parse(&url) else {
                return;
            };
            let get = |name: &str| {
                parsed
                    .query_pairs()
                    .find(|(k, _)| k == name)
                    .map(|(_, v)| v.to_string())
            };
            let (Some(redirect_uri), Some(state)) = (get("redirect_uri"), get("state")) else {
                return;
            };
            let callback = format!(
                "{redirect_uri}?code={}&state={}",
                enc("mock-code"),
                enc(&state)
            );
            let Ok(client) = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
            else {
                return;
            };
            let _ = client.get(callback).send().await;
        });
        browser.tasks.lock().unwrap().push(handle);
    }
}

/// Await every simulated-browser leg (the census tail every test runs).
async fn settle(browser: &Browser) {
    let tasks: Vec<_> = browser.tasks.lock().unwrap().drain(..).collect();
    for task in tasks {
        let _ = task.await;
    }
}

/// A standards-shaped fake IdP: discovery + a `/token` endpoint that records the
/// form and answers `id_token`/`access_token`/`refresh_token`/`expires_in`. The
/// `id_token`'s `iss` is the mock's own URI and its `nonce` is the value the login
/// sent (echoed from the token form), so a compliant login validates.
async fn fake_idp(sub: &str) -> (MockServer, OidcConfig, Arc<Mutex<Vec<String>>>) {
    let server = MockServer::start().await;
    Mock::given(path("/.well-known/openid-configuration"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "issuer": server.uri(),
            "authorization_endpoint": format!("{}/authorize", server.uri()),
            "token_endpoint": format!("{}/token", server.uri()),
            "jwks_uri": format!("{}/jwks", server.uri()),
            "id_token_signing_alg_values_supported": ["RS256"],
        })))
        .mount(&server)
        .await;
    let forms = Arc::new(Mutex::new(Vec::<String>::new()));
    let token_forms = forms.clone();
    let issuer = server.uri();
    let sub = sub.to_string();
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(move |req: &Request| {
            let form = String::from_utf8_lossy(&req.body).to_string();
            token_forms.lock().unwrap().push(form.clone());
            let field = |name: &str| {
                form.split('&')
                    .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
                    .unwrap_or_default()
                    .to_string()
            };
            let now = archimedes_lib::agent::mcp::oauth::now_epoch_secs();
            let token = id_token(serde_json::json!({
                "iss": issuer,
                "aud": ["archimedes"],
                "sub": sub,
                "exp": now + 3600,
                "nonce": field("nonce"),
            }));
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "access-1",
                "id_token": token,
                "refresh_token": "refresh-1",
                "expires_in": 3600,
            }))
        })
        .mount(&server)
        .await;
    let config = OidcConfig {
        issuer: server.uri(),
        client_id: "archimedes".to_string(),
        scope: None,
        redirect_ports: vec![],
    };
    (server, config, forms)
}

// ── 1. the full login (the "a compliant IdP works out of the box" criterion) ──

#[tokio::test]
async fn the_oidc_login_completes_and_stores_the_validated_id_token() {
    let (_server, config, forms) = fake_idp("alice").await;
    let browser = Arc::new(Browser::default());
    let cancel = CancellationToken::new();
    let session: oidc::OidcSession =
        oidc::authenticate_oidc(&config, &cancel, &fake_browser(browser.clone()))
            .await
            .expect("the login completes");
    settle(&browser).await;

    // The authorize URL a real browser would have opened.
    let urls = browser.urls.lock().unwrap().clone();
    assert_eq!(urls.len(), 1, "ONE browser hand-off: {urls:?}");
    for want in [
        "response_type=code",
        "client_id=archimedes",
        "code_challenge_method=S256",
        "code_challenge=",
        "state=",
        "nonce=",
        "scope=openid",
    ] {
        assert!(
            urls[0].contains(want),
            "the authorize URL carries `{want}`: {}",
            urls[0]
        );
    }

    // The token request carried the PKCE verifier and the client id, and NO secret
    // (a pre-registered PUBLIC client — T6 does no DCR and holds no secret).
    let token_forms = forms.lock().unwrap().clone();
    assert_eq!(token_forms.len(), 1, "one token request: {token_forms:?}");
    let form = &token_forms[0];
    for want in [
        "grant_type=authorization_code",
        "code=mock-code",
        "code_verifier=",
        "client_id=archimedes",
        "redirect_uri=http%3A%2F%2F127.0.0.1",
    ] {
        assert!(
            form.contains(want),
            "the token form carries `{want}`: {form}"
        );
    }
    assert!(
        !form.contains("client_secret"),
        "a public client sends no secret: {form}"
    );

    // The session carries the VALIDATED identity, and the caller persists it in the
    // contract shape `{"type":"oidc","flow":"oidc",…}`.
    assert_eq!(session.sub, "alice", "the validated sub");
    let store_dir = scratch("login-store");
    let store_path = store_dir.path().join("provider-auth.json");
    let credential = oidc::credential_from_session(&session, &config);
    store::store_credential(&store_path, "gw", ProviderCredential::Oidc(credential))
        .expect("the credential persists");
    let on_disk = std::fs::read_to_string(&store_path).expect("the store is readable");
    assert!(
        on_disk.contains("\"type\": \"oidc\"") || on_disk.contains("\"type\":\"oidc\""),
        "{on_disk}"
    );
    assert!(
        on_disk.contains("\"sub\": \"alice\"") || on_disk.contains("\"sub\":\"alice\""),
        "{on_disk}"
    );
    // The PKCE verifier NEVER reaches the store.
    assert!(
        !on_disk.contains("code_verifier"),
        "the store holds tokens, never the verifier"
    );
    assert!(!on_disk.contains("nonce-we-sent"), "no login ephemera leak");
    // Round-trip through the store's own loader (the additive variant parses back).
    let loaded = store::load(&store_path);
    let ProviderCredential::Oidc(back) = loaded.providers.get("gw").expect("the entry") else {
        panic!(
            "the entry did not come back as oidc: {:?}",
            loaded.providers.get("gw")
        );
    };
    assert_eq!(
        back.id_token, session.id_token,
        "the id_token survives the round trip"
    );
    assert_eq!(back.flow, "oidc");
    assert_eq!(back.issuer, config.issuer);
    assert_eq!(back.client_id.as_deref(), Some("archimedes"));
}

// ── 2. header hygiene (the acceptance criterion the spec calls out) ──────────

#[tokio::test]
async fn gateway_headers_never_reach_the_idp() {
    // The spec's acceptance criterion, behaviourally: a provider row that carries
    // gateway headers (T2a's `headers` — Cloudflare Access and friends need them on
    // the COMPLETION wire) runs a login, and the IdP sees NONE of them on either leg
    // (discovery or token). The structural half is the census below.
    let (server, config, _forms) = fake_idp("alice").await;
    // Literal values (no env templates): the census is about WHERE the headers go,
    // not about how `$VAR` expands — that is T2a's pin in `tests/provider_headers.rs`.
    // Keeping this test env-free also means it needs no `env_lock` and cannot race a
    // sibling's env mutation.
    let row = ProviderConfig {
        headers: Some(std::collections::HashMap::from([
            (
                "Authorization".to_string(),
                "Bearer static-gateway".to_string(),
            ),
            ("Mcp-Session-Id".to_string(), "sess-42".to_string()),
            ("X-Litellm-Key".to_string(), "sk-leak-me".to_string()),
        ])),
        ..provider("gw", "oidc", "static-key")
    };
    // The header set the row WOULD put on the wire, expanded by the SAME function
    // the resolve spine uses — the pairs the IdP must never see.
    let expanded = provider_auth::headers::expand_map(row.headers.as_ref().expect("headers"));
    assert_eq!(
        expanded.len(),
        3,
        "all three headers expand to valid wire pairs"
    );
    let browser = Arc::new(Browser::default());
    oidc::authenticate_oidc(
        &config,
        &CancellationToken::new(),
        &fake_browser(browser.clone()),
    )
    .await
    .expect("the login completes");
    settle(&browser).await;
    let requests = server.received_requests().await.expect("the mock records");
    assert!(
        requests.len() >= 2,
        "both IdP legs ran (discovery + token): {} requests",
        requests.len()
    );
    for request in &requests {
        for (name, value) in request.headers.iter() {
            let name = name.as_str().to_ascii_lowercase();
            let value = value.to_str().unwrap_or("").to_string();
            for (header, want) in expanded.iter() {
                if name == header.to_ascii_lowercase() {
                    panic!(
                        "the IdP saw the gateway header `{header}` ({name}: {value}) on {} {}",
                        request.method, request.url
                    );
                }
                assert_ne!(
                    value, *want,
                    "the gateway header VALUE `{want}` reached {} {} under `{name}`",
                    request.method, request.url
                );
            }
            // The Bearer is the sharpest one: an `Authorization` head on an
            // IdP-bound request means a gateway credential leaked to a third party.
            assert_ne!(
                value, "Bearer static-gateway",
                "the gateway Bearer reached {} {}",
                request.method, request.url
            );
        }
    }
}

/// The structural half of the header-hygiene criterion: `oidc.rs` contains NO
/// header injection point at all, so a gateway header CANNOT be attached to an
/// IdP-bound request without adding one (which this test reddens). Vacuity-guarded
/// like the childproc census: an unreadable file is a failure, not a pass.
#[test]
fn oidc_module_has_no_header_injection_point() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/agent/provider_auth/oidc.rs"
    );
    let source = std::fs::read_to_string(path)
        .expect("oidc.rs is readable (the census is vacuous otherwise)");
    for forbidden in [
        ".default_headers(",
        ".header(",
        ".headers(",
        ".bearer_auth(",
    ] {
        assert!(
            !source.contains(forbidden),
            "`{forbidden}` appeared in oidc.rs — an IdP-bound request can now carry a \
             header the provider row configured (the census guards the acceptance criterion)"
        );
    }
    // And the client really is built here (fresh + headerless), not accepted from a
    // caller who could stamp it.
    assert!(
        source.contains("reqwest::Client::builder()"),
        "oidc.rs must build its own client (the header-hygiene guarantee is structural)"
    );
}

// ── 3. the redirect_ports cascade ───────────────────────────────────────────

#[tokio::test]
async fn redirect_ports_are_tried_in_order_then_ephemeral() {
    // A LISTENING port is a bind failure, so holding one open is the deterministic
    // "this port is taken" probe — no root and no privileged-port assumption (the
    // plan's UNVERIFIED note about port 1 on unknown CI legs, resolved the portable
    // way).
    let taken = std::net::TcpListener::bind("127.0.0.1:0").expect("a listener binds");
    let taken_port = taken.local_addr().expect("an address").port();

    let free_probe = std::net::TcpListener::bind("127.0.0.1:0").expect("binds");
    let free_port = free_probe.local_addr().expect("addr").port();
    drop(free_probe);

    // (a) An EMPTY list → one ephemeral bind (the redirect URI is still the
    //     `/callback` shape a corporate allowlist can name).
    let browser = Arc::new(Browser::default());
    let (_server, config, _forms) = fake_idp("alice").await;
    let session = oidc::authenticate_oidc(
        &config,
        &CancellationToken::new(),
        &fake_browser(browser.clone()),
    )
    .await
    .expect("the ephemeral fallback completes the login");
    settle(&browser).await;
    let urls = browser.urls.lock().unwrap().clone();
    let redirect = url::Url::parse(&urls[0])
        .expect("the authorize URL parses")
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.to_string())
        .expect("a redirect_uri");
    assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
    assert!(redirect.ends_with("/callback"), "{redirect}");
    assert_ne!(
        redirect
            .trim_start_matches("http://127.0.0.1:")
            .trim_end_matches("/callback")
            .parse::<u16>()
            .expect("a port"),
        taken_port,
        "an empty list never guesses at a configured port"
    );
    assert_eq!(session.sub, "alice");

    // (b) A configured list whose FIRST entry is taken and whose SECOND is free:
    //     the cascade takes the free one, in order.
    let config = OidcConfig {
        redirect_ports: vec![taken_port, free_port],
        ..config
    };
    let browser = Arc::new(Browser::default());
    oidc::authenticate_oidc(
        &config,
        &CancellationToken::new(),
        &fake_browser(browser.clone()),
    )
    .await
    .expect("the second port binds");
    settle(&browser).await;
    let urls = browser.urls.lock().unwrap().clone();
    let redirect = url::Url::parse(&urls[0])
        .expect("parses")
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.to_string())
        .expect("a redirect_uri");
    assert_eq!(
        redirect,
        format!("http://127.0.0.1:{free_port}/callback"),
        "the cascade stops at the FIRST bindable port"
    );
    drop(taken);
}

// ── 4. the refresh + THE `sub`-consistency guard ────────────────────────────

/// A mock IdP `/token` answering a refresh with an `id_token` whose `sub` (and
/// everything else) the caller chooses.
async fn refresh_idp(sub: &str) -> (MockServer, OidcCredential, Arc<Mutex<String>>) {
    let server = MockServer::start().await;
    let body_sub = sub.to_string();
    // The token the mock answers with, in a slot the caller fills AFTER the mount
    // (`wiremock`'s responder must be `Send + 'static`, so an `Arc<Mutex<…>>` is the
    // shape that lets a test decide the claims per case).
    let token_slot: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let responder_slot = token_slot.clone();
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(move |req: &Request| {
            let token_slot = responder_slot.clone();
            let form = String::from_utf8_lossy(&req.body).to_string();
            // The refresh's own shape is part of the contract: a public client
            // posts `grant_type=refresh_token` + the token + the client id.
            assert!(
                form.contains("grant_type=refresh_token"),
                "the refresh form carries the grant type: {form}"
            );
            assert!(
                form.contains("client_id=archimedes"),
                "…and the client id: {form}"
            );
            assert!(!form.contains("client_secret"), "…and no secret: {form}");
            let _ = &body_sub;
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "refreshed-access",
                "id_token": token_slot.lock().unwrap().clone(),
                "expires_in": 3600,
            }))
        })
        .mount(&server)
        .await;
    let cred = OidcCredential {
        token_endpoint: Some(format!("{}/token", server.uri())),
        issuer: server.uri(),
        ..stored_oidc("gw", sub, None)
    };
    (server, cred, token_slot)
}

/// Seed a store file with one `oidc` credential (the state a refresh starts from).
fn seed_store(path: &Path, provider_id: &str, cred: OidcCredential) {
    store::store_credential(path, provider_id, ProviderCredential::Oidc(cred)).expect("seeded");
}

#[tokio::test]
async fn a_refresh_rejects_a_swapped_sub_account() {
    // THE named criterion: a refresh whose `id_token` names a DIFFERENT account is
    // refused, and the stored credential is left byte-identical — the Supervisor
    // loop keeps serving the unexpired token, so an account swap is impossible
    // rather than merely unlikely.
    let store_dir = scratch("sub-swap");
    let store_path = store_dir.path().join("provider-auth.json");
    let (_server, cred, slot) = refresh_idp("alice").await;
    // The mock answers with a token for BOB while the stored anchor is ALICE.
    let now = archimedes_lib::agent::mcp::oauth::now_epoch_secs();
    *slot.lock().unwrap() = id_token(serde_json::json!({
        "iss": cred.issuer,
        "aud": ["archimedes"],
        "sub": "bob",
        "exp": now + 3600,
    }));
    seed_store(&store_path, "gw", cred.clone());
    let before = std::fs::read_to_string(&store_path).expect("the store exists");

    let outcome = refresh::refresh(
        &ProviderCredential::Oidc(cred.clone()),
        &reqwest::Client::new(),
    )
    .await
    .expect_err("a swapped sub is refused, never served");
    assert!(
        outcome.contains("DIFFERENT account"),
        "the error says what happened: {outcome}"
    );
    assert!(
        outcome.contains("bob") && outcome.contains("alice"),
        "…naming both subjects so an operator can act: {outcome}"
    );
    let after = std::fs::read_to_string(&store_path).expect("the store still exists");
    assert_eq!(
        before, after,
        "a rejected refresh writes NOTHING to the store"
    );
    // And the stored credential still resolves (degrade, never blank).
    let config_dir = scratch("sub-swap-config");
    let bearer = resolve_bearer_at(
        &provider("gw", "oidc", "static-key"),
        &store_path,
        config_dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(
        bearer.as_deref(),
        Some("id-gw"),
        "the stored id_token keeps serving"
    );
}

#[tokio::test]
async fn a_refresh_with_a_matching_sub_rotates_the_token() {
    let (_server, cred, slot) = refresh_idp("alice").await;
    let now = archimedes_lib::agent::mcp::oauth::now_epoch_secs();
    *slot.lock().unwrap() = id_token(serde_json::json!({
        "iss": cred.issuer,
        "aud": ["archimedes"],
        "sub": "alice",
        "exp": now + 3600,
    }));
    let refreshed = refresh::refresh(
        &ProviderCredential::Oidc(cred.clone()),
        &reqwest::Client::new(),
    )
    .await
    .expect("a matching sub rotates");
    let ProviderCredential::Oidc(next) = refreshed else {
        panic!("an oidc credential refreshed into another variant: {refreshed:?}");
    };
    assert_ne!(next.id_token, cred.id_token, "the token rotated");
    assert_eq!(next.sub, "alice", "the anchor is unchanged");
    assert_eq!(
        next.refresh_token.as_deref(),
        Some("refresh-gw"),
        "an unrotated refresh_token is KEPT, never cleared (the mock rotates nothing)"
    );
    let expires_at = next.expires_at.expect("expires_in became millis");
    assert!(
        expires_at > store::now_epoch_millis() + 3_500_000,
        "MILLISECONDS, not seconds: {expires_at}"
    );
    assert_eq!(next.access_token.as_deref(), Some("refreshed-access"));
    assert_eq!(next.flow, "oidc", "the arm key survives the rotate");
}

#[tokio::test]
async fn a_refresh_that_fails_claims_validation_is_refused() {
    // A refreshed token whose `iss` is somebody else's, whose `aud` omits our client
    // id, that is expired, whose `azp` names another client, or whose `sub` is blank
    // never becomes the bearer — EVEN with the account we expect (the `sub` guard is
    // an addition to claims validation, never a replacement for it).
    let (_server, cred, slot) = refresh_idp("alice").await;
    let now = archimedes_lib::agent::mcp::oauth::now_epoch_secs();
    let cases: Vec<(&str, serde_json::Value)> = vec![
        (
            "wrong issuer",
            serde_json::json!({"iss": "https://attacker.example", "aud": ["archimedes"],
                               "sub": "alice", "exp": now + 3600}),
        ),
        (
            "audience without us",
            serde_json::json!({"iss": cred.issuer, "aud": ["someone-else"],
                               "sub": "alice", "exp": now + 3600}),
        ),
        (
            "already expired",
            serde_json::json!({"iss": cred.issuer, "aud": ["archimedes"],
                               "sub": "alice", "exp": now - 600}),
        ),
        (
            "a present azp that is not ours",
            serde_json::json!({"iss": cred.issuer, "aud": ["archimedes"], "azp": "other",
                               "sub": "alice", "exp": now + 3600}),
        ),
        (
            "an empty sub",
            serde_json::json!({"iss": cred.issuer, "aud": ["archimedes"], "sub": "   ",
                               "exp": now + 3600}),
        ),
    ];
    for (label, claims) in cases {
        *slot.lock().unwrap() = id_token(claims);
        let err = refresh::refresh(
            &ProviderCredential::Oidc(cred.clone()),
            &reqwest::Client::new(),
        )
        .await
        .expect_err(&format!("the {label} case must be refused"));
        assert!(
            err.contains("failed validation"),
            "the {label} case is reported as a validation failure: {err}"
        );
    }
    // A response with NO `id_token` at all: the identity cannot be verified at all,
    // so the refresh is refused (the `sub` guard needs a token to read a subject
    // from, and serving an unverified pair is exactly what the guard exists against).
    let bare = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"access_token": "no-identity"})),
        )
        .mount(&bare)
        .await;
    let bare_cred = OidcCredential {
        token_endpoint: Some(format!("{}/token", bare.uri())),
        issuer: bare.uri(),
        ..cred.clone()
    };
    let err = refresh::refresh(
        &ProviderCredential::Oidc(bare_cred),
        &reqwest::Client::new(),
    )
    .await
    .expect_err("a refresh that returns no id_token must be refused");
    assert!(
        err.contains("id_token"),
        "the missing-identity case says why: {err}"
    );
}

#[tokio::test]
async fn a_credential_with_no_refresh_token_or_endpoint_is_not_refreshed() {
    // The missing-piece shapes are ERRORS the loop backs off on, and the stored
    // token keeps serving (T1's never-discard discipline).
    let missing_refresh = OidcCredential {
        refresh_token: None,
        token_endpoint: Some("https://idp.example/token".to_string()),
        ..stored_oidc("gw", "alice", None)
    };
    let err = refresh::refresh(
        &ProviderCredential::Oidc(missing_refresh),
        &reqwest::Client::new(),
    )
    .await
    .expect_err("nothing to exchange is an error, not a silent success");
    assert!(err.contains("refresh token"), "{err}");
    let missing_endpoint = stored_oidc("gw", "alice", None);
    let err = refresh::refresh(
        &ProviderCredential::Oidc(missing_endpoint),
        &reqwest::Client::new(),
    )
    .await
    .expect_err("nowhere to ask is an error");
    assert!(err.contains("token endpoint"), "{err}");
}

#[tokio::test]
async fn an_unknown_oidc_flow_is_refused_not_silently_served() {
    // The dispatcher's guarded arm: a credential whose `flow` is not `oidc` cannot
    // reach `oidc::refresh` (a future flow must add its own arm).
    let weird = OidcCredential {
        flow: "oidc-v2".to_string(),
        ..stored_oidc("gw", "alice", Some("https://idp/token".to_string()))
    };
    let err = refresh::refresh(&ProviderCredential::Oidc(weird), &reqwest::Client::new())
        .await
        .expect_err("an unknown flow is refused");
    assert!(err.contains("oidc-v2"), "the error names the flow: {err}");
}

// ── 5. the resolve arm (the `id_token` IS the bearer) ───────────────────────

#[tokio::test]
async fn resolve_serves_the_stored_id_token_never_the_access_token() {
    // The criterion "the validated id_token is injected as the Bearer": the arm
    // returns the `id_token`; the access token is diagnostics only. The substitution
    // into `Model.api_key` is the T1 resolve-spine contract (interface §1) — this
    // pins the VALUE that lands there.
    let store_dir = scratch("resolve-serve");
    let store_path = store_dir.path().join("provider-auth.json");
    let config_dir = scratch("resolve-serve-config");
    // Far enough from expiry that no refresh is attempted (the Supervisor's lead is
    // 5 minutes).
    let cred = OidcCredential {
        expires_at: Some(store::now_epoch_millis() + 60 * 60 * 1000),
        ..stored_oidc("gw", "alice", None)
    };
    seed_store(&store_path, "gw", cred.clone());
    let bearer = resolve_bearer_at(
        &provider("gw", "oidc", "static-key"),
        &store_path,
        config_dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(
        bearer.as_deref(),
        Some("id-gw"),
        "the id_token is the bearer"
    );
    assert_ne!(
        bearer.as_deref(),
        Some("access-gw"),
        "the access token is never the proxy bearer"
    );
}

#[tokio::test]
async fn resolve_refreshes_an_expiring_id_token_and_persists_it() {
    // The extension the plan licenses for arm 2: an `id_token` inside the 5-minute
    // lead is refreshed SYNCHRONOUSLY (an `id_token` is short-lived and the loop's
    // next pass may not arrive in time), the success is persisted through the atomic
    // path, and the fresh token is served.
    let store_dir = scratch("resolve-refresh");
    let store_path = store_dir.path().join("provider-auth.json");
    let config_dir = scratch("resolve-refresh-config");
    let (_server, mut cred, slot) = refresh_idp("alice").await;
    let now = archimedes_lib::agent::mcp::oauth::now_epoch_secs();
    *slot.lock().unwrap() = id_token(serde_json::json!({
        "iss": cred.issuer.clone(),
        "aud": ["archimedes"],
        "sub": "alice",
        "exp": now + 3600,
    }));
    // INSIDE the lead (60 s from now) → the arm must refresh.
    cred.expires_at = Some(store::now_epoch_millis() + 60_000);
    seed_store(&store_path, "gw", cred.clone());
    let bearer = resolve_bearer_at(
        &provider("gw", "oidc", "static-key"),
        &store_path,
        config_dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await
    .expect("a bearer is served");
    let refreshed = id_token(serde_json::json!({
        "iss": cred.issuer, "aud": ["archimedes"], "sub": "alice", "exp": now + 3600,
    }));
    assert_eq!(bearer, refreshed, "the REFRESHED id_token is served");
    let loaded = store::load(&store_path);
    let ProviderCredential::Oidc(stored) = loaded.providers.get("gw").expect("still stored") else {
        panic!("the entry changed variant");
    };
    assert_eq!(stored.id_token, refreshed, "…and persisted");
    assert_eq!(stored.sub, "alice");
    assert!(stored.expires_at.expect("a new expiry") > store::now_epoch_millis() + 3_500_000);
}

#[tokio::test]
async fn resolve_never_serves_a_swapped_sub_token_it_serves_the_stored_one() {
    // The serve-path half of the `sub` guard (the refresh dispatcher's half is
    // `a_refresh_rejects_a_swapped_sub_account`): an expiring `id_token` is refreshed
    // synchronously, and when that refresh comes back for a DIFFERENT account the arm
    // must serve the STORED token and write NOTHING — a mismatched token is the one
    // thing that must never reach the proxy, and the user is never silently logged in
    // as somebody else.
    let store_dir = scratch("resolve-sub-swap");
    let store_path = store_dir.path().join("provider-auth.json");
    let config_dir = scratch("resolve-sub-swap-config");
    let (_server, mut cred, slot) = refresh_idp("alice").await;
    let now = archimedes_lib::agent::mcp::oauth::now_epoch_secs();
    *slot.lock().unwrap() = id_token(serde_json::json!({
        "iss": cred.issuer, "aud": ["archimedes"], "sub": "mallory", "exp": now + 3600,
    }));
    cred.expires_at = Some(store::now_epoch_millis() + 60_000);
    seed_store(&store_path, "gw", cred.clone());
    let before = std::fs::read_to_string(&store_path).expect("the store exists");
    let bearer = resolve_bearer_at(
        &provider("gw", "oidc", "static-key"),
        &store_path,
        config_dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await
    .expect("a bearer is still served (degrade, never blank)");
    assert_eq!(
        bearer, cred.id_token,
        "the STORED id_token served, not the stranger's"
    );
    assert_ne!(
        bearer,
        *slot.lock().unwrap(),
        "the mismatched token was NOT served"
    );
    let after = std::fs::read_to_string(&store_path).expect("the store exists");
    assert_eq!(before, after, "a rejected refresh writes NOTHING");
}

#[tokio::test]
async fn resolve_degrades_to_the_static_key_when_nothing_is_stored() {
    // Interface §1: a resolve with no credential DEGRADES (`None` = "use the row's
    // static key"), it never blanks and never errors.
    let store_dir = scratch("resolve-empty");
    let config_dir = scratch("resolve-empty-config");
    let bearer = resolve_bearer_at(
        &provider("gw", "oidc", "static-key"),
        &store_dir.path().join("provider-auth.json"),
        config_dir.path(),
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(bearer, None, "`None` means the static key as-is");
}

#[tokio::test]
async fn an_explicit_oidc_mode_beats_an_inferred_bang_key() {
    // R8's precedence, re-pinned for the `oidc` arm (T6 must NOT re-widen arm 3's
    // guard): a row whose `api_key` looks like a key helper but whose `authMode`
    // says `oidc` serves the STORED token — the explicit mode wins.
    let store_dir = scratch("r8-oidc");
    let store_path = store_dir.path().join("provider-auth.json");
    let config_dir = scratch("r8-oidc-config");
    seed_store(
        &store_path,
        "gw",
        OidcCredential {
            expires_at: Some(store::now_epoch_millis() + 60 * 60 * 1000),
            ..stored_oidc("gw", "alice", None)
        },
    );
    let row = provider("gw", "oidc", "!echo should-not-run");
    let bearer = resolve_bearer_at(
        &row,
        &store_path,
        config_dir.path(),
        &reqwest::Client::new(),
        true,
    )
    .await;
    assert_eq!(
        bearer.as_deref(),
        Some("id-gw"),
        "the stored id_token beat the helper (R8: an explicit auth mode wins)"
    );
}

// ── 6. the store variant, in isolation ──────────────────────────────────────

#[tokio::test]
async fn the_oidc_store_variant_round_trips_the_documented_wire_shape() {
    // The wire entry is `{ "type": "oidc", "flow": "oidc", "idToken": …, "sub": …,
    // "issuer": …, … }` (camelCase + millis, the same discipline as the `oauth`
    // variant). Pinned so a rename reddens HERE rather than corrupting a real store.
    let cred = stored_oidc("gw", "alice", Some("https://idp/token".to_string()));
    let value = serde_json::to_value(ProviderCredential::Oidc(cred.clone())).expect("serializes");
    assert_eq!(value["type"], "oidc");
    assert_eq!(value["flow"], "oidc");
    assert_eq!(value["idToken"], "id-gw");
    assert_eq!(value["sub"], "alice");
    assert_eq!(value["issuer"], "https://idp.example");
    assert_eq!(value["clientId"], "archimedes");
    assert_eq!(value["tokenEndpoint"], "https://idp/token");
    assert_eq!(
        value["expiresAt"].as_i64(),
        cred.expires_at,
        "millis on the wire (the store's unit)"
    );
    let back: ProviderCredential = serde_json::from_value(value).expect("parses back");
    assert_eq!(back, ProviderCredential::Oidc(cred));
    // The `oauth` variant is UNTOUCHED by the additive change (the same document,
    // the same tag).
    let oauth = serde_json::json!({
        "type": "oauth", "flow": "litellm_cli_pkce", "accessToken": "a",
        "baseUrl": "https://gw"
    });
    let parsed: ProviderCredential = serde_json::from_value(oauth).expect("oauth still parses");
    assert!(matches!(parsed, ProviderCredential::OAuth(_)));
    // An UNKNOWN type (a future app version's flow read by this build) drops ONE
    // entry, never the document — T1's per-entry tolerance, which the new variant
    // must not have disturbed.
    let store_dir = scratch("store-tolerance");
    let store_path = store_dir.path().join("provider-auth.json");
    std::fs::write(
        &store_path,
        serde_json::json!({
            "version": 1,
            "providers": {
                "good": serde_json::to_value(ProviderCredential::Oidc(stored_oidc("good", "alice", None))).unwrap(),
                "future": { "type": "device-code-v9", "flow": "device-code-v9" },
            }
        })
        .to_string(),
    )
    .expect("the fixture writes");
    let loaded = store::load(&store_path);
    assert!(
        loaded.providers.contains_key("good"),
        "the good entry survives"
    );
    assert!(
        !loaded.providers.contains_key("future"),
        "the unknown entry is dropped, not fatal"
    );
}

// ── 7. the structural lints ─────────────────────────────────────────────────

/// RULING R4 (interface §10), the lint T5's plan deferred to T6: there is exactly
/// ONE `constant_time_eq` in this crate — T5's, in `mcp/callback.rs` — and
/// `oidc.rs` IMPORTS it. A copy-pasted second definition is the divergence this
/// pins out. Vacuity-guarded like the childproc census: an unreadable file or a
/// missing import is a FAILURE, never a silent pass.
#[test]
fn the_constant_time_compare_is_imported_not_copy_pasted() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/agent/provider_auth/oidc.rs"
    );
    let source = std::fs::read_to_string(path)
        .expect("oidc.rs is readable (this lint is vacuous otherwise)");
    assert!(
        source.contains("use crate::agent::mcp::callback::constant_time_eq"),
        "oidc.rs must IMPORT T5's constant_time_eq (ruling R4) — the import line is \
         missing, which means it is either defining its own or not comparing in \
         constant time at all"
    );
    // A DEFINITION (not an import) is the copy-paste this lint exists to catch.
    // COMMENT LINES ARE STRIPPED FIRST: the module doc NAMES T5's symbol (that is
    // how the import is documented), so only CODE may not define one.
    let code = code_only(&source);
    for definition in [
        "fn constant_time_eq",
        "fn ct_eq",
        "fn constant_time",
        "fn timing_safe_eq",
    ] {
        assert!(
            !code.contains(definition),
            "oidc.rs DEFINES `{definition}` — a second constant-time compare is exactly \
             the divergence ruling R4 forbids; import the one in mcp/callback.rs"
        );
    }
    // The callback file still OWNS the single definition (a move would silently
    // break the import and this lint's premise).
    let callback = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/agent/mcp/callback.rs"
    ))
    .expect("mcp/callback.rs is readable");
    assert!(
        callback.contains("pub(crate) fn constant_time_eq"),
        "the ONE definition must stay in mcp/callback.rs (T5's file, read-only for T6)"
    );
    // And no OTHER file in the provider_auth tree grew a second one (the same
    // comment-stripping rule: a doc comment that NAMES the primitive is
    // documentation, not a second implementation).
    let tree = concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent/provider_auth");
    let mut offenders = Vec::new();
    for entry in std::fs::read_dir(tree).expect("the provider_auth dir is readable") {
        let entry = entry.expect("an entry");
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("a readable source file");
        if code_only(&text).contains("fn constant_time_eq") {
            offenders.push(path.display().to_string());
        }
    }
    assert!(
        offenders.is_empty(),
        "a second constant_time_eq definition appeared in provider_auth: {offenders:?}"
    );
}

/// Drop comment lines from a Rust source (a crude but honest line filter): the
/// structural lints care about CODE, and this suite's own doc comments NAME the
/// primitives they guard, which must not read as a definition.
fn code_only(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The command is registered (the `auth_mcp_server` pattern): a command the UI
/// cannot reach is not a deliverable.
#[test]
fn the_oidc_login_command_is_registered() {
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("lib.rs is readable");
    assert!(
        source.contains("commands::settings::provider_login_oidc,"),
        "`provider_login_oidc` is missing from generate_handler! — T8's button would \
         invoke a command that does not exist on the IPC surface"
    );
}
