//! Supervisor-side provider credentials: the `provider-auth.json` store, the
//! bearer-resolution dispatcher, and the background refresher. Deliberately
//! NOT under `agent/harness/provider/` (the wire clients — ADR 0024).
//!
//! The token's destination is `Model.api_key` (interface §1):
//! `EffectiveCatalog::resolve` is the single substitution site, so the Worker
//! never learns about OAuth/ADC/OIDC — it holds a pushed snapshot string.
//! Wiring `resolve_bearer` into `resolve` is T2/T4's seam; this module owns
//! the resolution, the store and the refresh lifecycle.

pub mod gcloud;
pub mod headers;
pub mod key_helper;
pub mod refresh;
pub mod store;

pub use gcloud::{adc_file_path, describe_error, parse_adc, token as gcloud_token, AdcCredential};
pub use headers::{expand_map, validate_base_url};
pub use key_helper::run as run_key_helper;
pub use refresh::{
    noop_refresher_factory, production_refresher_factory, refresh, SupervisorRefresher,
    SupervisorRefresherDeps,
};
pub use store::{
    auth_file_path, is_expiring_soon, load, now_epoch_millis, remove_credential, save,
    store_credential, OAuthCredential, ProviderAuthStore, ProviderCredential, REFRESH_LEAD_MILLIS,
};

use std::path::Path;

/// Is the `gcloud_adc` flow enabled for one provider row? (issue #128.)
///
/// Precedence, in the ONE place it is computed:
/// - `LITELLM_GCLOUD_TOKEN_AUTH` unset (or an unrecognised value) → the row
///   decides (`use_gcloud_token_auth` OR `authMode: "gcloud_adc"`);
/// - `=0` / `=false` → OFF even for a row that enabled it (an explicit env
///   disable beats the config — the escape hatch for "never touch my ADC file");
/// - `=1` / `=true` → ON for EVERY row (an env force beats a config that did not
///   opt in — the container/CI shape, where the ADC file is the only credential).
///
/// The env is read PER CALL, deliberately: this runs on a Supervisor resolve
/// (not a per-turn Worker path), it keeps the toggle injectable from a test
/// without touching `settings.json`, and it means the flag cannot be cached at
/// startup behind a settings load.
pub fn gcloud_token_auth_enabled(provider: &crate::config::ProviderConfig) -> bool {
    let enabled_by_row = provider.use_gcloud_token_auth || provider.auth_mode == "gcloud_adc";
    match std::env::var_os("LITELLM_GCLOUD_TOKEN_AUTH").as_deref() {
        Some(v) if v == "0" || v.eq_ignore_ascii_case("false") => false,
        Some(v) if v == "1" || v.eq_ignore_ascii_case("true") => true,
        // Unset, or any other spelling: the row decides (a typo in the env must
        // not silently disable a flow the user configured).
        _ => enabled_by_row,
    }
}

/// The effective bearer for one provider row, or `None` to mean "use the row's
/// static `api_key` as-is". Never `Err` at this boundary — a failure resolves
/// to `None` + a `debuglog` line, because blanking a working key is worse than
/// a stale one (interface §1).
///
/// THE production entry (the interface fixes this signature — T2/T4 wire it
/// into `EffectiveCatalog::resolve`): it resolves the store path itself via
/// [`store::auth_file_path`] — the platform DATA dir, beside `mcp-auth.json`
/// (ruling R3). NEVER resolved from `config_dir` (a different directory —
/// `~/.config/archimedes` vs `~/.local/share/archimedes` on Linux). It is a
/// thin alias over [`resolve_bearer_at`], so the two are the same path by
/// construction, never by convention.
///
/// `execute_helpers` is the spec's `execute_helpers = false` seeding gate (T2
/// owns threading it); T1 declares the parameter so T2 does not have to change
/// the signature every caller uses.
pub async fn resolve_bearer(
    provider: &crate::config::ProviderConfig,
    config_dir: &Path,
    client: &reqwest::Client,
    execute_helpers: bool,
) -> Option<String> {
    resolve_bearer_at(
        provider,
        &store::auth_file_path(),
        config_dir,
        client,
        execute_helpers,
    )
    .await
}

/// THE path-taking core (the tested seam — the `mcp::manager` `with_auth_file`
/// shape): every `oauth`/`oidc` read goes through `auth_file: &Path`, so a test
/// passes `scratch.join("provider-auth.json")` and nothing ever touches the
/// real data dir. Production reaches it through [`resolve_bearer`], which
/// passes [`store::auth_file_path`].
///
/// The `gcloud_adc` / `!command` arms (which may need `config_dir`) share this
/// ONE body so later tasks extend a single function, not two.
pub async fn resolve_bearer_at(
    provider: &crate::config::ProviderConfig,
    auth_file: &Path,
    config_dir: &Path,
    client: &reqwest::Client,
    execute_helpers: bool,
) -> Option<String> {
    // `client` and `config_dir` are both live now (the `gcloud_adc` flow uses
    // them; T5/T6 will use `client` for a synchronous refresh before serving an
    // expiring token). No parameter is left unnamed.
    // The dispatch ORDER is FIXED by interface §4 — earlier arms must not be
    // reordered. Slot 1 (the ADC flow) sits above the landed match, which keeps
    // T1's/T2a's arm order exactly as it landed.
    // Dispatch slot 1 (interface §4, T4 / issue #128): the Google ADC flow.
    // `gcloud::token` mints (or reuses a cached) access token from the user's ADC
    // file; ANY failure inside it — no ADC file, a `service_account`, a
    // malformed file, a failed exchange — resolves to `None`, which means
    // "serve the row's static key" (interface §1: a failed credential resolution
    // degrades, it never blanks), and `gcloud` logs the specific diagnostic
    // through `debuglog`.
    //
    // A MISS FALLS THROUGH to the rest of the ladder (interface §4's slot order
    // says ADC is asked FIRST, not that it is the only thing asked: a row with
    // both `useGcloudTokenAuth` and a `!command` key helper keeps its helper when
    // the ADC file is absent). It is written as an early-return rather than a
    // `match` arm so that fall-through is the plain control flow, and the
    // match below keeps T1's/T2a's landed arm order untouched (ruling R8's
    // arm-3-vs-oauth ordering is T5's to change, not this task's).
    //
    // This flow is NOT a subprocess and takes no `execute_helpers` gate: the
    // exchange is one `reqwest` POST, so the "no child process at seeding"
    // invariant is untouched (pinned by the zero-subprocess census). The minted
    // token is NEVER persisted — `gcloud` holds it in a 50-minute in-memory cache
    // and nothing writes it to the provider-auth store.
    if gcloud_token_auth_enabled(provider) {
        if let Some(token) = gcloud::token(config_dir, client).await {
            return Some(token);
        }
        crate::agent::debuglog::log(&format!(
            "provider-auth: gcloud_adc produced no token for provider `{}` — falling back to \
             the row's other credential sources (the static key if there are no others)",
            provider.id
        ));
    }
    match provider.auth_mode.as_str() {
        // Arm 3 (T2a, issue #129): an `api_key` starting with `!` is a KEY
        // HELPER — executed when `execute_helpers` is true. A helper FAILURE
        // degrades to `None` (the static key as-is) per the interface's rule —
        // never an `Err`, never a blank — with a debuglog line. With
        // `execute_helpers == false` (the seeding path) the helper is NEVER
        // spawned and `None` is returned (the command string stays the static
        // key; the "no subprocess at startup" invariant, pinned by test).
        //
        // The slot is T1's landed placeholder position (between the `gcloud_adc`
        // and the `oauth`/`oidc` arms) and is NOT reordered (interface §4 fixes
        // the dispatch order). Because a `_`-guard matches any `auth_mode`, a row
        // that carries BOTH a `!`-key and `authMode: "oauth"` takes this arm
        // first — the recorded behaviour of the landed order (the plan's §2h
        // note describes the reverse; see the implementation report).
        _ if provider.api_key.starts_with('!') => {
            if !execute_helpers {
                None
            } else {
                match key_helper::run(&provider.api_key).await {
                    Ok(token) => Some(token),
                    Err(e) => {
                        crate::agent::debuglog::log(&format!(
                            "provider-auth: key helper failed for {}: {e}",
                            provider.id
                        ));
                        None
                    }
                }
            }
        }
        "oauth" | "oidc" => {
            // T1 implements the `oauth` arm; `oidc` shares the entry point and
            // has no stored credential type yet (T6 adds it), so it degrades to
            // the static key exactly as an absent entry does.
            //
            // The stored token is SERVED as-is: the background loop
            // (`refresh::SupervisorRefresher`) refreshes ahead of expiry with the
            // 5-minute lead, and a refresh failure must never take a working
            // bearer away (interface §1). T5/T6 may extend this arm to refresh
            // synchronously when the token is inside the lead margin.
            let loaded = store::load(auth_file);
            match loaded.providers.get(&provider.id) {
                Some(ProviderCredential::OAuth(cred)) => {
                    // The lead check is computed here so the extension point is
                    // load-bearing rather than speculative; T1 serves the
                    // stored token either way.
                    let _ = store::is_expiring_soon(cred.expires_at, store::now_epoch_millis());
                    Some(cred.access_token.clone())
                }
                // No stored credential (or one this build cannot serve) → the
                // static key as-is. Degrade, never blank.
                _ => {
                    crate::agent::debuglog::log(&format!(
                        "provider-auth: no stored credential for provider `{}` (auth mode `{}`) — \
                         serving the configured static key",
                        provider.id, provider.auth_mode
                    ));
                    None
                }
            }
        }
        // The default — the static key path (`"api_key"`, an unknown mode, or an
        // empty one: the permissive boundary validates at use, not at parse).
        _ => None,
    }
}
