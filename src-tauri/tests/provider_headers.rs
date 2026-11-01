//! Integration tests for issue #129's DISCOVERY side: the `!command` key helper
//! on the bearer-resolution path, the custom headers on the three discovery arms
//! (wiremock header matchers), the insecure-HTTP gate, and the `settings.json`
//! round trip of the two new provider fields.
//!
//! Item 8 — the COMPLETION-wire assertion (`completion_sends_expanded_custom_headers_on_each_wire`) — is
//! T2b's addition to this file (plan §2i / ruling R7): T2a ships the discovery
//! half only, so nothing here claims the completion wire.

use std::collections::{BTreeMap, HashMap};

use archimedes_lib::agent::harness::discover_models;
use archimedes_lib::agent::provider_auth;
use archimedes_lib::config::{load_settings, write_settings, ProviderConfig, Settings};
use archimedes_lib::test_support::ScratchDir;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// The env-mutation lock: the SAME static the lib-test binary uses
/// (`test_support::ENV_LOCK` — `env_lock()` is `pub(crate)` and therefore not
/// reachable from this crate, but the mutex it locks is). A header test that
/// mutates the process environment must not interleave with a sibling's read.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    // Poison-tolerant (the lib's `env_lock` is the same): a sibling panicking
    // while holding it must not turn this test's failure into a `PoisonError`.
    archimedes_lib::test_support::ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// The `commands/settings.rs` restore guard (the restore happens even when an
/// assertion panics). Caller must hold `env_lock()`.
struct RestoreEnv(&'static str, Option<std::ffi::OsString>);
impl Drop for RestoreEnv {
    fn drop(&mut self) {
        match self.1.take() {
            // SAFETY: the `ENV_LOCK` is still held at drop time (this guard is
            // declared after the `_lock` guard and outlives it in reverse); no
            // other thread mutates the env concurrently.
            Some(v) => unsafe { std::env::set_var(self.0, v) },
            None => unsafe { std::env::remove_var(self.0) },
        }
    }
}

/// Set `key` for the rest of the test. Caller must hold `env_lock()`.
fn set_env(key: &'static str, value: &str) -> RestoreEnv {
    let prev = std::env::var_os(key);
    // SAFETY: `ENV_LOCK` is held by caller.
    unsafe { std::env::set_var(key, value) };
    RestoreEnv(key, prev)
}

/// A `ProviderConfig` for the dispatcher tests (the shape T1's
/// `tests/provider_auth.rs` helper uses, plus T2a's two additive fields).
fn provider(id: &str, api_key: &str) -> ProviderConfig {
    ProviderConfig {
        id: id.to_string(),
        name: format!("Provider {id}"),
        base_url: "https://gw.example/v1".to_string(),
        api_key: api_key.to_string(),
        api: "litellm".to_string(),
        key_url: None,
        auth_mode: "api_key".to_string(),
        headers: None,
        allow_insecure_http: false,
    }
}

/// Item 1 — the key helper on the RESOLVE path: a `!`-prefixed `api_key` runs
/// the bare program and the trimmed stdout is the bearer (`resolve_bearer_at` is
/// the path-taking tested seam — the store path is a scratch file, so nothing
/// here touches the real credential store, ruling R3). With
/// `execute_helpers == false` the helper is never spawned and the boundary
/// returns `None` (serve the static key).
#[cfg(unix)]
#[tokio::test]
async fn key_helper_bearer_reaches_the_resolve_boundary() {
    let dir = ScratchDir::in_env_temp("-t2a-headers-it", "resolve");
    let auth_file = dir.join("provider-auth.json");
    let client = reqwest::Client::new();
    let p = provider("gw", "!echo tok");

    let got = provider_auth::resolve_bearer_at(&p, &auth_file, &dir, &client, true).await;
    assert_eq!(got.as_deref(), Some("tok"), "the helper's trimmed stdout");

    // The seeding gate: the same row, no execution → the boundary degrades to
    // `None` (the caller serves the static key).
    let seeded = provider_auth::resolve_bearer_at(&p, &auth_file, &dir, &client, false).await;
    assert_eq!(seeded, None, "the seeding path never executes");

    // A FAILING helper is `None` too (never an `Err`, never a blank at this
    // boundary) — `/bin/false` exits non-zero.
    let failing = provider("gw", "!/bin/false");
    let got = provider_auth::resolve_bearer_at(&failing, &auth_file, &dir, &client, true).await;
    assert_eq!(got, None, "a failed helper degrades to the static key");

    // A REJECTED command (a shell metacharacter) likewise.
    let rejected = provider("gw", "!echo a;ls");
    let got = provider_auth::resolve_bearer_at(&rejected, &auth_file, &dir, &client, true).await;
    assert_eq!(got, None, "a rejected command degrades to the static key");
}

/// The expanded map the discovery tests attach (`$VAR` expanded HERE — the arms
/// only attach what the spine would have expanded; the expansion itself is
/// asserted in `headers.rs`'s unit tests and item 7 below).
fn expanded_map(name: &str, value: &str) -> BTreeMap<String, String> {
    BTreeMap::from([(name.to_string(), value.to_string())])
}

/// Item 2 — the OpenAI-shape discovery arm sends the custom headers (the
/// wiremock header matcher IS the assertion) alongside the bearer.
#[tokio::test]
async fn discovery_sends_expanded_custom_headers_on_the_openai_arm() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("authorization", "Bearer sk-test"))
        .and(header("x-env-test", "expanded-value"))
        .and(header("cf-access-client-id", "cid"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"m/1"}]}"#))
        .mount(&server)
        .await;
    let map = BTreeMap::from([
        ("x-env-test".to_string(), "expanded-value".to_string()),
        ("cf-access-client-id".to_string(), "cid".to_string()),
    ]);
    let models = discover_models(
        &format!("{}/v1", server.uri()),
        "sk-test",
        "openai-completions",
        Some(&map),
    )
    .await
    .expect("the matched request succeeds");
    assert!(models.contains_key("m/1"));
}

/// Item 3 — the Anthropic arm applies them too (after its `x-api-key` +
/// `anthropic-version` pair, which the matcher also requires — the headers are
/// ADDITIVE, never replacing the wire's own auth).
#[tokio::test]
async fn discovery_sends_custom_headers_on_the_anthropic_arm() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("x-api-key", "sk-ant"))
        .and(header("anthropic-version", "2023-06-01"))
        .and(header("x-env-test", "expanded-value"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[{"id":"claude-x"}]}"#))
        .mount(&server)
        .await;
    let models = discover_models(
        &format!("{}/v1", server.uri()),
        "sk-ant",
        "anthropic-messages",
        Some(&expanded_map("x-env-test", "expanded-value")),
    )
    .await
    .expect("the matched request succeeds");
    assert!(models.contains_key("claude-x"));
}

/// Item 4 — the LiteLLM arm (`GET {base}/model/info`) applies them too.
#[tokio::test]
async fn discovery_sends_custom_headers_on_the_litellm_arm() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/model/info"))
        .and(header("authorization", "Bearer gw-key"))
        .and(header("x-env-test", "expanded-value"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(r#"{"data":[{"model_name":"lit/1","model_info":null}]}"#),
        )
        .mount(&server)
        .await;
    let models = discover_models(
        &server.uri(),
        "gw-key",
        "litellm",
        Some(&expanded_map("x-env-test", "expanded-value")),
    )
    .await
    .expect("the matched request succeeds");
    assert!(models.contains_key("lit/1"));
}

/// Item 5 — the gate refuses a plain-HTTP non-loopback base with the DESCRIPTIVE
/// error (naming `allowInsecureHttp`), and the opt-in lifts it. The end-to-end
/// shape: a real `http://127.0.0.1:PORT` server is allowed (loopback is always
/// allowed, ADR 0057) while the same endpoint's non-loopback literal is refused.
#[tokio::test]
async fn the_http_gate_refuses_a_non_loopback_http_base() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[]}"#))
        .mount(&server)
        .await;
    // The loopback form of a real endpoint: allowed (and the discovery works).
    let uri = server.uri();
    assert!(
        uri.starts_with("http://127.0.0.1:"),
        "wiremock serves loopback plaintext HTTP: {uri}"
    );
    provider_auth::validate_base_url(&uri, false)
        .await
        .expect("loopback http is always allowed (ADR 0057)");
    let models = discover_models(&format!("{uri}/v1"), "", "openai-completions", None)
        .await
        .expect("the loopback endpoint is reachable");
    assert!(models.is_empty(), "the canned list is empty");

    // The SAME scheme to a non-loopback literal: refused, with the opt-out named.
    let err = provider_auth::validate_base_url("http://10.0.0.5/v1", false)
        .await
        .expect_err("a non-loopback http base is refused");
    assert!(err.contains("allowInsecureHttp"), "{err}");
    assert!(err.contains("http://10.0.0.5/v1"), "{err}");
    provider_auth::validate_base_url("http://10.0.0.5/v1", true)
        .await
        .expect("the explicit opt-in lifts the gate");
    provider_auth::validate_base_url("https://10.0.0.5/v1", false)
        .await
        .expect("https is never the gate's problem");
}

/// Item 6 — the gate's ALLOW side end-to-end: the loopback spellings a local
/// dev gateway actually uses (`localhost` by name, `[::1]`, `127.0.0.1`).
#[tokio::test]
async fn the_http_gate_always_allows_loopback_bases() {
    for url in [
        "http://127.0.0.1:4000/v1",
        "http://localhost:4000/v1",
        "http://[::1]:4000/v1",
    ] {
        provider_auth::validate_base_url(url, false)
            .await
            .unwrap_or_else(|e| panic!("{url} is loopback and must be allowed: {e}"));
    }
}

/// Item 7 — the CONFIG round trip through the real settings file (the two new
/// fields survive `write_settings` → `load_settings`, the header VALUES stay the
/// unexpanded templates, and a pre-feature file still parses to
/// `headers: None` / `allowInsecureHttp: false`).
#[test]
fn provider_headers_and_the_insecure_flag_round_trip_through_the_settings_file() {
    let dir = ScratchDir::in_env_temp("-t2a-headers-it", "config");
    let mut headers = HashMap::new();
    headers.insert("x-env-test".to_string(), "$T2_TEST_HEADER".to_string());
    let settings = Settings {
        providers: vec![ProviderConfig {
            id: "gw".to_string(),
            name: "Gateway".to_string(),
            base_url: "https://gw.example/v1".to_string(),
            api_key: "k".to_string(),
            api: "litellm".to_string(),
            key_url: None,
            auth_mode: "api_key".to_string(),
            headers: Some(headers),
            allow_insecure_http: true,
        }],
        ..Settings::default()
    };
    write_settings(&dir, &settings).expect("the settings write succeeds");

    let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap();
    assert!(
        raw.contains("\"allowInsecureHttp\": true"),
        "camelCase on the wire:\n{raw}"
    );

    let back = load_settings(&dir);
    let row = back.providers.first().expect("the provider survived");
    assert!(row.allow_insecure_http);
    assert_eq!(
        row.headers
            .as_ref()
            .and_then(|h| h.get("x-env-test"))
            .map(String::as_str),
        Some("$T2_TEST_HEADER"),
        "the value stays the TEMPLATE (expansion happens at resolve time)"
    );

    // A pre-feature file (neither key present) parses to the defaults.
    std::fs::write(
        dir.join("settings.json"),
        r#"{"providers":[{"id":"old","name":"Old","baseUrl":"https://old/v1","apiKey":"k"}]}"#,
    )
    .unwrap();
    let old = load_settings(&dir);
    let row = old.providers.first().expect("the pre-feature row parses");
    assert_eq!(row.headers, None, "no headers configured");
    assert!(!row.allow_insecure_http, "plain http stays refused");
}

/// The expansion engine reached from the integration tree (the seam the spine
/// uses): `$VAR` / `${VAR}` against the process environment in ONE pass, `$$`
/// escaping, and the invalid-name/value skips — i.e. what the arms are handed.
#[test]
fn the_expansion_the_spine_uses_is_single_pass_and_validated() {
    let _lock = env_lock();
    let _secret = set_env("T2_TEST_SECRET", "do-not-leak");
    let _a = set_env("T2_TEST_A", "$T2_TEST_SECRET");
    let _b = set_env("T2_TEST_B", "cid");
    let mut map = HashMap::new();
    // A `$A` whose VALUE names another variable: the single pass must NOT
    // dereference it (the "no recursive evaluation" rule).
    map.insert("x-a".to_string(), "$T2_TEST_A".to_string());
    map.insert("x-b".to_string(), "Bearer ${T2_TEST_B}".to_string());
    map.insert("x-literal".to_string(), "cost$$5".to_string());
    map.insert("bad name".to_string(), "skipped".to_string());
    map.insert("x-crlf".to_string(), "a\r\nInjected: 1".to_string());
    let out = provider_auth::expand_map(&map);
    assert_eq!(out.get("x-a").map(String::as_str), Some("$T2_TEST_SECRET"));
    assert_eq!(
        out.get("x-b").map(String::as_str),
        Some("Bearer cid"),
        "a template around the variable expands"
    );
    assert_eq!(out.get("x-literal").map(String::as_str), Some("cost$5"));
    assert_eq!(out.len(), 3, "{out:?} — the invalid name/value are skipped");
    let joined = out.values().cloned().collect::<Vec<_>>().join("|");
    assert!(
        !joined.contains("do-not-leak"),
        "a single pass never dereferences the variable the value merely mentions"
    );
}
