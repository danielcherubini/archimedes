---
status: live
last-verified: 2026-10-25
verified-by: read against this tree at `8b5d270` — the plugin behaviour below was re-read from the vendored
  `tauri-plugin-window-state-2.4.0` source resolved by `src-tauri/Cargo.lock`, not copied from the plan that
  found it
---

# Window state — which windows the plugin may remember

`tauri-plugin-window-state` is registered in `src-tauri/src/lib.rs` with
`Builder::default().with_filter(crate::navigation_guard::should_track_label).build()`. That filter is not
decoration. The failure mode is invisible in the code that causes it: ADR 0021 records that a `visible: false`
window is revealed on first run and treats that as the *feature*; the full mechanism, quoted below, lives only
in the plugin's vendored source.

## The reveal

`Builder::default()` means `StateFlags::default()`, which is `all()` — and `all()` includes `VISIBLE`. On
every window the plugin sees, its `on_window_ready` handler calls `restore_state`, which opens with
`let mut should_show = true;`. A label that HAS saved state gets `should_show = state.visible`. A label with
no saved state — the `else` branch — **never assigns it**, and then:

```rust
if flags.contains(StateFlags::VISIBLE) && should_show {
    self.show()?;
    self.set_focus()?;
}
```

So **any window with a label the plugin has never seen is shown and focused**, whatever the builder asked for.

That is exactly the `fetch_content` render webview. `agent/web/render.rs` builds it with `.visible(false)` and
labels it `web-fetch-<request_id>`, where `request_id` is `format!("render-{}", Uuid::new_v4())`
(`agent/worker/core.rs`). The label is a fresh uuid on every call, so it *always* takes the no-saved-state
branch. The app builds a hidden window and the plugin reveals it mid-fetch, taking focus with it — issue #91.
It is intermittent for the same reason the render path is: `tools.rs` only escalates to a render webview when
the plain HTTP fetch looks blocked (`extract::looks_blocked` — 403/429/503, or under 80 words).

**Recipe, if you want to see it.** The target must be a real public page answering 403/429/503 or extracting
under 80 words. A `localhost` or private-IP target never gets there — `render.rs` runs the address gate
(`resolve_and_verify_addrs`) and returns a synthetic 403 before any window is built. And `mode: "raw"` never
escalates at all, so a raw fetch cannot reproduce it however bad the page is.

## The growth

The filter check in `on_window_ready` returns **before** the plugin inserts the label into its state cache, and
`save_window_state` serialises that whole cache on `RunEvent::Exit` **without consulting the filter**. Nothing
ever prunes an entry. Unfiltered, every escalated fetch therefore appended a permanent
`web-fetch-render-<uuid>` key to `~/.local/share/codes.archimedes.desktop/.window-state.json`, for the life of
the config dir. The same one-line filter closes this too, because a filtered label is never inserted.

This half is proven from vendored source alone and needs no GUI to be true.

## What the filter deliberately does NOT do

- **It is not `.with_state_flags()` and it does not drop `VISIBLE`.** `tauri.conf.json` ships `"visible": false`
  for the main window and ADR 0021 depends on this plugin revealing it — it verified from the plugin source that
  a `visible: false` window *"is reliably shown on first run (no saved state), so there is no 'invisible app'
  risk"*. The app's startup correctness and issue #91 are therefore the **same plugin behaviour**, one wanted
  and one not. Excluding `VISIBLE` globally would break app startup, which is why the exclusion is per-label
  and applies only to render webviews.
- **It is not `.with_denylist()` or `.skip_initial_state()`.** Both take exact label strings, and the render
  label set is not enumerable in advance — a list can never name them. `skip_initial_state` would also only
  suppress the restore, not the save, so the state file would keep growing.
- **`should_track_label` keeps the main window tracked.** `tests::window_state_never_tracks_a_render_webview`
  asserts `should_track_label("main")` is true precisely so a future edit cannot "simplify" this into excluding
  everything but a hardcoded allowlist of nothing.

## Accepted residue

Builds before the filter wrote those entries and this change does not remove them. They are never read again:
the plugin only reads state for a label it is currently restoring, and every future render label is a fresh
uuid that cannot match an old key. That holds as long as the plugin restores per-label rather than iterating or
migrating the whole cache — **re-check it on a plugin bump**. Deleting the file by hand is already ADR 0021's
documented rollback step, so there is no cleanup task here by design.

## The orphan window, improved but not fixed

`render.rs`'s 5-second window-creation timeout returns and drops the receiver *before* `WindowDestroyGuard` is
constructed. A window built after that is never destroyed. The filter makes that orphan invisible as well as
harmless — never shown, never focused, never cached — but the real remedy is cancelling the in-flight
`render()`, which needs a cancel token threaded from `router.rs` (it spawns `render()` with no cancel handle).
As of 2026-10-25 that is deliberately out of scope, larger than a bugfix; **this paragraph is the flag to
revisit when that spawn gains cancellation.** Whether the spawn is aborted when its worker exits is
**unverified** as of the same date: a `tokio::spawn`ed future is not cancelled by dropping the sender.

## How the configuration is pinned

`navigation_guard::tests::window_state_never_tracks_a_render_webview` proves the predicate. It proves nothing
about whether the plugin is *configured* with it — deleting `.with_filter(...)` from `lib.rs` would leave every
behavioural test green and reintroduce both defects. `lib.rs`'s own `mod tests` therefore reads its own source
and asserts the qualified `tauri_plugin_window_state::Builder` token is followed by the filter call. Textual on
purpose: the mock runtime has no widget and a second `generate_context!()` is a macOS link error, so plugin
configuration is not observable in a test (`src-tauri/tests/webview_key_focus.rs` says so).

**What the pin does not catch, recorded rather than fixed:** it asserts the filter appears near the
window-state `Builder`, not that nothing else decorates that registration. A later edit adding
`.with_denylist(...)` alongside the filter stays green. That is accepted — a denylist *beside* the filter is
harmless today, and pinning "only these methods, in this order" would make the test reject legitimate changes
without protecting anything the two behavioural assertions do not already cover. If a future change drops
`VISIBLE` from the flags, the `main`-window assertions in the predicate test are the ones that should catch it.

**As of 2026-10-25 the symptom itself has never been observed by an automated run**, and on present tooling it
cannot be: CI has no `xvfb`, a transient 1280×900 webview is not observable headlessly, and `pnpm tauri dev`
never exits. Treat the reveal half as source-proven, not witnessed. The state-file half needs no witness — it
is readable in the plugin's source.
