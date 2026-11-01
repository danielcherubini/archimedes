//! Integration tests for the OpenAI-compatible `Provider`
//! (native-agent-harness Task 4): `complete()` against a mock HTTP server
//! (wiremock) serving canned SSE streams / canned status codes.

use archimedes_lib::agent::harness::{
    ChatMessage, ChatRole, FinishReason, MessageContent, ModelOptions, ModelRequest,
    OpenAiCompatibleProvider, Provider, ProviderError, ProviderEvent,
};
use futures_util::StreamExt;
use wiremock::matchers::{header, method};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A provider pointed at the mock server.
fn provider(base: &MockServer) -> OpenAiCompatibleProvider {
    OpenAiCompatibleProvider::new(base.uri(), "sk-test".to_string())
}

/// A minimal request (one user message, no tools).
fn request() -> ModelRequest {
    ModelRequest {
        model: "test-model".to_string(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: MessageContent::Text("hello".to_string()),
            tool_call_id: None,
            tool_calls: None,
        }],
        tools: vec![],
        options: ModelOptions {
            temperature: Some(0.5),
            max_tokens: Some(128),
            reasoning_effort: None,
            stream: true,
        },
        session_id: None,
    }
}

/// Mount a canned `text/event-stream` response on the mock server.
async fn mount_sse(server: &MockServer, body: &str) {
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(body.to_string(), "text/event-stream"),
        )
        .mount(server)
        .await;
}

/// The happy-path SSE body (one text delta + a stop).
const OK_SSE: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

/// A strict proxy that 400s on `stream_options` — ANY request carrying the
/// field is rejected (so each provider instance must learn the lesson once
/// for itself).
async fn mount_stream_options_hostile(server: &MockServer) {
    Mock::given(method("POST"))
        .and(wiremock::matchers::body_string_contains("stream_options"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_string(r#"{"error":{"message":"Unrecognized field: stream_options"}}"#),
        )
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(OK_SSE.to_string(), "text/event-stream"),
        )
        .mount(server)
        .await;
}

/// Collect the whole `complete()` stream.
async fn collect(p: &OpenAiCompatibleProvider, req: &ModelRequest) -> Vec<ProviderEvent> {
    let mut stream = p
        .complete(req)
        .await
        .expect("complete() succeeds against the mock server");
    let mut events = Vec::new();
    loop {
        // A timeout guard: a regression that stalls the stream fails the
        // test (with a partial event list) instead of hanging the suite.
        let r = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next()).await;
        match r {
            Ok(Some(event)) => events.push(event),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    events
}

// ── (a) content deltas → TextDelta in order, then Done("stop") ──────────

#[tokio::test]
async fn content_deltas_stream_in_order_then_done_stop() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let events = collect(&provider(&server), &request()).await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::TextDelta("Hel".to_string()),
            ProviderEvent::TextDelta("lo".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ],
        "content deltas in order, then Done(Stop)"
    );
}

// ── (b) tool_calls split across chunks → accumulated ToolCall, Done ─────

#[tokio::test]
async fn tool_call_fragments_accumulate_then_done_tool_calls() {
    let server = MockServer::start().await;
    // The name and arguments are split across three chunks (as the real
    // API streams them), and the `id` arrives only in the first.
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"re\"}}]}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"ad\",\"arguments\":\"{\"}}]}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"path\\\": \\\"/x\\\"}\"}}]}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let events = collect(&provider(&server), &request()).await;

    let tool_call_idx = events
        .iter()
        .position(|e| matches!(e, ProviderEvent::ToolCall(_)))
        .expect("an accumulated ToolCall event is emitted");
    let done_idx = events
        .iter()
        .position(|e| matches!(e, ProviderEvent::Done(_)))
        .expect("a Done event is emitted");
    assert!(tool_call_idx < done_idx, "the ToolCall precedes the Done");

    match &events[tool_call_idx] {
        ProviderEvent::ToolCall(tc) => {
            assert_eq!(tc.id, "call_1", "the id from the first fragment");
            assert_eq!(tc.name, "read", "name fragments accumulated");
            assert_eq!(
                tc.arguments,
                serde_json::json!({ "path": "/x" }),
                "argument fragments accumulated into valid JSON"
            );
        }
        other => panic!("expected a ToolCall, got {other:?}"),
    }
    assert_eq!(
        events[done_idx],
        ProviderEvent::Done(FinishReason::ToolCalls)
    );

    // The per-chunk deltas were also emitted (index-keyed).
    let deltas: Vec<&ProviderEvent> = events
        .iter()
        .take_while(|e| !matches!(e, ProviderEvent::ToolCall(_)))
        .filter(|e| matches!(e, ProviderEvent::ToolCallDelta(_)))
        .collect();
    assert_eq!(deltas.len(), 3, "one ToolCallDelta per chunk");
}

// ── (c) a trailing usage chunk → Usage event ─────────────────────────────

#[tokio::test]
async fn usage_chunk_emits_usage_event() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let events = collect(&provider(&server), &request()).await;
    let usage = events
        .iter()
        .find_map(|e| match e {
            // The cost is the event's SECOND element; this pin reads the
            // counts, so the carrier is bound and ignored.
            ProviderEvent::Usage(u, _cost) => Some(*u),
            _ => None,
        })
        .expect("a Usage event is emitted");
    assert_eq!(usage.input_tokens, 10);
    assert_eq!(usage.output_tokens, 5);
}

// ── (d) 429 → Retryable ──────────────────────────────────────────────────

#[tokio::test]
async fn http_429_is_retryable() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
        .mount(&server)
        .await;

    let err = match provider(&server).complete(&request()).await {
        Err(e) => e,
        Ok(_) => panic!("a 429 response is an error"),
    };
    assert!(
        matches!(err, ProviderError::Retryable(_)),
        "a 429 is retryable, got {err:?}"
    );
}

// ── (e) 401 → Auth ───────────────────────────────────────────────────────

#[tokio::test]
async fn http_401_is_auth() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
        .mount(&server)
        .await;

    let err = match provider(&server).complete(&request()).await {
        Err(e) => e,
        Ok(_) => panic!("a 401 response is an error"),
    };
    assert!(
        matches!(err, ProviderError::Auth(_)),
        "a 401 is an auth error, got {err:?}"
    );
}

// ── (f) session_id present → x-litellm-session-id & x-request-id headers ──

#[tokio::test]
async fn openai_provider_sends_session_id_headers_when_present() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(header("x-litellm-session-id", "sess-xyz-123"))
        .and(header("x-request-id", "sess-xyz-123"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n\
                 data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                 data: [DONE]\n\n",
            "text/event-stream",
        ))
        .expect(1)
        .mount(&server)
        .await;

    let mut req = request();
    req.session_id = Some("sess-xyz-123".to_string());

    let events = collect(&provider(&server), &req).await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::TextDelta("ok".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ],
    );
}

// ── (g) session_id absent → omit headers ─────────────────────────────────

#[tokio::test]
async fn openai_provider_omits_session_id_headers_when_absent() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let req = request();
    let events = collect(&provider(&server), &req).await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::TextDelta("ok".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ],
    );

    let requests = server.received_requests().await.expect("recorded requests");
    assert_eq!(requests.len(), 1);
    let sent_headers = &requests[0].headers;
    assert!(
        !sent_headers.contains_key(wiremock::http::HeaderName::from_static(
            "x-litellm-session-id"
        )),
        "x-litellm-session-id header should not be present"
    );
    assert!(
        !sent_headers.contains_key(wiremock::http::HeaderName::from_static("x-request-id")),
        "x-request-id header should not be present"
    );
}

// ── (n) the `stream_options` 400 retry-and-latch ───────────────────────

/// A strict proxy that 400s on `stream_options` must NOT break the
/// session: the FIRST call re-issues WITHOUT the field (the turn survives),
/// and the rejection LATCHES — every later call omits the field outright
/// (the fallback costs one request per provider, not one per model call).
#[tokio::test]
async fn a_400_on_stream_options_retries_without_it_and_latches() {
    let server = MockServer::start().await;
    mount_stream_options_hostile(&server).await;

    let provider = provider(&server);
    let events = collect(&provider, &request()).await;
    assert!(
        matches!(
            events.as_slice(),
            [
                ProviderEvent::TextDelta(_),
                ProviderEvent::Done(FinishReason::Stop)
            ]
        ),
        "the rejected call is re-issued without the field: {events:?}"
    );

    // A SECOND model call on the SAME provider — the latch is set, so the
    // field is never sent again (a per-call probe would double the latency
    // of every turn for the whole session).
    let events = collect(&provider, &request()).await;
    assert!(
        matches!(
            events.as_slice(),
            [
                ProviderEvent::TextDelta(_),
                ProviderEvent::Done(FinishReason::Stop)
            ]
        ),
        "the latched call succeeds: {events:?}"
    );

    let requests = server.received_requests().await.expect("recorded requests");
    let body_of = |i: usize| String::from_utf8_lossy(&requests[i].body).to_string();
    assert_eq!(requests.len(), 3, "one rejected + two served");
    assert!(
        body_of(0).contains("stream_options"),
        "the first call asks for usage"
    );
    assert!(
        !body_of(1).contains("stream_options"),
        "the retry drops the field: {}",
        body_of(1)
    );
    assert!(
        !body_of(2).contains("stream_options"),
        "the latch holds: the next call never re-sends it: {}",
        body_of(2)
    );
}

/// The 400 must be re-tried ONLY when it is ABOUT `stream_options` — a
/// different 400 (a malformed request, a bad model) is the `Fatal` it
/// always was, unretried (a blind retry would double the cost of every
/// genuine client error).
#[tokio::test]
async fn a_400_about_something_else_is_fatal_and_not_retried() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(400).set_body_string(r#"{"error":"unknown model"}"#))
        .mount(&server)
        .await;

    let err = match provider(&server).complete(&request()).await {
        Ok(_) => panic!("an unrelated 400 is an error"),
        Err(e) => e,
    };
    assert!(
        matches!(err, ProviderError::Fatal(_)),
        "an unrelated 400 stays Fatal: {err:?}"
    );
    let requests = server.received_requests().await.expect("recorded requests");
    assert_eq!(requests.len(), 1, "the unrelated 400 is NOT re-tried");
}

// ── T3b (#131): the per-model wire acceptance ──────────────────────────

use archimedes_lib::agent::harness::provider::build_provider;
use archimedes_lib::agent::harness::{Model, ToolSpec};

/// A catalog `Model` on ONE wire, pointed at the mock server (the
/// `tests/provider_headers.rs` shape).
fn wire_model(base_url: &str, api: &str) -> Model {
    Model {
        id: "m/1".to_string(),
        provider: "gw".to_string(),
        base_url: base_url.to_string(),
        api_key: "sk-test".to_string(),
        context_window: 128_000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: true,
        thinking_levels: Vec::new(),
        api: Some(api.to_string()),
    }
}

/// A request with a system prompt, one tool, and a thinking level (the shape
/// the two vendor quirks + Anthropic prompt caching are visible on).
fn rich_request(model: &str) -> ModelRequest {
    ModelRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: ChatRole::System,
                content: MessageContent::Text("you are helpful".to_string()),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: ChatRole::User,
                content: MessageContent::Text("hello".to_string()),
                tool_call_id: None,
                tool_calls: None,
            },
        ],
        tools: vec![ToolSpec {
            name: "read".to_string(),
            description: "Read a file".to_string(),
            parameters: serde_json::json!({ "type": "object" }),
        }],
        options: ModelOptions {
            temperature: None,
            max_tokens: Some(128),
            reasoning_effort: Some("high".to_string()),
            stream: true,
        },
        session_id: None,
    }
}

/// Collect a `complete()` stream generically over `Box<dyn Provider>` (the
/// local `collect` names the concrete OpenAI provider).
async fn collect_boxed(p: Box<dyn Provider>, req: &ModelRequest) -> Vec<ProviderEvent> {
    let mut stream = p.complete(req).await.expect("the completion call succeeds");
    let mut events = Vec::new();
    while let Ok(Some(e)) =
        tokio::time::timeout(std::time::Duration::from_secs(10), stream.next()).await
    {
        events.push(e);
    }
    events
}

/// Acceptance 1 (#131): a Claude model routed through LiteLLM (the derived
/// `anthropic-messages` wire) receives NATIVE thinking blocks on the stream
/// AND sends prompt caching + the `thinking` field on the request body.
#[tokio::test]
async fn claude_through_litellm_streams_native_thinking_blocks() {
    let server = MockServer::start().await;
    // The exact shapes `AnthropicStream` parses: a `thinking` block whose
    // `thinking_delta` arrives, then a `text` block, then the terminal
    // `message_delta` (`stop_reason` + usage) and `message_stop`.
    mount_sse(
        &server,
        "event: message_start\n\
         data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":7}}}\n\n\
         event: content_block_start\n\
         data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n\
         event: content_block_delta\n\
         data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"pondering\"}}\n\n\
         event: content_block_start\n\
         data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n\
         event: content_block_delta\n\
         data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}\n\n\
         event: message_delta\n\
         data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n\
         event: message_stop\n\
         data: {\"type\":\"message_stop\"}\n\n",
    )
    .await;

    let req = rich_request("claude-3-5-sonnet");
    let events = collect_boxed(
        build_provider(&wire_model(&server.uri(), "anthropic-messages")),
        &req,
    )
    .await;

    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ThinkingDelta(t) if t == "pondering")),
        "the `thinking` block streams as a native ThinkingDelta: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::TextDelta(t) if t == "answer")),
        "the text block streams as a TextDelta: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::Done(FinishReason::Stop))),
        "the `end_turn` stop reason closes the stream: {events:?}"
    );

    // The BODY assertion (acceptance 1's caching half): the request carried
    // `thinking` (the level → the Anthropic budget form) + `cache_control` on
    // the system block array and on the tool block.
    let requests = server.received_requests().await.expect("requests recorded");
    assert_eq!(requests.len(), 1);
    let body: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("a JSON request body");
    assert!(
        body.get("thinking").is_some(),
        "a thinking level reaches the Anthropic `thinking` field: {body}"
    );
    let system = body["system"]
        .as_array()
        .expect("a Claude system prompt is the cached block array");
    assert_eq!(
        system.last().expect("a system block")["cache_control"],
        serde_json::json!({ "type": "ephemeral" }),
        "the LAST system block carries the cache point"
    );
    assert_eq!(
        body["tools"][0]["cache_control"],
        serde_json::json!({ "type": "ephemeral" }),
        "the tool definition is part of the cached prefix"
    );
    // The wire's own auth + version headers are untouched by the body change.
    assert!(requests[0].headers.contains_key("x-api-key"));
    assert!(requests[0].headers.contains_key("anthropic-version"));
}

/// Acceptance 2 (#131): a `responses`-mode route (whose derived wire is
/// `openai-responses`) streams over the Responses SSE wire — `POST
/// {root}/v1/responses`, the `response.output_text.delta` events parsed, the
/// terminal `response.completed` closing the stream.
#[tokio::test]
async fn responses_mode_models_stream_via_responses_sse_wire() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(wiremock::matchers::path("/v1/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "event: response.created\n\
             data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}\n\n\
             event: response.output_text.delta\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n\
             event: response.output_text.delta\n\
             data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n\
             event: response.completed\n\
             data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n"
                .to_string(),
            "text/event-stream",
        ))
        .mount(&server)
        .await;

    // A `{root}/v1` base (the Settings' convention) → `POST /v1/responses`.
    let req = rich_request("r/1");
    let events = collect_boxed(
        build_provider(&wire_model(
            &format!("{}/v1", server.uri()),
            "openai-responses",
        )),
        &req,
    )
    .await;

    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::TextDelta(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        texts,
        vec!["Hel", "lo"],
        "the Responses deltas stream: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::Done(FinishReason::Stop))),
        "the `response.completed` terminal closes the stream: {events:?}"
    );

    let requests = server.received_requests().await.expect("requests recorded");
    assert_eq!(
        requests.len(),
        1,
        "the recorded request IS the path assertion — the matcher only answers /v1/responses"
    );
    // The Responses wire passes the level through as `reasoning.effort`
    // (never suppressed — the GPT-5.5 quirk is Chat-Completions-only).
    let body: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("a JSON request body");
    assert_eq!(body["reasoning"]["effort"], "high");
}

/// Acceptance 3 (#131 — the regression risk of the whole task): a standard
/// OpenAI-compatible completions model is BYTE-IDENTICAL — the same
/// `POST /v1/chat/completions` path, the same Bearer auth, and a body with
/// `stream_options` + `reasoning_effort` intact (the only body change in T3b
/// is the GPT-5.5-with-tools gate, which a standard model never trips).
#[tokio::test]
async fn standard_openai_completions_unchanged() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(wiremock::matchers::path("/v1/chat/completions"))
        .and(header("authorization", "Bearer sk-test"))
        .respond_with(
            ResponseTemplate::new(200).set_body_raw(OK_SSE.to_string(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let req = rich_request("gpt-4o");
    let events = collect_boxed(
        build_provider(&wire_model(
            &format!("{}/v1", server.uri()),
            "openai-completions",
        )),
        &req,
    )
    .await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProviderEvent::TextDelta(t) if t == "ok")),
        "the OpenAI stream parses as before: {events:?}"
    );

    let requests = server.received_requests().await.expect("requests recorded");
    assert_eq!(
        requests.len(),
        1,
        "a MATCHED request is the path + Bearer assertion (the mock only answers that pair)"
    );
    let body: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("a JSON request body");
    // The unchanged Chat Completions body: the usage ask, the level (a
    // standard model is NOT the GPT-5.5 quirk family), the OpenAI tool nesting.
    assert_eq!(
        body["stream_options"]["include_usage"],
        serde_json::json!(true)
    );
    assert_eq!(
        body["reasoning_effort"], "high",
        "no regression on the level"
    );
    assert_eq!(body["tools"][0]["function"]["name"], "read");
    assert!(
        !body.to_string().contains("cache_control"),
        "prompt caching is Anthropic-only: {body}"
    );
}

/// The latch is per provider INSTANCE: a fresh provider (a new session, or
/// a different provider row) asks for usage again — one hostile proxy does
/// not disable usage reporting for the whole process.
#[tokio::test]
async fn the_stream_options_latch_is_per_provider_instance() {
    let server = MockServer::start().await;
    mount_stream_options_hostile(&server).await;

    let first = provider(&server);
    collect(&first, &request()).await;
    let second = provider(&server);
    collect(&second, &request()).await;

    let requests = server.received_requests().await.expect("recorded requests");
    let asks = |i: usize| String::from_utf8_lossy(&requests[i].body).contains("stream_options");
    assert_eq!(requests.len(), 4, "two latched sequences");
    assert!(asks(0) && !asks(1), "the first provider latches");
    assert!(asks(2) && !asks(3), "the second provider asks again");
}
