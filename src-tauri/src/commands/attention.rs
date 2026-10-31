//! The attention IPC surface (ADR 0039): the two commands the renderer calls
//! to arm and disarm the Supervisor-side countdown.
//!
//! Both are pure delegation to [`crate::attention::AttentionTimer`] — the
//! rule of when/what lives in the renderer, and the timer is handed the delay
//! and the already-composed text. Rust reads no settings and resolves no
//! Session.

use std::sync::Arc;

use crate::agent::errors::AttentionError;
use crate::attention::{AlertText, AttentionTimer};

/// The longest title the OS is asked to render, in CHARS.
const MAX_TITLE_CHARS: usize = 120;
/// The longest body the OS is asked to render, in CHARS.
const MAX_BODY_CHARS: usize = 300;

/// The first `n` CHARS of `s`, as a `String`.
///
/// A deliberately local copy of the private `cap_chars` in
/// `agent/session/naming.rs:47` — that one is a plain `fn` inside the private
/// `mod naming` of the private `mod session`, so `crate::commands` cannot reach
/// it, and promoting it (and both `mod` declarations) is a wider change than
/// this hardening pass should make. Any THIRD caller should hoist one shared
/// helper rather than copy this a second time.
///
/// Char-wise and never a byte slice, for the original's reason: `&s[..n]` panics
/// when `n` lands inside a multi-byte code point, and the text here arrives from
/// a webview rendering user/model text from any script.
fn cap_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Bound the text that flows into an OS notification: trim, then cap each field
/// by its own char budget, and refuse a body that trims to nothing.
///
/// This is HARDENING THE SURFACE, not fixing a known overflow bug: the renderer's
/// `attentionAlertText` (`src/lib/attention.ts`) composes bounded text — the
/// title is the constant `"Archimedes"`, and the body is `"<label> needs your
/// answer"` / `"… finished — waiting for you"` where `<label>` is a session title
/// Rust already capped at 80 chars (`naming::TITLE_MAX_CHARS`), a folder name, or
/// `"A session"`. Nothing reachable from the UI overflows a toast today.
///
/// Why bound it anyway: `attention_arm` is the one command whose arguments end up
/// rendered by the OPERATING SYSTEM, and `tauri.conf.json` sets
/// `security.csp: null` while the app renders untrusted model output — so "the
/// renderer is trusted" is a weaker premise in this crate than in most, and the
/// rest of the crate does validate its IPC input (`validate_images` behind
/// `send_prompt`'s `InvalidPrompt` path). This text also leaves the app: it is
/// handed to the desktop's notification SERVER, where an absurd field is at best
/// reshaped by the host and at worst mis-lays its UI — a boundary the crate does
/// not control and so should not feed unbounded.
///
/// The title is not length-rejected, only capped: a body-only notification is a
/// legitimate shape an OS renders fine, and a refusal would drop the alert.
/// An empty BODY is refused, because an empty body means the renderer composed
/// nothing — a renderer bug worth surfacing, not a blank toast to blame on the
/// app.
fn alert_text(title: &str, body: &str) -> Result<AlertText, String> {
    // Trim BEFORE the cap, so padding cannot consume a char of the budget.
    let title = cap_chars(title.trim(), MAX_TITLE_CHARS);
    let body = cap_chars(body.trim(), MAX_BODY_CHARS);
    if body.is_empty() {
        return Err("attention_arm: empty alert body (the renderer composed nothing)".to_string());
    }
    Ok(AlertText { title, body })
}

/// The countdown a `delay_secs` value turns into — 24 h is a SANITY CEILING,
/// not a policy clamp.
///
/// The reason is not overflow: `Duration::from_secs(u64::MAX)` is perfectly
/// valid (the panicking constructors are `from_secs_f64` / `from_secs_f32` /
/// `Duration::new`). The reason is that an absurd hand-edited value would
/// become an effectively-never countdown — `tokio::time::sleep` clamps an
/// overflowing deadline to its far-future sentinel — so the alert would silently
/// stop ever arriving. Anything past a day is the "someone edited the file"
/// case; the Settings select is the only real producer and tops out at 60 s.
/// A `0` still means "fire immediately", exactly as typed.
fn countdown(delay_secs: u64) -> std::time::Duration {
    std::time::Duration::from_secs(delay_secs.min(86_400))
}

/// Arm the attention countdown (ADR 0039: the Supervisor owns the clock).
/// Arming REPLACES any countdown already in flight — one alert at a time.
///
/// `delay_secs = 0` means "fire immediately", exactly as typed, and that stays.
/// A reviewer's concern that `0` allows a notification flood is real but is
/// reachable ONLY from an already-fully-compromised renderer, which has strictly
/// more damaging commands available (`send_prompt` runs arbitrary agent turns);
/// refusing `0` here would cost the tested "fire immediately" semantic and buy
/// nothing against that threat model.
#[tauri::command]
pub async fn attention_arm(
    timer: tauri::State<'_, Arc<AttentionTimer>>,
    delay_secs: u64,
    title: String,
    body: String,
) -> Result<(), AttentionError> {
    // `alert_text` stays a non-command `String` helper (its inline tests pin its
    // sentence); the command is the boundary that chooses the wire type, and the
    // only reason it can refuse here is the empty body — so the `String` maps
    // onto `EmptyBody`, whose `#[error(…)]` carries that sentence VERBATIM
    // (task14's frozen pair), keeping the wire `message` byte-identical.
    let text = alert_text(&title, &body).map_err(|_| AttentionError::EmptyBody)?;
    timer
        .arm(countdown(delay_secs), text.title, text.body)
        // A refusal, not a crash: the renderer logs this through `logFailure`
        // and the chat carries on (a notification failure must never break it).
        .map_err(|_| AttentionError::NoRuntime)
}

/// Disarm the attention countdown. Idempotent — the renderer calls it for
/// EVERY disarm reason (activity, evidence, a disabled setting, unmount).
#[tauri::command]
pub async fn attention_disarm(
    timer: tauri::State<'_, Arc<AttentionTimer>>,
) -> Result<(), AttentionError> {
    timer.disarm();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{alert_text, countdown};
    use std::time::Duration;

    #[test]
    fn the_delay_is_the_value_typed() {
        assert_eq!(countdown(15), Duration::from_secs(15));
        // `0` means "fire immediately", exactly as typed — not "never".
        assert_eq!(countdown(0), Duration::ZERO);
    }

    /// A hand-edited `settings.json` must not be able to arm an
    /// effectively-never countdown (`tokio::time::sleep` clamps an overflowing
    /// deadline to its far-future sentinel, so an absurd value would simply
    /// never alert).
    #[test]
    fn an_absurd_delay_is_capped_at_a_day() {
        assert_eq!(countdown(u64::MAX), Duration::from_secs(86_400));
        assert_eq!(countdown(999_999), Duration::from_secs(86_400));
        // The ceiling itself is reachable, not one short of it.
        assert_eq!(countdown(86_400), Duration::from_secs(86_400));
    }

    /// The text the OS is asked to render survives a normal alert exactly as
    /// composed — no trimming of inner content, no rewriting.
    #[test]
    fn a_normal_title_and_body_pass_through_untouched() {
        let text = alert_text("Archimedes", "api-server finished — waiting for you")
            .expect("a real body is accepted");
        assert_eq!(text.title, "Archimedes");
        assert_eq!(text.body, "api-server finished — waiting for you");
    }

    /// The only thing padding is good for here is looking tidy in the toast.
    #[test]
    fn surrounding_whitespace_is_trimmed() {
        let text = alert_text("  Archimedes  \n", "  api-server needs your answer \t")
            .expect("a real body is accepted");
        assert_eq!(text.title, "Archimedes");
        assert_eq!(text.body, "api-server needs your answer");
    }

    /// An over-long title is cut to `MAX_TITLE_CHARS` — and the cut is
    /// CHAR-wise, not byte-wise.
    ///
    /// The fixture is deliberate: 119 ASCII bytes then a 2-byte `é`, so byte
    /// index 120 falls INSIDE a code point and `&title[..120]` would panic. The
    /// result is 121 bytes for a 120-char cap, which no byte slice can produce.
    #[test]
    fn an_over_long_title_is_capped_by_char_not_by_byte() {
        let title = format!("{}{}", "a".repeat(119), "é".repeat(81));
        assert_eq!(title.chars().count(), 200);

        let text = alert_text(&title, "body").expect("a real body is accepted");
        assert_eq!(text.title.chars().count(), 120, "the cap is 120 CHARS");
        assert_eq!(text.title, format!("{}é", "a".repeat(119)));
        assert_eq!(text.title.len(), 121, "121 bytes for a 120-char cap");
        // The body is untouched at this length.
        assert_eq!(text.body, "body");
    }

    /// The body's own cap, with a 4-byte code point straddling the byte index a
    /// slice would have used (`"b".repeat(300)` is 300 bytes, so the first
    /// emoji starts at 299 and `&body[..300]` splits it).
    #[test]
    fn an_over_long_body_is_capped_by_char_not_by_byte() {
        let body = format!("{}{}", "b".repeat(299), "😀".repeat(60));
        assert_eq!(body.chars().count(), 359);

        let text = alert_text("Archimedes", &body).expect("a real body is accepted");
        assert_eq!(text.body.chars().count(), 300, "the cap is 300 CHARS");
        assert_eq!(text.body, format!("{}😀", "b".repeat(299)));
        assert_eq!(text.body.len(), 303, "303 bytes for a 300-char cap");
    }

    /// Trim first, THEN cut: padding must not eat the budget (a cap-before-trim
    /// order would keep 115 `é` plus the spaces it just trimmed).
    #[test]
    fn the_trim_happens_before_the_cap() {
        let title = format!("  {}  ", "é".repeat(200));
        let text = alert_text(&title, "body").expect("a real body is accepted");
        assert_eq!(text.title, "é".repeat(120));
    }

    /// Both fields are capped at once, each by its own budget.
    #[test]
    fn both_fields_are_capped_together() {
        let text = alert_text(&"t".repeat(500), &"b".repeat(500)).expect("a real body is accepted");
        assert_eq!(text.title.chars().count(), 120);
        assert_eq!(text.body.chars().count(), 300);
    }

    /// A body of nothing but whitespace is a renderer bug (it composed no
    /// alert), and a blank toast is worse than a logged failure. Unicode
    /// whitespace counts — `str::trim` uses the `White_Space` property, so an
    /// NBSP-only body trims to nothing and is refused like a space-only one.
    #[test]
    fn a_blank_body_is_rejected() {
        for body in ["", "   ", " \n\t ", "\u{a0}\u{2028}"] {
            assert!(
                alert_text("Archimedes", body).is_err(),
                "a body that trims to nothing ({body:?}) must be refused, not shown"
            );
        }
    }

    /// An empty body means the renderer composed nothing at all — a bug worth
    /// surfacing, and the refusal must NAME the reason, because the renderer's
    /// only channel is `logFailure` on the rejected promise.
    #[test]
    fn the_refusal_names_the_reason() {
        let err = alert_text("Archimedes", "   ").expect_err("a blank body is refused");
        assert!(
            err.contains("body") && err.to_lowercase().contains("empty"),
            "the message must say what was wrong, got {err:?}"
        );
    }
}
