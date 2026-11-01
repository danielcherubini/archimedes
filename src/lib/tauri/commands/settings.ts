/**
 * The persisted-settings commands and the catalogs the Settings page reads:
 * `get_settings` / `save_settings`, the model + tool + known-provider listings,
 * the sandbox capability probe, the three one-shot Test/Sign-in actions, and the
 * provider-auth suite of the LiteLLM connection work (#126 / #127 / #132): the
 * five interactive-login commands (`provider_login_oauth`,
 * `provider_login_oidc`, `provider_login_sso_poll`,
 * `provider_login_sso_choose_team`, `provider_login_paste_token`) and the
 * spend/budget read (`get_provider_budget`).
 *
 * `AppSettings` itself lives in `../types.ts` — it is a wire shape shared with
 * `test_search_provider`, not a private of this module.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  KnownProvider,
  McpServerEntry,
  ModelDto,
  ProviderBudgetDto,
  ProviderLoginStep,
  ProviderOidcConfig,
} from "../types";


export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}


export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke("save_settings", { settings });
}


/** The effective catalog's models (the Default-model select + provider discovery status). `forceRefresh` = a provider id whose discovery cache is bypassed. */
export async function listModels(forceRefresh?: string): Promise<ModelDto[]> {
  return invoke("list_models", { forceRefresh: forceRefresh ?? null });
}


/** The native harness's tool names, sorted (the Settings page's enabled-tools checkbox list). */
export async function listTools(): Promise<string[]> {
  return invoke<string[]>("list_tools");
}


/** The known-providers catalog (the Settings' picker's data source — ADR 0024). */
export async function listKnownProviders(): Promise<KnownProvider[]> {
  return invoke<KnownProvider[]>("list_known_providers");
}


/**
 * (ADR 0030) Whether a `Sandboxed` shell can actually be confined HERE:
 * Linux + a kernel that enforces Landlock. `false` means every confined
 * command FAILS CLOSED, so the Settings page greys the tier out and says
 * why (it is the same signal the executor checks — the UI can never offer
 * a choice that only produces errors).
 */
export async function shellSandboxAvailable(): Promise<boolean> {
  return invoke<boolean>("shell_sandbox_available");
}


/** Test ONE MCP server entry (the Settings page's Test action, ADR 0019): a one-shot bounded connect + `tools/list`. Resolves the tool count; rejects with the `SettingsError` envelope (`{kind, message}` — ADR 0063) whose `message` is the sentence: `MCP server test failed: needs-auth` for a 401-on-OAuth server, or the network failure's sentence. `kind` is `mcp_test_failed` for EVERY test failure — the auth case carries no machine discriminator of its own today (see `McpTestErrorKind` in `@/lib/errors` and the parked red in `McpSection.test.tsx`). */
export async function testMcpServer(entry: McpServerEntry, name?: string): Promise<number> {
  return invoke("test_mcp_server", { name: name ?? null, entry });
}


/** Run interactive OAuth authentication for an MCP server (the Settings page's Sign in action). */
export async function authMcpServer(name: string, entry: McpServerEntry): Promise<string> {
  return invoke("auth_mcp_server", { name, entry });
}


/** Test ONE Search provider (Settings → Web search): one canned query, reporting the hit count or error. */
export async function testSearchProvider(provider: string, settings: AppSettings): Promise<number> {
  return invoke("test_search_provider", { provider, settings });
}


// ---------------------------------------------------------------------------
// Provider auth + budget (the LiteLLM connection suite, #126 / #127 / #132)
// ---------------------------------------------------------------------------

/**
 * Start the OAuth 2.1 PKCE / CLI-SSO device flow for a provider (T5,
 * `provider_login_oauth`).
 *
 * BLOCKS until the browser callback completes (up to 10 minutes) — the
 * `authMcpServer` shape, which the row's "signing in…" badge already assumes.
 * Resolves `authenticated`, or the `devicePending` step whose `userCode` /
 * `verificationUrl` the row shows while the UI polls `providerLoginSsoPoll`
 * every 2 s (a `devicePending` only happens when the flow FALLS BACK to the
 * legacy CLI-SSO device flow — no OAuth discovery document, or DCR
 * unavailable). Rejects with the `SettingsError` envelope (ADR 0063).
 *
 * Args are camelCase here; Tauri maps them to the Rust `provider_id` /
 * `base_url` parameters.
 */
export async function providerLoginOauth(
  providerId: string,
  baseUrl: string,
): Promise<ProviderLoginStep> {
  return invoke("provider_login_oauth", { providerId, baseUrl });
}

/**
 * Run the direct OIDC PKCE login (T6, `provider_login_oidc`).
 *
 * `config` is the row's `oidc` object VERBATIM (`{ issuer, clientId?, scope?,
 * redirectPorts? }`) — the flow runs against the exact values the user is
 * looking at, never a re-read of the saved document (a load-patch-save would
 * round-trip a stale copy). BLOCKS until the browser callback completes.
 *
 * NOTE the return type: this command's `Ok` is the `"{providerId}:
 * authenticated"` STRING, NOT the `ProviderLoginStep` DTO its siblings return —
 * the caller renders the authenticated state from the string. An
 * `oidc_auth_failed` rejection's message carries the authorize URL for manual
 * completion (ADR 0018).
 */
export async function providerLoginOidc(
  providerId: string,
  config: ProviderOidcConfig,
): Promise<string> {
  return invoke("provider_login_oidc", { providerId, config });
}

/**
 * The poll step of a pending CLI-SSO device flow (T5,
 * `provider_login_sso_poll`) — called every 2 s (`cli_sso::SSO_POLL_INTERVAL`)
 * while the step is `devicePending`, round-tripping `loginId` + `pollSecret`
 * from that step. `teamId` is `null` on the first poll; a `chooseTeam` response
 * means the flow needs a team choice.
 *
 * A REJECTION is the terminal signal — there is no `expired` step variant on
 * the wire. Specifically `"the CLI SSO session has expired or does not exist
 * (HTTP 400) — restart the login"` means the UI must stop polling and offer a
 * fresh login.
 */
export async function providerLoginSsoPoll(
  providerId: string,
  loginId: string,
  pollSecret: string,
  baseUrl: string,
  teamId?: string,
): Promise<ProviderLoginStep> {
  return invoke("provider_login_sso_poll", {
    providerId,
    loginId,
    pollSecret,
    baseUrl,
    teamId: teamId ?? null,
  });
}

/**
 * The interactive team choice (T5, `provider_login_sso_choose_team`): ONE
 * re-poll with `?team_id=<id>` — the verified wire. Every argument comes from
 * the `chooseTeam` step plus the chosen row's `teamId`.
 */
export async function providerLoginSsoChooseTeam(
  providerId: string,
  loginId: string,
  pollSecret: string,
  baseUrl: string,
  teamId: string,
): Promise<ProviderLoginStep> {
  return invoke("provider_login_sso_choose_team", {
    providerId,
    loginId,
    pollSecret,
    baseUrl,
    teamId,
  });
}

/**
 * T5's pasted-token fallback (`provider_login_paste_token`): store an SSO token
 * the user pasted from `{base}/sso/key/generate`.
 *
 * With `mintVirtualKey: true` the backend FIRST `POST`s `{base}/key/generate`
 * with an EMPTY `{}` body and stores the minted key; ANY mint failure degrades
 * to storing the pasted token (a virtual-key generation failure never fails
 * the paste). Resolves the `authenticated` step. The token is a CREDENTIAL: it
 * lands in T1's `provider-auth.json` store, NEVER in the settings document.
 */
export async function providerLoginPasteToken(
  providerId: string,
  baseUrl: string,
  token: string,
  mintVirtualKey: boolean,
): Promise<ProviderLoginStep> {
  return invoke("provider_login_paste_token", {
    providerId,
    baseUrl,
    token,
    mintVirtualKey,
  });
}

/**
 * The spend/budget read (T7, `get_provider_budget`).
 *
 * Returns EVERY provider's rows in ONE call (`ProviderBudgetDto[]`) — NOT one
 * provider's nullable figure — so the caller selects by `providerId`. An
 * absent ledger (no poller managed) answers `[]`: the empty answer IS the
 * degrade.
 *
 * `forceRefresh` is NOT a boolean: it carries a PROVIDER ID. When present the
 * backend runs ONE bounded `run_budget_tick` for THAT provider and then returns
 * the whole ledger, so the UI passes the id string when a fresh figure is
 * wanted and NEVER `"true"` (the parameter name is a carried-over smell from
 * `listModels(forceRefresh)`, not a flag). Omit it for a plain read.
 */
export async function getProviderBudget(
  forceRefresh?: string,
): Promise<ProviderBudgetDto[]> {
  return invoke("get_provider_budget", { forceRefresh: forceRefresh ?? null });
}
