import type { AcpSessionUpdate } from "../tauri";
import type { DiffRef, Message } from "../sessionTypes";

export function diffMessages(diffs: DiffRef[], at: number): Message[] {
  return diffs.map((d) => ({ kind: "diff" as const, path: d.path, patch: d.patch, at }));
}

/**
 * Whether a `compaction_update` frame is a STALE "a compaction is running" — an
 * ACTIVE one for a session whose Worker has already crashed.
 *
 * Why the reducers ask: `App.tsx` coalesces session-update frames into ONE
 * store write per animation frame, while `session-stalled` is applied
 * immediately. An active frame that arrived just BEFORE the crash is therefore
 * applied AFTER `markStalled` cleared the entry, and a dead Worker never emits
 * the closing frame — honouring it would leave the indicator spinning and the
 * composer locked on a session that can never compact again. Only the CLEAR
 * (`active: false`) is trusted past a stall: it locks nothing, and a resumed
 * session (a `resumeSession` clears `stalled`) compacts normally again.
 */
export function isStaleCompactionStart(
  update: AcpSessionUpdate,
  stalledHere: boolean,
): boolean {
  return update.sessionUpdate === "compaction_update" && update.active && stalledHere;
}

/**
 * THE identity rule for a transcript message — the key BOTH halves of
 * `resumeSession`'s merge match on, and it is CONTENT-INCLUSIVE, never a bare
 * id lookup. Composition, per kind:
 *
 * - `user` → `user|<text>|<images>` — an image contributes
 *   `name/mimeType/sizeBytes/data` and the entries are joined by NUL: there is
 *   NO id on either side (the local copy and the `record_message`d row), so it
 *   matches on text + images; the image entries are compared field-by-field in
 *   a FIXED order so key-order differences in the two constructions never
 *   break the match.
 * - `agent-text` / `agent-thought` → `<kind>|<messageId>|<text>`
 * - `tool-call` → `tool-call|<id>|<title>|<status>`
 * - `diff` → `diff|<path>|<patch>`
 *
 * So two messages are "the same message" only while their CONTENT agrees: a
 * `title`, `status` or `text` change makes a NEW key. That is the fact the
 * merge comments lean on (ADR 0050) — a message a mutator changes during the
 * load window is no longer "in the snapshot" and re-enters the additions.
 *
 * NOTE: for a `user` message this key is content ONLY and is therefore
 * ambiguous — the merge must additionally require the matching reloaded
 * row's timestamp to be >= the added message's `at` (see the dedup in
 * `resumeSession`) so a re-sent identical prompt (an OLDER matching row)
 * is not mistaken for the just-committed message.
 */
export function mergeDedupeKey(m: Message): string {
  switch (m.kind) {
    case "user": {
      const images = (m.images ?? [])
        .map((img) => `${img.name}|${img.mimeType}|${img.sizeBytes}|${img.data}`)
        .join("\u0000");
      return `user|${m.text}|${images}`;
    }
    case "agent-text":
    case "agent-thought":
      return `${m.kind}|${m.messageId}|${m.text}`;
    case "tool-call":
      return `tool-call|${m.id}|${m.title}|${m.status}`;
    case "diff":
      return `diff|${m.path}|${m.patch}`;
  }
}
