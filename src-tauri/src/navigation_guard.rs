//! The navigation guard: the Client can only ever navigate to ITSELF.
//!
//! Until now Tauri's `on_navigation` default returned `true` for every url
//! (`tauri-2.12.2/src/plugin.rs:287`), so a click on any anchor the Client
//! does not intercept replaced the Client's own page with someone else's —
//! inside a frameless window (`tauri.conf.json`: `decorations: false`) with no
//! back, no reload and no address bar. The per-anchor `OpenAnchor` handlers
//! (ADR 0051 Tasks 4-7) fix the anchors we know about; this module makes the
//! failure structurally impossible for the anchors nobody has written yet, and
//! it is the second layer behind `crate::open` (whose module doc says so).
//!
//! # Why a `Plugin` and not the window builder
//!
//! The app window is declared in `tauri.conf.json` (`app.windows`), never
//! built in Rust, so `WebviewWindowBuilder::on_navigation` is unreachable for
//! it. `tauri::plugin::Builder::on_navigation` IS consulted for a
//! config-created window — every webview's navigation handler ends up calling
//! the registered plugins (`tauri-2.12.2/src/manager/webview.rs:625`) and any
//! plugin that answers `false` wins (`tauri-2.12.2/src/plugin.rs:953-962`) — so
//! the guard lives in `lib.rs` as a plugin named `navigation-guard`.
//!
//! # The allowed set, and the url each rule exists for
//!
//! Getting this set wrong BRICKS the app: a refused initial load is a blank
//! window, and a refused IPC origin is an app whose `invoke` never returns.
//! So each rule names the url it is for:
//!
//! * `tauri:` — `tauri://localhost` is the embedded app on macOS/Linux
//!   (`tauri-2.12.2/src/protocol/mod.rs:32-39`: a custom protocol's origin is
//!   `<scheme>://localhost` everywhere except Windows/Android), and the origin
//!   Tauri stamps on an IPC request (`tauri-2.12.2/src/ipc/protocol.rs:586`).
//! * `http`/`https` on `localhost` / `127.0.0.1` — `devUrl`
//!   (`tauri.conf.json`: `http://localhost:1420`), i.e. `pnpm tauri dev`.
//! * `http`/`https` on ANY `<name>.localhost` — the Windows/Android form of
//!   the same origin (`http(s)://<scheme>.localhost` in that same `origin()`),
//!   which covers `tauri.localhost` (the app), `ipc.localhost` (`invoke`) and
//!   `asset.localhost` (`convertFileSrc`). A host under `.localhost` only
//!   resolves when a custom protocol of that name is REGISTERED in this
//!   webview, so no web content can be served there — that is why the whole
//!   suffix is safe to accept, `example.com.localhost` included.
//! * `http`/`https`/`ws`/`wss` on `TAURI_DEV_HOST` — with that variable set
//!   Vite serves the bundle from a LAN address (`vite.config.ts:5-6`) and
//!   runs HMR on port 1421 (`vite.config.ts:27-32`); without the rule,
//!   `pnpm tauri dev` for a phone/remote setup would load nothing.
//! * `ws`/`wss` on `localhost` / `127.0.0.1` — Vite's HMR socket
//!   (`ws://localhost:1420`, `:1421` with a dev host). A websocket is not a
//!   navigation action either, so this is insurance for an engine whose handler
//!   does see it, not the thing that keeps HMR alive.
//! * `about:blank` — the webview boots on it and that load passes through
//!   `on_navigation`.
//!
//! Everything else — every real website, `file:`, `javascript:`, `data:`,
//! `slack:` — is refused. (Real links reach the OS through `crate::open` /
//! the `external_open` command instead; Task 4-7 wire the anchors to it.)
//!
//! # Why there is no `ipc` rule
//!
//! On Linux and macOS `invoke` is a `fetch()` to `ipc://localhost/<cmd>`, and
//! wry only runs the navigation handler for a *navigation action*
//! (`wry-0.57.0/src/webkitgtk/mod.rs:554-558`: any other policy type returns
//! without consulting the handler). So IPC never reaches this predicate and
//! needs no allowance; on Windows it is `http://ipc.localhost`, which the
//! `.localhost` rule covers anyway. Adding an `ipc` rule would therefore only
//! widen the set for a case that cannot occur.
//!
//! # What this does NOT cover
//!
//! No `on_new_window` handler: a plugin has no such hook, wry's default
//! already denies a new window, and ADR 0051 Task 7 removes the app's only
//! `target="_blank"`. Subresource loads (`<img>`, `fetch`, XHR) are not
//! navigations and are unaffected — CSP would be the tool for those, and
//! `app.security.csp` is deliberately untouched. Designated render webviews
//! (matching [`RENDER_WEBVIEW_PREFIX`], ADR 0058) are exempted by label
//! before `is_app_url`.
//!
//! [`is_app_url`] is pure (the env var is read once by the caller in `lib.rs`),
//! so the whole decision table is unit-tested below — a refused initial load or
//! a refused `invoke` is a bricked app, which is exactly why the allowed set is
//! pinned row by row rather than smoke-tested. What the tests CANNOT prove is
//! the live one: `pnpm tauri dev` still loading the Client with the sidebar's
//! `invoke` returning. That is a GUI step, and it needs a human on each
//! platform.

use tauri::Url;

/// Hosts that are this machine, whatever the scheme.
const LOOPBACK_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

/// The suffix a Tauri custom-protocol origin carries on Windows/Android
/// (`http(s)://<scheme>.localhost`).
const LOCALHOST_SUFFIX: &str = ".localhost";

/// Is `host` the dev host? Compared lowercased because `Url` lowercases the
/// host it parsed, while the env var is whatever the user typed.
fn is_dev_host(host: &str, dev_host: Option<&str>) -> bool {
    dev_host.is_some_and(|dev| dev.to_ascii_lowercase() == host)
}

/// `<name>.localhost` — a registered custom protocol's origin on
/// Windows/Android. The empty name (`.localhost` itself) is not one.
fn is_custom_protocol_host(host: &str) -> bool {
    host.strip_suffix(LOCALHOST_SUFFIX)
        .is_some_and(|name| !name.is_empty())
}

/// Is `url` the app's OWN page — the dev server, the custom protocol,
/// `about:blank` (the initial load passes through `on_navigation`), or the
/// dev HMR socket? Everything else, i.e. every real website, is refused.
///
/// `dev_host` is the `TAURI_DEV_HOST` env value when set (`vite.config.ts:5-6`
/// serves the dev bundle from a LAN address in that mode), so the guard does
/// not brick `pnpm tauri dev` with that variable set.
pub fn is_app_url(url: &Url, dev_host: Option<&str>) -> bool {
    match url.scheme() {
        // The custom protocol: `tauri://localhost` on macOS/Linux, and the
        // `tauri://localhost` IPC origin.
        "tauri" => true,
        "http" | "https" => url.host_str().is_some_and(|host| {
            LOOPBACK_HOSTS.contains(&host)
                || is_custom_protocol_host(host)
                || is_dev_host(host, dev_host)
        }),
        // The dev HMR socket. No `.localhost` rule here: no custom protocol
        // is served over a websocket.
        "ws" | "wss" => url
            .host_str()
            .is_some_and(|host| LOOPBACK_HOSTS.contains(&host) || is_dev_host(host, dev_host)),
        // The page the webview boots on. Not the whole `about:` scheme.
        "about" => url.path() == "blank",
        _ => false,
    }
}

/// The label prefix that marks a webview as a designated render webview.
/// This prefix carries two guarantees, not one: it is what exempts a webview
/// from the app's own navigation rules (ADR 0058) AND what
/// [`should_track_label`] keys the window-state exclusion on. Changing it
/// silently changes the scope of both.
pub const RENDER_WEBVIEW_PREFIX: &str = "web-fetch-";

/// Is this webview one of ours — a designated render webview, which may
/// navigate anywhere? This is a decision about the VIEWER, not the url, so
/// `is_app_url` is untouched and the app's own window keeps the
/// "can only navigate to itself" guarantee that makes a hijacked webview
/// structurally impossible (ADR 0051).
pub fn is_render_webview(label: &str) -> bool {
    label.starts_with(RENDER_WEBVIEW_PREFIX)
}

/// Does `tauri-plugin-window-state` get to remember this window? Note the
/// polarity is the inverse of [`is_render_webview`]'s: `true` here means "the
/// plugin MAY track it". `false` for the designated render webviews — the
/// plugin's default flags include `StateFlags::VISIBLE`, and its
/// `on_window_ready` restore calls `show()` + `set_focus()` for any label with
/// no saved state, which is EVERY render webview because its label carries a
/// fresh uuid (`web-fetch-render-<uuid>`, `agent/worker/core.rs`). A hidden
/// window that the plugin reveals is issue #91.
///
/// The same filter keeps `web-fetch-*` out of `.window-state.json` — in
/// `2.4.0`, the version `Cargo.lock` resolves, the filter check returns before
/// the plugin inserts the label into its state cache, and the save writes that
/// whole cache without consulting the filter, so an unfiltered per-fetch label
/// accumulates forever. **A plugin bump must re-check that ordering**; the
/// accumulation argument dies with it, the reveal argument does not.
pub fn should_track_label(label: &str) -> bool {
    !is_render_webview(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse-or-panic so a typo in a fixture is a panic, not a silent skip.
    fn url(s: &str) -> Url {
        Url::parse(s).unwrap_or_else(|e| panic!("unparseable fixture {s:?}: {e}"))
    }

    fn check(rows: &[(&str, bool)]) {
        for (s, expected) in rows {
            assert_eq!(
                is_app_url(&url(s), None),
                *expected,
                "is_app_url({s:?}, None) should be {expected}"
            );
        }
    }

    /// The custom protocol: `tauri://localhost` is the app's own page on
    /// macOS/Linux (and the IPC origin). The initial load passes through
    /// `on_navigation`, so refusing it would show a blank window forever.
    #[test]
    fn allows_the_tauri_custom_protocol() {
        check(&[
            ("tauri://localhost", true),
            ("tauri://localhost/index.html", true),
        ]);
    }

    /// `devUrl` (`tauri.conf.json`: `http://localhost:1420`) is what
    /// `pnpm tauri dev` loads; the Client is a hash router so the fragment
    /// must not confuse the host check.
    #[test]
    fn allows_the_dev_server() {
        check(&[
            ("http://localhost:1420/", true),
            ("http://localhost:1420/#/x", true),
            ("http://127.0.0.1:1420/", true),
        ]);
    }

    /// Windows/Android have no custom-protocol scheme, so Tauri serves the
    /// app and every other custom protocol off `http(s)://<name>.localhost`
    /// (`tauri-2.12.2/src/protocol/mod.rs:32-39`): `tauri.localhost` is the
    /// app, `ipc.localhost` is `invoke`, `asset.localhost` is
    /// `convertFileSrc`. A host under `.localhost` only resolves when a
    /// custom protocol of that name is REGISTERED, so no web content can be
    /// served there — hence ANY `<name>.localhost` is the app's own, and
    /// `example.com.localhost` (which looks like a website and is not one)
    /// is pinned as accepted on purpose.
    #[test]
    fn allows_the_windows_custom_protocol_hosts() {
        check(&[
            ("http://tauri.localhost/", true),
            ("https://tauri.localhost/", true),
            ("http://ipc.localhost/", true),
            ("http://asset.localhost/img.png", true),
            ("http://example.com.localhost:1420/", true),
        ]);
    }

    /// Vite's HMR socket (`vite.config.ts:27-32`): port 1420 with no
    /// `TAURI_DEV_HOST`, 1421 with one.
    #[test]
    fn allows_the_dev_hmr_socket() {
        check(&[
            ("ws://localhost:1420/", true),
            ("ws://127.0.0.1:1421/", true),
            ("wss://localhost:1421/", true),
        ]);
    }

    /// The webview starts on `about:blank` and that load reaches
    /// `on_navigation`; refusing it bricks the window before the app URL is
    /// ever attempted.
    #[test]
    fn allows_the_initial_blank_page() {
        check(&[("about:blank", true)]);
    }

    /// `TAURI_DEV_HOST` makes Vite serve the bundle from a LAN address
    /// (`vite.config.ts:5-6`) and the HMR socket with it
    /// (`vite.config.ts:27-32`), so the guard must know that host too or
    /// `pnpm tauri dev` loads nothing.
    #[test]
    fn allows_the_dev_host_when_it_is_set() {
        let dev = Some("192.168.1.20");
        for s in ["http://192.168.1.20:1420/", "ws://192.168.1.20:1421/"] {
            assert!(
                is_app_url(&url(s), dev),
                "is_app_url({s:?}, Some(dev)) should be true"
            );
        }
    }

    /// Hostnames are case-insensitive and `Url` lowercases the host it
    /// parsed, so a `TAURI_DEV_HOST=MyBox.Local` still matches.
    #[test]
    fn allows_the_dev_host_whatever_case_the_env_was_written_in() {
        assert!(is_app_url(
            &url("http://mybox.local:1420/"),
            Some("MyBox.Local")
        ));
    }

    /// A host is the dev host, not the whole dev host's subnet, and only
    /// when the env var was actually set.
    #[test]
    fn refuses_the_dev_host_when_it_is_not_set() {
        check(&[("http://192.168.1.20:1420/", false)]);
    }

    /// Every real website, and every scheme that is not the app's own. This
    /// is the whole point of the guard: an anchor nobody wrote a handler for
    /// must not eat the Client's UI (frameless window, no back, no reload).
    #[test]
    fn refuses_every_real_website_and_every_other_scheme() {
        check(&[
            ("https://example.com/", false),
            ("file:///etc/passwd", false),
            ("javascript:alert(1)", false),
            ("data:text/html,x", false),
            ("ftp://host/x", false),
            ("slack://chan", false),
        ]);
    }

    /// Setting `TAURI_DEV_HOST` widens the set to that ONE host; it does not
    /// turn the guard into "allow the internet".
    #[test]
    fn refuses_the_real_web_even_with_a_dev_host_set() {
        assert!(
            !is_app_url(&url("https://example.com/"), Some("192.168.1.20")),
            "a dev host must not widen the guard to the whole internet"
        );
    }

    /// The `.localhost` rule is a suffix on a DOT boundary, not a substring:
    /// `evil.localhost.example.com` is a normal DNS name anyone can register.
    #[test]
    fn refuses_hosts_that_merely_look_like_localhost() {
        check(&[
            ("http://evil.localhost.example.com/", false),
            ("http://notlocalhost/", false),
            ("http://localhost.evil.com/", false),
        ]);
    }

    /// `about:` is not a blanket allow — only the blank page the webview
    /// boots on.
    #[test]
    fn refuses_about_pages_that_are_not_blank() {
        check(&[("about:config", false), ("about:srcdoc", false)]);
    }

    /// A ws/wss url to a real host is refused even though the http(s) rule
    /// is the one that carries the `.localhost` allowance.
    #[test]
    fn refuses_websockets_to_foreign_hosts() {
        check(&[
            ("ws://example.com:1421/", false),
            ("wss://evil.com/", false),
        ]);
    }

    #[test]
    fn identifies_render_webviews_by_label_prefix() {
        assert!(is_render_webview("web-fetch-9a1c"));
        assert!(!is_render_webview("main"));
        assert!(!is_render_webview("webfetch-1"));
        assert!(!is_render_webview(""));
    }

    #[test]
    fn window_state_never_tracks_a_render_webview() {
        // issue #91: the plugin's default StateFlags include VISIBLE, and it
        // show()s + set_focus()es any label with no saved state.
        assert!(!should_track_label("web-fetch-render-0f2a"));
        assert!(!should_track_label(RENDER_WEBVIEW_PREFIX));
        // The app's own window MUST stay tracked — ADR 0021 reveals the
        // `visible: false` main window through this very plugin.
        assert!(should_track_label("main"));
        assert!(should_track_label("anything-else"));
    }
}
