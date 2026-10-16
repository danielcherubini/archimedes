//! The Supervisor-side headless renderer (Task 7).
//!
//! Evaluates JavaScript on web pages using a hidden Tauri `WebviewWindow`.
//! Note: This module is Supervisor-ONLY (the Worker process never starts
//! the platform main loop and cannot construct `wry` webviews, ADR 0058).

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::oneshot;
use url::Url;

/// A render request from the worker.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub session_id: String,
    pub request_id: String,
    pub url: String,
    pub timeout_ms: u64,
}

/// A render reply back to the worker.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReply {
    pub html: Option<String>,
    pub status: u16,
    pub final_url: Option<String>,
    pub error: Option<String>,
}

/// Synchronous navigation check: ensures scheme is http/https, host matches
/// requested host or subdomain, and target IP is not blocked.
pub fn is_allowed_nav(target: &Url, initial: &Url) -> bool {
    if target.scheme() != "http" && target.scheme() != "https" {
        return false;
    }
    let Some(target_host) = target.host_str() else {
        return false;
    };
    let Some(initial_host) = initial.host_str() else {
        return false;
    };
    let host_matches =
        if target_host == initial_host || target_host.ends_with(&format!(".{initial_host}")) {
            true
        } else {
            let clean_initial = initial_host.strip_prefix("www.").unwrap_or(initial_host);
            let clean_target = target_host.strip_prefix("www.").unwrap_or(target_host);
            clean_target == clean_initial || clean_target.ends_with(&format!(".{clean_initial}"))
        };
    if !host_matches {
        return false;
    }

    let clean_target_host = target_host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = clean_target_host.parse::<std::net::IpAddr>() {
        if crate::agent::web::net::is_blocked_ip(ip) {
            return false;
        }
    } else {
        let port = target
            .port_or_known_default()
            .unwrap_or(if target.scheme() == "https" { 443 } else { 80 });
        use std::net::ToSocketAddrs;
        match (clean_target_host, port).to_socket_addrs() {
            Ok(addrs) => {
                let mut count = 0;
                for addr in addrs {
                    count += 1;
                    if crate::agent::web::net::is_blocked_ip(addr.ip()) {
                        return false;
                    }
                }
                if count == 0 {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }

    true
}

/// Render a URL in a hidden webview, returning the rendered HTML DOM.
pub async fn render(app: &tauri::AppHandle, req: RenderRequest) -> RenderReply {
    let parsed_initial = match Url::parse(&req.url) {
        Ok(u) => u,
        Err(e) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some(format!("invalid url: {e}")),
            };
        }
    };

    if parsed_initial.scheme() != "http" && parsed_initial.scheme() != "https" {
        return RenderReply {
            html: None,
            status: 0,
            final_url: None,
            error: Some("only http and https schemes are allowed".to_string()),
        };
    }

    let initial_host = match parsed_initial.host_str() {
        Some(h) => h,
        None => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some("missing host in url".to_string()),
            };
        }
    };
    let initial_port =
        parsed_initial
            .port_or_known_default()
            .unwrap_or(if parsed_initial.scheme() == "https" {
                443
            } else {
                80
            });

    if let Err(e) =
        crate::agent::web::net::resolve_and_verify_addrs(initial_host, initial_port).await
    {
        return RenderReply {
            html: None,
            status: 403,
            final_url: None,
            error: Some(e.to_string()),
        };
    }

    let label = format!(
        "{}{}",
        crate::navigation_guard::RENDER_WEBVIEW_PREFIX,
        req.request_id
    );

    let (load_tx, load_rx) = oneshot::channel::<Result<Url, String>>();
    let load_tx_cell = Arc::new(StdMutex::new(Some(load_tx)));

    let (win_tx, win_rx) = oneshot::channel::<Result<tauri::WebviewWindow, String>>();

    let app_handle = app.clone();
    let label_for_create = label.clone();
    let initial_url = parsed_initial.clone();
    let initial_for_nav = parsed_initial.clone();
    let load_tx_clone = load_tx_cell.clone();

    let main_thread_dispatch = app.run_on_main_thread(move || {
        let builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            &label_for_create,
            tauri::WebviewUrl::External(initial_url),
        )
        .visible(false)
        .decorations(false)
        .inner_size(1280.0, 900.0)
        .on_navigation(move |nav_url| is_allowed_nav(nav_url, &initial_for_nav))
        .on_page_load(move |_window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Ok(mut lock) = load_tx_clone.lock() {
                    if let Some(tx) = lock.take() {
                        let _ = tx.send(Ok(payload.url().clone()));
                    }
                }
            }
        });

        match builder.build() {
            Ok(w) => {
                let _ = win_tx.send(Ok(w));
            }
            Err(e) => {
                let _ = win_tx.send(Err(e.to_string()));
            }
        }
    });

    if let Err(e) = main_thread_dispatch {
        return RenderReply {
            html: None,
            status: 0,
            final_url: None,
            error: Some(format!(
                "failed to dispatch webview creation to main thread: {e}"
            )),
        };
    }

    let window = match tokio::time::timeout(Duration::from_millis(5000), win_rx).await {
        Ok(Ok(Ok(w))) => w,
        Ok(Ok(Err(e))) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some(format!("failed to build render window: {e}")),
            };
        }
        Ok(Err(_)) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some("window creation channel closed".to_string()),
            };
        }
        Err(_) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some("window creation timed out".to_string()),
            };
        }
    };

    struct WindowDestroyGuard(tauri::WebviewWindow);
    impl Drop for WindowDestroyGuard {
        fn drop(&mut self) {
            let _ = self.0.destroy();
        }
    }
    let guard = WindowDestroyGuard(window.clone());

    let timeout_duration = Duration::from_millis(req.timeout_ms.max(1000));
    let start_time = tokio::time::Instant::now();

    let final_url = match tokio::time::timeout(timeout_duration, load_rx).await {
        Ok(Ok(Ok(u))) => u,
        Ok(Ok(Err(e))) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some(format!("page load error: {e}")),
            };
        }
        Ok(Err(_)) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some("page load channel dropped".to_string()),
            };
        }
        Err(_) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: None,
                error: Some("page load timed out".to_string()),
            };
        }
    };

    // DOM stabilization delay after PageLoadEvent::Finished
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Deferred security check against net::is_blocked_ip
    if let Some(host) = final_url.host_str() {
        let port = final_url.port_or_known_default().unwrap_or(80);
        if let Ok(addrs) = tokio::net::lookup_host((host, port)).await {
            for addr in addrs {
                if crate::agent::web::net::is_blocked_ip(addr.ip()) {
                    return RenderReply {
                        html: None,
                        status: 403,
                        final_url: Some(final_url.to_string()),
                        error: Some(format!("navigation to blocked IP {} refused", addr.ip())),
                    };
                }
            }
        }
    }

    let elapsed = start_time.elapsed();
    let remaining = timeout_duration.saturating_sub(elapsed);
    if remaining.is_zero() {
        return RenderReply {
            html: None,
            status: 0,
            final_url: Some(final_url.to_string()),
            error: Some("timeout reached before eval".to_string()),
        };
    }

    let (eval_tx, eval_rx) = oneshot::channel::<String>();
    let eval_tx_cell = Arc::new(StdMutex::new(Some(eval_tx)));
    let eval_tx_clone = eval_tx_cell.clone();
    let win_eval = window.clone();

    let eval_dispatch = app.run_on_main_thread(move || {
        let _ =
            win_eval.eval_with_callback("document.documentElement.outerHTML", move |raw_json| {
                if let Ok(mut lock) = eval_tx_clone.lock() {
                    if let Some(tx) = lock.take() {
                        let _ = tx.send(raw_json);
                    }
                }
            });
    });

    if let Err(e) = eval_dispatch {
        return RenderReply {
            html: None,
            status: 0,
            final_url: Some(final_url.to_string()),
            error: Some(format!("failed to dispatch eval to main thread: {e}")),
        };
    }

    let html_json = match tokio::time::timeout(remaining, eval_rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: Some(final_url.to_string()),
                error: Some("eval response channel closed".to_string()),
            };
        }
        Err(_) => {
            return RenderReply {
                html: None,
                status: 0,
                final_url: Some(final_url.to_string()),
                error: Some("eval timed out".to_string()),
            };
        }
    };

    let html = serde_json::from_str::<String>(&html_json).unwrap_or(html_json);

    drop(guard);

    if html.len() > crate::agent::web::net::MAX_BODY_BYTES {
        return RenderReply {
            html: None,
            status: 0,
            final_url: Some(final_url.to_string()),
            error: Some("response body exceeded limit of 5 MB".to_string()),
        };
    }

    RenderReply {
        html: Some(html),
        status: 200,
        final_url: Some(final_url.to_string()),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_allowed_nav_same_host_and_subdomain() {
        let initial = Url::parse("https://localhost/start").unwrap();
        let same = Url::parse("https://localhost/another").unwrap();
        let sub = Url::parse("https://sub.localhost/page").unwrap();
        let diff = Url::parse("https://another-domain.invalid/evil").unwrap();
        let file = Url::parse("file:///etc/passwd").unwrap();

        assert!(is_allowed_nav(&same, &initial));
        assert!(is_allowed_nav(&sub, &initial));
        assert!(!is_allowed_nav(&diff, &initial));
        assert!(!is_allowed_nav(&file, &initial));
    }

    #[test]
    fn test_is_allowed_nav_www_prefix() {
        let initial_www = Url::parse("https://www.localhost/").unwrap();
        let target_bare = Url::parse("https://localhost/blog").unwrap();
        assert!(is_allowed_nav(&target_bare, &initial_www));

        let initial_bare = Url::parse("https://localhost/").unwrap();
        let target_www = Url::parse("https://www.localhost/blog").unwrap();
        assert!(is_allowed_nav(&target_www, &initial_bare));
    }

    #[test]
    fn test_is_allowed_nav_blocks_private_ips() {
        let initial_private = Url::parse("http://10.0.0.1/start").unwrap();
        let target_private = Url::parse("http://10.0.0.1/nav").unwrap();
        assert!(!is_allowed_nav(&target_private, &initial_private));

        let initial_local = Url::parse("http://127.0.0.1:8080/start").unwrap();
        let target_local = Url::parse("http://127.0.0.1:8080/nav").unwrap();
        assert!(is_allowed_nav(&target_local, &initial_local));

        let target_blocked = Url::parse("http://169.254.169.254/meta").unwrap();
        assert!(!is_allowed_nav(&target_blocked, &initial_local));
    }

    #[test]
    fn test_render_request_reply_serde() {
        let req = RenderRequest {
            session_id: "s1".into(),
            request_id: "r1".into(),
            url: "https://example.com".into(),
            timeout_ms: 5000,
        };
        let req_json = serde_json::to_value(&req).unwrap();
        assert_eq!(req_json["sessionId"], "s1");
        assert_eq!(req_json["timeoutMs"], 5000);

        let reply = RenderReply {
            html: Some("<html></html>".into()),
            status: 200,
            final_url: Some("https://example.com".into()),
            error: None,
        };
        let reply_json = serde_json::to_value(&reply).unwrap();
        assert_eq!(reply_json["status"], 200);
        assert_eq!(reply_json["html"], "<html></html>");
    }
}
