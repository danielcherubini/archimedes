---
status: accepted
date: 2026-10-14
superseded-by:
---

# The auto-updater is driven from Rust behind our own commands, not from the webview through the official plugin API

Tauri ships `@tauri-apps/plugin-updater` with a documented JS flow (`check()` → `downloadAndInstall()` → `relaunch()`), and the obvious wiring is to add it to the frontend plus `"updater:default"` and `"process:default"` to `capabilities/default.json`. We decided instead to register only the Rust plugin (`tauri-plugin-updater::Builder`) and expose two of our own commands — `check_update` and `install_update` with a progress event — so the webview never holds updater or restart rights and `capabilities/default.json` does not change. Two facts make this cheaper than it looks: capabilities gate only the webview→Rust IPC boundary, so a Rust-side `check()` needs no permission entry at all (the same reasoning already recorded for `tauri-plugin-notification` in `Cargo.toml`); and `AppExt::restart()` exists on Tauri itself, so `tauri-plugin-process` — and with it `allow-exit`/`allow-restart` — is not needed for the relaunch.

## Considered Options

- **Official plugins called from React, adding `updater:default` + `process:default` (rejected).** Least bespoke code and the documented path. Rejected for surface, not for security (see Consequences): it puts `allow-install` in the plugin ACL, adds two npm dependencies whose `Update` object is a native `Resource` the renderer must remember to `close()`, and hands the renderer a per-TCP-chunk progress callback it then has to coalesce.
- **`check()` in JS, install in Rust (rejected).** Two seams for one feature, and it buys the ACL entry the first option was rejected for while still needing the Rust commands.

## Consequences

- **Read this as surface reduction, NOT as an XSS mitigation.** The 2026-10-10 review (`docs/reviews/2026-10-10-client-spawn-surface-and-csp.md`) established that script running in the app's own document can call `__TAURI_INTERNALS__.invoke` without importing anything, that the per-run invoke key authenticates the transport rather than the caller, and that this app defines no `__app-acl__` — so injected script can already reach every registered custom command, `install_update` included. Moving the seam to Rust does not narrow that. What it does buy: the capability file stays a closed list that a `remote` block or a CSP relaxation cannot widen by accident, and the install path has one owner.
- **The plugin's four granular permissions never appear in this repo**, so the ACL stays reviewable as the four entries it is today. Reaching for `updater:default` later should be a deliberate change to this decision, not an escalation hatch.
- **We own the parts the official API would have handled**, and each is a place a naive port would be wrong: the progress event is rate-limited on the Rust side (the plugin's callback fires per TCP chunk with no coalescing — `updater.rs:829-836` — so a ~124 MB AppImage is thousands of IPC events); the check result is a three-way tagged type, because a `latest.json` 404 surfaces as `ReleaseNotFound` ("Could not fetch a valid release JSON from the remote") and NOT as a null return, so "up to date" and "the update server is broken" are different states and the UI must not merge them; and the Windows install never resolves, because `install_inner` calls `std::process::exit(0)` once `ShellExecuteW` succeeds, so the UI announces "this window will close" before awaiting rather than after.
- **No `tauri-plugin-process` dependency.** Restart goes through `AppExt::restart()`, which is the reason the second plugin disappeared.
- **Nothing checks for updates on launch**, because nothing does so by itself — `Builder::build()` only registers commands, so auto-check would be app code we wrote. Settings' manual action is the only trigger, which keeps the shipped app from generating update traffic we cannot retract after release.
