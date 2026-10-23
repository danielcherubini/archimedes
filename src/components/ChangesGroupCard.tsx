import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon, PencilIcon, XCircleIcon } from "lucide-react";
import type { ToolCallMessage } from "../lib/toolGroups";
import {
  editChangeStat,
  fileSummaries,
  type ToolFileSummary,
} from "../lib/toolOutput";
import FileChip from "./FileChip";
import DiffCount from "./DiffCount";
import { TRANSCRIPT_ROW } from "./lib/transcriptRow";
import { cn } from "./lib/utils";
import ToolCallCard from "./ToolCallCard";

const CHIP_GAP_PX = 8;

function dedupeFiles(files: ToolFileSummary[]): ToolFileSummary[] {
  const seen = new Set<string>();
  const out: ToolFileSummary[] = [];
  for (const f of files) {
    if (!seen.has(f.path)) {
      seen.add(f.path);
      out.push(f);
    }
  }
  return out;
}

function sumStats(
  stats: Array<{ added: number; removed: number } | undefined>,
): { added: number; removed: number } | undefined {
  let added = 0;
  let removed = 0;
  for (const s of stats) {
    if (s) {
      added += s.added;
      removed += s.removed;
    }
  }
  if (added === 0 && removed === 0) return undefined;
  return { added, removed };
}

function filesCountLabel(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

/**
 * A `Changes` card: consecutive `write`/`edit` tool calls folded into
 * one header (`Changes` + `N files` + a responsive file-chip list with
 * `+N` overflow + total `+N -M` stats; while any member is pending,
 * the latest member's chip shows instead of the full list) and,
 * expanded, the per-file cards indented under a left border.
 */
export default function ChangesGroupCard({
  messages,
}: {
  messages: ToolCallMessage[];
}) {
  // NO auto-open — see `ToolCallCard` for why the self-reveal was removed. A
  // group is a collapsed `N files` row until the user clicks it, whatever
  // status its members arrive with. (`ToolCallCard` used to auto-open a single
  // card and this mirrored it, so a finished run of edits was open either way;
  // with both gone the transcript is a list of rows in every case.)
  const [open, setOpen] = useState(false);
  const files = dedupeFiles(
    messages.flatMap((m) => fileSummaries(m.title, m.rawInput)),
  );
  const totalStat = sumStats(
    messages.map((m) => editChangeStat(m.title, m.rawInput)),
  );
  const anyPending = messages.some((m) => m.status === "pending");
  const anyFailed = messages.some((m) => m.status === "failed");
  const latest = anyPending
    ? messages.reduce((a, b) => (b.at >= a.at ? b : a))
    : undefined;
  const latestFile = latest
    ? fileSummaries(latest.title, latest.rawInput)[0]
    : undefined;

  // Responsive chip list (port of ZCode's `resolveResponsiveFileChipCount`):
  // measure the chips against the row's right boundary; overflow → `+N`.
  const listRef = useRef<HTMLSpanElement>(null);
  const chipRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const overflowRef = useRef<HTMLSpanElement>(null);
  // The trailing content (stats + chevron) is MEASURED, not a fixed
  // constant — it can total ~80px, so a fixed reservation would clip
  // the last chip with no `+N` indicator.
  const trailingRef = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(files.length);
  useLayoutEffect(() => {
    const update = () => {
      const list = listRef.current;
      if (!list) return;
      const boundary = list.closest("[data-changes-group-row]") ?? list;
      const rect = list.getBoundingClientRect();
      const boundaryRight = boundary.getBoundingClientRect().right;
      const trailingWidth = trailingRef.current?.offsetWidth ?? 0;
      const available = Math.max(
        0,
        boundaryRight - rect.left - trailingWidth,
      );
      const chipWidths = files.map(
        (_, i) => chipRefs.current[i]?.offsetWidth ?? 0,
      );
      const overflowWidth = overflowRef.current?.offsetWidth ?? 0;
      if (available <= 0) {
        setVisibleCount(0);
        return;
      }
      const allWidth =
        chipWidths.reduce((a, b) => a + b, 0) +
        CHIP_GAP_PX * Math.max(0, chipWidths.length - 1);
      if (allWidth <= available) {
        setVisibleCount(files.length);
        return;
      }
      let visible = 0;
      let width = 0;
      for (let i = 0; i < files.length; i++) {
        const next = i + 1;
        const required =
          width + chipWidths[i] + CHIP_GAP_PX * next + overflowWidth;
        if (required > available) break;
        width += chipWidths[i];
        visible = next;
      }
      setVisibleCount((c) => (c === visible ? c : visible));
    };
    update();
    const boundary =
      listRef.current?.closest("[data-changes-group-row]") ?? listRef.current;
    if (!boundary || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(boundary);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [files.length, anyPending]);

  const hiddenCount = files.length - visibleCount;
  // While any member is pending, the chip list is NOT rendered — the
  // live latest-member chip (below) replaces it (ZCode's behavior).

  return (
    <div className="flex w-full flex-col" data-changes-group-row="">
      {/* Stays a raw <button>, deliberately — Task C7's sweep stopped here.
          `TRANSCRIPT_ROW` must render with NO `bg-*` token (ADR 0062's no-band
          rule, pinned by `src/components/lib/transcriptRow.test.tsx:102`), and
          `buttonVariants`' BASE string carries `bg-clip-padding`. `bg-clip-*` is
          its own tailwind-merge group, so no `variant` and no `className`
          override removes it — even `bg-clip-border` still contains `bg-`.
          `ToolCallCardHeader.tsx`'s row is blocked for the identical reason. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn("group/tool-summary", TRANSCRIPT_ROW)}
      >
        {/* The row glyph and the `Changes` verb (ADR 0062) — the same two row
            tokens the tool rows and the `Thought` trigger use, so one Palette
            re-hues all three consumers. Everything else on this row (the count,
            the separators, the failure mark) keeps its own token: only the glyph
            and the verb are row decoration. */}
        <PencilIcon className="size-4 shrink-0 text-row-icon" />
        <span className="shrink-0 whitespace-nowrap font-medium text-row-verb">
          Changes
        </span>
        {anyFailed && (
          <XCircleIcon
            className="size-4 shrink-0 text-destructive"
            aria-label="Some changes failed"
          />
        )}
        {files.length > 1 && (
          <span className="shrink-0 text-foreground-subtlest">
            {filesCountLabel(files.length)}
          </span>
        )}
        {files.length > 1 && (
          <span className="shrink-0 text-foreground-subtlest">·</span>
        )}
        {files.length > 1 && !anyPending && (
          <span
            ref={listRef}
            className="relative inline-flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden"
          >
            {files.map((file, index) => {
              const isVisible = index < visibleCount;
              return (
                <span
                  key={file.path}
                  ref={(el) => {
                    chipRefs.current[index] = el;
                  }}
                  aria-hidden={isVisible ? undefined : true}
                  className={
                    isVisible
                      ? "inline-flex min-w-0 shrink-0"
                      : "pointer-events-none invisible absolute inline-flex shrink-0"
                  }
                >
                  <FileChip path={file.path} />
                </span>
              );
            })}
            {hiddenCount > 0 && (
              <span className="shrink-0 text-foreground-subtlest">
                +{hiddenCount}
              </span>
            )}
            <span
              ref={overflowRef}
              aria-hidden="true"
              className="pointer-events-none invisible absolute shrink-0"
            >
              +{files.length}
            </span>
          </span>
        )}
        {files.length === 1 && !anyPending && <FileChip path={files[0].path} />}
        <span ref={trailingRef} className="flex shrink-0 items-center gap-2">
          {totalStat && <DiffCount stat={totalStat} />}
          {anyPending && latestFile && (
            <span className="inline-flex min-w-0 items-center gap-2">
              <FileChip path={latestFile.path} />
            </span>
          )}
          {/* LEFT AS A TEMPLATE LITERAL on purpose (Task C8) — the only site in
              this file `classNameConvention.test.ts` allowlists, and the reason
              is measured rather than assumed: the base spells TWO utilities from
              tailwind-merge's `transition` group
              (`transition-transform transition-opacity`), so merging it drops
              one. `cn` keeps the later token (`transition-opacity`) where today's
              concatenation keeps both and lets CSS source order decide — and
              `dist/assets/*.css` emits `.transition-transform` AFTER
              `.transition-opacity`, so the rotation is what animates now. A `cn`
              swap would quietly stop the chevron's rotate from easing.
              (`transcriptRow.test.tsx:118` also pins `opacity-0` on this very
              element, which a merged `rotate-90` arm would drop.) Converting it
              means first deleting the redundant transition utility — a visual
              change, not a mechanical one. */}
          <ChevronRightIcon
            aria-hidden
            className={`size-4 shrink-0 text-foreground-subtlest opacity-0 transition-transform transition-opacity duration-200 ease-out group-hover/tool-summary:opacity-100 ${
              open ? "rotate-90 opacity-100" : "rotate-0"
            }`}
          />
        </span>
      </button>
      {open && (
        <div className="ml-2 mt-1 space-y-2 border-l border-border pl-3.5">
          {messages.map((m, i) => (
            <ToolCallCard
              key={m.id ?? i}
              title={m.title}
              status={m.status}
              diff={m.diff}
              rawInput={m.rawInput}
              rawOutput={m.rawOutput}
            />
          ))}
        </div>
      )}
    </div>
  );
}
