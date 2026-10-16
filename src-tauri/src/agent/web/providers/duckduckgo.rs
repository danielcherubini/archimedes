use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::agent::web::config::WebConfig;
use crate::agent::web::net::{safe_fetch, FetchOpts};
use crate::agent::web::providers::types::{SearchOpts, SearchProvider, SearchResultItem};

const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
const DEFAULT_DDG_URL: &str = "https://html.duckduckgo.com/html/?q=";

pub struct DuckDuckGoProvider {
    pub base_url: Option<String>,
}

impl Default for DuckDuckGoProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl DuckDuckGoProvider {
    pub fn new() -> Self {
        Self { base_url: None }
    }

    pub fn with_base_url(base_url: String) -> Self {
        Self {
            base_url: Some(base_url),
        }
    }
}

fn extract_target_url(raw_href: &str) -> Option<String> {
    let mut url_str = raw_href.to_string();
    if let Some(query_part) = url_str.split('?').nth(1) {
        for (key, val) in url::form_urlencoded::parse(query_part.as_bytes()) {
            if key == "uddg" {
                url_str = val.into_owned();
                break;
            }
        }
    }

    if url_str.starts_with("//") {
        url_str = format!("https:{url_str}");
    }

    if Url::parse(&url_str).is_ok() {
        Some(url_str)
    } else {
        None
    }
}

pub fn parse_ddg_html(html: &str) -> Vec<SearchResultItem> {
    let doc = dom_query::Document::fragment(html);
    let mut results = Vec::new();

    let elements = {
        let res = doc.select(".result");
        if res.length() > 0 {
            res
        } else {
            let web_res = doc.select(".web-result");
            if web_res.length() > 0 {
                web_res
            } else {
                doc.select(".result__body")
            }
        }
    };

    for el in elements.iter() {
        let a = {
            let a_el = el.select("a.result__a");
            if a_el.length() > 0 {
                a_el
            } else {
                let title_a = el.select(".result__title a");
                if title_a.length() > 0 {
                    title_a
                } else {
                    let h2_a = el.select("h2 a");
                    if h2_a.length() > 0 {
                        h2_a
                    } else {
                        el.select("a.result-link")
                    }
                }
            }
        };

        if a.length() == 0 {
            continue;
        }

        let snippet_el = {
            let s = el.select(".result__snippet");
            if s.length() > 0 {
                s
            } else {
                let b = el.select(".result__body");
                if b.length() > 0 {
                    b
                } else {
                    el.select(".result-snippet")
                }
            }
        };

        if snippet_el.length() == 0 {
            continue;
        }

        let raw_href = a.attr("href").map(|s| s.to_string()).unwrap_or_default();
        let Some(url_str) = extract_target_url(&raw_href) else {
            continue;
        };

        let title = a.text().trim().to_string();
        let snippet = snippet_el.text().trim().to_string();

        if !title.is_empty() {
            results.push(SearchResultItem {
                title,
                url: url_str,
                snippet,
                published_date: None,
            });
        }
    }

    // Fallback: If no results found, check for Lite table format (a.result-link and .result-snippet)
    if results.is_empty() {
        let links = doc.select("a.result-link");
        let snippets = doc.select(".result-snippet");
        for (i, link) in links.iter().enumerate() {
            let raw_href = link.attr("href").map(|s| s.to_string()).unwrap_or_default();
            let Some(url_str) = extract_target_url(&raw_href) else {
                continue;
            };

            let title = link.text().trim().to_string();
            let snippet = if i < snippets.length() {
                snippets.get(i).unwrap().text().trim().to_string()
            } else {
                String::new()
            };

            if !title.is_empty() {
                results.push(SearchResultItem {
                    title,
                    url: url_str,
                    snippet,
                    published_date: None,
                });
            }
        }
    }

    results
}

#[async_trait]
impl SearchProvider for DuckDuckGoProvider {
    fn id(&self) -> &'static str {
        "duckduckgo"
    }

    fn name(&self) -> &'static str {
        "DuckDuckGo"
    }

    fn is_available(&self, _config: &WebConfig) -> bool {
        true
    }

    async fn search(
        &self,
        query: &str,
        opts: &SearchOpts,
        cfg: &WebConfig,
        cancel: &CancellationToken,
    ) -> Result<Vec<SearchResultItem>, String> {
        let encoded_query =
            url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
        let target_url = match &self.base_url {
            Some(base) if base.ends_with('?') || base.ends_with('=') => {
                format!("{base}{encoded_query}")
            }
            Some(base) if base.contains('?') => format!("{base}&q={encoded_query}"),
            Some(base) => format!("{base}?q={encoded_query}"),
            None => format!("{DEFAULT_DDG_URL}{encoded_query}"),
        };

        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static(
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ),
        );
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));

        let fetch_opts = FetchOpts {
            method: reqwest::Method::GET,
            headers,
            body: None,
            proxy: opts
                .proxy
                .as_deref()
                .or(cfg.proxy.as_deref())
                .map(|s| s.to_string()),
        };

        let outcome = safe_fetch(&target_url, &fetch_opts, cancel)
            .await
            .map_err(|e| format!("[duckduckgo] error: {e}"))?;

        if outcome.status != 200 {
            return Err(format!("[duckduckgo] error: HTTP {}", outcome.status));
        }

        let html = String::from_utf8_lossy(&outcome.body);
        if html.contains("anomaly-modal") || html.contains("bots use DuckDuckGo too") {
            return Err(
                "[duckduckgo] error: bot detection or rate limit challenge (anomaly challenge)"
                    .to_string(),
            );
        }

        let mut results = parse_ddg_html(&html);
        if opts.num_results > 0 && results.len() > opts.num_results {
            results.truncate(opts.num_results);
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn test_parse_ddg_html_fixture() {
        let fixture = include_str!("../fixtures/duckduckgo_results.html");
        let results = parse_ddg_html(fixture);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://www.rust-lang.org/");
        assert!(results[0]
            .snippet
            .contains("A language empowering everyone"));

        assert_eq!(results[1].title, "crates.io: Rust Package Registry");
        assert_eq!(results[1].url, "https://crates.io/");

        assert_eq!(results[2].title, "Docs.rs");
        assert_eq!(results[2].url, "https://docs.rs/");
    }

    #[tokio::test]
    async fn test_ddg_provider_search_wiremock() {
        let fixture = include_str!("../fixtures/duckduckgo_results.html");
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/html/"))
            .and(query_param("q", "rust programming"))
            .respond_with(ResponseTemplate::new(200).set_body_string(fixture))
            .mount(&server)
            .await;

        let provider = DuckDuckGoProvider::with_base_url(format!("{}/html/", server.uri()));
        let cancel = CancellationToken::new();
        let config = WebConfig::default();
        let opts = SearchOpts {
            num_results: 2,
            ..Default::default()
        };

        let results = provider
            .search("rust programming", &opts, &config, &cancel)
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[1].title, "crates.io: Rust Package Registry");
    }

    #[tokio::test]
    async fn test_ddg_provider_search_fallback_proxy() {
        let server = MockServer::start().await;
        let provider = DuckDuckGoProvider::with_base_url(format!("{}/html/", server.uri()));
        let cancel = CancellationToken::new();
        let config = WebConfig {
            proxy: Some("http://10.0.0.1:8080".into()),
            ..Default::default()
        };
        let opts = SearchOpts::default();

        let err = provider
            .search("rust programming", &opts, &config, &cancel)
            .await
            .unwrap_err();
        assert!(err.contains("blocked IP"));
    }

    #[tokio::test]
    async fn test_ddg_provider_search_anomaly_202_returns_error() {
        let server = MockServer::start().await;

        let anomaly_html = r#"<!DOCTYPE html>
<html>
<head><title>DuckDuckGo</title></head>
<body>
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js"></form>
</body>
</html>"#;

        Mock::given(method("GET"))
            .and(path("/html/"))
            .and(query_param("q", "rust programming"))
            .respond_with(ResponseTemplate::new(202).set_body_string(anomaly_html))
            .mount(&server)
            .await;

        let provider = DuckDuckGoProvider::with_base_url(format!("{}/html/", server.uri()));
        let cancel = CancellationToken::new();
        let config = WebConfig::default();
        let opts = SearchOpts::default();

        let err = provider
            .search("rust programming", &opts, &config, &cancel)
            .await
            .unwrap_err();
        assert!(
            err.contains("202") || err.contains("bot detection") || err.contains("anomaly"),
            "Expected error about bot detection or 202, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_ddg_provider_search_sends_browser_headers() {
        let fixture = include_str!("../fixtures/duckduckgo_results.html");
        let server = MockServer::start().await;

        Mock::given(method("GET"))
            .and(path("/html/"))
            .and(query_param("q", "rust programming"))
            .respond_with(ResponseTemplate::new(200).set_body_string(fixture))
            .mount(&server)
            .await;

        let provider = DuckDuckGoProvider::with_base_url(format!("{}/html/", server.uri()));
        let cancel = CancellationToken::new();
        let config = WebConfig::default();
        let opts = SearchOpts {
            num_results: 1,
            ..Default::default()
        };

        let results = provider
            .search("rust programming", &opts, &config, &cancel)
            .await
            .unwrap();
        assert_eq!(results.len(), 1);

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let accept = reqs[0].headers.get("accept").unwrap();
        assert!(accept.to_str().unwrap().contains("text/html"));
        let accept_lang = reqs[0].headers.get("accept-language").unwrap();
        assert_eq!(accept_lang.to_str().unwrap(), "en-US,en;q=0.9");
        let ua = reqs[0].headers.get("user-agent").unwrap();
        assert_eq!(ua.to_str().unwrap(), DEFAULT_USER_AGENT);
    }

    #[test]
    fn test_parse_ddg_html_fallback_shapes() {
        // Fallback 1: result__title without result__a, and result__body without result__snippet
        let html_fallback = r#"
        <div class="result">
            <h2 class="result__title">
                <a href="https://example.com/fallback">Fallback Title</a>
            </h2>
            <div class="result__body">
                Fallback snippet text
            </div>
        </div>
        "#;
        let results = parse_ddg_html(html_fallback);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Fallback Title");
        assert_eq!(results[0].url, "https://example.com/fallback");
        assert_eq!(results[0].snippet, "Fallback snippet text");

        // Fallback 2: Lite format
        let html_lite = r#"
        <table class="results">
            <tr>
                <td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.com%2F">Lite Title</a></td>
            </tr>
            <tr>
                <td class="result-snippet">Lite snippet text</td>
            </tr>
        </table>
        "#;
        let lite_results = parse_ddg_html(html_lite);
        assert_eq!(lite_results.len(), 1);
        assert_eq!(lite_results[0].title, "Lite Title");
        assert_eq!(lite_results[0].url, "https://lite.example.com/");
        assert_eq!(lite_results[0].snippet, "Lite snippet text");
    }
}
