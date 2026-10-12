//! The session-naming PASS — the port of pi's `session-name` extension, in
//! two halves. The PRIMITIVES (pi's `generateTitle`, decomposed): what text
//! feeds the title prompt, how the model's answer is cleaned, which thinking
//! level the request asks for, and which model the `sessionNamingModel`
//! override names — pure functions, so each rule is testable on its own.
//! The WIRE-UP: `maybe_name_session` (the `agent_end` hook the router calls,
//! pi's handler) and the `name_session` task it spawns (the model call, the
//! conditional write, the `session-titled` emit, the per-session bookkeeping).
//!
//! Like `router.rs`, this is a CHILD module of `session`, so it may see the
//! parent's private items (the `SessionManager` fields, the naming bookkeep‐
//! ing map) with no visibility widening.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::json;

use crate::agent::events::EventSink;
use crate::agent::harness::catalog::{Model, ModelCatalog};
use crate::agent::harness::model_key::ModelKey;
use crate::agent::harness::provider::{
    ChatMessage, ChatRole, FinishReason, MessageContent, ModelOptions, ModelRequest, ProviderEvent,
};
use crate::agent::harness::SessionStore;
use crate::agent::tools::ContentBlock;
use crate::config::{load_settings, Settings};
use crate::storage::Db;

use super::{EffectiveCatalog, ProviderFactory, SessionManager};

/// Per-side character cap on the conversation excerpt (pi: 500).
pub(crate) const EXCERPT_CAP: usize = 500;
/// The title's hard cap (pi: 80).
pub(crate) const TITLE_MAX_CHARS: usize = 80;
/// Consecutive title-request failures tolerated before naming stops
/// (pi: 3).
pub(crate) const MAX_FAILURES: u32 = 3;

/// The first `n` CHARS of `s`. The module's ONLY cut on user-supplied text,
/// and deliberately not a byte slice: the excerpt is whatever the user typed,
/// and `&s[..n]` panics when `n` lands inside a multi-byte code point (one
/// two-byte `é` at position 499 of a 500-char cap is enough).
fn cap_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The text of a transcript message: `MessageContent::Text` verbatim, and
/// `MessageContent::Blocks` → the `ContentBlock::Text` parts joined with `\n`
/// — the same "text blocks only" rule pi filters for (`b?.type === "text"
/// && typeof b.text === "string"`), so an image block is not a segment and
/// does not consume a `\n` of the join. NOT trimmed: the caller trims, so
/// verbatim-vs-joined is the only thing this function decides.
pub(crate) fn message_text(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Image { .. } => None,
            })
            .collect::<Vec<&str>>()
            .join("\n"),
    }
}

/// The first exchange: the first `User` message with non-empty text, then
/// the first `Assistant` message with non-empty text AFTER it. Each side is
/// `"<Role>: " + text`, trimmed and capped at `EXCERPT_CAP` CHARS. Other
/// roles (system / tool) are ignored, and an assistant message that precedes
/// any user message is ignored (pi requires `foundUser` before it will accept
/// an assistant line — a restored preamble cannot become the title's subject).
/// `None` when there is no user text at all; an assistant side is OPTIONAL
/// (a turn whose assistant output was all tool calls still names from the
/// user text — pi's `conversationText` is non-empty on the user line alone).
///
/// One deliberate improvement on pi: a BLANK message is not a candidate at
/// all. pi sets `foundUser` on a whitespace-only first message, skips every
/// later one, and then bails at its own `conversationText.trim()` guard — so
/// such a session is never named. Here the first NON-EMPTY user text wins.
pub(crate) fn first_exchange_text(messages: &[ChatMessage]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut found_user = false;
    let mut found_assistant = false;
    for m in messages {
        // The role decides WHICH side this row can fill, so it is matched
        // first and the non-excerpt roles leave immediately.
        let label = match m.role {
            ChatRole::User if !found_user => "User",
            // `found_user` in the guard IS pi's ordering rule: an assistant
            // row before any user row is not the second half of an exchange.
            ChatRole::Assistant if found_user && !found_assistant => "Assistant",
            _ => continue,
        };
        let body = message_text(&m.content);
        let body = body.trim();
        if body.is_empty() {
            // Blank text does not fill this side, so the NEXT message of the
            // same role is still a candidate (pi's `texts.length > 0`).
            continue;
        }
        lines.push(format!("{label}: {}", cap_chars(body, EXCERPT_CAP)));
        if label == "User" {
            found_user = true;
        } else {
            found_assistant = true;
        }
        // Both sides found — pi's `if (foundUser && foundAssistant) break`, so
        // a long transcript is not walked to its end for two lines of text.
        if found_user && found_assistant {
            break;
        }
    }
    // The user line is the only mandatory side, so "no lines" is exactly "no
    // user text at all" (an assistant row is only ever pushed after one).
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// The title request's single user message, VERBATIM pi's copy: the wording
/// is what small models answer well, so it is data pinned by a test rather
/// than prose to re-word. The excerpt rides between the `<conversation>`
/// tags, on its own line, with no extra blank lines around it.
pub(crate) fn title_prompt(exchange: &str) -> String {
    [
        "Generate a concise title (3-8 words) for this conversation.",
        "The title should capture what the user is working on.",
        "Return only the title, nothing else.",
        "",
        "<conversation>",
        exchange,
        "</conversation>",
    ]
    .join("\n")
}

/// Strip ONE layer of matching surrounding quotes (`"…"` / `'…'`). pi's
/// regex is `^(\"|')((?:(?!\1).)*)\1$`, which says three things this mirrors:
/// the same quote character closes it, the INSIDE holds no other copy of it
/// (`"a" and "b"` is an answer that quotes within itself, not a wrapped
/// title), and one layer only — a doubly-wrapped answer is left completely
/// alone rather than half-stripped.
fn strip_one_quote_layer(s: &str) -> &str {
    let first = match s.chars().next() {
        Some(c @ ('"' | '\'')) => c,
        _ => return s,
    };
    // `strip_prefix` / `strip_suffix` on a `char` are boundary-safe (no byte
    // indexing), and a lone quote character strips to nothing but fails the
    // suffix test, so it is left alone.
    let inner = match s
        .strip_prefix(first)
        .and_then(|rest| rest.strip_suffix(first))
    {
        Some(inner) => inner,
        None => return s,
    };
    if inner.contains(first) {
        s
    } else {
        inner
    }
}

/// Clean a model answer: whitespace runs → one space, trim, strip ONE layer
/// of matching surrounding quotes (`"…"` / `'…'`), then cap at
/// `TITLE_MAX_CHARS` CHARS. `None` when nothing survives — an empty title is
/// a failure, not a write of `""` into `sessions.title`.
///
/// The trim happens BEFORE the quote strip because that is pi's chain order
/// (`replace(/\s+/g, " ").trim().replace(quoteRe).slice(0, 80)`); a quote
/// pair that wraps inner spaces therefore keeps them, exactly as pi does —
/// not worth a deviation that changes what a title looks like.
pub(crate) fn clean_title(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<&str>>().join(" ");
    let title = cap_chars(strip_one_quote_layer(&collapsed), TITLE_MAX_CHARS);
    (!title.is_empty()).then_some(title)
}

/// The log line for a configured level the model does not advertise (its own
/// function so the exact text is pinned by a test — the crate logs to stderr
/// with `eprintln!` and its tests have no stderr capture harness).
fn unrecognized_reasoning_log(raw: &str) -> String {
    format!("session-name: ignoring unrecognized reasoning {raw:?}")
}

/// The thinking level the title request asks for (decision 3). `None` (absent
/// / blank setting) → `None`: omit the key — `ModelOptions.reasoning_effort:
/// None` already means "no thinking" here, so pi's `minimal` default would
/// ADD cost. A configured value is matched case- and padding-insensitively
/// against `model.thinking_levels` and the MODEL'S OWN spelling is returned
/// (the provider's vocabulary, not the user's typo-corrected one).
///
/// A model that advertises NO levels yields `None` — the same rule
/// `remembered_thinking_level` applies (`agent/session/mod.rs`), NOT
/// `supports_thinking_level`'s soft-pass: an unverifiable level is never
/// sent, because `ModelOptions.reasoning_effort` is forwarded VERBATIM by
/// every adapter and an unknown level is provider-dependent (some read it as
/// MORE thinking, some reject the request — pi's `mapThinkingLevelToEffort`
/// `default:` arm silently buying maximum effort on a one-line title is the
/// canonical horror). An unrecognised value against a non-empty set logs and
/// returns `None`.
///
/// THE DELIBERATE DEVIATION from pi: pi validates against a FIXED list
/// (`minimal…max`, `off` excluded because there it is a fourth spelling of
/// "unset"). Here the vocabulary is the MODEL'S advertised `thinking_levels`,
/// which for this app's providers legitimately include `off` / `none` meaning
/// "no thinking" — an advertised `off` is forwarded, because the model says it
/// understands it.
pub(crate) fn resolve_naming_reasoning(model: &Model, configured: Option<&str>) -> Option<String> {
    // A blank setting is "unset", not "an invalid level": nothing to forward
    // and nothing to warn about (the same normalisation `load_settings`
    // applies to `sessionNamingModel`).
    let raw = configured.map(str::trim).filter(|s| !s.is_empty())?;
    if model.thinking_levels.is_empty() {
        // Unverifiable — NOT the soft-pass that waves it through.
        return None;
    }
    let needle = raw.to_lowercase();
    model
        .thinking_levels
        .iter()
        .find(|level| level.to_lowercase() == needle)
        .cloned()
        .or_else(|| {
            eprintln!("{}", unrecognized_reasoning_log(raw));
            None
        })
}

/// One pass of pi's `findMatch`: the key as a canonical `provider/id`, then
/// as a bare id (unique-match only), then — when the key carries a `:` — the
/// same two rungs on the part before the LAST `:`.
fn find_naming_match(catalog: &ModelCatalog, key: &str) -> Option<Model> {
    let needle = key.to_lowercase();
    // 1. The canonical composed key, IGNORE-CASE (`resolve_composed_model`
    //    matches with `==`, so a hand-edited `"TAMA/m1"` would silently miss;
    //    `ModelKey`'s `Display` is the catalog's one key rendering).
    if let Some(m) = catalog
        .all()
        .iter()
        .find(|m| ModelKey::from(*m).to_string().to_lowercase() == needle)
    {
        return Some(m.clone());
    }
    // 2. A bare id — resolved ONLY when exactly one model carries it (pi: a
    //    bare id must be unique across providers, or the naming request could
    //    land on a different provider's model than the user meant).
    let mut id_matches = catalog
        .all()
        .iter()
        .filter(|m| m.id.to_lowercase() == needle);
    let only = id_matches.next();
    if only.is_some() && id_matches.next().is_none() {
        return only.cloned();
    }
    // 3. Thinking-suffix tolerance: the level is the TRAILING segment (a model
    //    id may itself contain `:`, hence `rsplit_once`, and rung 1 already saw
    //    the whole key). The empty-prefix guard is pi's `if (prefix)`: without
    //    it a key like `":high"` would retry the whole catalog on `""`.
    if let Some((prefix, _level)) = key.rsplit_once(':') {
        if !prefix.is_empty() {
            return find_naming_match(catalog, prefix);
        }
    }
    None
}

/// Resolve the `sessionNamingModel` override, in pi's order: trim, then the
/// canonical `provider/id` ignore-case, then a bare id when UNIQUE across
/// providers, then the same two rungs with a trailing `:<level>` suffix
/// stripped. Anything else → `None`, and the caller falls back to the
/// session's own model (pi's `settingsModel ?? ctx.model`).
///
/// Deliberately NOT `resolve_composed_model` (its `==` match misses a
/// differently-cased key) and NOT pre-stripped with `ModelRef::parse` (it
/// returns `None` for a key without a `/`, so a bare `"m1:high"` — a legal
/// hand-edited override — would never resolve).
pub(crate) fn resolve_naming_model(catalog: &ModelCatalog, key: &str) -> Option<Model> {
    let key = key.trim();
    if key.is_empty() {
        // pi's `resolveModel` rejects blank BEFORE matching; a
        // `sessionNamingModel: "   "` means "no override".
        return None;
    }
    find_naming_match(catalog, key)
}

// ── The naming pass (the `agent_end` hook + the request) ──────────────────

/// How long the title request's stream may run before the task gives up on
/// it. The adapters bound themselves (`transport::build_client`'s connect +
/// read timeouts), so this is the backstop for a stream that dribbles for
/// ever without ever finishing — a naming pass must not hold a session's
/// `in_flight` flag open indefinitely.
const NAME_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The per-session naming bookkeeping: `fails` counts REQUEST failures only
/// (a guard that merely declines is NOT a failure — pi's handler returns
/// from its guards without touching `failCount`); `in_flight` keeps two
/// `agent_end`s from spawning two requests for the same session.
#[derive(Debug, Default, Clone)]
pub(crate) struct NamingState {
    pub(crate) fails: u32,
    pub(crate) in_flight: bool,
}

/// Everything one title request needs, OWNED (the `subagent::dispatch_native`
/// shape — no `Arc<SessionManager>` back-pointer), so the task outlives the
/// router call that spawned it without touching the manager again.
pub(crate) struct NamingRequest {
    session_id: String,
    db: Arc<Db>,
    /// `None` when no sink was ever wired (`set_sink`): the EMIT is skipped,
    /// the WRITE is not — a title still deserves persisting.
    sink: Option<Arc<dyn EventSink>>,
    provider_factory: ProviderFactory,
    /// The effective-catalog supplier, read for the `sessionNamingModel`
    /// override ONLY (no override → never resolved: the common case pays no
    /// discovery round-trip).
    catalog: EffectiveCatalog,
    /// The session's own model (the `config_state` mirror, read at spawn
    /// time) — pi's `ctx.model`, and the override's fallback.
    session_model: Model,
    /// Read ONCE by `maybe_name_session` (the `record_session` precedent for
    /// the sync `load_settings`), so the master switch and the two naming
    /// settings cannot disagree mid-flight.
    settings: Settings,
    /// The conversation excerpt, read WITH the guards (the sync half): the
    /// task never re-reads the transcript, so the prompt always matches the
    /// transcript the guards accepted.
    exchange: String,
    state: Arc<StdMutex<HashMap<String, NamingState>>>,
}

/// How the title stream ended, before the answer is judged.
enum Drain {
    /// The stream reached `Done` (the reason decides success or failure).
    Done(FinishReason),
    /// No usable answer: a `ProviderEvent::Error`, a stream that stopped
    /// with no `Done` at all, or the timeout.
    Failed(String),
}

impl SessionManager {
    /// The `agent_end` hook (the port of pi's `session-name` handler):
    /// guard, then fire-and-forget. Never blocks the router — the model call
    /// is spawned, and every guard is a sync map or row read.
    ///
    /// Every early return consumes NOTHING: no failure counted, no
    /// `in_flight` set. `in_flight` is set at the last moment (step 7),
    /// because a guard that returned AFTER setting it would strand the
    /// session in `in_flight` for ever — the very state the exit teardown
    /// exists to clear.
    pub(crate) fn maybe_name_session(&self, session_id: &str) {
        // 1. The master switch, and the two per-request settings read in the
        //    same breath (one `load_settings` for all three).
        let settings = load_settings(&self.config_dir);
        if !settings.session_naming_enabled {
            return;
        }
        // 2. No `Db` → no row to write (persistence is a no-op without it).
        let Some(db) = self.driver.db.clone() else {
            return;
        };
        // 3. The row. A missing row is pi's "ephemeral session" guard (with
        //    nothing to name, there is nothing to do); a row that already
        //    carries a title is pi's `getSessionName()` guard (decision 2: a
        //    title — generated or user-chosen — is final); a SUBAGENT row is
        //    the same idea as pi's ephemeral guard (a subagent's transcript
        //    is hidden — `list_sessions` filters `is_subagent = 0` — so
        //    naming it is meaningless). A read failure declines this turn and
        //    the next `agent_end` retries.
        let Ok(Some(row)) = db.session(session_id) else {
            return;
        };
        if row.title.is_some() || row.is_subagent {
            return;
        }
        // 4. The bookkeeping: the failure budget spent (pi's
        //    `failCount >= 3`), or one of our requests still running. READ
        //    ONLY (see the note above).
        {
            let state = self.naming.lock().unwrap_or_else(|p| p.into_inner());
            if state
                .get(session_id)
                .is_some_and(|s| s.in_flight || s.fails >= MAX_FAILURES)
            {
                return;
            }
        }
        // 5. The session's own model — the live `config_state` mirror, the
        //    same source `set_config_option` re-synthesizes from. Absent
        //    (a session that never resolved one) → nothing to ask.
        let Some(session_model) = self
            .config_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_id)
            .map(|c| c.model.clone())
        else {
            return;
        };
        // 6. The excerpt. No user text yet → decline, and the NEXT
        //    `agent_end` tries again (a turn whose transcript is still all
        //    tool calls has nothing to title from). The store frames ride a
        //    DIFFERENT outbound path than the `RpcEvent` stream, so the
        //    assistant row may or may not be in SQLite by now — the
        //    assistant side is optional by design, and a title written from
        //    the user line alone is the accepted outcome (no retry, no
        //    re-read loop: the write is once-only either way).
        let Ok(messages) = SessionStore::new(db.clone()).load_messages(session_id) else {
            return;
        };
        let Some(exchange) = first_exchange_text(&messages) else {
            return;
        };
        // A spawn needs a runtime. The router runs on a Worker pump task in
        // production; declining when there is none (the `sudo_exec` cleanup
        // precedent) is checked BEFORE the claim so a declined pass never
        // leaves `in_flight` set.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        // 7. Claim the session (the write lock RE-CHECKS step 4: the router
        //    is per-session today, and a second caller would otherwise slip
        //    through the gap between the read and the claim).
        {
            let mut state = self.naming.lock().unwrap_or_else(|p| p.into_inner());
            match state.get_mut(session_id) {
                Some(s) if s.in_flight || s.fails >= MAX_FAILURES => return,
                Some(s) => s.in_flight = true,
                None => {
                    state.insert(
                        session_id.to_string(),
                        NamingState {
                            fails: 0,
                            in_flight: true,
                        },
                    );
                }
            }
        }
        let request = NamingRequest {
            session_id: session_id.to_string(),
            db,
            // The sink is the EMIT's source only — its absence costs the
            // push, never the title.
            sink: self.sink.get().cloned(),
            provider_factory: self.provider_factory.clone(),
            catalog: EffectiveCatalog {
                config_dir: self.config_dir.clone(),
                cache: self.discovery_cache.clone(),
                base: self.catalog.clone(),
            },
            session_model,
            settings,
            exchange,
            state: self.naming.clone(),
        };
        handle.spawn(name_session(request));
    }
}

/// One title request, running as the fire-and-forget task `maybe_name_session`
/// spawned. Everything it needs is OWNED (`NamingRequest`), the provider is
/// built inside the task (the factory takes a `&Model`, and the model may be
/// the override, not the session's own), and the outcome is one conditional
/// SQL write plus one emit — never a UI error on a failure path.
pub(crate) async fn name_session(request: NamingRequest) {
    // `in_flight` is cleared on EVERY exit — every early return included —
    // by this guard, which is why no return path below clears it by hand.
    let _claimed = InFlightClaim {
        session_id: request.session_id.clone(),
        state: request.state.clone(),
    };
    let session_id = request.session_id.as_str();

    // pi's `settingsModel ?? ctx.model`: the override resolved against the
    // EFFECTIVE catalog (the settings' providers + live discovery — the same
    // core `effective_catalog` uses), falling back to the session's own model
    // when the key names nothing (pi never errors on a bad override). With
    // no override we do NOT resolve at all: no discovery round-trip for the
    // common case, and a blank key is "unset" (`resolve_naming_model`'s own
    // rule), so it costs nothing either.
    let model = match request.settings.session_naming_model.as_deref() {
        Some(key) if !key.trim().is_empty() => {
            let catalog = request.catalog.resolve(None).await;
            resolve_naming_model(&catalog, key).unwrap_or_else(|| request.session_model.clone())
        }
        _ => request.session_model.clone(),
    };

    // Auth: an unconfigured model is a SILENT skip, not a failure (pi's
    // `hasConfiguredAuth` guard — naming must not nag, and must not burn the
    // budget, over a provider the user never configured).
    if model.api_key.is_empty() {
        return;
    }

    let model_request = ModelRequest {
        // The BARE id, NOT the composed `provider/id` key — the wire wants
        // the model's own name (`compact.rs::summarize` does the same).
        model: model.id.clone(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: MessageContent::Text(title_prompt(&request.exchange)),
            tool_call_id: None,
            tool_calls: None,
        }],
        tools: Vec::new(),
        options: ModelOptions {
            temperature: Some(0.0),
            max_tokens: None,
            reasoning_effort: resolve_naming_reasoning(
                &model,
                request.settings.session_naming_reasoning.as_deref(),
            ),
            stream: true,
        },
        // The REAL session id, where pi issues the call under a fresh
        // `crypto.randomUUID()`: ADR 0026's per-session request tracking
        // wants EVERY request of the session attributed, and the footer's
        // cost total comes from the event stream, which this call never
        // touches.
        session_id: Some(session_id.to_string()),
    };

    let provider = (request.provider_factory)(&model);
    let mut stream = match provider.complete(&model_request).await {
        Ok(stream) => stream,
        Err(e) => {
            eprintln!("session-name: the title request failed for {session_id}: {e}");
            note_failure(&request.state, session_id);
            return;
        }
    };
    // Drain the stream (the `compact.rs::summarize` shape): the text deltas
    // accumulate, `Done` ends it, and anything else that ends the stream is
    // a FAILURE — a truncated answer is not a partial success. The
    // non-text events are IGNORED: a thinking delta is not a title, and a
    // title request that somehow calls a tool has answered nothing.
    let mut text = String::new();
    let drained = tokio::time::timeout(NAME_REQUEST_TIMEOUT, async {
        while let Some(event) = stream.next().await {
            match event {
                ProviderEvent::TextDelta(delta) => text.push_str(&delta),
                ProviderEvent::Done(finish) => return Drain::Done(finish),
                ProviderEvent::Error(e) => return Drain::Failed(e.to_string()),
                _ => {}
            }
        }
        Drain::Failed("the title stream ended without a finish_reason".to_string())
    })
    .await;
    let drained = match drained {
        Ok(outcome) => outcome,
        Err(_) => Drain::Failed(format!(
            "the title request timed out after {NAME_REQUEST_TIMEOUT:?}"
        )),
    };
    let finish = match drained {
        Drain::Done(finish) => finish,
        Drain::Failed(why) => {
            eprintln!("session-name: {why} for {session_id}");
            note_failure(&request.state, session_id);
            return;
        }
    };
    // `Done(Length)` is the output-token limit (the answer is CUT OFF) and
    // `Done(Error)` is the provider's own "the stream ended badly" — the same
    // two cases `summarize` refuses to treat as a partial success.
    if matches!(finish, FinishReason::Length | FinishReason::Error) {
        eprintln!("session-name: the title answer was truncated ({finish:?}) for {session_id}");
        note_failure(&request.state, session_id);
        return;
    }
    let Some(title) = clean_title(&text) else {
        // An answer that cleans to nothing is pi's `if (!title) onFailure()`:
        // writing `""` would label the session with nothing.
        eprintln!("session-name: the model answered with no usable title for {session_id}");
        note_failure(&request.state, session_id);
        return;
    };
    // The write is CONDITIONAL in SQL (`WHERE title IS NULL`), and that
    // condition IS pi's re-check-before-set race guard: a title that appeared
    // while we were streaming — or a row that vanished with the session —
    // means ours is dropped, and neither is a failure (nothing went wrong
    // with naming).
    match request.db.set_session_title(session_id, &title) {
        Ok(true) => {
            note_success(&request.state, session_id);
            // The push (Task 5's UI reads it: a live session's title arrives
            // by event because the boot `list_sessions` predates it).
            if let Some(sink) = request.sink.as_ref() {
                sink.emit(
                    "session-titled",
                    json!({ "sessionId": session_id, "title": title }),
                );
            }
        }
        Ok(false) => {}
        Err(e) => {
            eprintln!("session-name: failed to write title for {session_id}: {e}");
            note_failure(&request.state, session_id);
        }
    }
}

/// The `in_flight` flag's owner: cleared on EVERY exit of `name_session`,
/// including a panic (a `Drop` runs while unwinding) — which is why the flag
/// is never cleared by hand at the return sites.
struct InFlightClaim {
    session_id: String,
    state: Arc<StdMutex<HashMap<String, NamingState>>>,
}

impl Drop for InFlightClaim {
    fn drop(&mut self) {
        // A MISSING entry is not re-created: the session was torn down while
        // the request was in flight (`on_session_exited_expected` /
        // `handle_crash` removed it), and reviving it would resurrect state
        // for a session that no longer exists.
        if let Some(state) = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(&self.session_id)
        {
            state.in_flight = false;
        }
    }
}

/// Count one REQUEST failure — the only kind that counts (a guard that
/// declines is not one) — and log the give-up line exactly once, on the way
/// IN to the limit (`==`, not `>=`, so the line is not repeated by every
/// later attempt: pi notifies once for the same reason).
///
/// An entry that is GONE is not re-created (the same rule `InFlightClaim`
/// follows): the session was torn down while this request was in flight, and
/// a late failure must not leave state behind for a session that is over.
fn note_failure(state: &StdMutex<HashMap<String, NamingState>>, session_id: &str) {
    if let Some(state) = state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(session_id)
    {
        state.fails += 1;
        if state.fails == MAX_FAILURES {
            eprintln!(
                "session-name: naming failed {MAX_FAILURES} times for {session_id}; \
                 check the model configuration or set sessionNamingModel"
            );
        }
    }
}

/// A title that landed clears the failure budget: a session that recovered
/// is not a session that gave up.
fn note_success(state: &StdMutex<HashMap<String, NamingState>>, session_id: &str) {
    if let Some(state) = state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(session_id)
    {
        state.fails = 0;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashSet, VecDeque};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex as StdMutex};

    use futures_util::stream::{self, BoxStream, StreamExt};
    use tokio::sync::{mpsc, Mutex, Notify};

    use super::{
        cap_chars, clean_title, first_exchange_text, message_text, note_failure,
        resolve_naming_model, resolve_naming_reasoning, title_prompt, unrecognized_reasoning_log,
        EXCERPT_CAP, MAX_FAILURES, TITLE_MAX_CHARS,
    };
    use super::{NamingState, SessionManager};
    use crate::agent::events::RpcEvent;
    use crate::agent::harness::catalog::{Model, ModelCatalog};
    use crate::agent::harness::model_key::ModelKey;
    use crate::agent::harness::provider::{
        ChatMessage, ChatRole, FinishReason, MessageContent, ModelRequest, Provider, ProviderError,
        ProviderEvent, ToolCall,
    };
    use crate::agent::harness::SessionStore;
    use crate::agent::session::session_tests::{
        level_test_model, open_db, temp_config_dir, write_settings_json, TestSink,
    };
    use crate::agent::session::{LiveWorkerSession, NativeConfigState};
    use crate::agent::tools::{ContentBlock, ImageRef};
    use crate::agent::worker::client::WorkerInboundEvent;
    use crate::storage::Db;
    use crate::types::SessionInfo;
    use serde_json::{json, Value};

    // ── Test doubles ───────────────────────────────────────────────────────

    /// A `ChatMessage` literal (the `compact.rs` tests' `text_msg` shape,
    /// widened to every role the excerpt rule discriminates on).
    fn msg(role: ChatRole, content: MessageContent) -> ChatMessage {
        ChatMessage {
            role,
            content,
            tool_call_id: None,
            tool_calls: None,
        }
    }

    fn text(role: ChatRole, t: &str) -> ChatMessage {
        msg(role, MessageContent::Text(t.to_string()))
    }

    fn user(t: &str) -> ChatMessage {
        text(ChatRole::User, t)
    }

    fn assistant(t: &str) -> ChatMessage {
        text(ChatRole::Assistant, t)
    }

    /// A catalog `Model` literal (`session_tests::level_test_model`'s shape;
    /// that helper is private to `session::session_tests` and is widened by
    /// Task 4, which is the task that needs it FROM `naming.rs`).
    fn test_model(provider: &str, id: &str, levels: &[&str]) -> Model {
        Model {
            id: id.to_string(),
            provider: provider.to_string(),
            base_url: String::new(),
            api_key: "k".to_string(),
            context_window: 128_000,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: !levels.is_empty(),
            thinking_levels: levels.iter().map(|s| s.to_string()).collect(),
            api: Some("openai-completions".to_string()),
        }
    }

    fn catalog_of(models: Vec<Model>) -> ModelCatalog {
        ModelCatalog {
            models,
            ..ModelCatalog::default()
        }
    }

    /// The resolved model's identity as its composed key (so a failure names
    /// BOTH sides — the key asked for and the model that came back).
    fn key_of(m: &Model) -> String {
        ModelKey::from(m).to_string()
    }

    // ── `message_text` (the "text blocks only" rule) ───────────────────────

    #[test]
    fn a_blocks_message_joins_its_text_parts_and_skips_images() {
        let content = MessageContent::Blocks(vec![
            ContentBlock::Text {
                text: "First".into(),
            },
            // pi's filter is `b?.type === "text" && typeof b.text ===
            // "string"` — an image block carries no text, so it is not a
            // segment and (crucially) does not consume a `\n` of the join.
            ContentBlock::Image {
                image: ImageRef {
                    data: "aGVsbG8=".into(),
                    mime_type: "image/png".into(),
                },
            },
            ContentBlock::Text {
                text: "Second".into(),
            },
        ]);
        assert_eq!(message_text(&content), "First\nSecond");
    }

    #[test]
    fn a_text_message_is_verbatim_and_empty_blocks_are_empty() {
        assert_eq!(
            message_text(&MessageContent::Text("  raw  ".to_string())),
            "  raw  "
        );
        assert_eq!(message_text(&MessageContent::Blocks(vec![])), "");
    }

    // ── `first_exchange_text` (what feeds the prompt) ──────────────────────

    #[test]
    fn the_user_line_alone_is_a_complete_excerpt() {
        // The assistant side is OPTIONAL: a turn whose assistant output was
        // all tool calls still names from the user text (pi's
        // `conversationText` is non-empty on the user line alone).
        assert_eq!(
            first_exchange_text(&[user("How do I fix this bug?")]),
            Some("User: How do I fix this bug?".to_string())
        );
    }

    #[test]
    fn the_first_exchange_is_both_lines_in_role_order() {
        assert_eq!(
            first_exchange_text(&[user("How do I fix this bug?"), assistant("Here is how.")]),
            Some("User: How do I fix this bug?\nAssistant: Here is how.".to_string())
        );
    }

    #[test]
    fn only_the_first_message_of_each_side_is_taken() {
        let got = first_exchange_text(&[
            user("first question"),
            user("a second question"),
            assistant("first answer"),
            assistant("a second answer"),
        ])
        .expect("a user line exists");
        assert_eq!(got, "User: first question\nAssistant: first answer");
    }

    #[test]
    fn an_assistant_message_before_any_user_is_ignored() {
        // pi sets `foundAssistant` only when `foundUser` is already true, so
        // a preamble assistant row (a restored context, a subagent's echo)
        // can never be the excerpt's first line.
        assert_eq!(
            first_exchange_text(&[assistant("A preamble"), user("Real q"), assistant("Real a")]),
            Some("User: Real q\nAssistant: Real a".to_string())
        );
    }

    #[test]
    fn system_and_tool_rows_are_ignored() {
        // Only the two roles pi keeps (`msg.role !== "user" && !==
        // "assistant"` → continue): a system prompt is not something the user
        // is working on, and a tool result is machine output.
        let mut tool_row = msg(ChatRole::Tool, MessageContent::Text("tool output".into()));
        tool_row.tool_call_id = Some("call_1".into());
        assert_eq!(
            first_exchange_text(&[
                msg(
                    ChatRole::System,
                    MessageContent::Text("You are a helpful agent".into())
                ),
                user("q"),
                tool_row,
                assistant("a"),
            ]),
            Some("User: q\nAssistant: a".to_string())
        );
    }

    #[test]
    fn an_assistant_turn_of_only_tool_calls_still_names_from_the_user_text() {
        let mut calls = assistant("");
        calls.tool_calls = Some(vec![ToolCall {
            id: "call_1".into(),
            name: "bash".into(),
            arguments: json!({ "command": "ls" }),
        }]);
        assert_eq!(
            first_exchange_text(&[user("list the files"), calls]),
            Some("User: list the files".to_string())
        );
    }

    #[test]
    fn each_side_is_capped_at_the_excerpt_cap_in_chars() {
        // 500 is the CAP, not a truncation marker: nothing is appended, and
        // the cap counts CHARS of the text (the `"<Role>: "` label sits
        // outside it, exactly as pi's `"User: " + userText` builds it).
        let got = first_exchange_text(&[user(&"a".repeat(600)), assistant(&"b".repeat(600))])
            .expect("a user line exists");
        let mut lines = got.split('\n');
        let user_line = lines.next().expect("the user line");
        let asst_line = lines.next().expect("the assistant line");
        assert_eq!(
            user_line.strip_prefix("User: ").unwrap().chars().count(),
            EXCERPT_CAP
        );
        assert_eq!(
            asst_line
                .strip_prefix("Assistant: ")
                .unwrap()
                .chars()
                .count(),
            EXCERPT_CAP
        );
        assert!(lines.next().is_none(), "exactly two lines: {got:?}");
    }

    #[test]
    fn a_multi_byte_excerpt_is_capped_without_splitting_a_code_point() {
        // `é` is two bytes, so 500 CHARS is 1000 bytes: a byte-slice cap
        // would either cut the title in half or panic mid-character. The
        // multi-byte spelling must survive to the cap boundary.
        let got = first_exchange_text(&[user(&"é".repeat(600))]).expect("a user line exists");
        let body = got.strip_prefix("User: ").unwrap();
        assert_eq!(body.chars().count(), EXCERPT_CAP);
        assert_eq!(body, "é".repeat(EXCERPT_CAP));
    }

    #[test]
    fn blank_user_text_is_not_an_exchange() {
        // A blank row is not a candidate at all — pi locks `foundUser` on a
        // whitespace-only first message and then bails at its own
        // `conversationText.trim()` guard, so the session would never be
        // named; here the first NON-EMPTY user text wins instead.
        assert_eq!(first_exchange_text(&[user(""), assistant("a")]), None);
        assert_eq!(first_exchange_text(&[user("   \n\t ")]), None);
        assert_eq!(
            first_exchange_text(&[user("   "), user("real question")]),
            Some("User: real question".to_string())
        );
    }

    #[test]
    fn no_messages_yield_nothing() {
        assert_eq!(first_exchange_text(&[]), None);
    }

    // ── `title_prompt` (pi's copy, verbatim) ───────────────────────────────

    #[test]
    fn the_prompt_is_pis_copy_with_the_excerpt_between_the_tags() {
        // Pinned as a whole string: the wording is what the model is tuned on
        // (a re-word is a silent quality change no test would otherwise see),
        // and the excerpt sits BETWEEN the tags with no extra blank lines.
        let exchange = "User: q\nAssistant: a";
        assert_eq!(
            title_prompt(exchange),
            [
                "Generate a concise title (3-8 words) for this conversation.",
                "The title should capture what the user is working on.",
                "Return only the title, nothing else.",
                "",
                "<conversation>",
                exchange,
                "</conversation>",
            ]
            .join("\n")
        );
        assert!(title_prompt(exchange)
            .contains(&format!("<conversation>\n{exchange}\n</conversation>")));
    }

    // ── `clean_title` (how the answer is cleaned) ─────────────────────────

    #[test]
    fn whitespace_runs_collapse_and_the_ends_trim() {
        assert_eq!(
            clean_title("  Porting   the session namer \n"),
            Some("Porting the session namer".to_string())
        );
    }

    #[test]
    fn one_layer_of_matching_surrounding_quotes_is_stripped() {
        // The models answer in quotes more often than not; pi strips exactly
        // one layer (`/^(\"|')((?:(?!\1).)*)\1$/`).
        assert_eq!(
            clean_title("\"Porting the session namer\""),
            Some("Porting the session namer".to_string())
        );
        assert_eq!(clean_title("'x'"), Some("x".to_string()));
    }

    #[test]
    fn anything_that_is_not_one_wrapping_pair_is_left_alone() {
        // An unbalanced quote is content, and a title that merely CONTAINS
        // its own quote character is not a wrapped answer — pi's `(?!\1)`
        // refuses both, so a `"x"` inside the answer survives.
        assert_eq!(
            clean_title("\"unbalanced"),
            Some("\"unbalanced".to_string())
        );
        assert_eq!(
            clean_title("\"a\" and \"b\""),
            Some("\"a\" and \"b\"".to_string())
        );
        // A single quote character is not a pair.
        assert_eq!(clean_title("\""), Some("\"".to_string()));
        // A doubly-wrapped answer loses NOTHING (one layer means one layer).
        assert_eq!(clean_title("\"\"x\"\""), Some("\"\"x\"\"".to_string()));
    }

    #[test]
    fn an_answer_with_nothing_left_is_not_a_title() {
        assert_eq!(clean_title(""), None);
        assert_eq!(clean_title("   "), None);
        assert_eq!(clean_title("\n\t \n"), None);
        // Stripping the quotes can empty the answer: no title, so the caller
        // counts a failure rather than writing `""` to `sessions.title`.
        assert_eq!(clean_title("\"\""), None);
    }

    #[test]
    fn a_long_answer_is_capped_at_the_title_max_in_chars() {
        let got = clean_title(&"a".repeat(200)).expect("text survives");
        assert_eq!(got.chars().count(), TITLE_MAX_CHARS);
    }

    #[test]
    fn a_multi_byte_title_is_capped_at_chars_not_bytes() {
        // 80 multi-byte chars are >80 BYTES: the cap is 80 CHARS (a byte cap
        // would fit fewer characters, or panic on a byte-slice boundary).
        let got = clean_title(&"é".repeat(200)).expect("text survives");
        assert_eq!(got.chars().count(), TITLE_MAX_CHARS);
        assert_eq!(got, "é".repeat(TITLE_MAX_CHARS));
        assert_eq!(
            clean_title(&"é".repeat(80))
                .expect("text survives")
                .chars()
                .count(),
            80
        );
    }

    #[test]
    fn the_char_cap_does_not_slice_a_byte_sequence() {
        // `cap_chars` is the module's ONLY cut on user-supplied text; it must
        // land on a char boundary however awkwardly they fall.
        assert_eq!(cap_chars("aé", 1), "a");
        assert_eq!(cap_chars("éa", 1), "é");
        assert_eq!(cap_chars("a😀b", 2), "a😀");
        assert_eq!(cap_chars("abc", 10), "abc");
    }

    // ── `resolve_naming_reasoning` (decision 3) ────────────────────────────

    #[test]
    fn an_absent_or_blank_level_omits_the_key() {
        // Omitting is the default here: `ModelOptions.reasoning_effort: None`
        // already means "no thinking", so pi's `minimal` default would ADD
        // cost rather than ask for nothing.
        let m = test_model("tama", "m1", &["off", "low", "high", "xhigh"]);
        assert_eq!(resolve_naming_reasoning(&m, None), None);
        assert_eq!(resolve_naming_reasoning(&m, Some("")), None);
        assert_eq!(resolve_naming_reasoning(&m, Some("   ")), None);
    }

    #[test]
    fn an_advertised_level_is_forwarded() {
        let m = test_model("tama", "m1", &["off", "low", "high", "xhigh"]);
        assert_eq!(
            resolve_naming_reasoning(&m, Some("low")).as_deref(),
            Some("low")
        );
    }

    #[test]
    fn the_match_tolerates_case_and_padding_and_keeps_the_models_spelling() {
        let m = test_model("tama", "m1", &["off", "low", "high", "xhigh"]);
        assert_eq!(
            resolve_naming_reasoning(&m, Some(" LOW ")).as_deref(),
            Some("low"),
            "the padding is trimmed and the case folded to find the match"
        );
        // The MODEL's spelling goes on the wire — the provider's vocabulary,
        // not the user's typo-corrected one (`ModelOptions.reasoning_effort`
        // is forwarded verbatim by every adapter).
        let odd = test_model("tama", "m2", &["xHigh"]);
        assert_eq!(
            resolve_naming_reasoning(&odd, Some("  XHIGH ")).as_deref(),
            Some("xHigh")
        );
    }

    #[test]
    fn a_level_the_model_does_not_advertise_is_never_sent_and_is_logged() {
        let m = test_model("tama", "m1", &["off", "low", "high", "xhigh"]);
        assert_eq!(resolve_naming_reasoning(&m, Some("turbo")), None);
        // The exact line (the `{raw:?}` keeps the quotes, so a blank or a
        // near-miss is readable in the log).
        assert_eq!(
            unrecognized_reasoning_log("turbo"),
            r#"session-name: ignoring unrecognized reasoning "turbo""#
        );
    }

    #[test]
    fn an_advertised_off_is_forwarded() {
        // THE DELIBERATE DEVIATION from pi, which excludes `off` from its
        // fixed list because there it is a fourth spelling of "unset". Here
        // the vocabulary is the model's own, and this app's providers
        // advertise `off` / `none` to MEAN "no thinking" — the model says it
        // understands the token, so honour it.
        let m = test_model("tama", "m1", &["off", "low", "high"]);
        assert_eq!(
            resolve_naming_reasoning(&m, Some("off")).as_deref(),
            Some("off")
        );
    }

    #[test]
    fn a_model_that_advertises_no_levels_never_gets_one() {
        // The `remembered_thinking_level` rule, NOT `supports_thinking_level`'s
        // soft-pass: an unverifiable level is never sent.
        let m = test_model("tama", "m1", &[]);
        for raw in ["low", "high", "off", "turbo"] {
            assert_eq!(resolve_naming_reasoning(&m, Some(raw)), None, "{raw:?}");
        }
    }

    // ── `resolve_naming_model` (the override's resolution order) ───────────

    #[test]
    fn the_exact_composed_key_resolves() {
        let c = catalog_of(vec![
            test_model("tama", "m1", &[]),
            test_model("other", "m2", &[]),
        ]);
        assert_eq!(
            resolve_naming_model(&c, "tama/m1")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
    }

    #[test]
    fn a_differently_cased_key_still_resolves() {
        // `resolve_composed_model` matches with `==` and would MISS this
        // silently — a hand-edited setting's casing is not the provider's.
        let c = catalog_of(vec![test_model("tama", "m1", &[])]);
        assert_eq!(
            resolve_naming_model(&c, "TAMA/m1")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
        assert_eq!(
            resolve_naming_model(&c, "tama/M1")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
    }

    #[test]
    fn a_padded_key_resolves() {
        let c = catalog_of(vec![test_model("tama", "m1", &[])]);
        assert_eq!(
            resolve_naming_model(&c, " tama/m1 ")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
    }

    #[test]
    fn a_thinking_suffix_on_a_composed_key_is_stripped() {
        // `"provider/id:<level>"` is the form the model picker writes.
        let c = catalog_of(vec![test_model("tama", "m1", &["low", "xhigh"])]);
        assert_eq!(
            resolve_naming_model(&c, "tama/m1:xhigh")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
    }

    #[test]
    fn a_bare_id_with_a_suffix_still_resolves() {
        // The suffix strip must NOT require a `/`: `ModelRef::parse` returns
        // `None` for a key without one, so pre-stripping with it would lose
        // every bare-id override that carries a level.
        let c = catalog_of(vec![test_model("tama", "m1", &["high"])]);
        assert_eq!(
            resolve_naming_model(&c, "m1:high")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
    }

    #[test]
    fn a_unique_bare_id_resolves() {
        let c = catalog_of(vec![
            test_model("tama", "m1", &[]),
            test_model("other", "m2", &[]),
        ]);
        assert_eq!(
            resolve_naming_model(&c, "m1")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/m1")
        );
    }

    #[test]
    fn an_ambiguous_bare_id_resolves_to_nothing() {
        // A bare id must be UNIQUE across providers: guessing one of two is
        // how a naming request ends up on the wrong provider.
        let c = catalog_of(vec![
            test_model("tama", "m1", &[]),
            test_model("other", "m1", &[]),
        ]);
        assert_eq!(resolve_naming_model(&c, "m1"), None);
        // …while the composed key disambiguates the same two models.
        assert_eq!(
            resolve_naming_model(&c, "other/m1")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("other/m1")
        );
    }

    #[test]
    fn an_unknown_key_resolves_to_nothing() {
        let c = catalog_of(vec![test_model("tama", "m1", &[])]);
        assert_eq!(resolve_naming_model(&c, "tama/nope"), None);
        assert_eq!(resolve_naming_model(&c, "nope"), None);
    }

    #[test]
    fn a_blank_key_resolves_to_nothing() {
        // pi's `resolveModel` trims and rejects blank BEFORE matching, so a
        // `sessionNamingModel: "   "` falls back to the session's own model
        // instead of matching whatever the catalog's first entry is.
        let c = catalog_of(vec![test_model("tama", "m1", &[])]);
        assert_eq!(resolve_naming_model(&c, ""), None);
        assert_eq!(resolve_naming_model(&c, "   "), None);
        assert_eq!(resolve_naming_model(&c, "\t\n"), None);
    }

    #[test]
    fn a_key_that_is_only_a_suffix_resolves_to_nothing() {
        // The stripped form is EMPTY, and pi's `if (prefix)` guard is what
        // keeps `":high"` from matching the whole catalog on an empty string.
        let c = catalog_of(vec![test_model("tama", "m1", &[])]);
        assert_eq!(resolve_naming_model(&c, ":high"), None);
    }

    #[test]
    fn a_model_id_containing_a_colon_matches_before_any_stripping() {
        // A model id may itself contain `:` (a gateway's namespaced form), so
        // rung 1 sees the WHOLE key first: stripping the "level" off
        // `tama/ns:v4:fast` would look for a model that is not in the catalog.
        let c = catalog_of(vec![test_model("tama", "ns:v4:fast", &[])]);
        assert_eq!(
            resolve_naming_model(&c, "tama/ns:v4:fast")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/ns:v4:fast")
        );
        // And with a real level appended, the strip recovers the same model.
        assert_eq!(
            resolve_naming_model(&c, "tama/ns:v4:fast:xhigh")
                .as_ref()
                .map(key_of)
                .as_deref(),
            Some("tama/ns:v4:fast")
        );
    }

    // ── The naming pass (Task 4: the `agent_end` hook) ─────────────────────
    //
    // The tests drive the ROUTER's `agent_end` arm (`route_event`), not
    // `maybe_name_session` directly — the hook and the guards are the
    // feature. No `Arc<SessionManager>` is involved: `maybe_name_session`
    // takes `&self` and the spawned task owns every input it needs.
    //
    // The awaits are the provider's `Notify`, never a sleep. On a
    // current-thread runtime a task woken by `notify_waiters()` is polled
    // only AFTER the naming task returns `Pending` or COMPLETES, and every
    // await the naming task takes after `complete()` is immediately-ready
    // (an uncontended `tokio` mutex, an in-memory stream) — so the notify
    // also means that request's DB write / emit / bookkeeping have already
    // happened. The negative assertions are the mirror image: a freshly
    // spawned task does not run AT ALL until the test yields, so
    // `drain_tasks()` is what makes "no provider call" mean something.

    /// What the scripted provider does with one request.
    #[derive(Clone)]
    enum Script {
        /// Replay these events, then end the stream.
        Events(Vec<ProviderEvent>),
        /// Never answer (`complete()` itself pends — the `loop.rs`
        /// `ScriptedProvider`'s `None` script precedent): the request stays
        /// IN FLIGHT, which is what the `in_flight` guard test needs.
        Pending,
    }

    impl Script {
        /// A stream that answers with `text` and stops cleanly.
        fn answering(text: &str) -> Self {
            Script::Events(vec![
                ProviderEvent::TextDelta(text.to_string()),
                ProviderEvent::Done(FinishReason::Stop),
            ])
        }

        /// A stream that reports a mid-stream error (the request failure
        /// the budget counts).
        fn error(msg: &str) -> Self {
            Script::Events(vec![ProviderEvent::Error(ProviderError::Fatal(
                msg.to_string(),
            ))])
        }
    }

    /// The provider-side state, SHARED by every provider the factory builds
    /// (the factory runs per request, so the script queue and the recorded
    /// requests live behind `Arc`s).
    struct ProviderState {
        /// Every request the naming task sent, in order.
        requests: Mutex<Vec<ModelRequest>>,
        /// The scripted answers, consumed one per call; the LAST repeats
        /// (the `loop.rs` `ScriptedProvider`'s semantics).
        scripts: StdMutex<VecDeque<Script>>,
        /// Fired on EVERY `complete()` call.
        started: Notify,
        /// Run at the top of every `complete()` (the row-deleted-mid-flight
        /// test deletes the session row from here).
        on_call: StdMutex<Option<Box<dyn Fn() + Send + Sync>>>,
    }

    impl ProviderState {
        fn new(scripts: Vec<Script>) -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                scripts: StdMutex::new(scripts.into()),
                started: Notify::new(),
                on_call: StdMutex::new(None),
            }
        }

        /// The next script (the last entry repeats once the queue is down
        /// to one, so a three-failure test needs only one entry).
        fn next_script(&self) -> Script {
            let mut queue = self.scripts.lock().unwrap_or_else(|p| p.into_inner());
            if queue.len() > 1 {
                queue.pop_front().expect("len > 1")
            } else {
                queue
                    .front()
                    .cloned()
                    .unwrap_or_else(|| Script::Events(Vec::new()))
            }
        }
    }

    /// The title-request `Provider` double. The crate has NO shared mock
    /// that records the request (`ScriptedProvider` / `FailingProvider` /
    /// `CannedProvider` are private to their own test modules and none
    /// keeps the `ModelRequest`), and the request's shape is half of what
    /// this task must pin.
    struct RecordingProvider {
        state: Arc<ProviderState>,
    }

    #[async_trait::async_trait]
    impl Provider for RecordingProvider {
        async fn complete(
            &self,
            req: &ModelRequest,
        ) -> Result<BoxStream<'static, ProviderEvent>, ProviderError> {
            if let Some(on_call) = self
                .state
                .on_call
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
            {
                on_call();
            }
            self.state.requests.lock().await.push(req.clone());
            self.state.started.notify_waiters();
            match self.state.next_script() {
                Script::Events(events) => Ok(stream::iter(events).boxed()),
                Script::Pending => futures_util::future::pending().await,
            }
        }
    }

    /// The naming-pass harness: a `SessionManager` wired EXACTLY as the
    /// production seam is (`attach_db` / `set_catalog` / `set_sink` /
    /// `set_provider_factory` are all `&mut self`, so they run before any
    /// `Arc` — and no `Arc` is needed at all).
    struct Harness {
        manager: SessionManager,
        db: Arc<Db>,
        /// The config dir (the `settings.json` home) and the session `cwd`.
        dir: PathBuf,
        /// The sink's receiver — `None` when `set_sink` was never called
        /// (the "a title is still persisted with nobody listening" case).
        rx: Option<mpsc::UnboundedReceiver<Value>>,
        provider: Arc<ProviderState>,
        /// The session's own model (the catalog's `tama/m1`).
        model: Model,
    }

    /// Build the harness, optionally WITHOUT a sink. The catalog carries a
    /// second model (`tama/m2`) so the `sessionNamingModel` override has
    /// something to resolve to that is NOT the session's own model; the
    /// settings configure no providers, so `EffectiveCatalog::resolve`
    /// merges the base alone — no discovery, no network.
    fn harness_with_sink(scripts: Vec<Script>, with_sink: bool) -> Harness {
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let model = level_test_model("tama", "m1", &["off", "low", "high", "xhigh"]);
        let mut manager = SessionManager::new(dir.clone());
        manager.attach_db(db.clone());
        manager.set_catalog(ModelCatalog {
            models: vec![
                model.clone(),
                level_test_model("tama", "m2", &["off", "low", "high", "xhigh"]),
            ],
            ..ModelCatalog::default()
        });
        let rx = with_sink.then(|| {
            let (tx, rx) = mpsc::unbounded_channel();
            manager.set_sink(Arc::new(TestSink { tx }));
            rx
        });
        let provider = Arc::new(ProviderState::new(scripts));
        let shared = provider.clone();
        // The closure goes in DIRECTLY (`set_provider_factory` takes
        // `impl Fn(…)`, not a `ProviderFactory`).
        manager.set_provider_factory(move |_model: &Model| {
            Box::new(RecordingProvider {
                state: shared.clone(),
            }) as Box<dyn Provider>
        });
        Harness {
            manager,
            db,
            dir,
            rx,
            provider,
            model,
        }
    }

    fn harness(scripts: Vec<Script>) -> Harness {
        harness_with_sink(scripts, true)
    }

    impl Harness {
        fn model(&self) -> Model {
            self.model.clone()
        }

        /// Record the `sessions` row — guard 3 reads it, and its two
        /// columns ARE two guards (`title`, `is_subagent`). The row is born
        /// with a NULL title (`record_session` never writes one), so an
        /// existing title is written through the feature's own writer.
        fn record_row(&self, id: &str, title: Option<&str>, is_subagent: bool) {
            self.db
                .record_session(&SessionInfo {
                    session_id: id.to_string(),
                    cwd: self.dir.clone(),
                    capabilities: json!({}),
                    config_options: None,
                    archived: false,
                    title: None,
                    context_usage: None,
                    is_subagent,
                })
                .expect("the row records");
            if let Some(title) = title {
                self.db
                    .set_session_title(id, title)
                    .expect("the title writes");
            }
        }

        /// Seed the live config mirror (`config_state`) — guard 5's model
        /// source. A child module sees the parent's privates, so the test
        /// seeds the map directly instead of spawning a Worker.
        fn seed_config(&self, id: &str, model: &Model) {
            self.manager
                .config_state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(
                    id.to_string(),
                    NativeConfigState {
                        model: model.clone(),
                        thinking_level: None,
                    },
                );
        }

        /// Write the first exchange into `native_messages` — guard 6's
        /// excerpt source (the SAME table the loop persists to).
        fn seed_transcript(&self, id: &str) {
            let store = SessionStore::new(self.db.clone());
            store
                .insert_message(
                    id,
                    0,
                    "user",
                    &serde_json::to_string(&user("Port the session namer")).unwrap(),
                )
                .expect("the user row writes");
            store
                .insert_message(
                    id,
                    1,
                    "assistant",
                    &serde_json::to_string(&assistant("Here is how.")).unwrap(),
                )
                .expect("the assistant row writes");
        }

        /// The fully-seeded main session: row + config mirror + transcript.
        /// Without all three the guards early-return and every "the
        /// provider was called" assertion would fail for the wrong reason.
        fn seed_session(&self, id: &str) {
            self.record_row(id, None, false);
            self.seed_config(id, &self.model());
            self.seed_transcript(id);
        }

        /// Drive the router's hook (the real one, `is_subagent` included).
        fn agent_end(&self, id: &str, is_subagent: bool) {
            self.manager.route_event(
                id,
                is_subagent,
                WorkerInboundEvent::Event(RpcEvent::agent_end {
                    messages: vec![],
                    will_retry: false,
                }),
            );
        }

        /// Install a hook run at the top of every `complete()`.
        fn set_on_call<F>(&mut self, f: F)
        where
            F: Fn() + Send + Sync + 'static,
        {
            *self
                .provider
                .on_call
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(Box::new(f));
        }

        /// The session's naming bookkeeping (`None` = no entry ever made).
        fn state_of(&self, id: &str) -> Option<NamingState> {
            self.manager
                .naming
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(id)
                .cloned()
        }

        fn has_naming_entry(&self, id: &str) -> bool {
            self.manager
                .naming
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains_key(id)
        }

        /// Await the provider's "a request arrived" notify.
        async fn await_request(&self) {
            self.provider.started.notified().await;
        }

        async fn request_count(&self) -> usize {
            self.provider.requests.lock().await.len()
        }

        /// The exactly-one request the naming task sent.
        async fn one_request(&self) -> ModelRequest {
            let requests = self.provider.requests.lock().await;
            assert_eq!(requests.len(), 1, "exactly one title request");
            requests[0].clone()
        }

        /// Every frame the sink recorded (`TestSink` records EVERY emit as
        /// `{ "event", "payload" }`). Drains the receiver, so a test calls
        /// this or `titled`, not both.
        fn emitted(&mut self) -> Vec<Value> {
            let Some(rx) = self.rx.as_mut() else {
                return Vec::new();
            };
            let mut out = Vec::new();
            while let Ok(frame) = rx.try_recv() {
                out.push(frame);
            }
            out
        }

        /// The `session-titled` payloads, in order.
        fn titled(&mut self) -> Vec<Value> {
            self.emitted()
                .iter()
                .filter(|frame| frame["event"] == json!("session-titled"))
                .map(|frame| frame["payload"].clone())
                .collect()
        }

        fn stored_title(&self, id: &str) -> Option<String> {
            self.db
                .session(id)
                .expect("the row reads")
                .expect("the row exists")
                .title
        }
    }

    /// Let every task the router spawned run to its next await point — the
    /// NEGATIVE assertions need it (without a yield, "the provider was never
    /// called" would pass vacuously on a current-thread runtime).
    async fn drain_tasks() {
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn the_first_agent_end_titles_the_session_once() {
        let mut h = harness(vec![Script::Events(vec![
            // The answer arrives in two deltas AND wrapped in quotes: the
            // stored title is the joined, cleaned one.
            ProviderEvent::TextDelta("\"Porting".to_string()),
            ProviderEvent::TextDelta(" the session namer\"".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ])]);
        let id = "arch_first";
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        // One request, in the shape the harness uses elsewhere: the BARE
        // model id (NOT the composed key — `compact.rs::summarize`), the
        // REAL session id (ADR 0026's per-session attribution, unlike pi's
        // fresh `randomUUID`), no tools, temperature 0, and pi's prompt
        // wrapping the first exchange.
        let requests = h.provider.requests.lock().await;
        assert_eq!(requests.len(), 1);
        let req = &requests[0];
        assert_eq!(req.model, "m1");
        assert_eq!(req.session_id.as_deref(), Some(id));
        assert!(req.tools.is_empty());
        assert_eq!(req.options.temperature, Some(0.0));
        assert!(req.options.stream);
        assert_eq!(
            req.messages,
            vec![msg(
                ChatRole::User,
                MessageContent::Text(title_prompt(
                    "User: Port the session namer\nAssistant: Here is how."
                )),
            )]
        );
        drop(requests);

        assert_eq!(
            h.stored_title(id).as_deref(),
            Some("Porting the session namer"),
            "one quote layer stripped, the deltas joined verbatim"
        );
        assert_eq!(
            h.titled(),
            vec![json!({ "sessionId": id, "title": "Porting the session namer" })],
            "exactly one `session-titled`, and nothing else emitted"
        );

        // A second `agent_end` in the same session asks again? No — the row
        // carries a title now (guard 3), so the provider is never reached.
        h.agent_end(id, false);
        drain_tasks().await;
        assert_eq!(h.request_count().await, 1);
    }

    #[tokio::test]
    async fn a_row_that_already_carries_a_title_never_calls_the_provider() {
        let mut h = harness(vec![Script::answering("never")]);
        let id = "arch_titled";
        h.record_row(id, Some("Chosen by the user"), false);
        h.seed_config(id, &h.model());
        h.seed_transcript(id);

        h.agent_end(id, false);
        drain_tasks().await;

        assert_eq!(h.request_count().await, 0);
        assert_eq!(
            h.stored_title(id).as_deref(),
            Some("Chosen by the user"),
            "the existing title is untouched"
        );
        assert!(h.titled().is_empty());
    }

    #[tokio::test]
    async fn a_subagent_frame_never_calls_the_provider() {
        // The ROUTER-level guard: the frame says `is_subagent`, so naming is
        // not even asked (the hook is `!is_subagent && agent_end`).
        let mut h = harness(vec![Script::answering("never")]);
        let id = "arch_child_frame";
        h.seed_session(id);

        h.agent_end(id, true);
        drain_tasks().await;

        assert_eq!(h.request_count().await, 0);
        assert_eq!(h.stored_title(id), None);
        assert!(h.titled().is_empty());
    }

    #[tokio::test]
    async fn a_subagent_row_never_calls_the_provider() {
        // The ROW-level guard (pi skips ephemeral sessions; a subagent's
        // transcript is hidden from `list_sessions`, so naming it is
        // meaningless) — and it holds even when the frame does not say so.
        let h = harness(vec![Script::answering("never")]);
        let id = "arch_child_row";
        h.record_row(id, None, true);
        h.seed_config(id, &h.model());
        h.seed_transcript(id);

        h.agent_end(id, false);
        drain_tasks().await;

        assert_eq!(h.request_count().await, 0);
        assert_eq!(h.stored_title(id), None);
    }

    #[tokio::test]
    async fn naming_disabled_in_settings_never_calls_the_provider() {
        let h = harness(vec![Script::answering("never")]);
        let id = "arch_disabled";
        // The camelCase wire shape (`Settings` is `rename_all = "camelCase"`).
        write_settings_json(&h.dir, json!({ "sessionNamingEnabled": false }));
        h.seed_session(id);

        h.agent_end(id, false);
        drain_tasks().await;

        assert_eq!(h.request_count().await, 0);
        assert_eq!(h.stored_title(id), None);
    }

    #[tokio::test]
    async fn a_model_without_an_api_key_calls_nothing_and_counts_no_failure() {
        let mut h = harness(vec![Script::answering("never")]);
        let id = "arch_unconfigured";
        h.record_row(id, None, false);
        let mut unconfigured = h.model();
        unconfigured.api_key = String::new();
        h.seed_config(id, &unconfigured);
        h.seed_transcript(id);

        h.agent_end(id, false);
        drain_tasks().await;

        // pi's `hasConfiguredAuth` guard: a silent skip, never a failure and
        // never a UI notification.
        assert_eq!(h.request_count().await, 0);
        let state = h.state_of(id).expect("the pass ran");
        assert_eq!(state.fails, 0, "an unconfigured model is NOT a failure");
        assert!(!state.in_flight, "the early exit still cleared the flag");
        assert_eq!(h.stored_title(id), None);
        assert!(h.emitted().is_empty());
    }

    #[tokio::test]
    async fn three_request_failures_stop_naming_for_the_session() {
        let mut h = harness(vec![Script::error("the endpoint is down")]);
        let id = "arch_failing";
        h.seed_session(id);

        for expected in 1..=MAX_FAILURES {
            h.agent_end(id, false);
            h.await_request().await;
            let state = h.state_of(id).expect("the pass ran");
            assert_eq!(state.fails, expected, "one failure per failed request");
            assert!(
                !state.in_flight,
                "the failure path still clears `in_flight`"
            );
        }

        // The budget is spent: the next `agent_end` spawns nothing at all.
        h.agent_end(id, false);
        drain_tasks().await;
        assert_eq!(h.request_count().await, MAX_FAILURES as usize);
        // And a request failure is INVISIBLE: nothing written, nothing
        // emitted (the stderr log line is the only trace).
        assert_eq!(h.stored_title(id), None);
        assert!(
            h.emitted().is_empty(),
            "a failing provider emits NOTHING — no UI error"
        );
    }

    #[tokio::test]
    async fn a_truncated_answer_is_a_failure_and_writes_nothing() {
        let mut h = harness(vec![Script::Events(vec![
            ProviderEvent::TextDelta("Porting the session".to_string()),
            ProviderEvent::Done(FinishReason::Length),
        ])]);
        let id = "arch_truncated";
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        // A cut-off answer is an error, not a partial success (the
        // `compact.rs::summarize` rule: half a title is not a title).
        assert_eq!(h.state_of(id).expect("the pass ran").fails, 1);
        assert_eq!(h.stored_title(id), None);
        assert!(h.emitted().is_empty());
    }

    #[tokio::test]
    async fn a_stream_that_ends_without_a_done_is_a_failure() {
        // No `Done` at all (the provider's stream just stops): the same
        // "a truncated answer is an error" rule.
        let h = harness(vec![Script::Events(vec![ProviderEvent::TextDelta(
            "Porting the session namer".to_string(),
        )])]);
        let id = "arch_no_done";
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        assert_eq!(h.state_of(id).expect("the pass ran").fails, 1);
        assert_eq!(h.stored_title(id), None);
    }

    #[tokio::test]
    async fn an_answer_that_cleans_to_nothing_is_a_failure() {
        // A model that answers with whitespace only: writing `""` into
        // `sessions.title` would label the session with nothing, so it
        // counts as a failure (pi's `if (!title) onFailure()`).
        let mut h = harness(vec![Script::answering("  \n  ")]);
        let id = "arch_blank_answer";
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        assert_eq!(h.state_of(id).expect("the pass ran").fails, 1);
        assert_eq!(h.stored_title(id), None);
        assert!(h.emitted().is_empty());
    }

    #[tokio::test]
    async fn a_request_in_flight_blocks_a_second() {
        // The provider never answers, so the first request is STILL in
        // flight when the second `agent_end` arrives (a completed first
        // request would have written a title, and guard 3 — not guard 4 —
        // would be what stopped the second one).
        let h = harness(vec![Script::Pending]);
        let id = "arch_in_flight";
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;
        assert!(
            h.state_of(id).expect("the pass ran").in_flight,
            "the request is in flight"
        );

        h.agent_end(id, false);
        drain_tasks().await;
        assert_eq!(h.request_count().await, 1, "one request per session");
    }

    #[tokio::test]
    async fn an_empty_transcript_names_nothing_and_leaves_naming_armed() {
        let h = harness(vec![Script::answering("Porting the session namer")]);
        let id = "arch_no_transcript";
        h.record_row(id, None, false);
        h.seed_config(id, &h.model());
        // …and NO transcript yet (the store frames ride a different outbound
        // path than the `RpcEvent` stream, so this is a real ordering).

        h.agent_end(id, false);
        drain_tasks().await;

        assert_eq!(h.request_count().await, 0);
        assert!(
            !h.state_of(id).is_some_and(|s| s.in_flight || s.fails != 0),
            "a declined pass consumes nothing: no entry, or a pristine one"
        );

        // The transcript arrives later — the NEXT `agent_end` names the
        // session (this is why the excerpt guard retries instead of giving
        // up).
        h.seed_transcript(id);
        h.agent_end(id, false);
        h.await_request().await;
        assert_eq!(h.request_count().await, 1);
        assert_eq!(
            h.stored_title(id).as_deref(),
            Some("Porting the session namer")
        );
    }

    #[tokio::test]
    async fn the_naming_model_override_resolves_through_the_effective_catalog() {
        let h = harness(vec![Script::answering("Porting the session namer")]);
        let id = "arch_override";
        // The picker's own `"provider/id:<level>"` form, resolved by the
        // EFFECTIVE catalog (base + settings providers) inside the task.
        write_settings_json(&h.dir, json!({ "sessionNamingModel": "tama/m2:xhigh" }));
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        let req = h.one_request().await;
        assert_eq!(req.model, "m2", "the override's BARE id goes on the wire");
        assert_eq!(
            req.session_id.as_deref(),
            Some(id),
            "the request still belongs to the real session"
        );
        assert_eq!(
            h.stored_title(id).as_deref(),
            Some("Porting the session namer")
        );
    }

    #[tokio::test]
    async fn an_unknown_naming_model_falls_back_to_the_sessions_own_model() {
        // pi's `settingsModel ?? ctx.model`: a typo'd override is not an
        // error and not a failure — the session is titled with its own model.
        let h = harness(vec![Script::answering("Porting the session namer")]);
        let id = "arch_unknown_override";
        write_settings_json(&h.dir, json!({ "sessionNamingModel": "tama/ghost" }));
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        assert_eq!(h.one_request().await.model, "m1");
        assert_eq!(h.state_of(id).expect("the pass ran").fails, 0);
        assert_eq!(
            h.stored_title(id).as_deref(),
            Some("Porting the session namer")
        );
    }

    #[tokio::test]
    async fn a_reasoning_level_the_model_does_not_advertise_is_dropped() {
        let h = harness(vec![Script::answering("Porting the session namer")]);
        let id = "arch_bad_level";
        write_settings_json(&h.dir, json!({ "sessionNamingReasoning": "turbo" }));
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        assert_eq!(
            h.one_request().await.options.reasoning_effort,
            None,
            "an unverifiable level is never sent (decision 3)"
        );
    }

    #[tokio::test]
    async fn a_row_deleted_mid_flight_writes_nothing_and_counts_no_failure() {
        let mut h = harness(vec![Script::answering("Porting the session namer")]);
        let id = "arch_vanished";
        h.seed_session(id);
        // The row disappears between the guard read and the write (a close
        // racing the request): the conditional UPDATE matches no row.
        let db = h.db.clone();
        let vanished = id.to_string();
        h.set_on_call(move || {
            db.delete_session(&vanished).expect("the row deletes");
        });

        h.agent_end(id, false);
        h.await_request().await;

        // pi's race guard: a title with no row to hold it is dropped, and it
        // is NOT counted as a failure (nothing went wrong with naming).
        let state = h.state_of(id).expect("the pass ran");
        assert_eq!(state.fails, 0);
        assert!(!state.in_flight);
        assert!(
            h.emitted().is_empty(),
            "nothing is emitted for a row that is gone"
        );
    }

    #[tokio::test]
    async fn a_session_with_no_sink_still_persists_its_title() {
        // `set_sink` never called: the sink is the EMIT's source, not the
        // title's — a title still deserves persisting.
        let mut h = harness_with_sink(vec![Script::answering("Porting the session namer")], false);
        let id = "arch_no_sink";
        h.seed_session(id);

        h.agent_end(id, false);
        h.await_request().await;

        assert_eq!(
            h.stored_title(id).as_deref(),
            Some("Porting the session namer")
        );
        assert_eq!(h.state_of(id).expect("the pass ran").fails, 0);
        assert!(h.emitted().is_empty(), "and nothing to emit to");
    }

    /// Seed the naming entry (mid-flight, two failures deep) and the `live`
    /// entry the clean-exit teardown requires (it early-returns for a
    /// session that is not live).
    fn seed_teardown(h: &Harness, id: &str) {
        h.manager
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                id.to_string(),
                LiveWorkerSession {
                    cwd: h.dir.clone(),
                    close_kind: Arc::new(StdMutex::new(None)),
                    pending_turn: Arc::new(StdMutex::new(None)),
                    cancel_requested: Arc::new(StdMutex::new(false)),
                    pending_modal_ids: StdMutex::new(HashSet::new()),
                },
            );
        h.manager
            .naming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                id.to_string(),
                NamingState {
                    fails: 2,
                    in_flight: true,
                },
            );
    }

    #[test]
    fn a_clean_exit_leaves_no_naming_entry() {
        // `close_session` reaches this site through the Worker's EXPECTED
        // `Exited`, so it is the ONE teardown for both a close and a clean
        // self-exit.
        let h = harness(vec![Script::answering("never")]);
        let id = "arch_closing";
        seed_teardown(&h, id);

        h.manager.on_session_exited_expected(id);

        assert!(
            !h.has_naming_entry(id),
            "a closed session leaves no naming state behind"
        );
    }

    #[test]
    fn a_crash_leaves_no_naming_entry() {
        // A crashed-then-resumed session re-uses the SAME id: a stale
        // `in_flight` would block naming forever and a stale
        // `fails == MAX_FAILURES` would silently kill it — so the UNEXPECTED
        // `Exited` clears the entry too.
        let h = harness(vec![Script::answering("never")]);
        let id = "arch_crashing";
        h.manager
            .naming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                id.to_string(),
                NamingState {
                    fails: MAX_FAILURES,
                    in_flight: true,
                },
            );

        h.manager.handle_crash(id, Some(1));

        assert!(!h.has_naming_entry(id));
    }

    #[test]
    fn a_late_failure_never_resurrects_a_torn_down_entry() {
        // The teardown clears the entry while a title request is IN FLIGHT;
        // that request then fails. The bookkeeping must not re-create the
        // entry (the same rule the `InFlightClaim` follows), or "a closed
        // session leaves no naming entry" would hold only until the next
        // stderr log line.
        let h = harness(vec![Script::answering("never")]);
        let id = "arch_torn_down_mid_flight";
        h.manager
            .naming
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                id.to_string(),
                NamingState {
                    fails: 1,
                    in_flight: true,
                },
            );
        h.manager.handle_crash(id, Some(1));
        assert!(!h.has_naming_entry(id), "the crash cleared it");

        let state = h.manager.naming.clone();
        note_failure(&state, id);

        assert!(
            !h.has_naming_entry(id),
            "a failure after the teardown counts nothing and leaves nothing"
        );
    }
}
