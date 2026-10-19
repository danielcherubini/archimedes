---
status: committed
issue: 60
done-when: ADR 0063 IPC error envelopes implemented across settings/spaces/mcp/agents commands, bare `Prompt` renamed to `PromptTurn` in harness/worker, common web search provider utilities extracted to `providers/common.rs`, and all quality gates pass cleanly.
---

# Codebase Improvement Phase C — ADR 0063 IPC Errors, PromptTurn Disambiguation & Web Provider Deduplication

**Goal:** Harmonize remaining Tauri IPC command error envelopes with ADR 0063, disambiguate domain terminology for user turn submissions (`PromptTurn`), and deduplicate common web search provider utilities.
**Architecture:**
- **Finding 7 (IPC Errors):** Add typed domain errors (`SettingsError`, `SpacesError`, `McpError`, `AgentsError`) in `src-tauri/src/agent/errors.rs` implementing `From<...Error> for tauri::ipc::InvokeError` with `{ kind, message }` JSON envelope per ADR 0063.
- **Finding 8 (PromptTurn):** Disambiguate `struct Prompt` in `harness/loop.rs` to `struct PromptTurn` to conform to `CONTEXT.md` terminology rules avoiding bare "prompt".
- **Finding 9 (Web Providers Common):** Extract reusable HTTP client helpers, snippet cleaning, and error mappings across search providers into `src-tauri/src/agent/web/providers/common.rs`.
**Execution:** All 3 tasks have strictly disjoint file boundaries and execute concurrently in a single parallel wave.

---

### Task 1: Harmonize Remaining IPC Command Errors with ADR 0063
- Modify: `src-tauri/src/agent/errors.rs`
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/src/commands/spaces.rs`
- Modify: `src-tauri/src/commands/mcp.rs`
- Modify: `src-tauri/src/commands/agents.rs`

### Task 2: Disambiguate Bare `Prompt` Struct into `PromptTurn`
- Modify: `src-tauri/src/agent/harness/loop.rs`
- Modify: `src-tauri/src/agent/harness/mod.rs`
- Modify: `src-tauri/src/agent/harness/loop/turn.rs`
- Modify: `src-tauri/src/agent/worker/core.rs`
- Modify: `src-tauri/src/agent/worker/client.rs`

### Task 3: Extract Common Web Search Provider Utilities
- Create: `src-tauri/src/agent/web/providers/common.rs`
- Modify: `src-tauri/src/agent/web/providers/mod.rs`
- Modify: `src-tauri/src/agent/web/providers/brave.rs`
- Modify: `src-tauri/src/agent/web/providers/duckduckgo.rs`
- Modify: `src-tauri/src/agent/web/providers/perplexity.rs`
- Modify: `src-tauri/src/agent/web/providers/searxng.rs`
- Modify: `src-tauri/src/agent/web/providers/tavily.rs`
