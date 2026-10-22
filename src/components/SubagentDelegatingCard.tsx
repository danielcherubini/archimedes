import { useEffect, useState } from "react";
import { useSubagents } from "../store/subagents";
import { useSubagentSelection } from "../store/subagentSelection";
import { useInteractive } from "../store/interactive";
import { useSessions, type ToolCallUiStatus } from "../store/sessions";
import {
  cleanModelName,
  extractThinkingFromModel,
  formatCost,
  formatDuration,
  formatThinkingIndicator,
  formatTokens,
  getModelContextWindow,
} from "../lib/toolOutput";
import {
  estimateTokensFromMessages,
  extractTargetInfo,
  getActivityDisplay,
} from "../lib/subagentActivity";
import { StatusIcon } from "./SubagentStatusIcon";
import { ToolCallCardHeader } from "./ToolCallCardHeader";

/**
 * The `subagent` tool's card (the "Delegating" card): the standard
 * `ToolCallCardHeader` + the subagents delegated by THIS tool call.
 * Displays a 3-line compact view per subagent:
 *   Line 1: <agentName>: <task>
 *   Line 2: <model> · <thinkingLevel> · <context% / tokens> · <stats>
 *   Line 3: <activity> (current tool + live duration, last tool, output, Done, Failed)
 * Clicking a row opens the subagent's dedicated transcript modal.
 */
export default function SubagentDelegatingCard({
  title,
  status,
  rawInput,
  rawOutput,
  sessionId,
}: {
  title: string;
  status: ToolCallUiStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  sessionId: string;
}) {
  const entries = useSubagents((s) => s.entries);
  const select = useSubagentSelection((s) => s.select);
  const allMessages = useSessions((s) => s.messages);
  const allInteractiveCost = useInteractive((s) => s.cost);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const { targetTasks, targetSessionIds, inputItems, progressList, resultsList } =
    extractTargetInfo(rawInput, rawOutput);

  const allSessionEntries = Object.values(entries).filter(
    (e) => e.parentSessionId === sessionId,
  );

  const hasSpecificTargets = targetTasks.length > 0 || targetSessionIds.length > 0;

  const matchingStoreEntries = hasSpecificTargets
    ? allSessionEntries.filter(
        (e) =>
          targetSessionIds.includes(e.sessionId) ||
          targetTasks.includes(e.task),
      )
    : allSessionEntries;

  // Build the list of task keys to render
  const taskKeys: string[] = [];
  if (inputItems.length > 0) {
    for (const item of inputItems) {
      if (item.task && !taskKeys.includes(item.task)) taskKeys.push(item.task);
    }
  }
  for (const p of progressList) {
    if (p.task && !taskKeys.includes(p.task)) taskKeys.push(p.task);
  }
  for (const r of resultsList) {
    if (r.task && !taskKeys.includes(r.task)) taskKeys.push(r.task);
  }
  for (const e of matchingStoreEntries) {
    if (e.task && !taskKeys.includes(e.task)) taskKeys.push(e.task);
  }

  const rawInputObj =
    typeof rawInput === "object" && rawInput !== null
      ? (rawInput as Record<string, unknown>)
      : undefined;

  const rows =
    taskKeys.length > 0
      ? taskKeys.map((taskKey, idx) => {
          const storeEntry = matchingStoreEntries.find(
            (e) =>
              e.task === taskKey ||
              (e.sessionId &&
                resultsList.some(
                  (r) => r.task === taskKey && r.childSessionId === e.sessionId,
                )),
          );
          const progress = progressList.find((p) => p.task === taskKey);
          const result = resultsList.find(
            (r) =>
              r.task === taskKey ||
              (storeEntry && r.childSessionId === storeEntry.sessionId),
          );
          const rawInputItem = inputItems.find((i) => i.task === taskKey);

          const resolvedSessionId = storeEntry?.sessionId ?? result?.childSessionId;
          const agentCandidate =
            (progress?.agent && progress.agent.trim()) ||
            (result?.agent && result.agent.trim()) ||
            (storeEntry?.agentName && storeEntry.agentName.trim()) ||
            (rawInputItem?.agent && rawInputItem.agent.trim()) ||
            (typeof rawInputObj?.agent === "string" && rawInputObj.agent.trim());
          const agentName = agentCandidate || "subagent";

          const subStatus: "running" | "completed" | "failed" =
            result?.exitCode !== undefined
              ? (result.exitCode === 0 ? "completed" : "failed")
              : storeEntry?.status ??
                progress?.status ??
                (status === "completed" ? "completed" : "running");

          const model =
            progress?.model ??
            result?.model ??
            storeEntry?.model ??
            rawInputItem?.model ??
            (typeof rawInputObj?.model === "string" ? rawInputObj.model : undefined);

          const thinkingLevel =
            storeEntry?.thinkingLevel ??
            rawInputItem?.thinking ??
            (typeof rawInputObj?.thinking === "string"
              ? rawInputObj.thinking
              : undefined) ??
            extractThinkingFromModel(model);

          const interactiveCost = resolvedSessionId
            ? (allInteractiveCost[resolvedSessionId] as
                | {
                    inputTokens?: number;
                    outputTokens?: number;
                    tokens?: number;
                    cost?: number;
                    percent?: number;
                    contextPercent?: number;
                  }
                | undefined)
            : undefined;

          const sessionMessages = resolvedSessionId ? allMessages[resolvedSessionId] : undefined;

          const explicitTokens =
            progress?.tokens ??
            (interactiveCost &&
            (interactiveCost.inputTokens !== undefined || interactiveCost.outputTokens !== undefined || interactiveCost.tokens !== undefined)
              ? (interactiveCost.tokens ?? (interactiveCost.inputTokens ?? 0) + (interactiveCost.outputTokens ?? 0))
              : undefined) ??
            (result?.usage
              ? (result.usage.input ?? 0) + (result.usage.output ?? 0)
              : undefined) ??
            result?.progressSummary?.tokens ??
            (storeEntry?.metrics &&
            (storeEntry.metrics.inputTokens > 0 || storeEntry.metrics.outputTokens > 0)
              ? storeEntry.metrics.inputTokens + storeEntry.metrics.outputTokens
              : undefined);

          const estimatedTokens =
            sessionMessages && sessionMessages.length > 0
              ? estimateTokensFromMessages(sessionMessages)
              : undefined;

          const tokens =
            (explicitTokens && explicitTokens > 0 ? explicitTokens : undefined) ??
            estimatedTokens;

          const modelContextWindow = getModelContextWindow(model);
          const calculatedPct =
            tokens && modelContextWindow > 0 ? (tokens / modelContextWindow) * 100 : undefined;

          const contextPercent =
            progress?.percent ??
            progress?.contextPercent ??
            interactiveCost?.percent ??
            interactiveCost?.contextPercent ??
            calculatedPct;

          const cost =
            progress?.cost ??
            interactiveCost?.cost ??
            result?.usage?.cost ??
            storeEntry?.metrics?.cost;

          const sessionToolCount = sessionMessages
            ? sessionMessages.filter((m) => m.kind === "tool-call").length
            : undefined;
          const toolCount =
            (sessionToolCount && sessionToolCount > 0 ? sessionToolCount : undefined) ??
            progress?.toolCount ??
            result?.progressSummary?.toolCount;

          const isRunning = subStatus === "running";
          const durationMs = isRunning
            ? (storeEntry?.startedAt ? now - storeEntry.startedAt : progress?.durationMs)
            : (result?.progressSummary?.durationMs ??
              storeEntry?.metrics?.durationMs ??
              (storeEntry?.endedAt && storeEntry?.startedAt
                ? storeEntry.endedAt - storeEntry.startedAt
                : undefined));

          const error = storeEntry?.error ?? result?.error ?? progress?.error;
          // `reason` exists ONLY on the store entry (the `subagent-closed`
          // payload): the `progress` / `result` shapes are the older tool-result
          // detail stream and never carried a code.
          const reason = storeEntry?.reason;

          return {
            key: resolvedSessionId ?? `${taskKey}-${idx}`,
            sessionId: resolvedSessionId,
            agentName,
            task: taskKey,
            status: subStatus,
            model: cleanModelName(model),
            thinkingLevel,
            tokens,
            contextPercent,
            cost,
            toolCount,
            durationMs,
            error,
            reason,
            progress,
            result,
            sessionMessages,
          };
        })
      : matchingStoreEntries.map((storeEntry, idx) => {
          const progress = progressList.find(
            (p) => p.task === storeEntry.task,
          );
          const result = resultsList.find(
            (r) =>
              r.childSessionId === storeEntry.sessionId ||
              r.task === storeEntry.task,
          );
          const isRunning = storeEntry.status === "running";
          const durationMs = isRunning
            ? now - storeEntry.startedAt
            : (result?.progressSummary?.durationMs ??
              storeEntry.metrics?.durationMs ??
              (storeEntry.endedAt ? storeEntry.endedAt - storeEntry.startedAt : undefined));

          const sessionMessages = storeEntry.sessionId ? allMessages[storeEntry.sessionId] : undefined;
          const sessionToolCount = sessionMessages
            ? sessionMessages.filter((m) => m.kind === "tool-call").length
            : undefined;
          const toolCount =
            (sessionToolCount && sessionToolCount > 0 ? sessionToolCount : undefined) ??
            progress?.toolCount ??
            result?.progressSummary?.toolCount;

          const interactiveCost = storeEntry.sessionId
            ? (allInteractiveCost[storeEntry.sessionId] as
                | {
                    inputTokens?: number;
                    outputTokens?: number;
                    tokens?: number;
                    cost?: number;
                    percent?: number;
                    contextPercent?: number;
                  }
                | undefined)
            : undefined;

          const explicitTokens =
            progress?.tokens ??
            (interactiveCost &&
            (interactiveCost.inputTokens !== undefined || interactiveCost.outputTokens !== undefined || interactiveCost.tokens !== undefined)
              ? (interactiveCost.tokens ?? (interactiveCost.inputTokens ?? 0) + (interactiveCost.outputTokens ?? 0))
              : undefined) ??
            (result?.usage
              ? (result.usage.input ?? 0) + (result.usage.output ?? 0)
              : undefined) ??
            (storeEntry.metrics &&
            (storeEntry.metrics.inputTokens > 0 || storeEntry.metrics.outputTokens > 0)
              ? storeEntry.metrics.inputTokens + storeEntry.metrics.outputTokens
              : undefined);

          const estimatedTokens =
            sessionMessages && sessionMessages.length > 0
              ? estimateTokensFromMessages(sessionMessages)
              : undefined;

          const tokens =
            (explicitTokens && explicitTokens > 0 ? explicitTokens : undefined) ??
            estimatedTokens;

          const rawModel = storeEntry.model ?? progress?.model ?? result?.model;
          const modelContextWindow = getModelContextWindow(rawModel);
          const calculatedPct =
            tokens && modelContextWindow > 0 ? (tokens / modelContextWindow) * 100 : undefined;

          const contextPercent =
            progress?.percent ??
            progress?.contextPercent ??
            interactiveCost?.percent ??
            interactiveCost?.contextPercent ??
            calculatedPct;

          return {
            key: storeEntry.sessionId ?? `entry-${idx}`,
            sessionId: storeEntry.sessionId,
            agentName: storeEntry.agentName || "subagent",
            task: storeEntry.task,
            status: storeEntry.status,
            model: cleanModelName(rawModel),
            thinkingLevel:
              storeEntry.thinkingLevel ??
              extractThinkingFromModel(rawModel),
            tokens,
            contextPercent,
            cost: progress?.cost ?? interactiveCost?.cost ?? result?.usage?.cost ?? storeEntry.metrics?.cost,
            toolCount,
            durationMs,
            error: storeEntry.error ?? result?.error ?? progress?.error,
            reason: storeEntry.reason,
            progress,
            result,
            sessionMessages,
          };
        });

  const hasRunning =
    status === "pending" || rows.some((r) => r.status === "running");

  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  return (
    <div className="flex w-full flex-col">
      <ToolCallCardHeader
        title={title}
        status={status}
        rawInput={rawInput}
        rawOutput={rawOutput}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        files={[]}
        stat={undefined}
        range={undefined}
        isShell={false}
        command={undefined}
      />
      {open && rows.length > 0 && (
        <div className="mt-1 rounded-xl bg-panel px-4 py-3 divide-y divide-border/50">
          {rows.map((row) => {
            const activity = getActivityDisplay(row, row.sessionMessages, now);

            // Construct metadata parts for line 2
            const metadataParts: Array<{ text: string; className: string }> = [];
            if (row.model) {
              metadataParts.push({
                text: row.model,
                className: "text-foreground-subtle",
              });
            }
            if (row.thinkingLevel) {
              const formatted = formatThinkingIndicator(row.thinkingLevel);
              metadataParts.push({
                text: formatted ?? row.thinkingLevel,
                className: "text-accent",
              });
            }
            if (row.tokens !== undefined && row.tokens > 0) {
              const pctStr =
                row.contextPercent !== undefined && !Number.isNaN(row.contextPercent)
                  ? ` (${row.contextPercent >= 1 ? `${Math.round(row.contextPercent)}%` : `${row.contextPercent.toFixed(1)}%`})`
                  : "";
              metadataParts.push({
                text: `${formatTokens(row.tokens)} tok${pctStr}`,
                className: "text-foreground-subtle",
              });
            } else if (row.contextPercent !== undefined && !Number.isNaN(row.contextPercent)) {
              metadataParts.push({
                text: `${Math.round(row.contextPercent)}%`,
                className: "text-foreground-subtle",
              });
            }
            if (row.toolCount !== undefined && row.toolCount > 0) {
              metadataParts.push({
                text: `${row.toolCount} tool${row.toolCount !== 1 ? "s" : ""}`,
                className: "",
              });
            }
            if (row.durationMs !== undefined && row.durationMs > 0) {
              metadataParts.push({
                text: formatDuration(row.durationMs),
                className: "",
              });
            }
            if (row.cost !== undefined && row.cost > 0) {
              const formattedCost = formatCost(row.cost);
              if (formattedCost) {
                metadataParts.push({
                  text: formattedCost,
                  className: "text-foreground-subtle",
                });
              }
            }

            return (
              <button
                key={row.key}
                type="button"
                onClick={() => row.sessionId && select(row.sessionId)}
                aria-label={`Open ${row.agentName} transcript`}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="mt-1">
                  <StatusIcon status={row.status} />
                </span>
                <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                  {/* Line 1: Agent name + task preview */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="shrink-0 font-medium text-ui-base text-foreground">
                      {row.agentName}
                    </span>
                    {row.task && (
                      <>
                        <span className="text-ui-base text-foreground-subtle">:</span>
                        <span className="min-w-0 truncate text-ui-base text-foreground-subtle">
                          {row.task}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Line 2: Model · Thinking · Context/Tokens · Stats */}
                  {metadataParts.length > 0 && (
                    <div className="flex items-center gap-1.5 min-w-0 text-ui-xs text-foreground-subtlest font-mono truncate">
                      {metadataParts.map((part, i) => (
                        <span key={i} className="flex items-center gap-1.5 shrink-0">
                          {i > 0 && <span className="opacity-50">·</span>}
                          <span className={part.className}>{part.text}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Line 3: Activity / Current Action */}
                  {activity && (
                    <p className={`truncate text-ui-xs font-mono ${activity.colorClass}`}>
                      {activity.glyph && <span className="mr-1">{activity.glyph}</span>}
                      <span>{activity.text}</span>
                      {activity.duration && <span className="opacity-75">{activity.duration}</span>}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {open && rows.length === 0 && (
        <p className="font-mono text-ui-base text-foreground-subtle">
          No subagents yet.
        </p>
      )}
    </div>
  );
}
