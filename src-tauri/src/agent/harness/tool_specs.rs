use serde_json::json;

use crate::agent::harness::provider::ToolSpec;

/// What the `bash` tool tells the model about the shell it is about to get.
///
/// Two literals, keyed on the SAME predicate `exec_bash` branches on
/// (`unix` / `not(unix)`, not `windows` — keying the sentence and the executor
/// to one predicate is what makes them unable to disagree), because
/// `exec_bash` picks `sh -c` on Unix and `cmd.exe /d /s /c` on Windows. One
/// unconditional sentence is therefore a lie on one of them, and the lie is
/// what made issue #79 expensive: six detours, because the model — and the
/// reader — trusted `NOT re-parsed` on the one platform where it is false twice
/// over (the string IS re-quoted, on the way in, by std's command-line builder).
///
/// ADR 0017's invariant ("the `<tools>` section is byte-identical to the
/// `tools[]` API param") SURVIVES the `cfg`: `model_request`
/// (`harness/loop.rs:911`) and `advertised_specs` (`harness/loop.rs:926`) call
/// the same `advertised_tool_specs`, and `worker/core.rs` renders that same
/// value into the prompt — one process, one function, one target OS, so the two
/// consumers cannot disagree. A resume replays the STORED seq-0 prompt, so an
/// in-flight session keeps the sentence it started with.
///
/// The Unix literal is byte-identical to the single literal this replaced
/// (pinned by `the_bash_description_names_the_shell_this_platform_actually_runs`).
#[cfg(unix)]
const BASH_DESCRIPTION: &str =
    "Run a shell command (sh -c; NOT re-parsed), capturing interleaved stdout+stderr.";

/// The Windows sibling — see [`BASH_DESCRIPTION`]'s doc for why there are two.
///
/// HARD CONSTRAINT on the wording: the expanded string must contain NEITHER the
/// substring `read` NOR the substring `subagent`, because
/// `src-tauri/tests/worker_e2e.rs` (`full_turn_real_worker_canned_provider`)
/// asserts `!tools_section.contains("read") && !tools_section.contains("subagent")`
/// over the rendered `<tools>` section with only `bash` enabled, and that test
/// runs on the Windows CI leg. `the_bash_description_never_names_another_advertised_tool`
/// keeps that constraint visible from Linux. It rules out `already`, `reads`,
/// `reading`, `thread`, `spread` — hence "takes", not "reads".
#[cfg(not(unix))]
const BASH_DESCRIPTION: &str = "Run a shell command (cmd.exe /d /s /c; the string reaches \
    cmd.exe EXACTLY as written, so write quoting the way cmd.exe expects it), capturing \
    interleaved stdout+stderr. Two traps: `start` takes its FIRST quoted token as a window \
    title, so never pass `\"\"` there, and a background launch is verified by the log file \
    appearing — never by the launcher's exit code; `timeout /t` cannot run here (this child \
    has no console input) — wait with `ping -n 20 127.0.0.1 > NUL`.";

/// The tool specs sent to the model (the built-ins + the suite tools —
/// the schemas mirror the `tools.ts` override). `pub(crate)` so the
/// `dispatch_native` driver derives the child's tool set (the names
/// minus `subagent`) from it.
pub(crate) fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "bash".into(),
            description: BASH_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout_ms": { "type": "number" }
                },
                "required": ["command"]
            }),
        },
        ToolSpec {
            name: "read".into(),
            description: "Read a file (or an image, as a base64 content block).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "number" },
                    "limit": { "type": "number" }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "write".into(),
            description: "Write a file (creating parent directories).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        },
        ToolSpec {
            name: "edit".into(),
            description: "Edit a file (exact text replacements).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" },
                    "replace_all": { "type": "boolean" }
                },
                "required": ["path", "old_text", "new_text"]
            }),
        },
        ToolSpec {
            name: "find".into(),
            description: "Find files by name (a glob).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" },
                    "max_results": { "type": "number" }
                },
                "required": ["pattern"]
            }),
        },
        ToolSpec {
            name: "grep".into(),
            description: "Search file contents (a regex).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" },
                    "glob": { "type": "string" },
                    "max_results": { "type": "number" },
                    "-i": { "type": "boolean" }
                },
                "required": ["pattern"]
            }),
        },
        ToolSpec {
            name: "ls".into(),
            description: "List a directory.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "long": { "type": "boolean" }
                },
                "required": ["path"]
            }),
        },
        ToolSpec {
            name: "list_skills".into(),
            description: "List the model-visible Skills (name, scope, description) — the catalog \
                          the `<skills>` system-prompt section advertises, re-read from disk."
                .into(),
            parameters: json!({ "type": "object" }),
        },
        ToolSpec {
            name: "read_skill".into(),
            description: [
                "Load a Skill's instructions by NAME — the sanctioned way to read a skill file.",
                "",
                "`name` matches a discovered Skill (see list_skills, or the `<available_skills>` \
                section); no `path` returns that skill's `SKILL.md` body. `path` reads a file \
                BUNDLED with that skill, resolved against the skill's directory — it must stay \
                inside it.",
                "",
                "A Skill whose frontmatter sets `disable-model-invocation: true` is model-hidden: \
                it is not advertised and this tool refuses it — ask the user to send it as a \
                `$name` Mention, or to load it explicitly if its name is outside the mention \
                token grammar.",
                "",
                "Skills live OUTSIDE the session `cwd` (`~/.agents/skills`, `.agents/skills`). \
                The skill tools are the sanctioned route: `read_skill` resolves a NAME against \
                the discovered catalog and confines every read to that skill's own directory.",
            ]
            .join("\n"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "The Skill's name" },
                    "path": {
                        "type": "string",
                        "description": "A file inside the skill's directory (e.g. a referenced ./format.md)"
                    }
                },
                "required": ["name"]
            }),
        },
        ToolSpec {
            name: "ask".into(),
            description: "Ask the user a question (one or more, each with options).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "question": { "type": "string" },
                                // An option is a bare label string OR an object
                                // with a `label` — because that is what the
                                // parser ACCEPTS, and the app's own model has
                                // been sending the string form all along (80 of
                                // the 395 options in the session store). The
                                // schema used to say `{"type": "object"}`, which
                                // forbade the form the app was silently handling:
                                // a payload the model was told not to send, and
                                // that rendered fine anyway. `description` is
                                // spelled out because 312 recorded options carry
                                // one and the renderer shows it.
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "anyOf": [
                                            { "type": "string" },
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "label": { "type": "string" },
                                                    "description": { "type": "string" }
                                                },
                                                "required": ["label"]
                                            }
                                        ]
                                    }
                                },
                                "multi": { "type": "boolean" }
                            },
                            // `id` stays REQUIRED on purpose: the parser now
                            // synthesizes a positional id when one is missing
                            // (so a missing id can no longer break the card),
                            // but a real id is still what the model should send.
                            "required": ["id", "question", "options"]
                        }
                    }
                },
                "required": ["questions"]
            }),
        },
        ToolSpec {
            name: "sudo_exec".into(),
            description: "Run a command with elevated privileges (confirm + masked password)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "reason": { "type": "string" },
                    "timeoutMs": { "type": "number" }
                },
                "required": ["command", "reason"]
            }),
        },
        ToolSpec {
            name: "manage_todo_list".into(),
            description: "Manage a structured todo list (write / read).".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "operation": { "type": "string", "enum": ["write", "read"] },
                    "todoList": { "type": "array" }
                },
                "required": ["operation"]
            }),
        },
        ToolSpec {
            name: "subagent".into(),
            description: "Delegate tasks to subagents. `task` is required. Optional: `agentName` (a discovered Agent definition — its frontmatter model/thinking/tools + system-prompt body apply, layered under any explicit params), `model`, `systemPrompt`, `tools`. Omit `agentName` for a config-less dispatch (parent model, all tools, no system prompt). Model override is rarely needed.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "task": { "type": "string" },
                    "agentName": { "type": "string" },
                    "model": { "type": "string" },
                    "systemPrompt": { "type": "string" },
                    "tools": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["task"]
            }),
        },
        ToolSpec {
            name: "list_agents".into(),
            description: "List available subagent configurations (name, description, source, model/tools overrides). Call before dispatching if unsure which agents exist or which fits the task.".into(),
            parameters: json!({ "type": "object" }),
        },
        ToolSpec {
            name: "mcp".into(),
            description: [
                "Gateway to MCP (Model Context Protocol) servers. Use this tool to discover and call tools from connected MCP servers.",
                "",
                "Workflow:",
                "1. Search: mcp({ search: 'keyword' }) — find available tools",
                "2. Describe: mcp({ describe: 'tool_name' }) — see full parameters",
                "3. Call: mcp({ tool: 'tool_name', args: { ... } }) — execute the tool",
                "",
                "Other actions:",
                "  Status:  mcp({}) or mcp({ action: 'status' }) — list all servers and their connection status",
                "  List:    mcp({ server: 'name' }) — list all tools on a specific server",
                "  Connect: mcp({ connect: 'name' }) — eagerly connect to a server",
                "  Auth:    mcp({ action: 'auth', server: 'name' }) — run the interactive OAuth flow",
                "",
                "Use 'server' to disambiguate when two servers export a tool with the same name.",
            ]
            .join("\n"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tool": { "type": "string", "description": "Tool name to call" },
                    "args": { "description": "Tool arguments (a JSON string or an object)" },
                    "search": { "type": "string", "description": "Search tools by name/description keyword" },
                    "describe": { "type": "string", "description": "Tool name to show full parameter schema for" },
                    "connect": { "type": "string", "description": "Server name to eagerly connect" },
                    "server": { "type": "string", "description": "Filter to a specific server (for list, search, or disambiguating calls)" },
                    "action": { "type": "string", "description": "Action string ('status' or 'auth')" }
                }
            }),
        },
        ToolSpec {
            name: "web_search".into(),
            description: "Search the web using DuckDuckGo or configured search providers.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Single search query string" },
                    "queries": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Multiple search queries executed concurrently"
                    },
                    "num_results": { "type": "number", "description": "Maximum number of results to return (1-20, default 5)" },
                    "provider": { "type": "string", "description": "Search provider to use (default: auto)" },
                    "recency_filter": { "type": "string", "description": "Time filter for results" },
                    "domain_filter": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "List of domains to restrict results to"
                    }
                }
            }),
        },
        ToolSpec {
            name: "fetch_content".into(),
            description: "Fetch web content from a URL and extract readable markdown or raw content.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "URL to fetch and extract content from" },
                    "mode": {
                        "type": "string",
                        "enum": ["readable", "raw"],
                        "description": "Extraction mode: readable (default, converted to Markdown) or raw (original body)"
                    },
                    "max_chars": {
                        "type": "number",
                        "description": "Maximum characters to return in head (default 20,000, clamp 200..=200,000)"
                    }
                },
                "required": ["url"]
            }),
        },
        ToolSpec {
            name: "get_search_content".into(),
            description: "Get cached search content or full document from a previous fetch/search by responseId.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "response_id": { "type": "string", "description": "Response ID returned by web_search or fetch_content" },
                    "offset": { "type": "number", "description": "Character offset to start reading from (default 0)" },
                    "limit": { "type": "number", "description": "Maximum characters to read (capped at 20,000)" },
                    "find_text": { "type": "string", "description": "Substring to search for in cached content" }
                },
                "required": ["response_id"]
            }),
        },
    ]
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use std::collections::BTreeSet;

    use super::*;

    fn exec_param_keys() -> [(&'static str, &'static [&'static str]); 12] {
        [
            ("bash", &["command", "timeout_ms"]),
            ("read", &["path", "offset", "limit"]),
            ("write", &["path", "content"]),
            ("edit", &["path", "old_text", "new_text", "replace_all"]),
            ("find", &["pattern", "path", "max_results"]),
            ("grep", &["pattern", "path", "glob", "max_results", "-i"]),
            ("ls", &["path", "long"]),
            ("list_skills", &[]),
            ("read_skill", &["name", "path"]),
            (
                "web_search",
                &[
                    "query",
                    "queries",
                    "num_results",
                    "provider",
                    "recency_filter",
                    "domain_filter",
                ],
            ),
            ("fetch_content", &["url", "mode", "max_chars"]),
            (
                "get_search_content",
                &["response_id", "offset", "limit", "find_text"],
            ),
        ]
    }

    #[test]
    fn every_tool_spec_is_in_the_param_key_table() {
        const LOOP_INTERNAL_TOOLS: &[&str] = &[
            "ask",
            "sudo_exec",
            "manage_todo_list",
            "subagent",
            "list_agents",
            "mcp",
        ];
        let param_keys = exec_param_keys();
        for spec in tool_specs() {
            if LOOP_INTERNAL_TOOLS.contains(&spec.name.as_str()) {
                continue;
            }
            assert!(
                param_keys.iter().any(|(name, _)| *name == spec.name),
                "tool `{}` from `tool_specs()` is missing from `exec_param_keys()`",
                spec.name
            );
        }
    }

    #[test]
    fn tool_specs_advertise_exactly_the_executor_param_keys() {
        let specs = tool_specs();
        for (name, keys) in exec_param_keys() {
            let spec = specs
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("no `tool_specs` entry for `{name}`"));
            let advertised: BTreeSet<String> = spec
                .parameters
                .get("properties")
                .and_then(Value::as_object)
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let expected: BTreeSet<String> = keys.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                advertised, expected,
                "tool `{name}`: advertised {advertised:?} != executor keys {expected:?}"
            );
        }
    }

    /// The advertised `bash` description names the shell THIS platform's
    /// executor actually picks, and never names the other one.
    ///
    /// This is issue #79's lie-as-regression: the sentence the model is given
    /// must match the shell `exec_bash` branches to (`sh -c` on Unix,
    /// `cmd.exe /d /s /c` on Windows). It was `sh -c; NOT re-parsed` on Windows
    /// too, and that single false clause is what turned one quoting bug into six
    /// detours — the model trusted it, and so did the reader of the output.
    ///
    /// Reads the description out of `tool_specs()` rather than comparing the
    /// const to itself: the claim worth pinning is that the ADVERTISED spec is
    /// honest. The Unix arm's exact-equality assertion is also the guard that
    /// moving the literal into a const did not disturb one byte of the sentence
    /// every Linux and macOS session prompt carries.
    #[test]
    fn the_bash_description_names_the_shell_this_platform_actually_runs() {
        let d = bash_description();
        #[cfg(unix)]
        {
            assert_eq!(
                d,
                "Run a shell command (sh -c; NOT re-parsed), capturing interleaved stdout+stderr.",
                "the Unix description is byte-frozen (it is printed into every \
                 Unix session prompt and persisted as seq 0 of every session)"
            );
            assert!(
                !d.contains("cmd.exe"),
                "a Unix run never touches `cmd.exe`, so the description must not name it"
            );
        }
        #[cfg(not(unix))]
        {
            assert!(
                d.contains("cmd.exe") && d.contains("/d /s /c"),
                "the Windows description must name the shell the executor picks — \
                 `exec_bash` runs `cmd.exe /d /s /c` here, got {d:?}"
            );
            assert!(
                !d.contains("sh -c"),
                "the Windows description must not promise `sh -c` (that was #79's \
                 lie: the model trusted a sentence about a shell it never got), got {d:?}"
            );
        }
    }

    /// The `bash` description may not contain the substring `read` or the
    /// substring `subagent` — on ANY platform.
    ///
    /// Why a whole substring ban and not a word-boundary one: the `<tools>`
    /// section of the system prompt is rendered from the advertised specs
    /// (`harness/prompt.rs`'s `- {name}: {description}`), and
    /// `src-tauri/tests/worker_e2e.rs::full_turn_real_worker_canned_provider`
    /// asserts `!tools_section.contains("read") &&
    /// !tools_section.contains("subagent")` with only `bash` enabled — the
    /// assertion is a plain `contains`, so a `bash` description that merely
    /// contains the letters `read` (in `already`, `reads`, `thread`) reddens a
    /// Worker e2e. That test is not `cfg`-gated, so on a `windows`-only wording
    /// change the failure would appear ONLY on the Windows CI leg — the worst
    /// possible place to discover it. This test moves the constraint to a
    /// Linux-visible one.
    #[test]
    fn the_bash_description_never_names_another_advertised_tool() {
        let d = bash_description();
        assert!(
            !d.contains("read"),
            "`worker_e2e.rs`'s `full_turn_real_worker_canned_provider` asserts the \
             rendered <tools> section does not contain `read`; the section is built \
             from this description, so the substring is banned outright (this is why \
             the Windows wording says `takes`, not `reads`). got {d:?}"
        );
        assert!(
            !d.contains("subagent"),
            "same guard as above for `subagent`: the e2e asserts the <tools> section \
             with only `bash` enabled contains neither tool name, and a description \
             that trips it reddens the Worker e2e. got {d:?}"
        );
    }

    /// The advertised `bash` description, read out of `tool_specs()` (the same
    /// call the loop advertises from) rather than from the const.
    fn bash_description() -> String {
        tool_specs()
            .into_iter()
            .find(|s| s.name == "bash")
            .expect("`bash` is in `tool_specs()`")
            .description
    }
}
