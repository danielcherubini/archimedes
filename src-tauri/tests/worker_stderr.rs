//! A Worker's OWN diagnostics reach the `ARCHIMEDES_DEBUG` log.
//!
//! A Worker reports its failures on stderr — `bad inbound line`,
//! `prompt send failed`, a panic. While `WorkerHandle::spawn` piped stderr
//! to `/dev/null`, every one of those lines vanished, and the swallowed
//! frame that hung a whole subagent dispatch had to be diagnosed from the
//! DATABASE instead of from the one line the child printed at the moment
//! it broke. `spawn` pipes stderr now, and the drain task forwards each
//! line into the debug log.
//!
//! This binary runs ONE test, so the debug log's process-global state is
//! ours alone (no cross-test race on the `debuglog::init` global).

use std::time::Duration;

use archimedes_lib::agent::debuglog;
use archimedes_lib::agent::harness::catalog::{Model, ModelCatalog};
use archimedes_lib::agent::worker::client::WorkerHandle;
use archimedes_lib::agent::worker::protocol::{StartEnv, StartMode};

fn model() -> Model {
    Model {
        id: "m1".into(),
        provider: "fake".into(),
        base_url: "http://127.0.0.1:1/v1".into(),
        api_key: "k".into(),
        context_window: 100_000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: false,
        thinking_levels: Vec::new(),
        api: None,
    }
}

/// A `start` envelope (the fixture handles a `prompt` only once its
/// session has started).
fn start_env(session_id: &str) -> StartEnv {
    let cwd = std::env::temp_dir().display().to_string();
    StartEnv::from_parts(
        session_id.to_string(),
        cwd.clone(),
        StartMode::Fresh,
        None,
        model(),
        ModelCatalog {
            models: vec![model()],
            ..Default::default()
        },
        None,
        true,
        Some(vec!["bash".to_string()]),
        cwd,
        false,
        None,
        // (issue #101) `from_parts`' new trailing arg: this harness CONSTRUCTS
        // the envelope (no JSON), and no per-agent block is in play.
        None,
    )
}

#[tokio::test]
async fn a_worker_writes_its_own_diagnostics_to_the_debug_log() {
    let dir = tempfile::TempDir::new().unwrap();
    debuglog::init(true, Some(dir.path().to_path_buf()));

    let handle = WorkerHandle::spawn(std::path::Path::new(env!("CARGO_BIN_EXE_fake_worker")))
        .expect("the fixture spawns");
    handle
        .wait_ready(Duration::from_secs(15))
        .await
        .expect("the ready frame arrives");
    handle
        .send_start(&start_env("s-live"))
        .expect("the start frame is queued");

    // The fixture's `__stderr__` prompt: one line on stderr, nothing else.
    handle
        .send_prompt("__stderr__", &[])
        .expect("the prompt encodes");

    // The drain task runs beside the child, so poll: the marker arrives a
    // moment after the prompt (the IPC lines above prove the log itself is
    // alive from the first frame).
    let log = dir.path().join("supervisor.log");
    let marker = "worker-stderr: fake worker: a diagnostic on stderr";
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let text = loop {
        let now = std::fs::read_to_string(&log).unwrap_or_default();
        if now.contains(marker) || tokio::time::Instant::now() > deadline {
            break now;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        text.contains(marker),
        "the Worker's stderr line must reach the debug log, got:\n{text}"
    );

    let _ = handle.send_close();
    let _ = handle.kill().await;
}
