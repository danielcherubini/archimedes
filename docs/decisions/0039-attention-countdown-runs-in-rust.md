---
status: accepted
date: 2026-10-12
superseded-by:
---

# The attention countdown runs in Rust; the renderer only decides

The renderer computes whether an **Attention alert** should arm or disarm (it holds
the stores and is the only place DOM input exists) and hands Rust the delay plus the
title/body through `attention_arm` / `attention_disarm`; the sleep itself, the focus
check, and the delivery live in the Supervisor. The obvious implementation — a
`setTimeout` in the hook — is the one that silently fails: Tauri throttles a
backgrounded webview (cf. tauri-apps/tauri#5250), and a hidden or minimised window is
this feature's entire customer base, so a renderer-side clock is a notification
feature that does not notify exactly when it matters.

## Considered Options

- All in the renderer (plus `@tauri-apps/plugin-notification` and a `notification`
  capability) — least new surface, easiest tests; rejected on throttling alone.
- All in Rust (the Supervisor arms on `agent_settled` / `track_modal` and the
  renderer sends a debounced `ui_activity` command) — no throttling exposure at all,
  but every keystroke burst then pays IPC whether or not anything is armed, and the
  arm/disarm rule moves out of the vitest layer that already tests rules like
  `sessionStatusOf`.

## Consequences

Activity pings cross IPC only while an alert is armed, so idle typing costs nothing;
and a ping delayed by throttling is harmless, because a hidden window receives no
input to report. Rust stays dumb by construction: it reads no settings and knows no
Session vocabulary, so the delay's single source of truth stays the renderer's
settings store. Delivery needs no permission work — the notification plugin's
`request_permission` is a documented no-op on desktop — so there is no npm package,
no capability entry, and no first-run prompt.

**The protocol is order-dependent and the platform does not guarantee arrival
order.** The renderer relies on `attention_arm` and `attention_disarm` taking effect
in the order it sent them, because Rust's single-slot countdown makes
last-write-wins the entire protocol. Tauri does not supply that order for `async`
commands: each invoke is dispatched through `async_runtime::spawn` separately
(`tauri-2.12.2` `src/ipc/mod.rs:371-388`; the "serialized" in that path is about
serializing the RESPONSE, not about ordering execution), so the arm and the disarm
may run in either order. A `sync` command would be ordered — its wrapper runs inline
on the webview's IPC message-handler thread and answers through `ResponseTag::block`
(`src/ipc/command.rs:225-231`). Two closes were available on those terms and both
were declined: (a) make both commands sync and start the countdown from
`tauri::async_runtime::spawn`, which enters the singleton runtime handle and so works
from any thread, declined because the timer's unit tests depend on
`tokio::time::pause()` acting on the test runtime's thread-local clock, which
requires the in-test `tokio::spawn` the current shape uses; and (b) sequence tokens,
declined because they need a reset channel (a reload runs no cleanup, so a
high-water mark has to be re-set by something) and buy only a marginal improvement
over the disarm every renderer already performs on mount. For most pairs the worst
case is indeed one stale countdown — one late notification, never corrupted state —
but NOT for the pair every renderer issues at MOUNT, the unconditional `disarm`
followed by the pass's first `arm`: a re-order can land that disarm LAST and kill
the countdown this same renderer just booked for a gate that is still open. The
renderer's memory still claims the countdown is armed, and R5's latch never re-arms
what it believes is armed, so that pause is **never announced** — the alert is
silently dead until the pause ends. That is a dev-time exposure rather than a field
failure: live Sessions do not survive a restart, so at a real boot nothing is armed
and there is no gate to re-arm, and reaching the race needs a remount with a gate
already open (Fast Refresh, StrictMode's double mount). It is also why the jsdom
tests can pin only the DISPATCH order of that pair — declaration order in the hook —
and never its arrival order. The two ways to close it are the ones already declined
above, plus serialising the first pass behind the boot `disarm`'s round trip, which
makes every mount wait on IPC; none of them is worth paying for a window only a
hot-reloading developer can enter.

**The renderer writes its memory BEFORE the IPC resolves.** The pass commits the new
memory to its ref and only then issues the command, so a refused or failed
`attention_arm` leaves the renderer believing a countdown Rust does not actually
hold. The *belief* is bounded and self-healing — the entry is retired at its own
recorded deadline like any other, an evidence change disarms it sooner, and the
rejection is logged — but retiring it JOINS that trigger to the announced set, so
the pause it named is muted for good even though Rust never announced it: the true
cost is one alert lost permanently, not a countdown that expires harmlessly. Only
the command's own refusals get there (no runtime able to hold the countdown, a body
that trims to nothing), and the real renderer produces neither — the Supervisor's
runtime is up before any window exists, and `attentionAlertText` always composes a
non-empty body. A proper fix would carry the command's outcome back into the memory,
or refuse to announce a pause whose `arm` was refused; both put a promise inside a
pass whose whole point is not to wait on IPC, so they are declined at that price.

**Delivery is two transports, and a failed one is silent to the USER and loud in the
log.** The `Delivery` closure is chosen at compile time in
`src-tauri/src/attention/delivery.rs`: macOS and Windows hand the alert to
`tauri-plugin-notification`, while Linux and the BSDs send it on the session bus
themselves with `notify_rust` 4.18 and never touch the plugin. Neither transport needs
permission work — the plugin's `request_permission` is a documented no-op on desktop,
and a session-bus send needs none — so moving Linux off the plugin changed nothing
about the absence of an npm package, a capability entry or a first-run prompt, which
is what this section's opening paragraph still says. What has not moved is
who hears about a failure: a Linux session with no notification server still degrades
to nothing the user can see — no dialog, no badge, nothing they could act on — but it
is no longer silent in the debug log. Every attempt writes exactly one `attention:`
line, and each line claims only what its transport actually knows (`delivery_trace`):
`attention: alert delivery FAILED: <error>` with the error's `Display` when the server
refuses, `attention: alert ACCEPTED by the notification server (id=…)` with the
server-assigned id when it accepts, and on the plugin platforms a handover line that
claims no outcome because the plugin reports none. Alert text never enters any of
them. Only the refusal to *arm* crosses IPC back to the renderer (`attention_arm`
answers `Err` when there is no runtime to hold the countdown, or when the renderer
sent an empty body), because those are bugs the developer can fix; an absent
notification server is not.

**Why Linux left the plugin, and what is still owed upstream.**
`tauri-plugin-notification` 2.6.0 discards the handle its own notification library
returns (`src/desktop.rs:424-431`):

```rust
let notification = self.build()?;
tauri::async_runtime::spawn(async move {
    let _ = notification.show();   // notify_rust's NotificationHandle dropped here
});
Ok(())
```

That handle is what owns the session-bus connection the alert was sent on, and
`zbus::Connection` closes its socket when the last clone goes — so on GNOME the alert
is destroyed 22–25 ms later, per ADR 0038. The `Ok(())` says nothing about any of it:
it is returned before the spawned task runs. So on the session-bus targets we make the
call ourselves and retain what comes back; macOS and Windows keep the plugin, where a
notification is not a D-Bus message with a sender's name to lose. **Open action item:
upstream has NOT been notified.** Nothing has been filed against
`tauri-plugin-notification` for its `desktop.rs:424-431` as of this fold, so the
workaround here is local and the defect stands for every other app on the plugin.
