---
status: accepted
date: 2026-10-06
superseded-by:
---

# Multi-wire model providers (Anthropic + OpenAI Responses) and a known-providers picker

The native harness spoke **OpenAI-compatible chat-completions only** (ADR 0012's "v1 is OpenAI-compatible only") and every user provider was ASSUMED OpenAI-compatible (ADR 0014). We decided: the harness speaks **three wire APIs** — `openai-completions` (the existing `OpenAiCompatibleProvider`), `anthropic-messages` (a new `AnthropicProvider`), and `openai-responses` (a new `OpenAiResponsesProvider`) — selected per model via the `Model.api` discriminator the catalog already carried, and the Settings' **Providers section gains a known-providers picker**: a built-in catalog of provider templates (name, base URL, wire API, key-management URL) the user can add as a **pre-filled provider row** with one click (the user still pastes the API key).

**Why:** the desktop's only model source is the user's provider list (ADR 0014), and adding a provider meant hand-typing a base URL — error-prone, and a dead end for the large providers whose best endpoints are NOT OpenAI-compatible (Anthropic, xAI, OpenRouter, the Chinese GLM/Kimi/MiniMax/DeepSeek/Bailian endpoints). The templates are seeded from the ZCode builtin provider catalog (`config/provider/zcode-builtin.json` — 20 user-facing templates). The picker does NOT bypass ADR 0014: a picked template becomes a normal `settings.json` provider row (the user's list remains the sole model source; the base catalog stays empty).

**Considered Options**

- **Pre-seed the provider list on first run** (every known provider as a keyless row): rejected — a keyless row whose endpoint needs a key shows `unreachable` / 0 models; the first-run screen would be a wall of failed rows. Opt-in per provider keeps the list the user actually uses.
- **Seed the base catalog with static models**: rejected — contradicts ADR 0014's "the user list is the sole model source" (the base catalog is empty by design) and the base catalog has no key storage, so the user would still add a provider row for the key — the static models would be dead weight.
- **A frontend-only known-providers constant** (no Rust involvement): rejected — the wire API is a harness concern (the `Provider` factory dispatches on `Model.api`), and the picker's pre-fill value (`api`) must match the harness's vocabulary; a Rust-owned catalog with a Tauri command keeps one source of truth.
- **Port the `anthropic-messages` wire from ZCode's TS adapters**: rejected — ZCode's adapters are a Vercel-AI-SDK TS stack; the harness is Rust and already owns its SSE parsing. The wire contracts are re-implemented natively (the `Provider` trait seam exists for exactly this, ADR 0012's "a second provider (Anthropic) can be added later without touching the loop").
- **One generic "adapter" with a protocol table**: rejected — the three wires differ structurally (Anthropic's `event:`-tagged SSE + `system`-as-top-level-param + alternating-role messages; Responses' `input`/`instructions` + `output` items) more than a table can express; three small, well-tested providers beat one giant switch.

**Consequences**

- **`ProviderConfig` gains `api`** (`"openai-completions"` (default) / `"anthropic-messages"` / `"openai-responses"`) + an optional `keyUrl` (set by the picker; a "Get key" link in the row). `#[serde(default)]` — a pre-feature `settings.json` parses to the OpenAI-compatible default (no migration). Discovered models carry the provider's `api` (no longer hard-coded `openai-completions`).
- **The selectable set generalizes** — `ModelCatalog::openai_compatible()` becomes `selectable()`: `supports_tools` + `api` ∈ the three supported wires (a `None`/unknown `api` stays unselectable, as before).
- **`ProviderFactory` dispatches on `Model.api`** (the `AgentLoop` is untouched — the seam ADR 0012 designed for).
- **Discovery is per-wire** — `openai-completions` / `openai-responses` keep the OpenAI `GET {base}/models` shape; `anthropic-messages` uses Anthropic's `GET {base}/models` (an id-only list — a discovered Anthropic model gets the `DEFAULT_CONTEXT_WINDOW` fallback and advertises no thinking levels; v1 does not fetch per-model metadata from Anthropic).
- **Thinking levels map per-wire** — `openai-completions` passes `reasoning_effort` through (today's behavior); `openai-responses` sends `reasoning: { effort }`; `anthropic-messages` maps the desktop's level vocabulary to a `thinking` budget (`low` 4096 / `medium` 10000 / `high` 20000 / `xhigh` 40000 / `max` 128000; an unrecognized level → `adaptive`), and the request's `max_tokens` is clamped above the budget (Anthropic requires `max_tokens` — a `None` option defaults to 32768).
- **The known-providers catalog is a Rust constant** (20 ZCode templates) exposed via a stateless `list_known_providers` command (the `list_tools` pattern); the picker pre-fills `name` / `baseUrl` / `api` / `keyUrl` and an empty key.
- **A user provider's models are NO LONGER assumed OpenAI-compatible** (ADR 0014's consequence updated) — the provider row's `api` decides the wire.

## Amendment (2026-10-29) — model and provider are a pair; AgentLoop rebuilds provider on model switch (#120)

**AMENDED 2026-10-29 — the claim that `AgentLoop` is untouched is contradicted and overtaken by #120.** What stands unchanged: the three wire APIs (`openai-completions`, `anthropic-messages`, `openai-responses`), the known-providers picker and its pre-filled rows, discovery per wire, thinking-level mappings, and ADR 0014's sole-model-source ruling. This ADR is NOT superseded and its `status` is unchanged. The sentence above in Consequences — **`- **`ProviderFactory` dispatches on `Model.api`** (the `AgentLoop` is untouched — the seam ADR 0012 designed for).`** — is deliberately left standing exactly as written, preserving the original design intent. The correction is recorded here.

**What changed.** `AgentLoop` is touched now: `model` and `provider` are an invariant pair (`src-tauri/src/agent/harness/loop.rs:144-149`), built together at spawn (`src-tauri/src/agent/worker/core.rs:286-287`). Any code that replaces the model must rebuild the provider from that same `Model` (`set_model`, `src-tauri/src/agent/harness/loop.rs:461`). When mid-session model switching was added, `AgentLoop` was modified to update `self.model` without rebuilding `self.provider`, silently preserving the previous provider instance across a switch to a different model (issue #120).

**Why rebuild is keyed on the composed key rather than unconditional.** A live model switch changes the composed `"<provider>/<id>"` key, requiring a fresh provider instance built for that model. However, the rebuild must NOT run unconditionally on every model update: `refresh_live_models` pushes same-key metadata-only updates (`src-tauri/src/agent/session/mod.rs:1849-1863`) to update `context_window` and thinking levels without altering endpoint credentials. Unconditionally recreating the provider on metadata pushes would reset per-instance state, such as `accepts_stream_options` (`src-tauri/src/agent/harness/provider/openai.rs:39`), which latches after discovering a proxy rejects `stream_options`.

**ADR 0014's sole-model-source ruling stands intact.** The Settings list remains the sole model source (ADR 0014:23 — "The desktop has ONE model source — the Settings list"). The provider instance in `AgentLoop` is a view of a user's Settings provider rebuilt from the catalog's `Model` — never an independent per-session provider and never a second model source.

