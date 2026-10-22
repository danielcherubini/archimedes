import type { Message } from "./sessionTypes";
import type { SubagentFailureReason } from "./tauri";
import { formatDuration, summarizeToolCall } from "./toolOutput";

/**
 * The pure derivations behind the `subagent` tool's card (the "Delegating"
 * card), moved VERBATIM out of `SubagentDelegatingCard.tsx` so they can be
 * unit-tested without rendering it.
 *
 * Nothing here touches a store, a hook, or JSX: `extractTargetInfo` reads the
 * tool call's `rawInput` / `rawOutput` envelopes, `estimateTokensFromMessages`
 * measures a transcript, and `getActivityDisplay` turns one row into the card's
 * third line. The card keeps the row-derivation code that feeds them.
 */

export interface RawInputTaskItem {
  task?: string;
  agent?: string;
  model?: string;
  thinking?: string;
}

export interface RawProgressItem {
  agent?: string;
  task?: string;
  status?: "running" | "completed" | "failed";
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  error?: string;
  model?: string;
  output?: string;
  recentOutput?: string[];
  toolCalls?: Array<{ name?: string; argsPreview?: string; error?: boolean } | string>;
  percent?: number;
  contextPercent?: number;
}

export interface RawResultItem {
  agent?: string;
  task?: string;
  childSessionId?: string;
  exitCode?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    turns?: number;
  };
  model?: string;
  finalOutput?: string;
  error?: string;
  progressSummary?: { toolCount?: number; tokens?: number; durationMs?: number };
}

export function extractTargetInfo(rawInput: unknown, rawOutput: unknown): {
  targetTasks: string[];
  targetSessionIds: string[];
  inputItems: RawInputTaskItem[];
  progressList: RawProgressItem[];
  resultsList: RawResultItem[];
  details: Record<string, unknown> | undefined;
} {
  const targetTasks: string[] = [];
  const targetSessionIds: string[] = [];
  const inputItems: RawInputTaskItem[] = [];

  if (typeof rawInput === "object" && rawInput !== null) {
    const input = rawInput as Record<string, unknown>;
    if (typeof input.task === "string" && input.task) {
      targetTasks.push(input.task);
      inputItems.push({
        task: input.task,
        agent: typeof input.agent === "string" ? input.agent : undefined,
        model: typeof input.model === "string" ? input.model : undefined,
        thinking: typeof input.thinking === "string" ? input.thinking : undefined,
      });
    }
    if (Array.isArray(input.tasks)) {
      for (const t of input.tasks) {
        if (typeof t === "string" && t) {
          targetTasks.push(t);
          inputItems.push({ task: t });
        } else if (typeof t === "object" && t !== null) {
          const obj = t as Record<string, unknown>;
          if (typeof obj.task === "string" && obj.task) {
            targetTasks.push(obj.task);
            inputItems.push({
              task: obj.task,
              agent: typeof obj.agent === "string" ? obj.agent : undefined,
              model: typeof obj.model === "string" ? obj.model : undefined,
              thinking: typeof obj.thinking === "string" ? obj.thinking : undefined,
            });
          }
        }
      }
    }
  }

  const output = rawOutput as Record<string, unknown> | undefined;
  const details = output?.details as Record<string, unknown> | undefined;
  const progressList: RawProgressItem[] = Array.isArray(details?.progress)
    ? (details!.progress as RawProgressItem[])
    : [];
  const resultsList: RawResultItem[] = Array.isArray(details?.results)
    ? (details!.results as RawResultItem[])
    : [];

  for (const p of progressList) {
    if (p && typeof p.task === "string" && p.task) {
      targetTasks.push(p.task);
    }
  }

  for (const r of resultsList) {
    if (r) {
      if (typeof r.task === "string" && r.task) targetTasks.push(r.task);
      if (typeof r.childSessionId === "string" && r.childSessionId) {
        targetSessionIds.push(r.childSessionId);
      }
    }
  }

  return {
    targetTasks: Array.from(new Set(targetTasks)),
    targetSessionIds: Array.from(new Set(targetSessionIds)),
    inputItems,
    progressList,
    resultsList,
    details,
  };
}

export function estimateTokensFromMessages(messages: Message[]): number {
  let totalChars = 0;
  for (const m of messages) {
    if (m.kind === "user" || m.kind === "agent-text" || m.kind === "agent-thought") {
      totalChars += m.text.length;
    } else if (m.kind === "tool-call") {
      if (typeof m.rawInput === "string") totalChars += m.rawInput.length;
      else if (typeof m.rawInput === "object" && m.rawInput !== null) {
        totalChars += JSON.stringify(m.rawInput).length;
      }
      if (typeof m.rawOutput === "string") totalChars += m.rawOutput.length;
      else if (typeof m.rawOutput === "object" && m.rawOutput !== null) {
        totalChars += JSON.stringify(m.rawOutput).length;
      }
    } else if (m.kind === "diff") {
      totalChars += m.patch.length;
    }
  }
  return Math.round(totalChars / 4);
}

export interface ActivityInfo {
  glyph?: string;
  text: string;
  duration?: string;
  colorClass: string;
}

/**
 * The row shape `getActivityDisplay` reads. 5 fields — the card builds one per
 * delegated Subagent and passes the whole row in (it carries more, but only
 * these five are read here). Exported so the card's two row derivations can type
 * against it instead of repeating the inline literal.
 */
export interface ActivityRow {
  status: "running" | "completed" | "failed";
  error?: string;
  reason?: SubagentFailureReason;
  progress?: RawProgressItem;
  result?: RawResultItem;
}

/**
 * The card's short line for a **Dead / crashed / cancelled Subagent session**
 * (ADR 0055): a label per `SubagentFailureReason`, keyed to the four values the
 * Rust enum serialises to.
 *
 * It exists because `error` is NOT a display string: every failure path carries
 * SALVAGE prose addressed to the PARENT model ("subagent worker exited
 * unexpectedly (code 137)", "unresponsive"), and this row is one truncated line in
 * a compact list — the prose is unreadable there and duplicates what the
 * parent's own tool result already says. The code is data, so nothing here
 * string-matches `error`.
 */
export const FAILURE_LABELS: Record<SubagentFailureReason, string> = {
  unresponsive: "Unresponsive — no output for a long period",
  crashed: "Crashed",
  cancelled: "Cancelled",
  other: "Failed",
};

export function getActivityDisplay(
  row: ActivityRow,
  sessionMessages: Message[] | undefined,
  now: number,
): ActivityInfo | undefined {
  // The short reason line (ADR 0055), and ONLY when there is something to say.
  // `error` is the FALLBACK, not the primary: a payload from a backend that
  // predates `reason` (or a `progress`/`result` row that never carried it) still
  // shows why. Note the order — `reason` first, so the code wins over prose
  // whenever both exist; `error` second, so a failed row with neither is not
  // silently swallowed and falls through to the `status === "failed"` arm.
  if (row.error || row.reason) {
    const text = (row.reason && FAILURE_LABELS[row.reason]) || row.error;
    if (text) {
      return { glyph: "✗", text, colorClass: "text-destructive" };
    }
  }
  if (row.status === "completed") {
    return { glyph: "✓", text: "Done", colorClass: "text-success" };
  }
  if (row.status === "failed") {
    return { glyph: "✗", text: "Failed", colorClass: "text-destructive" };
  }

  // 1. Check live subagent transcript messages if available
  if (sessionMessages && sessionMessages.length > 0) {
    // In-flight running tool call
    const inFlightTool = sessionMessages.find(
      (m): m is Extract<Message, { kind: "tool-call" }> =>
        m.kind === "tool-call" && (m.status === "pending" || (m.status as string) === "running"),
    );
    if (inFlightTool) {
      const summary = summarizeToolCall(inFlightTool.title, inFlightTool.rawInput);
      const dur = inFlightTool.at ? ` · ${formatDuration(now - inFlightTool.at)}` : "";
      return {
        glyph: "▸",
        text: `${inFlightTool.title}${summary ? `: ${summary}` : ""}`,
        duration: dur,
        colorClass: "text-foreground-subtle",
      };
    }

    // Most recent transcript action
    const lastMsg = sessionMessages[sessionMessages.length - 1];
    if (lastMsg) {
      if (lastMsg.kind === "tool-call") {
        const summary = summarizeToolCall(lastMsg.title, lastMsg.rawInput);
        const glyph = lastMsg.status === "failed" ? "✗" : "✓";
        return {
          glyph,
          text: `${lastMsg.title}${summary ? `: ${summary}` : ""}`,
          colorClass: lastMsg.status === "failed" ? "text-destructive" : "text-foreground-subtle",
        };
      }
      if (lastMsg.kind === "agent-thought") {
        const lines = lastMsg.text.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0) {
          return {
            glyph: "▸",
            text: `[thinking] ${lines[lines.length - 1].trim()}`,
            colorClass: "text-foreground-subtlest",
          };
        }
      }
      if (lastMsg.kind === "agent-text") {
        const lines = lastMsg.text.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0) {
          return {
            glyph: "▸",
            text: lines[lines.length - 1].trim(),
            colorClass: "text-foreground-subtlest",
          };
        }
      }
    }
  }

  // 2. Fall back to progress from details envelope
  const p = row.progress;
  if (p?.currentTool) {
    const args = p.currentToolArgs ? `: ${p.currentToolArgs}` : "";
    const dur = p.currentToolStartedAt
      ? ` · ${formatDuration(now - p.currentToolStartedAt)}`
      : "";
    return {
      glyph: "▸",
      text: `${p.currentTool}${args}`,
      duration: dur,
      colorClass: "text-foreground-subtle",
    };
  }
  if (p?.toolCalls && p.toolCalls.length > 0) {
    const last = p.toolCalls[p.toolCalls.length - 1];
    if (typeof last === "string") {
      return { glyph: "✓", text: last, colorClass: "text-foreground-subtle" };
    }
    if (last && typeof last === "object") {
      const glyph = last.error ? "✗" : "✓";
      const suffix = last.argsPreview ? `: ${last.argsPreview}` : "";
      return {
        glyph,
        text: `${last.name ?? "tool"}${suffix}`,
        colorClass: last.error ? "text-destructive" : "text-foreground-subtle",
      };
    }
  }
  if (p?.recentOutput && p.recentOutput.length > 0) {
    const lastLine = p.recentOutput[p.recentOutput.length - 1];
    if (lastLine) {
      return { glyph: "▸", text: lastLine, colorClass: "text-foreground-subtlest" };
    }
  }
  if (p?.output) {
    const lines = p.output.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > 0) {
      return { glyph: "▸", text: lines[lines.length - 1], colorClass: "text-foreground-subtlest" };
    }
  }

  // 3. Fall back to result
  if (row.result) {
    const r = row.result;
    if (r.exitCode !== 0 && r.error) {
      return { glyph: "✗", text: r.error, colorClass: "text-destructive" };
    }
    if (r.finalOutput) {
      const lines = r.finalOutput.split("\n").filter((l) => l.trim() !== "");
      if (lines.length > 0) {
        return { text: lines[lines.length - 1], colorClass: "text-foreground-subtle" };
      }
    }
    return {
      glyph: r.exitCode === 0 ? "✓" : "✗",
      text: r.exitCode === 0 ? "Done" : "Failed",
      colorClass: r.exitCode === 0 ? "text-success" : "text-destructive",
    };
  }

  if (row.status === "running") {
    return { glyph: "▸", text: "Starting...", colorClass: "text-foreground-subtlest" };
  }

  return undefined;
}
