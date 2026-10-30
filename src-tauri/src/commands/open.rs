//! The External-open IPC surface (ADR 0051): ONE command, ONE delegation.
//!
//! Everything that decides *whether* an href may be opened — URL/path
//! classification, the scheme denylist, the tilde expansion, the `PathBuf::join`
//! that resolves a relative path onto the **Session**'s `cwd` — lives in
//! [`crate::open`]. Two reasons, both load-bearing: the same policy is needed
//! from Rust already (the MCP OAuth browser open), and the path route needs real
//! path semantics, which a renderer cannot give it (a Windows join is not a `/`).
//! So this module decides NOTHING: it moves `Option<String>` into the
//! `Option<&Path>` the policy takes — `as_deref()` alone would be
//! `Option<&str>` — and hands back whatever `open` returns. That is the whole
//! module, and the thinness is the point: a second place that "knows" what a
//! `file:` URL means is a second place to disagree with the first.
//!
//! There is deliberately NO scope check here and NO capability entry behind it
//! (ADR 0051). The opener plugin's ACL is consulted only inside the plugin's own
//! IPC commands; the Rust free functions this ends up calling
//! (`open_url`/`open_path`) never consult it, so `crate::open` IS the policy and
//! `capabilities/default.json` stays untouched. The consequence is accepted, not
//! overlooked: a bug in that policy has nothing behind it, which is why it is
//! unit-tested row by row and why the navigation guard exists as the second layer
//! rather than a scope.

use crate::agent::errors::OpenError;

/// Hand `href` to the OS's own default handler (ADR 0051).
///
/// `href` is whatever the user clicked (a URL, or a path — possibly relative,
/// possibly `~/`-rooted); `cwd` is the active **Session**'s `cwd`, i.e. its
/// **Space**, and `None` means a relative `href` is refused rather than guessed.
/// The `Err` is [`crate::open`]’s typed refusal code
/// (`denied-scheme:javascript`, `relative-without-cwd`, `os-error:…`) wrapped in
/// [`OpenError`], whose `message` IS that code verbatim — the `externalOpen`
/// wrapper logs it and a bug report is read from it, so the sentence is
/// unchanged and `kind` is the envelope's addition (ADR 0063).
#[tauri::command]
pub async fn external_open(href: String, cwd: Option<String>) -> Result<(), OpenError> {
    crate::open::open(&href, cwd.as_deref().map(std::path::Path::new)).map_err(OpenError::Code)
}

#[cfg(test)]
mod tests {
    use super::{external_open, OpenError};

    // These exercise ONLY the refusal arms of the policy, and that is a hard
    // requirement rather than tidiness: every ACCEPTING row would hand a real
    // href to `xdg-open`/`open`/the Windows shell and spawn a browser or a file
    // manager from the test suite. The accepted rows are covered where they
    // belong — `crate::open`'s decision-table tests, which assert on `classify`
    // and never reach the OS. What is pinned here is the only two things this
    // layer owns: that it DELEGATES (no behaviour of its own), and that the
    // typed refusal code survives IPC's error form VERBATIM as the envelope's
    // `message` — it is what the renderer logs and what a bug report gets read
    // from. Since task14 the command answers `OpenError`, so the assertion reads
    // the two halves of the wire value: `kind()` (the new discriminator) and
    // `to_string()` (the same code string the bare `Err(String)` carried).
    //
    // `#[tokio::test]` per `commands::files`/`commands::settings`: the command is
    // `async`, and a refusal returns before the async runtime is entered at all.

    #[tokio::test]
    async fn an_empty_href_refuses_as_empty_through_ipc() {
        let wire = external_open(String::new(), None).await.unwrap_err();
        // The `message` half is the OLD assertion, unchanged: the refusal code
        // survives verbatim. The `kind` half is what the envelope adds.
        assert_eq!(wire.kind(), "invalid_href");
        assert_eq!(wire.to_string(), "empty");
    }

    #[tokio::test]
    async fn a_denied_scheme_refuses_with_its_scheme_name_even_with_a_cwd() {
        let wire = external_open(
            "javascript:alert(1)".to_string(),
            Some("/home/u/proj".to_string()),
        )
        .await
        .unwrap_err();
        assert_eq!(wire.kind(), "denied_scheme");
        assert_eq!(wire.to_string(), "denied-scheme:javascript");
    }

    #[tokio::test]
    async fn a_relative_href_without_a_cwd_refuses_rather_than_guessing() {
        // The `cwd: None` arm in particular pins the `Option<String>` →
        // `Option<&Path>` move: a wrapper that defaulted a missing cwd to `""`
        // or `"."` would resolve `notes.md` against the CWD of the APP PROCESS
        // and open something the user never named.
        let wire = external_open("notes.md".to_string(), None)
            .await
            .unwrap_err();
        assert_eq!(wire.kind(), "relative_without_cwd");
        assert_eq!(wire.to_string(), "relative-without-cwd");
        assert!(matches!(wire, OpenError::Code(_)));
    }
}
