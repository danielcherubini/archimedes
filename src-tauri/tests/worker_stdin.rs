//! The Worker's stdin read loop must never LOSE a frame whose bytes
//! arrive across several reads.
//!
//! The bug this guards (`run_worker_inner`'s stdin arm): the
//! `read_line` future lived inside the Worker's main `tokio::select!`,
//! beside the `outbound_rx` arm. tokio's `read_line` is NOT
//! cancellation-safe — `read_until_internal` `consume`s every byte it
//! has seen into the future's OWN buffer and returns `Pending` when the
//! delimiter has not arrived yet — so a `select!` that picks the other
//! arm DROPS those bytes with the future.
//!
//! That is exactly a subagent dispatch: the Supervisor writes `start`
//! and `prompt` back to back (no human delay like a main session's
//! first prompt), and handling `start` pushes the seq-0 system-prompt
//! `transcript-insert` onto `outbound_rx` — so the arm is ready at the
//! very moment a `prompt` frame LARGER than the pipe's atomic-write
//! bound (`PIPE_BUF`, 4 KiB) is mid-delivery. The half-read `prompt`
//! vanished, the child never started its turn, no `agent_settled` ever
//! came, and the parent's `subagent` tool call hung on "Starting…" until
//! the **Dead bound**. (A `prompt` under 4 KiB is written atomically,
//! which is why only the long subagent tasks hung.)

use std::sync::{Arc, Mutex};
use std::time::Duration;

use archimedes_lib::agent::harness::catalog::{Model, ModelCatalog};
use archimedes_lib::agent::worker::protocol::{
    decode_outbound, encode_inbound, Inbound, StartEnv, StartMode,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// A model whose provider cannot answer (the turn only has to START —
/// the frame that proves the prompt reached the loop is emitted before
/// the model call).
fn model() -> Model {
    Model {
        id: "m1".to_string(),
        provider: "fake".to_string(),
        base_url: "http://127.0.0.1:1/v1".to_string(),
        api_key: "k".to_string(),
        context_window: 100_000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: Some("openai-completions".to_string()),
    }
}

/// Spawn the built binary in Worker mode (the `worker_smoke` shape) with
/// STDERR CAPTURED — the Supervisor pipes it to `/dev/null`, which is
/// exactly why a swallowed inbound frame was invisible.
fn spawn_worker() -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_archimedes"));
    cmd.arg("--worker");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd
}

/// Read the first stdout line (the `ready` frame) off the SHARED reader
/// (the same reader then feeds the frame collector — taking `stdout`
/// twice would close the pipe).
async fn read_ready_line(reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>) {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(15), reader.read_line(&mut line))
        .await
        .expect("the ready line arrives within the bound")
        .expect("stdout is readable");
    let v: Value = serde_json::from_str(line.trim()).expect("the ready line is JSON");
    assert_eq!(v["type"], "ready");
}

/// A `start` envelope (the subagent shape — `FreshChild` + a `system_prompt`,
/// which is what makes the Worker emit the seq-0 `transcript-insert`
/// that races the inbound `prompt`).
fn subagent_start(session_id: &str, cwd: &str) -> StartEnv {
    StartEnv::from_parts(
        session_id.to_string(),
        cwd.to_string(),
        StartMode::FreshChild,
        None,
        model(),
        ModelCatalog {
            models: vec![model()],
            ..Default::default()
        },
        None,
        true,
        Some(vec!["bash".to_string()]),
        cwd.to_string(),
        false,
        Some("the subagent system prompt".to_string()),
    )
}

/// `start` then a `prompt` whose frame dwarfs the pipe's atomic-write
/// bound, written back to back exactly as the Supervisor's drive task
/// writes them: the prompt MUST reach the loop (the `turn_start` event
/// and the `user` transcript row are the proof).
#[tokio::test]
async fn a_prompt_larger_than_the_pipe_bound_reaches_the_loop() {
    // The child's `StartEnv` cwd, OWNED (#96 task 06). Declared FIRST so it
    // drops LAST — after the `child.kill().await` reap below, which is a
    // statement and so runs before any local's `Drop` at scope exit.
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("worker-stdin-", "cwd");

    let mut child = spawn_worker().spawn().expect("the worker starts");
    let mut reader = tokio::io::BufReader::new(child.stdout.take().expect("stdout is piped"));
    read_ready_line(&mut reader).await;

    // The Worker's stderr (drained, so a chatty Worker cannot deadlock
    // on a full pipe).
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let stderr_lines = stderr_lines.clone();
        let mut er = tokio::io::BufReader::new(child.stderr.take().expect("stderr is piped"));
        tokio::spawn(async move {
            let mut l = String::new();
            while let Ok(n) = er.read_line(&mut l).await {
                if n == 0 {
                    break;
                }
                let t = l.trim_end().to_string();
                l.clear();
                stderr_lines
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(t);
            }
        });
    }

    // The frames the Worker emits (read CONCURRENTLY with the writes —
    // a full stdout pipe would otherwise deadlock the Worker).
    let frames: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let frames = frames.clone();
        tokio::spawn(async move {
            let mut line = String::new();
            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 {
                    break;
                }
                let l = line.trim().to_string();
                line.clear();
                if l.is_empty() {
                    continue;
                }
                if let Ok(f) = decode_outbound(&l) {
                    frames
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(serde_json::to_value(&f).unwrap_or(Value::Null));
                }
            }
        });
    }

    // A ~256 KiB task: far past the 64 KiB pipe buffer, so the write is
    // delivered in pieces and the Worker's `read_line` cannot help but
    // see a partial line.
    let task = "x".repeat(256 * 1024);
    let start = encode_inbound(&Inbound::Start(Box::new(subagent_start(
        "s-stdin",
        dir.to_str().unwrap(),
    ))));
    let prompt = encode_inbound(&Inbound::Prompt {
        text: task,
        images: Vec::new(),
    });

    // The writes (the drive task's shape: one writer, one line at a time,
    // flushed, back to back). The writer PARKS with `stdin` still open
    // after the flush — the Worker exits on `close`, not on the input, so
    // dropping the handle here would be an EOF that ends the Worker
    // before it ever sees the prompt.
    let mut stdin = tokio::io::BufWriter::new(child.stdin.take().expect("stdin is piped"));
    let writer = tokio::spawn(async move {
        stdin.write_all(start.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
        stdin.write_all(prompt.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
        // Park forever (the test aborts this task, which drops `stdin`).
        std::future::pending::<()>().await;
    });

    // The proof the prompt reached the loop.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let seen = frames.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let started = seen.iter().any(|f| {
            f["event"]["type"].as_str() == Some("turn_start")
                || (f["type"].as_str() == Some("transcript-insert")
                    && f["role"].as_str() == Some("user"))
        });
        if started {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            let kinds: Vec<String> = seen
                .iter()
                .map(|f| {
                    format!(
                        "{}/{}",
                        f["type"].as_str().unwrap_or("?"),
                        f["event"]["type"].as_str().unwrap_or("-")
                    )
                })
                .collect();
            let err = stderr_lines
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .join("\n");
            panic!(
                "the oversized prompt never reached the loop (the stdin reader lost it);\n\
                 frames seen: {kinds:?}\n\nworker stderr:\n{err}"
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    writer.abort();
    let _ = child.kill().await;
}
