//! Integration tests for `agent::provider_auth` (issue #125, Task 1): the
//! `provider-auth.json` store's wire shape, the expiry math, and the
//! `resolve_bearer` dispatcher's arms.
//!
//! PUBLIC API only — the tests that need the module's private helpers (the
//! mode/inode/staging-litter set) live in `store.rs`'s in-module
//! `#[cfg(test)]` tree, exactly as their `mcp::oauth` originals do.
//!
//! Hermeticity (interface ruling R3): every test drives the store through the
//! path-taking core `resolve_bearer_at` with a `ScratchDir` path, so nothing
//! here reads or writes the real platform data dir (the `mcp::manager`
//! `with_auth_file` precedent). `auth_file_path()` itself is not asserted.

use archimedes_lib::agent::provider_auth::resolve_bearer_at;
use archimedes_lib::agent::provider_auth::store::{self, OAuthCredential, ProviderCredential};
use archimedes_lib::config::ProviderConfig;
use archimedes_lib::test_support::ScratchDir;

/// A scratch dir for ONE test, OWNED (ADR 0078 — removed when it drops).
fn scratch() -> ScratchDir {
    ScratchDir::in_env_temp("provider-auth-", "tag")
}

/// A `ProviderConfig` on the given auth mode (the static `api_key` is a
/// sentinel the dispatcher must either ignore or serve, per arm).
fn provider(id: &str, auth_mode: &str) -> ProviderConfig {
    ProviderConfig {
        id: id.to_string(),
        name: format!("Provider {id}"),
        base_url: "https://gw.example/v1".to_string(),
        api_key: "static-key".to_string(),
        api: "litellm".to_string(),
        key_url: None,
        auth_mode: auth_mode.to_string(),
        // (issue #129) The mechanical additive grow: T2a's `ProviderConfig`
        // gained `headers` + `allow_insecure_http`; this fixture's providers
        // use neither (no custom headers, no plain-HTTP opt-in).
        headers: None,
        allow_insecure_http: false,
    }
}

/// A fully-populated OAuth credential (every `Option` non-`None`, so the
/// round-trip test is exhaustive).
fn oauth(id: &str, expires_at: Option<i64>) -> OAuthCredential {
    OAuthCredential {
        flow: "litellm_cli_pkce".to_string(),
        access_token: format!("bearer-{id}"),
        refresh_token: Some(format!("refresh-{id}")),
        expires_at,
        base_url: "https://gw.example/v1".to_string(),
        client_id: Some(format!("client-{id}")),
        token_endpoint: Some("https://auth.example/token".to_string()),
        resource: Some("https://gw.example".to_string()),
    }
}

#[test]
fn oauth_credential_round_trips_camelcase() {
    // The wire format (interface §3): the `type` tag is `"oauth"` and every
    // field is camelCase. The contract's fixed type has NO
    // `skip_serializing_if` on the `Option`s — a `None` serializes as `null`,
    // so this test populates ALL of them and asserts each name.
    let dir = scratch();
    let path = dir.path().join("provider-auth.json");
    let cred = oauth("gw", Some(1_729_000_000_000));
    store::store_credential(&path, "gw", ProviderCredential::OAuth(cred.clone())).expect("stores");

    // The round trip through the store is value-exact.
    let loaded = store::load(&path);
    assert_eq!(loaded.providers.len(), 1, "one entry");
    assert_eq!(
        loaded.providers["gw"],
        ProviderCredential::OAuth(cred),
        "every field survives the write + read"
    );
    assert_eq!(loaded.version, 1, "the envelope carries `version`");

    // The JSON shape (the names on disk, not just the Rust values). The
    // document is written `to_string_pretty`, so compare against a
    // whitespace-stripped copy: the assertion is about the KEY NAMES and the
    // `type` tag, not about the indentation.
    let json = std::fs::read_to_string(&path).expect("the file exists");
    let compact: String = json.chars().filter(|c| !c.is_whitespace()).collect();
    for needle in [
        "\"type\":\"oauth\"",
        "\"accessToken\"",
        "\"expiresAt\"",
        "\"tokenEndpoint\"",
        "\"refreshToken\"",
        "\"clientId\"",
        "\"resource\"",
        "\"flow\"",
        "\"baseUrl\"",
        "\"version\":1",
        "\"providers\"",
    ] {
        assert!(
            compact.contains(needle),
            "the document carries {needle}, got:\n{json}"
        );
    }
}

#[test]
fn unknown_provider_type_does_not_poison_the_store() {
    // A hand-edited (or newer-app-version) file carrying an entry this build
    // cannot parse must drop ONLY that entry: `load` keeps the good ones, and
    // the NEXT save does not wipe them by re-serializing a store that lost
    // them silently.
    let dir = scratch();
    let path = dir.path().join("provider-auth.json");
    std::fs::write(
        &path,
        r#"{"version":1,"providers":{
            "a":{"type":"oauth","flow":"litellm_cli_pkce","accessToken":"tok-a",
                 "baseUrl":"https://gw.example/v1"},
            "b":{"type":"mystery","x":1}
        }}"#,
    )
    .expect("the hand-written file exists");

    let loaded = store::load(&path);
    assert!(
        loaded.providers.contains_key("a"),
        "the good entry survives"
    );
    assert!(
        !loaded.providers.contains_key("b"),
        "the unparseable entry is dropped, not fatal"
    );

    // And the drop does not turn the next write into a whole-store wipe: a
    // third provider lands, `a` is still there, `b` stays gone (the tolerant
    // read is what makes the next save honest).
    store::store_credential(&path, "c", ProviderCredential::OAuth(oauth("c", None)))
        .expect("the save works");
    let after = store::load(&path);
    assert!(after.providers.contains_key("a"), "`a` survived the save");
    assert!(after.providers.contains_key("c"), "`c` was added");
    assert!(
        !after.providers.contains_key("b"),
        "the unparseable entry never enters the store, so it is never rewritten"
    );
    assert_eq!(after.version, 1, "the version round-trips");
}

#[test]
fn expiry_calculation_triggers_at_the_5_minute_lead() {
    // The spec's lead (§2.2): a token expiring INSIDE the 5-minute margin IS
    // expired for refresh purposes (the in-flight request must survive the
    // round trip — the `mcp::oauth` rationale). `None` = the auth server never
    // told us an expiry → NEVER expires (never auto-refresh).
    let now = 1_700_000_000_000_i64;
    assert!(
        store::is_expiring_soon(Some(now + 4 * 60_000), now),
        "4 minutes out is inside the 5-minute lead"
    );
    assert!(
        !store::is_expiring_soon(Some(now + 6 * 60_000), now),
        "6 minutes out is outside the lead"
    );
    assert!(
        !store::is_expiring_soon(None, now),
        "no advertised expiry never expires"
    );
    // The boundary itself: exactly at the lead counts as expiring (`<=`).
    assert!(
        store::is_expiring_soon(Some(now + store::REFRESH_LEAD_MILLIS), now),
        "the lead boundary is inclusive"
    );
    assert_eq!(
        store::REFRESH_LEAD_MILLIS,
        5 * 60 * 1000,
        "the lead is 5 minutes"
    );
}

#[test]
fn expiry_expressed_in_milliseconds_matches_the_spec() {
    // The unit pin (interface §3's "silent unit swap" warning): `expires_at`
    // is epoch MILLISECONDS — unlike `mcp::oauth::StoredAuth`, whose expiry is
    // in SECONDS. A seconds/millis mixup reddens this test.
    let dir = scratch();
    let path = dir.path().join("provider-auth.json");
    let millis = 1_729_000_000_000_i64;
    let document = serde_json::json!({
        "version": 1,
        "providers": {
            "gw": {
                "type": "oauth",
                "flow": "litellm_cli_pkce",
                "accessToken": "t",
                "baseUrl": "https://gw.example/v1",
                "expiresAt": millis
            }
        }
    })
    .to_string();
    std::fs::write(&path, document).expect("the hand-written file exists");
    let loaded = store::load(&path);
    // The absent `Option` fields parsed to `None` (the `#[serde(default)]`
    // half of the tolerant shape) and `expiresAt` kept its MILLISECOND value.
    let expected = ProviderCredential::OAuth(OAuthCredential {
        flow: "litellm_cli_pkce".to_string(),
        access_token: "t".to_string(),
        refresh_token: None,
        expires_at: Some(millis),
        base_url: "https://gw.example/v1".to_string(),
        client_id: None,
        token_endpoint: None,
        resource: None,
    });
    assert_eq!(
        loaded.providers["gw"], expected,
        "the millis value round-trips (and the absent optionals default to None)"
    );
    // The value is a MILLISECOND timestamp (13 digits): read as seconds it
    // would be year ~56,000 — so the spec's example value is unambiguously
    // millis against the live clock.
    let now = store::now_epoch_millis();
    assert!(
        (millis - now).abs() < 365 * 24 * 60 * 60 * 1000 * 10,
        "`expiresAt` is in the same ballpark as the current millis clock (within a decade): \
         now={now}, expiresAt={millis}"
    );
}

#[tokio::test]
async fn resolve_bearer_returns_the_stored_oauth_token_within_the_lead() {
    // The substitution rule (interface §1): on `auth_mode: "oauth"` with a
    // stored credential, the bearer REPLACES the row's static `api_key` — even
    // when the token is inside the refresh lead (the background loop refreshes
    // it; resolution here SERVES the stored token, because blanking a working
    // key is worse than a stale one).
    let dir = scratch();
    let auth_file = dir.path().join("provider-auth.json");
    let soon = store::now_epoch_millis() + 60_000; // 1 minute out — inside the lead
    store::store_credential(
        &auth_file,
        "gw",
        ProviderCredential::OAuth(oauth("gw", Some(soon))),
    )
    .expect("the store is seeded");

    let client = reqwest::Client::new();
    let bearer = resolve_bearer_at(
        &provider("gw", "oauth"),
        &auth_file,
        dir.path(),
        &client,
        false,
    )
    .await;
    assert_eq!(
        bearer.as_deref(),
        Some("bearer-gw"),
        "the stored token is the answer (the static key is ignored)"
    );
}

#[tokio::test]
async fn resolve_bearer_returns_none_when_no_credential_is_stored() {
    // `auth_mode: "oauth"` but nothing in the store (the file does not even
    // exist — `load` answers an empty store): `None`, meaning "use the row's
    // static api_key as-is". Degrade, never blank.
    let dir = scratch();
    let auth_file = dir.path().join("provider-auth.json");
    assert!(
        !auth_file.exists(),
        "the premise: no store file at the injected path"
    );

    let client = reqwest::Client::new();
    let bearer = resolve_bearer_at(
        &provider("gw", "oauth"),
        &auth_file,
        dir.path(),
        &client,
        false,
    )
    .await;
    assert_eq!(bearer, None, "no credential → the static key stands");
}

#[tokio::test]
async fn resolve_bearer_defaults_to_static_for_api_key_mode() {
    // The default arm: `auth_mode: "api_key"` never consults the store, even
    // when a credential IS stored for that provider id (a provider the user
    // switched back to a static key keeps serving the static key).
    let dir = scratch();
    let auth_file = dir.path().join("provider-auth.json");
    store::store_credential(
        &auth_file,
        "gw",
        ProviderCredential::OAuth(oauth("gw", None)),
    )
    .expect("the store is seeded");

    let client = reqwest::Client::new();
    let bearer = resolve_bearer_at(
        &provider("gw", "api_key"),
        &auth_file,
        dir.path(),
        &client,
        true,
    )
    .await;
    assert_eq!(bearer, None, "api_key mode is the static path");
}

#[tokio::test]
async fn unknown_auth_mode_is_treated_as_static() {
    // The permissive boundary (interface §5: a STRING, not an enum — validate
    // at use): an unknown mode is the static path, `None`, no panic. A file
    // written by a newer app version must not break resolution here.
    let dir = scratch();
    let auth_file = dir.path().join("provider-auth.json");
    store::store_credential(
        &auth_file,
        "gw",
        ProviderCredential::OAuth(oauth("gw", None)),
    )
    .expect("the store is seeded");

    let client = reqwest::Client::new();
    let bearer = resolve_bearer_at(
        &provider("gw", "bogus"),
        &auth_file,
        dir.path(),
        &client,
        true,
    )
    .await;
    assert_eq!(bearer, None, "an unknown mode degrades to the static key");
}
