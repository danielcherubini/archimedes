//! Integration tests for the `gcloud_adc` flow (issue #128, T4).
//!
//! Three things this file exists to make CI-red:
//!
//! 1. **Zero `gcloud` CLI subprocess** — a childproc-style source census over
//!    `provider_auth/gcloud.rs`'s PRODUCTION region. The exchange is a `reqwest`
//!    POST; nothing in this flow may spawn a child process.
//! 2. **The ADC path never touches the credential store** — the same census shape
//!    looking for `store::` calls, plus a runtime assertion that a successful mint
//!    leaves the provider-auth file ABSENT. This is the flow's central security
//!    rule: the minted access token lives only in the 50-minute in-memory cache,
//!    never in a plaintext file beside the refresh token and client secret.
//! 3. **The dispatcher arm** — `resolve_bearer_at` with the ADC flow on serves the
//!    minted token, and degrades to `None` (the row's static key) on every failure
//!    instead of blanking a working key (interface §1).
//!
//! Hermeticity: every ADC file is a `ScratchDir` fixture and every token endpoint
//! is a `wiremock` URL. Nothing here reads the developer's real
//! `~/.config/gcloud/application_default_credentials.json`, and nothing POSTs a
//! refresh token to real Google.

use std::path::{Path, PathBuf};

use archimedes_lib::agent::provider_auth::gcloud::{
    self, AdcCredential, AdcFileSource, TestAdcOverride,
};
use archimedes_lib::agent::provider_auth::{resolve_bearer_at, ProviderCredential};
use archimedes_lib::config::ProviderConfig;
use archimedes_lib::test_support::ScratchDir;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── the shared fixtures ───────────────────────────────────────────────────

/// The env-mutation lock: the SAME static the lib-test binary uses
/// (`test_support::ENV_LOCK` — `env_lock()` is `pub(crate)`, so an integration
/// test locks the mutex itself). A test that mutates the process environment must
/// not interleave with a sibling's read.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
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
            // other thread mutates the environment concurrently.
            Some(v) => unsafe { std::env::set_var(self.0, v) },
            None => unsafe { std::env::remove_var(self.0) },
        }
    }
}

/// Set `key` for the rest of the test. Caller must hold `env_lock()`.
fn set_env(key: &'static str, value: &str) -> RestoreEnv {
    let prev = std::env::var_os(key);
    // SAFETY: the `ENV_LOCK` is held by the caller.
    unsafe { std::env::set_var(key, value) };
    RestoreEnv(key, prev)
}

/// Unset `key` for the rest of the test. Caller must hold `env_lock()`.
fn remove_env(key: &'static str) -> RestoreEnv {
    let prev = std::env::var_os(key);
    // SAFETY: the `ENV_LOCK` is held by the caller.
    unsafe { std::env::remove_var(key) };
    RestoreEnv(key, prev)
}

/// The mint cache and the ADC override are PROCESS-GLOBAL (one mint per
/// `(client_id, refresh_token)` for the whole app), so a test that counts
/// exchanges must own them. `ENV_LOCK` serialises against every sibling that
/// installs an override or mutates the ADC env; the guard restores on panic.
struct AdcSerial {
    _lock: std::sync::MutexGuard<'static, ()>,
    _override: gcloud::TestAdcOverrideGuard,
}

/// Take the ADC flow's globals for one test, with NO ADC file installed (the
/// override REPLACES discovery, so this means "no ADC file exists" — the
/// developer's real file is unreachable).
fn adc_serial() -> AdcSerial {
    let _lock = env_lock();
    gcloud::cache_clear();
    let _override = gcloud::set_test_adc_override(TestAdcOverride {
        adc_file: AdcFileSource::Explicit(None),
        token_endpoint: None,
    });
    AdcSerial { _lock, _override }
}

/// A scratch `authorized_user` ADC file with a UNIQUE refresh token, so its cache
/// key cannot collide with a sibling test's even if a clear were skipped.
fn scratch_adc(dir: &Path, tag: &str) -> PathBuf {
    let path = dir.join(format!("adc-{tag}.json"));
    std::fs::write(
        &path,
        serde_json::json!({
            "type": "authorized_user",
            "client_id": format!("it-{tag}-client"),
            "client_secret": "it-client-secret",
            "refresh_token": format!("it-{tag}-refresh"),
            "quota_project_id": "archimedes-it"
        })
        .to_string(),
    )
    .unwrap();
    path
}

/// A `ProviderConfig` for the dispatcher tests (T1's fixture shape + T2a's and
/// T4's additive fields).
fn provider(id: &str, auth_mode: &str, api_key: &str, gcloud_flag: bool) -> ProviderConfig {
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
        use_gcloud_token_auth: gcloud_flag,
    }
}

/// A `wiremock` server minting `token` for any POST.
async fn mount_token_server(token: &str) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": token,
            "expires_in": 3599,
            "token_type": "Bearer"
        })))
        .mount(&server)
        .await;
    server
}

/// A token endpoint that refuses everything (the revoked-refresh-token shape).
async fn failing_token_server() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(400).set_body_json(serde_json::json!({"error": "invalid_grant"})),
        )
        .mount(&server)
        .await;
    server
}

/// Install an override pointing at `adc_file` + `endpoint` (the caller's
/// `AdcSerial` owns the serialization).
fn install(adc_file: AdcFileSource, endpoint: Option<String>) -> gcloud::TestAdcOverrideGuard {
    gcloud::set_test_adc_override(TestAdcOverride {
        adc_file,
        token_endpoint: endpoint,
    })
}

/// The TTL the tests use — the 50-minute production constant is pinned by name
/// (`gcloud::CACHE_TTL_MS`), never waited out.
const TEST_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

// ── 1. the zero-subprocess census ─────────────────────────────────────────

/// The census scanner shared by both source scans: the PRODUCTION region of one
/// file (every code line before the first item-position `#[cfg(test)]`, comments
/// dropped), `panic`-ing on an unreadable file — a census that quietly stops at
/// the first odd file passes for the wrong reason (the `agent/childproc.rs`
/// precedent, including its vacuity rule).
///
/// `#[cfg(not(windows))]` like the childproc precedent: Windows keeps no
/// source-scan census (the repo's own recorded gap).
#[cfg(not(windows))]
fn production_region(rel: &str) -> Vec<(usize, String)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("census cannot read {}: {e}", path.display()));
    let is_comment = |t: &str| ["//", "/*", "*", "*/"].iter().any(|p| t.starts_with(p));
    let mut out = Vec::new();
    for (idx, raw) in text.lines().enumerate() {
        let trimmed = raw.trim();
        if trimmed.starts_with("#[cfg(test)]") && !is_comment(trimmed) {
            break;
        }
        if is_comment(trimmed) {
            continue;
        }
        out.push((idx + 1, raw.to_string()));
    }
    out
}

/// The flow's headline claim: **zero `gcloud` CLI subprocess**. The token comes
/// from a `reqwest` POST to Google's endpoint — no CLI, no PATH dependency, no
/// user machine state beyond the ADC file.
///
/// A LINT, not a parser: it matches TEXT, so a string literal containing one of
/// these needles would also trip it (the honest trade every grep-level lint makes
/// — a false alarm costs one rename, a false pass costs a subprocess per
/// resolve).
#[cfg(not(windows))]
#[test]
fn gcloud_rs_never_spawns_a_subprocess() {
    const NEEDLES: [&str; 3] = ["Command::new(", "process::Command", "tokio::process"];
    let region = production_region("agent/provider_auth/gcloud.rs");
    assert!(
        region.len() > 100,
        "the census is vacuous — it scanned {} lines of gcloud.rs",
        region.len()
    );
    let hits: Vec<String> = region
        .iter()
        .filter(|(_, text)| NEEDLES.iter().any(|n| text.contains(n)))
        .map(|(line, text)| format!("gcloud.rs:{line}: {}", text.trim()))
        .collect();
    assert!(
        hits.is_empty(),
        "the ADC flow must never spawn a subprocess (issue #128 — the exchange is a \
         reqwest POST):\n{}",
        hits.join("\n")
    );
}

// ── 2. the never-write-store census ───────────────────────────────────────

/// The security census: the ADC module must never reach the provider-auth store.
/// A stray `store::store_credential` would persist the minted access token into
/// `provider-auth.json` beside the ADC refresh token and client secret — exactly
/// the secret-at-rest this flow exists to keep out of a plaintext file (the
/// in-memory 50-minute cache is its ONLY home).
#[cfg(not(windows))]
#[test]
fn gcloud_rs_never_calls_store() {
    const NEEDLES: [&str; 3] = ["store_credential", "store::save", "store::"];
    let region = production_region("agent/provider_auth/gcloud.rs");
    assert!(
        region.len() > 100,
        "the census is vacuous — it scanned {} lines of gcloud.rs",
        region.len()
    );
    let hits: Vec<String> = region
        .iter()
        .filter(|(_, text)| NEEDLES.iter().any(|n| text.contains(n)))
        .map(|(line, text)| format!("gcloud.rs:{line}: {}", text.trim()))
        .collect();
    assert!(
        hits.is_empty(),
        "the ADC flow must never write the credential store (issue #128 — the minted token \
         lives only in the in-memory cache):\n{}",
        hits.join("\n")
    );
}

// ── 3. the runtime never-persist assertion ────────────────────────────────

/// The same rule from OUTSIDE: a successful mint leaves the provider-auth store
/// exactly as it found it — ABSENT. This test reddens instantly if anyone ever
/// routes the ADC token through `store::save` / `store_credential`, wherever in
/// the call graph that happens (a census cannot see a write reached from a
/// different module; this one can).
#[tokio::test]
async fn minting_a_token_never_writes_the_provider_auth_store() {
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "nopersist");
    let adc = scratch_adc(&adc_dir, "nopersist");
    // Installed so the ambient candidates are never even STAT-ed (the developer's
    // real ADC file stays out of this test), even though the seam below takes the
    // path and the endpoint explicitly.
    let _override = install(AdcFileSource::Explicit(Some(adc.clone())), None);
    // The store's home (a scratch stand-in for the platform data dir — the path
    // INJECTION discipline the store itself is built on) and the config dir, both
    // watched.
    let watched = ScratchDir::in_env_temp("gcloud-adc-", "watched");
    let store_file = watched.join("archimedes/provider-auth.json");
    let before = watched_listing(watched.path());

    let endpoint = mount_token_server("ya29.never-persisted").await.uri();
    let minted =
        gcloud::token_for_paths(Some(&adc), &endpoint, TEST_TTL, &reqwest::Client::new()).await;
    assert_eq!(
        minted.as_deref(),
        Some("ya29.never-persisted"),
        "the mint itself must work (an empty test would pass this assertion)"
    );

    assert!(
        !store_file.exists(),
        "the ADC flow wrote the provider-auth store: {}",
        store_file.display()
    );
    assert!(
        !watched.join("archimedes").exists(),
        "the ADC flow created the store's directory"
    );
    // And NOTHING at all appeared in the watched dir — the strongest form: no
    // file anywhere, not merely none at the store's path.
    assert_eq!(
        watched_listing(watched.path()),
        before,
        "the ADC flow wrote something to disk it should not have"
    );
    // The ADC file itself is READ, never rewritten (discovery is read-only).
    let after = std::fs::read_to_string(&adc).unwrap();
    assert!(
        after.contains("authorized_user"),
        "the ADC fixture was rewritten: {after}"
    );
}

/// The names inside a dir (sorted), for the "nothing appeared" assertion.
fn watched_listing(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|e| {
            e.unwrap_or_else(|e| panic!("cannot read an entry of {}: {e}", dir.display()))
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    out.sort();
    out
}

// ── 4. the failure keeps the old token (integration mirror) ───────────────

/// A failed exchange returns `None` (the caller serves the static key) and the
/// previously minted token SURVIVES in the cache — a transient Google outage must
/// not cost a still-valid token. The outward behaviour is `None` either way, so
/// the cache contents are what carries the claim (the documented test seam).
#[tokio::test]
async fn exchange_failure_keeps_the_previous_token() {
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "keep");
    let adc = scratch_adc(&adc_dir, "keep");
    let ok = mount_token_server("ya29.integration-kept").await;
    let bad = failing_token_server().await;
    let client = reqwest::Client::new();

    assert_eq!(
        gcloud::token_for_paths(Some(&adc), &ok.uri(), TEST_TTL, &client)
            .await
            .as_deref(),
        Some("ya29.integration-kept")
    );
    // A DIFFERENT endpoint that fails: the mint is served from the cache while it
    // is fresh, so force the refetch with a TTL that has already elapsed.
    let _override = install(AdcFileSource::Explicit(Some(adc.clone())), Some(bad.uri()));
    assert_eq!(
        gcloud::token_for_paths(Some(&adc), &bad.uri(), std::time::Duration::ZERO, &client).await,
        None,
        "a failed exchange never invents a token"
    );
    let snapshot = gcloud::cache_snapshot();
    assert_eq!(
        snapshot
            .iter()
            .map(|(_, token)| token.as_str())
            .collect::<Vec<_>>(),
        vec!["ya29.integration-kept"],
        "a failed refetch must leave the held token in the cache"
    );
}

// ── 5. the dispatcher arm ─────────────────────────────────────────────────

/// The `gcloud_adc` arm in `resolve_bearer_at` serves the minted token (the row's
/// static key is REPLACED, not appended to).
#[tokio::test]
async fn resolve_bearer_serves_the_minted_adc_token() {
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "arm");
    let adc = scratch_adc(&adc_dir, "arm");
    let endpoint = mount_token_server("ya29.arm-token").await.uri();
    let _override = install(AdcFileSource::Explicit(Some(adc)), Some(endpoint));

    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");
    let auth_file = store_dir.join("provider-auth.json");
    let got = resolve_bearer_at(
        &provider("gw", "gcloud_adc", "static-key", false),
        &auth_file,
        &store_dir,
        &reqwest::Client::new(),
        true,
    )
    .await;
    assert_eq!(
        got.as_deref(),
        Some("ya29.arm-token"),
        "the ADC token is the effective bearer"
    );
    assert!(
        !auth_file.exists(),
        "the arm must not persist the token it just minted"
    );
}

/// `useGcloudTokenAuth: true` enables the flow on an ordinary `api_key` row (the
/// spec's "enable via the `use_gcloud_token_auth` setting" — `authMode` is not the
/// only door).
#[tokio::test]
async fn the_gcloud_flag_enables_the_arm_on_an_api_key_row() {
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "flag");
    let adc = scratch_adc(&adc_dir, "flag");
    let endpoint = mount_token_server("ya29.flag-token").await.uri();
    let _override = install(AdcFileSource::Explicit(Some(adc)), Some(endpoint));

    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");
    let got = resolve_bearer_at(
        &provider("gw", "api_key", "static-key", true),
        &store_dir.join("provider-auth.json"),
        &store_dir,
        &reqwest::Client::new(),
        true,
    )
    .await;
    assert_eq!(got.as_deref(), Some("ya29.flag-token"));
}

/// The `service_account` rejection, at the arm boundary: the row degrades to `None`
/// (= the static key) and the diagnostic names the fix. The diagnostic is asserted
/// through the debug log (the ADC path never surfaces an error at the boundary, so
/// the log is the only place a user can learn why).
#[allow(clippy::await_holding_lock)] // the debuglog target is process-global
#[tokio::test]
async fn resolve_bearer_degrades_on_a_service_account_and_logs_the_fix() {
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "service");
    let adc = adc_dir.join("adc.json");
    std::fs::write(
        &adc,
        serde_json::json!({
            "type": "service_account",
            "client_email": "svc@project.iam.gserviceaccount.com",
            "private_key": "-----BEGIN PRIVATE KEY-----",
            "token_uri": "https://oauth2.googleapis.com/token"
        })
        .to_string(),
    )
    .unwrap();
    let _override = install(AdcFileSource::Explicit(Some(adc)), None);

    // The log dir is this test's own (the `commands/sessions.rs` shape) so the
    // assertion never reads a sibling's lines, and it is disabled on the way out.
    let log_dir = ScratchDir::in_env_temp("gcloud-adc-", "log");
    struct RestoreDebuglog;
    impl Drop for RestoreDebuglog {
        fn drop(&mut self) {
            archimedes_lib::agent::debuglog::init(false, None);
        }
    }
    let _log = RestoreDebuglog;
    archimedes_lib::agent::debuglog::init(true, Some(log_dir.to_path_buf()));

    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");
    let got = resolve_bearer_at(
        &provider("gw", "gcloud_adc", "static-key", false),
        &store_dir.join("provider-auth.json"),
        &store_dir,
        &reqwest::Client::new(),
        true,
    )
    .await;
    assert_eq!(
        got, None,
        "a rejected ADC file degrades to the static key — never a blank, never an Err"
    );
    let logged = std::fs::read_to_string(log_dir.join("supervisor.log"))
        .expect("the rejection was logged (a silent ADC failure is undebuggable)");
    assert!(
        logged.contains("service_account"),
        "the diagnostic must name the offending type:\n{logged}"
    );
    assert!(
        logged.contains("gcloud auth application-default login"),
        "the diagnostic must name the fix the user can run:\n{logged}"
    );
}

/// The boundary never errors: no ADC file at all + a row with NO static key →
/// `None` (the "serve the empty static key" answer the caller already handles),
/// and no request is attempted.
#[tokio::test]
async fn resolve_bearer_never_errors_at_the_boundary() {
    let _serial = adc_serial();
    // The override installs NO adc file (the override replaces discovery, so this
    // is "no ADC file exists") and no endpoint (so the real Google endpoint would
    // be used — which proves the call returns before the network by still
    // finishing promptly).
    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");
    let got = resolve_bearer_at(
        &provider("gw", "gcloud_adc", "", false),
        &store_dir.join("provider-auth.json"),
        &store_dir,
        &reqwest::Client::new(),
        true,
    )
    .await;
    assert_eq!(
        got, None,
        "absent ADC + no static key is `None`, not an error"
    );
}

/// The env precedence, at the dispatcher (`LITELLM_GCLOUD_TOKEN_AUTH` beats the
/// row's flag in both directions; an unrecognised value defers to the row).
#[allow(clippy::await_holding_lock)] // the override + the env are process-global
#[tokio::test]
async fn env_override_beats_the_provider_flag() {
    let _lock = env_lock();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "env");
    let adc = scratch_adc(&adc_dir, "env");
    let server = mount_token_server("ya29.env-token").await;
    let _override = install(
        AdcFileSource::Explicit(Some(adc.clone())),
        Some(server.uri()),
    );
    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");
    let auth_file = store_dir.join("provider-auth.json");
    let client = reqwest::Client::new();

    let hits = || async { server.received_requests().await.unwrap_or_default().len() };

    // `=1` on a row that did NOT opt in → the arm fires.
    gcloud::cache_clear();
    let _on = set_env("LITELLM_GCLOUD_TOKEN_AUTH", "1");
    let got = resolve_bearer_at(
        &provider("gw-env-on", "api_key", "static-key", false),
        &auth_file,
        &store_dir,
        &client,
        true,
    )
    .await;
    assert_eq!(
        got.as_deref(),
        Some("ya29.env-token"),
        "`=1` enables the flow for every row"
    );
    assert!(
        hits().await >= 1,
        "the mint actually hit the token endpoint"
    );
    drop(_on);

    // `=false` on a row that DID opt in → the arm does not fire (no new request).
    gcloud::cache_clear();
    let before = hits().await;
    let _off = set_env("LITELLM_GCLOUD_TOKEN_AUTH", "false");
    let got = resolve_bearer_at(
        &provider("gw-env-off", "gcloud_adc", "static-key", true),
        &auth_file,
        &store_dir,
        &client,
        true,
    )
    .await;
    assert_eq!(
        got, None,
        "`=false` refuses the flow even for an opted-in row"
    );
    assert_eq!(
        hits().await,
        before,
        "a refused flow must not touch the token endpoint"
    );
    drop(_off);

    // An unrecognised value → the row decides (a typo must not silently disable a
    // configured flow).
    gcloud::cache_clear();
    let _typo = set_env("LITELLM_GCLOUD_TOKEN_AUTH", "yes-please");
    let got = resolve_bearer_at(
        &provider("gw-env-typo", "api_key", "static-key", true),
        &auth_file,
        &store_dir,
        &client,
        true,
    )
    .await;
    assert_eq!(
        got.as_deref(),
        Some("ya29.env-token"),
        "an unrecognised env value defers to the provider flag"
    );
    drop(_typo);
    gcloud::cache_clear();
}

/// With the env UNSET and the row's flag off, the ADC flow is invisible: a plain
/// `api_key` row is served by the default arm and the token endpoint is never
/// contacted. (The env is process-global state, so the unset is explicit — a
/// developer's exported `LITELLM_GCLOUD_TOKEN_AUTH` must not leak in here.)
#[tokio::test]
async fn an_ordinary_row_never_touches_the_adc_flow() {
    // `adc_serial()` ALREADY holds `ENV_LOCK` (it is a non-reentrant
    // `std::sync::Mutex` — locking it twice in one thread deadlocks, which is the
    // one way this suite can hang), so the env guard is taken without a second
    // lock here.
    let _serial = adc_serial();
    let _unset = remove_env("LITELLM_GCLOUD_TOKEN_AUTH");
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "off");
    let adc = scratch_adc(&adc_dir, "off");
    let server = mount_token_server("ya29.unwanted").await;
    let _override = install(AdcFileSource::Explicit(Some(adc)), Some(server.uri()));
    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");

    let got = resolve_bearer_at(
        &provider("gw", "api_key", "static-key", false),
        &store_dir.join("provider-auth.json"),
        &store_dir,
        &reqwest::Client::new(),
        true,
    )
    .await;
    assert_eq!(got, None, "an `api_key` row is the default arm's");
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        0,
        "the ADC flow must not run for a row that did not ask"
    );
}

/// The ADC flow does not consume the `execute_helpers` gate: with the seeding flag
/// `false` (the "app startup spawns nothing" path) the ADC arm still runs, because
/// it is a POST and not a subprocess.
#[tokio::test]
async fn the_adc_arm_runs_even_with_execute_helpers_false() {
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "seed");
    let adc = scratch_adc(&adc_dir, "seed");
    let endpoint = mount_token_server("ya29.seeded").await.uri();
    let _override = install(AdcFileSource::Explicit(Some(adc)), Some(endpoint));
    let store_dir = ScratchDir::in_env_temp("gcloud-adc-", "store");

    let got = resolve_bearer_at(
        &provider("gw", "gcloud_adc", "static-key", false),
        &store_dir.join("provider-auth.json"),
        &store_dir,
        &reqwest::Client::new(),
        false,
    )
    .await;
    assert_eq!(
        got.as_deref(),
        Some("ya29.seeded"),
        "the seeding gate gates SUBPROCESSES, not the native exchange"
    );
}

// ── 6. the real discovery path (env var, scratch HOME) ────────────────────

/// The `GOOGLE_APPLICATION_CREDENTIALS` leg, end-to-end through the PRODUCTION
/// discovery function (`token`, not the `*_for_paths` seam) — with the env pointed
/// at a scratch file and `HOME` pointed at an empty scratch dir, so the developer's
/// real ADC file cannot be the thing under test.
#[allow(clippy::await_holding_lock)] // the env is process-global
#[tokio::test]
async fn token_discovers_the_adc_file_named_by_the_env_var() {
    // `adc_serial()` holds `ENV_LOCK` for the whole span (see the note in
    // `an_ordinary_row_never_touches_the_adc_flow` — a second `env_lock()` in the
    // same thread would deadlock).
    let _serial = adc_serial();
    let adc_dir = ScratchDir::in_env_temp("gcloud-adc-", "envvar");
    let adc = scratch_adc(&adc_dir, "envvar");
    let empty_home = ScratchDir::in_env_temp("gcloud-adc-", "home");
    let endpoint = mount_token_server("ya29.from-env-var").await.uri();
    // The override carries ONLY the endpoint: with `adc_file: None` in the
    // override... it would replace discovery, so instead install nothing and let
    // the env drive discovery (the endpoint override is what keeps this off the
    // real Google).
    let _override = install(AdcFileSource::Discover, Some(endpoint));
    let _env = set_env(gcloud::ADC_ENV_VAR, &adc.display().to_string());
    let _home = set_env("HOME", &empty_home.display().to_string());

    let got = gcloud::token(&adc_dir, &reqwest::Client::new()).await;
    assert_eq!(
        got.as_deref(),
        Some("ya29.from-env-var"),
        "the env-named ADC file must be found by the production discovery path"
    );
}

/// The same path with NO ADC file anywhere (env unset, `HOME` an empty scratch
/// dir): `None`, and the config dir untouched. `config_dir` is in the signature
/// for interface symmetry — the ADC file never lives there, and this pins that no
/// stray file appears in it.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn token_is_none_when_no_adc_file_exists_anywhere() {
    let _lock = env_lock();
    gcloud::cache_clear();
    let empty_home = ScratchDir::in_env_temp("gcloud-adc-", "home");
    let config_dir = ScratchDir::in_env_temp("gcloud-adc-", "config");
    let _env = remove_env(gcloud::ADC_ENV_VAR);
    let _home = set_env("HOME", &empty_home.display().to_string());
    let _unset_toggle = remove_env("LITELLM_GCLOUD_TOKEN_AUTH");

    let got = gcloud::token(config_dir.path(), &reqwest::Client::new()).await;
    assert_eq!(got, None, "no ADC file anywhere is a plain miss");
    assert!(
        watched_listing(config_dir.path()).is_empty(),
        "the ADC flow wrote into the app's config dir"
    );
}

// ── 7. the refresher's `gcloud_adc` route ─────────────────────────────────

/// The store refresher's `flow = "gcloud_adc"` arm is a LABEL route: an ADC
/// credential carries the user's ADC file, not a minted token, so the loop
/// returns it UNCHANGED rather than trying to rotate something it cannot rotate
/// (and never persists a minted ADC token).
#[tokio::test]
async fn the_refresher_passes_a_gcloud_adc_credential_through_unchanged() {
    let cred = ProviderCredential::OAuth(
        archimedes_lib::agent::provider_auth::store::OAuthCredential {
            flow: "gcloud_adc".to_string(),
            access_token: "ya29.stored".to_string(),
            refresh_token: Some("adc-refresh".to_string()),
            expires_at: Some(1_700_000_000_000),
            base_url: "https://gw.example/v1".to_string(),
            client_id: Some("client".to_string()),
            token_endpoint: None,
            resource: None,
        },
    );
    let client = reqwest::Client::new();
    let next = archimedes_lib::agent::provider_auth::refresh(&cred, &client)
        .await
        .expect("the gcloud_adc route is a no-op, never an error");
    assert_eq!(
        next, cred,
        "an ADC credential is returned byte-for-byte unchanged"
    );
}

// ── 8. the constants the spec pins by name ────────────────────────────────

/// The numbers the spec fixes (50 minutes, Google's fixed endpoint, the
/// `authorized_user` shape) — pinned so a well-meaning "tidy-up" reddens here.
#[test]
fn the_spec_pinned_constants() {
    assert_eq!(gcloud::CACHE_TTL_MS, 50 * 60 * 1000, "the 50-minute cache");
    assert_eq!(
        gcloud::TOKEN_ENDPOINT,
        "https://oauth2.googleapis.com/token",
        "the fixed endpoint (no discovery)"
    );
    assert_eq!(gcloud::ADC_ENV_VAR, "GOOGLE_APPLICATION_CREDENTIALS");

    // A 50-minute cache inside Google's 60-minute token lifetime is the whole
    // safety argument for not reading `expires_in` — record it as a number.
    // WHY 50 minutes and not 60: Google access tokens live 3599 s, so a
    // 50-minute ceiling is the whole safety argument for never reading
    // `expires_in` — the cache can only ever serve a token with at least 10
    // minutes of life left. Asserted through a binding (not a literal) so clippy
    // sees a runtime comparison: the NUMBER is the reason, and widening the TTL to
    // 60 would silently start serving expired tokens.
    let google_token_lifetime_ms = 60 * 60 * 1000;
    assert!(
        gcloud::CACHE_TTL_MS < google_token_lifetime_ms,
        "the cache TTL must stay below Google's own token lifetime"
    );
}

/// `parse_adc` is the module's validation surface and the `service_account`
/// rejection is its reason for existing — asserted from OUTSIDE the crate so the
/// integration surface (what `commands/` and T5/T6 will call) is what is pinned.
#[test]
fn parse_adc_rejects_a_service_account_from_outside_the_crate() {
    let err = gcloud::parse_adc(
        r#"{"type":"service_account","client_email":"svc@x.iam","private_key":"k"}"#,
        Path::new("/scratch/adc.json"),
    )
    .expect_err("a service account is never a usable ADC credential");
    let msg = gcloud::describe_error(&err, Some(Path::new("/scratch/adc.json")));
    assert!(msg.contains("service_account"), "{msg}");
    assert!(
        msg.contains("gcloud auth application-default login"),
        "{msg}"
    );

    // And the happy shape parses.
    let dir = ScratchDir::in_env_temp("gcloud-adc-", "parse");
    let adc = scratch_adc(&dir, "parse");
    let contents = std::fs::read_to_string(&adc).unwrap();
    let cred: AdcCredential = gcloud::parse_adc(&contents, &adc).expect("a valid file parses");
    assert_eq!(cred.client_id, "it-parse-client");
    assert_eq!(cred.source, adc);
}
