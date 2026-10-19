//! The Worker process (ADR 0025 Task 2): the desktop's own binary
//! re-entered with `--worker` — one session's `AgentLoop` over a
//! stdio JSONL protocol with the Supervisor.
//!
//! The Tauri runtime NEVER starts in a Worker (`main` checks the flag
//! before the Tauri init). The Worker: installs the crash-logging
//! panic hook (tag `"worker"`), builds the `WorkerCore`, emits
//! `Ready`, then observes three things concurrently — the `events_rx`
//! pump task (each `RpcEvent` → an `Outbound::Event` frame on stdout),
//! the crash-watch task (the loop `JoinHandle` — `Err` (a panic — the
//! hook already wrote the crash log) → a best-effort `WorkerError`
//! frame + `std::process::exit(1)`; a panic in a `tokio::spawn`'d task
//! is otherwise SWALLOWED by tokio, and without this watch a panicked
//! loop would leave the Worker running forever with a dead loop), and
//! the inbound frame stream (the `spawn_stdin_reader` THREAD reads the
//! lines → `decode_inbound` → `core.handle` → the outbound frames to
//! stdout). Exit 0 when the core is closed or stdin hits EOF.

pub mod client;
pub mod core;
pub mod dispatch;
pub mod manager;
pub mod protocol;
pub mod sink;
pub mod store;

pub use client::{WorkerError, WorkerErrorKind, WorkerHandle, WorkerInboundEvent};
pub use core::{default_build_loop, LoopControl, LoopHandles, WorkerCore};
pub use dispatch::IpcDispatcher;
pub use manager::{
    ClosureHooks, SubagentCapture, WorkerFactory, WorkerHooks, WorkerManager,
    DEFAULT_SUBAGENT_DEAD_BOUND,
};
pub use protocol::{
    decode_inbound, decode_outbound, encode_inbound, encode_outbound, Inbound, Outbound,
    ProtoError, StartEnv, StartMode, StoreFrame, SubagentDispatchWire,
};
pub use sink::IpcEventSink;
pub use store::IpcStore;

use std::io::BufRead;

use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

/// The Worker main (the `run_worker` entry's async half — the stdio
/// JSONL loop over the `WorkerCore`).
pub async fn run_worker_inner() {
    // The directory is resolved HERE, at install time, and handed to the
    // hook — the hook resolves nothing during the panic. A `None` data
    // dir is not a supported state (the Supervisor's `setup()` hard-fails
    // on it), so skipping the hook here is belt-and-braces, not a mode.
    if let Some(base) = dirs::data_dir() {
        crate::agent::crashlog::install_panic_hook("worker", base.join("archimedes"));
    }
    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<Outbound>();
    let (mut core, _inbound_tx) = WorkerCore::new(outbound_tx);
    // The stdout writer (the two producers — the pump task and the main
    // loop — serialized; the TOKIO `Stdout` (the async type — `io-std`
    // feature) behind the `Mutex`).
    let stdout = std::sync::Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    // The pump task's completion signal (the `events_rx` channel
    // closed — the loop task ended; a no-op: the `closed` / stdin-EOF
    // conditions decide exit). An `mpsc` (NOT a oneshot — the `select!`
    // arms must be re-pollable across loop iterations) + a guard flag
    // (a closed + empty channel would otherwise fire the arm forever —
    // the guard disables it after the first fire).
    let (pump_done_tx, mut pump_done_rx) = tokio::sync::mpsc::channel(1);
    let mut pump_done_tx = Some(pump_done_tx);
    // The crash-watch's normal-end signal (the `JoinHandle` resolved
    // `Ok(())` — the normal loop end, e.g. after `Close`; a no-op: the
    // `closed` / stdin-EOF conditions decide exit — do NOT exit on
    // `Ok`). The `Err` (panic) path exits directly (the frame +
    // `std::process::exit(1)`).
    let (crash_ok_tx, mut crash_ok_rx) = tokio::sync::mpsc::channel(1);
    let mut crash_ok_tx = Some(crash_ok_tx);
    let mut pump_done = false;
    let mut crash_ok = false;

    // The `Ready` frame (the binary version — emitted at startup,
    // BEFORE `Start`).
    write_frame(
        &stdout,
        &Outbound::Ready {
            version: env!("CARGO_PKG_VERSION").to_string(),
            session_id: None,
        },
    )
    .await;

    // The inbound frames come from the `spawn_stdin_reader` THREAD — the
    // `read_line` deliberately does NOT live in this `select!` (see the
    // helper). The channel is unbounded: the only writer is the
    // Supervisor, and the OS pipe (64 KiB) bounds what can be in flight.
    let (inbound_tx, mut inbound_rx) = mpsc::unbounded_channel::<Inbound>();
    spawn_stdin_reader(std::io::stdin(), inbound_tx);
    loop {
        tokio::select! {
            // `mpsc::Receiver::recv` IS cancellation-safe (tokio's
            // `read_line` is NOT), so this arm may be dropped mid-poll
            // without losing a frame. `None` = the reader ended (the
            // stdin EOF / a read failure) — exit 0, the clean-EOF path.
            msg = inbound_rx.recv() => {
                let Some(msg) = msg else { break };
                for frame in core.handle(msg).await {
                    write_frame(&stdout, &frame).await;
                }
                // The `Close` — the Worker is done (exit 0; the `closed`
                // condition decides exit — the Supervisor does NOT close
                // the stdin pipe on `Close`):
                if core.is_closed() {
                    break;
                }
                // The loop just came up (the `Start`): spawn the pump task
                // (the `events_rx` moved out of the core) + the crash-watch
                // task (the `JoinHandle` — a panic in a `tokio::spawn`'d
                // task is otherwise SWALLOWED by tokio — surfaces only as a
                // `JoinError`; without this watch a panicked loop would
                // leave the Worker running forever with a dead loop — no
                // exit code, no `on_crash`, the session hangs instead of
                // stalling).
                // One loop per Worker — the `Option` `take`s make the
                // spawn-once provable (the compiler can't track the core's
                // state across loop iterations).
                if let Some((events_rx, task)) = core.take_pump() {
                    let pump_stdout = stdout.clone();
                    let pump_done_tx = pump_done_tx.take().expect(
                        "the pump sender is taken once",
                    );
                    tokio::spawn(async move {
                        let mut rx = events_rx;
                        while let Some(event) = rx.recv().await {
                            let frame = Outbound::Event { event };
                            let line = encode_outbound(&frame);
                            let mut w = pump_stdout.lock().await;
                            if w.write_all(line.as_bytes()).await.is_err()
                                || w.flush().await.is_err()
                            {
                                break; // stdout gone — the Supervisor is gone.
                            }
                        }
                        // The task's end drops the `pump_done_tx` sender
                        // (the `mpsc` channel closes — the `pump_done` arm
                        // fires once; `drop` of the send future is the
                        // clippy-clean no-op — the arm is a no-op anyway).
                        drop(pump_done_tx.send(()));
                    });
                    let crash_stdout = stdout.clone();
                    let crash_ok_tx = crash_ok_tx.take().expect(
                        "the crash-watch sender is taken once",
                    );
                    tokio::spawn(async move {
                        match task.await {
                            // `Ok(())` — the normal loop end (e.g. after
                            // `Close`): a no-op signal (the `closed` /
                            // stdin-EOF conditions decide exit — do NOT
                            // exit on `Ok`).
                            Ok(()) => {
                                // The task's end drops the `crash_ok_tx`
                                // sender (the channel closes — the arm
                                // fires once; `drop` of the send future is
                                // the clippy-clean no-op — the arm is a
                                // no-op anyway).
                                drop(crash_ok_tx.send(()));
                            }
                            // `Err` (a panic — the panic hook already
                            // wrote the crash log): best-effort
                            // `WorkerError` frame + a NON-ZERO exit (the
                            // Supervisor sees the crash via the exit code
                            // — the session stalls, the app lives).
                            Err(e) => {
                                let frame = Outbound::WorkerError {
                                    code: "worker_panic".to_string(),
                                    message: e.to_string(),
                                    backtrace: None,
                                };
                                let line = encode_outbound(&frame);
                                let mut w = crash_stdout.lock().await;
                                let _ = w.write_all(line.as_bytes()).await;
                                let _ = w.flush().await;
                                std::process::exit(1);
                            }
                        }
                    });
                }
                if core.is_closed() {
                    break; // the `Close` — exit 0.
                }
            }
            frame = outbound_rx.recv() => {
                // The store / sink frames (the `IpcStore` /
                // `IpcEventSink` / `IpcDispatcher` write them as the
                // loop runs — NOT only after a `handle` returns).
                match frame {
                    Some(f) => {
                        write_frame(&stdout, &f).await;
                    }
                    None => break, // the core's sender is gone.
                }
            }
            _ = pump_done_rx.recv(), if !pump_done => {
                // The loop's event stream ended (the loop task ended —
                // its `events` sender dropped). A no-op: the `closed`
                // / stdin-EOF conditions decide exit. The guard
                // disables the arm after the first fire (a closed +
                // empty channel would otherwise fire it forever).
                pump_done = true;
            }
            _ = crash_ok_rx.recv(), if !crash_ok => {
                // The loop task ended NORMALLY (`Ok(())` — e.g. after
                // the `Close` cancel). A no-op.
                crash_ok = true;
            }
        }
    }
}

/// The stdin line reader: a DEDICATED OS THREAD (not a task) that blocks
/// in `read_line` and forwards each decoded frame on the channel — the
/// stdin EOF / a read failure ends it, which drops the sender and ends
/// the main loop's arm.
///
/// WHY NOT A `select!` ARM: tokio's `read_line` is NOT cancellation-safe.
/// `read_until_internal` `consume`s every byte it has seen out of the
/// `BufReader` into the FUTURE'S OWN buffer, then returns `Pending` while
/// it waits for the delimiter — so a `select!` that picks another arm
/// mid-read DROPS those bytes with the future (tokio makes no
/// cancellation-safety claim for `read_line` / `read_until`).
/// `mpsc::Receiver::recv`, the arm the main loop races instead, IS
/// cancellation-safe.
///
/// The bug this prevents (a subagent stuck on "Starting…" until the
/// **Dead bound**): the Supervisor writes `start` and `prompt` BACK TO
/// BACK, and handling `start` pushes the seq-0 `transcript-insert` onto
/// `outbound_rx` — the competing arm is ready at exactly the moment a
/// `prompt` frame LARGER than the pipe's atomic-write bound (`PIPE_BUF`,
/// 4 KiB) is mid-delivery. The half-read `prompt` used to vanish with the
/// dropped future: no turn, no `agent_settled`, and no trace either — just
/// a `bad inbound line` on the Worker's stderr, which the Supervisor pipes
/// to `/dev/null`. And only the LONG subagent tasks hit it, which is what
/// made it look intermittent.
///
/// WHY A THREAD AND NOT A TASK: the read must never be cancelled, and
/// tokio's own `stdin` parks a BLOCKING-POOL task per pending read, which
/// `Runtime::drop` then waits for (that hung the Worker's `close` → exit-0
/// contract when this reader was a task). A plain thread blocked in
/// `std::io::stdin()` loses no bytes and does not hold the runtime down.
pub fn spawn_stdin_reader<R>(stdin: R, tx: mpsc::UnboundedSender<Inbound>)
where
    R: std::io::Read + Send + 'static,
{
    let _ = std::thread::Builder::new()
        .name("worker-stdin".to_string())
        .spawn(move || {
            let mut stdin = std::io::BufReader::new(stdin);
            let mut line = String::new();
            loop {
                line.clear();
                match stdin.read_line(&mut line) {
                    // stdin EOF (the clean-EOF path — the main loop exits 0).
                    Ok(0) => break,
                    Ok(_) => {
                        let line = line.trim_end_matches(['\n', '\r']).to_string();
                        if line.is_empty() {
                            continue;
                        }
                        match decode_inbound(&line) {
                            Ok(msg) => {
                                if tx.send(msg).is_err() {
                                    break; // the main loop is gone.
                                }
                            }
                            Err(e) => {
                                eprintln!("worker: bad inbound line: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("worker: stdin read failed: {e}");
                        break;
                    }
                }
            }
        });
}

/// Write one outbound frame to stdout (the shared writer — the pump
/// task and the main loop serialize on the `Mutex`).
async fn write_frame(
    stdout: &std::sync::Arc<tokio::sync::Mutex<tokio::io::Stdout>>,
    frame: &Outbound,
) {
    let line = encode_outbound(frame);
    let mut w = stdout.lock().await;
    if w.write_all(line.as_bytes()).await.is_err() || w.flush().await.is_err() {
        eprintln!("worker: stdout write failed (the Supervisor is gone?)");
    }
}
