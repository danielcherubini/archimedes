use serde_json::{json, Value};

use crate::agent::tools::exec::{ContentBlock, ToolCtx, ToolResult};
use crate::agent::web::cache::{global_cache, StoredKind};
use crate::agent::web::providers::registry::execute_search;
use crate::agent::web::providers::types::SearchOpts;

pub async fn exec_web_search(ctx: &ToolCtx, params: &Value) -> ToolResult {
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

    match execute_search(&queries, &opts, &ctx.web, &ctx.cancel).await {
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
