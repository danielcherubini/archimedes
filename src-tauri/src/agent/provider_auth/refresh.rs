//! The per-flow refresh dispatcher + the Supervisor's background credential
//! refresher (issue #125, Task 1).
//!
//! [`refresh`] is the per-attempt dispatcher: one stored credential in, one
//! credential (or an `Err`) out. It NEVER persists — the caller persists on
//! success (the MCP `refresh_and_persist` detach pattern is T5/T6's concern),
//! and the transient-failure policy (backoff, keep serving) lives in the LOOP,
//! not here.
//!
//! [`SupervisorRefresher`] is the app's FIRST production interval loop (the
//! pattern T7 copies): it sleeps until the earliest `expires_at` minus the
//! 5-minute lead, retries transient failures with 5 s exponential backoff while
//! the still-valid stored token keeps serving, persists a successful refresh
//! and pushes the new bearer to live sessions. It is stoppable (its handle is
//! kept reachable — ADR 0078: an un-joined loop outliving its test is the
//! census-leak route) and suppressible from the `setup_dirs` seam (see
//! [`noop_refresher_factory`]).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::budget::{self, BudgetPoller};
use super::litellm_oauth;
use super::oidc;
use super::store::{self, ProviderAuthStore, ProviderCredential};
use crate::agent::debuglog;
use crate::agent::session::SessionManager;

/// Cap the sleep at 1 minute (never sleep longer than that with a `None` /
/// absent `expires_at` — the re-scan is cheap; MCP's guidance: `expires_at:
/// None` means never expires, so do NOT guess a wake-up time for it).
const MAX_SLEEP_MILLIS: u64 = 60_000;

/// The floor on a computed sleep: a target that has already passed (or is
/// already inside the lead) must not turn the loop into a busy spin.
const MIN_SLEEP_MILLIS: u64 = 1_000;

/// Refresh one stored credential. Each flow module implements its own arm;
/// `refresh::refresh` dispatches on the credential's `flow`.
///
/// T1 implements ONLY the `oauth` arm (the only stored credential type today);
/// T4 adds `gcloud_adc`, T5 adds `litellm_cli_pkce` / `litellm_cli_sso` /
/// `pasted_token`, T6 adds `oidc`.
///
/// An `Err` means "this attempt failed" — the CALLER decides. The refresher
/// loop treats it as transient (back off + keep serving the stored token);
/// nothing here discards or rewrites anything.
pub async fn refresh(
    cred: &ProviderCredential,
    client: &reqwest::Client,
) -> Result<ProviderCredential, String> {
    // The dispatch is an EXHAUSTIVE match on `ProviderCredential`, which is the
    // extension point: adding a variant (T6's `Oidc`) without adding its arm is
    // a COMPILE ERROR here, never a silent no-op that serves a stale token.
    // (A catch-all arm would be the alternative and is deliberately absent —
    // `ProviderCredential` has one variant today, so a catch-all is an
    // unreachable-pattern warning and, later, a hole.)
    match cred {
        // The `gcloud_adc` flow (T4, issue #128) is a LABEL route, not a
        // rotation: an ADC credential carries the user's ADC FILE, not a minted
        // token, and the exchange happens in `resolve_bearer`
        // (`gcloud::token`) against a 50-minute IN-MEMORY cache. There is
        // therefore nothing for the store loop to rotate — and persisting an ADC
        // access token would break T4's central rule (the mint never touches
        // disk), so this arm returns the credential UNCHANGED and never writes.
        ProviderCredential::OAuth(oauth) if oauth.flow == "gcloud_adc" => {
            debuglog::log(
                "provider-refresh: a `gcloud_adc` credential needs no store refresh (the ADC \
                 token is minted per resolve into the in-memory cache) — serving the stored \
                 entry unchanged",
            );
            Ok(cred.clone())
        }
        // The `litellm_cli_pkce` flow (T5, issue #126) is the ONE T5 flow with a
        // real rotation: the PKCE client is PUBLIC (no secret) and LiteLLM
        // rotates the refresh token on every exchange, so this arm exchanges the
        // stored refresh token at the stored `token_endpoint` and persists the
        // NEW pair (a used refresh token is refused with `400 invalid_grant`).
        //
        // ADR 0015's MCP guard (a public client never auto-refreshes) is
        // deliberately NOT applied here — its OPPOSITE is correct for this
        // credential, and that is the decision record the plan §4e names: the
        // acceptance criterion "token refresh automatically executed in
        // background before expiry" is met by refreshing a secret-less client in
        // provider_auth's own code, with `mcp::oauth::refresh` untouched.
        //
        // A missing piece (no refresh token / endpoint / client id) FALLS
        // THROUGH to the generic `oauth` arm below rather than short-circuiting
        // here, and that is deliberate: T1's arm already owns the documented
        // degradation for exactly that shape (`Ok(cred.clone())` when the
        // endpoint or the refresh token is absent, an `Err` when the endpoint
        // answers badly — the loop's backoff policy), and its tests pin it. A
        // `litellm_cli_pkce` row that carries the full triple takes THIS arm.
        // Deviation recorded in the commit message (the plan asked for an
        // in-arm `Ok(clone)` guard; the fall-through yields the same observable
        // outcomes without regressing T1's pins).
        ProviderCredential::OAuth(oauth)
            if oauth.flow == "litellm_cli_pkce"
                && oauth.refresh_token.is_some()
                && oauth.token_endpoint.is_some()
                && oauth.client_id.is_some() =>
        {
            let refreshed = litellm_oauth::refresh_pkce(oauth, client).await?;
            Ok(ProviderCredential::OAuth(refreshed))
        }
        // The `litellm_cli_sso` flow (the LEGACY device flow) is a DELIBERATE
        // NO-OP, and that is a decision, not an omission: the device-flow JWT
        // carries NO refresh token (verified §11b — the ready poll body returns
        // only `key`/`user_id`/`team_id`). Pi re-logins when it expires; here the
        // store holds the JWT's `exp`-derived `expires_at`, the Supervisor lets it
        // expire, and the expiry IS the user-facing re-login (T8 shows the
        // provider as needing sign-in). Pinned by
        // `pasted_token_and_cli_sso_refresh_are_noops` — if the device flow ever
        // DOES advertise a refresh mechanism, that pin fails loudly at the store
        // level instead of this arm quietly becoming wrong.
        ProviderCredential::OAuth(oauth) if oauth.flow == "litellm_cli_sso" => {
            debuglog::log(
                "provider-refresh: a `litellm_cli_sso` credential has no refresh token (the \
                 device-flow JWT is static) — serving the stored entry unchanged; when it \
                 expires the user re-logs in",
            );
            Ok(cred.clone())
        }
        // The `pasted_token` flow is the OTHER deliberate no-op: a pasted SSO
        // token — or the virtual key minted from one — is a static bearer with no
        // refresh token (`GenerateKeyResponse` carries none, §11d). Whether the
        // mint advertised an `expires` or not, there is nothing to rotate, and pi
        // behaves identically (no silent renewal). Same pin as above.
        ProviderCredential::OAuth(oauth) if oauth.flow == "pasted_token" => {
            debuglog::log(
                "provider-refresh: a `pasted_token` credential is a static bearer with no \
                 refresh token — serving the stored entry unchanged",
            );
            Ok(cred.clone())
        }
        // The `oidc` flow (T6, issue #127) is a REAL rotation with the sharpest
        // guard in the suite: `oidc::refresh` re-validates the refreshed
        // `id_token`'s claims and REFUSES the whole refresh when its `sub` names a
        // DIFFERENT account than the stored one (an account swap through a
        // long-lived refresh token must never reach the proxy). On an `Err` —
        // mismatch, a rejected grant, a transient 5xx — this dispatcher returns the
        // error and writes NOTHING: the loop keeps serving the stored, unexpired
        // `id_token` (T1's never-discard-on-refresh-failure discipline) and the user
        // re-logs in when it finally expires.
        ProviderCredential::Oidc(cred) if cred.flow == "oidc" => {
            let refreshed = oidc::refresh(cred, client).await?;
            Ok(ProviderCredential::Oidc(refreshed))
        }
        ProviderCredential::Oidc(cred) => Err(format!(
            "an oidc credential on the unknown flow `{}` cannot be refreshed (re-log in)",
            cred.flow
        )),
        ProviderCredential::OAuth(oauth) => refresh_oauth(oauth, client).await,
    }
}

/// The `oauth` arm: exchange the stored refresh token at the stored
/// `token_endpoint` for a new access token.
async fn refresh_oauth(
    oauth: &store::OAuthCredential,
    client: &reqwest::Client,
) -> Result<ProviderCredential, String> {
    // No endpoint = nothing to ask. A no-op, not an error: an entry that cannot
    // be refreshed is served as-is by `resolve_bearer`, and the loop must not
    // spend a backoff on a credential it was never going to refresh.
    let Some(token_endpoint) = oauth.token_endpoint.as_deref() else {
        debuglog::log(
            "provider-refresh: an oauth credential with no stored token endpoint — nothing to \
             refresh (serving the stored token)",
        );
        return Ok(ProviderCredential::OAuth(oauth.clone()));
    };
    // Same for a missing refresh token: the access token is all we hold and the
    // server has nothing to exchange it for.
    let Some(refresh_token) = oauth.refresh_token.as_deref() else {
        debuglog::log(
            "provider-refresh: an oauth credential with no stored refresh token — nothing to \
             refresh (serving the stored token)",
        );
        return Ok(ProviderCredential::OAuth(oauth.clone()));
    };
    // T1 keeps the form MINIMAL: the two RFC 6749 refresh fields only. The
    // `scope` / `resource` policy belongs to the flows that mint them (T5 / T6)
    // — sending a `resource` the IdP was never asked for is a decision, not a
    // default.
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ];
    let resp = client
        .post(token_endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("the token endpoint request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // The status is carried in the message so a log reader can tell a
        // rejected grant (400/401 — the refresh token is gone) from a transient
        // one (429/5xx — the loop backs off). The POLICY is identical for both
        // at this level: fail the attempt, keep the stored credential (a failed
        // refresh never discards a still-valid access token).
        return Err(format!("the token endpoint answered {status}"));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("the token endpoint response was not JSON: {e}"))?;
    let new_access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "the token response carried no `access_token`".to_string())?;
    // `expires_in` is SECONDS on the wire (RFC 6749); this store's unit is
    // MILLISECONDS (interface §3 — never "unify" with `mcp::oauth::StoredAuth`,
    // whose expiry is seconds). An absent `expires_in` KEEPS the stored expiry
    // rather than inventing one (`None` = never expires: the loop must not
    // guess a deadline the auth server never advertised).
    let expires_at = match body.get("expires_in").and_then(|v| v.as_i64()) {
        Some(secs) => Some(store::now_epoch_millis().saturating_add(secs.saturating_mul(1000))),
        None => oauth.expires_at,
    };
    // A rotated refresh token replaces the stored one; an absent one keeps the
    // stored value (a server that does not rotate must not cost us the token we
    // still hold).
    let refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| oauth.refresh_token.clone());
    Ok(ProviderCredential::OAuth(store::OAuthCredential {
        access_token: new_access.to_string(),
        refresh_token,
        expires_at,
        ..oauth.clone()
    }))
}

/// The earliest stored expiry the loop should act on within `horizon` (epoch
/// millis), or `None` when nothing in the store needs attention that soon.
///
/// `horizon` is compared against the moment an entry ENTERES the refresh lead
/// (`expires_at - REFRESH_LEAD_MILLIS`), not against its raw expiry: a token
/// that is already inside the 5-minute lead is due NOW, and one that enters the
/// lead within the horizon is due on the next scan (§5's target math — "an
/// expiry inside the 5-minute lead is targeted; one beyond MAX_SLEEP is not").
///
/// An already-expired entry counts: the loop's [`MIN_SLEEP_MILLIS`] floor is
/// what turns "refresh that one now" into a bounded re-scan rather than a spin.
/// An entry with `expires_at: None` never appears here — MCP's rule: the auth
/// server never advertised an expiry, so we do not invent one.
fn earliest_expiry_within_lead(store: &ProviderAuthStore, horizon: i64) -> Option<i64> {
    store
        .providers
        .values()
        .filter_map(|cred| match cred {
            ProviderCredential::OAuth(oauth) => oauth.expires_at,
            // An `oidc` credential's `expires_at` is the SAME unit (millis) and
            // means the same thing (when the stored `id_token` dies), so the loop
            // targets it exactly like an OAuth entry (issue #127).
            ProviderCredential::Oidc(oidc) => oidc.expires_at,
        })
        // The LEAD-aware horizon: an entry is targeted when the moment it
        // ENTERES the lead (`expires_at - REFRESH_LEAD_MILLIS`) is at or before
        // the horizon — which includes an entry already inside the lead (that
        // boundary is in the past). Targeting on the raw `expires_at` instead
        // would let a token that is already inside the 5-minute lead wait for a
        // later scan.
        .filter(|at| at.saturating_sub(store::REFRESH_LEAD_MILLIS) <= horizon)
        .min()
}

/// How long the loop sleeps before its next scan: until the earliest targeted
/// expiry minus the refresh lead, clamped into
/// [`MIN_SLEEP_MILLIS`]..=[`MAX_SLEEP_MILLIS`].
///
/// An empty store (or one with nothing expiring inside the horizon) sleeps the
/// full cap — the re-scan is a cheap small-file read, and `expires_at: None`
/// must not be turned into a guessed deadline.
fn next_sleep_millis(store: &ProviderAuthStore, now: i64) -> u64 {
    let horizon = now.saturating_add(MAX_SLEEP_MILLIS as i64);
    earliest_expiry_within_lead(store, horizon).map_or(MAX_SLEEP_MILLIS, |at| {
        let lead = at
            .saturating_sub(store::REFRESH_LEAD_MILLIS)
            .saturating_sub(now);
        lead.clamp(MIN_SLEEP_MILLIS as i64, MAX_SLEEP_MILLIS as i64) as u64
    })
}

/// The transient-failure backoff for one failed refresh attempt: 5 s doubled
/// per consecutive failure, capped at 80 s (`5 * 2^i` with `i` capped at 4).
///
/// The cap exists because a gateway that is down for ten minutes must not put
/// the loop to sleep for hours: the stored token keeps serving and a re-scan is
/// cheap. `failures` counts CONSECUTIVE failures — a success resets the counter
/// (the loop's `transient_failures`).
fn backoff_millis(failures: u32) -> u64 {
    // The counter is capped BEFORE the shift so a long outage cannot overflow
    // the shift (and the saturating multiply is the belt to that brace).
    let shift = failures.min(4);
    5_000u64.saturating_mul(1u64 << shift)
}

/// The deps the refresher loop needs, owned by the `setup_dirs` seam (so a test
/// decides whether a loop starts at all — never an unconditional spawn that
/// tests inherit).
pub struct SupervisorRefresherDeps<R: tauri::Runtime> {
    /// The store path. Production fills it with [`store::auth_file_path`] (the
    /// platform DATA dir, beside `mcp-auth.json` — ruling R3; never
    /// `config_dir`); a test injects a scratch path (the `mcp::manager`
    /// `with_auth_file` shape).
    pub auth_file_path: PathBuf,
    /// The live-session push target: the SAME `Arc<SessionManager>` the app
    /// manages, so the loop never depends on a state lookup that can silently
    /// miss (a miss would leave live sessions on a stale bearer with no trace).
    pub session_manager: Arc<SessionManager>,
    /// The app handle, carried for the later waves that need managed state or
    /// an event emit from the loop (T7's budget loop is the named consumer).
    /// T1's push goes through `session_manager`, so this field is deliberately
    /// unread on the T1 path — see [`production_refresher_factory`].
    pub app_handle: tauri::AppHandle<R>,
    /// T7's budget poller (issue #132): the SHARED ledger the loop's add-on
    /// populates and the `get_provider_budget` command reads — the same
    /// `Arc<Mutex<BudgetPoller>>` the app manages, so there is ONE denial
    /// scoreboard and ONE facts view, never two that can disagree.
    ///
    /// `None` (the test-facing shape) means NO budget pass at all: the loop's
    /// add-on is skipped entirely and the sleep math is exactly T1's, so a test
    /// that does not build a poller inherits neither the polling nor a shortened
    /// wake. This is an ADD-ON by data, not a rewrite of T1's loop.
    pub budget_poller: Option<Arc<std::sync::Mutex<budget::BudgetPoller>>>,
}

/// The refresher's handle, kept REACHABLE so a test (or the app's exit path)
/// can stop the loop.
///
/// `Drop` is the census backstop (cancel + abort), which is why a value that is
/// merely dropped can never outlive its scope. Prefer [`Self::stop`] when the
/// caller can await: it proves the task exited instead of being killed.
pub struct SupervisorRefresher {
    // The parts are `Option` so BOTH [`Self::stop`] (which takes `self` by
    // value — the plan's helper shape) and the `Drop` backstop can take them:
    // a type that implements `Drop` cannot have its fields moved out, and
    // `stop` takes what it needs first so `Drop` finds `None` and no-ops.
    cancel: Option<CancellationToken>,
    handle: Option<JoinHandle<()>>,
}

impl SupervisorRefresher {
    /// Start the loop on the CURRENT tokio runtime.
    ///
    /// `None` (a DECLINE, never a panic) when the calling thread has no runtime
    /// to hold the loop: `tokio::spawn` with no reactor PANICS, so a sync caller
    /// on a bare thread must be turned down rather than crash the app. The
    /// `attention::AttentionTimer::arm` guard is the precedent, including the
    /// wording convention (a refusal is a decision the caller cannot otherwise
    /// explain from the log, so the log says so). Production does not go through
    /// here — see [`production_refresher_factory`], which names why the `setup`
    /// hook is not a tokio context.
    pub fn start<R: tauri::Runtime>(deps: &SupervisorRefresherDeps<R>) -> Option<Self> {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            debuglog::log("provider-refresh: no tokio runtime; skipping");
            return None;
        };
        spawn_loop_on(
            handle,
            deps.auth_file_path.clone(),
            deps.session_manager.clone(),
            deps.budget_poller.clone(),
        )
    }

    /// Stop the loop and AWAIT its exit (the test-facing stop: it proves the
    /// loop broke on the cancel rather than being killed by `Drop`'s abort).
    pub async fn stop(self) {
        let mut this = self;
        if let Some(cancel) = this.cancel.take() {
            cancel.cancel();
        }
        if let Some(handle) = this.handle.take() {
            let _ = handle.await;
        }
    }
}

impl Drop for SupervisorRefresher {
    fn drop(&mut self) {
        // The backstop: cancel first (the graceful break), then abort in case
        // the task is parked somewhere the cancel cannot reach before the scope
        // ends. An aborted task cannot outlive this value, which is the ADR 0078
        // guarantee the temp-dir census relies on.
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }
}

/// The production factory: start the loop on the app's own runtime.
///
/// THE RUNTIME QUESTION (a deviation from the plan's §2b sketch, recorded
/// because the plan's sketch would not have worked): the `setup` hook is NOT
/// executed inside a tokio context — Tauri calls it from the event loop's
/// `Ready` handler (`tauri-2.12.2/src/app.rs`, the `RuntimeRunEvent::Ready` arm
/// calls `setup(&mut self)` directly), so a bare `Handle::try_current()` probe
/// would DECLINE in production and the refresher would never run. The plan's
/// `attention::arm` precedent does not transfer: that guard's caller is an
/// `async fn` command (inside the runtime), this one is the sync `setup` hook.
/// So production asks `tauri::async_runtime` for the singleton runtime Tauri
/// itself runs commands on — the documented mechanism for spawning from `setup`
/// — and only falls back to the current handle when there is one.
///
/// The decline-on-no-runtime guarantee still holds where it matters: the
/// test-facing [`SupervisorRefresher::start`] keeps the `try_current` probe, and
/// no test path ever reaches this factory (the test-facing `setup_dirs*` entries
/// pass [`noop_refresher_factory`]).
pub fn production_refresher_factory<R: tauri::Runtime>(
    deps: &SupervisorRefresherDeps<R>,
) -> Option<SupervisorRefresher> {
    // The handle is deliberately unread on the T1 path (the push goes to the
    // manager in `deps`); naming it here keeps the "carried for T7" contract
    // visible instead of looking like an oversight.
    let _ = &deps.app_handle;
    let handle = tokio::runtime::Handle::try_current()
        .unwrap_or_else(|_| tauri::async_runtime::handle().inner().clone());
    spawn_loop_on(
        handle,
        deps.auth_file_path.clone(),
        deps.session_manager.clone(),
        deps.budget_poller.clone(),
    )
}

/// A no-op factory (returns `None`) — the `test_support` seam: a test that runs
/// the whole `setup_dirs` app must never inherit a background loop.
pub fn noop_refresher_factory<R: tauri::Runtime>(
    _deps: &SupervisorRefresherDeps<R>,
) -> Option<SupervisorRefresher> {
    None
}

/// The test-facing spawn: the current-runtime probe (which DECLINES on a bare
/// thread) in front of [`spawn_loop_on`]. `SupervisorRefresher::start` is the
/// same probe, but it needs a full [`SupervisorRefresherDeps`] — i.e. a Tauri
/// app handle — to be called at all, so this is the shape the in-module tests
/// drive.
#[cfg(test)]
fn spawn_loop(
    auth_file: PathBuf,
    session_manager: Arc<SessionManager>,
) -> Option<SupervisorRefresher> {
    spawn_loop_with(auth_file, session_manager, None)
}

/// The test-facing spawn WITH the budget poller (T7's loop-math tests drive the
/// SAME loop T1 shipped — the poller is a parameter, never a second loop).
#[cfg(test)]
fn spawn_loop_with(
    auth_file: PathBuf,
    session_manager: Arc<SessionManager>,
    budget_poller: Option<Arc<std::sync::Mutex<BudgetPoller>>>,
) -> Option<SupervisorRefresher> {
    let handle = tokio::runtime::Handle::try_current()
        .map_err(|_| {
            debuglog::log("provider-refresh: no tokio runtime; skipping");
        })
        .ok()?;
    spawn_loop_on(handle, auth_file, session_manager, budget_poller)
}

/// Spawn the loop on a given runtime handle — the seam both the production
/// factory and the in-module tests use (a test needs no Tauri app to drive the
/// loop, only the store path and a `SessionManager`).
fn spawn_loop_on(
    handle: tokio::runtime::Handle,
    auth_file: PathBuf,
    session_manager: Arc<SessionManager>,
    budget_poller: Option<Arc<std::sync::Mutex<BudgetPoller>>>,
) -> Option<SupervisorRefresher> {
    let cancel = CancellationToken::new();
    let task = handle.spawn(run_loop(
        auth_file,
        session_manager,
        budget_poller,
        cancel.clone(),
    ));
    Some(SupervisorRefresher {
        cancel: Some(cancel),
        handle: Some(task),
    })
}

/// The loop body: scan → sleep (cancellably) → refresh what is due → persist +
/// push → repeat.
///
/// Every sleep is a `select!` against the cancel, so a stop is immediate rather
/// than bounded by the remaining sleep, and every failure path keeps the stored
/// credential (the acceptance rule "a transient failure never invalidates a
/// still-valid access token").
async fn run_loop(
    auth_file: PathBuf,
    session_manager: Arc<SessionManager>,
    budget_poller: Option<Arc<std::sync::Mutex<BudgetPoller>>>,
    cancel: CancellationToken,
) {
    let client = reqwest::Client::new();
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let now = store::now_epoch_millis();
        let snapshot = store::load(&auth_file);
        // T7's cadence rides THIS sleep (no second timer): the wake target is
        // the earlier of T1's credential-lead target and the budget poller's
        // next arm. A `None` poller — or one with nothing to poll — yields
        // T1's number untouched, so the loop's shape and its idle cost are
        // byte-identical to wave 1's.
        let sleep = next_sleep_millis_with_budget(&snapshot, now, budget_poller.as_deref());
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(sleep)) => {}
            _ = cancel.cancelled() => break,
        }

        // Re-read AFTER the sleep: the store is written by other actors (the
        // Settings page's auth, another process's refresh), so the sleep was
        // sized against a snapshot that may no longer be current.
        let now = store::now_epoch_millis();
        let due_horizon = now.saturating_add(store::REFRESH_LEAD_MILLIS);
        let loaded = store::load(&auth_file);
        let mut transient_failures: u32 = 0;
        for (provider_id, cred) in loaded.providers {
            if cancel.is_cancelled() {
                return;
            }
            // Only a credential inside the lead is worth a token exchange:
            // refreshing a token with hours left would be one request per
            // provider per minute for nothing.
            let due = match &cred {
                ProviderCredential::OAuth(oauth) => {
                    oauth.expires_at.is_some_and(|at| at <= due_horizon)
                }
                // An `oidc` entry is due on the same rule (issue #127): the loop
                // rotates the `id_token` before it dies so the resolve arm rarely
                // has to refresh synchronously.
                ProviderCredential::Oidc(oidc) => {
                    oidc.expires_at.is_some_and(|at| at <= due_horizon)
                }
            };
            if !due {
                continue;
            }
            let refreshed = match refresh(&cred, &client).await {
                Ok(refreshed) => refreshed,
                Err(e) => {
                    // A failed attempt keeps the stored credential AND keeps
                    // that token in service (`resolve_bearer` still reads the
                    // file, and `refresh_live_credentials` is never called).
                    // Back off, then let the next scan try again.
                    debuglog::log(&format!(
                        "provider-refresh: provider `{provider_id}` refresh failed — keeping the \
                         stored token: {e}"
                    ));
                    let backoff = backoff_millis(transient_failures);
                    transient_failures = transient_failures.saturating_add(1);
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                        _ = cancel.cancelled() => return,
                    }
                    continue;
                }
            };
            transient_failures = 0;
            if refreshed == cred {
                // A no-op arm (no endpoint / no refresh token / a flow with no
                // refresher yet): rewriting the file would be churn with no new
                // bytes, and a push would be a `set_model` for nothing.
                continue;
            }
            if let Err(e) = store::store_credential(&auth_file, &provider_id, refreshed.clone()) {
                // The persist failed: live sessions keep their old bearer and
                // the next scan re-reads the file, so nothing is lost — but the
                // refresh must not be reported as done from here.
                debuglog::log(&format!(
                    "provider-refresh: provider `{provider_id}` refreshed but the store write \
                     failed (the next scan retries): {e}"
                ));
                continue;
            }
            // Push the new bearer to the live sessions on that provider — ONLY
            // after a successful refresh AND a successful persist, so a session
            // is never handed a token the store does not hold.
            // EXHAUSTIVE for the same reason as `refresh`'s match: a new variant
            // must be a compile error here, not a silently-wrong push. T6's
            // `Oidc` variant pushes its VALIDATED `id_token` — the same string
            // `resolve_bearer`'s arm 2 serves (interface §1: both land in
            // `Model.api_key`).
            let api_key = match &refreshed {
                ProviderCredential::OAuth(oauth) => oauth.access_token.clone(),
                ProviderCredential::Oidc(oidc) => oidc.id_token.clone(),
            };
            let pushed = session_manager
                .refresh_live_credentials(&provider_id, &api_key)
                .await;
            debuglog::log(&format!(
                "provider-refresh: provider `{provider_id}` token refreshed ({pushed} live \
                 session(s) updated)"
            ));
        }

        // ── T7's add-on: the budget tick, INSIDE this loop, behind this cancel ──
        //
        // The loop-shape law (budget.rs's module doc): the budget work is a
        // BODY of THIS loop, never a second `tokio::spawn`. `run_budget_tick`
        // does its own interval gating (the denial re-arm) and returns
        // immediately when the interval has not elapsed, so a wake that was
        // only about a credential costs nothing here.
        //
        // `execute_helpers = true`: this is not a seed (the interface §4 gate
        // belongs to the boot-time command path), and a row whose bearer comes
        // from a `!command` helper would otherwise never report a budget. The
        // resolver is T1's — this task re-derives no credential.
        if let Some(poller) = &budget_poller {
            if cancel.is_cancelled() {
                return;
            }
            budget::run_budget_tick(poller, &client, None, true).await;
        }
    }
}

/// The loop's wake target WITH the budget cadence folded in (pure, so the
/// cadence is testable without a clock): T1's credential-lead sleep, shortened
/// to the budget poller's next arm when that is sooner, clamped into
/// [`MIN_SLEEP_MILLIS`]..=[`MAX_SLEEP_MILLIS`] so a fast injectable interval can
/// never turn the loop into a spin.
///
/// The two `None` cases are the load-bearing ones: no poller at all, and a
/// poller with NO providers to poll, both return T1's sleep unchanged (an idle
/// poller must not buy a wake every 15 s for nothing).
fn next_sleep_millis_with_budget(
    store: &ProviderAuthStore,
    now: i64,
    poller: Option<&std::sync::Mutex<BudgetPoller>>,
) -> u64 {
    let credential_sleep = next_sleep_millis(store, now);
    // The lock is taken and released HERE (a sync fn, no `await` anywhere near
    // it) — the loop never holds a guard across an await.
    let budget_due = poller
        .and_then(|p| p.lock().ok())
        .and_then(|guard| guard.millis_until_next_arm(now));
    match budget_due {
        Some(due) => due
            .clamp(MIN_SLEEP_MILLIS, MAX_SLEEP_MILLIS)
            .min(credential_sleep),
        None => credential_sleep,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::provider_auth::store::OAuthCredential;

    /// A bare `OAuthCredential` (what the store holds is the enum-wrapped
    /// variant below; this is the shape a struct-update (`..`) can start from).
    fn oauth_struct(expires_at: Option<i64>) -> OAuthCredential {
        OAuthCredential {
            flow: "litellm_cli_pkce".to_string(),
            access_token: "tok".to_string(),
            refresh_token: Some("rt".to_string()),
            expires_at,
            base_url: "https://gw.example/v1".to_string(),
            client_id: None,
            token_endpoint: Some("https://auth.example/token".to_string()),
            resource: None,
        }
    }

    /// The same credential in the variant the store and the dispatcher speak.
    fn oauth(expires_at: Option<i64>) -> ProviderCredential {
        ProviderCredential::OAuth(oauth_struct(expires_at))
    }

    /// A store carrying `provider id → expiry`.
    fn store_with(entries: &[(&str, Option<i64>)]) -> ProviderAuthStore {
        ProviderAuthStore {
            version: 1,
            providers: entries
                .iter()
                .map(|(id, at)| (id.to_string(), oauth(*at)))
                .collect(),
        }
    }

    #[test]
    fn earliest_expiry_within_lead_targets_an_expiry_inside_the_horizon() {
        // The target math: an expiry inside the horizon is targeted (including
        // one already inside the lead, and one already past), the EARLIEST one
        // wins, and anything beyond the horizon is left for a later scan.
        let now = 1_700_000_000_000_i64;
        let horizon = now + MAX_SLEEP_MILLIS as i64;

        // Inside the horizon (20 s out) → targeted.
        let soon = now + 20_000;
        let store = store_with(&[("a", Some(soon))]);
        assert_eq!(earliest_expiry_within_lead(&store, horizon), Some(soon));

        // Two entries → the earlier one decides the wake-up.
        let later = now + 40_000;
        let store = store_with(&[("late", Some(later)), ("early", Some(soon))]);
        assert_eq!(
            earliest_expiry_within_lead(&store, horizon),
            Some(soon),
            "the earliest expiry decides the wake-up"
        );

        // Beyond the horizon (10 minutes out) → nothing targeted.
        let store = store_with(&[("a", Some(now + 10 * 60_000))]);
        assert_eq!(earliest_expiry_within_lead(&store, horizon), None);

        // §5's pairing: an expiry INSIDE the 5-minute lead is targeted even
        // though its raw `expires_at` is beyond the 1-minute horizon — the
        // target is when the entry ENTERS the lead, not when it dies. (A
        // predicate on the raw `expires_at` fails exactly here.)
        let inside_lead = now + 4 * 60_000;
        let store = store_with(&[("a", Some(inside_lead))]);
        assert_eq!(
            earliest_expiry_within_lead(&store, horizon),
            Some(inside_lead),
            "an expiry inside the 5-minute lead is targeted although it is beyond MAX_SLEEP"
        );

        // Already expired → still targeted (the loop's floor bounds it).
        let past = now - 60_000;
        let store = store_with(&[("a", Some(past))]);
        assert_eq!(earliest_expiry_within_lead(&store, horizon), Some(past));

        // `expires_at: None` is NEVER targeted (never guess a deadline).
        let store = store_with(&[("a", None)]);
        assert_eq!(
            earliest_expiry_within_lead(&store, horizon),
            None,
            "an advertised expiry of None means never expires"
        );

        // An empty store targets nothing.
        assert_eq!(
            earliest_expiry_within_lead(&ProviderAuthStore::default(), horizon),
            None
        );
    }

    #[test]
    fn backoff_is_5s_doubling_capped_at_80_s() {
        // The §2b pseudocode's `5 * 2^i` with the counter capped at 4: 5, 10,
        // 20, 40, 80, then FLAT 80 (a long outage must not put the loop to sleep
        // for hours while a gateway is down, and the shift must not overflow).
        assert_eq!(backoff_millis(0), 5_000);
        assert_eq!(backoff_millis(1), 10_000);
        assert_eq!(backoff_millis(2), 20_000);
        assert_eq!(backoff_millis(3), 40_000);
        assert_eq!(backoff_millis(4), 80_000);
        assert_eq!(
            backoff_millis(5),
            80_000,
            "the cap is flat, not overflow-prone"
        );
        assert_eq!(
            backoff_millis(u32::MAX),
            80_000,
            "and it survives a huge counter"
        );
    }

    #[test]
    fn loop_sleeps_max_when_empty() {
        let now = 1_700_000_000_000_i64;
        // An empty store: the full cap (a cheap re-scan, no guessed deadline).
        assert_eq!(
            next_sleep_millis(&ProviderAuthStore::default(), now),
            MAX_SLEEP_MILLIS,
            "an empty store sleeps the full cap"
        );
        // Nothing expiring inside the horizon → the same cap.
        let store = store_with(&[("a", Some(now + 10 * 60_000))]);
        assert_eq!(next_sleep_millis(&store, now), MAX_SLEEP_MILLIS);
        // An entry 55 minutes out → outside the 1-minute horizon → the cap.
        let store = store_with(&[("a", Some(now + 55 * 60_000))]);
        assert_eq!(next_sleep_millis(&store, now), MAX_SLEEP_MILLIS);
        // An entry already INSIDE the lead (4 minutes out): the lead subtraction
        // is negative, so the floor applies — the loop wakes, refreshes, and
        // re-scans, at the floor rate rather than at 0 (no spin).
        let store = store_with(&[("a", Some(now + 4 * 60_000))]);
        assert_eq!(
            next_sleep_millis(&store, now),
            MIN_SLEEP_MILLIS,
            "an expiry already inside the lead wakes the loop at the floor, not at 0"
        );
        // An entry 2 minutes out → also inside the lead → the floor.
        let store = store_with(&[("a", Some(now + 120_000))]);
        assert_eq!(next_sleep_millis(&store, now), MIN_SLEEP_MILLIS);
    }

    // ── T7's budget-poller cadence (issue #132) ─────────────────────────────
    //
    // These drive the SAME loop T1 shipped: the budget work is a body of it, so
    // the cadence tests are sleep-MATH tests plus one live-suppression test. No
    // test here starts a second loop, and every spawned handle is `stop()`ed
    // (ADR 0078's census rule: an un-joined loop is how a suite leaks dirs).

    /// A `settings.json` carrying ONE litellm row (the poller's only input).
    fn write_litellm_settings(config_dir: &std::path::Path, base_url: &str) {
        std::fs::write(
            config_dir.join("settings.json"),
            serde_json::json!({
                "providers": [{
                    "id": "gw",
                    "name": "GW",
                    "baseUrl": base_url,
                    "apiKey": "sk-live",
                    "api": "litellm"
                }]
            })
            .to_string()
            .as_bytes(),
        )
        .expect("the settings file is written");
    }

    /// A poller over a scratch settings dir (no real dirs involved).
    fn poller_in(dir: &std::path::Path, interval_millis: u64) -> BudgetPoller {
        BudgetPoller::new(
            dir.to_path_buf(),
            dir.join("provider-auth.json"),
            interval_millis,
        )
    }

    #[test]
    fn poller_re_arms_denial_after_the_poll_interval() {
        // The invalidation rule, in one test: a denial is good until the poll
        // interval ELAPSES (then the scoreboard is forgotten and the endpoint is
        // probed once more), and an arm inside the interval does not poll at all.
        let dir = tempfile::tempdir().expect("a temp dir");
        write_litellm_settings(dir.path(), "https://gw.example/v1");
        let mut poller = poller_in(dir.path(), 15_000);
        let now = store::now_epoch_millis();

        // The FIRST arm is always due (`last_arm_millis` starts at 0).
        assert!(poller.arm_tick(now), "the first tick polls");
        assert_eq!(
            poller.provider_ids(),
            vec!["gw".to_string()],
            "the row was read"
        );
        poller
            .denial_memory_mut()
            .deny("https://gw.example/v1", budget::BudgetEndpoint::UserInfo);

        // Inside the interval: NOT due, so no request and no re-probe.
        assert!(
            !poller.arm_tick(now + 14_999),
            "a wake inside the interval skips the whole budget pass"
        );
        assert!(
            poller
                .denial_memory()
                .is_denied("https://gw.example/v1", budget::BudgetEndpoint::UserInfo),
            "a denial survives until the interval elapses (that is the suppression)"
        );
        assert_eq!(
            poller.millis_until_next_arm(now + 14_999),
            Some(1),
            "the loop is told exactly how long is left"
        );

        // The interval elapses: due again AND the scoreboard is re-armed, so a
        // forbidden endpoint costs ONE request per interval and a proxy that
        // granted the entitlement mid-interval is heard again.
        assert!(poller.arm_tick(now + 15_000), "the interval elapsed ⇒ poll");
        assert!(
            poller.denial_memory().is_empty(),
            "the re-arm forgets every denial"
        );
        assert_eq!(poller.millis_until_next_arm(now + 15_000), Some(15_000));
    }

    #[test]
    fn poller_sleeps_max_when_no_providers() {
        // The idle-cost rule: the budget cadence may SHORTEN T1's wake, but a
        // poller with NOTHING to poll must not buy a wake every interval.
        let dir = tempfile::tempdir().expect("a temp dir");
        let now = store::now_epoch_millis();
        let empty_store = ProviderAuthStore::default();

        // (a) no poller at all ⇒ exactly T1's number.
        assert_eq!(
            next_sleep_millis_with_budget(&empty_store, now, None),
            MAX_SLEEP_MILLIS,
            "no poller ⇒ T1's sleep untouched"
        );
        // (b) a poller with no provider rows ⇒ the same (the load-bearing case).
        let idle = std::sync::Arc::new(std::sync::Mutex::new(poller_in(dir.path(), 15_000)));
        assert_eq!(
            next_sleep_millis_with_budget(&empty_store, now, Some(&idle)),
            MAX_SLEEP_MILLIS,
            "an idle poller never shortens the sleep"
        );
        // (c) WITH a provider, the budget arm shortens it — and a provider whose
        // arm is 15 s out lands at 15 s, not at T1's 60 s cap.
        write_litellm_settings(dir.path(), "https://gw.example/v1");
        let busy = std::sync::Arc::new(std::sync::Mutex::new(poller_in(dir.path(), 15_000)));
        {
            // Arm it once so the next arm is a full interval out.
            busy.lock().unwrap().arm_tick(now);
        }
        assert_eq!(
            next_sleep_millis_with_budget(&empty_store, now, Some(&busy)),
            15_000,
            "the budget cadence drives the wake when it is the sooner target"
        );
        // (d) clamped at the floor: an injectable 1 ms interval must not turn the
        // loop into a busy spin.
        let spin = std::sync::Arc::new(std::sync::Mutex::new(poller_in(dir.path(), 1)));
        {
            spin.lock().unwrap().arm_tick(now);
        }
        assert_eq!(
            next_sleep_millis_with_budget(&empty_store, now, Some(&spin)),
            MIN_SLEEP_MILLIS,
            "the floor bounds a fast injectable interval (no spin)"
        );
        // (e) and it never LENGTHENS T1's wake: a credential due in 2 s still
        // wins over a budget arm 15 s out.
        let due_soon = store_with(&[("gw", Some(now + 2_000 + store::REFRESH_LEAD_MILLIS))]);
        assert_eq!(
            next_sleep_millis_with_budget(&due_soon, now, Some(&busy)),
            2_000,
            "the credential lead (2 s out) still wins over a budget arm 15 s out — \
             the add-on can only SHORTEN, never lengthen, T1's target"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn poller_select_cancel_breaks_the_wake() {
        // T1's stoppability guarantee, re-pinned WITH the budget add-on attached
        // (the whole point of riding the existing loop: one cancel governs both
        // bodies). `stop()` JOINS, so a loop that slept through the cancel — or
        // that blocked in a budget pass the cancel cannot reach — times out
        // here instead of passing.
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("provider-auth.json");
        let session_manager = Arc::new(SessionManager::new(dir.path().to_path_buf()));
        // An EMPTY settings dir: the budget pass has nothing to poll, so this
        // test stays hermetic (no HTTP) while still exercising the add-on's arm
        // on every wake.
        let poller = std::sync::Arc::new(std::sync::Mutex::new(poller_in(dir.path(), 15_000)));
        let refresher = spawn_loop_with(auth_file, session_manager, Some(poller.clone()))
            .expect("a runtime holds the loop");
        let exited = tokio::time::timeout(Duration::from_secs(5), refresher.stop()).await;
        assert!(
            exited.is_ok(),
            "the loop broke on the cancel with the budget add-on attached"
        );
        assert!(
            poller.lock().unwrap().facts("gw").is_none(),
            "a poller with no rows stores no facts"
        );
    }

    #[test]
    fn poller_backoff_is_5s_doubling_capped_and_the_budget_path_adds_none() {
        // ONE backoff in this loop (T1's): the budget add-on must NOT introduce
        // a second one, or a 429-storm and a token-refresh outage would fight
        // over the wake time. Pinned by the values (the T1 curve, unchanged) and
        // by the budget side's contract: a transient verdict enters NO memory,
        // so the retry cadence for a rate-limited endpoint is the POLL INTERVAL
        // (`millis_until_next_arm`) and never a doubling backoff.
        assert_eq!(backoff_millis(0), 5_000);
        assert_eq!(backoff_millis(3), 40_000);
        assert_eq!(backoff_millis(u32::MAX), 80_000, "the cap is flat");
        // The budget path's counterpart: 429 is transient (no memory), so the
        // loop's next arm is the plain interval regardless of how many 429s ran.
        assert_eq!(
            budget::classify_status(429),
            budget::PollStatus::Transient,
            "the pin: a 429 is not a denial"
        );
        let dir = tempfile::tempdir().expect("a temp dir");
        write_litellm_settings(dir.path(), "https://gw.example/v1");
        let mut poller = poller_in(dir.path(), 15_000);
        let now = store::now_epoch_millis();
        assert!(poller.arm_tick(now));
        for _ in 0..5 {
            // Five consecutive rate-limited ticks change NOTHING about the cadence.
            assert_eq!(poller.millis_until_next_arm(now + 5_000), Some(10_000));
        }
        assert!(
            poller.denial_memory().is_empty(),
            "a rate-limited endpoint is never silenced"
        );
    }

    #[tokio::test]
    async fn poller_ignores_a_denied_endpoint_without_logging() {
        // The suppression's OTHER half (the integration file's named test counts
        // REQUESTS; the log line is only observable where the sink can be wired).
        // The `debuglog::init` + scratch-dir + disable-on-exit shape is
        // `commands::sessions.rs`'s precedent, verbatim.
        struct DisableDebuglogOnExit;
        impl Drop for DisableDebuglogOnExit {
            fn drop(&mut self) {
                debuglog::init(false, None);
            }
        }

        let dir = tempfile::tempdir().expect("a temp dir");
        let _disable = DisableDebuglogOnExit;
        debuglog::init(true, Some(dir.path().to_path_buf()));

        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/key/info"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"spend": 1.0})),
            )
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v2/user/info"))
            .respond_with(wiremock::ResponseTemplate::new(403))
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/user/info"))
            .respond_with(wiremock::ResponseTemplate::new(403))
            .mount(&server)
            .await;

        write_litellm_settings(dir.path(), &server.uri());
        let poller = std::sync::Arc::new(std::sync::Mutex::new(poller_in(dir.path(), 15_000)));
        let client = reqwest::Client::new();

        // Tick 1: the forbidden hop is probed, and the denial is narrated ONCE.
        budget::run_budget_tick(&poller, &client, None, true).await;
        let after_first = std::fs::read_to_string(dir.path().join("supervisor.log"))
            .expect("an enabled debug log writes the denial");
        assert!(
            after_first.contains("/v2/user/info"),
            "the hop that got denied IS named once: {after_first}"
        );
        let denial_lines = after_first.lines().filter(|l| l.contains("denied")).count();
        assert_eq!(denial_lines, 1, "exactly one denial line: {after_first}");

        // Tick 2 (same interval, so the loop's own gating applies): the denied
        // hop is skipped BEFORE the request is built ⇒ no request AND no line.
        budget::run_budget_tick(&poller, &client, None, true).await;
        let after_second = std::fs::read_to_string(dir.path().join("supervisor.log"))
            .expect("the log still exists");
        assert_eq!(
            after_second
                .lines()
                .filter(|l| l.contains("denied"))
                .count(),
            1,
            "a suppressed hop logs NOTHING (no repeated denial line): {after_second}"
        );
        let requests = server.received_requests().await.expect("recorded requests");
        let hits = |p: &str| requests.iter().filter(|r| r.url.path() == p).count();
        assert_eq!(hits("/key/info"), 1, "the tick was NOT skipped wholesale");
        assert_eq!(
            hits("/v2/user/info"),
            1,
            "the denied hop was not re-requested (and so could not log)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_breaks_the_loop() {
        // The stoppability guarantee (interface §7 / ADR 0078): the loop's sleep
        // is a `select!` against the cancel, so a stop returns promptly instead
        // of waiting out a sleep it would then act on. An EMPTY store is the
        // worst case here (the loop parks on the full 60 s cap), and `stop()`
        // JOINS — so a loop that ignored the cancel would hang rather than pass.
        let dir = tempfile::tempdir().expect("a temp dir");
        let auth_file = dir.path().join("provider-auth.json");
        let session_manager = Arc::new(SessionManager::new(dir.path().to_path_buf()));

        let refresher =
            spawn_loop(auth_file.clone(), session_manager).expect("a runtime holds the loop");
        let exited = tokio::time::timeout(Duration::from_secs(5), refresher.stop()).await;
        assert!(
            exited.is_ok(),
            "the refresher's task exited on its own after the cancel (a timeout would mean the \
             loop ignored it and only `Drop`'s abort would have ended it)"
        );
        assert!(
            !auth_file.exists(),
            "a scan of a missing store never WRITES it (an empty read must not create a file)"
        );
    }

    /// The production factory's RUNTIME FALLBACK, pinned in isolation (the
    /// deviation [`production_refresher_factory`] documents: the `setup` hook is
    /// not a tokio context, so `try_current` alone would decline in production
    /// and the refresher would never run).
    ///
    /// A plain `#[test]` body runs on a thread with NO current runtime — the same
    /// condition Tauri's `Ready` handler presents — so this asserts both halves:
    /// the probe fails, and Tauri's singleton handle still spawns (the loop would
    /// start). Hermetic: no `AppHandle` is needed to reach the mechanism.
    #[test]
    fn the_production_runtime_fallback_spawns_where_try_current_declines() {
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "the premise: a plain test thread has no current runtime (the `setup`-hook \
             condition the plan's `try_current`-only sketch would decline on)"
        );
        let handle = tauri::async_runtime::handle().inner().clone();
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = ran.clone();
        let task = handle.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        // Drive the singleton to completion for this task (the loop's own future
        // is endless, so a real stop goes through the `CancellationToken`; here
        // the question is only WHETHER the spawn runs at all).
        tauri::async_runtime::block_on(task).expect("the spawned task ran");
        assert!(
            ran.load(std::sync::atomic::Ordering::SeqCst),
            "Tauri's singleton runtime executes the task, so the production loop starts \
             where a bare `Handle::try_current()` would have declined"
        );
    }

    #[test]
    fn start_declines_without_a_runtime_instead_of_panicking() {
        // The `attention::arm` guard, pinned: a sync caller with no tokio
        // runtime gets `None` (a decline), never the `tokio::spawn` panic. A
        // plain `#[test]` runs on NO runtime, which is exactly the condition the
        // sync `setup_dirs` core can meet (`tests/ipc.rs`'s `tauri::test` mock
        // runtime is the sibling case the `attention` guard documents).
        let dir = tempfile::tempdir().expect("a temp dir");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spawn_loop(
                dir.path().join("provider-auth.json"),
                Arc::new(SessionManager::new(dir.path().to_path_buf())),
            )
        }));
        assert!(
            matches!(&result, Ok(None)),
            "no runtime ⇒ None (declined), never a panic: {:?}",
            result.as_ref().map(Option::is_some)
        );
    }

    /// A raw HTTP server that answers ONE request with a canned status + body
    /// (the `catalog.rs::raw_json_server` pattern, extended to RECORD the
    /// request — the refresh test asserts the POST target and the form fields,
    /// not only the response handling).
    async fn canned_token_server(
        listener: tokio::net::TcpListener,
        status: u16,
        body: &str,
    ) -> tokio::task::JoinHandle<String> {
        let body = body.to_string();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let Ok((mut stream, _)) = listener.accept().await else {
                return String::new();
            };
            let mut buf = [0u8; 4096];
            let mut data = Vec::new();
            // Read the headers, then the declared body, so the form is
            // observable.
            // The byte offset just past the header block (the `while` below
            // either sets it and breaks, or returns — so it is always assigned
            // before the read).
            let header_end;
            loop {
                let Ok(n) = stream.read(&mut buf).await else {
                    return String::new();
                };
                if n == 0 {
                    return String::new();
                }
                data.extend_from_slice(&buf[..n]);
                if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&data).to_string();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.trim()
                        .eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            let mut body_bytes = data[header_end..].to_vec();
            while body_bytes.len() < content_length {
                let Ok(n) = stream.read(&mut buf).await else {
                    break;
                };
                if n == 0 {
                    break;
                }
                body_bytes.extend_from_slice(&buf[..n]);
            }
            let reason = if status == 200 {
                "OK"
            } else {
                "Too Many Requests"
            };
            let resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: \
                 {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            format!("{headers}\nBODY:{}", String::from_utf8_lossy(&body_bytes))
        })
    }

    #[tokio::test]
    async fn refresh_oauth_exchanges_the_token_endpoint_for_a_new_access_token() {
        // The `oauth` arm, and the transient case the loop backs off from, in
        // the two shapes the acceptance criteria name: a canned 200 (new token +
        // `expires_in` SECONDS → `expires_at` MILLIS) and a canned 429 (`Err`,
        // the credential untouched).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = canned_token_server(
            listener,
            200,
            r#"{"access_token":"fresh-bearer","expires_in":3600}"#,
        )
        .await;

        let endpoint = format!("http://{addr}/token");
        let cred = ProviderCredential::OAuth(OAuthCredential {
            flow: "litellm_cli_pkce".to_string(),
            access_token: "stale-bearer".to_string(),
            refresh_token: Some("stored-rt".to_string()),
            expires_at: Some(store::now_epoch_millis()),
            base_url: "https://gw.example/v1".to_string(),
            client_id: Some("client-1".to_string()),
            token_endpoint: Some(endpoint.clone()),
            resource: Some("https://gw.example".to_string()),
        });

        let before = store::now_epoch_millis();
        let refreshed = refresh(&cred, &reqwest::Client::new())
            .await
            .expect("the exchange succeeds");
        let after = store::now_epoch_millis();

        // This was an IRREFUTABLE `let` while the enum had one variant; T6's
        // `Oidc` variant turned it into a compile error (the extension point
        // behaving exactly as T1's plan describes) and this `let … else` is the
        // checklist item that error demanded: the arm is a PANIC, so a future
        // dispatcher that routed this `oauth` credential into an `Oidc` output
        // reddens here instead of quietly asserting against the wrong variant.
        let ProviderCredential::OAuth(next) = &refreshed else {
            panic!("an oauth credential refreshed into a non-oauth variant: {refreshed:?}");
        };
        assert_eq!(
            next.access_token, "fresh-bearer",
            "the new token is the whole point"
        );
        let expires_at = next.expires_at.expect("`expires_in` became `expires_at`");
        // MILLIS: `expires_in: 3600` is one hour, so the stored expiry is one
        // hour of MILLISECONDS past now — a seconds mixup lands at now+3.6 s and
        // fails the lower bound (interface §3's silent-unit-swap warning).
        assert!(
            expires_at >= before + 3_600_000 && expires_at <= after + 3_600_000,
            "`expires_at` is now + 3600 SECONDS expressed in MILLIS: {expires_at} (before={before})"
        );
        assert_eq!(
            next.refresh_token.as_deref(),
            Some("stored-rt"),
            "a response that does not rotate keeps the stored refresh token"
        );
        // The identity / context fields survive the exchange untouched.
        assert_eq!(next.flow, "litellm_cli_pkce");
        assert_eq!(next.base_url, "https://gw.example/v1");
        assert_eq!(next.client_id.as_deref(), Some("client-1"));
        assert_eq!(next.token_endpoint.as_deref(), Some(endpoint.as_str()));
        assert_eq!(next.resource.as_deref(), Some("https://gw.example"));

        let recorded = server.await.expect("the server task ran");
        assert!(
            recorded.contains("POST /token"),
            "the refresh POSTs the stored token endpoint: {recorded}"
        );
        assert!(
            recorded.contains("grant_type=refresh_token"),
            "the form carries `grant_type`: {recorded}"
        );
        assert!(
            recorded.contains("refresh_token=stored-rt"),
            "the form carries the stored refresh token: {recorded}"
        );

        // The transient case: a 429 is an `Err` (the loop backs off and keeps
        // serving) — never a silent success, and nothing here discards the
        // credential the caller still holds.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = canned_token_server(listener, 429, r#"{"error":"rate_limited"}"#).await;
        let rate_limited = ProviderCredential::OAuth(OAuthCredential {
            token_endpoint: Some(format!("http://{addr}/token")),
            expires_at: None,
            ..oauth_struct(Some(0))
        });
        let err = refresh(&rate_limited, &reqwest::Client::new())
            .await
            .expect_err("a 429 fails the attempt");
        assert!(
            err.contains("429"),
            "the error names the status so a log reader can tell transient from rejected: {err}"
        );
        server.await.expect("the server task ran");
    }

    #[tokio::test]
    async fn refresh_without_an_endpoint_or_refresh_token_is_an_unchanged_no_op() {
        // The no-op arms are NOT errors: an entry that cannot be refreshed is
        // served as-is by `resolve_bearer`, and the loop must not spend a
        // backoff on a credential it was never going to refresh.
        let client = reqwest::Client::new();
        let no_endpoint = ProviderCredential::OAuth(OAuthCredential {
            token_endpoint: None,
            ..oauth_struct(Some(0))
        });
        assert_eq!(
            refresh(&no_endpoint, &client)
                .await
                .expect("a no-op, not an error"),
            no_endpoint,
            "unchanged"
        );
        let no_refresh_token = ProviderCredential::OAuth(OAuthCredential {
            refresh_token: None,
            ..oauth_struct(Some(0))
        });
        assert_eq!(
            refresh(&no_refresh_token, &client)
                .await
                .expect("a no-op, not an error"),
            no_refresh_token,
            "unchanged"
        );
    }
}
