/**
 * The persisted-settings commands and the catalogs the Settings page reads:
 * `get_settings` / `save_settings`, the model + tool + known-provider listings,
 * the sandbox capability probe, and the three one-shot Test/Sign-in actions.
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


/** Test ONE MCP server entry (the Settings page's Test action, ADR 0019): a one-shot bounded connect + `tools/list`. Resolves the tool count; rejects with the error text (a `needs-auth` / a network failure). */
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
