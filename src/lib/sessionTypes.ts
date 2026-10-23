/**
 * The **Session** transcript's data types — the shape one conversation row
 * takes in memory, and therefore the shape every transcript consumer reads.
 *
 * These live here and NOT in `store/sessions.ts` (they used to be defined
 * there) because the store is not their owner: `lib/transcript/reducer.ts`
 * builds `Message`s, and `lib/sessionTitle.ts`, `lib/sessionActivity.ts`,
 * `lib/sessionTime.ts`, `lib/toolGroups.ts`, `lib/toolOutput.ts`,
 * `lib/transcript/identity.ts` and `lib/transcript/unitKeys.ts` all read them.
 * Having a `lib/` module import a transcript type from the store that imports
 * its own reducer is a cycle kept safe only by the fact that a type import is
 * erased at runtime. `tsconfig.json` now sets `verbatimModuleSyntax`, so those
 * edges are at least provably type-only — but a shared vocabulary type belongs
 * at the bottom of the dependency graph, not at the top.
 *
 * The store still re-exports all three (`store/sessions.ts`), so the component
 * layer keeps importing them from where it always has; only the `lib/`
 * consumers moved here. Nothing in this file may import a store.
 */
import type { ImageRef } from "./chatAttachments";

/** A **Tool Call**'s status as the UI knows it (the ACP status, mapped). */
export type ToolCallUiStatus = "pending" | "completed" | "failed";

/** One file **Diff** attached to a **Tool Call**. */
export interface DiffRef {
  path: string;
  patch: string;
}

/** One row of a **Session**'s transcript, in render order. */
export type Message =
  | { kind: "user"; text: string; at: number; images?: ImageRef[] }
  | { kind: "agent-text"; messageId: string; text: string; at: number }
  | { kind: "agent-thought"; messageId: string; text: string; at: number }
  | {
      kind: "tool-call";
      id: string;
      title: string;
      status: ToolCallUiStatus;
      diff?: DiffRef;
      /** The ACP `rawInput` (the tool's raw input). */
      rawInput?: unknown;
      /** The ACP rawOutput (the tool's result — the RPC AgentToolResult, live-partial while running). */
      rawOutput?: unknown;
      at: number;
    }
  | { kind: "diff"; path: string; patch: string; at: number };
