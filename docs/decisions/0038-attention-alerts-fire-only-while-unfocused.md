---
status: accepted
date: 2026-10-12
superseded-by:
---

# Attention alerts fire only while the window is unfocused

An **Attention alert** whose delay elapses while the Archimedes window is the
focused window is dropped silently and never retried — the alert exists to reach a
user who has left, and a toast landing on top of the window they are reading is
noise. pi-archimedes' own `notify` package does the opposite on purpose ("no focus
tracking. Keystrokes are the only signal"), because a terminal cannot tell whether
the user is looking; the desktop can, so it uses that fact instead of mimicking the
terminal's blind spot. The one-shot half is the deliberate part: holding a fired-but
-suppressed alert until the next blur would let a Session that settled an hour ago
ring when the user finally alt-tabs, which is pi's own "a long-gone question cannot
ring" failure in new clothes.

## Considered Options

- Fire regardless of focus (the faithful port) — rejected: fires over the frontmost
  window, which is the one window the user is demonstrably reading.
- Hold the suppressed alert and fire it on the next blur — rejected: needs an expiry
  to avoid stale alerts, and re-introduces the delayed nag it was meant to avoid.
- Make focus-suppression a third setting — rejected: a knob for behaviour whose
  only alternative is worse on every platform (macOS suppresses frontmost-app
  notifications at the OS level anyway).

## Consequences

**The common case is the dropped one.** The likeliest real sequence is: watch a
run finish in the window, then walk away within the delay. The countdown expires
while the window still holds focus, so the alert is dropped and that pause never
announces itself at all. This is the decision above applied honestly, not an
oversight — holding the alert for the next blur is the rejected alternative, and
a user who was looking when the run finished has already seen it finish. "Alerts
when a Session has been paused on you" therefore means "…when you were already
gone by the time the delay expired", and nothing short of an expiry-hold (which
re-introduces the stale nag) covers the walk-away-after-finish pattern.

**The drop is WINDOW-level while a pause is SESSION-level, so its scope is wider
than "the run you were watching".** Focus is one answer about one window
(`WebviewWindow::is_focused()` on the main window, `src-tauri/src/lib.rs:145-149`),
while a pause belongs to a Session. So with the window focused on Session A, a gate
that opens in a background Session — or in a **Subagent session** — is dropped at
expiry exactly the same, and that user has demonstrably NOT seen it: `ChatStream`
renders gates for the active Session only (`src/components/ChatStream.tsx:103-112`
selects `prompts` and `requests` by `activeSessionId`). It is survivable through the
in-app affordance rather than through the alert: a waiting Session is marked in the
sidebar list with its "Waiting" pill (`src/components/SpacesList.tsx:552-559`), and
the collapsed rail marks it with the warning-fill dot and carries a waiting count in
its accessible name (`src/components/SessionRail.tsx:102-107` and `:180-191`). Closing
the gap itself would need a per-Session notion of "seen", which the app does not
have; this paragraph exists to keep the decision above from being read as narrower
than it is.

> **Amended 2026-10-16 (the `?` mark).** The two affordances named above are now ONE
> glyph: `SessionStatusMark` (`src/components/SessionStatusMark.tsx`) draws a `?` in
> the attention ink in the session row's leading slot — the slot the spinner occupies
> — and the same glyph in the rail and in the Space's tab. The row's text "Waiting"
> pill is gone (it hid the row's relative time while a Session waited, and it was the
> rail's dot restated in a second shape). The argument in this paragraph is unchanged:
> the cue still exists in the open list, the collapsed rail, AND the tab bar, and the
> rail's accessible name still carries the waiting count.

**One alert per pause is per renderer session, not per pause** (and which pause owns
the single countdown when several are owed at once is ADR 0040). The record of which
pauses have been announced lives in the renderer's memory (ADR 0039 — Rust is handed
a delay and some text and never learns what a pause is), and a webview reload wipes
it. Half of what that implies is closed: a reload runs no React cleanup, so a
countdown armed before it would otherwise survive, fire with stale text, and be
uncancellable from a page whose memory starts unarmed — hence the hook disarms
unconditionally on mount, declared above the pass effect so boot is disarm-then-arm.
The mirror image is not closable renderer-side and is accepted: the same reload
forgets the announced set, so a question that already alerted **alerts again**.
Fixing it properly means the Supervisor owning the announced set, or persisting it —
something to pick up deliberately, not to rediscover as a surprise.

**Activity signals can never be the reason a focused alert is suppressed** — input
arrives with focus, so the two gates overlap almost entirely. They remain
load-bearing anyway: they stop an armed alert from ringing for a pause the user
already resolved inside the delay (came back, typed, left again), and — with the
`beginTurn` disarm — from announcing "finished" while a turn they just started is
still streaming.

## How a Linux alert survives the desktop

ADR 0039 owns which transport each platform uses. What this section owns is the rule
the desktop imposes on an alert's lifetime, which is what took the Linux transport off
the notification plugin and is now a constraint on this decision rather than an
implementation detail. Measured on GNOME Shell **50.5** (Fedora 44, Wayland).

**An alert's lifetime includes its sender.** GNOME's FDO daemon makes an alert's
*source* watch the SENDER'S BUS NAME
(`Gio.DBus.session.watch_name(sender, …, this._onNameVanished)`) and destroy that
source when the name disappears — `shell_notificationDaemon.js`, in
`resource:///org/gnome/shell/ui/messageList.js` +
`/usr/share/gnome-shell/js/ui/messageTray.js`:

```js
_onNameVanished(connection, name) {
    const source = this._notifyDaemons.get(name)?.source;
    if (!source) return;
    if (this._senderForNotification.has(name))
        source.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
}
```

So an alert whose sending connection has already closed is destroyed with reason
`DISMISSED` (2) — neither the user nor a timeout — 22–25 ms after the server answered
`Notify` (measured three times; reproduced on demand by the `#[ignore]`d
`src-tauri/tests/attention_alert_survives.rs`). Nothing is logged on the sender's
side: no banner anyone can read, no entry in the message list, no error. **Hence: the
handle the server answers with is part of the alert, and this app keeps it** —
`attention::delivery`'s `Retained` store holds every returned handle for the process
lifetime, bounded at `RETAINED_ALERT_CAP = 8` and evicting the OLDEST. Bounded
because unbounded retention is a connection leak in a process that runs for weeks;
oldest-first because the alert released is the one announced 8 alerts ago, long past
any banner's life. Eviction is a deliberate re-exposure to the teardown above, which
is why the release is named in the same log line as the success that caused it.

**The rule bites only senders the desktop resolves to an app, and it resolves us.**
The destroy sits behind `if (this.app)`, so a sender GNOME cannot attribute is exempt:
`notify-send` alerts survive a dead sender, and so do this crate's own test-binary
deliveries, which is why the bug read as a GNOME quirk. We are not such a sender, and
the chain that makes us one is why the feature is coupled to a desktop entry.
`enableGtkAppId` is never set, so Tauri hands GTK no app id — it passes
`Some(identifier)` only `if manager.config.app.enable_gtk_app_id` (`tauri` 2.12.2,
`src/app.rs:2446`; the default is `false`, `tauri-utils` 2.10.1 `src/config.rs:5035`)
— so GTK derives the id from `prgname` and the window's Wayland `app_id`/WM_CLASS is
the executable name, `archimedes`. `notify_rust` defaults a notification's `app_name`
to that same executable name (4.18.2, `src/notification.rs:24`, `:119`), and GNOME
looks that up as `<app_name>.desktop`, which `make install-desktop` installs as
`~/.local/share/applications/archimedes.desktop` with `StartupWMClass=archimedes`.
Attribution and survival are therefore the same fact: the entry that gives the alert
its name and icon is what makes `this.app` truthy and the destroy apply. Observed on
the installed AppImage on this box: a banner with the app's own icon, whose
`NotificationClosed` arrived 10.3 s later — a lifetime, not a teardown.

**"A Linux alert vanished seconds after appearing" means the sender's connection
closed, and only a D-Bus capture can say so.**
`dbus-monitor "interface='org.freedesktop.Notifications'"` sees both the calls and the
`NotificationClosed` signal, and `busctl --user status
org.freedesktop.Notifications` names the server — on GNOME, the Shell's own
`gjs -m /usr/share/gnome-shell/org.gnome.Shell.Notifications`.
`ps -e | grep -i notify` is a **false negative** there: it prints nothing
while the server runs, because the Shell holds the bus name and no process is named
"notify". Nothing inside the app can witness its own close either — the daemon emits
the signal AT a destination rather than broadcast (measured
`Sender=:1.17 Destination=:1.31`), which is why no `zbus` dependency was added and the
eavesdropper is the instrument.

**Attribution is the platform question tests cannot reach.** Windows attributes a
toast through an AUMID, which only an *installed* bundle registers, so a dev-build
Windows toast is mislabelled by design and only an installed-bundle run closes that
platform row (the plugin documents this; it has never been exercised here, or
anywhere).
