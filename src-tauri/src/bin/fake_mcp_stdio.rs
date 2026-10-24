//! A deterministic MCP stdio test double (no LLM, no sleeps) for the
//! `StdioClient` tests.
//!
//! Wire behavior mirrors the MCP stdio transport: one JSON-RPC 2.0
//! object per line. `initialize` → the server capabilities response;
//! `notifications/initialized` → no response; `tools/list` → three canned
//! tools; `tools/call` → `echo` (its `text` argument back as a
//! `content[]` text item) / `hang` (NO response — the timeout test) / `err`
//! (a JSON-RPC error). Closing stdin exits 0.
//!
//! `--tools=<csv>` replaces the advertised `tools/list` set with EXACTLY the
//! named tools (see [`tools_list_result`]) — the seam a test uses when it
//! needs two HEALTHY servers whose tool sets DIFFER, which is the only way to
//! tell "the server I scoped to has no such tool" from "some OTHER server has
//! it".

use std::io::{BufRead, Write};

use serde_json::json;

const INIT_RESULT: &str = r#"{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake-mcp","version":"0.1.0"}}"#;

const TOOLS_LIST_RESULT: &str = r#"{"tools":[{"name":"echo","description":"echo its text argument","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}},{"name":"hang","description":"never answers","inputSchema":{"type":"object"}},{"name":"err","description":"always errors","inputSchema":{"type":"object"}}]}"#;

/// The `tools/list` result: the canned three-tool set, or — when started with
/// `--tools=<csv>` — EXACTLY the named tools, each with a canned description +
/// schema. An empty value (`--tools=`) advertises NO tools; the flag being
/// absent is the only way to get the canned three.
fn tools_list_result(args: &[String]) -> String {
    let Some(arg) = args.iter().find_map(|a| a.strip_prefix("--tools=")) else {
        return TOOLS_LIST_RESULT.to_string();
    };
    let tools: Vec<serde_json::Value> = arg
        .split(',')
        .filter(|name| !name.is_empty())
        .map(|name| {
            json!({
                "name": name,
                "description": format!("{name} on the narrowed fake server"),
                "inputSchema": { "type": "object" },
            })
        })
        .collect();
    json!({ "tools": tools }).to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let tools_list_result = tools_list_result(&args);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let id = v.get("id").cloned();
        let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
            continue;
        };
        match method {
            "initialize" => {
                if let Some(id) = id {
                    let _ = writeln!(
                        stdout,
                        "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{}}}",
                        id, INIT_RESULT
                    );
                    let _ = stdout.flush();
                }
            }
            "notifications/initialized" => {} // a notification: no response.
            "tools/list" => {
                if let Some(id) = id {
                    let _ = writeln!(
                        stdout,
                        "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{}}}",
                        id, tools_list_result
                    );
                    let _ = stdout.flush();
                }
            }
            "tools/call" => {
                let Some(id) = id else {
                    continue;
                };
                let name = v["params"]["name"].as_str().unwrap_or_default();
                match name {
                    "echo" => {
                        let text = v["params"]["arguments"]["text"]
                            .as_str()
                            .unwrap_or_default();
                        let _ = writeln!(
                            stdout,
                            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}",
                            id, text
                        );
                        let _ = stdout.flush();
                    }
                    "hang" => {} // NO response (the timeout test).
                    "err" => {
                        let _ = writeln!(
                            stdout,
                            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":-32000,\"message\":\"boom\"}}}}",
                            id
                        );
                        let _ = stdout.flush();
                    }
                    _ => {
                        let _ = writeln!(
                            stdout,
                            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":-32602,\"message\":\"unknown tool\"}}}}",
                            id
                        );
                        let _ = stdout.flush();
                    }
                }
            }
            _ => {} // unknown methods: no response.
        }
    }
}
