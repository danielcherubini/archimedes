//! Shared agent-layer vocabulary types.
//!
//! Extracted from `session.rs` (Task 5 of the god-file decomposition). A
//! TRUE SIBLING of `session/` — the modules that used to import these items
//! from `session` (`subagent`, `worker/manager`) now import from here, which
//! is what breaks the module cycle (a child of `session/` would leave the
//! `subagent → session` / `worker/manager → session` edges intact).

/// Mint a fresh unique session ID with the `arch_` prefix.
pub fn mint_session_id() -> String {
    format!("arch_{}", uuid::Uuid::new_v4())
}

/// Mint the id stamp for ONE Worker's life within a Session (a **Session
/// incarnation**, ADR 0049). SIX lowercase hex chars, opaque: it is a
/// namespace, not a value anyone decodes — and being hex-only is what lets
/// `normalize::is_bookkeeping_message_id` read an id's fields positionally
/// without ever mistaking a stamp for one of them.
pub fn mint_incarnation() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    id[..6].to_string()
}
