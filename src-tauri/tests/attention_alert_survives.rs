//! The MANUAL Linux checks behind the attention-alert fix: real alerts on a real
//! desktop session, then a look at what the process is still holding.
//!
//! ```text
//! cd src-tauri && cargo test --test attention_alert_survives -- --ignored --nocapture
//! ```
//!
//! # Why a person has to run this
//!
//! GNOME 50.5 destroys an alert when the connection that sent it dies: the FDO
//! daemon name-watches the sender and `_onNameVanished` ends in
//! `if (this.app) this.destroy()`, which is why an alert vanished 22–25 ms after
//! `Notify` was answered (see `Retained` in `attention::delivery`). Two things
//! found by measuring on a live session make that unobservable from inside a
//! test binary, and they are the reason these checks are `#[ignore]`d and
//! human-read rather than asserted:
//!
//! 1. **`NotificationClosed` is not broadcast.** The daemon emits it to a
//!    specific destination (measured: `Sender=:1.17 Destination=:1.31`), so a
//!    subscription on OUR connection was not a trustworthy witness, so `zbus` was
//!    not added as a dependency; the capture recipe is in
//!    [`watch_the_destroyed_alert_and_the_surviving_one`] instead. What the capture
//!    actually shows is `Sender=:1.17 Destination=:1.31` — the Shell emitting the
//!    close AT a destination (its own FDO-forwarding daemon), not to everyone, and
//!    in every close this box produced the sending connection had already died,
//!    which is what caused it. So "would our own connection have been addressed?"
//!    was never answerable here, and an assertion that hinged on it would have
//!    hinged on an unverified assumption.
//! 2. **The rule only bites senders that resolve to an app.** GNOME looks the
//!    sender up by pid, then by `<app_name>.desktop` (`_getApp`), and the
//!    destroy is behind `if (this.app)`. The installed app resolves
//!    (`archimedes.desktop`, and its `app_name` on the bus is the executable's
//!    name, `archimedes`); a test binary's `app_name` is its own mangled
//!    executable name, which matches no desktop file, so a plain delivery here
//!    is exempt from the rule — exactly like `notify-send`, whose alerts survive
//!    a dead sender for the same reason.
//!
//! So the first check proves the MECHANISM (the server answers, and we still own
//! the connection that carries that id), and the second is the pair a person can
//! SEE: the plugin's shape (drop the handle) versus ours (keep it), both sent as
//! an app-resolved sender.

// The gate is the SAME expression as the `notify-rust` dependency's target gate
// in `Cargo.toml` and as `attention::delivery`'s: on any other target there is
// no session bus to test against and no `notify-rust` to test with.
#![cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]

use std::time::Duration;

use archimedes_lib::attention::delivery::{retained_alerts, session_bus_delivery, Outcome};
use archimedes_lib::attention::AlertText;

/// How long to wait before deciding the alert was not destroyed. The measured
/// destruction was measured at 22–25 ms after `Notify`, so three seconds is >100×
/// the bug's own window, and it is also long enough for a person to look at the screen.
const WATCH: Duration = Duration::from_secs(3);

/// The desktop session's notification server or nothing: this whole file is
/// meaningless without one, and the failure should say that.
fn server_name() -> String {
    match notify_rust::get_server_information() {
        Ok(info) => {
            println!(
                "server: {} {} (spec {})",
                info.name, info.version, info.spec_version
            );
            info.name
        }
        Err(e) => panic!(
            "no notification server answered on this session bus ({e}) — run these tests \
             at a desktop session, not in CI or over ssh"
        ),
    }
}

#[test]
#[ignore = "shows a real notification on this desktop and waits 3 s — run it with `cargo test -- --ignored --nocapture`"]
fn the_process_still_holds_the_connection_three_seconds_after_the_alert() {
    server_name();

    // The real production send, through the real seam: the handle it returns is
    // what has to survive.
    let alert = AlertText {
        title: "Archimedes — manual check".into(),
        body: "This alert should STILL be on screen 3 s from now".into(),
    };
    let before = retained_alerts();
    let outcome = session_bus_delivery(&alert);
    let id = match outcome {
        Outcome::Accepted { id, released } => {
            println!("the server accepted the alert: id={id} (released={released:?})");
            id
        }
        other => panic!("the alert was not accepted ({other:?}) — nothing further can be checked"),
    };

    assert!(
        retained_alerts().contains(&id),
        "id={id} was accepted but is NOT retained — dropping that handle is what \
         tells GNOME the sender is gone (the bug this test guards)"
    );
    assert!(
        retained_alerts().len() > before.len(),
        "the store did not grow by this alert"
    );

    std::thread::sleep(WATCH);

    let held = retained_alerts();
    assert!(
        held.contains(&id),
        "id={id} was RELEASED during the {WATCH:?} wait: its connection closed, \
         and GNOME's `_onNameVanished` destroys the source that holds the alert"
    );

    println!(
        "checked: id={id} accepted, retained, and still retained {WATCH:?} later \
         (held now: {held:?} — the cap is {})",
        archimedes_lib::attention::delivery::RETAINED_ALERT_CAP
    );
    println!(
        "what this does NOT prove: this binary's app_name resolves to no desktop file, \
         so GNOME's `if (this.app)` destroy never applied to it (see the module doc). \
         The visible A-vs-B is `watch_the_destroyed_alert_and_the_surviving_one`."
    );
}

/// The shape of the bug and the shape of the fix, side by side, as a sender GNOME
/// resolves to an app — which is the only case the destroy rule applies to.
///
/// Two alerts appear. The first is shown the plugin's way (`show()` then drop the
/// handle) and should disappear from the banner within a second; the second is
/// shown our way (the handle kept, as `Retained` does) and should stay. For hard
/// evidence rather than eyeballs, capture the bus around it:
///
/// ```text
/// (timeout 12 busctl --user monitor org.freedesktop.Notifications >/tmp/n.txt 2>&1 &)
/// cargo test --test attention_alert_survives watch_the -- --ignored --nocapture
/// sleep 12; grep -c NotificationClosed /tmp/n.txt   # 1 = only the dropped one died
/// ```
///
/// The desktop entry to send as defaults to `archimedes` (what `make install`
/// writes) and can be overridden with `ARCHIMEDES_ALERT_DESKTOP_ENTRY`. If no such
/// `.desktop` file exists on this machine, the test gives up rather than print a
/// pair that would look identical for the wrong reason.
#[test]
#[ignore = "shows TWO real notifications on this desktop, one of which is destroyed on purpose"]
fn watch_the_destroyed_alert_and_the_surviving_one() {
    server_name();

    let entry = std::env::var("ARCHIMEDES_ALERT_DESKTOP_ENTRY")
        .unwrap_or_else(|_| "archimedes".to_string());
    if !desktop_entry_exists(&entry) {
        println!(
            "SKIP: no `{entry}.desktop` in the applications directories. Without a desktop \
             file GNOME cannot resolve the sender to an app, `this.app` stays null, and the \
             destroy rule never fires — the pair would look identical even with the bug \
             present. Install the app, or point ARCHIMEDES_ALERT_DESKTOP_ENTRY at any \
             installed .desktop name."
        );
        return;
    }

    // A: the plugin's shape — `let _ = notification.show();`, so the handle (and
    // with it the session connection) dies on the way out of the call.
    let dropped = alert_as_app(&entry, "DROP shape: this one should vanish at once");
    let dropped_id = dropped.id();
    drop(dropped);
    println!("A id={dropped_id} sent and the handle DROPPED — watch it disappear");

    std::thread::sleep(WATCH);

    // B: our shape — the handle goes into the retain store and stays there.
    let kept = alert_as_app(
        &entry,
        "KEEP shape: this one should stay until you dismiss it",
    );
    let kept_id = kept.id();
    std::mem::forget(kept);
    println!("B id={kept_id} sent and the handle KEPT — it should still be up");

    std::thread::sleep(WATCH);
    println!(
        "if A vanished and B stayed, the retain is doing its job. Both vanished: the fix \
         is not holding. A text file of the bus capture is the tie-breaker (doc comment)."
    );
}

/// An alert sent as `app_name = <entry>`, which is what makes GNOME resolve the
/// sender to an app and therefore apply the destroy rule. Everything else matches
/// what production sends.
fn alert_as_app(entry: &str, body: &str) -> notify_rust::NotificationHandle {
    let mut n = notify_rust::Notification::new();
    n.appname(entry);
    n.summary("Archimedes — manual A/B check");
    n.body(body);
    n.auto_icon();
    n.show()
        .unwrap_or_else(|e| panic!("the server refused the alert ({body}): {e}"))
}

/// Is there a `<entry>.desktop` for GNOME to resolve to? The two standard
/// XDG locations, which is where a user install and a system install land.
fn desktop_entry_exists(entry: &str) -> bool {
    let file = format!("{entry}.desktop");
    let home = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| dirs_home().join(".local/share"));
    [
        home.join("applications"),
        std::path::PathBuf::from("/usr/share/applications"),
    ]
    .iter()
    .any(|dir| dir.join(&file).is_file())
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/"))
}
