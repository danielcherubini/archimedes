use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent::tools::exec::{ContentBlock, ToolCtx, ToolResult};
use crate::agent::web::cache::{global_cache, StoredKind};
use crate::agent::web::providers::registry::{all_providers, execute_search_with_providers};
use crate::agent::web::providers::types::{SearchOpts, SearchProvider};

pub async fn exec_web_search(ctx: &ToolCtx, params: &Value) -> ToolResult {
    exec_web_search_with_providers(ctx, params, &all_providers()).await
}

pub async fn exec_web_search_with_providers(
    ctx: &ToolCtx,
    params: &Value,
    providers: &[Arc<dyn SearchProvider>],
) -> ToolResult {
    let mut queries = Vec::new();
    if let Some(arr) = params.get("queries").and_then(Value::as_array) {
        for val in arr {
            if let Some(s) = val.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    queries.push(trimmed.to_string());
                }
            }
        }
    }

    if queries.is_empty() {
        if let Some(s) = params.get("query").and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                queries.push(trimmed.to_string());
            }
        }
    }

    if queries.is_empty() {
        let err_msg = "web_search requires 'query' or 'queries'".to_string();
        return ToolResult {
            content: vec![ContentBlock::Text {
                text: err_msg.clone(),
            }],
            details: Some(json!({ "error": err_msg })),
            is_error: true,
        };
    }

    let num_results = params
        .get("num_results")
        .or_else(|| params.get("numResults"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, 20))
        .unwrap_or(5);

    let provider = params
        .get("provider")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let recency_filter = params
        .get("recency_filter")
        .or_else(|| params.get("recencyFilter"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let mut domain_filter = Vec::new();
    if let Some(arr) = params
        .get("domain_filter")
        .or_else(|| params.get("domainFilter"))
        .and_then(Value::as_array)
    {
        for val in arr {
            if let Some(s) = val.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    domain_filter.push(trimmed.to_string());
                }
            }
        }
    }

    let proxy = params
        .get("proxy")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| ctx.web.proxy.clone());

    let opts = SearchOpts {
        num_results,
        recency_filter,
        domain_filter,
        proxy,
        provider,
    };

    match execute_search_with_providers(providers, &queries, &opts, &ctx.web, &ctx.cancel).await {
        Ok(outcome) => {
            let summary = outcome
                .results
                .iter()
                .map(|r| format!("[{}]({})", r.title, r.url))
                .collect::<Vec<_>>()
                .join("\n");

            let response_id = global_cache().store(
                StoredKind::Search,
                summary.clone(),
                json!({
                    "provider": &outcome.provider,
                    "results": &outcome.results,
                }),
            );

            ToolResult {
                content: vec![ContentBlock::Text { text: summary }],
                details: Some(json!({
                    "responseId": response_id,
                    "provider": outcome.provider,
                    "resultCount": outcome.results.len(),
                    "results": outcome.results,
                })),
                is_error: false,
            }
        }
        Err(err) => ToolResult {
            content: vec![ContentBlock::Text { text: err.clone() }],
            details: Some(json!({ "error": err })),
            is_error: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;

    fn test_ctx() -> ToolCtx {
        ToolCtx {
            cwd: PathBuf::from("/tmp"),
            cancel: CancellationToken::new(),
            skill_roots: None,
            boundary: vec![PathBuf::from("/tmp")],
            file_policy: crate::agent::policy::FilePolicy {
                reads: crate::agent::policy::AccessPolicy::Sandboxed,
                writes: crate::agent::policy::AccessPolicy::Sandboxed,
                shell: crate::agent::policy::AccessPolicy::Allow,
            },
            protected: vec![],
            web: crate::agent::web::config::WebConfig::default(),
        }
    }

    #[tokio::test]
    async fn test_exec_web_search_missing_query() {
        let ctx = test_ctx();
        let res = exec_web_search(&ctx, &json!({})).await;
        assert!(res.is_error);
        match &res.content[0] {
            ContentBlock::Text { text } => {
                assert!(text.contains("web_search requires 'query' or 'queries'"));
            }
            _ => panic!("expected text block"),
        }
    }

    #[tokio::test]
    async fn test_exec_web_search_failover_to_duckduckgo_wiremock() {
        use crate::agent::web::providers::brave::BraveProvider;
        use crate::agent::web::providers::duckduckgo::DuckDuckGoProvider;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let brave_server = MockServer::start().await;
        let ddg_server = MockServer::start().await;

        // Brave fails with 429
        Mock::given(method("GET"))
            .and(path("/res/v1/web/search"))
            .respond_with(ResponseTemplate::new(429).set_body_string("Rate limited"))
            .mount(&brave_server)
            .await;

        // DuckDuckGo succeeds with HTML fixture
        let ddg_fixture = include_str!("fixtures/duckduckgo_results.html");
        Mock::given(method("GET"))
            .and(path("/html/"))
            .respond_with(ResponseTemplate::new(200).set_body_string(ddg_fixture))
            .mount(&ddg_server)
            .await;

        let providers: Vec<Arc<dyn SearchProvider>> = vec![
            Arc::new(BraveProvider::with_base_url(format!(
                "{}/res/v1/web/search",
                brave_server.uri()
            ))),
            Arc::new(DuckDuckGoProvider::with_base_url(format!(
                "{}/html/",
                ddg_server.uri()
            ))),
        ];

        let mut ctx = test_ctx();
        ctx.web.brave_api_key = Some("test-brave-key".into());
        ctx.web.default_provider = "auto".into();

        let res = exec_web_search_with_providers(
            &ctx,
            &json!({ "query": "rust programming" }),
            &providers,
        )
        .await;

        assert!(
            !res.is_error,
            "expected success via failover, got error: {:?}",
            res.content
        );
        let details = res.details.expect("details should exist");
        assert_eq!(details["provider"], "duckduckgo");
        assert_eq!(details["resultCount"], 3);
    }

    #[tokio::test]
    async fn test_exec_web_search_explicit_provider_no_failover_wiremock() {
        use crate::agent::web::providers::brave::BraveProvider;
        use crate::agent::web::providers::duckduckgo::DuckDuckGoProvider;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let brave_server = MockServer::start().await;
        let ddg_server = MockServer::start().await;

        // Brave fails with 429
        Mock::given(method("GET"))
            .and(path("/res/v1/web/search"))
            .respond_with(ResponseTemplate::new(429).set_body_string("Rate limited"))
            .mount(&brave_server)
            .await;

        // DuckDuckGo must NEVER be called
        Mock::given(method("GET"))
            .and(path("/html/"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&ddg_server)
            .await;

        let providers: Vec<Arc<dyn SearchProvider>> = vec![
            Arc::new(BraveProvider::with_base_url(format!(
                "{}/res/v1/web/search",
                brave_server.uri()
            ))),
            Arc::new(DuckDuckGoProvider::with_base_url(format!(
                "{}/html/",
                ddg_server.uri()
            ))),
        ];

        let mut ctx = test_ctx();
        ctx.web.brave_api_key = Some("test-brave-key".into());

        let res = exec_web_search_with_providers(
            &ctx,
            &json!({
                "query": "rust programming",
                "provider": "brave"
            }),
            &providers,
        )
        .await;

        assert!(res.is_error, "expected explicit brave error");
        match &res.content[0] {
            ContentBlock::Text { text } => {
                assert!(text.contains("[brave] error: HTTP 429"), "got: {text}");
            }
            _ => panic!("expected text block"),
        }
    }

    #[tokio::test]
    async fn test_exec_web_search_with_unknown_provider() {
        let ctx = test_ctx();
        let res = exec_web_search(
            &ctx,
            &json!({
                "query": "rust",
                "provider": "unknown_search_engine"
            }),
        )
        .await;

        assert!(res.is_error);
        match &res.content[0] {
            ContentBlock::Text { text } => {
                assert!(text.contains("Unknown provider: unknown_search_engine"));
            }
            _ => panic!("expected text block"),
        }
    }
}
