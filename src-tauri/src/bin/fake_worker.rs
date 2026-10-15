//! The `fake_worker` test fixture (ADR 0025 Task 3 — the
//! `fake_mcp_stdio` pattern): a tiny binary that speaks the Worker
//! protocol via the shared `protocol` types — `ready` on start, a
//! canned event + store-frame + `SinkFrame` stream on `start` +
//! `prompt`, a permission round-trip, `close` → exit 0, and a
//! `__crash__` prompt → exit 137.
//!
//! Wire behavior (one JSONL line per frame — the `protocol` types):
//! - startup: a `ready` line (the fixture version — BEFORE `start`).
//! - `start`: stores the `session_id` + `enabled_tools` (the advertised
//!   tool set rides a `session-update` `SinkFrame` — the
//!   `SubagentCapture` / wire-convention test input).
//! - `prompt`: a canned `RpcEvent` stream (`turn_start` →
//!   `message_start` / `message_end` with a canned assistant `Value` →
//!   `turn_end` → `agent_settled`) PLUS canned store frames
//!   (`TranscriptInsert` for a canned user + assistant `ChatMessage`,
//!   `DisplayUpsert` for a canned `agent-text` row) PLUS a canned
//!   `SinkFrame` `session-update` with an `agent_message_chunk` (the
//!   `SubagentCapture` test input — the enveloped shape).
//! - a `prompt` whose text is `"__crash__"`: exits 137 immediately
//!   (NO `agent_settled` — the crash-detection test).
//! - a `prompt` whose text is `"__permission__"`: a
//!   `PermissionRequest` (id `"p1"`, the FULL canned gate payload —
//!   `requestId` + `request: { toolCall: { title }, options }` —
//!   mirroring `permission.rs:135-158`); on a `PermissionResponse`
//!   (ANY `outcome`) → the tool-execution events + `agent_settled`
//!   (the round-trip test).
//! - a `prompt` whose text is `"__slow__"`: sleeps 10 s before
//!   settling (the `settle_timeout` tests).
//! - a `prompt` whose text is `"__subagent__"` /
//!   `"__slow_subagent__"` / `"__subagent_tools__"`: a canned
//!   `SubagentDispatch` frame (the Supervisor-side dispatch-flow test
//!   input — the `model_key` — `fake/m1` — resolves against the
//!   parent's `StartEnv` catalog; `__slow_subagent__` is the same
//!   frame with the SLOW child task; `__subagent_tools__` is the
//!   frame with `launch.tools: Some(["subagent"])` — the
//!   empties-out-after-the-guard-minus case).
//! - a `prompt` whose text is `"__long_stream__"`: a LONG `SinkFrame`
//!   `session-update` `agent_message_chunk` stream (the chunks land ~100 ms
//!   apart for ~1.5 s of CONTINUOUS production) and ONLY then the canned
//!   turn + `agent_settled` (the ADR 0055 regression input — a child that
//!   keeps PRODUCING far past a SHORT injected bound must COMPLETE, not be
//!   reaped mid-answer).
//! - a `prompt` whose text is `"__in_tool__"`: a `tool_execution_start`
//!   held OPEN for ~1.5 s before its `tool_execution_end` +
//!   `agent_settled` (the "child inside a tool call, producing NOTHING"
//!   state — legitimately silent, so a duration bound must never cut it).
//! - a `prompt` whose text is `"__stream_then_silence__"`: a SHORT
//!   `agent_message_chunk` stream + a `message_update` `usage` frame (real
//!   capture text AND real tokens), then ~10 s of SILENCE and NO
//!   `agent_settled` — a **Dead Subagent** (the **Dead bound** reaps it, and
//!   a cancel reaches it mid-silence). The salvage input: the drive must
//!   carry the partial text + the real usage instead of discarding them.
//! - a `prompt` whose text is `"__stream_then_crash__"`: the same partial
//!   production, then exit 137 (a **Dead Subagent** by process death — the
//!   crash path's salvage input).
//! - a `prompt` whose text is `"__cancel__"`: a `SubagentCancel` frame
//!   (the `SubagentCancel` routing test).
//! - a `prompt` whose text is `"__stderr__"`: a line on STDERR and NO
//!   stdout frame (the stderr-drain test — the Supervisor must forward it
//!   to the debug log, then the turn settles).
//! - a `subagent-result` line: a `subagent-result-ack` `SinkFrame`
//!   (the `SubagentResult` round-trip observation point — the
//!   `outcome` rides verbatim).
//! - `close`: exit 0 (the Worker self-exits — the Supervisor does NOT
//!   close the stdin pipe).

use std::io::{BufRead, Write};

use archimedes_lib::agent::events::RpcEvent;
use archimedes_lib::agent::harness::store::DisplayRow;
use archimedes_lib::agent::harness::ModelKey;
use archimedes_lib::agent::subagent::LaunchConfig;
use archimedes_lib::agent::worker::protocol::{decode_inbound, encode_outbound, Inbound, Outbound};

/// The fixture version (the `ready` frame's `version` field).
const VERSION: &str = "fake-worker-0.0.0";

/// The `__long_stream__` chunk count (ADR 0055) — `LONG_STREAM_CHUNKS` ×
/// `LONG_STREAM_GAP` ≈ 1.5 s of CONTINUOUS production: long enough to blow
/// the tests' injected 300 ms bound by 5×, short enough to keep the suite
/// fast (the whole scenario stays under ~2 s).
const LONG_STREAM_CHUNKS: u32 = 15;

/// The gap between two `__long_stream__` chunks (~100 ms — a chunk arrives
/// well INSIDE the tests' 300 ms bound, so a self-rearming silence clock can
/// never expire while the child is talking).
const LONG_STREAM_GAP: std::time::Duration = std::time::Duration::from_millis(100);

/// How long the `__in_tool__` scenario holds its `tool_execution_start`
/// open (~1.5 s — the child is silent for 5× the injected bound while it is
/// legitimately blocked inside the tool).
const IN_TOOL_HOLD: std::time::Duration = std::time::Duration::from_millis(1500);

/// How long the `__stream_then_silence__` scenario stays SILENT after its
/// partial production (~10 s — LONGER than any bound the tests inject, so
/// the **Dead bound** is the only thing that can end the dispatch, and a
/// cancel mid-silence is unambiguously the cancel arm).
const SILENCE_AFTER_STREAM: std::time::Duration = std::time::Duration::from_secs(10);

/// Emit one outbound frame (one JSONL line — the `protocol` encode).
fn emit<W: Write>(stdout: &mut W, frame: &Outbound) {
    let line = encode_outbound(frame);
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}

/// The long `agent_message_chunk` stream (ADR 0055 — the `__long_stream__`
/// scenario's body): `LONG_STREAM_CHUNKS` `SinkFrame` `session-update`
/// frames ~100 ms apart (~1.5 s of CONTINUOUS production). They ride
/// `messageId: "m2"` — a DIFFERENT id from `emit_canned_turn`'s canned `m1` —
/// so the stream is an INTERMEDIATE message in the capture's
/// last-`messageId`-with-non-empty-text rule and never concatenates into the
/// child's final answer (exactly the shape a real tool-using turn has); the
/// `messageId` values are literal because the `SubagentCapture` keys on the
/// frame's id, not on the stamped display row's.
///
/// Ordering invariant (the same one `emit_canned_turn` documents): this is
/// only the child's PRODUCTION phase — `agent_settled` is emitted by
/// `emit_canned_turn`, LAST, after the whole stream, so the `SubagentCapture`
/// is fully fed before the settle signal (no drive-teardown race).
fn emit_long_chunk_stream<W: Write>(stdout: &mut W, session_id: &str) {
    for i in 0..LONG_STREAM_CHUNKS {
        emit(
            stdout,
            &Outbound::SinkFrame {
                event: "session-update".to_string(),
                payload: serde_json::json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "m2",
                        "content": { "type": "text", "text": if i == 0 { "streamed" } else { "…" } }
                    }
                }),
            },
        );
        std::thread::sleep(LONG_STREAM_GAP);
    }
}

/// The PARTIAL production both salvage scenarios emit before they die: a
/// `message_update` `usage` frame (so `SubagentCapture::usage()` reports REAL
/// tokens — the failed path used to report 0 for work that really cost money)
/// followed by three `agent_message_chunk` `SinkFrame`s on one `messageId`
/// (so `SubagentCapture::captured_text()` is non-empty — the salvage the
/// parent must receive).
///
/// The `messageId` is `m9` — neither `emit_canned_turn`'s `m1` nor
/// `emit_long_chunk_stream`'s `m2` — and it is NOT a bookkeeping id, so the
/// capture's last-`messageId`-with-non-empty-text rule picks it up. Neither
/// scenario emits `agent_settled`: a **Dead Subagent** never decided it was
/// finished, and a settle frame here would erase the very failure being tested.
fn emit_partial_progress<W: Write>(stdout: &mut W, session_id: &str) {
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::message_update {
                usage: serde_json::json!({ "inputTokens": 120, "outputTokens": 34 }),
                assistant_message_event: serde_json::json!({
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": "partial "
                }),
            },
        },
    );
    for text in ["Finding one. ", "Finding two. ", "Finding three."] {
        emit(
            stdout,
            &Outbound::SinkFrame {
                event: "session-update".to_string(),
                payload: serde_json::json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "m9",
                        "content": { "type": "text", "text": text }
                    }
                }),
            },
        );
    }
}

/// The canned `RpcEvent` stream (the Supervisor's bookkeeping input —
/// `turn_start` → `message_start` / `message_end` with a canned
/// assistant `Value` → `turn_end` → `agent_settled`) PLUS the canned
/// store frames (`TranscriptInsert` for a canned user + assistant
/// `ChatMessage`, `DisplayUpsert` for a canned `agent-text` row) PLUS
/// a canned `SinkFrame` `session-update` with an `agent_message_chunk`
/// (the `SubagentCapture` test input — the enveloped shape).
///
/// The emission order mirrors the REAL harness (ADR 0025): the
/// `SinkFrame` `agent_message_chunk`s stream DURING the message
/// (BEFORE `agent_settled` — the `SubagentCapture` is fully fed
/// before the settle signal), and the store frames (the transcript
/// persistence) land with the message completion — ALSO before
/// `agent_settled`.
///
/// `incarnation` is the stamp this Worker's `StartEnv` carried (ADR 0049). It
/// namespaces the `DisplayUpsert` `message_key`, so two Worker lives for one
/// Session write TWO display rows instead of UPSERTing over one key — the
/// shape the two-incarnation e2e assertion reads.
/// (The `SubagentCapture` fixture is a SEPARATE concern: the `SinkFrame`
/// `messageId`s below stay the literal `m1`, because that capture keys on the
/// frame's id, not on the display row's.)
fn emit_canned_turn<W: Write>(stdout: &mut W, session_id: &str, incarnation: &str) {
    // The `RpcEvent` stream (the Supervisor's INTERNAL bookkeeping —
    // settle detection, the `SubagentCapture`'s usage, the debug
    // log).
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::turn_start,
        },
    );
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::message_start {
                message: serde_json::json!({ "role": "assistant" }),
            },
        },
    );
    // The `message_update` usage (the `SubagentCapture`'s token fields
    // — the metrics' token fields).
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::message_update {
                usage: serde_json::json!({ "inputTokens": 10, "outputTokens": 5 }),
                assistant_message_event: serde_json::json!({
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": "canned "
                }),
            },
        },
    );
    // The `SinkFrame` `session-update` with the `agent_message_chunk`
    // stream (the `SubagentCapture` test input — the enveloped
    // `{ sessionId, update }` shape — streamed DURING the message, BEFORE
    // `agent_settled`).
    emit(
        stdout,
        &Outbound::SinkFrame {
            event: "session-update".to_string(),
            payload: serde_json::json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "m1",
                    "content": { "type": "text", "text": "canned " }
                }
            }),
        },
    );
    emit(
        stdout,
        &Outbound::SinkFrame {
            event: "session-update".to_string(),
            payload: serde_json::json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "m1",
                    "content": { "type": "text", "text": "answer" }
                }
            }),
        },
    );
    // The `message_end` with a canned assistant `Value` (the
    // `message_end` shape — carries NO text for tool-call messages,
    // so the `SubagentCapture` does NOT read it).
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::message_end {
                message: serde_json::json!({
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "canned answer" }]
                }),
            },
        },
    );
    // The store frames (the Supervisor's persister input — the
    // `IpcStore`'s `TranscriptInsert` / `DisplayUpsert` frames — the
    // transcript rows land with the message completion, BEFORE
    // `agent_settled`).
    emit(
        stdout,
        &Outbound::TranscriptInsert {
            session_id: session_id.to_string(),
            seq: 1,
            role: "user".to_string(),
            content_json: r#"{"role":"user","content":"canned prompt"}"#.to_string(),
        },
    );
    emit(
        stdout,
        &Outbound::TranscriptInsert {
            session_id: session_id.to_string(),
            seq: 2,
            role: "assistant".to_string(),
            content_json: r#"{"role":"assistant","content":"canned answer"}"#.to_string(),
        },
    );
    emit(
        stdout,
        &Outbound::DisplayUpsert {
            session_id: session_id.to_string(),
            rows: vec![DisplayRow {
                kind: "agent-text".to_string(),
                message_key: format!("{incarnation}:m1"),
                payload_json: serde_json::json!({ "text": "canned answer" }),
                created_at: 1,
            }],
        },
    );
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::turn_end {
                message: serde_json::json!({ "role": "assistant" }),
                tool_results: Vec::new(),
            },
        },
    );
    // The settle (LAST — the `SubagentCapture` is fully fed by now:
    // the `agent_message_chunk` stream + the usage are all delivered
    // before this frame, so the drive task's settle→teardown reads a
    // complete capture — no race).
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::agent_settled,
        },
    );
}

/// The tool-execution events + `agent_settled` (the
/// `__permission__` round-trip's post-response stream — the
/// tool-execution events arrive AFTER the `PermissionResponse`).
///
/// The `tool_call_id` is the GATE's `requestId` (`p1`), NOT an independent
/// `t1`: in production `gate_tool` passes `&tc.id` to `native_permission_gate`,
/// so a **gate**'s id and the `tool_call_id` of the tool it is parked inside are
/// the SAME string. The Supervisor's ADR 0055 teardown depends on that one id
/// space — `tool_execution_end` removes the gate from the outstanding-gate set,
/// which is how an ANSWERED gate is absent at teardown — so a fixture that
/// invented a second id would model a Worker that cannot exist.
fn emit_tool_execution_and_settle<W: Write>(stdout: &mut W, session_id: &str) {
    let _ = session_id;
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::tool_execution_start {
                tool_call_id: "p1".to_string(),
                tool_name: "bash".to_string(),
                args: serde_json::json!({ "command": "ls" }),
            },
        },
    );
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::tool_execution_end {
                tool_call_id: "p1".to_string(),
                tool_name: "bash".to_string(),
                result: serde_json::json!({
                    "content": [{ "type": "text", "text": "ok" }],
                    "details": { "exitCode": 0 },
                    "isError": false
                }),
                is_error: false,
            },
        },
    );
    emit(
        stdout,
        &Outbound::Event {
            event: RpcEvent::agent_settled,
        },
    );
}

/// The canned `SubagentDispatch` frame (the Supervisor-side
/// dispatch-flow test input — the `model_key` — `fake/m1` — resolves
/// against the parent's `StartEnv` catalog; the `task` is the
/// subagent's initial prompt — `"__slow__"` for the `settle_timeout`
/// tests, `"__subagent_tools__"`'s `launch.tools` is
/// `Some(["subagent"])` — the empties-out-after-the-guard-minus
/// case).
fn emit_subagent_dispatch<W: Write>(
    stdout: &mut W,
    session_id: &str,
    task: &str,
    tools: Option<Vec<String>>,
    model_key: &str,
) {
    let parent_enabled_tools = if tools.is_some() {
        vec!["subagent".to_string()]
    } else {
        vec!["bash".to_string(), "read".to_string()]
    };
    emit(
        stdout,
        &Outbound::SubagentDispatch {
            id: "sub1".to_string(),
            parent_session_id: session_id.to_string(),
            parent_cwd: "/tmp/space".to_string(),
            parent_enabled_tools,
            agent_name: "tester".to_string(),
            launch: LaunchConfig {
                system_prompt: Some("be brief".to_string()),
                model: None,
                thinking: None,
                frontmatter_thinking: None,
                tools,
            },
            task: task.to_string(),
            model_key: model_key.to_string(),
        },
    );
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    // The `ready` frame (the fixture version — emitted at startup,
    // BEFORE `start`).
    emit(
        &mut stdout,
        &Outbound::Ready {
            version: VERSION.to_string(),
            session_id: None,
        },
    );

    let mut reader = stdin.lock();
    let mut line = String::new();
    let mut session_id: Option<String> = None;
    // The parent's `model` key (the `Start` env — the `SubagentDispatch`
    // frame's `model_key` — the Supervisor resolves it against the
    // parent's `StartEnv` catalog; the fixture's hardcoded `fake/m1`
    // would be unknown when the parent's model is a different provider
    // (e.g. the `ipc` test's seeded `tama/m1`)).
    let mut model_key: Option<String> = None;
    // The stamp this Worker's `StartEnv` carried (ADR 0049) — the fixture
    // namespaces its canned display key with it, exactly as the real harness
    // namespaces every id it mints.
    let mut incarnation = String::new();

    while let Ok(n) = reader.read_line(&mut line) {
        if n == 0 {
            break; // EOF — the Supervisor is gone.
        }
        let l = line.trim_end_matches(['\n', '\r']).to_string();
        line.clear();
        if l.is_empty() {
            continue;
        }
        let Ok(msg) = decode_inbound(&l) else {
            continue; // a malformed line — the fixture is permissive.
        };
        let sid = session_id.clone().unwrap_or_default();
        match msg {
            Inbound::Start(env) => {
                session_id = Some(env.session_id.clone());
                model_key = Some(ModelKey::from(&env.model).to_string());
                incarnation = env.incarnation.clone();
                // The advertised tool set (the `SubagentCapture` /
                // wire-convention test input — a `session-update`
                // `SinkFrame` with the `enabledTools` field — the
                // harness convention verbatim: `None` = all,
                // `Some(v)` = exactly `v`, `Some([])` = NO tools).
                // The `systemPrompt` + `trusted` fields ride the envelope
                // (the ADR 0025 Task 5 test input — the subagent's
                // `StartEnv` envelope assertion: the `systemPrompt` is
                // the `build_child_system_message` output, the `trusted`
                // is the parent's trust flag (the inheritance — ADR
                // 0010)). `systemPrompt` is ALWAYS present (a `null`
                // when the env's field is `None` — the absence-of-a-
                // system-message assertion keys on the `null`).
                let update = serde_json::json!({
                    "sessionUpdate": "session_info",
                    "enabledTools": env.enabled_tools,
                    "systemPrompt": serde_json::to_value(&env.system_prompt).unwrap(),
                    "trusted": env.trusted,
                    // The stamp the Worker mints its ids with (ADR 0049) — the
                    // two-incarnation assertion: the e2e resume test reads the
                    // echo to prove two Workers for one Session get
                    // DIFFERENT stamps.
                    "incarnation": env.incarnation
                });
                emit(
                    &mut stdout,
                    &Outbound::SinkFrame {
                        event: "session-update".to_string(),
                        payload: serde_json::json!({
                            "sessionId": env.session_id,
                            "update": update
                        }),
                    },
                );
            }
            Inbound::Prompt { text, .. } => match text.as_str() {
                // The crash (NO `agent_settled` — the
                // crash-detection test; the process exits 137 —
                // the SIGKILL convention).
                "__crash__" => std::process::exit(137),
                // The permission round-trip: the `PermissionRequest`
                // (id `"p1"`, the FULL canned gate payload —
                // `requestId` + `request: { toolCall: { title },
                // options }` — mirroring `permission.rs:135-158`);
                // on a `PermissionResponse` (ANY `outcome`) → the
                // tool-execution events + `agent_settled`.
                "__permission__" => {
                    emit(
                        &mut stdout,
                        &Outbound::PermissionRequest {
                            id: "p1".to_string(),
                            payload: serde_json::json!({
                                "sessionId": sid,
                                "requestId": "p1",
                                "request": {
                                    "sessionId": sid,
                                    "toolCall": { "title": "Allow bash?" },
                                    "options": [
                                        { "optionId": "allow", "name": "Allow", "kind": "allow" },
                                        { "optionId": "reject", "name": "Block", "kind": "reject" },
                                        { "optionId": "trust-space", "name": "Don't ask again for this Space", "kind": "allow" }
                                    ]
                                }
                            }),
                        },
                    );
                    // Wait for the `PermissionResponse` (ANY
                    // `outcome` — the fixture is permissive; a
                    // different frame while waiting is ignored).
                    loop {
                        let Ok(n) = reader.read_line(&mut line) else {
                            std::process::exit(1); // the Supervisor is gone.
                        };
                        if n == 0 {
                            std::process::exit(1); // EOF — the Supervisor is gone.
                        }
                        let l2 = line.trim_end_matches(['\n', '\r']).to_string();
                        line.clear();
                        if l2.is_empty() {
                            continue;
                        }
                        let Ok(m2) = decode_inbound(&l2) else {
                            continue;
                        };
                        if matches!(m2, Inbound::PermissionResponse { .. }) {
                            break;
                        }
                    }
                    // The tool-execution events + `agent_settled`
                    // (the round-trip completes — the
                    // `PermissionOutcome` was delivered verbatim).
                    emit_tool_execution_and_settle(&mut stdout, &sid);
                }
                // The slow settle (the `settle_timeout` tests — a 10 s
                // sleep before settling; the `settle_timeout` bound is
                // shorter, so the timeout wins).
                "__slow__" => {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    emit_canned_turn(&mut stdout, &sid, &incarnation);
                }
                // The LONG stream (ADR 0055 — the
                // `a_streaming_subagent_outlives_the_dead_bound` regression
                // input): ~1.5 s of CONTINUOUS `agent_message_chunk`
                // production — 5× the tests' injected 300 ms bound — and
                // ONLY THEN the canned turn (whose `agent_settled` stays
                // LAST, after the whole stream, so the `SubagentCapture` is
                // fully fed before the settle). A child that keeps
                // PRODUCING must COMPLETE, not be reaped mid-answer.
                "__long_stream__" => {
                    emit_long_chunk_stream(&mut stdout, &sid);
                    emit_canned_turn(&mut stdout, &sid, &incarnation);
                }
                // A tool call held OPEN (ADR 0055 — the
                // `a_child_inside_a_tool_call_is_never_reaped` regression
                // input): the `tool_execution_start` ANNOUNCE, then
                // NOTHING for ~1.5 s (the tool runs — the child is silent
                // BY CONSTRUCTION and legitimately blocked), then the
                // matching `tool_execution_end` + `agent_settled`. The
                // frames mirror `emit_tool_execution_and_settle`'s shapes
                // (the same `t1` / `bash`), split around the hold.
                "__in_tool__" => {
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::tool_execution_start {
                                tool_call_id: "t1".to_string(),
                                tool_name: "bash".to_string(),
                                args: serde_json::json!({ "command": "sleep 1.5" }),
                            },
                        },
                    );
                    std::thread::sleep(IN_TOOL_HOLD);
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::tool_execution_end {
                                tool_call_id: "t1".to_string(),
                                tool_name: "bash".to_string(),
                                result: serde_json::json!({
                                    "content": [{ "type": "text", "text": "ok" }],
                                    "details": { "exitCode": 0 },
                                    "isError": false
                                }),
                                is_error: false,
                            },
                        },
                    );
                    // The settle (LAST — the invariant: NOTHING the
                    // `SubagentCapture` reads arrives after it).
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The salvage input for the **Dead bound** / cancel paths: a
                // little REAL production (capture text + a `usage` frame),
                // then ~10 s of SILENCE and NO `agent_settled`. With a short
                // injected bound the drive arms its silence clock (the chunks
                // are not inside a tool call, so nothing blocks it) and reaps
                // the child — the capture must be non-empty at that moment.
                // The same scenario also serves the CANCEL case (cancel it
                // mid-silence).
                "__stream_then_silence__" => {
                    emit_partial_progress(&mut stdout, &sid);
                    std::thread::sleep(SILENCE_AFTER_STREAM);
                    // Never reached in the tests (the bound / the cancel wins
                    // long before); the settle keeps the fixture well-formed
                    // if the sleep ever does complete.
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The salvage input for the CRASH path: the same partial
                // production, then exit 137 (NO `agent_settled` — the process
                // death is the failure).
                "__stream_then_crash__" => {
                    emit_partial_progress(&mut stdout, &sid);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    std::process::exit(137);
                }
                // The `interactive-event` `SinkFrame` (the `todos_update`
                // push — the frontend's `useInteractive.applyTodoUpdate`
                // consumes the payload VERBATIM) + `agent_settled` (the
                // `headless` IPC test's `__interactive__` input — the
                // `SinkFrame` re-emit contract observation point).
                "__interactive__" => {
                    emit(
                        &mut stdout,
                        &Outbound::SinkFrame {
                            event: "interactive-event".to_string(),
                            payload: serde_json::json!({
                                "sessionId": sid,
                                "seq": 0,
                                "event": "todos_update",
                                "payload": {
                                    "source": "main",
                                    "todos": [
                                        { "content": "do the thing", "status": "pending" }
                                    ]
                                }
                            }),
                        },
                    );
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The Supervisor-side dispatch-flow test input (a
                // canned `SubagentDispatch` frame — the `model_key`
                // — `fake/m1` — resolves against the parent's
                // `StartEnv` catalog).
                "__subagent__" => {
                    emit_subagent_dispatch(
                        &mut stdout,
                        &sid,
                        "the task",
                        None,
                        &model_key.clone().unwrap_or_else(|| "fake/m1".to_string()),
                    );
                    // The parent's turn settles AFTER the dispatch (the
                    // fixture's simplified model — the `send_prompt`
                    // helper waits for the settle; the `SubagentResult`
                    // arrives later and is acked on receipt).
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The `settle_timeout` test input (the same frame with
                // the SLOW child task — the subagent's initial
                // prompt is `"__slow__"` → the 10 s settle).
                "__slow_subagent__" => {
                    emit_subagent_dispatch(
                        &mut stdout,
                        &sid,
                        "__slow__",
                        None,
                        &model_key.clone().unwrap_or_else(|| "fake/m1".to_string()),
                    );
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The wire-convention test input (the frame with
                // `launch.tools: Some(["subagent"])` — the
                // empties-out-after-the-guard-minus case; the
                // `parent_enabled_tools` is the `Some` case's parent
                // list).
                "__subagent_tools__" => {
                    emit_subagent_dispatch(
                        &mut stdout,
                        &sid,
                        "the task",
                        Some(vec!["subagent".to_string()]),
                        &model_key.clone().unwrap_or_else(|| "fake/m1".to_string()),
                    );
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The `SubagentCancel` routing test input (the loop's
                // `SubagentCancel` → the `IpcDispatcher`'s
                // `SubagentCancel` frame).
                "__cancel__" => {
                    emit(
                        &mut stdout,
                        &Outbound::SubagentCancel {
                            id: "sub1".to_string(),
                        },
                    );
                }
                // The stderr-drain test input: a diagnostic on STDERR
                // (what a real Worker does for `bad inbound line`), then a
                // quiet settle — the ONLY observation is the log line.
                "__stderr__" => {
                    eprintln!("fake worker: a diagnostic on stderr");
                    emit(
                        &mut stdout,
                        &Outbound::Event {
                            event: RpcEvent::agent_settled,
                        },
                    );
                }
                // The default prompt (the canned turn — the full
                // event + store-frame + `SinkFrame` stream).
                _ => {
                    emit_canned_turn(&mut stdout, &sid, &incarnation);
                }
            },
            // The `SubagentResult` (the Supervisor's delivery — the
            // `IpcDispatcher` waiter resolves; the fixture's
            // `subagent-result-ack` `SinkFrame` is the round-trip
            // observation point — the `outcome` rides verbatim).
            Inbound::SubagentResult { id, outcome } => {
                emit(
                    &mut stdout,
                    &Outbound::SinkFrame {
                        event: "subagent-result-ack".to_string(),
                        payload: serde_json::json!({
                            "id": id,
                            "outcome": serde_json::to_value(&outcome).unwrap_or_default()
                        }),
                    },
                );
            }
            // The `close` — the Worker self-exits 0 (the Supervisor
            // does NOT close the stdin pipe on `close`).
            Inbound::Close => std::process::exit(0),
            // The `config` — echo the frame (a `config-ack` `SinkFrame`
            // — the `set_space_trusted` mid-session trust-toggle test's
            // delivery observation point: the `trusted` flag rides
            // verbatim; the `model` / `thinking` fields ride when set).
            Inbound::Config {
                model,
                thinking,
                trusted,
            } => {
                let mut payload = serde_json::json!({
                    "sessionId": sid,
                    "trusted": trusted
                });
                if let Some(m) = model {
                    payload["model"] = serde_json::to_value(&m).unwrap_or_default();
                }
                if let Some(t) = thinking {
                    payload["thinking"] = serde_json::Value::String(t);
                }
                emit(
                    &mut stdout,
                    &Outbound::SinkFrame {
                        event: "config-ack".to_string(),
                        payload,
                    },
                );
            }
            // The `/compact` command (ADR 0044): WITHOUT this arm the
            // `_ => {}` catch-all swallows it, so the IPC-parity fixture would
            // silently ignore a frame the real Worker forwards to its loop.
            // STDERR is the fixture's observation point for what arrived
            // (stdout is the protocol stream — a non-frame line there would
            // corrupt it; the Supervisor drains stderr to the debug log).
            Inbound::Compact { instructions } => {
                eprintln!("fake worker: compact requested (instructions: {instructions:?})");
            }
            // `abort` / a `permission-response` to an unknown id / an
            // `interactive-response` / an unknown `type`: no response
            // (the fixture is permissive).
            _ => {}
        }
    }
    // stdin EOF — the Supervisor is gone (exit 0 — the clean-EOF
    // path).
}
