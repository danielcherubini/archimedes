//! The native session e2e (ADR 0025 Task 4): `start_session` spawns a
//! WORKER (the `AgentLoop` runs in the Worker process — the
//! `set_provider_factory` in-process mock `Provider` CANNOT survive, the
//! provider lives in the Worker process; the rewrite drives via the
//! `WorkerFactory` seam with the `fake_worker` fixture — the canned
//! `SinkFrame` / store-frame stream) → `send_prompt` → the
//! `session-update` `SinkFrame`s flow (the frozen shapes, re-emitted
//! verbatim) + the store frames are persisted (the `TranscriptPersister`)
//! → `resume_session` (the native branch — the `native_messages` re-read)
//! → the resumed session operates normally.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use archimedes_lib::agent::harness::{CompactionConfig, Model, ModelCatalog};
use archimedes_lib::agent::worker::client::WorkerHandle;
use archimedes_lib::agent::worker::manager::{WorkerFactory, WorkerManager};
use archimedes_lib::agent::{EventSink, SessionInfo, SessionManager, StopReason};
use archimedes_lib::storage::Db;
use archimedes_lib::test_support::is_incarnation_stamp;
use serde_json::{json, Value};
use tokio::sync::mpsc;

// ── the `fake_worker` fixture factory (the `WorkerFactory` seam) ──────────

/// The `fake_worker` fixture (the `WorkerFactory` seam — `cargo test`
/// builds the bin targets; the fixture speaks the Worker protocol: the
/// canned `SinkFrame` / store-frame stream, the `ready` handshake).
struct FixtureFactory;

impl WorkerFactory for FixtureFactory {
    fn spawn(&self) -> Result<WorkerHandle, archimedes_lib::agent::worker::client::WorkerError> {
        WorkerHandle::spawn(&fixture_path())
    }
}

/// The `fake_worker` fixture path (the `CARGO_MANIFEST_DIR`/
/// `target/debug` convention — `cargo test` builds the bin targets).
fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/debug/fake_worker"
    ))
}

// ── a recording `EventSink` ──────────────────────────────────────────────

struct RecSink {
    tx: mpsc::UnboundedSender<(String, Value)>,
}

impl EventSink for RecSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.tx.send((event.to_string(), payload));
    }
}

// ── the fixtures ──────────────────────────────────────────────────────────

/// A temp config dir (the `settings.json` home — the seeded settings give
/// the session start a `defaultThinkingLevel` — the settings-driven rung),
/// OWNED (#96 task 06): the guard removes the dir and its `settings.json`
/// and `archimedes.db` when it drops.
fn temp_config_dir() -> archimedes_lib::test_support::ScratchDir {
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("session-native-", "cfg");
    std::fs::write(
        dir.join("settings.json"),
        json!({ "theme": "dark", "defaultThinkingLevel": "high" }).to_string(),
    )
    .unwrap();
    dir
}

/// A full `Model` literal (the `base_url` EMPTY so
/// `refresh_model_metadata` is a no-op — no network;
/// `openai-completions` so the model is selectable).
fn test_model(id: &str) -> Model {
    Model {
        id: id.to_string(),
        provider: "fake".to_string(),
        base_url: String::new(),
        api_key: "k".to_string(),
        context_window: 128000,
        cost_per_mtok_in: 0.0,
        cost_per_mtok_out: 0.0,
        supports_tools: true,
        supports_thinking: true,
        thinking_levels: vec!["low".to_string(), "high".to_string()],
        api: Some("openai-completions".to_string()),
    }
}

/// A known catalog (the `set_catalog` seam — the base catalog is empty
/// in a test, so the effective catalog is this one): two
/// OpenAI-compatible models, the default `fake/m1`.
fn test_catalog() -> ModelCatalog {
    ModelCatalog {
        models: vec![test_model("m1"), test_model("m2")],
        default_model: Some("fake/m1".to_string()),
        compaction: CompactionConfig::default(),
    }
}

/// The e2e manager (ADR 0025 — the Worker-mediated path): `set_catalog`
/// (a known catalog) + a `WorkerManager` with the `fake_worker` factory
/// (the LATE-WIRE — the `SessionManager` ↔ `WorkerManager` construction
/// cycle: the `WorkerManager`'s `on_crash` / `on_event` callbacks capture
/// the `Arc<SessionManager>`; the `attach_*` methods are `&self`, so the
/// `OnceLock` `set` needs no exclusive access).
fn build_manager(
    dir: &Path,
    sink: &Arc<dyn EventSink>,
) -> (Arc<SessionManager>, Arc<WorkerManager>, Arc<Db>) {
    let db = Arc::new(Db::open(&dir.join("archimedes.db")).unwrap());
    let mut manager = SessionManager::new(dir.to_path_buf());
    manager.attach_db(db.clone());
    manager.set_catalog(test_catalog());
    manager.set_sink(sink.clone());
    let manager = Arc::new(manager);
    let wm = {
        let m = manager.clone();
        let m2 = manager.clone();
        Arc::new(WorkerManager::new(
            Arc::new(FixtureFactory),
            Arc::new(move |s, c, p| m.handle_crash(&s, c, p)),
            Arc::new(move |s, b, e| m2.route_event(&s, b, e)),
            Arc::new(|_s| None),
        ))
    };
    manager.attach_worker_manager(wm.clone());
    (manager, wm, db)
}

/// Wait for a `session-update` frame with the given `sessionUpdate` kind.
async fn wait_for_update(rx: &mut mpsc::UnboundedReceiver<(String, Value)>, kind: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if std::time::Instant::now() > deadline {
            panic!("timeout waiting for a {kind} frame");
        }
        let (event, payload) = tokio::time::timeout(Duration::from_millis(200), rx.recv())
            .await
            .expect("the sink channel stayed open")
            .expect("a frame arrived");
        if event == "session-update" && payload["update"]["sessionUpdate"] == kind {
            return payload["update"].clone();
        }
    }
}

/// Drain the sink channel (clear pending frames — a prior turn's leftover
/// `agent_message_chunk` must not be confused with the next turn's frames).
/// The `send_prompt` resolved on `agent_settled` (the LAST frame the
/// `fake_worker` emits), so the turn's frames are all in the channel by
/// the time the drain runs — the short settle window covers the delivery
/// gap (the frames are emitted in order, `agent_settled` last).
async fn drain(rx: &mut mpsc::UnboundedReceiver<(String, Value)>) {
    tokio::time::sleep(Duration::from_millis(100)).await;
    while rx.try_recv().is_ok() {}
}

/// (a) The full native-session e2e (ADR 0025 — the Worker-mediated path):
/// start (the `AgentLoop` runs in the Worker — NO in-process loop) → the
/// capability envelope has NO `piSessionFile` + the synthesized
/// `config_options` (model + thought_level) are present → `send_prompt` →
/// the `session-update` `SinkFrame`s flow (re-emitted verbatim) + the
/// store frames are persisted (the `native_messages` transcript + the
/// `messages` display rows) → `resume_session` (the native branch — NOT
/// `NotResumable` — the `native_messages` re-read) → the resumed session
/// operates normally (a fresh `fake_worker` + re-hydrate) → and the TWO
/// incarnations' `agent-text` display rows COEXIST, one per Worker life
/// (ADR 0049).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn native_session_end_to_end() {
    let dir = temp_config_dir();
    let (sink_tx, mut sink_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(RecSink { tx: sink_tx });
    let (manager, _wm, _db) = build_manager(&dir, &sink);

    // The base catalog is empty in a test → the model resolves from the
    // `set_catalog` catalog's default (`fake/m1`).
    let info = manager
        .start_session(dir.to_path_buf(), &sink)
        .await
        .expect("the native session starts (a Worker spawned — no in-process loop)");
    assert!(
        info.session_id.starts_with("arch_"),
        "a fresh native session ID starts with arch_, got {}",
        info.session_id
    );
    let sid = info.session_id.clone();

    // (1) The capability envelope: NO `piSessionFile` (resume is from the
    // `native_messages` table) + `loadSession: true` (the Resume button) +
    // the resolved model.
    assert!(
        info.capabilities.get("piSessionFile").is_none(),
        "a native session has no pi session file, got {:?}",
        info.capabilities
    );
    assert_eq!(info.capabilities["loadSession"], true);
    assert_eq!(info.capabilities["model"], "fake/m1");

    // (2) The synthesized `config_options` (the existing shape — the
    // frontend is unchanged): a model selector (the `selectable()`
    // ids `"<provider>/<id>"`) + a thought_level selector (the model's
    // `thinking_levels`; the built-in's default `high`).
    let options = info
        .config_options
        .expect("the native session synthesizes config options");
    let model_opt = options
        .iter()
        .find(|o| o["id"] == "model")
        .expect("a model selector");
    assert_eq!(model_opt["currentValue"], "fake/m1");
    let model_values: Vec<String> = model_opt["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["value"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(model_values, vec!["fake/m1", "fake/m2"]);
    let thought_opt = options
        .iter()
        .find(|o| o["id"] == "thought_level")
        .expect("a thought_level selector");
    assert_eq!(
        thought_opt["currentValue"], "high",
        "the built-in's default thinking level"
    );
    let thought_values: Vec<String> = thought_opt["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["value"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(thought_values, vec!["low", "high"]);

    // (3) The turn: `send_prompt` → the `session-update` `SinkFrame`s flow
    // (re-emitted VERBATIM — the SAME frozen shapes) + `EndTurn` (the
    // `agent_settled` settle).
    //
    // Before the turn: the FIRST incarnation's stamp, read off the start
    // envelope echo (ADR 0049). The resume below spawns a NEW Worker, which
    // must carry a DIFFERENT stamp.
    let first_env = wait_for_update(&mut sink_rx, "session_info").await;
    let stamp_a = first_env["incarnation"]
        .as_str()
        .expect("the start envelope echoes its incarnation stamp")
        .to_string();
    // The shape is pinned by the SAME predicate the `protocol` unit test uses
    // (`test_support::is_incarnation_stamp` — six chars, LOWERCASE, and the
    // `[0-9a-f]` byte set): `len() == 6` + a radix parse also accepts
    // `A3F9C1`, and lowercase is part of ADR 0049's contract.
    assert!(
        is_incarnation_stamp(&stamp_a),
        "the stamp is six LOWERCASE hex chars, got {stamp_a:?}"
    );

    let reason = manager
        .send_prompt(&sid, "hi".to_string())
        .await
        .expect("the native turn resolves");
    assert_eq!(reason, StopReason::EndTurn);
    let chunk = wait_for_update(&mut sink_rx, "agent_message_chunk").await;
    assert_eq!(
        chunk["content"]["text"], "canned ",
        "the first canned chunk"
    );

    // (4) The transcript (the `native_messages` table — the store frames
    // applied by the `TranscriptPersister`): the user + assistant rows
    // (the `fake_worker`'s canned `TranscriptInsert` frames) + the display
    // row (the `DisplayUpsert` frame — the `messages` table).
    let db = Db::open(&dir.join("archimedes.db")).unwrap();
    let rows = db.load_native_messages(&sid).unwrap();
    let roles: Vec<Value> = rows
        .iter()
        .map(|c| serde_json::from_str(c).unwrap())
        .collect();
    assert!(
        roles.iter().any(|v| v["role"] == "user"),
        "the user transcript row is persisted, got {roles:?}"
    );
    assert!(
        roles.iter().any(|v| v["role"] == "assistant"),
        "the assistant transcript row is persisted, got {roles:?}"
    );
    let msgs = db.messages_for(&sid).unwrap();
    assert!(
        msgs.iter().any(|m| m.kind == "agent-text"),
        "the display row is persisted, got {msgs:?}"
    );

    // (5) Close + RESUME (the native branch — the `native_messages`
    // re-read: NOT `NotResumable`).
    //
    // `stamp_a` is the FIRST Worker's stamp; the resume below spawns a SECOND
    // Worker (life B) which re-reads the transcript and starts its counters
    // from zero — so both lives mint `:m1` for one `session_id`. What keeps
    // them apart is the stamp, and the assertion at the END of this test is
    // what proves it (one display row per incarnation, coexisting).

    manager.close_session(&sid).await.expect("close works");
    let resumed = manager
        .resume_session(&sid, dir.to_path_buf(), &sink)
        .await
        .expect("a native session resumes from the native_messages table (not NotResumable)");

    // The RESUMED Worker's own stamp (ADR 0049) — two Worker processes
    // spawned for one Session are two incarnations. Read BEFORE the `drain`
    // below (which discards everything pending — this frame is already in the
    // channel). The display KEYS carry this stamp: the `fake_worker` fixture
    // namespaces its canned `DisplayUpsert` key with the stamp its `StartEnv`
    // carried, exactly as `normalize` namespaces every id the real harness
    // mints — so the coexistence assertion at the end of the test is the row-
    // level counterpart of `normalize_tests`' seam test.
    let second_env = wait_for_update(&mut sink_rx, "session_info").await;
    let stamp_b = second_env["incarnation"]
        .as_str()
        .expect("the resumed start envelope echoes its incarnation stamp")
        .to_string();
    assert!(
        is_incarnation_stamp(&stamp_b),
        "the resumed stamp is six LOWERCASE hex chars, got {stamp_b:?}"
    );
    assert_ne!(
        stamp_a, stamp_b,
        "a resumed Worker is a NEW incarnation and must not inherit the stamp"
    );

    assert_eq!(resumed.session_id, sid);
    assert!(
        resumed.capabilities.get("piSessionFile").is_none(),
        "the resumed native session has no pi session file"
    );

    // (6) The resumed session operates normally (a fresh `fake_worker` +
    // re-hydrate — the `StartEnv` carries the re-read transcript): the
    // turn's `agent_message_chunk` frame flows. The channel is DRAINED
    // first (turn 1's leftover `answer` chunk — the `send_prompt` resolved
    // on `agent_settled`, the LAST frame, so the leftover is in the
    // channel by now) so the fresh `canned ` chunk is the first the wait
    // finds.
    drain(&mut sink_rx).await;
    let reason = manager
        .send_prompt(&sid, "again".to_string())
        .await
        .expect("the resumed turn resolves");
    assert_eq!(reason, StopReason::EndTurn);
    let resumed_chunk = wait_for_update(&mut sink_rx, "agent_message_chunk").await;
    assert_eq!(
        resumed_chunk["content"]["text"], "canned ",
        "the resumed turn's first canned chunk"
    );

    // (ADR 0049) TWO INCARNATIONS COEXIST in one display table. Life A (the
    // first Worker) and life B (the resumed Worker) BOTH counted to `m1` for
    // the SAME `session_id`, so the display store's
    // `UNIQUE(session_id, kind, message_key)` sees two DIFFERENT keys and
    // keeps one row per life. This is what gives the assertion its teeth:
    // drop the stamp from the key the id-minter builds and life A's
    // `{stamp_a}:m1` is simply GONE (life B UPSERTs over the one shared row);
    // make `mint_incarnation` constant and the two lives share one stamp — the
    // `assert_ne!(stamp_a, stamp_b)` above is what fires first, and the shared
    // key (hence a 1-row table instead of 2) is what that inequality protects.
    //
    // The poll is the house bounded wait (100 × 50 ms — `tests/worker_e2e.rs`):
    // the resumed turn's `DisplayUpsert` is persisted ASYNCHRONOUSLY, so a
    // single read could land before life B has written anything.
    let key_life_a = format!("{stamp_a}:m1");
    let key_life_b = format!("{stamp_b}:m1");
    let mut expected_keys = vec![key_life_a.clone(), key_life_b.clone()];
    expected_keys.sort();
    let mut agent_text_keys: Vec<String> = Vec::new();
    for _ in 0..100 {
        agent_text_keys = db
            .messages_for(&sid)
            .unwrap()
            .into_iter()
            .filter(|m| m.kind == "agent-text")
            .map(|m| m.message_key.unwrap_or_default())
            .collect();
        // Wait for the EXACT set, not just for both keys to appear. Breaking on
        // the two membership checks would let the compare below run at whatever
        // instant the second key landed, so a hypothetical third `agent-text`
        // row would pass or fail depending on whether it had been persisted
        // yet. Waiting for the whole set makes an extra row fail DETERMINISTICALLY,
        // after the bounded wait, with the keys printed.
        let mut seen = agent_text_keys.clone();
        seen.sort();
        if seen == expected_keys {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The two membership checks FIRST, and named per life: when the pair is
    // not both present, the message has to say WHICH life vanished — A's key
    // was overwritten and B never wrote are different bugs.
    assert!(
        agent_text_keys.contains(&key_life_a),
        "life A's display row ({key_life_a}) is gone — life B wrote into its \
         key, so the ids are not namespaced by incarnation; the agent-text \
         keys are {agent_text_keys:?}"
    );
    assert!(
        agent_text_keys.contains(&key_life_b),
        "life B's display row ({key_life_b}) never appeared — the resumed \
         Worker wrote no row of its own; the agent-text keys are \
         {agent_text_keys:?}"
    );
    // And EXACTLY these two rows, nothing else in the `agent-text` family.
    // Sorted so the comparison is read-order-independent, and an EXACT value
    // rather than a suffix matcher: `filter(|k| k.ends_with(":m1")).count()
    // == 2` passed while a THIRD unstamped row (`m1`) sat in the table, and
    // it could not see an extra `agent-text` row whose key does not end in
    // `:m1` at all (the repo rule: an id assertion changes to a different
    // EXACT value, never to `contains` / `ends_with`).
    agent_text_keys.sort();
    assert_eq!(
        agent_text_keys, expected_keys,
        "two incarnations of one session must hold EXACTLY two `agent-text` \
         rows — one per Worker life, and no other `agent-text` row in the \
         table; the agent-text keys are {agent_text_keys:?}"
    );

    let _ = manager.close_session(&sid).await;
}

/// A legacy session whose stored ID is a bare UUID (no `arch_` prefix)
/// retains its exact ID when resumed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resuming_legacy_bare_uuid_session_preserves_id() {
    let dir = temp_config_dir();
    let (sink_tx, mut sink_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn EventSink> = Arc::new(RecSink { tx: sink_tx });
    let (manager, _wm, _db) = build_manager(&dir, &sink);

    let legacy_id = uuid::Uuid::new_v4().to_string();
    assert!(
        !legacy_id.starts_with("arch_"),
        "legacy id has no arch_ prefix: {legacy_id}"
    );

    // Seed the DB with a legacy session record (the stored `model` —
    // `fake/m1` — resolves against the catalog) + a system prompt in
    // `native_messages` (the resume's re-read).
    let db = Db::open(&dir.join("archimedes.db")).unwrap();
    let info = SessionInfo {
        session_id: legacy_id.clone(),
        cwd: dir.to_path_buf(),
        capabilities: json!({
            "model": "fake/m1",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();
    db.insert_native_message(
        &legacy_id,
        0,
        "system",
        r#"{"role":"system","content":"legacy system prompt"}"#,
    )
    .unwrap();

    let resumed = manager
        .resume_session(&legacy_id, dir.to_path_buf(), &sink)
        .await
        .expect("legacy session resumes");
    assert_eq!(
        resumed.session_id, legacy_id,
        "the resumed session preserves its exact legacy bare-UUID ID"
    );

    // The resumed session operates normally under the legacy ID (a fresh
    // `fake_worker` + re-hydrate — the `native_messages` re-read).
    let reason = manager
        .send_prompt(&legacy_id, "hello legacy".to_string())
        .await
        .expect("turn completes");
    assert_eq!(reason, StopReason::EndTurn);
    let chunk = wait_for_update(&mut sink_rx, "agent_message_chunk").await;
    assert_eq!(chunk["content"]["text"], "canned ");

    let _ = manager.close_session(&legacy_id).await;
}
