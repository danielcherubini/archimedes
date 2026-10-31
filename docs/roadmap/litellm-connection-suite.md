---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/133
done-when: All 8 subissues implemented, verified via unit/integration tests, and closed with LiteLLM parity achieved.
---

# Specification: Comprehensive LiteLLM Provider Connection & Authentication Suite

## 1. Overview & Goals

Archimedes Desktop currently supports LiteLLM proxies via a single discovery mode (`WireApi::LiteLLM` -> `GET /model/info`, ADR 0026) with static plaintext API keys and the `openai-completions` wire.

In production environments, LiteLLM proxies are frequently secured by enterprise SSO (OIDC/Okta), OAuth 2.1 PKCE with Dynamic Client Registration, Google Cloud IAM/ADC tokens, custom authentication headers, and multi-tenant proxy routing.

This specification provides full parity with `pi-provider-litellm` in Archimedes Desktop, bringing comprehensive enterprise authentication, discovery fallbacks, per-model wire negotiation, and quota tracking.

---

## 2. Architecture & Credential Storage

### 2.1 Credential Storage (`~/.archimedes/provider-auth.json`)
- Mode `0600` atomic JSON file stored alongside `mcp-auth.json` (ADR 0018).
- Keeps plaintext `settings.json` clean of sensitive refresh tokens and transient access tokens.
- Discriminated union format:
  ```json
  {
    "version": 1,
    "providers": {
      "provider-id-or-alias": {
        "type": "oauth",
        "flow": "litellm_cli_pkce",
        "access_token": "...",
        "refresh_token": "...",
        "expires_at": 1729000000000,
        "base_url": "https://llm.example.com",
        "client_id": "...",
        "token_endpoint": "https://llm.example.com/oauth/token",
        "resource": "https://llm.example.com"
      }
    }
  }
  ```

### 2.2 Supervisor Token Resolver & Worker Propagation
- The Supervisor runs a background token refresh task for expiring OAuth and ADC tokens (with 5-minute refresh lead).
- Refreshed tokens update provider model definitions and are propagated to active sessions via `refresh_live_models` / `send_config` IPC.
- The Worker receives a fresh bearer string snapshot for each turn, requiring zero OAuth or ADC logic inside the Worker process.

### 2.3 Provider Settings Extension (`settings.json`)
- Optional fields on provider config rows:
  - `auth_mode`: `"api_key" | "oauth" | "oidc" | "gcloud_adc"`
  - `headers`: `Record<string, string>` with `$VAR` and `${VAR}` environment variable expansion
  - `allow_insecure_http`: `boolean` (defaults to `false`)
  - `oidc`: `{ issuer, client_id, scope?, redirect_ports? }`

---

## 3. Subissues Specification

### Subissue 1: Credential Storage & Supervisor Token Refresh Lifecycle (Foundational)
- **Scope**:
  - Implement `provider-auth.json` reader/writer in `src-tauri/src/agent/provider/auth.rs` with atomic write semantics (`0600`).
  - Supervisor background token refresher with 5-minute lead time and transient retry backoff.
  - Integration with `refresh_live_models` to update live sessions without dropping model state.
- **Acceptance Criteria**:
  - Storage is file-mode `0600` on Unix and ACL-restricted on Windows.
  - Transient network failures do not invalidate still-valid access tokens.

### Subissue 2: OAuth 2.1 PKCE Dynamic Client Registration & CLI SSO Device Flow
- **Scope**:
  - PKCE DCR flow via `GET {base}/.well-known/litellm-cli-auth` (`contract_version: 1`, S256, same-origin endpoints).
  - Loopback server on `127.0.0.1:0` (`/callback` path) using constant-time `state` check and 10-minute timeout.
  - RFC 7591 Dynamic Client Registration `POST {registration_endpoint}`.
  - Browser launch to authorization endpoint with PKCE challenge and `resource` parameter.
  - Legacy CLI SSO fallback: `POST {base}/sso/cli/start` and polling `GET {base}/sso/cli/poll/{login_id}` every 2s with `x-litellm-cli-poll-secret`.
  - Pasted SSO token fallback with optional virtual key generation via `POST {base}/key/generate`.
- **Acceptance Criteria**:
  - Full end-to-end authentication via system browser against LiteLLM proxy.
  - Token refresh automatically executed in background before expiry.

### Subissue 3: Direct OIDC PKCE Login with External Identity Providers
- **Scope**:
  - Provider configuration `oidc: { issuer, client_id, scope, redirect_ports }`.
  - Discovery via `{issuer}/.well-known/openid-configuration` without LiteLLM proxy headers.
  - Sequential attempt of `redirect_ports` (or ephemeral port if empty) for corporate IdPs with fixed redirect URI allowlists.
  - Code exchange at IdP `token_endpoint`.
  - Claim validation of `id_token`: `iss`, `aud`, `azp`, `sub`, `exp`, `nonce`.
  - Inject `id_token` as Bearer token to LiteLLM proxy; refresh via IdP refresh token.
- **Acceptance Criteria**:
  - External IdPs (Okta, Keycloak, Entra ID) work out of the box with LiteLLM JWT authentication.
  - Validated claims prevent session account swapping on refresh (`sub` consistency).

### Subissue 4: Google Application Default Credentials (ADC) Token Support
- **Scope**:
  - Enable via `use_gcloud_token_auth` setting or `LITELLM_GCLOUD_TOKEN_AUTH` env var.
  - Locate ADC file: `GOOGLE_APPLICATION_CREDENTIALS`, `~/.config/gcloud/application_default_credentials.json`, `%APPDATA%\gcloud\application_default_credentials.json`.
  - Validate `type: "authorized_user"` (`client_id`, `client_secret`, `refresh_token`). Explicitly reject `service_account` with clean warning.
  - Pure native Rust token exchange: `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`.
  - In-memory cache valid for 50 minutes.
- **Acceptance Criteria**:
  - Zero external `gcloud` CLI dependency.
  - Automatically refreshes Google OAuth access token every 50 minutes.

### Subissue 5: Key Helper Command Execution (`!command`) & Custom Header Templates
- **Scope**:
  - If `api_key` starts with `!`: execute via `tokio::process::Command` without shell, 10s timeout, sanitizing metacharacters.
  - Skip helper execution during initial background seeding (`execute_helpers = false`).
  - Resolve `$VAR` and `${VAR}` in custom `headers` map.
  - Enforce HTTPS for non-loopback URLs unless `allow_insecure_http: true`.
- **Acceptance Criteria**:
  - Arbitrary token generators (Vault CLI, customized tools) execute safely.
  - Gateway headers (Cloudflare Access, enterprise proxies) pass through cleanly.

### Subissue 6: Discovery Fallbacks (/v1/models) & Multi-Deployment Grouping Reduction
- **Scope**:
  - Fallback ladder: On 401/403/404 or empty `data: []` from `GET /model/info`, fall back to `GET /v1/models`, then `GET /health`.
  - Group deployments by `model_name`: conservative reduction (`min` context window, `min` max output tokens, `max` cost).
  - Require all deployments in a route to support reasoning before exposing thinking controls.
  - Expand wildcard routes (`x/*`) via `/v1/models`.
- **Acceptance Criteria**:
  - Non-admin keys without `/model/info` access discover models via `/v1/models`.
  - Multi-deployment routes never overestimate context window.

### Subissue 7: Dynamic Per-Model Wire Protocol Selection (Anthropic Messages & OpenAI Responses)
- **Scope**:
  - Refine ADR 0026 to assign per-model `WireApi`:
    - `openai-responses` when mode is `responses` or `/v1/responses` listed.
    - `anthropic-messages` when deployment routes through Claude adapter (`anthropic`, `bedrock`, `vertex_ai`) and `/v1/messages` is available.
    - `openai-completions` as fallback.
  - Base URL normalization: root for Messages (`/v1`), `{root}/v1` for Completions and Responses.
  - Vendor quirks: suppress `reasoning_effort` with tools on GPT-5.5+ over Chat Completions; Anthropic prompt caching headers for Claude models.
- **Acceptance Criteria**:
  - Claude models routed through LiteLLM receive native thinking blocks and prompt caching.
  - Responses models stream via Responses SSE wire.

### Subissue 8: Multi-Level Budget & Quota Tracking
- **Scope**:
  - Poll `GET /key/info`, `GET /v2/user/info`, `GET /team/info?team_id=...`.
  - Denial memory: remember 4xx (except 429) and 500 status codes per endpoint.
  - Expose spend / max budget in Provider settings and status indicators.
- **Acceptance Criteria**:
  - Users see active spend / remaining budget without log spam from unauthorized endpoints.

---

## 4. Implementation Dependency Order

1. **Subissue 1 (#125)**: [Credential Storage & Supervisor Token Refresh Lifecycle](https://github.com/danielcherubini/archimedes/issues/125) (Foundation)
2. **Subissue 5 (#129)**: [Key Helper Command Execution & Custom Header Templates](https://github.com/danielcherubini/archimedes/issues/129) (Independent)
3. **Subissue 6 (#130)**: [Discovery Fallbacks (/v1/models) & Multi-Deployment Grouping Reduction](https://github.com/danielcherubini/archimedes/issues/130) (Independent)
4. **Subissue 4 (#128)**: [Google ADC Token Support](https://github.com/danielcherubini/archimedes/issues/128) (Depends on #125)
5. **Subissue 2 (#126)**: [OAuth 2.1 PKCE Dynamic Client Registration & CLI SSO Flow](https://github.com/danielcherubini/archimedes/issues/126) (Depends on #125)
6. **Subissue 3 (#127)**: [Direct OIDC PKCE Login with External Identity Providers](https://github.com/danielcherubini/archimedes/issues/127) (Depends on #125)
7. **Subissue 7 (#131)**: [Dynamic Per-Model Wire Protocol Selection](https://github.com/danielcherubini/archimedes/issues/131) (Depends on #130)
8. **Subissue 8 (#132)**: [Multi-Level Budget & Quota Tracking](https://github.com/danielcherubini/archimedes/issues/132) (Depends on #125)
