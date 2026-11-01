//! Integration tests for the budget/quota poller (issue #132, Task 7): the
//! three LiteLLM management endpoints against `wiremock`, the per-endpoint
//! denial memory's WIRE effect (a forbidden endpoint is probed once and then
//! stays quiet), and the 429-exclusion pin (a rate limit NEVER enters denial
//! memory).
//!
//! The wiremock precedent is `tests/provider.rs` (`Mock::given(method(…)
//! .and(path(…)))` + `server.received_requests()`); the header-blind
//! alternative `test_support::raw_json_server` exists but is not needed here —
//! every assertion here is path/method/header-shaped, which is exactly what
//! wiremock's matchers and its request log give.
//!
//! COUNT DISCIPLINE: each test mounts TWO OR THREE endpoints on ONE
//! `MockServer`, so `received_requests().len()` cannot attribute a request to an
//! endpoint. Every count therefore goes through [`count_path`] (method + path
//! filtered) and every mock is itself constrained by `method` + `path`, so a
//! `/key/info` mock can never swallow a `/user/info` request.
//!
//! The "no log line for a suppressed hop" half of the suppression claim is NOT
//! tested here (this file's claim is about REQUESTS); it is pinned in-module by
//! `refresh.rs`'s `poller_ignores_a_denied_endpoint_without_logging`, which can
//! wire the `debuglog` sink to its own scratch dir.

use std::sync::Arc;

use archimedes_lib::agent::provider_auth::budget::{
    poll_all, poll_key_info, poll_user_info, run_budget_tick, BudgetEndpoint, BudgetPoller,
    DenialMemory,
};
use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Count the requests the server saw for ONE method + path pair (the
/// attribution the raw `.len()` cannot provide on a multi-endpoint server).
async fn count_path(server: &MockServer, method: &str, path: &str) -> usize {
    server
        .received_requests()
        .await
        .expect("the mock server records requests")
        .iter()
        .filter(|r| r.method.as_str() == method && r.url.path() == path)
        .count()
}

/// The bearer every test authenticates with (asserted on the wire so the
/// "the poller carries T1's resolved token" claim is measured, not assumed).
const BEARER: &str = "sk-budget-test-token";

/// The provider base for a mock server (the row's base VERBATIM — the poller's
/// root rule is `trim_end_matches('/')`, so the mounted paths are the requested
/// ones).
fn base(server: &MockServer) -> String {
    server.uri()
}

// ── 1. `/key/info`: the entitled path ───────────────────────────────────────

#[tokio::test]
async fn key_info_returns_spend_and_budget() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/key/info"))
        .and(header("authorization", format!("Bearer {BEARER}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "key": "sk-abc",
            "spend": 2.5,
            "max_budget": 10.0,
            "budgetResetAt": "2026-01-01T00:00:00Z"
        })))
        .mount(&server)
        .await;

    let mut memory = DenialMemory::default();
    let facts = poll_key_info(&reqwest::Client::new(), &base(&server), BEARER, &mut memory)
        .await
        .expect("an entitled key reads its own budget");

    assert_eq!(facts.spend, Some(2.5));
    assert_eq!(facts.max_budget, Some(10.0));
    assert_eq!(
        facts.remaining,
        Some(7.5),
        "`remaining = max_budget - spend` when the budget is positive"
    );
    assert_eq!(
        facts.budget_reset_at.as_deref(),
        Some("2026-01-01T00:00:00Z"),
        "the proxy's reset instant rides the row verbatim"
    );
    assert!(memory.is_empty(), "a 2xx records no denial");
    // The attribution claim: exactly ONE request, on `/key/info`, and the mock
    // only matched because the bearer header was present (a missing header
    // leaves the mock un-fired and the poll `None`).
    assert_eq!(count_path(&server, "GET", "/key/info").await, 1);
}

#[tokio::test]
async fn key_info_prefers_the_nested_info_object() {
    // The DOCUMENTED era: `{ "info": { "spend": … } }`. A parse that read only
    // the top-level keys would report `None` spend here and the UI would show a
    // key with no spend at all.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/key/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "key": "sk-abc",
            "info": { "token": "sk-abc", "spend": 4.25, "expires": "2026-06-01T00:00:00Z" },
            "max_budget": 20.0
        })))
        .mount(&server)
        .await;

    let mut memory = DenialMemory::default();
    let facts = poll_key_info(&reqwest::Client::new(), &base(&server), BEARER, &mut memory)
        .await
        .expect("the nested era parses");
    assert_eq!(
        facts.spend,
        Some(4.25),
        "the spend comes from `info.spend` when the top-level key is absent"
    );
    assert_eq!(facts.remaining, Some(15.75));
    assert_eq!(count_path(&server, "GET", "/key/info").await, 1);
}

// ── 2. `/v2/user/info` + the `/user/info` fallback ──────────────────────────

#[tokio::test]
async fn user_info_tries_v2_then_falls_back_to_v1() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"detail": "Not Found"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/user/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": "alice",
            "spend": 1.0,
            "max_budget": 50.0
        })))
        .mount(&server)
        .await;

    let mut memory = DenialMemory::default();
    let facts = poll_user_info(&reqwest::Client::new(), &base(&server), BEARER, &mut memory)
        .await
        .expect("the fallback serves the tick");
    assert_eq!(facts.user_id.as_deref(), Some("alice"));
    assert_eq!(facts.remaining, Some(49.0));

    // BOTH hops fired exactly once (the fallback fired; nothing triple-fetched).
    assert_eq!(count_path(&server, "GET", "/v2/user/info").await, 1);
    assert_eq!(count_path(&server, "GET", "/user/info").await, 1);
    // And the hop that just served a 2xx records NO denial (the `/v2` absence is
    // papered over by the fallback, so quieting the pair would buy nothing).
    assert!(
        memory.is_empty(),
        "a successful fallback records no denial: {memory:?}"
    );
}

#[tokio::test]
async fn user_info_without_v2_skips_the_fallback() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": "alice",
            "spend": 0.5,
            "max_budget": 5.0
        })))
        .mount(&server)
        .await;
    // Mounted so a spurious fallback WOULD be served (and counted) rather than
    // hanging on an unmatched mock.
    Mock::given(method("GET"))
        .and(path("/user/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"user_id": "WRONG"})))
        .mount(&server)
        .await;

    let mut memory = DenialMemory::default();
    let facts = poll_user_info(&reqwest::Client::new(), &base(&server), BEARER, &mut memory)
        .await
        .expect("the primary answers");
    assert_eq!(facts.user_id.as_deref(), Some("alice"));
    // The PRIMARY assertion is the filtered count: the old route was never
    // asked, because the new one answered.
    assert_eq!(count_path(&server, "GET", "/v2/user/info").await, 1);
    assert_eq!(
        count_path(&server, "GET", "/user/info").await,
        0,
        "a 2xx on `/v2/user/info` must not spend a fallback request"
    );
    // Corollary (never the primary claim — the server hosts both endpoints):
    assert_eq!(server.received_requests().await.expect("recorded").len(), 1);
}

// ── 3. the team fan-out ─────────────────────────────────────────────────────

#[tokio::test]
async fn team_info_is_polled_per_membership() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": "alice",
            "spend": 1.0,
            "teams": [
                { "team_id": "team-a", "team_alias": "Research" },
                { "team_id": "team-b", "team_alias": "Eng" }
            ]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/team/info"))
        .and(query_param("team_id", "team-a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "team_id": "team-a",
            "team_alias": "Research",
            "spend": 100.0,
            "max_budget": 500.0,
            "budget_reset_at": "2026-02-01T00:00:00Z"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/team/info"))
        .and(query_param("team_id", "team-b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "team_id": "team-b",
            "team_alias": "Eng",
            "spend": 7.0,
            "max_budget": 20.0
        })))
        .mount(&server)
        .await;
    // `/key/info` deliberately UNMOUNTED (wiremock's 404 default): this test
    // asks about the team fan-out, and a denial on the key hop is harmless —
    // the assertions below are all filtered.

    let mut memory = DenialMemory::default();
    let facts = poll_all(&reqwest::Client::new(), &base(&server), BEARER, &mut memory).await;

    assert_eq!(facts.teams.len(), 2, "one row per membership");
    let aliases: Vec<&str> = facts
        .teams
        .iter()
        .map(|t| t.team_alias.as_deref().unwrap_or_default())
        .collect();
    assert_eq!(aliases, vec!["Research", "Eng"], "in membership order");
    assert_eq!(facts.teams[0].spend, Some(100.0));
    assert_eq!(facts.teams[0].max_budget, Some(500.0));
    assert_eq!(facts.teams[0].remaining, Some(400.0));
    assert_eq!(
        facts.teams[0].budget_reset_at.as_deref(),
        Some("2026-02-01T00:00:00Z")
    );
    assert_eq!(facts.teams[1].remaining, Some(13.0));

    // The fan-out is PER id: two `/team/info` requests, each carrying its own
    // `team_id` query param (the ids the user response named, not a guess).
    let team_hits: Vec<String> = server
        .received_requests()
        .await
        .expect("recorded")
        .iter()
        .filter(|r| r.url.path() == "/team/info")
        .map(|r| {
            r.url
                .query_pairs()
                .find(|(k, _)| k == "team_id")
                .map(|(_, v)| v.to_string())
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(team_hits.len(), 2, "one hop per membership");
    assert!(team_hits.contains(&"team-a".to_string()), "{team_hits:?}");
    assert!(team_hits.contains(&"team-b".to_string()), "{team_hits:?}");
    assert_eq!(count_path(&server, "GET", "/v2/user/info").await, 1);
}

// ── 4. THE acceptance test: probe once, then suppress ───────────────────────

#[tokio::test]
async fn forbidden_endpoint_is_probed_once_then_suppressed() {
    // The named acceptance criterion. One server hosts BOTH endpoints, so every
    // count is path-filtered — an unfiltered `.len()` cannot show that the
    // entitled hop kept firing while the denied one went silent.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/key/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"spend": 1.0})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"detail": "Only admin."})))
        .mount(&server)
        .await;
    // The fallback is denied too, so the `user_info` hop genuinely enters memory
    // (a 2xx fallback would serve the tick and record nothing).
    Mock::given(method("GET"))
        .and(path("/user/info"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"detail": "Only admin."})))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let mut memory = DenialMemory::default();

    // Tick 1: both hops fire; the forbidden one is recorded.
    let first = poll_all(&client, &base(&server), BEARER, &mut memory).await;
    assert!(first.key.is_some(), "the entitled hop still serves");
    assert!(first.user.is_none(), "the denied hop serves nothing");
    assert_eq!(count_path(&server, "GET", "/key/info").await, 1);
    assert_eq!(count_path(&server, "GET", "/v2/user/info").await, 1);
    assert_eq!(
        memory,
        {
            let mut expected = DenialMemory::default();
            expected.deny(&base(&server), BudgetEndpoint::UserInfo);
            expected
        },
        "exactly ONE denial recorded (the per-endpoint rule: the entitled hop is untouched)"
    );

    // Tick 2 (the same memory, no re-arm): the entitled hop fires AGAIN, the
    // denied hop is NEVER touched — no request, so nothing to log either.
    let second = poll_all(&client, &base(&server), BEARER, &mut memory).await;
    assert!(second.key.is_some(), "the entitled hop keeps serving");
    assert_eq!(
        count_path(&server, "GET", "/key/info").await,
        2,
        "the entitled endpoint is polled on every tick"
    );
    assert_eq!(
        count_path(&server, "GET", "/v2/user/info").await,
        1,
        "the forbidden endpoint was NEVER re-probed (still exactly one request)"
    );
    assert_eq!(
        count_path(&server, "GET", "/user/info").await,
        1,
        "and the fallback is suppressed with its primary"
    );
}

// ── 5. THE 429 pin ──────────────────────────────────────────────────────────

#[tokio::test]
async fn a_429_does_not_enter_denial_memory() {
    // A rate limit is TRANSIENT: treating it as a denial would permanently
    // silence a working endpoint that is merely busy (and re-arm a storm every
    // interval). Pinned twice — by classification (budget.rs's
    // `classify_status_maps_4xx_denied_except_429`) and by BEHAVIOR here: the
    // endpoint fires on BOTH ticks and the scoreboard stays empty.
    let server = MockServer::start().await;
    // The key hop is ENTITLED here, so the "memory is empty" assertion below is
    // about the 429 alone and not about an unmouted hop's default 404.
    Mock::given(method("GET"))
        .and(path("/key/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"spend": 1.0})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(ResponseTemplate::new(429).set_body_json(json!({"detail": "Rate limit"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/user/info"))
        .respond_with(ResponseTemplate::new(429).set_body_json(json!({"detail": "Rate limit"})))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let mut memory = DenialMemory::default();

    let first = poll_all(&client, &base(&server), BEARER, &mut memory).await;
    assert!(first.user.is_none(), "a 429 serves no facts");
    assert!(
        memory.is_empty(),
        "a 429 NEVER enters denial memory: {memory:?}"
    );

    let second = poll_all(&client, &base(&server), BEARER, &mut memory).await;
    assert!(second.user.is_none());
    assert!(
        memory.is_empty(),
        "still empty after a second 429: {memory:?}"
    );
    // The behavioral half of the pin: the hop is RETRIED on the next tick.
    assert_eq!(
        count_path(&server, "GET", "/v2/user/info").await,
        2,
        "a rate-limited endpoint is polled again (a denial would have left this at 1)"
    );
}

// ── 6. the token-resolution degrade (interface §1) ─────────────────────────

#[tokio::test]
async fn a_provider_whose_token_cannot_resolve_is_never_polled_and_never_errors() {
    // Interface §1's degradation, at the tick's boundary: when T1's resolver has
    // nothing to serve (an `oauth` row with no stored credential) and the row's
    // static `api_key` is EMPTY, there is no bearer to authenticate with — so
    // the tick SKIPS the provider: no request, no denial, no facts, and above
    // all no error. A budget read must never be able to fail the command that
    // surfaces it (the UI shows "not offered", never a failure row).
    //
    // The scratch paths double as the hermeticity pin: the poller was
    // CONSTRUCTED with a scratch settings dir + a scratch (absent) credential
    // store, so this also proves the tick resolves through the INJECTED path and
    // never reaches the real DATA-dir `provider-auth.json`.
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("provider-budget-", "nokey");
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/key/info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"spend": 0.0})))
        .mount(&server)
        .await;
    write_litellm_provider(dir.path(), &server.uri(), "", "oauth");

    let poller = std::sync::Arc::new(std::sync::Mutex::new(BudgetPoller::new(
        dir.path().to_path_buf(),
        dir.path().join("provider-auth.json"),
        archimedes_lib::agent::provider_auth::budget::BUDGET_POLL_INTERVAL_MILLIS,
    )));
    run_budget_tick(&poller, &reqwest::Client::new(), None, true).await;

    assert_eq!(
        count_path(&server, "GET", "/key/info").await,
        0,
        "no bearer ⇒ no request (an unauthenticated probe would only earn a 401 denial)"
    );
    let guard = poller.lock().expect("the ledger");
    assert!(
        guard.denial_memory().is_empty(),
        "a skipped provider records nothing: {:?}",
        guard.denial_memory()
    );
    assert!(
        guard.facts("litellm-local").is_none(),
        "and stores no facts (the DTO omits the row — the UI's not-offered state)"
    );
    // The row WAS picked up as a poll target (the `api == "litellm"` filter), so
    // the skip is the bearer rule and not the filter silently missing the row.
    assert_eq!(guard.provider_ids(), vec!["litellm-local".to_string()]);
}

/// Write a `settings.json` carrying ONE LiteLLM provider row (the poller's only
/// input) — the same file `load_settings` reads at arm time.
fn write_litellm_provider(
    config_dir: &std::path::Path,
    base_url: &str,
    api_key: &str,
    auth_mode: &str,
) {
    let settings = json!({
        "providers": [{
            "id": "litellm-local",
            "name": "LiteLLM Local",
            "baseUrl": base_url,
            "apiKey": api_key,
            "api": "litellm",
            "authMode": auth_mode
        }]
    });
    std::fs::write(
        config_dir.join("settings.json"),
        serde_json::to_vec_pretty(&settings).expect("serializes"),
    )
    .expect("the settings file is written");
}

// ── 7. the command's on-demand path (`force_refresh`) ──────────────────────

#[tokio::test]
async fn a_forced_refresh_re_probes_only_the_provider_the_user_asked_about() {
    // `get_provider_budget(force_refresh)` is the ONE moment a suppressed hop is
    // re-probed: the user clicked refresh, so one request is earned (and the
    // denial for THAT provider is forgotten). A second provider's suppressed
    // hops must NOT be re-opened by it — otherwise the refresh button would
    // become the denial-memory bypass the whole feature exists to prevent.
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("provider-budget-", "force");
    let denied = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"detail": "Only admin."})))
        .mount(&denied)
        .await;
    Mock::given(method("GET"))
        .and(path("/user/info"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({"detail": "Only admin."})))
        .mount(&denied)
        .await;
    let refreshed = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/user/info"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"user_id": "alice", "spend": 3.0})),
        )
        .mount(&refreshed)
        .await;
    // TWO litellm rows, one per mock server (the per-provider scoping is the
    // assertion, so the poller must hold both).
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"providers": [
            {"id": "denied-gw", "name": "D", "baseUrl": denied.uri(), "apiKey": "sk-d", "api": "litellm"},
            {"id": "fresh-gw", "name": "F", "baseUrl": refreshed.uri(), "apiKey": "sk-f", "api": "litellm"}
        ]})
        .to_string()
        .as_bytes(),
    )
    .expect("settings written");

    let poller = Arc::new(std::sync::Mutex::new(BudgetPoller::new(
        dir.path().to_path_buf(),
        dir.path().join("provider-auth.json"),
        archimedes_lib::agent::provider_auth::budget::BUDGET_POLL_INTERVAL_MILLIS,
    )));
    let client = reqwest::Client::new();

    // The loop's cadence pass: both hops are probed once, `denied-gw` enters
    // memory, and a SECOND cadence pass inside the interval stays silent.
    run_budget_tick(&poller, &client, None, true).await;
    run_budget_tick(&poller, &client, None, true).await;
    assert_eq!(count_path(&denied, "GET", "/v2/user/info").await, 1);

    // The user's refresh of the OTHER provider: it earns its own request, and
    // the suppressed provider stays suppressed (1 request, not 2).
    run_budget_tick(&poller, &client, Some("fresh-gw"), false).await;
    assert_eq!(
        count_path(&refreshed, "GET", "/v2/user/info").await,
        2,
        "the forced provider is polled regardless of the interval"
    );
    assert_eq!(
        count_path(&denied, "GET", "/v2/user/info").await,
        1,
        "and the other provider's denial still suppresses its hop"
    );

    // The forced provider's own facts landed (what the command renders).
    // The guard is scoped and the value CLONED out: a `MutexGuard` must never
    // live across a later `await` in the same body (clippy's
    // `await_holding_lock`, and the same discipline `run_budget_tick` follows).
    let forced_user = poller
        .lock()
        .expect("the ledger")
        .facts("fresh-gw")
        .and_then(|facts| facts.user.as_ref().and_then(|u| u.user_id.clone()));
    assert_eq!(
        forced_user.as_deref(),
        Some("alice"),
        "the forced poll's facts landed for the command to render"
    );

    // A `force_refresh` naming NOTHING the poller knows is a no-op, not an error
    // (the command's documented shape).
    run_budget_tick(&poller, &client, Some("no-such-provider"), false).await;
    assert_eq!(count_path(&denied, "GET", "/v2/user/info").await, 1);
    assert_eq!(count_path(&refreshed, "GET", "/v2/user/info").await, 2);
}
