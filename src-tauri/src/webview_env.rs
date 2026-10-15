//! The Linux WebView environment work-around (the app bakes in what the
//! README used to ask users to export by hand).
//!
//! # What it does
//!
//! On Linux, WebKitGTK renders through the DMABUF zero-copy path when the
//! compositor supports it. On NVIDIA drivers that path is broken in the
//! current webkit2gtk-4.1 builds — the symptom is a start-up crash, or a
//! window that renders but lags badly behind the pointer — and upstream's
//! documented remedy is to export `WEBKIT_DISABLE_DMABUF_RENDERER=1`
//! before launching. Asking every user to do that does not work: a
//! double-clicked desktop entry carries no shell environment, so the
//! crash lands on exactly the users who cannot read a README note. The
//! app therefore sets the variable itself, before Tauri creates the
//! WebView.
//!
//! # Why "fill it when absent", not "always set it"
//!
//! The variable is a blunt instrument: on Mesa (Intel/AMD) DMABUF is the
//! modern fast path, so forcing the flag costs those users a rendering
//! downgrade to buy what NVIDIA users need. That trade is the app's
//! default, but it stays a default: any value already in the environment
//! — including an empty one — wins, so `WEBKIT_DISABLE_DMABUF_RENDERER=0`
//! (or `=`) is the supported escape hatch back to the zero-copy path.
//! WebKit reads the variable through `g_getenv` in this process, so
//! setting it before the Builder is early enough; the WebProcess is a
//! fork/exec of a helper that inherits the same environment.
//!
//! # Why Linux only
//!
//! WebKitGTK exists only on the Linux build (`GTK`/`webkit2gtk-4.1` —
//! see the README's prerequisite list). macOS uses WKWebView and Windows
//! WebView2, neither of which reads this variable, so the module is
//! `#[cfg(target_os = "linux")]` in `lib.rs` rather than a runtime check.

/// The variable WebKitGTK reads to opt out of the DMABUF renderer.
pub const DMABUF_ENV_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// The value the app bakes in (the upstream documented opt-out — WebKit
/// treats exactly `1` as truthy here).
const DMABUF_ENV_VALUE: &str = "1";

/// The pure decision (the testable seam — [`apply_dmabuf_workaround`] is
/// the side effect): `Some(value)` means "set the variable to this",
/// `None` means "leave the process environment alone".
///
/// `existing` is the current value of [`DMABUF_ENV_VAR`] (`None` = unset).
/// A value that is merely present — empty or `0` — is a user's own choice
/// and is never overwritten.
pub fn dmabuf_workaround_value(existing: Option<&std::ffi::OsStr>) -> Option<&'static str> {
    if existing.is_none() {
        Some(DMABUF_ENV_VALUE)
    } else {
        None
    }
}

/// Apply the work-around to the process environment (the only mutation).
/// Called from `lib.rs`'s `run` BEFORE `tauri::Builder::default()`, which
/// is what makes it reach the WebView: the variable is read at WebView
/// creation, inside `.run(...)`.
pub fn apply_dmabuf_workaround() {
    let existing = std::env::var_os(DMABUF_ENV_VAR);
    if let Some(value) = dmabuf_workaround_value(existing.as_deref()) {
        // Edition 2021: `set_var` is safe, and this runs on the main
        // thread before the Builder starts any worker thread — the one
        // moment the process environment has no concurrent readers.
        std::env::set_var(DMABUF_ENV_VAR, value);
        crate::agent::debuglog::log("webview-env: WEBKIT_DISABLE_DMABUF_RENDERER=1 (baked in)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn os(v: &str) -> &OsStr {
        OsStr::new(v)
    }

    /// An unset variable is the ONE case the app fills in — this is the
    /// NVIDIA user who has never heard of the flag.
    #[test]
    fn sets_the_flag_when_the_environment_is_silent() {
        assert_eq!(dmabuf_workaround_value(None), Some(DMABUF_ENV_VALUE));
    }

    /// The user's own `0` means "keep the zero-copy path" (Mesa users,
    /// or anyone who wants the fast path back). It must survive.
    #[test]
    fn honours_an_explicit_off() {
        assert_eq!(dmabuf_workaround_value(Some(os("0"))), None);
        assert_eq!(dmabuf_workaround_value(Some(os("false"))), None);
    }

    /// A value the user already set to `1` is the same decision the app
    /// would have made — still no write, so the log line claiming the app
    /// did it stays honest.
    #[test]
    fn honours_a_pre_existing_opt_out() {
        assert_eq!(dmabuf_workaround_value(Some(os("1"))), None);
    }

    /// Even an EMPTY value is a choice: the app never overwrites a
    /// variable that exists, and WebKit reads an empty value as "not
    /// truthy", so `WEBKIT_DISABLE_DMABUF_RENDERER=` is a valid way to
    /// decline the work-around.
    #[test]
    fn honours_an_empty_value_as_a_choice() {
        assert_eq!(dmabuf_workaround_value(Some(OsStr::new(""))), None);
    }

    /// The real environment, through the mutation path: a variable that
    /// exists is untouched by [`apply_dmabuf_workaround`].
    #[test]
    fn apply_leaves_a_set_variable_untouched() {
        let lock = crate::test_support::env_lock();
        let previous = std::env::var_os(DMABUF_ENV_VAR);
        std::env::set_var(DMABUF_ENV_VAR, "0");
        apply_dmabuf_workaround();
        assert_eq!(std::env::var(DMABUF_ENV_VAR).as_deref(), Ok("0"));
        restore(previous);
        drop(lock);
    }

    /// …and an unset one gains the opt-out (the shipped default).
    #[test]
    fn apply_sets_the_flag_when_unset() {
        let lock = crate::test_support::env_lock();
        let previous = std::env::var_os(DMABUF_ENV_VAR);
        std::env::remove_var(DMABUF_ENV_VAR);
        apply_dmabuf_workaround();
        assert_eq!(
            std::env::var(DMABUF_ENV_VAR).as_deref(),
            Ok(DMABUF_ENV_VALUE)
        );
        restore(previous);
        drop(lock);
    }

    /// Put the process environment back for the sibling tests (the env
    /// lock is held, so this cannot race another test's read).
    fn restore(previous: Option<std::ffi::OsString>) {
        match previous {
            Some(v) => std::env::set_var(DMABUF_ENV_VAR, v),
            None => std::env::remove_var(DMABUF_ENV_VAR),
        }
    }
}
