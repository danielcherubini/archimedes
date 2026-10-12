//! The attention countdown (ADR 0038/0039) — the Supervisor-side timer.
//!
//! The renderer decides WHEN to alert and WHAT the alert says; this module
//! only counts down. That split exists because Tauri throttles a backgrounded
//! webview (tauri-apps/tauri#5250) and a hidden or minimised window is this
//! feature's entire customer — a renderer-side `setTimeout` would simply never
//! fire in exactly the situation the feature is for.
//!
//! Rust is deliberately dumb: handed a delay and some text, it sleeps, asks
//! ONE question at expiry ("is the main window the focused window?"), and
//! either drops the alert or shows it. It reads no settings and knows no
//! Session vocabulary.
//!
//! Both external facts are injected seams ([`FocusProbe`], [`Delivery`]), so
//! the countdown is testable with no window and no OS notification. What the
//! seams DO in production — the session-bus send, the handle that has to be
//! kept alive, and the log line each delivery is allowed to write — is the
//! [`delivery`] submodule's business; this file stays the pure countdown.
//!
//! Every decision this countdown can take is narrated into the
//! `ARCHIMEDES_DEBUG` log with the `attention:` prefix — the timeline is pinned
//! by `tests/attention_trace.rs`. That is not decoration: "no notification
//! arrived" has three causes (never armed / dropped because the window was
//! focused / delivery failed), and a D-Bus capture cannot tell them apart,
//! while the DROP is silent BY DESIGN (ADR 0038). The log is the only place
//! where the three differ, so each branch names itself. Alert TEXT never
//! reaches the log — the body carries whatever the user was working on; only
//! its length is written.

use crate::agent::debuglog;

pub mod delivery;

/// The text of one attention alert — composed by the renderer, which owns
/// every scrap of session vocabulary (ADR 0039). Rust never interprets it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertText {
    pub title: String,
    pub body: String,
}

/// The seam answering "is the main window the focused window?" — a real one
/// reads the `WebviewWindow`, a test answers from a cell.
pub type FocusProbe = std::sync::Arc<dyn Fn() -> bool + Send + Sync + 'static>;
/// The seam that shows the alert. The real one is `attention::delivery::production`
/// — the session bus on Linux/BSD (where keeping the handle it gets back is what
/// keeps the alert on screen), `tauri-plugin-notification` elsewhere — and a test
/// answers from a cell.
///
/// The shape is deliberately still "take the text, return nothing": the timer must
/// not branch on what delivery learned, and what each transport learns about its
/// own send is [`delivery::Outcome`]'s business, not the timer's.
pub type Delivery = std::sync::Arc<dyn Fn(&AlertText) + Send + Sync + 'static>;

/// [`AttentionTimer::arm`] could not start a countdown: a countdown is a spawned
/// task, and the calling thread has no tokio runtime (`Handle`) to spawn it on.
///
/// A refusal and not a failure to fix: the caller reports it (the command turns
/// it into an `Err` the renderer logs) and the countdown simply never existed.
#[derive(Debug, PartialEq, Eq)]
pub struct NoRuntime;

/// The Supervisor's single attention countdown.
///
/// The `pending` SLOT holds exactly one handle, and arming replaces whatever is
/// stored there — so at most one countdown can ever DELIVER. "In flight" is
/// honestly a hair wider than that: `arm` spawns BEFORE it takes the lock, so
/// for the instant between the two there are two live tasks. Harmless — the new
/// one cannot deliver before its own deadline — and the price of never holding
/// a `std::sync::Mutex` guard across a spawn. Which pause owns the slot is the
/// renderer's rule (`src/lib/attention.ts`, R5), and it is a precedence ladder
/// rather than "last pause wins": within one Session a newer question never takes
/// the slot from an older question still open, while across Sessions the ladder
/// ranks by Session order, so a gate in a Session that ranks ahead does take it
/// (ADR 0040). The task itself is
/// fire-once-and-done — no retry, no re-arm, no repeat (ADR 0038's one-shot).
pub struct AttentionTimer {
    /// The in-flight countdown, if any. A `std::sync::Mutex` held ONLY across
    /// the take/abort/store — never across an await (which is why `arm` and
    /// `disarm` are sync methods).
    pending: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    focus: FocusProbe,
    deliver: Delivery,
}

impl AttentionTimer {
    pub fn new(focus: FocusProbe, deliver: Delivery) -> Self {
        Self {
            pending: std::sync::Mutex::new(None),
            focus,
            deliver,
        }
    }

    /// Take the slot from whatever countdown is stored there (aborting it),
    /// sleep `delay`, then fire — unless the window is focused at expiry, in
    /// which case the alert is DROPPED (ADR 0038: one-shot, never retried,
    /// never held for a later blur).
    ///
    /// `Err(`[`NoRuntime`]`)` when the current thread has no tokio runtime to
    /// hold the countdown; see the guard inside.
    pub fn arm(
        &self,
        delay: std::time::Duration,
        title: String,
        body: String,
    ) -> Result<(), NoRuntime> {
        // A spawn needs a runtime, and `arm` is sync so it cannot build one: the
        // ONLY caller today is the `async` command, which always runs inside
        // Tauri's singleton tokio runtime, but a future sync caller would not
        // (`RunEvent::Exit` builds its own throwaway runtime, and
        // `setup_dirs_with_factory` runs under `tauri::test`'s mock runtime in
        // `tests/ipc.rs`), and `tokio::spawn` with no reactor PANICS — inside a
        // command task the renderer would see only a rejected promise. Declining
        // is the same stance `agent/session/naming.rs` and
        // `agent/interactive/sudo_exec.rs` take for this exact call.
        //
        // Probed BEFORE the spawn and before the lock, so a declined arm leaves
        // an already-armed countdown untouched rather than silently aborting the
        // only alert that was live: nothing took the slot over, so its owner
        // keeps it.
        let handle = tokio::runtime::Handle::try_current().map_err(|_| {
            // A refusal is a decision the caller otherwise cannot explain from
            // the log, so it says so (the renderer's `logFailure` is
            // browser-console only, and the person diagnosing a silent desktop
            // does not have it).
            debuglog::log("attention: arm DECLINED — no tokio runtime to hold the countdown");
            NoRuntime
        })?;
        // The spawned future must be `'static`, so the probes are cloned out
        // of `self` rather than borrowed by the `async move` block.
        let (focus, deliver) = (self.focus.clone(), self.deliver.clone());
        // The LENGTH only — the armed line exists to show that a countdown was
        // booked and with what urgency (and that the body was not empty);
        // its content is the user's own text and stays out of the log.
        let body_chars = body.chars().count();
        // Spawned FIRST, so the lock below is taken exactly once, for the swap
        // alone (a `std::sync::Mutex` guard is never held across a spawn, let
        // alone an await). Spawning before the old handle is aborted costs
        // nothing: the new task goes straight to sleep, so it cannot deliver
        // before its own deadline — and taking the lock once is what keeps the
        // SLOT to one handle even against a concurrent `arm` on another thread
        // (spawn → unlock → re-lock would let the two arms overwrite each
        // other's handle and leak one live task).
        let task = handle.spawn(async move {
            tokio::time::sleep(delay).await;
            if focus() {
                // The line this whole module needed: the drop is silent to the
                // USER by ADR 0038's decision, which is exactly why a missing
                // notification used to be undiagnosable. This is the branch a
                // lying `is_focused()` probe takes the alert down.
                debuglog::log(
                    "attention: expired focused=true — alert dropped, never retried (ADR 0038 one-shot)",
                );
                return;
            }
            debuglog::log("attention: expired focused=false — delivering the alert");
            deliver(&AlertText { title, body });
        });
        let old = self
            .pending
            .lock()
            .expect("the attention lock")
            .replace(task);
        // Whether this arming took the slot from a live countdown (the
        // one-shot rule means the replaced one can never deliver).
        let replaced = old.is_some();
        if let Some(old) = old {
            old.abort();
        }
        // Armed, with the delay the renderer asked for (the number a "the alert
        // never came" report is measured against) and whether this took the
        // slot from a live countdown.
        debuglog::log(&format!(
            "attention: armed countdown (delay_ms={}, replaced_pending={replaced}, body_chars={body_chars})",
            delay.as_millis()
        ));
        Ok(())
    }

    /// Abort the pending countdown. Idempotent — a no-op when nothing is armed.
    pub fn disarm(&self) {
        let old = self.pending.lock().expect("the attention lock").take();
        let had_pending = old.is_some();
        if let Some(old) = old {
            old.abort();
        }
        // The renderer disarms for EVERY reason, most of them with nothing
        // armed; "user input killed a live countdown" has to be tellable apart
        // from "input arrived and there was nothing to cancel".
        if had_pending {
            debuglog::log("attention: disarm (pending=true) — aborted the countdown");
        } else {
            debuglog::log("attention: disarm (pending=false) — nothing was armed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AlertText, AttentionTimer, Delivery, FocusProbe, NoRuntime};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Let the spawned countdown task reach its next await point (the paused
    /// clock never advances on its own here — see each test's `pause()`).
    async fn settle() {
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }

    /// A timer whose focus answer is fixed, and whose deliveries are recorded
    /// instead of shown (no window, no OS notification in these tests).
    fn timer(focused: bool) -> (AttentionTimer, Arc<Mutex<Vec<AlertText>>>) {
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

    /// The headline case: the user left, the delay elapsed, ONE alert appears —
    /// and nothing after it (ADR 0038's one-shot).
    #[tokio::test]
    async fn fires_once_when_unfocused_at_expiry() {
        tokio::time::pause();
        let (timer, got) = timer(false);

        timer
            .arm(
                Duration::from_secs(15),
                "Archimedes".into(),
                "api-server finished — waiting for you".into(),
            )
            // These tests are `#[tokio::test]`, so a runtime exists and every
            // one of them arms exactly as it did before the guard was added.
            .expect("a runtime exists under #[tokio::test]");
        settle().await;

        // Not yet: 14.9 s of a 15 s countdown.
        tokio::time::advance(Duration::from_millis(14_900)).await;
        settle().await;
        assert!(
            taken(&got).is_empty(),
            "nothing fires before the armed delay elapses"
        );

        // Past expiry: exactly the armed text.
        tokio::time::advance(Duration::from_millis(200)).await;
        settle().await;
        assert_eq!(
            taken(&got),
            vec![AlertText {
                title: "Archimedes".into(),
                body: "api-server finished — waiting for you".into(),
            }]
        );

        // And never again — no repeat, no re-arm.
        tokio::time::advance(Duration::from_secs(120)).await;
        settle().await;
        assert_eq!(taken(&got).len(), 1, "one alert per arming, ever");
    }

    /// ADR 0038: a focused window DROPS the alert. It is not held for the next
    /// blur and not retried later — the countdown is over either way.
    #[tokio::test]
    async fn a_focused_window_drops_the_alert_and_never_retries() {
        tokio::time::pause();
        let (timer, got) = timer(true);

        timer
            .arm(
                Duration::from_secs(15),
                "Archimedes".into(),
                "api-server needs your answer".into(),
            )
            .expect("a runtime exists under #[tokio::test]");
        settle().await;

        for _ in 0..4 {
            tokio::time::advance(Duration::from_secs(10)).await;
            settle().await;
        }
        assert!(
            taken(&got).is_empty(),
            "a focused user is not interrupted, and nothing is retried"
        );
    }

    /// Activity (or an evidence change) before expiry cancels the countdown.
    #[tokio::test]
    async fn disarm_before_expiry_sends_nothing() {
        tokio::time::pause();
        let (timer, got) = timer(false);

        timer
            .arm(
                Duration::from_secs(15),
                "Archimedes".into(),
                "api-server needs your answer".into(),
            )
            .expect("a runtime exists under #[tokio::test]");
        settle().await;

        tokio::time::advance(Duration::from_secs(14)).await;
        settle().await;
        timer.disarm();

        tokio::time::advance(Duration::from_secs(2)).await;
        settle().await;
        assert!(taken(&got).is_empty(), "a disarmed countdown never fires");
    }

    /// The slot holds ONE handle: the second arming aborts the first, so only
    /// the last armed countdown can deliver — the earlier pause is never
    /// announced. (Which pause the renderer sends is its own precedence rule,
    /// tested in `src/lib/attention.ts`; this test is about the slot.)
    #[tokio::test]
    async fn arming_again_replaces_the_pending_countdown() {
        tokio::time::pause();
        let (timer, got) = timer(false);

        timer
            .arm(Duration::from_secs(15), "A".into(), "first".into())
            .expect("a runtime exists under #[tokio::test]");
        settle().await;
        timer
            .arm(Duration::from_secs(15), "B".into(), "second".into())
            .expect("a runtime exists under #[tokio::test]");
        settle().await;

        tokio::time::advance(Duration::from_millis(15_100)).await;
        settle().await;
        assert_eq!(
            taken(&got),
            vec![AlertText {
                title: "B".into(),
                body: "second".into(),
            }],
            "only the last armed countdown survives"
        );
    }

    /// The `Handle::try_current` GUARD. A plain `#[test]` — not `#[tokio::test]`
    /// — runs on a thread with NO ambient tokio runtime, which is exactly what a
    /// future SYNC caller would be (the `RunEvent::Exit` handler builds its own
    /// throwaway runtime, and `setup_dirs_with_factory` runs under `tauri::test`'s
    /// mock runtime in `tests/ipc.rs`). Without the guard, `tokio::spawn` there
    /// panics `"there is no reactor running, must be called from the context of a
    /// Tokio 1.x runtime"` — inside a command task that reaches the renderer as a
    /// bare rejected promise. `arm` must DECLINE instead, so the command can name
    /// a reason. (RED for this test was that exact panic, observed at
    /// `attention.rs:69` before the guard existed.)
    #[test]
    fn arm_declines_when_no_runtime_can_hold_the_countdown() {
        let (timer, got) = timer(false);

        assert_eq!(
            timer.arm(
                Duration::from_secs(1),
                "Archimedes".into(),
                "api-server finished — waiting for you".into(),
            ),
            Err(NoRuntime),
            "a caller with no runtime gets a refusal it can report, not a panic"
        );
        assert!(taken(&got).is_empty(), "a declined arm delivers nothing");
    }

    /// `disarm` is called on every disarm reason, including ones where nothing
    /// was ever armed — it must not panic.
    #[tokio::test]
    async fn disarm_is_idempotent() {
        let (timer, got) = timer(false);
        timer.disarm();
        timer.disarm();
        assert!(taken(&got).is_empty());
    }
}
