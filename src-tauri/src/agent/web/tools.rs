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

pub async fn exec_fetch_content(ctx: &ToolCtx, params: &Value) -> ToolResult {
    let url = match params.get("url").and_then(Value::as_str) {
        Some(u) if !u.trim().is_empty() => u.trim(),
        _ => {
            let err_msg = "fetch_content: missing `url` parameter".to_string();
            return ToolResult {
                content: vec![ContentBlock::Text {
                    text: err_msg.clone(),
                }],
                details: Some(json!({ "error": err_msg })),
                is_error: true,
            };
        }
    };

    let mode_str = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("readable");

    let mode = match mode_str {
        "readable" => crate::agent::web::extract::Mode::Readable,
        "raw" => crate::agent::web::extract::Mode::Raw,
        other => {
            let err_msg = format!(
                "fetch_content: unknown mode `{}` (expected \"readable\" or \"raw\")",
                other
            );
            return ToolResult {
                content: vec![ContentBlock::Text {
                    text: err_msg.clone(),
                }],
                details: Some(json!({ "error": err_msg })),
                is_error: true,
            };
        }
    };

    let max_chars = params
        .get("max_chars")
        .or_else(|| params.get("maxChars"))
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(200, 200_000))
        .unwrap_or(20_000);

    match crate::agent::web::extract::extract(url, mode, ctx).await {
        Ok(doc) => {
            let response_id = global_cache().store(
                StoredKind::Fetch,
                doc.markdown.clone(),
                json!({
                    "url": doc.url,
                    "title": doc.title,
                    "wordCount": doc.word_count,
                    "status": doc.status,
                    "extractor": doc.extractor,
                }),
            );

            let doc_len = doc.markdown.chars().count();
            let (head_text, truncated) = if doc_len > max_chars {
                let head: String = doc.markdown.chars().take(max_chars).collect();
                let remaining = doc_len.saturating_sub(max_chars);
                let suffix = format!(
                    "\n\n…[{} chars truncated — get_search_content with responseId {} for the rest]",
                    remaining, response_id
                );
                (format!("{}{}", head, suffix), true)
            } else {
                (doc.markdown.clone(), false)
            };

            ToolResult {
                content: vec![ContentBlock::Text { text: head_text }],
                details: Some(json!({
                    "responseId": response_id,
                    "url": doc.url,
                    "title": doc.title,
                    "wordCount": doc.word_count,
                    "status": doc.status,
                    "extractor": doc.extractor,
                    "truncated": truncated,
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

pub async fn exec_get_search_content(_ctx: &ToolCtx, params: &Value) -> ToolResult {
    let response_id = match params
        .get("response_id")
        .or_else(|| params.get("responseId"))
        .and_then(Value::as_str)
    {
        Some(id) if !id.trim().is_empty() => id.trim(),
        _ => {
            let err_msg = "get_search_content: missing `response_id` parameter".to_string();
            return ToolResult {
                content: vec![ContentBlock::Text {
                    text: err_msg.clone(),
                }],
                details: Some(json!({ "error": err_msg })),
                is_error: true,
            };
        }
    };

    let item = match global_cache().get(response_id) {
        Some(it) => it,
        None => {
            return ToolResult {
                content: vec![ContentBlock::Text {
                    text: "Response not found".into(),
                }],
                details: None,
                is_error: true,
            };
        }
    };

    let find_text = params
        .get("find_text")
        .or_else(|| params.get("findText"))
        .and_then(Value::as_str)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    if let Some(needle) = find_text {
        let content = &item.content;
        let content_lower = content.to_lowercase();
        let needle_lower = needle.to_lowercase();

        let mut matches = Vec::new();
        let mut start_idx = 0;

        while let Some(pos) = content_lower[start_idx..].find(&needle_lower) {
            let match_idx = start_idx + pos;
            let window_start = match_idx.saturating_sub(200);
            let window_end = (match_idx + needle.len() + 200).min(content.len());

            // Safely slice on char boundaries
            let safe_start = floor_char_boundary(content, window_start);
            let safe_end = ceil_char_boundary(content, window_end);
            let safe_match_end = ceil_char_boundary(content, match_idx + needle.len());

            let passage = &content[safe_start..safe_end];
            let match_str = &content[match_idx..safe_match_end];

            matches.push(json!({
                "passage": passage,
                "offset": match_idx,
                "match": match_str,
            }));

            if matches.len() >= 20 {
                break;
            }
            start_idx = match_idx + needle.len();
            if start_idx >= content.len() {
                break;
            }
        }

        if matches.is_empty() {
            let text = format!("get_search_content: no match for \"{}\"", needle);
            return ToolResult {
                content: vec![ContentBlock::Text { text }],
                details: Some(json!({
                    "responseId": response_id,
                    "matches": []
                })),
                is_error: false,
            };
        }

        let lines: Vec<String> = matches.iter().map(|m| m.to_string()).collect();
        return ToolResult {
            content: vec![ContentBlock::Text {
                text: lines.join("\n"),
            }],
            details: Some(json!({
                "responseId": response_id,
                "matches": matches
            })),
            is_error: false,
        };
    }

    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;

    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).min(20_000))
        .unwrap_or(20_000);

    let content_chars: Vec<char> = item.content.chars().collect();
    let total_chars = content_chars.len();

    let sliced = if offset >= total_chars {
        String::new()
    } else {
        let end = (offset + limit).min(total_chars);
        content_chars[offset..end].iter().collect::<String>()
    };

    ToolResult {
        content: vec![ContentBlock::Text { text: sliced }],
        details: Some(json!({ "responseId": response_id })),
        is_error: false,
    }
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
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

    #[tokio::test]
    async fn test_exec_fetch_content_missing_url() {
        let ctx = test_ctx();
        let res = exec_fetch_content(&ctx, &json!({})).await;
        assert!(res.is_error);
        match &res.content[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text, "fetch_content: missing `url` parameter");
            }
            _ => panic!("expected text block"),
        }
    }

    #[tokio::test]
    async fn test_exec_fetch_content_unknown_mode() {
        let ctx = test_ctx();
        let res = exec_fetch_content(
            &ctx,
            &json!({
                "url": "https://example.com",
                "mode": "invalid_mode"
            }),
        )
        .await;
        assert!(res.is_error);
        match &res.content[0] {
            ContentBlock::Text { text } => {
                assert_eq!(
                    text,
                    "fetch_content: unknown mode `invalid_mode` (expected \"readable\" or \"raw\")"
                );
            }
            _ => panic!("expected text block"),
        }
    }

    #[tokio::test]
    async fn test_exec_fetch_content_head_truncation_and_get_search_content() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        // Construct article body > 500 chars
        let long_para = "A".repeat(800);
        let html = format!(
            "<html><head><title>Long Document</title></head><body><article><p>{}</p></article></body></html>",
            long_para
        );

        Mock::given(method("GET"))
            .and(path("/long"))
            .respond_with(ResponseTemplate::new(200).set_body_string(html))
            .mount(&server)
            .await;

        let ctx = test_ctx();
        let url = format!("{}/long", server.uri());
        // max_chars clamped to min 200
        let res = exec_fetch_content(
            &ctx,
            &json!({
                "url": url,
                "max_chars": 200
            }),
        )
        .await;

        assert!(
            !res.is_error,
            "fetch_content should succeed: {:?}",
            res.content
        );
        let details = res.details.expect("details should exist");
        let response_id = details["responseId"]
            .as_str()
            .expect("responseId")
            .to_string();
        assert_eq!(details["title"], "Long Document");

        let text = match &res.content[0] {
            ContentBlock::Text { text } => text.clone(),
            _ => panic!("expected text block"),
        };
        assert!(text.contains("chars truncated — get_search_content with responseId"));

        // Now test get_search_content slice
        let get_res = exec_get_search_content(
            &ctx,
            &json!({
                "response_id": response_id,
                "offset": 0,
                "limit": 50
            }),
        )
        .await;
        assert!(!get_res.is_error);
        match &get_res.content[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text.len(), 50);
            }
            _ => panic!("expected text block"),
        }

        // Test get_search_content find_text hit
        let find_res = exec_get_search_content(
            &ctx,
            &json!({
                "response_id": response_id,
                "find_text": "AAAA"
            }),
        )
        .await;
        assert!(!find_res.is_error);
        match &find_res.content[0] {
            ContentBlock::Text { text } => {
                assert!(text.contains("\"match\":\"AAAA\""));
            }
            _ => panic!("expected text block"),
        }

        // Test get_search_content find_text no match is success
        let no_match_res = exec_get_search_content(
            &ctx,
            &json!({
                "response_id": response_id,
                "find_text": "nonexistent_phrase_xyz"
            }),
        )
        .await;
        assert!(!no_match_res.is_error);
        match &no_match_res.content[0] {
            ContentBlock::Text { text } => {
                assert_eq!(
                    text,
                    "get_search_content: no match for \"nonexistent_phrase_xyz\""
                );
            }
            _ => panic!("expected text block"),
        }
    }

    #[tokio::test]
    async fn test_exec_get_search_content_missing_id_and_not_found() {
        let ctx = test_ctx();
        let missing = exec_get_search_content(&ctx, &json!({})).await;
        assert!(missing.is_error);
        match &missing.content[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text, "get_search_content: missing `response_id` parameter");
            }
            _ => panic!("expected text block"),
        }

        let not_found = exec_get_search_content(
            &ctx,
            &json!({
                "response_id": "nonexistent_id_12345"
            }),
        )
        .await;
        assert!(not_found.is_error);
        match &not_found.content[0] {
            ContentBlock::Text { text } => {
                assert_eq!(text, "Response not found");
            }
            _ => panic!("expected text block"),
        }
    }
}
