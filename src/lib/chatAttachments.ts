import { inferAttachmentMimeType } from "./chatAttachmentMetadata";

export const MAX_CHAT_ATTACHMENTS = 8;
/**
 * Deliberately LOWER than ZCode's 20 MiB: the desktop persists attachments
 * inline (base64) in SQLite (ADR 0008), so the cap bounds DB growth.
 */
export const INLINE_IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Deliberately NARROWER than `image/*` (ZCode accepts all image types — it
 * uploads to its own backend): the destination is LLM vision APIs, which
 * only accept png/jpeg/gif/webp. An SVG would pass `image/*` and fail the
 * whole turn at the provider, so the allowlist is enforced here AND in the
 * Rust `build_prompt_blocks` validation.
 */
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/** A persisted / in-memory image (one `images` entry of a user message). */
export interface ImageRef {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** base64, WITHOUT a `data:` prefix. */
  data: string;
}

/** An image staged in the composer (CONTEXT.md: Attachment). */
export interface ChatComposerAttachment {
  id: string;
  file: File;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  objectUrl: string;
}

function normalizeComposerMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Ported from ZCode's `createChatComposerAttachment` (images-only: no `localPath`,
 * no text-file fields). `id` uses `crypto.randomUUID()` instead of `nanoid`
 * (no new dependency).
 */
export function createChatComposerAttachment(file: File): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(file.type || inferAttachmentMimeType(file.name));
  return {
    id: crypto.randomUUID(),
    file,
    filename: file.name,
    mimeType,
    objectUrl: URL.createObjectURL(file),
    sizeBytes: file.size,
  };
}

/** Release the object URL (call on remove / clear / unmount — prevents leaks). */
export function releaseAttachment(attachment: ChatComposerAttachment): void {
  URL.revokeObjectURL(attachment.objectUrl);
}

/**
 * Read the attachment as base64 (no `data:` prefix). Ported from ZCode's
 * `readAttachmentBase64` (Chinese error strings → English). Call ONLY at send
 * time — the UI preview uses the object URL (ZCode's pattern).
 */
export async function readAttachmentAsBase64(
  attachment: ChatComposerAttachment,
): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("failed to read attachment"));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read attachment"));
    reader.readAsDataURL(attachment.file);
  });
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) throw new Error("malformed data URL");
  return dataUrl.slice(commaIndex + 1);
}

/**
 * Apply the caps (PURE — a later task wires the state):
 * - only `SUPPORTED_IMAGE_TYPES` files (an empty `type` is inferred from the
 *   extension; `image/*` types outside the allowlist — e.g. `image/svg+xml` —
 *   are REJECTED, see the constant's comment);
 * - at most `MAX_CHAT_ATTACHMENTS` staged in total;
 * - each file ≤ `INLINE_IMAGE_ATTACHMENT_MAX_BYTES`.
 * Returns the new attachment list plus human-readable rejection reasons
 * (the composer shows them in its error line).
 */
export function addImageAttachments(
  existing: ChatComposerAttachment[],
  files: File[],
): { attachments: ChatComposerAttachment[]; rejected: string[] } {
  const rejected: string[] = [];
  let attachments = existing;
  for (const file of files) {
    const mimeType = normalizeComposerMimeType(file.type || inferAttachmentMimeType(file.name));
    if (!SUPPORTED_IMAGE_TYPES.includes(mimeType)) {
      rejected.push(
        `"${file.name || "pasted file"}" is not a supported image format (png, jpeg, gif, webp)`,
      );
      continue;
    }
    if (file.size > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
      rejected.push(`"${file.name || "pasted image"}" exceeds the 10 MiB limit`);
      continue;
    }
    if (attachments.length >= MAX_CHAT_ATTACHMENTS) {
      rejected.push(`at most ${MAX_CHAT_ATTACHMENTS} images per message`);
      break;
    }
    attachments = [...attachments, createChatComposerAttachment(file)];
  }
  return { attachments, rejected };
}

/**
 * Capability gate (FAIL-CLOSED): true only when the agent advertises
 * `promptCapabilities.image === true` in its initialize response.
 * `capabilities` is the raw camelCase wire record from `SessionInfo`
 * (`src/lib/tauri.ts`) — a missing field or missing `promptCapabilities`
 * means "not supported" (same posture as the suite's macOS fail-closed).
 */
export function agentSupportsImages(
  capabilities: Record<string, unknown> | undefined,
): boolean {
  const prompt = capabilities?.promptCapabilities as Record<string, unknown> | undefined;
  return prompt?.image === true;
}

// ── The `[image #N]` draft markers ─────────────────────────────────────────
//
// A staged screenshot leaves a marker in the draft, and the marker is SENT
// with the prompt so a prompt can name a specific attachment. `N` counts the
// attachments of THAT MESSAGE, never the session — that is the only reading
// true on the wire: `src-tauri/src/agent/harness/loop.rs` (the
// `MessageContent::Blocks` build) pushes the text block FIRST and then the
// images in send order as OpenAI `image_url` parts, so "the Nth image of this
// prompt" is the one thing a model can resolve. A session-wide number would
// read well to the user and be unresolvable by the model.

/**
 * The draft marker naming the Nth attachment of THIS message (1-based).
 *
 * The closing `]` is LOAD-BEARING TWICE OVER:
 *  • it ends the `#`-mention token (`MCP_MENTION_RE` in `src/lib/skills.ts`
 *    would otherwise keep a trailing marker's digits in play), and
 *  • it is what keeps a marker from OPENING the MCP picker. `activeMentionToken`
 *    returns `null` for `look [image #3]` with the caret after the `]`, but
 *    `{prefix: "#", remainder: "3"}` for `look [image #3` — so a marker WITHOUT
 *    the bracket would pop the picker the moment the user kept typing after it,
 *    on every staging path. Drop the bracket and every marker becomes a picker
 *    trigger.
 */
export function imageMarker(n: number): string {
  return `[image #${n}]`;
}

/**
 * Insert already-built marker TEXT at the caret (one call per staging EVENT —
 * never one per file, or a batch inserted at the same caret comes out
 * `#3 #2 #1` and the marker→image mapping inverts).
 *
 * A single space is prepended when the character BEFORE the caret is not
 * already whitespace, so a marker never welds itself to a word; at position 0
 * there is no character to separate, so nothing is added. Returns the caret
 * immediately AFTER the inserted text — the caller restores it, because a
 * controlled textarea loses both focus and caret on a programmatic `setDraft`.
 */
export function insertAtCaret(
  text: string,
  caret: number,
  markers: string,
): { text: string; caret: number } {
  // Clamp: a stale caret (a draft edited between the read and the insert) must
  // not splice outside the string.
  const at = Math.min(Math.max(caret, 0), text.length);
  const before = text.slice(0, at);
  const needsSpace = before !== "" && !/\s/.test(before.charAt(before.length - 1));
  const inserted = needsSpace ? ` ${markers}` : markers;
  return {
    text: before + inserted + text.slice(at),
    caret: at + inserted.length,
  };
}

/**
 * The marker pattern — the EXACT literal `[image #N]`, nothing looser, so
 * ordinary prose mentioning `#3` is untouched by the renumber.
 */
const IMAGE_MARKER_RE = /\[image #(\d+)\]/g;

/**
 * True when the draft says NOTHING except "here are images" — one or more
 * markers and no prose (the surrounding blanks the insert adds don't count).
 *
 * This is what `send()`'s fail-closed capability guards need: the marker is
 * draft TEXT, so a bare screenshot paste is no longer an "empty prompt" and a
 * `rawText === ""` test alone would let a text-only send through to an agent
 * that cannot take images at all — sending `[image #1]` to a model that receives
 * no image, which is worse than the empty prompt those guards exist to block.
 * `""` is FALSE here on purpose ("nothing but markers" is the question, not
 * "nothing"), so a caller keeps its own emptiness check.
 */
export function draftIsMarkerOnly(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  return t.replace(IMAGE_MARKER_RE, "").trim() === "";
}

/**
 * Rewrite the draft after the attachment at 1-based position `removedAt` was
 * removed: drop `[image #removedAt]` and decrement every marker ABOVE it.
 *
 * Keyed on the NUMBER, not on the order the markers appear in the text — a
 * marker lands at the caret, so text order and staging order can differ, and a
 * positional rescan would then delete the wrong marker.
 *
 * TWO PASSES, and the whitespace contract is part of the spec (without it the
 * deletion leaves orphan blanks):
 *  1. delete the named marker, THEN repair the SEAM it leaves: drop the blanks
 *     the marker was wrapped in and keep exactly one space when the marker sat
 *     BETWEEN words (none at either boundary of the draft). The repair is
 *     seam-local on purpose — a global "collapse every run of 2+ spaces" would
 *     rewrite blanks the user typed themselves, far from the deletion. And the
 *     space is deliberately NOT part of the marker match: a match that consumed
 *     a trailing space would swallow the separator following the LAST marker of
 *     a mid-sentence draft (`"see [image #1] and [image #2] now"` would lose the
 *     space before `and`).
 *  2. decrement every marker whose number is above `removedAt`.
 * The repair runs only where a marker was actually deleted, so a draft the user
 * hand-edited keeps its own spacing.
 */
export function renumberImageMarkers(text: string, removedAt: number): string {
  // Position 0 means "this id is no longer in the list" (`findIndex` + 1 in the
  // caller). Decrementing "everything above 0" would shift EVERY marker, so an
  // unknown position rewrites nothing.
  if (removedAt < 1) return text;
  // Pass 1 — delete the named marker and repair the SEAM it leaves. The repair
  // is local on purpose: a global "collapse every 2+ space run" would rewrite
  // blanks the user typed themselves, far from the deletion.
  const doomed = new RegExp(`\\[image #${removedAt}\\]`, "g");
  let out = "";
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = doomed.exec(text)) !== null) {
    const left = out + text.slice(from, m.index);
    const after = m.index + m[0].length;
    // Only the SPACE run at the seam is ours to touch — a newline is the
    // user's line structure, not a marker separator.
    const leftCut = left.replace(/ +$/, "");
    let right = after;
    while (text.charAt(right) === " ") right++;
    const atStart = leftCut.trim() === ""; // nothing but blanks precedes the seam
    const atEnd = text.slice(after).trim() === ""; // nothing follows it
    const hadSeparator = leftCut.length !== left.length || right !== after;
    // One space survives the seam only when the marker sat BETWEEN words; at
    // either boundary of the draft the exposed blank goes with it (otherwise
    // the deletion leaves a leading / trailing space behind).
    const seam = atStart || atEnd || !hadSeparator ? "" : " ";
    out = leftCut + seam;
    from = right;
  }
  out += text.slice(from);
  // Pass 2 — decrement every marker ABOVE the removed one (keyed on the
  // number, so text order is irrelevant).
  return out.replace(IMAGE_MARKER_RE, (whole, digits: string) => {
    const n = Number(digits);
    return n > removedAt ? imageMarker(n - 1) : whole;
  });
}
