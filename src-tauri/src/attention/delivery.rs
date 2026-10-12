//! The production [`Delivery`] — an alert's route to the screen, and the only
//! place in this crate that talks to a notification server.
//!
//! Two transports, picked at compile time, because the platforms do not fail
//! the same way:
//!
//! * Linux and the BSDs send the alert on the session bus themselves ([`bus`]).
//!   `tauri-plugin-notification` DOES get the alert to the server there, and the
//!   server then destroys it (22–25 ms later, measured on GNOME 50.5) because
//!   the plugin drops the handle that owns the connection it just sent on. The
//!   rule that makes dropping fatal is [`Retained`]'s subject, and it is a rule
//!   about the DESKTOP, not about us.
//! * macOS and Windows keep the plugin ([`plugin`]). A notification there is not
//!   a D-Bus message with a sender, so there is no bus name for it to die with.
//!
//! The other thing this module owns is what the debug log may SAY about a
//! delivery. "The alert never appeared" is THE support question for this feature
//! (`attention`'s module doc), and the two transports know very different
//! amounts about what just happened: one has the id the server answered with,
//! the other has a call that returned. [`Outcome`] is the seam that stops the
//! wording claiming more than the transport knows, and it is pure (no bus, no
//! window, no server) so the wording itself is tested. Alert TEXT never comes
//! near it — the store and the trace carry ids and errors only.

use std::collections::VecDeque;
use std::sync::Mutex;

// The gate below is the platform set `tauri-plugin-notification` builds
// `notify-rust` for, written as a subtraction: every `unix` except macOS (its
// own notification service) and the two `unix` mobiles (no session bus — the
// plugin's own target list excludes them too, so `cfg(unix)` alone would ask
// `notify-rust` to build where it cannot). The SAME expression gates the
// dependency in `Cargo.toml`, and the two must stay equal: the code may not name
// `notify-rust` on a target that does not have it.
#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
pub mod bus {
    //! Linux and the BSDs: send the alert ourselves and KEEP the handle the
    //! server answers with. See [`super::Retained`] for why that handle is
    //! load-bearing, and [`super::plugin`] for the platforms that need none of
    //! this.

    use std::sync::Arc;

    use crate::agent::debuglog;
    use crate::attention::{AlertText, Delivery};

    use super::{Outcome, Retained, RETAINED_ALERT_CAP};

    /// The alerts this process has shown and still holds a connection for.
    /// Process-lifetime on purpose: an alert outlives the countdown that sent
    /// it, and so must whatever keeps it on screen.
    static RETAINED: Retained<notify_rust::NotificationHandle> = Retained::new(RETAINED_ALERT_CAP);

    /// The ids of the alerts still being kept alive, oldest first.
    ///
    /// `pub` for the same reason as [`session_bus_delivery`]: the ignored manual
    /// test checks, on a real desktop, that the retention really happened.
    pub fn retained_alerts() -> Vec<u32> {
        RETAINED.ids(|handle| handle.id())
    }

    /// Send one alert on the session bus and retain what the server handed back.
    ///
    /// `pub` ONLY so the ignored manual test
    /// (`tests/attention_alert_survives.rs`) can drive the real thing;
    /// production reaches this through [`production`]'s closure and nothing
    /// else.
    ///
    /// The send BLOCKS for one D-Bus round trip (`notify_rust` drives its own
    /// future to completion on the calling thread) — which is what the plugin's
    /// spawned task already did with the same call, and this task's next and
    /// only remaining act is the log line.
    pub fn session_bus_delivery(text: &AlertText) -> Outcome {
        // The notification the plugin builds on this platform and nothing more:
        // the same app name (`notify_rust`'s default, the executable's), the
        // same `auto_icon`, no hints, the server's own timeout. Moving off the
        // plugin must not change WHICH app the desktop resolves the alert to —
        // that resolution is the difference between a banner and silence.
        let mut notification = notify_rust::Notification::new();
        notification.summary(&text.title);
        notification.body(&text.body);
        notification.auto_icon();

        match notification.show() {
            Err(e) => Outcome::Refused(e.to_string()),
            Ok(handle) => {
                // The id is the server's answer to `Notify`, read before the
                // handle moves into the store.
                let id = handle.id();
                let released = RETAINED.keep(handle).map(|old| old.id());
                Outcome::Accepted { id, released }
            }
        }
    }

    /// The [`Delivery`] for the session-bus desktops.
    ///
    /// The `AppHandle` is unused here — the bus path needs no window, no app
    /// identifier and no plugin — and is taken anyway so that one `production`
    /// shape serves every platform, and so the caller has nothing to `cfg`.
    pub fn production<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Delivery {
        Arc::new(|text: &AlertText| {
            let outcome = session_bus_delivery(text);
            debuglog::log(&super::delivery_trace(&outcome));
        })
    }
}

/// macOS, Windows and anything mobile: hand the alert to
/// `tauri-plugin-notification`, which has no bus-name semantics to keep alive.
#[cfg(not(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
)))]
pub mod plugin {
    //! A macOS/Windows notification is not a D-Bus message: there is no
    //! sender's bus name for the desktop to watch, so the XDG retention
    //! machinery would buy nothing and cost a dependency, and the plugin's own
    //! platform handling (bundle identifier on macOS, AUMID on Windows) stays
    //! in charge.

    use std::sync::Arc;

    use crate::agent::debuglog;
    use crate::attention::{AlertText, Delivery};

    use super::Outcome;

    /// Hand one alert to the plugin. `Ok` means the call returned and NOTHING
    /// else: the plugin spawns the real send and discards its result
    /// (`tauri-plugin-notification` 2.6.0, `desktop.rs`), so whether anything
    /// reached the screen is unknowable from here.
    fn plugin_delivery<R: tauri::Runtime>(app: &tauri::AppHandle<R>, text: &AlertText) -> Outcome {
        use tauri_plugin_notification::NotificationExt;
        match app
            .notification()
            .builder()
            .title(&text.title)
            .body(&text.body)
            .show()
        {
            Ok(()) => Outcome::HandedOff,
            Err(e) => Outcome::Refused(e.to_string()),
        }
    }

    /// The [`Delivery`] for the platforms that keep the plugin.
    pub fn production<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Delivery {
        let app = app.clone();
        Arc::new(move |text: &AlertText| {
            let outcome = plugin_delivery(&app, text);
            debuglog::log(&super::delivery_trace(&outcome));
        })
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
pub use bus::{production, retained_alerts, session_bus_delivery};

#[cfg(not(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
)))]
pub use plugin::production;

/// How many shown alerts this process keeps alive. Eight is a shape, not a
/// measurement: the countdown delivers one alert at a time (ADR 0038), so eight
/// is far more alerts than anyone is still looking at, and the cost of being
/// generous is eight idle D-Bus connections.
pub const RETAINED_ALERT_CAP: usize = 8;

/// What one delivery attempt learned about the alert it sent.
///
/// The variants ARE the difference between the platforms, and the debug line is
/// derived from this and nothing else — a transport cannot claim an id it was
/// never given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Linux and the BSDs: the server ANSWERED the `Notify` call with this id.
    /// That is evidence it took the alert — not evidence that anything reached
    /// the screen. `released` is the id of the alert this send pushed out of
    /// [`Retained`], if any.
    Accepted { id: u32, released: Option<u32> },
    /// macOS and Windows: the plugin took the notification and reported only
    /// that. Its `show()` spawns the real send and discards the result, so `Ok`
    /// says the builder call returned and nothing about the desktop.
    HandedOff,
    /// The call refused the alert, with its `Display` (usually "no notification
    /// server on this session").
    Refused(String),
}

/// The debug line for one delivery attempt.
///
/// PURE so the wording is testable with no notification server running — the
/// same `focus_probe_trace` shape. The caller throws the line at the log and
/// nothing else: ADR 0038's promise that a failed delivery is silent TO THE USER
/// is untouched, and the log is the only new listener.
pub fn delivery_trace(outcome: &Outcome) -> String {
    match outcome {
        // The id is what the server ANSWERED with, which is the strongest claim
        // the sender can make: the alert reached the server. Whether it stayed
        // on screen is the server's doing from here — and the `released` clause
        // is the one way WE can still be the reason an older alert disappeared.
        Outcome::Accepted { id, released } => match released {
            None => format!("attention: alert ACCEPTED by the notification server (id={id})"),
            Some(released) => format!(
                "attention: alert ACCEPTED by the notification server (id={id}); the retain cap of {RETAINED_ALERT_CAP} released the oldest handle (id={released}), so that alert's source may go with it"
            ),
        },
        // The plugin hands the notification to a task that discards what the
        // notification library says (`desktop.rs`: `let _ = notification
        // .show();`), so an `Ok` here is a handover and nothing more. Saying
        // "delivered" would be the lie that sent someone to a D-Bus capture.
        Outcome::HandedOff => concat!(
            "attention: alert handed to the notification plugin, which reports nothing ",
            "back (no id, no proof it reached a server)"
        )
        .to_string(),
        Outcome::Refused(e) => format!("attention: alert delivery FAILED: {e}"),
    }
}

/// The bounded store of the things that keep a shown alert on screen — on the
/// session-bus desktops, the handle `notify_rust` hands back per send.
///
/// Generic over the item because the POLICY is what is under test and the real
/// item needs a notification server to obtain: the tests hold tokens.
///
/// # Why retain one at all
///
/// `notify_rust::Notification::show()` opens a fresh session-bus connection per
/// notification, sends `Notify`, and returns a handle that owns that connection
/// — the crate documents the handle as keeping "a connection alive to ensure
/// actions work on certain desktops". On GNOME that connection is not a nicety:
/// the Shell's FDO daemon makes an alert's **source** watch the SENDER'S BUS
/// NAME (`Gio.DBus.session.watch_name(sender, …, this._onNameVanished)`) and
/// `_onNameVanished` reads
///
/// ```text
/// if (this.app)
///     this.destroy();
/// ```
///
/// So the moment the sending connection dies the Shell destroys the source and
/// every notification that came from it — reason `DISMISSED` (2), which is why
/// the alert is gone before a banner can be read and leaves nothing in the
/// message list. Measured here: `Notify` answered, then `NotificationClosed(id,
/// 2)` 22–25 ms later, three times. It bites only when the alert resolves to a
/// real app (an installed `.desktop` file); a `notify-send` sender is exempted by
/// that same `if (this.app)`, which is why hand-sent test notifications look fine.
///
/// # What dropping one costs
///
/// Eviction is a real drop, so the alert it releases becomes eligible for that
/// same teardown: a banner still on screen goes, and the alert's entry in the
/// message list goes with the source. That is the price of the cap, and it is
/// affordable because the store is oldest-first — the alert released is the one
/// announced `RETAINED_ALERT_CAP` alerts ago, long past any banner's life, for a
/// pause that is by construction older than every alert still kept. The
/// alternatives are worse: unbounded retention is a connection leak in a process
/// that runs for weeks, and no retention at all is the bug this module exists
/// for.
pub struct Retained<T> {
    cap: usize,
    /// Oldest first, so eviction is a `pop_front`.
    items: Mutex<VecDeque<T>>,
}

impl<T> Retained<T> {
    pub const fn new(cap: usize) -> Self {
        Self {
            cap,
            items: Mutex::new(VecDeque::new()),
        }
    }

    /// Keep `item` for the life of the process, returning whatever that pushed
    /// out of the cap — the OLDEST item, which the caller drops by returning it.
    ///
    /// Returned rather than dropped in place so the caller can NAME the released
    /// alert in the log before the drop happens.
    pub fn keep(&self, item: T) -> Option<T> {
        let mut held = self.items.lock().expect("the alert-retention lock");
        held.push_back(item);
        // One insert can only put the store one over its cap, so one eviction
        // is enough — and it is always the FRONT that goes, because the front is
        // the alert the user was told about earliest.
        if held.len() > self.cap {
            held.pop_front()
        } else {
            None
        }
    }

    /// Everything held, oldest first, read through `id`.
    pub fn ids(&self, id: impl Fn(&T) -> u32) -> Vec<u32> {
        self.items
            .lock()
            .expect("the alert-retention lock")
            .iter()
            .map(id)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.items.lock().expect("the alert-retention lock").len()
    }

    /// The required partner of `len`.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::{delivery_trace, Outcome, Retained, RETAINED_ALERT_CAP};
    use std::sync::{Arc, Mutex};

    // ---- the retention policy (the GNOME rule, as a data structure) --------

    /// A token that says so when it is dropped: "evicted" and "dropped" are the
    /// same event here, and only one of them closes a D-Bus connection.
    struct Token {
        id: u32,
        dropped: Arc<Mutex<Vec<u32>>>,
    }

    impl Drop for Token {
        fn drop(&mut self) {
            self.dropped.lock().unwrap().push(self.id);
        }
    }

    /// Pushing past the cap evicts the OLDEST and keeps the newest `cap`, so the
    /// alert a user might still be reading is always among what is kept.
    #[test]
    fn pushing_past_the_cap_evicts_the_oldest() {
        let dropped = Arc::new(Mutex::new(Vec::new()));
        let store = Retained::new(RETAINED_ALERT_CAP);
        let total = RETAINED_ALERT_CAP + 2;

        let mut evicted = Vec::new();
        for id in 0..total as u32 {
            let token = Token {
                id,
                dropped: dropped.clone(),
            };
            if let Some(old) = store.keep(token) {
                evicted.push(old.id);
                // `old` drops right here — that drop IS the connection closing.
            }
        }

        assert_eq!(
            store.ids(|token| token.id),
            (2..total as u32).collect::<Vec<_>>(),
            "the store holds the newest {RETAINED_ALERT_CAP}, oldest first"
        );
        assert_eq!(
            evicted,
            vec![0, 1],
            "eviction walks the store oldest-first, so the alert released is \
             the one the user was told about earliest"
        );
        assert_eq!(
            *dropped.lock().unwrap(),
            vec![0, 1],
            "an eviction DROPS what it evicts (that drop is what closes the old \
             connection and lets the desktop tear that source down)"
        );
        assert_eq!(store.len(), RETAINED_ALERT_CAP, "the cap is a cap");
    }

    /// Under the cap nothing is evicted and nothing is dropped: an ordinary
    /// alert is retained, not churned.
    #[test]
    fn under_the_cap_nothing_is_evicted() {
        let dropped = Arc::new(Mutex::new(Vec::new()));
        let store = Retained::new(3);
        for id in 0..3 {
            let token = Token {
                id,
                dropped: dropped.clone(),
            };
            assert!(store.keep(token).is_none(), "{id} fits under the cap");
        }
        assert_eq!(store.ids(|t| t.id), vec![0, 1, 2]);
        assert!(
            dropped.lock().unwrap().is_empty(),
            "a retained alert is retained: nothing was dropped"
        );
    }

    // ---- the log line (what the delivery is allowed to claim) --------------

    /// The session-bus success line carries the id the SERVER assigned: that
    /// number is the only evidence in hand that the alert was accepted, and it
    /// is what a support answer points at.
    #[test]
    fn the_success_line_carries_the_id_the_server_gave() {
        let line = delivery_trace(&Outcome::Accepted {
            id: 42,
            released: None,
        });
        assert!(line.starts_with("attention:"), "{line}");
        assert!(
            line.contains("42"),
            "the server's id is in the line: {line}"
        );
        assert!(
            !line.contains("returned Ok"),
            "the old line asserted the one thing nobody can know: {line}"
        );
    }

    /// When the store was full the line names the alert that was released — the
    /// only way a later "my earlier alert vanished" report can be answered.
    #[test]
    fn the_line_names_a_released_alert() {
        let line = delivery_trace(&Outcome::Accepted {
            id: 42,
            released: Some(7),
        });
        assert!(line.contains("42"), "{line}");
        assert!(line.contains('7'), "the released alert is named: {line}");
        assert!(
            line.contains("cap") || line.contains("retain"),
            "and the line says why it was released: {line}"
        );
    }

    /// The failure line still carries the error's `Display` (the standing rule:
    /// "we tried and the OS said no" must be tellable apart from "we never
    /// tried").
    #[test]
    fn the_failure_line_names_the_error() {
        let line = delivery_trace(&Outcome::Refused("no notification server".into()));
        assert!(line.contains("FAILED"), "a failure is labelled: {line}");
        assert!(line.contains("no notification server"), "{line}");
    }

    /// The plugin path cannot see the desktop at all, so its line must not read
    /// like a delivery report.
    #[test]
    fn the_plugin_line_admits_it_knows_nothing() {
        let line = delivery_trace(&Outcome::HandedOff);
        assert!(line.starts_with("attention:"), "{line}");
        assert!(
            !line.contains("delivered"),
            "the plugin never says the alert got anywhere: {line}"
        );
        assert!(
            !line.contains("returned Ok"),
            "not even the call's shape is a delivery claim: {line}"
        );
        assert!(
            line.contains("plugin") && (line.contains("nothing") || line.contains("no id")),
            "the line says who holds the alert now and what is unknown: {line}"
        );
    }

    /// The standing rule, restated where the alert's text is in scope: nothing
    /// a delivery emits ever carries the alert's words.
    #[test]
    fn no_line_carries_the_alert_text() {
        for outcome in [
            Outcome::Accepted {
                id: 1,
                released: None,
            },
            Outcome::HandedOff,
            Outcome::Refused("boom".into()),
        ] {
            let line = delivery_trace(&outcome);
            assert!(
                !line.contains("api-server") && !line.contains("waiting for you"),
                "{line}"
            );
        }
    }
}
