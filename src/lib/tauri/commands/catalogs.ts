/**
 * The per-Space CATALOG commands: the fetchers that are handed to the ONE shared
 * row-cache machine (`useSkillCatalog`, `useAgentCatalog`,
 * `useMentionCatalogs` — all through `useCatalogRow`), plus the Agent-definition
 * report that shares their Space-scoping contract.
 *
 * This grouping is Phase C's, measured, not the improvement report's: the report
 * filed all six under `spaces`, but they have nothing in common with Space
 * BOOKKEEPING (`./spaces.ts` — a row, a trusted flag, a delete) and everything in
 * common with each other: one cache, one eviction contract, and one
 * "`spacePath`/`cwd` is `null` for user scope" rule that every command here
 * repeats and no command there has.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentDefinitionDto,
  AgentDefinitionReportDto,
  CompletionDirDto,
  ListingDto,
  McpServerInfo,
  SkillInfo,
} from "../types";


/** The skill catalog for a Space (`null` = user-level skills only).
 *
 * The command is infallible by construction (discovery is total — a missing
 * root / unreadable file is skipped); the `Err` arm it still carries in its
 * Rust signature is the phantom task14c retires, so treat any rejection here
 * as unreachable and keep the caller's degrade (never render it as prose). */
export async function listSkills(spacePath: string | null): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("list_skills", { spacePath: spacePath ?? null });
}


/** The agent-definition catalog for a Space (`null` = user-level only). */
export async function listAgentDefinitionsForSpace(spacePath: string | null): Promise<AgentDefinitionDto[]> {
  return invoke<AgentDefinitionDto[]>("list_agent_definitions_for_space", { cwd: spacePath ?? null });
}


/** The Agent-definition report for the Space's definitions — the sidebar Agents modal's data source (ADR 0068). `cwd: null` = app-scope (user-level definitions only; the override map is global and unaffected). */
export async function listAgentDefinitionReports(
  cwd: string | null,
): Promise<AgentDefinitionReportDto[]> {
  return invoke<AgentDefinitionReportDto[]>("list_agent_definition_reports", {
    cwd: cwd ?? null,
  });
}


/** The effective MCP servers for a Space (`null` = user-level only). */
export async function listMcpServersEffective(spacePath: string | null): Promise<McpServerInfo[]> {
  return invoke<McpServerInfo[]>("list_mcp_servers_effective", { cwd: spacePath ?? null });
}


/**
 * The Listing a Space offers the `?` path completion (ADR 0033 — a
 * PATH is inserted, never the contents). `null` = no Space: the Rust
 * command degrades to the empty Listing rather than erroring. A rejection (the
 * Rust signature's `Err` arm is a phantom task14c retypes) arrives as the
 * `FilesError` envelope (`{kind, message}` — ADR 0063; `FilesErrorKind` in
 * `@/lib/errors` mirrors the frozen kinds).
 */
export async function listSpaceListing(spacePath: string | null): Promise<ListingDto> {
  return invoke<ListingDto>("list_space_listing", { spacePath: spacePath ?? null });
}


/**
 * The out-of-Space `?` rows for ONE directory (ADR 0035 — a `~/-`- or
 * drive-rooted token), never a walk. `null` = no out-of-Space token open.
 *
 * `null` is PASSED THROUGH as `{ query: null }`, exactly as `listSpaceListing`
 * passes `spacePath: null` (pinned in `src/lib/tauri.test.ts`), and the command
 * never rejects — it degrades to the empty listing. Do NOT add a client-side
 * short-circuit: the Rust `None` arm already touches no filesystem at all, and a
 * short-circuit here would move that guarantee out of the one place a Rust test
 * can see it, for no gain. (The `Err` arm in the Rust signature is a phantom
 * task14c retypes; it would arrive as the `FilesError` envelope, like
 * `listSpaceListing`.)
 */
export async function listCompletionEntries(
  query: string | null,
): Promise<CompletionDirDto> {
  return invoke<CompletionDirDto>("list_completion_entries", {
    query: query ?? null,
  });
}
