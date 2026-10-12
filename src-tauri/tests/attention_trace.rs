//! The attention countdown NAMES its own decisions in the `ARCHIMEDES_DEBUG`
//! log (the support question nobody could otherwise answer).
//!
//! A missing OS notification has three indistinguishable causes, and none of
//! them left a trace: the renderer never armed, the countdown expired while the
//! window was focused and was DROPPED (ADR 0038's one-shot — the silent path by
//! design), or delivery was attempted and the notification call failed and was
//! swallowed (`let _ = …show()`). A D-Bus capture can only say "no `Notify`
//! call" — it cannot tell a drop from a failed send. So every branch of the
//! countdown now logs one line, and this test pins the timeline those lines
//! form, because a support answer that is not reproducible is not an answer.
//!
//! Two rules this test guards:
//!   * the alert's TEXT never reaches the log (the plan's standing rule — the
//!     body carries the Session title, i.e. whatever the user was working on);
//!   * every line carries the `attention:` prefix, so one grep reconstructs
//!     the whole timeline.
//!
//! This binary runs ONE test, so the debug log's process-global state is ours
//! alone (no cross-test race on the `debuglog::init` global) — the same reason
//! `tests/worker_stderr.rs` is a one-test binary. The log is enabled through the
//! `init` seam with a temp dir, NOT through `ARCHIMEDES_DEBUG`, so this test
//! passes whatever the developer's shell happens to export.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use archimedes_lib::agent::debuglog;
use archimedes_lib::attention::{AlertText, AttentionTimer, Delivery, FocusProbe};

/// The alert text, chosen so a leak into the log is unmistakable.
const SECRET_TITLE: &str = "Archimedes";
const SECRET_BODY: &str = "api-server needs your answer — TRACE-MUST-NOT-LEAK";

/// Let the spawned countdown task reach its next await point (the paused clock
/// never advances on its own here — the same helper `attention.rs`'s tests use).
async fn settle() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

/// A timer whose focus answer is fixed and whose deliveries are recorded (no
/// window, no OS notification — the seams `attention.rs` exists to expose).
fn make_timer(focused: bool) -> (AttentionTimer, Arc<Mutex<Vec<AlertText>>>) {
    let delivered: Arc<Mutex<Vec<AlertText>>> = Arc::new(Mutex::new(Vec::new()));
    let focus: FocusProbe = Arc::new(move || focused);
    let sink = delivered.clone();
    let deliver: Delivery =
        Arc::new(move |t: &AlertText| sink.lock().expect("the recorder").push(t.clone()));
    (AttentionTimer::new(focus, deliver), delivered)
}

fn taken(recorder: &Arc<Mutex<Vec<AlertText>>>) -> Vec<AlertText> {
    recorder.lock().expect("the recorder").clone()
}

/// The written log (empty if nothing was written — a failure message then shows
/// the absence rather than panicking on the read).
fn logged(dir: &std::path::Path) -> String {
    std::fs::read_to_string(dir.join("supervisor.log")).unwrap_or_default()
}

/// The lines carrying BOTH needles (`attention:` lines are one decision each,
/// so a two-needle hit is a precise claim about one decision).
fn hits(content: &str, a: &str, b: &str) -> Vec<String> {
    content
        .lines()
        .filter(|l| l.contains(a) && l.contains(b))
        .map(str::to_string)
        .collect()
}

#[tokio::test]
async fn the_countdown_logs_every_decision_it_makes() {
    let dir = tempfile::TempDir::new().unwrap();
    debuglog::init(true, Some(dir.path().to_path_buf()));
    tokio::time::pause();

    // ---- arming: a fresh countdown, then one that TAKES THE SLOT ----------
    let (timer, got) = make_timer(false);
    timer
        .arm(
            Duration::from_millis(5_000),
            SECRET_TITLE.into(),
            SECRET_BODY.into(),
        )
        .expect("a runtime exists under #[tokio::test]");
    settle().await;
    timer
        .arm(
            Duration::from_millis(5_000),
            SECRET_TITLE.into(),
            SECRET_BODY.into(),
        )
        .expect("a runtime exists under #[tokio::test]");
    settle().await;

    // ---- disarm: once with something armed, once with nothing -------------
    timer.disarm();
    timer.disarm();

    // A disarmed countdown must not have fired while the clock ran past it.
    tokio::time::advance(Duration::from_millis(5_100)).await;
    settle().await;
    assert!(
        taken(&got).is_empty(),
        "a disarmed countdown delivers nothing"
    );

    // ---- expiry, unfocused: the alert is delivered ------------------------
    timer
        .arm(
            Duration::from_millis(5_000),
            SECRET_TITLE.into(),
            SECRET_BODY.into(),
        )
        .expect("a runtime exists under #[tokio::test]");
    settle().await;
    tokio::time::advance(Duration::from_millis(5_100)).await;
    settle().await;
    assert_eq!(taken(&got).len(), 1, "the unfocused expiry delivered once");

    // ---- expiry, focused: the alert is DROPPED (the silent path) ----------
    let (focused_timer, focused_got) = make_timer(true);
    focused_timer
        .arm(
            Duration::from_millis(5_000),
            SECRET_TITLE.into(),
            SECRET_BODY.into(),
        )
        .expect("a runtime exists under #[tokio::test]");
    settle().await;
    tokio::time::advance(Duration::from_millis(5_100)).await;
    settle().await;
    assert!(
        taken(&focused_got).is_empty(),
        "a focused user is never interrupted (ADR 0038)"
    );

    // ---- a caller with no runtime: the refusal is said out loud ------------
    // A thread of our own has no tokio context, which is exactly what a future
    // SYNC caller would be; `arm` must decline AND say so, since a declined arm
    // is otherwise indistinguishable from a renderer that never asked.
    std::thread::spawn(|| {
        let probe: FocusProbe = Arc::new(|| false);
        let quiet: Delivery = Arc::new(|_t: &AlertText| {});
        AttentionTimer::new(probe, quiet)
            .arm(
                Duration::from_millis(5_000),
                SECRET_TITLE.into(),
                SECRET_BODY.into(),
            )
            .expect_err("a caller with no runtime is refused, not panicked")
    })
    .join()
    .expect("the declined arm does not panic");

    // ==================== the timeline the log must tell ====================
    let log = logged(dir.path());

    // Every line is a countdown decision, and every one is greppable.
    for line in log.lines() {
        assert!(
            line.contains("attention:"),
            "every line this test produced must carry the `attention:` prefix, got {line:?}"
        );
    }

    // 1. Arming says it armed, with the delay it was given — the delay is what
    //    a "the alert never came" report is measured against. Four armings
    //    happened; three of them found an empty slot.
    let fresh = hits(&log, "armed", "replaced_pending=false");
    assert_eq!(
        fresh.len(),
        3,
        "every arming into an empty slot logs one line:\n{log}"
    );
    for line in &fresh {
        assert!(
            line.contains("delay_ms=5000"),
            "the armed line carries the countdown it was given, got {line:?}"
        );
    }
    // 2. Arming twice says the slot was taken over — the difference between
    //    "the renderer armed once" and "something re-armed and replaced it".
    //    (The fourth arming was on the SECOND timer, whose own slot was empty,
    //    so exactly one arming in this whole run replaced anything.)
    assert_eq!(
        hits(&log, "armed", "replaced_pending=true").len(),
        1,
        "the re-arm of the live countdown says it replaced a pending countdown:\n{log}"
    );

    // 3. Disarm distinguishes "user input killed a live countdown" from "input
    //    arrived with nothing armed" — the renderer sends both constantly.
    assert_eq!(
        hits(&log, "disarm", "pending=true").len(),
        1,
        "one disarm found something to abort:\n{log}"
    );
    assert_eq!(
        hits(&log, "disarm", "pending=false").len(),
        1,
        "one disarm found nothing armed:\n{log}"
    );

    // 4. THE PAIR THAT MATTERS: both expiry outcomes name themselves. Today the
    //    drop is completely silent, which is why "no notification" cannot be
    //    told apart from "no delivery".
    let fired = hits(&log, "expired", "focused=false");
    assert_eq!(
        fired.len(),
        1,
        "the unfocused expiry logs that it is delivering:\n{log}"
    );
    assert!(
        fired[0].contains("deliver"),
        "the unfocused expiry line says it delivers, got {:?}",
        fired[0]
    );
    let dropped = hits(&log, "expired", "focused=true");
    assert_eq!(
        dropped.len(),
        1,
        "the focused expiry logs that it DROPPED the alert:\n{log}"
    );
    assert!(
        dropped[0].contains("drop"),
        "the focused expiry line says it drops, got {:?}",
        dropped[0]
    );

    // 5. The standing rule: the alert's text never reaches a log. The armed
    //    lines carry the body's LENGTH so a blank alert is still visible.
    assert!(
        !log.contains(SECRET_BODY) && !log.contains("api-server"),
        "alert text must never reach the log:\n{log}"
    );
    let body_chars = SECRET_BODY.chars().count();
    assert!(
        log.contains(&format!("body_chars={body_chars}")),
        "the armed line carries the body's LENGTH ({body_chars}) instead of its text:\n{log}"
    );

    // 6. No expiry line was written for the disarmed countdown (the abort
    //    really killed the task, it did not merely hide its output).
    assert_eq!(
        log.lines().filter(|l| l.contains("expired")).count(),
        2,
        "exactly the two expiries that ran are logged:\n{log}"
    );

    // 7. The refusal names itself (4 armings that succeeded + this one).
    assert_eq!(
        hits(&log, "arm DECLINED", "no tokio runtime").len(),
        1,
        "a refused arm is a sentence in the log, not a missing line:\n{log}"
    );

    // 8. The timeline is COMPLETE, not merely non-empty: 4 armings, 1 refusal,
    //    2 disarms, 2 expiries.
    assert_eq!(
        log.lines().count(),
        9,
        "one line per decision the countdown took:\n{log}"
    );
}
