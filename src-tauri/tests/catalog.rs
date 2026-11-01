//! `ModelCatalog` (native-agent-harness Task 5, ADR 0014): the desktop is
//! native-only — the catalog is the Settings' providers list + live
//! discovery (no pi config seeding; that path was removed, ADR 0022).

use archimedes_lib::agent::harness::{CompactionConfig, Model, ModelCatalog};

fn model(id: &str, provider: &str, api: Option<&str>) -> Model {
    Model {
        id: id.to_string(),
        provider: provider.to_string(),
        base_url: format!("http://fake-{provider}/v1"),
        api_key: "k".to_string(),
        context_window: 100_000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: api.map(|s| s.to_string()),
    }
}

#[test]
fn selectable_filters_to_the_three_wires_subset() {
    let catalog = ModelCatalog {
        models: vec![
            model("Qwen/Qwen3.8-27B", "tama", Some("openai-completions")),
            model(
                "moonshotai/kimi-k3",
                "openrouter",
                Some("openai-completions"),
            ),
            model("gemini-2.5-flash", "google", Some("google-generative-ai")),
            model("lit/1", "llm", Some("litellm")),
            model("Unknown-Model", "tama", None),
        ],
        default_model: Some("Qwen/Qwen3.8-27B".to_string()),
        compaction: CompactionConfig::default(),
    };

    let selectable = catalog.selectable();
    let ids: Vec<&str> = selectable.iter().map(|m| m.id.as_str()).collect();
    // The two `api: "openai-completions"` models + the `api: "litellm"`
    // discovery-mode model (ADR 0026 — its wire is `openai-completions`) —
    // NOT the `google-generative-ai` model, NOT the metadata-less default
    // model (an unknown `api` is not one of the three wires the harness
    // speaks + the `litellm` discovery mode).
    assert_eq!(selectable.len(), 3);
    assert!(ids.contains(&"Qwen/Qwen3.8-27B"));
    assert!(ids.contains(&"moonshotai/kimi-k3"));
    assert!(ids.contains(&"lit/1"));
    assert!(!ids.contains(&"gemini-2.5-flash"));
    assert!(!ids.contains(&"Unknown-Model"));
}

// ── the LiteLLM discovery ladder + grouping (T3a / #130, ADR 0026 amendment) ──
//
// Through the PUBLIC `discover_models` seam (the caller's own entry point),
// against a path-aware mock server (wiremock — the repo's convention,
// `tests/provider.rs`). These assert at the `DiscoveredMeta` level: the terminal
// consumer that fans the reduction's truth onto `Model` is T3b's
// `EffectiveCatalog::resolve` write (interface §10 R5) and is asserted THERE, not
// here — this file claims NOTHING about a `Model`-level effect.

use archimedes_lib::agent::harness::discover_models;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Mount a per-path canned response (path matcher + status + body).
async fn mount_json(server: &MockServer, request_path: &str, status: u16, body: &str) {
    Mock::given(method("GET"))
        .and(path(request_path))
        .respond_with(
            ResponseTemplate::new(status).set_body_raw(body.to_string(), "application/json"),
        )
        .mount(server)
        .await;
}

#[tokio::test]
async fn non_admin_key_without_model_info_access_discovers_via_v1_models() {
    // Acceptance 1: a `litellm` provider whose `GET /model/info` answers 403
    // discovers its models via `GET /v1/models`.
    let server = MockServer::start().await;
    mount_json(&server, "/model/info", 403, r#"{"error":"forbidden"}"#).await;
    mount_json(
        &server,
        "/v1/models",
        200,
        r#"{"data":[{"id":"gpt-5.5","max_model_len":400000}]}"#,
    )
    .await;
    let models = discover_models(&server.uri(), "sk-key", "litellm", None)
        .await
        .expect("the /v1/models rung answers for a non-admin key");
    let meta = &models["gpt-5.5"];
    assert_eq!(meta.context_window, Some(400000));
    let requests = server.received_requests().await.unwrap();
    let paths: Vec<&str> = requests.iter().map(|r| r.url.path()).collect();
    assert_eq!(paths, vec!["/model/info", "/v1/models"]);
    for r in &requests {
        let auth = r
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(auth, "Bearer sk-key", "the Bearer header rides every rung");
    }
}

#[tokio::test]
async fn multi_deployment_route_never_overestimates_context_window() {
    // Acceptance 2: `min` over the route's deployments — grouping never last-wins.
    let server = MockServer::start().await;
    mount_json(
        &server,
        "/model/info",
        200,
        r#"{"data":[
            {"model_name":"shared","model_info":{"id":"d-a","max_input_tokens":128000}},
            {"model_name":"shared","model_info":{"id":"d-b","max_input_tokens":64000}}
        ]}"#,
    )
    .await;
    let models = discover_models(&server.uri(), "k", "litellm", None)
        .await
        .unwrap();
    assert_eq!(models.len(), 1, "ONE reduced route per model_name");
    assert_eq!(models["shared"].context_window, Some(64000));
}

#[tokio::test]
async fn wildcard_routes_expand_into_selectable_options() {
    // Acceptance 3: route-advertised ids (`anthropic/*`) that no `model_name`
    // route carries become individually selectable via `/v1/models`, keeping
    // their provider-qualified form (the picker's `provider/model` keying).
    let server = MockServer::start().await;
    mount_json(&server, "/model/info", 403, r#"{"error":"forbidden"}"#).await;
    mount_json(
        &server,
        "/v1/models",
        200,
        r#"{"data":[
            {"id":"anthropic/claude-3-7-sonnet","max_model_len":200000},
            {"id":"anthropic/claude-opus-4"},
            {"id":"gpt-5.5","max_model_len":400000}
        ]}"#,
    )
    .await;
    let models = discover_models(&server.uri(), "k", "litellm", None)
        .await
        .unwrap();
    let mut keys: Vec<&str> = models.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "anthropic/claude-3-7-sonnet",
            "anthropic/claude-opus-4",
            "gpt-5.5"
        ]
    );
    assert_eq!(
        models["anthropic/claude-3-7-sonnet"].context_window,
        Some(200000)
    );
    // A `/v1/models` entry carries none of the reduction's truth (the OpenAI
    // shape advertises none of it — the documented v1 degradation).
    for meta in models.values() {
        assert_eq!(meta.supports_tools, None);
        assert_eq!(meta.cost_per_mtok_in, None);
        assert_eq!(meta.cost_per_mtok_out, None);
    }
}

#[tokio::test]
async fn ladder_chain_with_no_answer_is_an_error() {
    // Acceptance 6: every rung (including `/health`) fails → `Err`, i.e.
    // `succeeded = false` and a retry on the next read (ADR 0076 rule 3 —
    // `ProviderDiscovery.succeeded` itself is UNTOUCHED by this task).
    let server = MockServer::start().await;
    mount_json(&server, "/model/info", 404, r#"{"detail":"Not Found"}"#).await;
    mount_json(&server, "/v1/models", 404, r#"{"detail":"Not Found"}"#).await;
    mount_json(&server, "/v1/model/info", 404, r#"{"detail":"Not Found"}"#).await;
    mount_json(&server, "/health", 503, r#"{"error":"down"}"#).await;
    assert!(discover_models(&server.uri(), "k", "litellm", None)
        .await
        .is_err());
}

#[tokio::test]
async fn reduction_lands_costs_and_tools_truth_on_discovered_meta() {
    // Acceptance 5 + 9: the reduction's conservative truth rides the four
    // additive `DiscoveredMeta` fields (interface §10 R5) — the ALL-deployments
    // tools gate and the `max` cost. T3b's resolve write is the terminal
    // consumer that fans these onto `Model`; nothing here asserts that.
    let server = MockServer::start().await;
    mount_json(
        &server,
        "/model/info",
        200,
        r#"{"data":[
            {"model_name":"r/1","model_info":{
                "id":"d-a","supports_function_calling":true,
                "input_cost_per_token":0.0000025}},
            {"model_name":"r/1","model_info":{
                "id":"d-b","supports_function_calling":false,
                "output_cost_per_token":0.000006}}
        ]}"#,
    )
    .await;
    let models = discover_models(&server.uri(), "k", "litellm", None)
        .await
        .unwrap();
    let meta = &models["r/1"];
    // ONE deployment lacking tools hides tools for the whole route.
    assert_eq!(meta.supports_tools, Some(false));
    // `max` over the deployments: 0.000006 USD/token × 1e6 = 6.0 per 1M.
    assert_eq!(meta.cost_per_mtok_out, Some(6.0));
    assert_eq!(meta.cost_per_mtok_in, Some(2.5));
}

#[tokio::test]
async fn rung_four_probes_the_deployment_id_after_the_liveness_gate() {
    // Rung 4: rungs 1–3 yield no selectable route but mention a deployment id →
    // `/health` gates the ladder and the `?litellm_model_id=` probe answers.
    let server = MockServer::start().await;
    // Mounted first: `path` ignores the query and first-registered wins.
    Mock::given(method("GET"))
        .and(path("/model/info"))
        .and(query_param("litellm_model_id", "dep-9"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            r#"{"data":[{"model_name":"probed/model","model_info":{"max_input_tokens":9000}}]}"#,
            "application/json",
        ))
        .mount(&server)
        .await;
    mount_json(
        &server,
        "/model/info",
        200,
        r#"{"data":[{"model_name":"","model_info":{"litellm_model_id":"dep-9"}}]}"#,
    )
    .await;
    mount_json(&server, "/v1/models", 200, r#"{"data":[]}"#).await;
    mount_json(&server, "/v1/model/info", 404, r#"{"detail":"Not Found"}"#).await;
    mount_json(&server, "/health", 200, r#"{"status":"healthy"}"#).await;
    let models = discover_models(&server.uri(), "k", "litellm", None)
        .await
        .expect("a live proxy + one answered probe is a success");
    assert_eq!(models["probed/model"].context_window, Some(9000));
}
