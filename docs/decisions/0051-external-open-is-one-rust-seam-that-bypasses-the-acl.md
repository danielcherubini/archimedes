---
status: accepted
date: 2026-10-14
superseded-by:
---

# External open is one Rust seam that deliberately bypasses the Tauri ACL

Clicking a link had to reach the operating system's default handler (`xdg-open` / `open` / the Windows shell), and the Client had three mechanisms doing it and none of them worked end to end: a markdown anchor with no handler (which NAVIGATED the Client's own webview — Tauri's default `on_navigation` hook returns `true`), a `target="_blank"` link wry silently denies, and an `openPath` call the capability never granted. We decided to put ONE policy in `src-tauri/src/open.rs` — normalise, apply a scheme **denylist**, join a relative path against the **Session**'s `cwd` with `PathBuf`, call the plugin's Rust free functions — behind a thin `external_open { href, cwd }` command, and to let the navigation guard be the second layer instead of the ACL. The reason is that the policy needs real path semantics (a Windows path join is not a string concatenation) and the same policy is needed from Rust already (the MCP OAuth browser open), so one tested Rust function beats a policy split across a capability scope, a JS classifier and a JS path join.

## Considered Options

- **The ACL scope as the policy** (rejected): call `openUrl`/`openPath` from the renderer and declare the denylist in `capabilities/default.json` (`allow: [{url: "*"}]` + `deny: [{url: "javascript:*"}, …]` + `opener:allow-open-path`). It keeps Tauri's second layer, but splits one decision across three places, and leaves the path join in JavaScript — where a `/`-joined Windows path is wrong.
- **Both** (rejected): the command seam plus a widened scope behind it. The belt and the braces would do the identical job, so the second one buys nothing except the illusion of a second opinion.

## Consequences

- **`capabilities/default.json` deliberately stays untouched** by this work. An opener permission granted to nothing is the visible symptom of this decision, not an oversight — the plugin's `scope.rs` is consulted only inside `commands.rs`, so a call from our own Rust code is never scope-checked and our function IS the policy. A bug in it has nothing behind it.
- **The scheme policy is a DENYLIST, not an allow-list.** `slack://`, `ssh://`, `ftp://` and `file://` reach the OS, because the OS is the thing that knows what a scheme means. `javascript:`, `data:`, `vbscript:`, `blob:` and `filesystem:` are refused. The transcript's links are model-authored, so this is a deliberate acceptance that a prompt-injected custom-scheme link launches whatever the user's machine has registered for it — the click is the consent.
- **The renderer ALSO blanks the denied schemes** in `react-markdown`'s `urlTransform`, so no `javascript:` href is ever in the DOM. That list is presentation hygiene (middle-click and keyboard paths do not pass through a cancelable click), not a second policy — the Rust list is authoritative.
- **The override is load-bearing, not cosmetic.** `react-markdown@10`'s default `urlTransform` blanks every protocol outside `http|https|irc|ircs|mailto|xmpp`, so without it `ssh://` renders `href=""` and the wide policy is unreachable.
- **`react-markdown` URL sanitization is no longer something we get for free** — replacing `defaultUrlTransform` means we own what survives into the DOM. The `urlTransform` override must keep refusing the denied schemes and must normalise away tab/LF/CR, which is how `java&#10;script:` is spelled in markdown.
- **A path is NOT judged against the _Boundary_.** A path outside the _Space_ opens too. That is not a _Boundary_ widening: the _Boundary_ governs what the **Agent** may reach, never what the user's own click opens.
- **This seam expands a tilde**, which is the one place in the app that does (`~/x` → `skills::home_dir()`). The rule _File completion_ carries is narrower than it used to read — nothing on the completion/_Boundary_ path normalises a tilde — and its glossary entry is amended to say so rather than claim the app never does.
- **The navigation guard is a local `Plugin` implementing `on_navigation`, not a window builder hook**, because the window is declared in `tauri.conf.json` and `WebviewWindowBuilder::on_navigation` is unreachable for a config-created window. It refuses any origin that is not the app's own, which is what makes "the Client ate its own UI" structurally impossible for any future component that forgets the handler. There is no `on_new_window` hook for a plugin and the default already denies, so `target="_blank"` stays dead by design — nothing in the app writes it any more.
