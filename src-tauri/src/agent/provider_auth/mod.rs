//! Supervisor-side provider credentials: the `provider-auth.json` store, the
//! bearer-resolution dispatcher, and the background refresher. Deliberately
//! NOT under `agent/harness/provider/` (the wire clients — ADR 0024).
//!
//! The token's destination is `Model.api_key` (interface §1):
//! `EffectiveCatalog::resolve` is the single substitution site, so the Worker
//! never learns about OAuth/ADC/OIDC — it holds a pushed snapshot string.
//! Wiring `resolve_bearer` into `resolve` is T2/T4's seam; this module owns
//! the resolution, the store and the refresh lifecycle.

pub mod headers;
pub mod key_helper;
pub mod refresh;
pub mod store;

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
    // Keep the interface's parameters named for the arms that do not use them
    // yet (the dispatcher is async and takes the shared client; T5/T6 will use
    // it for a synchronous refresh before serving an expiring token).
    let _ = client;
    // The dispatch ORDER is FIXED by interface §4 — earlier arms must not be
    // reordered, so a placeholder occupies its exact position.
    match provider.auth_mode.as_str() {
        // EXTENSION POINT — T4: `"gcloud_adc"` → `gcloud::token(config_dir, …)`.
        // Reaching `None` here means "serve the row's static key", which is the
        // documented degradation until that arm exists (interface §1: a failure
        // degrades, it never blanks).
        "gcloud_adc" => {
            let _ = (config_dir, execute_helpers);
            None
        }
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
