import { useEffect, useState } from "react";
import { useSubagents, type SubagentEntry } from "../store/subagents";
import { useModelCatalog } from "../store/modelCatalog";
import { useSubagentSelection } from "../store/subagentSelection";
import { useInteractive } from "../store/interactive";
import { useSessions, type ToolCallUiStatus } from "../store/sessions";
import {
  cleanModelName,
  extractThinkingFromModel,
  formatDuration,
  formatThinkingIndicator,
  formatTokens,
  getModelContextWindow,
} from "../lib/toolOutput";
import {
  estimateTokensFromMessages,
  extractTargetInfo,
  getActivityDisplay,
  unmatchedAgentTooltip,
} from "../lib/subagentActivity";
import { StatusIcon } from "./SubagentStatusIcon";
import { MutedCaption } from "./MutedCaption";
import { moneyOf } from "./SessionCostLine";
import { cn } from "./lib/utils";
import { Button } from "./ui/button";
import { ToolCallCardHeader } from "./ToolCallCardHeader";

/**
 * C7: the subagent DIRECTORY row (the one clickable row inside the card's
 * expanded list) is a `<Button variant="ghost" size="default">`, both named
 * explicitly because `ui/button.tsx:40` sets `defaultVariants {variant:"default"}`
 * and a bare `<Button>` would paint every row `bg-primary text-primary-foreground`
 * at a fixed `h-7 px-2`. Measured with the real `cn()`, the rendered utility SET
 * is exactly the string this row spelled. What `DIRECTORY_ROW_WALL` undoes:
 *  - `border-0` — the base's `border` is a 1px ring the row never had (preflight
 *    sets `border: 0 solid`); it would inset the status glyph by 1px inside the
 *    card's own `px-4` and make the base's `bg-clip-padding` a no-op besides.
 *  - `h-auto` — the size's `h-7` is a fixed 28px and this row is THREE lines
 *    (name + metadata + activity) at `py-2`; a fixed height would clip lines two
 *    and three. This is the single biggest hazard at this site.
 *  - `justify-start` — the base centres on the main axis; at `h-auto` there is no
 *    free space, so this is belt-and-braces.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` (the row inherited
 *    `normal`; the spans that must elide spell `truncate` themselves, which is
 *    what needs nowrap, and a row-level nowrap would defeat the label's
 *    `[overflow-wrap]` behaviour in the activity line).
 *  - `select-auto` — the base's `select-none` would make an agent name, a task
 *    preview and the token/cost metadata unselectable.
 *  - `transition-none` — the base's `transition-colors` would fade the
 *    `hover:bg-surface-hover` band in over 150 ms; this row's band is instant.
 *  - `text-[length:inherit]` — the size declares `text-ui-base` and the base
 *    declares `text-ui-base/relaxed`; `cn()` keeps the LAST utility of the
 *    font-size group, so this restores the font-size the row INHERITED (it spells
 *    none) and, by collapsing both, declares no line-height either. Every text
 *    child spells `text-ui-base` or `text-ui-xs` itself, so the row's own size is
 *    invisible — but a `text-ui-base` the row GAINS is a class another selector
 *    can read, and `ChatStreamDirectoryCompletion.test.tsx`'s `primaryLines()` helper (which finds
 *    picker rows by `querySelectorAll(".text-ui-base")`) proves that is not
 *    hypothetical: at this program's other picker it doubled a label list and
 *    reddened six assertions. Restoring beats arguing away.
 * Inert here: `shrink-0` (the rows are children of the card's `divide-y` BLOCK
 * container, so `flex-shrink` never applies), `gap-1` (the row spells `gap-2.5`,
 * which wins), `px-2`/`py-2` (the row spells `px-2 py-2`), `items-center` (the
 * row spells `items-start`, later, same group), `rounded-md` (the row spells
 * `rounded-lg`), `text-foreground` + `hover:text-foreground` from `ghost` (every
 * piece of text in the row is a span/div that spells its own ink —
 * `text-foreground`, `text-foreground-subtle`, `text-foreground-subtlest`,
 * `text-destructive`, `text-success`, `text-warning` (the issue #47 resolve-miss
 * caption, a `MutedCaption` span that spells its own ink through `cn()`), and
 * the activity line's own `colorClass`),
 * `text-ui-base` from the size (it collapses the base's `text-ui-base/relaxed` in
 * the same font-size group so NO line-height is declared, and every text child
 * spells `text-ui-base` or `text-ui-xs` itself), `bg-clip-padding` (no border →
 * padding-box == border-box, so `hover:bg-surface-hover` fills the same box),
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus, and again under `forced-colors`, which is also what makes the row's own
 * `focus-visible:outline-none` redundant-but-harmless), `disabled:*` (a directory
 * row is never disabled), `aria-invalid:*` / `aria-expanded:*` (Radix sets
 * neither on a plain button), `group/button`, `has-data-[icon=inline-*]:pr/pl`
 * (lucide sets no `data-icon`), `[&_svg]:pointer-events-none` (the click handler
 * is on the button), `[&_svg]:shrink-0`, and
 * `[&_svg:not([class*='size-'])]:size-3.5` — the row's only `<svg>`s are the
 * `StatusIcon` glyphs, which carry an explicit `size-4`, so the
 * `:not([class*='size-'])` guard excludes them (the icon-resize hazard, checked).
 */
const DIRECTORY_ROW_WALL =
  "border-0 h-auto justify-start whitespace-normal select-auto transition-none text-[length:inherit]";

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
  // (#85) The real context windows, so a child's percentage is computed against
  // the window its provider actually declares instead of a hardcoded name
  // table (`getModelContextWindow`'s last resort, which answers 64k for every
  // deepseek model — 6% of a 1M-window model's real size).
  const catalog = useModelCatalog((s) => s.models);
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

  /**
   * The store entry a task key belongs to: the one with the SAME `task`, or one
   * the tool envelope links to that task through `childSessionId`.
   */
  const entryForTask = (taskKey: string): SubagentEntry | undefined =>
    matchingStoreEntries.find(
      (e) =>
        e.task === taskKey ||
        (e.sessionId &&
          resultsList.some(
            (r) => r.task === taskKey && r.childSessionId === e.sessionId,
          )),
    );

  /**
   * ONE derivation for every row (D3). This used to be TWO: a `taskKeys.map`
   * block and a second `matchingStoreEntries.map` block that ran only when the
   * first produced no key at all, each carrying its own copy of every `??`
   * chain. Copies drift — the second one had already lost the
   * `result.progressSummary.tokens` arm, the `agent` / `model` / `thinking`
   * fallbacks to the tool call's own `rawInput`, the envelope-first `model`
   * precedence and the `exitCode` status rule, so the SAME child printed
   * different numbers depending on which block happened to render it. One
   * builder, one precedence order, no second copy to forget to update. Where
   * the two disagreed the ENVELOPE-AWARE chain won: it is the one every row
   * takes today (the other only ran for a store entry carrying no `task`), and
   * the envelope is the richer source — the store entry holds only what
   * `subagent-session-started` / `subagent-closed` happened to carry.
   *
   * What decides a row: the task keys (the tool call's own `rawInput` +
   * `details.progress` + `details.results` + the store entries that carry a
   * task) PLUS any store entry that carries NO task — the one job the deleted
   * second block did in anger, now an ordinary source in the same list. (It
   * used to be an exclusive `else`: while any task key existed, a task-less
   * entry rendered no row at all.)
   */
  const rowSources: Array<{ task: string; entry?: SubagentEntry }> = taskKeys.map((task) => ({
    task,
    entry: entryForTask(task),
  }));
  // A task-less entry the envelope already names is on screen as that task's
  // row — adding it again would duplicate the child AND collide on the row key.
  const claimedSessionIds = new Set(
    rowSources
      .map((source) => source.entry?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const e of matchingStoreEntries) {
    if (e.task) continue;
    if (e.sessionId && claimedSessionIds.has(e.sessionId)) continue;
    rowSources.push({ task: "", entry: e });
  }

  const rows = rowSources.map((source, idx) => {
    const taskKey = source.task;
    const storeEntry = source.entry;
    // A `""` key matches NO envelope frame: the key is only ever empty for a
    // store entry that has no task, and `p.task === ""` would then match a
    // frame that simply OMITS `task` — some other child's progress.
    const progress =
      taskKey === "" ? undefined : progressList.find((p) => p.task === taskKey);
    const result = resultsList.find(
      (r) =>
        (taskKey !== "" && r.task === taskKey) ||
        (storeEntry !== undefined && r.childSessionId === storeEntry.sessionId),
    );
    const rawInputItem =
      taskKey === "" ? undefined : inputItems.find((i) => i.task === taskKey);

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
      (typeof rawInputObj?.thinking === "string" ? rawInputObj.thinking : undefined) ??
      extractThinkingFromModel(model);

    const interactiveCost = resolvedSessionId
      ? (allInteractiveCost[resolvedSessionId] as
          | {
              inputTokens?: number;
              outputTokens?: number;
              tokens?: number;
              // `null` is REACHABLE and MEANINGFUL here (issue #107): the
              // interactive store's `CostUpdatePayload.cost` is
              // `number | null | undefined`, and `null` means "frames arrived,
              // none carried a figure" — see the chain below.
              cost?: number | null;
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

    const modelContextWindow = getModelContextWindow(model, catalog);
    const calculatedPct =
      tokens && modelContextWindow > 0 ? (tokens / modelContextWindow) * 100 : undefined;

    const contextPercent =
      progress?.percent ??
      progress?.contextPercent ??
      interactiveCost?.percent ??
      interactiveCost?.contextPercent ??
      calculatedPct;

    // THE MONEY (issue #107). The four sources are NOT uniformly nullable:
    // `progress.cost` / `result.usage.cost` are `number | undefined` (the tool
    // envelope's detail stream), `interactiveCost.cost` is `number | null |
    // undefined` (the interactive store, where `null` is a REACHABLE, MEANINGFUL
    // value), and `storeEntry.metrics.cost` is `number | null` (the Rust
    // `Option<f64>` hand-off). A bare `??` chain treats `null` and `undefined`
    // alike, so it would fall THROUGH a live entry that deliberately reports
    // "nothing" and print the CLOSED snapshot's figure instead — resurrecting an
    // old number over a child that currently reports no figure, which is the
    // exact collapse this task removes Rust-side.
    //
    // THE RULE (the tree's own — `lib/sessionCost.ts`'s `costUsdOf`, and
    // `SessionCostLine.test.tsx`'s "#105's precedence" pin): a LIVE entry that
    // EXISTS holding `null` is a REPORT, not a gap — it STOPS the chain and the
    // row renders no money at all. Absence (`undefined` — no live entry at all)
    // falls through exactly as it always has. The arm ORDER is untouched, so the
    // evidence precedence (progress detail > live entry > result detail > closed
    // snapshot) is byte-identical to before for every case but the live-`null`
    // one, which renders nothing either way.
    const liveCost =
      interactiveCost !== undefined
        ? (interactiveCost.cost ?? null) // a live `null` is a REPORT, not a gap
        : undefined;
    const cost =
      progress?.cost ??
      liveCost ??
      (liveCost === undefined
        ? (result?.usage?.cost ?? storeEntry?.metrics?.cost)
        : undefined);

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
    // (issue #47) Likewise `nameResolution` exists ONLY on the store entry (the
    // `subagent-session-started` payload — the resolver's own answer). It is
    // deliberately NOT part of the `agentCandidate` chain above: that chain
    // reads the model's CLAIM about a name, this is the resolver's ANSWER about
    // one, and the two are different facts.
    const nameResolution = storeEntry?.nameResolution;

    return {
      // `entry-${idx}` keeps the deleted block's fallback key for a task-less
      // entry with no session id; a task key keeps its own.
      key: resolvedSessionId ?? `${taskKey || "entry"}-${idx}`,
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
      nameResolution,
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
            // The money segment (issue #107). The gate refuses `undefined` AND
            // `null` alike — a `null` never reaches `moneyOf` (belt-and-braces
            // behind the chain's live-`null` stop above) — and `moneyOf` (shared
            // with `SessionCostLine`, so the rule has ONE owner) renders `$0.00`
            // for a REAL zero and nothing else for `0`. The old
            // `row.cost !== undefined && row.cost > 0` gate skipped `0`, which
            // is what made a free child and an unpriced child render alike.
            if (row.cost !== undefined && row.cost !== null) {
              const formattedCost = moneyOf(row.cost);
              if (formattedCost) {
                metadataParts.push({
                  text: formattedCost,
                  className: "text-foreground-subtle",
                });
              }
            }

            return (
              <Button
                key={row.key}
                type="button"
                variant="ghost"
                size="default"
                onClick={() => row.sessionId && select(row.sessionId)}
                aria-label={`Open ${row.agentName} transcript`}
                className={cn(DIRECTORY_ROW_WALL, "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
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
                    {/* (issue #47) The resolve miss — ONE quiet caption, and
                        ONLY for `unmatched`. A name that matched no definition
                        still dispatches (ADR 0020), so this must not read as a
                        failure: the row keeps its name, its status icon, its
                        metadata line and its click handler, and the child's
                        real output still renders. `no_name` / `matched` /
                        absent render nothing here at all. */}
                    {row.nameResolution === "unmatched" && (
                      <MutedCaption
                        className="shrink-0 text-warning"
                        // The sentence has ONE owner (`unmatchedAgentTooltip`,
                        // `lib/subagentActivity.ts`) — the transcript sheet's
                        // header renders the same words from the same call, so
                        // the two surfaces cannot reword independently.
                        title={unmatchedAgentTooltip(row.agentName)}
                      >
                        no matching Agent
                      </MutedCaption>
                    )}
                  </div>

                  {/* Line 2: Model · Thinking · Context/Tokens · Stats */}
                  {metadataParts.length > 0 && (
                    <MutedCaption
                      as="div"
                      className="flex items-center gap-1.5 min-w-0 font-mono truncate"
                    >
                      {metadataParts.map((part, i) => (
                        <span key={i} className="flex items-center gap-1.5 shrink-0">
                          {i > 0 && <span className="opacity-50">·</span>}
                          <span className={part.className}>{part.text}</span>
                        </span>
                      ))}
                    </MutedCaption>
                  )}

                  {/* Line 3: Activity / Current Action */}
                  {activity && (
                    <p className={cn("truncate text-ui-xs font-mono", activity.colorClass)}>
                      {activity.glyph && <span className="mr-1">{activity.glyph}</span>}
                      <span>{activity.text}</span>
                      {activity.duration && <span className="opacity-75">{activity.duration}</span>}
                    </p>
                  )}
                </div>
              </Button>
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
