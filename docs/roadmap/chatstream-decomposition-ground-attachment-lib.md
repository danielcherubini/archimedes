---
feature: chatstream-decomposition
area: attachment-library-and-chatstream-handlers
file: src/lib/chatAttachments.ts, src/lib/chatAttachmentMetadata.ts, src/components/ChatStream.tsx
status: grounding-report
branch: feature/chatstream-decomposition
base: b0071544
---

# Grounding report — the attachment / image-staging library layer and `ChatStream.tsx`'s attachment handlers

Area: the attachment library layer (`src/lib/chatAttachments.ts`, `src/lib/chatAttachmentMetadata.ts`, and `src/store/queuedPrompts.ts`'s attachment ownership) plus everything in `src/components/ChatStream.tsx` that touches attachments — the five handlers (`stageFiles`, `handlePaste`, `handleDrop`, `handleAttachClick`, `removeAttachment`), the WebKitGTK empty-paste clipboard fallback (`readClipboardImage`), the `heldForSendRef` failed-send restore contract, and the object-URL lifetime rules.

Purpose: a roadmap task is about to extract an attachment-lifecycle hook (taking `stageFiles`, `handlePaste`, `handleDrop`, `handleAttachClick`, `removeAttachment`) out of `ChatStream.tsx`. The planner must know every signature, every component-scope variable each handler touches, the cross-ownership of `draft`/`setDraft`, the system-specific fallback that must survive, the failed-send restore contract the dispatch hook must agree with, the object-URL ownership rules, which tests already pin what, and the house style for a hook of this shape.

Every claim below is pinned by **symbol name** (import, function, variable) rather than line number, so it survives a commit. Where a line number is given it is only a locator for the commit `b0071544`.

---

## 1. `src/lib/chatAttachments.ts` in full API terms (309 lines at `b0071544`)

Imports: only `import { inferAttachmentMimeType } from "./chatAttachmentMetadata";`. Exports, in file order, with their **exact** signatures (unchanged until the extraction deliberately moves them):

### Constants and types

```ts
export const MAX_CHAT_ATTACHMENTS = 8;
```
Doc: "Deliberately LOWER than ZCode's 20 MiB: the desktop persists attachments inline (base64) in SQLite (ADR 0008), so the cap bounds DB growth." The staging cap is enforced **inside `addImageAttachments`** — and, crucially, the failed-send restore path in `ChatStream.send()` re-applies it (`room = Math.max(0, MAX_CHAT_ATTACHMENTS - live.length)`). Tests pin: `chatAttachments.test.ts` `"rejects more than 8 attachments"` (asserts the message string `"at most 8 images per message"`); `ChatStream.test.tsx` `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the overflow"`.

```ts
export const INLINE_IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
```
Doc: "Deliberately LOWER than ZCode's 20 MiB … so the cap bounds DB growth." Tests pin: `"rejects files over 10 MiB"` (asserts `"exceeds the 10 MiB limit"`).

```ts
export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
```
Doc: "Deliberately NARROWER than `image/*` … the destination is LLM vision APIs, which only accept png/jpeg/gif/webp. An SVG would pass `image/*` and fail the whole turn at the provider, so the allowlist is enforced here AND in the Rust `build_prompt_blocks` validation." Tests pin: `"rejects unsupported image types"` (SVG rejected).

```ts
/** A persisted / in-memory image (one `images` entry of a user message). */
export interface ImageRef {
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** base64, WITHOUT a `data:` prefix. */
  data: string;
}
```
The on-the-wire shape `sendPrompt`'s 3-arg arm takes. It deliberately has **no `id`** — `ChatStream.tsx` builds it field-by-field from the id-bearing `SendTextImages` via a `map` (comment: "`ImageRef` has no `id` field — built field-by-field rather than by discarding `id` in a destructure, because `noUnusedLocals` is ON and an underscore does NOT exempt a destructured binding from being 'unused'"). Tests pin: the `sendPrompt` `toHaveBeenCalledWith("s1", "[image #1]", [{ name, mimeType, sizeBytes, data }])` assertions in `ChatStream.test.tsx`.

```ts
/** An image staged in the composer (CONTEXT.md: Attachment). */
export interface ChatComposerAttachment {
  id: string;
  file: File;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  objectUrl: string;
}
```
The composer's staged type; `id` is `crypto.randomUUID()` at creation. Tests pin: `"createChatComposerAttachment creates correct structure"` — and the whole `ChatStream.test.tsx` attachment suite builds these.

### Functions (exact signatures)

```ts
export function createChatComposerAttachment(file: File): ChatComposerAttachment
```
Doc: "Ported from ZCode's `createChatComposerAttachment` (images-only …). `id` uses `crypto.randomUUID()` instead of `nanoid` (no new dependency)." Guarantees: creates the `ChatComposerAttachment`, MIME from `file.type` else inferred from the extension via `inferAttachmentMimeType`, `objectUrl: URL.createObjectURL(file)`. Tests pin: `"createChatComposerAttachment creates correct structure"`, `"createChatComposerAttachment infers mime type"` (a `type: ""` file picks `image/webp` from the extension).

```ts
export function releaseAttachment(attachment: ChatComposerAttachment): void
```
Doc: "Release the object URL (call on remove / clear / unmount — prevents leaks)." The single funnel for `URL.revokeObjectURL`. Tests pin: `"releaseAttachment calls revokeObjectURL"` (asserts `URL.revokeObjectURL` called with `"blob:mock-s.png"`).

```ts
export async function readAttachmentAsBase64(
  attachment: ChatComposerAttachment,
): Promise<string>
```
Doc: "Read the attachment as base64 (no `data:` prefix). Ported from ZCode's `readAttachmentBase64` … Call ONLY at send time — the UI preview uses the object URL (ZCode's pattern)." Guarantee: strips the `data:` prefix after the first `,`; rejects with `"failed to read attachment"` on a non-string result or read error, `"malformed data URL"` when no comma. Tests pin: `"readAttachmentAsBase64 reads correctly"` (`new Uint8Array([1,2,3])` → `"AQID"`).

```ts
export function addImageAttachments(
  existing: ChatComposerAttachment[],
  files: File[],
): { attachments: ChatComposerAttachment[]; rejected: string[] }
```
PURE — the doc's first line is "Apply the caps (PURE — a later task wires the state):". Guarantees, in order per file: MIME allowlist (`SUPPORTED_IMAGE_TYPES`; empty `type` inferred from extension; `image/*` types outside the list — e.g. `image/svg+xml` — REJECTED) → size cap (`INLINE_IMAGE_ATTACHMENT_MAX_BYTES`) → count cap (`MAX_CHAT_ATTACHMENTS`, **breaks** on the cap so nothing after it is examined) → append via `createChatComposerAttachment`. Returns the new list (a fresh array only when at least one file was added, so the caller can test `next !== stagedBefore`) plus human-readable rejection reasons for the composer's error line. The UI strings are load-bearing (tests assert them): `"${file.name || "pasted file"}" is not a supported image format (png, jpeg, gif, webp)`, `"${file.name || "pasted image"}" exceeds the 10 MiB limit`, `at most ${MAX_CHAT_ATTACHMENTS} images per message`. Tests pin: the five `addImageAttachments` tests (`"rejects non-image files"`, `"rejects unsupported image types"`, `"rejects files over 10 MiB"`, `"rejects more than 8 attachments"`, `"accepts valid files"`).

```ts
export function agentSupportsImages(
  capabilities: Record<string, unknown> | undefined,
): boolean
```
Doc: "Capability gate (FAIL-CLOSED): true only when the agent advertises `promptCapabilities.image === true` in its initialize response. `capabilities` is the raw camelCase wire record from `SessionInfo` (`src/lib/tauri.ts`) — a missing field or missing `promptCapabilities` means 'not supported' (same posture as the suite's macOS fail-closed)." Body: `const prompt = capabilities?.promptCapabilities as Record<string, unknown> | undefined; return prompt?.image === true;`. Tests pin: `"returns true for correct capability"`, `"returns false for incorrect capability"`, `"returns false for empty"` — plus `ChatStream.test.tsx`'s `"paste stages a thumbnail in a resumable stored session (capability read from the stored session)"`, `"an image-only send is blocked when the capability regresses mid-session"`, `"a resumed session whose FRESH agent lacks image capability …"`.

```ts
export function imageMarker(n: number): string
```
Returns the exact literal `[image #${n}]`. The doc comment (quoted in full, it is load-bearing for any refactor): "The draft marker naming the Nth attachment of THIS message (1-based). The closing `]` is LOAD-BEARING TWICE OVER: • it ends the `#`-mention token (`MCP_MENTION_RE` in `src/lib/skills.ts` would otherwise keep a trailing marker's digits in play), and • it is what keeps a marker from OPENING the MCP picker … Drop the bracket and every marker becomes a picker trigger." Tests pin: `"is the bracketed marker for a 1-based position"`, and story-level `ChatStream.test.tsx` tests assert the literal `"[image #1]"` deltas.

```ts
export function insertAtCaret(
  text: string,
  caret: number,
  markers: string,
): { text: string; caret: number }
```
PURE. Insert already-built marker TEXT at the caret — **one call per staging EVENT, never one per file** (a batch inserted at the same caret comes out `#3 #2 #1` and inverts the marker→image mapping). Prepends a single space only when the character before the caret is not whitespace; at position 0 nothing is added. Clamps a stale caret. Returns the caret AFTER the inserted text — the caller restores it (a controlled textarea loses focus and caret on a programmatic `setDraft`). Tests pin: all five `insertAtCaret` tests (mid-string, whitespace, start-of-draft, clamp, and the newline case `"a\n[image #1]"`).

```ts
export function draftIsMarkerOnly(text: string): boolean
```
PURE. "True when the draft says NOTHING except 'here are images' — one or more markers and no prose (the surrounding blanks the insert adds don't count)." `""` is FALSE here on purpose ("nothing but markers" is the question, not "nothing"), so a caller keeps its own emptiness check. Pattern is the exact literal `IMAGE_MARKER_RE = /\[image #(\d+)\]/g` — prose naming a bare `#3` is untouched. Tests pin: the four `draftIsMarkerOnly` tests (markers-only → true; any prose → false; `""` → false; bare `#3` prose → false).

```ts
export function renumberImageMarkers(text: string, removedAt: number): string
```
PURE. Called after the attachment at 1-based position `removedAt` was removed. **Keyed on the NUMBER, not on text order** (a marker lands at the caret, so text order and staging order can differ — a positional rescan would delete the wrong marker). `removedAt < 1` returns `text` untouched ("Position 0 means 'this id is no longer in the list' (`findIndex` + 1 in the caller)" — this is the `removeAttachment` contract). TWO PASSES and the whitespace contract is part of the spec: pass 1 deletes the named marker and repairs the SEAM locally (drop the blanks the marker was wrapped in, keep exactly one space only when the marker sat BETWEEN words; the space is deliberately NOT part of the marker match); pass 2 decrements every marker above `removedAt`. Tests pin: the `renumberImageMarkers` table test with the seam cases, `"keys on the NUMBER, not on text order (the caret case)"`, `"leaves prose that mentions a bare number untouched"`, `"still decrements when the removed marker's text is gone from the draft"`, plus the component-level `"removing an attachment drops its marker and renumbers the survivors"` and `"the renumbered draft is what gets sent"`.

```ts
export function shiftImageMarkers(text: string, by: number): string
```
PURE. Bump every `[image #N]` marker's number by `by` — "the mirror image" of `renumberImageMarkers`: "N attachments joined the FRONT of it". `by === 0` returns the text untouched (`replace` would re-emit every marker). Guards the one case the arithmetic cannot express: a shift that would drive a marker to ≤ 0 leaves it alone. Tests pin: `"moves EVERY marker up by `by` (the restore-prepends-N case)"`, `"is a NO-OP for `by === 0`"`, `"matches ONLY the exact literal (prose `#3` is not a marker)"`, `"shifts markers in ANY text order"`, `"shifts DOWN for a negative `by`, and never invents a number below 1"`, `"leaves a marker-less draft untouched"` — plus component-level `"a failed send renumbers the draft when it re-prepends the held attachments"`.

There is **no other export** from this module (verified by grep of every `export` line). **Caveat for the planner**: `addImageAttachments` is documented "PURE — a later task wires the state", but the wire-up lives in `ChatStream.tsx` (see §3). `INLINE_IMAGE_ATTACHMENT_MAX_BYTES` and `SUPPORTED_IMAGE_TYPES` are consulted **only** inside this module today; `MAX_CHAT_ATTACHMENTS` is additionally imported by `ChatStream.tsx` for the failed-send restore ceiling (§3, §5).

---

## 2. `src/lib/chatAttachmentMetadata.ts` (29 lines at `b0071544`)

Two named exports (plus the module-private `SPREADSHEET_CLIPBOARD_HTML_PATTERN`), and its own test file `src/lib/chatAttachmentMetadata.test.ts` (38 lines, 7 `test(` blocks).

```ts
export function shouldPreferSpreadsheetClipboardText(text: string, html: string): boolean
```
Body, verbatim:

```ts
export function shouldPreferSpreadsheetClipboardText(text: string, html: string): boolean {
  if (!text) return false;
  return text.includes("\t") || SPREADSHEET_CLIPBOARD_HTML_PATTERN.test(html);
}
```

with `const SPREADSHEET_CLIPBOARD_HTML_PATTERN = /Excel\.Sheet/i;` and doc "Checks if the text content should be preferred over HTML when pasting from a spreadsheet. Spreadsheet apps often put tab-separated values in text/plain and a complex HTML table in text/html." Behaviour owned: the **spreadsheet TSV/HTML detection**. It is the *only* consumer of the `text` and `html` strings `handlePaste` reads — when it returns true (or there are no file items), the paste is left to the default text path. **This is what stops a spreadsheet paste's synthetic image from being staged** (test: `"spreadsheet TSV is NOT intercepted over the synthetic PNG"`). Tests (its own file): `"returns true for text containing tab and empty html"`, `"returns true for plain text and Excel HTML"`, `"returns false for plain text and plain HTML"`, `"returns false for empty text"`.

```ts
export function inferAttachmentMimeType(filename: string): string
```
Body, verbatim (extension → MIME): `png`→`image/png`, `jpg`/`jpeg`→`image/jpeg`, `gif`→`image/gif`, `webp`→`image/webp`, `txt`→`text/plain`, `json`→`application/json`, `md`→`text/markdown`, `pdf`→`application/pdf`, default `application/octet-stream`. Owners: both `chatAttachments.ts` internals (empty `file.type` files at create/stage) and `handleAttachClick`'s `+` picker rebuild (`type: inferAttachmentMimeType(path)`). Tests: `"infers image types correctly"`, `"infers text/plain correctly"`, `"infers application/octet-stream for no extension"`.

---

## 3. The five attachment handlers in `ChatStream.tsx` — exact signatures and every component-scope variable each reads/writes

All five live in one documented block: `// --- Image-attachment handlers (plain functions, NOT hooks — their placement is flexible; kept with the other handlers). ---`. They are **not** hooks **by intention**: the comment at the picker section (quoted in §3.4 background below) says "Plain (non-hook) functions like the attachment handlers are placement-flexible and live with the other handlers below." A hook extraction therefore changes what is currently a placement-flexible closure into a hook — which must be called unconditionally in the top block, ABOVE the `if (!activeSessionId) return` early return (the hook-count rule the file documents in full at the attachments state). The handlers are returned to `ComposerRow` as props (`attachments`, `removeAttachment`, `handlePaste`, `handleDrop`, `handleAttachClick`, `send`, … at the `ComposerRow` element — line ~1529-1532 at `b0071544`).

### 3.1 `stageFiles`

```ts
const stageFiles = (files: File[]) => {
```

**Reads (each with its role):**

| variable | role in this handler |
|---|---|
| `attachmentsRef` (the live mirror of `attachments`, re-synced every render) | `const stagedBefore = attachmentsRef.current;` — the CURRENT list, deliberately the ref not the state ("a render closure would be stale for fast successive events — e.g. pasting 8 files then a 9th in separate dispatches without a re-render in between") |
| `addImageAttachments` | `const { attachments: next, rejected } = addImageAttachments(stagedBefore, files);` |
| `imageMarker` | building the batch marker string |
| `composerRef` (the `<textarea>` ref) | `const el = composerRef.current;` — for the caret read |
| `document.activeElement` | the focus test for the caret (see below) |
| `draftRef` (the live mirror of `draft`) | `const len = draftRef.current.length;` for the caret fallback; `insertAtCaret(draftRef.current, caret, markers)` |
| `insertAtCaret` | the pure insert |
| `requestAnimationFrame` | restore focus + caret after the controlled write |

**Writes:**

- `attachmentsRef.current = next;` and `setAttachments(next)` — but ONLY when `next !== stagedBefore` (a fully rejected batch writes nothing).
- `setDraft(inserted.text)` — **the marker insert, one string for the WHOLE batch, inserted ONCE**: `const markers = next.slice(stagedBefore.length).map((_, i) => imageMarker(stagedBefore.length + 1 + i)).join(" ");` — "inserting one at a time at the same caret would emit `#3 #2 #1` and invert the marker→image mapping on every multi-file paste", and the count comes from the RETURNED list never `files.length` (a rejected mid-batch file must not leave a marker).
- **The caret rule (must survive the extraction verbatim)**: "CARET ONLY WHEN THE TEXTAREA ACTUALLY HAS FOCUS. `selectionStart` is `0` for a textarea that has never been focused, and two of these four paths (a drop, and the `+` picker — the native dialog holds focus) routinely run that way, so the naive read would drop every marker at the START of the user's sentence. This is a deliberate divergence from the `selectionStart ?? draft.length` idiom in `handleDrop`'s backstop and `selectMention`, which is safe there only because both are reachable solely after typing (so the field is focused)." The code: `const caret = el && document.activeElement === el ? (el.selectionStart ?? len) : len;` then after `setDraft`: `requestAnimationFrame(() => { const area = composerRef.current; if (!area) return; area.focus(); area.setSelectionRange(pos, pos); });`
- `setError(rejected.length > 0 ? rejected.join("; ") : null)` — a successful stage CLEARS a stale rejection line.

It is "the single funnel for all four" staging paths (paste-with-file-items, the WebKitGTK empty-paste fallback, drop, `+` picker) — "so one insert here covers all four. Doing it in the callers instead would number a mixed batch `#1, #3` and the number would stop matching the strip."

### 3.2 `handlePaste`

```ts
const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
```

**Reads:** `imageCapable` (the fail-closed gate — `if (!imageCapable) return; // fall through: default text paste`), `e.clipboardData.items` (`item.kind === "file"` → `item.getAsFile()`; comment: "`clipboardData.files` is EMPTY in real webviews (WebKit/WebKitGTK, WebView2/Chromium)"), `e.clipboardData.getData("text/plain")` and `getData("text/html")`, `shouldPreferSpreadsheetClipboardText(text, html)`, `stageFiles`, `activeSessionIdRef` (captured at paste time), `readClipboardImage` (§4).

**Writes (through `stageFiles`):** `attachmentsRef`/`setAttachments`, `setDraft` (the marker insert), `setError` — all inside the `stageFiles` funnel. **Direct writes: none.** The event is `e.preventDefault(); e.stopPropagation();` when files were staged; the spreadsheet case deliberately does NOT prevent (default text paste wins); the empty-paste fallback calls `void readClipboardImage().then(...)` — see §4 for the full body.

### 3.3 `handleDrop`

```ts
const handleDrop = (e: React.DragEvent) => {
```

Full body:

```ts
const handleDrop = (e: React.DragEvent) => {
  if (!imageCapable) return;
  e.preventDefault();
  stageFiles(Array.from(e.dataTransfer.files));
};
```

**Reads:** `imageCapable`, `e.dataTransfer.files`. **Writes:** nothing directly — everything through `stageFiles` (`attachmentsRef`/`setAttachments`/`setDraft` marker insert/`setError`). The document block above it is a contract a hook must keep verbatim: "Staging attachments is allowed DURING A TURN on all three paths — paste, drop and the `+` picker… The invariant this keeps: a locked composer STAGES, it does not DISPATCH. Enter while locked reaches `send()`, which moves the whole staged set (with its object URLs) into the queue entry alongside the text — so a dropped file never waits in the composer for the turn to end."

### 3.4 `handleAttachClick`

```ts
const handleAttachClick = async () => {
```

**Reads:** `composerEnabled` (stays — "a session that cannot be sent to must not accumulate images"), `imageCapable` (stays, fail-closed), `openFileDialog` (`@tauri-apps/plugin-dialog`'s `open`), `readFileBytes` (the Rust command), `basenameOfPath`, `inferAttachmentMimeType`, `describeIpcError`, `stageFiles`. The doc is explicit about the two lock terms: "NO `composerLocked` term, on purpose: the picker stages, it does not dispatch — see `handleDrop`'s comment for the invariant (staging is allowed during a turn on all three paths; a locked Enter moves the staged set into the queue row). `composerEnabled` DOES stay".

**Writes:** via `stageFiles` (all three state/ref slots + `setError` above), and directly `setError(readError)` in the else-arm: "A read failure (e.g. the file over the 10 MiB cap — the command rejects): keep the readable selections staged, surface the error only when NOTHING was staged." The dialog filter list is `Images` / `["png","jpg","jpeg","gif","webp"]` with the comment "the dialog filters, the command re-validates, `stageFiles` re-validates the MIME a third time". A `null`/cancelled picker stages nothing; a `catch` on `openFileDialog` returns (non-Tauri context).

### 3.5 `removeAttachment`

```ts
const removeAttachment = (id: string) => {
```

Full body, verbatim:

```ts
const removeAttachment = (id: string) => {
  // Revoke OUTSIDE the state updater (updaters must be pure — StrictMode
  // runs them twice; a double revoke is harmless but the wrong pattern).
  const target = attachmentsRef.current.find((a) => a.id === id);
  if (target) releaseAttachment(target);
  // The 1-based position IN THE LIST BEING SHOWN, computed BEFORE the
  // filter (after it, the index would be the survivor's). This is the `N`
  // the draft's marker uses, so removing a thumbnail takes its marker with
  // it and shifts every marker above it down — the numbers keep naming the
  // right picture. `draftRef` (not the closure) for the same reason
  // `attachmentsRef` is read here: the composer is not locked, so a
  // same-tick draft edit must not be reverted by this rewrite.
  const position = attachmentsRef.current.findIndex((a) => a.id === id) + 1;
  setDraft(renumberImageMarkers(draftRef.current, position));
  const next = attachmentsRef.current.filter((a) => a.id !== id);
  attachmentsRef.current = next;
  setAttachments(next);
};
```

**Reads:** `attachmentsRef` (twice — the `find` for the revoke and the `findIndex` for the marker position), `releaseAttachment`, `renumberImageMarkers`, `draftRef`. **Writes:** revoke of the removed URL, `setDraft` (marker removal + renumber), `attachmentsRef.current = next`, `setAttachments(next)`.

### 3.6 The shared state-variable ownership map (the reason `draft` must be an argument)

Every handler that writes `draft`/`setDraft`:

| Handler | How it touches `draft`/`setDraft` | Write shape |
|---|---|---|
| `stageFiles` | `setDraft(insertAtCaret(draftRef.current, caret, markers).text)` | marker INSERT at the caret (one batch string) |
| `removeAttachment` | `setDraft(renumberImageMarkers(draftRef.current, position))` | marker REMOVE + RENUMBER |
| `handlePaste` | none directly — via `stageFiles` | — |
| `handleDrop` | none directly — via `stageFiles` | — |
| `handleAttachClick` | none directly — via `stageFiles` | — |
| **`send`/`sendText` (not extracted, but the contract boundary)** | `setDraft("")` in `onCommitted`; `setDraft(shiftImageMarkers(draftRef.current, back.length))` in the catch restore | wipe at send; SHIFT on restore |

So exactly **three** sites write `draft` today, two of them inside the extraction's blast radius (`stageFiles`, `removeAttachment`) and one in the dispatch path (`send`'s `onCommitted` wipe + catch restore). All three read `draft` **through `draftRef`** — the live mirror re-synced every render, because "the composer is not locked, so a same-tick draft edit must not be reverted by this rewrite" — never through the render closure. **The extraction must take `draft`/`setDraft` (or the ref pair) as arguments and own neither**: `useMentionPicker` — the house precedent for exactly this shape — documented it as "the hook never owns the draft — eleven sites write it". The hook-count rule is equally binding: any `useState`/`useEffect` the extracted hook adds must live above the `if (!activeSessionId) return` early return (the file's own comment: "a hook called only on the full-frame path would change the hook count when the active session appears/disappears and crash React").

Also component-scope: `attachmentsRef` is written by `stageFiles`/`removeAttachment` **and** by `send`'s held-move and catch-restore; `setError` is written by `stageFiles`/`handleAttachClick`/`send`; `setAttachments` by `stageFiles`/`removeAttachment`/`send`'s held-move and restore and the session-switch effect. `setError(null)` also runs at the top of `send`.

`composerEnabled`, `imageCapable`, `composerRef`, `activeSessionIdRef`, `attachmentsRef`, `draftRef` are all derived elsewhere in the component (`composerEnabled = isLive || canResume`; `composerLocked = workingOrInTurn || agentState === "blocked" || compacting !== undefined`; `imageCapable = agentSupportsImages(activeCapabilities)`). A hook that needs `imageCapable` and `composerEnabled` must receive them as arguments (or derive `imageCapable` from `activeCapabilities` itself).

---

## 4. The WebKitGTK empty-paste clipboard-image fallback — must survive

This is called out in the issue as a system-specific behaviour the refactor must not break. The code, verbatim, from `handlePaste` (after the file-items arm):

```ts
    // WebKitGTK quirk: a pasted image produces a `paste` event with NO file
    // items and NO text (the DataTransfer is empty — verified on
    // webkit2gtk-4.1 2.52.5 on Wayland; the image IS inserted into a
    // contenteditable, just not exposed on the event). When the event has
    // no content at all, the likely cause is a clipboard image WebKit can't
    // surface — read it from the system clipboard (Rust/arboard) instead.
    // A text-only paste is a text paste: `getData("text/plain")` is
    // non-empty, so the fallback is skipped (no stale image staged).
    if (files.length === 0 && !text) {
      // The read can straddle a session switch (it is a slow IPC round
      // trip): capture the active session at PASTE time and abort if it
      // changed — without the guard, `stageFiles` would target the NEW
      // active session (staging session A's pasted image in session B's
      // composer; the same cross-session leak `send()`'s
      // `activeSessionIdRef` guard prevents for sends).
      const pastedInSession = activeSessionIdRef.current;
      void readClipboardImage()
        .then((bytes) => {
          if (!bytes) return; // no image on the clipboard — nothing to stage
          if (activeSessionIdRef.current !== pastedInSession) return; // switched
          const file = new File([new Uint8Array(bytes)], "screenshot.png", {
            type: "image/png",
          });
          stageFiles([file]);
        })
        .catch(() => {
          // Silent: clipboard access failed (or no image) — an empty-clipboard
          // paste is not an error condition.
        });
    }
```

**The IPC call**: `readClipboardImage` (imported from `../lib/tauri`, which re-exports it from `./tauri/commands/files`). Its declaration there, verbatim:

```ts
export async function readClipboardImage(): Promise<number[] | null> {
  return invoke<number[] | null>("read_clipboard_image");
}
```

with the composite doc: "`DataTransfer` file items (`items`/`files` are empty for a pasted image — verified on webkit2gtk-4.1 2.52.5 on Wayland), so the composer reads the image from the system clipboard directly (Rust/arboard) as a fallback. `null` when the clipboard has no image (text-only or empty)."

**The trigger condition**: a `paste` event on the composer where — after the file-items pass — `files.length === 0` AND `getData("text/plain")` is empty, on an `imageCapable` session. A text-only paste intentionally does NOT trigger it. The read is fire-and-forget (`void …`), and the `.catch` is silent ("an empty-clipboard paste is not an error condition").

**What a refactor must not break** (each is a pinned test):
1. The fallback stages the read bytes as a `File` named `screenshot.png` with `type: "image/png"` → thumbnail + marker (tests: `"WebKitGTK quirk: empty paste event falls back to the Rust clipboard read"`, `"the WebKitGTK empty-paste clipboard fallback inserts a marker too"`).
2. `null` from the read stages nothing (test: `"WebKitGTK quirk fallback: no image on the clipboard stages nothing"`).
3. A rejected read stages nothing and shows NO error line (`expect(screen.queryByText(/clipboard/i)).toBeNull()`, test: `"WebKitGTK quirk fallback: a read error stages nothing (silent)"`).
4. `readClipboardImage` is NOT called for a text paste (`"paste of plain text does NOT trigger the Rust clipboard read"`) nor for a paste with file items (`"paste with file items does NOT trigger the Rust clipboard read"`).
5. The **session-switch guard**: a read that straddles a session switch must abort and stage nothing in the new session (test: `"a paste-fallback clipboard read that straddles a session switch stages nothing (session guard)"`).
6. The **spreadsheet gate comes first**: a TSV/Excel-HTML paste with a synthetic image is never intercepted and never triggers a clipboard read (the `shouldPreferSpreadsheetClipboardText` arm, §2; tests `"spreadsheet TSV is NOT intercepted over the synthetic PNG"` and the metadata suite).

---

## 5. The failed-send attachment restore (`heldForSendRef`) — the contract the dispatch hook and the attachment hook must share

### 5.1 The state

```ts
const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);
const attachmentsRef = useRef(attachments);
/** Attachments handed to a send that has not settled yet, keyed by session id.
 * They are OUT of `attachments` (so their thumbnails leave the composer
 * immediately) but NOT released — a failed send puts them back. */
const heldForSendRef = useRef<Map<string, ChatComposerAttachment[]>>(new Map());
```

plus the re-sync line every render: `attachmentsRef.current = attachments;` — "the handlers read the CURRENT list from the ref (a render closure would be stale for fast successive events…)". Also in the same block: `sendingSessionsRef` (a `Set<string>`, the Task-5 double-send guard), `activeSessionIdRef`, `draftRef` — all re-synced every render, all read "through the ref, not the closure" by the async paths.

### 5.2 The move OUT of the composer (at send, not when the turn settles)

From `sendText`'s `onCommitted` callback (called by `send` right before `addUserMessage`):

```ts
(sentIds) => {
  setDraft("");
  // The staged `File`/object-URL pair has NO remaining job once the
  // base64 copies are on the user message: hold exactly the sent
  // attachments OUT of `attachments` so their thumbnails leave the
  // composer NOW instead of sitting there for the whole turn. They are
  // held, not released — the `catch` below puts them back on a failed
  // send, and the success path releases them when the turn settles.
  // `activeSessionIdRef` guard: a send whose session was switched away
  // during the read never touches the (now other session's) composer state.
  if (sentIds.size > 0 && activeSessionIdRef.current === targetSessionId) {
    const held = attachmentsRef.current.filter((a) => sentIds.has(a.id));
    heldForSendRef.current.set(targetSessionId, held);
    const staged = attachmentsRef.current.filter((a) => !sentIds.has(a.id));
    attachmentsRef.current = staged;
    setAttachments(staged);
  }
},
```

### 5.3 The catch path (verbatim — this block, its ordering, and its comments are the shared contract)

From `send`'s `catch`, after `turnCompleted(targetSessionId, "end_turn")` and `setError(msg)`:

```ts
      // Attachments deliberately survive a failed send (a re-pasted image is
      // costly, a re-typed draft is not). The thumbnails now leave the
      // composer AT send (see `heldForSendRef`), so this is where they come
      // back: the held list is merged in FRONT of whatever is staged now (the
      // user can stage during a turn), de-duplicated by `id` so a re-staged
      // item is not doubled. The RESTORED ones' object URLs are NOT revoked —
      // that is what makes the restored thumbnail render again (only the
      // overflow the cap forces out below is released).
      //
      // This block MUST stay in the same synchronous block as `setError`
      // above: the existing test waits on the error line, and it only passes
      // because both state updates land in one React 19 batch — an `await`
      // between them lets the test observe the pre-restore DOM (flaky).
      const held = heldForSendRef.current.get(targetSessionId);
      if (held && held.length > 0 && activeSessionIdRef.current === targetSessionId) {
        const live = attachmentsRef.current;
        const ids = new Set(live.map((a) => a.id));
        const fitting = held.filter((a) => !ids.has(a.id));
        // ── The restore respects MAX_CHAT_ATTACHMENTS ──────────────────────
        // The cap is enforced inside `addImageAttachments`, i.e. only at
        // STAGING time, and this path writes `attachments` directly — so
        // without a ceiling here a failed send can rebuild a list the cap
        // would never have admitted (send 8, paste a 9th during the turn,
        // fail: 9 staged). Nothing in the UI catches that, and the NEXT send
        // is then rejected server-side for a state this component built.
        // Dropping the overflow mirrors `addImageAttachments`'s silent cap
        // rejection at staging time: the same limit, the same non-error
        // treatment (the user sees a full strip, not an error line).
        const room = Math.max(0, MAX_CHAT_ATTACHMENTS - live.length);
        const back = fitting.slice(0, room);
        // The overflow's object URL has no owner left once it is dropped — no
        // state holds it, so no remove / session-switch / unmount path can
        // ever revoke it. Release it here or it leaks for the process lifetime.
        fitting.slice(room).forEach(releaseAttachment);
        const merged = [...back, ...live];
        attachmentsRef.current = merged;
        setAttachments(merged);
        // ── The draft's marker numbers move WITH the pictures ──────────────
        // The numbers are POSITIONAL (they count THIS message's attachments in
        // list order), and this restore inserts `back` IN FRONT of everything
        // staged during the turn. Anything staged mid-turn was numbered against
        // the SHORTER list — stage A, send (A held, list empty), paste B and
        // `stageFiles` numbers B `#1` — so after the merge slot 1 is A and the
        // draft's `#1` names the wrong picture: the next prompt asks about a
        // screenshot the user never meant. Shifting by the number ACTUALLY
        // restored (not the number that left the composer — the cap can make
        // those differ) is what keeps the marker→image mapping the whole
        // marker feature exists to guarantee.
        //
        // The live draft (`draftRef`, not the `send()` closure — the composer
        // stays editable across the awaits) is the text being rewritten, and
        // the write lands in this SAME synchronous block for the batching
        // reason above.
        if (back.length > 0) {
          setDraft(shiftImageMarkers(draftRef.current, back.length));
        }
      }
      heldForSendRef.current.delete(targetSessionId);
```

The block is followed by a note that the text typed before Send is still lost on failure (`setDraft("")` ran at send, pre-existing), and the `finally` deletes `targetSessionId` from `sendingSessionsRef`.

**Success path** (immediately after the `await sendPrompt(...)` returns a non-null `stopReason`, BEFORE `turnCompleted`): the map entry is walked and released — "Released from the HELD list (they left `attachments` at send), NOT by re-filtering the staged list by `sentIds`… the held objects are released either way (a revoked URL is not session-scoped)" — plus `heldForSendRef.current.delete(targetSessionId)`.

**A refactor's boundary contract** (what the attachment hook and the dispatch hook must agree on): the held map is **keyed by session id**; attachments leave `attachments` at send and return on failure; the restore **respects `MAX_CHAT_ATTACHMENTS`** (`room`), **de-duplicates by `id`**, **prepends** the survivors (`merged = [...back, ...live]`), **releases the overflow**, and **shifts the draft's markers by `back.length`** (the number ACTUALLY restored, which the cap can make smaller than the number that left). It must stay in **one synchronous block with `setError`** (React 19 batching), must hold the `activeSessionIdRef.current === targetSessionId` guards on both the move and the restore, and must run `setDraft`/`setAttachments` exactly as today. The order "settle the turn in `catch` BEFORE `setError` + restore" and "release held BEFORE success-settle" are load-bearing ("moving the settle in here would invert both orders — each caller owns its own settle", `sendText`'s NOTE). The pinned tests for this whole contract: `"a failed send keeps attachments staged"`, `"a failed send restores the thumbnail WITHOUT releasing its object URL"`, `"unmounting while a send is in flight releases the held attachment"`, `"switching sessions while a send is in flight releases the LEFT session's held attachment"`, `"a failed send renumbers the draft when it re-prepends the held attachments"`, `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the overflow"`.

Also session-scoped cleanup: the **session-switch effect** walks `heldForSendRef` for the session being LEFT (`const left = prevSessionIdRef.current;` — captured before the overwrite, with the comment: "at the release point the ref would otherwise hold the session being ENTERED, so the held-for-send lookup would miss — and the failure path's `delete` drops that entry without releasing it, making the leak permanent") and the **unmount effect** walks both `attachmentsRef.current` and the whole held map.

---

## 6. The URL / object-lifetime contract — where object URLs are created, who revokes them, and the "never revoke here" cases

**Creation — exactly one site**: `createChatComposerAttachment` → `objectUrl: URL.createObjectURL(file)` (`src/lib/chatAttachments.ts`). There is no second creator in the renderer.

**Revocation** happens through `releaseAttachment` (`URL.revokeObjectURL`) at exactly these sites:

| Site | When |
|---|---|
| `removeAttachment` (handler) | removing a thumbnail — revoke OUTSIDE the state updater (StrictMode purity) |
| `ChatStream` unmount effect | `attachmentsRef.current.forEach(releaseAttachment); heldForSendRef.current.forEach((held) => held.forEach(releaseAttachment));` — "on unmount ONLY — revoking on every state change would leak/break live previews (a revoked URL can no longer render the `img`)" |
| `ChatStream` session-switch effect | clear + release the staged list, then release the LEFT session's held entry |
| `send` catch restore | ONLY the overflow: `fitting.slice(room).forEach(releaseAttachment);` — "The overflow's object URL has no owner left once it is dropped" |
| `send` success path | release the held list once the turn settles (see §5.2-5.3) |
| `flushHead` (Queue Flush) success | `entry.attachments.forEach(releaseAttachment);` — "The dispatch path owns these URLs: Task 1's `forget` refuses to release a 'sent' entry precisely because the sender does" |
| `src/store/queuedPrompts.ts` | `removeAttachment` releases the doomed entry-attachment; `forget` releases ONLY when `leaving === "deleted"` ("for `leaving === "sent"` the dispatch path owns those URLs… releasing here too would be a double-revoke under the send path's feet"); `clearSession` releases every attachment for both `leaving` values ("Nobody owns the attachments any more") |

The queue entry type (`QueuedPrompt.attachments: ChatComposerAttachment[]`) documents the move semantics: "**MOVED out of the composer, not copied — this entry owns their object URLs.**"

**The two "never revoke here" cases (verbatim):**

Queue-move (locked `send`) — this is the ADR 0069 fork:

```ts
      // The URLs MOVE with the text: never revoke here, or the queue row's
      // preview and the later send both lose the file. The `[image #N]` markers
      // travel UNTOUCHED for the same reason-in-reverse: the numbering is
      // per-message, message-ness is preserved by the move, so there is nothing
      // to renumber. Nor is the text expanded — ADR 0069 stores the RAW draft so
      // expansion runs at send, against the catalog of THAT moment.
      const moved = attachmentsRef.current;
      attachmentsRef.current = [];
      setAttachments([]);
      useQueuedPrompts.getState().enqueue(targetSessionId, {
        id: crypto.randomUUID(),
        text: rawText,
        attachments: moved,
        state: "queued",
      });
      setDraft("");
      return;
```

Pinned by `"a locked send MOVES the staged attachment into the entry (no revoke, empty strip)"` (`expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-s.png")`) and `"an image dropped mid-turn queues WITH the next prompt instead of stranding"`.

Failed-send restore — from §5.3's comment: "The RESTORED ones' object URLs are NOT revoked — that is what makes the restored thumbnail render again (only the overflow the cap forces out below is released)." Pinned by `"a failed send restores the thumbnail WITHOUT releasing its object URL"` (`expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-s.png")`).

**Why it must be precise**: "Getting this wrong leaks or blanks previews silently" — a revoked URL can no longer render an `img`; a dropped-but-live URL is a leak no state path can reach again (the overflow release comment, and `"a successful Flush RELEASES its attachment's object URL"`'s note: "Task 1's `forget` refuses to release a `"sent"` entry precisely because the DISPATCH path does — so if `flushHead` did not, a successfully-sent attachment would leak until the Session closed"). Test scaffolding note: the test files stub `URL.createObjectURL`/`URL.revokeObjectURL` in `beforeAll` with `vi.fn()` implementations producing `blob:mock-…` URLs; `ChatStream.test.tsx`'s `beforeEach` calls `vi.clearAllMocks()` ("the `URL` stub implementations from `beforeAll` survive — `mockClear` semantics, not `mockReset`").

---

## 7. Existing tests — what is already pinned (do not duplicate)

### 7.1 `src/components/ChatStream.test.tsx` (7,885 lines; 11 top-level `describe` blocks)

Attachment-relevant `describe` blocks: `"ChatStream"` (the general paste/drop/picker/send surface), `"ChatStream — the [image #N] staging marker"` (opens at `:6514`), `"ChatStream — the failed-send attachment restore"` (`:6837`), `"ChatStream — send() forks to the prompt queue while the composer is locked"` (`:6968`), `"ChatStream — the Flush: the queue drains when the Session goes idle"` (`:7189`), and `"ChatStream — staging attachments is allowed while a turn is in flight"` (`:7692`).

**The `[image #N]` staging-marker group** (each is a pin the extraction must keep green): `"a pasted screenshot leaves [image #1] in the draft"`, `"a second paste is #2 — the number counts THIS message's attachments in staging order"`, `"a batch of three staged in ONE event numbers ascending #1 #2 #3"`, `"a rejected file in a mixed batch inserts NO marker (the count comes from the staged list)"`, `"a fully rejected batch inserts nothing at all"`, `"the drop path inserts a marker too"`, `"the `+` file-picker path inserts a marker too"`, `"the WebKitGTK empty-paste clipboard fallback inserts a marker too"`, `"a drop onto an UNFOCUSED composer with a non-empty draft appends the marker at the END"`, `"a paste while the composer is focused lands at the CARET, not at the end"`, `"removing an attachment drops its marker and renumbers the survivors"`, `"the renumbered draft is what gets sent"`, `"the strip badges each thumbnail with the number its marker uses"`, and the `#`-collision pins: `"a marker never expands into an <mcp> block even when the catalog has a server of that number"`, `"a pasted mask sentinel in a marker-free prompt is sent BYTE-UNCHANGED"`, `"a marker AND a pasted mask sentinel send UNEXPANDED (no block, no rewrite)"` (the `\uE000` mask lives in `sendText`, NOT in the staging layer — it is not in the extraction's blast radius, but the marker text it round-trips is).

**The failed-send restore group**: `"a failed send keeps attachments staged"`, `"a failed send restores the thumbnail WITHOUT releasing its object URL"`, `"unmounting while a send is in flight releases the held attachment"`, `"switching sessions while a send is in flight releases the LEFT session's held attachment"`, `"a failed send renumbers the draft when it re-prepends the held attachments"`, `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the overflow"` — plus the general `"send delivers images with the prompt"`, `"staged thumbnails leave the composer AT SEND, not when the send resolves"`, `"an image removed during the read is not sent"`, `"an image-only send with the image removed during the read sends nothing"`, `"an image-only send is blocked when the capability regresses mid-session (a marker is not prose)"`, `"image-only send is allowed"`, and the resume-capability pins (`"a resumed session whose FRESH agent lacks image capability sends text-only without the staged image (no stale capability)"`, `"an image-only send on a resumed session whose FRESH agent lacks image capability is blocked (fail-closed)"`).

**The "staging while a turn is in flight" group** (`"ChatStream — staging attachments is allowed while a turn is in flight"`): `"a drop STAGES while the composer is locked (the turn is not a capability check)"`, `"the `+` picker STAGES while the composer is locked (dialog opens, thumbnail appears)"`, `"an image dropped mid-turn queues WITH the next prompt instead of stranding"`, `"`!imageCapable` still blocks the drop and the `+` picker mid-turn (fail-closed)"`.

**Also in the general `ChatStream` describe**: `"paste stages a thumbnail"`, `"paste of plain text is NOT intercepted"`, `"paste of plain text does NOT trigger the Rust clipboard read"`, `"paste with file items does NOT trigger the Rust clipboard read"`, `"WebKitGTK quirk: empty paste event falls back to the Rust clipboard read"`, `"WebKitGTK quirk fallback: no image on the clipboard stages nothing"`, `"WebKitGTK quirk fallback: a read error stages nothing (silent)"`, `"spreadsheet TSV is NOT intercepted over the synthetic PNG"`, `"non-image paste is rejected with an error line"`, `"oversized paste is rejected"`, `"ninth image is rejected at the cap"`, `"remove button un-stages"`, `"drop stages a thumbnail"`, `"drop STAGES while locked"`, `"window-level drop backstop prevents navigation (drop outside the composer)"`, `"unmount releases staged object URLs"`, `"switching sessions clears staged attachments"`, `"paste stages a thumbnail in a resumable stored session (capability read from the stored session)"`, `"renders an enabled `+` (Attach files) button for a live image-capable session"`, `"the `+` button is disabled when the agent does not advertise image support (fail-closed)"`, `"clicking `+` opens the file picker and stages the picked image"`, `"a cancelled picker (null) stages nothing"`, `"a picker selection of a non-image path is skipped (the read returns null)"`, `"a paste-fallback clipboard read that straddles a session switch stages nothing (session guard)"`. **Queue-side attachment pins** (contract of the "never revoke here" moves): `"a locked send MOVES the staged attachment into the entry (no revoke, empty strip)"`, `"an image dropped mid-turn queues WITH the next prompt instead of stranding"`, `"a marker-only draft with no attachments while locked queues nothing"`, and the Flush pins `"a successful Flush RELEASES its attachment's object URL"`, `"a Flush to an agent that cannot take images sends TEXT-ONLY (fail-closed)"`, `"a Flush whose attachment READ fails settles NO turn and keeps the previous stop reason"`.

**Test-driving duplications to avoid**: the file's own scaffolding (module-level `vi.mock` of `lib/tauri` BY MODULE PATH spreading `vi.importActual` — pinned at 38 files / 37 spreading by `src/lib/tauriBarrel.test.ts`; `pasteToComposer`/`dropOnComposer` helpers that build the jsdom `clipboardData` with `items`, `getData`; `seedLiveSessionWithImages` setting `capabilities: { promptCapabilities: { image: true } }`; the `composerThumbs()`/`composerValue()` readouts against `[data-testid="composer-island"]`; `flush()`; `deferred<T>()` for in-flight IPC). Any new hook test that reaches a store must `resetStores()` first — the suite never runs shuffled and order-dependent store leakage is the documented failure mode (see the scaffolding report).

### 7.2 `src/components/chat/AttachmentStrip.test.tsx` (126 lines)

The strip's BEHAVIOUR is **not** tested here — its own header says: "The strip's BEHAVIOUR (staging, object-URL release, renumbering) is owned by `ChatStream` and `QueueRow` and is already pinned there — `ChatStream.test.tsx` clicks this button by accessible name in six tests and `QueueRow.test.tsx` in one." This file exists **only** for the markup contract of the C7 `<Button>` conversion: `"is a <Button> naming variant AND size explicitly"` (asserts `data-slot="button"`, `data-variant="ghost"`, `data-size="icon-xs"`), `"keeps every utility the badge spelled before the extraction"` (the `PRE_EXTRACTION` class literal), `"paints none of the utilities <Button> would otherwise contribute"` (the `FORBIDDEN` list), `"sizes its glyph with a size-* CLASS"` (`size-3` on the X), `"still removes the attachment it belongs to"` (`onRemove` called with the attachment id). A hook extraction must not force changes to `AttachmentStrip`'s props at all — the `removeAttachment` handler's contract is `(id: string) => void`.

### 7.3 `src/lib/chatAttachments.test.ts` (326 lines, `test(`-style, describer `"chatAttachments"`)

Covers every export functionally (see §1's per-export pins): the five `createChatComposerAttachment`/`readAttachmentAsBase64`/`releaseAttachment` tests, `addImageAttachments`×5, `imageMarker`×1, `insertAtCaret`×5, `renumberImageMarkers`×9 (including the whitespace-seam spec and the `< 1` no-op), `shiftImageMarkers`×6, `draftIsMarkerOnly`×4, `agentSupportsImages`×3. Its `beforeAll` installs `URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`)` and `URL.revokeObjectURL = vi.fn()`. **A PURE-function extraction cannot escape this file; a stateful-hook extraction must not re-test what it pins** (e.g. the renumber/shift tables belong here, not in the hook test — the hook test's job is that the handler *calls* them with the right inputs, which is exactly what the `ChatStream.test.tsx` story tests already prove end-to-end).

### 7.4 Adjacent pins to cite rather than duplicate

- `src/lib/chatAttachmentMetadata.test.ts`: the spreadsheet TSV/HTML heuristic (§2).
- `src/store/queuedPrompts.ts` — `releaseAttachment` ownership in `removeAttachment`/`forget`/`clearSession` (pinned in `QueueRow.test.tsx` and the Flush tests).
- `src/lib/tauriBarrel.test.ts` — the `vi.mock("../lib/tauri")` module-path count (38 / 37 at `b0071544`); if the extraction's test mocks a **different** module path (e.g. a new `src/lib/attachment*` barrel) the count is untouched, but if it ever mocks `lib/tauri` by another means it must stay in the 37-actual-spreading cohort.
- `src/test/setup.tsx` — shared jsdom environment stubs (`matchMedia`, `scrollIntoView`, pointer-capture trio); a new hook test needs no environment block.

---

## 8. `src/hooks/` conventions for a hook of this shape

### 8.1 Layout and naming

- Hooks live **flat in `src/hooks/`** — every hook file is `src/hooks/use<Name>.ts` (26 hooks, one `.tsx` test, no subdirectories, no `index.ts`; the directory listing at `b0071544` has no barrel).
- Tests sit **beside the hook**: `use<Name>.test.ts` (or `.test.tsx` for the DOM-heavy ones). Hook test files are named the same as the hook with `.test.ts` appended; only `useDragReorder.test.tsx` uses `.tsx`.
- One export per file: the hook function (plus optionally its exported interface/options type, e.g. `UseAsyncAction` / `UseAsyncActionOptions`). Type arguments are object-typed: `useDragReorder(args: {...}): UseDragReorder`, `useMentionPicker(args: {...}): MentionPickerResult` — the object-argument pattern is the house shape for hooks taking more than ~2 scalars.

### 8.2 Doc-comment style — the "moved out of ChatStream" precedent

Hooks extracted from `ChatStream` carry a **header comment that records provenance and the ownership boundary** — and the planner should copy this shape. `useAutoGrowComposer`'s header, verbatim: "Moved verbatim out of `ChatStream` by Phase D's Task D4. The two arguments are exactly what the effect used to close over — the textarea's ref and the draft it sizes for — so the hook OWNS neither: `ChatStream` keeps owning `draft` (it is written from eleven sites) and keeps owning `composerRef` (the composer's imperative caret work needs it). `draft` is a DEP here, nothing more…" `useWindowDropBackstop`'s: "Moved verbatim out of `ChatStream` by Phase D's Task D4. Zero coupling was measured before the move and it is the reason this hook is a leaf…" Phase references (Task D4) and the "what the extraction was never supposed to eat" language (`useAsyncAction`: "The post-success work … stays at each site — it is the part that differs, and it is what the extraction was never supposed to eat") are the established idioms.

### 8.3 State + handlers shape (the return contract)

Two house patterns for "returns state + handlers":

- **The object return with an `interface Use<Name>` block**, each field JSDoc'd (`useAsyncAction` returns `{ busy, error, run, clearError }`; `useDragReorder` returns `{ dragProps, draggingId, overId, overEdge }`). The argument-surface pin is a **house test**: `useMentionPicker`'s `"returns exactly the six fields `ChatStream` threads into `ComposerRow`, and no more"` (asserts `Object.keys(h.result.current).sort()`). An attachment hook's test should pin its returned surface the same way.
- **Ownership is explicit in the header**: "the hook OWNS neither" (`useAutoGrowComposer`), "takes `ids` and an `onReorder`… does not know what a list of ids MEANS" (`useDragReorder`), "the hook never owns the draft — eleven sites write it" (`useMentionPicker`'s test header). `useMentionPicker` — the closest analogue (it takes `draft, setDraft, draftRef, composerRef` + catalogs and returns picker state + handlers) — documents: "The harness is thin on purpose. `draft`/`setDraft` belong to the caller (the hook never owns the draft — eleven sites write it) and `composerRef` is a real `<textarea>`…". **For the attachment hook this is the direct precedent**: the hook should take `draft`/`setDraft`/`draftRef`/`composerRef` (or equivalent) as arguments and own neither the draft nor the composer ref.

### 8.4 What the hooks import

- **Pure-derivation hooks import nothing but React** — `useDragReorder`'s header: "That is also why it imports nothing but `react`: a `hooks/` module that reached into a store would give 'what is visible' a second owner, and the `lib` layer's own header rule (no `lib → store` edge) exists to stop exactly that kind of cycle."
- **Stateful hooks may read stores** (`useHasPendingRequest` reads `useSessions`/`usePermissions`/`useInteractive` via `useSyncExternalStore` selectors; `useMentionPicker` reads catalogs passed as values and owns no fetch — "the caller keeps `useCompletionDir`"). But anything owned by the caller (draft, composer ref, catalogs, fetch cache keys) is a **value argument**.
- The `lib` layer's own header rule is "no `lib → store` edge" — a new `src/hooks/useChatAttachments.ts` may import from `lib/chatAttachments.ts` (a `lib` module) but must not import a store; the queue/store interaction belongs to the caller (`send`/`flushHead`) exactly as today.

### 8.5 How the hook tests are named and what they mock

- Naming: `describe("useAsyncAction — the machine", …)` / `describe("useDragReorder (the gesture both lists share)", …)` / `describe("useMentionPicker — the picker state cell", …)`; `it("…")` strings are sentence-shaped, often with a parenthetical "the reason" clause (e.g. `"guard:true reads the RENDERED busy flag, so two runs in one batch both start"`). Comments inside the tests document which site pin each assertion (long-form provenance comments are the norm).
- `renderHook` vs host component: **both exist, chosen by whether the contract is DOM**.
  - `renderHook` + `act` is `useAsyncAction`'s style (pure state machine), `useAutoGrowComposer`'s style (a real `<textarea>` element created in the test and handed to a ref inside a `renderHook` wrapper — "jsdom has NO layout, so `scrollHeight`/`offsetHeight`/`clientHeight` are all `0` and every assertion here has to install them"), and `useMentionPicker`'s style — but with a **real `<textarea>`** because "the caret is an input to two of the derivations", plus a `draft`/`setDraft` **harness component inside `renderHook`** (the `HarnessProps`–`mount()` pattern).
  - **`useDragReorder.test.tsx` renders a `Probe` host component** instead of `renderHook`: its header — "This file is `.tsx` because the hook's contract IS DOM: it needs real elements to carry `dragProps` and to stub their rects, so it drives a probe component rather than `renderHook` (the same reason `ChatStream.test.tsx` is `.tsx`)." The `Probe` spreads `hook.dragProps(id)` onto rows verbatim and renders the gesture state to a readout div.
- What they mock: pure hooks mock nothing (`useAsyncAction.test.ts` has no `vi.mock` at all); `useDragReorder.test.tsx` stubs jsdom's missing `DataTransfer` and `getBoundingClientRect`; store-reading hooks mock `lib/tauri` by module path when they call IPC (**only through the `vi.importActual`-spreading factory**, per the barrel guard — 37 of 38 files). `useMentionPicker.test.ts` uses `renderHook` with fixtures and no module mocks (it receives catalogs as values). The attachment hook test should follow `useMentionPicker`: **real `renderHook` harness with a real `<textarea>` and owned `draft` state** (or a `Probe` if it must assert DOM wiring), value arguments for everything, no `vi.mock` of `lib/tauri` unless the hook itself calls IPC — which it must NOT, because `readClipboardImage`/`readFileBytes` calls stay in the handlers the hook returns, and mocking the hook's own module is never the house pattern.
- A CRITICAL note for the extraction's test scaffolding: `URL.createObjectURL`/`URL.revokeObjectURL` are stubbed **per-file in `beforeAll`** (not in `src/test/setup.tsx`, which only carries `matchMedia`/`scrollIntoView`/pointer-capture); a hook test that releases attachments must install the same two `vi.fn()` globals and assert against `blob:mock-…` literals.

### 8.6 Unconditional-call requirement

Every comments-and-code source in `ChatStream.tsx` repeats one rule: any hook the component calls must be called **unconditionally at the top, before the `if (!activeSessionId) return` early return** — "a hook called only on the full-frame path would change the hook count when the active session appears/disappears and crash React". The extracted attachment hook (which will own `useState` for `attachments` and `heldForSendRef` if it moves) must respect exactly this: it is a hook on the `!activeSessionId` path too (the `attachments`/`heldForSendRef` state and the unmount + session-switch effects currently run unconditionally, above the early return).

---

## 9. Exact verification commands (run from the repo root, `/home/daniel/Coding/AI/archimedes-desktop`)

Package manager is **pnpm** (`packageManager: "pnpm@11.7.0"`); vitest is 5.x; there is **no `vitest.config.*`** — the test config lives in `vite.config.ts` (`environment: "jsdom"`, `globals: true`, `setupFiles: ["./src/test/setup.tsx"]`, `testTimeout: 20_000`). `package.json` scripts: `"test": "vitest run"`, `"build": "tsc && vite build"`.

| What | Command |
|---|---|
| The library unit tests | `npx vitest run src/lib/chatAttachments.test.ts src/lib/chatAttachmentMetadata.test.ts` |
| The new hook's tests | `npx vitest run src/hooks/useChatAttachments.test.ts` (or `…src/hooks/use<Name>.test.tsx`) |
| The host component tests | `npx vitest run src/components/ChatStream.test.tsx` |
| One attachment test by name | `npx vitest run src/components/ChatStream.test.tsx -t "the failed-send attachment restore"` (or `-t "the [image #N] staging marker"`, `-t "staging attachments is allowed while a turn is in flight"` — any substring of a `describe`/`it` name works) |
| Whole frontend suite | `pnpm test` (repo root; CI runs `pnpm test --reporter=default --reporter=junit --outputFile=vitest-results.xml` per `.github/workflows/ci.yml`) |
| Type-check without bundling | `npx tsc --noEmit` (repo root) |
| Type-check + build (the CI gate) | `pnpm build` |
| Rust side (unchanged by this area) | from `src-tauri/`: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check` |

Notes: the suite is never run shuffled and there is no dedicated `typecheck` script (`AGENTS.md`'s validation table: "Frontend type-check + build — `pnpm build` — repo root"). The Rust fixtures census / temp-dir scripts in CI (`scripts/check-temp-dir-census.sh`, `scripts/check-test-data-dir.sh`) are unrelated to this frontend-only extraction but run in the same pipeline.