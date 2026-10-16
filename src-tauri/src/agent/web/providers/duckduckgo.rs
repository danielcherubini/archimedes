use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
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

pub fn parse_ddg_html(html: &str) -> Vec<SearchResultItem> {
    let doc = dom_query::Document::fragment(html);
    let mut results = Vec::new();

    for el in doc.select(".result").iter() {
        let a = el.select("a.result__a");
        if a.length() == 0 {
            continue;
        }

        let snippet_el = {
            let s = el.select(".result__snippet");
            if s.length() > 0 {
                s
            } else {
                el.select(".result__body")
            }
        };

        if snippet_el.length() == 0 {
            continue;
        }

        let mut url_str = a.attr("href").map(|s| s.to_string()).unwrap_or_default();
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

        if Url::parse(&url_str).is_err() {
            continue;
        }

        let title = a.text().trim().to_string();
        let snippet = snippet_el.text().trim().to_string();

        results.push(SearchResultItem {
            title,
            url: url_str,
            snippet,
            published_date: None,
        });
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

        if outcome.status < 200 || outcome.status >= 300 {
            return Err(format!("[duckduckgo] error: HTTP {}", outcome.status));
        }

        let html = String::from_utf8_lossy(&outcome.body);
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
}
