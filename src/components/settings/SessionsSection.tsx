import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { FolderOpenIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SessionInfo } from "@/lib/tauri";
import { basenameOfPath } from "@/lib/paths";
import { titleFor } from "@/lib/sessionTitle";
import { detachedSessions, useSessions, type Message } from "@/store/sessions";
import DeleteSessionDialog from "../DeleteSessionDialog";
import ClearDetachedSessionsDialog from "./ClearDetachedSessionsDialog";
import { SettingsBadge, SettingsGroupCard } from "./primitives";

/**
 * The relative time of a Session's last activity, derived ONLY from the latest
 * message's `at` when the transcript is loaded this boot
 * (`useSessions.messages[sessionId]`): `<60s` → `now`, `<60m` → `Nm`, else
 * `Nh`. Copied from `SpacesList`'s identical helper rather than exported from
 * there: `SessionInfo` has NO `createdAt` (the store's ordering note says so
 * explicitly), so a stored row that was never opened this boot has no loaded
 * messages and renders an empty slot instead.
 */
function relativeTimeFor(
  messages: Message[] | undefined,
  now: number = Date.now(),
): string | null {
  const latest = messages?.[messages.length - 1];
  if (!latest) return null;
  const diff = now - latest.at;
  if (diff < 60_000) return "now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / (60 * 60_000))}h`;
}

/**
 * One **Detached** row: the title (the one rule, `titleFor`), the FULL `cwd`,
 * an `archived` badge on the rows that carry the flag, the relative time (or an
 * empty slot), and the two actions — Reopen Space (non-destructive) then
 * Delete (the existing per-row confirm).
 *
 * The markup follows `McpSection`'s `McpRow` (a `border-t` row with a
 * `min-w-0 flex-1` text column and ghost icon buttons), NOT `SettingsRow`:
 * `SettingsRow` is a label/control grid for a preference, and this is a list of
 * data. The full path is on the row because this section is cross-Space — the
 * path is the one thing that says which folder a row came from (the confirm
 * dialog, which only asks how wide the sweep is, gets those same full paths).
 */
function DetachedSessionRow({
  row,
  onReopen,
  onDelete,
}: {
  row: SessionInfo;
  onReopen: () => void;
  onDelete: () => void;
}): ReactElement {
  const messages = useSessions((s) => s.messages[row.sessionId]);
  const title = titleFor(messages, basenameOfPath(row.cwd), row.title);
  const time = relativeTimeFor(messages);
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">
            {title}
          </div>
          <div className="truncate text-ui-sm text-foreground-subtle">
            {row.cwd}
          </div>
        </div>
        {row.archived ? <SettingsBadge>archived</SettingsBadge> : null}
        {time !== null ? (
          <span className="text-ui-sm text-foreground-subtle">{time}</span>
        ) : (
          // Empty slot — keeps the buttons aligned when no transcript was
          // loaded this boot.
          <span className="size-4" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Reopen space for ${title}`}
          title="Reopen this Space and open the session"
          onClick={onReopen}
        >
          <FolderOpenIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${title}`}
          title="Delete this session"
          onClick={onDelete}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Settings → **Detached sessions**: every stored Session whose **Space** tab is
 * closed (ADR 0016's 2026-10-21 amendment — the second door ADR 0016 requires
 * once the sidebar's Archived section is scoped to the active Space). Archived
 * and unarchived rows both qualify: an unarchived Session of a closed Space has
 * always been equally invisible.
 *
 * Three actions and nothing else — **Reopen Space** (the non-destructive
 * answer: `addSpace` puts the tab back, `openSession` loads the transcript, and
 * the section closes so the user lands on the tab they just re-opened),
 * **Delete** (per row, behind `DeleteSessionDialog`), and **Clear all** (the
 * widest blast radius in the app, behind the counted confirm).
 *
 * It reads the sessions store DIRECTLY — no new Rust command, no new fetch,
 * nothing to invalidate: `App.tsx` loads `listSessions(true)` at boot and
 * `deleteSession` removes the id from all three lists.
 */
export default function SessionsSection({
  onBack,
}: {
  onBack: () => void;
}): ReactElement {
  // Individual selectors (the `SpacesList` pattern) — one subscription per
  // slice, so an unrelated store write does not re-render this list.
  const spaces = useSessions((s) => s.spaces);
  const sessions = useSessions((s) => s.sessions);
  const historySessions = useSessions((s) => s.historySessions);
  const archivedSessions = useSessions((s) => s.archivedSessions);
  const messages = useSessions((s) => s.messages);
  const deleteSession = useSessions((s) => s.deleteSession);
  const addSpace = useSessions((s) => s.addSpace);
  const openSession = useSessions((s) => s.openSession);

  /**
   * The fourth argument is the LIVE list (`sessions`, not `historySessions`):
   * `detachedSessions` subtracts live ids because the Close-anyway path can
   * leave a live Session with no Space row, and passing the stored list there
   * would exclude nothing and let live rows leak into this section.
   */
  const detached = useMemo(
    () => detachedSessions(spaces, historySessions, archivedSessions, sessions),
    [spaces, historySessions, archivedSessions, sessions],
  );

  /**
   * The DISTINCT folder PATHS of the detached rows, for the confirm dialog.
   * Full paths and NOT base names on purpose: two different folders can share
   * a base name (`/home/alice/proj` and `/mnt/backup/proj`), and deduping by
   * base name would collapse them into one entry — undercounting the very
   * number this dialog exists to state. The rows keep showing `basenameOfPath`
   * for their title/space-name; only the dialog's list carries the path.
   */
  const folders = useMemo(
    () => [...new Set(detached.map((row) => row.cwd))],
    [detached],
  );

  const [clearOpen, setClearOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);

  /**
   * Clear all: best-effort, one delete per listed row. The ids are captured
   * BEFORE the first `await` — the store mutates as each delete lands, so a
   * list read afterwards would be missing the rows already gone. Each failure
   * is logged and the dialog closes unconditionally, partial failure included
   * (`closeSpace`'s `Promise.allSettled` + per-rejection `console.error` loop
   * is the precedent): a dialog stuck open after a swallowed failure is worse,
   * and the surviving rows stay listed here so they can be retried.
   */
  const clearAll = async (): Promise<void> => {
    const ids = detached.map((row) => row.sessionId);
    const settled = await Promise.allSettled(ids.map((id) => deleteSession(id)));
    for (const result of settled) {
      if (result.status === "rejected") {
        console.error("failed to delete a detached session:", result.reason);
      }
    }
    setClearOpen(false);
  };

  return (
    <div className="space-y-3">
      <SettingsGroupCard>
        {detached.length === 0 ? (
          <div className="px-4 py-3 text-ui-base text-foreground-subtle">
            No detached sessions. Every stored session belongs to an open Space.
          </div>
        ) : (
          detached.map((row) => (
            <DetachedSessionRow
              key={row.sessionId}
              row={row}
              onReopen={() => {
                // `addSpace` inserts (or re-touches) the Space row and selects
                // it; `openSession` then finds its owner and loads the
                // transcript; `onBack` leaves Settings so the user lands on the
                // tab they just re-opened. THIS ORDER is the whole effect.
                addSpace(row.cwd);
                openSession(row.sessionId);
                onBack();
              }}
              onDelete={() => setDeleteTarget(row)}
            />
          ))
        )}
      </SettingsGroupCard>
      <Button
        type="button"
        disabled={detached.length === 0}
        onClick={() => setClearOpen(true)}
      >
        Clear all
      </Button>
      {clearOpen && (
        <ClearDetachedSessionsDialog
          count={detached.length}
          folders={folders}
          onConfirm={() => void clearAll()}
          onClose={() => setClearOpen(false)}
        />
      )}
      {deleteTarget && (
        <DeleteSessionDialog
          // The SAME title rule the row used, so the confirm names exactly the
          // row it deletes.
          title={titleFor(
            messages[deleteTarget.sessionId],
            basenameOfPath(deleteTarget.cwd),
            deleteTarget.title,
          )}
          onConfirm={() => {
            // Closes on success AND on failure (a stuck-open dialog is worse);
            // the failure is logged, the row remains listed.
            deleteSession(deleteTarget.sessionId)
              .then(() => setDeleteTarget(null))
              .catch((err) => {
                console.error("Failed to delete session:", err);
                setDeleteTarget(null);
              });
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
